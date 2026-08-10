import { canonicalJsonDigest } from "../contracts/canonical.js";
import { parseConfigYaml } from "../contracts/config.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId } from "../contracts/evidence.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { parseReviewEvidence } from "../contracts/review.js";
import { parseRubricV1 } from "../contracts/rubric.js";
import { parseTriageCandidate, type TriageDisposition } from "../contracts/triage.js";
import { PIPELINE_STEPS, type PipelineStep } from "../contracts/vocabulary.js";
import { resolveDispatchRoute } from "../dispatch/routing.js";
import { stageTaskInitialization } from "../init/task-initialization.js";
import { buildDocumentArtifact, type DocumentArtifactInput } from "../state/document-artifact.js";
import { deriveCurrentEvidenceSet, loadRetainedEvidence } from "../state/evidence-results.js";
import { buildImplementationOutput, type ImplementationOutputInput } from "../state/implementation-manifest.js";
import {
  phaseDocumentDefaults,
  phaseImplParentDocumentDefaults,
  phaseReviewPaths,
} from "../state/phase-documents.js";
import { loadCurrentProduceSubject } from "../state/produce-subject.js";
import type { ProductionServices } from "../state/production.js";
import { APPROVAL_ARTIFACT_KINDS } from "../state/request-templates.js";
import { buildCommitAuthorizationInput, currentTargetRef } from "../state/status.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { legalRunStepStatus } from "../state/transitions.js";
import { computeCallEnvelope, type CallEnvelope } from "./envelope.js";

const fail = <T = never>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

export const BUILD_REQUEST_KINDS = Object.freeze([
  "initialize", "produce", "running", "self-review", "triage",
  "counter-review", "adjudicate", "gate",
] as const);
export type BuildRequestKind = typeof BUILD_REQUEST_KINDS[number];

const PAYLOAD_SHAPE =
  `{"intent_id":<fresh id>,"kind"?:${BUILD_REQUEST_KINDS.map((kind) => JSON.stringify(kind)).join("|")},` +
  '"step"?:<pipeline step for kind running>,' +
  '"document"?:{...},"implementation"?:{...},' +
  '"review"?:{"rubric":<rubric object>,"findings":[...],"matched_rule_versions":[...]},' +
  '"dispositions"?:[{"finding_id":<id>,"disposition":"accepted"|"rejected","rationale":<text>,"revision_intent"?:<text>,"evidence"?:<text>,"review_evidence_digest"?:<sha256>}],' +
  '"rubric"?:<rubric object for kind counter-review>,"summary"?:<gate summary text>}';

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
    const built = await buildImplementationOutput(
      services.dependencies,
      services.authority,
      services.state!,
      {
        ...implementation,
        phase_instance: state.phase_instance,
        step: "produce",
        parent_documents: implementation.parent_documents ??
          phaseImplParentDocumentDefaults(state.phase_instance),
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
      declared_inputs: document.declared_inputs ?? defaults.declared_inputs,
      input_fingerprint: state.input_fingerprint,
    } as unknown as DocumentArtifactInput);
    if (!built.ok) return built;
    artifact = built.value as unknown as PlainJsonValue;
  }

  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: "produce",
      status: "succeeded",
      artifact,
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

