import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId, type PathSafeId } from "../contracts/evidence.js";
import { parseConfigYaml } from "../contracts/config.js";
import type { ApprovalTrigger, DesignPolicyFinding, EligibleWaiver, GateContext } from "../contracts/gates.js";
import {
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  toRepositoryPathClaim,
  type RepositoryPathClaim,
} from "../contracts/path-claims.js";
import { decodePhaseInstance, isStrictlyEarlierPlanningPhase } from "../contracts/phase-instance.js";
import { parseWorkflowInvocationV1 } from "../contracts/semantic-workflow.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { parseTriageCandidate, type TriageDisposition } from "../contracts/triage.js";
import { PIPELINE_STEPS, type PipelineStep } from "../contracts/vocabulary.js";
import { parseDocumentArtifact } from "../contracts/durable-document.js";
import { stageTaskInitialization } from "../init/task-initialization.js";
import { readChangedGitPaths, resolveCommit } from "../repository/git.js";
import { buildDocumentArtifact, type DocumentArtifactInput } from "./document-artifact.js";
import {
  deriveCurrentEvidenceSet,
  derivePendingEditorialPredecessor,
  loadRetainedEvidence,
  type RetainedEvidenceSet,
} from "./evidence-results.js";
import { buildImplementationOutput, type ImplementationOutputInput } from "./implementation-manifest.js";
import {
  phaseDocumentDefaults,
  phaseImplParentDocumentDefaults,
  phaseReviewPaths,
  planningRestartAskBaseDigest,
  type PhaseImplParentDocument,
} from "./phase-documents.js";
import { loadCurrentProduceSubject, type CurrentProduceSubject } from "./produce-subject.js";
import { reconcileCurrentAuthority } from "./reconciliation.js";
import { discoverReconciliationInput } from "./reconciliation-discovery.js";
import { canonicalDocument } from "../contracts/canonical.js";
import type { ProductionServices } from "./production.js";
import { authenticateRuleAcceptancePolicy, resolvePinnedConstitution } from "./constitution.js";
import {
  assertAuthenticatedGateDecisionArchive,
  loadAuthenticatedGateApproval,
  loadAuthenticatedGateDecisionArchive,
  type AuthenticatedGateApproval,
  type AuthenticatedGateDecisionArchive,
} from "./gate-approvals.js";
import { loadLegacyImportInitialization } from "./legacy-import-resume.js";
/** The artifact-kind each planning phase's artifact-approval gate approves. */
export const APPROVAL_ARTIFACT_KINDS = {
  "prd": "prd",
  "design": "design",
  "phase-design": "phase-design",
  "phase-impl": "phase-implementation",
} as const;
import { baselineAdoptionInputFromFindings, buildCommitAuthorizationInput, buildDesignApprovalInput, buildSecondaryCommitAuthorizationFacts, computeTaskStatus, currentApprovedUpstreams, currentBaselineTargetFacts, currentReviewPredecessor, currentTargetRef, pendingAdjudicationGate } from "./status.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { legalRunStepStatus } from "./transitions.js";
import {
  acceptedNoWaitSettlement,
  authenticatedApprovalIsEligibleAfterLatestRestart,
  latestEligibleRuleSettlement,
  matchingOrdinaryApproval,
} from "./restart-authority.js";
import { assessCurrentEvidence, DEFAULT_MAX_ATTEMPTS } from "../review/fixed-point.js";
import { designApprovalPolicyContext } from "../review/adjudication.js";
import { computeCallEnvelope, type CallEnvelope } from "../local/call-envelope.js";
import { planningRestartTarget, semanticPlanningRestartId } from "./planning-restart.js";
import { resolveTaskPath } from "../repository/paths.js";
import { derivePendingWaiverRequest } from "./pending-waiver.js";
import { approvalRuleGateSummary } from "./approval-rules.js";
import type { ConfigV1, RepositoryName } from "../contracts/config.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

