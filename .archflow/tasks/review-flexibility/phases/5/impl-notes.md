# Phase 5 Implementation Notes — Dormant exact-policy settlement authority and Git proof

**Task:** review-flexibility
**Phase:** 5 of 7
**Base commit:** `fc1ab710ca1f2e13af9c3e6d08006fbe697a129a`

## Implementation Log: Phase 5 - Dormant exact-policy settlement authority and Git proof

### Decisions Made

- **Exact policy bytes mint the capability.** `SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2`, `authenticateRuleAcceptancePolicy`, and `AuthenticatedRuleAcceptancePolicy` in `src/state/constitution.ts` compare the complete canonical active `explicit-human-authority@2` and `approved-design-before-code@2` rules, bind the authentic task policy-base commit and constitution digest, and expose no public automation boolean.
- **One restart-aware settlement selector.** `acceptedNoWaitSettlement(policy, state, subjectDigest, producerPhase)` in `src/state/restart-authority.ts` delegates phase, digest, numeric latest-entry, and planning-restart eligibility to `latestEligibleRuleSettlement`; a newer `wait:true` always defeats older no-wait evidence.
- **Reviewed upstream authority is phase-bound.** Retained owner selection, pinned review material, fixed-point validation, counter-review request assembly, status, and gate composition accept either authenticated human/migration authority or the exact policy capability plus a producer-phase-bound no-wait settlement. Policy, waiver, migration, drift, restore, baseline-adoption, revision, and attempts-exhausted gates remain human-only.
- **Status and mutation prove authority independently.** Status passes authenticated no-wait facts into `deriveNextAction`; `runStateTransition` independently resolves the pinned constitution and subject, remints the policy capability, and supplies branded acceptance to `planStateTransition`, which strips branded values before plain-JSON validation and rechecks task, policy, phase, digest, and restart bindings.
- **Autonomous commits retain exact proof.** Design and phase-design settlements store `milestone_baseline_commit`; implementation commits use `ImplementationOutputV1.base_commit`. Both paths require exact target, direct parent, deterministic message, authorized paths, retained blobs, canonical task state, and task-tree cleanliness. Human-triggered implementation commits retain `requires_human_confirmation:true`; exact no-wait implementation commits project `false`.
- **Baseline refresh is bounded and byte-exact.** The no-input internal `refresh_milestone_baseline` state operation appends a replacement settlement only after independently proving the same policy, subject, evidence cursor, settlement-time live-config digest, clean fixed point, and current HEAD. Status and the transaction each compare the settlement to their one freshly materialized live-config snapshot. `approvedDesignWorktreeMatchesRetainedArtifact` in `src/state/implementation-manifest.ts` compares every primary/additional reviewed document's live bytes, Git mode, OID, and size to the original retained outputs before status offers refresh and again before mutation.
- **Authentic fixtures precede initialization.** `createTaskWorkspace` accepts filename-keyed constitution bytes before the real policy-base commit and task initialization. Exact-v2 test rules derive from the exported supported profile; no test patches task state or constitution digests.
- **Tracked payload only.** Generated schemas and `dist/` were reproduced from fresh `/tmp` stages. No live/seed constitution, client instruction, skill, task config, or machine-global installation path was changed.

### Deviations from Plan

- The bounded baseline refresh required a dedicated internal `archflow_state` operation, `refresh_milestone_baseline`, because an input-free semantic action must not express authority as caller-authored facts. This is the smallest protocol extension that preserves independent server proof and the advertised tool's plain object root.
- Fresh same-side review found that clean reconciliation after baseline adoption was insufficient to prove reviewed document bytes were unchanged. The implementation now compares current bytes and modes directly with original retained outputs before both offer and mutation; regression tests cover byte and executable-mode drift. This strengthens, rather than changes, the approved invariant that refresh never reuses review across changed bytes.
- Fresh same-side review accepted `refresh-baseline-compares-creation-time-config-digest`: refresh incorrectly compared a settlement created under edited live config bytes with immutable task-creation `state.config_digest`. The significant remediation carries the transaction kernel's single materialized `LiveConfigSnapshot` into preparation, compares its digest with the frozen settlement, mirrors that eligibility in status, and routes a later live-config change through fresh produce/review instead of refresh. The authentic semantic journey proves creation digest != settlement digest can refresh, while a post-settlement digest change cannot.
- The first post-remediation full integration run occurred before rebuilding `dist/` and reported only the two expected stale-bundle failures. After the fresh tracked rebuild, all 40 integration files passed.
- The required `npm run check` remains incomplete only because the intentionally always-on digest contract for `docs/validation/host-selection.json` still binds the prior tracked `dist/manifest.json`. Refreshing it requires authenticated Claude and Codex model turns. The user explicitly declined those external calls and directed the workflow to proceed with this evidence gap visible; no evidence was fabricated or rebound offline.
- No PRD, task-design, or phase-design behavior changed during implementation, so the governing documents required no content revision.

### Patterns Established

- A repository-selected policy capability must authenticate exact canonical rule content and metadata plus the immutable commit/digest binding; matching IDs or versions alone is not authority.
- Any downstream document authority must carry the producer phase beside the digest so restart cutoffs cannot be evaluated against the consuming phase.
- A Git-baseline refresh may update only Git authority. It must compare live subject bytes and modes directly to the original retained reviewed output; reconciliation or an adopted projection generation is not proof that review bytes stayed unchanged.
- A frozen evaluation config is the live config snapshot used to create the settlement, not the task's immutable creation config. Comparing sites reuse one materialized snapshot and bind its raw-byte digest exactly.
- Status guidance and mutation authorization remain separate proofs. A semantic no-submission action carries intent only; the handler reconstructs every authority fact.
- No project `CLAUDE.md` edit is made in this phase. Proposed durable convention: authority refreshes that reuse review after Git movement must compare the live subject directly with the original retained reviewed bytes and modes, independent of disposable or adopted projections.

