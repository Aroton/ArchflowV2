import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
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
import type { ResolvedPath, ResolvedTaskPath, ResolvedTaskWorkspacePath } from "../../src/repository/paths.js";
import { AtomicReplaceError, createAtomicWriter, createProjectionWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import {
  archiveDirectSemanticGateDecision,
  enterDirectSemanticRevisionCheckpoint,
  openDurableGate,
  resolveDurableGate,
  settleDirectSemanticGateDecision,
  type GateLifecycleDependencies,
  type GateOpenInput,
} from "../../src/state/gates.js";
import { resolveInterfaceGateDecision } from "../helpers/resolve-interface-gate.js";
import { readIntentReceipt, readTaskState } from "../../src/state/read.js";
import { computeAuthoritativeSemanticStatus } from "../../src/state/semantic-status.js";
import { executeSemanticAction } from "../../src/state/semantic-actions.js";
import { projectSemanticStatus } from "../../src/state/semantic-view.js";
import type { ProductionServices } from "../../src/state/production.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";
import { captureProjectionTarget, projectionGenerationDigest, type ProjectionPlan } from "../../src/state/snapshots.js";
import { planStateTransition } from "../../src/state/transitions.js";

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
  schema_version: "1", workflow_digest: D("5"), constitution_digest: D("6"),
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
    last_transition: {
      schema_version: "1", tool: "archflow_state", operation: parseSafeCode("record-document-artifact"),
      intent_id: "prior-intent" as GateOpenInput["intent_id"], request_digest: D("d"), input_fingerprint: FINGERPRINT,
      outcome: { revision: 7 }, outcome_digest: canonicalJsonDigest({ revision: 7 }),
      prior_revision: parseSafeInteger(6), resulting_revision: parseSafeInteger(7), result_id: "prior-result" as never,
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
    lock: { runExclusive: async <T>(_root: ResolvedTaskWorkspacePath, work: () => Promise<T>) => work() },
    resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: { subject: SUBJECT, fingerprint: FINGERPRINT } }),
    read_state: readTaskState,
    read_config: async () => ({
      kind: "valid",
      snapshot: {
        bytes: new TextEncoder().encode('schema_version: "1"\nroles: {}\n'),
        digest: D("4"),
        parsed: { schema_version: "1", roles: {} },
      },
    }),
    read_receipt: readIntentReceipt,
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
        { role: "counter-review", evidence_digest: D("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
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

function decisionPath(h: Harness): string { return join(h.authority.workspace_root, "cache", "gates", "gate.decision"); }
function gatePath(h: Harness): string { return join(h.authority.workspace_root, "cache", "gates", "gate.json"); }
function archivePath(h: Harness, gateId: string): string { return join(h.authority.task_root, "authority", "decisions", gateId, "decision.json"); }

type RefusalPostcondition = Readonly<{
  revision: number;
  approvals: TaskStateV1["approvals"];
  receipt: Uint8Array | undefined;
}>;

async function refusalPostcondition(h: Harness, intentId: string): Promise<RefusalPostcondition> {
  const state = await readTaskState(h.authority.state);
  if (state.kind !== "canonical") throw new Error("state unavailable");
  const receiptPath = join(h.authority.workspace_root, "transient", "intents", `${intentId}.json`);
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
  it("opens exactly one durable gate, clears the prior transition, and leaves it pending", async () => {
    const h = await harness();
    const opened = await openDurableGate(h.dependencies, gateInput(h));
    expect(opened.ok, opened.ok ? undefined : JSON.stringify({ error: opened.error, root: h.root, files: readFileSync(h.authority.state.absolute, "utf8") })).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.state.value.open_gate?.gate_id).toBe(opened.value.gate_id);
    expect(opened.value.state.value.last_transition).toBeUndefined();
    expect(existsSync(join(h.authority.task_root, "authority", "decisions", opened.value.gate_id, "request.json"))).toBe(true);
    expect(existsSync(gatePath(h))).toBe(true);

    // No consumer path closes the gate implicitly: it stays pending until a decision resolves it.
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
        if (path.path_class === "workspace-gate-interface" && failProjection) {
          failProjection = false;
          throw new AtomicReplaceError({ operation: "replace", target_may_have_changed: false, collision: false });
        }
        await realAtomic.replace(path, bytes);
      },
    } };
    const first = await openDurableGate(crashing, input);
    expect(first.ok).toBe(false);
    const requestDirectories = join(h.authority.task_root, "authority", "decisions");
    expect(existsSync(requestDirectories)).toBe(true);
    const before = await readTaskState(h.authority.state);
    if (before.kind !== "canonical") throw new Error("state unavailable");
    const { last_transition: _transition, ...stateBase } = before.document.value;
    const unrelated = { ...stateBase, revision: parseSafeInteger(before.document.value.revision + 1), status: "failed" as const } as TaskStateV1;
    writeFileSync(h.authority.state.absolute, canonicalDocument(unrelated).bytes);
    const retriedInput = { ...input, expected_revision: unrelated.revision };
    const retried = await openDurableGate(h.dependencies, retriedInput);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    writeFileSync(decisionPath(h), canonicalDocument(envelope(retried.value.request.value)).bytes);
    const tampered = { ...retried.value.state.value, status: "running" as const };
    writeFileSync(h.authority.state.absolute, canonicalDocument(tampered).bytes);
    const rejected = await resolveInterfaceGateDecision(h.dependencies, h.authority, retried.value.gate_id, FINGERPRINT);
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
      // Re-opening republishes the missing or damaged active-gate interface before resolution.
      const republished = await openDurableGate(h.dependencies, input);
      expect(republished.ok, republished.ok ? undefined : JSON.stringify(republished.error)).toBe(true);
      const resolved = await resolveInterfaceGateDecision(h.dependencies, h.authority, opened.value.gate_id);
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
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "reject")).bytes);
    const resolved = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
    expect(resolved.ok, resolved.ok ? undefined : JSON.stringify(resolved.error)).toBe(true);
    const state = await readTaskState(h.authority.state);
    expect(state.kind === "canonical" ? state.document.value.open_gate : undefined).toBeUndefined();
  });

  it("rejects a last-transition injection while a gate is open", async () => {
    const h = await harness();
    const input = gateInput(h, "committed-intent-injection");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
    const injected = { ...opened.value.state.value, last_transition: { ...initialState(h.authority).last_transition!, result_id: "injected-result" as never } };
    writeFileSync(h.authority.state.absolute, canonicalDocument(injected).bytes);
    const rejected = await resolveInterfaceGateDecision(h.dependencies, h.authority, opened.value.gate_id, FINGERPRINT);
    expect(rejected.ok).toBe(false);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
  });

  it("archives an advancing decision, commits one approval and last transition, cleans work, and exact-replays", async () => {
    const h = await harness();
    const opened = await openDurableGate(h.dependencies, gateInput(h));
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
    const resolved = await resolveInterfaceGateDecision(h.dependencies, h.authority, opened.value.gate_id);
    expect(resolved.ok, resolved.ok ? undefined : JSON.stringify(resolved.error)).toBe(true);
    if (!resolved.ok || !("record" in resolved.value)) return;
    expect(resolved.value.effect).toBe("advance");
    expect(resolved.value.state.value.approvals).toHaveLength(1);
    expect(resolved.value.state.value.open_gate).toBeUndefined();
    expect(resolved.value.state.value.last_transition?.intent_id).toBe(gateInput(h).intent_id);
    expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(true);
    expect(existsSync(gatePath(h))).toBe(false);
    expect(existsSync(decisionPath(h))).toBe(false);

    const replay = await resolveInterfaceGateDecision(h.dependencies, h.authority, opened.value.gate_id);
    expect(replay.ok).toBe(true);
    if (replay.ok && "record" in replay.value) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.state.value.approvals).toHaveLength(1);
    }
  });

  it("archives and clears a rejected decision without approval or a new transition", async () => {
    const h = await harness();
    const input = gateInput(h, "revise-intent");
    const opened = await openDurableGate(h.dependencies, input);
    if (!opened.ok) throw new Error("gate open failed");
    writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value, "reject")).bytes);
    const resolved = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.effect).toBe("non-advancing");
    expect(resolved.value.state.value.open_gate).toBeUndefined();
    expect(resolved.value.state.value.approvals).toEqual([]);
    expect(resolved.value.state.value.last_transition?.intent_id).toBe(input.intent_id);
    expect(existsSync(join(h.authority.workspace_root, "transient", "intents", `${input.intent_id}.json`))).toBe(false);
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
    expect(resolved, JSON.stringify(resolved)).toMatchObject({
      ok: true,
      value: {
        effect: "retry",
        replayed: false,
        state: { value: {
          phase_instance: PHASE, step: "produce", status: "running",
          attempt: 3, input_fingerprint: nextFingerprint,
          pending_human_revision: {
            gate_id: opened.value.gate_id,
            gate_kind: "constitution-review",
            attempt: 3,
          },
        } },
      },
    });
    if (!resolved.ok) return;
    const replayed = await openDurableGate(dependencies, input);
    expect(replayed, replayed.ok ? undefined : JSON.stringify(replayed.error)).toMatchObject({
      ok: true,
      value: { replay: { value: { gate_id: opened.value.gate_id } }, state: { value: { attempt: 3 } } },
    });

    const { last_transition: _transition, ...landedWithoutTransition } = resolved.value.state.value;
    const afterLanding = {
      ...landedWithoutTransition,
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

  it("keeps retry-once in the exhausted review cycle instead of opening a human revision", async () => {
    const h = await harness();
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...initialState(h.authority), step: "triage", status: "succeeded",
      attempt: parseSafeInteger(3),
    }).bytes);
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      resolve_gate_reentry_fingerprint: async () => ({ schema_version: "1", ok: true, value: D("e") }),
    };
    const input: GateOpenInput = {
      ...gateInput(h, "retry-once-same-cycle"),
      kind: "attempts-exhausted",
      context: { step: "triage", attempts: 3, maximum_attempts: 3 },
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
      payload: { decision: "retry-once", reason: "Authorize one more review attempt" },
    }).bytes);
    const resolved = await resolveDurableGate(dependencies, h.authority, request.gate_id);
    expect(resolved, JSON.stringify(resolved)).toMatchObject({
      ok: true,
      value: { state: { value: { step: "produce", status: "running", attempt: 4 } } },
    });
    if (resolved.ok) expect(resolved.value.state.value.pending_human_revision).toBeUndefined();
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

  it("restarts material drift at the authenticated phase that actually produced the upstream", async () => {
    const h = await harness();
    const phaseDesign12 = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(12) });
    const phaseDesign11 = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(11) });
    const phase12Bytes = new TextEncoder().encode("# Phase 12\n");
    const phase12Artifact = {
      schema_version: "1", artifact_kind: "document", task_id: TASK,
      phase_instance: phaseDesign12, step: "produce",
      document_path: parseTaskPathClaim("phases/12/design.md"), path_class: "document",
      byte_count: parseSafeInteger(phase12Bytes.byteLength), content_digest: sha256Bytes(phase12Bytes),
      declared_inputs: [], input_fingerprint: FINGERPRINT, snapshot_digest: D("2"),
      projection_target: `.archflow/tasks/${TASK}/phases/12/design.md` as never,
    } as DocumentArtifactV1;
    const phase11Bytes = new TextEncoder().encode("# Phase 11\n");
    const designBytes = new TextEncoder().encode("# Architecture from phase 11\n");
    const compoundArtifact = {
      ...phase12Artifact,
      phase_instance: phaseDesign11, document_path: parseTaskPathClaim("phases/11/design.md"),
      byte_count: parseSafeInteger(phase11Bytes.byteLength), content_digest: sha256Bytes(phase11Bytes),
      projection_target: `.archflow/tasks/${TASK}/phases/11/design.md` as never,
      additional_documents: [{
        document_path: parseTaskPathClaim("design.md"), byte_count: parseSafeInteger(designBytes.byteLength),
        content_digest: sha256Bytes(designBytes), projection_target: `.archflow/tasks/${TASK}/design.md` as never,
      }],
    } as DocumentArtifactV1;
    const phase12Digest = canonicalJsonDigest(phase12Artifact);
    const compoundDigest = canonicalJsonDigest(compoundArtifact);
    const phase12Ref = {
      phase_instance: "phase-design-12", step: "produce", result_digest: D("1"),
      result_id: parseSafeId("phase-12-result"), input_fingerprint: FINGERPRINT,
    } as TaskStateV1["authoritative_results"][number];
    const compoundRef = {
      phase_instance: "phase-design-11", step: "produce", result_digest: D("2"),
      result_id: parseSafeId("compound-result"), input_fingerprint: FINGERPRINT,
    } as TaskStateV1["authoritative_results"][number];
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...initialState(h.authority),
      step: "triage",
      status: "succeeded",
      attempt: parseSafeInteger(2),
      authoritative_results: [compoundRef, phase12Ref],
      approvals: [
        { gate_id: parsePathSafeId("compound-approval"), gate_kind: "design-approval", subject_digest: compoundDigest, decision_digest: D("4"), resolved_at_revision: parseSafeInteger(6) },
        { gate_id: parsePathSafeId("phase-12-approval"), gate_kind: "design-approval", subject_digest: phase12Digest, decision_digest: D("3"), resolved_at_revision: parseSafeInteger(5) },
      ],
    }).bytes);
    const retained = (artifact: DocumentArtifactV1, measuredAtRevision: number) => ({
      manifest: { value: {
        source_artifact: artifact, artifact_digest: canonicalJsonDigest(artifact),
        accounting: { measured_at_revision: measuredAtRevision }, projections: [], outputs: [],
      } },
    });
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      load_retained_manifest: async (reference) => ({
        schema_version: "1", ok: true,
        value: (reference.result_id === compoundRef.result_id
          ? retained(compoundArtifact, 6)
          : retained(phase12Artifact, 5)) as never,
      }),
    };
    const firstInput: GateOpenInput = {
      ...gateInput(h, "first-material"),
      request_digest: D("1"),
      kind: "material-drift",
      context: {
        affected_upstream: { kind: "architecture", digest: compoundDigest },
        drift: "material",
        affected_claim_ids: ["claim-one"],
      },
    };
    const firstOpened = await openDurableGate(dependencies, firstInput);
    expect(firstOpened.ok, JSON.stringify(firstOpened)).toBe(true);
    if (!firstOpened.ok) return;
    const firstRequest = firstOpened.value.request.value;
    writeFileSync(decisionPath(h), canonicalDocument({
      schema_version: "1", gate_id: firstRequest.gate_id, task_id: firstRequest.task_id,
      phase_instance: firstRequest.phase_instance, kind: firstRequest.kind,
      subject_digest: firstRequest.subject_digest, context_digest: firstRequest.context_digest,
      human_provenance: {
        schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "connected-host",
        decision_event_id: firstRequest.gate_id, connection_id: "connection-material-drift",
        request_id_digest: D("f"), recorded_at: "2026-07-30T12:00:00.000Z",
      },
      payload: { decision: "amend-upstream", reason: "Amend the first upstream" },    }).bytes);
    const firstResolved = await resolveDurableGate(
      dependencies, h.authority, firstRequest.gate_id,
    );
    expect(firstResolved, JSON.stringify(firstResolved)).toMatchObject({
      ok: true,
      value: {
        effect: "redirect-upstream",        state: { value: {
          phase_instance: "phase-design-11", step: "produce", status: "running", attempt: 1,
          restart_history: [{
            restart_id: firstRequest.gate_id,
            source_phase_instance: PHASE,
            target_phase_instance: "phase-design-11",
            reason: "Amend the first upstream",
          }],
        } },
      },
    });
    if (!firstResolved.ok) return;
    const replay = await resolveDurableGate(dependencies, h.authority, firstRequest.gate_id);
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, effect: "redirect-upstream" } });
    // Re-opening the same completed restart request replays it too: the archived decision
    // authenticates the already-landed restart instead of opening a competing gate.
    const reopened = await openDurableGate(dependencies, firstInput);
    expect(reopened, reopened.ok ? undefined : JSON.stringify(reopened.error)).toMatchObject({
      ok: true,
      value: { replay: { value: { gate_id: firstRequest.gate_id } }, state: { value: { phase_instance: "phase-design-11" } } },
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
    for (const issueCode of ["decision-missing", "decision-noncanonical"] as const) {
      const h = await harness();
      const input = gateInput(h, `refused-${issueCode}`);
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error("gate open failed");
      if (issueCode === "decision-noncanonical") writeFileSync(decisionPath(h), "{not canonical json");
      const before = await refusalPostcondition(h, input.intent_id);
      const refused = await resolveDurableGate(h.dependencies, h.authority, opened.value.gate_id);
      expect(refused.ok, issueCode).toBe(false);
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
    const foreignRoot = join(h.authority.task_root, "authority", "decisions", foreignGateId);
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
        // Cancellation returns a failure and leaves no state reference, so its temporary archive
        // is collected after durable closure while the disposable UI is removed.
        expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
        continue;
      }
      writeFileSync(decisionPath(h), canonicalDocument(waiverInterface(opened.value.request.value, outcome === "grant")).bytes);
      const resolved = await resolveInterfaceGateDecision(h.dependencies, h.authority, opened.value.gate_id);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok || !("record" in resolved.value)) continue;
      expect(resolved.value.record.value.outcome).toBe("waiver-decided");
      expect(resolved.value.state.value.waivers).toEqual([expect.objectContaining({
        gate_id: opened.value.gate_id, granted: outcome === "grant", scope: { operation: "review-trigger", boundary: "phase" },
      })]);
      expect(resolved.value.state.value.last_transition?.intent_id).toBe(input.intent_id);
      expect(existsSync(join(h.authority.workspace_root, "transient", "intents", `${input.intent_id}.json`))).toBe(false);
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

  it("revalidates config parseability, repository identity, state, and fingerprint before resolving after a wait", async () => {
    for (const changed of ["config", "repository", "state", "fingerprint"] as const) {
      const h = await harness();
      const input = gateInput(h, `changed-during-wait-${changed}`);
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error("gate open failed");
      writeFileSync(decisionPath(h), canonicalDocument(envelope(opened.value.request.value)).bytes);
      let dependencies: GateLifecycleDependencies = h.dependencies;
      let resumedInput = input;
      if (changed === "config") dependencies = { ...dependencies, read_config: async () => ({ kind: "invalid", digest: D("0") }) };
      if (changed === "fingerprint") resumedInput = { ...input, input_fingerprint: D("0") };
      if (changed === "repository" || changed === "state") {
        const read = await readTaskState(h.authority.state);
        if (read.kind !== "canonical") throw new Error("state unavailable");
        const mutated = changed === "repository"
          ? { ...read.document.value, repository_identity_digest: D("0") }
          : { ...read.document.value, status: "failed" as const };
        writeFileSync(h.authority.state.absolute, canonicalDocument(mutated).bytes);
      }
      const rejected = changed === "fingerprint"
        ? await resolveInterfaceGateDecision(dependencies, h.authority, opened.value.gate_id, resumedInput.input_fingerprint)
        : await resolveInterfaceGateDecision(dependencies, h.authority, opened.value.gate_id);
      expect(rejected.ok, `${changed} change unexpectedly resolved`).toBe(false);
      expect(existsSync(archivePath(h, opened.value.gate_id))).toBe(false);
    }
  });

  it("cleans interfaces when archived non-advancing and cancelled closures resume after a state-write crash", async () => {
    for (const outcome of ["reject", "cancel"] as const) {
      const h = await harness();
      const input = gateInput(h, `closure-resume-${outcome}`);
      const opened = await openDurableGate(h.dependencies, input);
      if (!opened.ok) throw new Error("gate open failed");
      const decision = outcome === "reject" ? envelope(opened.value.request.value, "reject") : {
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

  it("freshly replans discard-and-restore and applies the retained generation", async () => {
    const h = await harness();
    const restore = await restoreFixture(h, false);
    const opened = await openDurableGate(restore.dependencies, restore.input);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    writeFileSync(decisionPath(h), canonicalDocument(restoreEnvelope(opened.value.request.value, "discard-and-restore")).bytes);
    const resolved = await resolveInterfaceGateDecision(restore.dependencies, h.authority, opened.value.gate_id);
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

    const rejected = await resolveInterfaceGateDecision(restore.dependencies, h.authority, opened.value.gate_id);

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
    const rejected = await resolveInterfaceGateDecision(restore.dependencies, h.authority, opened.value.gate_id);
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
    const resolved = await resolveInterfaceGateDecision(restore.dependencies, h.authority, opened.value.gate_id);
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
    const first = await resolveInterfaceGateDecision(crashing, h.authority, opened.value.gate_id);
    expect(first.ok).toBe(false);
    expect(readFileSync(restore.target.absolute)).toEqual(Buffer.from(restore.desired));
    const resumed = await resolveInterfaceGateDecision(restore.dependencies, h.authority, opened.value.gate_id);
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
    const rejected = await resolveInterfaceGateDecision(dependencies, h.authority, opened.value.gate_id);
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
      const crashed = await resolveInterfaceGateDecision(crashing, h.authority, opened.value.gate_id);
      expect(crashed.ok).toBe(false);
      expect(existsSync(restore.target.absolute)).toBe(false);
      expect(existsSync(peerTarget.absolute)).toBe(false);
      if (thirdGeneration) writeFileSync(peerTarget.absolute, "third generation\n");
      const resumed = await resolveInterfaceGateDecision(dependencies, h.authority, opened.value.gate_id);
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
    const resumed = await resolveInterfaceGateDecision(dependencies, h.authority, opened.value.gate_id);
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
    const resolved = await resolveInterfaceGateDecision(dependencies, h.authority, opened.value.gate_id);
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
    const closed = await resolveInterfaceGateDecision(h.dependencies, h.authority, opened.value.gate_id);
    if (!closed.ok) throw new Error("gate resolution failed");
    const oldGateProjection = JSON.parse(readFileSync(join(h.authority.task_root, "authority", "decisions", opened.value.gate_id, "request.json"), "utf8")) as Record<string, unknown>;
    const foreignId = "g-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as GateOpenInput["intent_id"];
    const foreignDecision = { ...envelope(opened.value.request.value), gate_id: foreignId };
    let lockCalls = 0;
    const raced: GateLifecycleDependencies = { ...h.dependencies, lock: { runExclusive: async <T>(_root: ResolvedTaskWorkspacePath, work: () => Promise<T>) => {
      const result = await work();
      lockCalls += 1;
      if (lockCalls === 1) {
        mkdirSync(join(h.authority.workspace_root, "cache", "gates"), { recursive: true });
        const active = {
          ...oldGateProjection, gate_id: foreignId, status: "awaiting-human",
          decision_template: {
            schema_version: "1", gate_id: foreignId, task_id: TASK, phase_instance: PHASE, kind: "artifact-approval",
            subject_digest: input.subject_digest, context_digest: opened.value.request.value.context_digest,
            required_fields: ["payload", "human_provenance"],
            cancellation_fields: ["cancelled", "reason", "human_provenance"],
          },
        };
        writeFileSync(gatePath(h), canonicalDocument(active as PlainJsonValue).bytes);
        writeFileSync(decisionPath(h), canonicalDocument(foreignDecision).bytes);
      }
      return result;
    } } };
    const replayed = await resolveInterfaceGateDecision(raced, h.authority, opened.value.gate_id);
    expect(replayed.ok, replayed.ok ? undefined : JSON.stringify(replayed.error)).toBe(true);
    expect(existsSync(gatePath(h))).toBe(true);
    expect(existsSync(decisionPath(h))).toBe(true);
  });

  it("archives a connected-host semantic choice once, closes re-entry first, and enters revision separately", async () => {
    const h = await harness();
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...initialState(h.authority), step: "triage", status: "succeeded",
    } as TaskStateV1).bytes);
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      resolve_gate_reentry_fingerprint: async () => ({ schema_version: "1", ok: true, value: FINGERPRINT }),
    };
    const opened = await openDurableGate(dependencies, gateInput(h, "semantic-reentry-gate"));
    if (!opened.ok) throw new Error("semantic gate open failed");
    const connection = connectionContextFactory.captureStartup({
      connection_id: "semantic-gate-connection",
      startup_repository_candidate: { working_directory: h.root },
    }).initialize({ client: { name: "Codex", version: "test" }, host: "codex", protocol_version: "2025-06-18" });
    const invocation = createInvocationContext(connection, {
      invocation_id: "semantic-gate-call",
      transport_metadata: { request_id: 71, operation: "tools/call" },
    }, new AbortController().signal);
    const operationDigest = D("e");
    const archiveInput = {
      authority: h.authority,
      operation_digest: operationDigest,
      intent_id: parsePathSafeId(`afop-${operationDigest}-decision-archive`),
      choice: "request-changes",
      reason: "Revise the reviewed work",
      invocation_context: invocation,
    } as const;
    const archived = await archiveDirectSemanticGateDecision(dependencies, archiveInput);
    expect(archived.ok, archived.ok ? undefined : JSON.stringify(archived.error)).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.replayed).toBe(false);
    expect(existsSync(decisionPath(h))).toBe(false);
    const connectedStatus = await computeAuthoritativeSemanticStatus(dependencies, h.authority);
    expect(connectedStatus.ok && connectedStatus.value.archived_decision).toMatchObject({
      status: "exact", operation_digest: operationDigest,
    });
    const replay = await archiveDirectSemanticGateDecision(dependencies, archiveInput);
    expect(replay.ok && replay.value.replayed).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.record.bytes).toEqual(archived.value.record.bytes);

    const settled = await settleDirectSemanticGateDecision(dependencies, {
      authority: h.authority,
      operation_digest: operationDigest,
      intent_id: parsePathSafeId(`afop-${operationDigest}-decision-settle`),
    });
    expect(settled.ok, settled.ok ? undefined : JSON.stringify(settled.error)).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.state.value).toMatchObject({ step: "triage", status: "succeeded", attempt: 1 });
    expect(settled.value.state.value.open_gate).toBeUndefined();
    expect(settled.value.state.value.pending_human_revision).toBeUndefined();
    expect(settled.value.state.value.last_transition).toMatchObject({
      tool: "archflow_gate", operation: "semantic-revision-requested",
      intent_id: `afop-${operationDigest}-decision-settle`,
    });

    const revisionOperation = D("f");
    const entered = await enterDirectSemanticRevisionCheckpoint(dependencies, {
      authority: h.authority,
      operation_digest: revisionOperation,
      intent_id: parsePathSafeId(`afop-${revisionOperation}-revise-enter`),
    });
    expect(entered.ok, entered.ok ? undefined : JSON.stringify(entered.error)).toBe(true);
    if (!entered.ok) return;
    expect(entered.value.value).toMatchObject({ step: "produce", status: "running", attempt: 1 });
    expect(entered.value.value.pending_human_revision).toMatchObject({
      gate_id: opened.value.gate_id,
      predecessor_input_fingerprint: FINGERPRINT,
      attempt: 1,
    });
    expect(entered.value.value.last_transition).toMatchObject({
      tool: "archflow_gate", operation: "semantic-revision-enter",
      intent_id: `afop-${revisionOperation}-revise-enter`,
      result_id: opened.value.gate_id,
      prior_revision: settled.value.state.value.revision,
      resulting_revision: entered.value.value.revision,
    });
    const replayedEntry = await enterDirectSemanticRevisionCheckpoint(dependencies, {
      authority: h.authority,
      operation_digest: revisionOperation,
      intent_id: parsePathSafeId(`afop-${revisionOperation}-revise-enter`),
    });
    expect(replayedEntry.ok, replayedEntry.ok ? undefined : JSON.stringify(replayedEntry.error)).toBe(true);
    if (replayedEntry.ok) expect(replayedEntry.value.bytes).toEqual(entered.value.bytes);
  });

  it("settles an archive-before-state local revise through its digest-bound continuation", async () => {
    const h = await harness();
    const legacyPhase = encodePhaseInstance({ kind: "prd" });
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...initialState(h.authority), phase_instance: legacyPhase,
      step: "triage", status: "succeeded", attempt: parseSafeInteger(3),
    }).bytes);
    const liveDependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      resolve_gate_reentry_fingerprint: async () => ({ schema_version: "1", ok: true, value: D("e") }),
    };
    const input: GateOpenInput = {
      ...gateInput(h, "legacy-reentry-archive"), phase_instance: legacyPhase, kind: "constitution-review",
      context: {
        constitution: "pass", failed_rules: [], uncertain_rules: [],
        matched_trigger_rules: [{ rule_id: "review-required", rule_version: 1 }],
        uncertain_trigger_rules: [], eligible_waivers: [],
      },
    };
    const opened = await openDurableGate(liveDependencies, input);
    expect(opened.ok, opened.ok ? undefined : JSON.stringify(opened.error)).toBe(true);
    if (!opened.ok) return;
    const request = opened.value.request.value;
    writeFileSync(decisionPath(h), canonicalDocument({
      schema_version: "1", gate_id: request.gate_id, task_id: request.task_id,
      phase_instance: request.phase_instance, kind: request.kind,
      subject_digest: request.subject_digest, context_digest: request.context_digest,
      human_provenance: PROVENANCE,
      payload: { decision: "revise", reason: "Revise current artifact" },
    }).bytes);
    const realAtomic = liveDependencies.atomic;
    const archiveOnly: GateLifecycleDependencies = { ...liveDependencies, atomic: {
      ...realAtomic,
      replace: async (path, bytes) => {
        if (path.path_class === "task-state") {
          throw new AtomicReplaceError({ operation: "replace", target_may_have_changed: false, collision: false });
        }
        await realAtomic.replace(path, bytes);
      },
    } };
    const crashed = await resolveDurableGate(archiveOnly, h.authority, opened.value.gate_id);
    expect(crashed.ok).toBe(false);
    const archived = parseCanonicalDocument<GateDecisionRecordV1>(readFileSync(archivePath(h, opened.value.gate_id)));
    const operation = canonicalJsonDigest({
      schema_version: "1", digest_kind: "legacy-local-decision-settlement",
      gate_request_digest: opened.value.request.digest, gate_decision_digest: archived.digest,
    });
    const legacyStatus = await computeAuthoritativeSemanticStatus(liveDependencies, h.authority);
    expect(legacyStatus.ok && legacyStatus.value.archived_decision).toMatchObject({
      status: "exact", operation_digest: operation, provenance: "pre-facade",
    });
    if (archived.value.outcome !== "decided") throw new Error("fixture archive was not decided");
    const malformedConnected = canonicalDocument({
      ...archived.value,
      envelope: {
        ...archived.value.envelope,
        human_provenance: {
          schema_version: "1", actor_class: "human", assurance: "declared-local-trace",
          channel: "connected-host", decision_event_id: "malformed-event",
          connection_id: "malformed-connection", request_id_digest: D("a"),
          recorded_at: "2026-07-30T12:00:00.000Z",
        },
      },
    } as GateDecisionRecordV1);
    writeFileSync(archivePath(h, opened.value.gate_id), malformedConnected.bytes);
    const malformedStatus = await computeAuthoritativeSemanticStatus(liveDependencies, h.authority);
    expect(malformedStatus.ok && malformedStatus.value.archived_decision).toEqual({ status: "invalid" });
    writeFileSync(archivePath(h, opened.value.gate_id), archived.bytes);
    const afterCrash = await readTaskState(h.authority.state);
    expect(afterCrash.kind === "canonical" && afterCrash.document.value.open_gate?.gate_id).toBe(opened.value.gate_id);

    const forgedOperation = D("0");
    const forged = await settleDirectSemanticGateDecision(liveDependencies, {
      authority: h.authority, operation_digest: forgedOperation,
      intent_id: parsePathSafeId(`afop-${forgedOperation}-decision-settle`),
    });
    expect(forged.ok).toBe(false);
    const settled = await settleDirectSemanticGateDecision(liveDependencies, {
      authority: h.authority, operation_digest: operation,
      intent_id: parsePathSafeId(`afop-${operation}-decision-settle`),
    });
    expect(settled.ok, settled.ok ? undefined : JSON.stringify(settled.error)).toBe(true);
    if (!settled.ok) return;
    expect(settled.value).toMatchObject({
      replayed: false, effect: "retry",
      state: { value: {
        step: "triage", status: "succeeded", attempt: 3,
        last_transition: {
          tool: "archflow_gate", operation: "semantic-revision-requested",
          intent_id: `afop-${operation}-decision-settle`, result_id: opened.value.gate_id,
        },
      } },
      record: { value: { envelope: { human_provenance: { channel: "archflow-local" } } } },
    });
    expect(settled.value.state.value.open_gate).toBeUndefined();
    const replayed = await settleDirectSemanticGateDecision(liveDependencies, {
      authority: h.authority, operation_digest: operation,
      intent_id: parsePathSafeId(`afop-${operation}-decision-settle`),
    });
    expect(replayed.ok && replayed.value.replayed).toBe(true);
    const checkpointStatus = await computeAuthoritativeSemanticStatus(liveDependencies, h.authority);
    expect(checkpointStatus.ok && checkpointStatus.value.revision_checkpoint).toMatchObject({
      status: "valid", operation_digest: operation, provenance: "pre-facade",
    });
    if (!checkpointStatus.ok) return;
    const invocation = { skill: "archflow-prd" as const, intent: "resume" as const };
    const ready = projectSemanticStatus(checkpointStatus.value, invocation).view;
    expect(ready.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });
    expect(ready.next_action.offer).toBeDefined();
    const afterRevise = await executeSemanticAction(
      { authority: h.authority, runner: h.runner } as ProductionServices,
      checkpointStatus.value,
      { schema_version: "1", task_id: TASK, invocation, action: { offer: ready.next_action.offer! } },
      {
        enter_revision_checkpoint: (plan) => enterDirectSemanticRevisionCheckpoint(liveDependencies, {
          authority: h.authority, operation_digest: plan.operation_digest, intent_id: plan.intent_id,
        }),
        refresh_snapshot: async () => {
          const refreshed = await computeAuthoritativeSemanticStatus(liveDependencies, h.authority);
          if (!refreshed.ok) throw new Error(JSON.stringify(refreshed.error));
          return refreshed.value;
        },
      },
    );
    expect(afterRevise.position).toEqual({ kind: "prd" });
    const enteredState = await readTaskState(h.authority.state);
    expect(enteredState.kind === "canonical" && enteredState.document.value).toMatchObject({
      phase_instance: legacyPhase, step: "produce", status: "running", attempt: 3,
    });
  });

  it("replays direct retry-once revision entry with its authenticated predecessor attempt", async () => {
    const h = await harness();
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...initialState(h.authority), step: "triage", status: "succeeded", attempt: parseSafeInteger(3),
    }).bytes);
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      resolve_gate_reentry_fingerprint: async () => ({ schema_version: "1", ok: true, value: D("e") }),
    };
    const opened = await openDurableGate(dependencies, {
      ...gateInput(h, "semantic-retry-once"), kind: "attempts-exhausted",
      context: { step: "triage", attempts: 3, maximum_attempts: 3 },
    });
    expect(opened.ok, opened.ok ? undefined : JSON.stringify(opened.error)).toBe(true);
    if (!opened.ok) return;
    const connection = connectionContextFactory.captureStartup({
      connection_id: "semantic-retry-connection", startup_repository_candidate: { working_directory: h.root },
    }).initialize({ client: { name: "Codex", version: "test" }, host: "codex", protocol_version: "2025-06-18" });
    const invocation = createInvocationContext(connection, {
      invocation_id: "semantic-retry-call", transport_metadata: { request_id: 72, operation: "tools/call" },
    }, new AbortController().signal);
    const decisionOperation = D("d");
    const archived = await archiveDirectSemanticGateDecision(dependencies, {
      authority: h.authority, operation_digest: decisionOperation,
      intent_id: parsePathSafeId(`afop-${decisionOperation}-decision-archive`),
      choice: "try-review-again", reason: "Authorize one more attempt", invocation_context: invocation,
    });
    expect(archived.ok, archived.ok ? undefined : JSON.stringify(archived.error)).toBe(true);
    if (!archived.ok) return;
    const settled = await settleDirectSemanticGateDecision(dependencies, {
      authority: h.authority, operation_digest: decisionOperation,
      intent_id: parsePathSafeId(`afop-${decisionOperation}-decision-settle`),
    });
    expect(settled.ok, settled.ok ? undefined : JSON.stringify(settled.error)).toBe(true);
    if (!settled.ok) return;
    const revisionOperation = D("e");
    const entered = await enterDirectSemanticRevisionCheckpoint(dependencies, {
      authority: h.authority, operation_digest: revisionOperation,
      intent_id: parsePathSafeId(`afop-${revisionOperation}-revise-enter`),
    });
    expect(entered.ok, entered.ok ? undefined : JSON.stringify(entered.error)).toBe(true);
    if (!entered.ok) return;
    expect(entered.value.value).toMatchObject({ step: "produce", status: "running", attempt: 4 });
    expect(entered.value.value.pending_human_revision).toBeUndefined();
    expect(entered.value.value.last_transition?.outcome).toMatchObject({ predecessor_attempt: 3 });
    const replayed = await enterDirectSemanticRevisionCheckpoint(dependencies, {
      authority: h.authority, operation_digest: revisionOperation,
      intent_id: parsePathSafeId(`afop-${revisionOperation}-revise-enter`),
    });
    expect(replayed.ok, replayed.ok ? undefined : JSON.stringify(replayed.error)).toBe(true);
    if (replayed.ok) expect(replayed.value.bytes).toEqual(entered.value.bytes);
  });
});
