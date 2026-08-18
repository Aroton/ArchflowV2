import { randomUUID } from "node:crypto";

import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId, parseSha256Digest, type PathSafeId } from "../contracts/evidence.js";
import type { GateKind } from "../contracts/gates.js";
import { decodePhaseInstance, isEarlierPlanningPhase, parsePhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { parseTriageCandidate, type TriageDisposition } from "../contracts/triage.js";
import { PIPELINE_STEPS, type PipelineStep } from "../contracts/vocabulary.js";
import { parseDocumentArtifact } from "../contracts/durable-document.js";
import {
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  toRepositoryPathClaim,
  type RepositoryPathClaim,
} from "../contracts/path-claims.js";
import { stageTaskInitialization } from "../init/task-initialization.js";
import { readChangedGitPaths, resolveCommit } from "../repository/git.js";
import { buildDocumentArtifact, type DocumentArtifactInput } from "../state/document-artifact.js";
import {
  deriveCurrentEvidenceSet,
  derivePendingEditorialPredecessor,
  loadRetainedEvidence,
} from "../state/evidence-results.js";
import { buildImplementationOutput, type ImplementationOutputInput } from "../state/implementation-manifest.js";
import {
  phaseDocumentDefaults,
  phaseImplParentDocumentDefaults,
  phaseReviewPaths,
  type PhaseImplParentDocument,
} from "../state/phase-documents.js";
import { loadCurrentProduceSubject } from "../state/produce-subject.js";
import type { ProductionServices } from "../state/production.js";
import { resolvePinnedConstitution } from "../state/constitution.js";
import { loadAuthenticatedGateApproval, type AuthenticatedGateApproval } from "../state/gate-approvals.js";
import { APPROVAL_ARTIFACT_KINDS } from "../state/request-templates.js";
import { baselineAdoptionInputFromFindings, buildCommitAuthorizationInput, buildDesignApprovalInput, computeTaskStatus, currentTargetRef, pendingAdjudicationGate } from "../state/status.js";
import { baselineRestoreOffered } from "../state/gates.js";
import { canonicalDocument } from "../contracts/canonical.js";
import { reconcileCurrentAuthority } from "../state/reconciliation.js";
import { discoverReconciliationInput } from "../state/reconciliation-discovery.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { legalRunStepStatus } from "../state/transitions.js";
import { buildGatePreview, previewHasChoice, type GateDecisionChoice, type ProspectiveGate } from "../state/gate-preview.js";
import { writeStagedRequest } from "../state/staged-requests.js";
import { computeCallEnvelope, type CallEnvelope } from "./call-envelope.js";
import { computeLocalGatePreview } from "./gate-preview.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

export const BUILD_REQUEST_KINDS = Object.freeze([
  "initialize", "produce", "running", "triage",
  "counter-review", "gate", "waiver", "advance",
  "restart",
] as const);
export type BuildRequestKind = typeof BUILD_REQUEST_KINDS[number];

const PAYLOAD_SHAPE =
  `{"intent_id"?:<id; omitted = generated>,"kind"?:${BUILD_REQUEST_KINDS.map((kind) => JSON.stringify(kind)).join("|")},` +
  '"step"?:<pipeline step for kind running>,' +
  '"document"?:{...},"implementation"?:{...},' +
  '"human_revision"?:{"classification":"simple"|"significant","rationale":<text>,"user_override"?:{"agent_classification":"simple"|"significant","rationale":<text>}},' +
  '"dispositions"?:[{"finding_id":<id>,"disposition":"accepted"|"accepted-editorial"|"rejected","rationale":<text>,"revision_intent"?:<text>,"evidence"?:<text>,"review_evidence_digest"?:<sha256>}],' +
  '"summary"?:<gate summary text>,"preview_digest"?:<gate-preview digest>,"decision"?:{"choice":<option token>,"reason":<human reason>},' +
  '"origin"?:<waiver origin>,"rationale"?:<waiver rationale>,"target_phase_instance"?:<earlier planning phase>,"reason"?:<restart reason>}';

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object; expected ${PAYLOAD_SHAPE}`);
  }
  return value as Record<string, unknown>;
}

function transitionInvalid(state: TaskStateV1, to: string): ProjectResult<never> {
  return fail(createProjectError("TRANSITION_INVALID", {
    phase_instance: state.phase_instance,
    from: `${state.step}-${state.status}`,
    to,
  }));
}

function requestedGateDecision(snapshot: Record<string, unknown>, label: string): Readonly<{
  preview_digest: ReturnType<typeof parseSha256Digest>;
  decision: GateDecisionChoice;
}> {
  const raw = record(snapshot.decision, `${label} decision`);
  const choice = String(raw.choice ?? "");
  const reason = String(raw.reason ?? "");
  if (choice.trim() === "" || reason.trim() === "") {
    throw new TypeError(`${label} decision requires non-empty "choice" and "reason" fields`);
  }
  return Object.freeze({
    preview_digest: parseSha256Digest(snapshot.preview_digest),
    decision: Object.freeze({ choice, reason }),
  });
}

function isPipelineStep(value: string): value is PipelineStep {
  return (PIPELINE_STEPS as readonly string[]).includes(value);
}

function mechanicalInput(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
): Record<string, PlainJsonValue> {
  return {
    schema_version: "1",
    task_id: services.authority.task_id,
    intent_id: intentId,
    expected_revision: state.revision,
    input_fingerprint: state.input_fingerprint,
  };
}

const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/**
 * Extends an implementation declaration with every canonical task document that is currently
 * changed. These documents are writable during implementation, but they live outside the
 * repository snapshot exposed to review children. Making them ordinary outputs both retains
 * their reviewed bytes and ensures rollback covers them without relying on the caller to notice
 * that a plan edit needs special treatment.
 */
export function includeChangedImplementationDocuments(input: {
  readonly task_id: TaskStateV1["task_id"];
  readonly phase_instance: TaskStateV1["phase_instance"];
  readonly changed_paths: readonly string[];
  readonly outputs: readonly RepositoryPathClaim[];
  readonly restore_targets: readonly RepositoryPathClaim[];
  readonly parent_documents: readonly PhaseImplParentDocument[];
}): Readonly<{
  outputs: readonly RepositoryPathClaim[];
  restore_targets: readonly RepositoryPathClaim[];
  parent_documents: readonly PhaseImplParentDocument[];
}> {
  const defaults = phaseImplParentDocumentDefaults(input.phase_instance);
  if (defaults === undefined) throw new TypeError("implementation document capture requires a phase-impl phase");
  const changed = new Set(input.changed_paths);
  const outputs = new Set(input.outputs);
  const restoreTargets = new Set(input.restore_targets);
  const parents = new Map(input.parent_documents.map((parent) => [parent.document_path, parent]));
  for (const parent of defaults) {
    const taskPath = parseTaskPathClaim(parent.document_path);
    const repositoryPath = toRepositoryPathClaim(input.task_id, taskPath);
    if (!changed.has(repositoryPath)) continue;
    outputs.add(repositoryPath);
    restoreTargets.add(repositoryPath);
    if (!parents.has(parent.document_path)) parents.set(parent.document_path, parent);
  }
  return Object.freeze({
    outputs: Object.freeze([...outputs].sort(ordinal)),
    restore_targets: Object.freeze([...restoreTargets].sort(ordinal)),
    parent_documents: Object.freeze([...parents.values()].sort((left, right) =>
      ordinal(left.document_path, right.document_path))),
  });
}

function implementationPathList(value: unknown, name: string): readonly RepositoryPathClaim[] {
  if (!Array.isArray(value)) throw new TypeError(`implementation ${name} must be an array`);
  return value.map((path) => parseRepositoryPathClaim(path));
}

function implementationParentDocuments(
  value: unknown,
  defaults: readonly PhaseImplParentDocument[],
): readonly PhaseImplParentDocument[] {
  if (value === undefined) return defaults;
  if (!Array.isArray(value)) throw new TypeError("implementation parent_documents must be an array");
  return value.map((candidate) => {
    const parent = record(candidate, "implementation parent document");
    const role = parent.role;
    if (role !== "prd" && role !== "design" && role !== "phase-design" && role !== "impl-notes") {
      throw new TypeError("implementation parent document role is invalid");
    }
    return Object.freeze({ document_path: parseTaskPathClaim(parent.document_path), role });
  });
}

// Parseable on purpose so the draft passes tool-call parsing; computeCallEnvelope substitutes
// the real fingerprint via the no-state initialization identity, so the sentinel never reaches
// the server.
const INITIALIZATION_FINGERPRINT_SENTINEL = "0".repeat(64);

/**
 * The one kind that is legal only before durable state exists. Staging must precede envelope
 * resolution: it scaffolds the pinned task config that the initialization identity reads to
 * resolve the fingerprint — which also makes this the one composer that writes, carried over
 * from task-init because the envelope cannot resolve against a config that is not on disk.
 */
async function composeInitialize(
  services: ProductionServices,
  intentId: string,
): Promise<ProjectResult<CallEnvelope>> {
  const staged = await stageTaskInitialization({
    working_directory: services.runner.location.worktreeRoot,
    task_id: services.authority.task_id,
  });
  if (!staged.ok) return staged;
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      schema_version: "1",
      task_id: services.authority.task_id,
      intent_id: intentId,
      expected_revision: 0,
      input_fingerprint: INITIALIZATION_FINGERPRINT_SENTINEL,
      phase_instance: "prd",
      step: "produce",
      status: "running",
      artifact: staged.value as unknown as PlainJsonValue,
    },
  });
}

async function composeProduce(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> {
  if (legalRunStepStatus(state, "produce") !== "succeeded") {
    return transitionInvalid(state, "produce-succeeded");
  }
  const phaseKind = decodePhaseInstance(state.phase_instance).kind;
  if (snapshot.document !== undefined && snapshot.implementation !== undefined) {
    throw new TypeError(`build-request accepts document facts or implementation facts, never both; expected ${PAYLOAD_SHAPE}`);
  }

  let artifact: PlainJsonValue;
  if (phaseKind === "phase-impl") {
    if (snapshot.document !== undefined) {
      throw new TypeError("phase-impl produces an implementation output; supply implementation facts, not document facts");
    }
    const implementation = record(
      snapshot.implementation,
      "build-request implementation facts (required for phase-impl)",
    );
    const parentDefaults = phaseImplParentDocumentDefaults(state.phase_instance);
    if (parentDefaults === undefined) throw new TypeError("phase-impl parent document defaults are unavailable");
    const changed = await readChangedGitPaths(services.runner);
    const captured = includeChangedImplementationDocuments({
      task_id: services.authority.task_id,
      phase_instance: state.phase_instance,
      changed_paths: changed.paths,
      outputs: implementationPathList(implementation.outputs, "outputs"),
      restore_targets: implementationPathList(implementation.restore_targets, "restore_targets"),
      parent_documents: implementationParentDocuments(implementation.parent_documents, parentDefaults),
    });
    const built = await buildImplementationOutput(
      services.dependencies,
      services.authority,
      services.state!,
      {
        ...implementation,
        ...captured,
        phase_instance: state.phase_instance,
        step: "produce",
        declared_inputs: implementation.declared_inputs ?? [],
        input_fingerprint: state.input_fingerprint,
      } as unknown as ImplementationOutputInput,
    );
    if (!built.ok) return built;
    artifact = built.value as unknown as PlainJsonValue;
  } else {
    if (snapshot.implementation !== undefined) {
      throw new TypeError(`${phaseKind} produces a document; supply document facts, not implementation facts`);
    }
    const defaults = phaseDocumentDefaults(services.authority.task_id, state.phase_instance);
    if (defaults === undefined) throw new TypeError(`${phaseKind} has no canonical document defaults`);
    const document = snapshot.document === undefined
      ? {}
      : record(snapshot.document, "build-request document facts");
    const built = await buildDocumentArtifact(services.runner, services.authority, {
      phase_instance: state.phase_instance,
      step: "produce",
      document_path: document.document_path ?? defaults.document_path,
      ...(defaults.additional_document_paths === undefined
        ? {}
        : { additional_document_paths: defaults.additional_document_paths }),
      declared_inputs: document.declared_inputs ?? defaults.declared_inputs,
      input_fingerprint: state.input_fingerprint,
    } as unknown as DocumentArtifactInput);
    if (!built.ok) return built;
    // When durable authority shows a pending editorial revision — the retained triage accepted
    // only editorial findings against the retained produce artifact — the predecessor link is
    // attached here from that authority, never hand-copied by the model.
    const editorial = await derivePendingEditorialPredecessor(services.dependencies, state);
    artifact = (editorial === undefined
      ? built.value
      : parseDocumentArtifact({
          ...built.value,
          editorial_predecessor: editorial,
        })) as unknown as PlainJsonValue;
  }

  let humanRevision: PlainJsonValue | undefined;
  if (state.pending_human_revision !== undefined) {
    if (snapshot.human_revision === undefined) {
      throw new TypeError("this produce result completes a human-requested revision; human_revision classification and rationale are required");
    }
    humanRevision = structuredClone(record(snapshot.human_revision, "build-request human revision")) as PlainJsonValue;
  } else if (snapshot.human_revision !== undefined) {
    throw new TypeError("human_revision is accepted only while durable state has a pending human-requested revision");
  }

  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: "produce",
      status: "succeeded",
      artifact,
      ...(humanRevision === undefined ? {} : { human_revision: humanRevision }),
    },
  });
}

function composeRunning(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> | ProjectResult<never> {
  const step = String(snapshot.step ?? "");
  if (!isPipelineStep(step)) {
    throw new TypeError(`build-request running facts require "step": one of ${PIPELINE_STEPS.join(", ")}`);
  }
  if (legalRunStepStatus(state, step) !== "running") {
    return transitionInvalid(state, `${step}-running`);
  }
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step,
      status: "running",
    },
  });
}

async function composeTriage(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> {
  if (legalRunStepStatus(state, "triage") !== "succeeded") {
    return transitionInvalid(state, "triage-succeeded");
  }
  if (!Array.isArray(snapshot.dispositions)) {
    throw new TypeError('build-request triage facts require "dispositions": one entry per current finding');
  }
  const loadRetainedManifest = services.dependencies.load_retained_manifest;
  if (loadRetainedManifest === undefined) throw new TypeError("retained evidence loading is unavailable");
  const loaded = await loadRetainedEvidence(
    { load_retained_manifest: loadRetainedManifest },
    state,
    state.phase_instance,
  );
  if (!loaded.ok) return loaded;
  const derived = deriveCurrentEvidenceSet(loaded.value);

  const digestsByFindingId = new Map<string, string[]>();
  const expected = new Set<string>();
  const blocking = new Set<string>();
  for (const reviewRef of derived.reviews) {
    for (const finding of reviewRef.evidence.findings) {
      const key = `${reviewRef.evidence_digest}:${finding.finding_id}`;
      expected.add(key);
      if (finding.blocking) blocking.add(key);
      const digests = digestsByFindingId.get(finding.finding_id) ?? [];
      digests.push(reviewRef.evidence_digest);
      digestsByFindingId.set(finding.finding_id, digests);
    }
  }

  const dispositions: TriageDisposition[] = snapshot.dispositions.map((entry, index) => {
    const item = record(entry, `triage disposition ${index}`);
    const findingId = String(item.finding_id ?? "");
    const candidates = digestsByFindingId.get(findingId);
    if (candidates === undefined) {
      throw new TypeError(`triage disposition names unknown finding_id ${JSON.stringify(findingId)}; current findings: ${[...digestsByFindingId.keys()].join(", ") || "(none)"}`);
    }
    let evidenceDigest = item.review_evidence_digest === undefined
      ? undefined
      : String(item.review_evidence_digest);
    if (evidenceDigest === undefined) {
      if (candidates.length !== 1) {
        throw new TypeError(`finding_id ${findingId} appears in ${candidates.length} current reviews; disambiguate with review_evidence_digest (one of ${candidates.join(", ")})`);
      }
      evidenceDigest = candidates[0]!;
    } else if (!candidates.includes(evidenceDigest)) {
      throw new TypeError(`review_evidence_digest ${evidenceDigest} does not carry finding ${findingId}`);
    }
    const base = { review_evidence_digest: evidenceDigest, finding_id: findingId } as const;
    if (item.disposition === "accepted" || item.disposition === "accepted-editorial") {
      if (item.disposition === "accepted-editorial" && blocking.has(`${evidenceDigest}:${findingId}`)) {
        throw new TypeError(`finding ${findingId} is blocking; "accepted-editorial" is only for non-blocking wording or formatting fixes — use "accepted" or "rejected"`);
      }
      return {
        ...base,
        disposition: item.disposition,
        rationale: String(item.rationale ?? ""),
        revision_intent: String(item.revision_intent ?? ""),
      } as TriageDisposition;
    }
    if (item.disposition === "rejected") {
      return {
        ...base,
        disposition: "rejected",
        rationale: String(item.rationale ?? ""),
        evidence: String(item.evidence ?? ""),
      } as TriageDisposition;
    }
    throw new TypeError(`triage disposition for ${findingId} must set disposition "accepted", "accepted-editorial", or "rejected"`);
  });

  const actual = new Set(dispositions.map((item) => `${item.review_evidence_digest}:${item.finding_id}`));
  if (actual.size !== dispositions.length) {
    throw new TypeError("triage dispositions contain a duplicate finding reference");
  }
  const missing = [...expected].filter((key) => !actual.has(key));
  if (missing.length > 0) {
    throw new TypeError(`triage dispositions must cover every current finding; missing: ${missing.join(", ")}`);
  }
  const acceptedCount = dispositions.filter((item) => item.disposition === "accepted").length;
  const acceptedEditorialCount = dispositions.filter((item) => item.disposition === "accepted-editorial").length;
  const candidate = parseTriageCandidate({
    schema_version: "1",
    task_id: services.authority.task_id,
    phase_instance: state.phase_instance,
    step: "triage",
    subject_digest: derived.subject_digest,
    input_fingerprint: derived.input_fingerprint,
    current_evidence_set_digest: derived.current_evidence_set.set_digest,
    source_evidence_digests: derived.current_evidence_set.slots.map((slot) => slot.evidence_digest),
    dispositions,
    accepted_count: acceptedCount,
    rejected_count: dispositions.length - acceptedCount - acceptedEditorialCount,
    accepted_editorial_count: acceptedEditorialCount,
  });

  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: "triage",
      status: "succeeded",
      artifact: {
        schema_version: "1",
        artifact_kind: "triage",
        evidence: candidate as unknown as PlainJsonValue,
      },
    },
  });
}

function composeCounterReview(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> | ProjectResult<never> {
  if (snapshot.rubric !== undefined) {
    throw new TypeError("build-request counter-review selects the canonical rubric from durable phase state; do not supply rubric");
  }
  if (legalRunStepStatus(state, "counter_review") !== "succeeded") {
    return transitionInvalid(state, "counter_review-succeeded");
  }
  const paths = phaseReviewPaths(state.phase_instance);
  return computeCallEnvelope(services, {
    tool: "archflow_counter_review",
    input: {
      ...mechanicalInput(services, state, intentId),
      artifact_path: paths.artifact_path,
    },
  });
}

async function composeGate(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> {
  const summary = String(snapshot.summary ?? "");
  if (summary.trim() === "") {
    throw new TypeError('build-request gate facts require a non-empty "summary" written for the human reviewer');
  }
  const requested = requestedGateDecision(snapshot, "build-request gate");
  // Baseline adoption composes ahead of the phase's own approval gates: reconciliation blocking is
  // ahead of them in status routing too, so an approval composed past unresolved drift could never
  // resolve honestly. Mid-produce drift is expected producer work and never composes this gate.
  if (state.step !== "produce" || state.status === "succeeded") {
    const discovered = await discoverReconciliationInput(services.dependencies, services.authority, canonicalDocument(state));
    if (!discovered.ok) return discovered;
    const drift = reconcileCurrentAuthority(discovered.value);
    if (drift.classification === "reconciliation-required") {
      const adoption = baselineAdoptionInputFromFindings(services.authority.task_id, state, drift.findings);
      if (adoption !== undefined) {
        // A restore that can never apply must be refused here, before the gate opens: a decided
        // interface is immutable, so recording it would wedge the gate behind an unapplicable
        // decision. Adoption-sourced drift has no retained manifest to restore from.
        if (requested.decision.choice === "restore-recorded-versions" &&
            !(await baselineRestoreOffered(services.dependencies, services.authority, services.state!, adoption.context.drifted_projections))) {
          return transitionInvalid(state, "baseline-adoption-restore-unavailable");
        }
        const input: Record<string, PlainJsonValue> = {
          ...mechanicalInput(services, state, intentId),
          phase_instance: state.phase_instance,
          summary,
          subject_digest: adoption.subject_digest,
          current_evidence: adoption.current_evidence as unknown as PlainJsonValue,
          kind: "baseline-adoption",
          context: adoption.context as unknown as PlainJsonValue,
        };
        const preview = buildGatePreview({
          task_id: services.authority.task_id,
          revision: state.revision,
          phase_instance: state.phase_instance,
          summary,
          subject_digest: input.subject_digest as ProspectiveGate["subject_digest"],
          current_evidence: adoption.current_evidence,
          kind: "baseline-adoption",
          context: input.context as ProspectiveGate["context"],
        });
        if (preview.preview_digest !== requested.preview_digest || !previewHasChoice(preview, requested.decision)) {
          return transitionInvalid(state, preview.preview_digest !== requested.preview_digest
            ? "gate-preview-stale"
            : "gate-decision-choice-invalid");
        }
        input.preview_digest = requested.preview_digest;
        input.decision = requested.decision as unknown as PlainJsonValue;
        return computeCallEnvelope(services, { tool: "archflow_gate", input });
      }
    }
  }
  const phaseKind = decodePhaseInstance(state.phase_instance).kind;
  const gateKind = phaseKind === "phase-impl"
    ? "commit-authorization"
    : phaseKind === "design" || phaseKind === "phase-design"
      ? "design-approval"
      : "artifact-approval";
  if (state.terminal !== undefined || state.open_gate !== undefined) {
    return transitionInvalid(state, `${gateKind}-gate`);
  }
  const subject = await loadCurrentProduceSubject(services.dependencies, state);
  if (!subject.ok) return subject;
  const loadRetainedManifest = services.dependencies.load_retained_manifest;
  if (loadRetainedManifest === undefined) throw new TypeError("retained evidence loading is unavailable");
  const loaded = await loadRetainedEvidence(
    { load_retained_manifest: loadRetainedManifest },
    state,
    state.phase_instance,
  );
  if (!loaded.ok) return loaded;
  const derived = deriveCurrentEvidenceSet(loaded.value);

  // An unresolved constitution-review gate composes first: the fixed point refuses to advance
  // while one is pending, so an approval gate composed past it could never resolve honestly.
  // Kind, subject, and context are all derived from retained adjudication evidence; only the
  // summary is authored.
  const constitution = await resolvePinnedConstitution(
    services.runner, state.policy_base_commit, services.authority.context,
  );
  let pendingGate: ReturnType<typeof pendingAdjudicationGate>;
  if (constitution.ok) {
    const authenticated: AuthenticatedGateApproval[] = [];
    for (const approval of state.approvals) {
      const loadedApproval = await loadAuthenticatedGateApproval(
        services.dependencies, services.authority, approval,
      );
      if (!loadedApproval.ok) return loadedApproval;
      authenticated.push(loadedApproval.value);
    }
    pendingGate = pendingAdjudicationGate(state, constitution.value, loaded.value, authenticated);
  }

  let input: Record<string, PlainJsonValue>;
  if (gateKind === "design-approval") {
    const target = await currentTargetRef(services.dependencies);
    const approval = await buildDesignApprovalInput(services.dependencies, state, loaded.value, target);
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary,
      subject_digest: subject.value.artifact_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: "design-approval",
      context: approval.context as unknown as PlainJsonValue,
    };
  } else if (pendingGate !== undefined) {
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary,
      subject_digest: pendingGate.subject_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: pendingGate.kind,
      context: pendingGate.context as unknown as PlainJsonValue,
    };
  } else if (gateKind === "commit-authorization") {
    const target = await currentTargetRef(services.dependencies);
    const authorization = buildCommitAuthorizationInput(
      subject.value,
      derived.current_evidence_set,
      target,
      await resolveCommit(services.runner, "HEAD"),
    );
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary,
      subject_digest: authorization.subject_digest,
      current_evidence: authorization.current_evidence as unknown as PlainJsonValue,
      kind: "commit-authorization",
      context: authorization.context as unknown as PlainJsonValue,
    };
  } else {
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary,
      subject_digest: subject.value.artifact_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: "artifact-approval",
      context: { artifact_kind: APPROVAL_ARTIFACT_KINDS[phaseKind] },
    };
  }
  const preview = buildGatePreview({
    task_id: services.authority.task_id,
    revision: state.revision,
    phase_instance: state.phase_instance,
    summary,
    subject_digest: input.subject_digest as ProspectiveGate["subject_digest"],
    current_evidence: derived.current_evidence_set,
    kind: input.kind as GateKind,
    context: input.context as ProspectiveGate["context"],
  });
  if (preview.preview_digest !== requested.preview_digest || !previewHasChoice(preview, requested.decision)) {
    return transitionInvalid(state, preview.preview_digest !== requested.preview_digest
      ? "gate-preview-stale"
      : "gate-decision-choice-invalid");
  }
  input.preview_digest = requested.preview_digest;
  input.decision = requested.decision as unknown as PlainJsonValue;
  return computeCallEnvelope(services, { tool: "archflow_gate", input });
}

async function composeWaiver(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> {
  if (state.terminal !== undefined || state.open_gate !== undefined) {
    return transitionInvalid(state, "waiver-gate");
  }
  const requested = requestedGateDecision(snapshot, "build-request waiver");
  const origin = record(snapshot.origin, "build-request waiver origin");
  const rationale = String(snapshot.rationale ?? "");
  if (rationale.trim() === "") throw new TypeError('build-request waiver requires a non-empty "rationale"');
  const preview = await computeLocalGatePreview(services, {
    kind: "waiver",
    origin: origin as unknown as PlainJsonValue,
    rationale,
  });
  if (!preview.ok) return preview;
  if (preview.value.preview_digest !== requested.preview_digest ||
      !previewHasChoice(preview.value, requested.decision)) {
    return transitionInvalid(state, preview.value.preview_digest !== requested.preview_digest
      ? "waiver-preview-stale"
      : "waiver-decision-choice-invalid");
  }
  return computeCallEnvelope(services, {
    tool: "archflow_waiver",
    input: {
      ...mechanicalInput(services, state, intentId),
      origin: origin as unknown as PlainJsonValue,
      rationale,
      preview_digest: requested.preview_digest,
      decision: requested.decision as unknown as PlainJsonValue,
    },
  });
}

/**
 * Composes the judgment-free phase handoff from freshly recomputed durable status. Status is
 * deliberately recomputed here rather than trusting the caller's earlier projection: a replay,
 * concurrent gate resolution, or prior successful handoff must make this request refuse before
 * it is staged.
 */
async function composeAdvance(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
): Promise<ProjectResult<CallEnvelope>> {
  const computed = await computeTaskStatus(services.dependencies, services.authority);
  if (!computed.ok) return computed;
  const next = computed.value.next_action;
  if ((next.code !== "advance-phase" && next.code !== "complete-task") ||
      next.target_phase_instance === undefined ||
      computed.value.revision !== state.revision) {
    return transitionInvalid(state, "advance");
  }
  const completing = next.code === "complete-task";
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: next.target_phase_instance,
      step: completing ? state.step : "produce",
      status: completing ? state.status : "running",
    },
  });
}

function composePlanningRestart(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> | ProjectResult<never> {
  const target = parsePhaseInstanceId(snapshot.target_phase_instance);
  const reason = String(snapshot.reason ?? "");
  if (reason.trim() === "" || state.terminal !== undefined || state.open_gate !== undefined ||
      !isEarlierPlanningPhase(target, state.phase_instance)) {
    return transitionInvalid(state, `${target}-restart`);
  }
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: target,
      step: "produce",
      status: "running",
      planning_restart: { reason },
    },
  });
}

/**
 * Composes a complete, fingerprint-resolved tool request from durable state plus the caller's
 * judgment content. Every kind derives its mechanical fields — phase, revision, digests, slot
 * order, provenance, counts — from the same authorities the server checks against, guards the
 * targeted transition with the server's own movement rules, and resolves the whole request
 * through the call envelope, so `request.input` is the finished tool call with nothing left to
 * transcribe. Judgment content is never drafted here: findings, dispositions, rationales,
 * and gate summaries come only from the payload; canonical review policy comes from the server.
 * Kind "initialize" is the one
 * request composed without durable state — it stages the initialization artifact itself and is
 * refused once state exists.
 */
/**
 * A generated intent id: kind, second-resolution UTC stamp, four hex characters of crypto
 * randomness. The caller only supplies `intent_id` explicitly to replay or resume an interrupted
 * call by reusing the id the envelope echoed.
 */
function generateIntentId(kind: string): PathSafeId {
  const stamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").slice(0, 15);
  const random = randomUUID().replaceAll("-", "").slice(0, 4);
  return parsePathSafeId(`${kind}-${stamp}-${random}`);
}

/**
 * Stages the resolved request beside the intent receipt slot and returns the envelope augmented
 * with the staged path plus the four-field reference the MCP call pastes instead of the payload.
 * Overwrite semantics are deliberate — recomposing the same intent replaces the staged file, and
 * the request digest is what protects against stale or mismatched use.
 */
async function withStagedRequest(
  services: ProductionServices,
  intentId: PathSafeId,
  result: ProjectResult<CallEnvelope>,
): Promise<ProjectResult<CallEnvelope>> {
  if (!result.ok) return result;
  const staged = await writeStagedRequest({
    services,
    intent_id: intentId,
    tool: result.value.tool,
    request_input: result.value.request.input,
    request_digest: result.value.request_digest,
  });
  if (!staged.ok) return staged;
  return ok(Object.freeze({ ...result.value, staged: staged.value }));
}

export async function runBuildRequest(
  services: ProductionServices,
  value: PlainJsonValue,
): Promise<ProjectResult<CallEnvelope>> {
  assertPlainJson(value, "build-request input");
  const snapshot = record(structuredClone(value), "build-request input");
  const kind = snapshot.kind === undefined ? "produce" : String(snapshot.kind);
  const intentId = snapshot.intent_id === undefined
    ? generateIntentId(kind)
    : parsePathSafeId(String(snapshot.intent_id));
  if (kind === "initialize") {
    // Initialize keeps its full-payload flow unstaged: it is the one request composed before
    // durable state exists, and the initialization transaction owns the first authoritative
    // writes into the task directory — staging a request file next to a not-yet-adopted
    // scaffold would put bytes there that no durable authority accounts for yet.
    return services.state === undefined
      ? composeInitialize(services, intentId)
      : transitionInvalid(services.state.value, "initialize");
  }
  if (services.state === undefined) {
    return fail(createProjectError("STATE_MISSING", {
      phase_instance: services.authority.context.phase_instance,
    }));
  }
  const state = services.state.value;

  switch (kind) {
    case "produce": return withStagedRequest(services, intentId, await composeProduce(services, state, intentId, snapshot));
    case "running": return withStagedRequest(services, intentId, await composeRunning(services, state, intentId, snapshot));
    case "triage": return withStagedRequest(services, intentId, await composeTriage(services, state, intentId, snapshot));
    case "counter-review": return withStagedRequest(services, intentId, await composeCounterReview(services, state, intentId, snapshot));
    case "gate": return withStagedRequest(services, intentId, await composeGate(services, state, intentId, snapshot));
    case "waiver": return withStagedRequest(services, intentId, await composeWaiver(services, state, intentId, snapshot));
    case "advance": return withStagedRequest(services, intentId, await composeAdvance(services, state, intentId));
    case "restart": return withStagedRequest(services, intentId, await composePlanningRestart(services, state, intentId, snapshot));
    default:
      throw new TypeError(`build-request kind ${JSON.stringify(kind)} is not recognized; expected ${PAYLOAD_SHAPE}`);
  }
}
