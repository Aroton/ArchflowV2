# Phase 3 Design — Subject rules and durable settlements

**Task:** review-flexibility
**Phase:** 3 of 6
**Date:** 2026-08-19
**Scope:** task design D5 (approval-rules config and one pure evaluator), the durable-evaluation portion of D6, D7's persisted document-trigger presentation, and D10's repository template defaults. Autonomous document advancement and settlement-as-approval consumption are deliberately dormant until Phase 5 first amends this repository's active `explicit-human-authority` rule. The task-config self-cutover remains excluded: the separately installed machine-global bundle may not be updated without an explicit user request.
**Fact basis:** verified against the committed baseline (`956018b`; uncommitted implementation bytes excluded) through focused interface, verification, and fresh draft audits. The original durable exploration remains in `.archflow/tasks/review-flexibility/scratch/`; current corrections and parent updates are enumerated in "Deviations."

## Phase goal

Lay the durable foundation for targeted approval of **document subjects** (prd, design, phase-design) without weakening the repository's currently active human-authority boundary:

1. A new config section `approval_rules` (subject triggers + content-trigger rule shapes) is parsed, validated, mirrored into the durable config snapshot, and shipped active in the template with the PRD's default ruleset (PRD R5, R6 defaults for document subjects; PRD criterion 3).
2. One pure helper `evaluateApprovalRules` decides, from parsed config + workflow subject + changed paths, whether a completed step must wait for a human. The clean-advance transaction that first establishes the completed fixed point evaluates it once and durably records the conclusion; later status calls route from that settled authority rather than re-deciding the completed step from mutable config. The constitution policy arm and every exception gate ignore approval rules and still stop (task design D7, PRD R4).
3. The settling transaction writes a durable **approval-rule settlement** into state.json for both outcomes. A wait settlement retains its exact trigger match for the human presentation. In this phase neither outcome substitutes for explicit human document approval, upstream approval, phase-exit authority, or milestone-commit authority.
4. A human-requested simple revision is always returned for approval of the final bytes and never mints a rule settlement. It also cannot erase an accepted material review finding; such a finding requires a significant revision and fresh review.
5. The repository template gains the new defaults, but this task's live config remains unchanged. The separately installed pre-cutover server continues enforcing its existing default gates for this in-flight task; adopting a rebuilt bundle is a distinct user-authorized operation outside this phase design.

## Requirements mapped to this phase

| Source | Requirement |
|--------|-------------|
| PRD R4 (phase share) | After counter-review completes, rule evaluation decides proceed-or-wait for document subjects; counter-review itself always runs; exception/safety gates untouched and not rule-conditional. |
| PRD R5 | Two declarative rule kinds in per-project config (the same surface R1/R2 made editable); machine-evaluated; constitution policy-base pinning unchanged. |
| PRD R6 (document share) | Fresh projects gate the PRD and the architecture/design under the shipped defaults (PRD criterion 3); the SQL content default ships in the template and is inert until Phase 4 activates the commit boundary. |
| Task design D5 | `approval_rules` schema in config; one pure helper with self-contained glob matcher; subject-to-gate-kind mapping incl. phase-impl→commit-authorization; content rules apply to phase-impl changed paths only; one authoritative evaluation at the first enumerated clean-advance transaction boundary. |
| Task design D6 | `RuleSettlementV1` records both evaluated outcomes at enumerated clean fixed points; the wait arm preserves trigger evidence. Settlement consumption as autonomous authority is deferred until the governing constitution is explicitly revised. |
| Task design D7 (document share) | Artifact/design approval remains mandatory in this phase. When a persisted wait match exists, its subject/path trigger is included in the ordinary human presentation; the policy arm remains unconditional. |
| Task design D9 (self-application correction) | Do not add an unsupported key to this task's live config while the separately installed server is old. The constitution amendment remains Phase 5; any bundle adoption remains a distinct, explicitly user-authorized action. |
| Task design D10 (template share) | `assets/config.template.yaml` ships `approval_rules` with `subjects: [prd, design]` and the SQL content example. |

## Context — what exists today (verified)

