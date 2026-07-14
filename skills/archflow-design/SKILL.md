---
name: archflow-design
description: Design an ArchFlow technical architecture and phased implementation plan from an approved PRD. Use when the user asks to plan architecture, choose implementation approaches, or break a feature into phases.
---

# Create Technical Architecture

Treat the supplied task name as `<task>` and work in `.archflow/tasks/<task>/`.

## Setup and exploration

Read `prd.md`; it is required. If it is absent, stop and direct the user to `archflow-prd <task>`. Read context documents and any existing `architecture.md`.

Use an exploration agent when available, otherwise investigate directly. Explore the current codebase for the requirements and constraints in the PRD: relevant files, functions, and patterns; the correct location for new code; reusable utilities; and conflicts or integration points. When a specific technical challenge needs research, use current web research for architecture patterns and current framework practices; return only the synthesized conclusions the design depends on, not raw survey material.

## Decision gate

Before designing, present and resolve consequential decisions with the user:

- technology choices not already locked in the PRD;
- architecture-pattern tradeoffs;
- rough phase count and order;
- constraints discovered in exploration.

## Write architecture

Delegate architecture drafting to a writing agent when available; otherwise draft it directly. Provide the full PRD, exploration and research results, resolved user decisions, and context documents. Write `.archflow/tasks/<task>/architecture.md` with this structure:

```markdown
# Architecture: [Task Name]

> Technical design for [Task Name] based on [prd.md](./prd.md)

## Technology Stack
| Layer | Choice | Rationale |
|-------|--------|-----------|
| [Layer] | [Technology] | [Why] |

## System Architecture
[High-level description; use a text diagram if helpful.]

### Directory Structure
~~~
[Planned layout for new or modified code]
~~~

### Data Model
[Core entities and relationships, if applicable]

### API Design
[Key endpoints or interfaces, if applicable]

## Key Decisions
| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| [Decision] | [Options] | [Choice] | [Why] |

## Testing Strategy
[Frameworks, coverage goals, and how this will be tested]

## Phases
### Phase 1: [Name]
**Goal**: [What this delivers]
**Requirements**: REQ-01, REQ-02
**Success Criteria**:
- [ ] [Observable behavior]
**Scope**: [What gets built]

### Phase 2: [Name]
**Goal**: [What this delivers]
**Depends on**: Phase 1
**Requirements**: REQ-04, REQ-05
**Success Criteria**:
- [ ] [Observable behavior]
**Scope**: [What gets built]

## Progress
| Phase | Name | Status |
|-------|------|--------|
| 1 | [Name] | Not Started |
| 2 | [Name] | Not Started |

---
*Created: [date]*
```

Keep only the sections that earn their place; omit any that would hold boilerplate for this task. Design the technology stack, architecture, decisions and alternatives, testing strategy, and as many independently testable phases as the work genuinely needs — typically 3–6, but a small task may be a single phase and a large one more. Do not pad a simple task into ceremony or cram a complex one into an arbitrary count. Every phase must have a goal, requirement IDs, scope, dependencies where relevant, and observable success criteria.

## Review and commit

Present the architecture and stop for review. Apply requested changes and repeat until explicit approval; when re-presenting, summarize what changed since the last review rather than restating the full document. Then commit it as:

```text
<Task Title>: Design Architecture
```

Report completion with copy/paste-ready next steps:

```text
Architecture committed. Begin phase 1:
Claude Code: /archflow-phase <task> 1
Codex: $archflow-phase <task> 1
```

Preserve existing history when revising and never commit without approval.