export const BUILD_REQUEST_KINDS = Object.freeze([
  "initialize", "produce", "failed", "running", "triage",
  "counter-review", "gate", "advance", "planning-restart", "waiver",
  "refresh-milestone-baseline",
  "recover-milestone-authority", "recover-approval-trigger-authority", "refresh-stale-baseline",
] as const);
export type BuildRequestKind = typeof BUILD_REQUEST_KINDS[number];

const PAYLOAD_SHAPE =
  `{"intent_id"?:<id; omitted = generated>,"kind"?:${BUILD_REQUEST_KINDS.map((kind) => JSON.stringify(kind)).join("|")},` +
  '"step"?:<pipeline step for kind running>,' +
  '"document"?:{...},"implementation"?:{...},' +
  '"human_revision"?:{"classification":"simple"|"significant","rationale":<text>,"user_override"?:{"agent_classification":"simple"|"significant","rationale":<text>}},' +
  '"dispositions"?:[{"finding_id":<id>,"disposition":"accepted"|"accepted-editorial"|"rejected","rationale":<text>,"revision_intent"?:<text>,"evidence"?:<text>,"review_evidence_digest"?:<sha256>}],' +
  '"summary"?:<gate summary text>,' +
  '"invocation_routes"?:{"counter-reviewer"?:{"model":<model>,"effort":<effort>,"provider"?:<cc-switch provider>},"adjudicator"?:{...}},' +
  '"route_override"?:{"reason":<why the pinned reviewer was substituted>,"counter-reviewer"?:{"model":<model>,"effort":<effort>,"provider"?:<cc-switch provider>},"adjudicator"?:{...}},' +
  '"origin"?:<waiver origin>,"rationale"?:<waiver rationale>}';

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object; expected ${PAYLOAD_SHAPE}`);
  }
  return value as Record<string, unknown>;
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

type ComposedImplementationRepository = Readonly<{
  name: RepositoryName;
  base_commit: string;
  outputs: readonly RepositoryPathClaim[];
  restore_targets: readonly RepositoryPathClaim[];
  declared_inputs: readonly Readonly<{ input_id: string; path: RepositoryPathClaim }>[];
}>;

function refusesSecondaryArchflow(path: RepositoryPathClaim): boolean {
  return path === ".archflow" || path.startsWith(".archflow/");
}

function parseImplementationDeclaredInputs(
  value: unknown,
  label: string,
): readonly Readonly<{ input_id: string; path: RepositoryPathClaim }>[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((candidate, index) => {
    const input = record(candidate, `${label} ${index}`);
    const inputId = String(input.input_id ?? "");
    if (inputId.trim() === "") throw new TypeError(`${label} ${index} input_id must be non-empty`);
    return Object.freeze({ input_id: inputId, path: parseRepositoryPathClaim(input.path) });
  });
}

function parseImplementationRepositories(
  value: unknown,
  config: ConfigV1,
  primaryInputs: readonly Readonly<{ input_id: string }>[] ,
): readonly ComposedImplementationRepository[] {
  const configured = config.repositories ?? {};
  const writableNames = Object.entries(configured)
    .filter(([, declaration]) => declaration.mode === "writable")
    .map(([name]) => name)
    .sort(ordinal);
  const candidates = value === undefined ? [] : value;
  if (!Array.isArray(candidates)) throw new TypeError("implementation repositories must be an array");
  const seenIds = new Set<string>();
  for (const input of primaryInputs) {
    if (seenIds.has(input.input_id)) throw new TypeError(`implementation declared input_id ${input.input_id} must be unique across repositories`);
    seenIds.add(input.input_id);
  }
  const sections = candidates.map((candidate, index): ComposedImplementationRepository => {
    const section = record(candidate, `implementation repository ${index}`);
    const name = String(section.name ?? "") as RepositoryName;
    const declaration = configured[name];
    if (declaration === undefined) throw new TypeError(`implementation repository ${name || "(empty)"} is not configured`);
    if (declaration.mode !== "writable") throw new TypeError(`implementation repository ${name} is context-only, not writable`);
    const outputs = implementationPathList(section.outputs, `repositories.${name}.outputs`);
    const restoreTargets = implementationPathList(section.restore_targets, `repositories.${name}.restore_targets`);
    const declaredInputs = parseImplementationDeclaredInputs(section.declared_inputs, `implementation repositories.${name}.declared_inputs`);
    for (const path of [...outputs, ...restoreTargets, ...declaredInputs.map((input) => input.path)]) {
      if (refusesSecondaryArchflow(path)) throw new TypeError(`implementation repository ${name} may not claim .archflow paths`);
    }
    for (const input of declaredInputs) {
      if (seenIds.has(input.input_id)) throw new TypeError(`implementation declared input_id ${input.input_id} must be unique across repositories`);
      seenIds.add(input.input_id);
    }
    return Object.freeze({
      name,
      base_commit: String(section.base_commit ?? ""),
      outputs: Object.freeze(outputs),
      restore_targets: Object.freeze(restoreTargets),
      declared_inputs: Object.freeze(declaredInputs),
    });
  });
  if (sections.some((section) => section.base_commit.trim() === "")) {
    throw new TypeError("implementation repository base_commit must be non-empty");
  }
  const actualNames = sections.map((section) => section.name);
  if (actualNames.some((name, index) => index > 0 && actualNames[index - 1]! >= name)) {
    throw new TypeError("implementation repositories must be sorted by name with no duplicates");
  }
  if (actualNames.length !== writableNames.length || actualNames.some((name, index) => name !== writableNames[index])) {
    const missing = writableNames.filter((name) => !actualNames.includes(name));
    const extra = actualNames.filter((name) => !writableNames.includes(name));
    throw new TypeError(`implementation repositories must cover every writable secondary exactly (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }
  return Object.freeze(sections);
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

