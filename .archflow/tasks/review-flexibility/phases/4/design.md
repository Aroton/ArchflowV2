# Phase 4 Design — Content-trigger presentation at the guarded commit boundary

**Task:** review-flexibility  
**Phase:** 4 of 6  
**Status:** draft for review  
**Date:** 2026-08-20

## Goal

Complete the presentation half of targeted approval for phase implementations. When Phase 3's frozen approval-rule settlement says a content rule matched, the ordinary `commit-authorization` presentation must show every matched repository-relative path, its output operation, and its exact byte-size change. The explanation must remain stable if task config changes after settlement.

This phase does **not** activate autonomous consumption. Under the current constitution, both a matching SQL change (`wait:true`) and a non-matching TypeScript-only change (`wait:false`) still stop for explicit `commit-authorization`, and the client-created commit still requires the separate explicit human confirmation. Phase 5 owns conditional gate suppression and autonomous commit authority in the same reviewed change as the constitution amendment.

## Requirements and boundaries

### Requirements covered

- **R4, staged presentation only:** counter-review remains mandatory, and phase implementation remains behind the existing explicit commit boundary.
- **R7:** a fired content trigger presents every matched path, where it lives, whether it was added, modified, deleted, or renamed, and a concise exact byte-size delta.
- **R2 interaction:** a config edit after settlement is informational. It cannot recompute, replace, or erase the match presented for already-reviewed implementation bytes.
- **R5 interaction:** content triggers remain phase-implementation path matches. This phase introduces no new rule language or matching pass.
- **Exception safety:** attempts exhaustion, constitution review, material drift, baseline adoption, and the other exception gates retain their existing priority and human authority.

### Non-goals

- Do not treat `wait:false` as approval or commit authority.
- Do not suppress, rename, or otherwise change `commit-authorization`.
- Do not amend the constitution, repository hard rules, workflow skills, task config, or repository config.
- Do not re-evaluate mutable config when composing or presenting a settled gate.
- Do not add semantic diff analysis, filesystem inspection, Git reads, a new durable settlement root, or a generalized presentation framework.
- Do not change the commit decision vocabulary: the human must still be offered authorize, revise, abort, and cancel.
- Do not change any machine-global installation or run `install.sh`. The tracked `dist/` payload may be rebuilt repository-locally through the existing release workflow.

## Existing authority and implementation context

Phase 3 established all durable authority this phase needs:

- `RuleSettlementV1` in `src/contracts/durable-state.ts` is the sole frozen result of approval-rule evaluation. Relevant conclusions are `wait:true` with `match:{kind:"content",paths:[...]}` and `wait:false` with `match:null`.
- `latestEligibleRuleSettlement(state, subjectDigest, producerPhaseInstance)` in `src/state/restart-authority.ts` is the only settlement selector. It already enforces exact subject binding, producer-phase binding, numeric latest selection, and planning-restart cutoffs.
- `approvalRuleContext` records both endpoints of a rename in the changed-path set. The settled content paths are deduplicated, sorted, and complete for the config evaluated at the clean fixed point.
- Retained `ImplementationOutputV1.outputs` is the authenticated source of presentation metadata. Each output supplies its operation, its current path, a rename's previous path, and before/after byte sizes as applicable.
- `buildCommitAuthorizationInput` already derives the exact commit scope from that same retained implementation output and includes both rename endpoints.
- `composeGate` already computes `approvalSummary` from the eligible settlement. Its document-gate arms use that value, but the `commit-authorization` arm currently archives the caller's raw `summary`; that is the direct missing seam.
- `buildHumanGatePresentation` already supports server-derived `details`, and the semantic view projects those details without exposing gate IDs, digests, or decision templates.

No new durable contract is required. The archived gate summary will identify the persisted trigger, while the disposable human presentation will reconstruct the richer per-file lines from durable state and the retained implementation result. Losing the projection therefore loses convenience only; status can rebuild it from authenticated authority.

## Files in scope

### Source

- `src/state/status.ts`
  - Add the single pure join/formatting seam for content-trigger details.
  - Reconstruct details for an authenticated open `commit-authorization` gate from the eligible settlement and the retained implementation output.
  - Fail closed instead of presenting a partial match when durable paths and retained outputs disagree.
- `src/state/request-composition.ts`
  - Archive `approvalSummary`, rather than raw `summary`, for the ordinary `commit-authorization` arm.
  - Keep raw summaries on higher-priority exception/policy gates so content-trigger language cannot misdescribe the decision being asked.
- `src/state/gate-decision-interface.ts`
  - Accept the narrow internally derived content-trigger detail list when rendering a commit-authorization presentation.
  - Reject detail lines supplied for any other gate kind as an internal invariant violation.
  - Keep every decision template and option unchanged.