- **The single gate-opening decision lives in `advanceAction`, not `composeGate`.** `src/state/next-action.ts:167` opens the phase-kind's approval gate unconditionally when no matching approval exists (`requiredKind`: design/phase-design→design-approval, prd→artifact-approval, phase-impl→commit-authorization; `matchingApproval` keyed by `subject_digest`; legacy-design and migration approvals exempt at `:167`). The semantic view requests a `gate-summary` only when `next_action` is `open-gate`, and `composeGate` (`src/state/request-composition.ts:509-731`, kind derivation `:547-552`) is reached only through that offer — suppressing the open-gate action naturally bypasses gate composition. A second, separate design-approval open exists in the adjudication-gate branch (`next-action.ts:401-405`); that is the constitution policy arm.
- **Status has the routing facts, but clean-advance settlement owns evaluation.** `computeTaskStatusDetailedInternal` reads live config for change notices, loads the retained subject, authenticates approvals, and derives next action. The narrowly enumerated clean-fixed-point transactions evaluate and persist the rule conclusion. Status continues to route authority from authenticated approval, while gate composition uses the latest eligible waiting settlement only to explain the recorded trigger; mutable config is never retroactively turned into authority.
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

- Subject trigger: `wait` iff `subject ∈ config.approval_rules.subjects`. Content rules are evaluated **only for the phase-impl subject** and match when any changed path matches any rule's glob list (task design D5: a `**/*.md` rule never fires on the design doc; documented behavior). Absent/empty `approval_rules` ⇒ `{wait: false, match: null}`; in Phase 3 this records the future rule outcome but does not bypass explicit approval.
- Glob matcher: self-contained, no dependency. Semantics pinned: patterns match the whole repository-relative, `/`-separated path, case-sensitive; `*` and `?` match within one segment; `**` matches zero or more complete segments (so `**/*.sql` matches `a.sql` and `db/a.sql`; `db/**` matches everything under `db/`); a trailing `/**` also matches the directory's own path. Documented in the module and unit-tested.
- The subject→gate-kind mapping (D5) is one exported table `subjectGateKind: {prd: "artifact-approval", design|phase-design: "design-approval", phase-impl: "commit-authorization"}` incl. the force rule (a phase-impl subject trigger forces commit-authorization regardless of content rules) — implemented and unit-tested helper-level in this phase; its behavioral effect at the commit boundary activates in Phase 4 (P3-3).

### P3-2 — One authoritative evaluation at the first clean-advance transaction

- The shared settlement builder is the sole evaluator at the enumerated transaction boundaries in P3-5. Its caller reads config once, assembles the subject and changed paths through `approvalRuleContext`, and appends the complete conclusion. Later config edits govern later settlements and are reported, but never rewrite the recorded result.
- `computeTaskStatusDetailedInternal` still requires authenticated human approval for document routing. When the current settlement is `wait:true`, gate composition reads its persisted match instead of re-evaluating live config, so the human sees why the gate opened even after config changes.

### P3-3 — Explicit document approval remains active until the constitution changes

`advanceAction` continues to open `artifact-approval`/`design-approval` unless an authenticated human approval already exists. `wait:false` is durable evaluation evidence only in Phase 3: it does not supply upstream ownership, phase-exit authority, `planned_final_phase`, design-milestone commit facts, or recovery authority. Phase-impl commit authorization is likewise unchanged. Phase 5 must first revise the active constitution and matching repository hard rules; only a later approved phase may activate autonomous consumption.

The adjudication-gate policy arm remains unconditional. A granted waiver may append the ordinary rule settlement for the now-clean subject, but it is not artifact approval and therefore still returns to the ordinary explicit document gate in this phase.

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

Settlements have **one durable representation**: the inline state entry on `TaskStateV1.rule_settlements?: readonly RuleSettlementV1[]`, written by the kernel's own state commit. Both outcomes are persisted, but in this phase they are evaluation evidence rather than human authority; `wait:true` additionally preserves the exact trigger match. A separate durable document and an external authority file are rejected because either would add drift or non-atomic authority.

