import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

import { pathSafeIdV1Schema, safeCodeV1Schema, safeIdV1Schema, safeIntegerV1Schema, safeVersionV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { Sha256Digest } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { decodePhaseInstance, type PhaseInstanceId } from "./phase-instance.js";
import { PATH_CLASSES, repositoryPathClaimV1Schema, type RepositoryPathClaim } from "./path-claims.js";
import { GATE_KINDS, type GateKind } from "./gates.js";
import type { AdapterId, ModelFamily } from "./review.js";
import { ADVERTISED_TOOL_NAMES, TOOL_NAMES, type ToolName } from "./tool-names.js";

export type ErrorOwner = "contracts" | "config" | "repository" | "paths" | "policy" | "state" | "intent" | "snapshot" | "gate" | "routing" | "dispatch" | "sandbox" | "protocol" | "integrity";
export type ErrorProjection = "project" | "protocol";
export interface StrictParameterParser<P extends Readonly<Record<string, unknown>>> { readonly parse: (value: unknown) => P }
export interface ErrorDefinition<P extends Readonly<Record<string, unknown>>, O extends ErrorOwner, R extends boolean, A extends string, X extends ErrorProjection> { readonly owner: O; readonly retryable: R; readonly parameter_parser: StrictParameterParser<P>; readonly action: A; readonly projection: X }
export type CompleteErrorRegistry<C extends string, O extends ErrorOwner, X extends ErrorProjection> = Readonly<{ [K in C]: ErrorDefinition<Readonly<Record<string, unknown>>, O, boolean, string, X> }>;

export type ProjectErrorCode = "CONTRACT_INVALID" | "RESULT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED" | "ENVELOPE_OVERFLOW" | "WORKFLOW_INVALID" | "CONFIG_INVALID" | "CONFIG_MODEL_UNSUPPORTED" | "CONFIG_FAMILY_UNSUPPORTED" | "RUNTIME_VERSION_UNSUPPORTED" | "REPOSITORY_NOT_FOUND" | "REPOSITORY_MISMATCH" | "TASK_INVALID" | "PATH_INVALID" | "PATH_ESCAPE" | "TASK_SCOPE_VIOLATION" | "GIT_CONFLICT" | "GIT_DIVERGED" | "HANDOFF_REQUIRED" | "POLICY_BASE_INVALID" | "WORKFLOW_MISMATCH" | "STALE_SKILLS" | "STATE_MISSING" | "STATE_INVALID" | "TRANSITION_INVALID" | "INPUT_FINGERPRINT_MISMATCH" | "STATE_CONFLICT" | "INTENT_MISMATCH" | "INTENT_NOT_CURRENT" | "SNAPSHOT_LIMIT" | "SNAPSHOT_INVALID" | "RESTORE_COLLISION" | "RECONCILIATION_REQUIRED" | "SECRET_DETECTED" | "GATE_ACTIVE" | "GATE_DECISION_INVALID" | "GATE_CANCELLED" | "UNSUPPORTED_HOST" | "UNSUPPORTED_MODEL" | "FAMILY_MISMATCH" | "CLI_VERSION_UNSUPPORTED" | "AUTH_UNAVAILABLE" | "CLI_MISSING" | "SANDBOX_UNAVAILABLE" | "SANDBOX_PROBE_FAILED" | "RATE_LIMITED" | "TIMEOUT" | "CANCELLED" | "MODEL_OUTPUT_INVALID" | "IO_ERROR" | "OUTPUT_OVERFLOW" | "PROCESS_FAILED" | "INTERNAL_ERROR";
export type ProtocolErrorCode = "TOOL_NOT_FOUND" | "TOOL_DISABLED" | "UNSUPPORTED_PROTOCOL" | "INITIALIZATION_REPEATED";

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
const taskSlug = documentScoped(taskSlugV1Schema);
const pathSafeId = documentScoped(pathSafeIdV1Schema);
const code = documentScoped(safeCodeV1Schema);
const version = documentScoped(safeVersionV1Schema);
const integer = documentScoped(safeIntegerV1Schema);
const repositoryPathClaim = documentScoped(repositoryPathClaimV1Schema);
const tool = z.enum(TOOL_NAMES);
const adapter = z.enum(["claude-cli", "codex-cli"] satisfies readonly AdapterId[]);
const family = z.enum(["claude", "codex"] satisfies readonly ModelFamily[]);
const gateKind = z.enum(GATE_KINDS);
const phaseInstance = z.string().regex(/^(prd|design|phase-design-[1-9][0-9]*|phase-impl-[1-9][0-9]*)$/u).refine((value) => { try { decodePhaseInstance(value); return true; } catch { return false; } });
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const digestPair = { expected_digest: digest, observed_digest: digest } as const;
const pathClass = z.enum(PATH_CLASSES);
const taskPathClass = { task_id: taskSlug, path_class: pathClass } as const;
const adapterAttempt = { adapter, attempt: integer } as const;
const sortedPaths = z.array(repositoryPathClaim).min(1).superRefine((items, context) => { for (let index = 1; index < items.length; index += 1) if (items[index - 1]!.localeCompare(items[index]!) >= 0) context.addIssue({ code: "custom", message: "offending_paths must be sorted and unique" }); })
  .meta({ uniqueItems: true, "x-archflow-sorted-unique": true });
const validationIssues = z.array(z.string().min(1).max(256)).min(1).max(5);

// Shared single instances so the generated schema emits one `$defs` entry with `$ref`s at each
// use site, mirroring the def layout the hand-written document established.
const issueParams = object({ issue_code: code });
const digestsParams = object(digestPair);
const taskPathParams = object(taskPathClass);
const gateParams = object({ gate_id: pathSafeId, gate_kind: gateKind });
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
    const issues = error.issues.slice(0, 5).map((issue) => {
      const path = issue.path.length === 0 ? "input" : issue.path.map(String).join(".");
      return `${path}: ${issue.message}`.slice(0, 256);
    });
    if (issues.length > 0) return issues;
  }
  return error instanceof Error && error.message !== "" ? [error.message.slice(0, 256)] : undefined;
}

