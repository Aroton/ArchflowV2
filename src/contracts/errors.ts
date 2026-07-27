import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

import { safeCodeV1Schema, safeIdV1Schema, safeIntegerV1Schema, safeVersionV1Schema, sha256DigestV1Schema } from "./evidence.js";
import type { Sha256Digest } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { decodePhaseInstance, type PhaseInstanceId } from "./phase-instance.js";
import { taskPathClaimV1Schema, type TaskPathClaim } from "./path-claims.js";
import { GATE_KINDS, type GateKind } from "./gates.js";
import type { AdapterId, ModelFamily } from "./review.js";
import { TOOL_NAMES, type ToolName } from "./tool-names.js";

export type ErrorOwner = "contracts" | "config" | "repository" | "paths" | "policy" | "state" | "intent" | "snapshot" | "gate" | "routing" | "dispatch" | "sandbox" | "protocol" | "integrity";
export type ErrorProjection = "project" | "protocol";
export interface StrictParameterParser<P extends Readonly<Record<string, unknown>>> { readonly parse: (value: unknown) => P }
export interface ErrorDefinition<P extends Readonly<Record<string, unknown>>, O extends ErrorOwner, R extends boolean, A extends string, X extends ErrorProjection> { readonly owner: O; readonly retryable: R; readonly parameter_parser: StrictParameterParser<P>; readonly action: A; readonly projection: X }
export type CompleteErrorRegistry<C extends string, O extends ErrorOwner, X extends ErrorProjection> = Readonly<{ [K in C]: ErrorDefinition<Readonly<Record<string, unknown>>, O, boolean, string, X> }>;

export type ProjectErrorCode = "CONTRACT_INVALID" | "RESULT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED" | "WORKFLOW_INVALID" | "CONFIG_INVALID" | "CONFIG_MODEL_UNSUPPORTED" | "CONFIG_FAMILY_UNSUPPORTED" | "RUNTIME_VERSION_UNSUPPORTED" | "REPOSITORY_NOT_FOUND" | "REPOSITORY_MISMATCH" | "TASK_INVALID" | "PATH_INVALID" | "PATH_ESCAPE" | "TASK_SCOPE_VIOLATION" | "GIT_CONFLICT" | "GIT_DIVERGED" | "HANDOFF_REQUIRED" | "POLICY_BASE_INVALID" | "WORKFLOW_MISMATCH" | "PINNED_CONFIG_MISMATCH" | "STALE_SKILLS" | "STATE_MISSING" | "STATE_INVALID" | "TRANSITION_INVALID" | "INPUT_FINGERPRINT_MISMATCH" | "STATE_CONFLICT" | "SUPPLEMENTAL_REVIEW_REQUIRED" | "INTENT_MISMATCH" | "SNAPSHOT_LIMIT" | "SNAPSHOT_INVALID" | "RESTORE_COLLISION" | "RECONCILIATION_REQUIRED" | "SECRET_DETECTED" | "GATE_ACTIVE" | "GATE_DECISION_INVALID" | "GATE_CANCELLED" | "UNSUPPORTED_HOST" | "UNSUPPORTED_MODEL" | "FAMILY_MISMATCH" | "CLI_VERSION_UNSUPPORTED" | "AUTH_UNAVAILABLE" | "CLI_MISSING" | "SANDBOX_UNAVAILABLE" | "SANDBOX_PROBE_FAILED" | "RATE_LIMITED" | "TIMEOUT" | "CANCELLED" | "MODEL_OUTPUT_INVALID" | "IO_ERROR" | "OUTPUT_OVERFLOW" | "PROCESS_FAILED" | "INTERNAL_ERROR";
export type ProtocolErrorCode = "TOOL_NOT_FOUND" | "TOOL_DISABLED" | "UNSUPPORTED_PROTOCOL" | "INITIALIZATION_REPEATED";

