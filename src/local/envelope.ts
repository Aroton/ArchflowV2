import { readFile } from "node:fs/promises";

import { canonicalJsonDigest, parseCanonicalDocument } from "../contracts/canonical.js";
import { parseGateRequest, type GateRequestV1, type WaiverGateContext } from "../contracts/durable-gate.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { computeGateContextDigest, computeGateId, computeInputFingerprint } from "../contracts/fingerprints.js";
import { parseToolCall, type ParsedToolCall } from "../contracts/mcp-tools.js";
import { parseTaskPathClaim, type TaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import type { ModelFamily } from "../contracts/review.js";
import { isToolName, type ToolName } from "../contracts/tool-names.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import { gateCounterReviewClaim, gateDecisionClaim, gateRequestClaim, resolveTaskPath } from "../repository/paths.js";
import { identifyStateInitialization } from "../state/initialization.js";
import type { ProductionServices } from "../state/production.js";
import { identifyTransactionRequest } from "../state/request.js";

export type GateCounterPromptInput = Readonly<{
  tool: "archflow_gate" | "archflow_waiver";
  gate_id: PathSafeId;
  request_digest: Sha256Digest;
  task_id: GateRequestV1["task_id"];
  phase_instance: GateRequestV1["phase_instance"];
  kind: GateRequestV1["kind"];
  subject_digest: Sha256Digest;
  context_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
  current_evidence: CurrentEvidenceSetRef;
}>;

export type CallEnvelope = Readonly<{
  tool: ToolName;
  input_fingerprint: Sha256Digest;
  request_digest: Sha256Digest;
  artifact_digest?: Sha256Digest;
  gate?: Readonly<{
    gate_id: PathSafeId;
    decision_path: TaskPathClaim;
    archive_decision_path: TaskPathClaim;
    request_path: TaskPathClaim;
    gate_counter_review_path: TaskPathClaim;
    counter_review_prompt: string;
  }>;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

function configuredProducerFamily(currentEvidence: CurrentEvidenceSetRef): ModelFamily {
  const families = new Set(currentEvidence.slots.map((slot) => slot.producer_family));
  if (families.size !== 1) throw new TypeError("gate evidence must name one configured producer family");
  const family = families.values().next().value;
  if (family !== "claude" && family !== "codex") throw new TypeError("gate evidence producer family is invalid");
  return family;
}

/** Renders the complete hand-off needed to create and install optional REQ-41 gate evidence. */
export function renderGateCounterPrompt(input: GateCounterPromptInput): string {
  assertPlainJson(input, "gate counter-review prompt input");
  const snapshot = structuredClone(input);
  const producerFamily = configuredProducerFamily(snapshot.current_evidence);
  const reviewerFamily: ModelFamily = producerFamily === "claude" ? "codex" : "claude";
  const retryTool = snapshot.tool;
  const acceptedChangeGuidance = retryTool === "archflow_gate"
    ? "For accepted-change, do not decide the old gate: revise and rebuild the artifact, take the exact new subject from envelope.artifact_digest, combine it with status.open_gate.supplemental_supersession, and retry the same call with that complete supersede outcome. GATE_SUPERSEDED confirms that the old gate closed without approval; re-enter produce/review/triage/adjudicate to a fixed point and open a fresh gate over the new subject."
    : "For accepted-change, do not decide or retry the old waiver gate. Revise the bound subject and return to the upstream produce/review/triage/adjudicate workflow; the waiver result contract has no superseded success shape.";
  const bindings = JSON.stringify({
    gate_id: snapshot.gate_id,
    request_digest: snapshot.request_digest,
    task_id: snapshot.task_id,
    phase_instance: snapshot.phase_instance,
    kind: snapshot.kind,
    subject_digest: snapshot.subject_digest,
    context_digest: snapshot.context_digest,
    input_fingerprint: snapshot.input_fingerprint,
    current_evidence_set_digest: snapshot.current_evidence.set_digest,
    producer_family: producerFamily,
    reviewer_family: reviewerFamily,
  }, null, 2);

  return `Perform an optional independent counter-review of the open ArchFlow gate using the configured ${reviewerFamily} reviewer family.

The review is advisory until the human chooses whether to install it. Do not edit the gate decision or any task artifact. Read .archflow/tasks/${snapshot.task_id}/gate.json and .archflow/tasks/${snapshot.task_id}/decisions/${snapshot.gate_id}/request.json, inspect the subject and current evidence they bind, then create a degraded ReviewEvidence JSON document in gate-counter-review.json with role "gate-counter-review", step "counter_review", producer_family "${producerFamily}", model_family "${reviewerFamily}", assurance "degraded", and these exact bindings:

${bindings}

Write the rubric you actually used to gate-counter-rubric.json and obtain rubric_digest with:

archflow-local hash --task ${snapshot.task_id} < gate-counter-rubric.json

Set model and effort to the values actually used, or "unknown" when unavailable, and include a non-empty reason for degraded assurance. Findings must use stable kebab-case finding_id values; verdict and blocking_count must agree with the findings. Hash and render the review with:

archflow-local hash --task ${snapshot.task_id} < gate-counter-review.json
archflow-local render --task ${snapshot.task_id} < gate-counter-render-input.json

gate-counter-render-input.json must be {"kind":"review","value":<the complete review object>}. Copy the returned review digest into evidence_digest and the render digest into projection_digest.

Triage every finding into gate-counter-triage.json. Bind task_id, phase_instance, subject_digest, input_fingerprint, and current_evidence_set_digest exactly as above; set source_evidence_digests to [evidence_digest], include one disposition per finding, and make accepted_count/rejected_count exact. Hash it with:

archflow-local hash --task ${snapshot.task_id} < gate-counter-triage.json

Create gate-counter-record.json as SupplementalReviewRecordV1 with schema_version "1", all bindings above, evidence_digest, projection_digest, the complete review, triage_digest, the complete triage, and outcome "no-change" when no finding was accepted or "accepted-change" otherwise. Create gate-counter-validate-input.json as {"kind":"supplemental-review","value":<the complete supplemental record>}. Validate and install it from a second terminal:

archflow-local validate --task ${snapshot.task_id} < gate-counter-validate-input.json
archflow-local gate-counter --task ${snapshot.task_id} < gate-counter-record.json

Keep the original ${retryTool} input byte-for-byte except for supplemental_outcome, and keep its same intent_id on every retry. If the human declines, select status.open_gate.supplemental_outcomes[action="decline"], create no review or triage, and retry ${retryTool} once with that exact payload.

If the human elects review, install the record above and let the original blocked call return SUPPLEMENTAL_REVIEW_REQUIRED. Re-run status, select its exact ingest payload, and retry the same ${retryTool} input with that supplemental_outcome. Re-run status after ingest. For a retained no-change outcome, select the exact triage-no-change payload and retry the same ${retryTool} call; the gate may then resolve only from the human's separately selected gate.decision. ${acceptedChangeGuidance} Never invent a supplemental review, triage result, subject digest, or human gate decision.`;
}

async function archivedWaiverRequest(
  services: ProductionServices,
  call: Extract<ParsedToolCall, { readonly name: "archflow_waiver" }>,
): Promise<ProjectResult<GateRequestV1>> {
  const target = await resolveTaskPath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: gateRequestClaim(call.input.origin.origin_gate_id),
    expectedClass: "decision",
    context: services.authority.context,
  });
  if (!target.ok) return target;
  try {
    const document = parseCanonicalDocument<GateRequestV1>(
      new Uint8Array(await readFile(target.value.absolute)),
      "waiver origin gate request",
    );
    return ok(parseGateRequest(document.value));
  } catch {
    return fail(createProjectError("CONTRACT_INVALID", { issue_code: "waiver-origin-request-invalid" }));
  }
}

