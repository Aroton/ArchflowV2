# Model and effort recommendations

Updated 2026-09-12. Fresh selector policy `implementation-agent-selector-v4` favors economical implementation after strong architecture and phase design. Model recommendations are engineering judgments, not capability guarantees or instructions to switch the session.

## Implementation ladder

Architecture and phase design recommend GPT-6 Astra high. Their job includes settling material decisions, identifying existing guarantees, and providing meaningful verification so implementation usually suits Sol medium or Astra low.

| Remaining implementation work | Starting recommendation |
|---|---|
| Narrow, well-understood, short task with a cheap reliable check | Gemini 3.7 Flash high |
| Settled patterns, ordinary migrations, CRUD, UI composition, API/dependency wiring, ordinary tests | GPT-5.6 Sol medium (default) |
| Substantive reasoning within a settled approach: bounded parsing, state transitions, artifact handling, tricky integration | GPT-6 Astra low |
| Identifiable difficult algorithmic derivation or interacting correctness mechanisms still requiring deep reasoning after design | GPT-6 Astra high |

There are no additive axis scores, automatic risk floors, or highest-component aggregation. Distinguish calling an established ownership transaction from inventing ownership. Timers, shared state, security labels, file counts, document length, and lengthy tests or tool loops alone do not justify escalation. A hard mechanism that is essential to the current implementation still counts: do not average it away or assume an unspecified stronger subagent will solve it. Never select Astra max; existing explicit-route restrictions remain.

## Phase boundaries and feedback

Assess material decisions remaining, new mechanisms versus tested predecessor APIs, relevant examples, credible verification, and coupling. Typically plan one coherent mechanism plus routine wiring. A tested internal prerequisite is a useful increment even when the full feature comes later. Isolate an independently difficult component when the reduction in implementation and rework cost justifies the extra design/review cycle; a bounded implementation assignment can sometimes suffice. Avoid fragmenting routine work merely to obtain a cheaper label. Keep required safety behavior with the capability it protects.

The selector recommends for the plan as written. Its optional free-form `rationale` explains remaining difficulty and can identify a decision to settle or a component to isolate. High-effort recommendations should identify the concrete hard problem. Missing rationale does not invalidate a valid profile. The producer assesses useful feedback through existing review/triage or server-returned reopen actions. No scoring worksheet, automatic plan rewrite, extra model call, new gate, or model quota is introduced.

## Cost and calibration

The objective is total useful work per resource spent, including architecture, phase design, implementation, verification, and review/rework. Model and effort are separate choices: lower effort does not change the model's per-token price. Consult current official [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) pricing when estimating API cost; CLI/account billing and actual token consumption need separate evidence.

The earlier seven-case V3 calibration tested whether a selector followed that policy. It did not benchmark implementation capability or justify the old thresholds. Calibrate V4 with a small sample of actual implementations and existing notes/usage evidence: chosen and actual model/effort, total work including review/rework, and consequential defects. Include routine wiring that calls concurrency primitives, broad mechanical edits, bounded new mechanisms, and genuinely difficult algorithms. A simulated selector or scripted CLI test cannot establish model quality or cost savings. No new telemetry or benchmark framework is needed.

## Reviewer roles and authority

The effort selector remains Luna xhigh, the test reviewer Luna xhigh, and constitution adjudication Gemini 3.7 Flash high. Configured counter-reviewer rosters and explicit routes retain their meaning. This policy does not rewrite task configuration or switch implementation sessions. Any selector failure defaults to Sol medium without retry or a human boundary. Advice, including its rationale, cannot grant edits, bypass review, change offers, or approve work.

## Retained evidence

The payload remains schema version 2 with an optional rationale; fresh policy identity is V4. V1 assessments and V2/V3-policy selections remain readable with their original profiles. Their private judgments are not reinterpreted. A policy change alone does not rerun completed reviews; changed phase-design bytes require fresh selection. Contract tests validate profile membership, binding, archival readability, and explanation projection, not the quality of the model's judgment.
