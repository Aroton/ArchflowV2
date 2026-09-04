import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { handleCounterReview } from "../../src/mcp/handlers/counter-review.js";
import { MULTI_REPOSITORY_VIEW_NOTE, REPOSITORY_VIEW_NOTE } from "../../src/review/envelopes.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { buildDocumentArtifact } from "../../src/state/document-artifact.js";
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { prepareDocumentResult } from "../../src/mcp/handlers/state-results.js";
import { cleanupTemporaryRepositories, createTempRepository, type TempRepository } from "../helpers/temp-repository.js";

const TASK = parseTaskSlug("multi-repository-review");
const PHASE = encodePhaseInstance({ kind: "prd" });
const PRD_BYTES = new TextEncoder().encode("# PRD\n\nReview every configured repository.\n");
const scanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1", outcome: "clean", detector_set_id: "multi-repository-scanner" as never,
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

afterAll(cleanupTemporaryRepositories);

type Fixture = Readonly<{
  primary: TempRepository;
  secondary: TempRepository | undefined;
  args: Readonly<Record<string, unknown>>;
  invoke: (id: string) => ReturnType<typeof createInvocationContext>;
  bin: string;
  home: string;
  capture: string;
  authorityRoot: string;
}>;

function configSource(secondary?: TempRepository, name = "api"): string {
  return `schema_version: "1"
roles:
  counter-reviewer:
    model: gpt-fixture
    effort: high
${secondary === undefined ? "" : `repositories:\n  ${name}:\n    path: ${JSON.stringify(secondary.path)}\n    mode: context-only\n`}`;
}

async function fixture(options: Readonly<{ plural: boolean; drift?: boolean; remove?: boolean }>): Promise<Fixture> {
  const primary = createTempRepository({ label: options.plural ? "multi-review-primary" : "single-review-primary" });
  const secondary = options.plural ? createTempRepository({ label: "multi-review-secondary" }) : undefined;
  if (secondary !== undefined) {
    secondary.write("api.ts", "export const api = true;\n");
    secondary.write(".archflow/tasks/foreign/state.json", "{}\n");
    secondary.commitAll("secondary context");
  }
  const workflow = readFileSync(new URL("../../assets/workflow.yaml", import.meta.url));
  const config = configSource(secondary);
  primary.write(".archflow/workflow.yaml", workflow);
  primary.write(".archflow/constitution/00-retired.md", `---
id: retired
version: 1
status: deprecated
---
No active rule.
`);
  primary.write(`.archflow/tasks/${TASK}/config.yaml`, config);
  primary.write(`.archflow/tasks/${TASK}/prd.md`, Buffer.from(PRD_BYTES));
  primary.write("primary.ts", "export const primary = true;\n");
  primary.commitAll("review fixture");

  const operation = {
    task_id: TASK, phase_instance: PHASE,
    operation: parseSafeCode("multi-repository-review-fixture"), attempt: parseSafeInteger(1),
  } as const;
  const discovered = await discoverWorktree(createGitRunner({ cwd: primary.path }), operation);
  if (!discovered.ok) throw new Error(discovered.error.code);
  const environment = await preflightGit(discovered.value, operation);
  if (!environment.ok) throw new Error(environment.error.code);
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value, environment: environment.value, task_id: TASK, context: operation,
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const policyBase = parseGitOid(primary.git("rev-parse", "HEAD"));
  const constitution = await resolvePinnedConstitution(discovered.value, policyBase, operation);
  if (!constitution.ok) throw new Error(constitution.error.code);
  const workflowDigest = sha256Bytes(workflow);
  const produceFingerprint = computeInputFingerprint({
    schema_version: "1", workflow_digest: workflowDigest, constitution_digest: constitution.value.digest,
    artifact_identities: [], upstream_identities: [], rubric_digest: canonicalJsonDigest({}),
    phase_instance: PHASE, declared_inputs: [],
  });
  const reviewFingerprint = computeInputFingerprint({
    schema_version: "1", workflow_digest: workflowDigest, constitution_digest: constitution.value.digest,
    artifact_identities: [], upstream_identities: [],
    rubric_digest: (await loadTestRubric("prd")).rubric_digest,
    phase_instance: PHASE, declared_inputs: [],
  });
  const artifact = await buildDocumentArtifact(discovered.value, authority.value, {
    phase_instance: PHASE, step: "produce", document_path: parseTaskPathClaim("prd.md"),
    declared_inputs: [], input_fingerprint: produceFingerprint,
  });
  if (!artifact.ok) throw new Error(artifact.error.code);
  const prepared = await prepareDocumentResult({
    services: { authority: authority.value, runner: discovered.value } as Parameters<typeof prepareDocumentResult>[0]["services"],
    artifact: artifact.value, result_id: "produce-prd" as never, retained_task_bytes: parseSafeInteger(0),
    measured_at_revision: parseSafeInteger(6), scanner,
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  await ensureResultDirectory(authority.value, prepared.value.reference.result_digest);
  for (const payload of prepared.value.prepared.payloads) {
    await ensurePayloadParent(authority.value, prepared.value.reference.result_digest, payload.target.absolute as never);
  }
  const installed = await installSnapshot(
    createAtomicWriter(), prepared.value.prepared, prepared.value.manifest_target,
    discovered.value.location.worktreeRoot as never,
  );
  if (!installed.ok) throw new Error(installed.error.code);
  const state: TaskStateV1 = {
    schema_version: "1", task_id: TASK,
    repository_identity_digest: authority.value.repository_identity_digest,
    revision: parseSafeInteger(7), phase_instance: PHASE, step: "counter_review", status: "running",
    attempt: parseSafeInteger(1), input_fingerprint: reviewFingerprint,
    initialization_digest: canonicalJsonDigest({ fixture: "multi-repository-review" }),
    config_digest: sha256Bytes(new TextEncoder().encode(config)), workflow_digest: workflowDigest,
    constitution_digest: constitution.value.digest, policy_base_commit: policyBase,
    authoritative_results: [prepared.value.reference], approvals: [], waivers: [],
  };
  writeFileSync(authority.value.state.absolute, canonicalDocument(state).bytes);
  mkdirSync(join(authority.value.workspace_root, "cache", "reviews"), { recursive: true });

  const bin = join(primary.root, "bin");
  const home = join(primary.root, "home");
  const capture = join(primary.root, "capture.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), "{}\n");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8"); const envelope = JSON.parse(raw);
  const target = argv[argv.indexOf("-C") + 1];
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ envelope, target,
    entries: readdirSync(target).sort(), primary: existsSync(join(target, "primary.ts")),
    api: existsSync(join(target, "api", "api.ts")), apiAuthority: existsSync(join(target, "api", ".archflow")) }));
  ${options.remove === true && secondary !== undefined ? `rmSync(${JSON.stringify(secondary.path)}, { recursive: true, force: true });` : ""}
  ${options.drift === true && secondary !== undefined ? `writeFileSync(${JSON.stringify(join(secondary.path, "drift.txt"))}, "drift\\n"); execFileSync("git", ["add", "."], { cwd: ${JSON.stringify(secondary.path)} }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "drift"], { cwd: ${JSON.stringify(secondary.path)} });` : ""}
  const subject = envelope.subject; const assignment = envelope.assignment;
  const output = { schema_version: "3", task_id: subject.task_id,
    phase_instance: subject.phase_instance, step: "counter_review", role: "counter-review",
    subject_digest: subject.subject_digest, input_fingerprint: subject.input_fingerprint,
    rubric_digest: subject.rubric_digest, producer_family: subject.producer_family,
    findings: [],
    ...(Object.hasOwn(assignment, "expected_upstream_digests") ? {
      upstream_alignment: assignment.expected_upstream_digests.map((upstream_digest) => ({
        upstream_digest, drift: "aligned", affected_claim_ids: [], rationale: "Fixture found no drift."
      }))
    } : {}),
    ...(Object.hasOwn(assignment, "legacy_confirmations") ? {
      legacy_confirmations: assignment.legacy_confirmations.map(({ finding_id }) => ({
        finding_id, status: "resolved", evidence: "Fixture confirms the accepted revision."
      }))
    } : {}) };
  writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}
