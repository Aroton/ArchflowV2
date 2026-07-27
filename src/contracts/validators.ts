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

function hasUniqueObjectPropertyValues(properties: string | readonly string[], data: unknown[]): boolean {
  const propertyNames = typeof properties === "string" ? [properties] : properties;
  const seen: unknown[][] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const values = propertyNames.map((property) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, property);
      return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    });
    if (seen.some((candidate) => isDeepStrictEqual(candidate, values))) return false;
    seen.push(values);
  }
  return true;
}

function hasBoundedUtf8Length(maximumBytes: number, data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= maximumBytes;
}

function isOrdinalSortedUnique(_enabled: true, data: string[]): boolean {
  return data.every((value, index) => index === 0 || data[index - 1]! < value);
}

function hasConsistentReviewSummary(_enabled: true, data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.findings)) return true;
  const blockingCount = data.findings.filter((finding) => typeof finding === "object" && finding !== null && (finding as Record<string, unknown>).blocking === true).length;
  const verdict = blockingCount > 0 ? "fail" : data.findings.length > 0 ? "advisory" : "pass";
  return data.blocking_count === blockingCount && data.verdict === verdict;
}

function hasConsistentAdjudicationSemantics(_enabled: true, data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.rule_findings) || !Array.isArray(data.drift_findings) || !Array.isArray(data.approved_upstream_digests)) return true;
  const ruleKey = (rule: Record<string, unknown>): string => `${String(rule.rule_id)}:${String(rule.rule_version)}`;
  const sortedUnique = (values: readonly string[]): boolean => values.every((value, index) => index === 0 || values[index - 1]! < value);
  const ruleFindings = data.rule_findings as Record<string, unknown>[];
  const driftFindings = data.drift_findings as Record<string, unknown>[];
  const upstream = data.approved_upstream_digests as string[];
  if (!sortedUnique(upstream) || !sortedUnique(ruleFindings.map(ruleKey)) || !sortedUnique(driftFindings.map((finding) => String(finding.upstream_digest)))) return false;
  if (driftFindings.length !== upstream.length || driftFindings.some((finding, index) => finding.upstream_digest !== upstream[index])) return false;
  for (const finding of ruleFindings) {
    if (!Array.isArray(finding.enforced_by)) return false;
    if (finding.compliance === "pass" && finding.enforced_by.length === 0) return false;
    for (const evidence of finding.enforced_by as Record<string, unknown>[]) {
      if (evidence.state === "current" && evidence.subject_digest !== data.subject_digest) return false;
      if (evidence.state !== "current" && finding.compliance === "pass") return false;
    }
  }
  const constitution = ruleFindings.some((finding) => finding.compliance === "fail") ? "fail" : ruleFindings.some((finding) => finding.compliance === "uncertain") ? "uncertain" : "pass";
  if (data.constitution !== constitution) return false;
  const drift = driftFindings.some((finding) => finding.drift === "material") ? "material" : driftFindings.some((finding) => finding.drift === "incidental") ? "incidental" : "aligned";
  if (data.drift !== drift) return false;
  const matched = ruleFindings.filter((finding) => finding.trigger === "matched").map(ruleKey);
  const uncertain = ruleFindings.filter((finding) => finding.trigger === "uncertain").map(ruleKey);
  const actualMatched = Array.isArray(data.matched_rule_versions) ? (data.matched_rule_versions as Record<string, unknown>[]).map(ruleKey) : [];
  const actualUncertain = Array.isArray(data.uncertain_rule_versions) ? (data.uncertain_rule_versions as Record<string, unknown>[]).map(ruleKey) : [];
  return isDeepStrictEqual(actualMatched, matched) && isDeepStrictEqual(actualUncertain, uncertain);
}

const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const ruleKey = (value: unknown): string => { const item = record(value); return `${String(item?.rule_id)}:${String(item?.rule_version)}`; };
const sortedUniqueBy = (values: unknown, key: (value: unknown) => string = String): boolean => Array.isArray(values) && values.every((value, index) => index === 0 || key(values[index - 1]) < key(value));

function hasGateContextSemantics(kind: unknown, contextValue: unknown): boolean {
  const context = record(contextValue);
  if (context === undefined) return true;
  if (kind === "review-trigger" || kind === "adjudication-failure") {
    const primary = kind === "review-trigger" ? context.matched_rules : context.failed_rules;
    if (!sortedUniqueBy(primary, ruleKey) || !sortedUniqueBy(context.uncertain_rules, ruleKey) || !sortedUniqueBy(context.eligible_waiver_rules, ruleKey)) return false;
    const available = new Set([...(primary as unknown[]), ...(context.uncertain_rules as unknown[])].map(ruleKey));
    if ((context.eligible_waiver_rules as unknown[]).some((item) => !available.has(ruleKey(item)))) return false;
    if (kind === "adjudication-failure" && available.size === 0) return false;
    return record(context.waiver_scope)?.operation === kind;
  }
  if (kind === "attempts-exhausted") return typeof context.attempts === "number" && typeof context.maximum_attempts === "number" && context.attempts >= context.maximum_attempts;
  if (kind === "material-drift") return sortedUniqueBy(context.affected_claim_ids);
  if (kind === "commit-authorization") return sortedUniqueBy(context.current_artifact_digests) && sortedUniqueBy(context.parent_document_digests);
  return true;
}

