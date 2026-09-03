import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { encodePhaseInstance, type PhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { handleCounterReview, resolveRepositoryViewCommit } from "../../src/mcp/handlers/counter-review.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { REPOSITORY_VIEW_NOTE } from "../../src/review/envelopes.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { buildDocumentArtifact } from "../../src/state/document-artifact.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { prepareDocumentResult } from "../../src/mcp/handlers/state-results.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

const TASK = parseTaskSlug("pinned-context-ask");
const PRD_PHASE = encodePhaseInstance({ kind: "prd" });
const DESIGN_PHASE = encodePhaseInstance({ kind: "design" });
const PRD_BYTES = new TextEncoder().encode("# PRD\n\nRequirements.\n");
const DESIGN_BYTES = new TextEncoder().encode(
  "# Design\n\nArchitecture touches `tracked.txt` and `src/missing.ts`.\n",
);
const CONVENTIONS_BYTES = new TextEncoder().encode("# Conventions\n\nKeep it simple.\n");
const ASK_BYTES = new TextEncoder().encode("Please build a small widget with an off switch.\n");
function configBytes(options: FixtureOptions): Uint8Array {
  const roles = options.activeRule === true
    ? "  counter-reviewer:\n    model: gpt-fixture\n    effort: high\n  adjudicator:\n    model: gpt-fixture\n    effort: high\n"
    : "  counter-reviewer:\n    model: gpt-fixture\n    effort: high\n";
  return new TextEncoder().encode(`schema_version: "1"\nroles:\n${roles}`);
}
const scanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1", outcome: "clean", detector_set_id: "pinned-context-scanner" as never,
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

afterAll(cleanupTemporaryRepositories);

type FixtureOptions = Readonly<{
  phase: "prd" | "design";
  declareAsk?: boolean;
  approveUpstream?: boolean;
  /** Supplies a durable settlement but no human approval for the upstream. */
  upstreamReceipt?: boolean;
  /** Pins an active constitution rule so the merged call dispatches the constitution review too. */
  activeRule?: boolean;
}>;

async function fixture(options: FixtureOptions) {
  const repository = createTempRepository({ label: "pinned-context-ask" });
  const workflow = readFileSync(new URL("../../assets/workflow.yaml", import.meta.url));
  repository.write(".archflow/workflow.yaml", workflow);
  // Deliberately no active rules unless a test asks for them: this suite proves the pinned
  // context of the rubric review envelope, so the merged call must report the constitution
  // review as not-run rather than launching the second, adjudicating dispatch.
  repository.write(".archflow/constitution/00-process.md", `---
id: process
version: 1
status: ${options.activeRule === true ? "active" : "deprecated"}
---
Preserve explicit human review gates.
`);
  repository.write(`.archflow/tasks/${TASK}/config.yaml`, Buffer.from(configBytes(options)));
  repository.write(`.archflow/tasks/${TASK}/prd.md`, Buffer.from(PRD_BYTES));
  repository.write(`.archflow/tasks/${TASK}/design.md`, Buffer.from(DESIGN_BYTES));
  repository.write(`.archflow/tasks/${TASK}/ask.md`, Buffer.from(ASK_BYTES));
  repository.write("tracked.txt", "base\n");
  repository.write("CLAUDE.md", Buffer.from(CONVENTIONS_BYTES));
  repository.commitAll("pinned-context fixture");

  const activePhase: PhaseInstanceId = options.phase === "prd" ? PRD_PHASE : DESIGN_PHASE;
  const context = {
    task_id: TASK,
    phase_instance: activePhase,
    operation: parseSafeCode("pinned-context-fixture"),
    attempt: parseSafeInteger(1),
  } as const;
  const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), context);
  if (!discovered.ok) throw new Error(discovered.error.code);
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error(environment.error.code);
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: TASK,
    context,
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const policyBaseCommit = parseGitOid(repository.git("rev-parse", "HEAD"));
  const constitution = await resolvePinnedConstitution(discovered.value, policyBaseCommit, context);
  if (!constitution.ok) throw new Error(constitution.error.code);
  const configDigest = sha256Bytes(configBytes(options));
  const workflowDigest = sha256Bytes(workflow);
  const produceFingerprint = computeInputFingerprint({
    schema_version: "1",
    workflow_digest: workflowDigest,
    constitution_digest: constitution.value.digest,
    artifact_identities: [],
    upstream_identities: [],
    rubric_digest: canonicalJsonDigest({}),
    phase_instance: activePhase,
    declared_inputs: [],
  });
  const reviewFingerprint = computeInputFingerprint({
    schema_version: "1",
    workflow_digest: workflowDigest,
    constitution_digest: constitution.value.digest,
    artifact_identities: [],
    upstream_identities: [],
    rubric_digest: (await loadTestRubric(options.phase)).rubric_digest,
    phase_instance: activePhase,
    declared_inputs: [],
  });

  const producePhase = async (
    phase: PhaseInstanceId,
    documentPath: string,
    resultId: string,
    declaredInputs: readonly { input_id: string; path: string }[],
  ) => {
    const artifact = await buildDocumentArtifact(discovered.value, authority.value, {
      phase_instance: phase, step: "produce", document_path: parseTaskPathClaim(documentPath),
      declared_inputs: declaredInputs as never, input_fingerprint: produceFingerprint,
    });
    if (!artifact.ok) throw new Error(artifact.error.code);
    const prepared = await prepareDocumentResult({
      services: { authority: authority.value, runner: discovered.value } as Parameters<typeof prepareDocumentResult>[0]["services"],
      artifact: artifact.value, result_id: resultId as never,
      retained_task_bytes: parseSafeInteger(0), measured_at_revision: parseSafeInteger(6), scanner,
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
    return { reference: prepared.value.reference, artifact_digest: prepared.value.reference.result_digest, artifact: artifact.value };
  };

  const prd = await producePhase(
    PRD_PHASE, "prd.md", "produce-prd",
    options.declareAsk === true
      ? [{ input_id: "user-ask", path: `.archflow/tasks/${TASK}/ask.md` }]
      : [],
  );
  const prdArtifactDigest = canonicalJsonDigest(prd.artifact as never);
  const design = options.phase === "design"
    ? await producePhase(DESIGN_PHASE, "design.md", "produce-design", [])
    : undefined;

  const authoritativeResults = options.phase === "prd"
    ? [prd.reference]
    : [design!.reference, prd.reference];
  const state: TaskStateV1 = {
    schema_version: "1",
    task_id: TASK,
    repository_identity_digest: authority.value.repository_identity_digest,
    revision: parseSafeInteger(7),
    phase_instance: activePhase,
    step: "counter_review",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: reviewFingerprint,
    initialization_digest: canonicalJsonDigest({ fixture: "pinned-context" }),
    config_digest: configDigest,
    workflow_digest: workflowDigest,
    constitution_digest: constitution.value.digest,
    policy_base_commit: policyBaseCommit,
    authoritative_results: authoritativeResults,
    approvals: options.approveUpstream === true
      ? [{
          gate_id: "gate-prd-approval" as never,
          gate_kind: "artifact-approval",
          subject_digest: prdArtifactDigest,
          decision_digest: canonicalJsonDigest({ fixture: "prd-approval" }),
          resolved_at_revision: parseSafeInteger(6),
        }]
      : [],
    // The settle-time receipt shape the settling transaction writes: bound to the producing
    // step's phase instance and the retained manifest's artifact digest, at a past revision.
    ...(options.upstreamReceipt === true ? {
      rule_settlements: [{
        task_id: TASK,
        phase_instance: PRD_PHASE,
        step: "triage" as const,
        subject_digest: prdArtifactDigest,
        conclusion: { wait: false, match: null } as const,
        config_digest: configDigest,
        settled_at_revision: parseSafeInteger(6),
      }],
    } : {}),
    waivers: [],
  };
  writeFileSync(authority.value.state.absolute, canonicalDocument(state).bytes);
  mkdirSync(join(authority.value.workspace_root, "cache", "reviews"), { recursive: true });

  const bin = join(repository.root, "bin");
  const sourceHome = join(repository.root, "source-home");
  const envelopePath = join(repository.root, "captured-envelope.json");
  mkdirSync(join(sourceHome, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(sourceHome, ".codex", "auth.json"), "{}\n");
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  await writeFile(${JSON.stringify(envelopePath)}, raw);
  const envelope = JSON.parse(raw);
  const subject = envelope.subject;
  let output;
  if (subject.role === "counter-review") {
    output = {
      task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
      input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
      producer_family: subject.producer_family, findings: [], matched_rule_versions: []
    };
  } else {
    output = {
      schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "adjudicate", subject_digest: subject.subject_digest, input_fingerprint: subject.input_fingerprint,
      pinned_constitution_digest: subject.pinned_constitution_digest,
      approved_upstream_digests: subject.approved_upstream_digests,
      source_review_envelope_digest: subject.source_review_envelope_digest,
      rule_findings: envelope.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version,
        compliance: "pass", rationale: "The document respects this rule.", trigger: "not-matched",
        trigger_evidence: "No review trigger matched." })),
      drift_findings: subject.approved_upstream_digests.map((digest) => ({ upstream_digest: digest,
        drift: "aligned", affected_claim_ids: [], rationale: "No upstream drift." }))
    };
  }
  await writeFile(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}
