# Dependencies and Integrations

**Explored:** 2026-07-31
**Commit:** `fccf3fb`

## Package baseline

`package.json` — private ESM package `archflow-mcp-server@0.0.0`, `"type": "module"`, `engines.node: "^24.15.0"` (Node 25 deliberately excluded; 24.15.0 is the functional floor).
`package-lock.json` — npm lockfile **version 3**, `requires: true`. Every direct dependency is an **exact version**; ranges are rejected by policy.

`tsconfig.json`: `target/lib ES2024`, `module/moduleResolution NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `resolveJsonModule`, `skipLibCheck: false`, `noEmit`. Includes `src/**/*.ts`, `test/**/*.ts`, `vitest.config.ts`.

## Runtime dependencies (`dependencies`)

| Package | Pin | Where it is actually used |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` | **Only** `src/mcp/sdk-adapter.ts` (enforced boundary). Also `scripts/probe-phase-4-mcp-compatibility.mjs`, `test/types/mcp-sdk-public-surface.ts`, `test/contracts/mcp-*.test.ts`, `test/unit/contexts.test.ts`. Pulls `@modelcontextprotocol/core@2.0.0` transitively. |
| `zod` | `4.4.3` | ~20 files in `src/contracts/` (`config.ts`, `review.ts`, `gates.ts`, `errors.ts`, `evidence.ts`, `durable-*.ts`, `trust.ts`, `mcp-tools.ts`, …). The TypeScript-side parse layer. |
| `ajv` | `8.20.0` | `src/contracts/validators.ts` via `import { Ajv2020 } from "ajv/dist/2020.js"`; also `scripts/release-support.mjs` and `test/contracts/mcp-advertised-schema.test.ts`. Configured `strict: true, allErrors: true` with 8 custom `x-archflow-*` keywords (`unique-by`, `max-utf8-bytes`, `nfc`, `effect`, `sorted-unique`, `sorted-unique-by`, `review-summary`, `adjudication-semantics`). |
| `ajv-formats` | `3.0.1` | Same three sites; applied as `addFormats(ajv)` after casting `formatsModule.default as unknown as FormatsPlugin` (ESM/CJS interop shim). |
| `yaml` | `2.9.0` | Only `src/contracts/yaml.ts` (`LineCounter`, `isAlias`, `parseAllDocuments`, `visit`) — strict single-document YAML 1.2. |
| `write-file-atomic` | `8.0.0` | Only `src/state/atomic.ts`. CJS, ships no types → repo owns a narrow local declaration at **`src/types/write-file-atomic.d.ts`** (promise API only; do not add community typings). |
| `@secretlint/core` | `13.0.4` | `src/state/secret-scan.ts` — `lintSource`. |
| `@secretlint/secretlint-rule-preset-recommend` | `13.0.4` | `src/state/secret-scan.ts` — `rules as recommendedRules`; `@secretlint/secretlint-rule-filter-comments` is deliberately filtered out of the enabled set. |

`@secretlint/types` is **transitive**, not a direct dependency, but is imported type-only in `src/state/secret-scan.ts`.

Node built-ins used in `src/`: `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:child_process`, `node:stream`, `node:buffer`, `node:util`, `node:process`, `node:module`, `node:async_hooks`, `node:perf_hooks`, `node:timers/promises`.

## Dev dependencies

| Package | Pin | Use |
| --- | --- | --- |
| `typescript` | `7.0.2` | `npm run typecheck` (`tsc --noEmit`). Also used **as a library**: `scripts/release-support.mjs` imports `{ LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast"`. Only package with a retained NOTICE asset (`notices/typescript-7.0.2-NOTICE.txt`). |
| `@types/node` | `24.13.3` | Typings; patch line intentionally independent of the tested Node runtimes. |
| `vitest` | `4.1.10` | `vitest.config.ts`: `environment: "node"`, `include: ["test/**/*.test.ts"]`, coverage reports to `coverage/` (no coverage script wired). |
| `vite` | `7.3.6` | Vitest toolchain. **Vite 8 is prohibited** — its graph introduces MPL-2.0 Lightning CSS, which `check:dependencies` fails on by name. |
| `esbuild` | `0.28.1` | `scripts/build-temp-helper.mjs` (two temp bundles: `src/contracts/index.ts` and `src/main.ts`) and `scripts/release-support.mjs` (the release bundle). |
| `@secretlint/secretlint-rule-aws` | `13.0.4` | Dev-only rule package used by secret-scan tests. |

