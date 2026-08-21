# Phase 5 Design — Dormant exact-policy settlement authority and Git proof

**Task:** review-flexibility  
**Phase:** 5 of 7  
**Status:** draft for counter-review  
**Date:** 2026-08-20

## Goal

Implement and verify the fail-closed runtime machinery that can treat a reviewed `wait:false` rule settlement as advancement authority, while leaving the repository's live constitution, seed constitution, hard rules, and skills at v1 so the new path cannot activate for normally initialized repositories in this phase.

Phase 6 will independently amend the two rules and client instructions. Phase 7 will refresh the maintained documentation set. This split lets the human review the dormant authority mechanics before separately deciding whether to activate them.

## Requirements owned by this phase

- Prepare the runtime half of **R4**: ordinary approval gates may be suppressed only by an exact accepted no-wait settlement, after counter-review and every exception/policy obligation.
- Preserve **R6** defaults as dormant evidence: exact-v2 fixtures prove PRD/design triggers wait, TypeScript-only implementation does not, and SQL paths wait; the shipped v1 seed still mandates today's gates.
- Prepare **R8** safely: encode the exact supported v2 rule semantics that Phase 6 must ship, but do not edit any live/seed constitution or client instruction file here.
- Preserve exact Git proof, restart cutoffs, task isolation, human revision behavior, and every safety/exception gate.

## Scope

### In scope

- An internal exact supported-v2 rule profile and unforgeable acceptance capability.
- One exact restart-aware no-wait settlement selector used by every consumer.
- A bounded durable baseline for autonomous design/phase-design milestone commits.
- Reviewed-upstream selection, fixed-point inputs, routing, state transitions, phase-bound derivation, and exact autonomous commit proof.
- Authentic v1/v2 test fixtures, focused semantic journeys, schemas affected by the durable field, and repository-local tracked `dist/` regeneration.

### Out of scope

- Editing `.archflow/constitution/`, `assets/constitution/`, `CLAUDE.md`, `AGENTS.md`, or any skill. Phase 6 owns those activation bytes.
- New trigger kinds, config changes, semantic diff analysis, gate-kind removal, or a public automation switch.
- Making constitution-review, constitution-edit, attempts-exhausted, material-drift, restore-collision, baseline-adoption, migration-audit, waiver, or revision gates conditional.
- Comprehensive caps-named documentation (Phase 7).
- Any machine-global installation or live repository/task config edit.

## Inherited interfaces

- Phase 3 writes `RuleSettlementV1` only at eligible clean fixed points: final triage, accepted-editorial re-entry, or authenticated policy-waiver discharge. Human-requested revisions are excluded and return to their existing gate.
- `latestEligibleRuleSettlement(state, digest, producerPhase)` is the sole selector for the numerically latest exact settlement after the latest applicable planning restart.
- Phase 4 reconstructs complete content-trigger presentation details from frozen `wait:true` evidence plus retained implementation output; those presentations remain unchanged.
- `resolvePinnedConstitution` authenticates a registry from immutable `policy_base_commit` bytes and brands the result. `state.constitution_digest` binds the task to those bytes.
- `ImplementationOutputV1.base_commit` pins implementation commits. `DocumentArtifactV1` has no Git baseline, so autonomous design milestones require one bounded settlement-time fact.

## Design decisions

### P5-1 — Authenticate exact supported semantics, not names or versions

Define a module-owned canonical `SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2` containing the complete selected rule objects for:

- `explicit-human-authority@2`; and
- `approved-design-before-code@2`.

The comparison includes `id`, `version`, `status`, exact `text`, exact `review_trigger`, and normalized `enforced_by` metadata. The two entries are sorted by ID and compared canonically. Phase 6's live and seed files must parse to this exact profile. A repository-owned rule with the same ID/version but different wording or metadata is unsupported and remains human-gated.

Add a branded `AuthenticatedRuleAcceptancePolicy`, minted only when:

1. the `ResolvedConstitution` is authentic and came from `state.policy_base_commit`;
2. its digest equals `state.constitution_digest`; and
3. the two selected active rule objects exactly equal the supported profile.

The capability binds task id, policy-base commit, and constitution digest, and consumers recheck those bindings. V1, missing/divergent rules, unknown future versions, digest disagreement, or a fabricated plain object cannot activate autonomy. No MCP/config/status boolean is accepted.

