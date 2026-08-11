import { constants as fsConstants } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { canonicalDocument, parseCanonicalDocument } from "../contracts/canonical.js";
import {
  chainAnchor,
  checkpointSelfDigest,
  selectGreatestValidChain,
  type ManualCheckpointImportV1,
  type ManualCheckpointV1,
} from "../contracts/durable-checkpoint.js";
import {
  parseGateDecisionRecord,
  parseGateRequest,
  type GateDecisionRecordV1,
  type GateRequestV1,
} from "../contracts/durable-gate.js";
import type { AuthoritativeResultRef, TaskStateV1 } from "../contracts/durable-state.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { gateDecisionEffect } from "../contracts/gates.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import { gateDecisionClaim, gateRequestClaim, openResolved, resolveTaskPath } from "../repository/paths.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { implementationOutputCommittedAtCurrentTarget } from "./implementation-manifest.js";
import type { NextStateDraft, RetainedResultInstallation, TransactionDependencies } from "./transaction.js";
import { planStateTransition } from "./transitions.js";
import {
  loadApprovedDesignFinalPhase,
  loadAuthenticatedManualGateFacts,
  resolveAuthenticatedManualGateFacts,
  type AuthenticatedGateApproval,
} from "./gates.js";

type ArchivedGatePair = Readonly<{
  request: GateRequestV1;
  decision: GateDecisionRecordV1;
  decision_digest: AuthoritativeResultRef["result_digest"];
}>;

type CheckpointEvidence = Readonly<{
  checkpoint_digest: AuthoritativeResultRef["result_digest"];
  retained: ReadonlyMap<AuthoritativeResultRef["result_digest"], RetainedResultInstallation>;
  gates: ReadonlyMap<string, ArchivedGatePair>;
  committed_implementations: readonly Readonly<{
    result_digest: AuthoritativeResultRef["result_digest"];
    phase_instance: TaskStateV1["phase_instance"];
    subject_digest: AuthoritativeResultRef["result_digest"];
    gate_id: string;
  }>[];
  planned_final_phase?: TaskStateV1["planned_final_phase"] | null;
  authenticated_commit_approvals: readonly AuthenticatedGateApproval[];
}>;

const evidenceFacts = new WeakMap<object, Readonly<{
  artifact_digest: AuthoritativeResultRef["result_digest"];
  checkpoints: ReadonlyMap<AuthoritativeResultRef["result_digest"], CheckpointEvidence>;
}>>();

declare const authenticatedManualImportEvidenceBrand: unique symbol;
export type AuthenticatedManualImportEvidence = Readonly<{
  readonly kind: "authenticated-manual-import-evidence";
  readonly [authenticatedManualImportEvidenceBrand]: true;
}>;

export type ManualImportEvidenceInput = Readonly<{
  dependencies: TransactionDependencies;
  authority: TransactionAuthority;
  artifact: ManualCheckpointImportV1;
}>;

export type AuthenticatedManualChainInput = Readonly<{
  artifact: ManualCheckpointImportV1;
  evidence: AuthenticatedManualImportEvidence;
  current?: TaskStateV1;
}>;

export type ManualChainReduction = Readonly<{
  next_state: NextStateDraft;
  head: ManualCheckpointV1;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

function invalid(phase: TaskStateV1["phase_instance"] | ManualCheckpointV1["phase_instance"], issue: string): ProjectResult<never> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", { phase_instance: phase, issue_code: issue }),
  });
}

function io(authority: TransactionAuthority, operation: string): ProjectResult<never> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }),
  });
}

async function readGateDocument<T extends PlainJsonValue>(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  gateId: Parameters<typeof gateRequestClaim>[0],
  kind: "request" | "decision",
  parse: (value: unknown) => T,
): Promise<ProjectResult<ReturnType<typeof canonicalDocument<T>>>> {
  const target = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: kind === "request" ? gateRequestClaim(gateId) : gateDecisionClaim(gateId),
    expectedClass: "decision",
    context: authority.context,
  });
  if (!target.ok) return target;
  try {
    const handle = await openResolved(target.value.absolute, fsConstants.O_RDONLY);
    try {
      const document = parseCanonicalDocument<PlainJsonValue>(new Uint8Array(await handle.readFile()), `manual gate ${kind}`);
      return ok(canonicalDocument(parse(document.value)));
    } finally {
      await handle.close();
    }
  } catch {
    return io(authority, `read-manual-gate-${kind}`);
  }
}