`);
  chmodSync(executable, 0o755);

  const connection = connectionContextFactory.captureStartup({
    connection_id: "pinned-context-connection",
    startup_repository_candidate: { working_directory: repository.path },
  }).initialize({
    client: { name: "claude-code", version: "2.1.220" },
    host: "claude",
    protocol_version: "2025-11-25",
  });
  const invocation = (id: string) => createInvocationContext(connection, {
    invocation_id: id,
    transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
  }, new AbortController().signal);
  const args = {
    schema_version: "1",
    task_id: TASK,
    intent_id: "pinned-context-intent",
    expected_revision: 7,
    input_fingerprint: reviewFingerprint,
    artifact_path: options.phase === "prd" ? "prd.md" : "design.md",
  } as const;
  return { args, repository, bin, sourceHome, envelopePath, invocation };
}

function capturedEnvelope(path: string): {
  context: readonly Record<string, unknown>[];
  workspace?: Record<string, unknown>;
  subject?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof capturedEnvelope>;
}

const saved = { PATH: process.env.PATH, HOME: process.env.HOME };

function activateFixtureCli(h: { bin: string; sourceHome: string }): void {
  process.env.PATH = `${h.bin}${delimiter}${saved.PATH ?? dirname(process.execPath)}`;
  process.env.HOME = h.sourceHome;
}

describe("counter-review pinned context integration", () => {
  beforeEach(() => {
    saved.PATH = process.env.PATH;
    saved.HOME = process.env.HOME;
  });
  afterEach(() => {
    if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  });

  it("pins the declared verbatim ask into the PRD review envelope", async () => {
    const h = await fixture({ phase: "prd", declareAsk: true });
    activateFixtureCli(h);

    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invocation("ask-pinned"));
    expect(result).toMatchObject({
      schema_version: "1", ok: true, value: {
        verdict: "pass",
        // With zero active rules the server itself decides the constitution review is not run,
        // and the merged success says so explicitly instead of omitting the field.
        constitution: { status: "not-run", reason: "no-active-constitution-rules" },
      },
    });
    const envelope = capturedEnvelope(h.envelopePath);
    expect(envelope.context).toEqual([{
      kind: "user-ask",
      label: "ask.md",
      status: "pinned",
      content_digest: sha256Bytes(ASK_BYTES),
      encoding: "utf8",
      content: new TextDecoder().decode(ASK_BYTES),
    }]);
    expect(envelope.workspace).toEqual({
      kind: "read-only-repository-checkout",
      commit: h.repository.git("rev-parse", "HEAD"),
      note: REPOSITORY_VIEW_NOTE,
    });
    // The server stamped the durable attempt counter into the child-visible subject.
    expect(envelope.subject).toMatchObject({ attempt: 1 });
  });

  it("reviews against pinned policy when the task branch commits a constitution edit", async () => {
    const h = await fixture({ phase: "prd", declareAsk: true });
    activateFixtureCli(h);
    h.repository.write(".archflow/constitution/00-process.md", `---