- **Canonical order is a dedicated numeric-aware comparator over `(phase_instance, subject_digest, settled_at_revision)`**, not `tupleKey`: that helper string-coerces numbers and would sort revision 10 before 9. Construction and Zod validation use the same comparator; duplicates are rejected, while an exact restart may re-settle the same phase/digest at a later numeric revision. Latest selection compares `settled_at_revision` numerically rather than relying on array/string order.
- **Eligibility is digest-bound AND restart-scanned**: presentation selects a settlement only while its `subject_digest` equals the current digest and it passes the restart cutoff. Latest selection is deterministic. No approval-dependent consumer accepts it as authority in this phase.
- `config_digest` is the **live** config digest observed by the settling preparation's own single config read (P3-5), never the creation-time pinned one. Settlements join no retained-result graph and no fingerprint composition.
- Settlements are **additive**: existing approval/import arms remain unchanged; in-flight states with no settlement preserve today's gate-required behavior, and archived gate parsers are untouched.

### P3-5 — Enumerated clean-advance transactions evaluate rules against prospective evidence

Final triage settles through the `archflow_state` handler, and accepted-editorial `produce-succeeded` re-entry can reach the same clean fixed point with retained predecessor evidence. A shared builder covers both routes using one config read. A human-requested simple revision is intentionally excluded: its final bytes always return to the human, and it cannot clear an accepted material finding.

**The fixed-point input includes the result being installed.** Final-triage preparation overlays the pending triage result; editorial re-entry overlays the newly produced subject over retained predecessor evidence. A settlement is written only when the prospective view is clean and no adjudication gate remains.

The handler passes `{subject_digest, config_digest, conclusion}` through `TransitionPlanInput`. The planner accepts it only on final-triage success or exact accepted-editorial produce re-entry, derives identity and revision mechanically, and appends either conclusion. It rejects simple human revision and every other transition carrier. Crash/replay remains idempotent.

**Policy-waiver discharge is the third settlement route, with its own gate-resolution guard.** An authenticated current design-policy waiver may evaluate and append the now-clean subject's settlement from final triage or exact accepted-editorial re-entry. Other gate kinds, decisions, stale subjects, pending policy, and simple human revisions cannot mint one. Both conclusions still return to the ordinary document-approval boundary in this phase; a waiver is not artifact approval.

### P3-6 — Settlement consumption is intentionally dormant

`currentApprovedUpstreams`, `requireApprovedUpstreamDigests`, counter-review/pinned-context upstream derivation, produce-owner selection, next-action routing, transition exit predicates, state-handler completion signals, and milestone proof continue to require authenticated human approval. This is the fail-closed compatibility boundary with the active constitution. Phase 3 may store and present settlements, but no `wait:false` entry is authority.

### P3-7 — Design milestone commits remain human-authorized

`designCommit` facts and `designArtifactCommittedAtCurrentTarget` continue to require authenticated design-approval or migration-audit context. A settlement is neither commit authorization nor recovery authority. The autonomous milestone path is deferred with P3-6.

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

### Chunk C — Human gate presentation and fail-closed routing

- `src/state/status.ts` and `src/state/next-action.ts`: preserve authenticated-human routing and milestone authority.
- `src/state/request-composition.ts` and `src/state/gate-decision-interface.ts`: bind the eligible persisted `wait:true` match into ordinary gate context and human-readable presentation; later config changes do not rewrite it.

### Chunk D — Durable settlements with dormant consumption

- `src/state/transitions.ts`: guarded settlement carrier accepted only at final-triage success or exact accepted-editorial produce re-entry; simple human revision and all phase exits remain human-authorized.
- `src/mcp/handlers/state.ts`: shared settlement construction for final-triage and accepted-editorial re-entry; one config read and prospective evidence overlay; no autonomous completion signal.
- `src/state/gates.ts`: separately guard authenticated policy-waiver discharge inside `closedStateForRecord`/`nextStateForRecord`; evaluate and atomically append the current subject's rule settlement through the shared pure constructor; other gate kinds/decisions and unresolved or non-current subjects cannot use this seam (P3-5).
- `src/state/restart-authority.ts`: `ruleSettlementIsEligibleAfterLatestRestart` beside the approval filter (P3-4).
- `src/review/fixed-point.ts`: a simple revision never clears an accepted material finding.
- Approval-dependent upstream, planned-final-phase, and milestone consumers remain unchanged and human-authorized.

