import { createHash } from "node:crypto";

import { assertAuthenticInvocationContext, type InvocationContext } from "../contracts/contexts.js";
import { createProtocolError, describeValidationIssues, parseProtocolError, type ProtocolError } from "../contracts/errors.js";
import {
  parseArchFlowApplyInputV1,
  parseArchFlowStatusInputV1,
  parseSemanticResultV1,
  type SemanticResultV1,
  type SemanticToolContractMap,
} from "../contracts/semantic-workflow.js";
import { isAdvertisedToolName, type SemanticToolName } from "../contracts/tool-names.js";
import { reportInternalError } from "./diagnostics.js";

export type SemanticToolHandler<K extends SemanticToolName> = (
  input: SemanticToolContractMap[K]["input"],
  context: InvocationContext
) => unknown | Promise<unknown>;

export type ToolHandlerRegistry = Readonly<Partial<{
  [K in SemanticToolName]: SemanticToolHandler<K>;
}>>;

declare const authenticatedProtocolErrorBrand: unique symbol;
export type AuthenticatedProtocolError = Readonly<{
  readonly value: ProtocolError;
  readonly [authenticatedProtocolErrorBrand]: true;
}>;

export type SemanticToolOutcome = {
  readonly [K in SemanticToolName]: Readonly<{
    readonly kind: "semantic-result";
    readonly tool: K;
    readonly result: SemanticResultV1;
  }>;
}[SemanticToolName];

export type ToolBoundaryOutcome =
  | SemanticToolOutcome
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

export function authenticateProtocolError(value: unknown): AuthenticatedProtocolError {
  const parsed = parseProtocolError(value);
  const wrapper = { value: parsed } as { value: ProtocolError; [protocolErrorBrand]?: true };
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

function semanticOutcome<K extends SemanticToolName>(tool: K, result: SemanticResultV1): ToolBoundaryOutcome {
  const outcome = deepFreeze({ kind: "semantic-result" as const, tool, result });
  outcomes.add(outcome);
  return outcome as SemanticToolOutcome;
}

function semanticFailure(
  tool: SemanticToolName,
  code: string,
  message: string,
  retryable = false
): ToolBoundaryOutcome {
  return semanticOutcome(tool, parseSemanticResultV1({
    schema_version: "1",
    ok: false,
    error: { code, message, retryable },
  }));
}

function copyRegistry(handlers: ToolHandlerRegistry): ToolHandlerRegistry {
  if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new TypeError("a handler registry object is required");
  }
  const prototype = Object.getPrototypeOf(handlers);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("the handler registry must have a plain prototype");
  }
  const copied: Partial<Record<SemanticToolName, (...args: never[]) => unknown>> = {};
  for (const key of Reflect.ownKeys(handlers)) {
    if (typeof key !== "string" || !isAdvertisedToolName(key)) throw new TypeError("the handler registry contains an unknown tool");
    const descriptor = Object.getOwnPropertyDescriptor(handlers, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("handler registry entries must be enumerable data properties");
    }
    if (typeof descriptor.value !== "function") throw new TypeError("tool handlers must be functions");
    const handler = descriptor.value as (...args: never[]) => unknown;
    copied[key] = Object.freeze((...args: never[]) => handler(...args));
  }
  return deepFreeze(copied) as ToolHandlerRegistry;
}

function parseSemanticInput<K extends SemanticToolName>(tool: K, args: unknown):
  { readonly kind: "input"; readonly input: SemanticToolContractMap[K]["input"] }
  | { readonly kind: "outcome"; readonly outcome: ToolBoundaryOutcome } {
  try {
    const input = (tool === "archflow_status" ? parseArchFlowStatusInputV1(args) : parseArchFlowApplyInputV1(args)) as SemanticToolContractMap[K]["input"];
    return { kind: "input", input };
  } catch (error) {
    const issues = describeValidationIssues(error);
    return { kind: "outcome", outcome: semanticFailure(tool, "CONTRACT_INVALID", issues?.join("; ") ?? "The semantic tool input is invalid.") };
  }
}

export function createToolBoundary(handlers: ToolHandlerRegistry): ToolBoundary {
  const registry = copyRegistry(handlers);
  const boundary: ToolBoundary = {
    invoke: async (name, args, context): Promise<ToolBoundaryOutcome> => {
      if (typeof name !== "string") throw new TypeError("a string tool name is required");
      assertAuthenticInvocationContext(context);

      // The retired low-level names are no longer advertised or dispatched: every non-semantic
      // name fails closed here with the digest-only TOOL_NOT_FOUND view, whether it was never a
      // tool or is durable vocabulary in existing state records.
      if (!isAdvertisedToolName(name)) {
        const toolNameDigest = createHash("sha256").update(name, "utf8").digest("hex");
        return protocolOutcome(createProtocolError("TOOL_NOT_FOUND", { tool_name_digest: toolNameDigest }));
      }

      const classified = parseSemanticInput(name, args);
      if (classified.kind === "outcome") return classified.outcome;
      const handler = registry[name] as SemanticToolHandler<typeof name> | undefined;
      if (handler === undefined) {
        return protocolOutcome(createProtocolError("TOOL_DISABLED", { tool: name, lifecycle_state: "inert-no-handler" }));
      }
      let returned: unknown;
      try {
        returned = await handler(classified.input, context);
      } catch (error) {
        reportInternalError(context.invocation_id, error);
        return semanticFailure(name, "INTERNAL_ERROR", `Internal error (${context.invocation_id}).`);
      }
      try {
        return semanticOutcome(name, parseSemanticResultV1(returned));
      } catch (error) {
        reportInternalError(context.invocation_id, error);
        return semanticFailure(name, "INTERNAL_ERROR", `Internal error (${context.invocation_id}).`);
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
