# Phase 14 Implementation Counter-Review

**Task**: mcp-integration
**Phase**: 14 — Constitution Adjudication, Drift, and Review Fixed Point
**Reviewed**: 2026-07-30 (fresh-context counter-review of the uncommitted working tree)
**Scope**: complete scoped diff (63 tracked modifications + 17 untracked files), phase design, implementation log, `architecture.md`, `prd.md`, `.archflow/context/`.

## Verification actually run

| Command | Result |
|---------|--------|
| `npm run typecheck` | clean |
| `npm test` | **1471 / 1474 pass**, 1 file failed |
| `npm run check:dependencies` | passed (140 locked entries) |
| `npm run check:notices` | passed (140 SPDX, 21 NOTICE mappings) |
| `npm run check:phase4-mcp-boundary` | passed (90 production files, SDK isolated) |
| `npm run build:temp` | passed under v24.18.0 |

**Inherited failures, correctly attributed.** The three failures are all in `test/integration/release-offline.test.ts` — stale tracked bundle and the residual `__require` loader (`stale bundle input: src/contracts/adjudication.ts`). `git diff test/integration/release-offline.test.ts` is empty, so the assertion set is unchanged and these remain the Phase 13 → Phase 15 inheritance the log names. **None of the findings below is one of those three.**

Criteria confirmed met, with no findings: the two-rewrite disk-backed fixed point and post-restart reload (`test/integration/review-fixed-point-phase14.test.ts:1162`); `evidence_digest === artifact_digest === canonicalJsonDigest(payload)` with a distinct rendered projection digest; the seven-member tool union and widened manifest union; all four encodings of the amended `enforced_by` pass rule; pinned-constitution resolution from the commit tree with worktree edits/deletions changing neither digest nor registry, and both uncommitted and committed edit detection; automatic same-family adjudication refused before launch; supplemental gate-counter authority reconstructed from parsed evidence with a forged-slot negative; `SCHEMA_IDS` 40, error registry 53, barrel-absence assertion extended, `src/main.ts` boundary intact; PRD/architecture amendments 1–10 recorded.

---

## Findings (ordered by severity)

### 1. HIGH — The result-installation guard never requires the `archflow_state` call to carry the evidence artifact it installs

`src/state/transaction.ts:533-556` (`expectedInstallationSource`) keys the mapping on `call.input.step` and on the **manifest's** embedded `source_artifact` only. It never inspects `call.input.artifact`. Nothing else closes the hole:

- `src/state/transitions.ts:114-117` — `artifactMatches` returns `true` for an absent artifact at any step other than a succeeded `produce`, so a succeeded `self_review`/`triage` with no artifact is legal.
- `src/state/transitions.ts:145-158` — `resultReferenceMatches` is satisfied by the installation's own reference.

So an evidence result installs cleanly on an **artifact-less** `archflow_state` call. Two concrete consequences:

1. `src/state/request.ts:21-23` then selects `record-state-boundary`, whose `operation_fields` are `{phase_instance, step, status}` — no `artifact_kind`, no `artifact_digest`. The request digest does not bind the retained evidence at all, so two different evidence payloads share one request identity. The design's own justification for adding `record-self-review`/`record-triage` was that "the resume-list distinguishability this design depends on is only real once `computeRequestDigest` admits them"; that property is bypassable.
2. `src/state/transaction.ts:821-826` — `resumesResult` does not include `record-state-boundary`, so a crash after receipt creation falls into the `else if (plan.result_installation !== undefined)` branch and calls `installResultFacts(..., false)` (non-resuming) instead of the `load_retained_result` resume path.

The pinned decision named exactly this hazard as the reason for the mapping: *"without the mapping an evidence installation could ride an artifact-less `archflow_state` call."* The implemented mapping does not prevent it.

Secondary, same site: even when `call.input.artifact` **is** present, nothing requires `manifest.source_artifact.evidence` to equal `call.input.artifact.evidence`. Two distinct evidence payloads that share `task_id`/`phase_instance`/`step`/`input_fingerprint` pass every check, so the digested request artifact and the retained artifact can differ.

**Fix**: in `expectedInstallationSource`, for `archflow_state` at `self_review`/`triage`, require `call.input.artifact !== undefined` and `canonicalJsonDigest(call.input.artifact) === canonicalJsonDigest(source)`. Both are programmer-invariant violations under the pinned split, so `TypeError` is the right category.

