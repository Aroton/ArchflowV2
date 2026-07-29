# Phase 10 Implementation Counter-Review — Adoption, Reconciliation, and Recovery

**Task**: mcp-integration
**Reviewed**: 2026-07-29, uncommitted working tree on `feature/mcp-server` (baseline `ae0a404`)
**Reviewer**: Claude (Opus 5), fresh-context counter-review; implementation and first verification were done by a different model.

## Verification performed

- Read the phase design, `architecture.md`, and `.archflow/context/` (only this repo carries `.archflow/context/`; the sibling workspace checkouts do not).
- Read every changed and new file in the design's Files table via `git diff` / direct reads, including all untracked additions reported by `git status`.
- Ran `npm run typecheck` (clean), `npm test` (**1223 passed, 3 failed**), `npm run test:contracts` (446/446), `npm run build:temp` (clean under v24.18.0).
- Confirmed the 3 failures are exactly the inherited `test/integration/release-offline.test.ts` cases documented since Phase 6 (`validateReleaseSemantics` at `scripts/release-support.mjs:880`), unchanged in assertion text.

The substrate work is largely sound. The state anchor is a genuinely closed third branch in both Zod and JSON Schema; mixed-anchor chains fail through `checkpointLinkBreak`'s `"predecessor" in next` requirement; the adoption capability is a real WeakMap identity check that also re-derives the `next_state` digest, so a forged preparation cannot smuggle a different draft past `assertPreserved`; the revision-0 path reuses the mature kernel's CAS/replay/receipt-first/state-last shape and the crash suites prove the cuts; `observeDivergentHeads`/`planCleanHandoff` make no merge, commit, push, or exclusion claim, and the lock repair rejects symlinks, non-empty, and replaced targets with an FD-pinned inode check. The findings below are what the first verification missed.

## Findings

### 1. BLOCKER — Ordinary reconciliation reports a consistent, committed task as `receipt-invalid`

`src/state/reconciliation.ts:108` validates every supplied receipt as a **prepared** successor of the supplied state:

```ts
validateDurableSemantics(createPreparedIntentSubject(input.state, receipt)).ok
```

Rank 8a in prepared mode requires `receipt.prior_revision === state.revision` (`src/contracts/durable.ts` rejects both `>` as `intent-receipt-future-revision` and `<` as `intent-receipt-revision-not-successor`). A receipt that has **already committed** has `prior_revision === state.revision - 1`, so it fails that check and the caller receives:

- finding `{ kind: "receipt-invalid", next_action: "inspect-retained-receipt" }`, and
- `classification: "reconciliation-required"`

for a task where nothing is wrong. The author's own discriminator on line 125 — `input.state.value.committed_intent?.receipt_digest !== receipt.digest` — shows the intent was to report `receipt-only` when the receipt is *not* referenced and nothing when it *is*; the equal case is unreachable, because validation already failed. Success criterion 7 ("reports receipt-only or projection mismatch facts") is therefore unmet: the module cannot distinguish a crashed receipt-only preparation from a normally committed one, and pushes every post-success reconciliation into the human-repair path.

`test/unit/state-reconciliation.test.ts:53-79` only covers the uncommitted receipt and two malformed ones, which is why this passed first verification.

**Resolution**: select the relation by the state's own binding — when `state.committed_intent?.receipt_digest === receipt.digest`, validate with `createCommittedIntentSubject` and emit no finding; otherwise keep `createPreparedIntentSubject` and the existing `receipt-only` branch. Add the committed-receipt case to the unit test alongside the receipt-only case.

### 2. BLOCKER — Initial checkpoint-chain adoption never validates workflow-transition legality

Design item 4 puts "direct initial imports" inside the adoption planner, and success criterion 6 requires that "workflow transitions reject illegal lifecycle movement … before any durable commit."