### Chunk E — Template and journeys

- `assets/config.template.yaml` defaults; no task-config edit and no machine-global installation (P3-8).
- Journey/integration tests below; fixture adaptations for document-gate suites.

### Chunk F — Verification sweep and bundle

- Full gates (below); rebuild the tracked `dist/` payload (`release:stage`/`release:write`) — src/schema bytes are bundle inputs; stale bundle fails `release-offline`.

## Tests

1. **Helper unit (new `test/unit/approval-rules.test.ts`)**: subject match/no-match per subject; empty and absent `approval_rules` ⇒ autonomous; content rules evaluated for phase-impl only (a `**/*.md` rule does not fire on a design doc); glob semantics (`**` zero-or-more segments incl. `**/*.sql` matching root `a.sql`; `*`/`?` within a segment; trailing `/**`; case sensitivity); `subjectGateKind` mapping incl. phase-impl→commit-authorization force rule.
2. **Contract tests**: task-state optional-field combinations (both conclusions; bad revision bound; duplicate triple); numeric comparator cases across 9→10 and 99→100 in canonical, reverse, and duplicate orders; latest eligible selection is numeric; structural corpus inventory confirms the settlement is owned by task-state and no extra schema root/registry entry exists; foundational config agreement covers `approval_rules`.
3. **Dormant-authority boundary**: document next actions, upstream consumers, phase exits, planned-final-phase derivation, and milestone proof reject both settlement conclusions without authenticated human approval.
4. **Mandatory opening**: document kinds open their human gate after either conclusion; phase-impl remains unconditional. A `wait:true` match is presented from the persisted settlement, not mutable config.
5. **Policy-arm split and waiver resumption**: failing/uncertain policy writes no settlement; a granted authenticated current waiver appends either evaluated conclusion from final triage or exact editorial re-entry, then returns to ordinary document approval. Unrelated, stale, pending, or simple-revision routes cannot mint settlements.
6. **Human-authorized document journeys**: even `wait:false` records are followed by the ordinary approval and authenticated milestone commit path.
7. **Fresh-project defaults**: PRD, design, and phase-design all retain explicit human approval in this phase; the settlement records which future rule outcome would apply.
8. **Settlement evidence and guard**: edits before settlement govern it; edits afterward do not change its recorded match. The gate presentation still names the persisted subject/path trigger after config edits.
9. **Restart and idempotence semantics**: an exact planning restart re-settles the same `(phase_instance, subject_digest)` at a new revision; pre-restart settlements are ineligible until re-settlement; latest eligible selection is numeric and tested across decimal-width boundaries.
10. **Fixed-point and boundary guards**: final-triage and accepted-editorial prospective evidence may settle; simple human revision may not carry a settlement and always returns to approval. A simple classification cannot clear an accepted material finding. Policy-pending and malformed boundaries fail closed.
11. **Existing suites adapted**: document journeys remain explicitly human-gated; composition/status/transition fixtures gain settlement and trigger-presentation facts; init-assets self-adapts. Phase-impl commit semantics are unchanged.
12. **Crash/replay**: `test/crash/state-transaction.test.ts` adds settlement-bearing replay for both outcomes (same plan ⇒ same entry bytes inside committed `next_state`; no second file can drift).

## Files touched (summary)

`src/contracts/config.ts`, `src/contracts/durable-state.ts`, regenerated `src/contracts/schemas/v1/{config,task-state}.schema.json`, `src/state/approval-rules.ts` (new), `src/state/status.ts`, `src/state/next-action.ts`, `src/state/request-composition.ts`, `src/state/transitions.ts`, `src/mcp/handlers/state.ts`, `src/state/gates.ts`, `src/state/restart-authority.ts`, `src/state/implementation-manifest.ts`, `src/review/fixed-point.ts`, `src/mcp/handlers/counter-review.ts`, `src/review/pinned-context.ts`, `src/state/produce-subject.ts`, `assets/config.template.yaml`, targeted tests and journey fixtures, maintained docs, and the rebuilt `dist/` payload. There is no task-config edit, separate settlement contract/schema root, registry expansion, or machine-global installation.