function exactResultBinding(
  checkpoint: ManualCheckpointV1,
  reference: AuthoritativeResultRef,
  retained: RetainedResultInstallation,
): boolean {
  const manifest = retained.prepared.manifest;
  return manifest.digest === reference.result_digest &&
    manifest.value.task_id === checkpoint.task_id &&
    manifest.value.repository_identity_digest === checkpoint.repository_identity_digest &&
    manifest.value.result_id === reference.result_id &&
    manifest.value.phase_instance === reference.phase_instance &&
    manifest.value.step === reference.step &&
    manifest.value.input_fingerprint === reference.input_fingerprint &&
    reference.manifest_path === retained.manifest_target.repositoryRelative;
}

function expectedProjections(retained: Iterable<RetainedResultInstallation>): ManualCheckpointV1["projections"] {
  const byPath = new Map<string, ManualCheckpointV1["projections"][number]>();
  for (const installation of retained) {
    for (const projection of installation.prepared.manifest.value.projections) {
      const previous = byPath.get(projection.path);
      if (previous !== undefined && previous.content_digest !== projection.content_digest) {
        throw new TypeError("reachable retained results disagree about a projection");
      }
      byPath.set(projection.path, projection);
    }
  }
  return Object.freeze([...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)));
}

/**
 * Resolves every authority pointer reachable from the supplied closed chain. The returned value is
 * an in-process capability; callers cannot substitute checkpoint JSON after the filesystem reads.
 */
