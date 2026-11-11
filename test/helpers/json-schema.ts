import { isDeepStrictEqual } from "node:util";
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { assertPlainJson, type PlainJsonValue } from "../../src/contracts/plain-json.js";

/**
 * Test-owned strict Ajv compiler for the committed JSON Schema documents. Zod is the runtime shape
 * authority everywhere in production; the committed schemas are generated from it and exist for
 * third-party consumers. Compiling them here proves each document stays valid draft-2020-12 that a
 * strict external validator accepts, and lets tests exercise what the published document enforces.
 *
 * The registered keywords are exactly the `x-archflow-*` keywords still present in committed
 * schemas: the set keywords carried by the hand-written release manifest. Retired keywords are
 * deliberately not registered — a regeneration that resurrected one would fail strict compilation
 * here.
 */

export class ContractValidationError extends TypeError {
  public constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ContractValidationError";
  }
}

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

/** `x-archflow-unique-by`: no two items share the same own-data values for the named properties. */
function hasUniqueObjectPropertyValues(properties: string | readonly string[], data: unknown[]): boolean {
  const propertyNames = typeof properties === "string" ? [properties] : properties;
  const seen: unknown[][] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const values: unknown[] = [];
    for (const property of propertyNames) {
      const descriptor = Object.getOwnPropertyDescriptor(item, property);
      if (descriptor === undefined) {
        values.push(undefined);
        continue;
      }
      if (!descriptor.enumerable || !("value" in descriptor)) return false;
      values.push(descriptor.value);
    }
    if (seen.some((candidate) => isDeepStrictEqual(candidate, values))) return false;
    seen.push(values);
  }
  return true;
}

/** `x-archflow-sorted-unique`: strictly increasing by string value, which implies uniqueness. */
function isSortedUnique(items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  for (let i = 1; i < items.length; i++) {
    if (String(items[i - 1]) >= String(items[i])) return false;
  }
  return true;
}

function createAjvEngine(): Ajv2020 {
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
    keyword: "x-archflow-sorted-unique",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "array",
    errors: false,
    validate: (_enabled: true, data: unknown) => isSortedUnique(data)
  });
  return ajv;
}

const validatorCache = new Map<string, JsonSchemaValidator<unknown>>();

function schemaCacheKey(schema: AnySchema, referencedSchemas: readonly AnySchema[]): string {
  const schemaId = typeof schema === "object" && schema !== null && "$id" in schema ? String(schema.$id) : JSON.stringify(schema);
  const refIds = referencedSchemas.map((s) => (typeof s === "object" && s !== null && "$id" in s ? String(s.$id) : JSON.stringify(s))).join(",");
  return `${schemaId}|refs:${refIds}`;
}

export function createJsonSchemaValidator<T>(
  schema: AnySchema,
  referencedSchemas: readonly AnySchema[] = []
): JsonSchemaValidator<T> {
  const key = schemaCacheKey(schema, referencedSchemas);
  const cached = validatorCache.get(key);
  if (cached !== undefined) return cached as JsonSchemaValidator<T>;

  const ajv = createAjvEngine();
  for (const referencedSchema of referencedSchemas) ajv.addSchema(referencedSchema);
  const validate = ajv.compile<T>(schema);
  const assert = (value: unknown, label = "value"): T => {
    assertPlainJson(value, label);
    if (!validate(value)) throw new ContractValidationError(`${label}: ${formatAjvErrors(validate.errors)}`, validate.errors);
    return value as unknown as T;
  };
  const validator: JsonSchemaValidator<T> = { validate, assert };
  validatorCache.set(key, validator as JsonSchemaValidator<unknown>);
  return validator;
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