function transitionInvalid(state: TaskStateV1, to: string): ProjectResult<never> {
  return fail(createProjectError("TRANSITION_INVALID", {
    phase_instance: state.phase_instance,
    from: `${state.step}-${state.status}`,
    to,
  }));
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
    const configRead = await services.dependencies.read_config(services.authority.config);
    if (configRead.kind !== "valid") throw new TypeError("task config is unavailable for implementation repository validation");
    const liveConfig = parseConfigYaml(new TextDecoder("utf-8", { fatal: true }).decode(configRead.snapshot.bytes), "task config");
    const primaryDeclaredInputs = parseImplementationDeclaredInputs(implementation.declared_inputs ?? [], "implementation declared_inputs");
    const repositories = parseImplementationRepositories(implementation.repositories, liveConfig, primaryDeclaredInputs);
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
        declared_inputs: primaryDeclaredInputs,
        repositories,
        input_fingerprint: state.input_fingerprint,
      } as unknown as ImplementationOutputInput,
      services.repository_set,
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

function composeFailedProduce(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
): Promise<ProjectResult<CallEnvelope>> | ProjectResult<never> {
  if (state.terminal !== undefined || state.open_gate !== undefined ||
      state.step !== "produce" || state.status !== "running") {
    return transitionInvalid(state, "produce-failed");
  }
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: "produce",
      status: "failed",
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
  const invocationRoutes = snapshot.invocation_routes === undefined
    ? undefined
    : structuredClone(record(snapshot.invocation_routes, "build-request counter-review invocation_routes")) as PlainJsonValue;
  // A route override is a human decision passed straight through: the server validates it against
  // the same rules as a pinned route, so this only refuses a shape that is not an object at all.
  const routeOverride = snapshot.route_override === undefined
    ? undefined
    : structuredClone(record(snapshot.route_override, "build-request counter-review route_override")) as PlainJsonValue;
  const paths = phaseReviewPaths(state.phase_instance);
  return computeCallEnvelope(services, {
    tool: "archflow_counter_review",
    input: {
      ...mechanicalInput(services, state, intentId),
      artifact_path: paths.artifact_path,
      ...(invocationRoutes === undefined ? {} : { invocation_routes: invocationRoutes }),
      ...(routeOverride === undefined ? {} : { route_override: routeOverride }),
    },
  });
}

