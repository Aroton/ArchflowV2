# PATTERNS

**Explored:** 2026-08-12 · **Commit:** `247df34` · **Covers:** `src/`, `test/`, `scripts/`, repository policy

This is a strict TypeScript/Node package whose conventions are enforced primarily by the type checker, runtime validators, and tests. There is no configured linter or formatter. Match the surrounding file: contract registries intentionally use dense declarations, while state, repository, and MCP algorithms favor expanded control flow and rationale-heavy comments.

## Module and formatting conventions

- The package is ESM (`"type": "module"`) and targets Node `^24.15.0`; TypeScript uses `NodeNext` module resolution and ES2024 (`package.json`, `tsconfig.json`).
- Relative imports always use the emitted `.js` extension, including imports between `.ts` sources: `../contracts/errors.js` in `src/state/transaction.ts`.
- Node built-ins use the `node:` prefix. Imports are normally grouped as Node built-ins, third-party packages, then relative modules, with blank lines between groups. `src/repository/git.ts` is representative.
- `verbatimModuleSyntax` makes type imports explicit. Use `import type { ... }`, or a `type` specifier in a mixed import. `src/contracts/durable-document.ts` demonstrates both value and type imports from the same modules.
- JSON modules use import attributes: `with { type: "json" }`, as in `src/contracts/validators.ts`. Runtime-relative assets and fixtures use `new URL(..., import.meta.url)`, as in `src/init/assets.ts` and `test/integration/mcp-stdio.test.ts`.
- House formatting is two spaces, double quotes, semicolons, trailing commas in expanded calls/objects, and `readonly` fields by default. Numeric separators are used for limits and timeouts (`30_000`, `25 * 1024 * 1024`).
- Strictness is deliberate: `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are enabled, while `skipLibCheck` is false. Indexed accesses therefore commonly use a justified non-null assertion after an explicit length/cardinality check; see `src/contracts/errors.ts` and `src/repository/index-entries.ts`.
- Long doc comments preserve design and security rationale, often tagged with requirement or design labels such as `D1`, `D11`, and `REQ-11`. Preserve that reasoning when changing the associated behavior; `src/contracts/durable-document.ts` is the clearest example.

## Naming conventions

| Kind | Convention | Examples |
|---|---|---|
| Source files | kebab-case | `durable-implementation-output.ts`, `state-results.ts` |
| Source layers | directory by responsibility | `contracts/`, `repository/`, `state/`, `review/`, `dispatch/`, `mcp/`, `local/`, `init/` |
| Exported types/classes | PascalCase | `TaskStateV1`, `GitInvocationError`, `TransactionDependencies` |
| Persisted versioned shapes | PascalCase plus `V1` | `DocumentArtifactV1` in `src/contracts/durable-document.ts` |
| Runtime schema mirrors | camelCase plus `V1Schema` | `documentArtifactV1Schema` |
| Parsers | `parseX`, throwing on invalid input | `parseDocumentArtifact`, `parseGitOid` |
| Assertion functions | `assertX`; authenticity assertions say `assertAuthenticX` or `assertInternalX` | `assertPlainJson`, `assertAuthenticTransactionOutcome`, `assertInternalTransactionAuthority` |
| Factories | `createX`, usually returning a frozen object | `createGitRunner`, `createProjectError` |
| Constant vocabularies/registries | `UPPER_SNAKE_CASE`, normally `as const` and/or frozen | `PIPELINE_STEPS`, `PROJECT_ERROR_DEFINITIONS` |
| Persisted/wire JSON fields | snake_case | `input_fingerprint`, `phase_instance`, `projection_target` |
| Internal locals/options | camelCase | `runnerMaxBuffer`, `materializedSpec` |
| Error codes | upper snake case | `STATE_CONFLICT`, `PATH_ESCAPE` |
| Error owners/actions | lowercase; actions are kebab-case | `"state"`, `"reread-and-retry-intent"` |
| MCP tools | `archflow_` plus snake_case | `archflow_state`, `archflow_counter_review` |
| Tests/files | behavior or exported-symbol name, never workflow phase number | `state-transaction.test.ts`, `local-cli-stdin-discipline.test.ts` |

Vocabulary is represented as a constant tuple plus a derived union, not a TypeScript `enum`. For example, `PIPELINE_STEPS` and `PipelineStep` in `src/contracts/vocabulary.ts` let Zod, JSON Schema generation/validation, and TypeScript share one vocabulary.

## Type and contract conventions

### Persisted graphs use type aliases

Any type reachable from a persisted root must be declared with `type`, never `interface`. `CanonicalDocument<T extends PlainJsonValue>` checks the entire reachable graph, and TypeScript supplies the implicit string index signature needed by `PlainJsonValue` only for type aliases. An `interface` nested anywhere in the graph produces `TS2344: Index signature for type 'string' is missing` at the root.

```ts
export type DocumentArtifactV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "document";
  // ...
};
// src/contracts/durable-document.ts
```

This is about declaration form, not branded strings, optional properties, or readonly arrays. It also intentionally prevents declaration merging from widening a persisted shape beyond its JSON Schema. Interfaces remain normal for non-persisted service contracts such as `GitRunner` and `GitCommandSpec` in `src/repository/git.ts`, or the MCP runtime options in `src/mcp/sdk-adapter.ts`.

### Branded boundary values

Digests, safe integers, task slugs, Git OIDs, path claims, and resolved paths are nominally branded primitives. Callers obtain them through strict `parseX` functions, not unchecked casts. See `src/contracts/evidence.ts`, `src/contracts/canonical.ts`, and `src/repository/paths.ts`. Path brands distinguish task-relative from repository-relative frames even where runtime schemas are structurally identical.

### Discriminated unions and exhaustive registries

- Wire and durable unions discriminate on stable literal fields such as `ok`, `artifact_kind`, `kind`, or `name`.
- Exhaustive switches bind the remainder to `never`; `operationFor` in `src/state/transaction.ts` is representative.
- Registries use `as const satisfies Record<Code, ...>` so a new vocabulary member cannot omit its definition. The project/protocol error registries in `src/contracts/errors.ts` are the dominant example.
- Persisted arrays that model sets are required to be sorted and unique. They are validated, never silently sorted or deduplicated. Shared helpers such as `isSortedUniqueBy` and `tupleKey` in `src/contracts/validators.ts` keep Zod and Ajv behavior aligned.

## Validation and caller-owned objects

The package follows an assert-don't-filter model. Invalid input is rejected rather than coerced, stripped, defaulted, or normalized. Zod objects are strict, and Ajv is configured without type coercion, default insertion, or additional-property removal in `src/contracts/validators.ts`.

### Plain JSON preflight

Every parse boundary begins with `assertPlainJson`. For example:

```ts
export function parseDocumentArtifact(value: unknown): DocumentArtifactV1 {
  assertPlainJson(value, "document artifact");
  return documentArtifactV1Schema.parse(value);
}
// src/contracts/durable-document.ts
```

`src/contracts/plain-json.ts` rejects unsupported primitives, non-finite numbers, cycles, sparse arrays, symbol keys, dangerous own keys, non-plain prototypes, accessors, non-enumerable properties, and mutation during traversal. It re-reads descriptors and keys after recursive inspection to detect time-of-check/time-of-use changes.

### Descriptor checks require both data and enumerability

When reading a caller-owned field through `Object.getOwnPropertyDescriptor`, require that the descriptor contains `value` and is `enumerable`:

```ts
const descriptor = Object.getOwnPropertyDescriptor(value, field);
if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
  throw new TypeError(`${label}.${field} must be an own enumerable data property`);
}
// src/state/transaction.ts, ownDataField
```

The checks prevent different hazards. Rejecting accessors prevents split observation from a getter. Rejecting non-enumerable data prevents a field invisible to `JSON.stringify`, canonical bytes, and their digests from being treated as authenticated input. The same convention appears in `src/contracts/durable.ts`, `src/mcp/server.ts`, and the transaction kernel.

### Materialize once before repeated inspection

Validate a caller-owned JSON object once, then `structuredClone` it and inspect only the clone. `materializeDraft` and `materializeFingerprint` in `src/state/transaction.ts` are representative. For wrapper objects that cannot themselves be plain JSON (for example, a canonical document containing `Uint8Array` bytes), first extract each own enumerable data slot, then validate and clone the JSON value; see `materialize` in `src/contracts/durable.ts`.

This boundary is security-relevant: an enumerable getter can otherwise return one value during validation and another during hashing. The rule is “assert, then clone,” not repeated reads of the original.

### Multiple authorities

- Zod is the runtime shape authority. The published JSON Schemas under `src/contracts/schemas/v1/` are generated from it (`npm run generate:schemas`; `check:schemas` fences the committed bytes), except the hand-written release manifest.
- Contract tests compile the generated documents with a dev-only strict Ajv (`test/helpers/json-schema.ts`) to prove they stay valid draft-2020-12 for third-party consumers; production never compiles a schema.
- Durable semantic checks that cross document boundaries are centralized in `validateDurableSemantics` (`src/contracts/durable.ts`) rather than duplicated in individual schemas.
- A caller-supplied digest or fingerprint is an assertion, never authority. The server re-derives canonical digests and input fingerprints before comparison.

## Error-handling conventions

`src/contracts/errors.ts` is the central taxonomy. Each project or protocol error code has a strict parameter schema, owner, retryability flag, next action, and projection. `createProjectError` validates parameters and returns a frozen structure; `parseProjectError` reconstructs the expected value from the registry and compares it deeply, preventing callers from forging owner/retryability/action metadata.

Error parameters are constrained identifiers, codes, versions, paths, counts, and digests. Do not include arbitrary exception text, filesystem paths, model output, or secrets. Hash hostile/unbounded subjects or map them to a stable safe code.

The layer convention is:

- Contract parsers and internal invariant checks throw `TypeError` or a typed subclass. Examples: `PlainJsonError` (`src/contracts/plain-json.ts`) and `GitInvocationError` (`src/repository/git.ts`).
- Expected operational/domain failures exposed to callers use `ProjectResult<T>`, a frozen `ok: true | false` discriminated union. The state transaction kernel has local `ok` and `fail` constructors in `src/state/transaction.ts`.
- Filesystem/process failures are first classified with typed errors carrying stable fields, then translated to project errors at a layer that has the required context. `projectErrorForGitFailure` and the projection failure mapping in `src/state/transaction.ts` illustrate this.
- MCP handler failures are normalized by `mapHandlerErrors` in `src/mcp/handlers/errors.ts`. Known carried project errors are returned, programmer `TypeError`s are rethrown, and unknown failures are reported diagnostically but projected only as `INTERNAL_ERROR` with a correlation ID.
- Protocol failures and project failures remain distinct at the MCP adapter boundary: protocol failures use JSON-RPC errors, while project failures are tool results marked as errors (`src/mcp/sdk-adapter.ts`).

## State management and data access

### Canonical serialization and immutability

`src/contracts/canonical.ts` owns canonical JSON: ordinally sorted object keys, preserved array order, two-space indentation, UTF-8, and exactly one trailing newline. `CanonicalDocument<T>` binds frozen bytes, parsed value, and digest. Parsing re-renders and byte-compares, so semantically equivalent but noncanonical JSON is rejected.

Durable objects and capability handles are commonly frozen. Authentic internal authority is carried by module-private `WeakSet`/`WeakMap` membership rather than a spoofable JSON field. Examples include transaction authority in `src/state/authority.ts` and result-installation capabilities/outcomes in `src/state/transaction.ts`.

### Repository access

- Git is invoked with argv arrays through `createGitRunner`; no shell command strings are built (`src/repository/git.ts`). Input bytes are copied before spawning, outputs and time are bounded, UTF-8 decoding is explicit, and absence is recognized only by a caller-declared exit-code-plus-diagnostic pair.
- Use `:(top,literal)<claim>` by itself for worktree-root-anchored literal pathspecs. Never combine it with `--literal-pathspecs`: that disables pathspec magic and silently selects nothing. `readIndexEntries` in `src/repository/index-entries.ts` documents and implements the rule.
- `git check-attr` accepts pathnames, not pathspecs. It therefore uses neither `:(top,literal)` nor `--literal-pathspecs`; see `src/repository/attributes.ts`.
- Machine-readable Git output is normally NUL-delimited. Returned paths and result cardinality are validated rather than trusted (`src/repository/index-entries.ts`, `src/repository/attributes.ts`).
- Paths enter as branded claims and are resolved through `src/repository/paths.ts`; consumers act on `ResolvedPath` values and re-check `path_class`. Avoid ad hoc concatenation for repository or task authority.

### Durable writes and transaction ownership

- `src/state/atomic.ts` centralizes exclusive immutable authority creation, atomic replacement, projection writes, and disposable-interface removal. Operations are restricted by `path_class`; ordinary source code does not write authority directly.
- Durable result manifests and decision archives are created exclusively. Replaceable projections such as `state.json` use atomic replacement; request staging, recovery receipts, locks, rendered gate UI, and diagnostic attempts belong under ignored `.archflow/runtime/tasks/<task>/`.
- `runStateTransaction` in `src/state/transaction.ts` is the write coordinator: authenticate request authority, acquire the work-root task lock, recompute fingerprints/digests, prepare a draft that cannot set kernel-owned revision/transition fields, stage recovery bytes, publish canonical state with `last_transition`, install current result authority/projections, clean successful buffers and superseded authority, and arbitrate uncertain outcomes for replay.
- State readers return classified unions such as canonical/missing/unreadable/noncanonical, leaving policy decisions to callers (`src/state/read.ts`).
- I/O and state dependencies are injected through explicit dependency records, enabling deterministic unit and crash testing without weakening production boundaries.
- The gate interface is a reconstructible projection below ignored runtime, not authority. Records under `authority/decisions/` and state remain sufficient if it is missing or corrupt. In the normal path the connected handler writes the preview-bound choice and archives it synchronously; the standalone decision-file writer remains recovery machinery, never a prerequisite for resolving already authenticated authority.

## CLI and MCP conventions

- `src/main.ts` is intentionally small: validate that the MCP executable received no arguments, then wire stdin/stdout/stderr into the runtime.
- The local CLI parses the command before reading input. Commands in `INPUT_FREE_COMMANDS` never read stdin; payload commands read `--input` or stdin only after command classification (`src/local/main.ts`). This prevents input-free commands from hanging when a parent keeps stdin open.
- Command and tool surfaces are table-driven (`src/local/commands.ts`, `src/mcp/tools.ts`), keeping advertised schemas, dispatch, and validation aligned.
- Stdio protocol bytes stay off diagnostic output. MCP framing/dispatch/send-queue responsibilities are split across `src/mcp/framing.ts`, `src/mcp/send-queue.ts`, and `src/mcp/sdk-adapter.ts`.

## Testing conventions

Vitest runs in Node with explicit imports (`describe`, `it`, `expect`, hooks); globals and setup files are not configured (`vitest.config.ts`). Current test organization:

| Directory | Files | Role |
|---|---:|---|
| `test/unit/` | 106 | Module-level behavior and boundary tests; dependencies are usually injected rather than module-mocked |
| `test/contracts/` | 21 | JSON Schema/Zod agreement, cross-authority parity, durable structural and semantic corpora |
| `test/integration/` | 32 | Real Git repositories, process wiring, local CLI, MCP handlers/stdio, initialization, replay, and state lifecycle |
| `test/crash/` | 4 | Child-process fault injection and recovery/idempotence |
| `test/real-host/` | 5 | Live host/preflight/terminal journeys and benchmark coverage |
| `test/helpers/` | 4 | Reusable repository, workspace, constitution, and host harnesses |
| `test/fixtures/` | 64 | JSON/YAML corpora, fake CLIs, legacy layouts, and crash helpers |
| `test/types/` | 1 | Compile-only MCP SDK public-surface probe included by `tsc` |

Representative practices:

- Test names describe behavior and invariants, not the phase that introduced them. `test/integration/local-cli-stdin-discipline.test.ts` is a strong example.
- `it.each` is used for representative input matrices; `Promise.allSettled` or parameterized helpers are used where all API variants must agree (`test/unit/plain-json.test.ts`, `test/unit/repository-git.test.ts`).
- Temporary resources are registered and removed in `afterEach`/`afterAll`. Git fixtures neutralize global/system Git config and set deterministic author metadata; see `test/helpers/temp-repository.ts`.
- Repository tests use real Git heavily because attributes, filters, index modes, symlinks, worktrees, and conflicts are part of the contract. `test/integration/repository-git-matrix.test.ts` and `test/integration/repository-git-object-proofs.test.ts` cover those boundaries.
- Contract fixtures encode their expected verdict in names (`*.valid.json`, `invalid-*.json`) and are loaded relative to the test module, not `process.cwd()`.
- Crash tests spawn fixture children, interrupt at controlled seams, and assert exact recovery or replay rather than merely checking that an error occurred.
- Assertions favor exact equality for canonical bytes/documents and `toMatchObject` for large result envelopes where only selected contract fields matter.

Common verification commands:

```text
npm run typecheck
npm run test:unit
npm run test:contracts
npm run test:mcp-runtime
npm test
npm run check
```

`npm run check` is the full maintainer-run gate: SDK compatibility, typecheck, MCP runtime and full tests, contract tests, temporary build, dependency/notice policies, MCP SDK boundary policy, and release integrity/reproducibility checks. The repository has no hosted CI workflow, so running this gate before merge is an explicit maintainer action.

## High-risk convention checklist

1. Use a `type` alias for every persisted root and everything reachable from it.
2. At a caller-owned slot, require an own enumerable data descriptor; checking only for `value` is insufficient.
3. Before inspecting caller-owned JSON more than once, run `assertPlainJson`, clone once, and inspect only the clone.
4. Use `:(top,literal)` without `--literal-pathspecs`; pass plain pathnames to `check-attr`.
5. Keep relative ESM imports suffixed with `.js`, and mark type-only imports.
6. Reject or classify invalid input; do not coerce, filter, or silently normalize it.
7. Recompute canonical digests/fingerprints rather than trusting caller assertions.
8. Use the atomic/state transaction abstractions for durable writes and preserve `path_class` checks.
9. Keep protocol errors, project results, typed internal exceptions, and diagnostic logs in their intended channels.
10. Parse an input-free CLI command before considering stdin, and never read stdin for that command.
11. Name code and tests for enduring behavior, never the workflow phase that produced them.
