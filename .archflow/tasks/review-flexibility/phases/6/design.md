# Phase 6 Design — Constitution activation and conditional human authority

**Task:** review-flexibility  
**Phase:** 6 of 7  
**Status:** draft for review

## Goal

Activate the targeted-approval model that Phase 5 deliberately left dormant. Ship the exact supported v2 constitution in both the live repository and new-project seeds, make client instructions follow server-derived conditional gates and commit facts, and prove that a normally scaffolded task can advance and commit autonomously when no approval rule matches while every triggered, policy, migration, and safety boundary still stops for explicit human judgment.

This is primarily an activation and client-contract phase. The Phase 5 authority machinery is already implemented. The independent review exposed one material projection defect at the activation seam, so the two TypeScript sites that describe implementation commit authority are explicitly in scope; broader runtime changes remain out of scope unless verification exposes another material defect.

## Requirements

1. `.archflow/constitution/00-process.md` and `10-architecture.md` parse to the complete canonical objects in `SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2`: exact IDs, version 2, active status, normative text, review triggers, and empty enforcement metadata. The matching `assets/constitution/` files are byte-identical seeds.
2. `explicit-human-authority@2` requires explicit decisions only at gates opened by an approval rule or safety condition and states that commits are not human-gated by default. `approved-design-before-code@2` accepts durable phase-design authority from either a passed triggered gate or rule-based advancement after counter-review.
3. `CLAUDE.md` and `AGENTS.md` remain byte-identical. Their hard rules preserve mandatory counter-review, explicit authority at every gate that actually opens, no implementation before durable phase-design authority, conversational human gates, task isolation, truthful parent documents, and phase implementation logs. They must no longer require a human gate or commit approval when authenticated server facts authorize autonomous advancement.
4. The PRD, design, phase-design, phase-implementation, status, and upgrade skills follow only the returned semantic action. They submit a gate summary and stop only when one is offered; they never synthesize a gate, approval, or autonomous authority.
5. Document producers handle both reviewed outcomes: a triggered/safety presentation follows the existing explicit-decision flow, while a clean no-wait result may proceed directly to an autonomous milestone commit or successor. Simple human revisions still return to approval of the final bytes.
6. Phase implementation treats `commit.requires_human_confirmation` as the discriminator. The server-returned action detail and instruction branch on the same authenticated fact: `true` describes the human-authorized commit and retains the separate conversational confirmation; `false` describes rule-authorized autonomous commit facts and does not claim a human decision or request confirmation. Both client branches independently verify baseline and target ref, stage and inspect exactly the returned paths, use the returned message, preserve unrelated changes, and call status for commit proof.
7. `archflow-status` reports a pending commit according to its returned confirmation flag and removes obsolete pinned-config recovery guidance. It remains read-only and never turns status facts into mutation authority.
8. Migration preview and `migration-audit`, constitution review and waiver handling, attempts exhaustion, drift/restore/baseline adoption, cancellation, and other safety/exception gates remain explicit human boundaries. Counter-review remains mandatory before either a triggered wait or autonomous advancement.
9. The config template describes the now-active approval rules rather than a future staged rollout. Add the same default `approval_rules` values to this repository's `.archflow/config.yaml` so future self-hosted tasks retain PRD/design and SQL gates after the v2 policy commit. Do not edit this in-flight task's copied config. Because the machine-global installed server is not updated by this phase, do not create a new task from the amended repository policy/config until a compatible tracked bundle has been adopted through a separate explicit install request.
10. A normally scaffolded task, with no injected constitution override, authenticates the shipped v2 profile. Tests prove the default PRD and design subject gates, autonomous document milestones under a task config that deliberately removes those subject triggers, and a default-rules TypeScript-only implementation with `requires_human_confirmation:false`; they also retain explicit v1/divergent-policy fail-closed coverage and SQL-triggered plus exception/migration human-gate coverage.
11. Maintained pages made immediately false by activation are updated in this phase: `OVERVIEW`, `LIFECYCLE`, `SKILLS`, `SERVER`, `COUNTER-REVIEW`, `DURABLE-STATE`, `CONTRACTS`, `TESTING`, and the affected `LIMITATIONS` entry. Phase 7 retains the broader cross-feature documentation audit and remaining page/stamp refresh.
12. Regenerate the tracked `dist/` payload from a fresh temporary stage and verify it, but do not run `install.sh`, overwrite any machine-global bundle or launcher, or otherwise install this checkout.