Because Phase 5 does not amend the shipped v1 rules, ordinary initialized tasks cannot mint this capability. Tests create real policy-base commits containing the exact planned v2 profile before task initialization; they never patch state digests.

### P5-2 — One exact accepted-no-wait selector

Centralize consumption in:

```ts
acceptedNoWaitSettlement(policy, state, subjectDigest, producerPhase)
  -> RuleSettlementV1 | undefined
```

It delegates latest/restart/digest/phase selection to `latestEligibleRuleSettlement` and returns only a `wait:false` conclusion. A newer `wait:true` beats an older no-wait. Missing, wrong-task, wrong-phase, wrong-digest, or pre-restart evidence returns `undefined` and preserves the ordinary gate.

An existing open or resolved human gate keeps its archived authority. The selector is an alternative only for ordinary artifact/design/commit approval; it never satisfies policy findings, waivers, migration audit, attempts exhaustion, drift, restore, baseline adoption, or a human revision checkpoint.

### P5-3 — Reviewed upstream authority is phase-bound

Every current human-only upstream consumer accepts either:

- restart-eligible authenticated artifact/design approval (or migration-audit import authority); or
- exact accepted no-wait settlement for the upstream's producer phase and artifact digest.

Apply the shared rule to retained owner selection, status assessment, pinned review context, counter-review/adjudication inputs, triage settlement guards, waiver discharge, and request composition. Existing wire names such as `approved_upstream_digests` remain compatible vocabulary; acceptance itself must retain producer phase and cannot search settlements by digest alone.

`requireApprovedUpstreamDigests` either receives already authenticated phase-bound authority facts or defers to the shared loader. It must not re-scan only human approval references after a settlement was authenticated.

### P5-4 — Higher-priority gates always win

Preserve next-action order:

1. reconciliation/baseline problems;
2. terminal state or existing open gate;
3. unfinished produce/review/triage work;
4. attempts exhaustion;
5. constitution adjudication, waivers, migration audit, drift/restore/baseline, and revision checkpoints;
6. only then, ordinary artifact/design/commit approval.

At the final arm, matching human approval follows its existing path; accepted no-wait follows the autonomous path; `wait:true` or absent/ineligible policy/settlement opens today's gate. `composeGate` mirrors the order and refuses only an unnecessary phase-default gate, never an exception gate.

### P5-5 — Mutation independently proves the same authority

Status guidance does not authorize a transition. The state handler independently resolves the pinned constitution, mints the branded policy, loads the exact subject, selects the accepted settlement, verifies required commit proof, and passes a branded acceptance fact into `planStateTransition` beside authenticated human approvals.

The planner removes branded values before plain-JSON validation and rechecks their state/policy/phase/digest bindings. It allows:

- PRD exit on matching human approval or accepted no-wait;
- design/phase-design exit on matching human/migration authority or accepted no-wait, plus observed milestone commit;
- phase-implementation exit/final completion on matching commit authorization or accepted no-wait, plus observed implementation commit.

All other settlement-only transitions reject. Autonomous task-design exit derives `planned_final_phase` from the exact retained design bytes using existing grammar; invalid/absent bounds fail closed.

### P5-6 — Autonomous commits retain exact baselines and proof

#### Design and phase-design

Extend `RuleSettlementV1` with optional `milestone_baseline_commit`, allowed only for a `design` or `phase-design` `wait:false` settlement. The settling server transaction records HEAD in the same canonical state update that appends the settlement.

Before offering `commit-artifacts`, require HEAD to equal that baseline and return the current symbolic target, deterministic message, and whole task-local path. After the client commit, require:

- HEAD/target agreement and direct parent equal to the durable baseline;
- exact message and task-only changed paths;
- exact retained document/additional-document blobs;
- committed canonical `state.json` equal to current state containing the accepted settlement;
- no unauthorized task document and a clean task tree.

Human design approvals and migration audits retain their archived commit contexts; autonomous state+settlement proof is an alternative root, not a relaxation.

If HEAD no longer equals the latest settlement's baseline, status does not inspect forever or force a planning restart. After all reconciliation, open-gate, fixed-point, policy, and exception checks above remain clear, it returns one server-owned no-submission `refresh-milestone-baseline` action. That transaction may append a replacement no-wait settlement only when it independently proves:

