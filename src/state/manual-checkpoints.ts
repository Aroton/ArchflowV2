import { constants as fsConstants } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  canonicalJsonDigest,
  canonicalDocument,
  parseCanonicalDocument,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import {
  checkpointSelfDigest,
  parseManualCheckpoint,
  type ManualCheckpointV1,
} from "../contracts/durable-checkpoint.js";
import { openGateFrozenStateDigest } from "../contracts/durable.js";
import type { GateDecisionRecordV1, GateRequestV1, WaiverGateContext } from "../contracts/durable-gate.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type { StepStatus, TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger } from "../contracts/evidence.js";
import { computeInputFingerprint } from "../contracts/fingerprints.js";
import { parseToolCall } from "../contracts/mcp-tools.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import type { ManualAuthority, ManualAuthorityFacts } from "../local/manual-workflow.js";
import { resolveManualAuthority } from "../local/manual-workflow.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { CheckpointChainEvidence } from "../repository/handoff.js";
import { openResolved, resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import { ensureManualCheckpointDirectory } from "./layout.js";
import type { TransactionDependencies } from "./transaction.js";
import {
  resolveAuthenticatedManualGateFacts,
  loadAuthenticatedManualGateFacts,
  type AuthenticatedManualGateFacts,
  type AuthenticatedGateApproval,
} from "./gates.js";
import {
  resolveInstalledManualResult,
  type InstalledManualResult,
  type InstalledManualResultFacts,
} from "./production.js";
import { planStateTransition } from "./transitions.js";
import { implementationOutputCommittedAtCurrentTarget } from "./implementation-manifest.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const ioFailure = (authority: TransactionAuthority, operation: string): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }),
  });

export type ManualMilestone =
  | Readonly<{ kind: "step"; phase_instance: PhaseInstanceId; step: PipelineStep; status: StepStatus }>
  | Readonly<{ kind: "gate-open"; request: GateRequestV1 }>
  | Readonly<{ kind: "gate-resolved"; decision: GateDecisionRecordV1 }>
  | Readonly<{ kind: "terminal"; terminal: "complete" | "abandoned" }>;

export type NextManualCheckpointInput = Readonly<{
  authority: ManualAuthority;
  milestone: ManualMilestone;
  results: readonly InstalledManualResult[];
  gate_facts?: AuthenticatedManualGateFacts;
}>;

export type FinalManualProjectionDerivation =
  | Readonly<{ outcome: "ok"; projections: ManualCheckpointV1["projections"] }>
  | Readonly<{ outcome: "missing-manifest" | "path-conflict" }>;

/** Derives projections solely from the result generations that remain authoritative. */
export function deriveFinalManualProjections(input: Readonly<{
  references: readonly TaskStateV1["authoritative_results"][number][];
  retained_manifests: readonly CanonicalDocument<ResultManifestV1>[];
  installed_results: readonly InstalledManualResultFacts[];
}>): FinalManualProjectionDerivation {
  const installedByDigest = new Map(input.installed_results.map((facts) => [facts.reference.result_digest, facts] as const));
  const projections = new Map<
    ManualCheckpointV1["projections"][number]["path"],
    ManualCheckpointV1["projections"][number]["content_digest"]
  >();
  for (const reference of input.references) {
    const installed = installedByDigest.get(reference.result_digest);
    const retained = input.retained_manifests.find((candidate) => candidate.digest === reference.result_digest);
    if (installed === undefined && retained === undefined) return Object.freeze({ outcome: "missing-manifest" });
    for (const projection of installed?.projections ?? retained!.value.projections) {
      const prior = projections.get(projection.path);
      if (prior !== undefined && prior !== projection.content_digest) return Object.freeze({ outcome: "path-conflict" });
      projections.set(projection.path, projection.content_digest);
    }
  }
  return Object.freeze({
    outcome: "ok",
    projections: Object.freeze([...projections].map(([path, content_digest]) => ({ path, content_digest }))
      .sort((left, right) => left.path.localeCompare(right.path))),
  });
}

function invalidManual(authority: TransactionAuthority, issue: string): ProjectResult<never> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", {
      phase_instance: authority.context.phase_instance,
      issue_code: issue,
    }),
  });
}