## Context

Phase 5 added `SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2`, exact policy authentication, restart-aware no-wait settlement selection, autonomous upstream and phase-exit authority, bounded milestone-baseline refresh, and exact Git proof. The shipped live and seed constitution stayed at v1, so ordinary initialization could not mint that capability. Phase 6 changes the bytes that new tasks pin; it does not add a global code-version switch and cannot retroactively change an existing task's pinned policy.

The current task remains governed by its v1 policy and its copied task-local config, so editing the repository seed config does not change this phase's authority and the existing human phase-design gate and commit path still apply. Future tasks initialized from the amended policy base may consume no-wait settlements autonomously. This repository's live config must therefore receive the same default approval rules as the shipped template in the activation commit; otherwise its future PRD, design, phase design, and implementation subjects would all evaluate `wait:false`. Exact-profile mismatch is intentionally fail-closed: v1, divergent v2, unknown future text, wrong constitution digest, stale or wrong-subject settlements, `wait:true`, and safety conditions continue to produce human-required behavior.

Repository policy forbids installing this checkout without an explicit request, and Phase 6 does not install it. The live repository config change is safe for the in-flight task because task creation already copied its config. It is intended for tasks created after a separately authorized adoption of the compatible Phase 6 bundle; creating a new task against the amended config with older tooling is outside the supported cutover sequence and is called out in the maintained limitations.

The parent task design originally deferred all maintained documentation to Phase 7. Activation would immediately falsify caps-named pages that describe v1 as current, all document/implementation gates as mandatory, settlements as presentation-only evidence, the TypeScript no-wait journey as human-authorized, or route overrides as necessarily reaching a later approval gate. Repository policy requires behavior documentation to change with the behavior, so the parent design is updated in the same production result: Phase 6 owns those activation-facing statements; Phase 7 remains the complete audit for earlier config, override, and remaining page/stamp changes.

## Files

### Constitution and shipped configuration

- `.archflow/constitution/00-process.md`, `.archflow/constitution/10-architecture.md` — amend the live rules to the exact supported v2 profile.
- `assets/constitution/00-process.md`, `assets/constitution/10-architecture.md` — byte-identical seeds for newly scaffolded repositories.
- `assets/config.template.yaml` — replace staged/future approval-rule commentary with the active targeted-gate model; do not alter the already-approved default rules.
- `.archflow/config.yaml` — add the template's default PRD/design subject triggers and SQL content trigger for future tasks in this repository; update obsolete byte-pinning commentary, but do not change routes or this task's copied config.

### Truthful semantic commit projection

- `src/state/next-action.ts` — derive implementation commit detail from `commit_requires_human_confirmation`, naming human authority only for the confirmed branch and rule authority for the autonomous branch.
- `src/state/semantic-view.ts` — project confirmation instructions only when the returned commit fact requires them; keep both branches' exact Git facts unchanged.
- `test/unit/state-next-action.test.ts`, `test/unit/semantic-view.test.ts` — pin truthful human and autonomous detail/instruction variants.

### Client contracts

- `CLAUDE.md`, `AGENTS.md` — identical repository instructions with conditional gate/commit trust boundaries.
- `skills/archflow-prd/SKILL.md`, `skills/archflow-design/SKILL.md`, `skills/archflow-phase-design/SKILL.md` — conditional document gate, autonomous milestone commit, and successor handling.
- `skills/archflow-phase-impl/SKILL.md` — triggered gate versus direct autonomous commit choreography keyed by returned actions and `requires_human_confirmation`.
- `skills/archflow-status/SKILL.md` — truthful conditional-gate/commit reporting and current editable-config guidance.
- `skills/archflow-upgrade/SKILL.md` — preserve unconditional preview and migration-audit authority while avoiding claims that all ordinary workflow gates are mandatory.

### Maintained activation documentation

- `docs/OVERVIEW.md`
- `docs/workflow/LIFECYCLE.md`
- `docs/workflow/SKILLS.md`
- `docs/mcp/SERVER.md`
- `docs/review/COUNTER-REVIEW.md`
- `docs/state/DURABLE-STATE.md`
- `docs/contracts/CONTRACTS.md`
- `docs/TESTING.md`
- `docs/LIMITATIONS.md` — update the route-override visibility/approval limitation made false by no-wait activation; Phase 7 still owns its full limitations audit.

