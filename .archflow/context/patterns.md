# Codebase Patterns and Conventions

**Date:** 2026-07-28  
**Commit:** 91a7c95

---

## Naming Conventions

### TypeScript/JavaScript

- **Variables, functions, methods:** camelCase
  ```typescript
  const sessionState = "READY";
  function parsePhaseInstance(value: unknown): PhaseInstance { }
  ```

- **Type names and interfaces:** PascalCase
  ```typescript
  interface ConnectionContext { }
  type ToolName = string & { readonly [toolNameBrand]: true };
  type ProjectError = { /* ... */ };
  ```

- **Constants and enums:** UPPER_CASE or PascalCase for enum values
  ```typescript
  const TOOL_NAMES = Object.freeze(["archflow_state", "archflow_counter_review"]);
  const MAX_ENTRIES = 1_024;
  export type ErrorOwner = "contracts" | "config" | "repository" | "paths" | "policy" | "state";
  ```

- **Branded type symbols:** Unique symbols with descriptive names
  ```typescript
  declare const positiveSafePhaseBrand: unique symbol;
  declare const phaseInstanceIdBrand: unique symbol;
  export type PositiveSafePhaseNumber = number & { readonly [positiveSafePhaseBrand]: true };
  ```

- **Unique Symbol declarations:** Descriptive names prefixed with the concept
  ```typescript
  const connectionContextBrand: unique symbol = Symbol("ConnectionContext");
  const invocationContextBrand: unique symbol = Symbol("InvocationContext");
  ```

### JSON/Configuration Fields

- **JSON serialized data:** snake_case
  ```typescript
  const digestPair = { expected_digest: sha256DigestV1Schema, observed_digest: sha256DigestV1Schema };
  ```

- **Tool names:** snake_case with prefix
  ```typescript
  const TOOL_NAMES = Object.freeze([
    "archflow_state",
    "archflow_counter_review",
    "archflow_adjudicate",
  ] as const);
  ```

---

## Error Handling Approach

### Structured Error Definitions

Errors are defined with comprehensive metadata using Zod schemas for validation:

```typescript
export type ErrorOwner = "contracts" | "config" | "repository" | "paths" | "policy" | "state" | "intent" | "snapshot" | "gate" | "routing" | "dispatch" | "sandbox" | "protocol" | "integrity";

export interface ErrorDefinition<P extends Readonly<Record<string, unknown>>, O extends ErrorOwner, R extends boolean, A extends string, X extends ErrorProjection> {
  readonly owner: O;
  readonly retryable: R;
  readonly parameter_parser: StrictParameterParser<P>;
  readonly action: A;
  readonly projection: X;
}
```

### Error Creation and Parsing

```typescript
export function createProjectError<K extends ProjectErrorCode>(
  code: K,
  parameters: z.input<(typeof PROJECT_PARAMETER_SCHEMAS)[K]>
): ErrorValue<ProjectErrorDefinitionByCode, K> {
  return constructError(PROJECT_ERROR_DEFINITIONS, code, parameters);
}

export function parseProjectError(value: unknown): ProjectError {
  return parseSerializedError(PROJECT_ERROR_DEFINITIONS, value, "project error") as ProjectError;
}
```

### Custom Error Classes

```typescript
export class ProtocolContextError extends Error {
  public constructor(public readonly protocol_error: ProtocolError) {
    super(protocol_error.code);
    this.name = "ProtocolContextError";
  }
}

export class ContractValidationError extends TypeError {
  public constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ContractValidationError";
  }
}
```

### Error Parameter Schemas

- Errors use discriminated union types with Zod validation
- Parameters are validated on construction and deserialization
- Deep strict equality checking ensures round-trip integrity
- Each error has an associated action string for recovery guidance

---

## State Management Patterns

### Immutable State Design

All state is frozen using `Object.freeze()` to prevent mutations:

```typescript
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
```

### State Machines

