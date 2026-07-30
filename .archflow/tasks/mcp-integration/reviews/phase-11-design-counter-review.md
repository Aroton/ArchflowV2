# Phase 11 Design Counter-Review

**Subject**: `.archflow/tasks/mcp-integration/phases/phase-11-snapshots-implementation-manifests-and-restore.md` (Designed 2026-07-29)
**Reviewer**: Claude Code (opposite-client counter-review; different model from the drafting model)
**Date**: 2026-07-29
**Inputs read**: `architecture.md` (full, incl. Phase 7–12 entries and the Data Model / Snapshot-bounds invariants), `prd.md` (REQ-08, 11, 13, 21, 22, 23, 25, 26, 33, 39, 50), Phase 7/8/9/10 designs and implementation logs, `.archflow/context/{architecture,dependencies,patterns}.md` (stamped `91a7c95`, 14 commits stale — every claim below was re-verified against the live tree at `5a902ef`). No other workspace repository that shares this task has its own `.archflow/context/`; the three that do (`Archforge`, `snib-apis`, `snib-modular-genesis`) are unrelated projects.

**Live code verified**: `src/contracts/{durable.ts,durable-primitives.ts,durable-implementation-output.ts,durable-document.ts,durable-state.ts,durable-maintenance.ts,durable-checkpoint.ts,secret-scan.ts,errors.ts,evidence.ts,canonical.ts,fingerprints.ts}`, `src/state/{transaction.ts,transitions.ts,reconciliation.ts,atomic.ts,layout.ts}`, `src/repository/{git.ts,paths.ts,index-entries.ts}`, `scripts/{check-dependency-policy.mjs,check-notices.mjs}`, `tsconfig.json`, `package.json`.

**Dependency currency verified against the live npm registry and the actual tarballs** (`@secretlint/core@13.0.4` is current, MIT, `type: module`, `engines.node >=22`; `@secretlint/secretlint-rule-preset-recommend@13.0.4` is current and MIT; the installed closure is exactly the eight packages the design names — six MIT plus `structured-source@4.0.0` and `boundary@2.0.0` under BSD-2-Clause). Findings 1 and 5 were reproduced by executing the pinned packages and `tsc@7.0.2`; Finding 3 was reproduced against real `git`.

---

## Finding 1 — BLOCKER: disabling `filter-comments` inside the preset has no effect, so untrusted output *can* suppress secret detection

Chunk 4 pins "the preset's `@secretlint/secretlint-rule-filter-comments` disabled so untrusted output cannot suppress findings with directives", and Verification Steps require proving "representative provider tokens in either form fail even when surrounded by Secretlint disable directives".

`@secretlint/core@13.0.4` honours `disabled` in exactly one place: the top-level `registerRule` in `module/index.js`, which is applied to the entries of `options.config.rules`. Preset sub-rules take a different path — `registerRulePreset` → `preset.create(presetContext)` → `createRulePresetContext.registerRule` → `RunningEvents.registerRule` — and `module/RunningEvents.js` never reads `disabled` at all. The nested `rules: [{ id: "@secretlint/secretlint-rule-filter-comments", disabled: true }]` descriptor is therefore constructed, passed down, and ignored.

Reproduced against the pinned packages (content = one `ghp_…` token; directive = lowercase `secretlint-disable-next-line`, which is what the bundled `HTML_COMMENT_REGEXP` matches):

| config | findings |
|---|---|
| preset, no directive | 1 |
| preset, directive present | **0** |
| preset + nested `filter-comments: disabled` (as designed) | **0** |
| the preset module's exported `rules` registered flat, minus `filter-comments` | 1 |

Implemented as written, a model-authored review or document that happens to contain `secretlint-disable` silently passes the pre-projection scan and the secret is committed to the task branch — the exact failure the architecture's "scan the complete candidate projection and fail closed" invariant exists to prevent — and success criterion 5 fails.

**Suggested resolution**: the preset module publicly exports `rules` (28 rule creators) alongside `creator`. Register those individually as top-level `SecretLintCoreConfigRule` entries with `filter-comments` filtered out (verified working above) instead of registering the preset. `detector_set_id` then records the flat rule-set identity rather than a preset-plus-override identity. Whichever route is chosen, the design must state that the disable is asserted by a *test*, because the config field is silently inert.