**No ESLint, Prettier, or Biome.** There is no linter or formatter in this repo; style is enforced by convention plus `tsc` strictness.

## MCP protocol integration

Entry point `src/main.ts` (18 lines) wires `process.stdin/stdout/stderr` into `runMcpProcess` (`src/mcp/process-runner.ts`) with `startMcpRuntime` (`src/mcp/sdk-adapter.ts`).

- **Transport**: stdio, hand-rolled. `src/mcp/framing.ts` (newline-delimited JSON framing), `src/mcp/send-queue.ts` (ordered egress), `src/mcp/session.ts` (JSON-RPC session state machine, name/argument projection), `src/mcp/server.ts` (tool boundary). The SDK's own `StdioServerTransport` is **not** used — the adapter supplies a hand-written `Transport` object (`start`/`send`/`close`) so every outbound byte passes through the local send queue.
- **SDK surfaces used** (all from the `@modelcontextprotocol/server` public root): `Server`, `ProtocolError`, `specTypeSchemas`, and types `JSONRPCMessage`, `ListToolsResult`, `Transport`.
- **Server construction**: `new Server({ name: "archflow-mcp", version: "0.0.0" }, { supportedProtocolVersions: ["2025-11-25"] })`, then `registerCapabilities({ tools: {} })`.
- **Tool registration**: two method-string handlers, `server.setRequestHandler("tools/list", …)` and `("tools/call", …)`. `tools/list` returns `structuredClone(ADVERTISED_TOOL_CATALOGUE)`. Results go through `server.projectCallToolResult(…, descriptor.outputSchema)`.
- **Advertised tools** (`src/contracts/tool-names.ts`): `archflow_state`, `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, `archflow_waiver`. `src/mcp/tools.ts` builds each tool's standalone input/output JSON Schema by inlining 20 `src/contracts/schemas/v1/*.json` documents into `$defs` and rewriting `$ref`s to local pointers.
- **Protocol error codes** (local, not SDK): `TOOL_NOT_FOUND -32001`, `TOOL_DISABLED -32002`, `UNSUPPORTED_PROTOCOL -32003`, `INITIALIZATION_REPEATED -32004`.

### SDK-compatibility guarding (two mechanisms, both CI-enforced)

1. **Import boundary** — `npm run check:phase4-mcp-boundary` (`scripts/check-phase-4-mcp-boundary.mjs`). Any `@modelcontextprotocol/*` string literal outside `src/mcp/sdk-adapter.ts` fails. Inside the adapter, only *declared static imports* from the public roots `@modelcontextprotocol/core` and `@modelcontextprotocol/server` are allowed — no deep paths such as `.../server/dist/index.mjs`. `scripts/test-phase-4-mcp-boundary-policy.mjs` mutation-tests the checker.
2. **Behavioral probe** — `npm run probe:phase4-mcp-compatibility` (`scripts/probe-phase-4-mcp-compatibility.mjs`, first step of CI). Asserts installed `server`/`core` are exactly `2.0.0` MIT with a `.` export; `LATEST_PROTOCOL_VERSION === "2025-11-25"`; presence of `Server.prototype.{registerCapabilities,setRequestHandler,connect,close,projectCallToolResult}`; `specTypeSchemas.{InitializeRequest,ListToolsRequest,CallToolRequest,CancelledNotification}` parse behavior; and pins several *quirks* the adapter depends on — malformed `initialize` returning `-32603` without mutating client identity, `ProtocolError` being rewritten to `-32602` on `tools/call`, and `Transport.onmessage` surviving teardown.
   **This probe makes a live network call**: `npm view <pkg> dist-tags --json` for both packages, asserting `latest === 2.0.0`. It also prints a `MANUAL GATE REQUIRED` notice about verifying SDK stable status from dated official sources.

The adapter additionally re-verifies the SDK at runtime: `matchesExpectedProjection` / `projectOutcome` compare the SDK's outgoing message against a locally recomputed projection using `isDeepStrictEqual`, and known SDK error rewrites are replaced with a canonical `-32602 Invalid params`. `test/types/mcp-sdk-public-surface.ts` is a compile-only witness of the SDK type surface.

## External process integrations

### Git (`src/repository/`)

`src/repository/git.ts` spawns `git` via `execFile` (never a shell). Defaults: `maxBuffer` 8 MiB, timeout 30 s, max stdin 25 MiB. Binary path defaults to `"git"` (`options.gitPath` overridable). Minimum version **git 2.25**; object format must be `sha1` (`git rev-parse --show-object-format`).

Subcommands used across `src/repository/`: `--version`, `rev-parse`, `rev-list`, `status --porcelain=v1 -z --untracked-files=all`, `ls-tree -z`, `ls-files -s -z`, `diff --name-only -z`, `merge-base --is-ancestor`, `cat-file` (`-s`, `blob`, `--filters --path=`), `hash-object [-w] --stdin`, `check-attr -z text merge`.

Failure taxonomy is explicit (`GitFailureKind`: `not-installed`, `not-executable`, `timeout`, `output-overflow`, `spawn-failed`, `command-failed`). "Absence" is never inferred from exit 128 — callers must declare an `ExpectedAbsence { code, stderrIncludes }` pair.

**Load-bearing pathspec rule** (documented at `git.ts:394`, `index-entries.ts:88-99`, `attributes.ts:78`): index reads use `:(top,literal)<claim>` pathspecs and must **not** pass `--literal-pathspecs`, which would disable the magic and silently match nothing. `git check-attr` takes pathnames, not pathspecs, and needs neither.

### Filesystem / sandbox boundary

`src/repository/paths.ts` is the containment gate. Every target is resolved with `realpath` (walking to the nearest existing ancestor on `ENOENT`), proven inside the worktree root, then opened with `O_NOFOLLOW` where available (a no-op on Windows, so steps 3–6 carry the guarantee). Branded `ResolvedPath` / `ResolvedTaskPath` types make an unresolved path untypeable at call sites. No third-party path-containment library is used — the doc comment explicitly rejects `path-is-inside`, `resolve-path`, and `contains-path`.

State lives under `.archflow/` (`src/state/layout.ts`, `src/repository/index-entries.ts:35`). Only index mode `100644` is legal below `.archflow/**` — no executables, symlinks, or gitlinks. `src/state/lock.ts` uses a plain `mkdir` lock (`proper-lockfile` is prohibited); `src/state/atomic.ts` uses `write-file-atomic` plus `link`/`rename`/`symlink` primitives.

### Host identity and CLI dispatch (`src/dispatch/`)

`src/contracts/hosts.ts` derives the host from the MCP `clientInfo.name` against exactly two recorded handshakes — `claude-code` (fixture version `2.1.220`) and `codex-mcp-client` (fixture version `0.146.0`); anything else is `"unknown"`. Handshake fixtures: `test/fixtures/dispatch/handshakes/*.json`.

`src/dispatch/routing.ts` maps config → `DispatchRoute`. Family is derived from the model prefix (`claude-` → claude, `gpt-` → codex; anything else is `CONFIG_MODEL_UNSUPPORTED`). Counter-reviewer and adjudicator roles **must** be the opposite family from the producer. Effort support differs: `claude-cli` accepts `low|medium|high|xhigh|max`, `codex-cli` accepts all six including `ultra`.

`src/dispatch/cli.ts` — two adapters, selected by `selectCliAdapter(host)`: a `claude` host dispatches to **codex**, a `codex` host dispatches to **claude** (claude dispatch additionally requires `allow_claude_dispatch: true`).

- Minimum CLI versions: **claude `2.1.205`**, **codex `0.122.0`**, parsed from exact `--version` output patterns.
- Preflight also runs `claude auth status` / `codex login status` and fails with `AUTH_UNAVAILABLE` if not logged in; it records the presence of managed-policy files under `/etc/claude-code/`, `/Library/Application Support/ClaudeCode/`, and `/etc/codex/`.
- Claude argv: `-p --safe-mode --tools "" --disable-slash-commands --strict-mcp-config --mcp-config <empty> --no-session-persistence --setting-sources "" --output-format json --json-schema <schema> --model --effort`.
- Codex argv: `exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --strict-config -s read-only -C <workspace> --json --output-schema <file> -o <file> -m <model> -c skills.include_instructions=false -c project_doc_max_bytes=0 -c model_reasoning_effort=<effort>` plus `--disable` for 14 features (`shell_tool`, `unified_exec`, `multi_agent`, `browser_use`, `computer_use`, `hooks`, `plugins`, …).
- `serializeDispatch` funnels all dispatches through one process-wide FIFO so concurrent runs cannot race the shared credential stores.

`src/dispatch/process.ts` runs the child: `spawn` with `shell: false`, `windowsHide: true`, `detached` on non-Windows (so termination signals the whole process group — SIGTERM, then SIGKILL after 250 ms). **Timeout 300 s (`DISPATCH_TIMEOUT_MS`), output cap 8 MiB (`DISPATCH_OUTPUT_BYTE_CAP`)** across stdout/stderr/final-output.

## Environment variables

`src/` reads **exactly one** environment variable: `process.env.HOME` in `src/dispatch/workspace.ts:65` (falling back to `os.homedir()`), used to locate the caller's credential file. There is no `.env` file, no dotenv loader, and no runtime configuration read from the environment.

`createDispatchWorkspace` builds a disposable `mkdtemp` home outside the repository and sets the child environment to:

- **Set**: `HOME` (generated), `TMPDIR` (generated), `CODEX_HOME`.
- **Forwarded if present** (`FORWARDED_ENVIRONMENT`): `PATH`, `LANG`, `LC_ALL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`.
- **Everything else is dropped** — notably `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are never forwarded, so children stay on the user's existing subscription auth. Exactly one credential file is symlinked into the generated home: `~/.claude/.credentials.json` or `~/.codex/auth.json`.

`test/integration/dispatch-plumbing.test.ts` is the regression test: it plants sentinel values in the environment and asserts they never appear in child output (`scanDispatchOutput`).

Application configuration is data, not environment: `src/contracts/config.ts` (`ConfigV1` — `roles` over `{producer, self-reviewer, counter-reviewer, adjudicator}`, optional `overrides` per skill `{explore, prd, design, phase-design, phase-impl}`, `max_attempts` default 3, efforts `low|medium|high|xhigh|max|ultra`) parsed from YAML. Bundled policy assets: `assets/workflow.yaml`, `assets/constitution/{00-process,10-architecture,20-data,30-product}.md`.

Scripts read `ARCHFLOW_RELEASE_FAULT_AFTER` (`scripts/release-support.mjs:1148`) for fault-injection testing only.

## Network, databases, auth providers

**Verified: `src/` makes no network calls.** A grep for `fetch(`, `http://`, `https://` across `src/**/*.ts` returns nothing outside schema identifier strings (`https://json-schema.org/draft/2020-12/schema`, `https://archflow.dev/schemas/v1/...`, `urn:archflow:...`) — Ajv resolves those from bundled local JSON, never over the wire. No HTTP client, no database driver, no ORM, no auth-provider SDK, no telemetry.

