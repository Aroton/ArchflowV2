import { canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import { isDeepStrictEqual } from "node:util";
import {
  checkpointSelfDigest,
  selectGreatestValidChain,
  type ChainAnchor,
  type ManualCheckpointImportV1,
  type ManualCheckpointV1,
  type PredecessorLink,
} from "../contracts/durable-checkpoint.js";
import type { LegacyImportInitializationV1 } from "../contracts/durable-legacy-import.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type { GateRequestV1 } from "../contracts/durable-gate.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { parseLegacyImportInitialization } from "../contracts/durable-legacy-import.js";
import { parseTaskInitialization, type TaskInitializationV1 } from "../contracts/durable-task-initialization.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import type { SafeInteger, Sha256Digest } from "../contracts/evidence.js";
import { parseSafeInteger } from "../contracts/evidence.js";
import { parseSafeId, parseSha256Digest, type SafeId } from "../contracts/evidence.js";
import { parsePathSafeId, type PathSafeId } from "../contracts/evidence.js";
import { decodePhaseInstance, parsePhaseInstanceId, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { PIPELINE_STEPS, type PipelineStep } from "../contracts/vocabulary.js";
import { WORKFLOW_V1 } from "../contracts/workflow.js";
import type { DocumentArtifactV1 } from "../contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../contracts/durable-implementation-output.js";
import { deriveCurrentEvidenceSet, type EvidenceResultValue, type RetainedEvidenceSet } from "../state/evidence-results.js";
import {
  buildNextManualCheckpoint,
  materializeManualAuthorityState,
  readManualCheckpoints,
  writeManualCheckpoint,
  type ManualMilestone,
} from "../state/manual-checkpoints.js";
import {
  createRetainedTaskAccounting,
  installManualRetainedResult,
  remintManualRetainedResult,
  type ProductionServices,
} from "../state/production.js";
import { computeTaskStatus, type TaskStatusV1 } from "../state/status.js";
import { createSecretlintScanner } from "../state/secret-scan.js";
import { prepareRetainedStateResult } from "../mcp/handlers/state-results.js";
import { computeCallEnvelope, type CallEnvelope } from "./envelope.js";
import { parseToolCall, type StateInput } from "../contracts/mcp-tools.js";
import { loadManualImportEvidence } from "../state/manual-import.js";
import { identifyStateInitialization } from "../state/initialization.js";
import { parseRepositoryPathClaim } from "../contracts/path-claims.js";
import type { SelectedManualHandoffAuthority } from "../repository/handoff.js";
import { inspectManualHandoff, type ManualHandoffResult } from "../repository/handoff.js";
import { parseGitOid, type GitOid } from "../contracts/canonical.js";
import {
  advanceManualGate,
  loadApprovedDesignFinalPhase,
  loadAuthenticatedManualGateFacts,
  plannedFinalPhaseFromDesign,
  resolveAuthenticatedManualGateFacts,
  type ManualGateLifecycleAction,
  type ManualGateLifecycleResult,
} from "../state/gates.js";
import { GATE_KINDS, parseGateContext } from "../contracts/gates.js";
import { parseSupplementalReviewOutcome } from "../contracts/supplemental.js";

type Initialization = TaskInitializationV1 | LegacyImportInitializationV1;

declare const manualAuthorityBrand: unique symbol;
/** Same-process authority. Its authenticated facts are deliberately not enumerable or serializable. */
export type ManualAuthority = Readonly<{ readonly [manualAuthorityBrand]: true }>;

export type ManualAuthorityKind = "initial" | "state-anchored" | "continuation";

export type ManualAuthorityFacts = Readonly<{
  services: ProductionServices;
  kind: ManualAuthorityKind;
  initialization?: Initialization;
  initialization_digest: Sha256Digest;
  state?: CanonicalDocument<TaskStateV1>;
  chain: readonly CanonicalDocument<ManualCheckpointV1>[];
  head?: ManualCheckpointV1;
  predecessor?: PredecessorLink;
  retained_manifests: readonly CanonicalDocument<ResultManifestV1>[];
  retained_task_bytes: SafeInteger;
  planned_final_phase?: SafeInteger;
}>;

const manualAuthorities = new WeakMap<object, ManualAuthorityFacts>();

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

function invalid(services: ProductionServices, issue: string): ProjectResult<never> {
  return fail(createProjectError("STATE_INVALID", {
    phase_instance: services.authority.context.phase_instance,
    issue_code: issue,
  }));
}

function parseInitialization(value: Initialization): Initialization {
  return value.artifact_kind === "task-initialization"
    ? parseTaskInitialization(value)
    : parseLegacyImportInitialization(value);
}

function initializationFromInventory(checkpoints: readonly ManualCheckpointV1[]): Initialization | undefined {
  const first = checkpoints.find((checkpoint) => checkpoint.revision === 1);
  if (first !== undefined && "initialization" in first) return first.initialization;
  // State deliberately retains only the initialization digest. A continuation from an adopted
  // checkpoint can recover the embedded initialization from the retained checkpoint inventory.
  return undefined;
}

export type LoadManualAuthorityInput = Readonly<{
  services: ProductionServices;
  initialization?: Initialization;
  /** Idempotent preparation excludes only this exact generation from retained-byte accounting. */
  exclude_result_digest?: Sha256Digest;
}>;

/** Resolves the only usable state/checkpoint head and authenticates every retained result it names. */
export async function loadManualAuthority(input: LoadManualAuthorityInput): Promise<ProjectResult<ManualAuthority>> {
  const inventory = await readManualCheckpoints(input.services.dependencies, input.services.authority);
  if (!inventory.ok) return inventory;
  const candidates = inventory.value.map((document) => document.value);
  const state = input.services.state;
  let initialization: Initialization | undefined;
  try {
    initialization = input.initialization === undefined
      ? initializationFromInventory(candidates)
      : parseInitialization(structuredClone(input.initialization));
  } catch {
    return invalid(input.services, "manual-initialization-invalid");
  }

  let anchor: ChainAnchor;
  let kind: ManualAuthorityKind;
  if (state !== undefined) {
    if (state.value.adopted_checkpoint !== undefined) {
      anchor = Object.freeze({
        mode: "continuation",
        task_id: state.value.task_id,
        repository_identity_digest: state.value.repository_identity_digest,
        predecessor: state.value.adopted_checkpoint,
      });
      kind = "continuation";
    } else {
      anchor = Object.freeze({
        mode: "state",
        task_id: state.value.task_id,
        repository_identity_digest: state.value.repository_identity_digest,
        state_anchor: Object.freeze({
          anchor_kind: "state",
          state_revision: state.value.revision,
          state_digest: state.digest,
        }),
      });
      kind = "state-anchored";
    }
  } else {
    const identity = initialization ?? (() => {
      const first = candidates.find((checkpoint) => checkpoint.revision === 1);
      return first !== undefined && "initialization" in first ? first.initialization : undefined;
    })();
    if (identity === undefined) return invalid(input.services, "manual-initialization-missing");
    initialization = parseInitialization(identity);
    anchor = Object.freeze({
      mode: "initial",
      task_id: initialization.task_id,
      repository_identity_digest: initialization.repository_identity_digest,
    });
    kind = "initial";
  }

  if (anchor.task_id !== input.services.authority.task_id ||
      anchor.repository_identity_digest !== input.services.authority.repository_identity_digest) {
    return invalid(input.services, "manual-authority-foreign");
  }
  const selected = selectGreatestValidChain(anchor, candidates);
  if (selected.kind === "stop") return invalid(input.services, `manual-checkpoint-${selected.outcome}`);
  const selectedDocuments = selected.chain.map((checkpoint) => {
    const digest = checkpointSelfDigest(checkpoint);
    const document = inventory.value.find((candidate) => candidate.digest === digest);
    if (document === undefined) throw new TypeError("selected checkpoint was not read from inventory");
    return document;
  });
  const head = selected.chain.at(-1);
  if (selected.chain.some((checkpoint) => checkpoint.terminal === "abandoned")) {
    return invalid(input.services, "manual-abandoned-authority-unauthenticated");
  }
  if (initialization === undefined) {
    const embedded = selected.chain.find((checkpoint) => "initialization" in checkpoint);
    if (embedded !== undefined && "initialization" in embedded) initialization = embedded.initialization;
  }
  if (state === undefined && initialization === undefined) return invalid(input.services, "manual-initialization-unavailable");
  const initializationDigest = state?.value.initialization_digest ?? canonicalJsonDigest(initialization!);
  if ((initialization !== undefined && canonicalJsonDigest(initialization) !== initializationDigest) ||
      selected.chain.some((checkpoint) => checkpoint.initialization_digest !== initializationDigest)) {
    return invalid(input.services, "manual-initialization-digest-mismatch");
  }

  const references = head?.authoritative_results ?? state?.value.authoritative_results ?? [];
  const manifests: CanonicalDocument<ResultManifestV1>[] = [];
  const seen = new Map<Sha256Digest, string>();
  let retainedBytes = 0;
  for (const reference of references) {
    const identity = `${reference.phase_instance}\0${reference.step}\0${reference.result_id}\0${reference.input_fingerprint}\0${reference.manifest_path}`;
    const prior = seen.get(reference.result_digest);
    if (prior !== undefined && prior !== identity) return invalid(input.services, "manual-retained-result-disagrees");
    if (prior !== undefined) continue;
    seen.set(reference.result_digest, identity);
    const loaded = await input.services.dependencies.load_retained_result?.(reference);
    if (loaded === undefined || !loaded.ok) return invalid(input.services, "manual-retained-result-unreadable");
    const manifest = loaded.value.prepared.manifest;
    if (manifest.digest !== reference.result_digest) return invalid(input.services, "manual-retained-result-disagrees");
    manifests.push(manifest);
    if (reference.result_digest !== input.exclude_result_digest) retainedBytes += manifest.value.accounting.result_bytes;
  }

  let parsedRetained: SafeInteger;
  try { parsedRetained = parseSafeInteger(retainedBytes); }
  catch { return invalid(input.services, "manual-retained-accounting-invalid"); }
  const resolvedKind: ManualAuthorityKind = head === undefined ? kind : "continuation";
  const capability = Object.freeze({}) as ManualAuthority;
  const baseFacts = {
    services: input.services,
    kind: resolvedKind,
    ...(initialization === undefined ? {} : { initialization }),
    initialization_digest: initializationDigest,
    ...(state === undefined ? {} : { state }),
    chain: Object.freeze(selectedDocuments),
    ...(head === undefined ? {} : { head }),
    ...((head !== undefined || (kind === "continuation" && state?.value.adopted_checkpoint !== undefined)) ? {
      predecessor: head !== undefined
        ? Object.freeze({ revision: parseSafeInteger(head.revision), checkpoint_digest: checkpointSelfDigest(head) })
        : state!.value.adopted_checkpoint!,
    } : {}),
    retained_manifests: Object.freeze(manifests),
    retained_task_bytes: parsedRetained,
  } satisfies Omit<ManualAuthorityFacts, "planned_final_phase">;
  let chainPlannedFinalPhase: SafeInteger | null | undefined;
  let designApprovalGateIds: readonly PathSafeId[] = [];
  let design: CanonicalDocument<ResultManifestV1> | undefined;
  if (head !== undefined) {
    design = manifests.find((manifest) =>
      manifest.value.phase_instance === "design" && manifest.value.step === "produce" &&
      manifest.value.source_artifact.artifact_kind === "document");
    designApprovalGateIds = head.approvals.filter((approval) =>
      approval.gate_kind === "artifact-approval" && approval.subject_digest === design?.value.artifact_digest)
      .map((approval) => approval.gate_id);
    if (design !== undefined && designApprovalGateIds.length > 0 &&
        design.value.source_artifact.artifact_kind === "document") {
      const designArtifact = design.value.source_artifact;
      const reference = references.find((candidate) => candidate.result_digest === design!.digest);
      const retained = reference === undefined
        ? undefined
        : await input.services.dependencies.load_retained_result?.(reference);
      if (retained === undefined || !retained.ok) return invalid(input.services, "manual-approved-design-authority-missing");
      const payload = retained.value.prepared.payloads.find((candidate) =>
        candidate.path === designArtifact.projection_target);
      if (payload === undefined) return invalid(input.services, "manual-approved-design-authority-missing");
      try {
        const planned = plannedFinalPhaseFromDesign(payload.bytes);
        chainPlannedFinalPhase = planned === null ? null : parseSafeInteger(planned);
      } catch {
        return invalid(input.services, "manual-approved-design-phase-count-invalid");
      }
    }
  }
  const statePlannedFinalPhase = state?.value.planned_final_phase;
  if (chainPlannedFinalPhase !== undefined && statePlannedFinalPhase !== undefined &&
      (chainPlannedFinalPhase === null || chainPlannedFinalPhase !== statePlannedFinalPhase)) {
    return invalid(input.services, "manual-planned-final-phase-disagrees");
  }
  const resolvedPlannedFinalPhase = chainPlannedFinalPhase === undefined
    ? statePlannedFinalPhase
    : chainPlannedFinalPhase === null ? undefined : chainPlannedFinalPhase;
  const authorityFacts: ManualAuthorityFacts = Object.freeze({
    ...baseFacts,
    ...(resolvedPlannedFinalPhase === undefined ? {} : { planned_final_phase: resolvedPlannedFinalPhase }),
  });
  manualAuthorities.set(capability, authorityFacts);
  if (chainPlannedFinalPhase !== undefined && head !== undefined && design !== undefined) {
      const current = materializeManualAuthorityState(capability);
      const loaded = await loadAuthenticatedManualGateFacts({
        dependencies: input.services.dependencies,
        transaction_authority: input.services.authority,
        authority_binding: capability as object,
        state: current,
        gate_ids: designApprovalGateIds,
      });
      if (!loaded.ok) return loaded;
      const gates = resolveAuthenticatedManualGateFacts(loaded.value, capability as object);
      const pair = gates.pairs.find((candidate) =>
        candidate.request.kind === "artifact-approval" && candidate.request.phase_instance === "design" &&
        candidate.request.subject_digest === design?.value.artifact_digest &&
        candidate.decision.outcome === "decided" && candidate.decision.envelope.payload.decision === "approve");
      if (pair === undefined) return invalid(input.services, "manual-approved-design-authority-missing");
      const planned = await loadApprovedDesignFinalPhase(input.services.dependencies, current, pair.decision);
      if (!planned.ok) return planned;
      const authenticatedPlanned = planned.value === undefined || planned.value === null
        ? planned.value
        : parseSafeInteger(planned.value);
      if (authenticatedPlanned !== chainPlannedFinalPhase) {
        return invalid(input.services, "manual-approved-design-phase-count-mismatch");
      }
  }
  return ok(capability);
}

/** Internal capability resolver. Unknown objects are never interpreted structurally. */
export function resolveManualAuthority(authority: ManualAuthority): ManualAuthorityFacts {
  const facts = manualAuthorities.get(authority as object);
  if (facts === undefined) throw new TypeError("manual authority capability is invalid or expired");
  return facts;
}

/** Adapter for the repository handoff verifier; the capability itself remains the only input. */
export function resolveManualHandoffAuthority(authority: object): SelectedManualHandoffAuthority {
  const facts = resolveManualAuthority(authority as ManualAuthority);
  const head = facts.chain.at(-1);
  if (head !== undefined) return Object.freeze({
    kind: "manual",
    path: parseRepositoryPathClaim(`.archflow/tasks/${facts.services.authority.task_id}/manual/checkpoints/${head.value.revision}-${head.digest}.json`),
    document: head,
  });
  if (facts.state === undefined) throw new TypeError("initial manual authority has no installed handoff document");
  return Object.freeze({
    kind: "normal",
    path: parseRepositoryPathClaim(`.archflow/tasks/${facts.services.authority.task_id}/state.json`),
    document: facts.state,
  });
}

export type BuildCheckpointImportStateCallInput = Readonly<{
  authority: ManualAuthority;
  intent_id: PathSafeId;
}>;
export type CheckpointImportStateCall = Readonly<{
  input: StateInput;
  envelope: CallEnvelope;
}>;

/** Builds the exact recovery call from the authenticated selected chain and current state anchor. */
export async function buildCheckpointImportStateCall(
  input: BuildCheckpointImportStateCallInput,
): Promise<ProjectResult<CheckpointImportStateCall>> {
  const facts = resolveManualAuthority(input.authority);
  const chain = facts.chain.map((document) => document.value);
  const first = chain[0];
  const head = chain.at(-1);
  if (first === undefined || head === undefined) return invalid(facts.services, "manual-import-chain-empty");
  let artifact: ManualCheckpointImportV1;
  if ("initialization" in first) {
    if (facts.state !== undefined) return invalid(facts.services, "manual-import-initial-with-state");
    artifact = {
      schema_version: "1", artifact_kind: "manual-checkpoint-import",
      task_id: facts.services.authority.task_id,
      repository_identity_digest: facts.services.authority.repository_identity_digest,
      import_mode: "initial", chain,
    };
  } else if ("state_anchor" in first) {
    if (facts.state === undefined) return invalid(facts.services, "manual-import-state-anchor-missing");
    artifact = {
      schema_version: "1", artifact_kind: "manual-checkpoint-import",
      task_id: facts.services.authority.task_id,
      repository_identity_digest: facts.services.authority.repository_identity_digest,
      import_mode: "state-anchored", chain, state_anchor: first.state_anchor,
    };
  } else {
    if (facts.state === undefined) return invalid(facts.services, "manual-import-continuation-state-missing");
    artifact = {
      schema_version: "1", artifact_kind: "manual-checkpoint-import",
      task_id: facts.services.authority.task_id,
      repository_identity_digest: facts.services.authority.repository_identity_digest,
      import_mode: "continuation", chain, predecessor: first.predecessor,
      expected_state_revision: facts.state.value.revision,
      expected_state_digest: facts.state.digest,
    };
  }
  const callInput: StateInput = {
    schema_version: "1",
    task_id: facts.services.authority.task_id,
    intent_id: parsePathSafeId(input.intent_id),
    expected_revision: facts.state?.value.revision ?? 0,
    input_fingerprint: head.input_fingerprint,
    phase_instance: head.phase_instance,
    step: head.step,
    status: head.status,
    artifact,
  };
  let parsedCall;
  try { parsedCall = parseToolCall("archflow_state", callInput); }
  catch { return invalid(facts.services, "manual-import-state-call-invalid"); }
  if (facts.state === undefined) {
    const evidence = await loadManualImportEvidence({
      dependencies: facts.services.dependencies,
      authority: facts.services.authority,
      artifact,
    });
    if (!evidence.ok) return evidence;
    const identified = await identifyStateInitialization(
      facts.services.dependencies,
      { authority: facts.services.authority, call: parsedCall },
      evidence.value,
    );
    if (!identified.ok) return identified;
    if (identified.value.input_fingerprint !== head.input_fingerprint) {
      return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", {
        expected_digest: identified.value.input_fingerprint,
        observed_digest: head.input_fingerprint,
      }));
    }
    return ok(Object.freeze({
      input: Object.freeze(callInput),
      envelope: Object.freeze({
        tool: "archflow_state" as const,
        input_fingerprint: identified.value.input_fingerprint,
        request_digest: identified.value.request_digest,
        // The verified head fingerprint is already embedded, so the call input is its own
        // resolved request.
        request: Object.freeze({
          tool: "archflow_state" as const,
          input: callInput as unknown as PlainJsonValue,
        }),
        artifact_digest: canonicalJsonDigest(artifact),
      }),
    }));
  }
  const envelope = await computeCallEnvelope(facts.services, {
    tool: "archflow_state", input: callInput,
  });
  if (!envelope.ok) return envelope;
  if (envelope.value.input_fingerprint !== head.input_fingerprint) {
    return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", {
      expected_digest: envelope.value.input_fingerprint,
      observed_digest: head.input_fingerprint,
    }));
  }
  return ok(Object.freeze({ input: Object.freeze(callInput), envelope: envelope.value }));
}

