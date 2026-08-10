import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { sha256Bytes } from "../contracts/canonical.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { userAskClaim } from "../contracts/path-claims.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import {
  readCommitTreeBlob,
  readCommitTreePathListing,
  readGitBlobBytes,
  readHeadCommit,
} from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { openResolved, resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "../state/authority.js";
import {
  expectedProduceUpstreamBindings,
  loadProduceUpstreamSubject,
  readProduceProjection,
  type CurrentProduceSubject,
} from "../state/produce-subject.js";
import type { TransactionDependencies } from "../state/transaction.js";
import {
  ReviewEnvelopeError,
  buildReviewEnvelope,
  type DispatchEnvelope,
  type PinnedContextEntry,
  type PinnedContextKind,
  type ReviewEnvelopeInput,
} from "./envelopes.js";

/**
 * Cap priority, highest kept first. Required comparison bases sit above `CAP_DROPPABLE_KINDS`
 * membership: a kind not in the droppable set is never sacrificed to the byte cap, so an envelope
 * that cannot fit the artifact plus every non-droppable entry fails closed exactly as before.
 */
const CAP_PRIORITY: readonly PinnedContextKind[] = [
  "approved-upstream", "user-ask", "verification-transcript",
  "interface-excerpt", "conventions", "repo-map",
];

const CAP_DROPPABLE_KINDS: ReadonlySet<PinnedContextKind> = new Set([
  "interface-excerpt", "conventions", "repo-map",
]);

/** Per-entry head budget for mechanical evidence; the full-file digest stays recorded. */
const EXCERPT_BYTE_BUDGET = 24_576;

/** Bounded number of mechanically resolved evidence targets per review. */
const MECHANICAL_TARGET_LIMIT = 32;

function visibleContent(bytes: Uint8Array): Readonly<{ encoding: "utf8" | "base64"; content: string }> {
  try {
    return Object.freeze({
      encoding: "utf8",
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    });
  } catch {
    return Object.freeze({ encoding: "base64", content: Buffer.from(bytes).toString("base64") });
  }
}

/** Pins evidence bytes whole, recording the digest of exactly those bytes. */
export function pinnedContextEntry(
  kind: PinnedContextKind,
  label: string,
  bytes: Uint8Array,
): PinnedContextEntry {
  return Object.freeze({
    kind,
    label,
    status: "pinned",
    content_digest: sha256Bytes(bytes),
    ...visibleContent(bytes),
  });
}

/** Names evidence the server could not assemble, so the gap is reviewable rather than silent. */
export function unavailableContextEntry(
  kind: PinnedContextKind,
  label: string,
  note: string,
): PinnedContextEntry {
  return Object.freeze({ kind, label, status: "unavailable", note });
}

/** Cuts a byte head on a UTF-8 boundary so a truncated text file stays readable text. */
function utf8SafeHead(bytes: Uint8Array, budget: number): Uint8Array {
  for (let cut = budget; cut > budget - 4 && cut > 0; cut -= 1) {
    const head = bytes.slice(0, cut);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head);
      return head;
    } catch {
      // keep backtracking to the previous code-point boundary
    }
  }
  return bytes.slice(0, budget);
}

/** Pins whole when within budget, otherwise a bounded head with the full-file digest recorded. */
export function excerptContextEntry(
  kind: PinnedContextKind,
  label: string,
  bytes: Uint8Array,
): PinnedContextEntry {
  if (bytes.byteLength <= EXCERPT_BYTE_BUDGET) {
    return pinnedContextEntry(kind, label, bytes);
  }
  return Object.freeze({
    kind,
    label,
    status: "truncated",
    content_digest: sha256Bytes(bytes),
    ...visibleContent(utf8SafeHead(bytes, EXCERPT_BYTE_BUDGET)),
    total_byte_count: bytes.byteLength,
  });
}

