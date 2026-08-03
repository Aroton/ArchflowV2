# Phase 18 Implementation Counter-Review

Scope: uncommitted diff against `72023f7`, limited to the Files table of
`phases/phase-18-manual-and-degraded-recovery-workflow.md`. `npm run typecheck` passes.
`npm test` fails (see finding 3).

Blocker and major findings follow. Each must be resolved before approval.

---

## 1. Blocker — Two incompatible "current manual state" shapes make an open gate on top of existing state unresolvable

`checkpointState` returns a *different* state depending on whether a manual checkpoint already
exists:

- `src/state/manual-checkpoints.ts:87` — with `state` and **no** head it returns
  `authority.state.value` verbatim, still carrying `adopted_checkpoint`, `committed_intent`,
  `terminal`, and the **state** revision.
- `src/state/manual-checkpoints.ts:88-105` — with `state` **and** a head it strips
  `committed_intent`, `adopted_checkpoint`, `open_gate`, `terminal` and substitutes
  `revision: head.revision`.

The gate-open milestone freezes the first shape:
`src/state/manual-checkpoints.ts:298` computes
`openGateFrozenStateDigest({ ...current, revision, open_gate: undefined })`.
Once that checkpoint is installed it becomes the head, so every later materialization goes through
the second shape. `openGateFrozenStateDigest` (`src/contracts/durable.ts:97`) hashes the whole state
shell, so the recomputed digest cannot match.

Failure scenario (server dies while `state.json` exists, first degraded milestone opens a gate):

1. `manual-next {operation:"gate", action:{kind:"publish", …}}` succeeds and installs a checkpoint
   whose `open_gate.frozen_state_digest` was hashed over a state containing `adopted_checkpoint`
   (or `committed_intent`) and the state-space revision.
2. Any subsequent `manual-status` / `manual-next` materializes the head through the stripped shape.
   `validateDurableSemantics` rejects it at `src/contracts/durable.ts:469`, so
   `loadAuthenticatedManualGateFacts` fails at `src/state/gates.ts:1638-1639` and
   `advanceManualGate` fails at `src/state/gates.ts:2067-2068` with
   `manual-gate-state-authority-invalid`.
3. Status is permanently `repair-required`, and recovery by import is also refused because the head
   carries an unresolved gate (`src/state/manual-import.ts:211-213`). The chain is bricked with no
   safe action.

A second, independent break in the same area: for a continuation authority anchored on
`state.adopted_checkpoint` with no installed checkpoint yet, `advanceManualGate` derives
`opened_at_revision = state.revision + 1` (`src/state/gates.ts:1993`) from the *state* revision,
while `buildNextManualCheckpoint` numbers the checkpoint `predecessor.revision + 1`
(`src/state/manual-checkpoints.ts:222`) in the *checkpoint* revision space. Those disagree after any
prior import (state 6 / adopted checkpoint 3 → 7 vs 4), so the publish is rejected outright at
`src/state/manual-checkpoints.ts:295-296` (`manual-gate-open-transition-invalid`). The first manual
gate after any recovery import is therefore impossible.

A third instance: `runManualNext` installs `value.result` before the milestone switch
(`src/local/manual-workflow.ts:803-844`), so a `gate` operation carrying a result freezes a digest
over pre-install `authoritative_results` while the checkpoint records the merged set
(`src/state/manual-checkpoints.ts:265-268`) — same unrecoverable mismatch.

**Required resolution.** Derive one canonical current-manual-state projection and use it for both
the gate lifecycle and the checkpoint builder, so the frozen digest is computed over exactly the
state that materializing the resulting checkpoint reproduces: identical field stripping, identical
revision space, and post-installation `authoritative_results`. Reject a milestone that mixes result
installation with gate opening, or fold the installed references in before freezing. Add unit
coverage that opens *and then resolves* a gate for all three authority kinds
(`initial`, `state-anchored`, `continuation`), including continuation anchored on
`state.adopted_checkpoint`.

---

## 2. Blocker — Derived `planned_final_phase` is discarded whenever `state.json` exists, and the derivation itself runs against a state that omits it

