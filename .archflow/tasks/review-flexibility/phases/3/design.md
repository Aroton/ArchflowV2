# Phase 3 Design — Subject triggers and autonomous advancement

**Task:** review-flexibility
**Phase:** 3 of 6
**Date:** 2026-08-19
**Scope:** task design D5 (approval-rules config section + one pure evaluation helper, complete), D6 (durable rule-advance receipts accepted everywhere an approved upstream is required, plus the gateless design-milestone commit derivation), D7's document-subject share (artifact-approval and design-approval become rule-conditional; the constitution policy arm stays unconditional), D10's template share (default `approval_rules`), and the D9 self-application cutover edit to this task's own config. The commit boundary stays behaviorally unchanged in this phase: commit-authorization keeps opening unconditionally, implementation commit facts and `buildCommitAuthorizationInput` are untouched, and content-trigger presentation work stays with Phase 4 ("content triggers and the commit boundary") — the split is pinned in P3-3.
**Fact basis:** verified against the current tree (branch `feature/review-override-flexibility`, `f149e27` plus the staged phase-2 durable-state records) by three parallel exploration reports with re-checked file:line references (`.archflow/tasks/review-flexibility/scratch/phase3-upstream-acceptance.md`, `phase3-config-status-surface.md`, `phase3-durable-receipts.md`). Deltas versus the task design are in "Deviations" — items 1, 2, and 6 update the parent.

## Phase goal

Make human approval of **document subjects** (prd, design, phase-design) a targeted trigger instead of a built-in constant, and make gateless advancement durable and honest:

1. A new config section `approval_rules` (subject triggers + content-trigger rule shapes) is parsed, validated, mirrored into the durable config snapshot, and shipped active in the template with the PRD's default ruleset (PRD R5, R6 defaults for document subjects; PRD criterion 3).
2. One pure helper `evaluateApprovalRules` decides, from parsed config + workflow subject + changed paths, whether a completed step must wait for a human. Document-subject gate opening (artifact-approval, design-approval) consults it at the single status seam; the constitution policy arm and every exception gate ignore it and still stop (task design D7, PRD R4).
3. When no rule waits, the settling transaction writes a durable **rule-advance receipt** into state.json; every site that today requires an approved upstream — the task design's six plus four this design adds — accepts a receipt as the alternative authority (D6).
4. A gateless design/phase-design step derives its design-milestone commit facts from the receipt plus the retained produce manifest and advances to `commit-artifacts` instead of stalling at `inspect-state` (D6's derivation half).
5. This task's own config gains `subjects: [prd, design, phase-design, phase-impl]` (D9 switchover) so its remaining phases keep explicit human gates; the phase-impl entry is recorded and helper-tested now and becomes behaviorally load-bearing in Phase 4.

## Requirements mapped to this phase

| Source | Requirement |
|--------|-------------|
| PRD R4 (phase share) | After counter-review completes, rule evaluation decides proceed-or-wait for document subjects; counter-review itself always runs; exception/safety gates untouched and not rule-conditional. |
| PRD R5 | Two declarative rule kinds in per-project config (the same surface R1/R2 made editable); machine-evaluated; constitution policy-base pinning unchanged. |
| PRD R6 (document share) | Fresh projects gate the PRD and the architecture/design under the shipped defaults (PRD criterion 3); the SQL content default ships in the template and is inert until Phase 4 activates the commit boundary. |
| Task design D5 | `approval_rules` schema in config; one pure helper with self-contained glob matcher; subject-to-gate-kind mapping incl. phase-impl→commit-authorization; content rules apply to phase-impl changed paths only; single evaluation point; disagreement guard extension. |
| Task design D6 | `RuleAdvanceV1` receipt written in the settling transaction; all approval-requiring sites accept receipts; `planned_final_phase` derives from design approval or design receipt; gateless design milestones compose commit facts from receipt + produce manifest. |
| Task design D7 (document share) | composeGate opens artifact/design approval only on a rule wait; policy arm (unsatisfied constitution findings, failing/uncertain rule, eligible waivers) opens regardless; presentations unchanged in this phase. |
| Task design D9 (cutover step only) | Add the full subject list to this task's own config; note it in the implementation notes. The constitution amendment itself is Phase 5. |
| Task design D10 (template share) | `assets/config.template.yaml` ships `approval_rules` with `subjects: [prd, design]` and the SQL content example. |

## Context — what exists today (verified)

- **The single gate-opening decision lives in `advanceAction`, not `composeGate`.** `src/state/next-action.ts:167` opens the phase-kind's approval gate unconditionally when no matching approval exists (`requiredKind`: design/phase-design→design-approval, prd→artifact-approval, phase-impl→commit-authorization; `matchingApproval` keyed by `subject_digest`; legacy-design and migration approvals exempt at `:167`). The semantic view requests a `gate-summary` only when `next_action` is `open-gate`, and `composeGate` (`src/state/request-composition.ts:509-731`, kind derivation `:547-552`) is reached only through that offer — suppressing the open-gate action naturally bypasses gate composition. A second, separate design-approval open exists in the adjudication-gate branch (`next-action.ts:401-405`); that is the constitution policy arm.
- **The status computation already assembles everything the helper needs.** `computeTaskStatusDetailedInternal` (`src/state/status.ts:712-1286`) reads and parses live config (`:748-762`), computes the phase-1 `config_change` notice (`:776-782`), loads the current produce subject with retained manifest (`:843-864`), authenticates approvals (`:866-900`), derives implementation (`:902-941`) and design (`:942-1019`) commit facts, and makes exactly one `deriveNextAction({...})` call (`:1188-1212`) — parsed config, subject kind (`decodePhaseInstance(state.phase_instance).kind`), subject digest, and changed paths (`produceSubject.artifact.outputs[].path`, renames' `previous_path`; document subjects' fixed paths via `.retained.manifest.value.outputs`) are all in hand at that call. `gate_input` is built only for `open-gate` + commit-authorization (`:1214-1227`).
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
  10. Migration-audit opening's `traditionallyApproved` check (`src/state/gates.ts:384-391`) — an import-path exception gate; receipts deliberately do **not** apply there (see P3-6).
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

### P3-2 — One evaluation point, one shared context assembly

- `computeTaskStatusDetailedInternal` evaluates the helper once at the existing `deriveNextAction` seam (`status.ts:1188-1212`) and passes the conclusion into `NextActionInput` as `rule_conclusion?: ApprovalRuleConclusion` (computed whenever a produce subject exists). A tiny shared builder `approvalRuleContext(state, produceSubject, parsedConfig)` in `approval-rules.ts` assembles `{subject, changedPaths, config}` so status, the composeGate guard mirror, and the settling transaction (P3-5) cannot drift apart — the same pattern as the guard's existing mirror.
- `composeGate` needs **no conditional of its own**: it is reachable only through an `open-gate` offer that `advanceAction` (P3-3) already made rule-conditional. The task design's "composeGate conditional" is realized at the `advanceAction` seam; composeGate inherits. The disagreement guard is extended so the mirrored computation includes the rule conclusion — a config edit between the status call and the gate apply surfaces as `gate-fixed-point-disagreement` (client retries; the new config governs), exactly the fail-safe the guard exists for.

### P3-3 — Gate opening becomes rule-conditional for document subjects; the commit boundary waits for Phase 4

`advanceAction` (`next-action.ts:167`) changes from "phase-kind approval absent ⇒ open-gate" to: for **prd, design, phase-design**, open the phase-kind's gate iff `rule_conclusion.wait`; otherwise fall through to the existing advance/commit branches — no new action shapes, the ungated flow is the existing fall-through. The **phase-impl arm is deliberately unchanged** in this phase: commit-authorization keeps opening unconditionally, implementation commit facts, `buildCommitAuthorizationInput`, `committedOutput`, and the commit action stay as today.

- Rejected alternative — flip all three kinds now: it pulls Phase 4's commit-boundary machinery (implementation commit facts without a gate, `committedOutput` receipt acceptance, ungated commit rendering, R7 presentation) forward into the phase that also lands receipts across ten acceptance sites, enlarging the blast radius on the very commit path this task uses to commit itself; and the task design's own file allocation places `buildCommitAuthorizationInput` rule-driven, commit-authorization conditional, and the ungated commit flow in Phase 4. The cost of staging is one temporary condition (`requiredKind !== "commit-authorization"`) removed by Phase 4.
- The adjudication-gate branch's design-approval open (`next-action.ts:401-405`) — the **policy arm** — is untouched: unsatisfied constitution findings, a failing or uncertain rule, or eligible waivers open design-approval regardless of any subject rule (D7, R4). `resolveAdjudicationGateStep` needs no edit: it already returns `adjudication-gate` only when policy findings exist; the policy-clean path flows to the now rule-conditional `advanceAction`. Deadlock is impossible — the fixed point's adjudication acceptance points are unchanged and the policy arm opens the gate that discharges them.

### P3-4 — `RuleAdvanceV1`: dual representation like approvals, restart-aware, additive

New contract module `src/contracts/durable-rule-receipt.ts` (type aliases + Zod; registered via `SCHEMA_IDS` in `src/contracts/versions.ts`, a durable-group `SchemaDocumentPlan` in `schema-generation-durable.ts`, barrel export):

```ts
type RuleAdvanceOutcome =
  | { kind: "none" }
  | { kind: "subject"; subject: WorkflowSubject }
  | { kind: "content"; paths: readonly string[] };
type RuleAdvanceV1 = {
  task_id: string; phase_instance: string; step: string;
  subject_digest: Sha256Digest; rule_outcome: RuleAdvanceOutcome;
  config_digest: Sha256Digest; settled_at_revision: number;
};
```

Receipts have **one durable representation**: the state entry on `TaskStateV1.rule_advances?: readonly RuleAdvanceV1[]` (the `baseline_adoptions` pattern: type alias + Zod + sorted-unique refine + `settled_at_revision ≤ revision` superRefine), written by the kernel's own state commit — one atomic write, no second file, no crash window. Recovery authority for a gateless milestone is the receipt entry inside the **committed `state.json`**, which the milestone proof already requires in the commit (`implementation-manifest.ts:280`) and reads as a blob (P3-7); a milestone can reconstruct durable state from the commit alone without any record file. (Counter-review revision: an `authority/rule-advances` record file was considered and withdrawn — the kernel's plan allowlist (`materializePlan`, `transaction.ts:583-596`) admits no authority-record slot and the transition planner is pure, so no seam could write such a record atomically with the state entry, and an out-of-band write would crash into exactly the recovery wedge it existed to prevent.)