function omittedForCap(entry: PinnedContextEntry, digest: Sha256Digest): PinnedContextEntry {
  return Object.freeze({
    kind: entry.kind,
    label: entry.label,
    status: "omitted-cap",
    content_digest: digest,
    note: "omitted to fit the review envelope byte cap; the digest still names the exact evidence bytes",
  });
}

function isByteCapError(error: unknown): error is ReviewEnvelopeError {
  return error instanceof ReviewEnvelopeError &&
    error.project_error.code === "CONTRACT_INVALID" &&
    (error.project_error.diagnostic.parameters as { issue_code?: unknown }).issue_code === "envelope-byte-cap";
}

/**
 * Builds the review envelope, and on byte-cap overflow replaces droppable pinned entries with
 * `omitted-cap` markers, lowest cap priority first, before failing closed. A dropped entry stays
 * visible to the reviewer as a named digest, so the omission surfaces under `unverifiable-claims`
 * instead of silently narrowing the review.
 */
export function buildReviewEnvelopeWithCap(input: ReviewEnvelopeInput): DispatchEnvelope {
  const context = [...input.context];
  for (;;) {
    try {
      return buildReviewEnvelope({ ...input, context });
    } catch (error) {
      if (!isByteCapError(error)) throw error;
      const index = dropCandidateIndex(context);
      if (index === undefined) throw error;
      const entry = context[index]!;
      if (entry.status !== "pinned" && entry.status !== "truncated") throw error;
      context[index] = omittedForCap(entry, entry.content_digest);
    }
  }
}

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(phase: PhaseInstanceId, issue_code: string): ProjectResult<T> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", { phase_instance: phase, issue_code }),
  });

/**
 * Assembles the pinned context for a counter-review of the current produce subject.
 *
 * PRD reviews pin the verbatim user ask: a PRD that declared a `user-ask` input gets `ask.md`
 * pinned after its bytes are authenticated against the declared digest, and a PRD that declared
 * none stays reviewable with a named `unavailable` entry, so the rubric's `ask-fidelity` criterion
 * routes to `unverifiable-claims` instead of guessing. A declared-but-drifted or unreadable
 * `ask.md` fails closed: the declaration is durable authority the worktree no longer satisfies.
 *
 * Every later phase pins its exact canonical upstream documents — the same
 * `expectedProduceUpstreamBindings` set adjudication authenticates — each one required to hold a
 * durable `artifact-approval` for its exact current artifact digest and its worktree bytes
 * re-hashed against the retained projection digest. Any missing result, absent approval, or byte
 * drift fails closed: upstream pinning restates durable authority, never observes around it.
 */