const tool = z.enum(TOOL_NAMES);
const adapter = z.enum(["claude-cli", "codex-cli"] satisfies readonly AdapterId[]);
const family = z.enum(["claude", "codex"] satisfies readonly ModelFamily[]);
const gateKind = z.enum(GATE_KINDS);
const phaseInstance = z.string().refine((value) => { try { decodePhaseInstance(value); return true; } catch { return false; } });
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const digestPair = { expected_digest: sha256DigestV1Schema, observed_digest: sha256DigestV1Schema } as const;
const taskPathClass = { task_id: safeIdV1Schema, path_class: safeCodeV1Schema } as const;
const adapterAttempt = { adapter, attempt: safeIntegerV1Schema } as const;
const sortedPaths = z.array(taskPathClaimV1Schema).min(1).superRefine((items, context) => { for (let index = 1; index < items.length; index += 1) if (items[index - 1]!.localeCompare(items[index]!) >= 0) context.addIssue({ code: "custom", message: "offending_paths must be sorted and unique" }); });

const PROJECT_PARAMETER_SCHEMAS = {
  CONTRACT_INVALID: object({ tool: tool.optional(), issue_code: safeCodeV1Schema, schema_version: safeVersionV1Schema.optional() }),
  RESULT_INVALID: object({ tool, result_id: safeIdV1Schema, expected_digest: sha256DigestV1Schema.optional(), observed_digest: sha256DigestV1Schema.optional() }),
  CONTRACT_VERSION_UNSUPPORTED: object({ schema_version: safeVersionV1Schema, supported_version: safeVersionV1Schema }),
  WORKFLOW_INVALID: object({ issue_code: safeCodeV1Schema }), CONFIG_INVALID: object({ issue_code: safeCodeV1Schema }),
  CONFIG_MODEL_UNSUPPORTED: object({ model: safeIdV1Schema }), CONFIG_FAMILY_UNSUPPORTED: object({ family: safeIdV1Schema }),
  RUNTIME_VERSION_UNSUPPORTED: object({ component: safeIdV1Schema, version: safeVersionV1Schema }),
  REPOSITORY_NOT_FOUND: object({ repository_candidate_digest: sha256DigestV1Schema }), REPOSITORY_MISMATCH: object(digestPair),
  TASK_INVALID: object({ task_id: safeIdV1Schema, issue_code: safeCodeV1Schema }), PATH_INVALID: object(taskPathClass), PATH_ESCAPE: object(taskPathClass), TASK_SCOPE_VIOLATION: object(taskPathClass),
  GIT_CONFLICT: object({ operation: safeCodeV1Schema }), GIT_DIVERGED: object(digestPair), HANDOFF_REQUIRED: object({ phase_instance: phaseInstance }),
  POLICY_BASE_INVALID: object({ expected_digest: sha256DigestV1Schema, observed_digest: sha256DigestV1Schema.optional() }), WORKFLOW_MISMATCH: object(digestPair), PINNED_CONFIG_MISMATCH: object(digestPair), STALE_SKILLS: object(digestPair),
  STATE_MISSING: object({ phase_instance: phaseInstance }), STATE_INVALID: object({ phase_instance: phaseInstance, issue_code: safeCodeV1Schema }), TRANSITION_INVALID: object({ phase_instance: phaseInstance, from: safeCodeV1Schema, to: safeCodeV1Schema }),
  INPUT_FINGERPRINT_MISMATCH: object(digestPair), STATE_CONFLICT: object({ expected_revision: safeIntegerV1Schema, observed_revision: safeIntegerV1Schema }), SUPPLEMENTAL_REVIEW_REQUIRED: object({ gate_id: safeIdV1Schema, evidence_digest: sha256DigestV1Schema }), INTENT_MISMATCH: object(digestPair),
  SNAPSHOT_LIMIT: object({ limit_scope: z.enum(["result", "task"]), offending_paths: sortedPaths, current_bytes: safeIntegerV1Schema, byte_cap: safeIntegerV1Schema }), SNAPSHOT_INVALID: object({ snapshot_digest: sha256DigestV1Schema, issue_code: safeCodeV1Schema }), RESTORE_COLLISION: object({ gate_id: safeIdV1Schema, path_class: safeCodeV1Schema }), RECONCILIATION_REQUIRED: object({ recorded_digest: sha256DigestV1Schema, observed_digest: sha256DigestV1Schema }), SECRET_DETECTED: object({ path_class: safeCodeV1Schema, detector_id: safeIdV1Schema }),
  GATE_ACTIVE: object({ gate_id: safeIdV1Schema, gate_kind: gateKind }), GATE_DECISION_INVALID: object({ gate_id: safeIdV1Schema, gate_kind: gateKind, issue_code: safeCodeV1Schema }), GATE_CANCELLED: object({ gate_id: safeIdV1Schema, gate_kind: gateKind }),
  UNSUPPORTED_HOST: object({ host: safeIdV1Schema }), UNSUPPORTED_MODEL: object({ model: safeIdV1Schema }), FAMILY_MISMATCH: object({ expected_family: family, observed_family: family }),
  CLI_VERSION_UNSUPPORTED: object({ adapter, version: safeVersionV1Schema }), AUTH_UNAVAILABLE: object({ adapter }), CLI_MISSING: object({ adapter }), SANDBOX_UNAVAILABLE: object({ capability: safeIdV1Schema }), SANDBOX_PROBE_FAILED: object({ capability: safeIdV1Schema, failure_class: safeCodeV1Schema }),
  RATE_LIMITED: object(adapterAttempt), TIMEOUT: object({ ...adapterAttempt, limit_ms: safeIntegerV1Schema }), CANCELLED: object({ source: z.enum(["client", "transport"]), attempt: safeIntegerV1Schema }), MODEL_OUTPUT_INVALID: object({ ...adapterAttempt, issue_code: safeCodeV1Schema }), IO_ERROR: object({ operation: safeCodeV1Schema, attempt: safeIntegerV1Schema }), OUTPUT_OVERFLOW: object({ adapter, byte_count: safeIntegerV1Schema, byte_cap: safeIntegerV1Schema }), PROCESS_FAILED: object({ adapter, exit_class: safeCodeV1Schema }), INTERNAL_ERROR: object({ correlation_id: safeIdV1Schema }),
} as const satisfies Record<ProjectErrorCode, z.ZodType<Readonly<Record<string, unknown>>>>;

