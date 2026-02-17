---
description: Research domain and create Product Requirements Document for a task
argument-hint: "<task-name>"
---

# Create Product Requirements Document

Create or revise a PRD for task **$ARGUMENTS**.

## Setup

1. Ensure `.archflow/tasks/$ARGUMENTS/` exists (create if not)
2. If `.archflow/context/` exists, read the context docs for codebase awareness
3. If `.archflow/tasks/$ARGUMENTS/prd.md` already exists, read it and ask:

```
╔══════════════════════════════════════════════════════════╗
║  A PRD already exists for this task.                    ║
║  Revise it, or start fresh?                             ║
╚══════════════════════════════════════════════════════════╝
```

## Process

### Step 1: Gather Requirements

Ask the user:

```
╔══════════════════════════════════════════════════════════╗
║  What is $ARGUMENTS?                                    ║
║  Describe the problem you're solving and who it's for.  ║
╚══════════════════════════════════════════════════════════╝
```

After the initial response, ask focused follow-up questions to cover:
- Problem statement and motivation
- Target users and their needs
- Core features (must-have vs nice-to-have)
- Constraints (tech stack, timeline, integrations)
- What's explicitly out of scope

Keep the conversation natural. Use AskUserQuestion for structured choices where appropriate. Aim for 2-4 rounds.

### Step 2: Research (Parallel Sub-Agents)

Once you have enough context, spawn 2-3 Task sub-agents in parallel. Use `subagent_type: "general-purpose"` for web research.

Include in each agent's prompt: (1) the user's problem description, requirements, and constraints from Step 1, (2) a summary of the codebase context from `.archflow/context/` if it was read in Setup.

**Agent 1 -- Domain Research:**
Ask it to research the [domain] space: current best practices, table-stakes features, common architecture patterns. Use WebSearch for current information. Return concise findings (under 500 words).

**Agent 2 -- Competitive Landscape:**
Research existing solutions in the space. What do they do well? Common complaints? Differentiating features? Use WebSearch. Return concise findings (under 400 words).

**Agent 3 -- Technical Research (only if specific tech was mentioned):**
Research current best practices for [specific technology]. Pitfalls, recommended patterns, libraries to use or avoid. Use WebSearch. Return concise findings (under 400 words).

Wait for all agents to complete.

### Step 3: Write the PRD (Sub-Agent)

Spawn a general-purpose sub-agent (`subagent_type: "general-purpose"`). Provide it with:
- Everything gathered from the user conversation (problem, users, requirements, constraints, scope)
- All research results from Step 2
- Any context docs from `.archflow/context/`

Ask it to design the PRD structure, assign REQ-IDs, and write the full document to `.archflow/tasks/$ARGUMENTS/prd.md` using this template:

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
[Synthesized from domain research -- competitive landscape, table stakes]

### Technology Landscape
[Best practices, recommended approaches, pitfalls]

### Key Risks
[What could go wrong? Unknowns?]

## Constraints

| Constraint | Details |
|------------|---------|
| [Type] | [What and why] |

## Success Metrics

[How do we know this succeeded?]

---
*Created: [date]*
```

Instruct the agent to write with genuine analysis, not boilerplate. The agent should return only the file path when done.

### Step 4: Commit

Stage the PRD file and commit. Convert the task name to human-readable title case (e.g. `user_feedback` becomes `User Feedback`):

```
[Task Name]: Create PRD
```

### Step 5: Present Completion

```
╔══════════════════════════════════════════════════════════╗
║  PRD written to .archflow/tasks/$ARGUMENTS/prd.md       ║
║                                                         ║
║  Open it in your editor to review. When satisfied:      ║
║  - Run /arch:design $ARGUMENTS to design architecture   ║
║  - Or tell me what to change                            ║
╚══════════════════════════════════════════════════════════╝
```
