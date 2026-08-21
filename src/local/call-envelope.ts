import { canonicalJsonDigest } from "../contracts/canonical.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { computeGateId } from "../contracts/fingerprints.js";
import { parseToolCall, type ParsedToolCall } from "../contracts/mcp-tools.js";
import { parseRepositoryPathClaim, type RepositoryPathClaim, type TaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { TOOL_NAMES, isToolName, type ToolName } from "../contracts/tool-names.js";
import { gateDecisionClaim, gateRequestClaim } from "../repository/paths.js";
import { identifyStateInitialization } from "../state/initialization.js";
import type { ProductionServices } from "../state/production.js";
import { identifyTransactionRequest } from "../state/request.js";

export type CallEnvelope = Readonly<{
  tool: ToolName;
  input_fingerprint: Sha256Digest;
  request_digest: Sha256Digest;
  /**
   * The fingerprint-resolved request in the one canonical shape: `request.input` is the exact
   * tool input to call `tool` with, byte-equivalent to what `request_digest` identifies, and
   * `request` itself is byte-acceptable envelope stdin. Resolution is a fixed point: running
   * envelope over its own `request` returns the same digests.
   */
  request: Readonly<{ tool: ToolName; input: PlainJsonValue }>;
  artifact_digest?: Sha256Digest;
  gate?: Readonly<{
    gate_id: PathSafeId;
    decision_path: RepositoryPathClaim;
    archive_decision_path: TaskPathClaim;
    request_path: TaskPathClaim;
  }>;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Substitutes the computed fingerprint into exactly the two places the tool contracts bind it:
 * the request's own `input_fingerprint`, and — for document and implementation-output artifacts
 * only — the embedded artifact's `input_fingerprint`, whose canonical digest the request digest
 * folds in. Nothing else is rewritten: review and triage artifacts bind their fingerprint as an
 * attested claim inside `evidence`, waiver origins pin their historical fingerprint, and retry
 * chains carry prior fingerprints — all of those must pass through untouched.
 */
function resolveCallInput(call: ParsedToolCall, fingerprint: Sha256Digest): PlainJsonValue {
  const input = structuredClone(call.input) as Record<string, unknown>;
  input.input_fingerprint = fingerprint;
  if (call.name === "archflow_state") {
    const artifact = input.artifact as Record<string, unknown> | undefined;
    if (artifact !== undefined &&
        (artifact.artifact_kind === "document" || artifact.artifact_kind === "implementation-output")) {
      artifact.input_fingerprint = fingerprint;
    }
  }
  return input as PlainJsonValue;
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
  const resolved = await services.dependencies.resolve_input_fingerprint({
    runner: services.runner,
    authority: services.authority,
    state: services.state,
    call,
    live_config: config.snapshot,
    expected_input_fingerprint: services.state.value.input_fingerprint,
    context: services.authority.context,
  });
  if (!resolved.ok) return resolved;
  return ok(resolved.value.fingerprint);
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
  if (tool === undefined) {
    throw new TypeError(`call envelope input is missing "tool": expected {"tool": <one of ${TOOL_NAMES.join(" | ")}>, "input": <tool input>}`);
  }
  if (!isToolName(tool)) {
    throw new TypeError(`call envelope tool ${JSON.stringify(tool)} is not recognized: expected {"tool": <one of ${TOOL_NAMES.join(" | ")}>, "input": <tool input>}`);
  }
  const draft = parseToolCall(tool, Reflect.get(snapshot, "input"));
  const fingerprint = await fingerprintFor(services, draft);
  if (!fingerprint.ok) return fingerprint;
  // Fingerprint resolution is internal: the caller's draft may embed any fingerprint (stale,
  // sentinel, or already correct); the identified request is always the resolved one, so the
  // returned digests describe exactly the bytes `request.input` carries. One envelope pass is
  // therefore always sufficient, and envelope over its own output is a fixed point.
  const resolvedInput = deepFreeze(resolveCallInput(draft, fingerprint.value));
  const call = parseToolCall(tool, resolvedInput);
  const identified = identifyTransactionRequest(call as never, services.authority, fingerprint.value);
  const envelope: CallEnvelope = {
    tool,
    input_fingerprint: fingerprint.value,
    request_digest: identified.request_digest,
    request: Object.freeze({ tool, input: resolvedInput }),
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
  return ok(Object.freeze({
    ...envelope,
    gate: Object.freeze({
      gate_id: gateId,
      decision_path: parseRepositoryPathClaim(`.archflow/runtime/tasks/${services.authority.task_id}/cache/gates/gate.decision`),
      archive_decision_path: gateDecisionClaim(gateId),
      request_path: gateRequestClaim(gateId),
    }),
  }));
}
