import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { GateRequestV1 } from "../../src/contracts/durable-gate.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { createVerifiedEvidenceReference } from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { renderReviewEvidence } from "../../src/contracts/renderers.js";
import type { SupplementalReviewRecordV1 } from "../../src/contracts/supplemental-record.js";
import { runLocalCommand } from "../../src/local/commands.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import type { ResolvedTaskPath } from "../../src/repository/paths.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { openDurableGate, runDurableGate, type GateLifecycleDependencies, type GateOpenInput } from "../../src/state/gates.js";
import { createProductionServices } from "../../src/state/production.js";
import { readIntentReceipt, readTaskState } from "../../src/state/read.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const D = (value: string) => parseSha256Digest(value.repeat(64));
const TASK = parseTaskSlug("supplemental-round-trip");
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(15) });
const SUBJECT: InputFingerprintSubject = {
  schema_version: "1", workflow_digest: D("5"), config_digest: D("4"), constitution_digest: D("6"),
  artifact_identities: [], upstream_identities: [], rubric_digest: D("7"), phase_instance: PHASE, declared_inputs: [],
};
const FINGERPRINT = computeInputFingerprint(SUBJECT);
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

type Harness = Readonly<{ root: string; authority: TransactionAuthority; dependencies: GateLifecycleDependencies }>;

async function harness(): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-supplemental-round-trip-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env: GIT_ENV });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: GIT_ENV });
  mkdirSync(join(root, ".archflow", "tasks", TASK), { recursive: true });
  const context: RepositoryOperationContext = {
    task_id: TASK, phase_instance: PHASE, operation: parseSafeCode("supplemental-round-trip"), attempt: parseSafeInteger(1),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error("worktree discovery failed");
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error("git preflight failed");
  const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: TASK, context });
  if (!authority.ok) throw new Error("authority creation failed");
  const state: TaskStateV1 = {
    schema_version: "1", task_id: TASK, repository_identity_digest: authority.value.repository_identity_digest,
    revision: parseSafeInteger(7), phase_instance: PHASE, step: "produce", status: "running", attempt: parseSafeInteger(1),
    input_fingerprint: FINGERPRINT, initialization_digest: D("3"), config_digest: D("4"), workflow_digest: D("5"),
    constitution_digest: D("6"), policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [], approvals: [], waivers: [],
  };
  writeFileSync(authority.value.state.absolute, canonicalDocument(state).bytes);
  const dependencies: GateLifecycleDependencies = {
    runner: discovered.value, environment: environment.value, atomic: createAtomicWriter(),
    lock: { runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>) => work() },
    resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: SUBJECT }),
    read_state: readTaskState,
    read_config: async () => ({ kind: "valid", snapshot: { bytes: new Uint8Array(), digest: D("4") } }),
    read_receipt: readIntentReceipt,
  };
  return { root, authority: authority.value, dependencies };
}