These pages are updated only for the activation semantics made current here. Phase 7 owns the full maintained-set reconciliation and remaining stamps.

### Tests and fixtures

- `test/unit/constitution.test.ts`, `test/unit/state-constitution.test.ts` — pin shipped parsed rules and exact runtime-profile agreement, including v1/divergent refusal.
- `test/unit/init-assets.test.ts`, `test/unit/task-workspace.test.ts` — prove live/seed identity and default scaffolded v2 policy authentication.
- `test/helpers/task-workspace.ts`, and only the semantic journey helpers that need an explicit legacy-policy seam — keep a deliberate v1 fixture for tests whose purpose is mandatory legacy behavior while allowing the default scaffold to exercise v2.
- `test/integration/semantic-document-journeys.test.ts` — convert or add the shipped-default autonomous document journey; retain triggered document, simple revision, policy, and exception cases.
- `test/integration/semantic-implementation-completion-journeys.test.ts` — prove shipped-default TypeScript autonomy and preserve SQL-triggered and exception-gate cases; tests expecting legacy unconditional commit authorization must opt into v1 explicitly.
- `test/integration/semantic-upgrade-journeys.test.ts` — preserve migration-audit and import-commit behavior if default seed activation changes fixture assumptions.
- `test/contracts/skill-contract-canonical.test.ts`, `test/contracts/skill-contract-upgrade.test.ts`, `test/contracts/skill-contract-server-outage.test.ts` — pin both conditional client paths, byte identity, and unchanged upgrade/outage contracts.
- `dist/` — regenerated tracked payload and manifest outputs produced through the repository release scripts.

The implementation may touch additional existing tests only when their default-v1 assumption is exposed by the shipped seed change. Do not replace meaningful legacy coverage with v2 expectations wholesale; make the policy fixture explicit at the test boundary.

## Work Chunks

### 1. Exact policy and scaffold activation

Copy the exact supported profile semantics into the two live constitution rules and mirror their bytes into the two seed files. Update the template's approval-rule commentary and add its approval defaults to the repository config without changing this task's copy. Add byte/parse/authentication tests showing that an unmodified scaffold pins v2, the repository config retains the intended defaults, and deliberately supplied v1 or divergent v2 remains non-authoritative.

### 2. Repository and skill trust contracts

First make the server's implementation commit detail and instruction branch truthfully on `commit_requires_human_confirmation`, with focused unit pins for both paths. Update `CLAUDE.md` and `AGENTS.md` together, then revise the six skills around those returned semantic shapes. Gate presentation remains mandatory whenever `gate-summary` or a human presentation is returned. Direct commit/successor paths are permitted only when the server returns them; phase implementation branches on the confirmation boolean without weakening exact Git checks. Preserve route-override, degraded-operation, revision, waiver, migration, and safety choreography.

### 3. Shipped-path semantic journeys

Run the existing exact-v2 document and TypeScript implementation journeys against the shipped constitution from ordinary scaffolding instead of injected constitution bytes. The document-autonomy journey may deliberately configure no subject triggers; separately preserve the default PRD/design trigger journey. Introduce explicit v1 fixtures where a test specifically proves legacy mandatory approval. Keep representative `wait:true`, simple-revision, exception, migration, and policy-divergence cases to demonstrate that activation changes only eligible no-wait paths.

### 4. Activation-facing documentation and payload

Update every maintained statement made false at activation, including the distinction between rule settlements, gates, and direct commit facts, the default-v2 test matrix, and route-override visibility when no downstream approval gate opens. Refresh the affected pages' exploration stamps consistently with repository conventions. Produce `dist/` from a fresh temporary release stage and verify the tracked payload. Do not install it.

## Pinned Cross-Chunk Interfaces