### 2. MEDIUM — The rewritten result-installation guard has zero negative-case coverage

Success criterion 4 requires "Every guard site rejects its own negative case … each violation in exactly one category," and the Verification Steps enumerate the cases: wrong tool for an evidence installation, `task_id`/`repository_identity_digest` not binding the authenticated task, and a reference the prepared plan does not name.

Grep across `test/` finds **no reference** to any of `result-installation-task-mismatch`, `result-installation-repository-mismatch`, `result-installation-state-mismatch`, `result-installation-target-mismatch`, `result-installation-payload-target-mismatch`, `result-installation-projection-target-mismatch`, nor to any of the four `TypeError` messages in `validateResultInstallationBinding` (`src/state/transaction.ts:539, 556, 579, 587`). `test/unit/state-transaction.test.ts` gained only the two `assertAuthenticTransactionOutcome` assertions (`+5` lines total).

This is ~70 lines of new trust-boundary code, one of the nine named guard sites, entirely unexercised — and it is what hid Finding 1.

By contrast the gate re-entry guards *are* covered (`test/integration/state-gate-lifecycle-phase12.test.ts:479-560` exercises wrong step/status/phase/attempt-context and asserts the archive is never written), which makes the installation gap stand out as an omission rather than a house style.

### 3. MEDIUM — `runAdjudication` throws where the design pinned classified failures

`runAdjudication` is declared `Promise<ProjectResult<…>>` and every other failure path returns a `ProjectResult`. Two expected, non-programmer conditions escape as rejections instead:

- **Malformed adjudicator output.** `src/review/adjudication.ts:70-79` raises `AdjudicationServiceError` carrying `MODEL_OUTPUT_INVALID`; the call at `:380-384` is not wrapped. A defective child — the single most expected failure mode on this path — rejects the promise. `MODEL_OUTPUT_INVALID` is a first-class registry code, and the pinned split says only "violations reachable only from a defective trusted callback" stay as throws; the model is not a trusted callback.
- **Unapproved upstream.** `src/review/fixed-point.ts:357-363` — `requireApprovedUpstreamDigests` throws a bare `TypeError` when no `artifact-approval` `ApprovalRef.subject_digest` matches, and `adjudication.ts:350` does not catch. The pinned decision states this case means "advancement stops **non-advancing**"; an upstream that simply has not been approved yet is ordinary operational state.

Phase 15 must now wrap `runAdjudication` in `try/catch` to satisfy the tool contract, which is exactly the asymmetry the classified/throw split was meant to remove.

### 4. MEDIUM — Manual-checkpoint adoption is silently stricter than documented, and both required regression tests are missing

`src/state/transitions.ts:145-158` changes `resultReferenceMatches` from the design's "**permit** a result reference at any succeeded evidence step" to **require** one: `producing` is now true for every succeeded `self_review`/`counter_review`/`triage`/`adjudicate`, and `if (reference === undefined) return false`. `src/state/checkpoints.ts:114-119` and `src/state/initialization.ts:157-162` compensate by searching `checkpoint.authoritative_results`.

Effect: a human-authored chain whose succeeded evidence checkpoints do **not** carry a matching `authoritative_results` entry is now `TRANSITION_INVALID`. That is a second re-specification of `ManualCheckpointV1` beyond the attempt counter, and it is recorded nowhere — not in the log's Deviations, not in architecture amendment 4, not in the PRD REQ-39 edit (which mentions only the attempt counter). Amendment 4 explicitly says this class of change must reach the manual-mode documentation.

Coverage gaps against criterion 5 and the Verification Steps ("**one manual-checkpoint chain-replay case in both adoption paths**"):

- `test/unit/state-checkpoints.test.ts` was only *repaired* — the fixture's second checkpoint moved from `attempt: 1` to `attempt: state.attempt` and gained `authoritative_results`. There is **no** test asserting a chain carrying the old per-step reset is rejected as `TRANSITION_INVALID`.
- `test/unit/state-initialization.test.ts` is untouched. The initialization adoption path has no chain-replay case at all, and its chain fixtures still sit at `attempt: 1`.

### 5. MEDIUM — The completed-enactment replay window is narrower than the pinned decision