const PROJECT_PARAMETER_SCHEMAS = {
  CONTRACT_INVALID: object({ tool: tool.optional(), issue_code: code, schema_version: version.optional(), issues: validationIssues.optional() }),
  RESULT_INVALID: object({ tool, result_id: id, expected_digest: digest.optional(), observed_digest: digest.optional() }),
  CONTRACT_VERSION_UNSUPPORTED: object({ schema_version: version, supported_version: version }),
  ENVELOPE_OVERFLOW: object({ offending_paths: sortedPaths, current_bytes: integer, byte_cap: integer }),
  WORKFLOW_INVALID: issueParams, CONFIG_INVALID: issueParams,
  CONFIG_MODEL_UNSUPPORTED: object({ model: id }), CONFIG_FAMILY_UNSUPPORTED: object({ family: id }),
  RUNTIME_VERSION_UNSUPPORTED: object({ component: id, version }),
  REPOSITORY_NOT_FOUND: object({ repository_candidate_digest: digest }), REPOSITORY_MISMATCH: digestsParams,
  TASK_INVALID: object({ task_id: taskSlug, issue_code: code }), PATH_INVALID: taskPathParams, PATH_ESCAPE: taskPathParams, TASK_SCOPE_VIOLATION: taskPathParams,
  GIT_CONFLICT: object({ operation: code }), GIT_DIVERGED: digestsParams, HANDOFF_REQUIRED: object({ phase_instance: phaseInstance }),
  POLICY_BASE_INVALID: object({ expected_digest: digest, observed_digest: digest.optional() }), WORKFLOW_MISMATCH: digestsParams, STALE_SKILLS: digestsParams,
  STATE_MISSING: object({ phase_instance: phaseInstance }), STATE_INVALID: object({ phase_instance: phaseInstance, issue_code: code }), TRANSITION_INVALID: object({ phase_instance: phaseInstance, from: code, to: code }),
  INPUT_FINGERPRINT_MISMATCH: digestsParams, STATE_CONFLICT: object({ expected_revision: integer, observed_revision: integer }), INTENT_MISMATCH: digestsParams, INTENT_NOT_CURRENT: object({ intent_id: pathSafeId, receipt_revision: integer, current_revision: integer }),
  SNAPSHOT_LIMIT: object({ limit_scope: z.enum(["result", "task"]), offending_paths: sortedPaths, current_bytes: integer, byte_cap: integer }), SNAPSHOT_INVALID: object({ snapshot_digest: digest, issue_code: code }), RESTORE_COLLISION: object({ gate_id: pathSafeId, path_class: pathClass }), RECONCILIATION_REQUIRED: object({ recorded_digest: digest, observed_digest: digest }), SECRET_DETECTED: object({ path_class: pathClass, detector_id: id }),
  GATE_ACTIVE: gateParams, GATE_DECISION_INVALID: object({ gate_id: pathSafeId, gate_kind: gateKind, issue_code: code }), GATE_CANCELLED: gateParams,
  UNSUPPORTED_HOST: object({ host: id }), UNSUPPORTED_MODEL: object({ model: id }), FAMILY_MISMATCH: object({ expected_family: family, observed_family: family }),
  CLI_VERSION_UNSUPPORTED: object({ adapter, version }), AUTH_UNAVAILABLE: adapterOnlyParams, CLI_MISSING: adapterOnlyParams, SANDBOX_UNAVAILABLE: object({ capability: id }), SANDBOX_PROBE_FAILED: object({ capability: id, failure_class: code }),
  RATE_LIMITED: adapterAttemptParams, TIMEOUT: object({ ...adapterAttempt, limit_ms: integer }), CANCELLED: object({ source: z.enum(["client", "transport"]), attempt: integer }), MODEL_OUTPUT_INVALID: object({ ...adapterAttempt, issue_code: code }), IO_ERROR: object({ operation: code, attempt: integer }), OUTPUT_OVERFLOW: object({ adapter, byte_count: integer, byte_cap: integer }), PROCESS_FAILED: object({ adapter, exit_class: code }), INTERNAL_ERROR: object({ correlation_id: id }),
} as const satisfies Record<ProjectErrorCode, z.ZodType<Readonly<Record<string, unknown>>>>;