## Finding 2 — BLOCKER: four of the manifest facts the phase must "independently verify" have no defined derivation anywhere

Chunk 2 requires building `ImplementationOutputV1` and independently verifying "…before/after blob identities, …, base/index/worktree identities, …, and canonical diff digest"; chunk 3 requires validating "manifest/source-artifact correspondence"; chunk 1 pins `snapshot_digest` into `ResultManifestV1` and describes it as identifying "the declared-output snapshot"; success criterion 2 claims "exact diff digest" round-trips.

Four of those digests have **no producer and no specification** in the repository:

- `ImplementationOutputV1.diff_digest` (`src/contracts/durable-implementation-output.ts:103`) — the only other occurrence in `src/` is the `commit-authorization` gate context (`src/contracts/gates.ts:36`), which Phase 12 consumes.
- `ImplementationOutputV1.index_identity_digest` and `worktree_identity_digest` (`:96-97`) — no derivation exists; `src/repository/index-entries.ts` reads index entries but computes no identity digest.
- `snapshot_digest`, on both `ImplementationOutputV1` (`:104`) and `DocumentArtifactV1` (`src/contracts/durable-document.ts:70`).

Phase 7 recorded this deliberately — `test/contracts/durable-semantics-corpus.test.ts:1450` is literally named *"verifies no diff_digest, snapshot_digest, index/worktree identity, or secret-scan target"* — and named Phase 11 as the layer that turns assertions into facts. The design inherits that obligation but defines none of the four, so "independently verify every supplied manifest fact" and "manifest/source-artifact correspondence" are not implementable for them: comparing `manifest.snapshot_digest` to `artifact.snapshot_digest` is comparing two unauthenticated agent-supplied strings.

`snapshot_digest` additionally needs an explicit amendment, not just a derivation. Phase 7 documents it as "the retained result this document projects" (`durable-document.ts:70`), i.e. the same thing as `AuthoritativeResultRef.result_digest` — which the agent cannot know, because the server mints the manifest. This design silently redefines it as the declared-output snapshot identity to avoid a digest cycle. That is the right call, but it changes a shipped Phase 7 contract's meaning and must be recorded as an amendment in the architecture (the parent-docs-reflect-reality rule), or a reader will keep resolving `snapshot_digest` as a result address.

**Suggested resolution**: pin, in this design, the canonical byte layout for each of the four (e.g. `snapshot_digest = canonicalJsonDigest` over the sorted `(path, path_class, operation, file_type, mode, oid | payload_digest)` tuples; `index_identity_digest` / `worktree_identity_digest` over the sorted declared-path × (mode, oid) observations rather than the whole tree — see Finding 9; `diff_digest` over the canonical per-path before/after identity list, since a textual `git diff` is not byte-stable across Git versions and config). Add the `snapshot_digest` semantic amendment to `architecture.md`.

## Finding 3 — BLOCKER: the pinned `git hash-object --path=<p> --stdin` recipe computes the wrong OID for symlink outputs, and `--path` cannot be combined with `--no-filters`

Chunk 2 pins one uniform recipe — "`git hash-object --path=<declared-path> --stdin` … so clean-filter/attribute behavior determines the post-attributes OID" — and applies it to every output. `OutputEntry` has a `symlink` variant in all four operations (`durable-primitives.ts:91-165`), success criterion 2 claims symlinks round-trip, and Verification Steps exercise "`.gitattributes` clean/text behavior … symlinks".

Git does not apply attribute conversion to symlink blobs; it stores the target verbatim. `hash-object --path` has no notion of entry type and applies conversion unconditionally. Reproduced in a real repository with `.gitattributes` = `* filter=upper` and `filter.upper.clean = tr a-z A-Z`, on `link -> abc`:

```
git ls-files -s link              -> 120000 f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f
printf abc | git hash-object --path=link --stdin -> 48b83b862ebc57bd3f7c34ed47262f4b402935af   # wrong
printf abc | git hash-object --path=link --stdin --no-filters
  -> error: Can't use --path with --no-filters
```

