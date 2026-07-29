---
name: archflow-prd
description: Research a domain and create or revise an ArchFlow product requirements document. Use when the user wants to define a feature, its requirements, scope, risks, or success metrics.
---

# Create Product Requirements Document

Treat the task name supplied with this skill as `<task>` and work in `.archflow/tasks/<task>/`.

Run this session as the workflow orchestrator: the requirements conversation, decisions, review gates, and triage stay here because they need the full history, while bulk work — research, drafting, fresh-context review — runs in sub-agents that write to disk and return only conclusions. Treat sub-agents as available — both Claude Code and Codex provide them natively; work inline only when spawning actually fails or a piece of work is too small to justify the hand-off.

**Write to the operating envelope.** ArchFlow builds working software a small team can maintain: functionality and maintainability come first. Requirements describe the scale, criticality, and threat model this product actually faces; absent a stated reason, assume an early-stage product serving thousands of users, not millions. Do not manufacture non-functional requirements — throughput targets, availability tiers, adversarial threat models, compliance regimes — that the user did not ask for and the product does not face. This PRD sets the envelope that architecture and phase design are held to, so an inflated envelope here becomes over-engineering everywhere downstream.

## Setup and requirements

Create the task directory if necessary. Read `.archflow/context/` when it exists — in a multi-root workspace every repo may carry its own; read them all. Throughout this skill, "context documents" means that union, noting which repo each came from when passing them to sub-agents. If `prd.md` already exists, read it and ask whether to revise it or start fresh.

Ask what `<task>` is: the problem being solved and who it is for. Then, over a natural, focused conversation (typically a few rounds — stop as soon as requirements are sufficient), establish:

- problem statement and motivation;
- target users and needs;
- must-have versus nice-to-have features;
- technical stack, timeline, and integration constraints;
- the operating envelope: realistic scale at launch and a year out, what breaks and who it hurts if this fails, tolerable downtime and data loss, and whether anyone is realistically attacking it;
- explicit out-of-scope work.

Use structured choices when helpful. Do not research until requirements are sufficient.

## Research

Research only the dimensions that are load-bearing for this task — a user-facing product in a competitive space warrants all three below; an internal tool or refactor may warrant one or none. Skipping a dimension is a judgment call, not a failure. Spawn one research agent per dimension you pursue, run them in parallel, and wait for all of them — survey material is exactly what should never enter the orchestrator's context. A researcher sees nothing of this conversation, so give each a complete brief: the user's problem, requirements, constraints, and a summary of any context documents. Instruct each to return only the findings the PRD author needs to make decisions — synthesized conclusions, not raw survey material.

1. **Domain research**: current best practices, table-stakes features, and common architecture patterns.
2. **Competitive landscape**: existing solutions, what they do well, recurring complaints, and differentiators.
3. **Technical research**: best practices, pitfalls, and recommended or avoided libraries for technologies in scope.

Use current web research when the domain is fast-moving, competitive positioning matters, or you are uncertain — not as a ritual for every task.

## Write the PRD

Spawn a writer agent to draft the PRD; it sees none of this conversation, so give it the complete user requirements as established above, all research findings, any context documents, and the rubric below. Draft inline only when the task is small enough that its PRD is about a page and the hand-off would cost more than the drafting.

**PRD rubric** — the bar the writer drafts to and every reviewer judges against:

- A human reviews it in 5–10 minutes. Typically 1–3 pages, scaled to the task — a small internal change deserves a one-page PRD, not a filled-in ceremony.
- Every requirement is testable and cuts to what actually matters; genuine analysis, never boilerplate.
- The operating envelope is stated, and nothing in the document exceeds it.
- Research shows up only as the decisions it changed and the risks it surfaced — survey material stays out.

Write `.archflow/tasks/<task>/prd.md` with this structure, keeping only the sections that earn their place — omit any section that would hold boilerplate for this task:

```markdown
# PRD: [Task Name]

> [One-paragraph elevator pitch]

## Problem Statement
[What problem does this solve? Why now?]

## Target Users
[Primary users, their needs, current pain points]

## Core Value Proposition
[The ONE thing this must deliver]

## Functional Requirements
### Must Have (v1)
| ID | Requirement | Description |
|----|-------------|-------------|
| REQ-01 | [Name] | [User can do X / System does Y] |

### Should Have (v1+)
| ID | Requirement | Description |
|----|-------------|-------------|
| REQ-20 | [Name] | [Description] |

### Out of Scope
| Feature | Reason |
|---------|--------|
| [Feature] | [Why excluded] |

## Operating Envelope
| Dimension | Target |
|-----------|--------|
| Scale | [Users, requests, data volume at launch and ~12 months out] |
| Criticality | [What breaks if this fails; tolerable downtime and data loss] |
| Threat model | [Who realistically attacks this, if anyone] |
| Beyond the envelope | [Concerns deliberately deferred — e.g. multi-region, high concurrency — and the signal that would make them real] |

## Non-Functional Requirements
| Category | Requirement |
|----------|-------------|
| Performance | [Measurable targets, consistent with the envelope above] |
| Security | [Requirements the stated threat model actually justifies] |

## Key Risks
[What could go wrong or remains unknown, including risks research surfaced. Other research findings appear only where they changed a requirement or decision.]

## Constraints
| Constraint | Details |
|------------|---------|
| [Type] | [What and why] |

## Success Metrics
[How do we know this succeeded?]

---
*Created: [date]*
```

## Sub-agent review

Before the user sees the draft, have it critiqued. Spawn one or more fresh-context reviewer agents — one is usually enough — giving each the draft, the user's stated requirements, the research findings, and the rubric above. Instruct them to find problems, not to affirm: incomplete, inconsistent, or untestable requirements; scope creep; requirements or an envelope larger than what the user described; missing constraints or out-of-scope entries; boilerplate posing as analysis.

**Hold reviewers to a materiality bar** — this is what keeps review from degenerating into polish. A finding qualifies only if acting on it changes what gets built or a decision the user would make differently. Wording, naming, section ordering, internal-consistency touch-ups, and restating what the document already covers are not findings; the author fixes those silently if they matter at all. Use two severities: **blocker** (ship this document and the work is wrong or a requirement is missing) and **major** (likely to cause real rework). Returning "nothing material" is a good outcome, not a failed review.

Triage the findings and revise for blockers and majors. Run a second round only when the revisions changed the document's shape enough that new problems could have been introduced — never to see whether a fresh reviewer can find something. A round that would produce only editorial changes means review is done. Tell the user what review caught and changed.

## Review and commit

Present the PRD, noting what the sub-agent review changed, and stop for review. Alongside it, offer a **counter-review by the other client**: emit a copy/paste-ready prompt addressed to the client you are not running in (in Claude Code, write it for Codex; in Codex, for Claude Code) so a different model reviews the PRD with fresh eyes. Whether to run it is the user's call. The prompt must be self-contained, along these lines:

```text
Counter-review the PRD at .archflow/tasks/<task>/prd.md.

Read .archflow/context/ first if present — check every workspace repo for its
own .archflow/context/, not just the repo holding the task.

A different model drafted this PRD and already revised it once — your job is to
find what it missed. Challenge requirement completeness, consistency, and
testability; scope boundaries; unstated constraints; and risks the research
overlooked. Also challenge the Operating Envelope in both directions: whether it
understates what this product faces, and whether it or the requirements demand
scale, hardening, or ceremony this product does not need. A PRD must be
reviewable in 5–10 minutes — padding and survey material are defects, not
thoroughness. Do not rewrite the document or change any files outside the
review.

Report only findings that change what gets built or a decision the human would
make differently. Wording, naming, ordering, and internal-consistency polish are
not findings. Use two severities: blocker (ship this and the work is wrong or a
requirement is missing) and major (likely to cause real rework).

Write your findings to .archflow/tasks/<task>/reviews/prd-counter-review.md
as a list, each with a severity and a suggested resolution. If nothing meets
that bar, say so explicitly in that file — that is a valid result.
```

When the user returns and the review file exists without a `## Triage` section, read it and triage every finding: accept it and revise the PRD, or reject it with a stated reason. Rejecting is a normal outcome — a finding that only makes the document read better, or that hardens against something outside the operating envelope, is rejected by default and never reopens the review loop. Append the dispositions as a `## Triage` section to the review file and re-present only what changed.

When re-presenting after revisions, summarize what changed since the last review rather than restating the full document. Repeat until explicitly approved. Then commit only the PRD as:

```text
<Task Title>: Create PRD
```

Report completion with copy/paste-ready next steps:

```text
PRD committed. Next, design the architecture:
Claude Code: /archflow-design <task>
Codex: $archflow-design <task>
```

Never commit or pass a review gate without approval.
