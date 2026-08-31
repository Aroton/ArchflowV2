# Product Requirements Document: Review Taxonomy & Workflow State Overrides

**Task:** `review-taxonomy`  
**Status:** In Review  
**Date:** 2026-08-31  

---

## 1. Problem Statement

ArchFlow currently uses a single severity scale (`blocker`, `major`, `minor` with a binary `blocking` flag) for counter-review findings. This model creates several fundamental dysfunctions:
1. **Consequence Conflation:** Reviewers conflate severity (how bad it would be if true) with confidence (how sure they are), preventing reviewers from raising high-impact risks or suspicions when confidence is uncertain.
2. **Unfalsifiable Debate:** Objections often arrive as vague assertions, leading to model-vs-model debates rather than concrete, testable verification.
3. **Over-Acceptance Pressure:** AI agents running producing skills often feel pressured to accept every reviewer comment or spend cycles rewriting designs to appease minor reviewer opinions, instead of exercising triage agency.
4. **Workflow Lock-In and Spinning Loops:** Workflow execution can become trapped in rigid checkpoints—such as lengthy verification requirements (e.g., 30-minute test runs) or multi-round review loops that spin on flaky or inconsequential findings. Currently, escaping these loops requires either endless cycles or expensive upstream design revisions that trigger even more reviews.

There is no structured, human-authorized escape hatch for skipping disproportionate validation steps or pushing through stalled review cycles with explicit human intervention.

---

## 2. Target Users & Stakeholders

- **Software Engineers & Developers:** Using ArchFlow to build features autonomously while retaining explicit control and rapid escape hatches when automation spins.
- **Orchestrator AI Agents:** Running ArchFlow skills (`archflow-prd`, `archflow-design`, `archflow-phase-design`, `archflow-phase-impl`), needing clear agency to triage contentious reviews and offer human override gates when stuck.
- **Counter-Reviewer Models:** Dispatched by the workflow server to independently critique artifacts and code without self-censoring low-confidence, high-value suspicions.

---

## 3. Goals and Non-Goals

### Goals
- **Replace Severity Scale with 3-Field Taxonomy:** Replace `severity` (`blocker`/`major`/`minor`), `blocking`, and all legacy severity scales (`critical`, `bug`, etc.) with:
  1. `claim_type`: `defect`, `risk`, `gap`, `preference`.
  2. `confidence`: `certain`, `likely`, `suspicion`.
  3. `falsifier`: Concrete evidence, test fixture, or explicit indication of unevaluable conditions.
- **Encourage Contentious Counter-Review:** Prompt counter-reviewers to surface counter-ideas, boundary edge-cases, and suspicions with concrete falsifiers.
- **Empower Agent Triage & Falsifier-Based Routing:** Equip skills to triage aggressively:
  - Falsifiable claims $\rightarrow$ run check or test fixture.
  - Non-falsifiable with real consequence $\rightarrow$ escalate to human/author (`escalated-human`).
  - Non-falsifiable with no consequence (or preference) $\rightarrow$ reject or defer (`deferred`).
- **Human-Gated Validation Override:** Provide a structured, durable mechanism for the human to waive or skip long/expensive verification steps during phase implementation with recorded rationale.
- **Human-Gated Review Push-Through:** Provide a structured, durable mechanism to break out of spinning or flaky review cycles with explicit human approval, advancing without forcing upstream design rewrites.
- **Durable Authority & Audit Trail:** Maintain strict compliance with repository constitution rules (`explicit-human-authority`, `honest-human-centered-outcomes`), recording all overrides, waivers, and taxonomy decisions immutably in task authority.

### Non-Goals
- **Eliminating Counter-Review:** Overrides are not automatic bypasses; counter-review remains the mandatory default, and bypasses require explicit human authorization.
- **Unstructured Agent Self-Approval:** The AI agent cannot unilaterally decide to skip validation or override review failures without an explicit, authenticated human gate decision.
- **Arbitrary State Mutation:** Overrides do not allow arbitrary jumping between unrelated workflow states; they provide bounded skip/advance transitions at specific blocked gates.

---

## 4. User Stories & Core Workflows

### 4.1 Contentious Review & Falsifier-Driven Triage
As an orchestrating agent, when counter-review completes on a design or implementation, I receive findings with explicit claim types, confidence levels, and falsifiers. For claims with falsifiers, I execute the check; for speculative claims with no falsifier or no real consequence, I reject or defer them; for contentious non-falsifiable issues with material consequence, I escalate them to the human gate via `escalated-human`.

### 4.2 Skipping Long Verification via Human Intervention
As a developer, when a phase implementation requires a 30-minute end-to-end test or hardware test that is unnecessary for the current incremental change, the agent surfaces a validation-override option. I provide my rationale and authorize skipping the long check, and the workflow transitions to commit authorization with the waiver recorded in durable authority.

### 4.3 Pushing Through Flaky Review Loops
As a developer, after multiple review cycles where the counter-reviewer repeats minor opinions or flaky findings, the agent offers a review push-through option. I approve pushing through with a brief reason, and the workflow advances to the next phase without requiring me or the agent to rewrite upstream design documents.

