# review-flexibility: gate & approval-touchpoint map

Repo: `/home/aroton/ArchflowV2.feature-review-override-flexibility` (branch `feature/review-override-flexibility`).
Scope of this document: everything the "targeted-trigger" design (no built-in approval gates; machine-evaluated per-project subject/content rules decide autonomy) must touch.

---

## 1. Gate kinds inventory

### Definitions

- `src/contracts/gates.ts:80` — `GATE_KINDS = ["artifact-approval", "design-approval", "constitution-review", "material-drift", "attempts-exhausted", "constitution-edit", "commit-authorization", "restore-collision", "baseline-adoption", "migration-audit"]`.
- `GateContractByKind` (gates.ts:46-78) defines context+decision per kind:
  - `artifact-approval` (gates.ts:47): context `{ artifact_kind: "prd" | "design" | "phase-design" | "phase-implementation" }`, decision approve/revise/reject.
  - `design-approval` (gates.ts:49-59): combined design+policy+commit authority; context includes `policy_findings`, `eligible_waivers`, `target_ref`, `baseline_commit`, `commit_message`.
  - `commit-authorization` (gates.ts:69): context `{ target_ref, baseline_commit, commit_message, paths: RepositoryPathClaim[], diff_digest, current_artifact_digests, parent_document_digests }`, decision authorize-commit/revise/abort.
  - Safety/exception kinds: `constitution-review` (65), `material-drift` (66), `attempts-exhausted` (67), `constitution-edit` (68), `restore-collision` (70), `baseline-adoption` (76), `migration-audit` (77).
- `src/contracts/durable-gate.ts` adds the **waiver arm**: `constitutionWaiver = gateArm("constitution-review", waiverGateContextSchema, waiverDecisionsTuple, ...)` (durable-gate.ts:295) — a constitution-review request whose context is `WaiverGateContext { origin, rationale }` (durable-gate.ts:26) with decisions grant/deny/cancel.
- `GateEffect` (gates.ts:84): `approve`→advance, `authorize-commit`→advance, `revise`→retry, etc. (`effects` map, gates.ts:280-282).
- Pinned per-kind decision vocabularies: `GATE_REQUEST_DECISIONS` (durable-gate.ts:228-239) and the runtime mirror `DECISIONS` (src/state/gate-core.ts:41-52).

### Where each kind is created

All gate opens funnel through one function: **`openDurableGate`** (`src/state/gates.ts:163`). Its only callers are in `src/mcp/handlers/semantic.ts`:
- `openComposedGate` (semantic.ts:108-126) — executes an `archflow_gate` tool call composed by `composeRequest`.
- `openComposedWaiver` (semantic.ts:128-169) — opens the waiver arm from `archflow_waiver`.

The **composition** (choosing kind + context) lives in `composeGate` (`src/state/request-composition.ts:509-731`), driven by the `decide` semantic offer (gate-summary submission). Priority order inside composeGate:

1. **baseline-adoption** — composed first when reconciliation drift is blocking (request-composition.ts:522-546; subject built by `baselineAdoptionInputFromFindings`, src/state/status.ts:163-200).
2. Phase-default gate kind selection (request-composition.ts:547-552):
   ```ts
   const gateKind = phaseKind === "phase-impl"
     ? "commit-authorization"
     : phaseKind === "design" || phaseKind === "phase-design"
       ? "design-approval"
       : "artifact-approval";
   ```
   - `phase-impl` → **commit-authorization** (request-composition.ts:702-718; context built by `buildCommitAuthorizationInput`, src/state/status.ts:631-666).
   - `design`/`phase-design` → **design-approval** (request-composition.ts:680-691; `buildDesignApprovalInput`, status.ts:669-703).
   - `prd` (and any non-impl planning phase) → **artifact-approval** (request-composition.ts:719-728, context `{ artifact_kind: APPROVAL_ARTIFACT_KINDS[phaseKind] }`; `APPROVAL_ARTIFACT_KINDS` at request-composition.ts:46-51 maps `phase-impl`→`"phase-implementation"`, though the phase-impl arm never composes artifact-approval today).
