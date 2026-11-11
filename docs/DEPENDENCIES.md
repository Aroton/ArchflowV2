# DEPENDENCIES

**Explored:** 2026-11-11 · **Commit:** `f1fe689` · **Covers:** `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `src/dispatch/`, `src/init/`, `src/review/simple-context.ts`, `scripts/`, `release/legal/`, `notices/`, `THIRD_PARTY_NOTICES.md`, `install.sh`, `skills/archflow-run/scripts/`

What ArchFlow needs in order to run and to be built, what it launches, what it reads, and what it never touches. The shipped program has two direct dependencies; almost everything else here is the machine it runs on.

## Runtime and package baseline

- **Node `^24.15.0`** (`engines` in `package.json`; `install.sh` checks it). The package is private, ES-module only (`"type": "module"`), and ships as a single bundled file.
- **Two direct runtime dependencies**, pinned to exact versions and bundled into `dist/archflow-local.mjs` (the bundle imports only Node built-ins):

| Package | Used for |
|---|---|
| `yaml` 2.9.0 | Parsing `config.yaml`, constitution frontmatter and the bundled review-input configuration, in strict single-document, no-alias, no-merge-key mode (`src/contracts/yaml.ts`). |
| `zod` 4.4.3 | Every schema: review payload and result, config, rubric, constitution rule, reviewer outputs, project errors. Also generates JSON Schema for reviewer output (`toJSONSchema`). |

- **Development dependencies** (none ships): `typescript` 7.0.2 (`tsc --noEmit` only), `vitest` 4.1.10 with `vite` 7.3.6, `esbuild` 0.28.1 (the release bundler), `ajv` 8.20.0 with `ajv-formats` 3.0.1 (validating generated schemas and release manifests in tests and release checks), `@types/node` 24.13.3.
- **Nothing is installed for the user at runtime.** There is no network access at startup, no package fetch and no telemetry.

## Programs ArchFlow launches

| Program | Why | Minimum version (checked at preflight) |
|---|---|---|
| `claude` | Claude reviewer route; also the launcher for any cc-switch provider route | 2.1.205 |
| `codex` | Codex (GPT) reviewer route | 0.122.0 |
| `agy` | Antigravity (Gemini) reviewer route | 1.0.0 |
| `cc-switch` | Optional: `cc-switch start claude <provider> -- …` runs the claude CLI against another provider's models. Only used when a route names a `provider`. | none |
| `git` | `rev-parse`, `diff`, `ls-files`, `check-ignore` against the reviewed repository; `git archive` for read-only checkouts | any |
| `tar` | Extracts the `git archive` stream into the review workspace | any |

Each reviewer CLI is probed before its first use in a review: version, then login state, then whether managed-policy files are present (`src/dispatch/cli.ts`). Failures surface as `CLI_MISSING`, `CLI_VERSION_UNSUPPORTED` or `AUTH_UNAVAILABLE` with a fixed next action, never as a guess at a fix. These CLIs are version-coupled: ArchFlow passes flags that suppress project instructions, user configuration, skills and tools, and a new CLI release can rename or drop one. The exact argv for each is covered by fixtures; see [mcp/DISPATCH.md](mcp/DISPATCH.md) and [LIMITATIONS.md](LIMITATIONS.md).

The `archflow-run` helper scripts (`skills/archflow-run/scripts/counter-review.sh`, `wait.sh`, `cleanup.sh`) additionally need `bash`, and `counter-review.sh` needs `jq`. `wait.sh` uses `flock` for its limit on concurrent commands and `setsid` to detach, and works without either.

## Filesystem and git

- **Reads:** the repository under review (changed, untracked and declared files), `.archflow/config.yaml`, `.archflow/constitution/`, and the installed bundle's `assets/`. The bundle finds `assets/` beside `dist/`; a source checkout finds it two levels up.
- **Writes:** `init` writes only the scaffold under `.archflow/` and edits or removes the legacy MCP registrations in `.mcp.json` and `.codex/config.toml`. `review` writes nothing into the repository except, when one reviewer's dispatch fails unexpectedly, an appended stack in `.archflow/runtime/diagnostics/internal-errors.log` (only if `.archflow/` already exists). It creates one temporary directory per review, outside the repository, and removes it.
- **A per-dispatch usage record** (a small JSON file: duration, model, token counts the CLI reported, failure stage) goes to `<ARCHFLOW_HOME>/usage/` for an installed bundle, and records older than seven days are deleted on the next dispatch. A source run does not write it.
- **Never written by tests, and by the CLI only through the usage log under `<ARCHFLOW_HOME>/usage/` (installed bundles only):** `~/.claude`, `~/.agents`, `~/.gemini`, `~/.archflow`, `~/.local/bin`. Otherwise only `install.sh`, run by a person, writes there (the reviewer CLIs themselves may refresh credentials in their own homes).

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` | `src/dispatch/workspace.ts` | Where each reviewer CLI finds its login. Passed through unchanged so a token refresh persists in the CLI's own store. |
| `PATH`, `USER`, `LANG`, `LC_ALL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` | the same | Forwarded to reviewer children. Everything else, including API keys and provider variables, is dropped. |
| `ARCHFLOW_HOME`, `ARCHFLOW_BIN` | `install.sh` | Install root (default `~/.archflow`) and launcher directory (default `~/.local/bin`). |
| `ARCHFLOW_LOCAL` | `counter-review.sh` | Overrides the command, e.g. `node dist/archflow-local.mjs`. |
| `ARCHFLOW_REAL_HOSTS=1` | `test/helpers/real-host.ts` | Opt in to tests that call real, authenticated model hosts. |
| `ARCHFLOW_CC_SWITCH_PROVIDER`, `ARCHFLOW_CC_SWITCH_MODEL` | `test/real-host/cc-switch-dispatch.test.ts` | Provider and model for the opt-in cc-switch test. |
| `ARCHFLOW_WRITE_PROMPT_SNAPSHOTS=1` | `test/unit/standalone-review-prompt-snapshots.test.ts` | Rewrites the rendered-prompt fixtures. |

