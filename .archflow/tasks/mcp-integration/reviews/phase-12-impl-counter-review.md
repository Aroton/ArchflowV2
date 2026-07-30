# Phase 12 Implementation Counter-Review

**Task**: mcp-integration
**Phase**: 12 — Durable Gates, Waivers, and Manual Decisions
**Reviewer**: Claude Opus 5 (cross-client counter-review of an uncommitted implementation)
**Date**: 2026-07-30
**Scope**: the uncommitted working tree against the phase design's Files table, `architecture.md`, and `.archflow/context/{architecture,patterns,dependencies}.md`

---

## Verdict

**Request changes.** Three findings require code changes before Phase 12 is marked COMPLETE: one durable-state availability defect (Finding 1), one human-trust-boundary interface defect (Finding 2), and one test-determinism defect in the phase's own new crash suite (Finding 3). No finding is a trust-boundary *soundness* failure — I found no path that fabricates an approval, appends a second `ApprovalRef` for one gate ID, admits a non-advancing decision to `approvals`/`waivers`, or resolves a gate twice. The kernel closure, the effect matrix, the waiver origin binding, the restore-collision applications, and the crash/two-process boundaries all hold up under inspection and under the delivered tests.

### Verification independently reproduced

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run test:contracts` | 453/453 pass (16 files) |
| `npm run build:temp` | clean |
| `npm test` (isolated repeat runs) | 1327/1330 — the only stable failures are the three inherited `test/integration/release-offline.test.ts` cases; assertion set unchanged |
| `npm test` / `npm run check` (5 full runs) | **non-deterministic**: 3 of 5 runs added extra failures, including two different cases in the new `test/crash/state-gate-lifecycle-phase12.test.ts` — see Finding 3 |
| `npx vitest run test/{crash,integration}/state-gate-lifecycle-phase12.test.ts test/integration/state-transaction.test.ts` ×3 | 40/40 pass every time in isolation |

---

## Finding 1 — A missing `gate.json` makes an open gate unresolvable through the human's own interface

**Severity: MAJOR** (durable availability; not a soundness failure)

**What the design pins.** Gate Identity and File Contracts, `gate.json` row: *"An interface, never authority — losing it re-raises `SUPPLEMENTAL_REVIEW_REQUIRED`, which is the safe direction."* The interface is a human-facing file that lives in the task directory precisely so a person in a second terminal can read it.

**What the implementation does.** Every path that can resolve a live gate from a human-written `gate.decision` hard-fails when `gate.json` is absent or unparseable:

- `src/state/gates.ts:667-670` — `runDurableGate` reads `gate.json` purely as a guard and returns `STATE_INVALID/active-gate-interface-invalid` when it is missing. The value read into `active` is never used afterwards; the ledger is re-read independently on the next line.
- `src/state/gates.ts:622-623` and `src/state/gates.ts:300-310` — `resolveDurableGate` obtains its ledger from `currentSupplementalLedger`, which returns `undefined` on a missing/invalid `gate.json`; the caller converts that to `STATE_INVALID`.
- `src/state/gates.ts:711-712` — `resolveAdvancingGate` does the same on the archive-missing branch.
- `src/state/gates.ts:368-406` — the open body never republishes `gate.json` when it resumes a gate that `open_gate` already names; it returns at line 406 without touching the interface.

Because `open_gate` freezes every other transition (`src/state/transitions.ts:82`), the task cannot move at all in that state.

**Failure scenario (reproduced).** Open an `artifact-approval` gate; delete `gate.json` (human cleanup, an editor's swap-file dance, a stray `git clean`, an interrupted sync); write a fully valid, correctly bound `gate.decision`. Observed on the current tree:

```
runDurableGate:     STATE_INVALID / {"issue_code":"active-gate-interface-invalid"}
resolveDurableGate: STATE_INVALID / {"issue_code":"active-gate-interface-invalid"}
open_gate still set: true
archive exists:      false
```

Every retry returns the same non-retryable classification. The only in-band recovery is for someone to hand-author `decisions/<gate-id>/decision.json` — an internal archive root with no helper behind it until Phase 15 — which then does resolve, because the archive branches (`gates.ts:590-614`, `gates.ts:704-718`) do not consult `gate.json`. So a lost *interface* file forces the operator into the *authority* file. That inverts the property the row pins.

**Required resolution.** Treat a missing or unparseable `gate.json` as an empty supplemental ledger rather than as a state error, in all three resolve paths; drop the unused guard read at `gates.ts:667-670`. Preferably also republish `gate.json` from the archived request in the open body when `current.open_gate.gate_id === gateId` and the interface is absent, so a resumed call restores the human's fill-in form as well as its own ability to proceed (the request archive already holds everything `activeProjection` needs). Add a regression test: delete `gate.json` under an open gate, write a valid decision, and assert the gate resolves exactly once.

---

## Finding 2 — The waiver gate publishes a fill-in template describing a shape the resolver rejects

**Severity: MAJOR** (human trust boundary — the decision cannot be authored from the published interface)

**What the design pins.** `gate.json` is *"Projection of the request plus the fill-in template"*, and the `gate.decision` row states there is **"No fourth renderer"** — *"`gate.json` carries the human-readable field list instead."* The published field list is therefore the only in-band description of what a human must write.

**What the implementation does.** `activeProjection` (`src/state/gates.ts:165-177`) emits the same template for every gate, with `required_fields: ["payload", "human_provenance"]`. That tuple is not merely a default: it is frozen into the type (`src/contracts/durable-gate.ts:86`, `readonly ["payload", "human_provenance"]`) and into the normative schema (`src/contracts/schemas/v1/active-gate.schema.json:53`, `prefixItems` of two `const`s with `items: false`, `minItems`/`maxItems` 2). A waiver gate therefore cannot express its own required fields.

But for a waiver gate the resolver requires an entirely different shape. `parseInterface` (`src/state/gates.ts:221-225`) demands `{granted, scope, origin, notes, human_provenance}` bound to the archived `WaiverOriginRef`, and `bindEnvelope` (`src/state/gates.ts:196-198`) throws `"waiver gate requires a waiver decision"` the moment a `payload`-shaped envelope is seen. A human who follows the published template on a waiver gate produces a file that can never resolve, and the interface never names `granted`, `scope`, `origin`, or `notes` anywhere.

The same gap applies, less severely, to the cancellation shape (`{cancelled: true, reason, …}`, `gates.ts:216-219`), which every gate kind accepts and no gate kind advertises. The design pins explicit cancellation as *"a human act, so its producer is this file"* — an act the human cannot discover without reading `gates.ts`.

**Failure scenario.** REQ-40's waiver path: `waiver-requested` closes the origin gate, `archflow_waiver` opens the sole waiver gate, and the human opens `gate.json` in a second terminal. It says to write `payload` and `human_provenance`. Doing so yields `GATE_DECISION_INVALID/decision-binding-invalid` with no indication of the correct shape; the gate stays pending and the task stays frozen until someone reads the server source.

**Required resolution.** Make the template kind-aware: when the archived request carries a waiver context, `required_fields` must name `granted`, `scope`, `origin`, `notes`, `human_provenance`. Widen `GateDecisionTemplateV1.required_fields` and the `active-gate` schema's `prefixItems`/`maxItems` accordingly (both currently forbid it), and advertise the cancellation escape shape on every kind. Extend the waiver integration case to assert the published template names the fields `parseInterface` actually requires.

*Note:* the design reserved *"whether the `gate.json` template is actually fillable by a human … without reading the source"* to human judgement. The waiver arm is not a judgement call — the published field list is demonstrably wrong for that gate, so it is reported here rather than deferred.

---

## Finding 3 — The new crash suite is non-deterministic under the repository's own gate command

**Severity: MAJOR** (the phase's verification claim is not reproducible)

**What is wrong.** `test/crash/state-gate-lifecycle-phase12.test.ts` budgets 10 s per IPC event internally (`event(child, type, timeoutMs = 10_000)`, line 84) and spawns real Node children, real `git`, real `SIGKILL`s, and a lock-repair pass per case — while inheriting Vitest's default 5 s per-test timeout (`vitest.config.ts` sets no `testTimeout`). The internal budget therefore exceeds the enclosing budget by construction, and under full-suite worker contention individual cases lose the race.

**Observed.** Across five full runs of `npm test` / `npm run check`, three runs failed extra cases beyond the three inherited `release-offline` failures, including two different cases from this new suite:

- `serializes conflicting resolves and appends one approval`
- `resumes exactly once after real SIGKILL at resolve cut state-resolved`

The same file passes 3/3 when run in isolation. The design's Verification Steps require confirming that only the three inherited failures remain — a check this suite makes unreproducible.

**Required resolution.** Give the new crash cases an explicit timeout at or above their internal 10 s event budget (a per-`it` timeout argument, as `test/unit/state-gates.test.ts:128` already does, or a suite-level `testTimeout`).

*Out of scope but same root cause:* `test/crash/state-transaction.test.ts` and `test/integration/state-transaction.test.ts` (Phase 9/11) exhibit identical load-dependent timeouts; I reproduced one with the new suite excluded entirely, so those are inherited, not introduced. Fixing them is not Phase 12's work — but do not attribute their intermittent failures to this phase either.

---

## Non-blocking observations (no change required to approve)

These are recorded for the implementation log and for Phase 13's consumer, not as gates.

1. **Supplemental de-duplication uses the derived ledger, not `gate.json`'s.** The design pins *"A gate-counter review is surfaced only when its evidence digest is absent from `gate.json`'s ledger — that projection is a de-duplication filter here, not authority."* `currentSupplementalLedger` (`gates.ts:313`) keeps only entries deep-equal to the caller's `supplemental_outcome` — so the de-dup set (`gates.ts:671-674`) is empty whenever the caller omits the field, and an already-triaged review re-raises. It is the safe direction and the caller must re-assert to proceed anyway, so nothing strands; but it costs an extra round trip on any resume that drops the field, and it means an archived closure can never carry more than the single currently-asserted entry even though `SupplementalLedger` is a list. Worth one sentence in the implementation log so Phase 13 knows the field must be replayed on every retry.
2. **`resolveDurableGate` archives an advancing closure and then refuses it** (`gates.ts:628-632`, `gate-success-requires-run-service`). Correct under `runDurableGate`, which re-enters via `resolveAdvancingGate`, and it preserves archive-before-receipt ordering — but a direct caller of the exported function gets a written archive plus a `STATE_INVALID`. Worth a comment on the export, or a narrower error.
3. **`resolveAdvancingGate:720`** labels any replayed non-`decided` record `effect: "advance"`. Only reachable for `waiver-decided`+granted today, but a `cancelled`/`superseded` record routed here would be mislabelled.
4. **Replayed cancellation shape differs by path.** `resolveDurableGate:594` returns `ok` for an archived `cancelled` record once `open_gate` is cleared, while the live path (`:613`) returns `GATE_CANCELLED`. `runDurableGate` normalises its own replay branch (`:656`); a direct caller sees both shapes.
5. **`open_gate` is written from freshly derived values, not from the adopted archive.** `gates.ts:448` computes `openState` before the `created === "exists"` branch at `:458-463` swaps in the existing request. Unreachable in practice (gate ID binds `request_digest`, which binds `kind`, `subject_digest`, and `context`), but the two could disagree if that ever stopped holding.
6. **`importGateDecisions` stamps `state.revision + 1`** as `resolved_at_revision`/`granted_at_revision` (`gates.ts:816`), which need not be the revision `planCheckpointAdoption` actually lands on.
7. **Coverage gap:** the Verification Steps call for proving that *"a leftover `gate.decision` from a resolved gate must be recognised as another gate's and removed rather than adopted."* The preserve direction is covered (crash suite, *preserves a decision written after gate publication…*), and the removal logic exists (`gates.ts:464-475`), but I found no test asserting the removal.

---

## What I checked and found sound

Recorded so the human gate knows the review was not narrow.

- **Kernel closure.** `assertPreserved` (`transaction.ts:267-276`) now routes any `open_gate`/`approvals`/`waivers` difference through `assertInternalCheckpointAdoptionPlan`; the three new `state-transaction.test.ts` cases prove each field. The previously-missing `transitions.ts` open-gate movement freeze now has its test.
- **Effect matrix.** `nextStateForRecord` appends an `ApprovalRef` only for `outcome:"decided"` with `gateDecisionEffect === "advance"`, and a `WaiverRef` only for `waiver-decided`; `earnsReceipt` gates the receipt identically. `state-gates.test.ts` exercises all 14 decision arms against the classifier and asserts no non-advancing arm reaches either set.
- **Waiver origin binding.** `authenticateWaiverOrigin` (`gates.ts:253-270`) re-reads both archived origin documents, requires `validateDurableSemantics` agreement, the exact `origin_decision_digest`, a `waiver-requested` payload, and deep equality of rule and scope; the fabricated-origin test proves a self-consistent forgery is rejected and no state moves. `WaiverRef.scope` is written only after deep-equalling the archived origin.
- **Exactly-once resolution.** `createExclusive` on `decisions/<gate-id>/decision.json` is the filesystem property; `atomic.ts` admits only `decision` to it and only `gate-interface` to `replace`/`removeGateInterface`. Two-process tests show the loser writing nothing and reporting a classified failure, with the design's honesty caveat about lock-acquisition versus `STATE_CONFLICT` respected (`IO_ERROR` asserted, not assumed).
- **Crash cuts.** All five design-named cuts are covered with real `SIGKILL` plus lock repair, including the two decision-safety cuts; the "decision written after `gate.json` but before state" case preserves and resolves.
- **Contract work.** The ten `interface`→`type` conversions are exactly the ones named, and `CanonicalDocument` now accepts all three roots; the `restore-collision` `path` hole is closed by `$ref`-ing the path-claim `$def`; `supplemental_outcome` is added to `GateInput` and to the `archflow_gate` selector keys in a way that leaves `request_digest` unchanged; `computeGateId`/`computeGateContextDigest` are domain-separated and materialize their subject before hashing, per the repository's assert-then-clone rule.
- **`frozen_state_digest`.** A third `OpenGateRef` field beyond the two the design named, but it is recorded in `architecture.md` with its rationale and its digest-cycle avoidance, and it is what makes the "committed-intent injection while a gate is open" and "state tampered during the wait" rejections work. Accepted as a documented amendment rather than flagged as scope creep.
- **Restore-collision.** `discard-and-restore` re-plans through `prepareProjectionPlan` with the observed image as authenticated before, re-checks `current_generation_digest` and the rename peer, and refuses on a stale generation without any writer call; `adopt-as-new-generation` performs no worktree write; partial-rename resume and third-generation peer rejection are both covered.
- **`architecture.md`** carries all five amendments the Files table required, including the `SUPPLEMENTAL_REVIEW_REQUIRED` retryability correction and the poll-only wait replacing the notification-plus-fallback sentence at the old line 290.

---

## Recommended next step

Fix Findings 1–3, re-run `npm run check`, and confirm the failure set returns to exactly the three inherited `release-offline` cases across at least two consecutive full runs. Findings 1 and 2 are each a small, local change; Finding 3 is a timeout argument. No re-design is warranted — the phase's structure, ordering, and trust boundaries are sound.

---

## Implementation triage and resolution

**Triaged by**: Codex
**Date**: 2026-07-30
**Status**: all three major findings confirmed and resolved; awaiting renewed human verdict.

1. **Finding 1 — resolved.** A missing or invalid `gate.json` now contributes an empty supplemental ledger instead of blocking resolution. Resuming the live gate through `openDurableGate` republishes a valid interface from immutable `request.json`; a correctly bound `gate.decision` is preserved. Integration tests cover both the normal blocking service and direct non-advancing resolution after deleting `gate.json`.
2. **Finding 2 — resolved.** The active-gate contract and schema now publish kind-aware required fields. Ordinary gates advertise `payload` and `human_provenance`; waiver gates advertise `granted`, `scope`, `origin`, `notes`, and `human_provenance`; every template separately advertises the `cancelled`, `reason`, and `human_provenance` escape shape. The waiver lifecycle test asserts the published template matches the resolver.
3. **Finding 3 — resolved.** The Phase 12 process/SIGKILL suite has a 20-second per-test timeout, exceeding its internal 10-second IPC budget. The focused crash suite passes 11/11, and two consecutive full `npm test` runs each passed 1,329/1,332 tests with only the same three inherited `release-offline` failures.

Post-fix focused evidence: typecheck passed; active-gate contract/schema tests passed 206/206; lifecycle tests passed 27/27; crash tests passed 11/11; `git diff --check` passed.