## Pinned cross-chunk interfaces

1. **Helper:** `evaluateApprovalRules(config, subject, changedPaths) → {wait: boolean; match: {kind:"subject"; subject} | {kind:"content"; paths} | null}`; content evaluation only for the phase-impl subject; absent/empty rules ⇒ `{wait: false, match: null}`.
2. **Glob semantics:** whole-path, `/`-segmented, case-sensitive; `*`/`?` within a segment; `**` zero-or-more segments; no dependencies.
3. **Mapping:** `subjectGateKind` — prd→artifact-approval, design|phase-design→design-approval, phase-impl→commit-authorization (subject trigger forces the gate regardless of content rules); helper-level now, commit-boundary behavior in Phase 4.
4. **Settlement record:** `RuleSettlementV1` as in P3-4 — one state representation for both outcomes on `TaskStateV1.rule_settlements?`; dedicated comparator orders strings lexically and `settled_at_revision` numerically; `config_digest` comes from the preparation's single live-config read; eligibility = digest match + restart cutoff; latest selection compares revisions numerically.
5. **Settlement:** final-triage and accepted-editorial re-entry assess prospective evidence, read config once, and append either conclusion through a guarded carrier. Authenticated current policy-waiver discharge uses a separate guard. Simple human revision, other transitions, and unrelated/stale gate resolutions cannot mint a settlement.
6. **Opening:** document approval remains mandatory after either conclusion. A `wait:true` gate uses the eligible persisted match; mutable config is not re-evaluated for its presentation.
7. **Acceptance:** settlements are not approval, upstream, phase-exit, or commit authority in Phase 3. Every such consumer retains its human-approval arm only.
8. **Derivation:** design milestone facts and recovery proof remain derived from authenticated human design approval or migration audit.

## Success criteria

- With a subject rule matching, today's behavior: the gate opens with today's presentation and decision set, and resolves exactly as before (in-flight open gates unaffected).
- With no matching rule, the step records `wait:false` but still opens the ordinary human document gate; the settlement does not authorize a commit or phase exit while the current constitution remains active.
- With a matching rule, the step records `wait:true` plus the exact match, and the gate presents that persisted subject/path evidence. Large content matches degrade within the bounded gate-summary contract by showing exact leading paths and an omitted count while retaining the complete sorted match durably. Rule edits made afterward are reported but do not retroactively invert or erase either outcome.
- An exact planning restart invalidates pre-restart settlements for presentation selection, and byte-identical re-production can re-settle at a new revision; numeric ordering remains correct across 9→10 and 99→100.
- Fresh projects under the shipped template still stop PRD, design, and phase-design for explicit approval in this phase.
- Constitution policy findings still open design-approval regardless of rules; attempts-exhausted and the other exception gates are untouched and still stop (existing suites green).
- A granted constitution waiver records the now-clean subject's settlement, then returns to ordinary document approval because a waiver is not approval of produced bytes.
- Accepted-editorial re-entry may settle. A human-requested simple revision never settles, always returns for approval of its final bytes, and never clears an accepted material finding.
- The phase-impl commit boundary behaves exactly as before this phase (carve-out observable in tests).
- The repository template and `dist/` support `approval_rules`, while repository `.archflow/config.yaml`, this task's config, and the machine-global installation remain untouched; task creation continues copying the compatible repository config, and re-scaffold reports `scaffold-diverged` rather than rewriting it.
- `check:schemas` is green with config/task-state regeneration only; durable contract suites are green; `dist/` is rebuilt but not installed.

## Executable verification

`npm run typecheck`; `npm run generate:schemas` (diff reviewed); `npm run check:schemas`; `npm run test:unit`; `npm run test:contracts`; `npx vitest run test/integration`; `npx vitest run test/crash`; then the dist rebuild and `npx vitest run test/integration/release-offline.test.ts`. Raw outputs transcribed to the phase verification transcript.

## Deviations from the task design (facts, not decisions)

