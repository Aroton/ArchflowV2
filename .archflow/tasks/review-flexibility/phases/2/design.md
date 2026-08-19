# Phase 2 Design — Route override through the semantic workflow tools

**Task:** review-flexibility
**Phase:** 2 of 6
**Date:** 2026-08-19
**Scope:** task design D4 (route override reachable via a `review-dispatch` submission on the semantic `review` action) plus D10's Phase-2 skill-prose share (outage procedure in the four reviewing skills, config routing/overrides guidance in archflow-init). `approval_rules`, gate conditionality, the template ruleset, the constitution amendment, archflow-status prose, and the docs refresh belong to Phases 3–6.
**Fact basis:** verified against the current tree (branch `feature/review-override-flexibility`, `31fe7a3` plus the staged phase-1 durable-state records) by three parallel exploration reports with re-checked file:line references (`.archflow/tasks/review-flexibility/scratch/phase2-submission-path.md`, `phase2-override-plumbing.md`, `phase2-skills-pins.md`). Deltas versus the task design are in "Deviations" — one mechanism refinement updates the parent (item 2).

## Phase goal

Make the fully-implemented-but-unreachable per-dispatch reviewer route override reachable through the public semantic apply path, and teach the skills when to use it:

1. A `review-dispatch` submission on the `review` action carries a `RouteOverrideDeclaration` into the counter-review dispatch; the substitute route is validated exactly like a configured route, the dispatch runs under it, and the retained evidence records the override with its human reason (PRD R3, observable criterion 4).
2. On a fresh apply the override binds into the authenticated operation identity for free via the existing `submission_digest`; it is always request-scoped (composed into the request digest) and never touches the input fingerprint of the reviewed subject. On the crash-recovery path it authenticates at request level only (P2-3).
3. The four reviewing skills document the outage procedure (human-authorized substitution with a required reason → submit with the review offer), and archflow-init documents the config `overrides` section.

## Requirements mapped to this phase

