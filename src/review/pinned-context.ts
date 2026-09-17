import { governingReviewBindings } from "./documents.js";
import { isFeedbackReview } from "../contracts/review.js";
import type { ReviewResponse } from "../contracts/triage.js";
import { reviewFindings } from "../contracts/review.js";
import { readFile } from "node:fs/promises";
import type { SafeInteger } from "../contracts/evidence.js";
import { posix } from "node:path";

import { canonicalJsonBytes, sha256Bytes } from "../contracts/canonical.js";
import { decodeUtf8Strict, visibleContent } from "../contracts/utf8.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { parseTaskPathClaim, userAskClaim } from "../contracts/path-claims.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { reviewFindingDisplayDetail, type ReviewEvidence } from "../contracts/review.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { openResolved, resolveTaskPath, resolveTaskWorkspacePath, verificationTranscriptClaim } from "../repository/paths.js";
import type { TransactionAuthority } from "../state/authority.js";
import {
  expectedProduceUpstreamBindings,
  loadProduceUpstreamSubject,
  produceOwnedTaskDocumentPaths,
  produceUpstreamBindingsForSubject,
  readProduceProjection,
  type CurrentProduceSubject,
} from "../state/produce-subject.js";
import {
  authenticatedValidationOverrideIsCurrent,
  loadAuthenticatedValidationOverride,
} from "../state/validation-overrides.js";
import type { ProjectionPlan } from "../state/snapshots.js";
import type { TransactionDependencies } from "../state/transaction.js";
import { loadLegacyImportInitialization } from "../state/legacy-import-resume.js";
import {
  type PinnedContextEntry,
  type PinnedContextKind,
} from "./envelopes.js";

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
 * PRD reviews pin the complete user ask record: the verbatim original request plus any verbatim
 * clarification exchanges appended to `ask.md`. A PRD that declared a `user-ask` input gets those
 * bytes pinned after they are authenticated against the declared digest, and a PRD that declared
 * none stays reviewable with a named `unavailable` entry, so the rubric's `ask-fidelity` criterion
 * routes to `unverifiable-claims` instead of guessing. A declared-but-drifted or unreadable
 * `ask.md` fails closed: the declaration is durable authority the worktree no longer satisfies.
 *
 * Every later phase pins its exact canonical upstream documents — the same
 * `expectedProduceUpstreamBindings` set adjudication authenticates — each one required to hold a
 * durable reviewed-upstream authority for its exact current artifact digest and producer phase,
 * and its worktree bytes
 * re-hashed against the retained projection
 * digest. Any missing result, absent authority, or byte drift fails closed: upstream pinning
 * restates durable authority, never observes around it.
 *
 * Every phase kind additionally pins the latest accepted revision intents when present
 * (see {@link priorTriageEvidence}), so remediation confirms only unresolved owned work.
 */