3. **attempts-exhausted** (request-composition.ts:660-669) — composed exactly when the fixed-point assessor says the budget is spent (`assessCurrentEvidence(...).next === "attempts-exhausted"`, :595-618, with a `gate-fixed-point-disagreement` refusal on divergence).
4. **migration-audit** (request-composition.ts:670-679) — design phase of a legacy import with no accepted audit.
5. **constitution-review / material-drift** — from `pendingAdjudicationGate(state, constitution, loaded.value, authenticated)` (request-composition.ts:572-589, 692-701; selector `selectAdjudicationGates`, src/review/adjudication.ts:172-225; pending-gate derivation `pendingAdjudicationGates`, src/state/status.ts:555-585).
6. **restore-collision** and **constitution-edit** are not composed by `composeGate`; they are opened by raw `archflow_gate` calls from the phase-impl flow with server-side validation inside `openDurableGate`:
   - restore-collision: context validated against the retained produce result's projection plan (gates.ts:283-298); resolution applies the restore (gates.ts:1706-1749).
   - constitution-edit: context derived by `detectTaskLocalConstitutionEdit` (src/state/constitution.ts:165-212), used by `src/init/legacy-upgrade.ts:265`.

Server-side open-time validation for commit-authorization: `openDurableGate` re-reads the retained produce manifest and requires `diff_digest`, `current_artifact_digests`, `parent_document_digests` to match (gates.ts:269-282).

### Where commit-authorization is resolved and consumed

- Resolution: general gate resolution paths in gates.ts — `resolveDurableGate` (1466), `resolveAdvancingGate` (1661), and the connected-host direct path `archiveDirectSemanticGateDecision` (1094) → `settleDirectSemanticGateDecision` (1261). An advancing decision (authorize-commit) appends an `ApprovalRef` to `state.approvals` (`nextStateForRecord`, gates.ts:476-479).
- Consumption (the actual commit authority):
  - `src/state/status.ts:910-941` — finds the authenticated commit-authorization approval with decision `authorize-commit`, extracts `exactCommitAuthorizationContext` (paths/message/target/baseline), and proves the commit happened via `implementationOutputCommittedAtCurrentTarget` (src/state/implementation-manifest.ts:124).
  - `src/mcp/handlers/state.ts:427-457` — same proof at transition time (`completionSignal` for phase-impl triage-succeeded).
  - `src/state/transitions.ts:397-459` — `hasAuthenticatedCommittedOutput` requires a commit-authorization approval **and** `commit_observed === true` before a phase-impl may complete its final phase or cross to the next phase (453-459: `phase-impl triage-succeeded → different phase` refused without it).
  - `src/state/next-action.ts:199-215` — the `commit-phase` next action carries `commit_paths/commit_message/commit_target_ref/commit_baseline` from the approved request; `src/state/semantic-view.ts:286-299` renders it as an `action_kind: "commit"` offer (`requires_human_confirmation: true` for phase commits).
  - Design milestone commits analogously consume design-approval context (status.ts:942-975; next-action.ts:177-198 `commit-artifacts`; semantic-view.ts:274-285).

### Approvals reload

`src/state/gate-approvals.ts:54-137` `loadAuthenticatedGateApproval` — reloads each `ApprovalRef` from state + request.json + decision.json archives and mints a branded capability. Every consumer of "was this approved?" goes through this (status.ts:866-900, request-composition.ts:580-587, transitions, counter-review preconditions, produce-subject).

---

## 2. Gate decision presentation

`src/state/gate-decision-interface.ts` is the single renderer family:

- `buildGateDecisionTemplates(active)` (:37-111) — enumerates **every** decision shape the resolver accepts, derived from `request.allowed_decisions` (pinned tuples). Per CLAUDE.md hard rule, any new decision shape (e.g. a trigger-match gate kind) must be enumerated here: waiver arms, baseline-adoption applicability filtering (:71-74), waiver-requested per-(rule,axis) templates (:79-91), restore-collision adoption candidate (:92-99).
- `buildHumanGatePresentation(active)` (:267-308) — the conversational projection: `title`, `summary` (the stored gate request summary), optional `details: string[]`, `question`, and `options` (token/label/consequence). Copy tables: `PRESENTATION_COPY` per kind (:159-200), `OPTION_COPY` per decision (:202-222). Special-cased option copy for design-approval approve (:253-261) and indexed waiver options (:238-246).
- **Where a trigger-match presentation (matched file paths + per-file change summary) would render**: the `details` block. Precedents:
  - design-approval policy findings → `details` lines (:279-290).
  - baseline-adoption drifted/deleted projection paths → `details` list, capped at 10 paths with "… and N more" (:291-304). This is the exact shape to copy for "names every matching file path".
