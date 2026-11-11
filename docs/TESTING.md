# TESTING

**Explored:** 2026-11-11 · **Commit:** `f1fe689` · **Covers:** `vitest.config.ts`, `package.json`, `tsconfig.json`, `test/`, `scripts/`

How the tests are organized, what each layer is for, and which command to run. The everyday gate is deliberately fast: it asks whether an edit broke the typed code, the focused behavior, or a public shape. It does not reproduce a release, and it never calls a paid model.

## Vitest projects

`vitest.config.ts` declares four non-overlapping projects, all in the Node environment. Worker counts are bounded to `availableParallelism() - 2` so the machine stays responsive during a run.

| Project | Directory | What belongs there | In `npm run check`? |
|---|---|---|---|
| `fast` | `test/unit/`, `test/contracts/` | In-process module behavior, and public shape and documentation checks | Yes |
| `extended` | `test/extended/` | Exhaustive schema compilation over the whole published schema set | No (`check:deep`) |
| `integration` | `test/integration/` | Real temporary git repositories, child processes, the CLI over stdin/stdout, a built temporary bundle, the install script | No (`check:deep`) |
| `real-host` | `test/real-host/` | Authenticated `claude`, `codex` and `agy` calls | Never automatically |

`tsc --noEmit` also compiles every `test/**/*.ts` file, so a test in a project nobody runs cannot silently stop compiling. This is how the real-host files stay checked without being run.

A `bundled-review-yaml` plugin in `vitest.config.ts` loads `assets/review-inputs.yaml` as a string, exactly as the esbuild bundle does, so tests see the same compiled-in configuration as the shipped program.

## npm scripts

