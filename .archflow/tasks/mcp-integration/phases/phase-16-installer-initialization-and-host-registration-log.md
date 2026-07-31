## Implementation Log: Phase 16 - Installer, Initialization, and Host Registration

### Decisions Made

- `install.sh` verifies `dist/manifest.json.artifacts[]` plus `runtime_assets[]`, installs `dist/` and `assets/` under `${ARCHFLOW_HOME:-$HOME/.archflow}/bundle/`, and writes PATH launchers to `${ARCHFLOW_BIN:-$HOME/.local/bin}`. `runtime_assets` is a sorted release-manifest array of `{ path, size, digest }` for the seven scaffold inputs.
- `src/init/registration.ts` authenticates Claude project registration from parsed `.mcp.json`, with `claude mcp get` used only for approval/masking diagnostics. It owns only the marker-delimited Codex block and treats project trust as the resolved command plus `startup_timeout_sec === 30` and `tool_timeout_sec === 3600`.
- `src/init/index.ts` discovers the Git worktree root before writing. Expected host failures are retained as `claude_registration_error` / `codex_registration_error` in a successful `InitReport`; configuration collisions and scaffold divergence remain top-level refusals.
- `src/init/task-initialization.ts` copies `.archflow/config.yaml` only when the task config is absent, preserves and validates an existing override, and pins config bytes plus workflow/constitution bytes from the approved HEAD commit.
- The user re-approved the existing four-advisory `fast-uri@3.1.0` local-only risk for the final Phase 16 bundle digest `c9a8fcc5883b9b980d0d51bd380b363038dd79bb0aeca12b416a2ce1d34b8a25`; dependency inventory and handler authority did not change.

### Deviations from Plan

- The parent architecture now reflects live host behavior: Claude has a persistent project `timeout`, while Codex has no project-scoped registration command. No `MCP_TOOL_TIMEOUT` inheritance branch and no `codex mcp add` call were built.
- Counter-review added bare `[mcp_servers]` inline-conflict detection, timeout-authenticated Codex trust, worktree-root initialization, partial-host reporting, divergent-path guidance, retained CLI versions on auth failure, and installed handshake/stdin/portability assertions.
- `src/init/assets.ts` resolves installed assets at `../assets/` from `dist/archflow-local.mjs`; the source-tree fallback remains `../../assets/`.

### Patterns Established

- A merged host readback proves project authority only through project-unique values, not a shared command name. For Codex, the managed timeout pair distinguishes a trusted project block from a same-name global entry.
- Repository-wide initialization first discovers the canonical Git worktree root. Invocation from a nested directory must never create a second repository projection there.
- Expected per-host availability/authentication failures belong in the complete init report; write-safety collisions remain fail-fast refusals.
- Installer ownership is a sorted relative-path manifest. Upgrade deletes only previously recorded paths that are no longer shipped.

### Gotchas

- A bare TOML `[mcp_servers]` table followed by `archflow = { ... }` conflicts with `[mcp_servers.archflow]`; a line scan must carry table context until the next header.
- `codex mcp get archflow --json` may resolve a global same-command entry in an untrusted project. Null or missing project timeouts mean the project block did not apply.
- The release risk policy invalidates acceptance on every MCP bundle-byte change. That forced repeated approval even when the dependency, advisory set, entry bindings, and scope were unchanged; future release-governance work should bind reapproval to a material change in affected dependency/reachability/scope rather than any byte change.
- Input-free local commands must remain in `INPUT_FREE_COMMANDS`; `--help` does not exercise the stdin path, so regression tests must hold stdin open while invoking the real command.

### Key Interfaces

- `src/init/index.ts`: `runInit(input: { working_directory: string }): Promise<ProjectResult<InitReport>>`; `InitReport` carries nullable host registrations and explicit nullable host registration errors.
- `src/init/assets.ts`: `scaffoldRepositoryAssets(input): Promise<ProjectResult<AssetScaffoldReport>>`.
- `src/init/registration.ts`: `registerClaudeProject(input)` and `registerCodexProject(input)`; timeout constants are `CLAUDE_MCP_TIMEOUT_MS`, `CODEX_STARTUP_TIMEOUT_SEC`, and `CODEX_TOOL_TIMEOUT_SEC`.
- `src/init/diagnostics.ts`: `collectInitDiagnostics(input): Promise<InitDiagnostics>`; `CliAdapterError.cli_version` retains a successfully parsed version when auth fails.
- `src/init/task-initialization.ts`: `stageTaskInitialization(input: { working_directory: string; task_id: string }): Promise<ProjectResult<TaskInitializationV1>>`.
- `src/local/commands.ts`: input-free `init` and `task-init`; `src/local/main.ts`: `INPUT_FREE_COMMANDS` owns `status`, `init`, and `task-init`.
- `dist/manifest.json`: MCP digest `c9a8fcc5883b9b980d0d51bd380b363038dd79bb0aeca12b416a2ce1d34b8a25`; local CLI digest `bf10cbdaaa269b30e752cf5d4f0ca36e3df5a7e5a00959a41794dec553d7bc2d`; dependency inventory `8ead1e3c66890ec554a96365625df6efe859b2eaa50ade4e9e69e87a0b381398`.

### Verification

- `npm run check` passed on Node `24.18.0`.
- Full Vitest suite: 128 files, 1,554 tests passed. Contract suite: 17 files, 457 tests. MCP runtime suite: 13 files, 117 tests.
- Installed-flow coverage proves the offline MCP initialize handshake, input-free `archflow-local init`, seven runtime-asset digests, Node `23.x` and `24.14.0` rejection, PATH refusal, owned-file pruning, nested-worktree initialization, and absence of home/install paths from portable host/task artifacts.
- Release smoke, 17 integrity mutations, and byte-identical reproduction passed.
