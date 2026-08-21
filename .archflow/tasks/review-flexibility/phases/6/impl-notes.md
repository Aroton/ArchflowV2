# Phase 6 Implementation Notes — Constitution activation and conditional human authority

**Task:** review-flexibility
**Phase:** 6 of 7
**Base commit:** `b6f0b748887cc2b60cdffab7fbb520f132e64755`

## Implementation Log: Phase 6 - Constitution activation and conditional human authority

### Decisions Made

- **The shipped constitution now mints the already-implemented exact v2 capability.** `.archflow/constitution/00-process.md` and `10-architecture.md` contain the exact `SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2` semantics; their `assets/constitution/` counterparts are byte-identical. The repository and template config retain default `prd`/`design` subject triggers and the `**/*.sql` content trigger.
- **Commit prose follows the authenticated confirmation bit.** `src/state/next-action.ts` and `src/state/semantic-view.ts` describe human authority and request a separate confirmation only when `commit_requires_human_confirmation` is true. The false branch names authenticated rule authority and directs exact autonomous execution; both branches preserve baseline, target-ref, path, staged-diff, message, unrelated-change, and proof checks.
- **Clients never infer the branch.** `CLAUDE.md`, byte-identical `AGENTS.md`, and the six producer/status/upgrade skills follow only returned semantic actions. A returned presentation is always human-required; no presentation means the client proceeds through the fresh server-returned commit or successor action. Migration, waiver, constitution, drift, restoration, attempts-exhausted, baseline-adoption, and cancellation boundaries remain human-required.
- **Default scaffolding proves activation.** `test/helpers/task-workspace.ts` now provides an explicit legacy-v1 fixture, while ordinary scaffolding uses the shipped v2 rules. Document and implementation journeys use default v2 for autonomous cases and opt into v1 only when testing legacy unconditional gates.
- **Activation-facing maintained documentation changed with behavior.** `docs/OVERVIEW.md`, `workflow/LIFECYCLE.md`, `workflow/SKILLS.md`, `mcp/SERVER.md`, `review/COUNTER-REVIEW.md`, `state/DURABLE-STATE.md`, `contracts/CONTRACTS.md`, `TESTING.md`, and `LIMITATIONS.md` describe targeted gates, exact no-wait authority, conditional commits, default-v2 coverage, and route overrides that may have no later presentation. Phase 7 retains the broader audit named by the parent design.
- **Tracked payload only.** A fresh final stage at `/tmp/archflow-phase6-final.rN7NvN` reproduced `dist/` with bundle digest `57f1d0eea80329d1c70b38ffeccaa716350c5f7f81e0f6e6d32c20ac371d94dd` and manifest digest `f25a3541925e12e84ad5cb3a3fd5d09e550af38cddb6d3dbdaec2e0293482108`. No machine-global skill, launcher, or bundle was installed.

### Deviations from Plan

- The shipped-v2 default exposed three additional legacy-policy assumptions outside the phase design's initially named journey files: `test/integration/planning-restart-handler.test.ts` and two cases in `test/integration/semantic-implementation-journeys.test.ts`. Those tests specifically assert unconditional human gates, so they now opt into `legacyHumanAuthorityConstitutionV1Bytes()` instead of weakening their assertions or replacing meaningful legacy coverage.
- Fresh same-side review accepted `PH6-REVIEW-01`: four producer skills conditionally opened gate presentations but the following paragraph still said unconditionally to stop for human judgment. The significant remediation scopes the stop/decision flow to a returned `presentation`, explicitly directs no-presentation paths to follow fresh server actions, and adds contract coverage. Runtime authority did not change, but client behavior did, so the revision requires fresh automatic review.
- The first full integration sweep reported only the three stale legacy expectations above (233 of 236 tests passed). After explicit-v1 fixture remediation, the affected 9 tests and the final full 40-file integration suite passed.
- The first semantic work-result declaration exposed `PATH_INVALID` for the approved repository seed `.archflow/config.yaml`: the repository path classifier intentionally rejected every managed path except workflow and constitution files, so the implementation manifest could not retain or commit the required config activation. The smallest runtime correction adds only that exact seed path to the existing `repository-source` class in `src/repository/paths.ts`; every other unmanaged `.archflow/` path remains rejected. `test/unit/repository-paths.test.ts` and `docs/state/DURABLE-STATE.md` pin and explain the boundary.
- The connected MCP process was loaded from the repository-local `dist/` before that correction and cannot hot-reload it, so a second submission in this session repeated the same pre-mutation `PATH_INVALID`. `.codex/config.toml` already points at `scripts/dev-mcp-launcher.sh` with `ARCHFLOW_DEV=1`; a fresh Codex session will load the rebuilt tracked bundle and resume the still-unconsumed work-result offer. No machine-global install or launcher update is required or authorized.
- `npm run check` remains incomplete at its one intentionally always-on host-selection digest assertion: `docs/validation/host-selection.json` binds the prior `dist/manifest.json` digest. The final run passed 2,037 tests and failed that single expected assertion. Refreshing it requires authenticated opt-in real-host calls; no evidence was fabricated or rebound.
- No PRD, task-design, or phase-design requirement changed during implementation, so the governing documents required no semantic revision.

