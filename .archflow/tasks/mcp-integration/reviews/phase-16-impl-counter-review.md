# Phase 16 Implementation Counter-Review — Installer, Initialization, and Host Registration

**Task**: mcp-integration
**Reviewed**: 2026-07-31, uncommitted working tree on `feature/mcp-server` (baseline `99ad4bf`)
**Reviewer**: Claude (Opus 5), fresh-context counter-review; implementation and first verification were done by a different model.

## Verification performed

- Read the phase design, `architecture.md`, `.archflow/context/*` (only `ArchflowV2.feature` carries a context directory; the other workspace repos have none), and every changed/new file in the design's Files table via `git status`/`git diff`.
- Ran `npm run typecheck`, `npm test` (126 files, 1548 tests, all pass), `npm run check:dependencies`, `npm run check:notices`, and `npm run check:release` (exit 0, `release:reproduce` reproduces byte-identically).
- Ran the real `install.sh` end-to-end into scratch `HOME`/`ARCHFLOW_HOME`/`ARCHFLOW_BIN`, then drove the installed launchers: `archflow-mcp` completes the JSON-RPC `initialize` handshake offline, and `archflow-local init` returns in 0.55 s with stdin held open by a live parent (input-free behavior confirmed; installed-bundle asset resolution via `import.meta.url` confirmed — all seven assets scaffolded from `<bundle>/assets/`).
- Probed the **real** `claude 2.1.220` and `codex-cli 0.146.0` in isolated `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`HOME` sandboxes to check the assumptions the fake fixtures encode (findings 1 and 2 below). No repository file was modified; all probes wrote only to the scratchpad.

The core of the phase is sound and better than the design required in places: payload + runtime-asset re-hashing works dependency-free, the Node floor correctly rejects 24.14 as well as 23.x, the owned skill manifest prunes exactly the dropped owned file while leaving unrelated skills byte-identical, `.mcp.json` is decided from the parsed project file (never `claude mcp get`) and is byte-stable across re-runs, the Codex marker block appends without touching a prior byte, `codex mcp add` is never called, no TOML dependency was added, the config template resolves opposite-family routes in both orientations with no `ultra` and no retired `*-codex` slug, and `stageTaskInitialization` pins the workflow/constitution from the commit tree while preserving and digesting a pre-existing per-task override. I also confirmed against the real CLI that `claude mcp add --scope project` exits **0** and writes `.mcp.json` even when a user-scope `archflow` already exists, that its output for a user-scope entry (`Scope: User config …`) trips `masked_by_higher_precedence`, and that its project-scope output (`Scope: Project config (shared via .mcp.json)` / `Status: ⏸ Pending approval …`) is classified correctly — the text heuristics in `claudeGetDiagnostic` hold against the live format.

The findings below are what the first verification missed.

## Findings

### 1. BLOCKER — The Codex conflict scan misses the `[mcp_servers]` inline/dotted form, and appending the block then corrupts the user's entire project config

`outsideCodexConflict` (`src/init/registration.ts:215-230`) recognizes only a `[mcp_servers.archflow]` header line (`:220`) or a single line containing `mcp_servers.archflow` / `mcp_servers = … archflow …` (`:227`). It therefore does **not** see the ordinary TOML form:

```toml
[mcp_servers]
archflow = { command = "other-binary", args = [] }
```

Neither line matches: the header has no `.archflow` and no `=`, and the key line has no `mcp_servers`. Init classifies the file as conflict-free and appends its own `[mcp_servers.archflow]` table. Verified against real `codex-cli 0.146.0`: before the append Codex resolves that entry fine; after it, **every** read of the project config fails with

```
Error parsing project config file …/.codex/config.toml: TOML parse error at line 4, column 14
  [mcp_servers.archflow]   duplicate key