export function materializeManualAuthorityState(authority: ManualAuthority): TaskStateV1 {
  return projectCurrentManualState(resolveManualAuthority(authority));
}

/** Canonical current-state shell shared by manual gates and checkpoint construction. */
export function projectCurrentManualState(authority: ManualAuthorityFacts): TaskStateV1 {
  const head = authority.head;
  if (authority.state !== undefined) {
    const {
      committed_intent: _committed,
      adopted_checkpoint: _adopted,
      open_gate: _open,
      terminal: _terminal,
      planned_final_phase: _planned,
      revision: _revision,
      phase_instance: _phase,
      step: _step,
      status: _status,
      attempt: _attempt,
      input_fingerprint: _fingerprint,
      authoritative_results: _results,
      approvals: _approvals,
      waivers: _waivers,
      ...state
    } = authority.state.value;
    const source = head ?? authority.state.value;
    const revision = head?.revision ?? authority.state.value.adopted_checkpoint?.revision ?? authority.state.value.revision;
    return {
      ...state,
      revision: parseSafeInteger(revision),
      phase_instance: source.phase_instance,
      step: source.step,
      status: source.status,
      attempt: source.attempt,
      input_fingerprint: source.input_fingerprint,
      authoritative_results: source.authoritative_results,
      approvals: source.approvals,
      waivers: source.waivers,
      ...(authority.planned_final_phase === undefined ? {} : { planned_final_phase: authority.planned_final_phase }),
      ...(source.open_gate === undefined ? {} : { open_gate: source.open_gate }),
      ...(source.terminal === undefined ? {} : { terminal: source.terminal }),
    };
  }
  const source = head;
  const initialization = authority.initialization;
  if (initialization === undefined) throw new TypeError("initial manual authority requires initialization");
  return {
    schema_version: "1",
    task_id: initialization.task_id,
    repository_identity_digest: initialization.repository_identity_digest,
    revision: parseSafeInteger(source?.revision ?? 0),
    phase_instance: source?.phase_instance ?? ("prd" as PhaseInstanceId),
    step: source?.step ?? "produce",
    status: source?.status ?? "running",
    attempt: source?.attempt ?? parseSafeInteger(1),
    input_fingerprint: source?.input_fingerprint ?? authority.initialization_digest,
    initialization_digest: authority.initialization_digest,
    config_digest: initialization.config_digest,
    workflow_digest: initialization.workflow_digest,
    constitution_digest: initialization.constitution_digest,
    policy_base_commit: initialization.policy_base_commit,
    authoritative_results: source?.authoritative_results ?? [],
    approvals: source?.approvals ?? [],
    waivers: source?.waivers ?? [],
    ...(authority.planned_final_phase === undefined ? {} : { planned_final_phase: authority.planned_final_phase }),
    ...(source?.open_gate === undefined ? {} : { open_gate: source.open_gate }),
    ...(source?.terminal === undefined ? {} : { terminal: source.terminal }),
  };
}

/** True when leaving the authenticated final implementation would bypass required completion. */
export function requiresManualFinalPhaseCompletion(
  current: TaskStateV1,
  targetPhase: PhaseInstanceId,
): boolean {
  const decoded = decodePhaseInstance(current.phase_instance);
  return decoded.kind === "phase-impl" && current.step === "triage" && current.status === "succeeded" &&
    current.planned_final_phase !== undefined && Number(decoded.phase) >= Number(current.planned_final_phase) &&
    targetPhase !== current.phase_instance;
}