type OrdinaryPolicyFacts = Readonly<{
  constitution: "pass" | "fail" | "uncertain";
  policy_findings: readonly DesignPolicyFinding[];
  eligible_waivers: readonly EligibleWaiver[];
}>;

function ordinaryPolicyFacts(retained: RetainedEvidenceSet): OrdinaryPolicyFacts {
  const source = retained.get("adjudicate")?.manifest.source_artifact;
  if (source === undefined) {
    return Object.freeze({
      constitution: "pass",
      policy_findings: Object.freeze([]),
      eligible_waivers: Object.freeze([]),
    });
  }
  if (source.artifact_kind !== "adjudication-evidence") {
    throw new TypeError("retained adjudication result has the wrong artifact kind");
  }
  return designApprovalPolicyContext(source.evidence);
}

function archivedPresentationClass(
  archive: AuthenticatedGateDecisionArchive,
): "configured-approval" | "exception" {
  assertAuthenticatedGateDecisionArchive(archive);
  const context = archive.request.context;
  if (!("approval_trigger" in context) || !("policy_findings" in context)) return "exception";
  if (context.policy_findings.some((finding) =>
    finding.compliance !== "pass" || finding.trigger !== "not-matched")) return "exception";
  const trigger = context.approval_trigger;
  if (trigger.kind === "human-revision-reapproval") return trigger.prior_gate.class;
  return trigger.rule_authority === "unavailable" ? "exception" : "configured-approval";
}