---

## 5. Functional Requirements

### 5.1 Three-Field Review Taxonomy Schema
- **FR-1.1 (Claim Type):** Review findings MUST include a `claim_type` field with one of:
  - `defect`: An assertion that something is provably wrong.
  - `risk`: An assertion that behavior fails under condition X (unevaluable from artifact alone).
  - `gap`: An assertion that a condition or specification is unhandled or missing.
  - `preference`: An observation or stylistic preference not claiming correctness.
- **FR-1.2 (Confidence):** Review findings MUST include a `confidence` field with one of:
  - `certain`: High certainty based on direct evidence.
  - `likely`: High probability based on standard patterns.
  - `suspicion`: Plausible hypothesis or edge-case suspicion (explicitly welcomed and cost-free).
- **FR-1.3 (Falsifier Contract):** Review findings MUST include a `falsifier` string:
  - For falsifiable claims (`defect`, testable `risk`/`gap`), the falsifier MUST specify the concrete test fixture, check command, or artifact inspection that settles the claim.
  - For non-falsifiable claims with claimed material consequence (e.g., environment or hardware constraints unevaluable in the artifact), the falsifier MUST state why an automated check is impossible and cite the consequence.
  - Findings lacking both a concrete settling check and claimed material consequence MUST be classified as `preference` or suppressed by the reviewer.
- **FR-1.4 (Legacy Scale Deprecation & Inventory):** The system MUST inventory and deprecate all legacy classification and severity scales—explicitly including `critical`, `bug`, `blocker`, `major`, `minor`, the `severity` field, and the binary `blocking` flag. All new review and triage schemas MUST prohibit these legacy fields, while preserving backwards-compatible read/deserialization for archived evidence.
- **FR-1.5 (Review Summary & Verdict Derivation):** Under the 3-field taxonomy, reviewer output is purely descriptive. Review summaries and public contracts MUST report total finding counts and counts partitioned by `(claim_type, confidence)` tuple. Review verdicts reflect finding presence (`pass` if 0 findings, `advisory` if only `preference` findings exist, `review-raised` if `defect`, `risk`, or `gap` findings exist), replacing legacy binary `blocking_count` calculations.

### 5.2 Counter-Reviewer Prompting & Rubrics
- **FR-2.1 (Contentious Review Objective):** Counter-reviewer prompts and system instructions MUST instruct models to be contentious, challenging assumptions and surfacing potential failure modes, edge cases, and latency/boundary risks.
- **FR-2.2 (Cost-Free Suspicions):** Prompts MUST explicitly encourage `suspicion` ratings, emphasizing that speculative risks with clear falsifiers are valuable signals.
- **FR-2.3 (Falsifier Enforcement):** Prompts MUST require reviewers to provide a concrete falsifier or explicit unevaluable condition note for every defect, risk, and gap.

### 5.3 Agent Triage, Dispositions & Advancement Lifecycle
- **FR-3.1 (Triage Routing Logic):** Triage processing in the orchestrator MUST route findings according to the falsifier matrix:
  - *Falsifiable Finding:* The agent runs the check or test fixture. If falsified, reject with check output; if confirmed, accept for remediation.
  - *Non-Falsifiable with Material Consequence:* Escalate to author/human via `escalated-human`.
  - *Non-Falsifiable without Material Consequence (or Preference):* Reject with evidence or mark as `deferred`.
- **FR-3.2 (Triage Disposition Contract):** Triage submissions MUST support the following mutually exclusive dispositions for every current finding:
  - `accepted`: Substantive defect/risk accepted for code/document remediation. Forces re-entry into produce attempt $N+1$.
  - `accepted-editorial`: Wording or formatting improvement with no change to behavior, meaning, or contracts. Authorizes one-hop produce without full re-review. Gated strictly by executor/triage assertion that the finding does not alter substantive behavior.
  - `rejected`: Finding is disproven, non-material, or outside scope. Requires rationale and rejection evidence.
  - `escalated-human`: Non-falsifiable claim with material consequence escalated to human judgment. Completes triage and opens/folds into a human gate before advancement.
  - `deferred`: Non-blocking observation or future consideration that does not block current phase advancement. Closes the finding for the current phase and records it in the durable triage ledger.
- **FR-3.3 (Fixed-Point Advancement with Dispositions):**
  - If any finding is `accepted`, the phase re-enters production for remediation.
  - If all findings are `rejected` or `deferred` (and no active rules fail), the phase reaches a clean fixed point and advances by rule or configured gate.
  - If any finding is `escalated-human`, the phase MUST present the escalation at an explicit human gate (`artifact-approval`, `design-approval`, or `commit-authorization`). The human can either accept the escalation (triggering produce re-entry) or override/waive it with rationale (advancing the phase).
- **FR-3.4 (Rejection Acceptance):** The workflow engine MUST treat rejection of non-material or unsubstantiated reviewer findings as healthy and normal, rather than penalizing or blocking the run.