- `selectGateDecisionTemplate(active, choice)` (:342-416) binds a token+reason to a template. The connected-host path accepts **only server-issued tokens**: `archiveDirectSemanticGateDecision` rejects choices not in `buildHumanGatePresentation(active).options` (gates.ts:1120-1137).
- `src/contracts/renderers.ts` renders review/triage/adjudication *evidence* markdown (not gate UI): `renderReviewEvidence` (:46), `renderTriage` (:69), `renderAdjudicationEvidence` (:78). These are what the human gate summary quotes; a content-trigger summary could reuse this "metadata + prose" line style.
- Status exposes the presentation twice: full status `open_gate.presentation` (status.ts:597-607 `gateStatus`) and the brief routine projection (status.ts:309-340 `projectBriefStatus`); the semantic view surfaces it as the `resolve-open-gate` decide offer (semantic-view.ts:255-270).

---

## 3. The flow point "after counter-review completes"

Pipeline per phase: `produce → counter_review → triage` (+`adjudicate` as an evidence-slot only; `src/contracts/vocabulary.ts` PIPELINE_STEPS comment).

Sequence:

1. `handleCounterReview` (src/mcp/handlers/counter-review.ts) dispatches the review child **and** the constitution adjudication child atomically (`runCounterReview`, src/review/counter-review.ts:261; constitution plan :347-371) and retains both evidence slots (`adjudicate` slot holds `AdjudicationEvidence`).
2. Retained evidence is loaded/derived by `loadRetainedEvidence` / `deriveCurrentEvidenceSet` (src/state/evidence-results.ts:89-133, 206).
3. **The fixed point** — `assessCurrentEvidence` (src/review/fixed-point.ts:553-583) — walks `decideNextAction` (:522-547):
   - accepted findings → produce re-entry (attempt budget applies → `attempts-exhausted`);
   - missing/stale counter_review → `counter_review`;
   - incomplete triage → `triage`;
   - editorial-only acceptance → editorial produce re-entry;
   - else `resolveAdjudicationGateStep` (:501-519): every adjudication gate satisfied → **`advance`**; else `adjudication-gate` (first unsatisfied gate from `selectAdjudicationGates`).
4. `deriveNextAction` (src/state/next-action.ts:254-439) maps the assessment:
   - `advance` → `advanceAction` (:150-251): requires the phase-default approval kind (`requiredKind` at :153-159 — design/phase-design→design-approval, prd→artifact-approval, phase-impl→commit-authorization) via `matchingApproval` (:140-144); missing → `open-gate`; present → `commit-artifacts`/`commit-phase`/`advance-phase`/`complete-task`.
   - `adjudication-gate` → open-gate for the constitution gate (:391-424) with `pending_gate_kinds` disclosure.
5. The `open-gate` action becomes the semantic `decide` offer (gate-summary submission) in semantic-view.ts:249-254 → `composeGate` → `openDurableGate`. After the human decides, `resolve-open-gate` (semantic-view.ts:255-270) archives/settles, then the advancing effect appends the approval and the next status recomputes to commit/advance.

**Where rule evaluation slots in.** The approval requirement is enforced in three places that must stay in agreement (composeGate has an explicit `gate-fixed-point-disagreement` guard, request-composition.ts:595-618; status routes `fixed-point-disagreement` as a blocker, status.ts:524-542):

- `src/state/next-action.ts:150-251` (`advanceAction` — the advertised action),
- `src/state/request-composition.ts:547-552, 680-728` (`composeGate` — the composed request),
- `src/state/transitions.ts:190-225, 268+, 397-473` (`planStateTransition` — the durable movement check at phase crossings).