State is represented as discriminated unions with exhaustive handling:

```typescript
export type SessionState = "PRE_INIT" | "INITIALIZING" | "INIT_RESPONSE_ACCEPTED" | "READY" | "CLOSING" | "CLOSED";

export type SessionAction =
  | Readonly<{ kind: "send"; source: "direct" | "sdk" | "fallback"; message: Readonly<Record<string, unknown>>; }>
  | Readonly<{ kind: "forward-sdk"; route: "initialize" | "ping" | "tools-list" | "tools-call"; }>
  | Readonly<{ kind: "validate-cancellation"; /* ... */ }>;
```

### Branded Type Authentication

WeakSet tracks authentic instances to prevent spoofing:

```typescript
const authenticConnections = new WeakSet<object>();
const authenticInvocations = new WeakSet<object>();

export function createInvocationContext(
  connection: ConnectionContext,
  seed: unknown,
  signal: AbortSignal
): InvocationContext {
  if (!authenticConnections.has(connection)) {
    throw new TypeError("a branded connection context is required");
  }
  // ... validation ...
  authenticInvocations.add(context);
  return context;
}

export function assertAuthenticInvocationContext(value: unknown): asserts value is InvocationContext {
  if (value === null || typeof value !== "object" || !authenticInvocations.has(value)) {
    throw new TypeError("an authentic invocation context is required");
  }
}
```

### Deferred Pattern for Async Operations

```typescript
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
```

---

## Data Access Patterns

### Zod Schema Validation

Input validation using Zod with strict object shapes:

```typescript
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const PROJECT_PARAMETER_SCHEMAS = {
  CONTRACT_INVALID: object({ 
    tool: tool.optional(), 
    issue_code: safeCodeV1Schema, 
    schema_version: safeVersionV1Schema.optional() 
  }),
  RESULT_INVALID: object({ 
    tool, 
    result_id: safeIdV1Schema 
  }),
} as const;
```

### AJV JSON Schema Validation

AJV used alongside Zod for additional schema validation with custom keywords:

```typescript
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";

export interface JsonSchemaValidator<T> {
  readonly validate: ValidateFunction<T>;
  readonly assert: (value: unknown, label?: string) => T;
}
```

### Plain JSON Assertion

Helper function to ensure data is plain JSON serializable:

```typescript
export function assertPlainJson(value: unknown, label: string): void {
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype && !Array.isArray(value)) {
      throw new TypeError(`${label} must be plain JSON`);
    }
  }
}
```

### Structured Cloning for Data Copies

```typescript
function copy<T>(value: T): T {
  return structuredClone(value as PlainJsonValue) as T;
}

// Usage: defensive copy of validated input
const startup = deepFreeze(copy(startupSchema.parse(seed)));
```

### Type-Only Exports for Contract Boundaries

```typescript
// Type-only exports make the exact table primitives discoverable without granting authority.
export type ErrorParameterPrimitives = {
  readonly digest: Sha256Digest;
  readonly tool: ToolName;
  readonly phase: PhaseInstanceId;
  readonly path: TaskPathClaim;
  readonly gate: GateKind;
  readonly adapter: AdapterId;
  readonly family: ModelFamily;
};
```

---

## Testing Framework and Conventions

### Test Runner: Vitest

Configuration in `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      reportsDirectory: "coverage"
    }
  }
});
```

### Test Structure

- Tests co-located in `test/` directory matching source structure
- Test files named with `.test.ts` extension
- Organized by category: `contracts/`, `unit/`, `integration/`
- Fixtures in `test/fixtures/` organized by feature

### Test Patterns

