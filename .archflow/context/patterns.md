# Patterns and Conventions

**Explored:** 2026-07-27
**Commit:** `8e3144c`

## Package and module conventions

- The package is strict TypeScript and native ESM (`package.json` has `"type": "module"`; `tsconfig.json` uses `NodeNext`). Relative imports therefore include the emitted `.js` extension even in `.ts` sources, for example `import { assertPlainJson } from "./plain-json.js"` in `src/contracts/config.ts`.
- Source code currently lives under `src/contracts/`; each file owns one contract area such as configuration, evidence, gates, review, or trust. Public consumers use the curated barrel at `src/contracts/index.ts`.
- Internal trust-minting helpers live below `src/contracts/internal/` and are deliberately excluded from the public barrel. `test/contracts/schema-registry.test.ts` asserts that test authority factories are not exported.
- Names expose version and role explicitly: runtime schemas use names such as `configV1Schema`, parsers use `parseConfigV1` / `parseConfigYaml`, fixed vocabularies use uppercase constants such as `ROUTING_ROLES`, and public data types use PascalCase names such as `ConfigV1` and `ProjectResult<T>`.
- JSON keys and serialized vocabulary use `snake_case` and lowercase hyphenated literals (`schema_version`, `input_fingerprint`, `counter-reviewer`). TypeScript-only identifiers use `camelCase` / `PascalCase`.
- Constants commonly combine literal preservation with compile-time completeness checks: `as const satisfies ...`. Read-only data is favored in public types (`readonly` properties and arrays), while branded string/number types prevent raw values from acquiring validated authority.
- Imports are generally grouped as external or Node built-ins, a blank line, then local imports. Type-only dependencies use `import type` or inline `type` specifiers because `verbatimModuleSyntax` is enabled. There is no configured ESLint or Prettier command; formatting is maintained by source convention and the TypeScript compiler.

## Boundary validation and data handling

- Untrusted values are checked as plain JSON before domain parsing. Typical entry points call `assertPlainJson(value, "config")` and then a strict Zod schema (`src/contracts/config.ts`). `src/contracts/plain-json.ts` rejects cycles, accessors, inherited/symbol/dangerous properties, sparse arrays, non-finite numbers, and mutation during inspection.
- Zod object schemas are closed with `.strict()`. Cross-field semantics are expressed through `.refine()` / `.superRefine()` and, where useful, an additional explicit validation function. This makes unknown fields and inconsistent derived fields fail instead of being silently stripped.
- Normative JSON Schemas under `src/contracts/schemas/v1/` are mirrored by TypeScript/Zod contracts. `src/contracts/validators.ts` configures AJV in strict, non-coercing, non-defaulting mode and provides `assertZodAgreement` so the two representations cannot silently diverge.
- Parsers return the original value when validation does not require derivation, preserving identity and avoiding mutation. Tests commonly clone input first and assert it remains equal afterward, for example `test/contracts/foundational-schema-agreement.test.ts` and `test/unit/plain-json.test.ts`.
- Canonical order and exact-set invariants are common: arrays are required to be sorted and unique, review slots have a fixed role order, and count/verdict fields must match their contents. Helpers in `src/contracts/validators.ts` and domain modules enforce these rules.
- Rendering is deterministic and byte-oriented. `src/contracts/renderers.ts` escapes invisible or markup-sensitive characters, emits fields in fixed order, and returns UTF-8 `Uint8Array` values rather than loosely formatted objects.
- There is no database or general data-access layer in the current repository. Runtime code is predominantly pure contract parsing, validation, derivation, and rendering. Filesystem reads appear mainly in tests and asset-loading paths, using `node:fs/promises` and `new URL(..., import.meta.url)` rather than process-relative paths.

## State, identity, and immutability