`loadManualAuthority` derives the approved final phase from the authenticated chain at
`src/local/manual-workflow.ts:241-271` and stores it in the authority facts (`:267`). But
`checkpointState` applies `authority.planned_final_phase` only in the state-absent branch
(`src/state/manual-checkpoints.ts:131`); the state-present branches
(`src/state/manual-checkpoints.ts:87`, `:88-105`) carry `planned_final_phase` from `state.json`
alone.

Failure scenario (mixed recovery — the task was imported into state before design approval, then
the server became unavailable and the design approval was archived and checkpointed manually):

- `state.planned_final_phase` is absent, the chain-derived value is computed and then thrown away.
- `planStateTransition`'s `completesFinalPhase` requires `current.planned_final_phase !== undefined`
  (`src/state/transitions.ts:227-235`), so `operation: "terminal"` can never succeed — terminal
  completion is unreachable.
- The over-run guard at `src/state/manual-checkpoints.ts:276-278`
  (`manual-final-phase-must-complete`) is likewise never armed, so manual mode silently advances
  past the planned final phase.

Separately, the derivation at `src/local/manual-workflow.ts:249` calls
`materializeManualAuthorityState(capability)` *before* the facts are updated with the derived value.
In the pure-manual path this means that once `planned_final_phase` is known, any gate opened
afterwards freezes a digest containing it, while the next load recomputes the digest without it —
producing the same unrecoverable `manual-gate-state-authority-invalid` as finding 1. Because
commit-authorization gates are opened after design approval, this is on the headline
"multi-phase pure-manual completion" path.

**Required resolution.** Resolve `planned_final_phase` once, before any state is materialized, from
`state.json` or the authenticated chain (whichever is present, chain winning when both exist and
agree), and apply it in every branch of `checkpointState`. Add coverage for terminal completion in a
continuation authority whose approval arrived only through the checkpoint chain, and for a manual
attempt to advance past the planned final phase.

---

## 3. Blocker — Verification is far below the phase's Verification Steps, `npm test` fails, and several Files-table deliverables are absent

Delivered coverage is three files / eight assertions:
`test/unit/local-manual-workflow-phase18.test.ts` (3 tests: fabricated gate facts, one archived gate
pair, clean handoff), `test/integration/manual-workflow-phase18.test.ts` (1 test), and
`test/contracts/skill-contract-phase18.test.ts` (3 substring assertions).

Against the phase's Verification Steps and Success Criteria, none of the following is exercised:

- State-anchored and continuation `ManualCheckpointImportV1` wrappers and their comparison with the
  real handler identification path (only the `initial` wrapper is asserted,
  `test/integration/manual-workflow-phase18.test.ts:126-138`).
- Mature-state adoption through `planCheckpointAdoption` with authenticated evidence; missing-state
  adoption is only implicitly covered.
- Any gate or waiver lifecycle end-to-end: publish → decision archive → checkpoint → import;
  supplemental ingest, rejection/resume, accepted-change supersession, decline, cancellation,
  restart.
- Commit authorization, committed-tree observation, non-final advancement, and terminal completion —
  the two paths findings 1 and 2 break.
- Retained-result task cap, stale normal state behind the head, secret rejection, already-matching
  target, and changed-target collision.
- The enumerated non-advancing rejections (fork, gap, duplicate/colliding revisions, foreign
  identity, corrupt filename/document/digest, state-anchor digest mismatch, predecessor mismatch,
  higher-looking-but-invalid inventory). Only `terminal: "abandoned"` is covered
  (`test/integration/manual-workflow-phase18.test.ts:198-215`).
- Handoff divergence: only the clean-ready case is asserted
  (`test/unit/local-manual-workflow-phase18.test.ts:163`). No divergent-history case, no
  both-heads-preserved stop, no proof that the abandoned writer cannot advance.
- Per-tool fallback validation against existing contracts — the integration test only asserts the
  `tool` echo and resume command (`test/integration/manual-workflow-phase18.test.ts:158-167`),
  not that each material is schema-valid or contains a complete resume instruction. The contract
  test pins six substrings, not "every documented fallback command/template".