## Network and authentication boundary

ArchFlow opens no sockets and calls no API itself. All network traffic belongs to the reviewer CLIs under the developer's own login, and their cost and rate limits are the developer's. ArchFlow neither reads nor stores credentials; a review's only trace of a call is the usage file above. Authentication stays in each CLI's canonical home on purpose; the consequences are in [LIMITATIONS.md](LIMITATIONS.md).

## Build, test, and release tooling

`package.json` scripts (the full list and what each is for is in [TESTING.md](TESTING.md)):

- `typecheck`, `test*`, `check`, `check:deep`: the development loop.
- `generate:schemas` / `check:schemas`: regenerate or byte-compare the JSON Schemas under `src/contracts/schemas/v1/` from the zod definitions (`scripts/generate-schemas.mjs`, which bundles the generator with esbuild).
- `release:stage|check|reproduce|write|smoke|mutations`, `check:release`: build and verify the tracked `dist/` payload with esbuild (`scripts/release-support.mjs`). The payload is `archflow-local.mjs`, `manifest.json`, `metafile.json` and `legal/`; the manifest records every input digest and the runtime asset files (`assets/config.template.yaml`, `assets/archflow.gitignore`, the two rubrics, and `assets/constitution/`). `assets/review-inputs.yaml` is compiled into the bundle as text (esbuild's `.yaml` loader; `vitest.config.ts` does the same under test) rather than shipped as a file.
- `check:notices` / `test:notices-policy`: check `THIRD_PARTY_NOTICES.md` against `package-lock.json`.

`release:write` promotes an explicitly staged payload into `dist/`; it never installs anything machine-wide. Rebuilding `dist/` is a release step of its own, not part of ordinary feature work.

### Legal material

`THIRD_PARTY_NOTICES.md` is generated from the lockfile and lists every locked package with its SPDX license, including optional platform packages. Retained notice text lives in `notices/` (TypeScript's NOTICE). `release/legal/upstream/installed-yaml-2.9.0/` and `installed-zod-4.4.3/` hold the license files for the two packages that are bundled into the shipped program, and they are copied into `dist/legal/`. Licensing is handled as ordinary package metadata and notices, in line with `CLAUDE.md`; there is no per-file license audit.

### Install

`install.sh` copies the verified bundle plus `assets/` into `<ARCHFLOW_HOME>/bundle/`, writes a two-line `archflow-local` launcher (`exec node …/dist/archflow-local.mjs "$@"`) into the launcher directory, and copies `skills/` into the Claude Code, Codex and Antigravity skill directories. It also removes artifacts older installs left behind (the `archflow-mcp` launcher and retired skills, owner-checked, and the old Antigravity MCP entry). Installing is always an explicit human action, never part of a task or a test.

## Change checklist

- Adding a runtime dependency: it is bundled into a shipped file, so it needs a pinned version, a license file under `release/legal/upstream/`, an entry in `THIRD_PARTY_NOTICES.md`, and a regenerated `dist/`.
- Bumping a reviewer CLI's supported version: update the minimum in `src/dispatch/cli.ts`, the argv fixtures, and run the opt-in real-host tests.
- Changing a shipped asset: update the runtime asset list in `scripts/release-support.mjs`, or it will be missing from `dist/` and from the installed bundle.
- Changing config or review schemas: run `npm run generate:schemas`.