async function fingerprintFor(
  services: ProductionServices,
  call: ParsedToolCall,
): Promise<ProjectResult<Sha256Digest>> {
  if (services.state === undefined) {
    if (call.name !== "archflow_state") {
      const phase = call.name === "archflow_waiver" ? call.input.origin.phase_instance : services.authority.context.phase_instance;
      return fail(createProjectError("STATE_MISSING", { phase_instance: phase }));
    }
    const identified = await identifyStateInitialization(services.dependencies, {
      authority: services.authority,
      call,
    });
    return identified.ok ? ok(identified.value.input_fingerprint) : identified;
  }
  if (call.name === "archflow_gate" || call.name === "archflow_waiver") {
    return ok(services.state.value.input_fingerprint);
  }
  const config = await services.dependencies.read_config(services.authority.config);
  if (config.kind !== "valid") {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: `config-${config.kind}` }));
  }
  if (config.snapshot.digest !== services.state.value.config_digest) {
    return fail(createProjectError("PINNED_CONFIG_MISMATCH", {
      expected_digest: services.state.value.config_digest,
      observed_digest: config.snapshot.digest,
    }));
  }
  const resolved = await services.dependencies.resolve_input_fingerprint({
    runner: services.runner,
    authority: services.authority,
    state: services.state,
    call,
    live_config: config.snapshot,
    context: services.authority.context,
  });
  if (!resolved.ok) return resolved;
  assertPlainJson(resolved.value, "envelope fingerprint subject");
  return ok(computeInputFingerprint(structuredClone(resolved.value)));
}

