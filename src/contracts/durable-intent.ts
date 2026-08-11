import { z } from "zod";

import { canonicalJsonDigest } from "./canonical.js";
import type { TaskStateV1 } from "./durable-state.js";
import { taskStateV1Schema } from "./durable-state.js";
import type { PathSafeId, SafeCode, SafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import {
  pathSafeIdV1Schema,
  safeCodeV1Schema,
  safeIdV1Schema,
  safeIntegerV1Schema,
  sha256DigestV1Schema,
  taskSlugV1Schema,
} from "./evidence.js";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";
import type { ToolName } from "./tool-names.js";
import { TOOL_NAMES } from "./tool-names.js";
import { intentReceiptV1Validator } from "./validators.js";

/**
 * The immutable successful preparation stored at `intents/<intent-id>.json`.
 * `intent-receipt.schema.json` is the runtime shape authority — `parseIntentReceipt` validates
 * through the compiled JSON Schema — and `intentReceiptV1Schema` below is its Zod mirror,
 * proven equivalent by `test/contracts/durable-intent-agreement.test.ts`.
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

const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;

/**
 * The mirror. `.strict()` matches `additionalProperties: false`; `tool` reuses `TOOL_NAMES`, the
 * same tuple the schema's `enum` spells out, so the two authorities share one list.
 * `resulting_revision` mirrors the schema's inline `{ "type": "integer", "minimum": 1 }` — a
 * receipt's resulting revision is never `0`, while `prior_revision` stays `safeInteger` because
 * initialization commits from the synthetic predecessor revision `0`. `outcome` mirrors the
 * recursive `plainJson` `$def` with `z.json()`; both sides sit behind `assertPlainJson`, which
 * rejects the non-finite numbers Ajv's `type: "number"` would otherwise admit and JSON cannot
 * carry. `prepared_state` composes `taskStateV1Schema` exactly as the schema `$ref`s
 * `urn:archflow:schema:v1:task-state`.
 */
export const intentReceiptV1Schema = z.object({
  schema_version: z.literal("1"),
  intent_id: pathSafeIdV1Schema,
  task_id: taskSlugV1Schema,
  repository_identity_digest: sha256Digest,
  tool: z.enum(TOOL_NAMES),
  operation: safeCodeV1Schema,
  request_digest: sha256Digest,
  input_fingerprint: sha256Digest,
  prior_revision: safeIntegerV1Schema,
  resulting_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  result_id: safeIdV1Schema,
  outcome_digest: sha256Digest,
  outcome: z.json(),
  prepared_state_digest: sha256Digest,
  prepared_state: taskStateV1Schema,
}).strict() as unknown as z.ZodType<IntentReceiptV1>;

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
