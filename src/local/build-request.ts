import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { ProductionServices } from "../state/production.js";
import {
  BUILD_REQUEST_KINDS,
  composeRequest,
  type BuildRequestKind,
} from "../state/request-composition.js";
import { writeStagedRequest } from "../state/staged-requests.js";
import type { CallEnvelope } from "./call-envelope.js";

export { BUILD_REQUEST_KINDS, type BuildRequestKind };

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });

/**
 * Legacy CLI adapter. Shared request derivation stays transport-neutral; only this adapter writes
 * the staged handoff consumed by the existing MCP command path.
 */
export async function runBuildRequest(
  services: ProductionServices,
  value: PlainJsonValue,
): Promise<ProjectResult<CallEnvelope>> {
  const composed = await composeRequest(services, value);
  if (!composed.ok) return composed;
  const { envelope, intent_id: intentId } = composed.value;
  if (services.state === undefined) return ok(envelope);
  const staged = await writeStagedRequest({
    services,
    intent_id: intentId,
    tool: envelope.tool,
    request_input: envelope.request.input,
    request_digest: envelope.request_digest,
  });
  if (!staged.ok) return staged;
  return ok(Object.freeze({ ...envelope, staged: staged.value }));
}
