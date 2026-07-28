## Implementation Log: Phase 6 - Repository Identity, Paths, and Canonical Digests

**Implemented**: 2026-07-28
**Status**: COMPLETE
**Requirements advanced**: REQ-04, REQ-05, REQ-13, REQ-26 (none completed — see the design's opening note)

### Decisions Made

- Kept the directional rule absolute: pure computation in `src/contracts/`, all `git`/`node:fs` in the new `src/repository/` tree. `src/contracts/**` never imports `src/repository/**`, and the repository barrel is never re-exported from the contracts barrel. `test/contracts/repository-boundary.test.ts` asserts this structurally rather than by convention, scanning import specifiers rather than raw text.
- Made every unsafe state unrepresentable with brands instead of documenting it: `TaskSlug`, `PathSafeId`, `TaskPathClaim`, `RepositoryPathClaim`, `RawGitPath`, `GitOid`, `ResolvedTaskPath`, and `RootBoundGitRunner`. Discovery returns the *runner*, not a location, so there is no way to keep using an unbound one; `tryRepositoryPathClaim` is the sole promotion from Git output to a claim and returns `undefined` rather than throwing so callers can count what they cannot represent.
- Withdrew `exit 128 ⇒ absent` as unsafe. Every command declares its own `ExpectedAbsence{code, stderrIncludes}`, and a nonzero exit is absence only when both the code and the diagnostic substring match. A dubious-ownership or corrupt-repository 128 now produces `IO_ERROR`, not a silent empty answer.
- Centralised the failure translation in one exported `projectErrorForGitFailure` rather than letting each of chunks 5–8 re-derive it. The design pinned the failure map but no function for it; five independent authors would have produced five encodings of the same error.
- Recorded the `--literal-pathspecs` finding as a permanent prohibition rather than a one-off workaround, because the natural instinct is to "harden" the call by adding the flag back.
- Chose the denylist limitation over a speculative subsystem for request-digest exclusions (counter-review finding 3). See Gotchas.

### Deviations from Plan

- **Containment step 6 was wrong in the design and is now corrected.** The pinned condition omitted `rel !== ".."`, and `"..".startsWith("../")` is `false`, so it *accepted the root's own parent* — the exact escape the check exists to prevent. `release-support.mjs`'s private `isInside` carries the guard; this design had dropped it. Added with a regression test; the design document is updated.
- **`--literal-pathspecs` and `:(top,literal)` are mutually exclusive.** The flag disables pathspec magic, so the magic prefix is then matched as a literal filename and selects nothing (reproduced on git 2.43: empty output). Placed after the subcommand, `ls-files` and `check-attr` reject it outright. `check-attr` takes pathnames, not pathspecs, so it needs neither. Kept `:(top,literal)` alone, which supplies both literal matching and root anchoring. The design's success criterion was unsatisfiable as written and is corrected.
- **`--git-common-dir` is relative to the process cwd, not the worktree toplevel.** From `repo/nested/deeper` it returns `../../.git`; resolving that against the toplevel lands two levels above the repository and produced a real `IO_ERROR`. Both values are now queried through one `git -C <worktreeRoot> rev-parse --git-dir --git-common-dir`, which makes the design's stated resolution rule true in every case. `--path-format=absolute` was still rejected — it would raise the version floor to ~2.31.
- **The ID inventory was incomplete for a fourth time**, which is why the mechanical sweep is mandated. Additional sites retightened: `review.ts`, `triage.ts`, `adjudication.ts` and their five schemas; `errors.ts` (`task_id` on `taskPathClass`/`TASK_INVALID`, `gate_id` at five further codes); `authority-link.schema.json`; four more `trust.ts` `task_id` interface fields; two more `mcp-tools.schema.json` `task_id` sites. Named but non-existent: `input_id` (zero occurrences repository-wide) and `prior_gate_id` in `mcp-tools.ts`.
- **At `review.ts`/`triage.ts`/`adjudication.ts` the retightening is a vocabulary swap, not a narrowing.** Those `task_id` fields used a local kebab-only pattern (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), not `safeId`. `TaskSlug` caps length at 64 but newly admits `.`, `_`, and a leading digit. Applied for consistency with "global per logical ID, no exceptions"; flagged at the human gate.
- **`.gitattributes` is a tracked release control**, so chunk 1's rule forced a `dist/manifest.json` regeneration the Files table never anticipated. See Gotchas for the larger consequence.
- **`step 3` also uses the nearest-existing-ancestor walk.** The task root `.archflow/tasks/<task-id>/` legitimately does not exist before task initialization, and a bare `realpath(root)` turned every pre-init resolution into `IO_ERROR`.
- **`TaskSlug`/`PathSafeId` gained the reserved-device and trailing-dot rules** after counter-review finding 2. The pinned regexes accepted `con`, `task.`, `CON`, `gate.`, `PRN.txt` — all rejected at path composition, recreating the exact mismatch these types were introduced to prevent. The two predicates now live in `evidence.ts` and are imported by `path-claims.ts`, so the two authorities cannot drift.
- Added one exported symbol beyond the pinned lists per module where the design pinned behaviour but no function: `projectErrorForGitFailure` (chunk 4), `ARCHFLOW_ATTRIBUTES_REMEDIATION` (chunk 7), `secretFindingV1Schema` (chunk 9).

### Patterns Established

- **Brands are minted by exactly one function and the brand symbol is module-private.** `RootBoundGitRunner` is the strongest instance: only `discoverWorktree` can mint one, so "run a repository query from an arbitrary cwd" is a compile error, not a review comment.
- **Errors carry an explicit `RepositoryOperationContext`, never one the reader invents.** Every project error these readers promise needs parameters no Git command returns (`task_id`, `phase_instance`, `operation`, `attempt`). Any new reader takes the context as an argument.
- **Shared digest helpers are pinned so two chunks cannot construct the same error differently** — `historyIdentityDigest` and `repositoryCandidateDigest`. Never re-derive a digest inline; `GIT_DIVERGED` hashes OIDs through the shared helper because `PROJECT_PARAMETER_SCHEMAS` requires 64 hex characters.
- **Digest inputs are validated and materialized once, then never re-read.** `computeInputFingerprint` and `computeRequestDigest` call `assertPlainJson` then `structuredClone` on the whole subject as their first statement; every later step reads the detached clone. Any future digest function must do the same — see Gotchas.
- **Three-way failure convention, applied without exception**: parsers and assertion helpers throw; orchestrating readers (anything that runs a git command or touches the filesystem) return `ProjectResult<T>`; pure derivations return their value directly.
- **Zod and JSON Schema edits are one indivisible change**, because `assertZodAgreement` compares them. This now includes the *inline mirrors*: eight schemas duplicate the ID patterns literally, and updating only `primitives.schema.json` reintroduces the drift.
- **Set-valued collections are sorted and duplicate-checked before hashing.** `canonicalJsonBytes` sorts object keys but preserves array order, so an unsorted collection lets two callers hash identical logical inputs to different fingerprints.

### Gotchas

- **`--literal-pathspecs` silently returns nothing when combined with `:(top,literal)`.** No error, empty output. Anyone "hardening" a git call by adding the flag will break the readers invisibly.
- **`check-attr -z` emits NUL triplets, not lines**: exactly 6N NUL-terminated fields for N paths and two attributes. Any other count is treated as a mismatch rather than best-effort parsed.
- **`ls-files -s -z` fields are `<mode> <oid> <stage>\t<path>`** — split on NUL first, then on the single tab. Never split the path on whitespace.
- **Running a reader from a subdirectory is a silent wrong answer, not an error.** From `repo/sub`, `ls-files` returns nothing and `check-attr` reports `text: auto`. This is why the root-bound runner exists.
- **`git rev-parse --show-superproject-working-tree` exits 0 whether or not there is a superproject** — the submodule test is for empty output, not exit code.
- **`fsPromises.realpath.native` is `undefined`** even though `fs.realpath.native` and `fs.realpathSync.native` exist.
- **`O_NOFOLLOW` does not exist on Windows**, so containment step 7 is a no-op there and the symlink defence rests entirely on steps 3–6. Containment is check-then-use with an inherent TOCTOU window: Node 24 has no `openat`-style API, no `O_PATH`, no `O_RESOLVE_BENEATH`, and no equivalent of Go's `os.Root`.
- **`assertPlainJson` already rejects accessor properties**, which is what made the counter-review blocker cheap to fix. Before the fix, a getter could return a safe object to the exclusion walk and an excluded field to canonicalization, so `computeRequestDigest` returned a digest containing `intent_id` instead of throwing. Any function that inspects a caller-owned object more than once has this bug.
- **KNOWN LIMITATION — the request-digest denylist is not category-complete.** `operation_fields` is an open `PlainJsonObject`, so exact-name exclusion cannot catch `started_at`, `attempt_number`, `retry_reason`, `timed_out`, and similar spellings; two callers can encode the same volatile state under different names and disagree. The correct fix is a closed per-operation allowlist, which Phase 6 cannot build because it defines no operations. **Owner: the phase that defines per-operation request field sets** must replace the denylist and delete the note in `fingerprints.ts`.
- **The Windows-specific rules are verified lexically only.** CI is `ubuntu-latest`; trailing-dot/space stripping, reserved device names as real filesystem aliases, and `O_NOFOLLOW`'s absence are never exercised against a real Win32 filesystem.
- **Orphan branches remain a documented limitation.** Checking out an orphan branch changes HEAD's root set and surfaces as `REPOSITORY_MISMATCH`, which is the intended behaviour.
- **`.gitattributes` is in `REQUIRED_CONTROLS`**, so touching it invalidates the tracked release payload — and regenerating that payload is gated on a risk-decision re-binding, not a mechanical rebuild. Any phase that edits a release control input inherits that gate. Node `24.15.0`/`24.18.0` were absent again and had to be installed; the ambient `24.11.1` is below the `>=24.15.0` engines floor.
- **Beware abandoned `build-release.mjs` processes.** Four orphaned runs (PPID 1) from a prior session were found pinning four cores for 4h17m. The script does not die with its parent and has no wall-clock timeout, so an interrupted agent leaves a full release build spinning. Recorded as a follow-up, not fixed here.

### Key Interfaces

- `src/contracts/canonical.ts`: `GitOid`/`parseGitOid`/`gitOidV1Schema`, `GIT_TREE_MODES`/`GitTreeMode`/`ArchflowTreeMode`/`parseGitTreeMode`/`normalizeGitTreeMode`, `canonicalJsonBytes`, `sha256Bytes`, `canonicalJsonDigest`, `gitBlobOid`, `historyIdentityDigest`, `repositoryCandidateDigest`, `CanonicalDocument<T>`, `canonicalDocument`, `parseCanonicalDocument`.
- `src/contracts/evidence.ts`: adds `PathSafeId`/`pathSafeIdV1Schema`/`parsePathSafeId` and `TaskSlug`/`taskSlugV1Schema`/`parseTaskSlug`, plus the shared `isReservedDeviceName` and `endsWithDotOrSpace` predicates that `path-claims.ts` imports. The pre-existing `safeId` is unchanged.
- `src/contracts/path-claims.ts`: `TaskPathClaim`, `RepositoryPathClaim`, `RawGitPath`, `rawGitPath`, `tryRepositoryPathClaim`, `toRepositoryPathClaim`, `TASK_PATH_CLASSES` (13), `REPOSITORY_PATH_CLASSES` (4), `PATH_CLASSES` (17), `READ_ONLY_PATH_CLASSES`, `parsePathClass`.
- `src/contracts/fingerprints.ts`: `computeInputFingerprint(InputFingerprintSubject)`, `computeRequestDigest(RequestDigestSubject)`, `EXCLUDED_REQUEST_DIGEST_FIELDS`, `computePinnedConfigDigest(bytes)`, `verifyPinnedConfig(expected, observedBytes)`, `DeclaredInputRef`, `GitIdentityRef`.
- `src/contracts/secret-scan.ts`: `SecretScanCandidate`, `SecretFinding`, `SecretScanResult` (clean/detected/unavailable), `secretScanResultV1Schema`, `parseSecretScanResult`, `SecretScanner` — contract only, no engine. Schema `urn:archflow:schema:v1:secret-scan-result`.
- `src/repository/git.ts`: `createGitRunner({cwd, gitPath?, maxBuffer?, timeoutMs?})`, `GitRunner{cwd, run, runText, runNulFields}`, `GitCommandSpec`, `ExpectedAbsence`, `GitInvocationError`, `GitFailureKind`, `preflightGit(runner, context)`, `GitEnvironment`, `RepositoryOperationContext`, `projectErrorForGitFailure(error, runner, context)`.
- `src/repository/identity.ts`: `discoverWorktree(runner, context) → ProjectResult<RootBoundGitRunner>`, `WorktreeLocation`, `RootBoundGitRunner`, `resolveRepositoryIdentity(runner, environment, context)`, `verifyRepositoryIdentity(expected, observed)`, `computeTaskIdentity(taskId, repository)`, `RepositoryIdentity`, `TaskIdentity`.
- `src/repository/paths.ts`: `classifyTaskPath`, `classifyRepositoryPath`, `resolveTaskPath`, `resolveRepositoryPath`, `openResolved(path, flags)`, `ResolvedTaskPath`, `ResolvedPath`.
- `src/repository/attributes.ts`: `ARCHFLOW_GITATTRIBUTES_RULE`, `ARCHFLOW_ATTRIBUTES_REMEDIATION`, `AttributeCheck`, `checkArchflowAttributes(runner, paths, context)`.
- `src/repository/index-entries.ts`: `IndexEntry`, `readIndexEntries(runner, paths, context)`, `assertArchflowIndexEntry(entry)`.
- `src/repository/history.ts`: `readHistoryStatus(runner, context)`, `classifyMutationReadiness(status, context) → ProjectResult<void>`, `WorktreeHistoryStatus`, `UpstreamState`, `IN_PROGRESS_OPERATIONS`, `InProgressOperation`.
- `src/repository/index.ts`: the sole repository barrel, 39 symbols, created once by chunk 8.
- `test/helpers/temp-repository.ts`: `createTempRepository({label, directoryName, attributes, config})` with `write`/`chmod`/`commitAll`/`hashObject`/`git`/`addWorktree`/`relocate`/`forceConflict`, plus `cleanupTemporaryRepositories` and `gitAvailable`.

### Verification

- Full aggregate green under exact Node `24.15.0` and `24.18.0` except the one blocked step below: `probe:phase4-mcp-compatibility`, `typecheck`, `test:mcp-runtime` (99), `test:contracts` (102), `build:temp`, `check:dependencies`, `check:notices`, `test:notices-policy`, `check:phase4-mcp-boundary`, `test:phase4-mcp-boundary-policy` all pass.
- 635 of 638 tests pass, up from 383 before the phase. The 3 failures are `test/integration/release-offline.test.ts` "stale bundle input".
- Counter-review findings 1 and 2 were reproduced independently before triage and re-verified after fixing. Finding 1's secondary claim (same subject hashing differently across consecutive calls) did **not** reproduce; the split-observation defect it points at is real and was fixed regardless.
- Integration suite runtime is ~0.7 s of test time and leaves no `/tmp` residue.

### Blocked at Phase Close — a contradiction in the release integrity model

`npm run check:release` cannot pass, and **the blocker is not the risk re-acceptance.** The user explicitly re-accepted the `fast-uri-3-1-0-local-risk` decision for this bundle. The re-binding was then attempted end to end and **`release:stage` passed** with the rebound records. Promotion is what fails: `release:write` aborts with `HEAD dependency_gate_decisions record changed or disappeared: fast-uri-3-1-0-local-risk`.

Three invariants in `scripts/release-support.mjs` cannot all hold across a bundle change:

1. `:1380` — every decision record committed at HEAD must remain **byte-identical** in the candidate. So a decision cannot be edited in place.
2. `:803` — **every** decision in `dependency_gate_decisions` must satisfy `decision.bundle_digest === manifestValue.bundle_digest`, i.e. bind the *current* bundle.
3. `:676-677` — a supersession requires **both** the superseded and the replacement decision to remain in `dependency_gate_decisions`.

In-place re-binding violates (1). The supersession mechanism, which exists precisely for this, violates (2) — the retained superseded record necessarily carries the *old* bundle digest, so it can never satisfy the every-decision check. An amendment does not help either: `:673` binds it to an unchanged decision digest, leaving the stale `bundle_digest` in place to fail (2). `write-tracked-release.mjs` has no override flag.

**Consequence: the tracked `dist/` payload cannot be re-promoted after any bundle change.** This is the first time that has been attempted — Phase 5 *created* the initial tracked release, so the re-promotion path was never exercised. The measured values are recorded for whoever fixes it: old bundle `16faf636…`, new bundle `dec8044b…`, and `dependency_inventory_digest` **unchanged** at `1f93c687…`, confirming no dependency change.

All attempted edits to `release/` and `dist/` were reverted; both are at HEAD. Fixing this means changing Phase 5's integrity model — most plausibly by scoping (2) to non-superseded decisions — which is a deliberate design decision about legal-record semantics, not an expedient patch to land mid-commit. **Recorded as the top follow-up, out of Phase 6 scope.** The three failing `test/integration/release-offline.test.ts` cases are this one issue.

### Durable Convention Proposal

Two rules outlive this task and belong in the project's `CLAUDE.md`, since `.archflow/` is deleted before PR:

1. **Never pass `--literal-pathspecs` to a Git invocation that uses a `:(top,literal)` pathspec.** The flag disables pathspec magic, so the prefix is matched as a literal filename and the command silently selects nothing.
2. **Validate and materialize a caller-owned object once before inspecting it more than once.** Use `assertPlainJson` then `structuredClone`; an enumerable getter can otherwise return different values to a validation pass and a hashing pass.

Everything else recorded here is specific to this task and stays in this log.