export type ManualWorkflowNextAction = Readonly<{
  code: string;
  detail: string;
  human_required: boolean;
  command: string;
  input?: PlainJsonValue;
}>;

export type ManualWorkflowStatus = Readonly<{
  mode: "normal" | "degraded" | "repair-required";
  authority_kind?: ManualAuthorityKind;
  revision?: SafeInteger;
  phase_instance?: string;
  step?: string;
  status?: string;
  task_status?: TaskStatusV1;
  next_action: ManualWorkflowNextAction;
}>;

export type ManualWorkflowStatusInput = LoadManualAuthorityInput;

function action(code: string, detail: string, human: boolean, command: string, input?: PlainJsonValue): ManualWorkflowNextAction {
  return Object.freeze({ code, detail, human_required: human, command, ...(input === undefined ? {} : { input }) });
}

/** Classifies authority conservatively and always emits exactly one executable next action. */
export async function classifyManualWorkflowStatus(input: ManualWorkflowStatusInput): Promise<ProjectResult<ManualWorkflowStatus>> {
  if (input.services.state === undefined && input.initialization === undefined) {
    const inventory = await readManualCheckpoints(input.services.dependencies, input.services.authority);
    if (inventory.ok && inventory.value.length === 0) return ok(Object.freeze({
      mode: "degraded",
      next_action: action(
        "create-task",
        "Create the canonical initialization artifact, then pass it unchanged to manual-next to install the initial checkpoint.",
        false,
        `archflow-local task-init --task ${input.services.authority.task_id}`,
        Object.freeze({ schema_version: "1", resume_command: "archflow-local manual-next", operation: "bootstrap" }),
      ),
    }));
  }
  const loaded = await loadManualAuthority(input);
  if (!loaded.ok) return ok(Object.freeze({
    mode: "repair-required",
    next_action: action(
      "repair-manual-authority",
      `Repair unreadable, ambiguous, or discontinuous authority (${loaded.error.code}).`,
      true,
      "archflow-local manual-status",
    ),
  }));
  const facts = resolveManualAuthority(loaded.value);
  const current = facts.head ?? facts.state?.value;
  const mode = facts.head === undefined && facts.state !== undefined ? "normal" : "degraded";
  let next: ManualWorkflowNextAction;
  let taskStatus: TaskStatusV1 | undefined;
  if (mode === "normal") {
    const normal = await computeTaskStatus(facts.services.dependencies, facts.services.authority);
    if (!normal.ok) return normal;
    taskStatus = normal.value;
    const derived = normal.value.next_action;
    next = action(
      derived.code,
      derived.detail,
      derived.human_required,
      derived.skill === undefined ? "archflow-status" : `$${derived.skill}`,
      structuredClone(derived) as PlainJsonValue,
    );
  } else if (current?.terminal !== undefined) {
    next = action("task-complete", `Task is terminal: ${current.terminal}.`, false, "archflow-local manual-status");
  } else if (current?.open_gate !== undefined) {
    next = action("resolve-open-gate", "Resolve or cancel the authenticated open gate before advancing.", true, "archflow-local manual-next", {
      schema_version: "1", operation: "gate", action: { kind: "reload", gate_id: current.open_gate.gate_id },
    });
  } else {
    const phase = current === undefined ? "prd" : current.phase_instance;
    const phaseKind = decodePhaseInstance(parsePhaseInstanceId(phase)).kind;
    const skill = WORKFLOW_V1.phases.find((candidate) => candidate.id === phaseKind)?.skill ?? "archflow-status";
    next = action(
      "gather-next-manual-milestone",
      "Run the current workflow skill, then record its actual schema-valid outcome through manual-next; status cannot be inferred before that work finishes.",
      false,
      `$${skill}`,
      Object.freeze({
        resume_command: "archflow-local manual-next",
        milestone_template: {
          schema_version: "1",
          operation: "step",
          phase_instance: phase,
          step: current?.step ?? "produce",
          status: "<running|succeeded|failed>",
        },
      }),
    );
  }
  return ok(Object.freeze({
    mode,
    authority_kind: facts.kind,
    ...(current === undefined ? {} : {
      revision: parseSafeInteger(current.revision),
      phase_instance: current.phase_instance,
      step: current.step,
      status: current.status,
    }),
    ...(taskStatus === undefined ? {} : { task_status: taskStatus }),
    next_action: next,
  }));
}