### Tests

- `test/unit/state-status.test.ts`
- `test/unit/state-gate-interface.test.ts`
- `test/unit/state-next-action.test.ts` (wording pin only: autonomous activation is Phase 5, not Phase 4)
- `test/integration/semantic-implementation-completion-journeys.test.ts`

### Maintained documentation

Update the affected behavior descriptions in the same change, while leaving Phase 6 as the final cross-system documentation refresh:

- `docs/workflow/LIFECYCLE.md`
- `docs/review/COUNTER-REVIEW.md`
- `docs/state/DURABLE-STATE.md`
- `docs/TESTING.md`

The repository-local tracked `dist/` payload is a generated delivery output, not a hand-written work chunk. Rebuild it after source/tests/docs are final. No schema source changes are planned; `npm run check:schemas` must prove the committed schemas remain current.

## Work chunks

### Chunk 1 — Derive complete content-trigger details from existing authority

Add one pure helper at the status/presentation boundary. Its inputs are the eligible current settlement (or its conclusion) and the exact retained `ImplementationOutputV1`; it does not accept config bytes, a repository reader, or Git state.

The helper returns no details for an absent settlement, `wait:false`, or a subject match. For a content match, it returns one or more immutable detail lines for each persisted matched path, grouped in the settlement's canonical path order:

- add: identify the path as added and show `0 → after.size_bytes` plus the signed delta;
- delete: identify the path as deleted and show `before.size_bytes → 0` plus the signed delta;
- modify: identify the path as modified and show `before.size_bytes → after.size_bytes` plus the signed delta;
- rename matched at the old endpoint: identify it as renamed to the new path and show before/after sizes plus the signed delta;
- rename matched at the new endpoint: identify it as renamed from the old path and show before/after sizes plus the signed delta.

A rename may legitimately contribute both old and new paths when both matched. Iterate the persisted path list rather than the output list so neither endpoint is collapsed. A single path may also identify more than one legitimate endpoint—for example, renaming `a/x.sql` to `a/y.sql` while adding a new `a/x.sql`. For each settled path, emit every matching endpoint in deterministic order: rename-source matches (`previous_path`) first, then current-path matches (`output.path`), with matches in either group ordered by `output.path` using code-unit order. A delta of zero is rendered with an explicit non-negative sign, just like another exact delta.

Each persisted path must resolve to at least one retained output endpoint. Multiple endpoints are valid and all are presented. A path with no matching endpoint is an invariant failure: status withholds the human decision presentation and reports an inspection/blocking state. It must never filter an unmatched path and present a plausible-looking partial list.

### Chunk 2 — Archive the trigger notice and render the reconstructible details

In `composeGate`, use the already-derived `approvalSummary` only when the ordinary gate kind is `commit-authorization`. This binds the frozen trigger notice into the archived request and its request digest. Continue using the original summary for attempts-exhausted, constitution, drift, migration, and other higher-priority gates.

For an authenticated open commit gate, status selects the settlement with `latestEligibleRuleSettlement` for the current implementation artifact digest and derives the details through Chunk 1. Pass those lines through a narrow optional argument to the existing gate presentation renderer; do not put them in `GateContext<"commit-authorization">` and do not change durable gate schemas. The renderer adds the lines to `presentation.details` only when `active.kind === "commit-authorization"`. If a caller supplies content-trigger details for any other gate kind, the renderer throws an internal invariant error rather than silently ignoring misplaced evidence. Pin both the valid commit case and the cross-kind rejection in `test/unit/state-gate-interface.test.ts`.

The semantic presentation is reconstructed on every status call, so its output must be deterministic. Do not truncate or reorder the detail array: R7 requires every matched path. The existing bounded archived summary may show leading paths plus an explicit omitted count, while the presentation details carry the complete list.

The commit gate's title, question, option tokens, option consequences, allowed decisions, exact commit facts, and `requires_human_confirmation:true` behavior stay unchanged.

### Chunk 3 — Pin guarded behavior end to end and update human documentation

Add focused unit coverage for the pure join and presentation, then extend the semantic implementation journey with representative settled implementations:

1. A `.sql` output produces `wait:true`; the still-mandatory commit gate archives the frozen trigger notice and presents all matching paths with operations and exact byte deltas.
2. Editing approval rules after that settlement does not alter the archived/reconstructed match or its details; ordinary config-change reporting may report the edit independently.
3. A TypeScript-only output produces `wait:false`; it still opens explicit commit authorization and carries no content-trigger details.
4. Rename coverage proves old-only, new-only, both-endpoint, and rename-away-plus-add-at-the-old-path matches are complete and deterministically ordered.
5. Existing exception-gate cases still route before ordinary commit authorization.
6. Both settlement conclusions preserve the commit decision choices and separate human confirmation.