export async function loadManualImportEvidence(
  input: ManualImportEvidenceInput,
): Promise<ProjectResult<AuthenticatedManualImportEvidence>> {
  if (!isDeepStrictEqual(Object.keys(input).sort(), ["artifact", "authority", "dependencies"])) {
    throw new TypeError("manual import evidence input has unexpected or missing fields");
  }
  const { dependencies, authority } = input;
  assertInternalTransactionAuthority(authority, { runner: dependencies.runner, environment: dependencies.environment });
  assertPlainJson(input.artifact, "manual checkpoint import");
  const artifact = structuredClone(input.artifact);
  if (artifact.task_id !== authority.task_id ||
      !verifyRepositoryIdentity(artifact.repository_identity_digest, authority.repository_identity).ok) {
    return invalid(authority.context.phase_instance, "manual-import-authority-mismatch");
  }
  const selected = selectGreatestValidChain(chainAnchor(artifact), artifact.chain);
  if (selected.kind !== "chain" || selected.chain.length !== artifact.chain.length ||
      !isDeepStrictEqual(selected.chain, artifact.chain)) {
    return invalid(authority.context.phase_instance, selected.kind === "stop"
      ? `manual-import-chain-${selected.outcome}`
      : "manual-import-chain-not-exact");
  }
  if (selected.chain.some((checkpoint) => checkpoint.terminal === "abandoned")) {
    return invalid(authority.context.phase_instance, "manual-import-abandoned-authority-unauthenticated");
  }
  if (dependencies.load_retained_result === undefined) {
    return invalid(authority.context.phase_instance, "manual-import-result-loader-unavailable");
  }

  const checkpoints = new Map<AuthoritativeResultRef["result_digest"], CheckpointEvidence>();
  const selectedHead = selected.chain.at(-1)!;
  let planningBase: TaskStateV1;
  const evidenceBinding = Object.freeze({});
  if (artifact.import_mode === "initial") {
    const first = selected.chain[0]!;
    if (!("initialization" in first)) return invalid(first.phase_instance, "manual-import-initialization-missing");
    planningBase = initialBase(first);
  } else {
    const observed = await dependencies.read_state(authority.state);
    if (observed.kind !== "canonical") return invalid(authority.context.phase_instance, "manual-import-current-state-unavailable");
    planningBase = observed.document.value;
  }
  for (const [checkpointIndex, checkpoint] of selected.chain.entries()) {
    const priorCheckpoint = checkpointIndex === 0 ? undefined : selected.chain[checkpointIndex - 1];
    const closedPriorGate = priorCheckpoint?.open_gate !== undefined && checkpoint.open_gate === undefined
      ? priorCheckpoint.open_gate
      : undefined;
    if (checkpoint === selectedHead && checkpoint.open_gate !== undefined) {
      return invalid(checkpoint.phase_instance, "manual-import-open-gate-must-close-cancel-or-supersede");
    }
    const retained = new Map<AuthoritativeResultRef["result_digest"], RetainedResultInstallation>();
    for (const reference of checkpoint.authoritative_results) {
      const loaded = await dependencies.load_retained_result(reference);
      if (!loaded.ok) return loaded;
      if (!exactResultBinding(checkpoint, reference, loaded.value)) {
        return invalid(checkpoint.phase_instance, "manual-import-result-binding-invalid");
      }
      retained.set(reference.result_digest, loaded.value);
    }
    let projections: ManualCheckpointV1["projections"];
    try {
      projections = expectedProjections(retained.values());
    } catch {
      return invalid(checkpoint.phase_instance, "manual-import-projection-disagreement");
    }
    if (!isDeepStrictEqual(projections, checkpoint.projections)) {
      return invalid(checkpoint.phase_instance, "manual-import-projection-binding-invalid");
    }
    for (const entry of checkpoint.evidence_chain) {
      const produce = [...retained.values()].find((installation) =>
        installation.prepared.manifest.value.phase_instance === entry.phase_instance &&
        installation.prepared.manifest.value.step === "produce" &&
        installation.prepared.manifest.value.artifact_digest === entry.subject_digest);
      if (produce === undefined) {
        return invalid(checkpoint.phase_instance, "manual-import-evidence-subject-missing");
      }
      for (const slot of entry.current_evidence.slots) {
        const evidenceResult = [...retained.values()].find((installation) => {
          const manifest = installation.prepared.manifest.value;
          const source = manifest.source_artifact;
          return manifest.phase_instance === entry.phase_instance &&
            manifest.artifact_digest === slot.evidence_digest &&
            (source.artifact_kind === "review-evidence" || source.artifact_kind === "triage" ||
              source.artifact_kind === "adjudication-evidence") &&
            source.evidence.subject_digest === entry.subject_digest &&
            source.evidence.input_fingerprint === entry.input_fingerprint;
        });
        if (evidenceResult === undefined) {
          return invalid(checkpoint.phase_instance, "manual-import-evidence-result-missing");
        }
      }
    }

    const gates = new Map<string, ArchivedGatePair>();
    const gateRefs = [
      ...checkpoint.approvals.map((reference) => ({ gate_id: reference.gate_id, reference } as const)),
      ...checkpoint.waivers.map((reference) => ({ gate_id: reference.gate_id, reference } as const)),
      ...(checkpoint.open_gate === undefined
        ? []
        : [{ gate_id: checkpoint.open_gate.gate_id, reference: undefined } as const]),
      ...(closedPriorGate === undefined
        ? []
        : [{ gate_id: closedPriorGate.gate_id, reference: undefined } as const]),
    ];
    for (const gateEntry of gateRefs) {
      const { gate_id: gateId, reference } = gateEntry;
      if (gates.has(gateId)) continue;
      const request = await readGateDocument(dependencies, authority, gateId, "request", parseGateRequest);
      if (!request.ok) return request;
      const decision = await readGateDocument(dependencies, authority, gateId, "decision", parseGateDecisionRecord);
      if (!decision.ok) return decision;
      const semantics = validateDurableSemantics({ gate_request: request.value, gate_decision: decision.value });
      if (!semantics.ok) return semantics;
      if (request.value.value.task_id !== checkpoint.task_id ||
          request.value.value.gate_id !== gateId ||
          decision.value.value.task_id !== checkpoint.task_id ||
          decision.value.value.gate_id !== gateId) {
        return invalid(checkpoint.phase_instance, "manual-import-gate-binding-invalid");
      }
      if (checkpoint.open_gate?.gate_id === gateId && (
        request.value.value.kind !== checkpoint.open_gate.gate_kind ||
        request.value.value.subject_digest !== checkpoint.open_gate.subject_digest ||
        request.value.value.context_digest !== checkpoint.open_gate.context_digest ||
        request.value.value.opened_at_revision !== checkpoint.open_gate.opened_at_revision
      )) {
        return invalid(checkpoint.phase_instance, "manual-import-open-gate-request-binding-invalid");
      }
      if (closedPriorGate?.gate_id === gateId && (
        request.value.value.kind !== closedPriorGate.gate_kind ||
        request.value.value.subject_digest !== closedPriorGate.subject_digest ||
        request.value.value.context_digest !== closedPriorGate.context_digest ||
        request.value.value.opened_at_revision !== closedPriorGate.opened_at_revision
      )) {
        return invalid(checkpoint.phase_instance, "manual-import-closed-gate-request-binding-invalid");
      }
      const expectedDigest = reference !== undefined && "decision_digest" in reference ? reference.decision_digest : undefined;
      if (expectedDigest !== undefined && decision.value.digest !== expectedDigest) {
        return invalid(checkpoint.phase_instance, "manual-import-gate-decision-digest-mismatch");
      }
      if (reference !== undefined && "decision_digest" in reference) {
        if (decision.value.value.outcome !== "decided" ||
            gateDecisionEffect(decision.value.value.envelope.payload) !== "advance" ||
            request.value.value.kind !== reference.gate_kind ||
            request.value.value.subject_digest !== reference.subject_digest) {
          return invalid(checkpoint.phase_instance, "manual-import-approval-binding-invalid");
        }
      } else if (reference !== undefined) {
        const record = decision.value.value;
        if (record.outcome !== "waiver-decided" ||
            record.granted !== reference.granted ||
            record.origin.rule.rule_id !== reference.rule_id ||
            record.origin.rule.rule_version !== reference.rule_version ||
            record.origin.subject_digest !== reference.subject_digest ||
            !isDeepStrictEqual(record.scope, reference.scope)) {
          return invalid(checkpoint.phase_instance, "manual-import-waiver-binding-invalid");
        }
      }
      gates.set(gateId, Object.freeze({
        request: request.value.value,
        decision: decision.value.value,
        decision_digest: decision.value.digest,
      }));
    }

    const committed: Array<CheckpointEvidence["committed_implementations"][number]> = [];
    for (const approval of checkpoint.approvals) {
      if (approval.gate_kind !== "commit-authorization") continue;
      const pair = gates.get(approval.gate_id);
      if (pair?.decision.outcome !== "decided" || gateDecisionEffect(pair.decision.envelope.payload) !== "advance" ||
          pair.request.kind !== "commit-authorization" || pair.request.subject_digest !== approval.subject_digest) {
        return invalid(checkpoint.phase_instance, "manual-import-commit-authorization-invalid");
      }
      const implementation = [...retained.entries()].find(([, installation]) =>
        installation.prepared.manifest.value.artifact_digest === approval.subject_digest &&
        installation.prepared.manifest.value.source_artifact.artifact_kind === "implementation-output");
      if (implementation === undefined) {
        return invalid(checkpoint.phase_instance, "manual-import-implementation-result-missing");
      }
      const source = implementation[1].prepared.manifest.value.source_artifact;
      if (source.artifact_kind !== "implementation-output" ||
          source.phase_instance !== pair.request.phase_instance ||
          source.phase_instance !== implementation[1].prepared.manifest.value.phase_instance ||
          !await implementationOutputCommittedAtCurrentTarget(dependencies.runner, source, pair.request.context.target_ref)) {
        return invalid(checkpoint.phase_instance, "manual-import-committed-tree-proof-missing");
      }
      committed.push(Object.freeze({
        result_digest: implementation[0],
        phase_instance: source.phase_instance,
        subject_digest: approval.subject_digest,
        gate_id: approval.gate_id,
      }));
    }
    const commitGateIds = checkpoint.approvals
      .filter((approval) => approval.gate_kind === "commit-authorization")
      .map((approval) => approval.gate_id);
    let authenticatedCommitApprovals: readonly AuthenticatedGateApproval[] = [];
    if (commitGateIds.length > 0) {
      const authenticated = await loadAuthenticatedManualGateFacts({
        dependencies,
        transaction_authority: authority,
        authority_binding: evidenceBinding,
        state: checkpointState(planningBase, checkpoint),
        gate_ids: commitGateIds,
      });
      if (!authenticated.ok) return authenticated;
      authenticatedCommitApprovals = resolveAuthenticatedManualGateFacts(
        authenticated.value,
        evidenceBinding,
      ).authenticated_gate_approvals.filter((candidate) => candidate.approval.gate_kind === "commit-authorization");
    }
    let plannedFinalPhase: TaskStateV1["planned_final_phase"] | null | undefined;
    const designApproval = checkpoint.approvals.find((approval) =>
      approval.gate_kind === "artifact-approval" && [...retained.values()].some((installation) =>
        installation.prepared.manifest.value.phase_instance === "design" &&
        installation.prepared.manifest.value.step === "produce" &&
        installation.prepared.manifest.value.artifact_digest === approval.subject_digest));
    if (designApproval !== undefined) {
      const pair = gates.get(designApproval.gate_id);
      if (pair === undefined) return invalid(checkpoint.phase_instance, "manual-approved-design-authority-missing");
      const planned = await loadApprovedDesignFinalPhase(
        dependencies,
        checkpointState(planningBase, checkpoint),
        pair.decision,
      );
      if (!planned.ok) return planned;
      plannedFinalPhase = planned.value === undefined || planned.value === null
        ? planned.value
        : planned.value as TaskStateV1["planned_final_phase"];
    }
    const digest = checkpointSelfDigest(checkpoint);
    checkpoints.set(digest, Object.freeze({
      checkpoint_digest: digest,
      retained,
      gates,
      committed_implementations: Object.freeze(committed),
      authenticated_commit_approvals: Object.freeze(authenticatedCommitApprovals),
      ...(plannedFinalPhase === undefined ? {} : { planned_final_phase: plannedFinalPhase }),
    }));
    planningBase = checkpointState(planningBase, checkpoint);
    if (plannedFinalPhase === null) {
      const { planned_final_phase: _planned, ...withoutPlanned } = planningBase;
      planningBase = withoutPlanned as TaskStateV1;
    } else if (plannedFinalPhase !== undefined) {
      planningBase = { ...planningBase, planned_final_phase: plannedFinalPhase };
    }
  }
  const capability = Object.freeze({ kind: "authenticated-manual-import-evidence" as const }) as AuthenticatedManualImportEvidence;
  evidenceFacts.set(capability, Object.freeze({ artifact_digest: canonicalDocument(artifact).digest, checkpoints }));
  return ok(capability);
}