`src/state/checkpoints.ts:111-128` does exactly that for the state-anchored and continuation paths: it walks the selected chain and runs `planStateTransition` for every link. The initial path in `src/state/initialization.ts:113-159` does not. `initialState` selects the chain, checks only that the **head** matches the call's `phase_instance`/`step`/`status`/`input_fingerprint`, and then copies the head's fields straight into revision 1. Nothing between consecutive checkpoints is checked for lifecycle legality — `selectGreatestValidChain`, `checkpointSelfBreak`, `checkpointLinkBreak`, and durable ranks 5c–5t all constrain identity, revision arithmetic, digests, and initialization, never `(phase_instance, step, status, attempt)` movement.

Concretely, an initial import chain of `[rev 1: prd/produce/succeeded, rev 2: phase-impl-9/adjudicate/failed]` links correctly, passes every rank, and initializes the task directly into `phase-impl-9/adjudicate/failed` — a lifecycle jump the mature path would reject. The design's verification step explicitly calls for "an initial multi-checkpoint adoption," and neither `test/unit/state-initialization.test.ts` (single direct initialization only) nor `test/crash/state-initialization.test.ts` exercises a multi-checkpoint initial chain at all.

**Resolution**: in `initialState`, after chain selection, seed a cursor from the first checkpoint and run the same `planStateTransition` walk `planCheckpointAdoption` uses for links 2..n, failing closed on the first illegal move. Add an initial multi-checkpoint adoption test plus a rejected illegal-jump case.

### 3. MAJOR — The rank 8a adoption exemption is unbounded, and nothing re-derives `adopted_checkpoint` from the bound artifact on the retained-receipt path

`src/contracts/durable.ts:769-774` turns the adopted-checkpoint equality off entirely whenever `receipt.operation === "adopt-manual-checkpoint-import"`:

```ts
if (receipt.operation !== "adopt-manual-checkpoint-import" &&
    !isDeepStrictEqual(prepared.adopted_checkpoint, intentState.adopted_checkpoint)) { … }
```

On the *preparation* path this is compensated: `buildPlan` forces `assertInternalCheckpointAdoptionPlan` plus the operation check (`src/state/transaction.ts:413-419`), so only a planner-minted draft can change the head. On the *resume* path it is not. `handleExisting` (`src/state/transaction.ts:561-614`) re-reads a retained receipt, validates identity and `validatePreparedAndCommitted`, then installs `committedState(receipt)` **without ever consulting the planner or the artifact's chain**. For an adoption receipt, `prepared_state.adopted_checkpoint` is therefore accepted verbatim: no rank, and no kernel check, ties it to the head of the chain the request digest binds. Every other pinned field (`initialization_digest`, `config_digest`, `workflow_digest`, `constitution_digest`, `policy_base_commit`, task/repository identity) is still compared, so this is the one field with no authority behind it on resume.

That is the specific property the design's verification step asks to be proven ("adoption authority cannot change any other pinned field" — and, by symmetry, that the adopted checkpoint it *can* change is the validated one). It is untested; there is no test that re-reads an adoption receipt through the consolidated validator at all.

**Resolution**: in the adoption branch, replace the blanket exemption with a derived check — require `prepared.adopted_checkpoint` to equal `{revision, checkpoint_digest}` of the head of the receipt-bound import chain (reachable through the subject when the artifact is supplied), or add the equivalent check in `handleExisting` before `installPlan` when `operationFor(request.call) === "adopt-manual-checkpoint-import"`. Add the retained-adoption-receipt re-read test the design's verification step names.

### 4. MAJOR — `durable-handoff.ts` adds a Zod mirror for a server-authored record, against the established D2 pattern and the design's own wording

The Files table says `handoff-record.schema.json` provides "the **sole normative** JSON Schema for the server-authored handoff record." `HandoffRecordV1` never crosses the MCP tool boundary — nothing parses untrusted input into it; `planCleanHandoff` constructs it from already-authenticated material. The two existing precedents for exactly that situation carry **no** Zod schema: `src/contracts/durable-intent.ts` parses through `intentReceiptV1Validator` only, and `src/contracts/durable-maintenance.ts` declares no schema and no parser at all. `src/contracts/durable-state.ts:9-18` states the rule directly ("This module declares no Zod schema (D2), and it must not … there is no untrusted-input parse boundary for a mirror to guard").