function gateInput(h: Harness, intent: string): GateOpenInput {
  return {
    authority: h.authority, expected_revision: 7, intent_id: intent as GateOpenInput["intent_id"], request_digest: D("8"),
    input_fingerprint: FINGERPRINT, phase_instance: PHASE, summary: "Approve this phase", subject_digest: D("9"),
    current_evidence: {
      set_digest: D("a"),
      slots: [
        { role: "self-review", evidence_digest: D("b"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
        { role: "counter-review", evidence_digest: D("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
      ],
    },
    kind: "artifact-approval", context: { artifact_kind: "phase-implementation" },
  };
}

function recordFor(request: GateRequestV1): SupplementalReviewRecordV1 {
  const review = {
    schema_version: "1", task_id: request.task_id, phase_instance: request.phase_instance, step: "counter_review",
    role: "gate-counter-review", subject_digest: request.subject_digest, input_fingerprint: FINGERPRINT, rubric_digest: D("7"),
    producer_family: "claude", findings: [], matched_rule_versions: [], verdict: "pass", blocking_count: 0,
    model_family: "codex", model: "gpt-test", effort: "medium", assurance: "degraded", reason: "Offline supplemental review",
  } as const;
  const evidenceDigest = canonicalJsonDigest(review);
  const triage = {
    schema_version: "1", task_id: request.task_id, phase_instance: request.phase_instance, step: "triage",
    subject_digest: request.subject_digest, input_fingerprint: FINGERPRINT,
    current_evidence_set_digest: request.current_evidence.set_digest, source_evidence_digests: [evidenceDigest],
    dispositions: [], accepted_count: 0, rejected_count: 0,
  } as const;
  return {
    schema_version: "1", gate_id: request.gate_id, request_digest: request.request_digest,
    task_id: request.task_id, phase_instance: request.phase_instance, kind: request.kind,
    subject_digest: request.subject_digest, context_digest: request.context_digest, input_fingerprint: FINGERPRINT,
    current_evidence_set_digest: request.current_evidence.set_digest, evidence_digest: evidenceDigest,
    projection_digest: sha256Bytes(renderReviewEvidence(createVerifiedEvidenceReference(review))), review,
    triage_digest: canonicalJsonDigest(triage), triage, outcome: "no-change",
  };
}

function retainedPath(h: Harness, gateId: string): string {
  return join(h.authority.task_root, "decisions", gateId, "supplemental-review.json");
}

function projectionPath(h: Harness, gateId: string): string {
  return join(h.authority.task_root, "reviews", `${PHASE}.gate-counter.${gateId}.md`);
}

describe("production supplemental gate round trip", () => {
  it("retains the immutable record before publishing, retries identically, and authenticates through runDurableGate", async () => {
    const h = await harness();
    const input = gateInput(h, "supplemental-round-trip");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error(`gate open failed: ${JSON.stringify(opened.error)}`);
    const record = recordFor(opened.value.request.value);
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    mkdirSync(projectionPath(h, opened.value.gate_id));

    await expect(runLocalCommand({ command: "gate-counter", working_directory: h.root, task_id: TASK, value: record })).rejects.toThrow();
    expect(readFileSync(retainedPath(h, opened.value.gate_id))).toEqual(Buffer.from(canonicalDocument(record).bytes));
    rmSync(projectionPath(h, opened.value.gate_id), { recursive: true });

    const first = await runLocalCommand({ command: "gate-counter", working_directory: h.root, task_id: TASK, value: record });
    expect(first).toMatchObject({ installation: "exists", record_digest: canonicalDocument(record).digest });
    const retainedBefore = readFileSync(retainedPath(h, opened.value.gate_id));
    const projectionBefore = readFileSync(projectionPath(h, opened.value.gate_id));
    const second = await runLocalCommand({ command: "gate-counter", working_directory: h.root, task_id: TASK, value: record });
    expect(second).toEqual(first);
    expect(readFileSync(retainedPath(h, opened.value.gate_id))).toEqual(retainedBefore);
    expect(readFileSync(projectionPath(h, opened.value.gate_id))).toEqual(projectionBefore);

    const production = await createProductionServices({ working_directory: h.root, task_id: TASK, operation: parseSafeCode("gate-counter-resolve") });
    if (!production.ok) throw new Error(`production assembly failed: ${JSON.stringify(production.error)}`);
    const dependencies: GateLifecycleDependencies = {
      ...production.value.dependencies,
      read_config: h.dependencies.read_config,
      resolve_input_fingerprint: h.dependencies.resolve_input_fingerprint,
    };
    const resolved = await runDurableGate(dependencies, {
      ...input,
      authority: production.value.authority,
      signal: new AbortController().signal,
    });
    expect(resolved).toMatchObject({ ok: false, error: { code: "SUPPLEMENTAL_REVIEW_REQUIRED" } });
  });

  it.each([
    ["projection-only", (record: SupplementalReviewRecordV1) => record],
    ["server-attested", (record: SupplementalReviewRecordV1) => ({ ...record, review: { ...record.review, assurance: "server-attested" } })],
    ["fabricated-triage", (record: SupplementalReviewRecordV1) => ({ ...record, triage_digest: D("0") })],
  ])("rejects %s authority through the production retained-record resolver", async (variant, mutate) => {
    const h = await harness();
    const input = gateInput(h, `supplemental-${variant}`);
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    const record = recordFor(opened.value.request.value);
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    writeFileSync(projectionPath(h, opened.value.gate_id), "forged wake-up projection\n");
    if (variant !== "projection-only") writeFileSync(retainedPath(h, opened.value.gate_id), canonicalDocument(mutate(record) as never).bytes);
    expect(existsSync(projectionPath(h, opened.value.gate_id))).toBe(true);

    const production = await createProductionServices({ working_directory: h.root, task_id: TASK, operation: parseSafeCode("forged-resolve") });
    if (!production.ok) throw new Error("production assembly failed");
    const result = await production.value.dependencies.resolve_supplemental_review!({
      authority: production.value.authority,
      request: opened.value.request.value,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "supplemental-review-authority-invalid" } } },
    });
  });
});
