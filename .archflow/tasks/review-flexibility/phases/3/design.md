# Phase 3 Design — Subject triggers and autonomous advancement

**Task:** review-flexibility
**Phase:** 3 of 6
**Date:** 2026-08-19
**Scope:** task design D5 (approval-rules config section + one pure evaluation helper, complete), D6 (durable rule settlements and autonomous acceptance across approval-dependent consumers, plus gateless design-milestone commit derivation), D7's document-subject share (artifact-approval and design-approval become rule-conditional; the constitution policy arm stays unconditional), and D10's repository template share (default `approval_rules`). The task-config self-cutover previously assigned here is removed: this checkout is served by a separately installed machine-global bundle, which may not parse the new key and may not be updated without the user's explicit request. The commit boundary stays behaviorally unchanged in this phase; content-trigger presentation remains Phase 4 work.
**Fact basis:** verified against the committed baseline (`956018b`; uncommitted implementation bytes excluded) through focused interface, verification, and fresh draft audits. The original durable exploration remains in `.archflow/tasks/review-flexibility/scratch/`; current corrections and parent updates are enumerated in "Deviations."

## Phase goal

Make human approval of **document subjects** (prd, design, phase-design) a targeted trigger instead of a built-in constant, and make gateless advancement durable and honest:

1. A new config section `approval_rules` (subject triggers + content-trigger rule shapes) is parsed, validated, mirrored into the durable config snapshot, and shipped active in the template with the PRD's default ruleset (PRD R5, R6 defaults for document subjects; PRD criterion 3).
2. One pure helper `evaluateApprovalRules` decides, from parsed config + workflow subject + changed paths, whether a completed step must wait for a human. The clean-advance transaction that first establishes the completed fixed point evaluates it once and durably records the conclusion; later status calls route from that settled authority rather than re-deciding the completed step from mutable config. The constitution policy arm and every exception gate ignore approval rules and still stop (task design D7, PRD R4).
3. The settling transaction writes a durable **approval-rule settlement** into state.json for both wait and autonomous outcomes. Approval-dependent consumers accept only an eligible autonomous settlement or use an equivalent gateless derivation; wait settlements retain the exact trigger match for later human presentation; constitution adjudication and migration adoption deliberately remain human-only (D6/D7).
4. A gateless design/phase-design step derives its design-milestone commit facts from an autonomous settlement plus the retained produce manifest and advances to `commit-artifacts` instead of stalling at `inspect-state` (D6's derivation half).
5. The repository template gains the new defaults, but this task's live config remains unchanged. The separately installed pre-cutover server continues enforcing its existing default gates for this in-flight task; adopting a rebuilt bundle is a distinct user-authorized operation outside this phase design.

## Requirements mapped to this phase

| Source | Requirement |
|--------|-------------|
| PRD R4 (phase share) | After counter-review completes, rule evaluation decides proceed-or-wait for document subjects; counter-review itself always runs; exception/safety gates untouched and not rule-conditional. |
| PRD R5 | Two declarative rule kinds in per-project config (the same surface R1/R2 made editable); machine-evaluated; constitution policy-base pinning unchanged. |
| PRD R6 (document share) | Fresh projects gate the PRD and the architecture/design under the shipped defaults (PRD criterion 3); the SQL content default ships in the template and is inert until Phase 4 activates the commit boundary. |
| Task design D5 | `approval_rules` schema in config; one pure helper with self-contained glob matcher; subject-to-gate-kind mapping incl. phase-impl→commit-authorization; content rules apply to phase-impl changed paths only; one authoritative evaluation at the first enumerated clean-advance transaction boundary. |
| Task design D6 | `RuleSettlementV1` written whenever an enumerated transaction first establishes a clean final-review fixed point; applicable approval-dependent consumers accept only its autonomous arm; the wait arm preserves trigger evidence; `planned_final_phase` derives during a gateless design settle; policy/import exceptions remain human-only; gateless design milestones compose commit facts from an autonomous settlement + produce manifest. |
| Task design D7 (document share) | After settlement, artifact/design approval opens for a `wait:true` outcome (or a legacy absent settlement), while authenticated approval or `wait:false` advances; policy arm opens regardless; presentations are otherwise unchanged in this phase. |
| Task design D9 (self-application correction) | Do not add an unsupported key to this task's live config while the separately installed server is old. The constitution amendment remains Phase 5; any bundle adoption remains a distinct, explicitly user-authorized action. |
| Task design D10 (template share) | `assets/config.template.yaml` ships `approval_rules` with `subjects: [prd, design]` and the SQL content example. |

## Context — what exists today (verified)

- **The single gate-opening decision lives in `advanceAction`, not `composeGate`.** `src/state/next-action.ts:167` opens the phase-kind's approval gate unconditionally when no matching approval exists (`requiredKind`: design/phase-design→design-approval, prd→artifact-approval, phase-impl→commit-authorization; `matchingApproval` keyed by `subject_digest`; legacy-design and migration approvals exempt at `:167`). The semantic view requests a `gate-summary` only when `next_action` is `open-gate`, and `composeGate` (`src/state/request-composition.ts:509-731`, kind derivation `:547-552`) is reached only through that offer — suppressing the open-gate action naturally bypasses gate composition. A second, separate design-approval open exists in the adjudication-gate branch (`next-action.ts:401-405`); that is the constitution policy arm.
- **Status has the routing facts, but clean-advance settlement owns evaluation.** `computeTaskStatusDetailedInternal` (`src/state/status.ts:712-1286`) reads live config for Phase-1 change notices (`:748-782`), loads the retained produce subject (`:843-864`), authenticates approvals (`:866-900`), derives implementation (`:902-941`) and design (`:942-1019`) commit facts, and calls `deriveNextAction` (`:1188-1212`). The same subject kind, digest, and changed paths are available at the narrowly enumerated transactions that first establish a clean fixed point (P3-5). Those transactions evaluate and persist the conclusion before status routes it. Status then consumes authenticated approval/latest eligible settlement facts; it does not turn a mutable live-config read into authority for an already-settled step.
- **Config schema and its durable mirror.** `src/contracts/config.ts:35-40` — `schema_version`, `roles`, `overrides`, `max_attempts`, every object `.strict()`. A new section must also be mirrored in `taskConfigSnapshotV1Schema` (`src/contracts/durable-state.ts:531-559`, parentless clones; state.json rejects unknown sections) and the generated `config.schema.json` / `task-state.schema.json` regenerated (`check:schemas` byte-fence). `TaskConfigSnapshot`/`AbsentIsAbsence` pick the shape up automatically; `config_change` notices flow through the existing generic `ConfigChangeEntry`. Template: `assets/config.template.yaml` (no `approval_rules` yet); `test/unit/init-assets.test.ts:35` byte-compares scaffolded config to it (self-adapting). This task's own `config.yaml` still carries a pre-phase-1 header claiming byte-pinning plus the retired `producer` role — parses fine (accepted-on-read).
- **Where approvals are required (the acceptance surface).** Six sites named by the task design plus four discovered by exploration:
  1. `currentApprovedUpstreams` (`src/state/status.ts:487-528`, throw `:524`) — authenticated approval per upstream binding; called by status `:1028` and inside composeGate's disagreement guard `:600`.
  2. `requireApprovedUpstreamDigests` (`src/review/fixed-point.ts:586-602`) — shallow ApprovalRef scan by gate-kind pair + subject digest; also `adjudicationGateSatisfied` `:332-375` (constitution-review discharged by authenticated design-approval or migration-audit) and `currentFor` "adjudicate" `:173-180` (adjudication current while its `approved_upstream_digests` match element-wise).
  3. `deriveApprovedUpstreams` (`src/mcp/handlers/counter-review.ts:122-203`, `upstream-approval-missing` at `:193-197`).
  4. `assembleUpstreamContext` (`src/review/pinned-context.ts:250-305`, shallowest check `:261-266`).
  5. `loadProduceUpstreamSubject` (`src/state/produce-subject.ts:82-175`, owner filter `:110-118` with `approvalIsEligibleAfterLatestRestart`; failure `:142`) — the shared chokepoint behind 1 and 4.
  6. `loadApprovedDesignFinalPhase` (`src/state/planned-final-phase.ts:50-87`, record filter `:55-60`; called from gate resolution `src/state/gates.ts:763,789,820-830`).
  7. `matchingApproval`/`advanceAction` (`src/state/next-action.ts:138-175`).
  8. Transition predicates — `hasAuthenticatedArtifactApproval`, `hasAuthenticatedCombinedDesignApproval`, `hasAuthenticatedMigrationAudit`, `hasAuthenticatedCommittedOutput` (`src/state/transitions.ts:197-225`, `253-266`, `397-422`; phase-exit requirements `:463-474`, `committedOutput` for phase-impl `:395-459`).
  9. The `archflow_state` handler's completion/phase-exit/legacy-jump signal blocks (`src/mcp/handlers/state.ts:387-517`, triage settle calling `planStateTransition` at `:518`).
  10. Migration-audit opening's `traditionallyApproved` check (`src/state/gates.ts:384-391`) — an import-path exception gate; rule settlements deliberately do **not** supply its human authority (see P3-6).
- **Settlement machinery.** The kernel (`src/state/transaction.ts`: `buildPlan` `:777`, `assertPreserved` `:319`, `withLastSeenConfig` `:800`, `installPlan` `:1012`) commits prepared states atomically; the handler's `prepare` callback builds the transition through the pure `planStateTransition` (`src/state/transitions.ts:425`, optional history fields conditionally spread in draft assembly `:530-545`, `TransitionPlanInput` precedents `:37-64`). Today a gate opens separately via `openDurableGate` (`src/state/gates.ts:165`, its own atomic write `:430-462`) and settles via `resolveDurableGate` (`:1473`) / `settleDirectSemanticGateDecision` (`:1268`); approvals are appended only in `nextStateForRecord` (`:469-492`) and authenticated by `loadAuthenticatedGateApproval` (`src/state/gate-approvals.ts:54-137`) against archived authority files.
- **Durable-state extension pattern.** `TaskStateV1` (`src/contracts/durable-state.ts:253-310`, Zod mirror `:567-622`) gains optional collections exactly as `baseline_adoptions` (`:187-200`, schema `:597-599`, revision-bound superRefine `:609-613`) and `last_seen_config` (`:307`, schema `:600`) do: `type` alias + Zod + sorted-set refine + bound. Persisted-reachable types must be type aliases, never interfaces (documented `:22-35`). State-embedded collections are state-only — no authority files. `IntentReceiptV1.prepared_state` embeds the full state schema (1 MiB receipt cap, `transaction.ts:82`).
- **Design-milestone facts are one generic context away.** `designCommit` facts (`src/state/status.ts:942-1018`) come from an authenticated design-approval/migration-audit request context, then `designArtifactCommittedAtCurrentTarget` (`src/state/implementation-manifest.ts:222+`) proves the commit; its context type (`:227-228`) is exactly `Pick<GateContext<"design-approval">, "target_ref"|"baseline_commit"|"commit_message"> & {authorized_document_paths?}`, with document paths defaulting to the artifact's `projection_target`s + additional_documents (`:241-250`). `buildDesignApprovalInput` (`status.ts:675-709`) authors that context today (target `currentTargetRef`, baseline HEAD). `advanceAction` consumes the facts (`next-action.ts:176-194`) and falls to `inspect-state` when absent (`:176-178`).
- **Disagreement guard.** `composeGate`'s guard (`src/state/request-composition.ts:588-619`) re-computes the status mirror (config read, `currentApprovedUpstreams`, review predecessor, `assessCurrentEvidence`) and fails `TRANSITION_INVALID` → `gate-fixed-point-disagreement` on any throw.
- **Nothing exists yet**: `approval_rules` / `evaluateApprovalRules` appear nowhere in src or test.

## Design decisions

### P3-1 — One pure helper, complete in this phase; content rules are phase-impl-only

New module `src/state/approval-rules.ts`:

```ts
type WorkflowSubject = "prd" | "design" | "phase-design" | "phase-impl";
type ApprovalRuleMatch =
  | { kind: "subject"; subject: WorkflowSubject }
  | { kind: "content"; paths: readonly string[] };
type ApprovalRuleConclusion = { wait: boolean; match: ApprovalRuleMatch | null };
evaluateApprovalRules(config, subject, changedPaths): ApprovalRuleConclusion
```

- Subject trigger: `wait` iff `subject ∈ config.approval_rules.subjects`. Content rules are evaluated **only for the phase-impl subject** and match when any changed path matches any rule's glob list (task design D5: a `**/*.md` rule never fires on the design doc; documented behavior). Absent/empty `approval_rules` ⇒ `{wait: false, match: null}` for every subject — fully autonomous document flow.
- Glob matcher: self-contained, no dependency. Semantics pinned: patterns match the whole repository-relative, `/`-separated path, case-sensitive; `*` and `?` match within one segment; `**` matches zero or more complete segments (so `**/*.sql` matches `a.sql` and `db/a.sql`; `db/**` matches everything under `db/`); a trailing `/**` also matches the directory's own path. Documented in the module and unit-tested.
- The subject→gate-kind mapping (D5) is one exported table `subjectGateKind: {prd: "artifact-approval", design|phase-design: "design-approval", phase-impl: "commit-authorization"}` incl. the force rule (a phase-impl subject trigger forces commit-authorization regardless of content rules) — implemented and unit-tested helper-level in this phase; its behavioral effect at the commit boundary activates in Phase 4 (P3-3).

### P3-2 — One authoritative evaluation at the first clean-advance transaction

- The shared settlement builder invoked only at the enumerated transaction boundaries in P3-5 is the authority that evaluates approval rules for the completed subject. Its caller reads config once, assembles the workflow subject and changed paths through `approvalRuleContext`, and appends a settlement carrying the complete conclusion for either outcome. That durable result freezes the decision: an eligible `wait:false` settlement means autonomous; an eligible `wait:true` settlement requires its human gate and supplies the exact match presentation. A later config edit governs later settlements and is reported by the Phase-1 notice machinery, but read-only status never retroactively re-decides a completed step.
- `computeTaskStatusDetailedInternal` derives the next action from authenticated approval/latest eligible settlement state, not from a fresh live-config conclusion. `composeGate` needs no rule conditional of its own: it is reachable only through the `open-gate` offer that `advanceAction` (P3-3) derives from the settlement, and it renders the persisted match. Its existing disagreement guard continues to cover subject/evidence drift; a config edit after settlement does not invalidate, invert, or erase the already-settled decision.

### P3-3 — Gate opening becomes rule-conditional for document subjects; the commit boundary waits for Phase 4

`advanceAction` (`next-action.ts:167`) changes from "phase-kind approval absent ⇒ open-gate" to: for **prd, design, phase-design**, an eligible `wait:false` settlement falls through to the existing advance/commit branches; an eligible `wait:true` settlement (or a legacy state with none) opens the phase-kind gate. This makes the settlement result, rather than mutable post-settlement config, authoritative. The **phase-impl arm is deliberately unchanged** in this phase: commit-authorization keeps opening unconditionally even when Phase 3 recorded a `wait:false` phase-impl settlement for Phase 4 to consume later; implementation commit facts, `buildCommitAuthorizationInput`, `committedOutput`, and the commit action stay as today.

- Rejected alternative — flip all three kinds now: it pulls Phase 4's commit-boundary machinery (implementation commit facts without a gate, autonomous-settlement consumption, ungated commit rendering, R7 presentation) forward into the phase that also lands settlements across the broad approval-dependency surface, enlarging the blast radius on the very commit path this task uses to commit itself. The cost of staging is one temporary condition (`requiredKind !== "commit-authorization"`) removed by Phase 4.
- The adjudication-gate branch's design-approval open (`next-action.ts:401-405`) — the **policy arm** — remains unconditional: unsatisfied constitution findings, a failing or uncertain rule, or eligible waivers open it regardless of project rules. Final triage does not mint a settlement while that arm is pending; the authenticated waiver-discharge transaction supplies the missing settlement afterward (P3-5). The fixed point's adjudication acceptance rules remain unchanged.

### P3-4 — `RuleSettlementV1`: both outcomes, one durable representation, restart-aware

Define the following type aliases and Zod mirror directly in `src/contracts/durable-state.ts`, beside `BaselineAdoptionRecord` and the other shapes consumed only by task-state. `RuleSettlementV1` is reachable from one durable root, so task-state owns it inline (or as its own `$def`); there is no separate schema ID, root document, barrel export, or consumer registration surface:

```ts
type RuleSettlementConclusionV1 =
  | { wait: false; match: null }
  | { wait: true; match:
      | { kind: "subject"; subject: WorkflowSubject }
      | { kind: "content"; paths: readonly string[] } };
type RuleSettlementV1 = {
  task_id: string; phase_instance: string; step: string;
  subject_digest: Sha256Digest; conclusion: RuleSettlementConclusionV1;
  config_digest: Sha256Digest; settled_at_revision: number;
};
```

Settlements have **one durable representation**: the inline state entry on `TaskStateV1.rule_settlements?: readonly RuleSettlementV1[]`, written by the kernel's own state commit. Both outcomes are persisted: `wait:false` is autonomous authority; `wait:true` preserves the exact trigger match. Recovery authority for a gateless milestone is the autonomous settlement inside the committed `state.json`. A separate durable document and an external authority file are both rejected: one adds an unnecessary registry/schema surface, while the other cannot be written atomically by the kernel.

- **Canonical order is a dedicated numeric-aware comparator over `(phase_instance, subject_digest, settled_at_revision)`**, not `tupleKey`: that helper string-coerces numbers and would sort revision 10 before 9. Construction and Zod validation use the same comparator; duplicates are rejected, while an exact restart may re-settle the same phase/digest at a later numeric revision. Latest selection compares `settled_at_revision` numerically rather than relying on array/string order.
- **Eligibility is digest-bound AND restart-scanned**: a settlement applies only while its `subject_digest` equals the digest being checked and it passes a restart cutoff. `restart-authority.ts` gains `ruleSettlementIsEligibleAfterLatestRestart` beside the approval filter. An approval-dependent consumer additionally requires `conclusion.wait === false`; a wait settlement can open/present a gate but never authorize advancement.
- `config_digest` is the **live** config digest observed by the settling preparation's own single config read (P3-5), never the creation-time pinned one. Settlements join no retained-result graph and no fingerprint composition.
- Settlements are **additive**: existing approval/import arms remain unchanged; in-flight states with no settlement preserve today's gate-required behavior, and archived gate parsers are untouched.

### P3-5 — Enumerated clean-advance transactions evaluate rules against prospective evidence

Today: triage settles via the `archflow_state` handler (`state.ts:518` → `planStateTransition`), while accepted editorial review and the allowed one-hop simple human revision can return to `produce-succeeded` with retained predecessor evidence and reach the same clean fixed point without another triage result. A shared settlement builder covers each of those routes. Each settling preparation evaluates rules **from one config read it performs** — the kernel's `prepare` callback (`transaction.ts:1164-1230`) receives only `(current, call)` and never sees `liveIdentification`'s snapshot, so the settle path derives both the conclusion and `config_digest` from that single read. No kernel signature changes; `transaction.ts` is untouched. It evaluates all four workflow subjects: document subjects use no content paths; phase-impl uses retained implementation output paths, so its settlement already exists when Phase 4 activates commit-boundary consumption.

**The fixed-point input includes the result being installed.** During final-triage preparation the just-produced triage result is not yet in `state.authoritative_results`, so the handler loads retained evidence and overlays the pending triage slot with `preparedResult.reference` plus its prepared manifest before assessment. Editorial/simple-revision `produce-succeeded` re-entry instead overlays the newly produced subject and assesses it with its retained accepted-review predecessor evidence. Each path assembles resolved constitution, upstream digests, and authenticated approvals against that exact prospective evidence set. A rule settlement is written only when this post-transaction view reaches the clean-advance path **with no pending adjudication gate** (`resolveAdjudicationGateStep` empty); policy failure writes no settlement and the post-settle status advertises the policy-arm design-approval gate.

The handler passes one structured `rule_settlement` field to `TransitionPlanInput`: `{subject_digest, config_digest, conclusion}`. `planStateTransition` accepts it only on two state-handler clean-advance boundaries: (1) final triage success with the pending triage overlay and (2) `produce-succeeded` re-entry after an accepted editorial review or the permitted one-hop simple human revision, using the current produced subject plus retained predecessor evidence. It rejects the field on every other state transition and whenever the prospective fixed point is not clean or still has pending adjudication. The transition derives task ID, phase instance, step, and `settled_at_revision = current.revision + 1` mechanically. Draft assembly appends the settlement for **either** conclusion. A `wait:false` entry is autonomous authority; a `wait:true` entry preserves the gate trigger and match but authorizes no advancement. Crash/replay remains the kernel's existing idempotent plan replay (same plan ⇒ same appended entry bytes).

**Policy-waiver discharge is the third settlement route, with its own gate-resolution guard.** Waiver resolution does not call `planStateTransition`: it runs through `closedStateForRecord`/`nextStateForRecord` in `src/state/gates.ts`. Final triage and editorial/simple-revision re-entry write no rule settlement while constitution adjudication is pending. If a later design-approval waiver is granted, that authenticated gate-resolution transaction evaluates the now-clean subject against one live-config read and calls the same pure settlement constructor used by the handler paths, then appends the `RuleSettlementV1` atomically with the waiver state. The gate code may call that constructor only from the branch where the authenticated design-approval decision is `waiver` and the accepted waiver actually discharges the current subject's pending policy arm; every other gate kind, decision, and unresolved/non-current subject rejects or omits settlement. Identity and revision derive from the gate transaction's current state rather than caller fields. A `wait:false` result advances without opening a redundant ordinary design gate; `wait:true` opens the project's ordinary design gate with the persisted match.

### P3-6 — Autonomous-settlement acceptance across the approval-dependent surface

Each applicable site gains one arm: "or the latest eligible `rule_settlements` entry for the subject whose conclusion is `wait:false` — `subject_digest` matching the digest being checked, `phase_instance` naming the producing step's instance, and passing the restart cutoff (P3-4)". A `wait:true` settlement is routing/presentation evidence only. Sites:

1. `currentApprovedUpstreams` (`status.ts:487-528`, seam `:524`) — autonomous settlement alongside the approval arm; also fixes the status blocker path.
2. `requireApprovedUpstreamDigests` (`fixed-point.ts:586-602`) — autonomous settlements as an alternative accepted-ref population. `adjudicationGateSatisfied` (`:332-375`) is not settlement-extended: constitution adjudication is discharged only by a human design-approval/migration-audit or waiver.
3. `deriveApprovedUpstreams` (`counter-review.ts:122-203`, seam `:193`) — autonomously settled upstreams render into pinned context like approved ones.
4. `assembleUpstreamContext` (`pinned-context.ts:250-305`, seam `:261-266`).
5. `loadProduceUpstreamSubject` (`produce-subject.ts:82-175`, owner filter `:110-118`) — autonomously settled retained manifests count as owned; the chokepoint for 1 and 4.
6. **`planned_final_phase` is derived and validated at the gateless design settle, not in `loadApprovedDesignFinalPhase`.** That loader (`planned-final-phase.ts:50-87`) is called only from gate resolution, so a settlement arm there would be dead code. The settling transaction of a `wait:false` design step runs the same derivation/validation the gate performs; malformed phase-plan grammar fails the settle, and a valid bound is recorded atomically. The loader keeps its approval arm for gated flows.
7. `matchingApproval`/routing (`next-action.ts:138-175`) — `wait:false` counts as autonomous authority; `wait:true` opens the document gate and exposes its match; a re-read cannot invert either outcome.
8. Transition predicates (`transitions.ts:197-225`, `253-266`, `463-474`) — artifact/design phase-exit accepts `wait:false` + observed milestone commit exactly as it accepts approval + observed commit. The phase-impl `committedOutput` predicate (`:395-459`) is untouched (P3-3).
9. The `archflow_state` handler signal blocks (`state.ts:387-517`) — build completion/phase-exit signals from approval or autonomous settlement, feeding the same `planStateTransition`.
10. Migration-audit's `traditionallyApproved` (`gates.ts:384-391`) — **no settlement arm**: legacy import adoption remains deliberately human.

### P3-7 — Gateless design milestones derive commit facts from autonomous settlement + manifest

In `status.ts:942-1019`, beside the authenticated design-approval and migration-audit arms, a third arm authors the same facts when an eligible `wait:false` design/phase-design settlement exists: `commit_message` from the existing milestone grammar, `target_ref` from `currentTargetRef`, `baseline_commit` from HEAD, `authorized_document_paths` from the retained produce manifest's document projections — reusing `buildDesignApprovalInput`'s authoring and the `designArtifactCommittedAtCurrentTarget` context type unchanged (it already accepts exactly these fields). `advanceAction` (`next-action.ts:176-194`) needs no change: the facts exist, so `commit-artifacts` is offered instead of `inspect-state`.

**The commit proof gains one acceptance arm, and recovery authority is the committed autonomous settlement.** Today `designArtifactCommittedAtCurrentTarget` (`implementation-manifest.ts:273-284`) requires the milestone commit to contain `state.json` plus an archived decisions `request.json`/`decision.json` pair, and a gateless milestone would fail `missing-recovery-authority` and route permanently to `inspect-state`. The fix: recovery accepts either the decisions pair or a read of the committed `state.json` blob containing the expected eligible `rule_settlements` entry with `conclusion.wait:false` and matching `(phase_instance, subject_digest)`. The kernel's state commit produced it atomically; observation semantics — baseline, direct parent, exact message, task-scoped paths, document after-images — are otherwise unchanged.

### P3-8 — Template defaults and the installed-server boundary

- `assets/config.template.yaml` ships (D10):

```yaml
approval_rules:
  subjects: [prd, design]
  content:
    - paths: ["**/*.sql"]
```

The content entry is the shipped default ruleset (R6) and is behaviorally inert until Phase 4 activates the commit boundary; document-subject behavior under these defaults is PRD criterion 3. `init-assets.test.ts` self-adapts to the repository template edit.

The template and rebuilt `dist/` are repository deliverables only. The active MCP command is resolved from a separately installed machine-global bundle, and this repository's installation rule forbids updating it without the user's explicit request in the current conversation. Therefore Phase 3 edits only `assets/config.template.yaml`: it does **not** edit the repository's live `.archflow/config.yaml`, this task's `.archflow/tasks/review-flexibility/config.yaml`, or the installed bundle. Task creation copies the repository `.archflow/config.yaml`, not `assets/config.template.yaml`; that live seed remains compatible with the old installed server and continues to supply this in-flight task's existing built-in gates. Re-running scaffold in this already initialized repository detects the template difference and returns `scaffold-diverged` rather than rewriting `.archflow/config.yaml`. A future separately authorized bundle adoption or new initialization adopts parser + template together. Recovery if an unsupported `approval_rules` key is written prematurely is to remove that key and retry with the old server—never to infer that the workflow advanced.

## Work chunks

Five chunks plus the verification sweep; A is contracts, B is the helper (independent of A's durable mirror, consumes A's config schema), C is the opening seam (depends on A+B), D is settlement and acceptance (depends on A+B, parallel to C), E is template/cutover and journeys (depends on C+D).

### Chunk A — Contracts, schemas, schema registration

- `src/contracts/config.ts`: `approval_rules` section (`subjects` enum array + `content: [{paths: string[]}]`, `.strict()`, optional).
- `src/contracts/durable-state.ts`: mirror `approval_rules` into `taskConfigSnapshotV1Schema`; define `RuleSettlementV1` and its conclusion schema beside the other task-state-owned records; add `TaskStateV1.rule_settlements?`, the dedicated numeric-aware sorted-unique comparator, and revision bound.
- `npm run generate:schemas`; review the config and task-state diffs. No separate rule-settlement schema document or registry edits are created.

### Chunk B — The evaluation helper

- `src/state/approval-rules.ts` (new): `evaluateApprovalRules`, the glob matcher, `subjectGateKind` mapping table, `approvalRuleContext` shared assembly.

### Chunk C — Conditional opening and the advance surface

- `src/state/status.ts`: derive routing and design-milestone facts from authenticated approval or latest eligible settlement; do not re-evaluate rules for an already-settled subject.
- `src/state/next-action.ts`: `advanceAction` document-subject settlement condition (P3-3 carve-out); approval/settlement routing (P3-6.7).
- `src/state/request-composition.ts`: keep the fixed-point guard aligned with settled authority; config changes after settlement are informational and do not invert the outcome (P3-2).

### Chunk D — Durable settlements and autonomous acceptance

- `src/state/transitions.ts`: guarded `TransitionPlanInput.rule_settlement` bundle accepted only at final-triage success or the accepted editorial/simple-revision produce re-entry boundary; settlement append for either outcome with mechanically derived identity/revision fields; artifact/design phase-exit predicates accept only `wait:false`; gateless design settle derives and validates `planned_final_phase` (P3-6.6).
- `src/mcp/handlers/state.ts`: signal blocks approval-or-autonomous-settlement (P3-6.9); shared settlement construction for final-triage and accepted editorial/simple-revision `produce-succeeded` re-entry; each route's single config read and prospective evidence overlay; fixed-point assessment; rule evaluation for all workflow subjects; structured settlement bundle (P3-5).
- `src/state/gates.ts`: separately guard authenticated policy-waiver discharge inside `closedStateForRecord`/`nextStateForRecord`; evaluate and atomically append the current subject's rule settlement through the shared pure constructor; other gate kinds/decisions and unresolved or non-current subjects cannot use this seam (P3-5).
- `src/state/restart-authority.ts`: `ruleSettlementIsEligibleAfterLatestRestart` beside the approval filter (P3-4).
- `src/state/status.ts`: `currentApprovedUpstreams` autonomous-settlement arm; persisted wait-match routing; design-milestone facts arm (P3-7).
- `src/state/implementation-manifest.ts`: the recovery-authority arm of `designArtifactCommittedAtCurrentTarget` — decisions pair, or the committed `state.json` blob containing the expected eligible autonomous settlement (P3-7).
- `src/review/fixed-point.ts`: `requireApprovedUpstreamDigests` autonomous-settlement arm (`adjudicationGateSatisfied` untouched).
- `src/mcp/handlers/counter-review.ts`: `deriveApprovedUpstreams` autonomous-settlement arm.
- `src/review/pinned-context.ts`: `assembleUpstreamContext` autonomous-settlement arm.
- `src/state/produce-subject.ts`: owner filter autonomous-settlement arm.
- `src/state/planned-final-phase.ts`: the settle-time derivation reuses `plannedFinalPhaseFromDesign` unchanged; `loadApprovedDesignFinalPhase` keeps its approval arm only.

### Chunk E — Template and journeys

- `assets/config.template.yaml` defaults; no task-config edit and no machine-global installation (P3-8).
- Journey/integration tests below; fixture adaptations for document-gate suites.

### Chunk F — Verification sweep and bundle

- Full gates (below); rebuild the tracked `dist/` payload (`release:stage`/`release:write`) — src/schema bytes are bundle inputs; stale bundle fails `release-offline`.

## Tests

1. **Helper unit (new `test/unit/approval-rules.test.ts`)**: subject match/no-match per subject; empty and absent `approval_rules` ⇒ autonomous; content rules evaluated for phase-impl only (a `**/*.md` rule does not fire on a design doc); glob semantics (`**` zero-or-more segments incl. `**/*.sql` matching root `a.sql`; `*`/`?` within a segment; trailing `/**`; case sensitivity); `subjectGateKind` mapping incl. phase-impl→commit-authorization force rule.
2. **Contract tests**: task-state optional-field combinations (both conclusions; bad revision bound; duplicate triple); numeric comparator cases across 9→10 and 99→100 in canonical, reverse, and duplicate orders; latest eligible selection is numeric; structural corpus inventory confirms the settlement is owned by task-state and no extra schema root/registry entry exists; foundational config agreement covers `approval_rules`.
3. **Upstream authority across the P3-6 surface**: autonomous-settlement upstream dispatch renders pinned context and passes `requireApprovedUpstreamDigests`; `loadProduceUpstreamSubject` and `currentApprovedUpstreams` accept `wait:false` but reject `wait:true`; `planned_final_phase` derives at a gateless design settle; artifact/design phase exit moves with autonomous settlement + observed milestone commit; migration-audit stays unchanged.
4. **Conditional opening**: `state-next-action.test.ts` — document kinds open for `wait:true` (and legacy absent-settlement) and advance for `wait:false`; phase-impl still opens unconditionally (carve-out pinned, so Phase 4's removal is observable); neither outcome flips on re-read.
5. **Policy-arm split and waiver resumption**: failing/uncertain constitution policy opens design-approval with no rule settlement; clean adjudication + no subject rule records `wait:false`; a granted waiver atomically records `wait:false` and advances when no project rule waits, or records `wait:true` and reopens the ordinary design gate with its match when a subject rule applies. Unrelated gate resolutions cannot mint settlements.
6. **Gateless document journeys**: template-default phase-design records `wait:false`, derives design-milestone commit facts, offers `commit-artifacts`, and proves the milestone from the autonomous settlement in committed state, never `inspect-state`; a fully autonomous config proves its first gateless milestone the same way.
7. **Fresh-project defaults (PRD criterion 3)**: template-configured task — first PRD and the design each stop at their approval gate with no project-specific rules added; a phase-design subject (not in defaults) advances gatelessly.
8. **Settlement authority and guard**: edit approval rules before final triage settlement and the new rules govern; edit them after either outcome and the settlement remains stable. A SQL-match journey removes the rule before commit-gate composition and still renders the persisted complete path set. Subject/evidence drift between status and gate apply still yields `gate-fixed-point-disagreement`.
9. **Restart and idempotence semantics**: an exact planning restart re-settles the same `(phase_instance, subject_digest)` at a new revision; pre-restart settlements are ineligible until re-settlement; latest eligible selection is numeric and tested across decimal-width boundaries.
10. **Gateless settle fixed-point determination and boundary guards**: the pending triage result is overlaid into the prospective evidence set; accepted-editorial and allowed one-hop simple-revision `produce-succeeded` re-entry each settle from the new subject plus retained accepted-review predecessor evidence, with both no-rule (`wait:false`, no ordinary gate) and matching-rule (`wait:true`, persisted match and ordinary gate) cases; a design settle with pending policy adjudication writes no rule settlement and opens the policy arm; malformed phase-plan grammar fails autonomous settlement with no `planned_final_phase`; `TransitionPlanInput.rule_settlement` is rejected outside final-triage success and the two specified produce re-entry shapes, or whenever their prospective fixed point is not clean. Gate-resolution tests independently prove that only an authenticated, current policy-waiver discharge can invoke the shared constructor and append a settlement; other gate kinds, decisions, stale subjects, and still-pending adjudication cannot.
11. **Existing suites adapted**: document journeys add explicit subject rules where gates are expected; semantic helper fixtures preserve gated tiers; status/config-edit fixtures keep PRD gated by default; composition/status/transition fixtures gain settlement facts; init-assets self-adapts. Phase-impl commit semantics are unchanged, but final-triage tests assert both `wait:false` and matched `wait:true` settlements are durably available for Phase 4.
12. **Crash/replay**: `test/crash/state-transaction.test.ts` adds settlement-bearing replay for both outcomes (same plan ⇒ same entry bytes inside committed `next_state`; no second file can drift).

## Files touched (summary)

`src/contracts/config.ts`, `src/contracts/durable-state.ts`, regenerated `src/contracts/schemas/v1/{config,task-state}.schema.json`, `src/state/approval-rules.ts` (new), `src/state/status.ts`, `src/state/next-action.ts`, `src/state/request-composition.ts`, `src/state/transitions.ts`, `src/mcp/handlers/state.ts`, `src/state/gates.ts`, `src/state/restart-authority.ts`, `src/state/implementation-manifest.ts`, `src/review/fixed-point.ts`, `src/mcp/handlers/counter-review.ts`, `src/review/pinned-context.ts`, `src/state/produce-subject.ts`, `src/state/planned-final-phase.ts` (settle-time reuse; no loader change), `assets/config.template.yaml`, targeted tests and journey fixtures, and the rebuilt `dist/` payload. There is no task-config edit, separate settlement contract/schema root, registry expansion, or machine-global installation.

## Pinned cross-chunk interfaces

1. **Helper:** `evaluateApprovalRules(config, subject, changedPaths) → {wait: boolean; match: {kind:"subject"; subject} | {kind:"content"; paths} | null}`; content evaluation only for the phase-impl subject; absent/empty rules ⇒ `{wait: false, match: null}`.
2. **Glob semantics:** whole-path, `/`-segmented, case-sensitive; `*`/`?` within a segment; `**` zero-or-more segments; no dependencies.
3. **Mapping:** `subjectGateKind` — prd→artifact-approval, design|phase-design→design-approval, phase-impl→commit-authorization (subject trigger forces the gate regardless of content rules); helper-level now, commit-boundary behavior in Phase 4.
4. **Settlement record:** `RuleSettlementV1` as in P3-4 — one state representation for both outcomes on `TaskStateV1.rule_settlements?`; dedicated comparator orders strings lexically and `settled_at_revision` numerically; `config_digest` comes from the preparation's single live-config read; eligibility = digest match + restart cutoff; latest selection compares revisions numerically.
5. **Settlement:** final-triage preparation overlays the pending result; accepted editorial/simple-revision `produce-succeeded` re-entry overlays the new subject over retained accepted-review predecessor evidence; authenticated waiver discharge uses the now-clean waived subject. The two state-handler routes assess their prospective fixed point, read config once, and pass `{subject_digest, config_digest, conclusion}` through guarded `TransitionPlanInput.rule_settlement`; the transition derives identity/revision and appends either conclusion. The waiver route never uses that carrier: authenticated gate resolution separately guards the waiver branch and calls the same pure constructor with identity/revision derived from current state. No other state transition or gate resolution may mint a settlement. This applies to all four workflow subjects.
6. **Opening:** after settlement, `advanceAction` advances document subjects only for authenticated approval or eligible `wait:false`; `wait:true` opens the gate and supplies its persisted match. It never re-evaluates mutable config for that completed step. The phase-impl commit arm and adjudication policy arm remain behaviorally untouched in this phase.
7. **Acceptance:** each applicable P3-6 consumer keeps its existing arms and accepts only a `wait:false` settlement keyed by subject digest; the gateless planned-final-phase path uses equivalent settle-time derivation. Policy adjudication and migration adoption accept no settlement as human authority.
8. **Derivation:** gateless design milestones produce the same `design_commit` fact shape from autonomous settlement + retained manifest. The `GateContext<"design-approval">` Pick shape consumed by `designArtifactCommittedAtCurrentTarget` stays unchanged, while the function's recovery-authority check gains the autonomous-settlement acceptance arm specified in P3-7.

## Success criteria

- With a subject rule matching, today's behavior: the gate opens with today's presentation and decision set, and resolves exactly as before (in-flight open gates unaffected).
- With no matching rule (document subjects): the step records `wait:false`, no `open_gate` is written, every upstream-requiring consumer works, and a gateless design milestone commits and proves from the autonomous settlement in committed state — including under a fully autonomous config where no earlier gate ever ran.
- With a matching rule, the step records `wait:true` plus the exact match, and the gate presents that persisted subject/path evidence. Rule edits made afterward are reported but do not retroactively invert or erase either outcome.
- An exact planning restart invalidates pre-restart settlements at every consumer, and byte-identical re-production re-settles at a new revision; numeric ordering remains correct across 9→10 and 99→100. A malformed phase plan fails the gateless design settle closed.
- Fresh projects under the shipped template: PRD and design stop for review; phase-design advances gatelessly (PRD criterion 3).
- Constitution policy findings still open design-approval regardless of rules; attempts-exhausted and the other exception gates are untouched and still stop (existing suites green).
- A granted constitution waiver does not cause a redundant unconditional design gate: waiver discharge records the same rule settlement, then advances or opens the ordinary triggered gate according to that persisted conclusion.
- Accepted editorial review and the allowed one-hop simple human revision cannot bypass settlement: their `produce-succeeded` re-entry records `wait:false` and advances when no rule matches, or records `wait:true` with the exact match and opens the ordinary gate.
- The phase-impl commit boundary behaves exactly as before this phase (carve-out observable in tests).
- The repository template and `dist/` support `approval_rules`, while repository `.archflow/config.yaml`, this task's config, and the machine-global installation remain untouched; task creation continues copying the compatible repository config, and re-scaffold reports `scaffold-diverged` rather than rewriting it.
- `check:schemas` is green with config/task-state regeneration only; durable contract suites are green; `dist/` is rebuilt but not installed.

## Executable verification

`npm run typecheck`; `npm run generate:schemas` (diff reviewed); `npm run check:schemas`; `npm run test:unit`; `npm run test:contracts`; `npx vitest run test/integration`; `npx vitest run test/crash`; then the dist rebuild and `npx vitest run test/integration/release-offline.test.ts`. Raw outputs transcribed to the phase verification transcript.

## Deviations from the task design (facts, not decisions)

1. **Four adjacent sites/boundaries beyond D6's original six** (verified by exploration): next-action routing, transition predicates, state-handler signals, and the deliberately human-only migration-audit boundary. The parent's D6 inventory is corrected; these are not all settlement-acceptance sites.
2. **Phase 3/4 boundary sharpened:** commit-authorization conditionality and ungated commit rendering remain Phase 4 work. Phase 3 nevertheless settles all four subjects at the enumerated atomic clean-advance seams, recording both wait and autonomous conclusions so Phase 4 can consume authority and present original path matches after config edits.
3. **composeGate needs no live rule conditional**: settlement freezes the decision; next action routes from approval/settlement state, and composeGate renders a persisted wait match. The disagreement guard remains evidence-bound while post-settlement config edits are informational.
4. **Settlement mechanics concretized and corrected by review** (P3-4/P3-5/P3-7): `rule_settlements` on `TaskStateV1` records both outcomes using a task-state-owned type/schema; separate schema and authority roots were rejected. The collection uses a numeric-aware comparator and restart eligibility; every enumerated route supplies its prospective evidence; `planned_final_phase` derives at gateless design settlement; policy adjudication and migration adoption accept no settlement as human authority.
5. **Schema surface simplified after counter-review**: `taskConfigSnapshotV1Schema` mirrors `approval_rules`, while the settlement shape stays inside the single task-state root like `BaselineAdoptionRecord`; no new schema ID, document, barrel export, or consumer registration is warranted.
6. **Self-cutover removed after counter-review** (P3-8): the active server is a separately installed bundle and may not parse the new key. Phase 3 changes the repository template and rebuilt dist only; it neither edits this task's config nor installs globally. The installed old server continues its existing gates until the user separately authorizes adoption.
7. **Prospective settlement input** (fresh same-side audit): retained evidence alone cannot see the triage result being installed. P3-5 now pins the prepared-result overlay and a structured, boundary-guarded `rule_settlement` carrier rather than passing an underspecified conclusion.
8. **Parent/interface drift corrected** (fresh same-side audit): the parent now uses the phase's path-only helper result, assigns operation/size enrichment to Phase 4, and removes duplicate matcher ownership. The earlier external-schema consumer inventory was superseded by the task-state-owned settlement shape in item 5.
9. **Wait evidence and numeric ordering corrected** (fresh draft review): one settlement record now persists both outcomes, so Phase 4 can present the original content matches after config changes; a dedicated comparator avoids lexicographic revision failures at 9→10 and 99→100.
10. **Waiver resumption corrected after counter-review**: authenticated policy-waiver discharge is a narrowly guarded settlement boundary, preventing a redundant unconditional design gate while preserving a project-requested ordinary gate.
11. **All clean-advance routes settled after counter-review**: accepted editorial review and the permitted one-hop simple revision can reach a clean fixed point at `produce-succeeded` without another triage result. P3-5 now enumerates those two re-entry shapes alongside final triage and waiver discharge, with their prospective evidence overlays and both rule outcomes tested. Because waiver resolution bypasses `planStateTransition`, it has a separate authenticated gate-resolution guard around the shared settlement constructor.
12. **Template-copy source corrected after counter-review**: task creation copies repository `.archflow/config.yaml`; Phase 3 changes only `assets/config.template.yaml` and rebuilt `dist/`. The live repository/task config remains compatible with the installed server, and re-scaffolding an initialized repository reports `scaffold-diverged` instead of silently adopting the new template.