function hasGateSemantics(_enabled: true, data: Record<string, unknown>): boolean {
  if (!hasGateContextSemantics(data.kind, data.context)) return false;
  const context = record(data.context); const payload = record(data.payload);
  if (context === undefined || payload === undefined) return true;
  if ((data.kind === "review-trigger" || data.kind === "adjudication-failure") && payload.decision === "waiver-requested") {
    return Array.isArray(context.eligible_waiver_rules) && context.eligible_waiver_rules.some((item) => ruleKey(item) === ruleKey(payload.rule));
  }
  if (data.kind === "adjudication-failure" && payload.decision === "approve") {
    const eligible = new Set((context.eligible_waiver_rules as unknown[]).map(ruleKey));
    const required = new Set([...(context.failed_rules as unknown[]), ...(context.uncertain_rules as unknown[])].map(ruleKey).filter((key) => !eligible.has(key)));
    if (!sortedUniqueBy(payload.resolutions, (item) => ruleKey(record(item)?.rule))) return false;
    const actual = (payload.resolutions as unknown[]).map((item) => ruleKey(record(item)?.rule));
    return actual.length === required.size && actual.every((key) => required.has(key));
  }
  if (data.kind === "restore-collision" && payload.decision === "adopt-as-new-generation") return isDeepStrictEqual(payload.adoption_authority, context.adoption_candidate);
  return true;
}

function hasSupplementalSemantics(_enabled: true, data: Record<string, unknown>): boolean {
  const review = record(data.review);
  if (review === undefined) return true;
  const slot = record(review.evidence_slot);
  if (slot === undefined || slot.gate_id !== review.prior_gate_id || slot.producer_family === slot.reviewer_family) return false;
  return data.action !== "supersede" || (data.old_subject_digest === review.subject_digest && data.new_subject_digest !== data.old_subject_digest);
}

function hasExactCurrentEvidence(value: unknown): boolean {
  const current = record(value); if (current === undefined || !Array.isArray(current.slots)) return false;
  const slots = current.slots.map(record); if (slots.some((slot) => slot === undefined) || (slots.length !== 2 && slots.length !== 3)) return false;
  if (slots[0]!.role !== "self-review" || slots[1]!.role !== "counter-review" || (slots.length === 3 && slots[2]!.role !== "gate-counter-review")) return false;
  if (slots[0]!.producer_family !== slots[0]!.reviewer_family || slots.slice(1).some((slot) => slot!.producer_family === slot!.reviewer_family)) return false;
  return new Set(slots.map((slot) => slot!.evidence_digest)).size === slots.length;
}

function hasMcpSemantics(_enabled: true, data: Record<string, unknown>): boolean {
  if ("kind" in data && "current_evidence" in data) return hasExactCurrentEvidence(data.current_evidence) && hasGateContextSemantics(data.kind, data.context);
  if ("origin" in data) return record(data.origin)?.task_id === data.task_id;
  return true;
}

function hasResultExpectationSemantics(_enabled: true, data: Record<string, unknown>): boolean { return record(data.success)?.revision === data.resulting_revision; }

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
    keyword: "x-archflow-effect",
    schemaType: "string",
    metaSchema: {
      type: "string",
      enum: ["advance", "retry", "redirect-waiver", "redirect-upstream", "non-advancing"]
    },
    errors: false,
    valid: true
  });
  ajv.addKeyword({
    keyword: "x-archflow-sorted-unique",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "array",
    errors: false,
    validate: isOrdinalSortedUnique
  });
  ajv.addKeyword({
    keyword: "x-archflow-review-summary",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "object",
    errors: false,
    validate: hasConsistentReviewSummary
  });
  ajv.addKeyword({
    keyword: "x-archflow-adjudication-semantics",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "object",
    errors: false,
    validate: hasConsistentAdjudicationSemantics
  });
  for (const [keyword, validate] of [
    ["x-archflow-gate-semantics", hasGateSemantics],
    ["x-archflow-supplemental-semantics", hasSupplementalSemantics],
    ["x-archflow-mcp-semantics", hasMcpSemantics],
    ["x-archflow-result-expectation-semantics", hasResultExpectationSemantics]
  ] as const) ajv.addKeyword({ keyword, schemaType: "boolean", metaSchema: { const: true }, type: "object", errors: false, validate });
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