export type ManualFallbackTool = "archflow_state" | "archflow_counter_review" | "archflow_adjudicate" | "archflow_gate" | "archflow_waiver";
type ManualFallbackCommon = Readonly<{
  authority: ManualAuthority;
  unavailable_reason?: string;
}>;
export type ManualFallbackInput =
  | (ManualFallbackCommon & Readonly<{ tool: "archflow_state"; proposed_call: PlainJsonValue; source_artifact?: PlainJsonValue }>)
  | (ManualFallbackCommon & Readonly<{
      tool: "archflow_counter_review";
      proposed_call: PlainJsonValue;
      source_artifact: PlainJsonValue;
      rubric: PlainJsonValue;
      upstreams: readonly PlainJsonValue[];
      producer_family: "claude" | "codex";
    }>)
  | (ManualFallbackCommon & Readonly<{
      tool: "archflow_adjudicate";
      proposed_call: PlainJsonValue;
      source_artifact: PlainJsonValue;
      evidence: readonly PlainJsonValue[];
      upstreams: readonly PlainJsonValue[];
    }>)
  | (ManualFallbackCommon & Readonly<{
      tool: "archflow_gate" | "archflow_waiver";
      proposed_call: PlainJsonValue;
      request_material: PlainJsonValue;
      decision_templates: readonly PlainJsonValue[];
    }>);