The only network access in the repository is in **verification tooling**, never at runtime:

1. `scripts/probe-phase-4-mcp-compatibility.mjs` — `npm view … dist-tags`.
2. `scripts/release-support.mjs` (`reproduceReleasePayload`) — `npm ci --ignore-scripts --no-audit --no-fund` inside an isolated materialization root with `env: { PATH, HOME: <temp>, npm_config_cache: <temp> }`.

## Dependency admission and legal-evidence system

The densest machinery in the repo. Five authorities; the first four are enforced in CI.

### 1. `scripts/check-dependency-policy.mjs` — the admission allowlist (`npm run check:dependencies`)

The script **is** the policy; `package.json` must match it, not the reverse. It hard-codes:

- The exact runtime and dev dependency maps (name → exact version); any addition, removal, or drift fails.
- `package.json` must be `private` + `"type": "module"`, `engines.node === "^24.15.0"`, and must declare **no** `optionalDependencies`, `peerDependencies`, `bundledDependencies`, or `bundleDependencies`. Same for the lockfile root.
- Lockfile must be `lockfileVersion: 3` with `requires: true`; every entry needs `name`, `version`, `integrity`, and `resolved`.
- **Approved SPDX licenses (closed set)**: `0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MIT`. Anything else fails, including `undefined`.
- **Prohibited by name**: `lightningcss*` (MPL-2.0), plus later-phase reservations `@anthropic-ai/sandbox-runtime`, `@modelcontextprotocol/{client,express,hono,node}`, `execa`, `proper-lockfile`. Their absence is deliberate.
- **Pinned sub-graphs**: `@modelcontextprotocol/{core,server}` must be exactly `2.0.0`/MIT and `server` must lock `core: "2.0.0"`; `write-file-atomic@8.0.0`/ISC must retain its `signal-exit@^4.0.1` edge with `signal-exit@4.1.0`/ISC resolved; the Secretlint closure must be **exactly fourteen** reviewed packages (`@secretlint/{core,profiler,types,secretlint-rule-aws,secretlint-rule-preset-recommend}@13.0.4`, `@textlint/regexp-string-matcher@2.0.2`, `boundary@2.0.0`, `debug@4.4.3`, `escape-string-regexp@4.0.0`, `lodash.{sortby,uniq,uniqwith}`, `ms@2.1.3`, `structured-source@4.0.0`) — checked both by identity and by walking the closure.