- the exact supported policy capability is still active;
- the task is still at the same succeeded clean fixed point with no open gate or pending human revision;
- the exact retained subject digest, review/adjudication/triage evidence, rule conclusion, and original `config_digest` are unchanged;
- the prior entry is still the latest eligible no-wait settlement for that producer phase and subject; and
- reconciliation reports no task projection drift and no higher-priority safety/exception action.

The replacement copies the frozen conclusion and config digest, records `settled_at_revision` at the new canonical state revision, and replaces only `milestone_baseline_commit` with current HEAD; the earlier entry remains archived. It is a Git-authority refresh, not rule re-evaluation, approval, review reuse across changed bytes, or permission to bypass a gate. Fresh status then returns the ordinary exact commit facts. Repeated HEAD movement may repeat this bounded refresh, while any subject/evidence/task-byte change routes through normal reconciliation or fresh review instead.

#### Phase implementation

Build autonomous facts from `ImplementationOutputV1.base_commit`, exact retained output/rename-source paths, parent-document digests, deterministic message, and current target. Require target at the baseline before offering and reuse the direct-parent/tree/path/message observer after commit.

Triggered commit authorization continues projecting `requires_human_confirmation:true`. The dormant autonomous path projects `false`. Both require exact target/baseline/message/paths, literal-path staging, unrelated-change preservation, client-created commit, and fresh status proof.

## Files and work chunks

### Chunk 1 — Exact policy capability and durable baseline

- `src/contracts/durable-state.ts` and affected generated schema.
- `src/contracts/semantic-workflow.ts` and its generated schema add the bounded no-submission refresh action.
- `src/state/constitution.ts`, `src/state/approval-rules.ts`, `src/state/restart-authority.ts`.
- Settlement construction call sites in `src/mcp/handlers/state.ts` and `src/state/gates.ts` capture the milestone baseline only on the allowed design no-wait shape.

Pinned interface: exact canonical selected-rule profile; branded capability; one phase/digest/restart-aware selector; no public boolean.

### Chunk 2 — Reviewed upstream and fixed-point consumers

- `src/state/produce-subject.ts`, `src/state/status.ts`, `src/state/request-composition.ts`.
- `src/review/pinned-context.ts`, `src/review/fixed-point.ts`, `src/mcp/handlers/counter-review.ts`.

Pinned interface: every upstream authority is producer-phase-bound; policy/waiver/migration checks stay human-only; no duplicate digest-only scan.

### Chunk 3 — Routing, crossing, and exact commit proof

- `src/state/next-action.ts`, `src/state/transitions.ts`, `src/mcp/handlers/state.ts`.
- `src/state/planned-final-phase.ts`, `src/state/implementation-manifest.ts`, `src/state/semantic-view.ts`, `src/state/semantic-actions.ts`.

Pinned interface: exception precedence; state handler re-authentication; observed direct-child commit; triggered confirmation true and autonomous false.

### Chunk 4 — Authentic fixtures, regression journeys, and tracked payload

- `test/helpers/task-workspace.ts` adds a pre-initialization constitution-byte override used to create real v1/v2 policy-base commits.
- Focused tests named below cover policy, restart, routing, upstream, crossing, commit proof, and semantic journeys.
- Regenerate affected schemas and repository-local tracked `dist/` from a fresh `/tmp` stage.

Pinned interface: the repository's live/seed constitution, client hard rules, and skills remain byte-unchanged in this phase; no install and no live config edit.

Chunks 2 and 3 start only after Chunk 1's interfaces are fixed. They may run in parallel but must consume those interfaces. Chunk 4 verifies the combined dormant mechanism.

## Success criteria

