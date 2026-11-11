import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

import { REPOSITORY_NAME_PATTERN } from "./config.js";
import { safeCodeV1Schema, safeIdV1Schema, safeIntegerV1Schema, safeVersionV1Schema, sha256DigestV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { ADAPTER_IDS, MODEL_FAMILIES } from "./review.js";

export type ErrorOwner = "contracts" | "config" | "repository" | "routing" | "dispatch";
export interface StrictParameterParser<P extends Readonly<Record<string, unknown>>> { readonly parse: (value: unknown) => P }
export interface ErrorDefinition<P extends Readonly<Record<string, unknown>>, O extends ErrorOwner, R extends boolean, A extends string> { readonly owner: O; readonly retryable: R; readonly parameter_parser: StrictParameterParser<P>; readonly action: A }
export type CompleteErrorRegistry<C extends string, O extends ErrorOwner> = Readonly<{ [K in C]: ErrorDefinition<Readonly<Record<string, unknown>>, O, boolean, string> }>;

export type ProjectErrorCode = "CONTRACT_INVALID" | "CONFIG_INVALID" | "CONFIG_MODEL_UNSUPPORTED" | "CONFIG_FAMILY_UNSUPPORTED" | "REPOSITORY_NOT_FOUND" | "REPOSITORY_VIEW_UNAVAILABLE" | "UNSUPPORTED_HOST" | "UNSUPPORTED_MODEL" | "FAMILY_MISMATCH" | "CLI_VERSION_UNSUPPORTED" | "AUTH_UNAVAILABLE" | "CLI_MISSING" | "RATE_LIMITED" | "TIMEOUT" | "CANCELLED" | "MODEL_OUTPUT_INVALID" | "IO_ERROR" | "OUTPUT_OVERFLOW" | "PROCESS_FAILED";

/**
 * Every schema instance a generated document registers under `$defs` must be unique to that
 * document: the schema generator keys `$ref` emission on object identity across all documents at
 * once, so registering a shared instance here would collide with the document that owns it. The
 * clone must also carry no parent link — `.meta({})`/`.describe()` clones keep one, and a
 * parented clone emits a cross-document `$ref` to wherever its parent is registered instead of
 * its own body, silently breaking this document's self-containment. `clone(def)` shares the
 * checks (parse behavior is unchanged) and severs the parent.
 */
const documentScoped = <T extends z.ZodType>(schema: T): T => schema.clone(schema.def) as unknown as T;

const digest = documentScoped(sha256DigestV1Schema);
const id = documentScoped(safeIdV1Schema);
const code = documentScoped(safeCodeV1Schema);
const version = documentScoped(safeVersionV1Schema);
const integer = documentScoped(safeIntegerV1Schema);
const adapter = z.enum(ADAPTER_IDS);
const family = z.enum(MODEL_FAMILIES);
const repositoryName = z.union([z.literal("primary"), z.string().regex(REPOSITORY_NAME_PATTERN)]);
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const adapterAttempt = { adapter, attempt: integer } as const;
const validationIssues = z.array(z.string().min(1).max(256)).min(1).max(5);

// Shared single instances so the generated schema emits one `$defs` entry with `$ref`s at each
// use site, mirroring the def layout the hand-written document established.
const adapterOnlyParams = object({ adapter });
const adapterAttemptParams = object(adapterAttempt);

/**
 * Bounded projection of a rejected input's validation failure into diagnostic parameters. The
 * `next_action` after CONTRACT_INVALID is to correct the input, which cannot be done blind: an
 * issue_code alone was observed leaving a caller retrying byte-cosmetic variants of the same
 * wrong shape. Free text stays out of `issue_code` (a safe-code) and lives in this capped list.
 */
export function describeValidationIssues(error: unknown): string[] | undefined {
  if (error instanceof z.ZodError) {
    // Union errors otherwise hide the field behind "Invalid input". Prefer the branch
    // whose discriminators match; never mix corrections from incompatible submissions.
    const flatten = (items: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[] = []): readonly z.core.$ZodIssue[] => items.flatMap(issue => {
      const path = [...prefix, ...issue.path];
      if (issue.code !== "invalid_union" || issue.errors.length === 0) return [{ ...issue, path }];
      const branches = issue.errors.map(branch => flatten(branch, path));
      const score = (branch: readonly z.core.$ZodIssue[]) => branch.reduce((sum, item) =>
        sum + (item.code === "invalid_value" && ["kind", "outcome", "decision", "skill"].includes(String(item.path.at(-1))) ? 1000 : 1), 0);
      const best = branches.reduce((left, right) => score(left) <= score(right) ? left : right);
      return [...best];
    });
    const issues = [...new Set(flatten(error.issues).map((issue) => {
      const path = issue.path.length === 0 ? "input" : issue.path.map(String).join(".");
      return `${path}: ${issue.message}`.slice(0, 256);
    }))].slice(0, 5);
    if (issues.length > 0) return issues;
  }
  return error instanceof Error && error.message !== "" ? [error.message.slice(0, 256)] : undefined;
}

const PROJECT_PARAMETER_SCHEMAS = {
  CONTRACT_INVALID: object({ issue_code: code, schema_version: version.optional(), issues: validationIssues.optional() }),
  CONFIG_INVALID: object({ issue_code: code, issues: validationIssues.optional() }),
  CONFIG_MODEL_UNSUPPORTED: object({ model: id }), CONFIG_FAMILY_UNSUPPORTED: object({ family: id }),
  REPOSITORY_NOT_FOUND: object({ repository_candidate_digest: digest }), REPOSITORY_VIEW_UNAVAILABLE: object({ repository_name: repositoryName }),
  UNSUPPORTED_HOST: object({ host: id }), UNSUPPORTED_MODEL: object({ model: id }), FAMILY_MISMATCH: object({ expected_family: family, observed_family: family }),
  CLI_VERSION_UNSUPPORTED: object({ adapter, version }), AUTH_UNAVAILABLE: adapterOnlyParams, CLI_MISSING: adapterOnlyParams,
  RATE_LIMITED: object({ ...adapterAttempt, reason: z.literal("session-limit").optional() }), TIMEOUT: object({ ...adapterAttempt, limit_ms: integer, origin: z.literal("cli").optional() }), CANCELLED: object({ source: z.enum(["client"]), attempt: integer }), MODEL_OUTPUT_INVALID: object({ ...adapterAttempt, issue_code: code }), IO_ERROR: object({ operation: code, attempt: integer }), OUTPUT_OVERFLOW: object({ adapter, byte_count: integer, byte_cap: integer }), PROCESS_FAILED: object({ adapter, exit_class: code }),
} as const satisfies Record<ProjectErrorCode, z.ZodType<Readonly<Record<string, unknown>>>>;

function parser<P extends Readonly<Record<string, unknown>>>(schema: z.ZodType<P>): StrictParameterParser<P> { return Object.freeze({ parse(value: unknown): P { assertPlainJson(value, "error parameters"); return schema.parse(value); } }); }
function defineError<P extends Readonly<Record<string, unknown>>, O extends ErrorOwner, R extends boolean, A extends string>(owner: O, retryable: R, schema: z.ZodType<P>, action: A): ErrorDefinition<P, O, R, A> { return Object.freeze({ owner, retryable, parameter_parser: parser(schema), action }); }

export const PROJECT_ERROR_DEFINITIONS = Object.freeze({
  CONTRACT_INVALID: defineError("contracts", false, PROJECT_PARAMETER_SCHEMAS.CONTRACT_INVALID, "correct-contract"),
  CONFIG_INVALID: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_INVALID, "repair-config"), CONFIG_MODEL_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_MODEL_UNSUPPORTED, "select-supported-model"), CONFIG_FAMILY_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_FAMILY_UNSUPPORTED, "select-supported-family"),
  REPOSITORY_NOT_FOUND: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.REPOSITORY_NOT_FOUND, "open-repository"), REPOSITORY_VIEW_UNAVAILABLE: defineError("repository", true, PROJECT_PARAMETER_SCHEMAS.REPOSITORY_VIEW_UNAVAILABLE, "repair-repository-view-and-resume"),
  UNSUPPORTED_HOST: defineError("routing", false, PROJECT_PARAMETER_SCHEMAS.UNSUPPORTED_HOST, "select-supported-host"), UNSUPPORTED_MODEL: defineError("routing", false, PROJECT_PARAMETER_SCHEMAS.UNSUPPORTED_MODEL, "select-supported-model"), FAMILY_MISMATCH: defineError("routing", false, PROJECT_PARAMETER_SCHEMAS.FAMILY_MISMATCH, "select-correct-family"), CLI_VERSION_UNSUPPORTED: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.CLI_VERSION_UNSUPPORTED, "upgrade-cli"), AUTH_UNAVAILABLE: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.AUTH_UNAVAILABLE, "repair-authentication"), CLI_MISSING: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.CLI_MISSING, "install-cli"),
  RATE_LIMITED: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.RATE_LIMITED, "retry-after-backoff"), TIMEOUT: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.TIMEOUT, "retry-unchanged-attempt"), CANCELLED: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.CANCELLED, "restart-child-attempt"), MODEL_OUTPUT_INVALID: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.MODEL_OUTPUT_INVALID, "retry-unchanged-attempt"), IO_ERROR: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.IO_ERROR, "retry-unchanged-attempt"), OUTPUT_OVERFLOW: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.OUTPUT_OVERFLOW, "reduce-output"), PROCESS_FAILED: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.PROCESS_FAILED, "repair-before-fresh-attempt"),
} as const satisfies CompleteErrorRegistry<ProjectErrorCode, ErrorOwner>);