/** Computes the server-checked fingerprint, request digest, and caller-known gate bindings. */
export async function computeCallEnvelope(
  services: ProductionServices,
  value: PlainJsonValue,
): Promise<ProjectResult<CallEnvelope>> {
  assertPlainJson(value, "call envelope input");
  const snapshot = structuredClone(value);
  if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new TypeError("call envelope input must be an object");
  }
  const tool = Reflect.get(snapshot, "tool");
  if (!isToolName(tool)) throw new TypeError("call envelope tool is invalid");
  const call = parseToolCall(tool, Reflect.get(snapshot, "input"));
  const fingerprint = await fingerprintFor(services, call);
  if (!fingerprint.ok) return fingerprint;
  const identified = identifyTransactionRequest(call as never, services.authority, fingerprint.value);
  const envelope: CallEnvelope = {
    tool,
    input_fingerprint: fingerprint.value,
    request_digest: identified.request_digest,
    ...(call.name === "archflow_state" && call.input.artifact !== undefined
      ? { artifact_digest: canonicalJsonDigest(call.input.artifact) }
      : {}),
  };
  if (call.name !== "archflow_gate" && call.name !== "archflow_waiver") return ok(Object.freeze(envelope));

  const gateId = computeGateId({
    task_identity_digest: services.authority.task_identity_digest,
    intent_id: call.input.intent_id,
    request_digest: identified.request_digest,
  });
  let phaseInstance: GateRequestV1["phase_instance"];
  let kind: GateRequestV1["kind"];
  let subjectDigest: Sha256Digest;
  let contextDigest: Sha256Digest;
  let currentEvidence: CurrentEvidenceSetRef;
  if (call.name === "archflow_gate") {
    phaseInstance = call.input.phase_instance;
    kind = call.input.kind;
    subjectDigest = call.input.subject_digest;
    contextDigest = computeGateContextDigest(call.input.kind, call.input.context as never);
    currentEvidence = call.input.current_evidence;
  } else {
    const origin = await archivedWaiverRequest(services, call);
    if (!origin.ok) return origin;
    const waiverContext: WaiverGateContext = { origin: call.input.origin, rationale: call.input.rationale };
    phaseInstance = call.input.origin.phase_instance;
    kind = call.input.origin.scope.operation;
    subjectDigest = call.input.origin.subject_digest;
    contextDigest = computeGateContextDigest("waiver", waiverContext);
    currentEvidence = origin.value.current_evidence;
  }
  const promptInput: GateCounterPromptInput = {
    tool: call.name,
    gate_id: gateId,
    request_digest: identified.request_digest,
    task_id: services.authority.task_id,
    phase_instance: phaseInstance,
    kind,
    subject_digest: subjectDigest,
    context_digest: contextDigest,
    input_fingerprint: fingerprint.value,
    current_evidence: currentEvidence,
  };
  return ok(Object.freeze({
    ...envelope,
    gate: Object.freeze({
      gate_id: gateId,
      decision_path: parseTaskPathClaim("gate.decision"),
      archive_decision_path: gateDecisionClaim(gateId),
      request_path: gateRequestClaim(gateId),
      gate_counter_review_path: gateCounterReviewClaim(phaseInstance, gateId),
      counter_review_prompt: renderGateCounterPrompt(promptInput),
    }),
  }));
}