function exactCommittedTransitionFacts(
  cursor: TaskStateV1,
  checkpoint: ManualCheckpointV1,
  evidence: CheckpointEvidence,
): Readonly<{
  completion_subject_digest: AuthoritativeResultRef["result_digest"];
  authenticated_gate_approvals: readonly AuthenticatedGateApproval[];
  commit_observed: true;
}> | undefined {
  const decoded = decodePhaseInstance(cursor.phase_instance);
  if (decoded.kind !== "phase-impl" || cursor.step !== "adjudicate" || cursor.status !== "succeeded") return undefined;
  const proof = evidence.committed_implementations.find((candidate) =>
    candidate.phase_instance === cursor.phase_instance &&
    cursor.authoritative_results.some((reference) =>
      reference.phase_instance === cursor.phase_instance &&
      reference.step === "produce" &&
      reference.result_digest === candidate.result_digest));
  if (proof === undefined) return undefined;
  const approval = checkpoint.approvals.find((candidate) =>
    candidate.gate_id === proof.gate_id &&
    candidate.gate_kind === "commit-authorization" &&
    candidate.subject_digest === proof.subject_digest);
  if (approval === undefined) return undefined;
  const authenticated = evidence.authenticated_commit_approvals.find((candidate) =>
    candidate.approval.gate_id === proof.gate_id &&
    candidate.approval.subject_digest === proof.subject_digest &&
    candidate.request.kind === "commit-authorization" &&
    candidate.request.phase_instance === cursor.phase_instance);
  if (authenticated === undefined) return undefined;
  let legal = false;
  if (checkpoint.terminal === "complete") {
    legal = cursor.planned_final_phase !== undefined &&
      Number(decoded.phase) === Number(cursor.planned_final_phase) &&
      checkpoint.phase_instance === cursor.phase_instance && checkpoint.step === cursor.step &&
      checkpoint.status === cursor.status && checkpoint.attempt === cursor.attempt &&
      checkpoint.input_fingerprint === cursor.input_fingerprint &&
      isDeepStrictEqual(checkpoint.authoritative_results, cursor.authoritative_results);
  } else {
    const target = decodePhaseInstance(checkpoint.phase_instance);
    legal = (cursor.planned_final_phase === undefined || Number(decoded.phase) < Number(cursor.planned_final_phase)) &&
      target.kind === "phase-design" && Number(target.phase) === Number(decoded.phase) + 1 &&
      checkpoint.step === "produce" && checkpoint.status === "running" && checkpoint.attempt === 1 &&
      isDeepStrictEqual(checkpoint.authoritative_results, cursor.authoritative_results);
  }
  return legal ? Object.freeze({
    completion_subject_digest: proof.subject_digest,
    authenticated_gate_approvals: Object.freeze([authenticated]),
    commit_observed: true as const,
  }) : undefined;
}

