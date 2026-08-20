# Phase 4 Implementation Notes — Content-trigger presentation at the guarded commit boundary

**Task:** review-flexibility
**Phase:** 4 of 6
**Base commit:** `3030d3d7f9ba335051a0d994d7742f9dee09d803`

## Implementation Log: Phase 4 - Content-trigger presentation at the guarded commit boundary

### Decisions Made

- **One pure durable join at the status boundary.** `contentTriggerDetails(settlement, output)` in `src/state/status.ts` accepts only an eligible frozen `RuleSettlementV1` and the exact retained `ImplementationOutputV1`. It has no config, Git, repository-reader, or filesystem input.
- **Settlement order is presentation order.** For each persisted matched path, rename-source endpoints (`previous_path`) render first in code-unit `output.path` order, then current-path endpoints. This preserves both sides of a rename and every co-located operation, including rename-away plus add-at-old-path.
- **Exact retained sizes drive every line.** Adds render `0 → after`, deletes `before → 0`, modifies and renames render `before → after`, and every delta is explicitly signed, including `+0`.
- **Incomplete joins fail closed.** If any persisted content path has no retained output endpoint, status withholds `open_gate`, adds `content-trigger-presentation-invalid`, and routes to inspection instead of presenting a plausible partial decision interface.
- **Rich details remain disposable.** `buildHumanGatePresentation(active, contentTriggerDetails?)` in `src/state/gate-decision-interface.ts` accepts the internally reconstructed detail array only for `commit-authorization`; supplying it for another gate kind throws an internal-invariant `TypeError`. No durable gate context or schema changed.
- **Only the ordinary commit gate archives trigger prose.** `composeGate` in `src/state/request-composition.ts` uses the already-frozen `approvalSummary` for `commit-authorization`; attempts exhaustion, constitution/policy, drift, migration, baseline adoption, and other higher-priority arms retain their original summary.
- **The staged human boundary remains intact.** Both `wait:true` and `wait:false` implementation settlements still open explicit `commit-authorization`, keep the same authorize/revise/abort/cancel resolver vocabulary, and still require separate client-held commit confirmation.
- **Maintained behavior documentation changed with the code.** `docs/workflow/LIFECYCLE.md`, `docs/review/COUNTER-REVIEW.md`, `docs/state/DURABLE-STATE.md`, and `docs/TESTING.md` describe frozen per-path operation/size details, complete disposable presentation, later-config-edit stability, and Phase 5 ownership of autonomous activation.

### Deviations from Plan

- The semantic completion journey covers add, delete, and modify operations end to end, plus post-settlement config editing, frozen archived trigger prose, complete presentation details, unchanged choices, and separate commit confirmation. A multi-rename semantic fixture was removed after the existing implementation-output builder rejected its synthetic projection pair as inconsistent. The complete old-only, new-only, both-endpoint, and rename-away-plus-add-old matrix remains directly pinned against the pure production join in `test/unit/state-status.test.ts`; this changes test placement, not required behavior or an approved interface.
- The first sandboxed focused run could not spawn temporary Git processes (`EPERM`). The exact command was rerun with bounded process permission and passed; both outputs remain in the raw verification transcript.
- The first full integration sweep ran before the required tracked payload rebuild and therefore reported only the two expected stale-bundle failures. After the approved `/tmp`-staged rebuild, the offline release test and the full 40-file integration sweep passed.
- No PRD, task-design, or phase-design claim changed during implementation, so the governing documents required no content revision.

### Patterns Established

- A human-facing explanation derived from frozen authority should accept the smallest authenticated inputs that can reconstruct it; mutable configuration and live repository state stay outside the seam.
- When one durable path can legitimately identify multiple diff endpoints, iterate the authoritative path list and emit every endpoint rather than collapsing through a one-to-one map.
- A reconstructible presentation that cannot completely join its durable sources is unavailable authority, not partially useful evidence; status should keep the gate open but withhold choices and route to inspection.
- Bounded archival prose and complete disposable correspondence serve different purposes: the archive can explicitly summarize a very large match, while the reconstructed `presentation.details` must enumerate every matched path.
- No additional project `CLAUDE.md` convention is proposed. These subsystem-specific rules are now captured in maintained docs, focused tests, and the existing repository conventions.