- The parsed selected live and seed rules must canonicalize exactly to `SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2`; punctuation, frontmatter, review triggers, and enforcement metadata are authority-bearing.
- `.archflow/constitution/<file>` and `assets/constitution/<file>` are byte-identical for both amended rules.
- `CLAUDE.md` and `AGENTS.md` are byte-identical.
- Rule settlement is evidence, not caller authority. Only the server's authenticated status/apply view decides whether the next action is a gate, commit, successor, refresh, or exception.
- Counter-review and constitution review behavior is unchanged and precedes both `wait:true` and `wait:false` consumption.
- `gate-summary` is submitted only when expected. Any returned presentation requires explicit human judgment and no client may choose its token.
- `commit.requires_human_confirmation:true` means durable authorization exists but the client still obtains the separate conversational confirmation. `false` means the client does not invent that confirmation. Neither value permits altering the returned baseline, target ref, paths, or message.
- The semantic action's detail and instruction agree with `requires_human_confirmation`: only the `true` branch refers to a human commit decision or requests confirmation; the `false` branch names authenticated rule authority and direct client execution.
- Document milestone commit facts currently use `requires_human_confirmation:false` after either authenticated human gate authority or exact no-wait authority; document skills execute the server facts directly and never infer their source.
- Migration audit, waiver, constitution failure/uncertainty, attempts exhaustion, material drift, restore collision, baseline adoption, cancellation, and human-requested simple revision remain human-required regardless of approval-rule matches.
- An existing task remains bound to its recorded `policy_base_commit` and constitution digest. Shipped seed changes affect only tasks initialized from a policy base containing the amended bytes.
- Repository `.archflow/config.yaml` and `assets/config.template.yaml` carry equivalent default `approval_rules`, while task-local config remains isolated and unchanged. No task is created from the amended repository inputs until compatible bundle adoption is explicitly authorized.
- Release work updates only tracked repository payloads; machine-global skills, launchers, and bundles remain untouched.

## Success Criteria

- The four constitution files have the required live/seed byte identities and parse to the exact supported v2 profile.
- The repository config and shipped template expose the same default PRD/design and SQL approval rules, without changing this task's config or installing the bundle.
- A default scaffolded task mints exact v2 policy authority without a test-only constitution injection.
- With subject triggers deliberately removed but the shipped constitution unchanged, clean no-wait PRD/design/phase-design journeys expose no human presentation and reach the exact autonomous milestone commit/successor path after review; the shipped default PRD and design triggers still open their human gates.
- A TypeScript-only phase implementation under default SQL-only content rules exposes no commit-authorization presentation and returns exact commit facts with `requires_human_confirmation:false`; the client contract commits those facts without asking for confirmation.
- Human-required and autonomous implementation commit actions carry truthful, mutually consistent detail, instruction, and confirmation facts.
- PRD and architecture default subject triggers, SQL content triggers, explicit v1 fixtures, divergent v2 policy, simple human revisions, and all tested exception/migration paths still require the appropriate explicit human decision.
- Skill contract tests prove that clients neither invent a gate on an autonomous path nor skip a returned gate, and `CLAUDE.md` remains identical to `AGENTS.md`.
- The activation-facing maintained pages describe targeted gates, conditional commits, settlement authority, the test matrix, and route-override visibility accurately; the parent Phase 7 plan still names the remaining complete documentation audit.
- The tracked release payload reproduces from a fresh temporary stage and validates without any installation or live-config mutation.

## Executable Verification

Focused checks:

```bash
npx vitest run test/unit/constitution.test.ts test/unit/state-constitution.test.ts test/unit/init-assets.test.ts test/unit/task-workspace.test.ts test/unit/state-next-action.test.ts test/unit/semantic-view.test.ts
npx vitest run test/contracts/skill-contract-canonical.test.ts test/contracts/skill-contract-upgrade.test.ts test/contracts/skill-contract-server-outage.test.ts
npx vitest run test/integration/semantic-document-journeys.test.ts test/integration/semantic-implementation-completion-journeys.test.ts test/integration/semantic-upgrade-journeys.test.ts
```

Full repository checks:

```bash
npm run typecheck
npm run check:schemas
npm run test:unit
npm run test:contracts
npx vitest run test/integration
npx vitest run test/crash
```

Release and hygiene checks:

```bash
npm run release:stage -- --output <fresh-temporary-directory>
npm run release:write -- --stage <fresh-temporary-directory>
npm run release:check -- --payload dist
git diff --check
npm run check
```

Use a fresh directory under `/tmp` for release staging and record the exact commands and results in the phase implementation log. Phase 5 documents that full `npm run check` may still fail only at the point-in-time `docs/validation/host-selection.json` digest after a legitimate `dist/` rebuild. Report that result honestly; do not fabricate, rebind, or refresh authenticated real-host evidence without explicit authorization.
