# Phase 3 Implementation Notes — Subject rules and durable settlements

**Task:** review-flexibility
**Phase:** 3 of 6
**Base commit:** `ae187bc`

## Implementation Log: Phase 3 - Subject rules and durable settlements

### Decisions Made

- **One inline settlement shape for both outcomes.** `RuleSettlementV1` and `RuleSettlementConclusionV1` live in `src/contracts/durable-state.ts`; `TaskStateV1.rule_settlements` is the only durable representation. A settlement records either `{wait:false, match:null}` or `{wait:true, match:<subject-or-content>}`. There is no standalone settlement schema, registry key, barrel export, or authority file.
- **Evaluation is frozen at the clean fixed point.** `evaluateApprovalRules` in `src/state/approval-rules.ts` is called by the settling transaction's own config read. Status and gate composition consume the persisted conclusion; a later config edit is informational and governs only later settlements.
- **Every eligible settle path is covered.** `src/mcp/handlers/state.ts` settles final triage and accepted-editorial `produce:succeeded` re-entry from exact prospective evidence. `src/state/gates.ts` separately settles an authenticated, current policy-waiver grant from final triage or exact editorial re-entry. Human-requested simple revisions never settle.
- **Settlements are not approval authority in this phase.** `latestEligibleRuleSettlement` applies digest, producer-phase, numeric-latest, and restart-cutoff checks for presentation selection. Upstream, routing, transition, planned-final-phase, and milestone consumers continue to require authenticated human approval until the constitution is amended in Phase 5.
- **Document and implementation gates remain mandatory.** `src/state/next-action.ts` opens the ordinary document gate after either settlement outcome. Constitution policy arms, migration adoption, exception gates, and phase-implementation `commit-authorization` remain human-only.
- **Persisted trigger evidence reaches the human.** `src/state/request-composition.ts` adds the eligible `wait:true` subject/path match to the ordinary gate's durable summary, independent of later config edits.
- **Simple revisions preserve the trust boundary.** Final revised bytes always return to the human. The state handler rejects a `simple` declaration while retained triage contains an accepted material finding, so the finding cannot be relabelled away through a reused-review triage pass; the producer must classify the revision as significant and trigger fresh review.
- **Phase-plan authority remains human-derived.** Fresh design production and both rule-settlement routes leave `planned_final_phase` absent. Only authenticated design approval (or the existing migration authority path) establishes the initial bound; later governing-document produces may refresh an already-approved bound.
- **Repository defaults only.** `assets/config.template.yaml` ships `subjects: [prd, design]` and `content: [{paths:["**/*.sql"]}]`. Neither the live repository/task config nor any machine-global installation was changed.

### Deviations from Plan

- The interrupted worktree used an obsolete autonomous-only `RuleAdvanceV1` / `rule_advances` design with a separate `rule-advance` schema. The implementation was converted to the approved inline both-outcome settlement model; the obsolete untracked contract/schema were removed before verification.
- The full integration sweep initially exposed three stale journey expectations written for the obsolete model: gate composition after a post-settlement config edit was expected to fail, and two journeys expected the entire settlement collection to be absent despite a prior PRD wait settlement. Tests now assert the approved behavior: the persisted outcome is stable, and only the refused current-phase settlement is absent.
- A post-milestone baseline-adoption cleanliness exception from the interrupted attempt was outside the approved phase. Its source, test, and documentation hunks were removed. The only earlier-cursor exit added here is narrowly limited to the approved accepted-editorial/simple-revision `produce:succeeded` document re-entry.
- The maintained caps-named documentation pages were updated in the same change because repository instructions require behavior-changing edits to keep those pages current, even though the phase design's file summary did not enumerate them.
- Fresh same-side review found that the approved draft activated autonomous document commits before Phase 5 amended the active `explicit-human-authority` rule. The implementation and governing documents now defer all settlement consumption to Phase 5; Phase 3 stores and presents outcomes only.
- Fresh review also found that simple revision re-entry could bypass approval and suppress an accepted material finding. Simple re-entry now records no settlement, always returns to a human gate, and is refused before mutation when retained triage accepted a material finding. The same review found that design settlements still populated `planned_final_phase`; fresh production, normal settlement, and waiver settlement now leave the field absent until authenticated approval.
- The server-owned counter-review found one maintained-doc table that still described Phase 5's conditional gate opening. The `artifact-approval` and `design-approval` rows now state the Phase 3 behavior explicitly: both settlement outcomes open the human gate, and a persisted waiting match is presentation evidence. Its suggestion to allow partial `approval_rules` objects was rejected because the approved strict schema and contract corpus require both arrays whenever the optional section is present.
- Follow-up review found that appending an unbounded content-match list to maximum-length caller prose could exceed the gate input's 4,096-character contract. Gate composition now reserves bounded space for trigger evidence, explicitly truncates excess caller prose, shows exact leading paths plus an omitted count, and leaves the complete sorted match in durable settlement evidence.

