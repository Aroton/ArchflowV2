---
name: archflow-prd
description: Research a domain and create or revise an ArchFlow product requirements document. Use when the user wants to define a feature, its requirements, scope, risks, or success metrics.
---

# Create Product Requirements Document

Treat the task name supplied with this skill as `<task>` and work in `.archflow/tasks/<task>/`.

## Setup and requirements

Create the task directory if necessary. Read `.archflow/context/` when it exists. If `prd.md` already exists, read it and ask whether to revise it or start fresh.

Ask what `<task>` is: the problem being solved and who it is for. Then, over 2–4 natural, focused rounds, establish:

- problem statement and motivation;
- target users and needs;
- must-have versus nice-to-have features;
- technical stack, timeline, and integration constraints;
- explicit out-of-scope work.

Use structured choices when helpful. Do not research until requirements are sufficient.

## Research

Run the following independent research work in parallel when available; otherwise perform the same investigations directly. Give every researcher the user’s problem, requirements, constraints, and a summary of any context documents. Wait for all work to complete.

1. **Domain research**: current best practices, table-stakes features, and common architecture patterns; return at most 500 words.
2. **Competitive landscape**: existing solutions, what they do well, recurring complaints, and differentiators; return at most 400 words.
3. **Technical research**, only when a specific technology is in scope: best practices, pitfalls, and recommended or avoided libraries; return at most 400 words.

Use current web research for domain and competitive research; use it for technical research when a specific technology is in scope.

## Write the PRD

Delegate PRD drafting to a writing agent when available; otherwise draft it directly. Give the writer the complete user requirements, all research findings, and any context documents. Write `.archflow/tasks/<task>/prd.md` with genuine analysis rather than boilerplate and this structure:

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

Present the PRD and stop for review. Revise and re-present until explicitly approved. Then commit only the PRD as:

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
