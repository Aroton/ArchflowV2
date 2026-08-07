import { createHash } from "node:crypto";

import { assertAuthenticInvocationContext, type InvocationContext } from "../contracts/contexts.js";
import { createProjectError, createProtocolError, parseProtocolError, type ProtocolError } from "../contracts/errors.js";
import { safeVersionV1Schema } from "../contracts/evidence.js";
import {
  parseToolCall,
  validateProjectFailureStructure,
  validateProjectResultStructure,
  type ParsedToolCall,
  type StructurallyValidProjectResult
} from "../contracts/mcp-tools.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { isToolName, type ToolName } from "../contracts/tool-names.js";
import { reportInternalError } from "./diagnostics.js";

export type ToolHandler<K extends ToolName> = (
  call: Extract<ParsedToolCall, { readonly name: K }>,
  context: InvocationContext
) => unknown | Promise<unknown>;

export type ToolHandlerRegistry = Readonly<Partial<{
  [K in ToolName]: ToolHandler<K>;
}>>;

declare const authenticatedProtocolErrorBrand: unique symbol;
export type AuthenticatedProtocolError = Readonly<{
  readonly value: ProtocolError;
  readonly [authenticatedProtocolErrorBrand]: true;
}>;

export type ToolProjectOutcome = {
  readonly [K in ToolName]: Readonly<{
    readonly kind: "project-result";
    readonly tool: K;
    readonly result: StructurallyValidProjectResult<K>;
  }>;
}[ToolName];

export type ToolBoundaryOutcome =
  | ToolProjectOutcome
  | Readonly<{
      readonly kind: "protocol-error";
      readonly error: AuthenticatedProtocolError;
    }>;

export interface ToolBoundary {
  readonly invoke: (
    name: string,
    args: unknown,
    context: InvocationContext
  ) => Promise<ToolBoundaryOutcome>;
}

const protocolErrors = new WeakSet<object>();
const boundaries = new WeakSet<object>();
const outcomes = new WeakSet<object>();
const protocolErrorBrand = Symbol("AuthenticatedProtocolError");

function deepFreeze<T>(value: T): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function copyJson<T>(value: T): T {
  return structuredClone(value as PlainJsonValue) as T;
}

export function authenticateProtocolError(value: unknown): AuthenticatedProtocolError {
  const parsed = parseProtocolError(value);
  const copied = deepFreeze(copyJson(parsed));
  const wrapper = { value: copied } as { value: ProtocolError; [protocolErrorBrand]?: true };
  Object.defineProperty(wrapper, protocolErrorBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false
  });
  deepFreeze(wrapper);
  protocolErrors.add(wrapper);
  return wrapper as unknown as AuthenticatedProtocolError;
}

function protocolOutcome(error: ProtocolError): ToolBoundaryOutcome {
  const wrapper = authenticateProtocolError(error);
  const outcome = deepFreeze({ kind: "protocol-error" as const, error: wrapper });
  outcomes.add(outcome);
  return outcome;
}

function projectOutcome<K extends ToolName>(
  tool: K,
  result: StructurallyValidProjectResult<K>
): ToolBoundaryOutcome {
  const outcome = deepFreeze({ kind: "project-result" as const, tool, result });
  outcomes.add(outcome);
  return outcome as ToolProjectOutcome;
}

function projectFailure<K extends ToolName>(
  tool: K,
  code: "CONTRACT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED" | "INTERNAL_ERROR",
  parameters: Readonly<Record<string, unknown>>
): ToolBoundaryOutcome {
  const error = code === "CONTRACT_INVALID"
    ? createProjectError(code, parameters as Parameters<typeof createProjectError<"CONTRACT_INVALID">>[1])
    : code === "CONTRACT_VERSION_UNSUPPORTED"
      ? createProjectError(code, parameters as Parameters<typeof createProjectError<"CONTRACT_VERSION_UNSUPPORTED">>[1])
      : createProjectError(code, parameters as Parameters<typeof createProjectError<"INTERNAL_ERROR">>[1]);
  const result = validateProjectFailureStructure(tool, { schema_version: "1", ok: false, error });
  return projectOutcome(tool, result);
}

function invalidInput<K extends ToolName>(tool: K, issueCode: string): ToolBoundaryOutcome {
  return projectFailure(tool, "CONTRACT_INVALID", { tool, issue_code: issueCode });
}

function internalFailure<K extends ToolName>(tool: K, context: InvocationContext, error: unknown): ToolBoundaryOutcome {
  reportInternalError(context.invocation_id, error);
  return projectFailure(tool, "INTERNAL_ERROR", { correlation_id: context.invocation_id });
}

