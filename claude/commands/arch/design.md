---
description: Design technical architecture with implementation phases for a task
argument-hint: "<task-name>"
---

# Create Technical Architecture

Create or revise the architecture for task **$ARGUMENTS**.

## Setup

1. Read `.archflow/tasks/$ARGUMENTS/prd.md` -- **REQUIRED**. If missing, tell the user to run `/arch:prd $ARGUMENTS` first and stop.
2. If `.archflow/context/` exists, read the context docs for codebase awareness
3. If `.archflow/tasks/$ARGUMENTS/architecture.md` exists, read it -- we may be revising

## Process

### Step 1: Explore Current Codebase (Sub-Agents)

Launch 1-2 Explore sub-agents (`subagent_type: "Explore"`) to understand the current codebase state relevant to this task.

**Agent 1 -- Relevant Code Analysis:**
Include in the agent's prompt: (1) key requirements and constraints from the PRD, (2) a summary of codebase context from `.archflow/context/` if available. Ask the agent to explore the codebase and find:
- Existing code that relates to this task (files, functions, patterns)
- Where new code should live based on current project structure
- Existing utilities, helpers, or patterns that should be reused
- Potential conflicts or integration points
Return findings with specific file paths and code references.

**Agent 2 -- Architecture Pattern Research (only if needed):**
Use `subagent_type: "general-purpose"` with WebSearch. Include in the agent's prompt: the specific technical challenge from the PRD and any technology constraints. Research architecture patterns relevant to this task: recommended approaches for [specific technical challenge], current best practices for [framework/tech]. Return concise findings (under 500 words).

### Step 2: Discuss Key Decisions with User

Before designing, present the key architectural choices to the user. Use AskUserQuestion for structured decisions:

- Technology choices (if not already locked in PRD)
- Architecture pattern tradeoffs
- Rough phase breakdown (how many phases, what order)
- Any constraints discovered during exploration

### Step 3: Design and Write Architecture (Sub-Agent)

Spawn a general-purpose sub-agent (`subagent_type: "general-purpose"`). Provide it with:
- The full PRD from `.archflow/tasks/$ARGUMENTS/prd.md`
- Codebase exploration results from Step 1
- User decisions from Step 2
- Context docs from `.archflow/context/` if they exist

Ask it to design the full architecture and write it to `.archflow/tasks/$ARGUMENTS/architecture.md` using this template:

```markdown
# Architecture: [Task Name]

> Technical design for [$ARGUMENTS] based on [prd.md](./prd.md)

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| [Layer] | [Technology] | [Why] |

## System Architecture

[High-level description. Text-based diagram if helpful.]

### Directory Structure

\`\`\`
[Planned layout for new/modified code]
\`\`\`

### Data Model

[Core entities and relationships, if applicable]

### API Design

[Key endpoints or interfaces, if applicable]

## Key Decisions

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| [Decision] | [Options] | [Choice] | [Why] |

## Testing Strategy

[How this will be tested. Frameworks, coverage goals.]

## Phases

### Phase 1: [Name]
**Goal**: [What this delivers]
**Requirements**: REQ-01, REQ-02
**Success Criteria**:
- [ ] [Observable behavior from user perspective]
- [ ] [Observable behavior]
**Scope**: [What gets built]

### Phase 2: [Name]
**Goal**: [What this delivers]
**Depends on**: Phase 1
**Requirements**: REQ-04, REQ-05
**Success Criteria**:
- [ ] [Observable behavior]
**Scope**: [What gets built]

[... more phases ...]

## Progress

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Name] | Not Started |
| 2 | [Name] | Not Started |

---
*Created: [date]*
```

The agent should design the technology stack, system architecture, key decisions with alternatives considered, phase decomposition (3-8 phases, each independently testable), and testing strategy. Return only the file path when done.

### Step 4: Present Completion

> Architecture written to `.archflow/tasks/$ARGUMENTS/architecture.md`
>
> Open it in your editor to review the design and phase plan.
>
> When satisfied:
> - Run `/arch:phase $ARGUMENTS 1` to begin implementation
> - Or tell me what to change
