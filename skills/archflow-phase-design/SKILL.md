---
name: archflow-phase-design
description: Design and durably review one approved ArchFlow implementation phase before code may be written.
---

# Phase Design

Treat the arguments as `<task> <phase-number>`. On entry call `archflow_status` with exactly `{"schema_version":"1","task_id":"<task>","invocation":{"skill":"archflow-phase-design","phase":<phase-number>,"intent":"resume"}}`. Every `archflow_apply` call uses that exact task and invocation plus `"action":{"offer":<next_action.offer>}` and only the submission that `next_action.expected_submission` requests; omit `submission` for `none`. Use `intent:"reopen"` only when the human explicitly asked to reopen this planning boundary; submit their exact request as `{"kind":"reopening-request","request":<exact request>}` through the returned offer. After it succeeds, call `archflow_status` again with the exact `intent:"resume"` invocation above; the one-shot reopen invocation does not own production. Let the server derive the affected phases and authority changes.

This session is the producer and orchestrator. Use only returned `resources` shaped `{role,path,access}`; select `current-artifact`, `task-design`, `prd`, and any `prior-implementation-notes` by role, use returned paths, respect access, and never read another task's files. Shared `docs/` and ordinary repository exploration remain available. After every `archflow_apply`, trust its returned fresh view. If an offer is lost, stale, or refused, call `archflow_status` again. Perform one offered action per call and never start implementation in this invocation.

The server identifies the producer family from the initialize handshake of the connected client and dispatches the configured counter-review (opposite-family by default), plus the constitution review when the repository has active constitution rules; you never perform, spawn, or simulate either. The orchestrator's context is the workflow's scarcest resource: conversation with the user, human gates, triage, and synthesis stay here. Run codebase exploration and research through sub-agents in parallel, each spawned with a complete brief — a sub-agent sees nothing of this conversation — writing bulk output to disk and returning only the conclusions this phase's design needs. Plan the work, then delegate the parallelizable pieces to sub-agents; do inline only what is too small to justify a hand-off. Review the draft through a fresh review sub-agent before recording produce (below), and run independent review work in parallel: the counter-review dispatch runs in the background while any same-side review sub-agents run. Then triage, resolve, and re-enter review as needed, bounded by the attempt budget.

## Degraded operation

If either semantic workflow tool is unavailable, run read-only `archflow-local manual-status --task <task>`, report its position, and stop. Create no milestone, edit no workflow document, write no code, record nothing offline, and infer no approval. An offer refusal is ordinary recovery, not degraded operation.

## Production and independent review

If entry status returns `start-next-skill` with `next_action.offer`, apply its no-submission offer with this exact invocation before writing. If it names a successor without an offer, report the returned successor command and stop; this completed invocation does not own the hand-off. Otherwise require position `phase-design` with the requested phase; report a different phase or inspection result rather than bypassing it. Read the returned task design, PRD, relevant context, and prior implementation notes whose interfaces matter. Delegate substantial exploration and a fresh same-side draft review to sub-agents with complete briefs while keeping conversation, triage, and synthesis here.

Write the `current-artifact` with the phase goal, requirements, context, files, work chunks, pinned cross-chunk interfaces, success criteria, and executable verification. Keep it within the approved phase scope. Do not write implementation code; document bytes alone grant no authority. If planning proves the task design or PRD inaccurate, update each returned writable parent in the same production result and record the deviations explicitly. This compound parent update is part of the single submitted document result.

For same-side review use `review_context.rubric` verbatim and its active rules; never author durable review policy. Submit the completed current artifact and any parent updates with `{"kind":"work-result","outcome":"succeeded"}`. Do not name paths or author routing, policy, fingerprint, digest, or revision fields. Apply the offered no-submission `review`; the server derives and runs the configured rubric and constitution review (opposite-family by default). Never perform, spawn, simulate, or replace that independent review.

## Triage and revision

When `triage` is offered, submit exactly one disposition per returned finding. Accept only a defect with a material consequence for scope, interfaces, implementation, verification, approval, or important risk. Use `accepted-editorial` only for non-blocking wording or formatting with no meaning change. Reject optional cleanup and preferred alternatives with concrete evidence. Reject every `unverifiable-` gap with evidence beginning `envelope-gap: `. Phase-design approval is not a backlog-triage meeting; keep rejected non-material observations out.

Accepted findings authorize no immediate edit. Apply the separate no-submission `revise` offer first; only then edit the phase design and any returned writable PRD or task-design parent, submit a new `work-result`, and allow required review. A human request for changes uses the same close-then-revise sequence: record their selected opaque decision token and reason, apply `revise`, then edit.

Declare the actual human revision on the next work result. A **simple** revision is only typo, formatting, comment, or wording work that changes no meaning, behavior, scope, interface, trust boundary, input, verification claim, or parent document; it can reuse review once but always returns for approval of the final bytes. A **significant** revision is anything else, resets the attempt count to 1, and automatically runs a fresh opposite-client counter-review plus constitution review. Uncertainty defaults to significant. Explain the classification, and record a human override in either direction in `human_revision.user_override`.

## Human decision, Git, and hand-off

When an offer expects `gate-summary`, submit a concise self-contained `{"kind":"gate-summary","summary":<summary>}`. It opens a nonblocking presentation. Explain conversationally the phase-design outcome, all material risks, every returned detail, and each choice with its consequence; ask one direct question. Keep opaque tokens and mechanical bindings internal unless the user requests diagnostics or audit detail. The independent review already ran and there is no optional review at the end.

Stop for explicit human judgment. Later submit only `{"kind":"decision","choice":<selected presentation option token>,"reason":<human reason>}`. Never choose or infer it. A `waiver-requested` choice is not approval: apply the separate no-submission `open-waiver` offer, present its choices, stop again, and later submit the waiver's opaque token and reason. Denial or cancellation grants nothing.

When fresh status returns `next_action.kind:"commit"`, use only returned `commit` facts. Confirm HEAD matches `baseline` and `target_ref`, stage exactly every authorized path — run `git add -A -- :(top,literal)<path>` once per entry in `commit.paths` — inspect the staged task-local diff, and commit with `commit.message` and the same top-anchored literal pathspecs. Do not ask for another confirmation and preserve unrelated staged or worktree changes. After any Git failure, report it and retry safely. Call read-only `archflow_status` with the same invocation so the server observes the commit proof.

If fresh status instead blocks with a design-milestone inspection, the milestone cannot succeed as things stand and retrying the commit only loops. Explain in plain language which file or fact is in the way and what would resolve it: a stray task document nobody approved is removed, while a milestone commit that already exists and cannot be recognized needs the user's decision about the branch. Never edit the archived approval or the commit history to make the check pass.

Apply an offered no-submission `start-next-skill` only for this exact invocation. Report `DESIGNED` only after fresh status proves the hand-off and names the successor; do not start implementation here:

`Claude: /<next_action.skill> <task> <next_action.skill_args...>`

`Codex: $<next_action.skill> <task> <next_action.skill_args...>`
