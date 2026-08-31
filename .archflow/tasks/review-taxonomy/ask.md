we want to update how our counter reviews classify things. You can see more about the research at @[docs/research/review-taxonomy-research.md]

Additionally, we want to add a way for the AI agent to override the workflow state. Often times we get to the end of a workflow and have something like "you need a 30 min validaiton" we want to skip. This should be allowed to be skipped with human intervention. Same with if we have run 4 reviews and just want to push through as they are either flaky or not getting real issues. 

Right now we have to just keep spinning, or go back and edit the design which is expensive. (which causes additional reviews too)

## Clarifications

### Question 1

How should the new Review Finding Taxonomy (claim type, confidence, required falsifier) integrate into the triage and blocking flow?

### Answer 1

Fully integrate with falsifier-based triage routing: falsifiable claims require verification checks, non-falsifiable claims with consequence escalate to human/author, and non-falsifiable claims without consequence can be deferred. This replaces existing critical/bug/blocker/severity scales. The counter reviewer should be contentious to expose counter ideas, and the main agent is expected to deny/triage findings that are not real or non-material rather than accepting everything. Skills must understand they can deny and triage.

### Question 2

How should the workflow state override / push-through mechanism be structured and authorized for long validations and stuck review loops?

### Answer 2

Integrate into the workflow state machine as explicit human-authorized override/waiver gates (e.g., validation-waiver and review push-through decisions) that record durable rationale and bypass stuck loops, allowing the AI agent and human to skip long validations or push through flaky/inconsequential review loops without endless spinning or expensive design rewrites.