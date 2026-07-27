import { isDeepStrictEqual } from "node:util";
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";

export interface JsonSchemaValidator<T> {
  readonly validate: ValidateFunction<T>;
  readonly assert: (value: unknown, label?: string) => T;
}

export interface ZodLikeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export class ContractValidationError extends TypeError {
  public constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ContractValidationError";
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === undefined || errors === null || errors.length === 0) return "schema validation failed";
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ");
}

function hasUniqueObjectPropertyValues(property: string, data: unknown[]): boolean {
  const seen = new Set<unknown>();
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const descriptor = Object.getOwnPropertyDescriptor(item, property);
    const value = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    if (seen.has(value)) return false;
    seen.add(value);
  }
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
    schemaType: "string",
    metaSchema: { type: "string", minLength: 1 },
    type: "array",
    errors: false,
    validate: hasUniqueObjectPropertyValues
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

export function assertValidJsonSchema<T>(
  validator: JsonSchemaValidator<T> | ValidateFunction<T>,
  value: unknown,
  label = "value"
): asserts value is T {
  assertPlainJson(value, label);
  if ("assert" in validator) {
    validator.assert(value, label);
    return;
  }
  if (!validator(value)) throw new ContractValidationError(`${label}: ${formatAjvErrors(validator.errors)}`, validator.errors);
}

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