async function deriveManualStepFingerprint(
  authority: ReturnType<typeof resolveManualAuthority>,
  current: TaskStateV1,
  phaseInstance: PhaseInstanceId,
  step: PipelineStep,
  status: StepStatus,
): Promise<ProjectResult<TaskStateV1["input_fingerprint"]>> {
  const config = await authority.services.dependencies.read_config(authority.services.authority.config);
  if (config.kind !== "valid") return invalidManual(authority.services.authority, "manual-fingerprint-config-invalid");
  const call = parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: current.task_id,
    intent_id: "manual-checkpoint-fingerprint",
    expected_revision: current.revision,
    input_fingerprint: current.input_fingerprint,
    phase_instance: phaseInstance,
    step,
    status,
  });
  const subject = await authority.services.dependencies.resolve_input_fingerprint({
    runner: authority.services.runner,
    authority: authority.services.authority,
    state: canonicalDocument(current),
    call,
    live_config: config.snapshot,
    context: authority.services.authority.context,
  });
  return subject.ok ? ok(computeInputFingerprint(subject.value)) : subject;
}

async function loadManualCommitTransitionFacts(
  input: NextManualCheckpointInput,
  authority: ReturnType<typeof resolveManualAuthority>,
  current: TaskStateV1,
): Promise<ProjectResult<Readonly<{
  completion_subject_digest: TaskStateV1["input_fingerprint"];
  authenticated_gate_approvals: readonly AuthenticatedGateApproval[];
  commit_observed: true;
}>>> {
  const implementation = authority.retained_manifests.find((manifest) =>
    manifest.value.phase_instance === current.phase_instance && manifest.value.step === "produce" &&
    manifest.value.source_artifact.artifact_kind === "implementation-output");
  const approval = current.approvals.find((candidate) =>
    candidate.gate_kind === "commit-authorization" &&
    candidate.subject_digest === implementation?.value.artifact_digest);
  if (implementation === undefined || approval === undefined ||
      implementation.value.source_artifact.artifact_kind !== "implementation-output") {
    return invalidManual(authority.services.authority, "manual-commit-proof-required");
  }
  const loaded = await loadAuthenticatedManualGateFacts({
    dependencies: authority.services.dependencies,
    transaction_authority: authority.services.authority,
    authority_binding: input.authority as object,
    state: current,
    gate_ids: [approval.gate_id],
  });
  if (!loaded.ok) return loaded;
  const gates = resolveAuthenticatedManualGateFacts(loaded.value, input.authority as object);
  const authenticated = gates.authenticated_gate_approvals.find((candidate) =>
    candidate.approval.gate_id === approval.gate_id &&
    candidate.approval.subject_digest === implementation.value.artifact_digest &&
    candidate.request.kind === "commit-authorization" &&
    candidate.request.phase_instance === current.phase_instance);
  if (authenticated === undefined || authenticated.request.kind !== "commit-authorization" ||
      !await implementationOutputCommittedAtCurrentTarget(
        authority.services.runner,
        implementation.value.source_artifact,
        authenticated.request.context.target_ref,
      )) {
    return invalidManual(authority.services.authority, "manual-commit-proof-required");
  }
  return ok(Object.freeze({
    completion_subject_digest: implementation.value.artifact_digest,
    authenticated_gate_approvals: Object.freeze([authenticated]),
    commit_observed: true as const,
  }));
}