| Source | Requirement |
|--------|-------------|
| PRD R3 | A route-override declaration submitted through the workflow's public apply path for a dispatch; same validation as a configured route; recorded on review evidence with its reason; no input-fingerprint alteration. Skills include outage guidance (when/how, human reason required). |
| Task design D4 | New `review-dispatch` submission kind carrying `route_override`; accepted by the `review` action; threaded into `review-run` facts; bound into the operation identity; no dedicated pre-approval gate. |
| Task design D10 (Phase-2 share) | Outage procedure in archflow-prd/design/phase-design/phase-impl; config routing/overrides guidance in archflow-init. (archflow-status notice handling stays with Phase 5 per the phase plan's file allocation.) |

## Context — what exists today (verified)

- **Downstream is complete; the gap is submission → facts.** The only live producer of `counter-review` facts is the `requestFacts` case `review`/substep `review-run` (`src/state/semantic-actions.ts:347-350`), which emits `{kind, intent_id}` and never reads its submission parameter. `composeCounterReview` (`src/state/request-composition.ts:495-504`) already passes `facts.route_override` into the composed tool input; `runCounterReview` consumes it: route resolution prefers the substitute for the named role (`src/review/counter-review.ts:280-285`), `routeFromConfiguredRoute` (`src/dispatch/routing.ts:57-80`) validates the substitute exactly like a configured route, and `overrideRecordFor` (`src/review/counter-review.ts:288-298`) stamps a `RouteOverrideRecord` on the review (:330) and adjudication (:380) evidence. Every override population in the tree today is test-only (hand-built `parseToolCall` in `test/integration/review-fixed-point.test.ts:787-795`).
- **Submission machinery.** `APPLY_SUBMISSION_KINDS` (`src/contracts/semantic-workflow.ts:99`) has no `review-dispatch`. `assertSubmissionMatches` (`src/state/semantic-actions.ts:82-87`) treats `"none"` as submission-forbidden and every other kind as exact-required (present AND matching). `operationKey` (`:117-141`) digests `submission ?? {kind: "none"}` into `SemanticOperationKeyV1.submission_digest`, so a submission is bound into the authenticated operation identity and replay continuation automatically — no extra binding work (already pinned by `test/unit/state-request.test.ts:139-159` and `test/unit/fingerprints.test.ts:208-225`).
- **Two review shapes in the view.** The dispatching review offer (`src/state/semantic-view.ts:182-187`) advertises `expected_submission: "none"`; review shapes that do not dispatch (finding-free completion, `:189-195`) also `"none"`.
- **Validation layers** (all existing, none config-only): the submission arm schema at plan time (`applySubmissionV1Schema`, `src/contracts/semantic-workflow.ts:320-328`); `routeOverrideSchema` inside `computeCallEnvelope`'s `parseToolCall` at composition (`src/local/call-envelope.ts:118,126`, again at `src/mcp/handlers/semantic.ts:199`) — non-empty reason, at least one role, route shape; dispatchability at dispatch time: the model must be a safe-id with a `claude-`/`gpt-` prefix unless a `provider` is given (claude-only; `gpt-*` + provider rejected), and claude-cli rejects `ultra` effort. The constitution cross-check runs against the substitute adapter.
- **Surfacing** (existing): `renderRouteOverride` in retained evidence markdown (`src/contracts/renderers.ts:39-59,95`) and `counter_review_provenance.route_override` in status → the human gate block (`src/state/status.ts:1121-1123`). The public `WorkflowViewV1` does not project route provenance (`PublicReviewContextV1` carries rubric + active_rules only) — no new public contract surface in this phase; R3's "surfaced wherever that evidence is presented" is satisfied by evidence markdown plus the gate block.
- **Schema machinery.** Regenerated schemas live in `src/contracts/schemas/v1/` (not repo-root; Deviations item 1). The advertised root stays a plain object with `action.properties.submission === {$ref: #/$defs/applySubmission}` (pinned at `test/contracts/mcp-advertised-schema.test.ts:334-340`); the advertised byte budget is `< 28_200` (`:272`; ~23.5 KB today — the inline route definition adds a few hundred bytes, headroom exists, re-measure when landing). `src/contracts/internal/schema-generation-semantic-workflow.ts` needs no edit: the arm nests inside the existing `applySubmission` def. Golden request-digest fixtures (`test/unit/fingerprints.test.ts:163-170`) do not move (their baselines carry no override); tool-level `route_override` digests are already pinned (`:181-225`). No test pins the review shape's `expected_submission` (journeys pin submit-work/decide/start-next-skill only).
- **Continuation seam.** `substepPlan` (`src/state/semantic-actions.ts:601`) computes continuation substeps with `requestFacts(..., undefined)`: the chained review-enter→review-run inside one apply drops the submission parameter, so facts assembly on that path cannot read it. The plan type already carries per-action submission payloads for exactly this reason (`task_ask`, `reopening_request`, `decision_submission`, `:61-64`).
- **Skills and pins.** Pins are substring/regex assertions over the live `skills/*/SKILL.md` (`test/contracts/skill-contract-canonical.test.ts:50-52`) — no canonical copies, nothing to regenerate for prose. The three planning skills say "Apply the offered no-submission `review`" (archflow-prd `:38`, archflow-design `:24`, archflow-phase-design `:24`); archflow-phase-impl's review section (`:30`) likewise. archflow-init (14 lines) never mentions config routing; `assets/config.template.yaml:23-44` already documents `overrides`, and the skill guidance matches it (schema: `configOverridesSchema`, `src/contracts/config.ts:27`). Vocabulary filters that bite: no bare "override" for this feature (the word already means revision classification in these files), no "checkpoint" anywhere, no `archflow_*` tool names beyond the two advertised, no new `archflow-local` commands, no SCREAMING_SNAKE outside `PROJECT_ERROR_DEFINITIONS`, frontmatter keys exactly `description` + `name`. Skills are not dist-bundle inputs (`install.sh` copies `skills/` directly); src/schema changes are.

## Design decisions

### P2-1 — Honest advertisement: the dispatching review offer names `review-dispatch`

The task design sketched keeping `expected_submission: "none"` on the offer and relaxing the matcher for review actions. Rejected: the advertised interface is the client's instruction surface — a client (or skill prose) that reads `expected_submission: "none"` correctly refuses to submit anything, which keeps the feature unreachable in practice, and the skills' pinned "no-submission `review`" wording would have to contradict the advertisement. Instead the dispatching review offer advertises `expected_submission: "review-dispatch"`, and `assertSubmissionMatches` learns exactly one new rule at its single enforcement point: the `review-dispatch` kind tolerates an absent submission (no override wanted) and requires a match when present. `"none"` still forbids; every other kind stays exact-required; no planner-level bypass is added (unlike the archived-decision retry path). Review shapes that do not dispatch keep `"none"`. Offer bytes change for the dispatching shape; review continuations authenticate via `currentOfferMatches`/recovered operation digests (`src/state/semantic-actions.ts:458-465`), so nothing strands.

### P2-2 — The declaration rides the plan, not just the requestFacts parameter

Because `substepPlan` continuations call `requestFacts` without the submission, the payload must live on the plan (`decision_submission` precedent): `SemanticActionPlanV1` gains `route_override?: RouteOverrideDeclaration`, set at plan time from a validated `review-dispatch` submission, read by the `review-run` facts assembly on both the fresh and the continuation path. Facts for `review-run` include `route_override` exactly when present; `composeCounterReview` consumes it unchanged (Context).

### P2-3 — Crash-window semantics: request-scoped, documented, never misreported

If an apply is interrupted between review-enter and review-run, the recovered continuation binds the submission's digest but not its value: the resumed dispatch runs under the configured route, with no override. Re-requesting the override on the re-offered review action works within the existing continuation machinery, with one precise limitation: when a review continuation authenticates, the operation digest is the recovered one, unconditionally (`src/state/semantic-actions.ts:429-446` — the candidate digest from the fresh offer plus the resent submission feeds only the old-retry comparison at `:459-462` and cannot match, because offer bytes embed the state revision, `src/state/semantic-view.ts:345`). A re-submitted `review-dispatch` therefore proceeds as a **fresh request** — a new request digest that passes the pre-dispatch replay probe as a genuinely new intent (`src/mcp/handlers/replay.ts:13-36`) — while the operation identity stays the recovered one: on the recovery path the override is authenticated at request level, not operation level. That still satisfies R3 and D4's binding model (the override binding is request-scoped by design, never fingerprint-scoped): the substitute is validated, the dispatch runs under it, and the evidence records it with its reason. Accepted deliberately — persisting the override, or changing the continuation-recovery digest selection at `:441-444` (the authentication seam shared by every review/triage continuation), would add durable machinery and review surface for a narrow crash window that no requirement names. The behavior stays honest and visible — evidence records the route that actually ran (no `RouteOverrideRecord` when none applied); a failing configured route keeps the dispatch's existing failure remediation (`retry-unchanged-attempt` / `repair-before-fresh-attempt`, `src/contracts/errors.ts:125`), with sustained failure surfacing through the fixed-point assessment's attempts-exhausted gate (`src/review/fixed-point.ts:442-448`), not from individual dispatch failures. Pinned by test; the LIMITATIONS wording lands with Phase 6 per the phase plan's file allocation.

### P2-4 — Contracts: one kind, one arm, one local $def

- `APPLY_SUBMISSION_KINDS` gains `"review-dispatch"`; `ApplySubmissionV1` gains `{ readonly kind: "review-dispatch"; readonly route_override: RouteOverrideDeclaration }`. `route_override` is **required** on the arm — an override-less apply uses no submission at all, and the declaration itself already requires a non-empty reason and at least one role, so an optional-only arm would be a meaningless shape. `RouteOverrideDeclaration` is type-imported from `src/contracts/mcp-tools.ts:76-80` (no import cycle).
- The zod arm in `applySubmissionV1Schema` uses a **parentless clone** of the shared route schema, registered as a semantic-workflow-local `$def` — the `src/contracts/mcp-tools.ts:184-196` clone pattern. The shared instance is registered as `config#/$defs/route` and the advertised catalogue carries no config document, so reusing it would emit a cross-document `$ref` that throws at advertise time (Phase 1 hit the same class of problem with the config snapshot mirror).
- `npm run generate:schemas`; commit the regenerated `src/contracts/schemas/v1/semantic-workflow.schema.json`. The advertised root stays a plain object; the union stays nested under `action.submission`.

### P2-5 — View and skills tell one story

- `src/state/semantic-view.ts`: the dispatching review offer's `expected_submission` becomes `"review-dispatch"` and its instruction names the override as the only reason to submit (carry a `review-dispatch` submission with `route_override` only when requesting a reviewer substitution).
- The four reviewing skills: reword the review-apply sentence (no longer "no-submission") and add the outage paragraph, scoped to a **server-reachable, route-only failure** — explicitly not the degraded-operation stop path (server unavailable → stop, `manual-status`, wait). Procedure: ask the human for a substitute route (`model`, `effort`, optional `provider`) and a reason; the reason is required and recorded on the evidence; submit `review-dispatch` with the review offer; the substitution parameterizes the automatic counter-review and never skips it. This is the single human-authorized exception to each skill's "do not supply routing" line.
- archflow-upgrade: its generic submission rule (`skills/archflow-upgrade/SKILL.md:32` — "only the submission that `next_action.expected_submission` requests; omit `submission` for `none`") drives the adopted task through the same dispatching review offer, so it gains a one-clause carve-out: `review-dispatch` is optional and used only for a human-authorized reviewer substitution; otherwise omit the submission (counter-review finding `upgrade-skill-submission-rule-unhandled`, accepted — Deviations item 7).
- archflow-init: one guidance paragraph for the config `overrides` section (per-phase-kind → `counter-reviewer`/`adjudicator` roles), matching `assets/config.template.yaml:23-44` and `configOverridesSchema`.
- Pins: update any `skill-contract-canonical.test.ts` substring asserting the reworded sentences; add outage-prose pins to `skill-contract-server-outage.test.ts` once the wording is final. archflow-status is untouched (Phase 5 owns its prose); the new wording must not contradict its degraded-path routing note.

## Work chunks

Four implementation chunks plus the verification sweep; A is contracts, B is state threading (depends on A), C is skills and pins (independent files, wording keyed to A's kind name), D is tests (depends on B).

### Chunk A — Contracts and schema

- `src/contracts/semantic-workflow.ts`: kind, arm, zod arm with parentless clone (P2-4); type-import `RouteOverrideDeclaration`.
- Regenerate `src/contracts/schemas/v1/semantic-workflow.schema.json` (`npm run generate:schemas`).

### Chunk B — State threading and offer honesty

- `src/state/semantic-actions.ts`: `assertSubmissionMatches` widening (P2-1 rule); `SemanticActionPlanV1.route_override?` plan field set at plan time; `requestFacts` review-run facts and the `substepPlan` continuation read it (P2-2).
- `src/state/semantic-view.ts`: dispatching review shape advertises `expected_submission: "review-dispatch"`; instruction mentions the optional override.

### Chunk C — Skills and pins

- The six `skills/*/SKILL.md` edits (P2-5, including the archflow-upgrade carve-out), then the pin updates in `test/contracts/skill-contract-canonical.test.ts` and `test/contracts/skill-contract-server-outage.test.ts`.

### Chunk D — Tests

1. **Unit, `test/unit/semantic-actions.test.ts`** (extend; `apply()` helper `:63-72`): `review-dispatch` accepted on review with and without a submission present; other actions still reject it; `"none"` still forbids; operation digest differs with/without the submission (model on `:86-101`); the review-run continuation fixture (`:127-153`) extended to prove the override survives `substepPlan` into facts.
2. **Composition, `test/integration/semantic-composition-parity.test.ts`** (extend): review facts with an override → the envelope carries it; `request_digest` changes with the override; the subject `input_fingerprint` does not.
3. **Journey (new or extended integration file)**: apply `review` with `review-dispatch` via `semanticJourneyHarness` + review stub → the child runs under the substitute route; retained evidence carries `RouteOverrideRecord` with the human reason (model on `test/integration/review-fixed-point.test.ts:1102-1182`); gate/status provenance shows `counter_review_provenance.route_override`. Plus the crash-window pin (P2-3): a recovered continuation without the submission value dispatches under the configured route; a re-submitted `review-dispatch` on the re-offered review action proceeds as a fresh request (new request digest, new intent) under the recovered operation identity — request-level authentication, exactly as P2-3 specifies.
4. **Contracts**: advertised schema — root plain object, `action.submission` still `$ref: applySubmission`, byte budget re-measured against `< 28_200`; generated schema contains the arm; `check:schemas` green; skill suites green with the updated/new pins.

### Chunk E — Verification sweep and bundle

- Full gates (below); rebuild the tracked `dist/` payload (`npm run release:stage -- --output <tmpdir>` then `npm run release:write -- --stage <tmpdir>`) — skills are not bundle inputs, src/schemas are; a stale bundle fails `release-offline` / `check:release` with "stale bundle input".

## Files touched (summary)

`src/contracts/semantic-workflow.ts`, `src/contracts/schemas/v1/semantic-workflow.schema.json` (regenerated), `src/state/semantic-actions.ts`, `src/state/semantic-view.ts`, `skills/archflow-prd/SKILL.md`, `skills/archflow-design/SKILL.md`, `skills/archflow-phase-design/SKILL.md`, `skills/archflow-phase-impl/SKILL.md`, `skills/archflow-init/SKILL.md`, `skills/archflow-upgrade/SKILL.md`, `test/contracts/skill-contract-canonical.test.ts`, `test/contracts/skill-contract-server-outage.test.ts`, `test/unit/semantic-actions.test.ts`, `test/integration/semantic-composition-parity.test.ts`, one new/extended integration journey file, and the rebuilt `dist/` payload. ~15 hand-written files including tests.

## Pinned cross-chunk interfaces

1. **Arm shape:** `{ kind: "review-dispatch"; route_override: RouteOverrideDeclaration }` — `route_override` required; the declaration type is imported from `src/contracts/mcp-tools.ts`, never redefined.
2. **Plan field:** `SemanticActionPlanV1.route_override?: RouteOverrideDeclaration` — present iff the planned apply carried a `review-dispatch` submission; `review-run` facts include `route_override` exactly when present; continuation paths read the plan field (the `requestFacts` submission parameter is `undefined` there).
3. **Matcher rule:** `assertSubmissionMatches` — `"none"` forbids; `"review-dispatch"` tolerates absence and requires a match when present; every other kind stays exact-required. One rule at the single enforcement point; no planner-level bypass.
4. **Offer honesty:** the dispatching review shape advertises `expected_submission: "review-dispatch"`; non-dispatching review shapes keep `"none"`; the instruction names the override as the only reason to submit.
5. **Fingerprint neutrality:** the override affects `submission_digest`/operation digest/request digest only; the input-fingerprint composition is untouched (PRD R3's "does not alter the input fingerprint").
6. **Schema locality:** the arm's route schema is a parentless semantic-workflow-local `$def` (clone pattern); no cross-document `$ref`; the advertised root stays a plain object.

## Success criteria

- PRD criterion 4, phase-scoped: a substitution requested through the semantic apply path during an outage scenario is accepted (same validation as a configured route), runs under the substitute route, and appears on the retained review evidence with its human reason and in gate/status provenance.
- Every existing review flow that applies `review` with no submission keeps working unchanged — absence is tolerated on the dispatching shape, non-dispatching shapes untouched.
- The submission is authenticated: on a fresh apply, a different submission yields a different operation digest and the same submission replays; on the recovery path the operation identity is the recovered one and the override binds at request level (P2-3); the override never changes the subject input fingerprint.
- Skill contract suites green with updated/new pins; advertised and generated schemas faithful; `check:schemas` green; `dist/` bundle fresh.

## Executable verification

Commands: `npm run typecheck`; `npm run generate:schemas` (diff reviewed); `npm run test:unit`; `npm run test:contracts`; `npx vitest run test/integration`; `npx vitest run test/crash`; then the dist rebuild and `npx vitest run test/integration/release-offline.test.ts` (`check:release`).

## Deviations from the task design (facts, not decisions)

1. Regenerated schemas live under `src/contracts/schemas/v1/`, not the repo-root `schemas/v1/` the task design names. Citation-level; corrected here and in the parent's D4/phase-plan text.
2. **Mechanism refinement (parent updated):** D4 sketched relaxing `assertSubmissionMatches` while the offer keeps advertising `expected_submission: "none"`. This design instead advertises `"review-dispatch"` on the dispatching review shape and teaches the matcher to tolerate absence for that one kind (P2-1) — a truthful-to-the-sketch `"none"` advertisement would keep the override unreachable to any client that follows the advertised interface, which is the reachability problem this phase exists to fix. The parent's D4 bullet is updated in this production result.
3. **Seam addition folded into D4:** `requestFacts` is invoked without the submission on the in-process review-run continuation (`substepPlan`, `src/state/semantic-actions.ts:601`), so "threads the declaration into the review-run facts" requires a plan-field carrier (`decision_submission` precedent) to be true on that path at all.
4. **Skill edits extend past the outage paragraph:** the four reviewing skills' "no-submission `review`" wording must change for the same reachability reason (P2-1); the task design's Phase-2 file list named only the outage paragraph. The parent's phase list is updated.
5. **Crash-window loss semantics** (P2-3) were unstated in the task design; documented here and pinned by test. The LIMITATIONS wording is deferred to Phase 6 per the phase plan's file allocation.
6. D4's "one optional field `route_override`" becomes a **required** field on the arm (P2-4): an override-less apply uses no submission, and `RouteOverrideDeclaration` validation already rejects an empty declaration, so an optional-only arm adds a meaningless shape. Folded into the parent's D4 bullet.
7. **Review-driven scope addition** (counter-review finding `upgrade-skill-submission-rule-unhandled`, accepted): archflow-upgrade joins the Phase-2 skill set beyond the task design's original file list. Its generic submission rule mechanically follows `expected_submission`, which under P2-1 would direct an upgrade session to construct a route override — with its required human reason — absent any human-authorized substitution: the same advertisement/prose contradiction P2-1 exists to eliminate, in the fabricated-authorization direction. One-clause carve-out in that skill (P2-5); the parent's Phase-2 file list is updated in the same change.