export type ProjectErrorDefinitionByCode = typeof PROJECT_ERROR_DEFINITIONS;
export type ErrorValue<R, K extends keyof R> = Readonly<{ schema_version: "1"; code: K; owner: R[K] extends ErrorDefinition<any, infer O, any, any> ? O : never; retryable: R[K] extends ErrorDefinition<any, any, infer B, any> ? B : never; diagnostic: Readonly<{ template_id: K; parameters: R[K] extends ErrorDefinition<infer P, any, any, any> ? P : never }>; next_action: R[K] extends ErrorDefinition<any, any, any, infer A> ? A : never }>;
export type ProjectError = { readonly [K in ProjectErrorCode]: ErrorValue<ProjectErrorDefinitionByCode, K> }[ProjectErrorCode];
export type ProjectResult<T> = { readonly schema_version: "1"; readonly ok: true; readonly value: T } | { readonly schema_version: "1"; readonly ok: false; readonly error: ProjectError };

function constructError<R extends Readonly<Record<string, ErrorDefinition<any, any, any, any>>>, K extends keyof R>(registry: R, code: K, parameters: unknown): ErrorValue<R, K> {
  const definition = registry[code]!;
  const parsed = definition.parameter_parser.parse(parameters);
  return Object.freeze({ schema_version: "1", code, owner: definition.owner, retryable: definition.retryable, diagnostic: Object.freeze({ template_id: code, parameters: parsed }), next_action: definition.action }) as ErrorValue<R, K>;
}
export function createProjectError<K extends ProjectErrorCode>(code: K, parameters: z.input<(typeof PROJECT_PARAMETER_SCHEMAS)[K]>): ErrorValue<ProjectErrorDefinitionByCode, K> { return constructError(PROJECT_ERROR_DEFINITIONS, code, parameters); }

