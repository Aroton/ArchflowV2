import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../../src/contracts/canonical.js";
import {
  parseAndDeriveAdjudication,
  type AdjudicationEvidence,
} from "../../src/contracts/adjudication.js";
import type { ConstitutionRegistry } from "../../src/contracts/constitution.js";
import type { GateDecisionRecordV1, GateRequestV1 } from "../../src/contracts/durable-gate.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import type { GateDecisionEnvelope, WaiverOriginRef } from "../../src/contracts/gates.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type GitEnvironment, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import { AtomicReplaceError, createAtomicWriter, createProjectionWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { openDurableGate, resolveDurableGate, runDurableGate, type GateLifecycleDependencies, type GateOpenInput } from "../../src/state/gates.js";
import { readIntentReceipt, readTaskState } from "../../src/state/read.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";
import type { SupplementalReviewOutcome } from "../../src/contracts/supplemental.js";
import { captureProjectionTarget, projectionGenerationDigest, type ProjectionPlan } from "../../src/state/snapshots.js";
import { planStateTransition } from "../../src/state/transitions.js";
import {
  selectAdjudicationGate,
  type AdjudicationGateRequest,
} from "../../src/review/adjudication.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const D = (value: string) => parseSha256Digest(value.repeat(64));
const TASK = parseTaskSlug("gate-lifecycle");
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(12) });
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const PROVENANCE = {
  schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
  decision_event_id: "gate-decision", helper_invocation_id: "gate-helper", recorded_at: "2026-07-30T12:00:00.000Z",
} as const;
const SUBJECT: InputFingerprintSubject = {
  schema_version: "1", workflow_digest: D("5"), config_digest: D("4"), constitution_digest: D("6"),
  artifact_identities: [], upstream_identities: [], rubric_digest: D("7"), phase_instance: PHASE, declared_inputs: [],
};
const FINGERPRINT = computeInputFingerprint(SUBJECT);

type Harness = Readonly<{
  root: string;
  authority: TransactionAuthority;
  dependencies: GateLifecycleDependencies;
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
}>;

function initialState(authority: TransactionAuthority): TaskStateV1 {
  return {
    schema_version: "1", task_id: TASK, repository_identity_digest: authority.repository_identity_digest,
    revision: parseSafeInteger(7), phase_instance: PHASE, step: "produce", status: "running", attempt: parseSafeInteger(1),
    input_fingerprint: FINGERPRINT, initialization_digest: D("3"), config_digest: D("4"), workflow_digest: D("5"),
    constitution_digest: D("6"), policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [], approvals: [], waivers: [],
    committed_intent: {
      intent_id: "prior-intent" as GateOpenInput["intent_id"], request_digest: D("d"), receipt_digest: D("e"),
      outcome_digest: D("f"), prior_revision: parseSafeInteger(6), resulting_revision: parseSafeInteger(7), result_id: "prior-result" as never,
    },
  };
}

async function harness(): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-gate-lifecycle-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env: GIT_ENV });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: GIT_ENV });
  mkdirSync(join(root, ".archflow", "tasks", TASK), { recursive: true });
  const context: RepositoryOperationContext = {
    task_id: TASK, phase_instance: PHASE, operation: parseSafeCode("gate-lifecycle-test"), attempt: parseSafeInteger(1),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error("worktree discovery failed");
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error("git preflight failed");
  const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: TASK, context });
  if (!authority.ok) throw new Error("authority creation failed");
  writeFileSync(authority.value.state.absolute, canonicalDocument(initialState(authority.value)).bytes);
  const dependencies: GateLifecycleDependencies = {
    runner: discovered.value,
    environment: environment.value,
    atomic: createAtomicWriter(),
    lock: { runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>) => work() },
    resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: SUBJECT }),
    read_state: readTaskState,
    read_config: async () => ({ kind: "valid", snapshot: { bytes: new Uint8Array(), digest: D("4") } }),
    read_receipt: readIntentReceipt,
    resolve_supplemental_review: async ({ request, outcome }) => ({
      schema_version: "1",
      ok: true,
      value: {
        evidence: supplementalEvidence(request),
        gate_id: request.gate_id,
        ...(outcome?.action === "triage-no-change"
          ? { triage_digest: outcome.triage_digest, triage_outcome: "no-change" as const }
          : outcome?.action === "supersede"
            ? { triage_digest: outcome.accepted_triage_digest, triage_outcome: "accepted-change" as const }
            : {}),
      },
    }),
  };
  return { root, authority: authority.value, dependencies, runner: discovered.value, environment: environment.value };
}