function checkpointState(base: TaskStateV1, checkpoint: ManualCheckpointV1): TaskStateV1 {
  return {
    ...base,
    phase_instance: checkpoint.phase_instance,
    step: checkpoint.step,
    status: checkpoint.status,
    attempt: checkpoint.attempt,
    input_fingerprint: checkpoint.input_fingerprint,
    authoritative_results: structuredClone(checkpoint.authoritative_results),
    approvals: structuredClone(checkpoint.approvals),
    waivers: structuredClone(checkpoint.waivers),
    ...(checkpoint.terminal === undefined ? {} : { terminal: checkpoint.terminal }),
  };
}

function preservesGateRefs(current: TaskStateV1, checkpoint: ManualCheckpointV1): boolean {
  return current.approvals.every((reference) =>
    checkpoint.approvals.some((candidate) => isDeepStrictEqual(candidate, reference))) &&
    current.waivers.every((reference) =>
      checkpoint.waivers.some((candidate) => isDeepStrictEqual(candidate, reference)));
}

function authenticatedClosedGate(
  prior: ManualCheckpointV1 | undefined,
  checkpoint: ManualCheckpointV1,
  evidence: CheckpointEvidence,
): ArchivedGatePair | undefined {
  const open = prior?.open_gate;
  if (open === undefined || checkpoint.open_gate !== undefined) return undefined;
  const pair = evidence.gates.get(open.gate_id);
  return pair !== undefined && pair.request.gate_id === open.gate_id &&
    pair.request.kind === open.gate_kind && pair.request.subject_digest === open.subject_digest &&
    pair.request.context_digest === open.context_digest && pair.request.opened_at_revision === open.opened_at_revision &&
    pair.decision.gate_id === open.gate_id
    ? pair
    : undefined;
}