Subject/step context available at that point: `state.phase_instance` (phase kind = the workflow subject: prd / design / phase-design / phase-impl), `subject_digest` (retained produce manifest digest), the retained produce subject (`loadCurrentProduceSubject`, src/state/produce-subject.ts — document artifact or implementation output with all output paths), retained evidence set, resolved pinned constitution, authenticated approvals. All of it is already assembled inside `computeTaskStatusDetailedInternal` (status.ts:706-1287) — the natural single place to also evaluate per-project rules and attach the result to `NextActionInput`.

---

## 4. Content triggers — data available at evaluation time

### Phase implementation (many files)

- The retained produce artifact is an `ImplementationOutputV1` (src/contracts/durable-implementation-output.ts) whose `outputs` are `OutputEntry` records (src/contracts/durable-primitives.ts:168+): per-file `path`, `operation` ∈ add/modify/delete/rename (durable-primitives.ts:24), `before`/`after` `BlobIdentity { oid, mode, size_bytes }`, `storage` git-object|raw-payload. Sorted by path at build (src/state/implementation-manifest.ts:702). `base_commit` and `diff_digest` (domain-separated over base+outputs, `deriveImplementationDiffDigest`, implementation-manifest.ts:345) are recorded.
- So at rule-evaluation time (post-triage fixed point) the server already holds, per changed file: **path, operation kind, sizes, blob oids** — enough for a concise mechanical per-file summary ("modify, +N−M bytes" needs before/after sizes only; hunks would need a new git read). **No diff-stat/hunk reader exists today**: git boundary readers are name-only (`readChangedGitPaths` porcelain status, src/repository/git.ts:318-358; `readCommitRangeChangedPaths` diff --name-only, git.ts:450-469) plus blob reads (`readGitBlobBytes`, git.ts:531). Adding `git diff --numstat base..HEAD/worktree` would be new, bounded machinery.
- The commit-authorization context already carries the exact authorized `paths` set (gates.ts:69; built in status.ts:644-663, including rename previous_path).
- Build path that captures paths: `composeProduce` reads `readChangedGitPaths(services.runner)` (request-composition.ts:240) and folds changed task documents into outputs via `includeChangedImplementationDocuments` (request-composition.ts:98-130); `buildImplementationOutput` (implementation-manifest.ts:594-833) verifies snapshot/index/worktree identities per output.
- Undeclared-change report: the manifest also records changes outside declared outputs (`UndeclaredChangeReport`), so "every file the change touches" is durably known, not just declared outputs.

### Artifact steps (single file each)

- Document artifacts carry `document_path` (+`additional_document_paths`) with defaults per phase (src/state/phase-documents.ts:104-112, 129-150): `prd.md`, `design.md`, `phases/N/design.md`, `phases/N/impl-notes.md` (task-relative, i.e. `.archflow/tasks/<task>/...`). A content trigger on an artifact step can only ever match these fixed paths (plus additional declared paths) — effectively subject-only evaluation for documents.

---

## 5. Where per-project rules could live and be read

- **Repo-level config exists**: `archflow-init` installs `.archflow/config.yaml` from `assets/config.template.yaml` (src/init/assets.ts:21). Task creation copies it byte-for-byte to `.archflow/tasks/<task>/config.yaml` (`createTaskConfig`, src/init/task-initialization.ts:66-87) and the task pins its digest in `state.config_digest`; every gate operation re-verifies the pinned config (`validateLiveGateState`, gates.ts:135-137; status.ts:742-770). Schema: `configV1Schema` (src/contracts/config.ts:35-40) — `roles`, `overrides` (per-phase routing), `max_attempts`; **strict**, so adding rules means a schema version question: rules pinned at task creation follow the existing "changing config after pinning requires a new task" model (a deliberate trust property; a ruleset that humans edit mid-task must instead follow the constitution pattern).
- **Constitution pattern (recommended precedent)**: `.archflow/constitution/*.md` resolved from the pinned `policy_base_commit` (`resolvePinnedConstitution`, src/state/constitution.ts:122-159; `parseConstitutionRuleFiles`, src/contracts/constitution.ts). Constitution rules already carry `review_trigger` text and `enforced_by` labels and already drive machine-derived gates: `selectAdjudicationGates` (adjudication.ts:172) → design-approval policy context / constitution-review gates. Rules with the same pinning + digest + waiver machinery could host subject/content triggers; the `constitution-edit` gate and waivers already handle human amendment of policy mid-task.
- **Where rules would be evaluated in the server** (the constitution is resolved in exactly these spots today): `computeTaskStatusDetailedInternal` (status.ts:784-809), `composeGate` (request-composition.ts:572-574), and the fixed-point subject assembly. Config is read via `dependencies.read_config(authority.config)` and parsed with `parseConfigYaml` (already done for `max_attempts` at request-composition.ts:596-599 and status.ts:765).

