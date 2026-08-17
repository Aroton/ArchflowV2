---
name: archflow-design
description: Design, review, and obtain explicit approval for an ArchFlow task architecture and phase plan.
---

# Task Design

Treat the argument as `<task>`. On entry call `archflow_status` with exactly `{"schema_version":"1","task_id":"<task>","invocation":{"skill":"archflow-design","intent":"resume"}}`. Every `archflow_apply` call uses that exact task and invocation plus `"action":{"offer":<next_action.offer>}` and only the submission that `next_action.expected_submission` requests; omit `submission` for `none`. Use `intent:"reopen"` only when the human explicitly asked to reopen task design, and submit the human's exact request as `{"kind":"reopening-request","request":<exact request>}` through the returned offer. After it succeeds, call `archflow_status` again with the exact `intent:"resume"` invocation above; the one-shot reopen invocation does not own production. The server derives the reopened boundary and invalidation impact. Never reinterpret ordinary feedback as reopen.

This session is the producer and orchestrator. Use only returned `resources` shaped `{role,path,access}`; select `prd` and `current-artifact` by role, use returned paths, respect access, and never read another task's files. Shared `docs/` and ordinary repository exploration remain available. After each `archflow_apply`, use its returned fresh view. On a lost, stale, or rejected offer, call `archflow_status` again. Perform exactly one offered semantic action per apply call and never start successor work in this invocation.

## Degraded operation

If either semantic workflow tool is unavailable, run read-only `archflow-local manual-status --task <task>`, report its position, and stop. Create no milestone, edit no workflow document, record nothing offline, and infer no approval. An offer refusal is not degraded operation.

## Production and independent review

If entry status returns `start-next-skill` with `next_action.offer`, apply that no-submission offer with the same exact invocation before writing. If it names a successor without an offer, report the returned successor command and stop; this completed invocation does not own the hand-off. If it selects another phase or an inspection action, report that safe result and stop. When production is open, read the returned PRD and relevant repository context. Use parallel sub-agents with complete briefs for substantial exploration and a fresh same-side draft review; keep conversation, triage, and synthesis here. Write the `current-artifact` with system boundaries, data and control flow, key interfaces and decisions, requirement mapping, risks, verification strategy, and the implementation phase plan. Update a returned writable PRD in the same production result if design makes it inaccurate.

Every finite phase plan uses consecutive headings beginning at 1 in the exact form `### Phase N: Name`; alternate dashes, tables, skipped numbers, and other headings are not phase authority. An intentionally open-ended plan contains exactly `<!-- archflow:phase-plan:open-ended -->` and no `### Phase` headings. Design artifact approval fails closed when neither form is valid.

For a same-side review, use the returned `review_context.rubric` verbatim and its active rules; never author durable review policy. Then submit the completed bytes with `{"kind":"work-result","outcome":"succeeded"}`. Do not submit paths, routing, policy, fingerprints, digests, or revisions. Apply the offered no-submission `review` action. The server derives and runs the opposite-family rubric and constitution review; never perform, spawn, simulate, or replace it.

## Triage and revision

For an offered `triage`, submit exactly one disposition per returned finding. Accept only defects with a material consequence for requirements, architecture, implementation, verification, approval, or important risk. `accepted-editorial` is only non-blocking wording or formatting with no meaning change. Reject optional cleanup or preferred alternatives with concrete evidence. Reject `unverifiable-` gaps with evidence beginning `envelope-gap: `. Design approval is not a backlog-triage meeting; rejected non-material observations stay out of it.

Accepted findings do not authorize edits. Apply the separate no-submission `revise` offer first, then edit the design and any returned writable parent made inaccurate, submit another `work-result`, and allow fresh review when required. A human request for changes follows the same boundary: submit the selected opaque token and reason, apply `revise`, then edit.

Classify the actual human-requested change on the next work result. A **simple** revision is only typo, formatting, comment, or wording work that changes no meaning, behavior, scope, interface, trust boundary, input, verification claim, or parent document; it may reuse review once but always returns for approval of the final bytes. A **significant** revision is anything else, resets the attempt count to 1, and automatically runs a fresh opposite-client counter-review plus constitution review. Default uncertainty to significant, explain the rationale, and preserve a human override in either direction in `human_revision.user_override`.

## Human decision, Git, and successor

When the current offer expects `gate-summary`, submit a concise self-contained `{"kind":"gate-summary","summary":<summary>}`. The result opens a nonblocking presentation. Explain conversationally the design and phase-plan outcome, every material risk and returned detail, and all choices with their consequences; ask one direct question. Do not expose opaque tokens or mechanical bindings unless the user requests diagnostics or audit detail. The independent review already ran; there is no optional review at the end.

Stop for explicit judgment, then submit only `{"kind":"decision","choice":<selected presentation option token>,"reason":<human reason>}`. Never select a decision yourself. `waiver-requested` is not approval: apply the separate no-submission `open-waiver`, present the waiver gate, stop again, and later submit its opaque token and reason. Denial and cancellation authorize nothing.

When fresh status returns `next_action.kind:"commit"`, use only its returned `commit` facts. Confirm HEAD matches `baseline` and `target_ref`, stage only `:(top,literal)<commit.path>` with `git add -A --`, inspect the staged task-local diff, and commit with `commit.message` and the same top-anchored literal pathspec. Do not request a second confirmation; the approved presentation authorized these exact facts. Preserve unrelated index and worktree changes. On Git failure, report it and retry safely. Then call read-only `archflow_status` with the same invocation so the server observes commit proof.

Apply an offered no-submission `start-next-skill` only for this exact invocation. After fresh status names the successor, report it and stop:

`Claude: /<next_action.skill> <task> <next_action.skill_args...>`

`Codex: $<next_action.skill> <task> <next_action.skill_args...>`