/** Builds one immediate manual successor entirely from same-process authenticated capabilities. */
export async function buildNextManualCheckpoint(
  input: NextManualCheckpointInput,
): Promise<ProjectResult<ManualCheckpointV1>> {
  const authority = resolveManualAuthority(input.authority);
  const current = projectCurrentManualState(authority);
  if (current.terminal !== undefined) return invalidManual(authority.services.authority, "manual-terminal-already-set");
  const revision = parseSafeInteger(current.revision + 1);
  const resultFacts = input.results.map((result) => resolveInstalledManualResult(result, input.authority));
  const references = new Map(current.authoritative_results.map((reference) =>
    [`${reference.phase_instance}\0${reference.step}`, reference] as const));
  for (const facts of resultFacts) {
    references.set(`${facts.reference.phase_instance}\0${facts.reference.step}`, facts.reference);
  }
  const derivedProjections = deriveFinalManualProjections({
    references: [...references.values()], retained_manifests: authority.retained_manifests, installed_results: resultFacts,
  });
  if (derivedProjections.outcome !== "ok") {
    return invalidManual(authority.services.authority, derivedProjections.outcome === "missing-manifest"
      ? "manual-current-result-manifest-missing"
      : "manual-projection-path-conflict");
  }
  const projections = new Map<ManualCheckpointV1["projections"][number]["path"], ManualCheckpointV1["projections"][number]["content_digest"]>(derivedProjections.projections.map((projection) =>
    [projection.path, projection.content_digest] as const));

  let phaseInstance = current.phase_instance;
  let step = current.step;
  let status = current.status;
  let attempt = current.attempt;
  let inputFingerprint = current.input_fingerprint;
  let approvals = current.approvals;
  let waivers = current.waivers;
  let openGate = current.open_gate;
  let terminal: "complete" | "abandoned" | undefined;

  if (input.milestone.kind === "step") {
    if (current.open_gate !== undefined) return invalidManual(authority.services.authority, "manual-step-with-open-gate");
    phaseInstance = input.milestone.phase_instance;
    step = input.milestone.step;
    status = input.milestone.status;
    const sameSubject = phaseInstance === current.phase_instance && step === current.step;
    attempt = phaseInstance !== current.phase_instance
      ? parseSafeInteger(1)
      : sameSubject && current.status === "failed" && status === "running"
        ? parseSafeInteger(current.attempt + 1)
        : current.attempt;
    const installed = resultFacts.find((facts) =>
      facts.reference.phase_instance === phaseInstance && facts.reference.step === step);
    const reference = installed?.reference;
    if (reference !== undefined) inputFingerprint = reference.input_fingerprint;
    else if (status === "succeeded") return invalidManual(authority.services.authority, "manual-step-result-required");
    else if (phaseInstance !== current.phase_instance || step !== current.step ||
        (authority.state === undefined && authority.head === undefined)) {
      const derived = await deriveManualStepFingerprint(authority, current, phaseInstance, step, status);
      if (!derived.ok) return derived;
      inputFingerprint = derived.value;
    }
    const bootstrap = authority.state === undefined && authority.head === undefined;
    if (!bootstrap) {
      const sourceArtifact = installed?.manifest.value.source_artifact;
      const transitionArtifact =
        sourceArtifact?.artifact_kind === "adjudication-evidence" || sourceArtifact?.artifact_kind === "review-evidence"
          ? undefined
          : sourceArtifact;
      const requiresCommit = decodePhaseInstance(current.phase_instance).kind === "phase-impl" &&
        current.step === "triage" && current.status === "succeeded" &&
        phaseInstance !== current.phase_instance;
      if (requiresCommit && requiresManualFinalPhaseCompletion(current, phaseInstance)) {
        return invalidManual(authority.services.authority, "manual-final-phase-must-complete");
      }
      const commit = requiresCommit ? await loadManualCommitTransitionFacts(input, authority, current) : undefined;
      if (commit !== undefined && !commit.ok) return commit;
      const transition = planStateTransition({
        current,
        target: { phase_instance: phaseInstance, step, status, attempt, input_fingerprint: inputFingerprint },
        recomputed_input_fingerprint: inputFingerprint,
        ...(installed === undefined ? {} : { result_reference: installed.reference }),
        ...(transitionArtifact === undefined ? {} : { artifact: transitionArtifact }),
        ...(commit === undefined ? {} : commit.value),
      });
      if (!transition.ok) return transition;
    }
  } else if (input.milestone.kind === "gate-open") {
    const request = input.milestone.request;
    if (current.open_gate !== undefined || request.task_id !== current.task_id ||
        request.phase_instance !== current.phase_instance || request.opened_at_revision !== revision) {
      return invalidManual(authority.services.authority, "manual-gate-open-transition-invalid");
    }
    const frozen = openGateFrozenStateDigest({ ...current, revision, open_gate: undefined } as unknown as TaskStateV1);
    openGate = Object.freeze({
      gate_id: request.gate_id,
      gate_kind: request.kind,
      subject_digest: request.subject_digest,
      context_digest: request.context_digest,
      frozen_state_digest: frozen,
      ...(request.context !== null && typeof request.context === "object" && "origin" in request.context
        ? { waiver_origin_gate_id: (request.context as WaiverGateContext).origin.origin_gate_id }
        : {}),
      opened_at_revision: revision,
    });
  } else if (input.milestone.kind === "gate-resolved") {
    if (current.open_gate === undefined || input.gate_facts === undefined ||
        current.open_gate.gate_id !== input.milestone.decision.gate_id) {
      return invalidManual(authority.services.authority, "manual-gate-resolution-authority-missing");
    }
    const gates = resolveAuthenticatedManualGateFacts(input.gate_facts, input.authority as object);
    const decision = input.milestone.decision;
    const pair = gates.pairs.find((candidate) => candidate.decision.gate_id === decision.gate_id);
    if (pair === undefined || canonicalJsonDigest(pair.decision) !== canonicalJsonDigest(decision)) {
      return invalidManual(authority.services.authority, "manual-gate-resolution-mismatch");
    }
    const landed = gates.post_decision_state;
    if (landed === undefined || landed.revision !== revision || landed.task_id !== current.task_id ||
        landed.repository_identity_digest !== current.repository_identity_digest ||
        !isDeepStrictEqual(landed.authoritative_results, current.authoritative_results)) {
      return invalidManual(authority.services.authority, "manual-gate-post-decision-state-mismatch");
    }
    phaseInstance = landed.phase_instance;
    step = landed.step;
    status = landed.status;
    attempt = landed.attempt;
    inputFingerprint = landed.input_fingerprint;
    approvals = landed.approvals;
    waivers = landed.waivers;
    openGate = landed.open_gate;
    terminal = landed.terminal;
  } else {
    if (current.open_gate !== undefined) return invalidManual(authority.services.authority, "manual-terminal-with-open-gate");
    if (input.milestone.terminal === "abandoned") {
      return invalidManual(authority.services.authority, "manual-abandonment-authority-required");
    }
    if (input.milestone.terminal === "complete") {
      const commit = await loadManualCommitTransitionFacts(input, authority, current);
      if (!commit.ok) return invalidManual(authority.services.authority, "manual-terminal-proof-required");
      const transition = planStateTransition({
        current,
        target: {
          phase_instance: current.phase_instance, step: current.step, status: current.status,
          attempt: current.attempt, input_fingerprint: current.input_fingerprint,
        },
        recomputed_input_fingerprint: current.input_fingerprint,
        ...commit.value,
      });
      if (!transition.ok || transition.value.terminal !== "complete") {
        return invalidManual(authority.services.authority, "manual-terminal-proof-required");
      }
    }
    terminal = input.milestone.terminal;
  }

  const common = {
    schema_version: "1" as const,
    task_id: current.task_id,
    repository_identity_digest: current.repository_identity_digest,
    revision,
    phase_instance: phaseInstance,
    step,
    status,
    attempt,
    input_fingerprint: inputFingerprint,
    assurance: "degraded" as const,
    initialization_digest: authority.initialization_digest,
    authoritative_results: Object.freeze([...references.values()].sort((left, right) =>
      left.phase_instance.localeCompare(right.phase_instance) || left.step.localeCompare(right.step))),
    projections: Object.freeze([...projections].map(([path, content_digest]) => ({ path, content_digest }))
      .sort((left, right) => left.path.localeCompare(right.path))),
    evidence_chain: authority.head?.evidence_chain ?? [],
    approvals: Object.freeze([...approvals].sort((left, right) => left.gate_id.localeCompare(right.gate_id))),
    waivers: Object.freeze([...waivers].sort((left, right) => left.gate_id.localeCompare(right.gate_id))),
    ...(openGate === undefined ? {} : { open_gate: openGate }),
    ...(terminal === undefined ? {} : { terminal }),
  };
  const value = authority.kind === "continuation"
    ? { ...common, predecessor: authority.predecessor! }
    : authority.state !== undefined
      ? { ...common, state_anchor: {
          anchor_kind: "state" as const,
          state_revision: authority.state.value.revision,
          state_digest: authority.state.digest,
        } }
      : authority.initialization === undefined
        ? undefined
        : { ...common, revision: 1 as const, initialization: authority.initialization };
  if (value === undefined) return invalidManual(authority.services.authority, "manual-initialization-unavailable");
  try { return ok(parseManualCheckpoint(value)); }
  catch { return invalidManual(authority.services.authority, "manual-checkpoint-derived-invalid"); }
}