- **Sorted-unique key is the triple `(phase_instance, subject_digest, settled_at_revision)`**, not the pair: a planning restart that ends in byte-identical re-production legally re-settles the same `(phase_instance, subject_digest)` at a new revision, and a pair key would fail the settling transaction on its own invariant (receipts survive restarts verbatim — `transitions.ts:129-149` spreads `...preserved`, and exact-restart drafts expect exactly that). Acceptance sites read the **latest eligible** receipt for the subject, mirroring how approvals read the latest `resolved_at_revision` winner.
- **Eligibility is digest-bound AND restart-scanned**: a receipt satisfies a site only while its `subject_digest` equals the digest being checked *and* it passes a restart cutoff. Digest binding alone is not equivalent to `approvalIsEligibleAfterLatestRestart` (`src/state/restart-authority.ts:26-33`) in the identical-bytes restart case — a surviving digest-matching receipt would auto-authorize the restarted subject during the reconsideration window where the approval arm deliberately fails closed. `restart-authority.ts` therefore gains `ruleAdvanceIsEligibleAfterLatestRestart` beside the approval filter (same `latestRestartRevisionAffectingPhase` scan over the receipt's `settled_at_revision`), and the digest-bound rule remains as the second, subject-binding half. Every acceptance site applies both.
- `config_digest` is the **live** config digest observed by the settling preparation's own single config read (P3-5), never the creation-time pinned one. Receipts join no retained-result graph and no fingerprint composition.
- Receipts are **additive**: every acceptance site keeps its existing approval/import arms unchanged and gains a receipt arm; in-flight tasks and open gates are unaffected (archived parsers untouched).

### P3-5 — The receipt is written by the settling transaction of the step's final review substep

Today: triage settles via the `archflow_state` handler (`state.ts:518` → `planStateTransition`), then a gate opens separately. Gateless: the settling preparation evaluates the rules **itself, from one config read it performs** — the kernel's `prepare` callback (`transaction.ts:1164-1230`) receives only `(current, call)` and never sees `liveIdentification`'s snapshot (that flows into `buildPlan` for `withLastSeenConfig`), so the settle path does its own `read_config` + parse and derives **both** the rule conclusion and the receipt's `config_digest` from that single read. No kernel signature changes; `transaction.ts` is untouched. At settle time only subject triggers are evaluated — the settling subjects in this phase are documents, and content rules apply to phase-impl changed paths only (P3-1), so `changedPaths` plays no role here.

**The fixed-point condition is a specified evidence determination, not an assumption** (counter-review revision): the preparation assembles the same evidence the composeGate disagreement-guard mirror assembles — retained evidence set, resolved constitution, upstream digests, authenticated approvals — and runs the same assessment; the receipt is written only when that assessment reaches the clean-advance path **with no pending adjudication gate** (`resolveAdjudicationGateStep` empty: unsatisfied constitution findings, a failing or uncertain rule, or eligible waivers ⇒ no receipt, and the post-settle status advertises the policy-arm design-approval gate instead, per P3-3). The receipt then substitutes for a human approval at the phase-exit predicates, so the condition that mints it must be exactly the condition under which the fixed point would otherwise demand only that approval.

With the fixed point clean and the conclusion `wait: false`, the same transaction appends the receipt entry (`TransitionPlanInput` gains the conclusion; draft assembly `transitions.ts:530-545` appends the frozen sorted-set entry). If the conclusion is `wait: true`, no receipt is written and the post-settle status advertises `open-gate` exactly as today — the settle-time evaluation is authoritative for the receipt, the status-side evaluation governs what the client is offered next, and a config edit between the two is resolved by whichever view the client acts on (settle first: the receipt stands, mirroring how an approval stays valid across later config edits; no gate yet: the next status re-advertises per the new config). A config edit between settle and advance changes nothing — the step already settled. Crash/replay: the receipt rides the kernel's existing idempotent plan replay (same plan ⇒ same appended entry bytes).

### P3-6 — Receipt acceptance at every approval-requiring site

Each site gains one arm: "or the latest eligible `rule_advances` entry for the subject — `subject_digest` matching the digest being checked, `phase_instance` naming the producing step's instance, and passing the restart cutoff (P3-4)". Sites:

1. `currentApprovedUpstreams` (`status.ts:487-528`, seam `:524`) — receipt alongside the approval arm; also fixes the status blocker path.
2. `requireApprovedUpstreamDigests` (`fixed-point.ts:586-602`) — receipts as an alternative accepted-ref population. `adjudicationGateSatisfied` (`:332-375`) is **not** receipt-extended: constitution-review adjudication is still discharged only by a human design-approval/migration-audit or waiver — a receipt never discharges policy findings (D7's honest split; the policy-clean path never reaches it).
3. `deriveApprovedUpstreams` (`counter-review.ts:122-203`, seam `:193`) — receipt-only upstreams render into pinned context like approved ones.
4. `assembleUpstreamContext` (`pinned-context.ts:250-305`, seam `:261-266`).
5. `loadProduceUpstreamSubject` (`produce-subject.ts:82-175`, owner filter `:110-118`) — receipt-owning retained manifests count as owned; the chokepoint for 1 and 4.
6. **`planned_final_phase` is derived and validated at the gateless design settle, not in `loadApprovedDesignFinalPhase`.** That loader (`planned-final-phase.ts:50-87`) is called only from gate resolution (`gates.ts:763,789,820-830`) — paths that never execute gatelessly — so attaching the receipt arm there would be dead code. Instead, the settling transaction of a gateless **design**-phase step runs the same derivation and the same validation the gate performs today: `plannedFinalPhaseFromDesign` over the retained design.md payload, hard-failing the settle on the existing `approved-design-phase-count-invalid` grammar when the phase plan is malformed (today the design-approval gate refuses; gatelessly the settle refuses — the client fixes design.md and re-runs, an honest non-success with a safe next action rather than the silent absent bound that `plannedFinalPhaseFromRecordedPayloads` preserves at produce time). A valid bound is recorded in the same transaction as the receipt. `loadApprovedDesignFinalPhase` keeps its approval arm unchanged for gated flows.
7. `matchingApproval` (`next-action.ts:138-175`) — a receipt keyed to the current subject digest counts as "decided" for the document kinds, so a re-read status after settlement keeps advancing (no re-open loop).
8. Transition predicates (`transitions.ts:197-225`, `253-266`, `463-474`) — artifact/design phase-exit accepts receipt + observed milestone commit exactly as it accepts approval + observed commit. The phase-impl `committedOutput` predicate (`:395-459`) is untouched (P3-3).
9. The `archflow_state` handler signal blocks (`state.ts:387-517`) — build completion/phase-exit signals from approval **or** receipt, feeding the same `planStateTransition`.
10. Migration-audit's `traditionallyApproved` (`gates.ts:384-391`) — **no receipt arm**: legacy import adoption is an exception gate whose authority is deliberately human; a receipt never substitutes (documented).

### P3-7 — Gateless design milestones derive commit facts from receipt + manifest, with receipt recovery authority

In `status.ts:942-1019`, beside the authenticated design-approval and migration-audit arms, a third arm authors the same facts when a design/phase-design receipt (digest-matched, restart-eligible) exists: `commit_message` from the existing milestone grammar, `target_ref` from `currentTargetRef`, `baseline_commit` from HEAD, `authorized_document_paths` from the retained produce manifest's document projections — reusing `buildDesignApprovalInput`'s authoring and the `designArtifactCommittedAtCurrentTarget` context type unchanged (it already accepts exactly these fields). `advanceAction` (`next-action.ts:176-194`) needs no change: the facts exist, so `commit-artifacts` is offered instead of `inspect-state`.

**The commit proof gains one acceptance arm, and the receipt's recovery authority is the committed state entry itself.** Today `designArtifactCommittedAtCurrentTarget` (`implementation-manifest.ts:273-284`) requires the milestone commit to contain `state.json` plus an archived decisions `request.json`/`decision.json` pair, and a gateless milestone — which produces no gate decisions — would fail `missing-recovery-authority`, a blocking miss that routes to a permanent `inspect-state` (`next-action.ts:179-188`: "running it again cannot resolve this"). A fully autonomous configuration (no document subjects — the PRD's flagship ruleset) would therefore wedge irrecoverably on its *first* gateless milestone. The fix: the recovery-authority check accepts **either** the decisions pair (gated milestones) **or** — for a gateless milestone, whose expected receipt the caller passes into the context — a read of the committed `state.json` blob (already required in the commit at `:280`) that parses and contains an eligible `rule_advances` entry matching the expected `(phase_instance, subject_digest)`. One atomic durable write produced the receipt (the kernel's own state commit); there is no second file and no crash window. Observation semantics — baseline, direct parent, exact message, task-scoped paths, document after-images — are otherwise unchanged.

### P3-8 — Template defaults and the D9 cutover

- `assets/config.template.yaml` ships (D10):

```yaml
approval_rules:
  subjects: [prd, design]
  content:
    - paths: ["**/*.sql"]
```

The content entry is the shipped default ruleset (R6) and is behaviorally inert until Phase 4 activates the commit boundary (P3-1/P3-3); document-subject behavior under these defaults is exactly PRD criterion 3. `init-assets.test.ts` self-adapts to the template edit.
- **Cutover (implementation-time, in Phase 3's own impl session):** add `approval_rules: {subjects: [prd, design, phase-design, phase-impl], content: [{paths: ["**/*.sql"]}]}` to `.archflow/tasks/review-flexibility/config.yaml`, and refresh that file's stale pre-phase-1 header (it still claims config is byte-pinned and uneditable) to the editable-config wording. The edit is a reported config change under the phase-1 machinery (notice in the next status; harmless to legacy evidence via the D2 recorded-digest fallback). The phase-impl subject entry is inert in this phase (commit-authorization still opens unconditionally — P3-3) and becomes load-bearing when Phase 4 lands; the phase-design entry keeps this task's Phase 4+ designs gated from the very next session. Record the edit in the implementation notes (D9).

## Work chunks

Five chunks plus the verification sweep; A is contracts, B is the helper (independent of A's durable mirror, consumes A's config schema), C is the opening seam (depends on A+B), D is settlement and acceptance (depends on A+B, parallel to C), E is template/cutover and journeys (depends on C+D).

### Chunk A — Contracts, schemas, schema registration

- `src/contracts/config.ts`: `approval_rules` section (`subjects` enum array + `content: [{paths: string[]}]`, `.strict()`, optional).
- `src/contracts/durable-rule-receipt.ts` (new): `RuleAdvanceV1` + outcome union; register in `versions.ts` `SCHEMA_IDS`, `schema-generation-durable.ts`, `src/contracts/index.ts`.
- `src/contracts/durable-state.ts`: mirror `approval_rules` into `taskConfigSnapshotV1Schema` (parentless clones); `TaskStateV1.rule_advances?` + Zod mirror + sorted-set refine (triple key, P3-4) + revision bound.
- `npm run generate:schemas`; review the diff (config, task-state, new rule-advance files).

### Chunk B — The evaluation helper

- `src/state/approval-rules.ts` (new): `evaluateApprovalRules`, the glob matcher, `subjectGateKind` mapping table, `approvalRuleContext` shared assembly.

### Chunk C — Conditional opening and the advance surface

- `src/state/status.ts`: evaluate once at the `deriveNextAction` seam; `rule_conclusion` into `NextActionInput`.
- `src/state/next-action.ts`: `advanceAction` document-subject rule condition (P3-3 carve-out); `matchingApproval` receipt arm (P3-6.7).
- `src/state/request-composition.ts`: guard mirror extension only (P3-2).

### Chunk D — Receipts: settlement and acceptance

- `src/state/transitions.ts`: `TransitionPlanInput` conclusion field; receipt entry append in draft assembly; artifact/design phase-exit predicates accept receipts; gateless design settle derives and validates `planned_final_phase` (P3-6.6).
- `src/mcp/handlers/state.ts`: signal blocks approval-or-receipt (P3-6.9); the settle-time single config read, the fixed-point evidence assembly, and the rule evaluation (P3-5).
- `src/state/restart-authority.ts`: `ruleAdvanceIsEligibleAfterLatestRestart` beside the approval filter (P3-4).
- `src/state/status.ts`: `currentApprovedUpstreams` receipt arm (P3-6.1); design-milestone facts arm (P3-7).
- `src/state/implementation-manifest.ts`: the recovery-authority arm of `designArtifactCommittedAtCurrentTarget` — decisions pair, or the committed `state.json` blob containing the expected eligible receipt entry (P3-7).
- `src/review/fixed-point.ts`: `requireApprovedUpstreamDigests` receipt arm (P3-6.2; `adjudicationGateSatisfied` untouched).
- `src/mcp/handlers/counter-review.ts`: `deriveApprovedUpstreams` receipt arm (P3-6.3).
- `src/review/pinned-context.ts`: `assembleUpstreamContext` receipt arm (P3-6.4).
- `src/state/produce-subject.ts`: owner filter receipt arm (P3-6.5).
- `src/state/planned-final-phase.ts`: the settle-time derivation reuses `plannedFinalPhaseFromDesign` unchanged; `loadApprovedDesignFinalPhase` keeps its approval arm only.

### Chunk E — Template, cutover, journeys

- `assets/config.template.yaml` defaults; the cutover edit to this task's config (P3-8; implementation-time).
- Journey/integration tests below; fixture adaptations for document-gate suites.

### Chunk F — Verification sweep and bundle

- Full gates (below); rebuild the tracked `dist/` payload (`release:stage`/`release:write`) — src/schema bytes are bundle inputs; stale bundle fails `release-offline`.

## Tests

1. **Helper unit (new `test/unit/approval-rules.test.ts`)**: subject match/no-match per subject; empty and absent `approval_rules` ⇒ autonomous; content rules evaluated for phase-impl only (a `**/*.md` rule does not fire on a design doc); glob semantics (`**` zero-or-more segments incl. `**/*.sql` matching root `a.sql`; `*`/`?` within a segment; trailing `/**`; case sensitivity); `subjectGateKind` mapping incl. phase-impl→commit-authorization force rule.
2. **Contract tests**: schema-registry counts/bijection (+1 id); durable-contract-surface module/stem lists; durable-state-validation optional-field combination (receipts valid/invalid: bad revision bound, duplicate `(phase_instance, subject_digest)`); structural corpus array paths + `$def` inventory; semantics-corpus rejections for receipt invariants; foundational config agreement valid/invalid `approval_rules` cases.
3. **Upstream acceptance at every P3-6 site** (extend the suites that pin each): receipt-only upstream dispatch renders pinned context and passes `requireApprovedUpstreamDigests` (counter-review-pinned-context integration); `loadProduceUpstreamSubject` accepts a receipt-owning manifest; `currentApprovedUpstreams` returns receipt-satisfied digests; `planned_final_phase` derives from a design receipt; transitions' artifact/design phase-exit moves with receipt + observed milestone commit; migration-audit site unchanged (receipt does not satisfy `traditionallyApproved`).
4. **Conditional opening**: `state-next-action.test.ts` — the `:372` "requires the phase-specific approval before advancing" table splits: document kinds open only with a matching subject rule (and advance with a receipt); phase-impl still opens unconditionally (carve-out pinned, so Phase 4's removal is observable); `matchingApproval` receipt arm prevents re-open loops.
5. **Policy-arm split (D7 test)**: constitution rule failing/uncertain + no subject rule ⇒ design-approval still opens (adjudication-gate branch); clean adjudication + no subject rule ⇒ advances with a receipt and no gate.
6. **Gateless document journeys**: (a) template-default config — a phase-design step completes review, settles with a receipt (assert the state entry), derives design-milestone commit facts from receipt + manifest, offers `commit-artifacts`, and the milestone commit observation — including the receipt recovery-authority arm (expected entry found in the committed `state.json` blob) — advances the phase, never `inspect-state`; assert no `open_gate` write occurs on the gateless path. (b) **fully autonomous config** (`approval_rules` with no document subjects): the *first* gateless milestone commits and proves — the wedge case the recovery-authority arm exists to prevent.
7. **Fresh-project defaults (PRD criterion 3)**: template-configured task — first PRD and the design each stop at their approval gate with no project-specific rules added; a phase-design subject (not in defaults) advances gatelessly.
8. **Guard**: a config edit between status and gate apply (or a doctored mirror input) yields `gate-fixed-point-disagreement`, not a silently different conclusion.
9. **Restart and idempotence semantics**: an exact planning restart (byte-identical re-production) re-settles the same `(phase_instance, subject_digest)` at a new revision without violating the sorted-set invariant (triple key); the pre-restart receipt is ineligible across the restart cutoff at every acceptance site until the re-settle writes a fresh one; latest-eligible receipt wins when several exist.
10. **Gateless settle fixed-point determination**: a design settle with an unsatisfied constitution gate (pending adjudication findings) writes **no** receipt and the phase-exit predicate refuses the crossing — the policy arm still opens design-approval. A design whose phase-plan headings are malformed fails its gateless settle closed (phase-count grammar error surfaced, no receipt, no `planned_final_phase`) — the gateless replacement for today's gate refusal.
11. **Existing suites adapted**: `semantic-document-journeys` phase-design legs add explicit `subjects: [phase-design]` (template defaults no longer gate phase-design); **`test/helpers/semantic-journeys.ts` `reachImplementationHandoff` and the two implementation journey suites it feeds** get an explicit fixture config listing the document subjects, so the walked prd/design/phase-design tiers still gate under the new template defaults (the phase-design tier would otherwise advance gatelessly and the helper's gate-summary apply would fail); `status-reentry-edit`/`config-editing` fixtures keep prd gated by default; `semantic-composition-parity` composeGate mirror updated; `state-transitions` crossing rules receipt-extended; `semantic-actions`/`semantic-view` status fixtures gain `rule_conclusion`; `init-assets` self-adapts. Phase-impl commit-authorization *semantics* are unchanged — only the journey fixtures' config bytes change.
12. **Crash/replay**: `test/crash/state-transaction.test.ts` extended with one receipt-bearing replay (same plan ⇒ same receipt entry bytes inside the committed `next_state`; no second file exists to drift).

## Files touched (summary)

`src/contracts/config.ts`, `src/contracts/durable-rule-receipt.ts` (new), `src/contracts/durable-state.ts`, `src/contracts/versions.ts`, `src/contracts/internal/schema-generation-durable.ts`, `src/contracts/index.ts`, regenerated `src/contracts/schemas/v1/{config,task-state,rule-advance}.schema.json`, `src/state/approval-rules.ts` (new), `src/state/status.ts`, `src/state/next-action.ts`, `src/state/request-composition.ts`, `src/state/transitions.ts`, `src/mcp/handlers/state.ts`, `src/state/restart-authority.ts`, `src/state/implementation-manifest.ts`, `src/review/fixed-point.ts`, `src/mcp/handlers/counter-review.ts`, `src/review/pinned-context.ts`, `src/state/produce-subject.ts`, `src/state/planned-final-phase.ts` (settle-time reuse; no loader change), `assets/config.template.yaml`, `.archflow/tasks/review-flexibility/config.yaml` (cutover), plus ~9 new/extended test files (incl. `test/helpers/semantic-journeys.ts` fixture config) and the rebuilt `dist/` payload. ~22 hand-written files including tests — above the ~10–15 signal, inherent to D6's ten-site acceptance reach plus the milestone-recovery and restart-eligibility seams review surfaced; the task design's own Phase 3 list carried 14 + tests, and the remainder is Deviations 1 and 4.

## Pinned cross-chunk interfaces

1. **Helper:** `evaluateApprovalRules(config, subject, changedPaths) → {wait: boolean; match: {kind:"subject"; subject} | {kind:"content"; paths} | null}`; content evaluation only for the phase-impl subject; absent/empty rules ⇒ `{wait: false, match: null}`.
2. **Glob semantics:** whole-path, `/`-segmented, case-sensitive; `*`/`?` within a segment; `**` zero-or-more segments; no dependencies.
3. **Mapping:** `subjectGateKind` — prd→artifact-approval, design|phase-design→design-approval, phase-impl→commit-authorization (subject trigger forces the gate regardless of content rules); helper-level now, commit-boundary behavior in Phase 4.
4. **Receipt:** `RuleAdvanceV1` as in P3-4 — one durable representation, the state entry on `TaskStateV1.rule_advances?` sorted-unique by `(phase_instance, subject_digest, settled_at_revision)`, written by the kernel's own state commit; recovery authority for a gateless milestone is that entry read from the committed `state.json` blob; `config_digest` is the live digest of the settling preparation's own single config read; eligibility = digest match AND restart cutoff (`ruleAdvanceIsEligibleAfterLatestRestart`); latest eligible wins.
5. **Settlement:** the receipt is appended by the settling transaction of the step's final review substep when the settle-path evidence assembly — the same retained-evidence/constitution/upstream/authenticated-approval assembly the composeGate guard mirror performs — reaches the clean-advance path with no pending adjudication gate, and the settle-path rule evaluation (one config read inside the preparation, subject triggers only) concludes `wait: false`; the settle-time evaluation is authoritative for the receipt, the status seam governs what the client is offered next.
6. **Opening:** `advanceAction` opens document-subject gates iff `rule_conclusion.wait`; `NextActionInput.rule_conclusion?` is computed once at the status seam via `approvalRuleContext`; the phase-impl arm and the adjudication-gate policy arm are untouched in this phase.
7. **Acceptance:** every P3-6 site keeps its existing arms and adds one receipt arm keyed by subject digest; `adjudicationGateSatisfied` and migration-audit's `traditionallyApproved` accept no receipts.
8. **Derivation:** gateless design milestones produce the same `design_commit` fact shape from receipt + retained manifest, proven by the unchanged `designArtifactCommittedAtCurrentTarget`.

## Success criteria

- With a subject rule matching, today's behavior: the gate opens with today's presentation and decision set, and resolves exactly as before (in-flight open gates unaffected).
- With no matching rule (document subjects): the step settles with a receipt (state entry in state.json), no `open_gate` is written, every upstream-requiring consumer of that document works (counter-review pinned context, status assessment, produce-subject loading, planned final phase at the design settle), and a gateless design milestone commits, proves (the expected receipt entry read from the committed `state.json` blob, per P3-7), and advances — including under a fully autonomous config where no earlier gate ever ran.
- An exact planning restart invalidates pre-restart receipts at every acceptance site (restart cutoff), and byte-identical re-production re-settles cleanly at a new revision. A malformed phase plan fails the gateless design settle closed instead of silently advancing with no final-phase bound.
- Fresh projects under the shipped template: PRD and design stop for review; phase-design advances gatelessly (PRD criterion 3).
- Constitution policy findings still open design-approval regardless of rules; attempts-exhausted and the other exception gates are untouched and still stop (existing suites green).
- The phase-impl commit boundary behaves exactly as before this phase (carve-out observable in tests).
- The cutover edit lands in this task's config, is visible as a `config_change` notice, and keeps this task's phase-design gates opening from the next session.
- `check:schemas` green with the regenerated/added schemas; durable contract suites green; `dist/` rebuilt.

## Executable verification

`npm run typecheck`; `npm run generate:schemas` (diff reviewed); `npm run check:schemas`; `npm run test:unit`; `npm run test:contracts`; `npx vitest run test/integration`; `npx vitest run test/crash`; then the dist rebuild and `npx vitest run test/integration/release-offline.test.ts`. Raw outputs transcribed to the phase verification transcript.

## Deviations from the task design (facts, not decisions)

1. **Four acceptance sites beyond D6's six** (verified by exploration): `advanceAction`/`matchingApproval` (`next-action.ts:138-175`), the transition predicates (`transitions.ts:197-225`, `253-266`, `395-422`, `463-474`), the `archflow_state` handler's signal blocks (`state.ts:387-517`), and — as a consciously untouched boundary — migration-audit's `traditionallyApproved` (`gates.ts:384-391`), which accepts no receipts. The parent's D6 list is extended in the same production result.
2. **Phase 3/4 boundary sharpened:** commit-authorization conditionality, `buildCommitAuthorizationInput` becoming rule-driven, implementation commit facts without a gate, and the ungated-commit rendering are Phase 4 work — matching the parent's own file allocation — realized by one temporary carve-out in `advanceAction` (P3-3). The helper (incl. content matching and the phase-impl mapping) is complete and unit-pinned now. The parent's Phase 3 test mention of "a phase-impl subject trigger forcing commit-authorization" is satisfied helper-level in this phase and behaviorally in Phase 4; its Phase 4 list gains nothing new.
3. **composeGate needs no conditional** (P3-2): the opening decision is upstream at `advanceAction`; composeGate is reachable only through an open-gate offer, and the disagreement-guard mirror extension carries the rule conclusion. The parent's "composeGate conditional for artifact/design approval" is realized at the `advanceAction` seam with the guard extension named.
4. **Receipt mechanics concretized and corrected by review** (P3-4/P3-5/P3-7): `rule_advances` on `TaskStateV1` in a new `durable-rule-receipt.ts` contract module with schema registration, written by the settling transaction of the final review substep — **one durable representation only** (a counter-review-proposed `authority/rule-advances` record file was withdrawn: the kernel's plan allowlist admits no such slot and the planner is pure, so no seam could write it atomically; recovery authority is instead the receipt entry read from the committed `state.json` blob by the milestone proof), a triple sorted-unique key (an exact restart re-settles the same pair at a new revision), restart-cutoff eligibility in `restart-authority.ts` (digest binding alone under-cuts the approval arm's fail-closed reconsideration window), and a specified settle-path fixed-point determination (the guard-mirror evidence assembly, clean-advance path, no pending adjudication gate — a receipt never precede satisfied adjudication). The settle-path evaluation reads config once inside the preparation (`prepare` cannot see `liveIdentification`'s snapshot; the kernel is untouched). `planned_final_phase` is derived and validated at the gateless design settle rather than in `loadApprovedDesignFinalPhase` (whose call sites never execute gatelessly). `adjudicationGateSatisfied` accepts no receipts (constitution findings stay human-dischargeable only) — an explicit boundary within D6's "all six acceptance points" wording, which named `requireApprovedUpstreamDigests`, not adjudication satisfaction. The parent's D6 bullet carries these refinements.
5. **Schema-surface additions the parent's file list implied but did not name**: the `taskConfigSnapshotV1Schema` mirror for `approval_rules` (durable-state.ts), and the registration files (`versions.ts`, `schema-generation-durable.ts`, `contracts/index.ts`) for the new contract.
6. **Cutover scope** (P3-8): besides adding `approval_rules`, the cutover refreshes this task's config header, which still describes the removed byte-pinning model — the parent's D9 switchover step names only the subjects addition; the stale-text fix rides along in the same edit.