Correct the stale `state-next-action` test description that says the unconditional commit boundary lasts "until Phase 4." Its assertions remain unchanged and should state that activation is deferred to Phase 5/the constitution amendment.

Update the four maintained documentation pages to describe the new per-path operation/size presentation while stating clearly that both outcomes remain human-authorized in this staged phase.

## Pinned cross-chunk interfaces

1. **Authority source:** details derive only from `latestEligibleRuleSettlement` for the exact current implementation artifact digest plus that artifact's retained `ImplementationOutputV1.outputs`.
2. **Frozen match:** presentation never calls `evaluateApprovalRules`, parses current approval rules, or performs a fresh path match. Later config edits cannot change the presented settlement.
3. **Complete join:** every persisted matched path produces at least one detail line, grouped in settlement order; all matching endpoints are emitted, and rename source and destination are independently addressable. Within one path, rename-source matches precede current-path matches and each group uses code-unit `output.path` order.
4. **Exact size arithmetic:** all numbers come from retained `before.size_bytes`/`after.size_bytes`; add uses zero as before, delete uses zero as after, and signed delta is `after - before`.
5. **Durable/disposable split:** the gate archive retains the bounded frozen-trigger summary and all existing commit facts. Rich detail lines remain a reconstructible status projection; no new authority field or schema is introduced.
6. **Decision fidelity:** `authorize-commit`, `revise`, `abort`, and `cancel` remain the complete rendered choices accepted by the resolver.
7. **Pre-activation boundary:** neither settlement conclusion can satisfy commit authority in this phase. `deriveNextAction` continues to open `commit-authorization`, and successful authorization still returns commit facts requiring human confirmation.
8. **Exception precedence:** approval-rule presentation data is attached only to the ordinary commit gate, never to a higher-priority safety or policy gate.

## Risks and mitigations

- **Accidental early autonomy:** the existing stale test prose can invite implementation to suppress a no-match gate in Phase 4. Keep the assertion human-required and correct only its phase reference.
- **Presentation drift:** consulting current config after settlement could show a different reason than the reviewed fixed point. The helper has no config input and uses only the eligible persisted match.
- **Rename loss or co-located operations:** joining only on `output.path` loses old-endpoint matches, while assuming one endpoint per path rejects a valid rename-away plus add-at-old-path change. Iterate settlement paths, index both rename endpoints, and emit every matching endpoint in the pinned order.
- **Plausible partial output:** silently dropping an unmatched path would violate R7 and mislead the human. Treat a path with no retained endpoint as a blocking invariant failure.
- **Exception mislabeling:** reusing the trigger-enhanced summary for every gate would make an attempts-exhausted or policy decision look like commit approval. Apply it only in the ordinary commit arm after precedence has selected that kind.
- **Unnecessary durable churn:** adding detail fields to the commit gate context would widen schemas and compatibility work without adding authority. Keep details reconstructible from the settlement and retained output.
- **Large match sets:** the bounded archive summary already truncates explicitly while preserving exact durable paths. The semantic details array remains complete; no silent presentation truncation is allowed in this phase.

## Success criteria

Phase 4 is complete when all of the following are true:

1. A frozen SQL/content match reaches the existing commit-authorization gate and the human presentation lists every matched path, operation, and exact signed byte delta.
2. A post-settlement config edit changes neither the match nor its presentation details.
3. A no-match TypeScript implementation still requires explicit commit authorization and shows no content-trigger details.
4. Rename source and destination matches—including a rename away followed by an add at the old path—are all represented correctly and deterministically.
5. A join disagreement fails closed without presenting incomplete evidence.
6. Exception gates retain priority, and commit options/commit facts are unchanged.
7. No durable schema, constitution, skill, config, workflow, or global installation is changed.
8. The affected maintained documentation accurately describes the staged behavior.

## Executable verification

Focused verification during implementation:

```bash
npx vitest run test/unit/state-status.test.ts test/unit/state-gate-interface.test.ts test/unit/state-next-action.test.ts
npx vitest run test/integration/semantic-implementation-completion-journeys.test.ts
npm run typecheck
```

Proportional regression for the central status/gate boundary:

```bash
npm run test:unit
npm run test:contracts
npx vitest run test/integration
npx vitest run test/crash
npm run check:schemas
git diff --check
```

After source and documentation settle, rebuild and verify only the tracked repository payload through the existing `/tmp`-staged release flow:

```bash
npm run release:stage -- --output <fresh-/tmp-stage>
npm run release:write -- --stage <fresh-/tmp-stage>
npm run release:check -- --payload dist
npx vitest run test/integration/release-offline.test.ts
```

No install command or machine-global write is authorized by this phase.
