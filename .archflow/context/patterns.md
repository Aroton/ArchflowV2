# Codebase Patterns and Conventions

**Date:** 2026-07-31
**Commit:** fccf3fb

Scope: the `archflow-mcp-server` TypeScript package (`src/`, `test/`, `scripts/`). No linter or formatter is configured — every convention below is enforced by hand, by `tsc`, or by a test.

---

## 1. Module and build conventions

| Rule | Evidence |
|---|---|
| ESM only (`"type": "module"`), Node `^24.15.0` | `package.json:4-7` |
| **Every relative import ends in `.js`**, even for `.ts` sources (`module: NodeNext`) | `src/contracts/errors.ts:4-11` |
| JSON imported with an import attribute, never `readFile` in `src/` | `import taskStateSchema from "./schemas/v1/task-state.schema.json" with { type: "json" };` — `src/contracts/validators.ts:18` |
| `verbatimModuleSyntax` is on → type-only imports **must** say `type` | `import type { Sha256Digest } from "./evidence.js";` `src/contracts/canonical.ts:5` |
| `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `skipLibCheck: false` | `tsconfig.json` |
| `tsc --noEmit` covers `src/**`, `test/**`, and `vitest.config.ts` | `tsconfig.json:14` |
| Node builtins use the `node:` prefix always | `import { createHash } from "node:crypto";` |

`noUncheckedIndexedAccess` is why you constantly see `items[index - 1]!` and `slots[0]!` — non-null assertions after an index are house style, not sloppiness (`src/contracts/errors.ts:32`, `src/contracts/validators.ts:202`).

### Import ordering

Three groups separated by blank lines: `node:` builtins → third-party → relative. Relative imports are roughly path-sorted; value and type imports from the same module are often two adjacent statements.

```ts
import { z } from "zod";                                   // src/contracts/durable-document.ts:1
                                                           //
import type { DeclaredInputRef } from "./fingerprints.js"; // :3
import { declaredInputRefV1Schema } from "./durable-primitives.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
```

### Formatting

2-space indent, double quotes, semicolons, `readonly` on nearly every field. Line length is **not** capped: several contract modules deliberately pack one declaration per (very long) line to keep a whole registry visible at once — `src/contracts/errors.ts:34-75`, `src/contracts/contexts.ts:9-29`, `src/contracts/gates.ts:31-41`, `src/contracts/mcp-tools.ts:40-56`. Multi-line, prose-documented style is used in the algorithmic modules (`plain-json.ts`, `canonical.ts`, `atomic.ts`, `transaction.ts`). Match the file you are editing.

Doc comments are unusually long and carry *decision rationale* with design-decision tags (`D1`, `D11`, `D19`, `REQ-14`). Preserve and extend them; they are how prior review conclusions survive.

---

## 2. Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Source files | kebab-case, `.ts` | `durable-implementation-output.ts`, `path-claims.ts` |
| Domain grouping | one directory per layer: `contracts/`, `state/`, `repository/`, `mcp/`, `review/`, `dispatch/` | |
| Persisted root types | `PascalCase` + `V1` suffix | `TaskStateV1`, `DocumentArtifactV1`, `IntentReceiptV1` |
| Zod mirrors | `camelCaseV1Schema` | `documentArtifactV1Schema` (`durable-document.ts:80`) |
| Compiled Ajv authorities | `camelCaseV1Validator` | `intentReceiptV1Validator` (`validators.ts:323`) |
| Parse functions (throw) | `parseX` — 59 of them | `parseDocumentArtifact`, `parseTaskSlug`, `parseGitOid` |
| Assertions | `assertX(value): asserts value is X` | `assertPlainJson`, `assertValidJsonSchema` |
| Capability assertions | `assertAuthenticX` / `assertInternalX` | `assertAuthenticToolBoundary` (`mcp/server.ts:232`), `assertInternalTransactionAuthority` (`state/authority.ts:34`) |
| Factories | `createX` returning a frozen object | `createAtomicWriter`, `createToolBoundary`, `createJsonSchemaValidator` |
| Frozen constant tables | `UPPER_SNAKE` + `as const` (+ `Object.freeze` when exported as a value) | `TOOL_NAMES`, `GATE_KINDS`, `PIPELINE_STEPS`, `PROJECT_ERROR_DEFINITIONS` |
| Error codes | `UPPER_SNAKE` string-literal union members | `"STATE_CONFLICT"`, `"PATH_ESCAPE"` |
| Error `owner` / `next_action` | lowercase kebab | `"state"`, `"reread-and-retry-intent"` |
| All JSON / persisted / wire fields | `snake_case` | `input_fingerprint`, `phase_instance`, `resulting_revision` |
| Local TS variables & non-persisted params | `camelCase` | `recomputedInputFingerprint` |
| MCP tool names | `archflow_` + snake_case | `archflow_state`, `archflow_counter_review` |
| Schema `$id`s | `urn:archflow:schema:v1:<kebab-name>` (two legacy `https://archflow.dev/schemas/v1/...`) | `versions.ts:3-44` |
| Schema files | `src/contracts/schemas/v1/<kebab-name>.schema.json` | |
| Ajv custom keywords | `x-archflow-<kebab>` | `x-archflow-sorted-unique-by` (`validators.ts:277`) |

**Field naming is split by destination, not by language.** A type that is persisted or crosses the MCP boundary uses `snake_case` fields even though it is TypeScript (`TransactionAuthority` in `state/authority.ts:23-32` is `snake_case`); a purely internal options bag is `camelCase` — `resolveTaskPath({ runner, taskId, claim, expectedClass, context })` (`repository/paths.ts:413`).

### Constant-union idiom

Enumerations are always a frozen array plus a derived type — never a TS `enum`:

```ts
export const PIPELINE_STEPS = ["produce", "self_review", "counter_review", "triage", "adjudicate"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
// src/contracts/vocabulary.ts:2,7
```

The array is what Zod (`z.enum(PIPELINE_STEPS)`) and the JSON Schema `enum` both consume, so the vocabulary cannot drift.

---

## 3. Type conventions

### 3.1 The `type`-alias rule (the one newcomers break)

**Any type reachable from a persisted root must be a `type` alias, never an `interface`.**

```ts
// src/contracts/durable-state.ts:19-21
// Every type below is a `type` alias rather than an `interface` (D1): `CanonicalDocument<T extends
// PlainJsonValue>` grants the implicit index signature it needs only to aliases, and it checks the
// whole reachable graph, so an `interface` anywhere below the root fails the constraint at the root.

export type TaskStateV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly authoritative_results: readonly AuthoritativeResultRef[];   // AuthoritativeResultRef is also a `type`
  readonly open_gate?: OpenGateRef;
};
```

The constraint that forces it: `CanonicalDocument<T extends PlainJsonValue>` (`src/contracts/canonical.ts:98-107`) and `PlainJsonObject`'s index signature (`plain-json.ts:3-5`). TypeScript grants implicit index signatures to type aliases only. An `interface` **anywhere in the reachable graph** — not just the root — fails with `TS2344: Index signature for type 'string' is missing`. Branded fields, optional properties, and `readonly` arrays are all fine; the *declaration form* is the sole cause. The rule also intentionally closes declaration merging on persisted names.

Same note repeated at every persisted root: `durable-document.ts:22-24`, `durable-implementation-output.ts:59-61`, `durable-task-initialization.ts:16`, `durable-legacy-import.ts:48`, `durable-maintenance.ts:10`, `durable-primitives.ts:15-16`.

`interface` remains correct — and is used — for things that never reach a persisted root or a `PlainJsonValue` generic: `PlainJsonObject` itself, `CanonicalDocument`, `ErrorDefinition` (`errors.ts:16`), `ConnectionContext`/`InvocationContext` (`contexts.ts:9-10`), the tool contract map (`mcp-tools.ts:44-56`), `JsonSchemaValidator`. When such an interface *does* need to be hashed, the escape hatch is a generic conversion function, documented at `contracts/fingerprints.ts:124-129`.

### 3.2 Branded primitives

Nominal string/number types via `declare const ...Brand: unique symbol`:

```ts
// src/contracts/evidence.ts:5-24
declare const sha256DigestBrand: unique symbol;
export type Sha256Digest = string & { readonly [sha256DigestBrand]: true };
export type SafeInteger = number & { readonly [safeIntegerBrand]: true };
```

The regex authority and the brand are joined by a cast at the schema, and a `parseX` is the only sanctioned way in:

```ts
export const sha256DigestV1Schema = z.string().regex(/^[0-9a-f]{64}$/u);              // :55
export const taskSlugV1Schema = pathSegmentSafe(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u)) as unknown as z.ZodType<TaskSlug>;  // :58

export function parseSha256Digest(value: unknown): Sha256Digest {
  assertPlainJson(value, "SHA-256 digest");
  return sha256DigestV1Schema.parse(value) as Sha256Digest;
}                                                                                     // :63-66
```

Branded path types work the same way (`ResolvedTaskPath`, `repository/paths.ts:54`). Brand casts on paths are treated as a security boundary: the state layer has exactly one and it is annotated as such (`state/layout.ts:39-42`).

### 3.3 Discriminated unions and exhaustiveness

Unions over a key are built by mapping the key union and indexing back, so adding a member is a compile error everywhere:

```ts
export type ProjectError = { readonly [K in ProjectErrorCode]: ErrorValue<ProjectErrorDefinitionByCode, K> }[ProjectErrorCode];  // errors.ts:80
export type GateDecisionEnvelope<K extends GateKind = GateKind> =
  { readonly [P in K]: GateDecisionEnvelopeBase & { readonly kind: P; readonly payload: GateDecisionPayload<P> } }[K];           // gates.ts:52
```

Switches end with a `never` binding, not a `default: throw`:

```ts
default: {
  const exhaustive: never = call;
  throw new TypeError(`unknown tool ${String((exhaustive as { name?: unknown }).name)}`);
}                                                                                        // state/request.ts:62-65
```

Registries prove exhaustiveness with `as const satisfies Record<Code, …>` (`errors.ts:52`, `errors.ts:71`) or a compile-time witness constant that is then `void`ed (`mcp-tools.ts:57-58`, `fingerprints.ts:98-110`).

---

## 4. Validation conventions

### 4.1 Assert, don't filter

Nothing is sanitized, stripped, or coerced. Input is either exactly right or it throws. Ajv is constructed with `coerceTypes: false, removeAdditional: false, useDefaults: false, strict: true, allowUnionTypes: false` (`validators.ts:219-227`), Zod objects are all `.strict()`, and a Zod mirror that *transformed* its input is itself an error (`validators.ts:404-406`).

### 4.2 `assertPlainJson` is the first line of every parse boundary

```ts
export function parseDocumentArtifact(value: unknown): DocumentArtifactV1 {
  assertPlainJson(value, "document artifact");
  return documentArtifactV1Schema.parse(value);
}                                                                          // durable-document.ts:98-101
```

`assertPlainJson` (`plain-json.ts:99`) rejects: non-finite numbers, non-plain prototypes, symbol keys, cycles, sparse arrays, the `__proto__`/`prototype`/`constructor` keys, **accessor properties**, **non-enumerable data properties**, and values that mutate mid-inspection (descriptors are re-read after recursion, `plain-json.ts:24-42`, `:90-93`).

### 4.3 `Object.getOwnPropertyDescriptor` needs **both** `value` and `enumerable`

The two checks guard different hazards and the pair appears everywhere a caller-owned object is read:

```ts
if (descriptor === undefined || !("value" in descriptor)) fail("accessor properties are not JSON values", propertyPath);
if (!descriptor.enumerable) fail("non-enumerable properties are not JSON values", propertyPath);
// plain-json.ts:84-85
```

```ts
const descriptor = Object.getOwnPropertyDescriptor(value, field);
if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
  throw new TypeError(`${label}.${field} must be an own enumerable data property`);
}
// state/transaction.ts:248-251 (`ownDataField`); same shape at validators.ts:64, mcp/server.ts:136, durable.ts:228
```

Rejecting accessors prevents *split observation* (a getter returning one value to validation and another to hashing). Rejecting non-enumerable data properties prevents a field invisible to `JSON.stringify`/`canonicalJsonBytes` — and therefore to every digest — from being treated as present.

### 4.4 `structuredClone` before any second inspection

Validate once, materialize once, then read only the copy:

```ts
function materialize<T>(subject: T, label: string): T {
  assertPlainJson(subject, label);
  return structuredClone(subject) as T;
}
// contracts/fingerprints.ts:131-134 — rationale at :112-129
```

Same pattern named `materializeFingerprint`/`materializeDraft` (`transaction.ts:255-264`), `copy` (`contexts.ts:23`), `copyJson` (`mcp/server.ts:67`), `copyFreezeJson` (`trust.ts:70`). Boundary-crossing results are cloned **and re-validated** after the copy (`mcp/server.ts:219-221`).

### 4.5 Dual authority: JSON Schema is normative, Zod is a mirror

- A shape supplied by an agent across the MCP boundary gets **both** a `*.schema.json` (normative) and a Zod mirror, and a contract test proves they agree.
- A purely server-internal shape gets **only** the JSON Schema plus `validateDurableSemantics`; adding a Zod mirror is explicitly forbidden and grepped for (`durable-state.ts:11-17`).
- Shared predicates prevent drift: the Ajv keyword and the Zod `.refine()` call *the same exported function* — `isSortedUniqueBy` + `tupleKey` (`validators.ts:93,109`; used in `durable-document.ts:91` and `validators.ts:288`).

```ts
export function assertZodAgreement<T>(value, jsonValidator, zodSchema, label = "value"): T
// validators.ts:380 — asserts plain JSON, snapshots via structuredClone, runs both authorities,
// then fails on: mutation of input, disagreement, rejection, or Zod transforming the value.
```

Set-valued arrays are sorted+unique by contract, never deduplicated silently — a duplicate throws (`fingerprints.ts:148-156`).

---

## 5. Error handling

### 5.1 Two registries, table-driven

`src/contracts/errors.ts` (105 dense lines) is the single authority. Two disjoint code unions:

```ts
export type ErrorOwner = "contracts" | "config" | "repository" | "paths" | "policy" | "state" | "intent"
  | "snapshot" | "gate" | "routing" | "dispatch" | "sandbox" | "protocol" | "integrity";   // :13
export type ProjectErrorCode  = "CONTRACT_INVALID" | … 53 codes …;                          // :19
export type ProtocolErrorCode = "TOOL_NOT_FOUND" | "TOOL_DISABLED" | "UNSUPPORTED_PROTOCOL" | "INITIALIZATION_REPEATED";  // :20
```

Adding an error code is a **four-part edit**: the code union (`:19`), a strict Zod parameter schema (`:34-52`), a `defineError(owner, retryable, schema, action, projection)` entry (`:61-71`), and the JSON Schema `project-error.schema.json`. The `as const satisfies Record<Code, …>` on both tables makes a missing entry a type error, and `test/unit/errors.test.ts:9` pins the count at 53.

### 5.2 Construction and parsing

```ts
const conflict = createProjectError("STATE_CONFLICT", { expected_revision: 2, observed_revision: 3 });
// => { schema_version: "1", code: "STATE_CONFLICT", owner: "state", retryable: true,
//      diagnostic: { template_id: "STATE_CONFLICT", parameters: {…} },
//      next_action: "reread-and-retry-intent" }   (frozen)                            errors.ts:84-89
```

- Parameters are validated by a `StrictParameterParser` that runs `assertPlainJson` then a `.strict()` Zod object (`errors.ts:58`) — an extra key throws, so raw exception text can never leak into an error.
- All parameter values are constrained primitives: digests, `safeCode`, `safeId`, `safeVersion`, `safeInteger`, path claims. Free text is never a parameter; a hostile subject is hashed instead (`TOOL_NOT_FOUND` carries `tool_name_digest`, `errors.ts:55`).
- `parseProjectError` re-derives the value from the registry and `isDeepStrictEqual`s it against the input (`errors.ts:92-99`), so `owner`, `retryable`, and `next_action` cannot be forged in transit.

### 5.3 Throw vs. return

- **Contract layer (`src/contracts/`) throws.** `TypeError` subclasses: `PlainJsonError` (`plain-json.ts:9`), `ContractValidationError` (`validators.ts:40`), `ProtocolContextError` (`contexts.ts:12`). Marked in comments as `/** Throws, per the contract-layer convention. */` (`phase-instance.ts:64`, `durable-document.ts:97`).
- **State/dispatch layers return `ProjectResult<T>`** — a discriminated result, never an exception, for anything a caller must handle:

```ts
export type ProjectResult<T> =
  | { readonly schema_version: "1"; readonly ok: true;  readonly value: T }
  | { readonly schema_version: "1"; readonly ok: false; readonly error: ProjectError };   // errors.ts:82