| Script | Runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run --project fast` |
| `npm run test:unit` / `test:contracts` | `fast`, narrowed to `test/unit` or `test/contracts` |
| `npm run test:extended` | the `extended` project |
| `npm run test:integration` | the `integration` project |
| `npm run test:real-host` | the `real-host` project (opt-in; see below) |
| `npm run check` | `typecheck`, then `test`, then `check:notices` |
| `npm run check:deep` | `check`, then concurrently `check:schemas`, `test:notices-policy`, `test:extended`, `check:release`; then `test:integration` |
| `npm run generate:schemas` / `check:schemas` | regenerate, or byte-compare, the JSON Schemas under `src/contracts/schemas/v1/` |
| `npm run check:notices` / `test:notices-policy` | `THIRD_PARTY_NOTICES.md` against `package-lock.json`; the checker's own policy tests |
| `npm run release:stage` / `check` / `reproduce` / `write` / `smoke` / `mutations` | build, validate, rebuild-and-compare, promote, smoke-run and hostile-mutate a release payload (`scripts/`) |
| `npm run check:release` | `release:check`, `release:smoke`, `release:mutations` and `release:reproduce` concurrently, against `dist/` |

Narrow a run by passing a path after `--`: `npm test -- test/unit/plain-json.test.ts`, `npm run test:integration -- test/integration/local-cli-payload-input.test.ts`. That is the preferred debugging loop; a failure in one integration file does not need the rest.

`npm run check:deep` is for changes that cross many boundaries: schemas, process behavior, or release construction. There is deliberately no changed-file detector that guesses when to run it. `check:release` rebuilds and compares the tracked `dist/`, so it reports a difference whenever source changed and `dist/` was not rebuilt.

## What each layer covers

**Unit (`test/unit/`)** pins module behavior with a representative success and failure per boundary: plain-JSON and canonical-JSON rules (`plain-json`, `canonical`), config, constitution and rubric parsing (`workflow-config`, `constitution*`, `rubric`), approval-rule globs (`approval-rules`), route selection and validation (`dispatch-routing`), adapter argv, preflight and failure classification (`dispatch-cli*`, `dispatch-failure-observation`, `dispatch-recovery`), the child-process runner (`dispatch-process`), workspace creation and view materialization (`dispatch-workspace`), usage parsing and the usage log (`dispatch-usage*`), the Antigravity output reader, review input assembly and envelopes (`review-inputs`, `review-envelopes`, `review-rubrics`), the standalone review itself (`simple-review`, `local-review`), init assets and diagnostics (`init-*`), and git path and worktree identity (`repository-*`). `standalone-review-prompt-snapshots` compares every role's rendered prompt to the files in `test/fixtures/review-prompts/`.

**Contracts (`test/contracts/`)** pins public shapes: each generated JSON Schema agrees with its zod definition (`foundational-schema-agreement`, `shared-primitives-schema-agreement`, `error-schema-agreement`), canonical hashing matches the release script's (`canonical-parity`), the release manifest contract (`release-contracts`), the skill contract (`skill-contract-canonical`: skills name only shipped local commands and no retired tool, and keep exact frontmatter), `repository-boundary` (`src/contracts` never imports `src/repository`; `package.json` admits only `yaml` and `zod` at runtime on the Node 24 line and keeps expensive projects out of `check`), and a check on the documentation set.

**Extended (`test/extended/`)** compiles every published schema with Ajv, once, with the compiled validators cached.

**Integration (`test/integration/`)** runs real processes:

- the CLI surface: `local-cli-command-surface`, `local-cli-payload-input` (file and stdin payloads, empty input), `local-cli-stdin-discipline` (an input-free command never reads stdin);
- the standalone review end to end with scripted reviewer children (`simple-review-dispatch`, `review-corpus`, over `test/fixtures/corpus/review-scenarios.json`);
- dispatch: `dispatch-cli`, `dispatch-coordinator`, `dispatch-plumbing` (`USER` is preserved for Claude auth, workspaces stay disposable after a failure or abort, the Codex final file is bounded separately, a planted credential and routing canary never reach output and the canary scan is shown to catch a deliberately leaking fake, a grandchild in the process group is reaped on cancel); the oversized-argv guard is a unit test in `dispatch-process`;
- init: `init-orchestration` and `init-legacy-registration-cleanup` (scaffold, divergence refusal, `--force`, removal of old MCP registrations, symlinks left alone);
- the `archflow-run` helper scripts: `archflow-run-cleanup-script` (the run directory and the run's agents go in one commit, another run's agents, a person's own file and a symbolic link are kept, uncommitted run files refuse the removal, a dry run changes nothing, the run's scratch worktrees are removed and other worktrees are left alone) and `archflow-run-wait-handle-sweep` (old finished handles are deleted, a running one and anything that is not a handle are kept);
- `install-script` (argument handling, install to all three clients, pruning only files an earlier install owned, rejecting a mutated asset, the `PATH` hint) against a scratch `HOME`;
- the built bundle (`release-bundle-review`, `release-offline`): a staged payload validates, runs `init` from an install-shaped copy and reviews a repository offline, builds are byte-reproducible in independent roots, unsafe output roots are refused, and a bundle with no assets directory names the places it looked.

**Real host (`test/real-host/`)** calls the genuine CLIs: `dispatch` (schema-valid reviewer and constitution output in both producer directions), `review-scope` and `reviewer-file-access` (reviewers stay on the declared files), `preflight` (real version and login shapes; credential values never leak into errors), `failure-classes` (an invalid model and an abort are classified), and `cc-switch-dispatch`.

## Real hosts need an explicit opt-in

```text
ARCHFLOW_REAL_HOSTS=1 npm run test:real-host
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_CC_SWITCH_PROVIDER=<provider> npx vitest run --project real-host test/real-host/cc-switch-dispatch.test.ts
```

These use installed credentials, provider quota and a timeout derived from the 15-minute dispatch timeout. `check`, `check:deep`, the release scripts and builds never run them; a real-host run is a person's decision, and the files are kept compiling by `typecheck` alone. A rate-limit or session-limit failure that exits in about a second usually means the account quota, not a harness bug.

## Placement rules

- Deterministic module behavior with a representative success and failure: `unit`.
- Cheap public shape and wire invariants: `contracts`.
- Exhaustive matrices over the whole published schema set: `extended`.
- Anything that spawns `git`, runs a child process, drives the CLI, builds a temporary bundle or runs the installer: `integration`. A one-commit temporary repository is still integration; build it with `test/helpers/temp-repository.ts` (or `review-repository.ts`) rather than an inline scaffold.
- Anything authenticated or provider-dependent: `real-host`.
- Name tests for the behavior they cover, never the workflow phase that introduced them.
- Install and init tests use a scratch `HOME` and never write to the real `~/.claude`, `~/.agents`, `~/.archflow` or `~/.local/bin`.

There is no coverage percentage gate. Confidence comes from the fast layer plus deeper evidence chosen for the boundary a change touches. Expected-failure tests may print an `INTERNAL_ERROR` line to stderr while passing; that is the internal error log doing its job.