### Gotchas

- `latestEligibleRuleSettlement` must be called with both the exact retained implementation artifact digest and that artifact's producer phase instance. A later config edit is informational and must never cause a new evaluation during status rendering.
- A rename can match at `previous_path`, `path`, or both. A path may also name a rename source and a separate current add; treating matched paths or output paths as unique one-to-one keys loses required evidence.
- `Array.prototype.localeCompare` is not the pinned ordering contract. The helper uses direct code-unit comparison so its deterministic output matches the settlement/output contract.
- `buildHumanGatePresentation`'s optional second argument is internal evidence, not caller-authored gate context. Passing even an empty defined list to a non-commit gate is an invariant violation.
- The tracked `dist/` payload is validated against source inputs. Integration's offline release cases fail with `stale bundle input` until the repository-local payload is rebuilt; no machine-global installation is involved or authorized.

### Key Interfaces

- `contentTriggerDetails(settlement: RuleSettlementV1 | undefined, output: ImplementationOutputV1): readonly string[] | undefined` — `src/state/status.ts`; returns no details for absent, `wait:false`, or subject settlements and throws if a content path cannot be joined completely.
- `buildHumanGatePresentation(active: ActiveGateV1, contentTriggerDetails?: readonly string[]): HumanGatePresentation` — `src/state/gate-decision-interface.ts`; exposes details only on `commit-authorization` and preserves all existing decision templates/options.
- `latestEligibleRuleSettlement(state, subjectDigest, producerPhaseInstance): RuleSettlementV1 | undefined` — `src/state/restart-authority.ts`; remains the sole restart-aware settlement selector.
- `buildCommitAuthorizationInput(subject, currentEvidence, target, baselineCommit): CommitAuthorizationInput` — `src/state/status.ts`; continues to derive the exact commit scope and separate-confirmation facts from the retained implementation output.
- `approvalRuleGateSummary(summary, match)` — `src/state/request-composition.ts`; supplies bounded frozen trigger prose to the ordinary commit gate archive while higher-priority gates keep raw summaries.

### Verification Evidence

Raw, unedited command output is stored in `.archflow/runtime/tasks/review-flexibility/cache/phases/4/verification.txt`.

- Focused unit verification: `npx vitest run test/unit/state-status.test.ts test/unit/state-gate-interface.test.ts test/unit/state-next-action.test.ts` — 3 files, 51 tests passed after the sandbox-only Git-spawn rerun.
- Focused semantic verification: `npx vitest run test/integration/semantic-implementation-completion-journeys.test.ts` — 1 file, 11 tests passed.
- `npm run typecheck` — passed.
- `npm run test:unit` — 107 files, 1,231 tests passed.
- `npm run test:contracts` — 27 files, 514 tests passed.
- `npx vitest run test/crash` — 3 files, 35 tests passed.
- `npm run check:schemas` — 32 generated schemas match committed bytes; no schema changed.
- `npm run release:stage -- --output /tmp/archflow-phase4-content-details.Cih2ey` and `npm run release:write -- --stage /tmp/archflow-phase4-content-details.Cih2ey` — reproducible tracked bundle written; bundle digest `970284516d4d8080fa3c6f52c2be4cb2fd932bf51a7a3bb236313d625867ce2f`. This updated tracked `dist/` only and installed nothing globally.
- `npm run release:check -- --payload dist` — passed.
- `npx vitest run test/integration/release-offline.test.ts` — 1 file, 3 tests passed.
- Final `npx vitest run test/integration` after the rebuild — 40 files, 234 tests passed.
- `git diff --check` — passed before the payload rebuild; a final post-log check is recorded below.