async function simpleRevisionApprovalTrigger(
  services: ProductionServices,
  state: TaskStateV1,
  subject: CurrentProduceSubject,
): Promise<ApprovalTrigger | undefined> {
  const revision = [...(state.human_revision_history ?? [])]
    .filter((candidate) =>
      candidate.phase_instance === state.phase_instance &&
      candidate.classification === "simple" &&
      candidate.resulting_subject_digest === subject.artifact_digest &&
      candidate.resulting_result_digest === subject.reference.result_digest)
    .sort((left, right) => right.resulting_attempt - left.resulting_attempt)[0];
  if (revision === undefined) return undefined;
  const archive = await loadAuthenticatedGateDecisionArchive(
    services.dependencies, services.authority, revision.gate_id,
  );
  if (!archive.ok) throw new TypeError("simple revision prior gate archive is unavailable");
  assertAuthenticatedGateDecisionArchive(archive.value);
  if (
    archive.value.request.phase_instance !== state.phase_instance ||
    archive.value.request.kind !== revision.gate_kind ||
    archive.value.request.subject_digest !== revision.predecessor_subject_digest ||
    archive.value.decision.envelope.payload.decision !== "revise"
  ) throw new TypeError("simple revision prior gate archive does not bind the revision record");
  return Object.freeze({
    kind: "human-revision-reapproval",
    prior_gate: Object.freeze({
      gate_id: revision.gate_id,
      decision_digest: archive.value.decision_digest,
      class: archivedPresentationClass(archive.value),
    }),
    revision_checkpoint: Object.freeze({
      classification: "simple",
      predecessor_subject_digest: revision.predecessor_subject_digest,
      subject_digest: revision.resulting_subject_digest,
    }),
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
  // Baseline adoption composes ahead of the phase's own approval gates: reconciliation blocking is
  // ahead of them in status routing too, so an approval composed past unresolved drift could never
  // resolve honestly. Mid-produce drift is expected producer work and never composes this gate.
  if (state.step !== "produce" || state.status === "succeeded") {
    const discovered = await discoverReconciliationInput(services.dependencies, services.authority, canonicalDocument(state), services.repository_set);
    if (!discovered.ok) return discovered;
    const drift = reconcileCurrentAuthority(discovered.value);
    if (drift.classification === "reconciliation-required") {
      const target = await currentBaselineTargetFacts(services.dependencies, drift.findings, services.repository_set);
      const adoption = baselineAdoptionInputFromFindings(
        services.authority.task_id, state, drift.findings, target,
      );
      if (adoption !== undefined) {
        // A restore that can never apply is refused later, before the human decision is archived:
        // the decided interface is immutable, so recording it would wedge the gate behind an
        // unapplicable decision. Adoption-sourced drift has no retained manifest to restore from.
        return computeCallEnvelope(services, {
          tool: "archflow_gate",
          input: {
            ...mechanicalInput(services, state, intentId),
            phase_instance: state.phase_instance,
            summary,
            subject_digest: adoption.subject_digest,
            current_evidence: adoption.current_evidence as unknown as PlainJsonValue,
            kind: "baseline-adoption",
            context: adoption.context as unknown as PlainJsonValue,
          },
        });
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
  const editorialPredecessorDigest = subject.value.artifact.artifact_kind === "document"
    ? subject.value.artifact.editorial_predecessor?.subject_digest
    : undefined;
  const settledRule = latestEligibleRuleSettlement(
    state, subject.value.artifact_digest, state.phase_instance,
  ) ?? (editorialPredecessorDigest === undefined
    ? undefined
    : latestEligibleRuleSettlement(state, editorialPredecessorDigest, state.phase_instance));
  const approvalSummary = settledRule?.conclusion.wait === true
    ? approvalRuleGateSummary(summary, settledRule.conclusion.match)
    : summary;
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
  let exhaustion: Readonly<{ attempts: number; maximum_attempts: number }> | undefined;
  // The same eligibility filter status applies: an approval superseded by a later planning
  // restart must not make the composer disagree with the advertised action.
  const authenticated: AuthenticatedGateApproval[] = [];
  for (const approval of state.approvals) {
    const loadedApproval = await loadAuthenticatedGateApproval(
      services.dependencies, services.authority, approval,
    );
    if (!loadedApproval.ok) return loadedApproval;
    if (!authenticatedApprovalIsEligibleAfterLatestRestart(state, loadedApproval.value)) continue;
    authenticated.push(loadedApproval.value);
  }
  if (constitution.ok) {
    pendingGate = pendingAdjudicationGate(state, constitution.value, loaded.value, authenticated);
    // The attempts-exhausted gate composes exactly when the fixed point says the budget is spent;
    // deriving the kind from the phase alone would open the phase-default gate instead. The
    // assessor sees the same subject facts status derives — including the shared review
    // predecessor, without which one-hop simple-revision states would assess differently here —
    // so the composed request and the advertised action cannot disagree about exhaustion.
    try {
      const configRead = await services.dependencies.read_config(services.authority.config);
      const configured = configRead.kind === "valid"
        ? parseConfigYaml(new TextDecoder("utf-8", { fatal: true }).decode(configRead.snapshot.bytes), "task config").max_attempts
        : undefined;
      const approvedUpstreams = await currentApprovedUpstreams(
        services.dependencies, services.authority, state, authenticated, subject.value,
      );
      const predecessor = currentReviewPredecessor(state, subject.value);
      const assessment = assessCurrentEvidence(state, loaded.value, {
        subject_digest: subject.value.artifact_digest,
        input_fingerprint: state.input_fingerprint,
        constitution: constitution.value,
        approved_upstream_digests: approvedUpstreams,
        authenticated_gate_approvals: authenticated,
        ...(predecessor === undefined ? {} : { review_predecessor: predecessor }),
        ...(configured === undefined ? {} : { max_attempts: configured }),
      });
      if (assessment.next === "attempts-exhausted") {
        exhaustion = Object.freeze({ attempts: state.attempt, maximum_attempts: configured ?? DEFAULT_MAX_ATTEMPTS });
      }
    } catch {
      return transitionInvalid(state, "gate-fixed-point-disagreement");
    }
  }

  // The migration-audit gate composes from the same legacy import authority status derives the
  // advertised `migration_audit_required` fact from: the design phase of a legacy import with no
  // accepted audit yet, ahead of the phase-default design-approval gate. Every context field is
  // mechanical — only the summary is authored.
  const legacyInitialization = await loadLegacyImportInitialization(services.dependencies, services.authority, state);
  const migrationAuditRequired = legacyInitialization.ok &&
    legacyInitialization.value !== undefined && state.phase_instance === "design" &&
    !authenticated.some((approval) =>
      approval.request.kind === "migration-audit" &&
      approval.decision.envelope.payload.decision === "accept-import-audit");
  let migrationAuditContext: GateContext<"migration-audit"> | undefined;
  if (migrationAuditRequired) {
    const initialization = legacyInitialization.value;
    migrationAuditContext = initialization !== undefined &&
      initialization.resume_phase !== undefined &&
      initialization.planned_final_phase !== undefined &&
      initialization.target_ref !== undefined &&
      initialization.commit_message !== undefined
      ? Object.freeze({
          source_identity_digest: initialization.source_identity_digest,
          destination_identity_digest: services.authority.task_identity_digest,
          import_digest: initialization.import_digest,
          code_baseline_digest: canonicalJsonDigest({ schema_version: "1", digest_kind: "code-baseline-commit", commit: initialization.code_baseline_commit }),
          policy_baseline_digest: canonicalJsonDigest({ schema_version: "1", digest_kind: "policy-base-commit", commit: initialization.policy_base_commit }),
          resume_phase: initialization.resume_phase,
          planned_final_phase: initialization.planned_final_phase,
          imported_documents: Object.freeze(initialization.mapping.map((entry) => Object.freeze({
            path: entry.destination_path,
            content_digest: initialization.staged_payload_refs.find((reference) => reference.legacy_path === entry.legacy_path)!.digest,
          })).sort((left, right) => left.path.localeCompare(right.path))),
          target_ref: initialization.target_ref,
          baseline_commit: initialization.code_baseline_commit,
          commit_message: initialization.commit_message,
        })
      : undefined;
    if (migrationAuditContext === undefined) return transitionInvalid(state, "migration-audit-gate");
  }
  const settlementPolicy = constitution.ok
    ? authenticateRuleAcceptancePolicy(state, constitution.value)
    : undefined;
  const policyFacts = ordinaryPolicyFacts(loaded.value);
  const simpleTrigger = await simpleRevisionApprovalTrigger(services, state, subject.value);
  const approvalTrigger: ApprovalTrigger | undefined = simpleTrigger ?? (settledRule === undefined
    ? undefined
    : Object.freeze({
        kind: "rule-settlement" as const,
        settlement: Object.freeze({
          subject_digest: settledRule.subject_digest,
          config_digest: settledRule.config_digest,
          settled_at_revision: settledRule.settled_at_revision,
        }),
        conclusion: settledRule.conclusion,
        rule_authority: settlementPolicy === undefined ? "unavailable" as const : "authenticated" as const,
      }));
  const ordinaryApproved = matchingOrdinaryApproval(
    state, authenticated, subject.value.artifact_digest, state.phase_instance,
  ) !== undefined;
  const acceptedSettlement = settlementPolicy === undefined
    ? undefined
    : acceptedNoWaitSettlement(
      settlementPolicy,
      state,
      subject.value.artifact_digest,
      subject.value.artifact.phase_instance,
    );

  let input: Record<string, PlainJsonValue>;
  if (exhaustion !== undefined) {
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary,
      subject_digest: subject.value.artifact_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: "attempts-exhausted",
      context: { ...exhaustion, step: state.step },
    };
  } else if (pendingGate !== undefined && pendingGate.kind !== "constitution-review") {
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary,
      subject_digest: pendingGate.subject_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: pendingGate.kind,
      context: pendingGate.context as unknown as PlainJsonValue,
    };
  } else if (migrationAuditRequired) {
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary,
      subject_digest: subject.value.artifact_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: "migration-audit",
      context: migrationAuditContext as unknown as PlainJsonValue,
    };
  } else if (
    acceptedSettlement !== undefined && !ordinaryApproved &&
    simpleTrigger === undefined && editorialPredecessorDigest === undefined && pendingGate === undefined
  ) {
    // Every exception gate above remains human-only. Only the now-unnecessary ordinary phase gate
    // is refused when the exact reviewed no-wait settlement already supplies advancement authority.
    return transitionInvalid(state, `${gateKind}-gate-not-required`);
  } else if (gateKind === "design-approval") {
    if (approvalTrigger === undefined) return transitionInvalid(state, "approval-trigger-authority-missing");
    const target = await currentTargetRef(services.dependencies);
    const approval = await buildDesignApprovalInput(services.dependencies, state, loaded.value, target);
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary: approvalSummary,
      subject_digest: subject.value.artifact_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: "design-approval",
      context: { ...approval.context, ...policyFacts, approval_trigger: approvalTrigger } as unknown as PlainJsonValue,
    };
  } else if (gateKind === "commit-authorization") {
    if (approvalTrigger === undefined) return transitionInvalid(state, "approval-trigger-authority-missing");
    const target = await currentTargetRef(services.dependencies);
    const secondarySections = subject.value.artifact.artifact_kind === "implementation-output"
      ? subject.value.artifact.secondary_repositories ?? []
      : [];
    if (secondarySections.some((section) => section.outputs.length > 0) && services.repository_set === undefined) {
      throw new TypeError("commit authorization requires the authenticated repository set");
    }
    const secondaryCommits = services.repository_set === undefined || subject.value.artifact.artifact_kind !== "implementation-output"
      ? Object.freeze([])
      : await buildSecondaryCommitAuthorizationFacts(subject.value.artifact, services.repository_set);
    const authorization = buildCommitAuthorizationInput(
      subject.value,
      derived.current_evidence_set,
      target,
      await resolveCommit(services.runner, "HEAD"),
      secondaryCommits,
    );
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary: approvalSummary,
      subject_digest: authorization.subject_digest,
      current_evidence: authorization.current_evidence as unknown as PlainJsonValue,
      kind: "commit-authorization",
      context: { ...authorization.context, ...policyFacts, approval_trigger: approvalTrigger } as unknown as PlainJsonValue,
    };
  } else {
    if (approvalTrigger === undefined) return transitionInvalid(state, "approval-trigger-authority-missing");
    input = {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      summary: approvalSummary,
      subject_digest: subject.value.artifact_digest,
      current_evidence: derived.current_evidence_set as unknown as PlainJsonValue,
      kind: "artifact-approval",
      context: {
        artifact_kind: APPROVAL_ARTIFACT_KINDS[phaseKind],
        ...policyFacts,
        approval_trigger: approvalTrigger,
      },
    };
  }
  return computeCallEnvelope(services, { tool: "archflow_gate", input });
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

/** Composes the input-free, server-proven refresh of an unchanged design settlement baseline. */
async function composeRefreshMilestoneBaseline(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
): Promise<ProjectResult<CallEnvelope>> {
  const computed = await computeTaskStatus(services.dependencies, services.authority);
  if (!computed.ok) return computed;
  if (computed.value.next_action.code !== "refresh-milestone-baseline" ||
      computed.value.revision !== state.revision) {
    return transitionInvalid(state, "refresh-milestone-baseline");
  }
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: state.step,
      status: state.status,
      operation: "refresh_milestone_baseline",
    },
  });
}

