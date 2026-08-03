# Phase 17 Implementation Counter-Review

**Task**: mcp-integration
**Phase**: 17 — Normal-Mode Thin Phase Skills and Truthful Status
**Basis**: uncommitted worktree diff, scoped to the design's Files table plus the files it touched outside it
**Verification run by this review**: `npm run typecheck` (pass), `npm test` (**3 failing**), `npm run check:release` (**fail**), `npm run check:dependencies` (pass), `npm run check:notices` (pass)

Seven findings. Four blockers, three majors.

---

## BLOCKER 1 — `archflow_adjudicate` can never succeed for any phase that declares upstreams: the approval digest domain was changed on one side only

This phase moved the review/gate subject digest from "sha256 of the artifact's file bytes" to "the retained produce manifest's `artifact_digest`" (`src/state/produce-subject.ts`, `src/mcp/handlers/counter-review.ts:122`, `src/mcp/handlers/state.ts:102-108`, and hard-required by `src/state/gates.ts:1011` and `:853`). `status` follows the new domain (`src/state/status.ts:224`, `buildCommitAuthorizationInput`).

`deriveUpstreams` was not moved. It still computes `upstream_digest = sha256Bytes(<raw upstream file bytes>)` and demands an `artifact-approval` approval whose `subject_digest` equals that value (`src/mcp/handlers/adjudicate.ts:128-131`); `requireApprovedUpstreamDigests` (`src/review/fixed-point.ts:351-366`) and `runAdjudication` (`src/review/adjudication.ts:352-369`) repeat the same check. An `artifact-approval` approval now always carries the canonical-JSON artifact digest, which is never equal to the document's content digest.

Consequence: `/archflow-design` (`upstream_paths: ["prd.md"]`), `/archflow-phase-design` (`["design.md","prd.md"]`) and `/archflow-phase-impl` all get `STATE_INVALID/upstream-approval-missing` on their first adjudicate call. Only `/archflow-prd`, whose `upstream_paths` is `[]`, can complete a pipeline.

The same split also defeats the chunk‑1 check the design asked for: `currentFor`'s new adjudicate branch (`src/review/fixed-point.ts:126-133`) compares the recorded `adjudication.approved_upstream_digests` (handler-side content digests) against `subject.approved_upstream_digests`, which `computeTaskStatus.currentApprovedUpstreams` (`src/state/status.ts:196-232`) builds from retained-manifest **artifact** digests. Even if the approval lookup were satisfied, the two lists could not be equal, so `assessCurrentEvidence` could never report `advance` from status.

Nothing caught this because the only live-handler pipeline test uses `upstream_paths: []` (`test/integration/review-fixed-point-live-phase17.test.ts:239`); no test drives a real `archflow_adjudicate` with a non-empty upstream list.

**Suggested resolution**: pick the retained produce `artifact_digest` as the single upstream identity. Change `deriveUpstreams` to resolve each `upstream_paths` entry to that phase's retained produce manifest and use `manifest.artifact_digest` for both the approval lookup and `approved_upstream_digests` (keeping the file read for the envelope's `artifact` text), so it agrees with `requireApprovedUpstreamDigests`, `currentFor`, and `currentApprovedUpstreams`. Add a live-handler regression that drives adjudicate with a non-empty `upstream_paths` all the way to `assessCurrentEvidence.next === "advance"`.

---

## BLOCKER 2 — `phases/<n>/design.md` is declared as a phase-impl upstream but no gate ever approves it

`skills/archflow-phase-impl/SKILL.md:42` sends `upstream_paths: ["phases/<phase-number>/design.md","design.md"]`, and `computeTaskStatus.currentApprovedUpstreams` requires an `artifact-approval` for the `phase-design-<n>` produce result. But `skills/archflow-phase-design/SKILL.md` opens only `review-trigger` / `material-drift` / `adjudication-failure` / `attempts-exhausted` — matching the design's pinned per-skill table — so no `artifact-approval` for a phase design is ever created. `deriveNextAction.advanceAction` (`src/state/next-action.ts:88-99`) confirms it: `phase-design` requires no gate kind at all and goes straight to `advance-phase`.