async function composeSelfReview(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
  snapshot: Record<string, unknown>,
): Promise<ProjectResult<CallEnvelope>> {
  if (legalRunStepStatus(state, "self_review") !== "succeeded") {
    return transitionInvalid(state, "self_review-succeeded");
  }
  const review = record(
    snapshot.review,
    'build-request self-review facts (required: {"rubric":<rubric object>,"findings":[...],"matched_rule_versions":[...]})',
  );
  const rubric = parseRubricV1(review.rubric);
  if (review.matched_rule_versions === undefined) {
    throw new TypeError('self-review facts require "matched_rule_versions"; an empty array is the explicit value when no pinned active rule matched');
  }
  if (!Array.isArray(review.findings)) {
    throw new TypeError('self-review facts require "findings" as an array; an empty array is a valid result of actually applying the rubric');
  }
  const subject = await loadCurrentProduceSubject(services.dependencies, state);
  if (!subject.ok) return subject;

  const config = await services.dependencies.read_config(services.authority.config);
  if (config.kind !== "valid") {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: `config-${config.kind}` }));
  }
  if (config.snapshot.digest !== state.config_digest) {
    return fail(createProjectError("PINNED_CONFIG_MISMATCH", {
      expected_digest: state.config_digest,
      observed_digest: config.snapshot.digest,
    }));
  }
  const parsedConfig = parseConfigYaml(
    new TextDecoder("utf-8", { fatal: true }).decode(config.snapshot.bytes),
    "task config",
  );
  const phaseKind = decodePhaseInstance(state.phase_instance).kind;
  const producer = resolveDispatchRoute(parsedConfig, phaseKind, "producer", "claude");
  const selfRoute = resolveDispatchRoute(parsedConfig, phaseKind, "self-reviewer", producer.family);
  if (producer.family !== selfRoute.family) {
    throw new TypeError("producer and self-review routes must share a family");
  }

  const blockingCount = review.findings
    .filter((finding) => (finding as Record<string, unknown> | null)?.blocking === true).length;
  const verdict = blockingCount > 0 ? "fail" : review.findings.length > 0 ? "advisory" : "pass";
  const evidence = parseReviewEvidence({
    schema_version: "1",
    task_id: services.authority.task_id,
    phase_instance: state.phase_instance,
    step: "self_review",
    role: "self-review",
    subject_digest: subject.value.artifact_digest,
    input_fingerprint: state.input_fingerprint,
    rubric_digest: canonicalJsonDigest(rubric as unknown as PlainJsonValue),
    producer_family: producer.family,
    findings: review.findings,
    matched_rule_versions: review.matched_rule_versions,
    verdict,
    blocking_count: blockingCount,
    model_family: selfRoute.family,
    model: selfRoute.model,
    effort: selfRoute.effort,
    assurance: "agent-declared",
  });

  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      ...mechanicalInput(services, state, intentId),
      phase_instance: state.phase_instance,
      step: "self_review",
      status: "succeeded",
      artifact: {
        schema_version: "1",
        artifact_kind: "review-evidence",
        evidence: evidence as unknown as PlainJsonValue,
      },
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
  const loadRetainedResult = services.dependencies.load_retained_result;
  if (loadRetainedResult === undefined) throw new TypeError("retained evidence loading is unavailable");
  const loaded = await loadRetainedEvidence(
    { load_retained_result: loadRetainedResult },
    state,
    state.phase_instance,
  );
  if (!loaded.ok) return loaded;
  const derived = deriveCurrentEvidenceSet(loaded.value);

  const digestsByFindingId = new Map<string, string[]>();
  const expected = new Set<string>();
  for (const reviewRef of derived.reviews) {
    for (const finding of reviewRef.evidence.findings) {
      expected.add(`${reviewRef.evidence_digest}:${finding.finding_id}`);
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
    if (item.disposition === "accepted") {
      return {
        ...base,
        disposition: "accepted",
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
    throw new TypeError(`triage disposition for ${findingId} must set disposition "accepted" or "rejected"`);
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
    rejected_count: dispositions.length - acceptedCount,
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
  if (legalRunStepStatus(state, "counter_review") !== "succeeded") {
    return transitionInvalid(state, "counter_review-succeeded");
  }
  const rubric = parseRubricV1(snapshot.rubric);
  const paths = phaseReviewPaths(state.phase_instance);
  return computeCallEnvelope(services, {
    tool: "archflow_counter_review",
    input: {
      ...mechanicalInput(services, state, intentId),
      artifact_path: paths.artifact_path,
      rubric: rubric as unknown as PlainJsonValue,
    },
  });
}

function composeAdjudicate(
  services: ProductionServices,
  state: TaskStateV1,
  intentId: string,
): Promise<ProjectResult<CallEnvelope>> | ProjectResult<never> {
  if (legalRunStepStatus(state, "adjudicate") !== "succeeded") {
    return transitionInvalid(state, "adjudicate-succeeded");
  }
  const paths = phaseReviewPaths(state.phase_instance);
  return computeCallEnvelope(services, {
    tool: "archflow_adjudicate",
    input: {
      ...mechanicalInput(services, state, intentId),
      artifact_path: paths.artifact_path,
      upstream_paths: [...paths.upstream_paths],
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
  const phaseKind = decodePhaseInstance(state.phase_instance).kind;
  const gateKind = phaseKind === "phase-impl" ? "commit-authorization" : "artifact-approval";
  if (state.terminal !== undefined || state.open_gate !== undefined) {
    return transitionInvalid(state, `${gateKind}-gate`);
  }
  const subject = await loadCurrentProduceSubject(services.dependencies, state);
  if (!subject.ok) return subject;
  const loadRetainedResult = services.dependencies.load_retained_result;
  if (loadRetainedResult === undefined) throw new TypeError("retained evidence loading is unavailable");
  const loaded = await loadRetainedEvidence(
    { load_retained_result: loadRetainedResult },
    state,
    state.phase_instance,
  );
  if (!loaded.ok) return loaded;
  const derived = deriveCurrentEvidenceSet(loaded.value);

  let input: Record<string, PlainJsonValue>;
  if (gateKind === "commit-authorization") {
    const target = await currentTargetRef(services.dependencies);
    const authorization = buildCommitAuthorizationInput(subject.value, derived.current_evidence_set, target);
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
  return computeCallEnvelope(services, { tool: "archflow_gate", input });
}

/**
 * Composes a complete, fingerprint-resolved tool request from durable state plus the caller's
 * judgment content. Every kind derives its mechanical fields — phase, revision, digests, slot
 * order, provenance, counts — from the same authorities the server checks against, guards the
 * targeted transition with the server's own movement rules, and resolves the whole request
 * through the call envelope, so `request.input` is the finished tool call with nothing left to
 * transcribe. Judgment content is never drafted here: findings, dispositions, rationales,
 * rubric bodies, and gate summaries come only from the payload. Kind "initialize" is the one
 * request composed without durable state — it stages the initialization artifact itself and is
 * refused once state exists.
 */
export async function runBuildRequest(
  services: ProductionServices,
  value: PlainJsonValue,
): Promise<ProjectResult<CallEnvelope>> {
  assertPlainJson(value, "build-request input");
  const snapshot = record(structuredClone(value), "build-request input");
  const intentId = parsePathSafeId(String(snapshot.intent_id ?? ""));
  const kind = snapshot.kind === undefined ? "produce" : String(snapshot.kind);
  if (kind === "initialize") {
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
    case "produce": return composeProduce(services, state, intentId, snapshot);
    case "running": return composeRunning(services, state, intentId, snapshot);
    case "self-review": return composeSelfReview(services, state, intentId, snapshot);
    case "triage": return composeTriage(services, state, intentId, snapshot);
    case "counter-review": return composeCounterReview(services, state, intentId, snapshot);
    case "adjudicate": return composeAdjudicate(services, state, intentId);
    case "gate": return composeGate(services, state, intentId, snapshot);
    default:
      throw new TypeError(`build-request kind ${JSON.stringify(kind)} is not recognized; expected ${PAYLOAD_SHAPE}`);
  }
}