### 5.4 Skill Instructions & Agent Agency
- **FR-4.1 (Skill Guidelines):** All ArchFlow skill instructions (`archflow-prd`, `archflow-design`, `archflow-phase-design`, `archflow-phase-impl`) MUST explicitly instruct the agent to exercise triage judgment and actively deny invalid, speculative, or inconsequential findings.
- **FR-4.2 (Anti-Overfitting):** Skills MUST forbid unnecessary upstream document edits or cosmetic design changes made solely to pacify non-material reviewer opinions.

### 5.5 Verification & Validation Overrides (Human-Gated)
- **FR-5.1 (Validation Skip Request):** In phase implementation, when verification requirements are lengthy, unavailable, or disproportionate, the workflow MUST allow presenting a validation waiver / override gate to the human.
- **FR-5.2 (Explicit Human Rationale):** The human gate MUST require an explicit human decision and non-empty rationale string explaining why the verification is skipped or deferred.
- **FR-5.3 (Durable Record):** The granted validation waiver MUST be recorded immutably under task authority and reflected in phase implementation status.

### 5.6 Review Push-Through & Loop Overrides
- **FR-6.1 (Push-Through Gate Trigger):** When review attempts reach a threshold (e.g., after 2+ rounds with non-material or recurring issues) or when the agent identifies a review stall, the workflow MUST provide an explicit `review-push-through` decision path at the gate.
- **FR-6.2 (Autonomous Advance Prevention):** Review push-through MUST require explicit human authorization; the agent cannot self-authorize a push-through.
- **FR-6.3 (State Transition on Push-Through):** An authorized push-through MUST transition the task past the review fixed point to gate approval or milestone commit without forcing an attempt exhaustion failure or design restart.

### 5.7 Metrics & Auditability
- **FR-7.1 (Taxonomy Metrics):** The status and diagnostic layer MUST track denial rates by `claim_type` $\times$ `confidence` to ensure healthy triage dynamics (e.g., high denial on `suspicion` is expected and healthy).
- **FR-7.2 (Override Audit Trail):** All validation skips and review push-through decisions MUST be traceable in `archflow_status`, recording timestamp, human reason, displaced requirements, and gate identity.

---

## 6. Non-Functional Requirements

- **NFR-1 (Security & Trust Bounds):** In accordance with rule `explicit-human-authority`, no override or waiver may be granted implicitly, via timeout, or by agent assertion alone.
- **NFR-2 (Schema Compatibility):** Existing archived task states, gate records, and review manifests must continue to parse cleanly without data loss.
- **NFR-3 (Determinism):** Finding IDs, envelope digests, and triage disposition ledgers must remain deterministic and reproducible.
- **NFR-4 (Performance):** Triage evaluation and gate presentation overhead must remain under 100ms.

---

## 7. Stated Assumptions & Dependencies

- **Assumption 1:** Reviewer model CLI adapters (Claude, Codex, Antigravity) are capable of emitting structured JSON complying with the updated finding taxonomy schema.
- **Assumption 2:** The server's MCP tool interface (`archflow_status`, `archflow_apply`) remains the authoritative communication boundary between skills and workflow state.
- **Assumption 3:** Existing task artifacts in `.archflow/tasks/` remain strictly isolated per task.

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Reviewers omit falsifiers or produce vague strings | High | Server schema validation rejects findings missing a valid non-blank `falsifier`; reviewer prompts provide concrete examples. |
| Agents abuse overrides to skip all testing | Medium | Overrides require explicit human approval and reason; status surfaces skipped validations prominently. |
| Reviewers stop raising suspicions if penalized | High | System metrics evaluate denial rates per `(claim_type, confidence)` tuple and document that high suspicion denial is normal. |
| Breaking changes in archived review manifests | Medium | Strict schema versioning with discriminated unions / optional legacy fields for backwards compatibility. |

---

## 9. Observable Success Criteria & Acceptance Matrix

| Requirement | Verification Method | Pass Criteria |
|---|---|---|
| 3-Field Review Taxonomy | Contract & Unit Tests | Counter-reviewer output validates `claim_type`, `confidence`, and `falsifier`; legacy severity (`critical`, `bug`, `blocker`, `major`, `minor`, `blocking`) is successfully replaced in new contracts. |
| Falsifier-Based Triage | Integration Tests | Triage correctly distinguishes falsifiable checks from non-falsifiable escalations (`escalated-human`) and non-material deferrals (`deferred`). |
| Fixed-Point Advancement | State Machine Tests | `escalated-human` materializes a required human gate; `deferred` closes finding for the phase; all-rejected/deferred advances cleanly. |
| Validation Skip Gate | End-to-End Workflow Test | Agent can request validation waiver; human approval with rationale records durable waiver and advances phase. |
| Review Push-Through | End-to-End Workflow Test | Human-authorized push-through advances a multi-round review loop to milestone commit without design rewrite. |
| ArchFlow Skills Agency | Skill Audit & Prompts | Skills instructions clearly guide agents to triage contentious findings without unnecessary design churn. |
