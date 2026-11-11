# COMPLEXITY

**Explored:** 2026-11-11 · **Commit:** `f1fe689` · **Covers:** `src/local/`, `src/review/`, `src/dispatch/`, `src/init/`, `src/contracts/`, `src/repository/`, `assets/`, `scripts/`, `test/helpers/`

A per-subsystem audit of the code as it now stands: about 5,500 lines of TypeScript in 49 files, plus the release scripts. Each item says what the complexity buys, so a simplification can be judged against the engineering priorities in `CLAUDE.md`. Line counts are rounded.

## How to read this

- **Load-bearing**: the complexity implements something a reviewer or human relies on. Simplify the implementation, never the guarantee.
- **Duplication**: the same shape exists twice; consolidating it is nearly free.
- **Questionable weight**: cost may exceed prototype-stage value. Candidates for "a documented limitation instead of a subsystem".
- **Residue**: machinery sized for a system that no longer exists (a long-lived server, initialized tasks). The cheapest wins.

## Where the weight is

| Area | Lines | Verdict |
|---|---|---|
| `src/dispatch/cli.ts` | 780 | Load-bearing, version-coupled; adapter duplication |
| `src/dispatch/workspace.ts` | 390 | Part load-bearing, part sized for multi-repository sets |
| `src/dispatch/process.ts` | 290 | Load-bearing |
| `src/repository/` | 490 | Questionable: serves only `init` |
| `src/review/` (all) | 880 | Mixed; see below |
| `src/contracts/` (all) | 1,200 | Mixed; schema generation is the heavy part |
| `src/init/` | 650 | Legacy cleanup is temporary by design |
| `scripts/release-support.mjs` and friends | 2,100 | Questionable weight |

## Ranked simplification targets

### 1. Residue from the long-lived server (dispatch)

`serializeDispatchAll` (`src/dispatch/cli.ts`) chains every review onto a process-wide FIFO queue so "one review in flight" holds in a long-lived server. `archflow-local review` is a one-shot process that makes exactly one such call, so the queue serializes nothing; the function reduces to `Promise.all`. The same is true of the process-lifetime preflight memo (`memoizedCliPreflight`): within one review it still saves a couple of child spawns for the three-plus children, but the "CLI upgraded under a running server" concern is gone with the server. A concurrency note in the repo should not describe a server that no longer exists. *Duplication/residue; removal is a few lines plus the tests that exercise the queue.*

### 2. Residue from initialized tasks

The word "task" survives in paths and prompts even though no task storage exists:

- `.archflow/tasks` is excluded or deleted in `src/review/simple-context.ts`, `src/dispatch/workspace.ts` (twice) and refused by the `paths` schema in `src/contracts/simple-review.ts`.
- `assets/review-inputs.yaml` and the `scope` text in `src/review/simple-review.ts` tell reviewers "this is a standalone simple task, not an initialized ArchFlow workflow", and prompt fixtures pin that text.
- `src/review/internal-error-log.ts` writes under `.archflow/runtime/diagnostics/`, a directory the old runtime owned; `assets/archflow.gitignore` exists to ignore `/runtime/`.

Two of these are deliberate hygiene (a repository that still holds old task directories should not leak them to reviewers, and the gitignore keeps the error log out of commits). The prompt wording is plain noise to a model that has never heard of initialized workflows. *Residue; the prompt wording is cheap to fix, the path exclusions are a judgment call.*

### 3. Naming debt: workflow words in surviving code

Review stages are `plan` and `implementation` at the CLI, but internally they route through `phase-design` and `phase-impl` (`src/review/inputs.ts`, `src/dispatch/routing.ts`, config `overrides`, the `phases:` map in `assets/review-inputs.yaml`). `WorkflowSubject` accepts `prd` and `design` that can never match (`src/contracts/config.ts`). File and type names say `simple` (`simple-review.ts`, `SimpleReviewInput`, `simple_plan` prompt blocks). The config keys stay because repositories' existing `config.yaml` files use them, and `simple-review.ts` keeps its name while another branch edits it, but each one makes a reader ask what a "phase" is. *Questionable weight at the cost of a compatibility decision; rename only with a config migration story.*

### 4. Two ways to run git, and a root-bound runner for one lookup

`src/repository/git.ts` and `identity.ts` (about 490 lines: a typed runner, classified failures, a branded `RootBoundGitRunner` that can only be minted by worktree discovery) are used by `init` alone, to find the worktree root and to ask whether scaffold paths are ignored. The review path never touches them; `src/review/simple-context.ts` has its own `simpleGit` wrapper around `execFile`. The brand exists to prevent a real past bug (`git ls-files` run from a subdirectory silently returning nothing), which is load-bearing for a runner with many callers and oversized for two. Options: shrink `repository/` to a `rev-parse --show-toplevel` helper, or move review onto the shared runner. *Duplication plus questionable weight.*

### 5. The review input pipeline is round-trippy

`sealDispatchInput` (`src/review/envelopes.ts`) builds a JSON record, serializes it to provisional bytes, re-parses and renders those through `prepareReviewInputs` (`src/review/inputs.ts`), then re-serializes with the rendered prompt and digests the result. The adapters later re-parse the same bytes to write the prompt and files into the workspace. Beyond an integrity check in `inputs.ts`, the digest and byte count are consumed only by the usage log. Passing the structured record directly, and rendering once, would remove two serialize/parse hops. The sealed bytes do give one inspectable artifact that fixtures pin, which is the real value. *Questionable weight.*

### 6. Multi-repository view machinery for a two-view case