`src/contracts/durable-handoff.ts:35-56` nevertheless defines `preservedHandoffHeadV1Schema`, `cleanHandoffPositionV1Schema`, and the exported `handoffRecordV1Schema`. `parseHandoffRecord` does not use them; the only consumer is `test/unit/durable-handoff.test.ts`, which tests the mirror against itself. This creates a second shape authority that can silently drift from the normative schema, for no requirement.

**Resolution**: delete the three Zod schemas and their `zod` import, keep `parseHandoffRecord` on `handoffRecordV1Validator`, and rewrite the agreement assertions in `test/unit/durable-handoff.test.ts` against the JSON Schema validator (the pattern `durable-intent` already uses). If the mirror is intended to stay, the design and `durable-state.ts`'s D2 note must be amended to say why this record is the exception.

### 5. MAJOR — A validating keyword was added to the advertised-schema closure with zero runtime-semantic coverage

Enabling the artifact union pulls nine durable schema documents into `ADVERTISED_TOOL_CATALOGUE`'s `$defs` closure (`src/mcp/tools.ts:39-48`). `test/contracts/mcp-advertised-schema.test.ts:276` requires every `x-archflow-*` keyword found in that source closure to be declared, so `x-archflow-sorted-unique-by` had to be added — and it was added with an **empty** coverage array (`:107`).

That array is the mechanism by which the test proves each validating keyword *stripped from the portable advertised schema* is still enforced at runtime: `expectedRuntimeSemanticCategories` (`:129`) is built from these lists, and an empty list demands nothing. `x-archflow-sorted-unique-by` is a genuine validating keyword (compiled at `src/contracts/validators.ts:262`) and it is stripped from the advertised schema (asserted at `:287`). It now guards real branches reachable from `archflow_state` input — e.g. `manual-checkpoint.schema.json:48,53,58,63,68` over `authoritative_results`, `projections`, `evidence_chain`, `approvals`, `waivers`. So the advertised schema accepts an import with unsorted/duplicated `authoritative_results` while the Zod boundary rejects it, and nothing proves the second half. Every other keyword in that table has at least one corpus case; this is the first exemption.

**Resolution**: add a runtime-semantic corpus case (e.g. `checkpoint-sorted-unique-by`: an `archflow_state` input whose artifact chain carries an unsorted `authoritative_results`), list it under `x-archflow-sorted-unique-by`, and materialize it in `materialize()`. If the exemption is deliberate, assert non-emptiness explicitly with a recorded reason rather than leaving a silent `[]`.

### 6. MAJOR — Two success-criterion behaviours and one design-named verification have no test

The code paths look correct, but the design names these explicitly and none is exercised:

- **Changed-artifact `INTENT_MISMATCH`** (success criterion 2: "same-intent reuse with changed artifact bytes returns `INTENT_MISMATCH` rather than replaying prior success"; verification step: "exact and changed-artifact initialization retries", "same-intent checkpoint-chain substitution"). The only `INTENT_MISMATCH` assertion in the tree is `test/unit/state-transaction.test.ts:409`, a Phase 9 non-artifact case. `test/unit/state-initialization.test.ts` proves the *exact* replay but never mutates the artifact; nothing covers chain substitution under a reused intent.
- **Handoff-record collision** (work-breakdown item 7: "Pin … handoff collisions in unit and real-process tests"). `installHandoffRecord` (`src/repository/handoff.ts:201-208`) is never called by any test, so neither the `maintenance-record` path-class guard nor the `"exists"` collision result is exercised — even though `src/state/atomic.ts:50` was widened specifically to admit that path class.
- **Lock remains blocking** (success criterion 9: "remains blocking until an explicit, separately human-confirmed repair"). The crash suites assert the lock directory *exists* after SIGKILL and that repair then succeeds, but never assert that an ordinary `runExclusive` acquisition fails while it is present.