export async function assembleReviewContext(input: {
  readonly runner: RootBoundGitRunner;
  readonly authority: TransactionAuthority;
  readonly dependencies: Pick<TransactionDependencies, "load_retained_result">;
  readonly state: TaskStateV1;
  readonly subject: CurrentProduceSubject;
  readonly projection_bytes: Uint8Array;
}): Promise<ProjectResult<readonly PinnedContextEntry[]>> {
  const phase = decodePhaseInstance(input.state.phase_instance);
  if (phase.kind !== "prd") {
    const upstreams = await assembleUpstreamContext(input);
    if (!upstreams.ok) return upstreams;
    let mechanical: readonly PinnedContextEntry[];
    if (input.subject.artifact.artifact_kind === "implementation-output") {
      mechanical = [
        ...verificationTranscriptEvidence(input.state, input.subject),
        ...await implementationMechanicalEvidence(input.runner, input.subject),
      ];
    } else {
      let artifactText: string | undefined;
      try {
        artifactText = new TextDecoder("utf-8", { fatal: true }).decode(input.projection_bytes);
      } catch {
        artifactText = undefined;
      }
      mechanical = artifactText === undefined
        ? Object.freeze([])
        : await documentMechanicalEvidence(input.runner, artifactText);
    }
    const conventions = await conventionsEvidence(input.runner);
    return ok(Object.freeze([...upstreams.value, ...mechanical, ...conventions]));
  }
  if (input.subject.artifact.artifact_kind !== "document") {
    return ok(Object.freeze([]));
  }
  const declared = input.subject.artifact.declared_inputs
    .find((candidate) => candidate.input_id === "user-ask");
  if (declared === undefined) {
    return ok(Object.freeze([unavailableContextEntry(
      "user-ask",
      "ask.md",
      "no user-ask input was declared by this PRD; judge ask fidelity under unverifiable-claims",
    )]));
  }
  const target = await resolveTaskPath({
    runner: input.runner,
    taskId: input.authority.task_id,
    claim: userAskClaim(),
    expectedClass: "task-ask",
    context: input.authority.context,
  });
  if (!target.ok) return target;
  let bytes: Uint8Array;
  try {
    const handle = await openResolved(target.value.absolute, 0);
    try {
      bytes = new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch {
    return fail(input.state.phase_instance, "user-ask-unavailable");
  }
  if (sha256Bytes(bytes) !== declared.digest) {
    return fail(input.state.phase_instance, "user-ask-not-current");
  }
  return ok(Object.freeze([pinnedContextEntry("user-ask", "ask.md", bytes)]));
}

async function assembleUpstreamContext(input: {
  readonly runner: RootBoundGitRunner;
  readonly authority: TransactionAuthority;
  readonly dependencies: Pick<TransactionDependencies, "load_retained_result">;
  readonly state: TaskStateV1;
}): Promise<ProjectResult<readonly PinnedContextEntry[]>> {
  const entries: PinnedContextEntry[] = [];
  for (const binding of expectedProduceUpstreamBindings(input.state)) {
    const upstream = await loadProduceUpstreamSubject(input.dependencies, input.state, binding);
    if (!upstream.ok) return upstream;
    const approved = input.state.approvals.some((approval) =>
      approval.gate_kind === "artifact-approval" &&
      approval.subject_digest === upstream.value.artifact_digest);
    if (!approved) return fail(input.state.phase_instance, "upstream-approval-missing");
    const projection = await readProduceProjection(
      input.runner, input.authority, upstream.value, binding.path,
    );
    if (!projection.ok) return projection;
    entries.push(pinnedContextEntry("approved-upstream", binding.path, projection.value.bytes));
  }
  return ok(Object.freeze(entries));
}

// ---------------------------------------------------------------------------
// Mechanical evidence extraction
// ---------------------------------------------------------------------------

const RELATIVE_IMPORT_PATTERNS = [
  /\bfrom\s+["']([^"'\n]+)["']/gu,
  /\bimport\s+["']([^"'\n]+)["']/gu,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
];

/** Relative module specifiers named by a changed source file, in first-mention order. */
export function relativeImportSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith("./") || specifier.startsWith("../")) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

/** Repository paths a specifier may resolve to, covering the compiled-extension import idiom. */
export function importTargetCandidates(fromPath: string, specifier: string): readonly string[] {
  const resolved = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (resolved.startsWith("../") || resolved === "..") return Object.freeze([]);
  const candidates = new Set<string>([resolved]);
  if (resolved.endsWith(".js")) candidates.add(`${resolved.slice(0, -3)}.ts`);
  if (resolved.endsWith(".mjs")) candidates.add(`${resolved.slice(0, -4)}.mts`);
  if (!/\.[A-Za-z0-9]+$/u.test(resolved)) {
    candidates.add(`${resolved}.ts`);
    candidates.add(`${resolved}.js`);
    candidates.add(`${resolved}/index.ts`);
  }
  return Object.freeze([...candidates]);
}

const DOC_PATH_MENTION = /`([A-Za-z0-9_@][A-Za-z0-9_@./:-]*)`/gu;

/** Backtick-quoted repository path mentions in a document, line references stripped. */
export function mentionedRepositoryPaths(text: string): readonly string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(DOC_PATH_MENTION)) {
    const token = match[1]!.replace(/:[0-9]+(?:-[0-9]+)?$/u, "");
    if (token.includes(":") || token.includes("..")) continue;
    const looksLikePath = token.includes("/") || /^[A-Za-z0-9_@-]+\.[A-Za-z0-9]+$/u.test(token);
    if (!looksLikePath) continue;
    paths.add(token);
  }
  return [...paths];
}