export type ManualFallbackOutput = Readonly<{
  tool: ManualFallbackTool;
  kind: "checkpoint" | "prompt" | "gate-interface";
  material: PlainJsonValue;
  resume_action: ManualWorkflowNextAction;
}>;

/** Emits the exact serializable material for one unavailable MCP capability. */
export async function buildManualFallback(input: ManualFallbackInput): Promise<ProjectResult<ManualFallbackOutput>> {
  const facts = resolveManualAuthority(input.authority);
  if (!( ["archflow_state", "archflow_counter_review", "archflow_adjudicate", "archflow_gate", "archflow_waiver"] as const)
    .includes(input.tool)) return invalid(facts.services, "manual-fallback-tool-invalid");
  const current = facts.head ?? facts.state?.value;
  const selector = Object.freeze({
    schema_version: "1" as const,
    operation: input.tool,
    task_id: facts.services.authority.task_id,
    ...(current === undefined ? {} : { phase_instance: current.phase_instance, step: current.step }),
  });
  const pinned = current === undefined ? Object.freeze({
    initialization_digest: facts.initialization_digest,
  }) : Object.freeze({
    initialization_digest: facts.initialization_digest,
    input_fingerprint: current.input_fingerprint,
    revision: current.revision,
  });
  const resume = action("resume-manual-next", "Pass this material unchanged to manual-next after recording its outcome.", false, "archflow-local manual-next", selector);
  if (input.tool === "archflow_state") return ok(Object.freeze({
    tool: input.tool,
    kind: "checkpoint",
    material: Object.freeze({
      action: "build-and-install-derived-checkpoint",
      selector,
      pinned,
      proposed_call: input.proposed_call,
      ...(input.source_artifact === undefined ? {} : { source_artifact: input.source_artifact }),
    }),
    resume_action: resume,
  }));
  if (input.tool === "archflow_counter_review" || input.tool === "archflow_adjudicate") {
    const role = input.tool === "archflow_counter_review" ? "counter-review" : "adjudication";
    const proposed = input.tool === "archflow_counter_review"
      ? Object.freeze({
          proposed_call: input.proposed_call,
          source_artifact: input.source_artifact,
          rubric: input.rubric,
          upstreams: input.upstreams,
          reviewer_family: input.producer_family === "claude" ? "codex" : "claude",
        })
      : Object.freeze({
          proposed_call: input.proposed_call,
          source_artifact: input.source_artifact,
          evidence: input.evidence,
          upstreams: input.upstreams,
        });
    const prompt = [
      `Perform the degraded ${role} for task ${facts.services.authority.task_id}.`,
      current === undefined ? "Use the supplied initialization and artifact." : `Pinned milestone: ${current.phase_instance}/${current.step} at revision ${current.revision}.`,
      "Return only schema-valid evidence bound to the supplied artifact and pinned inputs.",
      input.tool === "archflow_adjudicate" ? "If the evidence is uncertain or the operation fails, open a human gate; do not infer advancement." : "Do not change files or advance the workflow.",
      `Pinned input (use exactly): ${JSON.stringify(pinned)}`,
      `Proposed input (use exactly): ${JSON.stringify(proposed)}`,
    ].join("\n");
    return ok(Object.freeze({ tool: input.tool, kind: "prompt", material: Object.freeze({ prompt, selector, pinned, proposed }), resume_action: resume }));
  }
  const gateKind = input.tool === "archflow_waiver" ? "waiver" : "gate";
  return ok(Object.freeze({
    tool: input.tool,
    kind: "gate-interface",
    material: Object.freeze({
      action: `publish-${gateKind}-request-and-decision-templates`,
      selector,
      pinned,
      proposed_call: input.proposed_call,
      request_material: input.request_material,
      decision_templates: input.decision_templates,
      stop_until: "A canonical request-bound decision is atomically archived.",
    }),
    resume_action: resume,
  }));
}

