## Implementation Log: Phase 19 - Legacy Upgrade Workflow

### Decisions Made

- `src/init/legacy-upgrade.ts` owns the complete offline staging transaction through `stageLegacyUpgrade(input: StageLegacyUpgradeInput): Promise<ProjectResult<StagedLegacyUpgrade>>`. It establishes only destination `config.yaml` and `imports/<import-digest>/`; `archflow_state` remains the sole initializer of `state.json`.
- Resume derivation uses every mapping entry whose `phase_instance` is `phase-impl-<n>`, including mapped implementation counter-reviews, exactly as the approved design specifies. The same algorithm runs over the emitted manifest in `src/init/legacy-upgrade.ts` and the authenticated retained manifest in `src/state/gates.ts`.
- `src/mcp/handlers/state.ts` resolves legacy jump authority only for non-successor `design` targets. An ordinary `design` to `phase-design-1` transition does not depend on an import manifest; a later jump requires one unique manifest whose canonical digest equals `state.initialization_digest`.
- Migration-audit approval loading is filtered to the current retained design produce subject before `planStateTransition` receives the opaque authenticated capability. A stale audit cannot authorize a jump after design re-entry.
- The user accepted the unchanged local-only `fast-uri@3.1.0` exposure and authorized commit for MCP bundle digest `52e5ab4d4a824925dc0a9690294ad1b27580356e383c42f0b1e463327d92bf2f` on 2026-08-04.

### Deviations from Plan

- Counter-review found and removed an extra transition denial that was not in chunk 6. The guarded non-successor admission remains, but users may deliberately rebuild from the ordinary phase-1 successor without accepting an import jump.
- Zero authenticated manifest matches now yields no jump authority rather than a state error at the handler discovery seam. Ambiguity still fails, and the migration-audit gate wrapper still converts absence into a non-advancing error. This prevents inert interrupted staging or a manual initialization from blocking the ordinary successor.
- The Phase 19 integration test prepares retained PRD/design results and resolves their real artifact-approval gates directly instead of replaying every unchanged Phase 14/17 review step. It then drives the real migration audit, authenticated jump, and resume-phase `produce/succeeded`, which proves both upstream results and approvals are usable at the new seam.
- The tracked release transaction also refreshed generated `dist/legal/review.json`, although the Files table named only its source `release/legal-review.json`; the payload copy must remain byte-identical to that source for release validation.
- No PRD requirement changed. The architecture was updated only to record the completed implementation and checked success criteria.

### Patterns Established

- Exceptional transition authority is resolved only when the requested target needs the exception. Missing optional authority must not brick an independently legal ordinary transition.
- A content-addressed import is inert until durable state authenticates its canonical manifest digest; staged filenames or directory presence alone never grant workflow authority.
- Derive resume semantics from the declared mapping contract in both producer and consumer. Do not substitute a destination-filename heuristic for a mapping field unless the contract explicitly says to.

### Gotchas

- A log-less legacy phase can still advance the resume point when an implementation counter-review maps to `phase-impl-<n>`; the imported canonical design must declare enough phases before its artifact-approval gate can close.
- `findLegacyImportResumePhase(...)` returning `undefined` means no authenticated jump authority, not that a natural successor is invalid. `loadLegacyImportResumePhase(...)` is the stricter gate-opening wrapper.
- `upgrade` carries stdin JSON and must remain absent from `INPUT_FREE_COMMANDS`; dispatch must stay before task-worktree services because the destination does not yet exist.
- The release writer validates bundle-bound risk evidence while promoting `dist/`. Refresh `focused-inert-reachability.json`, `user-risk-acceptance.json`, and the decision bindings in `release/legal-review.json` before `release:write`.

### Key Interfaces

