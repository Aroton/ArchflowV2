# Architecture Context

**Explored:** 2026-07-27
**Commit:** `8e3144c`

## Current shape

This repository is the ArchFlow skills distribution plus an in-progress, contract-first TypeScript implementation of the planned local MCP integration. The implemented runtime code is currently a reusable contract library under `src/contracts/`; there is no MCP transport entry point, stdio server, persistent state engine, or tracked `dist/` bundle yet. The normative future design and phase plan live in `.archflow/tasks/mcp-integration/architecture.md`, while this document describes the code that exists at the stamped commit.

The package is private, ESM-only, and targets Node 24 / ES2024. `src/contracts/index.ts` is its sole aggregate entry point. A temporary bundle is built from that file for compatibility smoke testing, but the package does not currently declare a public `exports`, `bin`, or production build artifact.

## Repository map

| Path | Responsibility |
|---|---|
| `src/contracts/` | TypeScript domain contracts, parsers, validators, trust/provenance rules, canonical renderers, MCP tool request/result shapes, and error catalogues. |
| `src/contracts/schemas/v1/` | Versioned JSON Schema counterparts for the TypeScript/Zod contracts. Contract-agreement tests keep both representations aligned. |
| `src/contracts/internal/` | Non-public capability/branding seams. Test capabilities can construct otherwise unforgeable trust objects without exporting those constructors from `index.ts`. |
| `assets/workflow.yaml` | Shipped fixed ArchFlow phase graph and gate policy. |
| `assets/constitution/` | Shipped repository-wide policy rule templates, one stable/versioned rule per numbered Markdown file. |
| `skills/` | Portable source of truth for the six Claude Code/Codex Agent Skills. This layer is installed by `install.sh` and is not wired to a server executable yet. |
| `test/unit/` | Behavioral tests for individual contract modules and cross-module invariants. |
| `test/contracts/` | Zod/JSON-Schema agreement, schema registry, MCP surface, and exhaustive catalogue tests. |
| `test/fixtures/` | Valid and invalid serialized contract examples used by both test layers. |
| `scripts/` | Temporary bundling/smoke checks and dependency/license/NOTICE policy enforcement. |
| `docs/` | User/process documentation and the preserved originating MCP integration design. |
| `.archflow/tasks/mcp-integration/` | Tracked workflow planning, phase designs/logs, and reviews for the MCP implementation itself. |
| `.github/workflows/ci.yml` | Node-version matrix verification pipeline. |
| `notices/`, `THIRD_PARTY_NOTICES.md` | Retained third-party notice material and the lockfile-derived license inventory. |

Generated `.tmp/` bundles and installed `node_modules/` are local build products, not architecture sources. `dist/` is deliberately absent at this stage.

## Entry points and wiring

### Public contract surface

`src/contracts/index.ts` re-exports the supported library surface. Consumers are expected to enter through it rather than importing internal trust-brand machinery. Notably, connection contexts are type-exported and only invocation-context derivation is public; server-owned/test-only constructors remain internal.

The temporary build demonstrates the intended library boundary:

```js
entryPoints: ["src/contracts/index.ts"],
outfile: ".tmp/archflow-contracts.mjs",
platform: "node",
format: "esm"
```

`scripts/smoke-temp-bundle.mjs` dynamically imports that bundle and exercises YAML parsing, JSON Schema validation, review/adjudication derivation, render anti-spoofing, error creation, phase parsing, and the exact five-tool catalogue.

### Contract layering

The source dependency flow is mostly inward from generic serialization primitives toward workflow semantics:

1. `plain-json.ts`, `versions.ts`, `vocabulary.ts`, and `phase-instance.ts` establish safe values, version constants, fixed vocabulary, and canonical phase identifiers.
2. `yaml.ts` and `validators.ts` provide strict YAML parsing and non-mutating Ajv 2020 validation; other parsers preflight input through the plain-JSON boundary.
3. `workflow.ts`, `config.ts`, `rubric.ts`, and `constitution.ts` validate repository configuration and shipped policy assets.
4. `evidence.ts`, `path-claims.ts`, `review.ts`, and `adjudication.ts` define digest-bound evidence, task-scoped paths, review findings, and policy/drift results.
5. `trust.ts` qualifies evidence using invocation/result/authority bindings. `internal/trust-brands.ts` guards authentic branded values; `internal/test-capabilities.ts` exposes controlled fixture seams only to tests.
6. `triage.ts`, `supplemental.ts`, and `renderers.ts` consume qualified evidence to validate exact review-set dispositions and produce canonical human-readable artifacts.
7. `gates.ts` defines gate contexts and decision effects. `errors.ts` composes the domain types into exhaustive project and protocol error catalogues.
8. `mcp-tools.ts` binds the five fixed tool names to versioned request/result schemas, validates calls, correlates results with expected identity, and exports immutable tool definitions.
9. `contexts.ts` creates immutable invocation-scoped context from connection data and maps invalid context to protocol errors; live MCP handshake/transport ownership is intentionally not implemented yet.

The five frozen tool names are `archflow_state`, `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, and `archflow_waiver`. They are data contracts only at this commit—there are no handlers behind them.

### Assets to contracts

`assets/workflow.yaml` is parsed against a fixed workflow shape: explore is optional/ungated; PRD and design always gate; phase design and implementation gate on triggers. Constitution Markdown combines strict YAML frontmatter with normative prose. The contract tests load these assets directly, so shipped configuration and parser expectations are checked together.

### Skills and installation

`install.sh` copies the same `skills/` tree to `~/.claude/skills/` and/or `~/.agents/skills/`, optionally selected with `--claude` or `--codex`. It currently installs prompt/skill content only. MCP launchers, host registration, initialization, and offline helper installation remain planned later phases.

## Build and verification

`package.json` provides no production build command yet. The principal commands are:

| Command | Purpose |
|---|---|
| `npm run typecheck` | Strict TypeScript check with no emission. |
| `npm test` | Run all Vitest unit and contract-agreement tests. |
| `npm run test:unit` | Run module-level behavioral tests. |
| `npm run test:contracts` | Run schema and catalogue agreement tests. This is also run after the full suite in CI as an explicit gate. |
| `npm run build:temp` | Bundle `src/contracts/index.ts` with esbuild, then import and exercise the Node-targeted ESM bundle. |
| `npm run check:dependencies` | Enforce exact direct dependencies, exact lock metadata, approved licenses, and phase-boundary exclusions. |
| `npm run check:notices` | Verify the lockfile license inventory and retained notice digests. |
| `npm run test:notices-policy` | Mutation-test the NOTICE checks. |
| `npm run check` | Run the repository's complete local verification chain. |

GitHub Actions repeats these checks on Node `24.15.0` and `24.18.0`, using `npm ci`, and asserts that no tracked-release `dist/` bundle is produced prematurely.

## Configuration

- `package.json`: private ESM package, exact runtime/development versions, and verification scripts.
- `package-lock.json`: npm lockfile v3; policy scripts treat exact resolution and license metadata as architectural constraints.
- `tsconfig.json`: `NodeNext` modules/resolution, ES2024 target, strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `noEmit`.
- `vitest.config.ts`: Node test environment, `test/**/*.test.ts`, coverage output under `coverage/`.
- `.github/workflows/ci.yml`: read-only CI permissions and supported Node matrix.
- `.gitattributes`: automatic text detection and LF normalization.
- `assets/workflow.yaml`: canonical application phase topology.
- `assets/constitution/*.md`: canonical initial policy rules.

There are currently no runtime environment variables, network endpoints, database settings, authentication provider settings, or MCP host configuration consumed by the implemented TypeScript code. Host CLI/auth/sandbox configuration belongs to future adapter and installer phases, not the present contract package.

## Architectural boundaries to preserve

- Keep serialized inputs at a strict plain-JSON boundary before domain validation.
- Keep Zod behavior and shipped JSON Schemas demonstrably equivalent.
- Preserve digest-, task-, phase-, invocation-, and authority-bound evidence; schema-shaped objects alone must not acquire trust.
- Keep internal trust brands/capability constructors out of the aggregate public entry point.
- Preserve exactly five MCP tools; local maintenance/helper operations are designed for a separate CLI rather than expanding `tools/list`.
- Keep MCP SDK/transport concerns isolated from the contract layer when the server adapter arrives.
- Treat `.archflow/tasks/mcp-integration/architecture.md` as the implementation plan, but verify current code before assuming a planned subsystem exists.