```typescript
import { describe, expect, it } from "vitest";

describe("transport-neutral contexts", () => {
  it("defensively copies, deeply freezes, and initializes once", () => {
    const startupSeed = {
      connection_id: "connection-1",
      startup_repository_candidate: { working_directory: "/work/repo" }
    };
    const captured = connectionContextFactory.captureStartup(startupSeed);
    startupSeed.startup_repository_candidate.working_directory = "/changed";
    const connection = captured.initialize(candidates);
    
    expect(connection.startup_repository_candidate.working_directory).toBe("/work/repo");
    expect(Object.isFrozen(connection.initialization_candidates.client)).toBe(true);
    expect(() => captured.initialize(candidates)).toThrow(ProtocolContextError);
  });
});
```

### Test Fixtures

Fixtures stored as JSON files for contract validation:

```
test/fixtures/
  contracts/
    mcp-tools/
      state-valid.json
      state-invalid-artifact.json
    path-claims/
      valid.json
  mcp/
    runtime/
      initialize.json
      calls.json
```

---

## Code Formatting and Imports

### TypeScript Configuration

Strict compiler settings in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "skipLibCheck": false
  }
}
```

Key settings:
- **noUncheckedIndexedAccess:** Requires explicit type narrowing for array/object access
- **exactOptionalPropertyTypes:** Distinguishes between optional (`?:`) and `| undefined`
- **verbatimModuleSyntax:** Enforces consistent module syntax (ESM)
- **strict:** Enables strict null checking and implicit any detection

### Import Organization

Imports grouped and alphabetized:

```typescript
// 1. Node built-in imports
import process from "node:process";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { Writable } from "node:stream";

// 2. Third-party imports
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";

// 3. Local imports with .js extensions (ESM)
import { runMcpProcess } from "./mcp/process-runner.js";
import { startMcpRuntime } from "./mcp/sdk-adapter.js";
import type { ConnectionContext } from "./contracts/contexts.js";
```

### ES Modules

- **Module type:** "module" in package.json
- **File extensions:** Explicit `.js` extensions in imports (ESM requirement)
- **Node version:** >=24.15.0

---

## Module Conventions

### Feature-Based Organization

```
src/
  contracts/              # Data contract definitions and validation
    index.ts             # Public API
    errors.ts            # Error definitions
    validators.ts        # Validation utilities
    contexts.ts          # Context types and factories
    schemas/
      v1/               # JSON schemas for contracts
  mcp/                   # MCP protocol implementation
    server.ts
    session.ts
    tools.ts
    process-runner.ts
    send-queue.ts
```

### Public API Pattern

Index files expose only what clients need:

```typescript
// src/contracts/index.ts
export {
  createInvocationContext,
  parseTransportRequestId,
  parseClientImplementation,
  assertAuthenticInvocationContext,
  // NOT exported: connectionContextFactory (internal factory)
} from "./contexts.js";
```

### Private Internal Modules

Internal implementations use `internal/` subdirectory:

```
src/contracts/
  internal/
    test-capabilities.ts    # Testing utilities
    trust-brands.ts         # Branding implementation
```

### Type-Safe Exports

Exports carefully separated into types and implementations:

```typescript
// Some exports are type-only to control authority
export type ErrorParameterPrimitives = { /* ... */ };

// Functions and classes provide the actual capability
export function createProjectError<K extends ProjectErrorCode>(
  code: K,
  parameters: z.input<(typeof PROJECT_PARAMETER_SCHEMAS)[K]>
): ErrorValue<ProjectErrorDefinitionByCode, K> { }
```

---

## Key Patterns Summary

1. **Strict Type Safety:** Branded types with unique symbols prevent invalid states at compile time
2. **Immutable State:** Deep freezing prevents accidental mutations
3. **Explicit Error Handling:** Structured error definitions with Zod schemas ensure consistency
4. **Defensive Copying:** Structured cloning isolates internal state from external changes
5. **Authentication via WeakSet:** Prevents spoofing of critical objects like contexts
6. **Discriminated Unions:** State machines use union types for exhaustive handling
7. **Plain JSON Validation:** Ensures serialization/deserialization safety
8. **Dual Validation:** Both Zod and AJV used for comprehensive schema validation