function isAuthenticatedRetryLanding(
  cursor: TaskStateV1,
  checkpoint: ManualCheckpointV1,
  pair: ArchivedGatePair | undefined,
): boolean {
  if (pair?.decision.outcome !== "decided" || gateDecisionEffect(pair.decision.envelope.payload) !== "retry") return false;
  const decision = pair.decision.envelope.payload.decision;
  const reentry = (pair.request.kind === "review-trigger" && decision === "revise") ||
    (pair.request.kind === "adjudication-failure" && decision === "revise") ||
    (pair.request.kind === "material-drift" && decision === "revise-current") ||
    (pair.request.kind === "attempts-exhausted" && (decision === "retry-once" || decision === "revise"));
  return reentry && cursor.status === "succeeded" &&
    (cursor.step === "triage" || cursor.step === "adjudicate") &&
    checkpoint.phase_instance === cursor.phase_instance && checkpoint.step === "produce" &&
    checkpoint.status === "running" && checkpoint.attempt === cursor.attempt + 1 &&
    checkpoint.input_fingerprint !== cursor.input_fingerprint &&
    isDeepStrictEqual(checkpoint.authoritative_results, cursor.authoritative_results) &&
    isDeepStrictEqual(checkpoint.approvals, cursor.approvals) &&
    isDeepStrictEqual(checkpoint.waivers, cursor.waivers);
}