1. **Four adjacent sites/boundaries beyond D6's original six** (verified by exploration): next-action routing, transition predicates, state-handler signals, and the deliberately human-only migration-audit boundary. The parent's D6 inventory is corrected; these are not all settlement-acceptance sites.
2. **Activation boundary corrected:** Phase 3 records both conclusions and presents original matches, while Phase 4 enriches content-trigger presentation at the still-mandatory commit gate. Settlement consumption moves to Phase 5 alongside the constitution amendment, so no earlier phase can rely on authority not yet granted.
3. **composeGate needs no live rule conditional**: settlement freezes the decision; next action routes from approval/settlement state, and composeGate renders a persisted wait match. The disagreement guard remains evidence-bound while post-settlement config edits are informational.
4. **Settlement mechanics concretized and corrected by review** (P3-4/P3-5/P3-7): `rule_settlements` on `TaskStateV1` records both outcomes using a task-state-owned type/schema; separate schema and authority roots were rejected. The collection uses a numeric-aware comparator and restart eligibility; every enumerated route supplies prospective evidence; no settlement derives `planned_final_phase` or supplies policy, migration, exit, upstream, or commit authority in this phase.
5. **Schema surface simplified after counter-review**: `taskConfigSnapshotV1Schema` mirrors `approval_rules`, while the settlement shape stays inside the single task-state root like `BaselineAdoptionRecord`; no new schema ID, document, barrel export, or consumer registration is warranted.
6. **Self-cutover removed after counter-review** (P3-8): the active server is a separately installed bundle and may not parse the new key. Phase 3 changes the repository template and rebuilt dist only; it neither edits this task's config nor installs globally. The installed old server continues its existing gates until the user separately authorizes adoption.
7. **Prospective settlement input** (fresh same-side audit): retained evidence alone cannot see the triage result being installed. P3-5 now pins the prepared-result overlay and a structured, boundary-guarded `rule_settlement` carrier rather than passing an underspecified conclusion.
8. **Parent/interface drift corrected** (fresh same-side audit): the parent now uses the phase's path-only helper result, assigns operation/size enrichment to Phase 4, and removes duplicate matcher ownership. The earlier external-schema consumer inventory was superseded by the task-state-owned settlement shape in item 5.
9. **Wait evidence and numeric ordering corrected** (fresh draft review): one settlement record now persists both outcomes, so Phase 4 can present the original content matches after config changes; a dedicated comparator avoids lexicographic revision failures at 9→10 and 99→100.
10. **Waiver resumption corrected after counter-review**: authenticated policy-waiver discharge is a narrowly guarded settlement boundary, preventing a redundant unconditional design gate while preserving a project-requested ordinary gate.
11. **All eligible clean-advance routes settled after counter-review**: accepted-editorial re-entry can reach a clean fixed point at `produce-succeeded` without another triage result; a human-requested simple revision is deliberately ineligible and returns to approval without a settlement. P3-5 enumerates final triage, accepted-editorial re-entry, and waiver discharge with their prospective evidence overlays and both rule outcomes tested. Because waiver resolution bypasses `planStateTransition`, it has a separate authenticated gate-resolution guard around the shared settlement constructor.
12. **Template-copy source corrected after counter-review**: task creation copies repository `.archflow/config.yaml`; Phase 3 changes only `assets/config.template.yaml` and rebuilt `dist/`. The live repository/task config remains compatible with the installed server, and re-scaffolding an initialized repository reports `scaffold-diverged` instead of silently adopting the new template.
13. **Autonomous consumption deferred after fresh trust-boundary review:** the approved draft placed `wait:false` settlement consumption before Phase 5's constitution amendment, which would have allowed a document milestone commit without the explicit human authority required by the active repository rule. Phase 3 therefore records both outcomes and presents persisted matches but keeps every document approval, upstream, exit, and commit consumer human-authorized. Activation must be redesigned only after the governing rule is explicitly amended.
14. **Simple-revision boundary corrected after fresh trust-boundary review:** a human-requested simple revision never creates a settlement and always returns to human approval of the final bytes. Because “simple” means no behavioral or semantic change, it cannot resolve or suppress an accepted material finding; that case requires significant classification and fresh review.