### Patterns Established

- A conclusion derived from mutable config is recorded once at the transaction that first establishes the relevant fixed point; later config edits cannot rewrite its presentation evidence.
- Capability may be implemented before authority is activated, but no consumer may treat it as authority until the governing constitution is explicitly amended in the same reviewed change.
- When an existing pipeline re-entry can finish at an earlier cursor, admit only the exact approved successor edge and keep the normal evidence, authority, and commit checks separate from that movement exception.
- No additional project `CLAUDE.md` convention is proposed: these are ArchFlow subsystem contracts, now recorded in the maintained `docs/` set and executable tests rather than a general repository coding convention.

### Gotchas

- `RuleSettlementV1` is reachable from persisted `TaskStateV1`, so it must remain a `type` alias; using an interface breaks `CanonicalDocument<T extends PlainJsonValue>`.
- Settlement ordering cannot use stringified tuple helpers because revision 10 sorts before 9 lexically. `compareRuleSettlements` compares `(phase_instance, subject_digest)` lexically and `settled_at_revision` numerically; construction and Zod validation share it.
- The policy-waiver route bypasses `planStateTransition`; its authenticated gate-resolution transaction needs its own narrowly guarded settlement append. A waiver still does not approve document bytes.
- `**` glob behavior is segment-aware: `**/*.sql` matches both `a.sql` and `db/a.sql`, while `*` and `?` never cross `/`; content rules are evaluated only for `phase-impl`.
- The tracked bundle must be rebuilt after source/schema/template changes. `release:write` performs an isolated `npm ci` and required execution outside the filesystem/process sandbox; this updated only tracked `dist/` and did not install anything globally.

### Key Interfaces

- `evaluateApprovalRules(config, subject, changedPaths): ApprovalRuleConclusion` and `approvalRuleContext(state, produce, config)` — `src/state/approval-rules.ts`.
- `buildRuleSettlement(state, subjectDigest, configDigest, conclusion): RuleSettlementV1` — mechanically derives task, phase instance, step, and `current.revision + 1`.
- `latestEligibleRuleSettlement(state, subjectDigest, producerPhaseInstance): RuleSettlementV1 | undefined` — `src/state/restart-authority.ts`; Phase 3 uses it only for eligible presentation evidence.
- `TransitionPlanInput.rule_settlement?: RuleSettlementV1` — accepted only at final-triage success or exact accepted-editorial `produce:succeeded` re-entry; `planStateTransition` rejects simple human revisions and appends through `compareRuleSettlements`.
- `approvalRuleMatchSummary(match)` — stable human-readable subject/path trigger evidence used by gate composition.
- `subjectGateKind` — `prd`→`artifact-approval`, `design|phase-design`→`design-approval`, `phase-impl`→`commit-authorization`; the last mapping is helper-level only until Phase 4 activates commit-boundary rules.

### Verification Evidence

Raw, unedited command output is stored in `.archflow/runtime/tasks/review-flexibility/cache/phases/3/verification.txt`.

- `npm run typecheck` — passed.
- `npm run generate:schemas` and `npm run check:schemas` — 32 schemas generated; only `config.schema.json` and `task-state.schema.json` changed.
- `npm run test:unit` — 107 files, 1,226 tests passed.
- `npm run test:contracts` — 27 files, 514 tests passed.
- `npx vitest run test/integration` — final post-rebuild run: 40 files, 232 tests passed. The immediately preceding pre-rebuild run had only the two expected stale-bundle failures; all 230 source-level journeys passed.
- `npx vitest run test/crash` — 3 files, 35 tests passed.
- `npm run release:stage -- --output /tmp/archflow-phase3-bounded-summary.EsAS4Z` and `npm run release:write -- --stage /tmp/archflow-phase3-bounded-summary.EsAS4Z` — reproducible tracked bundle written; bundle digest `0d43c1d6a2aec01516e83ecbbac6918de929c6b2572abcfdd4db0741864cc6cb`. This updated tracked `dist/` only; no installation occurred.
- `npm run release:check -- --payload dist` — passed.
- `npx vitest run test/integration/release-offline.test.ts` — 1 file, 3 tests passed.
- Final `npm run typecheck && npm run check:schemas && git diff --check` — passed with no diff-check output.