`npm test` currently fails: 3 tests in `test/integration/release-offline.test.ts`, with
`Error: stale bundle input: src/local/commands.ts`. `dist/archflow-mcp.mjs`,
`dist/archflow-local.mjs`, `dist/manifest.json`, `dist/metafile.json`, `release/legal-review.json`,
`release/evidence/focused-inert-reachability.json`, `release/evidence/user-risk-acceptance.json`,
and `phases/phase-18-manual-and-degraded-recovery-workflow-log.md` are all listed in the Files table
and are all unmodified/absent.

**Required resolution.** Add the missing unit, integration, and contract coverage — at minimum the
gate/waiver lifecycle, commit authorization and terminal completion, all three import wrappers
against the handler identification path, the rejection corpus, and divergent handoff. Then rebuild
both bundles, stop at the mandatory user re-acceptance gate bound to the final MCP digest before
touching `release/evidence/user-risk-acceptance.json`, and write the implementation log. Do not
approve while `npm test` fails.

---

## 4. Major — `archflow-status` now calls `manual-status`, which cannot supply most of the facts the skill is instructed to report

`skills/archflow-status/SKILL.md:10` replaces `archflow-local status` with input-free
`archflow-local manual-status` as the sole status command for every task, including healthy
normal-mode tasks.

`ManualWorkflowStatus` (`src/local/manual-workflow.ts:409-417`) carries only
`mode`, `authority_kind`, `revision`, `phase_instance`, `step`, `status`, `next_action`. In normal
mode `classifyManualWorkflowStatus` calls `computeTaskStatus` and keeps **only** its `next_action`
(`src/local/manual-workflow.ts:460-470`); everything else in `TaskStatusV1`
(`src/state/status.ts:119-139`) is dropped — `config`, `reconciliation`, `evidence`, `open_gate`,
`blocking_reasons`, `gate_input`, `routes`, `constitution`.

The skill nonetheless still requires reporting them:

- `:12` — "verified configuration state, reconciliation state, evidence availability and
  assessment, open gate, blocking reasons".
- `:14` — "report only the expected and observed digests supplied by status".
- `:16` — open-gate kind, ID, decision path, "every ready-to-write decision template", and the
  counter-review prompt and paths.
- `:18` — "the exact supplemental outcomes status makes available for the current gate lifecycle".

None of those values exist in the response. A normal-mode task with an open gate or an unverified
config now shows a bare next-action code, and the skill's own instructions push the agent to source
the missing facts elsewhere — the exact inference the Phase 17 "truthful status" work removed.
`blocking_reasons` being dropped also means a blocked task reads as unblocked.

**Required resolution.** Either widen the normal-mode result so it carries the full `TaskStatusV1`
payload alongside `mode`/`authority_kind`, or keep `archflow-local status` as the normal-mode
reporting command and use `manual-status` only for classification and for the degraded /
repair-required branches. Update `skills/archflow-status/SKILL.md` so every field it instructs the
agent to report is a field the chosen command actually returns, and pin that correspondence in
`test/contracts/skill-contract-phase18.test.ts`.

---

## Non-blocking notes

These do not by themselves block approval, but are worth folding into the fix pass:

- `buildManualFallback` does not validate its `tool` discriminant. `runManualNext` spreads caller
  JSON straight into the input (`src/local/manual-workflow.ts:796-800`), and `:596` treats any
  value other than the four handled ones as `archflow_waiver`/`archflow_gate`, emitting a
  gate-interface for an unknown tool. Validate against the five names and reject otherwise.
- `createRetainedTaskAccountingFromBytes` (`src/state/production.ts:675-686`) has no callers, and
  `prepareRetainedStateResult` is used only by the manual workflow — the normal `archflow_state`
  handler still calls `prepareDocumentResult` / `prepareImplementationResult` /
  `prepareEvidenceResult` directly. Behaviour is identical today, but the "common seam" the design
  asked for is not actually shared.
- `let start = 0` in `reduceAuthenticatedManualChain` (`src/state/manual-import.ts:569`) is never
  reassigned.
- Pre-existing, but now in scope: `src/state/status.ts:708` compares the selected chain head
  revision against `state.revision`. After a recovery import those are different numbering spaces
  (state 6 / adopted checkpoint 3), so a pending manual chain is never reported as
  `checkpoint-import-available` in normal mode.

---

*Reviewed: 2026-08-03 — implementation counter-review, uncommitted working tree.*
