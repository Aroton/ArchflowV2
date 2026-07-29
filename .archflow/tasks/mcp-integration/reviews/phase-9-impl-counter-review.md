# Phase 9 Implementation Counter-Review — Transaction Substrate and Exact Replay

**Task**: mcp-integration
**Reviewed**: 2026-07-29, uncommitted working tree on `feature/mcp-server` (baseline `3c47577`)
**Reviewer**: Claude (Fable 5), fresh-context counter-review; implementation and first verification were done by a different model.

## Verification performed

- Read the phase design, architecture amendments, and all changed/new source and test files in the design's Files table.
- Ran `npm run typecheck` (clean), `npm test` (1163 passed; the only 3 failures are the inherited `release-offline` assertions the design predicts), the crash suite directly (5/5), `npm run check:dependencies`, `check:notices`, and `test:notices-policy` (all pass, 126 locked entries).
- Empirically probed the new durable validator with a scratch test (finding 1 below); the probe file was removed afterward.

The kernel itself is in good shape: CAS-before-everything, state-authenticated replay, orphan resume without re-preparation, receipt no-clobber install, state-last commit, post-fault arbitration from durable facts, lock non-reentrancy, and the deep-frozen parsed-call graph are all implemented as designed and covered by real multi-process and fault-injection tests. The findings below are what the first verification missed.

## Findings

### 1. MAJOR — Prepared-mode durable validation does not require the receipt to be the successor of its supplied predecessor

`src/contracts/durable.ts` rank 8a rejects only `receipt.prior_revision > predecessor.revision` (`intent-receipt-future-revision`). A receipt with `prior_revision < predecessor.revision` — a stale/superseded receipt paired with a newer predecessor — **passes** `validateDurableSemantics(createPreparedIntentSubject(...))`. Confirmed empirically: a subject with predecessor at revision N and a locally-valid receipt at prior N−2 → resulting N−1 validates `ok: true`.

This contradicts both the design (rank 8a: "predecessor **revision**/identity/pins/adopted-checkpoint ↔ receipt prepared successor agreement") and the implementation's own comment ("an uncommitted receipt must be the exact successor of its supplied predecessor"). The kernel is currently shielded because `handleExisting` checks `prior_revision !== current.revision` before calling `validatePreparedAndCommitted`, but the consolidated validator is the defense-in-depth authority Phase 10's reconciliation/repair will consume, and it is silently weaker than specified.

**Resolution**: enforce `receipt.prior_revision === predecessor.revision` in prepared mode (deciding with the human gate whether `<` reports `intent-receipt-future-revision` under a clarified name or a new issue code, which touches the pinned code list), or record explicitly in the design why `<` is admitted. Add the missing revision-agreement test either way.

### 2. MAJOR — Closed request-digest selectors are runtime-tested for only 1 of 5 tools, and no golden digests exist

The design pins: "Golden fixtures pin every operation literal/field list" and verification step 2 requires "Golden request digests must change only for the exact per-tool semantic fields in the table." In the tree:

- `test/unit/fingerprints.test.ts` and `test/unit/state-request.test.ts` exercise only `archflow_state`. The `closedOperationFields` branches and `subjectFor` selectors for `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, and `archflow_waiver` have **zero** runtime coverage — including the gate branch's optional-`supersedes` handling and its `as RequestDigestSubject` cast in `src/state/request.ts:35`, which is exactly where a field-list mistake would hide from the type checker.
- No golden digest fixture pins any request digest, so an accidental change to a selector's field set or ordering semantics would not fail any test.

The compile-time `ExactSelectorCoverage` guard is present and good, but it proves key-set agreement with the input types, not what actually reaches the hash.

**Resolution**: add per-tool selector tests (including gate with and without `supersedes`) plus golden digest constants for all five tools, asserting each digest changes only when a listed semantic field changes.

### 3. MAJOR — The pinned mutation matrix for the 23 new durable issue codes is mostly missing

`test/contracts/durable-semantics-corpus.test.ts` only pins the `DURABLE_ISSUE_CODES` registry literals and count (44 → 67); it adds no behavioral cases. `test/unit/durable-semantics.test.ts` behaviorally exercises roughly four codes (self-digest, outcome-digest, config-mismatch at 8a, final-state-mismatch at 8b), and the kernel tests add request-mismatch and outcome-digest. That leaves ~17 codes with no test that the mutation fails at its pinned rank — among them all the 8a pin/identity codes the design explicitly enumerates ("Prepared-mode tests mutate task_id, repository/initialization/config/workflow/constitution/policy digests, policy_base_commit, and adopted_checkpoint independently") and all four 8b reference codes. Kernel truth-table rows also untested: `intent-receipt-future-revision`, `intent-receipt-tool-mismatch`, `intent-receipt-operation-mismatch`, and state-claims-intent-but-receipt-missing/noncanonical (`STATE_INVALID`). This is the coverage that would have caught finding 1.

**Resolution**: extend the adversarial corpus with one independent mutation per code, per the design's rank table, and add kernel tests for the four untested truth-table rows.

### 4. MAJOR — Crash verification silently substitutes in-process fault injection for the designed SIGKILL cut points

The design pins verification step 3 as "real env-gated children killed at receipt-temp, receipt-link, state-replace-before, and state-replace-after cut points. Use SIGKILL for abandoned-lock **and receipt-only crash** cases", with the cut-point hooks living in test-only child code ("env-gated child-only hooks excluded from dist"). `test/crash/state-transaction.test.ts` instead injects `AtomicWriter` failures in-process and pre-materializes the residue a kill would leave, using a real SIGKILL only for the lock case. A test comment argues production exposes no fault hook — but the design's intent was hooks in the *child fixture*, which is achievable without touching production code (the child can wrap `createAtomicWriter` and `process.kill(process.pid, "SIGKILL")` at each boundary, then the parent verifies restart classification against the real kernel-produced residue).

The simulated-residue coverage is a reasonable equivalence argument, but it is a deviation from pinned verification steps that was not surfaced anywhere outside a test comment, and it never demonstrates that a real mid-transaction kill leaves exactly the residue the simulation assumes (e.g. temp present + link installed + temp not yet unlinked).

**Resolution**: either add child-side kill-at-boundary cases for the four cut points, or record the substitution and its equivalence argument in the phase implementation log so the human gate can accept it explicitly.

### 5. MINOR — Dead code in `handleExisting`

`src/state/transaction.ts:580` — the second `prior_revision !== current.revision → intent-receipt-future-revision` check is unreachable: `prior > current` returned at line 560, `resulting <= current` returned at line 572, and rank-4b successor arithmetic forces `resulting = prior + 1`, so `prior === current` always holds here. Remove it or replace with a comment stating the invariant, so a future reader doesn't treat it as a live classification row.

### 6. MINOR — Revision-overflow handling is untested and classified as a programmer error

`executeLocked` and `buildPlan` both throw a bare `TypeError` when `current.revision === Number.MAX_SAFE_INTEGER`. Verification step 5 lists "safe-integer overflow" among exercised cases; no test covers it. Also, a durable state pinned at the safe-integer ceiling is environmental data, not a caller protocol bug, so a `TypeError` (which escapes the `ProjectResult` contract entirely) is a debatable classification worth one line of design-record. At minimum add the test; the duplicate check in `buildPlan` can also collapse into one place.

### 7. MINOR — The 1 MiB receipt cap is untested

`MAX_RECEIPT_BYTES` (`src/state/transaction.ts:52,424`) has no test. The design pins the cap as a kernel property ("The receipt's canonical byte length is capped at 1 MiB by the kernel"). One test with an oversized prepared plan (large `next_state` content) asserting the boundary and that no write occurred would pin it.

### 8. MINOR — `LiveConfigSnapshot` and `FingerprintReadContext` are declared twice

`src/state/read.ts` and `src/state/fingerprint.ts` each declare structurally identical `LiveConfigSnapshot` (and fingerprint.ts re-declares the reader context types the design placed with the seams). They interoperate only by structural typing. Import one declaration from the other to keep a single source of truth.

### 9. MINOR — `layout.ts` mints a `ResolvedTaskPath` by cast

`src/state/layout.ts:24` does `join(authority.task_root, "intents") as ResolvedTaskPath`. This phase specifically added `resolveTaskRoot` so task roots are minted "through the same resolution-time containment authority rather than a state-layer cast"; casting the brand for the intents child weakens that convention even though it is safe here (fixed literal under a constructor-proven root, `O_NOFOLLOW` + `O_DIRECTORY` open). Add a comment justifying the cast, or give `openResolved` a narrow overload for fixed-name children of a proven root.

### 10. MINOR — Untracked `AGENTS.md` is a silent, undesigned addition

`AGENTS.md` is a byte-identical copy of `CLAUDE.md`, absent from the design's Files table and unmentioned in any log. If it is intentional (Codex-side instructions file), it creates a second copy that will drift; prefer generating/symlinking it or noting the duplication obligation in both files. If unintentional, remove it before commit. Either way it needs a deliberate decision at the gate, not a silent inclusion in the phase commit.

### 11. MINOR — Double-fault paths can replace the original error

Two related edge behaviors deviate slightly from the design's error-fidelity text:
- In `src/state/lock.ts`, if the locked callback throws a programmer error and the lock `rmdir` also fails, the `finally` block's `TaskLockError("release")` replaces the original error; the kernel then reports `IO_ERROR {operation: "task-lock-release"}` and the underlying cause is lost.
- In `runStateTransaction`'s release-failure arbitration, an earlier install failure that already returned `IO_ERROR {operation: "task-state-replace"}` is re-arbitrated with operation `task-lock-release`, whereas the design says the unchanged-predecessor case "returns the original IO_ERROR".

Both require two simultaneous faults and are non-advancing either way; worth either a one-line fix (attach/prefer the first error) or a recorded acceptance.

## Not findings (checked and clean)

- Contracts barrel exports no state filesystem capability (proven by test and smoke bundle); `assertAuthenticParsedToolCall` is correctly kept out of the barrel.
- `INTENT_NOT_CURRENT` registration, parameters, retryability, and next action match the design exactly, including schema mirror and registry counts (52 → 53).
- The architecture.md amendment the Files table lists was already recorded in the design-approval commit `3c47577`; no further edit was required.
- Dependency admission is exact: `write-file-atomic@8.0.0` + `signal-exit@4.1.0` only, `proper-lockfile` still prohibited, engine narrowed to `^24.15.0` in both manifest and lock, notices updated, and the policy checker pins the resolved persistence subgraph.
- `parseToolCall` deep-freeze/detach is implemented at the source and the mutation tests cover nested rubric criteria, upstream path arrays, waiver origin/rule/scope, and gate evidence/context.
- Receipt schema bounds match the design (`prior_revision` ≥ 0 via `safeInteger`, `resulting_revision` ≥ 1); the local `plainJson` `$def` is acceptable since no shared plain-JSON `$def` exists to reuse.
- CAS precedence, exact replay with refreshed CAS vs. `STATE_CONFLICT` on original CAS, orphan resume with `prepareCalls === 0`, receipt-substitution rank-8b detection, collision-reread totality, and real multi-process one-winner/independent-task behavior are all pinned by tests.

## Triage

All findings were evaluated against the approved Phase 9 design and the repository's prototype priorities. Findings 1–9 and 11 were accepted and resolved. Finding 10 was rejected as outside the phase-owned working set.

### Major findings

1. **Prepared predecessor revision gap — accepted and fixed.** Prepared-mode durable validation now requires exact predecessor equality. A receipt whose `prior_revision` is greater than the supplied predecessor still reports `intent-receipt-future-revision`; a stale receipt whose `prior_revision` is less reports the existing `intent-receipt-revision-not-successor`. Both are rank-8a `STATE_INVALID` outcomes. Reusing the existing successor code closes the authority gap without expanding the pinned vocabulary.
2. **Selector and golden-digest coverage — accepted and fixed.** Runtime tests now cover all five tool selectors, exact operation/field sets, gate requests with and without `supersedes`, excluded intent/CAS/caller-fingerprint/transport data, and stable golden digests. The gate selector's cast was removed in favor of an exact field annotation.
3. **Durable mutation matrix and kernel truth-table coverage — accepted and fixed.** Behavioral tests now exercise all 23 Phase 9 receipt issue codes at their pinned ranks and error carriers, including every prepared identity/pin/checkpoint comparison and all committed-reference comparisons. Kernel tests now cover future receipts, tool/operation mismatch, and claimed missing/noncanonical receipts.
4. **Real crash cut points — accepted and fixed.** Test-only child code now performs real `SIGKILL` termination at receipt-temp, receipt-link, state-replace-before, and state-replace-after boundaries. Parent tests inspect the actual residue and restart through the real kernel. Production source and the temporary bundle are asserted free of cut markers and hooks.

### Minor findings

5. **Dead successor check — accepted and fixed.** The unreachable second check was removed and replaced with a comment documenting the arithmetic/classification invariant that proves equality at that point.
6. **Revision overflow — accepted and tested.** The duplicate check was collapsed to one pre-preparation boundary. The implementation retains a programmer-boundary `TypeError`: no safe-integer successor can be constructed, and Phase 9 has no approved durable error code for an exhausted revision space. Tests prove rejection occurs before preparation or writes.
7. **Receipt size cap — accepted and tested.** An oversized prepared transaction now has explicit coverage for the 1 MiB canonical receipt cap and proves that neither receipt nor state is written.
8. **Duplicate fingerprint context types — accepted and fixed.** `src/state/read.ts` owns `LiveConfigSnapshot` and `FingerprintReadContext`; `src/state/fingerprint.ts` imports and re-exports those types rather than redeclaring structurally equivalent copies.
9. **Fixed-child path cast — accepted and documented.** The cast remains intentionally narrow: it derives only the fixed `intents` child from a constructor-authenticated task root, followed by `O_NOFOLLOW`, `O_DIRECTORY`, and directory-stat verification. No caller-controlled segment is involved.
10. **Untracked `AGENTS.md` — rejected as phase scope.** The file was already user-owned and untracked when Phase 9 implementation began, is absent from the design's Files table, and was not created or modified by this phase. It remains untouched and will be excluded from Phase 9 staging; deleting or redesigning it would be an unrelated workspace mutation.
11. **Double-fault error replacement — accepted and fixed.** The lock preserves an original callback/programmer error if release also fails. For resolved transaction failures, release ambiguity now preserves the original install `IO_ERROR` operation when durable authority remains at the predecessor, while an authenticated committed state still returns success.

### Re-verification after triage

- Typecheck passed.
- Durable semantic unit/corpus suites passed with all 23 receipt issue-code behaviors covered.
- All-tool selector/golden suites passed.
- Kernel and lock focused suites passed, including overflow, receipt cap, truth-table, and double-fault cases.
- Real child-side crash suite passed all four transaction cut points plus abandoned-lock `SIGKILL`; temporary bundle smoke confirmed that no test cut hook entered production output.