const failedMechanicalEvidence = (kind: PinnedContextKind, label: string): PinnedContextEntry =>
  unavailableContextEntry(kind, label, "mechanical evidence generation failed for this review");

/**
 * Pins interface excerpts for the repository paths a document names, plus a generated repo map of
 * the directories those paths occupy, all read from the immutable HEAD commit tree so the digest
 * names reproducible bytes. Never fails closed: extraction misses and generation failures surface
 * as `unavailable` entries the rubric routes to `unverifiable-claims`.
 */
async function documentMechanicalEvidence(
  runner: RootBoundGitRunner,
  artifactText: string,
): Promise<readonly PinnedContextEntry[]> {
  try {
    const head = await readHeadCommit(runner);
    const mentioned = mentionedRepositoryPaths(artifactText);
    const bounded = mentioned.slice(0, MECHANICAL_TARGET_LIMIT);
    const entries: PinnedContextEntry[] = [];
    const pinnedDirectories = new Set<string>();
    for (const path of bounded) {
      const blob = await readCommitTreeBlob(runner, head, path);
      if (blob === undefined) {
        entries.push(unavailableContextEntry(
          "interface-excerpt", path, `not found in the pinned tree ${head}`,
        ));
        continue;
      }
      entries.push(excerptContextEntry("interface-excerpt", path, await readGitBlobBytes(runner, blob.oid)));
      pinnedDirectories.add(posix.dirname(path));
    }
    if (mentioned.length > bounded.length) {
      entries.push(unavailableContextEntry(
        "interface-excerpt",
        "additional-mentions",
        `${mentioned.length - bounded.length} further mentioned paths not pinned (mechanical evidence limit)`,
      ));
    }
    if (pinnedDirectories.size > 0) {
      const listing = await readCommitTreePathListing(runner, head, [...pinnedDirectories]);
      const body = `${listing.paths.join("\n")}${listing.truncated ? "\n… listing truncated" : ""}\n`;
      entries.push(pinnedContextEntry("repo-map", `tree ${head}`, new TextEncoder().encode(body)));
    }
    return entries;
  } catch {
    return [failedMechanicalEvidence("interface-excerpt", "document-mentions")];
  }
}

/**
 * Lifts the phase's verification transcript out of the change set into a typed entry the rubric's
 * `verification-evidence` criterion can address, and names its absence when the change carries
 * none. The transcript is agent-written: nothing at prototype tier prevents a determined agent
 * from fabricating it. The rubric judges the transcript's *content* against the phase design
 * (command shown, output consistent, failures absent), which catches sloppy fabrication only; a
 * server-attested runner that executes the verification command itself is the named upgrade path
 * if that limitation proves live.
 */
export function verificationTranscriptEvidence(
  state: TaskStateV1,
  subject: CurrentProduceSubject,
): readonly PinnedContextEntry[] {
  if (subject.artifact.artifact_kind !== "implementation-output") return Object.freeze([]);
  const phase = decodePhaseInstance(state.phase_instance);
  if (phase.kind !== "phase-impl") return Object.freeze([]);
  const transcriptPath = `.archflow/tasks/${state.task_id}/phases/${String(phase.phase)}/verification.txt`;
  const entry = subject.retained.projection_plan.entries
    .find((candidate) => candidate.path === transcriptPath);
  if (entry === undefined || entry.desired.state !== "present") {
    return [unavailableContextEntry(
      "verification-transcript",
      `phases/${String(phase.phase)}/verification.txt`,
      "no verification transcript in the change set; claimed-but-untranscribed verification is an unverifiable claim, not a pass",
    )];
  }
  return [excerptContextEntry(
    "verification-transcript",
    `phases/${String(phase.phase)}/verification.txt`,
    entry.desired.bytes,
  )];
}