export type ManualNextValue = Readonly<{
  schema_version: "1";
  operation: "step" | "terminal" | "bootstrap" | "gate" | "fallback" | "import-call";
  initialization?: Initialization;
  phase_instance?: PhaseInstanceId;
  step?: PipelineStep;
  status?: TaskStateV1["status"];
  terminal?: "complete" | "abandoned";
  action?: ManualGateLifecycleAction;
  fallback_input?: PlainJsonValue;
  intent_id?: PathSafeId;
  result?: Readonly<{
    result_id: SafeId;
    artifact?: DocumentArtifactV1 | ImplementationOutputV1;
    evidence?: EvidenceResultValue;
  }>;
}>;

export type RunManualNextInput = Readonly<{ services: ProductionServices; value: ManualNextValue }>;
type PublicManualGateAwaiting = Omit<Extract<ManualGateLifecycleResult, { status: "awaiting-human" }>, "request"> & Readonly<{
  request: Readonly<{ digest: Sha256Digest; value: GateRequestV1 }>;
}>;
export type RunManualNextOutput =
  | Readonly<{ kind: "checkpoint"; checkpoint_path: string; checkpoint_digest: Sha256Digest; revision: SafeInteger; status: ManualWorkflowStatus }>
  | Readonly<{ kind: "fallback"; fallback: ManualFallbackOutput }>
  | Readonly<{ kind: "import-call"; call: CheckpointImportStateCall }>
  | Readonly<{ kind: "gate-awaiting"; gate: PublicManualGateAwaiting; status: ManualWorkflowStatus }>;