### Gotchas

- The shipped `.archflow/constitution/` and `assets/constitution/` remain v1, so ordinary initialized repositories cannot mint `AuthenticatedRuleAcceptancePolicy` in Phase 5 even when config evaluates to `wait:false`.
- `RuleSettlementV1.milestone_baseline_commit` is required only for design or phase-design `wait:false`; it is forbidden on PRD, implementation, and every `wait:true` settlement.
- Baseline adoption can legitimately make reconciliation clean for changed projection bytes. Never treat that clean result as proof that old counter-review evidence covers the live subject.
- `state.config_digest` authenticates task creation and may legitimately differ from a later `RuleSettlementV1.config_digest`; baseline refresh compares the settlement with a fresh live-config snapshot instead. A further live config edit refuses refresh until new review authority is produced under that configuration.
- The internal refresh command has no payload and therefore must not read stdin. Its semantic composition carries only the operation and intent ID.
- Full integration contains release-offline tests and must run after the tracked payload rebuild whenever source changes.
- `npm run check` binds the point-in-time real-host artifact to `dist/manifest.json`. Updating that artifact without running the authenticated opt-in suite would falsify evidence; the user explicitly accepted leaving this check incomplete for now.
- `.codex/config.toml` was already modified for this checkout's development MCP launcher. It is user-owned, excluded from implementation outputs, and must remain unstaged.

### Key Interfaces

- `authenticateRuleAcceptancePolicy(state: TaskStateV1, constitution: ResolvedConstitution): AuthenticatedRuleAcceptancePolicy | undefined` — `src/state/constitution.ts`; mints exact-profile authority bound to task, policy-base commit, and constitution digest.
- `acceptedNoWaitSettlement(policy, state, subjectDigest, producerPhase): RuleSettlementV1 | undefined` — `src/state/restart-authority.ts`; sole accepted-no-wait selector.
- `buildRuleSettlement(state, subjectDigest, configDigest, conclusion, milestoneBaselineCommit?)` — `src/state/approval-rules.ts`; records the bounded design baseline only on the allowed no-wait shape.
- `approvedDesignWorktreeMatchesRetainedArtifact(runner, authority, artifact, retained): Promise<ProjectResult<boolean>>` — `src/state/implementation-manifest.ts`; exact live-vs-retained document byte/mode proof used before autonomous design commit and baseline refresh.
- `autonomousDesignArtifactCommittedAtCurrentTarget(...)` and `autonomousImplementationOutputCommittedAtCurrentTarget(...)` — `src/state/implementation-manifest.ts`; exact direct-child commit observers.
- `planStateTransition({ authenticated_rule_acceptance, ... })` — `src/state/transitions.ts`; accepts branded no-wait authority only after binding rechecks and required commit proof.
- `operation: "refresh_milestone_baseline"` — `src/contracts/mcp-tools.ts` and `src/mcp/handlers/state.ts`; input-free, server-owned settlement baseline replacement.
- `NextActionInput.accepted_no_wait_settlement` plus `autonomous_commit` facts — `src/state/next-action.ts`; ordinary approval suppression occurs only at the final routing arm after exception precedence.

### Verification Evidence

Raw, unedited command output is stored in `.archflow/runtime/tasks/review-flexibility/cache/phases/5/verification.txt`.

- Focused authority and proof suite: 10 files, 179 tests passed after the sandbox-only Git-spawn `EPERM` rerun with bounded process permission.
- Focused semantic journeys: 3 files, 26 tests passed, including authentic exact-v2 document milestones, moved-HEAD refresh, TypeScript implementation completion, and legacy v1 human gates.
- `npm run typecheck` — passed after implementation and after review remediation.
- Config-digest refresh remediation: focused next-action tests passed; authentic exact-v2 semantic journey passed with a pre-settlement config edit, a refused post-settlement edit, restored settlement-time bytes, bounded refresh, exact commit, and phase advance. The revision is significant because it changes authority eligibility and therefore requires a fresh automatic review cycle.
- `npm run check:schemas` — 32 generated schemas match committed bytes.
- `npm run test:unit` — 107 files, 1,245 tests passed.
- `npm run test:contracts` — 27 files, 514 tests passed.
- Final post-rebuild `npx vitest run test/integration` — 40 files, 236 tests passed.
- Final `npx vitest run test/crash` — 3 files, 35 tests passed.
- Final significant-revision stage `/tmp/archflow-phase5-significant.z4Gxc4`; `npm run release:write` reproduced tracked `dist/`; bundle digest `cdea6bdb992f4a5e532ccf05e987515a3202e61dd6c3f68d8383a2b09bf32b6d`, manifest digest `0b7d14d5433fa444fb179fa6ddc565ef86f1bd718b2364cd48710304fe51b77d`.
- `npm run release:check -- --payload dist` and final `git diff --check` — passed.
- `npm run check` — 178 files passed and one point-in-time host-selection digest contract failed because `docs/validation/host-selection.json` still binds the prior tracked manifest. The user explicitly declined the authenticated external host calls and directed the workflow to proceed with this evidence gap disclosed.