id: process
version: 2
status: active
review_trigger: The task branch proposes a future policy change.
---
Future tasks should use this revised policy.
`);
    h.repository.git("add", "--", ".archflow/constitution/00-process.md");
    h.repository.git("commit", "-m", "revise future policy");

    const result = await handleCounterReview(
      parseToolCall("archflow_counter_review", h.args),
      h.invocation("task-branch-policy-edit"),
    );
    expect(result).toMatchObject({
      schema_version: "1", ok: true, value: {
        verdict: "pass",
        constitution: { status: "not-run", reason: "no-active-constitution-rules" },
      },
    });
    expect(capturedEnvelope(h.envelopePath).workspace).toMatchObject({
      kind: "read-only-repository-checkout",
      commit: h.repository.git("rev-parse", "HEAD"),
    });
  });

  it("routes the reviewer checkout to the implementation base commit, not HEAD", async () => {
    const base = parseGitOid("ab".repeat(20));
    await expect(resolveRepositoryViewCommit(
      {} as never,
      { artifact_kind: "implementation-output", base_commit: base } as never,
    )).resolves.toBe(base);
  });

  it("fails closed without dispatching when the declared ask has drifted", async () => {
    const h = await fixture({ phase: "prd", declareAsk: true });
    activateFixtureCli(h);
    h.repository.write(`.archflow/tasks/${TASK}/ask.md`, "Rewritten after produce.\n");

    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invocation("ask-drifted"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "user-ask-not-current" } } },
    });
    expect(() => readFileSync(h.envelopePath)).toThrow();
  });

  it("stays reviewable with a named unavailable entry when no ask was declared", async () => {
    const h = await fixture({ phase: "prd", declareAsk: false });
    activateFixtureCli(h);

    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invocation("ask-undeclared"));
    expect(result).toMatchObject({ schema_version: "1", ok: true, value: { verdict: "pass" } });
    const context = capturedEnvelope(h.envelopePath).context;
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({ kind: "user-ask", label: "ask.md", status: "unavailable" });
  });

  it("pins the approved upstream PRD plus mechanical evidence into the design review envelope", async () => {
    const h = await fixture({ phase: "design", approveUpstream: true });
    activateFixtureCli(h);

    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invocation("upstream-pinned"));
    expect(result).toMatchObject({ schema_version: "1", ok: true, value: { verdict: "pass" } });
    const envelope = capturedEnvelope(h.envelopePath);
    expect(envelope.workspace).toMatchObject({
      kind: "read-only-repository-checkout",
      commit: h.repository.git("rev-parse", "HEAD"),
    });
    const context = envelope.context;
    expect(context.map((entry) => [entry.kind, entry.label, entry.status])).toEqual([
      ["approved-upstream", "prd.md", "pinned"],
      ["interface-excerpt", "tracked.txt", "pinned"],
      ["interface-excerpt", "src/missing.ts", "unavailable"],
      ["repo-map", `tree ${h.repository.git("rev-parse", "HEAD")}`, "pinned"],
      ["conventions", "CLAUDE.md", "pinned"],
    ]);
    expect(context[0]).toMatchObject({
      content_digest: sha256Bytes(PRD_BYTES),
      content: new TextDecoder().decode(PRD_BYTES),
    });
    expect(context[1]).toMatchObject({ content: "base\n" });
    expect(String(context[3]!.content)).toContain("tracked.txt");
    expect(context[4]).toMatchObject({ content: new TextDecoder().decode(CONVENTIONS_BYTES) });
  });

  it("fails closed without dispatching when the upstream lacks durable approval", async () => {
    const h = await fixture({ phase: "design", approveUpstream: false });
    activateFixtureCli(h);

    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invocation("upstream-unapproved"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "upstream-approval-missing" } } },
    });
    expect(() => readFileSync(h.envelopePath)).toThrow();
  });

  it("refuses to pin a settlement-only upstream", async () => {
    const h = await fixture({ phase: "design", upstreamReceipt: true });
    activateFixtureCli(h);

    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invocation("upstream-receipt"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "upstream-approval-missing" } } },
    });
    expect(() => readFileSync(h.envelopePath)).toThrow();
  });

  it("does not dispatch constitution review over a settlement-only upstream", async () => {
    const h = await fixture({ phase: "design", upstreamReceipt: true, activeRule: true });
    activateFixtureCli(h);

    const result = await handleCounterReview(parseToolCall("archflow_counter_review", h.args), h.invocation("upstream-receipt-constitution"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "upstream-approval-missing" } } },
    });
  });
});