- `src/repository/paths.ts`: `resolveLegacySourcePath(options: { readonly sourceRoot: string; readonly claim: RepositoryPathClaim; readonly context: RepositoryOperationContext }): Promise<ProjectResult<ResolvedSourcePath>>` is the only resolver for unclassified legacy-source reads.
- `src/init/legacy-upgrade.ts`: `StageLegacyUpgradeInput`, `StagedLegacyUpgrade`, and `stageLegacyUpgrade(...)` define the offline command boundary and emitted initialization/audit authority.
- `src/init/task-initialization.ts`: `commitDigest(commit: GitOid, digest_kind: string): Sha256Digest`, `createTaskConfig(...)`, `canonicalTaskPaths(...)`, and `resolveInitializationPolicyBase(...)` are shared by normal and legacy initialization.
- `src/state/gates.ts`: `findLegacyImportResumePhase(dependencies, authority, state): Promise<ProjectResult<PhaseInstanceId | undefined>>` authenticates a retained legacy manifest and derives its target; `openDurableGate(...)` applies the migration-audit fixed-point and phase-plan preconditions.
- `src/state/transitions.ts`: `TransitionPlanInput.legacy_resume_phase?: PhaseInstanceId` plus an authenticated `migration-audit` approval admits only the derived non-successor `phase-design-<n>/produce/running` target at attempt 1.
- `src/local/commands.ts`: `LOCAL_COMMANDS` includes stdin-bearing `upgrade`, which calls `stageLegacyUpgrade(...)` before production services are constructed.
- `skills/archflow-upgrade/SKILL.md` is the human-facing orchestrator for staging, initialization, PRD/design reruns, audit, manual fallback, and normal resume.

### Counter-Review Resolution

- The tracked-bundle finding was retained as the mandatory release gate and closed only after the user's bundle-bound risk acceptance; tracked release staging, promotion, and reproduction then passed.
- Resume derivation was restored to the approved mapping-based rule, including the fixture's log-less phase implementation-review mapping.
- The unintended ordinary-successor denial was removed, zero manifest matches became absence of jump authority, and focused tests pin both cases.
- The integration journey now reaches a real resume-phase `produce/succeeded` result through the handler, proving retained PRD/design upstream authority after the jump.

### Verification

- TypeScript checking passed. The post-triage focused suite passed 6 files / 40 tests, covering staging, bundled integration, state transitions, gates, initialization crashes, and the Phase 19 skill contract.
- Before release promotion, the full suite passed 1,636/1,639 tests; the only failures were the three expected stale tracked-release/risk-binding guards. After approved tracked release promotion, `npm run check:release` passed validation, guarded smoke, mutation, and byte-identical reproduction checks.
- `release:stage`, `release:write`, and `release:reproduce` produced MCP digest `52e5ab4d4a824925dc0a9690294ad1b27580356e383c42f0b1e463327d92bf2f`, local-helper digest `77f78f91f371c6ed41dcb43cc16541006af93f2a80a93f5ffc48c09eb9d170b7`, dependency-inventory digest `6836db3d7e77b1cf9cb19c0a0c063ff6cfaee5f50e92fdeea28241fb31ec5777`, and manifest digest `2f8a8c79fea894a028d211a8a9b39e28f197024bf44f8e1fd30b98c556af97d3`.
- Dependency policy passed for 140 locked entries, notices passed for 140 SPDX entries and 21 reviewed NOTICE mappings, the temporary bundle exercised under Node `24.18.0`, and `git diff --check` passed.
- The final `npm run check` passed all 146 test files / 1,639 tests, all 21 contract files / 476 tests, all 13 MCP-runtime files / 117 tests, build, dependency, notice, boundary, release validation, guarded smoke, mutation, and reproduction checks.

### Proposed Durable Conventions

- Propose adding to repository policy: resolve exceptional transition authority only for targets that actually need the exception; an unavailable exceptional interface must not suppress an ordinary legal transition.
- Propose adding to repository policy: when a mapping drives state-machine position, define which mapping roles count and derive from that declared field consistently at creation and consumption boundaries.

No policy file was changed for these proposals; they require separate explicit approval.