---

## 6. State-machine transitions that assume an approval gate between steps

- `planStateTransition` (src/state/transitions.ts:425-482):
  - :453-459 — phase-impl `triage-succeeded` may not cross phase without `hasAuthenticatedCommittedOutput` (:397-422: authenticated commit-authorization approval + `commit_observed`).
  - :460-467 — non-impl phase crossing requires `hasAuthenticatedArtifactApproval` (:197-217 — artifact-approval, or design-approval for design/phase-design) or an accepted migration audit.
  - :468-473 — design/phase-design crossing with a combined design approval additionally requires `commit_observed`.
- `advanceAction` (next-action.ts:150-251) — the advertised open-gate/commit/advance chain (see §3).
- **Upstream-approval dependency (big hazard)**: `currentApprovedUpstreams` (status.ts:481-522) *throws* when a produced upstream lacks a current approval, and `requireApprovedUpstreamDigests` (fixed-point.ts:586-602) throws likewise. Adjudication evidence records `approved_upstream_digests` (fixed-point.ts:175-180 checks them against the subject). If earlier phases advance without approvals under the new model, every later phase's assessment breaks with `approved-upstream-authority-unavailable` (status.ts:524-542). The rule engine must produce a durable substitute for "approved" (e.g. recorded rule evaluations) wherever these functions read `state.approvals`.
- Other readers of approval kinds that assume their existence:
  - `migration-audit` open validation accepts "traditionallyApproved" artifact/design approvals (gates.ts:382-389).
  - `loadApprovedDesignFinalPhase` (src/state/planned-final-phase.ts:50-87) derives `planned_final_phase` only from artifact/design approvals of design.md — final-phase completion depends on it.
  - Review preconditions: `src/review/pinned-context.ts:264`, `src/review/fixed-point.ts:340-362, 596`, `src/mcp/handlers/counter-review.ts:175-187`, `src/state/produce-subject.ts:115` — all treat artifact/design approval as the gate for reviewing/producing against upstream bytes.
  - `adjudicationGateSatisfied` treats a design-approval *approve* as satisfying constitution-review for design phases (fixed-point.ts:338-363).
- `workflow.yaml` phase graph: `src/contracts/workflow.ts:33-41` already declares `gate: "always" | "on_trigger" | "never"` per phase (`GATE_POLICIES`, vocabulary.ts) but the graph is pinned to one exact shape (`superRefine` :27-29) and the `gate` field is **not consulted** by any gating decision — gating is enforced by next-action/transitions/fixed-point. Server-side there is no configurable phase graph to change; skills and docs describe the gates.
- Crash/replay machinery keyed to approval decisions: `enactsReentry`/`beginsHumanRevision` (gates.ts:492-514) list the approval kinds' `revise` decisions; `pending_human_revision` handling in transitions and `archiveDirectSemanticGateDecision`/settlement; `semantic-status.ts:160-165` maps revise choices.

---

## 7. Tests covering approval gates and commit authorization

Test files referencing `artifact-approval` / `commit-authorization` / `design-approval` (grep over `test/`):

