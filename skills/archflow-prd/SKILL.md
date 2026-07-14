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

## Review and commit

Present the PRD and stop for review. When re-presenting after revisions, summarize what changed since the last review rather than restating the full document. Repeat until explicitly approved. Then commit only the PRD as:

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