const errorShellSchema = object({ schema_version: z.literal("1"), code: z.string(), owner: z.string(), retryable: z.boolean(), diagnostic: object({ template_id: z.string(), parameters: z.record(z.string(), z.unknown()) }), next_action: z.string() });

function parseSerializedError<R extends Readonly<Record<string, ErrorDefinition<any, any, any, any>>>>(registry: R, value: unknown, label: string): ErrorValue<R, keyof R> {
  assertPlainJson(value, label);
  const shell = errorShellSchema.parse(value);
  if (!Object.hasOwn(registry, shell.code)) throw new TypeError(`${label}: unknown code`);
  const code = shell.code as keyof R;
  const expected = constructError(registry, code, shell.diagnostic.parameters);
  if (!isDeepStrictEqual(shell, expected)) throw new TypeError(`${label}: fields do not match the error registry`);
  return value as ErrorValue<R, keyof R>;
}
export function parseProjectError(value: unknown): ProjectError { return parseSerializedError(PROJECT_ERROR_DEFINITIONS, value, "project error") as ProjectError; }

/**
 * Generation-only view of the exact Zod tables behind the registry, keyed the way the generated
 * documents name their `$defs`. This grants no new authority — the same schemas already decide
 * every parse above — and the registry stays compile-time-closed: these are the `as const`
 * tables themselves, not widened copies, so a code or shape can still only be added here.
 */
export const internalErrorSchemaTables = Object.freeze({
  project: Object.freeze({
    parameters: PROJECT_PARAMETER_SCHEMAS,
    primitives: Object.freeze({ digest, id, code, version, integer, adapter, family }),
    shared: Object.freeze({ validationIssues, adapterOnly: adapterOnlyParams, adapterAttempt: adapterAttemptParams }),
  }),
});