Consequence, independent of Blocker 1: every `phase-impl` adjudicate call fails `upstream-approval-missing`, and `computeTaskStatus` throws inside `currentApprovedUpstreams` → `blocking_reasons: ["fixed-point-disagreement"]`, `assessment` undefined, and `next_action` degrades to `run-step "Continue the adjudicate pipeline step"` forever. `/archflow-phase-impl` therefore cannot reach its `commit-authorization` gate, so REQ-09/REQ-20 and the completion criteria are unreachable.

This also leaves CLAUDE.md's hard rule "never write code before phase-design approval" with no durable enforcement point: the phase design advances on the fixed point alone.

**Suggested resolution**: decide one of the two, and record it as an amendment in the phase document's per-skill table:
* add an `artifact-approval` gate (`artifact_kind: "phase-design"`, which the contract already admits at `src/contracts/gates.ts:32`) to `archflow-phase-design`, and add `phase-design → "artifact-approval"` to `advanceAction`'s `requiredKind`; or
* drop `phases/<n>/design.md` from the phase-impl `upstream_paths` and from `currentApprovedUpstreams`'s `phase-impl` bindings.
The first preserves the hard rule and the REQ-13 upstream binding; the second does not.

---

## BLOCKER 3 — `npm test` and `npm run check:release` fail; the release payload was never re-staged and no Phase 17 implementation log exists

`npm test`: **3 failed / 1600 passed**, all in `test/integration/release-offline.test.ts`:

```
AssertionError: risk decision bundle binding is stale: fast-uri-3-1-0-local-risk
AssertionError: Error: stale bundle input: src/contracts/durable-state.ts
```

`npm run check:release` fails identically (`stale bundle input: src/contracts/durable-state.ts`).

The design's Verification Steps require: "`src/local/`, `src/state/`, `src/review/`, and `src/mcp/` all reach the bundle, so `dist/` entry digests change: re-run `release:stage`/`release:write`, confirm `release:reproduce` reproduces byte-identically, and record the new digests in the implementation log the way the Phase 16 log does." None of that was done — `release/` is unmodified in `git status`, and `.archflow/tasks/mcp-integration/phases/` has no `phase-17-…-log.md` (CLAUDE.md: "Every completed phase writes an implementation log").

This also answers the second question put to the human: there is **no new MCP bundle digest to accept yet**. `release/evidence/user-risk-acceptance.json` declares `invalidated_by: ["bundle-change", …]`, and the bundle binding is currently stale rather than re-derived, so a re-acceptance decision has nothing to bind to.

**Suggested resolution**: run `npm run build:temp`, `release:stage`, `release:write`, confirm `release:reproduce` is byte-identical, re-run `npm test` / `check:release` to green, then write `phase-17-normal-mode-thin-phase-skills-and-truthful-status-log.md` recording the new `dist/` entry digests exactly as the Phase 16 log does. Only then present the new bundle digest for the fast-uri risk re-acceptance.

---

## BLOCKER 4 — `status` reports a healthy superseding gate as corrupt, withholding its templates and REQ-41 prompt

`activeBindsArchivedRequest` (`src/state/status.ts:157-177`) rebuilds a `GateRequestV1` from `ActiveGateV1` field by field and compares whole-document canonical digests. The reconstruction omits `GateRequestCommon.supersedes` (`src/contracts/durable-gate.ts:48`), which `activeProjection` preserves via `...structuredClone(request)` (`src/state/gates.ts:217-231`).

So for any gate opened with a `supersedes` reference — the accepted-change supersession path that `renderGateCounterPrompt` and all five skills explicitly drive — the digests differ, `requestBindingMatches` is `false`, and `computeTaskStatus` pushes `active-gate-mismatch`, omits `open_gate` entirely, and `deriveNextAction` returns `inspect-state`. The human loses the decision templates, the paths, and the counter-review prompt for a gate that is perfectly well-formed.

Two success criteria are unmet: "**Every** open gate, server-opened included, offers the REQ-41 prompt through `status`" and "`status` reports exactly one `next_action` for every reachable state". The check is also unrequested: the design pinned `activeGateHead` as the binding test ("`activeGateHead` throws when the projection does not bind its archived request → omit `heads.gate` …"), and `activeGateHead(activeGate, request)` is already called two lines above.