- contracts: `durable-gate.test.ts`, `durable-gate-v1-compatibility.test.ts`, `durable-gate-validation.test.ts`, `gate-error-schema-agreement.test.ts`, `mcp-advertised-schema.test.ts`, `mcp-contract-agreement.test.ts`, `retired-surface.test.ts`, `release-contracts.test.ts`, `schema-registry.test.ts`, `skill-contract-*.test.ts`, `semantic-workflow-contract.test.ts`, `durable-semantics-corpus.test.ts`, `durable-state-validation.test.ts`.
- integration: `call-envelope.test.ts`, `counter-review-pinned-context.test.ts`, `legacy-upgrade.test.ts`, `review-fixed-point-live.test.ts`, `semantic-implementation-completion-journeys.test.ts`, `state-gate-lifecycle.test.ts`, `status-reentry-edit.test.ts`, `mcp-handler-state-replay.test.ts`, `semantic-*journeys*.test.ts` (document/implementation/upgrade/composition-parity).
- unit: `config-pinning.test.ts`, `errors.test.ts`, `fingerprints.test.ts`, `gates.test.ts`, `implementation-output-builder.test.ts`, `mcp-tools.test.ts`, `planned-final-phase.test.ts`, `planning-restart-runtime.test.ts`, `review-services.test.ts`, `semantic-actions.test.ts`, `state-gate-interface.test.ts`, `state-gates.test.ts`, `state-next-action.test.ts`, `state-produce-subject.test.ts`, `state-reconciliation*.test.ts`, `state-request.test.ts`, `state-status.test.ts`, `state-transaction.test.ts`, `state-transitions.test.ts`, `status-brief-projection.test.ts`, `workspace-cleanup.test.ts`.
- crash: `crash/state-gate-lifecycle.test.ts` (closure-before-receipt windows for approval gates).
- real-host: `terminal-journey.test.ts` (restore-collision/commit journeys), `review-benchmark.test.ts`.

Also affected and not in src/: the nine skills under `skills/` (phase-impl's authorize step, prd/design approval steps) and the maintained docs set that CLAUDE.md requires updating in-change: `docs/workflow/LIFECYCLE.md`, `docs/review/COUNTER-REVIEW.md`, `docs/state/DURABLE-STATE.md`, `docs/mcp/SERVER.md`, `docs/cli/COMMANDS.md`, `docs/workflow/SKILLS.md`, `docs/contracts/CONTRACTS.md`.

---

## 8. Touch-point list with hazards (condensed)

1. `src/contracts/gates.ts` — remove/retire artifact-approval + design-approval + commit-authorization arms (or keep as archived-shape readers: see the `archivedCommitAuthorizationContextSchema` precedent, gates.ts:259-262, and `parseArchivedGateRequest`/`parsePersistedGateRequest` tolerant parsers, durable-gate.ts:436-458 — in-flight tasks with open approval gates must keep resolving across bundle switchover).
2. `src/contracts/durable-gate.ts` — request/active-gate arms, decision tuples, generated schema defs.
3. `src/contracts/internal/schema-generation-mcp-tools.ts:109-141` — advertised `archflow_gate` input schema enumerates kinds.
4. `src/state/gate-core.ts:41-52` — `DECISIONS` mirror.
5. `src/state/request-composition.ts:547-552, 680-728` — composeGate phase-default arm; add rule-evaluation arm here (and keep the fixed-point-agreement guard honest).
6. `src/state/next-action.ts:150-251` — advanceAction approval requirement; this is where "no rule targets this → auto-advance" first becomes visible.
7. `src/state/transitions.ts:197-225, 397-473` — phase-crossing approval checks; auto-advance needs a durable replacement fact or these refuse the move.
8. `src/state/status.ts:481-522, 586-602(caller), 631-703, 910-975` — upstream-approval throws, commit/design commit authority builders, approval consumption.
9. `src/review/fixed-point.ts:338-375, 501-519, 586-602` — adjudication-gate satisfaction + `requireApprovedUpstreamDigests`.
10. `src/state/gate-decision-interface.ts` — presentation for any new trigger gate kind; `details` precedent at :279-304; template enumeration hard rule.
11. `src/state/gates.ts:382-389 (migration-audit), 492-514 (reentry/revision)` — approval-kind switches.
12. `src/state/planned-final-phase.ts:50-87` — planned_final_phase derives from design approval.
13. Rules storage: extend `src/contracts/config.ts` schema + `assets/config.template.yaml` + `src/init/task-initialization.ts` createTaskConfig (pinning semantics), or follow the constitution pattern (`src/state/constitution.ts`, `src/contracts/constitution.ts`) for amendable policy.
14. Content-trigger data: retained `ImplementationOutputV1.outputs` (paths/ops/sizes) is sufficient for summaries; numstat/hunks need a new bounded git reader in `src/repository/git.ts`.
15. Skills + docs caps pages (see §7).