function parseManualNextValue(value: ManualNextValue): ManualNextValue {
  assertPlainJson(value, "manual-next input");
  const copy = structuredClone(value);
  if (copy.schema_version !== "1" || !["step", "terminal", "bootstrap", "gate", "fallback", "import-call"].includes(copy.operation)) {
    throw new TypeError("manual-next operation is invalid");
  }
  if (copy.initialization !== undefined) parseInitialization(copy.initialization);
  if (copy.result !== undefined) {
    parseSafeId(copy.result.result_id);
    if ((copy.result.artifact === undefined) === (copy.result.evidence === undefined)) {
      throw new TypeError("manual-next result requires exactly one artifact or evidence value");
    }
  }
  if (copy.operation === "step") {
    parsePhaseInstanceId(copy.phase_instance);
    if (copy.step === undefined || !PIPELINE_STEPS.includes(copy.step) ||
        copy.status === undefined || !["running", "succeeded", "failed"].includes(copy.status)) {
      throw new TypeError("manual-next step milestone is invalid");
    }
  }
  if (copy.operation === "terminal" && copy.terminal === undefined) throw new TypeError("manual-next terminal is required");
  if (copy.operation === "gate") {
    if (copy.action === undefined) throw new TypeError("manual-next gate action is required");
    parseManualGateAction(copy.action);
  }
  if (copy.operation === "fallback" && copy.fallback_input === undefined) throw new TypeError("manual-next fallback input is required");
  if (copy.operation === "import-call") parsePathSafeId(copy.intent_id);
  return Object.freeze(copy);
}

function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new TypeError("manual gate value must be an object");
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new TypeError("manual gate value has unexpected or missing fields");
  }
  return value as Record<string, unknown>;
}

function parseManualGateAction(value: ManualGateLifecycleAction): void {
  if (value === null || Array.isArray(value) || typeof value !== "object" || !Object.hasOwn(value, "kind")) {
    throw new TypeError("manual gate action must be an object with kind");
  }
  const action = value as unknown as Record<string, unknown>;
  if (action.kind === "publish") {
    const published = exactObject(value, ["kind", "selector"]);
    if (published.selector === null || Array.isArray(published.selector) || typeof published.selector !== "object" ||
        !Object.hasOwn(published.selector, "kind")) throw new TypeError("manual gate selector must have kind");
    const selectorBase = published.selector as Record<string, unknown>;
    if (selectorBase.kind === "gate") {
      const commit = Reflect.get(published.selector, "gate_kind") === "commit-authorization";
      const selector = exactObject(
        published.selector,
        commit ? ["kind", "gate_kind", "summary"] : ["kind", "gate_kind", "summary", "context"],
        ["supersedes_gate_id"],
      );
      if (!(GATE_KINDS as readonly unknown[]).includes(selector.gate_kind) || typeof selector.summary !== "string" || selector.summary.trim() === "") {
        throw new TypeError("manual gate publish selector is invalid");
      }
      if (!commit) parseGateContext(selector.gate_kind as never, selector.context as never);
      if (selector.supersedes_gate_id !== undefined) parsePathSafeId(selector.supersedes_gate_id);
      return;
    }
    if (selectorBase.kind === "waiver") {
      const selector = exactObject(published.selector, ["kind", "origin_gate_id", "summary", "rationale"]);
      parsePathSafeId(selector.origin_gate_id);
      if (typeof selector.summary !== "string" || selector.summary.trim() === "" ||
          typeof selector.rationale !== "string" || selector.rationale.trim() === "") {
        throw new TypeError("manual waiver publish selector is invalid");
      }
      return;
    }
    throw new TypeError("manual gate publish selector kind is invalid");
  }
  if (action.kind === "reload") {
    parsePathSafeId(exactObject(value, ["kind", "gate_id"]).gate_id);
    return;
  }
  if (action.kind === "resolve" || action.kind === "supersede") {
    const resolved = exactObject(value, ["kind", "gate_id", "input_fingerprint"],
      action.kind === "resolve" ? ["supplemental_outcome"] : ["supplemental_outcome"]);
    parsePathSafeId(resolved.gate_id);
    parseSha256Digest(resolved.input_fingerprint);
    if (action.kind === "supersede" && resolved.supplemental_outcome === undefined) {
      throw new TypeError("manual gate supersession outcome is required");
    }
    if (resolved.supplemental_outcome !== undefined) {
      const supplemental = parseSupplementalReviewOutcome(resolved.supplemental_outcome);
      if (action.kind === "supersede" && supplemental.action !== "supersede") {
        throw new TypeError("manual gate supersession outcome is invalid");
      }
    }
    return;
  }
  throw new TypeError("manual gate action kind is invalid");
}