// The protocol document registers its own `$defs`, so its primitives are separate clones.
const protocolDigest = documentScoped(sha256DigestV1Schema);
const protocolId = documentScoped(safeIdV1Schema);
const protocolCode = documentScoped(safeCodeV1Schema);
const protocolVersion = documentScoped(safeVersionV1Schema);
const protocolTool = documentScoped(z.enum(ADVERTISED_TOOL_NAMES));

const PROTOCOL_PARAMETER_SCHEMAS = {
  TOOL_NOT_FOUND: object({ tool_name_digest: protocolDigest }), TOOL_DISABLED: object({ tool: protocolTool, lifecycle_state: protocolCode }), UNSUPPORTED_PROTOCOL: object({ offered_version: protocolVersion, supported_version: protocolVersion }), INITIALIZATION_REPEATED: object({ connection_id: protocolId }),
} as const satisfies Record<ProtocolErrorCode, z.ZodType<Readonly<Record<string, unknown>>>>;

function parser<P extends Readonly<Record<string, unknown>>>(schema: z.ZodType<P>): StrictParameterParser<P> { return Object.freeze({ parse(value: unknown): P { assertPlainJson(value, "error parameters"); return schema.parse(value); } }); }
function defineError<P extends Readonly<Record<string, unknown>>, O extends ErrorOwner, R extends boolean, A extends string, X extends ErrorProjection>(owner: O, retryable: R, schema: z.ZodType<P>, action: A, projection: X): ErrorDefinition<P, O, R, A, X> { return Object.freeze({ owner, retryable, parameter_parser: parser(schema), action, projection }); }