/** Installs a canonical checkpoint exactly once at its digest-addressed manual path. */
export async function writeManualCheckpoint(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  checkpoint: ManualCheckpointV1,
): Promise<ProjectResult<CanonicalDocument<ManualCheckpointV1>>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const parsed = parseManualCheckpoint(checkpoint);
  if (parsed.task_id !== authority.task_id ||
      parsed.repository_identity_digest !== authority.repository_identity_digest) {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("STATE_INVALID", {
        phase_instance: authority.context.phase_instance,
        issue_code: "manual-checkpoint-authority-mismatch",
      }),
    });
  }
  const digest = checkpointSelfDigest(parsed);
  const target = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: parseTaskPathClaim(`manual/checkpoints/${parsed.revision}-${digest}.json`),
    expectedClass: "manual-checkpoint",
    context: authority.context,
  });
  if (!target.ok) return target;
  const document = canonicalDocument(parsed);
  try {
    await ensureManualCheckpointDirectory(authority);
    const installed = await dependencies.atomic.createExclusive(target.value, document.bytes);
    if (installed === "exists") {
      const handle = await openResolved(target.value.absolute, fsConstants.O_RDONLY);
      try {
        const existing = new Uint8Array(await handle.readFile());
        if (!Buffer.from(existing).equals(Buffer.from(document.bytes))) {
          return Object.freeze({
            schema_version: "1",
            ok: false,
            error: createProjectError("STATE_INVALID", {
              phase_instance: authority.context.phase_instance,
              issue_code: "manual-checkpoint-address-disagreement",
            }),
          });
        }
      } finally {
        await handle.close();
      }
    }
    return ok(document);
  } catch {
    return ioFailure(authority, "write-manual-checkpoint");
  }
}