function submittedResultSource(result: NonNullable<ManualNextValue["result"]>): Readonly<{
  source_digest: Sha256Digest;
  phase_instance: PhaseInstanceId;
  step: PipelineStep;
  input_fingerprint: Sha256Digest;
}> {
  if (result.artifact !== undefined) return Object.freeze({
    source_digest: canonicalJsonDigest(result.artifact),
    phase_instance: result.artifact.phase_instance,
    step: result.artifact.step,
    input_fingerprint: result.artifact.input_fingerprint,
  });
  const value = result.evidence!;
  const evidence = value.evidence;
  const source = value.kind === "review"
    ? Object.freeze({ schema_version: "1" as const, artifact_kind: "review-evidence" as const, evidence })
    : value.kind === "adjudication"
      ? Object.freeze({ schema_version: "1" as const, artifact_kind: "adjudication-evidence" as const, evidence })
      : Object.freeze({ schema_version: "1" as const, artifact_kind: "triage" as const, evidence });
  return Object.freeze({
    source_digest: canonicalJsonDigest(source),
    phase_instance: parsePhaseInstanceId(evidence.phase_instance),
    step: evidence.step,
    input_fingerprint: evidence.input_fingerprint,
  });
}

function reusableManualResult(
  authority: ManualAuthority,
  result: NonNullable<ManualNextValue["result"]>,
): TaskStateV1["authoritative_results"][number] | undefined {
  const facts = resolveManualAuthority(authority);
  const expected = submittedResultSource(result);
  const references = facts.head?.authoritative_results ?? facts.state?.value.authoritative_results ?? [];
  const matches = references.filter((reference) => {
    if (reference.result_id !== result.result_id ||
        reference.phase_instance !== expected.phase_instance || reference.step !== expected.step ||
        reference.input_fingerprint !== expected.input_fingerprint) return false;
    const manifest = facts.retained_manifests.find((candidate) => candidate.digest === reference.result_digest);
    return manifest !== undefined && canonicalJsonDigest(manifest.value.source_artifact) === expected.source_digest;
  });
  if (matches.length > 1) throw new TypeError("manual retained result generation is ambiguous");
  return matches[0];
}