async function composeMilestoneRecoveryAction(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  code: "recover-milestone-authority" | "recover-approval-trigger-authority" | "refresh-stale-baseline",
  operation: "recover_milestone_authority" | "recover_approval_trigger_authority" | "refresh_stale_baseline",
): Promise<ProjectResult<CallEnvelope>> {
  const computed = await computeTaskStatus(services.dependencies, services.authority);
  if (!computed.ok) return computed;
  if (computed.value.next_action.code !== code || computed.value.revision !== state.revision) {
    return transitionInvalid(state, code);
  }
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: state.step,
      status: state.status,
      operation,
    },
  });
}

export async function composePlanningRestartRequest(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> {
  const invocation = parseWorkflowInvocationV1(snapshot.invocation);
  const target = planningRestartTarget(invocation);
  const reason = String(snapshot.reason ?? "");
  if (reason.trim() === "") throw new TypeError("planning-restart requires the exact non-empty human reason");
  if (state.terminal !== undefined || state.open_gate !== undefined ||
      !isStrictlyEarlierPlanningPhase(target, state.phase_instance)) {
    return transitionInvalid(state, "planning-restart");
  }
  let askBaseDigest: ReturnType<typeof sha256Bytes> | undefined;
  if (target === "prd") {
    const ask = await resolveTaskPath({
      runner: services.runner, taskId: services.authority.task_id,
      claim: parseTaskPathClaim("ask.md"), expectedClass: "task-ask", context: services.authority.context,
    });
    if (!ask.ok) return ask;
    try {
      const askBytes = new Uint8Array(await readFile(ask.value.absolute));
      const semanticRestartId = semanticPlanningRestartId(intentId);
      askBaseDigest = semanticRestartId === undefined
        ? sha256Bytes(askBytes)
        : planningRestartAskBaseDigest(askBytes, semanticRestartId, reason);
    }
    catch { return fail(createProjectError("IO_ERROR", { operation: "planning-restart-ask-read", attempt: state.attempt })); }
  }
  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: "produce",
      status: "running",
      operation: "planning_restart",
      target_phase_instance: target,
      reason,
      ...(askBaseDigest === undefined ? {} : { ask_base_digest: askBaseDigest }),
    },
  });
}