1. New runtime plus an authentic v1 task and exact `wait:false` still opens the ordinary human gate.
2. An authentic fixture pinned to the exact supported v2 profile consumes only the latest eligible no-wait settlement; divergent same-ID/version, `wait:true`, missing, wrong-phase/digest, and pre-restart evidence fail closed.
3. Exact-v2 fixture PRD/design/phase-design outputs become reviewed upstreams without a human approval archive, but only after counter-review and all policy obligations.
4. Exact-v2 fixture design/phase-design emits and observes an exact autonomous milestone commit, derives the phase bound, and advances.
5. When HEAD moves after a no-wait design settlement but task bytes/evidence remain exact, one bounded refresh records the new baseline and the milestone proceeds; task/evidence drift or a safety condition refuses refresh and takes its normal route.
6. Exact-v2 fixture TypeScript implementation reaches exact commit facts with `requires_human_confirmation:false` and advances after proof; SQL/subject `wait:true` keeps the complete unchanged gate and later `true` confirmation.
7. Attempts exhaustion, constitution/policy/waiver, material drift, restore, baseline adoption, migration audit, and human revision checkpoints retain precedence.
8. The exact policy profile rejects divergent repository-owned v2 text/trigger/metadata and unknown versions.
9. Focused/full verification and tracked release reproduction pass; live/seed policy, client instructions, skills, live config, and global installation locations are untouched.

## Executable verification

Focused authority and proof:

```bash
npx vitest run --no-file-parallelism \
  test/unit/approval-rules.test.ts \
  test/unit/constitution.test.ts \
  test/unit/planning-restart-runtime.test.ts \
  test/unit/state-next-action.test.ts \
  test/unit/state-transitions.test.ts \
  test/unit/state-produce-subject.test.ts \
  test/unit/state-status.test.ts \
  test/unit/review-services.test.ts \
  test/unit/implementation-output-builder.test.ts \
  test/unit/semantic-view.test.ts
```

Focused semantic journeys:

```bash
npx vitest run --no-file-parallelism \
  test/integration/semantic-document-journeys.test.ts \
  test/integration/semantic-implementation-completion-journeys.test.ts \
  test/integration/planning-restart-handler.test.ts
```

Full validation and repository-local release:

```bash
npm run typecheck
npm run check:schemas
npm run test:unit
npm run test:contracts
npx vitest run test/integration
npx vitest run test/crash
npm run release:stage -- --output <fresh-directory-under-/tmp>
npm run release:write -- --stage <that-fresh-directory>
npm run release:check -- --payload dist
npm run check
git diff --check
```

Implementation creates the release stage with `mktemp -d`, records its exact path and raw output, and updates only tracked repository `dist/`. Never run `install.sh` or copy this checkout into shared machine-global locations.

## Risks and mitigations

- **Same ID/version hides divergent policy:** compare complete canonical selected-rule objects to the supported profile.
- **New code weakens v1 tasks:** only the branded exact-profile capability activates; shipped rules stay v1 throughout this phase.
- **A stale settlement crosses a restart:** delegate to the latest phase/digest selector and test numeric ordering/cutoff.
- **One human-only upstream scan wedges successors:** route every enumerated consumer through one phase-bound authority interface.
- **Status and mutation disagree:** both independently mint the capability and validate the exact settlement; transition rechecks branded bindings.
- **Design milestone lacks a gate baseline:** record one settlement-time baseline and require exact state/tree/direct-parent proof.
- **HEAD moves after the settlement baseline freezes:** offer only the authenticated no-submission refresh above; unchanged subject/evidence is mandatory and reconciliation/safety work wins.
- **Exception gate is suppressed:** preserve current routing order and test no-wait fixtures under policy, attempts, drift, migration, waiver, baseline, and revisions.
- **Partial rollout activates before human policy approval:** no shipped rule profile matches until Phase 6's separately reviewed amendment.

## Parent-design deviations recorded

The parent design is updated in this production result because planning and fresh review exposed four material corrections:

1. `approved-design-before-code` lives in `10-architecture.md`, not `00-process.md`.
2. Acceptance must compare exact canonical supported v2 rule content and metadata, not only IDs/versions.
3. Dormant mechanics and the human constitution/client activation need separate reviewed phases; documentation becomes Phase 7.
4. Autonomous design milestone proof needs a durable settlement-time baseline; implementation outputs already have one.

The verification map now assigns dormant v1/v2 runtime proofs to Phase 5 and shipped-default activation to Phase 6. The PRD remains accurate.

The accepted independent-review finding `frozen-milestone-baseline-has-no-recovery` is resolved by the bounded refresh action and the new HEAD-movement success criterion; no other reviewed behavior changes.
