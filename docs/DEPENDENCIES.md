# DEPENDENCIES

**Explored:** 2026-08-10 · **Commit:** `28c1021` · **Covers:** `package.json`, `tsconfig.json`, `scripts/`, CI

## Runtime and package baseline

`package.json` defines a private ESM package, `archflow-mcp-server@0.0.0`, with a Node runtime floor and major-line cap of `^24.15.0`. `package-lock.json` is the exact npm lock (`lockfileVersion: 3`); direct dependencies use exact versions rather than ranges.

`tsconfig.json` targets ES2024 with `NodeNext` modules and resolution. Type checking is deliberately strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `skipLibCheck: false`; `noEmit` means esbuild, not TypeScript, produces artifacts.

### Direct runtime dependencies

| Package | Pin | Concrete use |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` | The public-root SDK boundary in `src/mcp/sdk-adapter.ts`: `Server`, `ProtocolError`, `specTypeSchemas`, and MCP types. It resolves `@modelcontextprotocol/core@2.0.0` transitively. |
| `zod` | `4.4.3` | Strict runtime parsing for agent-facing and in-memory contracts throughout `src/contracts/`, including config, review, gate, evidence, durable-document, and MCP tool inputs. |
| `ajv` | `8.20.0` | JSON Schema 2020-12 validation in `src/contracts/validators.ts`; release-receipt validation in `scripts/release-support.mjs`. |
| `ajv-formats` | `3.0.1` | Format support for those Ajv validators. |
| `yaml` | `2.9.0` | `src/contracts/yaml.ts` implements strict, single-document YAML parsing used by `config.yaml` and `workflow.yaml`. |
| `@secretlint/core` | `13.0.4` | `src/state/secret-scan.ts` calls `lintSource` before retaining implementation output. |
| `@secretlint/secretlint-rule-preset-recommend` | `13.0.4` | Supplies the production detector set; the filter-comments rule is removed before scanning. |
| `write-file-atomic` | `8.0.0` | Still admitted and lock-policy checked, but currently has **no production import**. `src/state/atomic.ts` now implements exclusive creation and atomic replacement with Node `open`/`link`/`rename`; `src/types/write-file-atomic.d.ts` is a residual narrow declaration. Do not assume the package protects current state writes. |

`@secretlint/types` is transitive and imported type-only by `src/state/secret-scan.ts`. Production code otherwise relies heavily on Node built-ins (`fs`, `path`, `crypto`, `child_process`, `stream`, `os`, `async_hooks`, timers, and related modules).

### Development dependencies

| Package | Pin | Use |
| --- | --- | --- |
| `typescript` | `7.0.2` | `npm run typecheck` / `tsc --noEmit`. |
| `@types/node` | `24.13.3` | Node 24 type declarations. |
| `vitest` | `4.1.10` | Unit, integration, contract, crash, and opt-in real-host tests. `vitest.config.ts` uses the Node environment and includes `test/**/*.test.ts`. |
| `vite` | `7.3.6` | Vitest runtime and the child-process fixture loader used by crash tests. |
| `esbuild` | `0.28.1` | Temporary bundles in `scripts/build-temp-helper.mjs` and release bundles in `scripts/release-support.mjs`. |
| `@secretlint/secretlint-rule-aws` | `13.0.4` | Dev-only rule used to exercise secret-scanning behavior. |

There is no ESLint, Prettier, Biome, dotenv loader, web framework, database client, ORM, or telemetry SDK.

## MCP and host integrations

### Stdio MCP runtime

`src/main.ts` is the `archflow-mcp` entry point. It accepts no payload arguments and connects `stdin`, `stdout`, and `stderr` to `src/mcp/process-runner.ts` and `src/mcp/sdk-adapter.ts`.

- The transport is newline-delimited JSON-RPC over stdio. `src/mcp/framing.ts`, `src/mcp/send-queue.ts`, and `src/mcp/session.ts` own framing, ordered output/backpressure, and session state. The SDK's `StdioServerTransport` is not used; `sdk-adapter.ts` provides a local `Transport` so output remains under the repository's queue and projection checks.
- The server identifies itself as `archflow-mcp@0.0.0` and supports MCP protocol `2025-11-25` (`PROTOCOL_VERSION` in `src/mcp/sdk-adapter.ts`).
- The only SDK import in production is the public root in `src/mcp/sdk-adapter.ts`. `scripts/check-mcp-sdk-boundary.mjs` enforces that boundary; `scripts/test-mcp-sdk-boundary-policy.mjs` mutation-tests the checker.
- `scripts/probe-mcp-sdk-compatibility.mjs` verifies the exact SDK/core package identities and the public/behavioral surfaces the adapter relies on. It also runs `npm view ... dist-tags --json`, so this verification step requires registry network access.
- `src/mcp/tools.ts` advertises exactly five tools: `archflow_state`, `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, and `archflow_waiver`. Their schemas originate in `src/contracts/schemas/v1/` and `src/contracts/mcp-tools.ts`.