export const PROJECT_ERROR_DEFINITIONS = Object.freeze({
  CONTRACT_INVALID: defineError("contracts", false, PROJECT_PARAMETER_SCHEMAS.CONTRACT_INVALID, "correct-contract", "project"), RESULT_INVALID: defineError("integrity", false, PROJECT_PARAMETER_SCHEMAS.RESULT_INVALID, "repair-retained-result", "project"), CONTRACT_VERSION_UNSUPPORTED: defineError("contracts", false, PROJECT_PARAMETER_SCHEMAS.CONTRACT_VERSION_UNSUPPORTED, "upgrade-caller", "project"), ENVELOPE_OVERFLOW: defineError("contracts", false, PROJECT_PARAMETER_SCHEMAS.ENVELOPE_OVERFLOW, "reduce-review-subject", "project"),
  WORKFLOW_INVALID: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.WORKFLOW_INVALID, "repair-workflow", "project"), CONFIG_INVALID: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_INVALID, "repair-config", "project"), CONFIG_MODEL_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_MODEL_UNSUPPORTED, "select-supported-model", "project"), CONFIG_FAMILY_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_FAMILY_UNSUPPORTED, "select-supported-family", "project"), RUNTIME_VERSION_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.RUNTIME_VERSION_UNSUPPORTED, "upgrade-runtime", "project"),
  REPOSITORY_NOT_FOUND: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.REPOSITORY_NOT_FOUND, "open-repository", "project"), REPOSITORY_MISMATCH: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.REPOSITORY_MISMATCH, "reopen-task-worktree", "project"), TASK_INVALID: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.TASK_INVALID, "repair-task", "project"), PATH_INVALID: defineError("paths", false, PROJECT_PARAMETER_SCHEMAS.PATH_INVALID, "use-valid-path-claim", "project"), PATH_ESCAPE: defineError("paths", false, PROJECT_PARAMETER_SCHEMAS.PATH_ESCAPE, "use-task-relative-path", "project"), TASK_SCOPE_VIOLATION: defineError("paths", false, PROJECT_PARAMETER_SCHEMAS.TASK_SCOPE_VIOLATION, "use-task-scoped-path", "project"), GIT_CONFLICT: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.GIT_CONFLICT, "resolve-git-conflict", "project"), GIT_DIVERGED: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.GIT_DIVERGED, "reconcile-git-history", "project"), HANDOFF_REQUIRED: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.HANDOFF_REQUIRED, "complete-clean-handoff", "project"),
  POLICY_BASE_INVALID: defineError("policy", false, PROJECT_PARAMETER_SCHEMAS.POLICY_BASE_INVALID, "restore-policy-base", "project"), WORKFLOW_MISMATCH: defineError("policy", false, PROJECT_PARAMETER_SCHEMAS.WORKFLOW_MISMATCH, "restore-pinned-workflow", "project"), STALE_SKILLS: defineError("policy", false, PROJECT_PARAMETER_SCHEMAS.STALE_SKILLS, "refresh-skills", "project"),
  STATE_MISSING: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.STATE_MISSING, "initialize-state", "project"), STATE_INVALID: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.STATE_INVALID, "inspect-current-state", "project"), TRANSITION_INVALID: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.TRANSITION_INVALID, "select-valid-transition", "project"), INPUT_FINGERPRINT_MISMATCH: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.INPUT_FINGERPRINT_MISMATCH, "create-fresh-intent", "project"), STATE_CONFLICT: defineError("state", true, PROJECT_PARAMETER_SCHEMAS.STATE_CONFLICT, "reread-and-retry-intent", "project"), INTENT_MISMATCH: defineError("intent", false, PROJECT_PARAMETER_SCHEMAS.INTENT_MISMATCH, "create-fresh-intent", "project"), INTENT_NOT_CURRENT: defineError("intent", false, PROJECT_PARAMETER_SCHEMAS.INTENT_NOT_CURRENT, "inspect-current-state", "project"),
  SNAPSHOT_LIMIT: defineError("snapshot", false, PROJECT_PARAMETER_SCHEMAS.SNAPSHOT_LIMIT, "reduce-snapshot", "project"), SNAPSHOT_INVALID: defineError("snapshot", false, PROJECT_PARAMETER_SCHEMAS.SNAPSHOT_INVALID, "repair-snapshot", "project"), RESTORE_COLLISION: defineError("snapshot", false, PROJECT_PARAMETER_SCHEMAS.RESTORE_COLLISION, "resolve-restore-gate", "project"), RECONCILIATION_REQUIRED: defineError("snapshot", false, PROJECT_PARAMETER_SCHEMAS.RECONCILIATION_REQUIRED, "run-reconciliation", "project"), SECRET_DETECTED: defineError("snapshot", false, PROJECT_PARAMETER_SCHEMAS.SECRET_DETECTED, "remove-secret", "project"),
  GATE_ACTIVE: defineError("gate", false, PROJECT_PARAMETER_SCHEMAS.GATE_ACTIVE, "resolve-recorded-gate", "project"), GATE_DECISION_INVALID: defineError("gate", false, PROJECT_PARAMETER_SCHEMAS.GATE_DECISION_INVALID, "record-valid-gate-decision", "project"), GATE_CANCELLED: defineError("gate", false, PROJECT_PARAMETER_SCHEMAS.GATE_CANCELLED, "restart-gate-flow", "project"),
  UNSUPPORTED_HOST: defineError("routing", false, PROJECT_PARAMETER_SCHEMAS.UNSUPPORTED_HOST, "select-supported-host", "project"), UNSUPPORTED_MODEL: defineError("routing", false, PROJECT_PARAMETER_SCHEMAS.UNSUPPORTED_MODEL, "select-supported-model", "project"), FAMILY_MISMATCH: defineError("routing", false, PROJECT_PARAMETER_SCHEMAS.FAMILY_MISMATCH, "select-correct-family", "project"), CLI_VERSION_UNSUPPORTED: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.CLI_VERSION_UNSUPPORTED, "upgrade-cli", "project"), AUTH_UNAVAILABLE: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.AUTH_UNAVAILABLE, "repair-authentication", "project"), CLI_MISSING: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.CLI_MISSING, "install-cli", "project"), SANDBOX_UNAVAILABLE: defineError("sandbox", false, PROJECT_PARAMETER_SCHEMAS.SANDBOX_UNAVAILABLE, "repair-sandbox", "project"), SANDBOX_PROBE_FAILED: defineError("sandbox", false, PROJECT_PARAMETER_SCHEMAS.SANDBOX_PROBE_FAILED, "repair-sandbox", "project"),
  RATE_LIMITED: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.RATE_LIMITED, "retry-after-backoff", "project"), TIMEOUT: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.TIMEOUT, "retry-unchanged-attempt", "project"), CANCELLED: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.CANCELLED, "restart-child-attempt", "project"), MODEL_OUTPUT_INVALID: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.MODEL_OUTPUT_INVALID, "retry-unchanged-attempt", "project"), IO_ERROR: defineError("dispatch", true, PROJECT_PARAMETER_SCHEMAS.IO_ERROR, "retry-unchanged-attempt", "project"), OUTPUT_OVERFLOW: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.OUTPUT_OVERFLOW, "reduce-output", "project"), PROCESS_FAILED: defineError("dispatch", false, PROJECT_PARAMETER_SCHEMAS.PROCESS_FAILED, "repair-before-fresh-attempt", "project"), INTERNAL_ERROR: defineError("integrity", false, PROJECT_PARAMETER_SCHEMAS.INTERNAL_ERROR, "stop-and-inspect", "project"),
} as const satisfies CompleteErrorRegistry<ProjectErrorCode, ErrorOwner, "project">);