Pinned: the replay arm recognises "archived retry-effect record with `current.revision > request.opened_at_revision`."

Implemented (`src/state/gates.ts:806-825`, `validateCompletedReentry`): `current.value.revision !== request.opened_at_revision + 1 || step !== "produce" || status !== "running"` → `STATE_INVALID gate-reentry-replay-state-mismatch`.

So replay works for exactly one revision. Once the retried produce moves (`running → succeeded`, or a further same-step retry), a duplicate or late `openDurableGate`/`resolveDurableGate` for that gate id returns `STATE_INVALID` rather than the recorded outcome. Criterion 2's "a replayed call after a completed enactment returns the recorded outcome rather than `INTENT_NOT_CURRENT`" holds only inside that window, and the narrowing is not listed among the log's Deviations.

### 6. MEDIUM — A retry-effect decision on a gate opened outside `adjudicate`/`succeeded` becomes permanently unresolvable

`closedStateForRecord` (`src/state/gates.ts:800-805`) routes **every** `revise` / `revise-current` / `retry-once` through `planGateAuthorizedReentry`, which hard-requires `status === "succeeded"` and `step === "adjudicate"` (`gates.ts:750-760`; `triage` only for `attempts-exhausted`).

If any caller opens a `review-trigger`, `adjudication-failure`, or `material-drift` gate at another boundary and the human writes a `revise` decision, resolution fails `STATE_INVALID` and the archive is never created — asserted directly by `test/integration/state-gate-lifecycle-phase12.test.ts:530-560`. The human's decision file is then unresolvable; the only escape is deleting it and choosing a non-retry outcome, which is not documented anywhere.

Phase 14 owns *when* these gates open, so nothing in-phase breaks. But the precondition lives only inside `planGateAuthorizedReentry`: `GateOpenInput` does not carry it, no doc records it, and Phase 15 will bind the handler that could violate it. This deserves an explicit statement in the log's Key Interfaces alongside the `resolve_gate_reentry_fingerprint` note.

### 7. LOW-MEDIUM — Two divergent "waiver in force" predicates, both deviating from the pin

The pinned decision is *"One predicate, checked where `review-trigger` and `adjudication-failure` admissibility is decided."* Implemented as two:

- `waiverInForce` (`src/review/fixed-point.ts:368-383`) is exported but has **no production caller** — only tests.
- The predicate actually consulted for gate satisfaction is re-implemented inline at `src/review/fixed-point.ts:188-204`.

Both also test `state.terminal === "complete"` where the pin says a waiver is in force "while `state.terminal === undefined`". `TERMINAL_STATES = ["complete", "abandoned"]` (`src/contracts/durable-state.ts:27`), so a waiver stays in force on an `abandoned` task. Impact is small (an abandoned task should not be advancing anyway), but it is an unrecorded deviation from a pinned rule, and two copies of a trust predicate will drift.

### 8. LOW-MEDIUM — Criterion 7's "two material upstreams … taking different decisions" is fixture metadata, not an executed loop