const PROTOCOL_PARAMETER_SCHEMAS = {
  TOOL_NOT_FOUND: object({ tool_name_digest: sha256DigestV1Schema }), TOOL_DISABLED: object({ tool, lifecycle_state: safeCodeV1Schema }), UNSUPPORTED_PROTOCOL: object({ offered_version: safeVersionV1Schema, supported_version: safeVersionV1Schema }), INITIALIZATION_REPEATED: object({ connection_id: safeIdV1Schema }),
} as const satisfies Record<ProtocolErrorCode, z.ZodType<Readonly<Record<string, unknown>>>>;

function parser<P extends Readonly<Record<string, unknown>>>(schema: z.ZodType<P>): StrictParameterParser<P> { return Object.freeze({ parse(value: unknown): P { assertPlainJson(value, "error parameters"); return schema.parse(value); } }); }
function defineError<P extends Readonly<Record<string, unknown>>, O extends ErrorOwner, R extends boolean, A extends string, X extends ErrorProjection>(owner: O, retryable: R, schema: z.ZodType<P>, action: A, projection: X): ErrorDefinition<P, O, R, A, X> { return Object.freeze({ owner, retryable, parameter_parser: parser(schema), action, projection }); }

export const PROJECT_ERROR_DEFINITIONS = Object.freeze({
  CONTRACT_INVALID: defineError("contracts", false, PROJECT_PARAMETER_SCHEMAS.CONTRACT_INVALID, "correct-contract", "project"), RESULT_INVALID: defineError("integrity", false, PROJECT_PARAMETER_SCHEMAS.RESULT_INVALID, "repair-retained-result", "project"), CONTRACT_VERSION_UNSUPPORTED: defineError("contracts", false, PROJECT_PARAMETER_SCHEMAS.CONTRACT_VERSION_UNSUPPORTED, "upgrade-caller", "project"),
  WORKFLOW_INVALID: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.WORKFLOW_INVALID, "repair-workflow", "project"), CONFIG_INVALID: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_INVALID, "repair-config", "project"), CONFIG_MODEL_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_MODEL_UNSUPPORTED, "select-supported-model", "project"), CONFIG_FAMILY_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.CONFIG_FAMILY_UNSUPPORTED, "select-supported-family", "project"), RUNTIME_VERSION_UNSUPPORTED: defineError("config", false, PROJECT_PARAMETER_SCHEMAS.RUNTIME_VERSION_UNSUPPORTED, "upgrade-runtime", "project"),
  REPOSITORY_NOT_FOUND: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.REPOSITORY_NOT_FOUND, "open-repository", "project"), REPOSITORY_MISMATCH: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.REPOSITORY_MISMATCH, "reopen-task-worktree", "project"), TASK_INVALID: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.TASK_INVALID, "repair-task", "project"), PATH_INVALID: defineError("paths", false, PROJECT_PARAMETER_SCHEMAS.PATH_INVALID, "use-valid-path-claim", "project"), PATH_ESCAPE: defineError("paths", false, PROJECT_PARAMETER_SCHEMAS.PATH_ESCAPE, "use-task-relative-path", "project"), TASK_SCOPE_VIOLATION: defineError("paths", false, PROJECT_PARAMETER_SCHEMAS.TASK_SCOPE_VIOLATION, "use-task-scoped-path", "project"), GIT_CONFLICT: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.GIT_CONFLICT, "resolve-git-conflict", "project"), GIT_DIVERGED: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.GIT_DIVERGED, "reconcile-git-history", "project"), HANDOFF_REQUIRED: defineError("repository", false, PROJECT_PARAMETER_SCHEMAS.HANDOFF_REQUIRED, "complete-clean-handoff", "project"),
  POLICY_BASE_INVALID: defineError("policy", false, PROJECT_PARAMETER_SCHEMAS.POLICY_BASE_INVALID, "restore-policy-base", "project"), WORKFLOW_MISMATCH: defineError("policy", false, PROJECT_PARAMETER_SCHEMAS.WORKFLOW_MISMATCH, "restore-pinned-workflow", "project"), PINNED_CONFIG_MISMATCH: defineError("policy", false, PROJECT_PARAMETER_SCHEMAS.PINNED_CONFIG_MISMATCH, "restore-pinned-config", "project"), STALE_SKILLS: defineError("policy", false, PROJECT_PARAMETER_SCHEMAS.STALE_SKILLS, "refresh-skills", "project"),
  STATE_MISSING: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.STATE_MISSING, "initialize-state", "project"), STATE_INVALID: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.STATE_INVALID, "repair-state", "project"), TRANSITION_INVALID: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.TRANSITION_INVALID, "select-valid-transition", "project"), INPUT_FINGERPRINT_MISMATCH: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.INPUT_FINGERPRINT_MISMATCH, "create-fresh-intent", "project"), STATE_CONFLICT: defineError("state", true, PROJECT_PARAMETER_SCHEMAS.STATE_CONFLICT, "reread-and-retry-intent", "project"), SUPPLEMENTAL_REVIEW_REQUIRED: defineError("state", false, PROJECT_PARAMETER_SCHEMAS.SUPPLEMENTAL_REVIEW_REQUIRED, "triage-supplemental-review", "project"), INTENT_MISMATCH: defineError("intent", false, PROJECT_PARAMETER_SCHEMAS.INTENT_MISMATCH, "create-fresh-intent", "project"),
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
export type ErrorParameterPrimitives = { readonly digest: Sha256Digest; readonly tool: ToolName; readonly phase: PhaseInstanceId; readonly path: TaskPathClaim; readonly gate: GateKind; readonly adapter: AdapterId; readonly family: ModelFamily };