const ok   = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });
// transaction.ts:185-186; local helpers `issue`/`stateIssue`/`taskIssue` at :188-200
```

Callers propagate with `if (!x.ok) return x;` (`transaction.ts:1001-1010`).

- **Operational I/O throws typed classes carrying structured fields**, not messages: `AtomicReplaceError { operation, target_may_have_changed, collision }` (`atomic.ts:24-40`), `TaskLockError { stage }`, `IntentLayoutError` / `ResultLayoutError` / `DecisionLayoutError` each with `stage: "create" | "verify"` (`layout.ts:9-28`).
- **Reads classify instead of throwing**, returning a `kind` union so the caller decides:

```ts
export type StateReadResult =
  | Readonly<{ kind: "canonical"; document: CanonicalDocument<TaskStateV1> }>
  | Readonly<{ kind: "missing" | "unreadable" | "noncanonical" }>;   // state/read.ts:23-25
```

### 5.4 Across the MCP boundary

Two disjoint channels, decided in `src/mcp/server.ts` and rendered in `src/mcp/sdk-adapter.ts`:

| Failure | Channel | Where |
|---|---|---|
| Protocol error (unknown tool, disabled tool, bad protocol, repeat init) | JSON-RPC `error`, codes `-32001…-32004`; `message` is the code, `data` is the full error | `PROTOCOL_CODES` `sdk-adapter.ts:98-108`, `protocolResponse` `:114-116` |
| Project error (everything else) | JSON-RPC `result` with `isError: true`, the `ProjectResult` as `structuredContent` | `sdk-adapter.ts:136-142` |
| Anything unexpected thrown by a handler | `INTERNAL_ERROR` project failure carrying only `correlation_id: context.invocation_id` | `mcp/server.ts:120-122, 211-224` |

Input classification is staged and each stage yields a distinct `issue_code`: `input-not-object`, `schema-version-missing`, `schema-version-invalid`, `input-invalid`, plus `CONTRACT_VERSION_UNSUPPORTED` for a well-formed but unsupported version (`mcp/server.ts:146-186`). Handler exceptions are caught with bare `catch {}` on purpose — the thrown value never reaches the wire.

---

## 6. Capability / authenticity pattern

Trust is carried by object identity in a module-private `WeakSet`/`WeakMap` (18 such sets in `src/`), never by a checkable field.

```ts
const transactionAuthorityBrand: unique symbol = Symbol("TransactionAuthority");
const authenticAuthorities = new WeakSet<object>();
const authorityDependencies = new WeakMap<object, Readonly<{ runner: RootBoundGitRunner; environment: GitEnvironment }>>();