`src/dispatch/workspace.ts` validates an ordered, named, sorted-and-unique set of views, each with its own identity digest, commit and optional projection, and `src/review/envelopes.ts` carries a `MULTI_REPOSITORY_VIEW_NOTE`. Review only ever builds two views of the same root, `primary` and `baseline`. The config still accepts and ignores a `repositories` key. A fixed two-view type would delete the name validation, ordering check and secondary-kind branches. *Questionable weight; the `git archive | tar` materialization and the contained-path writes are load-bearing and stay.*

### 7. Schema generation for seven JSON documents

`src/contracts/internal/schema-generation*.ts`, `scripts/generate-schemas.mjs`, the `check:schemas` script and `test/extended/schema-registry-compilation.test.ts` regenerate and byte-check seven schemas under `src/contracts/schemas/v1/` from the zod definitions (an eighth, `release-manifest.schema.json`, is hand-written). The generated documents are the review payload and result, config, rubric, constitution rule, path claim and error. They are real contracts for callers, but the pipeline (single-pass emission, local pointer rewriting, per-document registered instances in `errors.ts`) is a lot of machinery for a CLI whose payload is mainly built by one shell script. *Questionable weight; keep the schemas for the review input and result, which outside callers do depend on.*

### 8. Error registry sized for many owners

`src/contracts/errors.ts` defines 19 error codes with owners, retryability, strict parameter schemas and a `next_action`; `ErrorOwner` still lists five owners for a system with one program. The `CONFIG_INVALID` next action says "repair config" even when the real fix is reinstalling (see [LIMITATIONS.md](LIMITATIONS.md)): the registry cannot express two different fixes for one code, which is a symptom of the code being too coarse rather than too detailed. The union-flattening scorer in `describeValidationIssues` still keys on discriminator names (`kind`, `decision`, `skill`) from deleted request shapes. *Residue and small defects.*

### 9. Release and notice tooling

`scripts/release-support.mjs` (1,100 lines) plus smoke, mutation, reproduce and notice scripts, and the `check:release` composition, exist to prove that the tracked `dist/archflow-local.mjs` is byte-reproducible, hostile-payload resistant, and offline-runnable. The repository's own priorities say to avoid release infrastructure until needed. It is still wired into `check:deep`, and a tracked `dist/` is how the installer ships the bundle, so removing it is a product decision rather than a cleanup. *Questionable weight; flag for a human decision.*

### 10. Small frictions

- Two diagnostics paths describe the same limitation: `collectInitDiagnostics` reports the dispatch-isolation caveat as a string, and [LIMITATIONS.md](LIMITATIONS.md) repeats it.
- `collectInitDiagnostics` checks `claude` and `codex` but not the Antigravity CLI, although `agy` is a supported adapter.
- `HostIdentity` includes `"unknown"`, which `archflow-local review` can never produce (it rejects any producer other than the three), yet routing and adapter selection each handle it.
- `src/dispatch/usage-log.ts` and `usage.ts` keep a seven-day usage log beside the install and parse Claude's cost JSON; useful for budgeting reviews, with no consumer in the repository.
- Test fakes for the three CLIs live in `test/fixtures/dispatch/` as overlapping hand-written scripts (`fake-claude`, `fake-codex`, `plumbing-claude`, `plumbing-codex`, `plumbing-leak`), two of them per CLI.

## What is genuinely load-bearing (don't soften)

- **Snapshot-then-recheck** (`captureSimpleContext`, `assertCurrent` in `src/review/simple-context.ts`): the reports are only meaningful for the exact bytes reviewed. `BASELINE_CHANGED`, `POLICY_CHANGED` and `SUBJECT_CHANGED` are what stop a stale review from being mistaken for a current one.
- **Safe reads of caller-selected paths** (`safeParents`, `O_NOFOLLOW` opens, the 25 MiB cap): the paths come from a hand-built payload.
- **`assertPlainJson` before any hashing** (`src/contracts/plain-json.ts`): validating once and materializing once is what keeps a digest honest. See [PATTERNS.md](PATTERNS.md).
- **Strict child-output parsing** (`src/review/simple-review.ts`, `src/contracts/review.ts`, `adjudication.ts`): reviewer text only counts once it satisfies a closed schema; a constitution reviewer cannot invent a trigger for a rule that has none.
- **Argv and stdin discipline in the adapters** (`src/dispatch/cli.ts`, `process.ts`): payloads travel on stdin or files, never in one argv element past `MAX_ARGV_ELEMENT_BYTES`; children are killed as a process group on cancel or timeout.
- **Cross-family routing by trust precedence** (`src/dispatch/routing.ts`): a route is validated the same way whether it came from config or the payload, and a cc-switch provider cannot be paired with a non-Claude model.
- **Ownership checks in `init`'s legacy cleanup** (`src/init/legacy-registration-cleanup.ts`): it deletes only an entry it can prove an old init wrote, never follows symlinks, and replaces files through a temporary sibling.
- **`init` refuses before writing** (`src/init/assets.ts`): every destination is inspected before any is written, so a diverged scaffold never leaves a half-applied one.

## Suggested audit order

1. Residue (targets 1, 2 and the error-registry items in 8): small, safe, mostly deletions.
2. Prompt wording that still describes initialized tasks (second half of target 2).
3. The `repository/` shrink or merge (target 4).
4. The envelope round trip and the two-view workspace type (targets 5 and 6) together, since they touch the same types.
5. A human decision on release tooling and on schema generation (targets 7 and 9).
6. Naming (target 3) only with a plan for existing `config.yaml` files.