/**
 * Pins interface excerpts for the unchanged files the changed code imports, read as blobs at the
 * implementation's pinned `base_commit` — the same authenticated source `verifyImplementationManifest`
 * uses. Changed targets are skipped because their full bytes already travel in `changes[]`.
 */
async function implementationMechanicalEvidence(
  runner: RootBoundGitRunner,
  subject: CurrentProduceSubject,
): Promise<readonly PinnedContextEntry[]> {
  if (subject.artifact.artifact_kind !== "implementation-output") return Object.freeze([]);
  const baseCommit = subject.artifact.base_commit;
  try {
    const planEntries = subject.retained.projection_plan.entries;
    const changedPaths = new Set(planEntries.map((entry) => entry.path as string));
    const wanted: { specifier: string; fromPath: string; candidates: readonly string[] }[] = [];
    for (const entry of planEntries) {
      if (entry.desired.state !== "present" || !/\.(?:ts|tsx|mts|js|mjs)$/u.test(entry.path)) continue;
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(entry.desired.bytes);
      } catch {
        continue;
      }
      for (const specifier of relativeImportSpecifiers(source)) {
        const candidates = importTargetCandidates(entry.path, specifier);
        if (candidates.length === 0) continue;
        if (candidates.some((candidate) => changedPaths.has(candidate))) continue;
        wanted.push({ specifier, fromPath: entry.path, candidates });
      }
    }
    const entries: PinnedContextEntry[] = [];
    const pinnedTargets = new Set<string>();
    let processed = 0;
    for (const item of wanted) {
      if (processed >= MECHANICAL_TARGET_LIMIT) break;
      let resolved: { path: string; oid: string } | undefined;
      for (const candidate of item.candidates) {
        const blob = await readCommitTreeBlob(runner, baseCommit, candidate);
        if (blob !== undefined) {
          resolved = { path: candidate, oid: blob.oid };
          break;
        }
      }
      if (resolved === undefined) {
        processed += 1;
        entries.push(unavailableContextEntry(
          "interface-excerpt",
          item.specifier,
          `import from ${item.fromPath} did not resolve at base commit ${baseCommit}`,
        ));
        continue;
      }
      if (pinnedTargets.has(resolved.path)) continue;
      pinnedTargets.add(resolved.path);
      processed += 1;
      entries.push(excerptContextEntry("interface-excerpt", resolved.path, await readGitBlobBytes(runner, resolved.oid)));
    }
    if (processed >= MECHANICAL_TARGET_LIMIT && wanted.length > processed) {
      entries.push(unavailableContextEntry(
        "interface-excerpt",
        "additional-imports",
        `${wanted.length - processed} further import targets not pinned (mechanical evidence limit)`,
      ));
    }
    return entries;
  } catch {
    return [failedMechanicalEvidence("interface-excerpt", "changed-imports")];
  }
}

/** Pins the repository's conventions document from the worktree; absent conventions pin nothing. */
async function conventionsEvidence(runner: RootBoundGitRunner): Promise<readonly PinnedContextEntry[]> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(runner.location.worktreeRoot, "CLAUDE.md")));
  } catch {
    return Object.freeze([]);
  }
  return [excerptContextEntry("conventions", "CLAUDE.md", bytes)];
}

function dropCandidateIndex(context: readonly PinnedContextEntry[]): number | undefined {
  let candidate: number | undefined;
  let candidatePriority = -1;
  for (let index = 0; index < context.length; index += 1) {
    const entry = context[index]!;
    if (!CAP_DROPPABLE_KINDS.has(entry.kind)) continue;
    if (entry.status !== "pinned" && entry.status !== "truncated") continue;
    const priority = CAP_PRIORITY.indexOf(entry.kind);
    if (priority > candidatePriority) {
      candidate = index;
      candidatePriority = priority;
    }
  }
  return candidate;
}