export type TransactionAuthority = Readonly<{ … }> & { readonly [transactionAuthorityBrand]: true };

export function assertInternalTransactionAuthority(value: TransactionAuthority, expected?): void {
  if (!authenticAuthorities.has(value)) throw new TypeError("an authentic transaction authority is required");
  …
}
// state/authority.ts:19-45
```

The minting recipe, repeated verbatim across the codebase: build the object → `Object.defineProperty` the brand symbol as `{ value: true, enumerable: false, writable: false, configurable: false }` → `Object.freeze` (or `deepFreeze`) → add to the `WeakSet` (`authority.ts:89-97`, `mcp/server.ts:71-84`). The non-enumerable brand keeps it out of `JSON.stringify` and every digest. Every consumer opens with the matching `assert*` call.

`deepFreeze` is redefined locally in each module that needs it (`mcp/server.ts:59`, `contexts.ts:22`, `mcp/tools.ts:105`) — there is no shared utility module and none is wanted.

---

## 7. State management and data access

### 7.1 Canonical JSON is the only serialization

```ts
/** Ordinal-sorted keys, 2-space indent, exactly one trailing newline, UTF-8. */
export function canonicalJsonBytes(value: PlainJsonValue): Uint8Array {
  return encoder.encode(`${JSON.stringify(sortCanonical(value), null, 2)}\n`);
}                                                                       // canonical.ts:65-68
```

Object keys sort by **ordinal** comparison (`a < b`, never `localeCompare`); **array order is preserved because it is semantic** (`canonical.ts:39-63`). `undefined` and non-finite numbers throw rather than being dropped or emitted as `null`. `sortCanonical` mirrors `sortCanonical` in `scripts/release-support.mjs`, and `test/contracts/canonical-parity.test.ts` proves it.

`CanonicalDocument<T>` = `{ bytes, value, digest }`, always frozen (`canonical.ts:98-107`). Reading bytes back goes through `parseCanonicalDocument` (`:119-142`), which in strict order: fatal UTF-8 decode → `JSON.parse` → `assertPlainJson` → **re-render and byte-compare**. Any non-canonical form (permuted keys, wrong indent, missing/extra trailing newline, duplicate keys) is rejected, so bytes and value can never disagree.

### 7.2 Digests

```ts
export function sha256Bytes(bytes: Uint8Array): Sha256Digest              // canonical.ts:70
export function canonicalJsonDigest(value: PlainJsonValue): Sha256Digest  // canonical.ts:74
export function gitBlobOid(content: Uint8Array): GitOid                   // canonical.ts:79
```

Digests over non-JSON subjects are **domain-tagged** with a versioned prefix so two domains can never collide, and the subject is hashed rather than carried (error parameters only accept `/^[0-9a-f]{64}$/`):

```ts
sha256Bytes(encoder.encode(`archflow:history-identity:v1:${oid}`));              // canonical.ts:91
sha256Bytes(encoder.encode(`archflow:repository-candidate:v1:${absoluteCwd}`));  // :95
```

Set-valued collections are sorted before hashing; duplicate keys throw (`fingerprints.ts:140-156`). A caller-supplied `input_fingerprint` is always an assertion, never authority — the server recomputes it (`fingerprints.ts:169-174`).

### 7.3 Atomic writes are class-gated

`src/state/atomic.ts` exposes two frozen capability objects and refuses to write to the wrong `path_class`:

| Operation | Mechanism | Allowed classes |
|---|---|---|
| `createExclusive` | temp file via `open(…, "wx")` → `writeAll` loop → `handle.sync()` → `link()` (EEXIST ⇒ `"exists"`) → unlink temp in `finally` | `intent`, `maintenance-record`, `result-manifest`, `result-payload`, `decision` (`atomic.ts:57-63`) |
| `replace` | `write-file-atomic` | `task-state`, `gate-interface` (`:104-107`) |
| `removeGateInterface` | `unlink`, ENOENT tolerated | `gate-interface` (`:120-135`) |
| `replaceRegular` / `replaceSymlink` / `remove` | projection writer, `requireProjectable` gate | the 7 declared-output classes (`:141-147`) |

Immutable artifacts are content-addressed and created exclusively; only `state.json` and the gate interface are replaced in place. Every failure becomes an `AtomicReplaceError` carrying `target_may_have_changed` so the caller can reason about crash recovery.

Directory creation is equally paranoid: `mkdir` → `lstat` (reject symlink) → `openResolved` with `O_NOFOLLOW | O_DIRECTORY` → `fstat` (`state/layout.ts:37-64`).

### 7.4 Transaction kernel and journal

`runStateTransaction(dependencies, request, prepare)` (`state/transaction.ts:1016`) is the single write path:

1. `assertInternalTransactionAuthority(request.authority, { runner, environment })` and `assertAuthenticParsedToolCall(request.call)`.
2. Resolve the intent (journal) target, then take the task lock via `dependencies.lock.runExclusive(task_root, …)`.
3. Recompute the input fingerprint; `identifyTransactionRequest` mints the `request_digest` from a per-tool `RequestDigestSubject` (`state/request.ts:12-86`).
4. The caller-supplied `prepare` returns a `PreparedTransaction` whose `NextStateDraft` is structurally forbidden to carry `revision` or `committed_intent` (`transaction.ts:83-86`, enforced at `:260-264`) — the kernel owns revision monotonicity.
5. Write the intent receipt with `createExclusive` (the journal), replace `state.json`, install the retained result.
6. On a `TaskLockError` at release, `arbitrate(...)` reads the journal to decide whether the commit landed. Exclusive-create of the intent is what makes replay idempotent; `TransactionOutcome` reports `replayed: boolean`.

All I/O is injected through `TransactionDependencies` (`:68-81`) — `runner`, `atomic`, `lock`, `read_state`, `read_config`, `read_receipt`, `resolve_input_fingerprint` — which is what makes the crash tests possible.

### 7.5 Path resolution

Paths are never concatenated ad hoc. A `TaskPathClaim` / `RepositoryPathClaim` (branded, schema-validated; the two frames are runtime-indistinguishable and distinguished only by brand and `$ref` — `durable-document.ts:33-36`) goes through `resolveTaskPath` / `resolveRepositoryPath` / `resolveDeclaredOutputPath` (`repository/paths.ts:413-604`), which return a `ResolvedPath { absolute, repositoryRelative, path_class }`. Consumers re-check `path_class` before acting (`state/read.ts:74,87,100`).

---

## 8. Testing

`vitest.config.ts` is minimal — `environment: "node"`, `include: ["test/**/*.test.ts"]`, coverage to `coverage/`. No setup files, no globals: every test imports `{ describe, expect, it }` from `vitest` explicitly.

### Layout

| Directory | Count | Purpose |
|---|---|---|
| `test/unit/` | 76 | One file per source module, named after it (`state-transaction.test.ts` ↔ `src/state/transaction.ts`). Real behaviour, few mocks; dependency injection rather than module mocking. |
| `test/contracts/` | 16 | **Cross-authority agreement.** Compiles the `.schema.json` files with `createJsonSchemaValidator` and drives `assertZodAgreement` against the Zod mirrors; adversarial accept/reject corpora; `schema-registry.test.ts` proves `SCHEMA_IDS` ↔ schema files ↔ public exports stay in sync; `canonical-parity.test.ts` proves the TS and `.mjs` canonicalizers agree. Run separately via `npm run test:contracts`. |
| `test/integration/` | 10 | Real subprocesses, real git repositories, real stdio (`mcp-stdio.test.ts` spawns the server and byte-compares framed output). |
| `test/crash/` | 4 | Spawn a child from `test/fixtures/*-child.mjs`, kill it mid-transaction, assert recovery/replay. |
| `test/fixtures/` | — | JSON/YAML corpora grouped by area (`contracts/durable/`, `foundation/`, `mcp/runtime/`, `corpus/`, `dispatch/`, `release/`), plus the `.mjs` crash children. |
| `test/helpers/` | 2 | Reusable harnesses: `temp-repository.ts`, `resolved-constitution.ts`. |
| `test/types/` | 1 | `mcp-sdk-public-surface.ts` — **not a test**; a compile-only probe of the MCP SDK's type surface, checked by `tsc` because `tsconfig.json` includes `test/**/*.ts`. |

### Conventions

- Fixture names encode verdict: `*.valid.json`, `invalid-traversal.json`, `state-invalid-artifact.json`.
- Fixtures load via an import attribute (`import calls from "../fixtures/mcp/runtime/calls.json" with { type: "json" };`) or `new URL(..., import.meta.url)` + `readFile` — never a `process.cwd()`-relative path.
- **Test helpers know nothing about `src/`.** `temp-repository.ts:1-11` states the rule explicitly, so a fixture bug can never be mistaken for a source bug. (`resolved-constitution.ts` is the deliberate exception: it builds a real capability from `src/`.)
- Every git-touching test neutralizes ambient config:
  ```ts
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid", … };  // helpers/temp-repository.ts:33-41
  ```
- `describe` names the exported symbol (`describe("canonicalJsonBytes", …)`); `it` states the *invariant and its reason* ("preserves array order, which is semantic", "rejects duplicate keys, because the re-render is shorter").
- Contract-test files open with a header stating the *authority line* — what this file proves and what deliberately belongs to a sibling file (`test/contracts/durable-structural-corpus.test.ts:37-56`).
- Timeout constants are named and use numeric separators: `const TEST_TIMEOUT_MS = 20_000;`.

### Commands

```
npm run typecheck        # tsc --noEmit over src, test, vitest.config.ts
npm test                 # vitest run (everything)
npm run test:unit | test:contracts | test:mcp-runtime
npm run check            # full gate: probe → typecheck → tests → build → dependency/notice/boundary/release checks
```

CI (`.github/workflows/ci.yml`) runs the same steps individually across Node 24.15.0 and 24.18.0, and ends with `test ! -e .tmp`.

---

## 9. Things a newcomer gets wrong

1. Declaring a persisted shape as an `interface` — the error surfaces nowhere near the mistake, as `TS2344` at the `CanonicalDocument<T>` root. Use `type`.
2. Omitting `.js` from a relative import.
3. Reading a caller-supplied field with `obj.field` instead of `ownDataField` / `getOwnPropertyDescriptor` + `value` **and** `enumerable`.
4. Inspecting a caller-owned object twice without `assertPlainJson` + `structuredClone` in between.
5. Adding an error code in one place. It takes four: code union, parameter schema, `defineError` entry, JSON Schema — plus the count assertion in `test/unit/errors.test.ts`.
6. Putting free text or an exception message into error parameters. Hash it, or use a `safeCode`.
7. Filtering or coercing invalid input instead of throwing.
8. Adding a Zod mirror to a server-internal durable root (`TaskStateV1`) — explicitly forbidden and grepped for.
9. Writing files with `fs.writeFile` instead of the class-gated `AtomicWriter` / `ProjectionWriter`.
10. Sorting object keys with `localeCompare`, or sorting an array during canonicalization (array order is semantic).
11. Throwing from the state layer, where the contract is `ProjectResult<T>` — or returning a result from the contract layer, which throws.