function copyRegistry(handlers: ToolHandlerRegistry): ToolHandlerRegistry {
  if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new TypeError("a handler registry object is required");
  }
  const prototype = Object.getPrototypeOf(handlers);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("the handler registry must have a plain prototype");
  }
  const copied: Partial<Record<ToolName, ToolHandler<ToolName>>> = {};
  for (const key of Reflect.ownKeys(handlers)) {
    if (typeof key !== "string" || !isToolName(key)) throw new TypeError("the handler registry contains an unknown tool");
    const descriptor = Object.getOwnPropertyDescriptor(handlers, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("handler registry entries must be enumerable data properties");
    }
    if (typeof descriptor.value !== "function") throw new TypeError("tool handlers must be functions");
    const handler = descriptor.value as ToolHandler<ToolName>;
    copied[key] = Object.freeze((call, context) => handler(call, context));
  }
  return deepFreeze(copied) as ToolHandlerRegistry;
}

function classifyVersionedArgs<K extends ToolName>(
  tool: K,
  args: unknown
): { readonly call: Extract<ParsedToolCall, { readonly name: K }> } | { readonly outcome: ToolBoundaryOutcome } {
  try {
    assertPlainJson(args, `${tool} input`);
  } catch {
    return { outcome: invalidInput(tool, "input-not-object") };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { outcome: invalidInput(tool, "input-not-object") };
  }
  let hasSchemaVersion: boolean;
  let descriptor: PropertyDescriptor | undefined;
  try {
    hasSchemaVersion = Object.hasOwn(args, "schema_version");
    descriptor = Object.getOwnPropertyDescriptor(args, "schema_version");
  } catch {
    return { outcome: invalidInput(tool, "input-not-object") };
  }
  if (!hasSchemaVersion) {
    return { outcome: invalidInput(tool, "schema-version-missing") };
  }
  const supplied = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  if (typeof supplied !== "string" || !safeVersionV1Schema.safeParse(supplied).success) {
    return { outcome: invalidInput(tool, "schema-version-invalid") };
  }
  if (supplied !== "1") {
    return {
      outcome: projectFailure(tool, "CONTRACT_VERSION_UNSUPPORTED", {
        schema_version: supplied,
        supported_version: "1"
      })
    };
  }
  try {
    return { call: parseToolCall(tool, args) };
  } catch {
    return { outcome: invalidInput(tool, "input-invalid") };
  }
}

export function createToolBoundary(handlers: ToolHandlerRegistry): ToolBoundary {
  const registry = copyRegistry(handlers);
  const boundary: ToolBoundary = {
    invoke: async (name, args, context): Promise<ToolBoundaryOutcome> => {
      if (typeof name !== "string") throw new TypeError("a string tool name is required");
      assertAuthenticInvocationContext(context);

      if (!isToolName(name)) {
        const toolNameDigest = createHash("sha256").update(name, "utf8").digest("hex");
        return protocolOutcome(createProtocolError("TOOL_NOT_FOUND", { tool_name_digest: toolNameDigest }));
      }

      const classified = classifyVersionedArgs(name, args);
      if ("outcome" in classified) return classified.outcome;

      const handler = registry[name] as ToolHandler<typeof name> | undefined;
      if (handler === undefined) {
        return protocolOutcome(createProtocolError("TOOL_DISABLED", {
          tool: name,
          lifecycle_state: "inert-no-handler"
        }));
      }

      let returned: unknown;
      try {
        returned = await handler(classified.call, context);
      } catch (error) {
        return internalFailure(name, context, error);
      }

      try {
        validateProjectResultStructure(classified.call, returned);
        const copied = copyJson(returned as PlainJsonValue);
        return projectOutcome(name, validateProjectResultStructure(classified.call, copied));
      } catch (error) {
        return internalFailure(name, context, error);
      }
    }
  };
  deepFreeze(boundary);
  boundaries.add(boundary);
  return boundary;
}

export function assertAuthenticToolBoundary(value: unknown): asserts value is ToolBoundary {
  if (value === null || typeof value !== "object" || !boundaries.has(value)) {
    throw new TypeError("an authentic tool boundary is required");
  }
}

export function assertAuthenticToolBoundaryOutcome(value: unknown): asserts value is ToolBoundaryOutcome {
  if (value === null || typeof value !== "object" || !outcomes.has(value)) {
    throw new TypeError("an authentic tool boundary outcome is required");
  }
  if ("kind" in value && value.kind === "protocol-error") {
    const error = (value as { readonly error?: unknown }).error;
    if (error === null || typeof error !== "object" || !protocolErrors.has(error)) {
      throw new TypeError("an authentic protocol error wrapper is required");
    }
  }
}
