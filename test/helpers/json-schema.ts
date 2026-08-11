import { isDeepStrictEqual } from "node:util";
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import {
  ContractValidationError,
  hasUniqueObjectPropertyValues,
  isSortedUniqueBy,
  tupleKey,
} from "../../src/contracts/validators.js";
import { assertPlainJson, type PlainJsonValue } from "../../src/contracts/plain-json.js";

/**
 * Test-owned strict Ajv compiler for the committed JSON Schema documents. Zod is the runtime shape
 * authority everywhere in production; the committed schemas are generated from it and exist for
 * third-party consumers. Compiling them here proves each document stays valid draft-2020-12 that a
 * strict external validator accepts, and lets tests exercise what the published document enforces.
 *
 * The registered keywords are exactly the `x-archflow-*` keywords still present in committed
 * schemas: the `.meta`-emitted `x-archflow-mcp-semantics` on the generated `mcp-tools` document,
 * the set keywords carried by the two hand-written release schemas, and the byte/NFC pair the
 * error group re-emits. Retired keywords are deliberately not registered — a regeneration that
 * resurrected one would fail strict compilation here.
 */

export type JsonSchemaValidator<T> = {
  readonly validate: ValidateFunction<T>;
  readonly assert: (value: unknown, label?: string) => T;
};

export type ZodLikeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
};

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === undefined || errors === null || errors.length === 0) return "schema validation failed";
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ");
}

function hasBoundedUtf8Length(maximumBytes: number, data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= maximumBytes;
}

/** Unicode NFC is not expressible as a JSON Schema `pattern`, so the keyword carries it. */
function isUnicodeNormalized(_enabled: true, data: string): boolean {
  return data.normalize("NFC") === data;
}

const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const ruleKey = (value: unknown): string => { const item = record(value); return `${String(item?.rule_id)}:${String(item?.rule_version)}`; };

function hasGateContextSemantics(kind: unknown, contextValue: unknown): boolean {
  const context = record(contextValue);
  if (context === undefined) return true;
  if (kind === "review-trigger" || kind === "adjudication-failure") {
    const primary = kind === "review-trigger" ? context.matched_rules : context.failed_rules;
    if (!isSortedUniqueBy(primary, ruleKey) || !isSortedUniqueBy(context.uncertain_rules, ruleKey) || !isSortedUniqueBy(context.eligible_waiver_rules, ruleKey)) return false;
    const available = new Set([...(primary as unknown[]), ...(context.uncertain_rules as unknown[])].map(ruleKey));
    if ((context.eligible_waiver_rules as unknown[]).some((item) => !available.has(ruleKey(item)))) return false;
    if (kind === "adjudication-failure" && available.size === 0) return false;
    return record(context.waiver_scope)?.operation === kind;
  }
  if (kind === "attempts-exhausted") return typeof context.attempts === "number" && typeof context.maximum_attempts === "number" && context.attempts >= context.maximum_attempts;
  if (kind === "material-drift") return isSortedUniqueBy(context.affected_claim_ids);
  if (kind === "commit-authorization") return isSortedUniqueBy(context.current_artifact_digests) && isSortedUniqueBy(context.parent_document_digests);
  return true;
}

function hasExactCurrentEvidence(value: unknown): boolean {
  const current = record(value); if (current === undefined || !Array.isArray(current.slots)) return false;
  const slots = current.slots.map(record); if (slots.some((slot) => slot === undefined) || (slots.length !== 1 && slots.length !== 2)) return false;
  if (slots[0]!.role !== "counter-review" || (slots.length === 2 && slots[1]!.role !== "gate-counter-review")) return false;
  if (slots.some((slot) => slot!.producer_family === slot!.reviewer_family)) return false;
  return new Set(slots.map((slot) => slot!.evidence_digest)).size === slots.length;
}

function hasMcpSemantics(_enabled: true, data: Record<string, unknown>): boolean {
  if ("kind" in data && "current_evidence" in data) return hasExactCurrentEvidence(data.current_evidence) && hasGateContextSemantics(data.kind, data.context);
  if ("origin" in data) return record(data.origin)?.task_id === data.task_id;
  return true;
}

export function createJsonSchemaValidator<T>(
  schema: AnySchema,
  referencedSchemas: readonly AnySchema[] = []
): JsonSchemaValidator<T> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    validateFormats: true
  });
  const addFormats = formatsModule.default as unknown as FormatsPlugin;
  addFormats(ajv);
  ajv.addKeyword({
    keyword: "x-archflow-unique-by",
    schemaType: ["string", "array"],
    metaSchema: {
      oneOf: [
        { type: "string", minLength: 1 },
        { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } }
      ]
    },
    type: "array",
    errors: false,
    validate: hasUniqueObjectPropertyValues
  });
  ajv.addKeyword({
    keyword: "x-archflow-max-utf8-bytes",
    schemaType: "number",
    metaSchema: { type: "integer", minimum: 0 },
    type: "string",
    errors: false,
    validate: hasBoundedUtf8Length
  });
  ajv.addKeyword({
    keyword: "x-archflow-nfc",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "string",
    errors: false,
    validate: isUnicodeNormalized
  });
  ajv.addKeyword({
    keyword: "x-archflow-sorted-unique",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "array",
    errors: false,
    validate: (_enabled: true, data: unknown) => isSortedUniqueBy(data)
  });
  ajv.addKeyword({
    keyword: "x-archflow-mcp-semantics",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "object",
    errors: false,
    validate: hasMcpSemantics
  });
  for (const referencedSchema of referencedSchemas) ajv.addSchema(referencedSchema);
  const validate = ajv.compile<T>(schema);
  const assert = (value: unknown, label = "value"): T => {
    assertPlainJson(value, label);
    if (!validate(value)) throw new ContractValidationError(`${label}: ${formatAjvErrors(validate.errors)}`, validate.errors);
    return value as unknown as T;
  };
  return { validate, assert };
}

/**
 * Proves the committed document and its Zod source accept a value identically and without
 * mutation. Kept for tests that treat the published schema as a consumer-facing contract; the Zod
 * side is the runtime authority.
 */
export function assertZodAgreement<T>(
  value: unknown,
  jsonValidator: JsonSchemaValidator<T> | ValidateFunction<T>,
  zodSchema: ZodLikeSchema<T>,
  label = "value"
): T {
  assertPlainJson(value, label);
  const before = structuredClone(value as PlainJsonValue);
  const ajvValidate = "validate" in jsonValidator ? jsonValidator.validate : jsonValidator;
  const jsonAccepted = ajvValidate(value);
  const zodResult = zodSchema.safeParse(value);
  if (!isDeepStrictEqual(value, before)) throw new ContractValidationError(`${label}: a validator mutated its input`);
  if (jsonAccepted !== zodResult.success) {
    throw new ContractValidationError(`${label}: JSON Schema and Zod validators disagree`, {
      jsonSchemaErrors: ajvValidate.errors,
      zodError: zodResult.success ? undefined : zodResult.error
    });
  }
  if (!jsonAccepted || !zodResult.success) {
    throw new ContractValidationError(`${label}: schema validation failed: ${formatAjvErrors(ajvValidate.errors)}`, {
      jsonSchemaErrors: ajvValidate.errors,
      zodError: zodResult.success ? undefined : zodResult.error
    });
  }
  if (!isDeepStrictEqual(zodResult.data, value)) {
    throw new ContractValidationError(`${label}: Zod mirrors must not transform validated values`);
  }
  return value as T;
}