export const PROTOCOL_ERROR_DEFINITIONS = Object.freeze({
  TOOL_NOT_FOUND: defineError("protocol", false, PROTOCOL_PARAMETER_SCHEMAS.TOOL_NOT_FOUND, "call-advertised-tool", "protocol"), TOOL_DISABLED: defineError("protocol", false, PROTOCOL_PARAMETER_SCHEMAS.TOOL_DISABLED, "wait-for-tool-enable", "protocol"), UNSUPPORTED_PROTOCOL: defineError("protocol", false, PROTOCOL_PARAMETER_SCHEMAS.UNSUPPORTED_PROTOCOL, "negotiate-supported-protocol", "protocol"), INITIALIZATION_REPEATED: defineError("protocol", false, PROTOCOL_PARAMETER_SCHEMAS.INITIALIZATION_REPEATED, "open-new-connection", "protocol"),
} as const satisfies CompleteErrorRegistry<ProtocolErrorCode, "protocol", "protocol">);

export type ProjectErrorDefinitionByCode = typeof PROJECT_ERROR_DEFINITIONS;
export type ProtocolErrorDefinitionByCode = typeof PROTOCOL_ERROR_DEFINITIONS;
export type ErrorValue<R, K extends keyof R> = Readonly<{ schema_version: "1"; code: K; owner: R[K] extends ErrorDefinition<any, infer O, any, any, any> ? O : never; retryable: R[K] extends ErrorDefinition<any, any, infer B, any, any> ? B : never; diagnostic: Readonly<{ template_id: K; parameters: R[K] extends ErrorDefinition<infer P, any, any, any, any> ? P : never }>; next_action: R[K] extends ErrorDefinition<any, any, any, infer A, any> ? A : never }>;
export type ProjectError = { readonly [K in ProjectErrorCode]: ErrorValue<ProjectErrorDefinitionByCode, K> }[ProjectErrorCode];
export type ProtocolError = { readonly [K in ProtocolErrorCode]: ErrorValue<ProtocolErrorDefinitionByCode, K> }[ProtocolErrorCode];
export type ProjectResult<T> = { readonly schema_version: "1"; readonly ok: true; readonly value: T } | { readonly schema_version: "1"; readonly ok: false; readonly error: ProjectError };