`);
  chmodSync(join(bin, "codex"), 0o755);
  const connection = connectionContextFactory.captureStartup({
    connection_id: `multi-repository-${options.plural ? "plural" : "single"}`,
    startup_repository_candidate: { working_directory: primary.path },
  }).initialize({ client: { name: "claude-code", version: "2.1.220" }, host: "claude", protocol_version: "2025-11-25" });
  const invoke = (id: string) => createInvocationContext(connection, {
    invocation_id: id, transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
  }, new AbortController().signal);
  return {
    primary, secondary, bin, home, capture, authorityRoot: authority.value.task_root,
    invoke,
    args: { schema_version: "1", task_id: TASK, intent_id: "review-intent", expected_revision: 7,
      input_fingerprint: reviewFingerprint, artifact_path: "prd.md" },
  };
}

const saved = { path: process.env.PATH, home: process.env.HOME };
function activate(h: Fixture): void {
  process.env.PATH = `${h.bin}${delimiter}${saved.path ?? dirname(process.execPath)}`;
  process.env.HOME = h.home;
}
function capture(h: Fixture): Readonly<Record<string, any>> {
  return JSON.parse(readFileSync(h.capture, "utf8")) as Readonly<Record<string, any>>;
}
function reviewManifest(h: Fixture): ResultManifestV1 {
  const state = JSON.parse(readFileSync(join(h.authorityRoot, "state.json"), "utf8")) as TaskStateV1;
  for (const reference of state.authoritative_results) {
    const manifest = JSON.parse(readFileSync(join(h.authorityRoot, "authority", "results", `${reference.result_digest}.json`), "utf8")) as ResultManifestV1;
    if (manifest.source_artifact.artifact_kind === "review-evidence") return manifest;
  }
  throw new Error("review evidence was not installed");
}

describe("multi-repository counter-review handler", () => {
  beforeEach(() => { saved.path = process.env.PATH; saved.home = process.env.HOME; });
  afterEach(() => {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  });

  it("binds plural document snapshots and the same ordered pins into durable evidence", async () => {
    const h = await fixture({ plural: true }); activate(h);
    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invoke("plural-review"));
    expect(result).toMatchObject({ ok: true, value: { verdict: "pass" } });
    const observed = capture(h);
    expect(observed.entries).toEqual(["api", "primary"]);
    expect(observed.api).toBe(true);
    expect(observed.apiAuthority).toBe(false);
    expect(observed.envelope.workspace).toEqual({
      kind: "read-only-multi-repository-view", note: MULTI_REPOSITORY_VIEW_NOTE,
      repositories: [
        expect.objectContaining({ name: "primary", path: "primary", commit: h.primary.git("rev-parse", "HEAD") }),
        expect.objectContaining({ name: "api", path: "api", commit: h.secondary!.git("rev-parse", "HEAD") }),
      ],
    });
    const artifact = reviewManifest(h).source_artifact;
    expect(artifact.artifact_kind).toBe("review-evidence");
    if (artifact.artifact_kind !== "review-evidence") throw new Error("unexpected artifact");
    if (artifact.evidence.assurance !== "server-attested") throw new Error("unexpected assurance");
    expect(artifact.evidence).toMatchObject({ assurance: "server-attested", repositories: observed.envelope.workspace.repositories.map((entry: any) => ({
      name: entry.name, repository_identity_digest: entry.repository_identity_digest, commit: entry.commit,
    })) });
  });

  it("preserves the legacy single-repository checkout binding and child cwd", async () => {
    const h = await fixture({ plural: false }); activate(h);
    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invoke("single-review"));
    expect(result).toMatchObject({ ok: true, value: { verdict: "pass" } });
    const observed = capture(h);
    expect(observed.entries).toContain("primary.ts");
    expect(observed.primary).toBe(true);
    expect(observed.envelope.workspace).toEqual({
      kind: "read-only-repository-checkout", commit: h.primary.git("rev-parse", "HEAD"), note: REPOSITORY_VIEW_NOTE,
    });
    const artifact = reviewManifest(h).source_artifact;
    if (artifact.artifact_kind !== "review-evidence") throw new Error("unexpected artifact");
    expect(artifact.evidence.assurance).toBe("server-attested");
    if (artifact.evidence.assurance !== "server-attested") throw new Error("unexpected assurance");
    expect(artifact.evidence.repositories).toHaveLength(1);
    expect(artifact.evidence.repositories?.[0]).toMatchObject({ name: "primary", commit: h.primary.git("rev-parse", "HEAD") });
  });

  it("rejects a secondary HEAD advance after dispatch and installs no review evidence", async () => {
    const h = await fixture({ plural: true, drift: true }); activate(h);
    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invoke("drift-review"));
    expect(result).toMatchObject({ ok: false, error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "counter-review-subject-not-current" } } } });
    const state = JSON.parse(readFileSync(join(h.authorityRoot, "state.json"), "utf8")) as TaskStateV1;
    expect(state.revision).toBe(7);
    expect(state.authoritative_results).toHaveLength(1);
    expect(() => reviewManifest(h)).toThrow("review evidence was not installed");
  });

  it("names a secondary that disappears during dispatch and keeps the review current", async () => {
    const h = await fixture({ plural: true, remove: true }); activate(h);
    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invoke("vanish-review"));
    expect(capture(h).api).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_VIEW_UNAVAILABLE", retryable: true, diagnostic: { parameters: { repository_name: "api" } } },
    });
    // The loss during dispatch is reported exactly like the loss before it: the state did not
    // advance, no evidence was installed, and the same review offer remains current.
    const state = JSON.parse(readFileSync(join(h.authorityRoot, "state.json"), "utf8")) as TaskStateV1;
    expect(state).toMatchObject({ revision: 7, step: "counter_review", status: "running" });
    expect(state.authoritative_results).toHaveLength(1);
    expect(() => reviewManifest(h)).toThrow("review evidence was not installed");
  });

  it("names a secondary that becomes unavailable before dispatch verbatim (dotted names included), installs no evidence, and leaves topology faults as configuration errors", async () => {
    const h = await fixture({ plural: true }); activate(h);
    h.primary.write(`.archflow/tasks/${TASK}/config.yaml`, configSource(h.secondary, "api.v2"));
    rmSync(h.secondary!.path, { recursive: true, force: true });
    const unavailable = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invoke("missing-dotted-review"));
    expect(unavailable).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_VIEW_UNAVAILABLE", diagnostic: { parameters: { repository_name: "api.v2" } } },
    });
    expect(() => reviewManifest(h)).toThrow("review evidence was not installed");

    // A secondary nested inside the primary is a configuration fault, not an availability one.
    h.primary.write(`.archflow/tasks/${TASK}/config.yaml`, configSource(h.primary));
    const topology = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invoke("nested-review"));
    expect(topology).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
  });
});
