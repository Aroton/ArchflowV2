import { canonicalJsonDigest } from "./canonical.js";
import type { TaskStateV1 } from "./durable-state.js";
import type { PathSafeId, SafeCode, SafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";
import type { ToolName } from "./tool-names.js";
import { intentReceiptV1Validator } from "./validators.js";

/**
 * The immutable successful preparation stored at `intents/<intent-id>.json`.
 * This server-internal durable root has one normative JSON Schema and no Zod mirror.
 * Every reachable persisted shape is a type alias so it remains PlainJsonValue-compatible.
 */
export type IntentReceiptV1 = {
  readonly schema_version: "1";
  readonly intent_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly tool: ToolName;
  readonly operation: SafeCode;
  readonly request_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly prior_revision: SafeInteger;
  readonly resulting_revision: SafeInteger;
  readonly result_id: SafeId;
  readonly outcome_digest: Sha256Digest;
  readonly outcome: PlainJsonValue;
  readonly prepared_state_digest: Sha256Digest;
  readonly prepared_state: TaskStateV1;
};

export function parseIntentReceipt(value: unknown): IntentReceiptV1 {
  assertPlainJson(value, "intent receipt");
  return intentReceiptV1Validator.assert(value, "intent receipt");
}

/** Exact whole-receipt canonical digest; no domain tag and no field subset. */
export function intentReceiptDigest(receipt: IntentReceiptV1): Sha256Digest {
  return canonicalJsonDigest(receipt);
}

/** Exact canonical digest of the successful ToolSuccess snapshot. */
export function intentOutcomeDigest(outcome: PlainJsonValue): Sha256Digest {
  return canonicalJsonDigest(outcome);
}