So the design's escape hatch does not exist: `--path` and `--no-filters` are mutually exclusive. As written, every symlink output under any path carrying a clean filter or text conversion gets a wrong `after.oid`/`before.oid`, the `-w` variant writes a wrong object into the ODB, and restore of that symlink either fails or produces wrong bytes.

**Suggested resolution**: make the recipe type-dependent. Regular files use `hash-object --path=<declared-path> --stdin` (correct, and the reason for the design's post-attributes reasoning). Symlinks use the unconverted identity — the existing pure `gitBlobOid(target)` (`src/contracts/canonical.ts:79`) or `hash-object --stdin` with no `--path` — and the design should say so explicitly, because the correct-looking uniform recipe is the trap.

## Finding 4 — BLOCKER: the new `AuthoritativeResultRef` can never reach `next_state`; `src/state/transitions.ts` is missing from Files

Chunk 6 requires `materializePlan` to "require its `reference` to appear exactly in `next_state.authoritative_results`". `next_state` is produced by Phase 10's `planStateTransition`, which copies the field forward and then **throws** if it differs:

```ts
// src/state/transitions.ts:144-146
if (!isDeepStrictEqual(draft.authoritative_results, input.current.authoritative_results)) {
  throw new TypeError("transition planning changed authoritative results");
}
```

`transitions.ts` is not in the Files table and no chunk mentions it. Implemented as listed, either the planner throws on every result-producing transition or the reference is absent and `materializePlan` rejects the plan; there is no third outcome. The same omission hides a design decision that needs pinning: `authoritative_results` is a set keyed `(phase_instance, step)` with duplicates rejected (`durable-state.ts:142-143`), so a new generation *replaces* the previous entry at that key — which is precisely the entry the collision classifier relies on to authenticate displaced before-images. That ordering (classify against current state, then replace) is correct but currently implicit.

**Suggested resolution**: add `src/state/transitions.ts` (and its tests) to Files, and pin in chunk 6 that the planner accepts an optional result reference, inserts-or-replaces it at its `(phase_instance, step)` key preserving the sort, and rejects any other change to the set — so the existing preservation guarantee survives for every non-result transition.

## Finding 5 — BLOCKER: importing the pinned preset breaks `npm run typecheck`, and the reviewed closure is not eight packages

`tsconfig.json` sets `"skipLibCheck": false`, so the preset's own declaration file is type-checked. `@secretlint/secretlint-rule-preset-recommend@13.0.4` ships:

```ts
// module/index.d.ts
export declare const rules: import("@secretlint/types").SecretLintRuleCreator<
  import("@secretlint/secretlint-rule-aws").Options>[];
```

`@secretlint/secretlint-rule-aws` is a **devDependency** of the preset (all 28 rules are rollup-bundled into `module/index.js`), so it is not installed. Reproduced with the repo's exact `tsconfig.json` and `typescript@7.0.2`:

```
node_modules/@secretlint/secretlint-rule-preset-recommend/module/index.d.ts(2,86):
  error TS2307: Cannot find module '@secretlint/secretlint-rule-aws' or its corresponding type declarations.
```

This fires on any import of the module, including one that only names `creator`, and it is unavoidable for Finding 1's resolution, which must import `rules`. Adding `@secretlint/secretlint-rule-aws@13.0.4` fixes it but pulls `@textlint/regexp-string-matcher@^2.0.2` and its own closure, so the design's "eight-package closure of six MIT and two BSD-2-Clause packages" — accurate today for `core` + `preset` alone — no longer describes what gets locked.

**Suggested resolution**: pick one and state it with the resulting closure re-counted: (a) a repo-local stub declaration plus a `paths` mapping for `@secretlint/secretlint-rule-aws` (no new package, keeps `skipLibCheck: false`); or (b) admit `@secretlint/secretlint-rule-aws@13.0.4` and its transitive closure into the reviewed pin set, notices, and dependency policy. Do not relax `skipLibCheck`; it is repo-wide policy inherited from Phase 1.

## Finding 6 — MAJOR: retained Git objects written with `hash-object -w` are unreferenced and garbage-collectable, so REQ-25's restore guarantee rests on prunable storage

Chunk 2 pins "`-w` only when retaining the verified object" and "tracked bytes use that Git object and zero copied-payload accounting"; chunk 5 admits a target as restore-ready when its before-image is "authenticated by … a verified Git object"; chunk 3 says availability is "validated on every read or restore".

For implementation outputs this is the normal path, not the exception. Commit authorization is a separate later gate (architecture, REQ-13/Phase 12), so at the moment `archflow_state` records an `implementation-output` the after-image is typically *uncommitted*: the blob does not exist in the ODB at all until `-w` writes it, and once written it is reachable from no ref, no commit, and (unless the agent staged) not from the index. Unreferenced loose objects are removable by `git gc --prune=now`, `git prune`, and by ordinary auto-gc once `gc.pruneExpire` (default two weeks) lapses — over a task lifetime that is a real window. Failure is fail-closed rather than corrupting (`SNAPSHOT_INVALID` on the availability check), but REQ-25's "rerunning a phase with an unchanged input fingerprint restores the exact previously validated authoritative output bytes" and success criterion 1 then become unavailable with no recovery path, and the design gives no signal that this was considered.

The architecture already supplies the answer — "raw payload bytes are copied only when collision-safe restoration needs bytes not available from the bound Git object" — but the design collapses "tracked" into "available", which is not the same predicate.

**Suggested resolution**: define availability as *reachability*, not existence. Treat a Git object as an authoritative restore source only when it is reachable from a commit (or, with a stated caveat, the index); otherwise retain a raw payload and account its bytes. Note the consequence in chunk 3: uncommitted implementation outputs then count against the 25 MiB per-result cap, which is the honest accounting and is what the cap exists to bound.

## Finding 7 — MAJOR: `artifact_digest` points at bytes nothing retains, and the manifest drops the fields REQ-11/REQ-13 and Phase 12 depend on

`ResultManifestV1` is pinned as "the retained authority for one result" and carries `artifact_digest` "identif[ying] the validated source artifact". Nothing in the system retains that artifact: `state.json` has no artifact slot, the Phase 9 receipt retains the *outcome* (path/revision/status) rather than the request artifact, and the architecture's `results/sha256/<digest>/` layout contains only `manifest.json` and `payload/`. Consequently:

- Chunk 3's "validate … manifest/source-artifact correspondence on **every read or restore**" cannot be performed after the originating request ends. There is nothing to correspond to.
- The manifest's field list omits `diff_digest`, `parent_documents`, `declared_inputs`, `base_commit`, `index_identity_digest`, `worktree_identity_digest`, `restore_targets`, and `undeclared_changes`. `diff_digest` is Phase 12's digest-bound commit-authorization subject (`src/contracts/gates.ts:36`) and `parent_documents`/`declared_inputs` are REQ-11/REQ-13 evidence. After the request, none of it exists anywhere — so Phase 12 will have to re-open this storage decision.

**Suggested resolution**: either retain the validated source artifact document at the result address (e.g. `results/sha256/<result-digest>/artifact.json`, which makes `artifact_digest` resolvable and every later correspondence check real, and requires a `paths.ts` class-template addition), or carry the missing evidence fields into `ResultManifestV1` and restrict the correspondence check to creation time. Either way the architecture's directory layout needs the corresponding update.

## Finding 8 — MAJOR: the projection apply never re-verifies the classified before-image, so a collision arriving after classification is silently overwritten

Chunk 5 classifies every declared target during `prepareResultInstallation`, and chunk 6 applies "its **already-authenticated** projection plan before receipt/state". Those two points are separated by `buildPlan`, receipt construction, semantic validation, and directory setup (`src/state/transaction.ts:683-688`, then `installPlan`). The task lock excludes other ArchFlow writers but not the human's editor, a formatter, or a build watcher — this product mutates the user's live worktree by design.

The architecture's invariant is unconditional: "No default, timeout, retry, manual fallback, or repair path silently overwrites the collision." A divergent write that lands in that window is discarded without a `restore-collision` gate. The receipt-only resume path is already correct here (chunk 6 reconstructs the plan against current authority); the normal path is the gap.

**Suggested resolution**: pin that the apply re-reads each declared target immediately before replacing it and aborts non-advancingly if its identity no longer matches the classified before-image. This is one `lstat` plus one hash per declared path against an already-computed digest — not new machinery, and it is what makes the "classify before mutation" claim true rather than approximately true.

## Finding 9 — MAJOR: over-scoped verification and integrity work that the operating envelope does not need

Three places spend effort out of proportion to the product, and each changes what gets written:

1. **Maintenance crash matrix.** Verification Steps demand real-process fault injection "before and after … maintenance record, each permitted deletion". Maintenance is human-authorized, rare, record-first, and specified as idempotent, and its candidates are caller-supplied. One record-then-delete ordering cut plus a plain repeated-call idempotence test buys the same confidence as a per-deletion killed-child matrix. Keep the real-process cuts where authority actually moves: payload, manifest, projection, receipt, state.
2. **Reachability as a transitive graph walk.** Chunk 7's "following validated references transitively and failing closed on missing or contradictory material" describes a general closure engine. With Phase 15 owning enumeration, every root is caller-supplied and the reachable set is a fixed two-step walk — state/checkpoint roots → named result manifests → those manifests' payload paths — followed by a set-membership test on the supplied candidates. Write it as that walk; a generic engine is a maintenance liability with no second consumer.
3. **`worktree_identity_digest` (see Finding 2).** If it is defined over the whole worktree, verifying it makes every implementation output fail whenever any unrelated file changed, and makes the check O(repository) on every call. Define both identity digests over the declared paths plus the recorded undeclared-change observation, which is what the manifest's invariants actually read.

## Finding 10 — MAJOR: the dependency-admission work item is incomplete; the first new runtime dependency since Phase 5 fails `npm run check:dependencies` as listed

Files lists `package.json`, `package-lock.json`, and `THIRD_PARTY_NOTICES.md`. `scripts/check-dependency-policy.mjs:3-9` hard-codes the exact permitted runtime dependency set and requires `package.json.dependencies` to equal it exactly (`compareDirect`, `:38-50`), asserting the same set again against the lockfile root. Adding Secretlint fails that check until the script is edited, and Verification Steps run it (`dependency-policy and notice checks`, and `npm run check`).

`scripts/check-notices.mjs` is fully lock-derived and needs no edit — but it does require one SPDX row per new lock entry in `THIRD_PARTY_NOTICES.md`, so the row count follows whatever Finding 5 resolves the closure to (8, or 8 plus the `secretlint-rule-aws` closure). Neither new package ships a standalone `NOTICE`, so no `notices/` asset is required.

**Suggested resolution**: add `scripts/check-dependency-policy.mjs` to Files and state that the reviewed pin set recorded there must match the closure named in chunk 4 exactly.

---

## Checked and found sound (no finding)

- **Dependency currency.** `@secretlint/core@13.0.4` and `@secretlint/secretlint-rule-preset-recommend@13.0.4` are the current published versions, both MIT, both pure ESM with `engines.node >= 22`. The installed closure is exactly `@secretlint/{core,types,profiler,secretlint-rule-preset-recommend}` + `debug@4.4.3` + `ms@2.1.3` (MIT) + `structured-source@4.0.0` + `boundary@2.0.0` (BSD-2-Clause) — six MIT and two BSD-2-Clause, as claimed, and every license is in `approvedLicenses`. No copyleft and no `lightningcss`.
- **`lintSource` shape.** `{source: {content, filePath, ext?, contentType}, options: {locale?, maskSecrets?, config, noPhysicFilePath?}}` matches the design exactly, and `contentType: "unknown"` does make text-only rules run: `SecretLintRuleImpl.supportSourceCode` short-circuits to `true` for `unknown`, so `filter-comments` (`supportedContentTypes: ["text"]`) and every provider rule execute. Column really is zero-based (`SecretLintSourceNodeLocation`), so the design's one-based conversion is right, and `SafeId`'s charset admits both `secretlint:<suffix>` and a composite `detector_set_id` within 128 characters.
- **The `.p12` concern is real, not defensive over-caution.** The bundled GCP rule calls `fs.readFileSync(source.filePath)` on `ext === ".p12"` using the *logical* `filePath`, not `getPhysicalFilePath()` — so `noPhysicFilePath: true` does **not** neutralise it. Forcing `ext: ""` for `.p12` is the correct fix, and documenting PKCS#12 as undetected is the honest consequence.
- **Never spreading upstream messages.** Confirmed necessary: the bundled rules interpolate the matched secret into `message` (e.g. `` `found GCP Service Account's private key(p12): ${FILE_NAME}` ``, `` `found GitHub Token: ${TOKEN}` ``), and `filterMaskSecretsData` masks `message` only for values the rule also reported under `data`. Constructing fresh findings is the right rule.
- **Cap enforcement placement.** `SnapshotAccountingV1` pins `result_bytes ≤ 26_214_400` and `task_bytes ≤ 262_144_000` structurally (`durable-primitives.ts:340-349`), so an over-cap accounting is unrepresentable — preflighting before the result directory exists and returning `SNAPSHOT_LIMIT` is the only implementable order, and `SNAPSHOT_LIMIT`'s parameters (`limit_scope`, `offending_paths`, `current_bytes`, `byte_cap`) already carry exactly what the design promises to report.
- **Not rewriting a reused generation's `accounting`.** Correct and non-obvious: `measured_at_revision` and `task_bytes` are creation-time facts, and rewriting them would change the manifest's canonical bytes and therefore its `result_digest`, breaking the content address the reuse path just resolved.
- **Error taxonomy.** `SNAPSHOT_LIMIT`, `SNAPSHOT_INVALID`, `RESTORE_COLLISION`, `SECRET_DETECTED`, and `RECONCILIATION_REQUIRED` all exist with non-retryable classification and stable next actions (`src/contracts/errors.ts:47,67`); the design invents no code.
- **Restraint worth keeping.** "This phase does not add a second rollback-payload shape"; representing the three `restore-collision` outcomes without creating the gate; keeping enumeration in Phase 15 and gate lifecycle in Phase 12; and reusing the single consolidated `validateDurableSemantics` authority rather than adding a second one — all correct, and all consistent with the repository's stated priorities.
- **Receipt-only resume.** Selecting the result reference from the validated receipt's prepared state, reconstructing the plan against *current* authority, and installing state without calling `prepare` fits `handleExisting`/`installPlan` (`src/state/transaction.ts:586-641`) exactly; the extra fourth slot on `materializePlan` (`:412-423`) is a clean extension of the existing exact-slot check. Widening `atomic.createExclusive` past its current `intent`/`maintenance-record` restriction (`src/state/atomic.ts:50-51`) and `layout.ts` past its single fixed child are correctly identified as required edits.
- **Phase sizing** is set by the architecture and was not reviewed.

## Triage

All ten findings were accepted. The phase design and parent architecture were revised before implementation approval.

### Finding 1 — Accepted

The design no longer registers the preset `creator` or relies on its inert nested `disabled` field. It imports the preset's public `rules` array, registers the rule creators at top level, and omits `@secretlint/secretlint-rule-filter-comments` entirely. `detector_set_id` now binds the exact sorted enabled IDs and omission. Verification asserts the rule is absent and exercises broad, line-scoped, and rule-targeted directives. Independent reproduction confirmed the blocker with broad and targeted directives; the review's exact `disable-next-line` result is sensitive to the bundled line calculation, so the design does not overclaim that one fixture as the sole proof.

### Finding 2 — Accepted

The design now pins domain-separated canonical subjects for all four deferred facts. `snapshot_digest` hashes normalized final present/absent declared-target states; `diff_digest` hashes `base_commit` plus normalized operations and before/after identities while excluding retention accidents; index and worktree identities hash declared-scope observations plus the canonical undeclared-change report. The parent architecture records that Phase 7's “retained result” description was wrong: `snapshot_digest` identifies the declared-output snapshot, while `result_digest` alone addresses the retained manifest. The Phase 7 contract comments and schema `$comment`s are now in the Files plan for correction.

### Finding 3 — Accepted

The uniform OID recipe was split by file type. Regular files use path-aware `git hash-object --path=<path> --stdin`; symlinks hash target bytes without path conversion via `gitBlobOid` or equivalent `hash-object --stdin`. A real filtered-path symlink/index comparison is required. The design makes no nonexistent `--path --no-filters` escape-hatch claim.

### Finding 4 — Accepted

`src/state/transitions.ts` and its tests are now explicit phase files. `planStateTransition` accepts an optional authenticated result reference only at the matching successful producing boundary, inserts or replaces its `(phase_instance, step)` tuple in canonical order, and preserves the set exactly for ordinary transitions. Collision classification reads the current generation before replacement, and the transaction still requires the exact reference in prepared `next_state`.

### Finding 5 — Accepted

The design chooses the maintainable dependency fix: exact `@secretlint/secretlint-rule-aws@13.0.4` is a direct development dependency solely to satisfy the preset's shipped declaration under `skipLibCheck: false`. The reviewed Secretlint-related lock closure is recounted as fourteen packages — twelve MIT and two BSD-2-Clause — and package/lock/notices verification uses that set. No local declaration shim or `skipLibCheck` relaxation is introduced.

### Finding 6 — Accepted

Object existence and `hash-object -w` are no longer retention. `git-object` storage is permitted only when the embedded artifact's base commit remains on the current task-branch ancestry and its exact tree path resolves to the required OID/mode; uncommitted and index-only tracked output uses counted `raw-payload` storage. The parent architecture and success criteria now require an aggressive-prune fixture that remains restorable.

### Finding 7 — Accepted

`ResultManifestV1` now embeds the exact validated `DocumentArtifactV1 | ImplementationOutputV1` and requires `artifact_digest === canonicalJsonDigest(source_artifact)`. This retains the missing diff, parent, input, base/index/worktree, restore, and undeclared-change evidence without duplicating selected fields or adding an `artifact.json` path class. Every read revalidates the embedded artifact and its wrapper correlations, so Phase 12 has a durable commit-authorization subject.

### Finding 8 — Accepted

Every projection-plan entry records the classified before identity, including absence. Apply rereads the complete target set before the first mutation and rereads each target immediately before its own replacement. A mismatch before mutation yields zero writes; a later mid-apply mismatch never overwrites the changed target and uses the authenticated rollback/repair path for earlier mutations. Verification now covers both race windows without claiming protection against hostile filesystem TOCTOU.

### Finding 9 — Accepted

The maintenance crash matrix is reduced to the record boundary, one representative deletion cut, and ordinary repeated-call idempotence coverage. The generic reachability engine is replaced by a schema-specific bounded walk from supplied validated state, checkpoint chains, resumable receipt prepared states, and decision/review evidence to named manifests and then payloads. Incomplete roots fail closed and Phase 15 must provide/attest complete enumeration. Index/worktree identities hash only declared-path observations; unrelated content is represented only by the existing undeclared-change report.

### Finding 10 — Accepted

`scripts/check-dependency-policy.mjs` is now in the Files table and must update its exact runtime/development allowlists for the chosen pins. `scripts/check-notices.mjs` remains lock-derived and needs no code edit; `THIRD_PARTY_NOTICES.md` follows the final fourteen-package closure.

## Fresh-review follow-up

The substantial triage revision received a new bounded fresh-context closure review. It found two remaining majors; both were resolved without adding a speculative storage subsystem.

- **Alternate commit proof for changed after-images — accepted as a clarification, alternate subsystem rejected.** The reviewer correctly observed that `base_commit` cannot prove the after OID of an add, modify, or rename-with-modification. The design now says those surviving bytes always use counted raw payloads in the current pre-commit workflow. Zero-copy is intentionally limited to bytes already addressable at the embedded base commit/path, chiefly a pure rename's unchanged blob. A new per-entry alternate-commit proof would have no current producer because commit authorization is Phase 12.
- **Delete and rename before-image semantics — accepted.** Phase 7's fixed `storage: "git-object"` on delete is now interpreted only as “no retained post-state payload”; a later delete may authenticate its before-image from the current authoritative raw generation or from the base tree. Rename is explicitly non-overwriting because `OutputEntry` carries no destination-before identity: derivation, collision classification, and apply all require the destination to be absent. Existing destinations remain collisions instead of being silently overwritten or forcing a second rollback shape.

The fresh reviewer found no remaining blocker or major issue in the embedded-artifact digest relation, canonical identity subjects, Secretlint flat-rule plan and reviewed closure, pure-prepare installation capability, result/reference correlation, collision rollback, or bounded maintenance roots.
