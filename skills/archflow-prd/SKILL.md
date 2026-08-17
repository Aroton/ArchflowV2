---
name: archflow-prd
description: Define, review, and obtain explicit approval for an ArchFlow product requirements document.
---

# Product Requirements Document

Treat the argument as `<task>`. This session is the producer and workflow orchestrator. Durable truth comes from the two semantic workflow tools. On entry call `archflow_status` with exactly `{"schema_version":"1","task_id":"<task>","invocation":{"skill":"archflow-prd","intent":"resume"}}`. Every `archflow_apply` call uses that exact task and invocation plus `"action":{"offer":<next_action.offer>}` and only the submission that `next_action.expected_submission` requests; omit `submission` for `none`. Use `intent:"reopen"` only when the human explicitly asked to reopen the PRD; after status explains the impact, apply the offered action with the same invocation and `{"kind":"reopening-request","request":<the human's exact request>}`. After that succeeds, call `archflow_status` again with the exact `intent:"resume"` invocation above; the one-shot reopen invocation does not own production. Never turn an ordinary correction, review finding, or resumed session into a reopen.

Use only the returned `resources` entries shaped `{role,path,access}`: select workflow artifacts by role, use their returned paths, respect their access, and never read another task's files. Shared `docs/` and ordinary repository exploration remain available. After every `archflow_apply`, use its returned fresh view as authority; if a response is lost or an offer is refused, call `archflow_status` again and follow the newly offered action. Never consume a successor offer in this invocation.

## Degraded operation

If either semantic workflow tool is unavailable, run read-only `archflow-local manual-status --task <task>`, report its position, and stop. Create no milestone, edit no workflow artifact, record nothing offline, and never infer authorization. A stale or rejected offer is normal semantic recovery, not tool unavailability.

## Production and review

For a new task, the first offered action expects `task-ask`. Before research or clarification, apply it with `{"kind":"task-ask","text":<the user's exact original ask>}`. Do not paraphrase. The server owns initialization and the ask-history record. On an explicit reopen, send the exact human correction only as `reopening-request`; the server derives the target and appends PRD ask history.

When the offered action opens production, apply its no-submission offer before editing. Read the returned `user-ask` and other relevant resources, then research only as much as the brief needs. Run research through parallel sub-agents with complete briefs when it is substantial; keep conversation, clarification, synthesis, and decisions here. Record clarification questions and exact answers in the writable ask resource when returned, preserving this form:

```markdown
## Clarifications

### Question 1

<exact question>

### Answer 1

<exact reply>
```

Write each question before presenting it. An unanswered question remains without an invented answer. Write the `current-artifact` as a PRD covering the problem, users, goals and non-goals, testable requirements, assumptions, risks, and observable success criteria. Keep it useful for design rather than prescribing implementation. Perform one bounded author check for ask fidelity, ambiguity, observable acceptance, material assumptions, and unjustified scope. Do not spawn an extra generative reviewer or iterate on polish.

Submit the finished bytes through the current offer with `{"kind":"work-result","outcome":"succeeded"}` (or the offered failed form with a concrete reason). Do not supply paths, policy, routing, digests, revisions, or other server-owned facts. Apply the next no-submission `review` offer. The server selects the independent opposite-family rubric and constitution review from the returned `review_context`; never perform, spawn, simulate, or replace that review. If you run any same-side author review, use `review_context.rubric` verbatim and the returned active rules, never an authored rubric.

## Triage and revision

When offered `triage`, submit exactly one disposition for every returned finding. Accept a finding only when fixing it is reasonably likely to change requirements, downstream design, verification, approval, or important risk; use `accepted-editorial` only for non-blocking wording or formatting with no meaning change. Reject optional polish and preferences with concrete evidence. Reject every `unverifiable-` evidence gap with evidence beginning `envelope-gap: ` and never accept it. The approval conversation is not a backlog-triage meeting; omit rejected non-material observations.

After any accepted finding, apply the separate no-submission `revise` offer before editing. Then make only the stated changes and submit a new `work-result`; significant changes receive fresh independent review. For a human request for changes, first submit the selected opaque decision token and reason, then apply the returned `revise` offer before touching bytes. Declare the actual revision on the next `work-result`: a **simple** revision is limited to typo, formatting, comment, or wording-only changes with no change to meaning, behavior, scope, interface, trust boundary, input, verification claim, or parent document; it may reuse review for one hop but still requires approval of the final bytes. A **significant** revision is anything else, resets the attempt count to 1, and automatically runs a fresh opposite-client counter-review plus constitution review. Uncertainty defaults to significant. State the classification and rationale to the human, and encode a human override in `human_revision.user_override` when they override it in either direction.

## Human gates and hand-off

When `next_action.expected_submission` is `gate-summary`, author a concise, self-contained human summary and submit `{"kind":"gate-summary","summary":<summary>}`. This only opens the nonblocking presentation. Explain conversationally what is ready, the ask and PRD outcome, each material finding or risk, every returned `presentation.details` entry, and every option with its consequence. Ask one direct question. Keep opaque tokens, JSON, digests, internal paths, and protocol details internal unless the user asks for diagnostic or audit detail. There is no optional review at the end.

Stop for explicit human judgment. Later submit only `{"kind":"decision","choice":<the selected presentation option token>,"reason":<the human's reason>}` through the current offer. Never choose, infer, or record a decision for the human. If the choice is `waiver-requested`, it is not approval: apply the separate no-submission `open-waiver` offer, present the returned waiver choices in the same way, stop again, and submit the later opaque token and human reason. A denial or cancellation grants nothing.

After approval, use fresh `archflow_status` with the same invocation. Apply an offered no-submission `start-next-skill` only when it belongs to this exact invocation. Once fresh status names the successor, report it without starting it:

`Claude: /<next_action.skill> <task> <next_action.skill_args...>`

`Codex: $<next_action.skill> <task> <next_action.skill_args...>`