function constructError<R extends Readonly<Record<string, ErrorDefinition<any, any, any, any, any>>>, K extends keyof R>(registry: R, code: K, parameters: unknown): ErrorValue<R, K> {
  const definition = registry[code]!;
  const parsed = definition.parameter_parser.parse(parameters);
  return Object.freeze({ schema_version: "1", code, owner: definition.owner, retryable: definition.retryable, diagnostic: Object.freeze({ template_id: code, parameters: parsed }), next_action: definition.action }) as ErrorValue<R, K>;
}
export function createProjectError<K extends ProjectErrorCode>(code: K, parameters: z.input<(typeof PROJECT_PARAMETER_SCHEMAS)[K]>): ErrorValue<ProjectErrorDefinitionByCode, K> { return constructError(PROJECT_ERROR_DEFINITIONS, code, parameters); }
export function createProtocolError<K extends ProtocolErrorCode>(code: K, parameters: z.input<(typeof PROTOCOL_PARAMETER_SCHEMAS)[K]>): ErrorValue<ProtocolErrorDefinitionByCode, K> { return constructError(PROTOCOL_ERROR_DEFINITIONS, code, parameters); }

function parseSerializedError<R extends Readonly<Record<string, ErrorDefinition<any, any, any, any, any>>>>(registry: R, value: unknown, label: string): ErrorValue<R, keyof R> {
  assertPlainJson(value, label);
  const shell = object({ schema_version: z.literal("1"), code: z.string(), owner: z.string(), retryable: z.boolean(), diagnostic: object({ template_id: z.string(), parameters: z.record(z.string(), z.unknown()) }), next_action: z.string() }).parse(value);
  if (!Object.hasOwn(registry, shell.code)) throw new TypeError(`${label}: unknown code`);
  const code = shell.code as keyof R;
  const expected = constructError(registry, code, shell.diagnostic.parameters);
  if (!isDeepStrictEqual(shell, expected)) throw new TypeError(`${label}: fields do not match the error registry`);
  return value as ErrorValue<R, keyof R>;
}
export function parseProjectError(value: unknown): ProjectError { return parseSerializedError(PROJECT_ERROR_DEFINITIONS, value, "project error") as ProjectError; }
export function parseProtocolError(value: unknown): ProtocolError { return parseSerializedError(PROTOCOL_ERROR_DEFINITIONS, value, "protocol error") as ProtocolError; }

// Type-only exports make the exact table primitives discoverable without granting authority.
export type ErrorParameterPrimitives = { readonly digest: Sha256Digest; readonly tool: ToolName; readonly phase: PhaseInstanceId; readonly path: RepositoryPathClaim; readonly gate: GateKind; readonly adapter: AdapterId; readonly family: ModelFamily };

/**
 * Generation-only view of the exact Zod tables behind the registry, keyed the way the generated
 * documents name their `$defs`. This grants no new authority — the same schemas already decide
 * every parse above — and the registry stays compile-time-closed: these are the `as const`
 * tables themselves, not widened copies, so a code or shape can still only be added here.
 */
export const internalErrorSchemaTables = Object.freeze({
  project: Object.freeze({
    parameters: PROJECT_PARAMETER_SCHEMAS,
    primitives: Object.freeze({ digest, id, taskSlug, pathSafeId, pathClass, code, version, integer, tool, adapter, family, gate: gateKind, phase: phaseInstance, repositoryPathClaim }),
    shared: Object.freeze({ issue: issueParams, validationIssues, digests: digestsParams, taskPath: taskPathParams, gateParams, adapterOnly: adapterOnlyParams, adapterAttempt: adapterAttemptParams }),
  }),
  protocol: Object.freeze({
    parameters: PROTOCOL_PARAMETER_SCHEMAS,
    primitives: Object.freeze({ digest: protocolDigest, id: protocolId, code: protocolCode, version: protocolVersion, tool: protocolTool }),
  }),
});