```

so the human loses their whole project config layer — all MCP servers, model settings, hooks — while init reports success. This is exactly the case the pinned decision names ("a line scan for the `[mcp_servers.archflow]` header **and for `mcp_servers` inline/dotted forms**… anything ambiguous fails closed to the paste path") and it defeats success criterion 4's "refuses only on a genuine conflicting `archflow` entry".

**Resolution**: in the same line scan, when a bare `[mcp_servers]` header is seen, scan forward to the next `[` header for a `^\s*archflow\s*=` key and refuse (`server-command-collision` when the inline command is readable and differs, `codex-config-foreign` otherwise). Add the fixture case to `test/integration/init-registration-phase16.test.ts`.

### 2. BLOCKER — Codex trust is inferred from the command name alone, so a global entry makes init falsely report `project_trusted: true`

`codexGetCommand` (`:232-247`) reads only `command`/`transport.command`, and `registerCodexProject` sets `trusted = get.exit_code === 0 && resolvedCommand === "archflow-mcp"` (`:282`). `codex mcp get` resolves the **merged** configuration, so a global `~/.codex/config.toml` entry — precisely what `codex mcp add` writes, per the design's own context — satisfies that test in an untrusted project. Verified live with `codex-cli 0.146.0`, untrusted project, global `[mcp_servers.archflow] command = "archflow-mcp"`:

```json
{ "name": "archflow", "transport": { "command": "archflow-mcp", … },
  "startup_timeout_sec": null, "tool_timeout_sec": null }        exit 0   ← project block NOT applied
```

versus the same repo once trusted:

```json
{ … "startup_timeout_sec": 30.0, "tool_timeout_sec": 3600.0 }    exit 0   ← project block applied
```

Init reports `project_trusted: true`, `diagnostic` = the raw JSON, and `collectInitDiagnostics` propagates `codex_project_trusted: true` — a claim of success past the human trust boundary the design and `skills/archflow-init/SKILL.md` explicitly forbid, with the one-hour tool timeout silently absent (REQ-37). It also leaves success criterion 4 ("`codex mcp get archflow --json` … reports `tool_timeout_sec = 3600` resolved from `.codex/config.toml`") unverified anywhere in the code or the suite — `tool_timeout_sec` is never read.

**Resolution**: require `tool_timeout_sec === CODEX_TOOL_TIMEOUT_SEC` (optionally also `startup_timeout_sec === CODEX_STARTUP_TIMEOUT_SEC`) from the parsed JSON before concluding the project block resolved; report `project_trusted: false` when the command resolves but the timeouts do not. `test/fixtures/init/fake-host-cli.mjs:37-41` should mirror the real shape (`transport.command` nested, `tool_timeout_sec` null when untrusted / `3600` when trusted) so the trusted and merged-global cases are actually distinguished by the test.

### 3. BLOCKER — `architecture.md` was not updated, so the parent document still mandates the two branches this phase deleted

The design's Files table requires modifying `.archflow/tasks/mcp-integration/architecture.md` to record corrections (a) and (b), the replacement of success criterion 4, and the `.codex/config.toml` single-writer rule; `git diff --stat` shows the file untouched. It still says init must emit `export MCP_TOOL_TIMEOUT=3600000` and "fails closed until a newly started host proves `archflow-mcp` inherited `3600000`" (`architecture.md:312`, `:743` — the latter is a live Phase 16 checkbox that the implementation can never satisfy and that success criterion 4 was supposed to replace), and that Phase 16 must "use official Codex registration" (`:736`), which is now exactly what the implementation must not do. This violates the project hard rule that parent docs reflect reality, and leaves the next phase's status check reading a criterion list that contradicts the shipped code.

**Resolution**: apply the four recorded amendments to `architecture.md` before the commit gate.

### 4. MAJOR — `runInit` aborts on the first host failure after it has already written files, so a single-host machine gets no report at all

`runInit` (`src/init/index.ts:22-33`) returns the first non-`ok` result, and `registerCodexProject` writes its block **before** probing the CLI (`registration.ts:270-279`). Verified with the real installed bundle and `codex` absent from PATH: init scaffolded all seven assets, wrote `.gitattributes`, wrote a complete `.mcp.json` with `timeout: 3600000`, appended the Codex block — and then returned only

```json
{"ok": false, "error": {"code": "CLI_MISSING", "parameters": {"adapter": "codex-cli"}}}
```

with no diagnostics, no limitations, no approval/trust guidance, no recovery guidance, and no indication that anything succeeded. A machine with only one host CLI installed — an ordinary case — can therefore never obtain the report this phase exists to produce, and success criterion 11 ("Init reports … a missing CLI (`CLI_MISSING`), managed-policy presence, collisions, and each host's human approval step") is unmet for that case. This is the same fail-fast trap the pinned "Preflight reuse" decision already solved for `preflight` — `collectInitDiagnostics` maps a `CliAdapterError` into a report field rather than throwing — but `runInit` re-introduces it one level up.

**Resolution**: carry a failed host registration into the report as a field (the host's `ProjectError`) instead of returning early, and still assemble diagnostics/limitations. Keep the up-front refusals (`mcp-json-foreign-keys`, `server-command-collision`, `codex-config-foreign`, `scaffold-diverged`) as hard returns, since those are "do not write" paths.

### 5. MAJOR — Init scaffolds and registers relative to the process cwd, while `task-init` reads the worktree root

`runInit` writes everything under `input.working_directory`, which `src/local/main.ts:36` sets to `process.cwd()`; `stageTaskInitialization` instead resolves `runner.location.worktreeRoot` (`src/init/task-initialization.ts:103`), like the rest of the repository does. Run from a subdirectory of a repository, init reports full success and leaves `.archflow/`, `.gitattributes`, `.mcp.json`, and `.codex/config.toml` in the subdirectory (verified end-to-end) — Claude and Codex read neither from there — and the subsequent `archflow-local task-init --task demo` fails with `IO_ERROR{operation: "stage-task-initialization"}` carrying `next_action: "retry-unchanged-attempt"`, i.e. a retryable classification for a condition retrying can never fix. Success criterion 6's "init succeeds after repository relocation and in linked … worktrees" is only exercised for a top-level directory.

**Resolution**: resolve the worktree root in `runInit` the way `stageTaskInitialization` already does (`discoverWorktree` → `runner.location.worktreeRoot`) and scaffold/register there, or refuse when the working directory is not a Git worktree root. The skill's "run from the repository root" instruction is guidance to a model, not a boundary.

### 6. MAJOR — `scaffold-diverged` never says which asset diverged

`src/init/assets.ts:114` returns `CONFIG_INVALID{issue_code: "scaffold-diverged"}` and nothing else; `CONFIG_INVALID`'s parameter schema is `{issue_code: SafeCode}` (`src/contracts/errors.ts:38`), which cannot hold a path, and unlike `registration.ts`'s `refuse()` no guidance is written to stderr. The human sees one opaque JSON error for seven possible files. Chunk 3 of the design specifies "report `CONFIG_INVALID {issue_code: "scaffold-diverged"}` **with the path** and do not write", and criterion 5 expects the divergent asset to be *reported*, not merely refused.

**Resolution**: write the diverging repository-relative path (and the "review or delete it, then re-run init" recovery line) to stderr before returning, mirroring `refuse()`; assert the path appears in `test/unit/init-assets-phase16.test.ts`.

### 7. MAJOR — Diagnostics discard a known CLI version on auth failure and report unknown probe failures as "no error"

In `diagnoseAdapter`'s catch (`src/init/diagnostics.ts:80-90`):

- `version: unsupportedVersion(error)` returns `null` for anything but `CLI_VERSION_UNSUPPORTED`. `preflight` parses and range-checks the version **before** the auth probe (`src/dispatch/cli.ts:217-241`), so for the common logged-out case the version was successfully observed and is then thrown away — the report shows `version: null` for a CLI that is present and running. The design's "CLI version floors" decision explicitly leans on "init already reports both observed CLI versions in its diagnostics".
- Any exception that is neither `CliAdapterError` nor `DispatchProcessError` (e.g. `createDispatchWorkspace` failing) yields `error: null, version: null, authenticated: null` — a record indistinguishable from a clean probe, which is the "false claim of success" criterion 11 forbids.

**Resolution**: return the version whenever the preflight got far enough to observe one (thread it out of the error path or probe `--version` separately), and map an unrecognized exception to a non-null error (`IO_ERROR{operation: "init-preflight"}` is already in the registry — no new code needed).

### 8. MAJOR — Two assertions the design's Verification Steps require are absent from the installer test

`test/integration/install-script-phase16.test.ts:66-71` exercises only `archflow-local --help`, which returns at `main.ts:29` before `readInput` is ever reached — so it proves neither of the two things the design names: "`archflow-mcp` starts offline and speaks the protocol handshake" and "the does-not-wait-for-stdin assertion for `archflow-local init`". The registration suite likewise omits the required "assert no file init writes contains the temp `HOME` or install-root string". I verified all three manually against the installed bundle and they hold today, so this is a regression-protection gap rather than a live defect — but the stdin behavior is exactly the class of bug the repository has already been bitten by (see the CLAUDE.md convention on input-free commands), and it is currently untested.

**Resolution**: add the handshake spawn (imitating `test/integration/local-cli-phase15.test.ts`), an `archflow-local init` run with a parent-held stdin under a short timeout, and a substring assertion over `.mcp.json` / `.codex/config.toml` / the staged `TaskInitializationV1` for the temp `HOME` and bundle paths.

## Not findings (checked and cleared)

- `claude mcp add --scope project` with a pre-existing user-scope entry: exits **0** and writes `.mcp.json` (live-verified), so the readback path at `registration.ts:171-174` is not reachable in the masking case; the exit-1 duplicate path only occurs for a same-scope duplicate, which the parsed-file check already prevents.
- `install.sh` does not verify `skills/**`, but the pinned "Payload verification" decision scopes verification to `artifacts[]` plus runtime assets, and adding skills to the manifest would move `RELEASE_FILES`, which criterion 13 freezes.
- `stageTaskInitialization` creating the task `config.yaml` before the `POLICY_BASE_INVALID` refusal is intentional per chunk 6 and is asserted by the unit test.
- `parseMcpJson` mapping malformed JSON onto `mcp-json-foreign-keys` is a labeling compromise forced by the "no new error codes" decision; it fails closed with the paste block.

## Triage

Triaged 2026-07-31. Eight findings, eight accepted.

1. **Bare `[mcp_servers]` conflict missed — ACCEPTED.** This is a normal supported TOML shape, and appending the managed table creates a duplicate key that invalidates the complete project configuration. The scan will track the bare table and reject an `archflow = ...` key before writing; focused tests will cover readable collisions and ambiguous values.
2. **Codex trust inferred from command alone — ACCEPTED.** A same-command global entry is not evidence that project configuration resolved. Trust will require the project-owned one-hour tool timeout (and startup timeout) in the merged readback; the fake CLI will mirror the real nested transport and null-timeout untrusted shape.
3. **Parent architecture remained contradictory — ACCEPTED.** The Phase 16 scope and success criteria will record Claude's persistent project timeout, direct marker-owned Codex project configuration, and the absence of both the environment-export branch and `codex mcp add`.
4. **`runInit` loses its report on one host failure — ACCEPTED.** Missing/unsupported/logged-out host outcomes are expected diagnostics, not reasons to discard completed safe work and the other host's report. Hard configuration/refusal paths remain failures.
5. **Init uses the invocation subdirectory — ACCEPTED.** Repository initialization is repository-scoped. `runInit` will discover the Git worktree and use its canonical root for every scaffold, registration, and diagnostic operation.
6. **Divergent scaffold path omitted — ACCEPTED.** The existing error schema deliberately carries only the stable issue code, so the local helper will emit the exact repository-relative path and recovery instruction to stderr before returning the classified refusal.
7. **Diagnostics discard observed versions and unknown failures — ACCEPTED.** An auth failure occurs after a successful version observation and must retain it. Unexpected preflight/workspace failures will map to the existing `IO_ERROR` rather than a null error.
8. **Installed flow regression assertions missing — ACCEPTED.** The installer integration test will drive the installed MCP handshake, prove `archflow-local init` returns while stdin remains open, and assert portable registration/init artifacts contain neither the temporary home nor install root.
