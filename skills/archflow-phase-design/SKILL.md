---
name: archflow-phase-design
description: Design and durably review one approved ArchFlow implementation phase before code may be written.
---

# Phase Design

Treat the arguments as `<task> <phase-number>`. Work only in `.archflow/tasks/<task>/` plus shared `.archflow/context/`; never read another task's files. The canonical artifact is `.archflow/tasks/<task>/phases/<phase-number>/design.md`. Durable status, not that document's status line, decides whether implementation may begin.

## Stable rubric

Use this exact JSON object, without editing or reordering it, both when hashing the rubric and when calling `archflow_counter_review`:

```json
{"schema_version":"1","kind":"artifact","mode":"adversarial","criteria":[{"id":"chunk-seams","text":"The work chunks compose coherently and pin exact interfaces wherever separately implemented work meets.","blocking":true},{"id":"scope-budget","text":"The phase fits one implementation and verification session without adding work outside its approved goal.","blocking":true},{"id":"design-conformance","text":"The phase covers its assigned requirements and stays consistent with the approved task design and PRD.","blocking":true},{"id":"integration-risk","text":"Dependencies, ordering constraints, migration points, and verification of integration boundaries are explicit.","blocking":true}]}
```

Compute its `rubric_digest` using `archflow-local hash`. Obtain effective self-review provenance and active pinned rules from status. Do not self-declare routing facts or calculate any value the server checks.

## Durable loop and step ownership

Run `archflow-local status --task <task>`, check the result's JSON `ok` field, perform exactly its `next_action`, and run status again after every durable action. Verify that `phase_instance` is `phase-design-<phase-number>` before writing this phase. If status selects another phase, a repair, or a human-required action, report that instead of bypassing it.

Call `archflow_state` with `status: "running"` before each pipeline step. Record the terminal exit for `produce`, `self_review`, and `triage` only. `archflow_counter_review` and `archflow_adjudicate` install their own successful exits.

Every non-produce call uses one `archflow-local envelope --task <task>` pass over the complete proposed input. Produce uses two passes:

1. Draft `phases/<phase-number>/design.md`. Run `archflow-local build-document --task <task>` with the current phase instance, `step: "produce"`, `document_path: "phases/<phase-number>/design.md"`, and sorted declared inputs for `.archflow/tasks/<task>/design.md` and `.archflow/tasks/<task>/prd.md`.
2. Run `archflow-local envelope --task <task>` over the complete `archflow_state` request and substitute the returned fingerprint into both the request and artifact.
3. Run `envelope` again over that substituted request for the true request digest, then call `archflow_state` with byte-equivalent input.

On a fingerprint mismatch, abandon the pending intent, use the returned expected digest and safe next action, rebuild with a fresh intent, and re-run status. Do not introduce a manual fallback.

## Phase work

For `produce`, read `design.md`, `prd.md`, relevant context, the immediately preceding implementation notes when their interfaces affect this phase, and the pinned policy surfaced by status. Write a reviewable phase design that defines the goal, requirements, context, files, work chunks, pinned cross-chunk interfaces, success criteria, and executable verification. Keep it within the approved phase scope and current operating envelope. If implementation planning proves the task design inaccurate, update `design.md` in the same production change and record the deviation explicitly.

Do not write implementation code in this skill. A phase design has no authority merely because its file exists.

For `self_review`, apply every rubric criterion and pinned rule to the current artifact. Create the agent-declared review only from the current subject/fingerprint, the effective self-review route returned by status, and the locally hashed rubric. Install it through `archflow_state`; use `archflow-local render --task <task>` when the canonical review projection is needed.

For `counter_review`, call `archflow_counter_review` with `artifact_path: "phases/<phase-number>/design.md"` and the unchanged rubric. For `triage`, transcribe status's current evidence-set digest, canonical evidence digest order, and every finding identity. Disposition every finding exactly once; accepted findings revise the phase design and, when necessary, `design.md`, then re-enter production and fresh review. For `adjudicate`, call `archflow_adjudicate` with `artifact_path: "phases/<phase-number>/design.md"` and `upstream_paths: ["design.md","prd.md"]`.

## Approval gates and handoff

Adjudication may require `review-trigger`, `material-drift`, `adjudication-failure`, or `attempts-exhausted` authority. After the fixed point closes, every phase design also requires an `artifact-approval` gate with `context: {"artifact_kind":"phase-design"}` before the workflow may advance to implementation. Take its subject digest and current evidence from status, run `archflow-local envelope --task <task>` before the blocking `archflow_gate` call, and present the true gate ID. A gate opened within adjudication has no pre-call surface.

For every open gate, re-run status and present its ready decision templates, paths, and complete optional counter-review prompt. The user decides whether to run the optional review and which decision to authorize. If run, follow the prompt, ingest it with `archflow-local gate-counter --task <task>`, and triage supplemental findings before resolution; accepted changes re-enter the fixed point. Declining creates no review. Write only the explicitly selected template using `archflow-local decide --task <task>` with `kind: "interface"`, then let the blocked call resume.

Keep the original `archflow_gate` input and `intent_id` for every supplemental retry. Decline by retrying with status's exact `decline` outcome and create no review. If review is elected, install it, let the blocked call return `SUPPLEMENTAL_REVIEW_REQUIRED`, then retry with status's exact `ingest` outcome. Re-run status after ingest and retry with its exact `triage-no-change` outcome, or, for an accepted change, revise and rebuild the artifact, take the exact new subject digest from `envelope`, retry with the authenticated supersede facts plus that digest, and expect `GATE_SUPERSEDED`. A superseded gate approves nothing: re-enter produce, review, triage, and adjudication to a fixed point before opening a fresh gate. Never fabricate review, triage, subject, or human-decision facts.

If the explicit decision is `waiver-requested`, it is not approval. Re-run status, construct the `archflow_waiver` origin only from the server's archived request and decision plus helper-derived digests, run `envelope` before the blocking waiver call, and handle that gate through the same status/templates/prompt procedure. A denied or cancelled waiver grants nothing.

Never pass a review gate or claim `DESIGNED` without explicit human approval where a gate is required. Report `DESIGNED` only when a fresh status proves the current fixed point is closed, no gate remains unresolved, and the workflow has advanced to the corresponding implementation phase. Synchronize any human-readable `**Status**:` projection to durable truth; never use the line itself as authority. Then stop and tell the user the exact `next_action.skill` and arguments reported by status.
