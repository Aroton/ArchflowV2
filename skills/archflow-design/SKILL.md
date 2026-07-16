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

Keep only the sections that earn their place; omit any that would hold boilerplate for this task. Design the technology stack, architecture, decisions and alternatives, testing strategy, and as many independently testable phases as the work genuinely needs — a small task may be a single phase. Do not pad a simple task into ceremony or cram a complex one into an arbitrary count. Every phase must have a goal, requirement IDs, scope, dependencies where relevant, and observable success criteria.

**Size each phase to the implementation budget.** Each phase is implemented in its own session, and that session's orchestrator must finish the whole phase — implementation plus verification — without compacting its context. Today an orchestrator works in a ~200k-token window; session overhead plus the phase's inputs (design doc, architecture, prior log, context docs) consume roughly 40–50k before work begins, and compaction triggers before the window is full — leaving roughly 100–130k tokens for the work itself. A chunk of work implemented directly in the orchestrator costs ~15–30k (reading the files it touches, making edits, reading test output, iterating on failures); a chunk delegated to a sub-agent costs the orchestrator only ~2–5k (instructions out, summary back), with the heavy lifting in the sub-agent's own fresh window; end-of-phase verification costs another ~10–30k. So a phase implemented through sub-agent delegation carries roughly 8–12 chunks of work, and one implemented directly 3–5. These figures are today's calibration and grow with context windows — the durable rule is the fit: if a phase holds more work than one implementation session can finish, split it.

## Sub-agent review

Before the user sees the draft, have it critiqued. Spawn one or more fresh-context reviewer agents — one is usually enough — giving each the draft, the PRD, and the exploration findings. Instruct them to find problems, not to affirm: requirements with no phase covering them; phases that are not independently testable; phases oversized against the implementation budget above; and decisions whose rationale does not survive scrutiny.

Triage each finding, revise the draft, and repeat until a round surfaces nothing that changes the document — typically one or two rounds; diminishing returns, not a round count, is the stop signal. Tell the user what review caught and changed.

## Review and commit

Present the architecture, noting what the sub-agent review changed, and stop for review. Alongside it, offer a **counter-review by the other client**: emit a copy/paste-ready prompt addressed to the client you are not running in (in Claude Code, write it for Codex; in Codex, for Claude Code) so a different model reviews the design with fresh eyes. Whether to run it is the user's call. The prompt must be self-contained, along these lines:

```text
Counter-review the architecture at .archflow/tasks/<task>/architecture.md.

Read first: .archflow/tasks/<task>/prd.md and .archflow/context/ if present.

A different model drafted this architecture and already revised it once — your
job is to find what it missed. Challenge requirement-to-phase coverage, phase
independence and sizing, technology choices against the actual codebase, and
integration risks. Do not rewrite the document or change any files outside the
review.

Write your findings to
.archflow/tasks/<task>/reviews/architecture-counter-review.md
as a list, each with a severity (blocker / major / minor) and a suggested
resolution. If you find nothing substantive, say so explicitly in that file.
```

When the user returns and the review file exists without a `## Triage` section, read it and triage every finding: accept it and revise the architecture, or reject it with a stated reason. Append the dispositions as a `## Triage` section to the review file and re-present only what changed.

Apply requested changes and repeat until explicit approval; when re-presenting, summarize what changed since the last review rather than restating the full document. Then commit it as:

```text
<Task Title>: Design Architecture
```

Report completion with copy/paste-ready next steps:

```text
Architecture committed. Design phase 1:
Claude Code: /archflow-phase-design <task> 1
Codex: $archflow-phase-design <task> 1
```

Preserve existing history when revising and never commit without approval.