**Suggested resolution**: delete `activeBindsArchivedRequest` and use the `activeGateHead` call alone as the binding test, matching the pinned rule. If a stricter whole-document comparison is wanted, it must carry `supersedes` (and every future optional `GateRequestCommon` member) forward.

---

## MAJOR 5 — Post-dispatch re-observation was added to the adjudicate path, which the design excluded by name

`src/review/adjudication.ts` gained `RunAdjudicationDependencies.reobserve_projection_digest`, `RunAdjudicationInput.projection_digest`, and a post-dispatch `STATE_INVALID/adjudication-projection-not-current` check; `src/mcp/handlers/adjudicate.ts:329-345` wires a full state re-read plus manifest re-load to supply it.

The design's "Not in This Phase" is explicit: "any freshness machinery beyond the two checks chunk 1 restores — no stale-subject re-entry path, **no re-observation on any other tool path**." Chunk 1's restored check (a) is the counter-review installation path only; the design's own reasoning is that adjudicate is already covered by `handleAdjudicate`'s pre-dispatch subject re-read. This is code with no requirement behind it, on the most expensive handler path.

**Suggested resolution**: remove `reobserve_projection_digest`, `projection_digest`, and the `adjudication-projection-not-current` branch from `runAdjudication` and its handler wiring. Keep the identical mechanism in `runCounterReview`, which the design does require.

---

## MAJOR 6 — A substantial architecture change (`produce-subject.ts` and the handler rework) is undocumented in the phase's Files table and unrecorded as an amendment

The design's chunk 1 scopes the counter-review restoration to "the same computation once more … two lines" in `src/review/counter-review.ts`, and its Files table names nine `src/` files. The implementation instead introduced `src/state/produce-subject.ts` and rewrote how `handleCounterReview`, `handleAdjudicate`, and `handleState` establish the review subject — replacing the worktree file hash with the retained produce manifest's artifact. It also changed, with no entry in the Files table: `src/contracts/mcp-tools.ts` + `mcp-tools.schema.json` (`WaiverInput.supplemental_outcome`), `src/contracts/fingerprints.ts` (selector coverage), `src/mcp/handlers/{state,adjudicate,counter-review,waiver}.ts`, `src/repository/git.ts` (`isCommitAncestor`, `resolveCommit`), and `src/state/reconciliation.ts` (`blocking_reasons`).

Several of these look correct and even necessary — an `implementation-output` subject genuinely has no single file to hash, and `WaiverInput.supplemental_outcome` is what makes the REQ-41 loop reachable for a waiver gate (correctly excluded from the request digest at `src/contracts/fingerprints.ts:86-88` and `src/state/request.ts:60-61`, so the gate ID survives retries). The problem is that the subject-digest domain change is the root cause of Blocker 1 and was never written down. The declared-input fingerprint amendment *was* correctly recorded in `architecture.md:226`; this one was not.

**Suggested resolution**: after resolving Blocker 1, add the subject-digest change to `architecture.md` as an amendment the way the fingerprint row was amended, and bring the phase document's Files table in line with the files actually touched.

---

## MAJOR 7 — Two design-mandated proofs are missing, and both cover paths this phase newly created

* **Implementation-output produce.** The design pins it twice: "Both builders are proven by a **real `archflow_state` produce**, not by `verifyImplementationManifest` alone", and the criterion "a produce step succeeds on its first tool call, and a *second* produce on the same task succeeds too — the accounting path is exercised". `test/unit/implementation-output-builder-phase17.test.ts` asserts the accounting arithmetic and calls `verifyImplementationManifest` directly; the only live `archflow_state` produce (`review-fixed-point-live-phase17.test.ts`) installs a `document` artifact. `prepareSnapshot`'s `accounting` check (`src/state/snapshots.ts:164-166`) and the secret-scan path are therefore never exercised for an implementation output — the exact failure mode the design named ("the first produce on a task passes and every later one fails `SNAPSHOT_INVALID/accounting-mismatch`").
* **Terminal completion.** `planStateTransition`'s `terminal: "complete"` branch is unit-tested in isolation (`test/unit/state-gates.test.ts:445-455`), but nothing drives `handleState`'s `completionSignal` block (`src/mcp/handlers/state.ts:166-203`) through the tool. That block plans a self-transition whose target equals current in phase/step/status/attempt/fingerprint; whether such a call survives `runStateTransaction`'s earlier validation to reach `planStateTransition` is unproven. The design's Verification Steps required the full two-implementation-phase drive: `planned_final_phase` absent then present, updated on `amend-upstream` re-approval, `phase-impl-1` not terminating, and `commit-authorization` on `phase-impl-2` yielding `terminal: "complete"`. Only the gate-side half exists.

