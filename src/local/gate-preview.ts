import { parseCanonicalDocument } from "../contracts/canonical.js";
import {
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  type WaiverGateContext,
} from "../contracts/durable-gate.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { GateContext, GateKind, WaiverOriginRef } from "../contracts/gates.js";
import { parseGateContext } from "../contracts/gates.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { parseCurrentEvidenceSetRef } from "../contracts/trust.js";
import { gateDecisionClaim, gateRequestClaim, openResolved, resolveTaskPath } from "../repository/paths.js";
import { buildGatePreview, type GatePreview } from "../state/gate-preview.js";
import type { ProductionServices } from "../state/production.js";
import { computeTaskStatus } from "../state/status.js";
import { authenticWaiverOriginArchive } from "../state/waiver-origin.js";

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });

function record(value: PlainJsonValue): Record<string, PlainJsonValue> {
  assertPlainJson(value, "gate-preview input");
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("gate-preview input must be an object");
  }
  return structuredClone(value) as Record<string, PlainJsonValue>;
}

function invalid(services: ProductionServices, issueCode: string): ProjectResult<never> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", {
      phase_instance: services.state?.value.phase_instance ?? services.authority.context.phase_instance,
      issue_code: issueCode,
    }),
  });
}

async function currentGatePreview(
  services: ProductionServices,
  summary: string,
): Promise<ProjectResult<GatePreview>> {
  const status = await computeTaskStatus(services.dependencies, services.authority);
  if (!status.ok) return status;
  if (status.value.next_action.code !== "open-gate") {
    return invalid(services, "gate-preview-action-not-current");
  }
  const request = status.value.next_action.request;
  if (request?.tool !== "archflow_gate" || request.input === null || Array.isArray(request.input) || typeof request.input !== "object") {
    return invalid(services, "gate-preview-request-unavailable");
  }
  const input = request.input as Record<string, PlainJsonValue>;
  const kind = String(input.kind) as GateKind;
  const context = parseGateContext(kind, input.context) as GateContext<GateKind>;
  const evidence = parseCurrentEvidenceSetRef(input.current_evidence);
  return ok(buildGatePreview({
    task_id: services.authority.task_id,
    revision: status.value.revision!,
    phase_instance: status.value.phase_instance!,
    summary,
    subject_digest: String(input.subject_digest) as never,
    current_evidence: evidence,
    kind,
    context,
  }));
}

async function readWaiverOrigin(
  services: ProductionServices,
  origin: WaiverOriginRef,
): Promise<ProjectResult<Readonly<{
  context: WaiverGateContext;
  evidence: ReturnType<typeof parseCurrentEvidenceSetRef>;
}>>> {
  const requestTarget = await resolveTaskPath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: gateRequestClaim(origin.origin_gate_id),
    expectedClass: "authority-decision",
    context: services.authority.context,
  });
  if (!requestTarget.ok) return requestTarget;
  const decisionTarget = await resolveTaskPath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: gateDecisionClaim(origin.origin_gate_id),
    expectedClass: "authority-decision",
    context: services.authority.context,
  });
  if (!decisionTarget.ok) return decisionTarget;
  try {
    const requestHandle = await openResolved(requestTarget.value.absolute, 0);
    const request = parseCanonicalDocument(
      new Uint8Array(await requestHandle.readFile().finally(() => requestHandle.close())),
      "waiver origin request",
    );
    const parsedRequest = Object.freeze({ ...request, value: parseArchivedGateRequest(request.value) });
    const decisionHandle = await openResolved(decisionTarget.value.absolute, 0);
    const decision = parseCanonicalDocument(
      new Uint8Array(await decisionHandle.readFile().finally(() => decisionHandle.close())),
      "waiver origin decision",
    );
    const parsedDecision = Object.freeze({ ...decision, value: parseArchivedGateDecisionRecord(decision.value) });
    if (!authenticWaiverOriginArchive(parsedRequest, parsedDecision, origin)) {
      return invalid(services, "waiver-preview-origin-invalid");
    }
    return ok(Object.freeze({
      context: Object.freeze({ origin, rationale: "" }),
      evidence: parsedRequest.value.current_evidence,
    }));
  } catch {
    return invalid(services, "waiver-preview-origin-invalid");
  }
}

async function waiverPreview(
  services: ProductionServices,
  value: Record<string, PlainJsonValue>,
): Promise<ProjectResult<GatePreview>> {
  if (services.state === undefined) return invalid(services, "waiver-preview-state-missing");
  const origin = value.origin as unknown as WaiverOriginRef;
  const rationale = String(value.rationale ?? "");
  if (rationale.trim() === "") throw new TypeError("gate-preview waiver requires a non-empty rationale");
  const loaded = await readWaiverOrigin(services, origin);
  if (!loaded.ok) return loaded;
  const context: WaiverGateContext = Object.freeze({ origin, rationale });
  return ok(buildGatePreview({
    task_id: services.authority.task_id,
    revision: services.state.value.revision,
    phase_instance: origin.phase_instance,
    summary: `Waiver request for ${origin.rule.rule_id}`,
    subject_digest: origin.subject_digest,
    current_evidence: loaded.value.evidence,
    kind: "constitution-review",
    context,
  }));
}

export async function computeLocalGatePreview(
  services: ProductionServices,
  input: PlainJsonValue,
): Promise<ProjectResult<GatePreview>> {
  const value = record(input);
  return value.kind === "waiver"
    ? waiverPreview(services, value)
    : currentGatePreview(services, String(value.summary ?? ""));
}