`test/fixtures/corpus/adjudication-scenarios.json` carries `modeled_resolution: "amend-upstream"` and `"revise-current"`, and `test/integration/review-corpus-phase14.test.ts:214-218` asserts only that those two strings are present in the corpus in that order. `expected_first_upstream` correctly pins the serialization (`selectAdjudicationGates`'s `.find` over sorted `drift_findings`), and the two scenarios are separately authored adjudicator outputs.

What is **not** exercised anywhere: open the first `material-drift` gate → resolve it → re-adjudicate → observe the second upstream's gate. The criterion's "one at a time in sorted order **with re-adjudication between**, taking different decisions" is therefore modelled, not proven. Given the design's own reasoning ("re-adjudicating is not bookkeeping — it is the only way the second gate's context is true when it opens"), this is the one corpus criterion worth an integration case rather than a JSON label.

### 9. LOW — `CurrentReviewSet.reviews` weakened from qualified to verified evidence, unrecorded

`src/contracts/trust.ts:179` changes `readonly reviews: readonly QualifiedReviewEvidence[]` to `readonly VerifiedReferencedEvidence<"review">[]`, dropping the authority-link requirement from a Phase 2 trust type. The change is defensible — `deriveCurrentEvidenceSet` reconstructs the set from retained manifests, which is stronger provenance than a caller-supplied `AuthorityLink`, and `authorityQualifier.currentReviewSet` still checks qualification at runtime on its own path — but it is a public contract relaxation that appears in neither the log's Decisions nor architecture amendments 1–10. Per the frozen-contracts guidance the change itself is fine; the silence is the finding.

### 10. LOW — `test/unit/state-request.test.ts` was not updated, so its stated exhaustiveness is now false

The design's Files table and Verification Steps both name `test/unit/state-request.test.ts:140-142` as a site the amendment changes. The file is untouched. Its test "selects **every** artifact operation and binds the exact canonical artifact digest" (`:136`) still enumerates five of the seven `artifact_kind`s. `record-self-review`/`record-triage` are covered only in `test/unit/fingerprints.test.ts:211-215`, which exercises `computeRequestDigest` but not the `satisfies`-checked map in `src/state/request.ts:27-35`.

### 11. LOW — Archived-replay arms of `openDurableGate` no longer compare the caller's `input_fingerprint`

`src/state/gates.ts:513-515` now calls `validateLiveGateState(..., current.value.input_fingerprint)`, making that function's own fingerprint test (`gates.ts:391`) vacuous, and the real comparison moved to `gates.ts:560-565` — **after** the entire `archived !== "missing"` block. All three archived-replay arms (decided, cancelled, enacted-retry) therefore return without comparing the caller's fingerprint to durable state. Deliberate and necessary for the enacted-retry arm; the other two lost a check they previously had. `requestRead.value.request_digest === input.request_digest` bounds the exposure since the request digest covers the fingerprint, so this is a defence-in-depth regression, not an authority hole.

Same site, cosmetic: `ensureDecisionDirectory` (`gates.ts:521`) now runs before the fingerprint check, so a stale-fingerprint caller creates `decisions/<gate-id>/` before being rejected.

### 12. LOW — Untracked `AGENTS.md` at the repository root is unaccounted for

`AGENTS.md` is byte-identical to `CLAUDE.md` (104 lines each), untracked, not git-ignored, and appears in neither the Phase 14 Files table nor the implementation log. It will be swept into the phase commit as an undiscussed addition. Either make it a deliberate, documented Codex-facing instruction file (with a stated sync obligation against `CLAUDE.md`), or remove it before committing.

### 13. INFORMATIONAL — `revert-edit` is untested end to end

Criterion 5 and the Verification Steps ask for "`revert-edit` resolving through the same-step retry." Only the decision-table effect is asserted (`test/unit/state-gates.test.ts:61`, `effect: "retry"`). Nothing exercises the actual sequence: `constitution-edit` opening at `adjudicate`/`running`, a `revert-edit` closure leaving state at `adjudicate`/`running` with `open_gate` cleared, and the subsequent `running → failed → running` retry at `attempt + 1`. The mechanism is pre-existing so the risk is low, but the design chose this gate placement *specifically* because it needs no new machinery — which is a claim worth one test.

### 14. INFORMATIONAL — `git-constitution-head` bypasses the `git.ts` operation-constant convention

`src/state/constitution.ts:196-199` inlines `operation: "git-constitution-head" as RepositoryOperationContext["operation"]` for a raw `rev-parse --verify HEAD^{commit}`, while every other git operation label is a module-level `as SafeCode` constant in `src/repository/git.ts` (`TREE_LIST_OPERATION`, `TREE_DIFF_OPERATION`, …). A `rev-parse HEAD` reader belongs beside `readCommitTreeEntries`/`readCommitRangeChangedPaths`, with its operation constant declared next to theirs.

## Triage

Triaged 2026-07-30. Ten findings were accepted and fixed, three were accepted in part or as documentation, and one was rejected. The accepted work stayed inside the approved Phase 14 operating envelope.

| # | Disposition | Resolution |
|---|-------------|------------|
| 1 | **Accepted — fixed** | `validateResultInstallationBinding` now requires an `archflow_state` evidence installation to carry an evidence artifact and requires its canonical wrapper digest to equal the retained manifest source artifact. An evidence result can no longer ride an artifact-less or differently bound state request. |
| 2 | **Accepted — fixed** | Added focused negative coverage for missing/different request artifacts, wrong tool/source and step/source mappings, non-success boundaries, unnamed references, and all six classified task/repository/state/target mismatch codes. Rejections write no receipt. |
| 3 | **Accepted — fixed** | Malformed or registry-invalid adjudicator output now returns `MODEL_OUTPUT_INVALID`; a missing durable upstream approval returns classified `STATE_INVALID` with `upstream-approval-missing`. Both stop before minting, dispatch continuation, or state movement. Programmer-only callback/binding invariants remain throws. |
| 4 | **Accepted in part — tests and documentation fixed** | Rejected the claim that a succeeded evidence checkpoint may omit its result reference: REQ-08/11/21 require that durable result at the succeeded evidence boundary, and “permit” did not make the reference optional. Accepted the missing regression coverage. Both continuation adoption and revision-0 initial import now reject an old per-step attempt reset as `TRANSITION_INVALID`; the initial path also proves no state or receipt is written. The log records the result-reference requirement. |
| 5 | **Accepted — fixed** | Completed enactment replay still validates the exact landing state and server-recomputed fingerprint at `opened_at_revision + 1`; after later durable revisions it recognizes the immutable bound archive and returns the recorded outcome. Added replay coverage after retried production advances. |
| 6 | **Accepted as interface documentation; rejected as a code defect** | The strict predecessor guard is deliberate: it prevents a human decision from enacting an illegal transition. Phase 14 publishes retry-effect adjudication gates only at `adjudicate/succeeded`; `attempts-exhausted` may also be at `triage/succeeded`. Phase 15 must preserve that placement, and violations remain `STATE_INVALID` without archival. This constraint is now explicit in the implementation log. |
| 7 | **Accepted — fixed** | Removed the duplicated inline waiver logic. Gate satisfaction now calls the single exported `waiverInForce`, which accepts an exact tuple only while `state.terminal === undefined`; both `complete` and `abandoned` tasks reject the waiver. |
| 8 | **Accepted — fixed** | Added an executed two-upstream flow using the real corpus outputs: select/open the first sorted material gate, resolve `amend-upstream`, re-adjudicate, select/open the second gate, resolve `revise-current`, and verify server-derived re-entry. The different decisions are no longer fixture metadata alone. |
| 9 | **Accepted as an intentional contract amendment — documented** | Kept `CurrentReviewSet.reviews` as server-reconstructed verified references. The retained-manifest loader has stronger canonical provenance but no caller-authored `AuthorityLink`; the private collection brand authenticates assembly. The caller-driven `authorityQualifier.currentReviews` path still requires qualified evidence. The rationale is now recorded in code and the phase log. |
| 10 | **Accepted — fixed** | `state-request.test.ts` now exhaustively exercises all seven artifact kinds, including `record-self-review` and `record-triage`. |
| 11 | **Accepted — fixed in substance** | Non-enacted archived replays again compare the caller fingerprint to durable current state. Enacted retry replay retains the necessary post-transition exception. Moving decision-directory creation was cosmetic and was not changed. |
| 12 | **Rejected — unrelated user-owned file** | Root `AGENTS.md` predates and is outside the Phase 14 file set. It will not be staged or committed by this phase; deleting or adopting it would exceed the requested scope. |
| 13 | **Accepted — fixed** | Added the actual `constitution-edit` `revert-edit` sequence: closure is non-advancing and clears the gate, followed by the existing `running → failed → running` retry at `attempt + 1`. |
| 14 | **Accepted — fixed** | Added repository-owned `readHeadCommit` with `HEAD_COMMIT_OPERATION`; constitution edit detection uses it, with a repository-boundary test. |

---

## Recommended disposition

- **Fix before commit**: 1 (with 2 as its regression test). These are one defect and its missing guard test, and they sit on the phase's own headline retention route.
- **Fix before commit, cheap**: 12 (decide `AGENTS.md`), 7 (delete one of the two waiver predicates and align the terminal test with the pin).
- **Fix or explicitly record as a deviation**: 3, 4, 5, 6, 9. Each is either a behaviour narrower/wider than a pinned decision or an undocumented contract change; the phase's own hard rule is that the plan must reflect reality.
- **Test debt, defensible to carry with a note**: 8, 10, 13.
- **Cleanup**: 11, 14.

Nothing here blocks the phase's central claim: the disk-backed two-rewrite fixed point, restart reload, pinned-constitution authority, fail-closed mechanism policy, and gate-enacted re-entry all work and are genuinely proven against real state on disk.