Also missing relative to the design's Verification Steps: `test/integration/gate-decision-interface-phase17.test.ts` was not written. `test/unit/state-gate-interface-phase17.test.ts` covers the template and writer rules well, but from synthesized `ActiveGateV1` fixtures; the required cases "at least one of `review-trigger`/`adjudication-failure` opened by the server from inside `archflow_adjudicate`" and "`status` returns a complete REQ-41 prompt for a **server-opened** gate" are untested — which is why Blocker 4 survived.

**Suggested resolution**: add (a) a live `archflow_state` produce of an implementation output plus a second produce on the same task, (b) the two-implementation-phase completion drive through the real handlers, and (c) a `status`-over-a-server-opened-gate assertion covering both the templates and the prompt.

---

## Checked and found sound

Recorded so the next reader does not re-derive them: the uniform non-produce fingerprint (`rubricDigest`, `artifactPaths`, `upstreamPaths`) and its `architecture.md:226` amendment; the counter-review post-dispatch re-observation; `buildGateDecisionTemplates`' context-derived enumeration (waiver `{grant, deny, cancel}` keyed on `origin` not `kind`, per-eligible-rule waiver templates, pre-bound `adjudication-failure` resolutions sorted by the same `localeCompare` rule `validateGateDecision` uses, `adopt-as-new-generation` omitted without an `adoption_candidate`); `writeGateDecisionInterface`'s read-then-`replace` under `lock.runExclusive` following `openDurableGate:700-711`; the `identifyStateInitialization` seam shared by `runStateInitialization` and `computeCallEnvelope`; `discoverReconciliationInput`'s prepared-successor filter and its ambiguity outcome; `plannedFinalPhaseFromDesign`'s grammar and its pre-archive validation so a rejected plan leaves a correctable interface; `implementationOutputCommittedAtCurrentTarget`'s target-ref/ancestor/tree proof; `WaiverInput.supplemental_outcome` staying out of the request digest; `CLAUDE.md` and `AGENTS.md` byte-identical; `npm run check:dependencies` and `check:notices` clean; no sixth tool and no new error code.

## Triage

All seven findings are accepted. No finding is rejected.

| # | Disposition | Resolution |
|---|---|---|
| 1 | **Accepted — blocker** | Use the retained upstream produce artifact digest as the sole upstream identity for approval, adjudication evidence, and status currency, while retaining document bytes only as dispatch material. Add a real non-empty-upstream handler pipeline regression. |
| 2 | **Accepted — blocker** | Add mandatory `artifact-approval` authority for `phase-design`, update the phase skill and next-action contract, and retain the phase-design artifact as the implementation upstream. This preserves the hard no-code-before-approved-design boundary. |
| 3 | **Accepted — blocker/process gate** | After all code fixes, stage the actual final payload, present its new digest for explicit risk re-acceptance, then write/reproduce the tracked release, run the complete release suite, and create the Phase 17 implementation log. Verification remains unaccepted until those steps pass. |
| 4 | **Accepted — blocker** | Use `activeGateHead(active, archivedRequest)` as the complete binding authority instead of reconstructing a request that drops `supersedes`. Add a superseding-gate status regression covering templates and the REQ-41 prompt. |
| 5 | **Accepted — major** | Remove adjudication post-dispatch projection re-observation and its plumbing. Keep only the counter-review post-dispatch check required by the approved design. |
| 6 | **Accepted — major** | Record the retained-produce subject domain and all necessary touched files as implementation amendments in the phase design and parent architecture. |
| 7 | **Accepted — major** | Add real `archflow_state` implementation-output produces including a second produce/accounting path, real handler terminal completion coverage, and status over a server-opened adjudication gate. |