function initialBase(checkpoint: Extract<ManualCheckpointV1, { revision: 1 }>): TaskStateV1 {
  const initialization = checkpoint.initialization;
  return {
    schema_version: "1",
    task_id: initialization.task_id,
    repository_identity_digest: initialization.repository_identity_digest,
    revision: 1 as TaskStateV1["revision"],
    phase_instance: checkpoint.phase_instance,
    step: checkpoint.step,
    status: checkpoint.status,
    attempt: checkpoint.attempt,
    input_fingerprint: checkpoint.input_fingerprint,
    initialization_digest: checkpoint.initialization_digest,
    config_digest: initialization.config_digest,
    workflow_digest: initialization.workflow_digest,
    constitution_digest: initialization.constitution_digest,
    policy_base_commit: initialization.policy_base_commit,
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
}

/** Reduces a closed checkpoint chain using only loader-authenticated archive and Git facts. */
export function reduceAuthenticatedManualChain(
  input: AuthenticatedManualChainInput,
): ProjectResult<ManualChainReduction> {
  const facts = evidenceFacts.get(input.evidence);
  if (facts === undefined) throw new TypeError("authenticated manual import evidence is required");
  assertPlainJson(input.artifact, "manual checkpoint import reduction artifact");
  const artifact = structuredClone(input.artifact);
  if (facts.artifact_digest !== canonicalDocument(artifact).digest) {
    throw new TypeError("manual import evidence belongs to another artifact");
  }
  const selected = selectGreatestValidChain(chainAnchor(artifact), artifact.chain);
  if (selected.kind !== "chain" || selected.chain.length !== artifact.chain.length || selected.chain.length === 0) {
    return invalid(input.current?.phase_instance ?? artifact.chain[0]!.phase_instance, "manual-import-chain-not-exact");
  }
  if (selected.chain.some((checkpoint) => checkpoint.terminal === "abandoned")) {
    return invalid(input.current?.phase_instance ?? selected.chain[0]!.phase_instance,
      "manual-import-abandoned-authority-unauthenticated");
  }
  const first = selected.chain[0]!;
  let cursor: TaskStateV1;
  if (artifact.import_mode === "initial") {
    if (!("initialization" in first)) return invalid(first.phase_instance, "manual-import-initialization-missing");
    cursor = initialBase(first);
  } else {
    if (input.current === undefined) return invalid(first.phase_instance, "manual-import-current-state-required");
    cursor = structuredClone(input.current);
  }

  for (let index = 0; index < selected.chain.length; index += 1) {
    const checkpoint = selected.chain[index]!;
    const priorCheckpoint = index === 0 ? undefined : selected.chain[index - 1];
    const evidence = facts.checkpoints.get(checkpointSelfDigest(checkpoint));
    if (evidence === undefined) throw new TypeError("manual import evidence is incomplete");
    if (evidence.planned_final_phase === null) {
      const { planned_final_phase: _planned, ...withoutPlanned } = cursor;
      cursor = withoutPlanned as TaskStateV1;
    } else if (evidence.planned_final_phase !== undefined) {
      cursor = { ...cursor, planned_final_phase: evidence.planned_final_phase };
    }
    if (checkpoint.open_gate !== undefined) continue;
    const closedGate = authenticatedClosedGate(priorCheckpoint, checkpoint, evidence);

    const samePosition = cursor.phase_instance === checkpoint.phase_instance &&
      cursor.step === checkpoint.step && cursor.status === checkpoint.status &&
      cursor.attempt === checkpoint.attempt && cursor.input_fingerprint === checkpoint.input_fingerprint;
    const terminalAdded = cursor.terminal === undefined && checkpoint.terminal !== undefined;
    const commitFacts = exactCommittedTransitionFacts(cursor, checkpoint, evidence);
    if (!preservesGateRefs(cursor, checkpoint)) {
      return invalid(checkpoint.phase_instance, "manual-import-gate-authority-removed");
    }
    if (!samePosition) {
      const resultReference = checkpoint.status === "succeeded"
        ? checkpoint.authoritative_results.find((reference) =>
            reference.phase_instance === checkpoint.phase_instance && reference.step === checkpoint.step &&
            reference.input_fingerprint === checkpoint.input_fingerprint)
        : undefined;
      const retainedArtifact = resultReference === undefined
        ? undefined
        : evidence.retained.get(resultReference.result_digest)?.prepared.manifest.value.source_artifact;
      if (resultReference !== undefined && retainedArtifact === undefined) {
        return invalid(checkpoint.phase_instance, "manual-import-result-evidence-missing");
      }
      const transitionArtifact =
        retainedArtifact?.artifact_kind === "adjudication-evidence" || retainedArtifact?.artifact_kind === "review-evidence"
          ? undefined
          : retainedArtifact;
      const transition = planStateTransition({
        current: cursor,
        target: {
          phase_instance: checkpoint.phase_instance,
          step: checkpoint.step,
          status: checkpoint.status,
          attempt: checkpoint.attempt,
          input_fingerprint: checkpoint.input_fingerprint,
        },
        recomputed_input_fingerprint: checkpoint.input_fingerprint,
        ...(commitFacts === undefined ? {
          ...(transitionArtifact === undefined ? {} : { artifact: transitionArtifact }),
          ...(resultReference === undefined ? {} : { result_reference: resultReference }),
        } : commitFacts),
      });
      if (!transition.ok) {
        if (!isAuthenticatedRetryLanding(cursor, checkpoint, closedGate)) return transition;
      } else if (!isDeepStrictEqual(transition.value.authoritative_results, checkpoint.authoritative_results)) {
        return invalid(checkpoint.phase_instance, "manual-import-result-transition-mismatch");
      }
    } else if (!terminalAdded && isDeepStrictEqual(cursor.approvals, checkpoint.approvals) &&
        isDeepStrictEqual(cursor.waivers, checkpoint.waivers) &&
        isDeepStrictEqual(cursor.authoritative_results, checkpoint.authoritative_results)) {
      // The initial checkpoint is a legitimate seed; later exact duplicates are not milestones.
      const authenticatedNonStateClosure = closedGate !== undefined && (
        closedGate.decision.outcome === "cancelled" ||
        closedGate.decision.outcome === "superseded" ||
        (closedGate.decision.outcome === "decided" &&
          gateDecisionEffect(closedGate.decision.envelope.payload) !== "advance")
      );
      if (!(artifact.import_mode === "initial" && index === 0) && !authenticatedNonStateClosure) {
        return invalid(checkpoint.phase_instance, "manual-import-checkpoint-no-effect");
      }
    }
    if (terminalAdded) {
      if (checkpoint.terminal !== "complete") {
        return invalid(checkpoint.phase_instance, "manual-import-terminal-authority-invalid");
      }
      if (commitFacts === undefined) return invalid(checkpoint.phase_instance, "manual-import-terminal-commit-proof-missing");
      const terminal = planStateTransition({
        current: cursor,
        target: {
          phase_instance: checkpoint.phase_instance, step: checkpoint.step, status: checkpoint.status,
          attempt: checkpoint.attempt, input_fingerprint: checkpoint.input_fingerprint,
        },
        recomputed_input_fingerprint: checkpoint.input_fingerprint,
        ...commitFacts,
      });
      if (!terminal.ok || terminal.value.terminal !== "complete") {
        return invalid(checkpoint.phase_instance, "manual-import-terminal-commit-proof-missing");
      }
    }
    cursor = checkpointState(cursor, checkpoint);
  }

  const head = selected.chain.at(-1)!;
  const { revision: _revision, committed_intent: _intent, open_gate: _gate, ...draft } = cursor;
  const next: NextStateDraft = {
    ...draft,
    adopted_checkpoint: {
      revision: head.revision as TaskStateV1["revision"],
      checkpoint_digest: checkpointSelfDigest(head),
    },
  };
  return ok(Object.freeze({ next_state: Object.freeze(next), head }));
}
