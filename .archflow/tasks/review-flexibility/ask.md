review-flexibility we need to add more flexibility to our reviews. A couple of things off the top of my head. 1. We need to be able to change the config mid project (there is no reason to lock it in). 2. We need to hook up our overrides.

## Clarifications

### Question 1

Today the task config is byte-pinned at task creation: its digest is bound into state and every review envelope, and any later byte change fails with a config-mismatch error — the only exits are a new task or restoring the original bytes. When you say we need to change the config mid-project, what guardrail should the amendment flow have?

### Question 2

Which parts of the config should be amendable mid-project — just reviewer routing (roles and per-phase-kind overrides), or everything including max attempts?

### Question 3

By "hook up our overrides": the per-dispatch reviewer route override for outages (added in commit 6549da8) is fully implemented server-side but has no entry point through the two semantic workflow tools, so no skill can actually request it. Is wiring that up the intent — and should the config template and skills also surface the existing per-phase-kind override section, which today is hand-edit-only?

### Question 4

Nothing today proves a human authorized a reviewer substitution; the route override records a reason but the client relays it. Should using a route override require an explicit human decision at a gate, or is a recorded human-provided reason (relayed by the client, shown at the next gate) sufficient?

### Answer 1 and Answer 2

(pinning, guardrail, and amendable scope — answered by redirecting the question:)

> Ok, so lets talk about pinning. What are we really trying to solve by pinning?
>
> We are doing work in a trusted environment (local app dev). The AI is the one doing all the work. What we really want to do is just actually notify the AI that bytes have changed, what changed, and to let them review if its changed.
>
> I don't actually think we need crazy amount of durable validation to make it a super hard rule (and this has caused more problems than its caught as it causes ai loops and extra processing etc)
>
> So think about it this way.
>
> 1. What is useful to have (to an ai)
> 2. What is efficient?
> 3. What is flexible?

(automation posture, which subsumes the guardrail question:)

> Right and the final target is automatation through steps, just enforcmenet a step occurs (counter review etc)
>
> So in a "perfect world" the flow is:
>
> 1. I give requirements to the AI
> 2. It makes a prd/asks questions etc
> 3. Counter reviews
> 4. Presents to human for review and feedback.
>
> Same for overall architecutre.
>
> But where things get interesting is when we get to a PHASE design/impl we don't even really care about human gates UNLESS we add a consitution amendment to trigger human approval (and maybe this is how we should do it in PRD and architecture too)
>
> So basically we can say "we wnat to review prd" "we want to review overall design" "we want to review sql changes" etc. But the goal is to automate as much as possible into the ai and only catch human approvals on things that we target

### Answer 3

Not answered separately; the original ask's "hook up our overrides" plus the automation direction above is treated as: wire the per-dispatch route override through the semantic workflow tools, and surface the config-level per-phase-kind overrides. The PRD states this scope.

### Answer 4

Not answered directly. The PRD states it as an assumption consistent with the targeted-trigger model: a route substitution is recorded with its reason and surfaced at whatever gate or report next occurs; it does not open a dedicated pre-approval gate unless a rule targets it.

### Question 5

Three follow-up questions: (1) commits — does a completed phase auto-commit when no rule targets it, or is the git boundary human by default? (2) default posture — fresh repo with no constitution rules: fully autonomous, or a shipped default ruleset? (3) how targeted can a trigger be — workflow subjects only, or content matching?

### Answer 5

> 1. I don't care about commits literally at all. We will always be in a feature branch and squash merging at the end anyways
> 2. Default ruleset is review prd and design. (allow override, but this is mys tandard workflow)
> 3. I need content reviews. So I ALWAYS review sql and api contracts. It would be amazing for the AI to stop and tell me those and where they are etc. But this is PER PROJECT, not global. We just need that capability. As a default build in human approval for sql files