export async function composePendingWaiverRequest(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> {
  if (state.terminal !== undefined || state.open_gate !== undefined) {
    return transitionInvalid(state, "waiver-gate");
  }
  const pending = await derivePendingWaiverRequest(services);
  if (!pending.ok) return pending;
  return computeCallEnvelope(services, { tool: "archflow_waiver", input: {
    ...mechanicalInput(services, state, intentId),
    origin: pending.value.origin as unknown as PlainJsonValue,
    rationale: pending.value.rationale,
  } });
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

export type ComposedRequest = Readonly<{
  envelope: CallEnvelope;
  intent_id: PathSafeId;
}>;

export async function composeRequest(
  services: ProductionServices,
  value: PlainJsonValue,
): Promise<ProjectResult<ComposedRequest>> {
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
    const composed = services.state === undefined
      ? await composeInitialize(services, intentId)
      : transitionInvalid(services.state.value, "initialize");
    return composed.ok
      ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId }))
      : composed;
  }
  if (services.state === undefined) {
    return fail(createProjectError("STATE_MISSING", {
      phase_instance: services.authority.context.phase_instance,
    }));
  }
  const state = services.state.value;

  switch (kind) {
    case "produce": {
      const composed = await composeProduce(services, state, intentId, snapshot);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "failed": {
      const composed = await composeFailedProduce(services, state, intentId);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "running": {
      const composed = await composeRunning(services, state, intentId, snapshot);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "triage": {
      const composed = await composeTriage(services, state, intentId, snapshot);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "counter-review": {
      const composed = await composeCounterReview(services, state, intentId, snapshot);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "gate": {
      const composed = await composeGate(services, state, intentId, snapshot);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "advance": {
      const composed = await composeAdvance(services, state, intentId);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "planning-restart": {
      const composed = await composePlanningRestartRequest(services, state, intentId, snapshot);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "waiver": {
      const composed = await composePendingWaiverRequest(services, state, intentId, snapshot);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "refresh-milestone-baseline": {
      const composed = await composeRefreshMilestoneBaseline(services, state, intentId);
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "recover-milestone-authority": {
      const composed = await composeMilestoneRecoveryAction(
        services, state, intentId, "recover-milestone-authority", "recover_milestone_authority",
      );
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "recover-approval-trigger-authority": {
      const composed = await composeMilestoneRecoveryAction(
        services, state, intentId, "recover-approval-trigger-authority", "recover_approval_trigger_authority",
      );
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    case "refresh-stale-baseline": {
      const composed = await composeMilestoneRecoveryAction(
        services, state, intentId, "refresh-stale-baseline", "refresh_stale_baseline",
      );
      return composed.ok ? ok(Object.freeze({ envelope: composed.value, intent_id: intentId })) : composed;
    }
    default:
      throw new TypeError(`build-request kind ${JSON.stringify(kind)} is not recognized; expected ${PAYLOAD_SHAPE}`);
  }
}