export async function assembleReviewContext(input: {
  readonly runner: RootBoundGitRunner;
  readonly authority: TransactionAuthority;
  readonly dependencies: Pick<
    TransactionDependencies,
    "load_retained_result" | "load_retained_manifest" | "runner" | "environment" | "read_state"
  >;
  readonly state: TaskStateV1;
  readonly subject: CurrentProduceSubject;
  readonly projection_bytes: Uint8Array;
  /**
   * The subject's retained projection plan, supplied by the caller for implementation outputs.
   * The subject itself carries only a manifest, and rebuilding the plan re-reads every payload and
   * re-runs the secret scan, so the dispatching handler — which already loads it — passes it down.
   */
  readonly projection_plan?: ProjectionPlan;
  /** A prior-triage record the caller already loaded; avoids re-reading the retained triage. */
  readonly prior_triage?: PriorTriageRecord;
}): Promise<ProjectResult<readonly PinnedContextEntry[]>> {
  const phase = decodePhaseInstance(input.state.phase_instance);
  const priorTriage = await priorTriageEvidence(input.dependencies, input.state, input.prior_triage);
  if (!priorTriage.ok) return priorTriage;
  if (phase.kind !== "prd") {
    const upstreams = await assembleUpstreamContext(input);
    if (!upstreams.ok) return upstreams;
    let mechanical: readonly PinnedContextEntry[] = [];
    if (input.subject.artifact.artifact_kind === "implementation-output") {
      const validationOverrides = await validationOverrideEvidence(input);
      if (!validationOverrides.ok) return validationOverrides;
      mechanical = [
        ...validationOverrides.value,
        ...await verificationTranscriptEvidence(input.runner, input.authority, input.state, input.subject),
      ];
    }
    // Source, conventions, and navigation are already available in the pinned repository view.
    return ok(Object.freeze([...upstreams.value, ...priorTriage.value, ...mechanical]));
  }
  if (input.subject.artifact.artifact_kind !== "document") {
    return ok(Object.freeze([...priorTriage.value]));
  }
  const declared = input.subject.artifact.declared_inputs
    .find((candidate) => candidate.input_id === "user-ask");
  if (declared === undefined) {
    return ok(Object.freeze([unavailableContextEntry(
      "user-ask",
      "ask.md",
      "no user-ask input was declared by this PRD; judge ask fidelity under unverifiable-claims",
    ), ...priorTriage.value]));
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
  return ok(Object.freeze([pinnedContextEntry("user-ask", "ask.md", bytes), ...priorTriage.value]));
}

async function validationOverrideEvidence(input: {
  readonly authority: TransactionAuthority;
  readonly dependencies: Pick<
    TransactionDependencies,
    "load_retained_manifest" | "runner" | "environment" | "read_state"
  >;
  readonly state: TaskStateV1;
  readonly subject: CurrentProduceSubject;
}): Promise<ProjectResult<readonly PinnedContextEntry[]>> {
  const phase = decodePhaseInstance(input.state.phase_instance);
  if (phase.kind !== "phase-impl" || input.subject.artifact.artifact_kind !== "implementation-output") {
    return ok(Object.freeze([]));
  }
  const binding = expectedProduceUpstreamBindings(input.state)
    .find((candidate) => candidate.artifact_kind === "phase-design");
  if (binding === undefined) return fail(input.state.phase_instance, "validation-override-governing-phase-design-missing");
  // If this result rewrites its governing phase design, every grant bound to the predecessor is
  // historical. The replacement has not yet acquired approval authority at review time.
  if (produceOwnedTaskDocumentPaths(input.subject.artifact).includes(binding.path)) {
    return ok(Object.freeze([]));
  }
  const governing = await loadProduceUpstreamSubject(
    input.dependencies, input.authority, input.state, binding,
  );
  if (!governing.ok) return governing;

  const productionInput = Object.freeze({
    phase_instance: input.state.phase_instance,
    input_fingerprint: input.subject.artifact.input_fingerprint,
  });

  const grants = [];
  let unavailable = false;
  for (const record of input.state.validation_overrides ?? []) {
    if (record.phase_instance !== input.state.phase_instance ||
        record.input_fingerprint !== input.subject.artifact.input_fingerprint ||
        record.governing_phase_design_digest !== governing.value.artifact_digest) continue;
    const authenticated = await loadAuthenticatedValidationOverride(
      input.dependencies, input.authority, record,
    );
    if (!authenticated.ok) {
      unavailable = true;
      continue;
    }
    if (!authenticatedValidationOverrideIsCurrent(
      authenticated.value, productionInput, governing.value.artifact_digest,
    )) continue;
    grants.push(Object.freeze({
      status: "not-run" as const,
      gate_id: authenticated.value.record.gate_id,
      human_reason: authenticated.value.record.human_reason,
      decided_at: authenticated.value.record.decided_at,
      displaced_validations: authenticated.value.request.context.displaced_validations,
    }));
  }
  const entries: PinnedContextEntry[] = [];
  if (grants.length > 0) {
    entries.push(pinnedContextEntry(
      "validation-override",
      "human-granted validation overrides",
      canonicalJsonBytes({
        schema_version: "1",
        evidence_kind: "validation-overrides",
        interpretation: "The named validations were not run; this records a human exception and is not passing evidence.",
        overrides: grants,
      }),
    ));
  }
  if (unavailable) {
    entries.push(unavailableContextEntry(
      "validation-override",
      "validation override authority",
      "a matching recorded validation override could not be authenticated and is not treated as granted",
    ));
  }
  return ok(Object.freeze(entries));
}

async function assembleUpstreamContext(input: {
  readonly runner: RootBoundGitRunner;
  readonly authority: TransactionAuthority;
  readonly dependencies: Pick<TransactionDependencies, "load_retained_result" | "load_retained_manifest" | "runner">;
  readonly state: TaskStateV1;
  readonly subject: CurrentProduceSubject;
}): Promise<ProjectResult<readonly PinnedContextEntry[]>> {
  const entries: PinnedContextEntry[] = [];
  const produced = new Set(produceOwnedTaskDocumentPaths(input.subject.artifact));
  for (const binding of governingReviewBindings(input.state.phase_instance).filter(binding => !produced.has(binding.path))) {
    const upstream = await loadProduceUpstreamSubject(input.dependencies, input.authority, input.state, binding);
    if (!upstream.ok) return upstream;
    // Retained owners were authority-checked by the shared loader, including the exact producer
    // phase on settlement authority. Imports remain human-only and retain their migration audit.
    if ("imported_projection" in upstream.value) {
      const approved = input.state.phase_instance === "design" ||
        input.state.approvals.some((approval) => approval.gate_kind === "migration-audit");
      if (!approved) return fail(input.state.phase_instance, "upstream-approval-missing");
    }
    const projection = await readProduceProjection(
      input.runner, input.authority, upstream.value, binding.path,
    );
    if (!projection.ok) return projection;
    entries.push({ ...pinnedContextEntry("imported_projection" in upstream.value ? "imported-reference" : "approved-upstream", binding.path, projection.value.bytes), source_version: upstream.value.artifact_digest });
  }
  if (input.state.phase_instance === "design") {
    const imported = await loadLegacyImportInitialization(
      input.dependencies, input.authority, input.state,
    );
    if (!imported.ok) return imported;
    if (imported.value !== undefined) {
      const prefix = `.archflow/tasks/${input.state.task_id}/`;
      for (const mapping of imported.value.mapping) {
        if (mapping.phase_instance === "prd" || mapping.phase_instance === "design") continue;
        const relativePath = mapping.destination_path.slice(prefix.length);
        const target = await resolveTaskPath({
          runner: input.runner,
          taskId: input.authority.task_id,
          claim: parseTaskPathClaim(relativePath),
          expectedClass: "document",
          context: input.authority.context,
        });
        if (!target.ok) return target;
        const bytes = new Uint8Array(await readFile(target.value.absolute));
        const reference = imported.value.staged_payload_refs.find((item) => item.legacy_path === mapping.legacy_path);
        if (reference === undefined || sha256Bytes(bytes) !== reference.digest) return fail(input.state.phase_instance, "imported-reference-changed");
        entries.push(pinnedContextEntry("imported-reference", relativePath, bytes));
      }
      entries.push(pinnedContextEntry("imported-reference", "migration-plan.json", canonicalJsonBytes({
        schema_version: "1",
        ...(imported.value.resume_phase === undefined ? {} : { resume_phase: imported.value.resume_phase }),
        ...(imported.value.planned_final_phase === undefined ? {} : { planned_final_phase: imported.value.planned_final_phase }),
        mapping: imported.value.mapping,
      })));
    }
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

/**
 * Pins optional agent-written verification context at review time. The implementation notes
 * carry the verification record; a raw log is supporting evidence, not implementation authority.
 * Hashing identifies the supplied bytes and does not attest that commands actually ran.
 */
export async function verificationTranscriptEvidence(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  state: TaskStateV1,
  subject: CurrentProduceSubject,
): Promise<readonly PinnedContextEntry[]> {
  if (subject.artifact.artifact_kind !== "implementation-output") return Object.freeze([]);
  const phase = decodePhaseInstance(state.phase_instance);
  if (phase.kind !== "phase-impl") return Object.freeze([]);
  const displayPath = `cache/phases/${String(phase.phase)}/verification.txt`;
  const resolved = await resolveTaskWorkspacePath({
    runner,
    taskId: state.task_id,
    claim: verificationTranscriptClaim(phase.phase),
    expectedClass: "workspace-verification-transcript",
    context: authority.context,
  });
  if (!resolved.ok) {
    return [unavailableContextEntry(
      "verification-transcript",
      displayPath,
      "verification log is unavailable; assess the verification record in implementation notes and relevant code and tests",
    )];
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolved.value.absolute));
  } catch {
    return [unavailableContextEntry("verification-transcript", displayPath,
      "verification log is absent; assess the verification record in implementation notes and relevant code and tests")];
  }
  return [pinnedContextEntry("verification-transcript", displayPath, bytes)];
}

/**
 * Pins the latest accepted triage dispositions for remediation confirmation.
 *
 * Durable triage still carries its cumulative `disposition_ledger` for audit and review-strength
 * accounting. This child projection deliberately ignores that ledger so prompts do not grow by
 * replaying closed rounds.
 *
 * Every rendered field restates durable authority: finding severity, summary, evidence, and
 * suggested resolution come from the retained reviewer-authored evidence manifest; dispositions,
 * rationales, and revision intents come from retained triage. A referenced-but-unloadable
 * manifest fails closed; a finding absent from retained review evidence renders without invented
 * details.
 */
export type PriorTriageDisposition = Readonly<Record<string, unknown> & {
  finding_id: string;
  disposition: string;
}>;

/**
 * The structured prior-triage record before rendering. It is a child projection of only the
 * latest accepted dispositions. Durable triage retains its cumulative ledger separately for
 * audit and review-strength accounting.
 */
export type PriorTriageRecord = Readonly<{
  response?: ReviewResponse;
  phase_instance: PhaseInstanceId;
  current_attempt: SafeInteger;
  dispositions: readonly PriorTriageDisposition[];
  current: readonly Readonly<{
    review_evidence_digest?: Sha256Digest;
    finding_id: string;
    disposition: string;
  }>[];
  /** Exact review occurrence whose current accepted dispositions must be confirmed. */
  source_review?: Readonly<{
    evidence_digest: Sha256Digest;
    evidence: ReviewEvidence;
  }>;
}>;

export async function loadPriorTriageRecord(
  dependencies: Pick<TransactionDependencies, "load_retained_result">,
  state: TaskStateV1,
): Promise<ProjectResult<PriorTriageRecord | undefined>> {
  const triageRef = state.authoritative_results.find((candidate) =>
    candidate.phase_instance === state.phase_instance && candidate.step === "triage");
  if (triageRef === undefined || dependencies.load_retained_result === undefined) {
    return ok(undefined);
  }
  const triage = await dependencies.load_retained_result(triageRef);
  if (!triage.ok) return triage;
  const triageSource = triage.value.prepared.manifest.value.source_artifact;
  if (triageSource.artifact_kind !== "triage") {
    return fail(state.phase_instance, "prior-triage-artifact-invalid");
  }
  const findingsByRef = new Map<string, Readonly<{
    summary: string;
    evidence: string;
    suggested_resolution: string;
  } & (
    | { claim_type: string; confidence: string; falsifier: string }
    | { severity: string; blocking: boolean }
  )>>();
  const reviewRef = state.authoritative_results.find((candidate) =>
    candidate.phase_instance === state.phase_instance && candidate.step === "counter_review");
  let sourceReview: PriorTriageRecord["source_review"];
  if (reviewRef !== undefined) {
    const review = await dependencies.load_retained_result(reviewRef);
    if (!review.ok) return review;
    const manifest = review.value.prepared.manifest.value;
    if (manifest.source_artifact.artifact_kind === "review-evidence") {
      sourceReview = Object.freeze({
        evidence_digest: manifest.artifact_digest,
        evidence: manifest.source_artifact.evidence,
      });
      for (const finding of reviewFindings(manifest.source_artifact.evidence)) {
        const display = reviewFindingDisplayDetail(finding);
        findingsByRef.set(`${manifest.artifact_digest}:${finding.finding_id}`, {
          ...(manifest.source_artifact.evidence.schema_version !== "1" && "claim_type" in finding
            ? { claim_type: finding.claim_type, confidence: finding.confidence, falsifier: finding.falsifier }
            : "severity" in finding
              ? { severity: finding.severity, blocking: finding.blocking }
              : (() => { throw new TypeError("review finding does not match its native schema version"); })()),
          summary: display.summary,
          evidence: display.evidence,
          suggested_resolution: display.suggested_resolution,
        });
      }
    }
  }
  const dispositions: PriorTriageDisposition[] = triageSource.evidence.dispositions.map((disposition) => {
    const finding = findingsByRef.get(`${disposition.review_evidence_digest}:${disposition.finding_id}`);
    // Tolerant field selection: the triage disposition vocabulary can grow (for example
    // accepted-editorial); render whichever recorded response the shape carries.
    const recorded = disposition as Readonly<{ revision_intent?: unknown; rationale?: unknown }>;
    return {
      review_evidence_digest: disposition.review_evidence_digest,
      finding_id: disposition.finding_id,
      attempt: state.attempt,
      ...(finding ?? {}),
      disposition: disposition.disposition as string,
      ...(typeof recorded.rationale === "string" ? { rationale: recorded.rationale } : {}),
      ...(typeof recorded.revision_intent === "string"
        ? { revision_intent: recorded.revision_intent }
        : {}),
    };
  });
  const accepted = dispositions.filter((disposition) => disposition.disposition === "accepted");
  return ok(Object.freeze({
    phase_instance: state.phase_instance,
    current_attempt: state.attempt,
    ...(triageSource.evidence.response === undefined ? {} : { response: triageSource.evidence.response }),
    dispositions: Object.freeze(accepted),
    current: Object.freeze(accepted.map((disposition) => Object.freeze({
      ...(typeof disposition.review_evidence_digest === "string"
        ? { review_evidence_digest: disposition.review_evidence_digest as Sha256Digest }
        : {}),
      finding_id: disposition.finding_id,
      disposition: disposition.disposition,
    }))),
    ...(sourceReview === undefined ? {} : { source_review: sourceReview }),
  }));
}

/**
 * Renders the latest accepted dispositions. With `owns`, the record is scoped to one reviewer.
 */
export function priorTriageContextEntry(
  record: PriorTriageRecord,
  owns?: (findingId: string) => boolean,
  reviewerId?: string,
): PinnedContextEntry {
  if (record.response !== undefined) {
    const source = record.source_review?.evidence;
    const reports = source !== undefined && isFeedbackReview(source) ? [...(source.previous_reports ?? []), ...source.reports].filter(report => reviewerId === undefined || report.reviewer_id === reviewerId) : [];
    const requests = record.response.decision === "revise" ? record.response.reviewers.filter(reviewer => reviewerId === undefined || reviewer.reviewer_id === reviewerId) : [];
    // The child needs previous feedback, not accounting or the server's provenance bookkeeping.
    const previousReports = reports.map(report => "outcome" in report
      ? { reviewer_id: report.reviewer_id, outcome: report.outcome, feedback: report.feedback }
      : { reviewer_id: report.reviewer_id, report: report.report });
    return { ...pinnedContextEntry("prior-triage", "prior-round-response", new TextEncoder().encode(JSON.stringify({
      previous_reports: previousReports, revision_summary: record.response.rationale, verification_requests: requests,
    }))), ...(record.source_review === undefined ? {} : { source_version: record.source_review.evidence_digest }) };
  }
  const accepted = record.dispositions.filter((disposition) => disposition.disposition === "accepted");
  const dispositions = owns === undefined
    ? accepted
    : accepted.filter((disposition) => owns(disposition.finding_id));
  const rendered = {
    schema_version: "1",
    record_kind: "prior-triage",
    phase_instance: record.phase_instance,
    current_attempt: record.current_attempt,
    coverage: owns === undefined
      ? "the latest accepted findings for this phase instance"
      : "the latest accepted findings assigned to this reviewer",
    dispositions,
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(rendered, null, 2)}\n`);
  // Pinned whole: a head-truncated record would cut exactly the dispositions the reviewer must confirm.
  return pinnedContextEntry("prior-triage", "prior-round-triage", bytes);
}

export async function priorTriageEvidence(
  dependencies: Pick<TransactionDependencies, "load_retained_result">,
  state: TaskStateV1,
  preloaded?: PriorTriageRecord,
): Promise<ProjectResult<readonly PinnedContextEntry[]>> {
  const record = preloaded !== undefined
    ? ok<PriorTriageRecord | undefined>(preloaded)
    : await loadPriorTriageRecord(dependencies, state);
  if (!record.ok) return record;
  return ok(Object.freeze(
    record.value === undefined || (record.value.response === undefined && record.value.dispositions.length === 0)
      ? []
      : [priorTriageContextEntry(record.value)],
  ));
}