- State is represented as explicit validated values, not mutable application stores. Discriminated unions and correlated generic maps encode legal result, error, gate, evidence, and workflow variants at compile time.
- Security- or trust-sensitive values require unforgeable identity in addition to matching structure. Unique-symbol brands and internal `WeakSet`/capability machinery in `src/contracts/internal/trust-brands.ts` distinguish authentic values from spread copies; tests in `test/unit/trust.test.ts` and `test/unit/mcp-tools.test.ts` verify copied objects lose authority.
- Registries and capabilities are frozen with `Object.freeze`, including nested parser/definition objects where relevant. `src/contracts/errors.ts` is representative: definitions are immutable, parameter schemas are correlated by error code, and construction emits frozen, serializable envelopes.
- Functions generally avoid ambient state. When stateful behavior is necessary, it is scoped to an invocation/capability and authenticated before use rather than exposed as a global mutable singleton.

## Error handling

- Boundary failures throw typed built-in subclasses with useful labels and paths: `PlainJsonError extends TypeError` (`src/contracts/plain-json.ts`) and `ContractValidationError extends TypeError` (`src/contracts/validators.ts`). YAML syntax failures use `SyntaxError` with source label, line, and column (`src/contracts/yaml.ts`).
- Domain validation usually throws `TypeError` for structurally or semantically invalid values. Errors are fail-fast; parsing does not coerce or repair caller data.
- Operational/project failures intended for transport are values rather than exceptions. `src/contracts/errors.ts` defines exhaustive `PROJECT_ERROR_DEFINITIONS` and `PROTOCOL_ERROR_DEFINITIONS`, with each code correlated to an owner, retryability, a strict parameter parser, a next action, and a projection.
- Serialized diagnostics intentionally contain bounded, validated parameters instead of raw exceptions or sensitive names. `test/unit/errors.test.ts` verifies extra diagnostic fields are rejected and project/protocol error spaces remain distinct.
- Narrow `try`/`catch` blocks are used only when converting a predicate or preserving a validation boundary; broad swallowing is not a convention. For example, `isPlainJsonValue` converts `assertPlainJson` failure into `false`, while most public parsers allow actionable validation errors to propagate.

## Testing conventions

- Vitest is the sole test framework, configured for Node in `vitest.config.ts`; files match `test/**/*.test.ts`. Commands split fast domain tests (`npm run test:unit`) from schema/representation agreement tests (`npm run test:contracts`).
- Tests mirror the source boundary:
  - `test/unit/` exercises individual TypeScript contract modules and semantic invariants.
  - `test/contracts/` checks JSON Schema compilation, registry completeness, exhaustive vocabulary, and agreement with Zod/runtime behavior.
  - `test/fixtures/` contains small valid and deliberately invalid JSON, YAML, and Markdown examples grouped by `foundation/` or `contracts/` and domain.
- Tests use `describe` / `it` with behavioral sentences, direct `expect` assertions, and `it.each` or compact loops for rejection matrices. Compile-time guarantees use Vitest's `expectTypeOf` and `// @ts-expect-error`, as shown in `test/unit/path-claims.test.ts`.
- Fixture helpers are local to the test file and load through `readFile(new URL(..., import.meta.url), "utf8")`; JSON fixtures are explicitly parsed and cast from `unknown`. There is no shared global setup or mock-heavy fixture framework.
- Negative and adversarial coverage is a first-class pattern: unknown keys, prototype/accessor attacks, malformed Unicode, duplicate IDs, stale/foreign evidence, copied branded values, and Zod/JSON Schema disagreement all receive explicit tests.
- Tests frequently verify non-mutation and identity semantics, not only value equality. `structuredClone` captures before-state; authentic-object tests also assert that a spread copy is rejected.

## Practical checklist for new code

1. Put the contract in the domain-specific `src/contracts/<domain>.ts` module and export only the intended surface through `src/contracts/index.ts`.
2. Treat every `unknown` input as hostile: plain-JSON preflight it, apply a strict schema, then enforce semantic/cross-field invariants without mutation.
3. Keep serialized names in the established `snake_case` vocabulary, TypeScript names idiomatic, and version public schemas/types explicitly when they are wire contracts.
4. Add unit tests for happy paths, rejection matrices, non-mutation, and type/brand boundaries. Add or update contract-agreement tests whenever normative JSON Schema is involved.
5. Use `.js` suffixes for relative imports, type-only imports where applicable, immutable public types, and deterministic ordering for serialized collections and output.