Host identity is derived from MCP `clientInfo.name` in `src/contracts/hosts.ts`: `claude-code` maps to Claude, `codex-mcp-client` maps to Codex, and any unrecognized name maps to `unknown`. Recorded versions are evidence fixtures, not a prefix-based identity fallback.

### Project registration

Initialization (`src/init/index.ts` and `src/init/registration.ts`) integrates with both first-party hosts:

- Claude Code: `claude mcp add --scope project archflow -- archflow-mcp`, followed by `claude mcp get archflow`. The project descriptor is `.mcp.json`; the registered stdio command is `archflow-mcp` with a 3,600,000 ms timeout. Human project approval can remain pending.
- Codex: ArchFlow atomically maintains only its marked block in `.codex/config.toml`, then checks it with `codex mcp get archflow --json`. The block sets `startup_timeout_sec = 30` and `tool_timeout_sec = 3600`. Repository trust remains a human action; initialization never writes `trust_level`.
- Both registration paths detect foreign configuration and command collisions instead of overwriting unrelated host settings.

The repository itself contains current examples in `.mcp.json` and `.codex/config.toml`.

## Model dispatch integrations

`src/dispatch/` launches authenticated first-party `claude` or `codex` CLIs to perform independent review/adjudication. It does not call provider HTTP APIs directly.

`src/dispatch/routing.ts` reads the task-pinned YAML configuration and maps model prefixes to adapters (`claude-*` to `claude-cli`, `gpt-*` to `codex-cli`). Counter-review and adjudication must use the opposite family from the producer. The active template at `assets/config.template.yaml` routes the Claude-family producer role to `claude-opus-5` and the Codex-family counter-reviewer/adjudicator roles to `gpt-5.6-sol`; `.archflow/config.yaml` is the current repository copy. Optional per-workflow overrides exist for `explore`, `prd`, `design`, `phase-design`, and `phase-impl`.

`src/dispatch/cli.ts` defines the concrete adapters:

- Minimum versions are Claude Code `2.1.205` and Codex CLI `0.122.0`, checked with exact `--version` output patterns.
- Authentication preflight runs `claude auth status` or `codex login status`. Authentication comes from the user's first-party CLI credential store, not API keys.
- Claude runs in print/safe mode with tools and slash commands disabled, an empty strict MCP config, no session persistence or setting sources, and a projected JSON output schema.
- Codex runs `exec --ephemeral` with user config/rules ignored, read-only sandboxing, strict config, a generated output schema/file, and shell, browser, computer, image, apps, plugins, hooks, skill search, and multi-agent features disabled.
- `src/dispatch/process.ts` uses `spawn` without a shell, caps total output at 8 MiB, times out after 15 minutes by default (a real review of the pinned checkout is legitimately multi-minute), and terminates the process group on non-Windows.
- A process-wide FIFO in `src/dispatch/cli.ts` serializes dispatches so concurrent calls do not race shared credential files.

`src/dispatch/workspace.ts` creates a disposable home outside the repository and symlinks only the selected credential:

- Claude: source `~/.claude/.credentials.json`.
- Codex: source `~/.codex/auth.json`.
- Child values set by ArchFlow: generated `HOME`, generated `TMPDIR`, and generated `CODEX_HOME`.
- Forwarded only when present: `PATH`, `LANG`, `LC_ALL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`.
- Provider keys such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, plus all other caller environment variables, are intentionally dropped.

Managed-policy presence is reported from fixed Claude paths under `/etc/claude-code/` and `/Library/Application Support/ClaudeCode/`, and Codex paths under `/etc/codex/`; it is diagnostic evidence, not permission to bypass host policy.

## Filesystem, Git, and durable storage

There is no server or cloud database. Durable authority is ordinary repository content under `.archflow/`, with paths defined in `src/state/layout.ts` and validated by `src/repository/paths.ts`.

- `src/repository/git.ts` invokes `git` with `execFile`, never a shell. Defaults are an 8 MiB output buffer and 30-second timeout; binary stdin is bounded at 25 MiB. Git must be at least 2.25 and use SHA-1 object format.
- Repository readers use commands such as `rev-parse`, `rev-list`, `status`, `ls-tree`, `ls-files`, `diff`, `merge-base`, `cat-file`, `hash-object`, and `check-attr`. Absence is accepted only through command-specific exit-code/diagnostic pairs.
- `src/state/lock.ts` uses a task-local `mkdir` lock and `AsyncLocalStorage`; `proper-lockfile` is explicitly prohibited by dependency policy.
- `src/state/atomic.ts` uses exclusive temporary files, hard links, renames, and symlinks for immutable creation and projection. Paths are resolved and classed before mutation; `.archflow/**` is constrained to ordinary non-executable Git blobs.
- `.gitattributes` marks `.archflow/** -text merge=binary` so byte-addressed state is not changed by line-ending conversion or conflict-marker insertion. It also fixes LF handling for generated `dist/` text and preserves retained license bytes.

## Configuration and environment variables

Runtime workflow configuration is file-backed:

- `assets/config.template.yaml` is copied to `.archflow/config.yaml`, then byte-pinned per task at `.archflow/tasks/<task>/config.yaml`.
- `assets/workflow.yaml` defines the workflow graph; `assets/constitution/` supplies repository-owned policy documents.
- `src/contracts/config.ts` validates `schema_version: "1"`, role routes, optional phase-kind overrides, and optional positive `max_attempts` (default behavior is three attempts).

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

Production `src/` contains no `fetch`, HTTP client, listening socket, database driver, auth-provider SDK, or telemetry integration. URL strings in schemas are identifiers and local `$ref` authorities; Ajv does not fetch them.

Network access can still occur at two outer boundaries:

1. The spawned Claude/Codex CLIs communicate with their own providers using existing subscription/login credentials. ArchFlow treats these CLIs as external processes and post-validates structured output.
2. Verification/reproduction tooling accesses npm: `scripts/probe-mcp-sdk-compatibility.mjs` queries live dist-tags, and release reproduction runs an isolated `npm ci --ignore-scripts --no-audit --no-fund` with a temporary home/cache.

There are no application-managed users, sessions, OAuth flows, API tokens, or authorization database. Human authority is represented by durable ArchFlow gate/waiver records rather than an auth service.

## Build, test, policy, and release tooling

### Local commands

Important `package.json` scripts:

- `typecheck`: strict TypeScript validation.
- `test`, `test:unit`, `test:contracts`, `test:mcp-runtime`: Vitest suites; contract and MCP runtime checks also run separately even though the broad suite includes all matching tests.
- `test:real-host` and `bench:review`: opt-in serialized tests requiring installed/authenticated host CLIs.
- `build:temp`: esbuild smoke bundles under a unique temporary directory.
- `check:dependencies`: exact dependency/license/closure allowlist in `scripts/check-dependency-policy.mjs`.
- `check:notices` and `test:notices-policy`: lockfile-to-notice reconciliation and mutation tests.
- `check:mcp-sdk-boundary` and `test:mcp-sdk-boundary-policy`: production SDK import isolation and mutation tests.
- `release:stage`, `release:check`, `release:reproduce`, `release:write`, `release:smoke`, and `release:mutations`: deterministic release construction, validation, promotion, smoke tests, and hostile mutations.
- `check`: the aggregate local verification pipeline.

No formatter or source linter is configured. Formatting/import style is convention-backed; correctness gates are strict TypeScript, tests, contract agreement checks, and custom policy scripts.

### Release payload and installer

`scripts/release-support.mjs` bundles two Node 24 ESM executables with esbuild:

- `src/main.ts` -> `dist/archflow-mcp.mjs` (`mcp-stdio`).
- `src/local/main.ts` -> `dist/archflow-local.mjs` (`local-cli`).

The release is not published by automation. `dist/` is tracked and validated against `dist/manifest.json`, `dist/metafile.json`, `dist/legal/`, `release/legal-review.json`, retained upstream licenses, and dependency provenance. Reproduction materializes a clean source set, performs isolated `npm ci`, rebuilds, and byte-compares the candidate. The legal receipt currently records `project_license_status: "missing"` and `distribution_status: "unresolved"`; do not infer a distribution grant from bundled third-party notices.

`install.sh` verifies the tracked payload, installs it beneath `${ARCHFLOW_HOME:-$HOME/.archflow}/bundle`, writes `archflow-mcp` and `archflow-local` launchers beneath `${ARCHFLOW_BIN:-$HOME/.local/bin}`, and copies skills to `~/.claude/skills/` and/or `~/.agents/skills/`. It requires Node in `^24.15.0` and requires the launcher directory to be on `PATH`.

### CI/CD

`.github/workflows/ci.yml` is the only CI integration. It runs on every push and pull request with read-only repository contents permission, `ubuntu-latest`, and a non-fail-fast matrix of Node `24.15.0` and `24.18.0`. `actions/checkout` and `actions/setup-node` are pinned to full commit SHAs.

After `npm ci`, CI runs the SDK compatibility probe, typecheck, focused MCP tests, the full suite, contract tests, temporary build, dependency/notices/SDK-boundary policies and their mutation tests, release verification/smoke/mutations/reproduction, a fresh release staging comparison, and finally asserts that no repository `.tmp` directory remains. There is no deployment, package publication, container build, or artifact upload workflow.

## Change checklist

- Any direct dependency change must update the exact allowlist in `scripts/check-dependency-policy.mjs`, the lockfile, `THIRD_PARTY_NOTICES.md`, and release legal/provenance evidence as applicable.
- The approved lockfile license set is closed: `0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, and `MIT`. The policy also rejects Lightning CSS and specifically prohibited packages such as MCP framework/client packages, `execa`, and `proper-lockfile`.
- Keep all production `@modelcontextprotocol/*` imports isolated to `src/mcp/sdk-adapter.ts` and public package roots.
- The executable authorities for the dependency surface are `package.json`, `package-lock.json`, and the policy/release scripts — not narrative documents.
- Real-host tests are capability probes that can spend provider quota and depend on installed CLI login state; they are not part of ordinary `npm test` or CI.