function gateInput(h: Harness, intent = "gate-intent"): GateOpenInput {
  return {
    authority: h.authority, expected_revision: 7, intent_id: intent as GateOpenInput["intent_id"], request_digest: D("8"),
    input_fingerprint: FINGERPRINT, phase_instance: PHASE, summary: "Approve the implementation", subject_digest: D("9"),
    current_evidence: {
      set_digest: D("a"),
      slots: [
        { role: "counter-review", evidence_digest: D("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
      ],
    }, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" },
  };
}

function envelope(request: GateRequestV1, decision: "approve" | "revise" | "reject" = "approve"): GateDecisionEnvelope {
  return {
    schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance,
    kind: "artifact-approval", subject_digest: request.subject_digest, context_digest: request.context_digest,
    human_provenance: PROVENANCE, payload: { decision, reason: "Human reviewed the phase" },
  };
}

function decisionPath(h: Harness): string { return join(h.authority.task_root, "gate.decision"); }
function gatePath(h: Harness): string { return join(h.authority.task_root, "gate.json"); }
function archivePath(h: Harness, gateId: string): string { return join(h.authority.task_root, "decisions", gateId, "decision.json"); }
function reviewPath(h: Harness, gateId: string): string { return join(h.authority.task_root, "reviews", `${PHASE}.gate-counter.${gateId}.md`); }

type RefusalPostcondition = Readonly<{
  revision: number;
  approvals: TaskStateV1["approvals"];
  receipt: Uint8Array | undefined;
}>;

async function refusalPostcondition(h: Harness, intentId: string): Promise<RefusalPostcondition> {
  const state = await readTaskState(h.authority.state);
  if (state.kind !== "canonical") throw new Error("state unavailable");
  const receiptPath = join(h.authority.task_root, "intents", `${intentId}.json`);
  return {
    revision: state.document.value.revision,
    approvals: structuredClone(state.document.value.approvals),
    receipt: existsSync(receiptPath) ? readFileSync(receiptPath) : undefined,
  };
}

async function expectRefusalDidNotAdvance(
  h: Harness,
  intentId: string,
  before: RefusalPostcondition,
): Promise<void> {
  const after = await refusalPostcondition(h, intentId);
  expect(after.revision).toBe(before.revision);
  expect(after.approvals).toEqual(before.approvals);
  expect(after.receipt).toEqual(before.receipt);
}

function supplementalEvidence(request: GateRequestV1) {
  return {
    schema_version: "1",
    task_id: request.task_id,
    phase_instance: request.phase_instance,
    step: "counter_review",
    role: "gate-counter-review",
    subject_digest: request.subject_digest,
    input_fingerprint: FINGERPRINT,
    rubric_digest: D("7"),
    producer_family: "claude",
    findings: [],
    matched_rule_versions: [],
    verdict: "pass",
    blocking_count: 0,
    model_family: "codex",
    model: "gpt-test",
    effort: "medium",
    assurance: "degraded",
    reason: "Offline supplemental review",
  } as const;
}

async function waiverInput(h: Harness, intent: string): Promise<GateOpenInput> {
  const rule = { rule_id: "human-review", rule_version: 1 } as const;
  const originInput: GateOpenInput = {
    ...gateInput(h, `${intent}-origin`), kind: "constitution-review",
    context: { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [rule], uncertain_trigger_rules: [], eligible_waivers: [{ rule, scope: { operation: "review-trigger", boundary: "phase" } }] },
  };
  const opened = await openDurableGate(h.dependencies, originInput);
  if (!opened.ok) throw new Error("origin gate open failed");
  const originEnvelope: GateDecisionEnvelope = {
    schema_version: "1", gate_id: opened.value.gate_id, task_id: TASK, phase_instance: PHASE, kind: "constitution-review",
    subject_digest: originInput.subject_digest, context_digest: opened.value.request.value.context_digest, human_provenance: PROVENANCE,
    payload: { decision: "waiver-requested", reason: "Request waiver", rule, operation: "review-trigger", rationale: "Human waiver requested" },
  };
  writeFileSync(decisionPath(h), canonicalDocument(originEnvelope).bytes);
  const closed = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
  if (!closed.ok) throw new Error("origin gate resolution failed");
  const origin: WaiverOriginRef = {
    origin_gate_id: opened.value.gate_id, origin_decision_digest: closed.value.record.digest, origin_context_digest: opened.value.request.value.context_digest,
    task_id: TASK, phase_instance: PHASE, subject_digest: D("9"), current_evidence_set_digest: D("a"),
    rule, scope: { operation: "review-trigger", boundary: "phase" },
  };
  return {
    ...gateInput(h, intent), expected_revision: closed.value.state.value.revision, kind: "constitution-review", context: { origin, rationale: "Human waiver requested" },
    waiver_origin_gate_id: origin.origin_gate_id,
  };
}

function waiverInterface(request: GateRequestV1, granted: boolean): PlainJsonValue {
  const context = request.context as { origin: WaiverOriginRef };
  return {
    schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance,
    subject_digest: request.subject_digest, context_digest: request.context_digest, granted, scope: context.origin.scope,
    origin: context.origin, notes: granted ? "Granted" : "Denied", human_provenance: PROVENANCE,
  };
}

function supplementalFor(h: Harness, gateId: GateOpenInput["intent_id"], evidenceDigest: ReturnType<typeof D>, action: "ingest" | "triage-no-change" | "supersede"): SupplementalReviewOutcome {
  const review = {
    prior_gate_id: gateId, task_id: TASK, phase_instance: PHASE, subject_digest: D("9"), input_fingerprint: FINGERPRINT,
    evidence_slot: { role: "gate-counter-review" as const, evidence_digest: evidenceDigest, assurance: "degraded" as const,
      producer_family: "claude" as const, reviewer_family: "codex" as const, independence: "opposite-family" as const, gate_id: gateId },
  };
  if (action === "ingest") return { action, review, reason: "Review ingested" };
  if (action === "triage-no-change") return { action, review, triage_digest: D("3"), reason: "No change required" };
  return { action, review, accepted_triage_digest: D("4"), old_subject_digest: D("9"), new_subject_digest: D("8"), reason: "Superseded by revision" };
}

async function restoreFixture(
  h: Harness,
  changedInput: boolean,
  scanner?: SecretScanner,
  gitTracked = false,
): Promise<Readonly<{
  input: GateOpenInput;
  dependencies: GateLifecycleDependencies;
  target: ResolvedPath;
  desired: Uint8Array;
  currentDigest: ReturnType<typeof D>;
  writerEvents: string[];
  plan: ProjectionPlan;
}>> {
  const repositoryPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/restored.md`);
  const target: ResolvedPath = {
    absolute: join(h.root, repositoryPath) as ResolvedTaskPath, repositoryRelative: repositoryPath, path_class: "document",
  };
  mkdirSync(join(h.authority.task_root, "phases"), { recursive: true });
  const desired = new TextEncoder().encode("retained generation\n");
  writeFileSync(target.absolute, desired);
  const desiredDigest = projectionGenerationDigest((await captureProjectionTarget(target)).observation);
  const current = new TextEncoder().encode("human collision\n");
  writeFileSync(target.absolute, current);
  const currentCapture = await captureProjectionTarget(target);
  const currentDigest = projectionGenerationDigest(currentCapture.observation);
  const reference = {
    phase_instance: PHASE, step: "produce" as const, result_digest: D("1"), result_id: parseSafeId("restore-result"),
    input_fingerprint: changedInput ? D("0") : FINGERPRINT,
    manifest_path: parseRepositoryPathClaim(`.archflow/tasks/${TASK}/results/sha256/${D("1")}/manifest.json`),
  };
  writeFileSync(h.authority.state.absolute, canonicalDocument({ ...initialState(h.authority), authoritative_results: [reference] }).bytes);
  const plan: ProjectionPlan = {
    entries: [{
      path: repositoryPath, target, observed_before: currentCapture.observation,
      desired: { state: "present", file_type: "regular", mode: "100644", bytes: desired },
      rollback: currentCapture.rollback, git_tracked: gitTracked, disposition: "collision",
    }],
    collisions: [{ path: repositoryPath, path_class: "document" }],
    collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
  };
  const retained = { projection_plan: plan, worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath };
  const writerEvents: string[] = [];
  const realWriter = createProjectionWriter();
  const dependencies: GateLifecycleDependencies = {
    ...h.dependencies,
    load_retained_result: async () => ({ schema_version: "1", ok: true, value: retained as never }),
    projection_writer: {
      replaceRegular: async (...args) => { writerEvents.push("replace-regular"); await realWriter.replaceRegular(...args); },
      replaceSymlink: async (...args) => { writerEvents.push("replace-symlink"); await realWriter.replaceSymlink(...args); },
      remove: async (...args) => { writerEvents.push("remove"); await realWriter.remove(...args); },
    },
    gate_secret_scanner: scanner ?? { scan: async (candidates) => ({ schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"), scanned_paths: candidates.map((item) => item.virtual_path) }) },
  };
  const context = {
    path: parseTaskPathClaim("phases/restored.md"), recorded_generation_digest: desiredDigest, current_generation_digest: currentDigest,
    ...(changedInput ? { adoption_candidate: {
      link_digest: D("2"), purpose: "restore-adoption" as const, proposed_generation_digest: currentDigest, changed_input_fingerprint: FINGERPRINT,
    } } : {}),
  };
  return {
    input: { ...gateInput(h, changedInput ? "restore-adopt" : "restore-discard"), kind: "restore-collision", context },
    dependencies, target, desired, currentDigest, writerEvents, plan,
  };
}

function restoreEnvelope(request: GateRequestV1, decision: "discard-and-restore" | "adopt-as-new-generation"): GateDecisionEnvelope {
  const context = request.context as Extract<GateRequestV1, { kind: "restore-collision" }>["context"];
  return {
    schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance,
    kind: "restore-collision", subject_digest: request.subject_digest, context_digest: request.context_digest,
    human_provenance: PROVENANCE,
    payload: decision === "discard-and-restore"
      ? { decision, reason: "Restore retained generation" }
      : { decision, reason: "Adopt human generation", adoption_authority: context.adoption_candidate!, rationale: "Human change is intentional" },
  };
}

describe("durable gate lifecycle", () => {
  it("opens exactly one durable gate, clears committed intent, and abort leaves it pending", async () => {
    const h = await harness();
    const opened = await openDurableGate(h.dependencies, gateInput(h));
    expect(opened.ok, opened.ok ? undefined : JSON.stringify({ error: opened.error, root: h.root, files: readFileSync(h.authority.state.absolute, "utf8") })).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.state.value.open_gate?.gate_id).toBe(opened.value.gate_id);
    expect(opened.value.state.value.committed_intent).toBeUndefined();
    expect(existsSync(join(h.authority.task_root, "decisions", opened.value.gate_id, "request.json"))).toBe(true);
    expect(existsSync(gatePath(h))).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const aborted = await runDurableGate(h.dependencies, { ...gateInput(h), signal: controller.signal });
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.error.code).toBe("CANCELLED");
    const state = await readTaskState(h.authority.state);
    expect(state.kind).toBe("canonical");
    if (state.kind === "canonical") expect(state.document.value.open_gate?.gate_id).toBe(opened.value.gate_id);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
  });

  it("reuses a request-only crash after an unrelated transition, while later state tamper still rejects", async () => {
    const h = await harness();
    const input = gateInput(h, "request-only-retry");
    const realAtomic = h.dependencies.atomic;
    let failProjection = true;
    const crashing: GateLifecycleDependencies = { ...h.dependencies, atomic: { ...realAtomic,
      replace: async (path, bytes) => {
        if (path.path_class === "gate-interface" && failProjection) {
          failProjection = false;
          throw new AtomicReplaceError({ operation: "replace", target_may_have_changed: false, collision: false });
        }
        await realAtomic.replace(path, bytes);
      },
    } };
    const first = await openDurableGate(crashing, input);
    expect(first.ok).toBe(false);
    const requestDirectories = join(h.authority.task_root, "decisions");
    expect(existsSync(requestDirectories)).toBe(true);
    const before = await readTaskState(h.authority.state);
    if (before.kind !== "canonical") throw new Error("state unavailable");
    const { committed_intent: _committed, ...stateBase } = before.document.value;
    const unrelated = { ...stateBase, revision: parseSafeInteger(before.document.value.revision + 1), status: "failed" as const } as TaskStateV1;
    writeFileSync(h.authority.state.absolute, canonicalDocument(unrelated).bytes);
    const retriedInput = { ...input, expected_revision: unrelated.revision };
    const retried = await openDurableGate(h.dependencies, retriedInput);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    writeFileSync(decisionPath(h), canonicalDocument(envelope(retried.value.request.value)).bytes);
    const tampered = { ...retried.value.state.value, status: "running" as const };
    writeFileSync(h.authority.state.absolute, canonicalDocument(tampered).bytes);
    const rejected = await runDurableGate(h.dependencies, { ...retriedInput, signal: new AbortController().signal });
    expect(rejected.ok).toBe(false);
    expect(existsSync(archivePath(h, retried.value.gate_id))).toBe(false);
  });

  it("republishes a missing or invalid gate interface and resolves a preserved human decision", async () => {
    for (const damage of ["missing", "invalid"] as const) {
      const h = await harness();
      const input = gateInput(h, `${damage}-active-interface`);
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error("gate open failed");
      if (damage === "missing") rmSync(gatePath(h));
      else writeFileSync(gatePath(h), "{not canonical json");
      writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
      const resolved = await runDurableGate(h.dependencies, { ...input, signal: new AbortController().signal });
      expect(resolved.ok, resolved.ok ? undefined : JSON.stringify(resolved.error)).toBe(true);
      const state = await readTaskState(h.authority.state);
      expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
      expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(true);
    }
  });

  it("resolves a non-advancing decision directly when gate.json is missing", async () => {
    const h = await harness();
    const input = gateInput(h, "missing-active-direct");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    rmSync(gatePath(h));
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "revise")).bytes);
    const resolved = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
    expect(resolved.ok, resolved.ok ? undefined : JSON.stringify(resolved.error)).toBe(true);
    const state = await readTaskState(h.authority.state);
    expect(state.kind === "canonical" ? state.document.value.open_gate : undefined).toBeUndefined();
  });

  it("rejects a committed-intent injection while a gate is open", async () => {
    const h = await harness();
    const input = gateInput(h, "committed-intent-injection");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
    const injected = { ...opened.value.state.value, committed_intent: initialState(h.authority).committed_intent! };
    writeFileSync(h.authority.state.absolute, canonicalDocument(injected).bytes);
    const rejected = await runDurableGate(h.dependencies, { ...input, signal: new AbortController().signal });
    expect(rejected.ok).toBe(false);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
  });

  it("archives an advancing decision, commits one approval and receipt, cleans interfaces, and exact-replays", async () => {
    const h = await harness();
    const opened = await openDurableGate(h.dependencies, gateInput(h));
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
    const resolved = await runDurableGate(h.dependencies, { ...gateInput(h), signal: new AbortController().signal });
    expect(resolved.ok, resolved.ok ? undefined : JSON.stringify(resolved.error)).toBe(true);
    if (!resolved.ok || !("record" in resolved.value)) return;
    expect(resolved.value.effect).toBe("advance");
    expect(resolved.value.state.value.approvals).toHaveLength(1);
    expect(resolved.value.state.value.open_gate).toBeUndefined();
    expect(resolved.value.state.value.committed_intent?.intent_id).toBe(gateInput(h).intent_id);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(true);
    expect(existsSync(gatePath(h))).toBe(false);
    expect(existsSync(decisionPath(h))).toBe(false);

    const replay = await runDurableGate(h.dependencies, { ...gateInput(h), signal: new AbortController().signal });
    expect(replay.ok).toBe(true);
    if (replay.ok && "record" in replay.value) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.state.value.approvals).toHaveLength(1);
    }
  });

  it("archives and clears a non-advancing decision without approval or receipt", async () => {
    const h = await harness();
    const input = gateInput(h, "revise-intent");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "revise")).bytes);
    const resolved = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.effect).toBe("retry");
    expect(resolved.value.state.value.open_gate).toBeUndefined();
    expect(resolved.value.state.value.approvals).toEqual([]);
    expect(resolved.value.state.value.committed_intent).toBeUndefined();
    expect(existsSync(join(h.authority.task_root, "intents", `${input.intent_id}.json`))).toBe(false);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(true);
    expect(existsSync(gatePath(h))).toBe(false);
    expect(existsSync(decisionPath(h))).toBe(false);
  });

  it("atomically enacts and exact-replays a gate-authorized re-entry", async () => {
    const h = await harness();
    // The one sanctioned gate-authorized re-entry predecessor: triage-succeeded, where the
    // post-triage constitution gates open.
    const predecessor = {
      ...initialState(h.authority),
      step: "triage" as const,
      status: "succeeded" as const,
      attempt: parseSafeInteger(3),
    };
    writeFileSync(h.authority.state.absolute, canonicalDocument(predecessor).bytes);
    const nextFingerprint = D("e");
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      resolve_gate_reentry_fingerprint: async ({ request, current }) => {
        expect(request.phase_instance).toBe(PHASE);
        expect(["triage", "produce"]).toContain(current.value.step);
        return { schema_version: "1", ok: true, value: nextFingerprint };
      },
    };
    const input: GateOpenInput = {
      ...gateInput(h, "gate-reentry"),
      kind: "constitution-review",
      context: {
        constitution: "pass", failed_rules: [], uncertain_rules: [],
        matched_trigger_rules: [{ rule_id: "review-required", rule_version: 1 }],
        uncertain_trigger_rules: [], eligible_waivers: [],
      },
    };
    const opened = await openDurableGate(dependencies, input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const request = opened.value.request.value;
    writeFileSync(decisionPath(h), canonicalDocument({
      schema_version: "1", gate_id: request.gate_id, task_id: request.task_id,
      phase_instance: request.phase_instance, kind: request.kind,
      subject_digest: request.subject_digest, context_digest: request.context_digest,
      human_provenance: PROVENANCE,
      payload: { decision: "revise", reason: "Revise current artifact" },
    }).bytes);
    const resolved = await resolveDurableGate(dependencies, h.authority, opened.value.gate_id);
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        effect: "retry",
        replayed: false,
        state: { value: {
          phase_instance: PHASE, step: "produce", status: "running",
          attempt: 4, input_fingerprint: nextFingerprint,
        } },
      },
    });
    if (!resolved.ok) return;
    const replayed = await openDurableGate(dependencies, input);
    expect(replayed, replayed.ok ? undefined : JSON.stringify(replayed.error)).toMatchObject({
      ok: true,
      value: { replay: { value: { gate_id: opened.value.gate_id } }, state: { value: { attempt: 4 } } },
    });

    const afterLanding = {
      ...resolved.value.state.value,
      revision: parseSafeInteger(resolved.value.state.value.revision + 1),
      status: "failed" as const,
    };
    writeFileSync(h.authority.state.absolute, canonicalDocument(afterLanding).bytes);
    const lateReplay = await openDurableGate(dependencies, input);
    expect(lateReplay, lateReplay.ok ? undefined : JSON.stringify(lateReplay.error)).toMatchObject({
      ok: true,
      value: {
        replay: { value: { gate_id: opened.value.gate_id } },
        state: { value: { revision: afterLanding.revision, status: "failed" } },
      },
    });
  });

  it("closes revert-edit without advancing and permits the existing same-step retry", async () => {
    const h = await harness();
    const predecessor = {
      ...initialState(h.authority),
      step: "adjudicate" as const,
      status: "running" as const,
      attempt: parseSafeInteger(2),
    };
    writeFileSync(h.authority.state.absolute, canonicalDocument(predecessor).bytes);
    const input: GateOpenInput = {
      ...gateInput(h, "constitution-revert"),
      kind: "constitution-edit",
      context: {
        pinned_constitution_digest: D("6"),
        current_constitution_digest: D("8"),
        changed_path_class: "task-branch-constitution",
      },
    };
    const opened = await openDurableGate(h.dependencies, input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const request = opened.value.request.value;
    writeFileSync(decisionPath(h), canonicalDocument({
      schema_version: "1", gate_id: request.gate_id, task_id: request.task_id,
      phase_instance: request.phase_instance, kind: request.kind,
      subject_digest: request.subject_digest, context_digest: request.context_digest,
      human_provenance: PROVENANCE,
      payload: { decision: "revert-edit", reason: "The task-local edit was reverted" },
    }).bytes);
    const closed = await resolveDurableGate(h.dependencies, h.authority, request.gate_id);
    expect(closed).toMatchObject({
      ok: true,
      value: {
        effect: "retry",
        state: { value: {
          step: "adjudicate", status: "running", attempt: 2,
        } },
      },
    });
    if (!closed.ok) return;
    expect(closed.value.state.value.open_gate).toBeUndefined();
    const failed = planStateTransition({
      current: closed.value.state.value,
      target: {
        phase_instance: PHASE, step: "adjudicate", status: "failed",
        attempt: parseSafeInteger(2), input_fingerprint: FINGERPRINT,
      },
      recomputed_input_fingerprint: FINGERPRINT,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    const retried = planStateTransition({
      current: { ...failed.value, revision: closed.value.state.value.revision },
      target: {
        phase_instance: PHASE, step: "adjudicate", status: "running",
        attempt: parseSafeInteger(3), input_fingerprint: FINGERPRINT,
      },
      recomputed_input_fingerprint: FINGERPRINT,
    });
    expect(retried).toMatchObject({
      ok: true,
      value: { step: "adjudicate", status: "running", attempt: 3 },
    });
  });

  it("serializes two material upstream gates with re-adjudication and different decisions", async () => {
    const h = await harness();
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...initialState(h.authority),
      step: "triage",
      status: "succeeded",
      attempt: parseSafeInteger(2),
    }).bytes);
    const corpus = JSON.parse(readFileSync(
      new URL("../fixtures/corpus/adjudication-scenarios.json", import.meta.url),
      "utf8",
    )) as {
      scenarios: Array<{ name: string; output: Record<string, unknown> }>;
    };
    const registry: ConstitutionRegistry = new Map([[
      "plain-rule",
      {
        id: "plain-rule",
        version: 1,
        status: "active",
        text: "The artifact must not contain a seeded defect.",
        review_trigger: "Review when DEFECT-SEED is present.",
      },
    ]]);
    const selected = (name: string) => {
      const scenario = corpus.scenarios.find((entry) => entry.name === name);
      if (scenario === undefined) throw new Error(`missing scenario ${name}`);
      const gate = selectAdjudicationGate(
        registry,
        parseAndDeriveAdjudication(scenario.output) as unknown as AdjudicationEvidence,
      );
      if (gate?.kind !== "material-drift") throw new Error(`expected material gate for ${name}`);
      return gate as AdjudicationGateRequest<"material-drift">;
    };

    const firstGate = selected("two-material-upstreams");
    expect(firstGate.context.affected_upstream.digest).toBe(D("1"));
    const firstInput: GateOpenInput = {
      ...gateInput(h, "first-material"),
      request_digest: D("1"),
      kind: firstGate.kind,
      subject_digest: firstGate.subject_digest,
      context: firstGate.context,
    };
    const firstOpened = await openDurableGate(h.dependencies, firstInput);
    expect(firstOpened.ok).toBe(true);
    if (!firstOpened.ok) return;
    const firstRequest = firstOpened.value.request.value;
    writeFileSync(decisionPath(h), canonicalDocument({
      schema_version: "1", gate_id: firstRequest.gate_id, task_id: firstRequest.task_id,
      phase_instance: firstRequest.phase_instance, kind: firstRequest.kind,
      subject_digest: firstRequest.subject_digest, context_digest: firstRequest.context_digest,
      human_provenance: PROVENANCE,
      payload: { decision: "amend-upstream", reason: "Amend the first upstream" },
    }).bytes);
    const firstResolved = await resolveDurableGate(
      h.dependencies, h.authority, firstRequest.gate_id,
    );
    expect(firstResolved).toMatchObject({
      ok: true,
      value: {
        effect: "redirect-upstream",
        state: { value: { step: "triage", status: "succeeded", attempt: 2 } },
      },
    });
    if (!firstResolved.ok) return;

    const secondGate = selected("second-material-upstream-after-readjudication");
    expect(secondGate.context.affected_upstream.digest).toBe(D("2"));
    const nextFingerprint = D("e");
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      resolve_gate_reentry_fingerprint: async () => ({
        schema_version: "1", ok: true, value: nextFingerprint,
      }),
    };
    const secondInput: GateOpenInput = {
      ...gateInput(h, "second-material"),
      expected_revision: firstResolved.value.state.value.revision,
      request_digest: D("2"),
      kind: secondGate.kind,
      subject_digest: secondGate.subject_digest,
      context: secondGate.context,
    };
    const secondOpened = await openDurableGate(dependencies, secondInput);
    expect(secondOpened.ok).toBe(true);
    if (!secondOpened.ok) return;
    const secondRequest = secondOpened.value.request.value;
    writeFileSync(decisionPath(h), canonicalDocument({
      schema_version: "1", gate_id: secondRequest.gate_id, task_id: secondRequest.task_id,
      phase_instance: secondRequest.phase_instance, kind: secondRequest.kind,
      subject_digest: secondRequest.subject_digest, context_digest: secondRequest.context_digest,
      human_provenance: PROVENANCE,
      payload: { decision: "revise-current", reason: "Revise for the second upstream" },
    }).bytes);
    const secondResolved = await resolveDurableGate(
      dependencies, h.authority, secondRequest.gate_id,
    );
    expect(secondResolved).toMatchObject({
      ok: true,
      value: {
        effect: "retry",
        state: { value: {
          step: "produce", status: "running", attempt: 3,
          input_fingerprint: nextFingerprint,
        } },
      },
    });
  });

  it("rejects gate re-entry from the wrong step, status, phase, or exhausted-attempt context", async () => {
    const cases = [
      { label: "step", state: { step: "counter_review" as const, status: "succeeded" as const }, phase: PHASE },
      { label: "status", state: { step: "triage" as const, status: "running" as const }, phase: PHASE },
      { label: "phase", state: { step: "triage" as const, status: "succeeded" as const },
        phase: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(13) }) },
    ] as const;
    for (const testCase of cases) {
      const h = await harness();
      writeFileSync(h.authority.state.absolute, canonicalDocument({
        ...initialState(h.authority), ...testCase.state, attempt: parseSafeInteger(2),
      }).bytes);
      const dependencies: GateLifecycleDependencies = {
        ...h.dependencies,
        resolve_gate_reentry_fingerprint: async () => ({ schema_version: "1", ok: true, value: D("e") }),
      };
      const input: GateOpenInput = {
        ...gateInput(h, `gate-wrong-${testCase.label}`),
        phase_instance: testCase.phase,
        kind: "constitution-review",
        context: {
          constitution: "pass", failed_rules: [], uncertain_rules: [],
          matched_trigger_rules: [{ rule_id: "review-required", rule_version: 1 }], uncertain_trigger_rules: [], eligible_waivers: [],
        },
      };
      const opened = await openDurableGate(dependencies, input);
      expect(opened.ok, testCase.label).toBe(true);
      if (!opened.ok) continue;
      const request = opened.value.request.value;
      writeFileSync(decisionPath(h), canonicalDocument({
        schema_version: "1", gate_id: request.gate_id, task_id: request.task_id,
        phase_instance: request.phase_instance, kind: request.kind,
        subject_digest: request.subject_digest, context_digest: request.context_digest,
        human_provenance: PROVENANCE,
        payload: { decision: "revise", reason: "Revise current artifact" },
      }).bytes);
      const rejected = await resolveDurableGate(dependencies, h.authority, opened.value.gate_id);
      expect(rejected.ok, testCase.label).toBe(false);
      expect(existsSync(archivePath(h, opened.value.gate_id)), testCase.label).toBe(false);
    }

    const h = await harness();
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...initialState(h.authority), step: "triage", status: "succeeded", attempt: parseSafeInteger(3),
    }).bytes);
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      resolve_gate_reentry_fingerprint: async () => ({ schema_version: "1", ok: true, value: D("e") }),
    };
    const input: GateOpenInput = {
      ...gateInput(h, "gate-wrong-attempt"),
      kind: "attempts-exhausted",
      context: { step: "triage", attempts: 2, maximum_attempts: 2 },
    };
    const opened = await openDurableGate(dependencies, input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const request = opened.value.request.value;
    writeFileSync(decisionPath(h), canonicalDocument({
      schema_version: "1", gate_id: request.gate_id, task_id: request.task_id,
      phase_instance: request.phase_instance, kind: request.kind,
      subject_digest: request.subject_digest, context_digest: request.context_digest,
      human_provenance: PROVENANCE,
      payload: { decision: "retry-once", reason: "Authorize one retry" },
    }).bytes);
    const rejected = await resolveDurableGate(dependencies, h.authority, opened.value.gate_id);
    expect(rejected.ok).toBe(false);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
  });

  it("leaves a wrong-binding decision pending without advancing durable authority", async () => {
    const h = await harness();
    const input = gateInput(h);
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument({ ...envelope(opened.value.request.value), subject_digest: D("b") }).bytes);
    const before = await refusalPostcondition(h, input.intent_id);
    const rejected = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("GATE_DECISION_INVALID");
      expect(rejected.error.diagnostic.parameters).toMatchObject({ issue_code: "decision-binding-invalid" });
    }
    await expectRefusalDidNotAdvance(h, input.intent_id, before);
    const state = await readTaskState(h.authority.state);
    expect(state.kind).toBe("canonical");
    if (state.kind === "canonical") expect(state.document.value.open_gate?.gate_id).toBe(opened.value.gate_id);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
  });

  it("refuses every unreadable decision shape without advancing durable authority", async () => {
    for (const issueCode of ["decision-missing", "decision-noncanonical", "decision-invalid"] as const) {
      const h = await harness();
      const baseInput = gateInput(h, `refused-${issueCode}`);
      const input: GateOpenInput = issueCode === "decision-invalid"
        ? {
            ...baseInput,
            kind: "constitution-review",
            context: {
              constitution: "pass", failed_rules: [], uncertain_rules: [],
              matched_trigger_rules: [{ rule_id: "review-required", rule_version: 1 }],
              uncertain_trigger_rules: [], eligible_waivers: [],
            },
          }
        : baseInput;
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error("gate open failed");
      if (issueCode === "decision-noncanonical") writeFileSync(decisionPath(h), "{not canonical json");
      if (issueCode === "decision-invalid") {
        const request = opened.value.request.value;
        writeFileSync(decisionPath(h), canonicalDocument({
          schema_version: "1", gate_id: request.gate_id, task_id: request.task_id,
          phase_instance: request.phase_instance, kind: request.kind,
          subject_digest: request.subject_digest, context_digest: request.context_digest,
          human_provenance: PROVENANCE,
          payload: { decision: "revise", reason: "Revise current artifact" },
        }).bytes);
      }
      const before = await refusalPostcondition(h, input.intent_id);
      let refused;
      let observedLocks = 0;
      if (issueCode === "decision-invalid") {
        let locks = 0;
        const dependencies: GateLifecycleDependencies = {
          ...h.dependencies,
          lock: {
            runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>) => {
              locks += 1;
              observedLocks = locks;
              if (locks === 3) writeFileSync(decisionPath(h), "{not canonical json");
              return work();
            },
          },
        };
        refused = await runDurableGate(dependencies, { ...input, signal: new AbortController().signal });
      } else {
        refused = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
      }
      expect(refused.ok, `${issueCode} locks=${observedLocks}`).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code, issueCode).toBe("GATE_DECISION_INVALID");
        expect(refused.error.diagnostic.parameters, issueCode).toMatchObject({ issue_code: issueCode });
      }
      await expectRefusalDidNotAdvance(h, input.intent_id, before);
      expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
    }
  });

  it("refuses competing gate identities at each active-gate entry arm", async () => {
    const h = await harness();
    const input = gateInput(h, "active-gate-owner");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    const before = await refusalPostcondition(h, input.intent_id);

    const competing = await openDurableGate(h.dependencies, gateInput(h, "active-gate-competitor"));
    expect(competing).toMatchObject({ ok: false, error: { code: "GATE_ACTIVE" } });
    await expectRefusalDidNotAdvance(h, input.intent_id, before);

    const foreignGateId = parsePathSafeId("foreign-gate-id");
    const foreignRoot = join(h.authority.task_root, "decisions", foreignGateId);
    mkdirSync(foreignRoot, { recursive: true });
    writeFileSync(join(foreignRoot, "request.json"), canonicalDocument(opened.value.request.value).bytes);
    const wrongResolution = await resolveDurableGate(h.dependencies, h.authority, foreignGateId);
    expect(wrongResolution).toMatchObject({ ok: false, error: { code: "GATE_ACTIVE" } });
    await expectRefusalDidNotAdvance(h, input.intent_id, before);
  });

  it("binds waiver mode to the exact origin marker and scope for grant, denial, and cancellation", async () => {
    for (const outcome of ["grant", "deny", "cancel"] as const) {
      const h = await harness();
      const input = await waiverInput(h, `waiver-${outcome}`);
      const opened = await openDurableGate(h.dependencies, input);
      expect(opened.ok).toBe(true);
      if (!opened.ok) continue;
      expect(opened.value.state.value.open_gate?.waiver_origin_gate_id).toBe((input.context as { origin: WaiverOriginRef }).origin.origin_gate_id);
      const active = JSON.parse(readFileSync(gatePath(h), "utf8")) as { decision_template: { required_fields: string[]; cancellation_fields: string[] } };
      expect(active.decision_template.required_fields).toEqual(["granted", "scope", "origin", "notes", "human_provenance"]);
      expect(active.decision_template.cancellation_fields).toEqual(["cancelled", "reason", "human_provenance"]);
      if (outcome === "cancel") {
        writeFileSync(decisionPath(h), canonicalDocument({
          schema_version: "1", gate_id: opened.value.gate_id, task_id: TASK, phase_instance: PHASE,
          subject_digest: input.subject_digest, context_digest: opened.value.request.value.context_digest,
          cancelled: true, reason: "Cancelled by human", human_provenance: PROVENANCE,
        }).bytes);
        const cancelled = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
        expect(cancelled.ok).toBe(false);
        if (!cancelled.ok) expect(cancelled.error.code).toBe("GATE_CANCELLED");
        const archived = parseCanonicalDocument<GateDecisionRecordV1>(readFileSync(archivePath(h, opened.value.gate_id)));
        expect(archived.value.outcome).toBe("cancelled");
        continue;
      }
      writeFileSync(decisionPath(h), canonicalDocument(waiverInterface(opened.value.request.value, outcome === "grant")).bytes);
      const resolved = await runDurableGate(h.dependencies, { ...input, signal: new AbortController().signal });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok || !("record" in resolved.value)) continue;
      expect(resolved.value.record.value.outcome).toBe("waiver-decided");
      expect(resolved.value.state.value.waivers).toEqual([expect.objectContaining({
        gate_id: opened.value.gate_id, granted: outcome === "grant", scope: { operation: "review-trigger", boundary: "phase" },
      })]);
      expect(resolved.value.state.value.committed_intent !== undefined).toBe(outcome === "grant");
      expect(existsSync(join(h.authority.task_root, "intents", `${input.intent_id}.json`))).toBe(outcome === "grant");
    }
  });

  it("rejects a fabricated waiver origin even when its marker and scope are internally consistent", async () => {
    const h = await harness();
    const authentic = await waiverInput(h, "waiver-fabricated");
    const context = authentic.context as { origin: WaiverOriginRef; rationale: string };
    const fabricated: GateOpenInput = {
      ...authentic,
      intent_id: "waiver-fabricated-new" as GateOpenInput["intent_id"], request_digest: D("0"),
      context: { ...context, origin: { ...context.origin, origin_decision_digest: D("0") } },
    };
    const rejected = await openDurableGate(h.dependencies, fabricated);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(["CONTRACT_INVALID", "STATE_INVALID"]).toContain(rejected.error.code);
    const state = await readTaskState(h.authority.state);
    expect(state.kind === "canonical" ? state.document.value.open_gate : undefined).toBeUndefined();
  });

  it("does not trust edited gate.json supplemental entries as closure authority", async () => {
    const h = await harness();
    const input = gateInput(h, "forged-supplemental-ledger");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    const active = JSON.parse(readFileSync(gatePath(h), "utf8")) as Record<string, unknown>;
    active.supplemental = [{
      action: "decline",
      gate: { prior_gate_id: opened.value.gate_id, task_id: TASK, phase_instance: PHASE, subject_digest: input.subject_digest, input_fingerprint: FINGERPRINT },
      reason: "forged interface ledger",
    }];
    writeFileSync(gatePath(h), canonicalDocument(active as PlainJsonValue).bytes);
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "revise")).bytes);
    const resolved = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.record.value.supplemental).toEqual([]);
  });

  it("re-raises forged ingest and triage ledger entries unless the exact caller outcome is supplied", async () => {
    for (const action of ["ingest", "triage-no-change"] as const) {
      const h = await harness();
      const input = gateInput(h, `forged-${action}`);
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error(`gate open failed: ${JSON.stringify(opened.error)}`);
      const reviewBytes = new TextEncoder().encode(`${action} review\n`);
      mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
      writeFileSync(reviewPath(h, opened.value.gate_id), reviewBytes);
      const outcome = supplementalFor(h, opened.value.gate_id, canonicalJsonDigest(supplementalEvidence(opened.value.request.value)), action);
      const active = JSON.parse(readFileSync(gatePath(h), "utf8")) as Record<string, unknown>;
      active.supplemental = [outcome];
      writeFileSync(gatePath(h), canonicalDocument(active as PlainJsonValue).bytes);
      writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "revise")).bytes);
      const reraised = await runDurableGate(h.dependencies, { ...input, signal: new AbortController().signal });
      expect(reraised.ok).toBe(false);
      if (!reraised.ok) expect(reraised.error.code, JSON.stringify(reraised.error)).toBe("SUPPLEMENTAL_REVIEW_REQUIRED");
      expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
      const accepted = await runDurableGate(h.dependencies, { ...input, supplemental_outcome: outcome, signal: new AbortController().signal });
      expect(accepted.ok).toBe(true);
      if (accepted.ok && "record" in accepted.value) expect(accepted.value.record.value.supplemental).toEqual([outcome]);
    }
  });

  it("rejects a caller-forged supplemental evidence slot even when gate.json repeats it", async () => {
    const h = await harness();
    const input = gateInput(h, "forged-caller-slot");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    writeFileSync(reviewPath(h, opened.value.gate_id), "forged slot projection\n");
    const forged = supplementalFor(h, opened.value.gate_id, D("0"), "ingest");
    const retried = await openDurableGate(h.dependencies, {
      ...input,
      supplemental_outcome: forged,
    });
    expect(retried.ok).toBe(false);
    if (!retried.ok) {
      expect(retried.error.code).toBe("STATE_INVALID");
      expect(retried.error.diagnostic.parameters).toMatchObject({
        issue_code: "supplemental-review-authority-invalid",
      });
    }
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
  });

  it("revalidates config, repository identity, state, and fingerprint before resolving after a wait", async () => {
    for (const changed of ["config", "repository", "state", "fingerprint"] as const) {
      const h = await harness();
      const input = gateInput(h, `changed-during-wait-${changed}`);
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error("gate open failed");
      writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
      let dependencies: GateLifecycleDependencies = h.dependencies;
      let resumedInput = input;
      if (changed === "config") dependencies = { ...dependencies, read_config: async () => ({ kind: "valid", snapshot: { bytes: new Uint8Array(), digest: D("0") } }) };
      if (changed === "fingerprint") resumedInput = { ...input, input_fingerprint: D("0") };
      if (changed === "repository" || changed === "state") {
        const read = await readTaskState(h.authority.state);
        if (read.kind !== "canonical") throw new Error("state unavailable");
        const mutated = changed === "repository"
          ? { ...read.document.value, repository_identity_digest: D("0") }
          : { ...read.document.value, status: "failed" as const };
        writeFileSync(h.authority.state.absolute, canonicalDocument(mutated).bytes);
      }
      const rejected = await runDurableGate(dependencies, { ...resumedInput, signal: new AbortController().signal });
      expect(rejected.ok, `${changed} change unexpectedly resolved`).toBe(false);
      expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
    }
  });

  it("cleans interfaces when archived non-advancing and cancelled closures resume after a state-write crash", async () => {
    for (const outcome of ["revise", "cancel"] as const) {
      const h = await harness();
      const input = gateInput(h, `closure-resume-${outcome}`);
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error("gate open failed");
      const decision = outcome === "revise" ? envelope(opened.value.request.value, "revise") : {
        schema_version: "1", gate_id: opened.value.gate_id, task_id: TASK, phase_instance: PHASE,
        subject_digest: input.subject_digest, context_digest: opened.value.request.value.context_digest,
        cancelled: true, reason: "Cancelled", human_provenance: PROVENANCE,
      };
      writeFileSync(decisionPath(h), canonicalDocument(decision).bytes);
      const realAtomic = h.dependencies.atomic;
      const crashing: GateLifecycleDependencies = { ...h.dependencies, atomic: {
        ...realAtomic,
        replace: async (path, bytes) => {
          if (path.path_class === "task-state") throw new AtomicReplaceError({ operation: "replace", target_may_have_changed: false, collision: false });
          await realAtomic.replace(path, bytes);
        },
      } };
      const crashed = await resolveDurableGate(crashing, h.authority, opened.value.gate_id);
      expect(crashed.ok).toBe(false);
      expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(true);
      const resumed = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
      if (outcome === "cancel") {
        expect(resumed.ok).toBe(false);
        if (!resumed.ok) expect(resumed.error.code).toBe("GATE_CANCELLED");
      } else expect(resumed.ok).toBe(true);
      expect(existsSync(gatePath(h))).toBe(false);
      expect(existsSync(decisionPath(h))).toBe(false);
    }
  });

  it("surfaces a first-arrival gate-counter review, records decline on retry, and preserves it in closure", async () => {
    const h = await harness();
    const input = gateInput(h, "supplemental-decline");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    const reviewBytes = new TextEncoder().encode("# Gate counter-review\n\nMajor finding.\n");
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    writeFileSync(reviewPath(h, opened.value.gate_id), reviewBytes);
    const waiting = await runDurableGate(h.dependencies, { ...input, signal: new AbortController().signal });
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) {
      expect(waiting.error.code).toBe("SUPPLEMENTAL_REVIEW_REQUIRED");
      expect(waiting.error.diagnostic.parameters).toEqual({
        gate_id: opened.value.gate_id,
        evidence_digest: canonicalJsonDigest(supplementalEvidence(opened.value.request.value)),
      });
    }
    const stillOpen = await readTaskState(h.authority.state);
    expect(stillOpen.kind === "canonical" ? stillOpen.document.value.open_gate?.gate_id : undefined).toBe(opened.value.gate_id);

    const decline: SupplementalReviewOutcome = {
      action: "decline", reason: "Proceed without incorporating the review",
      gate: { prior_gate_id: opened.value.gate_id, task_id: TASK, phase_instance: PHASE, subject_digest: input.subject_digest, input_fingerprint: FINGERPRINT },
    };
    const retried = await openDurableGate(h.dependencies, { ...input, supplemental_outcome: decline });
    expect(retried.ok).toBe(true);
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "revise")).bytes);
    const resolved = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id, FINGERPRINT, decline);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.record.value.supplemental).toEqual([decline]);
  });

  it("does not re-wake on an exact decline before resolving a visible decision", async () => {
    const h = await harness();
    const input = gateInput(h, "supplemental-decline-run");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    writeFileSync(reviewPath(h, opened.value.gate_id), "declined gate counter-review\n");
    const decline: SupplementalReviewOutcome = {
      action: "decline", reason: "Proceed with the reviewed decision",
      gate: { prior_gate_id: opened.value.gate_id, task_id: TASK, phase_instance: PHASE, subject_digest: input.subject_digest, input_fingerprint: FINGERPRINT },
    };
    const recorded = await openDurableGate(h.dependencies, { ...input, supplemental_outcome: decline });
    expect(recorded.ok).toBe(true);
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "revise")).bytes);
    const resolved = await runDurableGate(h.dependencies, {
      ...input,
      supplemental_outcome: decline,
      signal: new AbortController().signal,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && "record" in resolved.value) {
      expect(resolved.value.record.value.supplemental).toEqual([decline]);
    }
  });

  it("gives an unrecorded gate-counter review precedence when review and decision are simultaneously visible", async () => {
    const h = await harness();
    const input = gateInput(h, "supplemental-simultaneous");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    const reviewBytes = new TextEncoder().encode("simultaneous counter-review\n");
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    writeFileSync(reviewPath(h, opened.value.gate_id), reviewBytes);
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
    const result = await runDurableGate(h.dependencies, { ...input, signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SUPPLEMENTAL_REVIEW_REQUIRED");
    const state = await readTaskState(h.authority.state);
    expect(state.kind === "canonical" ? state.document.value.open_gate?.gate_id : undefined).toBe(opened.value.gate_id);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
  });

  it("archives a supersession closure without granting authority", async () => {
    const h = await harness();
    const input = gateInput(h, "supplemental-supersede");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    const reviewBytes = new TextEncoder().encode("accepted counter-review\n");
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    writeFileSync(reviewPath(h, opened.value.gate_id), reviewBytes);
    const supersede = supplementalFor(h, opened.value.gate_id, canonicalJsonDigest(supplementalEvidence(opened.value.request.value)), "supersede");
    const closed = await openDurableGate(h.dependencies, { ...input, supplemental_outcome: supersede });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.replay?.value.outcome).toBe("superseded");
    expect(closed.value.state.value.open_gate).toBeUndefined();
    expect(closed.value.state.value.approvals).toEqual([]);
    expect(closed.value.state.value.waivers).toEqual([]);
  });

  it("authenticates a triage-no-change artifact and carries the ledger into the decision archive", async () => {
    const h = await harness();
    const input = gateInput(h, "supplemental-triage");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    const reviewBytes = new TextEncoder().encode("triaged counter-review\n");
    mkdirSync(join(h.authority.task_root, "reviews"), { recursive: true });
    writeFileSync(reviewPath(h, opened.value.gate_id), reviewBytes);
    const triage = supplementalFor(h, opened.value.gate_id, canonicalJsonDigest(supplementalEvidence(opened.value.request.value)), "triage-no-change");
    const retried = await openDurableGate(h.dependencies, { ...input, supplemental_outcome: triage });
    expect(retried.ok).toBe(true);
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "revise")).bytes);
    const resolved = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id, FINGERPRINT, triage);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.record.value.supplemental).toEqual([triage]);
  });

  it("freshly replans discard-and-restore and applies the retained generation", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, false);
    const opened = await openDurableGate(restore.dependencies, restore.input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
    const resolved = await runDurableGate(restore.dependencies, { ...restore.input, signal: new AbortController().signal });
    expect(resolved.ok).toBe(true);
    expect(readFileSync(restore.target.absolute)).toEqual(Buffer.from(restore.desired));
    expect(restore.writerEvents).toEqual(["replace-regular"]);
  });

  it("rejects a secret detected while replanning discard-and-restore without advancing the gate", async () => {
    const h = await harness();
    const counter = { calls: 0 };
    const scanner: SecretScanner = {
      scan: async (candidates) => {
        counter.calls += 1;
        const candidate = candidates[0];
        if (candidate === undefined) throw new TypeError("expected a restore projection candidate");
        return {
          schema_version: "1",
          outcome: "detected",
          detector_set_id: parseSafeId("secret-scan-test"),
          findings: [{
            detector_id: parseSafeId("test-secret"),
            path_class: candidate.path_class,
            virtual_path: candidate.virtual_path,
            line: parseSafeInteger(1),
            column: parseSafeInteger(1),
          }],
        };
      },
    };
    const restore = await restoreFixture(h, false, scanner, true);
    const opened = await openDurableGate(restore.dependencies, restore.input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const beforeTarget = readFileSync(restore.target.absolute);
    const beforeState = await refusalPostcondition(h, restore.input.intent_id);
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);

    const rejected = await runDurableGate(restore.dependencies, { ...restore.input, signal: new AbortController().signal });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code, JSON.stringify(rejected.error)).toBe("SECRET_DETECTED");
    expect(counter.calls).toBe(1);
    expect(restore.writerEvents).toEqual([]);
    expect(readFileSync(restore.target.absolute)).toEqual(beforeTarget);
    await expectRefusalDidNotAdvance(h, restore.input.intent_id, beforeState);
    const state = await readTaskState(h.authority.state);
    expect(state.kind).toBe("canonical");
    if (state.kind === "canonical") expect(state.document.value.open_gate?.gate_id).toBe(opened.value.gate_id);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(true);
  });

  it("rejects stale restore generations without a projection write", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, false);
    const opened = await openDurableGate(restore.dependencies, restore.input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    writeFileSync(restore.target.absolute, "newer human generation\n");
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
    const rejected = await runDurableGate(restore.dependencies, { ...restore.input, signal: new AbortController().signal });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("STATE_INVALID");
    expect(restore.writerEvents).toEqual([]);
    expect(readFileSync(restore.target.absolute, "utf8")).toBe("newer human generation\n");
  });

  it("adopts a changed restore generation without any projection write", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, true);
    const opened = await openDurableGate(restore.dependencies, restore.input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const before = readFileSync(restore.target.absolute);
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "adopt-as-new-generation")).bytes);
    const resolved = await runDurableGate(restore.dependencies, { ...restore.input, signal: new AbortController().signal });
    expect(resolved.ok, resolved.ok ? undefined : JSON.stringify(resolved.error)).toBe(true);
    expect(restore.writerEvents).toEqual([]);
    expect(readFileSync(restore.target.absolute)).toEqual(before);
  });

  it("resumes an advancing restore after projection applied but the state commit crashed", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, false);
    const opened = await openDurableGate(restore.dependencies, restore.input);
    if (!opened.ok) throw new Error("restore open failed");
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
    const realAtomic = restore.dependencies.atomic;
    let crashState = true;
    const crashing: GateLifecycleDependencies = { ...restore.dependencies, atomic: { ...realAtomic,
      replace: async (path, bytes) => {
        if (path.path_class === "task-state" && crashState) {
          crashState = false;
          throw new AtomicReplaceError({ operation: "replace", target_may_have_changed: false, collision: false });
        }
        await realAtomic.replace(path, bytes);
      },
    } };
    const first = await runDurableGate(crashing, { ...restore.input, signal: new AbortController().signal });
    expect(first.ok).toBe(false);
    expect(readFileSync(restore.target.absolute)).toEqual(Buffer.from(restore.desired));
    const resumed = await runDurableGate(restore.dependencies, { ...restore.input, signal: new AbortController().signal });
    expect(resumed.ok).toBe(true);
    const state = await readTaskState(h.authority.state);
    expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
  });

  it("writes neither rename peer when the peer generation changes after restore gate open", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, false);
    const original = restore.plan.entries[0]!;
    const peerPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/restored-old.md`);
    const peerTarget: ResolvedPath = { absolute: join(h.root, peerPath) as ResolvedTaskPath, repositoryRelative: peerPath, path_class: "document" };
    writeFileSync(peerTarget.absolute, "peer collision\n");
    const peerCapture = await captureProjectionTarget(peerTarget);
    const paired: ProjectionPlan = {
      ...restore.plan,
      entries: [
        { ...original, rename_pair: { role: "destination", peer_path: peerPath } },
        {
          path: peerPath, target: peerTarget, observed_before: peerCapture.observation,
          desired: { state: "absent" }, rollback: peerCapture.rollback, git_tracked: false, disposition: "collision",
          rename_pair: { role: "source", peer_path: original.path },
        },
      ],
      collisions: [{ path: original.path, path_class: "document" }, { path: peerPath, path_class: "document" }],
    };
    const dependencies: GateLifecycleDependencies = {
      ...restore.dependencies,
      load_retained_result: async () => ({ schema_version: "1", ok: true, value: {
        projection_plan: paired, worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
      } as never }),
    };
    const opened = await openDurableGate(dependencies, restore.input);
    if (!opened.ok) throw new Error("restore open failed");
    writeFileSync(peerTarget.absolute, "peer changed after gate\n");
    const primaryBefore = readFileSync(restore.target.absolute);
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
    const rejected = await runDurableGate(dependencies, { ...restore.input, signal: new AbortController().signal });
    expect(rejected.ok).toBe(false);
    expect(restore.writerEvents).toEqual([]);
    expect(readFileSync(restore.target.absolute)).toEqual(primaryBefore);
    expect(readFileSync(peerTarget.absolute, "utf8")).toBe("peer changed after gate\n");
  });

  it("resumes a rename restore after only the source write, but rejects a third-generation peer", async () => {
    for (const thirdGeneration of [false, true]) {
      const h = await harness();
      const restore = await restoreFixture(h, false);
      const original = restore.plan.entries[0]!;
      const peerPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/rename-destination.md`);
      const peerTarget: ResolvedPath = { absolute: join(h.root, peerPath) as ResolvedTaskPath, repositoryRelative: peerPath, path_class: "document" };
      const desiredPeer = new TextEncoder().encode("renamed retained generation\n");
      const paired: ProjectionPlan = {
        entries: [
          { ...original, desired: { state: "absent" }, rename_pair: { role: "source", peer_path: peerPath } },
          {
            path: peerPath, target: peerTarget, observed_before: { state: "absent" },
            desired: { state: "present", file_type: "regular", mode: "100644", bytes: desiredPeer },
            rollback: { state: "absent" }, git_tracked: false, disposition: "restore-ready",
            rename_pair: { role: "destination", peer_path: original.path },
          },
        ],
        collisions: [{ path: original.path, path_class: "document" }],
        collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
      };
      const dependencies: GateLifecycleDependencies = {
        ...restore.dependencies,
        load_retained_result: async () => ({ schema_version: "1", ok: true, value: {
          projection_plan: paired, worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
        } as never }),
      };
      const input: GateOpenInput = {
        ...restore.input,
        intent_id: `rename-partial-${String(thirdGeneration)}` as GateOpenInput["intent_id"],
        context: {
          ...(restore.input.context as Extract<GateRequestV1, { kind: "restore-collision" }>["context"]),
          recorded_generation_digest: projectionGenerationDigest({ state: "absent" }),
        },
      };
      const opened = await openDurableGate(dependencies, input);
      if (!opened.ok) throw new Error(`rename restore open failed: ${JSON.stringify(opened.error)}`);
      writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
      let writes = 0;
      const writer = dependencies.projection_writer!;
      const crashing: GateLifecycleDependencies = { ...dependencies, projection_writer: {
        replaceRegular: async (...args) => { writes += 1; if (writes === 2) throw new Error("simulated process death"); await writer.replaceRegular(...args); },
        replaceSymlink: async (...args) => { writes += 1; if (writes === 2) throw new Error("simulated process death"); await writer.replaceSymlink(...args); },
        remove: async (...args) => { writes += 1; if (writes === 2) throw new Error("simulated process death"); await writer.remove(...args); },
      } };
      const crashed = await runDurableGate(crashing, { ...input, signal: new AbortController().signal });
      expect(crashed.ok).toBe(false);
      expect(existsSync(restore.target.absolute)).toBe(false);
      expect(existsSync(peerTarget.absolute)).toBe(false);
      if (thirdGeneration) writeFileSync(peerTarget.absolute, "third generation\n");
      const resumed = await runDurableGate(dependencies, { ...input, signal: new AbortController().signal });
      expect(resumed.ok, resumed.ok ? undefined : JSON.stringify(resumed.error)).toBe(!thirdGeneration);
      expect(existsSync(restore.target.absolute)).toBe(false);
      expect(thirdGeneration ? readFileSync(peerTarget.absolute, "utf8") : readFileSync(peerTarget.absolute)).toEqual(
        thirdGeneration ? "third generation\n" : Buffer.from(desiredPeer),
      );
    }
  });

  it("resumes a rename restore when the destination write landed first", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, false);
    const original = restore.plan.entries[0]!;
    const peerPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/destination-first.md`);
    const peerTarget: ResolvedPath = { absolute: join(h.root, peerPath) as ResolvedTaskPath, repositoryRelative: peerPath, path_class: "document" };
    const desiredPeer = new TextEncoder().encode("destination landed first\n");
    const paired: ProjectionPlan = {
      entries: [
        {
          path: peerPath, target: peerTarget, observed_before: { state: "absent" },
          desired: { state: "present", file_type: "regular", mode: "100644", bytes: desiredPeer },
          rollback: { state: "absent" }, git_tracked: false, disposition: "restore-ready",
          rename_pair: { role: "destination", peer_path: original.path },
        },
        { ...original, desired: { state: "absent" }, rename_pair: { role: "source", peer_path: peerPath } },
      ],
      collisions: [{ path: original.path, path_class: "document" }],
      collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    };
    const dependencies: GateLifecycleDependencies = {
      ...restore.dependencies,
      load_retained_result: async () => ({ schema_version: "1", ok: true, value: {
        projection_plan: paired, worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
      } as never }),
    };
    const input: GateOpenInput = {
      ...restore.input,
      intent_id: "rename-destination-first" as GateOpenInput["intent_id"],
      context: {
        ...(restore.input.context as Extract<GateRequestV1, { kind: "restore-collision" }>["context"]),
        recorded_generation_digest: projectionGenerationDigest({ state: "absent" }),
      },
    };
    const opened = await openDurableGate(dependencies, input);
    if (!opened.ok) throw new Error("rename restore open failed");
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
    writeFileSync(peerTarget.absolute, desiredPeer);
    const resumed = await runDurableGate(dependencies, { ...input, signal: new AbortController().signal });
    expect(resumed.ok, resumed.ok ? undefined : JSON.stringify(resumed.error)).toBe(true);
    expect(existsSync(restore.target.absolute)).toBe(false);
    expect(readFileSync(peerTarget.absolute)).toEqual(Buffer.from(desiredPeer));
  });

  it("applies a fresh rename restore when the gated collision is the destination", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, false);
    const original = restore.plan.entries[0]!;
    const sourcePath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/fresh-rename-source.md`);
    const sourceTarget: ResolvedPath = { absolute: join(h.root, sourcePath) as ResolvedTaskPath, repositoryRelative: sourcePath, path_class: "document" };
    writeFileSync(sourceTarget.absolute, "rename source before image\n");
    const sourceCapture = await captureProjectionTarget(sourceTarget);
    const paired: ProjectionPlan = {
      entries: [
        { ...original, rename_pair: { role: "destination", peer_path: sourcePath } },
        {
          path: sourcePath, target: sourceTarget, observed_before: sourceCapture.observation,
          desired: { state: "absent" }, rollback: sourceCapture.rollback, git_tracked: false,
          disposition: "restore-ready", rename_pair: { role: "source", peer_path: original.path },
        },
      ],
      collisions: [{ path: original.path, path_class: "document" }],
      collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    };
    const dependencies: GateLifecycleDependencies = {
      ...restore.dependencies,
      load_retained_result: async () => ({ schema_version: "1", ok: true, value: {
        projection_plan: paired, worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
      } as never }),
    };
    const opened = await openDurableGate(dependencies, restore.input);
    if (!opened.ok) throw new Error("rename destination gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
    const resolved = await runDurableGate(dependencies, { ...restore.input, signal: new AbortController().signal });
    expect(resolved.ok, resolved.ok ? undefined : JSON.stringify(resolved.error)).toBe(true);
    expect(readFileSync(restore.target.absolute)).toEqual(Buffer.from(restore.desired));
    expect(existsSync(sourceTarget.absolute)).toBe(false);
  });

  it("does not delete newly replaced gate interfaces during committed replay cleanup", async () => {
    const h = await harness();
    const input = gateInput(h, "replay-cleanup-race");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
    const closed = await runDurableGate(h.dependencies, { ...input, signal: new AbortController().signal });
    if (!closed.ok) throw new Error("gate resolution failed");
    const oldGateProjection = JSON.parse(readFileSync(join(h.authority.task_root, "decisions", opened.value.gate_id, "request.json"), "utf8")) as Record<string, unknown>;
    const foreignId = "g-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as GateOpenInput["intent_id"];
    const foreignDecision = { ...envelope(opened.value.request.value), gate_id: foreignId };
    let lockCalls = 0;
    const raced: GateLifecycleDependencies = { ...h.dependencies, lock: { runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>) => {
      const result = await work();
      lockCalls += 1;
      if (lockCalls === 1) {
        const active = {
          ...oldGateProjection, gate_id: foreignId, status: "awaiting-human",
          decision_template: {
            schema_version: "1", gate_id: foreignId, task_id: TASK, phase_instance: PHASE, kind: "artifact-approval",
            subject_digest: input.subject_digest, context_digest: opened.value.request.value.context_digest,
            required_fields: ["payload", "human_provenance"],
            cancellation_fields: ["cancelled", "reason", "human_provenance"],
          }, supplemental: [],
        };
        writeFileSync(gatePath(h), canonicalDocument(active as PlainJsonValue).bytes);
        writeFileSync(decisionPath(h), canonicalDocument(foreignDecision).bytes);
      }
      return result;
    } } };
    const replayed = await runDurableGate(raced, { ...input, signal: new AbortController().signal });
    expect(replayed.ok).toBe(true);
    expect(existsSync(gatePath(h))).toBe(true);
    expect(existsSync(decisionPath(h))).toBe(true);
  });
});