### Patterns Established

- A client instruction with a conditional gate-opening paragraph must also condition every subsequent stop/decision imperative on a returned presentation; independent substrings are insufficient contract coverage for control flow.
- Default fixtures should exercise the shipped policy. Tests whose purpose is legacy mandatory authority declare the legacy constitution explicitly at workspace creation.
- Human-authorized and rule-authorized commits share exact Git validation and differ only in whether authenticated facts require a separate conversational confirmation.
- Activation documentation must change in the same implementation that changes shipped policy bytes; a later general documentation phase cannot temporarily leave maintained pages false.
- The repository's permanent `CLAUDE.md`/`AGENTS.md` now carries the task-independent convention that clients follow only server-returned semantic actions, require human judgment for every returned presentation, and never invent a gate or confirmation. No additional permanent convention is proposed.
- A repository-owned seed under `.archflow/` that must participate in reviewed implementation output needs an exact allow-list entry; never broaden the whole managed tree to repository source merely to admit one policy file.

### Gotchas

- Changing repository `.archflow/config.yaml` does not change this in-flight task's copied config. Do not edit `.archflow/tasks/review-flexibility/config.yaml` and do not create a task from amended repository inputs until compatible tracked bundle adoption is explicitly authorized.
- Exact v2 authority is content-bearing: IDs, versions, status, normative text, review triggers, and empty enforcement metadata must all match; byte identity between live and seed files is separately required.
- `requires_human_confirmation:false` does not grant caller discretion. The returned baseline, target ref, sorted paths, message, and proof observation remain exact.
- Release staging must run before `release:write`; an empty directory without `manifest.json` is not a candidate stage. Reproducibility materialization may need bounded process/network permission for its temporary `npm ci`.
- The tracked `dist/` rebuild intentionally invalidates the point-in-time host-selection manifest digest. Do not update authenticated validation evidence without actually running its opt-in real-host suite.
- `.codex/config.toml` is user-owned and was already modified for this checkout's development MCP launcher. It is excluded from implementation outputs and must remain unstaged.

### Key Interfaces

- `SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2` and `authenticateRuleAcceptancePolicy(...)` — `src/state/constitution.ts`; exact canonical shipped-rule authority.
- `NextActionV1.commit_requires_human_confirmation` — projected by `src/state/next-action.ts`; sole source for human-versus-rule implementation commit wording.
- `WorkflowNextActionV1.commit.requires_human_confirmation` — mapped by `src/state/semantic-view.ts`; client-visible discriminator that must agree with action detail and instruction.
- `legacyHumanAuthorityConstitutionV1Bytes()` — `test/helpers/task-workspace.ts`; explicit fixture seam for tests whose purpose is legacy unconditional approval.
- `.archflow/config.yaml` and `assets/config.template.yaml` — equivalent future-task approval defaults; current task config remains isolated.
- `classifyRepositoryPath(...)` — `src/repository/paths.ts`; classifies the exact repository seed `.archflow/config.yaml` as a reviewable `repository-source` while rejecting every other unmatched managed path.
- `skills/archflow-phase-impl/SKILL.md` commit branch — exact baseline/ref/path/message choreography shared by confirmation true and false, with confirmation requested only for true.

### Verification Evidence

Raw command output is stored in `.archflow/runtime/tasks/review-flexibility/cache/phases/6/verification.txt` and is digest-bound by the implementation result.

- Focused unit activation/projection suite: 6 files, 64 tests passed.
- Focused skill contracts: 3 files, 42 tests passed after the accepted client-control-flow remediation.
- Focused semantic journeys: 3 files, 30 tests passed using shipped v2 autonomy and explicit legacy fixtures.
- `npm run typecheck` passed; `npm run check:schemas` reported all 32 generated schemas current.
- `npm run test:unit`: 107 files, 1,248 tests passed.
- `npm run test:contracts`: 27 files, 515 tests passed.
- Final `npx vitest run test/integration`: 40 files, 236 tests passed.
- `npx vitest run test/crash`: 3 files, 35 tests passed.
- Fresh `/tmp/archflow-phase6-final.rN7NvN` stage reproduced and wrote tracked `dist/`; `npm run release:check -- --payload dist` passed with the digests recorded above.
- `git diff --check`, `AGENTS.md`/`CLAUDE.md` byte identity, and both live/seed constitution byte identities passed.
- `npm run check`: 178 files passed, 5 skipped, and the one expected point-in-time host-selection digest contract failed because the tracked manifest legitimately changed. No authenticated real-host evidence was rewritten.