**Resolution**: add (a) a changed-artifact retry against `runStateInitialization` and a substituted-chain retry against the adoption path, both asserting `INTENT_MISMATCH`; (b) an `installHandoffRecord` test covering `created` then `exists` on the same resolved `maintenance-record` path, plus rejection of a non-maintenance path class; (c) a blocked-acquisition assertion in `test/crash/state-initialization.test.ts` between the SIGKILL and the confirmed repair.

## Explicitly checked and not findings

- **Revision-0 live identity / policy base**: `expected_revision` admits `0` (`mcp-tools.ts:31` is `nonnegative()`, primitives `safeInteger` minimum 0), canonical paths are compared field-by-field, and each baseline/policy commit is peeled with `rev-parse --verify --quiet <oid>^{commit}` and compared to the claimed oid, so a blob or tag fails. Live workflow/constitution/config pins are validated transitively through `resolve_input_fingerprint`, which compares them against the *prepared* revision-1 state. The documented legacy-source limitation is recorded in-code.
- **Artifact-aware identity**: the operation literal is selected by `artifact_kind` in three places that agree, `closedOperationFields` cross-checks the pair and throws on a forged combination, and the digest is taken from the already-parsed, cloned, deep-frozen call input.
- **Checkpoint independence**: state and checkpoint revisions are decoupled correctly; `chainHeadBreak`/`checkpointLinkBreak` reject wrong-state, forked, gapped, foreign, and mixed-anchor chains; rank 5s requires no adopted checkpoint for `state-anchored` and the exact one for `continuation`.
- **Adoption capability**: not forgeable — `assertInternalCheckpointAdoptionPlan` requires WeakMap membership *and* a matching canonical digest of the own-enumerable `next_state`, and `buildPlan` additionally requires the adoption operation.
- **Lock quarantine**: rename-then-verify-then-`rmdir` with an O_NOFOLLOW directory FD pinning dev/ino across the rename; a failed verification deliberately leaves the quarantined object rather than deleting it, and never clobbers a newly created lock.
- **Git recovery**: `readHistoryStatus`/`classifyMutationReadiness` keep conflicts and in-progress operations blocking (the integration test proves `GIT_CONFLICT` on the same divergent heads), and the record binds both heads, the common checkpoint, the human selection, and the later clean position with no synchronization claim.
- Not treated as findings: `paths.ts`/`layout.ts`/`read.ts` appear in the Files table but needed no change; `MAX_RECEIPT_BYTES` is not enforced on the revision-0 path (bounded by state size, no correctness impact); the unreachable tail `return` in `transitions.ts:121`.

## Triage

### Finding 1 — Accepted

Reconciliation must select the committed or prepared semantic relation from the state's exact receipt binding. A state-authenticated committed receipt is consistent and emits no finding; only an unreferenced validating prepared receipt is classified as `receipt-only`.

### Finding 2 — Accepted

Initial multi-checkpoint adoption must enforce the same fixed-workflow lifecycle legality as mature adoption. The initialization path will validate every link after the initialization checkpoint before constructing revision 1, with valid multi-checkpoint and illegal-jump coverage.

### Finding 3 — Accepted

The operation literal alone is not enough authority on retained-receipt resume. The resume path will derive the expected adopted checkpoint from the request-digest-bound import artifact and require exact agreement with the retained prepared state before installing it.

### Finding 4 — Accepted

The server-authored handoff record follows the existing unmirrored durable-root rule. Its JSON Schema validator remains the sole shape authority; the unused Zod mirror will be removed and tests will exercise the normative validator directly.

### Finding 5 — Accepted

`x-archflow-sorted-unique-by` is validating behavior and cannot have an empty advertised-schema runtime coverage exemption. A reachable state-artifact corpus case will prove the stripped portable schema remains enforced by the runtime boundary.

### Finding 6 — Accepted

Each behavior is named by the approved success criteria or verification plan. Tests will cover changed initialization and substituted checkpoint artifacts returning `INTENT_MISMATCH`, handoff record creation/collision/path-class rejection, and ordinary lock acquisition remaining blocked before explicit confirmed repair.
