# DEPENDENCIES

**Explored:** 2026-08-21 · **Commit:** `869c189` · **Covers:** `package.json`, `tsconfig.json`, `scripts/`, `src/init/`, `src/contracts/config.ts`, `src/state/config-change.ts`, `src/state/fingerprint.ts`, `src/state/read.ts`, `src/dispatch/`, release tooling

## Runtime and package baseline

`package.json` defines a private ESM package, `archflow-mcp-server@0.0.0`, with a Node runtime floor and major-line cap of `^24.15.0`. `package-lock.json` is the exact npm lock (`lockfileVersion: 3`); direct dependencies use exact versions rather than ranges.

`tsconfig.json` targets ES2024 with `NodeNext` modules and resolution. Type checking is deliberately strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `skipLibCheck: false`; `noEmit` means esbuild, not TypeScript, produces artifacts.

### Direct runtime dependencies

| Package | Pin | Concrete use |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` | The public-root SDK boundary in `src/mcp/sdk-adapter.ts`: `Server`, `ProtocolError`, `specTypeSchemas`, and MCP types. It resolves `@modelcontextprotocol/core@2.0.0` transitively. |
| `zod` | `4.4.3` | The single runtime shape authority: strict parsing for agent-facing, durable, and in-memory contracts throughout `src/contracts/`, and the source for 32 generated JSON Schemas (`npm run generate:schemas`). Together with the hand-written release-manifest schema, the committed directory contains 33 schemas. |
| `yaml` | `2.9.0` | `src/contracts/yaml.ts` implements strict, single-document YAML parsing used by `config.yaml` and `workflow.yaml`. |
| `@secretlint/core` | `13.0.4` | `src/state/secret-scan.ts` calls `lintSource` before retaining implementation output. |
| `@secretlint/secretlint-rule-preset-recommend` | `13.0.4` | Supplies the production detector set; the filter-comments rule is removed before scanning. |
| `@secretlint/profiler` | `13.0.4` | `@secretlint/core`'s own profiler, promoted to a direct dependency because `src/state/secret-scan.ts` has to empty it. Core marks the performance timeline on every `lintSource` call and never releases what it collects, and the profiler rescans its retained list for each later mark — so scanning degrades quadratically and nothing ever reads the measurements. The adapter drains it through `getEntries`/`getMeasures` after each scan. It deliberately leaves the process-wide mark registry alone: marks are recorded before their observer callback runs, so clearing them races a callback that measures against a just-removed mark, which throws and takes the process down. |
| `write-file-atomic` | `8.0.0` | Declared but currently has **no production import**. `src/state/atomic.ts` now implements exclusive creation and atomic replacement with Node `open`/`link`/`rename`; `src/types/write-file-atomic.d.ts` is a residual narrow declaration. Do not assume the package protects current state writes. |

`@secretlint/types` is transitive and imported type-only by `src/state/secret-scan.ts`. Production code otherwise relies heavily on Node built-ins (`fs`, `path`, `crypto`, `child_process`, `stream`, `os`, `async_hooks`, timers, and related modules).

### Development dependencies

| Package | Pin | Use |
| --- | --- | --- |
| `typescript` | `7.0.2` | `npm run typecheck` / `tsc --noEmit`. |
| `@types/node` | `24.13.3` | Node 24 type declarations. |
| `vitest` | `4.1.10` | Unit, integration, contract, crash, and opt-in real-host tests. `vitest.config.ts` uses the Node environment and includes `test/**/*.test.ts`. |
| `vite` | `7.3.6` | Vitest runtime and the child-process fixture loader used by crash tests. |
| `esbuild` | `0.28.1` | Temporary bundles in `scripts/build-temp-helper.mjs` and release bundles in `scripts/release-support.mjs`. |
| `ajv` | `8.20.0` | Dev-only since 2026-08-11: strict compilation of committed JSON Schemas in tests (`test/helpers/json-schema.ts`) and the release manifest in `scripts/release-support.mjs`. Production validates through Zod and never compiles a schema, so Ajv's transitive `fast-uri` also left the runtime dependency closure. |
| `ajv-formats` | `3.0.1` | Format support for the dev-only Ajv compiler. |
| `@secretlint/secretlint-rule-aws` | `13.0.4` | Dev-only rule used to exercise secret-scanning behavior. |

There is no ESLint, Prettier, Biome, dotenv loader, web framework, database client, ORM, or telemetry SDK.

## MCP and host integrations

### Stdio MCP runtime

`src/main.ts` is the `archflow-mcp` entry point. It accepts no payload arguments and connects `stdin`, `stdout`, and `stderr` to `src/mcp/process-runner.ts` and `src/mcp/sdk-adapter.ts`.

- The transport is newline-delimited JSON-RPC over stdio. `src/mcp/framing.ts` and `src/mcp/send-queue.ts` own framing and ordered output/backpressure; the pinned SDK owns JSON-RPC dispatch and validation (see `mcp/SERVER.md`). The SDK's `StdioServerTransport` is not used; `sdk-adapter.ts` provides a local `Transport` so output remains under the repository's queue and its canonical result-xor-error egress check.
- The server identifies itself as `archflow-mcp@0.0.0` and supports MCP protocol `2025-11-25` (`PROTOCOL_VERSION` in `src/mcp/sdk-adapter.ts`).
- The only SDK import in production is the public root in `src/mcp/sdk-adapter.ts`. `scripts/check-mcp-sdk-boundary.mjs` enforces that boundary; `scripts/test-mcp-sdk-boundary-policy.mjs` mutation-tests the checker.
- `scripts/probe-mcp-sdk-compatibility.mjs` verifies the installed SDK/core public and behavioral surfaces the adapter relies on.
- `src/mcp/tools.ts` advertises exactly two purpose-described tools. `archflow_status` and `archflow_apply` use the generated semantic-workflow schema; the four low-level names remain durable-record vocabulary in `TOOL_NAMES` for existing state, but nothing advertises or dispatches them.

Host identity is derived from MCP `clientInfo.name` in `src/contracts/hosts.ts`: `claude-code` maps to Claude, `codex-mcp-client` maps to Codex, and any unrecognized name maps to `unknown`. Recorded versions are evidence fixtures, not a prefix-based identity fallback.

### Project registration

Initialization (`src/init/index.ts` and `src/init/registration.ts`) integrates with both first-party hosts:

Before host registration, `src/init/assets.ts` copies `assets/archflow.gitignore` to `.archflow/.gitignore` byte-for-byte. Its sole `/runtime/` rule keeps transient/cache/diagnostic bytes out of Git without taking ownership of the project root `.gitignore`; diagnostics use Git itself to verify the ignore match and enumerate any already tracked runtime paths.

- Claude Code: `claude mcp add --scope project archflow -- archflow-mcp`, followed by `claude mcp get archflow`. The project descriptor is `.mcp.json`; the registered stdio command is `archflow-mcp` with a 3,600,000 ms timeout. Human project approval can remain pending.
- Codex: ArchFlow atomically maintains only its marked block in `.codex/config.toml`, then checks it with `codex mcp get archflow --json`. The block sets `startup_timeout_sec = 30` and `tool_timeout_sec = 3600`. Repository trust remains a human action; initialization never writes `trust_level`.
- Both registration paths detect foreign configuration and command collisions instead of overwriting unrelated host settings.

The repository itself contains current examples in `.mcp.json` and `.codex/config.toml`.

## Model dispatch integrations

`src/dispatch/` launches authenticated first-party `claude` or `codex` CLIs to perform the independent rubric and constitution reviews. It does not call provider HTTP APIs directly.

`src/dispatch/routing.ts` consumes the strictly parsed live task-local YAML configuration and maps model prefixes to adapters (`claude-*` to `claude-cli`, `gpt-*` to `codex-cli`; a route naming a cc-switch `provider` forces the claude CLI). The config describes only the dispatched roles — counter-reviewer and adjudicator (the constitution-review route); the producer is the connected host itself and is never dispatched. The active template at `assets/config.template.yaml` defaults both roles to the claude host's opposite family (`gpt-5.6-sol`); `.archflow/config.yaml` is the repository seed copied into each task. Optional per-workflow overrides exist for `explore`, `prd`, `design`, `phase-design`, and `phase-impl`.

`src/dispatch/cli.ts` defines the concrete adapters:

- Minimum versions are Claude Code `2.1.205` and Codex CLI `0.122.0`, checked with exact `--version` output patterns.
- Authentication preflight runs `claude auth status` or `codex login status`. Authentication comes from the user's first-party CLI credential store, not API keys.
- Claude runs in print/safe mode with tools and slash commands disabled, an empty strict MCP config, no session persistence or setting sources, and a projected JSON output schema.
- Codex runs `exec --ephemeral` with user config/rules ignored, read-only sandboxing, strict config, a generated output schema/file, and shell, browser, computer, image, apps, plugins, hooks, skill search, and multi-agent features disabled.
- `src/dispatch/process.ts` uses `spawn` without a shell, caps total output at 8 MiB, times out after 15 minutes by default (a real review of the pinned checkout is legitimately multi-minute), and terminates the process group on non-Windows.
- A process-wide FIFO in `src/dispatch/cli.ts` limits one MCP server process to one resource-intensive reviewer at a time. Semantic review holds that FIFO around its entire replay/dispatch/commit operation and calls a direct counter-review inner seam, so it cannot deadlock by entering the same queue twice. Credential concurrency remains the first-party CLI's responsibility; the FIFO does not coordinate separate MCP server or interactive processes.

`src/dispatch/workspace.ts` creates a disposable working directory outside the repository but deliberately does not create a disposable authentication home:

- Both adapters receive the caller's canonical `HOME`.
- Claude also receives `CLAUDE_CONFIG_DIR` when the caller configured it.
- Codex receives the caller's `CODEX_HOME`, or the canonical `$HOME/.codex` default.
- `TMPDIR`, repository views, schemas, and outputs remain under the disposable workspace.
- Forwarded only when present: `PATH`, `LANG`, `LC_ALL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`.
- Provider keys such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, plus all other caller environment variables, are intentionally dropped.

Canonical authentication is a correctness requirement, not a containment gap to repair with links or copies. Both CLIs may atomically replace their credential file when rotating OAuth tokens; redirecting that path through a disposable symlink can replace the link, preserve a consumed token in the real store, and then delete the only fresh token during cleanup. Claude safe mode and Codex's user-config/rule suppressions keep review instructions isolated without relocating mutable authentication.

Managed-policy presence is reported from fixed Claude paths under `/etc/claude-code/` and `/Library/Application Support/ClaudeCode/`, and Codex paths under `/etc/codex/`; it is diagnostic evidence, not permission to bypass host policy.

## Filesystem, Git, and durable storage

There is no server or cloud database. Durable authority is ordinary tracked repository content under `.archflow/tasks/<task>/`, while transient/cache/diagnostic data is rooted below ignored `.archflow/runtime/tasks/<task>/`; both path families are defined in `src/state/layout.ts` and resolved with containment, symlink, and task-isolation checks in `src/repository/paths.ts`.

- `src/repository/git.ts` invokes `git` with `execFile`, never a shell. Defaults are an 8 MiB output buffer and 30-second timeout; binary stdin is bounded at 25 MiB. Git must be at least 2.25 and use SHA-1 object format.
- Repository readers use commands such as `rev-parse`, `rev-list`, `status`, `ls-tree`, `ls-files`, `diff`, `merge-base`, `cat-file`, `hash-object`, and `check-attr`. Absence is accepted only through command-specific exit-code/diagnostic pairs.
- `src/state/lock.ts` uses a task-local `mkdir` lock and `AsyncLocalStorage`; no external lock library participates in this path.
- `src/state/atomic.ts` uses exclusive temporary files, hard links, renames, and symlinks for immutable creation and projection. Paths are resolved and classed before mutation; `.archflow/**` is constrained to ordinary non-executable Git blobs.
- `.gitattributes` marks `.archflow/** -text merge=binary` so byte-addressed state is not changed by line-ending conversion or conflict-marker insertion. It also fixes LF handling for generated `dist/` text and preserves retained license bytes.

## Configuration and environment variables

Runtime workflow configuration is file-backed:

- `assets/config.template.yaml` is copied to `.archflow/config.yaml`, then copied again to `.archflow/tasks/<task>/config.yaml` when a task is created. That task-local copy remains live and editable: every config-observing transaction or dispatch strictly parses its current bytes, and invalid or unsupported YAML fails closed rather than falling back to an older snapshot.
- Successful config-observing transactions record the normalized parsed shape as `TaskStateV1.last_seen_config`. Read-only status compares that snapshot with the current parsed file and reports informational leaf-level `config_change` entries; a valid edit does not by itself stale an open gate or retained evidence.
- `assets/archflow.gitignore` is copied exactly to `.archflow/.gitignore`; its sole `/runtime/` rule owns only ArchFlow's nested workspace ignore boundary.
- `assets/workflow.yaml` defines the workflow graph and remains digest-pinned by task state; `assets/constitution/` supplies repository-owned policy documents whose selected Git identities remain pinned to the task policy base. Live config editability does not relax either pin.
- `src/contracts/config.ts` validates `schema_version: "1"`, role routes, optional phase-kind overrides, optional positive `max_attempts` (default behavior is three attempts), and optional `approval_rules` with subject triggers plus phase-implementation changed-path triggers. The retired `producer` route is a narrow read-compatibility field; it is ignored when config-change snapshots are normalized.
- The task state's `config_digest` remains the creation-time provenance for the copied config, and a rule settlement separately records the live config digest it evaluated. Config is not part of the current input-fingerprint subject, so valid edits do not invalidate gates or evidence through fingerprint churn.
- `src/state/fingerprint.ts` has one bounded read-compatibility retry for pre-cutover evidence: only an exact expected old fingerprint can be matched using that task state's creation `config_digest`. It never uses live config for the retry, rewrites evidence, or migrates arbitrary old state.

Environment inputs are narrow and purpose-specific:

| Variable | Consumer | Meaning |
| --- | --- | --- |
| `HOME` | `src/dispatch/workspace.ts`, `install.sh` | Locates first-party credentials and default install destinations. Dispatch replaces it for child processes. |
| `PATH`, `LANG`, `LC_ALL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` | `src/dispatch/workspace.ts` | Explicit dispatch-child allowlist. |
| `ARCHFLOW_HOME` | `install.sh` | Overrides the installed bundle root; default is `$HOME/.archflow`. |
| `ARCHFLOW_BIN` | `install.sh` | Overrides launcher destination; default is `$HOME/.local/bin`. |
| `ARCHFLOW_RELEASE_FAULT_AFTER` | `scripts/release-support.mjs` | Test-only crash injection for tracked-release replacement. |

`src/init/registration.ts` can accept an explicit environment object from its caller; otherwise its host registration subprocesses inherit `process.env`. There is no `.env` convention.

## Network and authentication boundaries

Production `src/` contains no `fetch`, HTTP client, listening socket, database driver, auth-provider SDK, or telemetry integration. URL strings in schemas are identifiers and local `$ref` authorities; nothing fetches them.

Network access can still occur at two outer boundaries:

1. The spawned Claude/Codex CLIs communicate with their own providers using existing subscription/login credentials. ArchFlow treats these CLIs as external processes and post-validates structured output.
2. Release reproduction accesses npm to run an isolated `npm ci --ignore-scripts --no-audit --no-fund` with a temporary home/cache.

There are no application-managed users, sessions, OAuth flows, API tokens, or authorization database. Human authority is represented by durable ArchFlow gate/waiver records rather than an auth service.

## Build, test, policy, and release tooling

### Local commands

Important `package.json` scripts:

- `typecheck`: strict TypeScript validation.
- `test`, `test:unit`, `test:contracts`: the fast Vitest project and its two directory-focused views.
- `test:extended`, `test:integration`, and `test:crash`: explicit deeper projects for exhaustive schemas, real Git/process journeys, and fault injection.
- `test:real-host` and `bench:review`: opt-in serialized tests requiring installed/authenticated host CLIs.
- `build:temp`: esbuild smoke bundles under a unique temporary directory.
- `check:notices` and `test:notices-policy`: lockfile-to-notice reconciliation and mutation tests.
- `check:mcp-sdk-boundary` and `test:mcp-sdk-boundary-policy`: production SDK import isolation and mutation tests.
- `release:stage`, `release:check`, `release:reproduce`, `release:write`, `release:smoke`, and `release:mutations`: deterministic release construction, validation, promotion, smoke tests, and hostile mutations.
- `check`: the under-ten-second local/CI pipeline; `check:deep` explicitly composes every local deep tier and release validation.

No formatter or source linter is configured. Formatting/import style is convention-backed; correctness gates are strict TypeScript, tests, contract agreement checks, notice consistency, SDK boundary checks, and release integrity checks.

### Release payload and installer

`scripts/release-support.mjs` bundles two Node 24 ESM executables with esbuild:

- `src/main.ts` -> `dist/archflow-mcp.mjs` (`mcp-stdio`).
- `src/local/main.ts` -> `dist/archflow-local.mjs` (`local-cli`).

The release is not published by automation. `dist/` is tracked and validated against `dist/manifest.json`, `dist/metafile.json`, dependency provenance, the repository `THIRD_PARTY_NOTICES.md`, and retained upstream license texts. The release copies notices and licenses directly, hashes every payload artifact, and verifies source-to-payload byte equality. Reproduction materializes a clean source set, performs isolated `npm ci`, rebuilds, and byte-compares the candidate.

`install.sh` verifies the tracked payload, installs it beneath `${ARCHFLOW_HOME:-$HOME/.archflow}/bundle`, writes `archflow-mcp` and `archflow-local` launchers beneath `${ARCHFLOW_BIN:-$HOME/.local/bin}`, and copies skills to `~/.claude/skills/` and/or `~/.agents/skills/`. It requires Node in `^24.15.0` and requires the launcher directory to be on `PATH`.

**Developing ArchFlow inside this repository** never requires installing: the project-scoped `.mcp.json` routes through `scripts/dev-mcp-launcher.sh`, which serves this checkout's tracked `dist/` bundle when `ARCHFLOW_DEV=1` (optionally `ARCHFLOW_DEV_DIST` to point elsewhere) and otherwise falls through to the installed `archflow-mcp` launcher. A dev session started with `ARCHFLOW_DEV=1` therefore exercises the branch's own bytes — regenerate `dist/` with the release loop after source changes — while the machine-global install stays untouched for everyone else.

### Automation

The repository has no hosted CI/CD workflow. Maintainers run `npm run check` for the SDK compatibility probe, typecheck, fast tests, temporary build smoke, notice inventory, and SDK import boundary. `npm run check:deep` adds schema drift, exhaustive contracts, integration/crash suites, policy mutations, and release integrity/reproduction only for broad changes. Authenticated real-host tests and benchmarks are always separate. There is no automated deployment, package publication, container build, or artifact upload.

## Change checklist

- Dependency changes update the exact pins in `package.json`, `package-lock.json`, and the ordinary third-party notice content as applicable.
- Keep all production `@modelcontextprotocol/*` imports isolated to `src/mcp/sdk-adapter.ts` and public package roots.
- The executable authorities for the dependency surface are `package.json`, `package-lock.json`, and the release provenance derived from the build — not narrative documents.
- Real-host tests are capability probes that can spend provider quota and depend on installed CLI login state; they are not part of ordinary `npm test` or `npm run check`.