### 2. `THIRD_PARTY_NOTICES.md` + `notices/` — SPDX inventory and retained NOTICEs

`scripts/check-notices.mjs` (`npm run check:notices`) reconciles the Markdown table against the lockfile **in both directions** (missing entries *and* stale entries fail). A second table maps `package@version | source-digest | retained-path | retained-digest`; the checker SHA-256s both the retained asset in `notices/` and the file actually installed in `node_modules/`, failing if either drifts. It also fails when an installed package ships a `NOTICE`/`THIRD-PARTY*` file with no reviewed mapping. `scripts/test-notices-policy.mjs` (`npm run test:notices-policy`) mutation-tests all of this. Currently one retained asset: `notices/typescript-7.0.2-NOTICE.txt`.

### 3. `release/legal-review.json` + `release/legal/upstream/` + `release/evidence/` — the release legal receipt

**This is the authority for what ships.** `release/legal-review.json` (schema `src/contracts/schemas/v1/release-legal-review.schema.json`, `urn:archflow:schema:v1:release-legal-review`) records, for the *bundled artifact*:

- `current_components[]` — nine components, each with a `provenance_kind`:
  - `installed` (present as a real package): `@modelcontextprotocol/core@2.0.0`, `@modelcontextprotocol/server@2.0.0` (both `Apache-2.0 AND MIT`), `zod@4.4.3` (MIT).
  - `embedded` (**inlined inside the MCP SDK's own dist, discovered through its source maps**): `ajv@8.18.0`, `ajv-formats@3.0.1`, `content-type@1.0.5`, `fast-deep-equal@3.1.3`, `fast-uri@3.1.0` (BSD-3-Clause), `json-schema-traverse@1.0.0`. Note embedded `ajv@8.18.0` ≠ direct `ajv@8.20.0` — both are inventoried separately.
  - Each carries a `legal_source` digest, a `package_identity` (`npm-registry-artifact` tarball URL + integrity, or `package-lock`), and `provenance_inputs` naming the exact `.mjs.map` files it was derived from.
- `upstream_legal_sources[]` — one-to-one with components; retained bytes live in `release/legal/upstream/<pkg>-<version>/LICENSE` and are copied into `dist/legal/upstream/`.
- `project_license_status: "missing"`, `distribution_status: "unresolved"` — `scripts/release-support.mjs` **invariants that these stay unresolved**; the receipt makes no first-party license grant.
- `limitations[]`, `amendments[]`, `supersessions[]` (the latter two currently empty) — the amendment/supersession chain is validated for referential integrity.

`dependency_gate_decisions[]` is the risk-acceptance ledger. One entry today: **`fast-uri-3-1-0-local-risk`**, `status: "accepted"`, covering four high-severity GHSAs (`GHSA-4c8g-83qw-93j6`, `GHSA-q3j6-qgpj-74h6`, `GHSA-v2hh-gcrm-f6hx`, `GHSA-v39h-62p7-jpjc`; safe floor 3.1.4) against `fast-uri@3.1.0` embedded in the MCP SDK. Backed by four digest-pinned evidence files in `release/evidence/`:

| File | Content |
| --- | --- |
| `advisory-snapshot.json` | The four advisories with source URLs, observed 2026-07-27. |
| `patched-artifact-availability.json` | `compatible_patched_artifact_available: false` — no fixed SDK build exists. |
| `focused-inert-reachability.json` | Vulnerable URI code is reachable during trusted schema compilation, but **no route from untrusted JSON-RPC input** in the current inert (handler-free) runtime. |
| `user-risk-acceptance.json` | Verbatim user acceptance text, dated, scoped `local-only` / non-production / `user-owned-agents`. |

The decision declares `invalidated_by: ["bundle-change", "dependency-change", "entry-change", "handler-authority-change"]` and pins `bundle_digest`, `dependency_inventory_digest`, and `decision_digest`. **Wiring a real tool handler invalidates this acceptance** and requires a fresh gate decision.

### 4. Release payload verification

`scripts/release-support.mjs` (~1400 lines) plus thin CLIs `build-release.mjs`, `check-release.mjs`, `reproduce-release.mjs`, `write-tracked-release.mjs`, `smoke-release-bundle.mjs`, `test-release-integrity.mjs`.

- `RELEASE_BUILD_PROFILE`: esbuild `src/main.ts` → `dist/archflow-mcp.mjs`, `platform: node`, `format: esm`, `target: node24`, `bundle: true`, `minify: false`, `sourcemap: false`, `legalComments: "none"`, with a `createRequire` banner.
- **`allowedImports` is a closed set of five**: `node:buffer`, `node:crypto`, `node:module`, `node:process`, `node:util`. The bundle may reach nothing else — this is what makes the shipped runtime "inert". (`src/state/`, `src/repository/`, and `src/dispatch/` are not currently reachable from `main.ts`.)
- Tracked payload `dist/` = `archflow-mcp.mjs`, `manifest.json`, `metafile.json`, `legal/THIRD_PARTY_NOTICES.md`, `legal/review.json`, `legal/upstream/**`. `dist/manifest.json` records per-chunk `adjacent_map_expectations` (`present` / `expected-absent`) with digests and the third-party components recognized in each source map.
- `npm run release:reproduce` re-materializes the source set, runs an isolated `npm ci`, rebuilds, and byte-compares — the reproducibility proof.
- `KNOWN_EMBEDDED` in `release-support.mjs` hard-codes tarball URL, integrity, and LICENSE digest for each embedded package, so an embedded component's legal source is checked against immutable registry bytes rather than whatever happens to be on disk.

### 5. `docs/dependency-upgrades.md` — the human-readable review log

Records the 2026-07-27 currency review and the 2026-07-29 `write-file-atomic@8.0.0` admission, plus the upgrade procedure (review registry metadata → edit exact versions → regenerate lock deliberately → refresh `THIRD_PARTY_NOTICES.md` → run the full check set on both Node versions → review migrations).

⚠️ **This doc is partially stale at `fccf3fb`**: its table still lists `@modelcontextprotocol/server@2.0.0-beta.5` and its "MCP beta compatibility evidence" section describes the beta, while the pin is now stable `2.0.0`. There is also **no admission section for the Secretlint packages**, though they are in `package.json` and pinned in the policy checker. The *enforced* authority is `scripts/check-dependency-policy.mjs`; treat the doc as narrative that has fallen behind.

## CI/CD and verification

`.github/workflows/ci.yml` — the only CI/CD integration. Triggers on every `push` and `pull_request`; `permissions: contents: read`; `ubuntu-latest`; matrix `node-version: ["24.15.0", "24.18.0"]`, `fail-fast: false`. Both actions are **SHA-pinned** (`actions/checkout@3d3c42e…` v7.0.1, `actions/setup-node@82076278…` v7.0.0).

Steps, in order: `npm ci` → `probe:phase4-mcp-compatibility` → `typecheck` → `test:mcp-runtime` → `test` → `test:contracts` → `build:temp` → `check:dependencies` → `check:notices` → `test:notices-policy` → `check:phase4-mcp-boundary` → `test:phase4-mcp-boundary-policy` → `release:check --payload dist` → `release:smoke --payload dist` → `release:mutations` → `release:reproduce` → `release:stage --output $RUNNER_TEMP/…` → `release:check --payload dist --compare <stage>` → `test ! -e .tmp`.

`npm run check` is the local aggregate of the same sequence. **There is no publish, deploy, container build, or release automation** — `dist/` is committed to the repo and verified, not uploaded anywhere.

`.gitattributes` is load-bearing, not cosmetic:

```
* text=auto
.archflow/** -text merge=binary          # byte-addressed state; blob OIDs independent of autocrlf/eol
dist/*.mjs text eol=lf                   # canonical generated release text is byte-reproducible
dist/archflow-mcp.mjs -whitespace
dist/*.json, dist/legal/*.json, dist/legal/*.md  text eol=lf
release/legal/upstream/** -text -whitespace   # retained upstream legal evidence keeps exact reviewed bytes
dist/legal/upstream/**    -text -whitespace
```

Order matters — Git applies the last matching rule, so `.archflow/**` must stay after `* text=auto`. `src/repository/attributes.ts` reads these back with `git check-attr -z text merge` and exports `ARCHFLOW_GITATTRIBUTES_RULE` / `ARCHFLOW_ATTRIBUTES_REMEDIATION` so the server can tell a user how to repair a repo whose attributes are wrong.

`.gitignore`: `node_modules/`, `.tmp/`, `coverage/`, `.vitest/`, `*.tsbuildinfo`.

## Quick rules for future work

- Adding **any** dependency means editing `scripts/check-dependency-policy.mjs`, `THIRD_PARTY_NOTICES.md`, and probably `release/legal-review.json` — plus a `docs/dependency-upgrades.md` entry. The checker is not a lint; it is the allowlist.
- License must be in `{0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT}`. Copyleft and MPL are out (this is why Vite 8 is excluded).
- Never import `@modelcontextprotocol/*` outside `src/mcp/sdk-adapter.ts`, and never from a deep path.
- Wiring a real tool handler invalidates the `fast-uri` risk acceptance and expands `RELEASE_BUILD_PROFILE.allowedImports` — both are gated decisions, not incidental edits.
- `execa` and `proper-lockfile` are prohibited; use `node:child_process` and the `mkdir` lock in `src/state/lock.ts`.