/** Single-process boundary: remints all capabilities and returns only checkpoint/status projections. */
export async function runManualNext(input: RunManualNextInput): Promise<ProjectResult<RunManualNextOutput>> {
  let value: ManualNextValue;
  try { value = parseManualNextValue(input.value); }
  catch { return invalid(input.services, "manual-next-input-invalid"); }
  const authority = await loadManualAuthority({
    services: input.services,
    ...(value.initialization === undefined ? {} : { initialization: value.initialization }),
  });
  if (!authority.ok) return authority;
  let selectedAuthority = authority.value;
  if (value.operation === "import-call") {
    const call = await buildCheckpointImportStateCall({ authority: selectedAuthority, intent_id: value.intent_id! });
    return call.ok ? ok(Object.freeze({ kind: "import-call" as const, call: call.value })) : call;
  }
  if (value.operation === "fallback") {
    const raw = value.fallback_input;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(input.services, "manual-fallback-input-invalid");
    const fallback = await buildManualFallback({ ...structuredClone(raw), authority: selectedAuthority } as unknown as ManualFallbackInput);
    return fallback.ok ? ok(Object.freeze({ kind: "fallback" as const, fallback: fallback.value })) : fallback;
  }
  if (value.operation === "gate" && value.result !== undefined) {
    return invalid(input.services, "manual-gate-result-mix-invalid");
  }
  const installed = [];
  if (value.result !== undefined) {
    let reusable;
    try { reusable = reusableManualResult(selectedAuthority, value.result); }
    catch { return invalid(input.services, "manual-retained-result-generation-ambiguous"); }
    if (reusable !== undefined) {
      const reloaded = await loadManualAuthority({
        services: input.services,
        ...(value.initialization === undefined ? {} : { initialization: value.initialization }),
        exclude_result_digest: reusable.result_digest,
      });
      if (!reloaded.ok) return reloaded;
      selectedAuthority = reloaded.value;
      const result = await remintManualRetainedResult({
        services: input.services,
        authority: selectedAuthority,
        reference: reusable,
      });
      if (!result.ok) return result;
      installed.push(result.value);
    } else {
      const accounting = await createRetainedTaskAccounting({ services: input.services, manual_authority: selectedAuthority });
      const prepared = value.result.artifact !== undefined
        ? await prepareRetainedStateResult({
          services: input.services,
          artifact: value.result.artifact,
          result_id: value.result.result_id,
          accounting,
          scanner: createSecretlintScanner(),
          })
        : await prepareRetainedStateResult({
          services: input.services,
          evidence: value.result.evidence!,
          result_id: value.result.result_id,
          accounting,
          scanner: createSecretlintScanner(),
          });
      if (!prepared.ok) return prepared;
      const result = await installManualRetainedResult({ services: input.services, authority: selectedAuthority, prepared: prepared.value });
      if (!result.ok) return result;
      installed.push(result.value);
    }
  }
  let milestone: ManualMilestone;
  let gateFacts;
  if (value.operation === "gate") {
    const gate = await advanceManualGate({
      dependencies: input.services.dependencies,
      transaction_authority: input.services.authority,
      manual_authority: selectedAuthority as object,
      state: materializeManualAuthorityState(selectedAuthority),
      action: value.action!,
      resolve_publish_material: ({ manual_authority, state }) => {
        if (manual_authority !== selectedAuthority) throw new TypeError("manual gate publish authority changed");
        const facts = resolveManualAuthority(selectedAuthority);
        const produce = facts.retained_manifests.find((manifest) =>
          manifest.value.phase_instance === state.phase_instance && manifest.value.step === "produce");
        if (produce === undefined) return invalid(input.services, "manual-gate-current-subject-missing");
        const references = facts.head?.authoritative_results ?? facts.state?.value.authoritative_results ?? [];
        const retained = new Map();
        for (const step of ["self_review", "counter_review"] as const) {
          const reference = references.find((candidate) =>
            candidate.phase_instance === state.phase_instance && candidate.step === step);
          const manifest = reference === undefined ? undefined : facts.retained_manifests.find((candidate) =>
            candidate.digest === reference.result_digest);
          if (reference === undefined || manifest === undefined) {
            return invalid(input.services, "manual-gate-current-evidence-missing");
          }
          retained.set(step, Object.freeze({ reference, manifest: manifest.value }));
        }
        let derived;
        try { derived = deriveCurrentEvidenceSet(retained as RetainedEvidenceSet); }
        catch { return invalid(input.services, "manual-gate-current-evidence-invalid"); }
        if (derived.subject_digest !== produce.value.artifact_digest ||
            derived.phase_instance !== state.phase_instance || derived.input_fingerprint !== state.input_fingerprint) {
          return invalid(input.services, "manual-gate-current-evidence-mismatch");
        }
        const checkpointEvidence = facts.head?.evidence_chain.find((entry) =>
          entry.phase_instance === state.phase_instance && entry.subject_digest === derived.subject_digest);
        if (checkpointEvidence !== undefined && !isDeepStrictEqual(checkpointEvidence.current_evidence, derived.current_evidence_set)) {
          return invalid(input.services, "manual-gate-checkpoint-evidence-mismatch");
        }
        return ok(Object.freeze({
          subject_digest: produce.value.artifact_digest,
          current_evidence: derived.current_evidence_set,
        }));
      },
    });
    if (!gate.ok) return gate;
    if (gate.value.status === "awaiting-human") {
      if (resolveManualAuthority(selectedAuthority).head?.open_gate?.gate_id === gate.value.gate_id) {
        const status = await classifyManualWorkflowStatus({ services: input.services });
        if (!status.ok) return status;
        const { request, ...publicGate } = gate.value;
        return ok(Object.freeze({
          kind: "gate-awaiting" as const,
          gate: Object.freeze({ ...publicGate, request: Object.freeze({ digest: request.digest, value: request.value }) }),
          status: status.value,
        }));
      }
      milestone = Object.freeze({ kind: "gate-open", request: gate.value.request.value });
    } else {
      milestone = Object.freeze({ kind: "gate-resolved", decision: gate.value.decision.value });
      gateFacts = gate.value.gate_facts;
    }
  } else if (value.operation === "terminal") milestone = Object.freeze({ kind: "terminal", terminal: value.terminal! });
  else milestone = Object.freeze({
    kind: "step",
    phase_instance: value.operation === "bootstrap" ? parsePhaseInstanceId("prd") : value.phase_instance!,
    step: value.operation === "bootstrap" ? "produce" : value.step!,
    status: value.operation === "bootstrap" ? "running" : value.status!,
  });
  const checkpoint = await buildNextManualCheckpoint({
    authority: selectedAuthority,
    milestone,
    results: installed,
    ...(gateFacts === undefined ? {} : { gate_facts: gateFacts }),
  });
  if (!checkpoint.ok) return checkpoint;
  const written = await writeManualCheckpoint(input.services.dependencies, input.services.authority, checkpoint.value);
  if (!written.ok) return written;
  const status = await classifyManualWorkflowStatus({
    services: input.services,
    ...(value.initialization === undefined ? {} : { initialization: value.initialization }),
  });
  if (!status.ok) return status;
  return ok(Object.freeze({
    kind: "checkpoint" as const,
    checkpoint_path: `.archflow/tasks/${input.services.authority.task_id}/manual/checkpoints/${checkpoint.value.revision}-${written.value.digest}.json`,
    checkpoint_digest: written.value.digest,
    revision: parseSafeInteger(checkpoint.value.revision),
    status: status.value,
  }));
}

export type RunManualHandoffInput = Readonly<{
  services: ProductionServices;
  expected_head: GitOid;
  initialization?: Initialization;
}>;

/** Single-process handoff boundary; no selected authority capability crosses CLI JSON. */
export async function runManualHandoff(input: RunManualHandoffInput): Promise<ProjectResult<ManualHandoffResult>> {
  let expected: GitOid;
  try { expected = parseGitOid(input.expected_head); }
  catch { return invalid(input.services, "manual-handoff-head-invalid"); }
  const authority = await loadManualAuthority({
    services: input.services,
    ...(input.initialization === undefined ? {} : { initialization: input.initialization }),
  });
  if (!authority.ok) return authority;
  return inspectManualHandoff({
    dependencies: { runner: input.services.runner },
    transaction_authority: input.services.authority,
    selected_authority: authority.value,
    resolve_selected_authority: resolveManualHandoffAuthority,
    expected_head: expected,
  });
}