/** Reads every canonical checkpoint from the fixed manual directory, sorted by revision and digest. */
export async function readManualCheckpoints(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<CheckpointChainEvidence>> {
  assertInternalTransactionAuthority(authority, dependencies);
  let names: string[];
  try {
    names = await readdir(join(authority.task_root, "manual", "checkpoints"));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return ok(Object.freeze([]));
    return ioFailure(authority, "read-manual-checkpoints");
  }
  const documents: CanonicalDocument<ManualCheckpointV1>[] = [];
  for (const name of names.sort()) {
    if (!/^(?:0|[1-9][0-9]*)-[0-9a-f]{64}\.json$/u.test(name)) {
      return Object.freeze({
        schema_version: "1",
        ok: false,
        error: createProjectError("STATE_INVALID", {
          phase_instance: authority.context.phase_instance,
          issue_code: "manual-checkpoint-inventory-invalid",
        }),
      });
    }
    const target = await resolveTaskPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parseTaskPathClaim(`manual/checkpoints/${name}`),
      expectedClass: "manual-checkpoint",
      context: authority.context,
    });
    if (!target.ok) return target;
    try {
      const handle = await openResolved(target.value.absolute, fsConstants.O_RDONLY);
      try {
        const document = parseCanonicalDocument<ManualCheckpointV1>(
          new Uint8Array(await handle.readFile()),
          "manual checkpoint",
        );
        const checkpoint = parseManualCheckpoint(document.value);
        const expectedName = `${checkpoint.revision}-${checkpointSelfDigest(checkpoint)}.json`;
        if (name !== expectedName || checkpoint.task_id !== authority.task_id ||
            checkpoint.repository_identity_digest !== authority.repository_identity_digest) {
          throw new TypeError("manual checkpoint authority mismatch");
        }
        documents.push(document);
      } finally {
        await handle.close();
      }
    } catch {
      return Object.freeze({
        schema_version: "1",
        ok: false,
        error: createProjectError("STATE_INVALID", {
          phase_instance: authority.context.phase_instance,
          issue_code: "manual-checkpoint-invalid",
        }),
      });
    }
  }
  documents.sort((left, right) => left.value.revision - right.value.revision || left.digest.localeCompare(right.digest));
  return ok(Object.freeze(documents));
}
