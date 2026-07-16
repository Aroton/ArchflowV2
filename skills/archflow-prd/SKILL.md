---
name: archflow-prd
description: Research a domain and create or revise an ArchFlow product requirements document. Use when the user wants to define a feature, its requirements, scope, risks, or success metrics.
---

# Create Product Requirements Document

Treat the task name supplied with this skill as `<task>` and work in `.archflow/tasks/<task>/`.

## Setup and requirements

Create the task directory if necessary. Read `.archflow/context/` when it exists. If `prd.md` already exists, read it and ask whether to revise it or start fresh.

Ask what `<task>` is: the problem being solved and who it is for. Then, over a natural, focused conversation (typically a few rounds — stop as soon as requirements are sufficient), establish:

- problem statement and motivation;
- target users and needs;
- must-have versus nice-to-have features;
- technical stack, timeline, and integration constraints;
- explicit out-of-scope work.

Use structured choices when helpful. Do not research until requirements are sufficient.

## Research

Research only the dimensions that are load-bearing for this task — a user-facing product in a competitive space warrants all three below; an internal tool or refactor may warrant one or none. Skipping a dimension is a judgment call, not a failure. Run whatever you do research in parallel when subagents are available; otherwise perform the same investigations directly. Give every researcher the user's problem, requirements, constraints, and a summary of any context documents, and instruct each to return only the findings the PRD author needs to make decisions — synthesized conclusions, not raw survey material.

1. **Domain research**: current best practices, table-stakes features, and common architecture patterns.
2. **Competitive landscape**: existing solutions, what they do well, recurring complaints, and differentiators.
3. **Technical research**: best practices, pitfalls, and recommended or avoided libraries for technologies in scope.

Use current web research when the domain is fast-moving, competitive positioning matters, or you are uncertain — not as a ritual for every task.

## Write the PRD

Delegate PRD drafting to a writing agent when available; otherwise draft it directly. Give the writer the complete user requirements, all research findings, and any context documents. Write `.archflow/tasks/<task>/prd.md` with genuine analysis rather than boilerplate, scaled to the task: a small internal change deserves a one-page PRD, not a filled-in ceremony. Use this structure, keeping only the sections that earn their place — omit any section that would hold boilerplate for this task:

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

## Non-Functional Requirements
| Category | Requirement |
|----------|-------------|
| Performance | [Measurable targets] |
| Security | [Requirements] |

## Research Summary
### Industry Context
[Synthesized competitive landscape and table stakes]
### Technology Landscape
[Best practices, approaches, and pitfalls]
### Key Risks
[What could go wrong or remains unknown?]

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

Before the user sees the draft, have it critiqued. Spawn one or more fresh-context reviewer agents — one is usually enough — giving each the draft, the user's stated requirements, and the research findings. Instruct them to find problems, not to affirm: incomplete, inconsistent, or untestable requirements; scope creep; missing constraints or out-of-scope entries; boilerplate posing as analysis.

Triage each finding, revise the draft, and repeat until a round surfaces nothing that changes the document — typically one or two rounds; diminishing returns, not a round count, is the stop signal. Tell the user what review caught and changed.

## Review and commit

Present the PRD, noting what the sub-agent review changed, and stop for review. Alongside it, offer a **counter-review by the other client**: emit a copy/paste-ready prompt addressed to the client you are not running in (in Claude Code, write it for Codex; in Codex, for Claude Code) so a different model reviews the PRD with fresh eyes. Whether to run it is the user's call. The prompt must be self-contained, along these lines:

```text
Counter-review the PRD at .archflow/tasks/<task>/prd.md.

Read .archflow/context/ first if present.

A different model drafted this PRD and already revised it once — your job is to
find what it missed. Challenge requirement completeness, consistency, and
testability; scope boundaries; unstated constraints; and risks the research
overlooked. Do not rewrite the document or change any files outside the review.

Write your findings to .archflow/tasks/<task>/reviews/prd-counter-review.md
as a list, each with a severity (blocker / major / minor) and a suggested
resolution. If you find nothing substantive, say so explicitly in that file.
```

When the user returns and the review file exists without a `## Triage` section, read it and triage every finding: accept it and revise the PRD, or reject it with a stated reason. Append the dispositions as a `## Triage` section to the review file and re-present only what changed.

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
