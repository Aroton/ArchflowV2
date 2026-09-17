import { createAdjudicationOutputSchema } from "../contracts/adjudication.js";
import { rawEffortSelectionV3Schema } from "../contracts/effort-review.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { reviewReportOutputSchema } from "../contracts/review.js";
import type { DispatchEnvelope } from "./envelopes.js";

/** Generate the current child contract once, before sealing the prompt and dispatch inputs. */
export function createReviewResponseSchema(
  kind: DispatchEnvelope["result_kind"],
  record: Readonly<Record<string, PlainJsonValue>>,
): PlainJsonValue {
  const contract = kind === "review" ? reviewReportOutputSchema
    : kind === "effort-review" ? rawEffortSelectionV3Schema
    : createAdjudicationOutputSchema((record.rules as { slot: string }[]).map(rule => rule.slot));
  // Zod's non-enumerable Standard Schema helper is not part of the JSON document.
  const schema: unknown = JSON.parse(JSON.stringify(contract.toJSONSchema({ target: "draft-2020-12" })));
  assertPlainJson(schema, "review response schema");
  const result = structuredClone(schema) as Record<string, PlainJsonValue>;
  if (kind === "effort-review") {
    const properties = result.properties as Record<string, PlainJsonValue>;
    for (const key of ["task_id", "phase_instance", "step", "role", "subject_digest", "input_fingerprint", "policy_id"]) {
      if (record[key] !== undefined) properties[key] = { const: structuredClone(record[key]) };
    }
  }
  return result;
}

/** Current reviewer contracts contain closed objects, fixed bindings, enums, and free text. */
export function reviewResponseExample(schema: PlainJsonValue): { example: PlainJsonValue; choices: string[] } {
  const choices = new Set<string>();
  function example(value: PlainJsonValue, field: string): PlainJsonValue {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid review response schema");
    const node = value as Readonly<Record<string, PlainJsonValue>>;
    if (node.const !== undefined) return node.const;
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      choices.add(`${field}: ${node.enum.map(item => `\`${String(item)}\``).join(" | ")}`);
      return node.enum[0]!;
    }
    if (node.type === "object" && node.properties !== null && typeof node.properties === "object" && !Array.isArray(node.properties)) {
      return Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, example(child, key)]));
    }
    if (node.type === "string") return `<${field.replaceAll("_", " ")}: your assessment grounded in the supplied evidence>`;
    throw new TypeError(`Unsupported review response example field: ${field}`);
  }
  return { example: example(schema, "response"), choices: [...choices] };
}
