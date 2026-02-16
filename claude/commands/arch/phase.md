---
description: Design and implement a phase for a task
argument-hint: "<task-name> <phase-number>"
---

# Design and Implement Phase

Design and/or implement a phase for task **$ARGUMENTS**.

Parse $ARGUMENTS to extract the task name and phase number. For example: `my-feature 2` means task "my-feature", phase 2.

## Setup

1. Read `.archflow/tasks/{task}/architecture.md` -- **REQUIRED**. If missing, tell user to run `/arch:design {task}` first and stop.
2. Parse the phase number from the architecture doc's Phases section. If the phase number doesn't exist, show available phases and stop.
3. If `.archflow/context/` exists, read relevant context docs
4. If this is phase 2+, read ALL prior phase design docs and ALL prior implementation log files (`*-log.md`) from `.archflow/tasks/{task}/phases/`. These contain decisions, patterns, interfaces, and gotchas from earlier phases that inform this one.
5. Check if a phase design doc already exists at `.archflow/tasks/{task}/phases/phase-{N}-*.md`

## Process

### Step 1: Determine Phase State

Check for an existing phase design doc matching the phase number.

**If no design doc exists** → Proceed to Step 2 (Design)

**If design doc exists with status DESIGNED** → Show the design summary and ask: "Ready to implement, or want to revise?"

**If design doc exists with status IN PROGRESS** → Analyze the codebase to determine what's completed vs remaining. Report progress and offer to continue.

**If design doc exists with status COMPLETE** → Tell user the phase is done and suggest the next one.

### Step 2: Explore and Design (Sub-Agents)

Launch sub-agents in parallel:

**Explore Agent (`subagent_type: "Explore"`):**
Include in the agent's prompt: (1) the phase definition from architecture.md (goal, scope, requirements), (2) key patterns and interfaces from prior phase logs if available, (3) a summary of what was built in previous phases. Ask it to explore the codebase and find:
- Current state of files this phase will touch or build on
- Existing patterns, utilities, and code to reuse
- Integration points with code from previous phases
Return findings with specific file paths and code snippets.

**Research Agent (`subagent_type: "general-purpose"`, only if phase involves unfamiliar territory):**
Include in the agent's prompt: the technical challenge and relevant constraints from the PRD and architecture doc. Research best practices for [specific technical challenge in this phase]. Use WebSearch. Return concise findings (under 400 words).

Then spawn a **general-purpose sub-agent** (`subagent_type: "general-purpose"`) with:
- The architecture doc and this phase's definition
- The PRD from `.archflow/tasks/{task}/prd.md`
- Codebase exploration results
- Any research results
- ALL prior phase design docs and implementation logs (decisions, patterns, interfaces, gotchas)
- Context docs from `.archflow/context/` if available

Ask it to create a detailed phase plan and write it directly to `.archflow/tasks/{task}/phases/phase-{N}-{slug}.md` (create the `phases/` directory if needed).

Derive the slug from the phase name in architecture.md. Convert to lowercase, replace spaces with hyphens. For example: "Database Setup" becomes `phase-1-database-setup`.

The agent should use this template:

```markdown
# Phase N: [Name]

**Status**: DESIGNED
**Task**: [task name]
**Goal**: [From architecture doc]
**Requirements**: [REQ-IDs]

## Context

[What's been built so far. What this builds on. Key decisions that affect this phase.]

## Design

### What We're Building

[Detailed description. Explain the approach, technical decisions, how pieces fit together.]

### Files to Create

| File | Purpose |
|------|---------|
| [path] | [What it does] |

### Files to Modify

| File | Changes |
|------|---------|
| [path] | [What changes and why] |

## Implementation Steps

1. **[Step name]**: [Description. Mark as PARALLEL if independent of other steps.]
2. **[Step name]**: [Description]
3. **[Step name]**: [Description]

## Success Criteria

- [ ] [Observable behavior]
- [ ] [Observable behavior]
- [ ] [Tests pass / Build succeeds]

## Testing

[What tests to write or run]

## Notes

[Anything discovered that affects future phases]

---
*Designed: [date]*
```

The agent should return only the file path when done.

### Step 3: Present Design

Read the phase design doc to confirm it was written. Present the design to the user:

> Phase design created at `.archflow/tasks/{task}/phases/phase-{N}-{slug}.md`
>
> Review it in your editor. Say **"implement"** to proceed, or provide feedback.

**STOP HERE AND WAIT FOR USER RESPONSE.**

### Step 4: Implement

After user approves:

1. Update status to **IN PROGRESS** in the phase doc
2. Read the implementation steps from the phase design doc
3. Analyze which steps are independent (marked PARALLEL or clearly no dependencies between them) vs which depend on prior steps
4. Fan out independent steps to parallel sub-agents (`subagent_type: "general-purpose"`). For each agent, include:
   - The specific step(s) to implement
   - Relevant context (architecture decisions, patterns from prior phases, file paths)
   - Instruction to write code files directly and return a summary of what was created/modified (file paths only, not contents)
5. Run dependent steps sequentially, each in its own sub-agent, waiting for prior steps to complete
6. After all steps complete, run tests where specified

### Step 5: Verify

After all implementation steps are done, present specific, actionable verification steps to the user:

> Implementation complete. Please verify:
>
> 1. [Specific command to run and expected output]
> 2. [Specific behavior to check]
> 3. [Specific edge case to test]
>
> Report any issues, or say **"verified"** to proceed.

**STOP AND WAIT FOR USER RESPONSE.**

If the user reports issues, fix them and re-present the verification steps. Only proceed to Step 6 after the user confirms verification passes.

### Step 6: Write Implementation Log

Create `.archflow/tasks/{task}/phases/phase-{N}-{slug}-log.md`:

```markdown
## Implementation Log: Phase N - [Name]

### Decisions Made
[Key technical decisions made during implementation and why]

### Deviations from Plan
[What changed from the phase design and why]

### Patterns Established
[Patterns introduced that future phases should follow]

### Gotchas
[Unexpected issues encountered, workarounds applied]

### Key Interfaces
[Exact file paths, exports, and function signatures that other phases will depend on]
```

This log is consumed by future phases. Be specific -- include file paths, function names, and concrete details, not generalities.

### Step 7: Update Parent Docs

Review the implementation log for deviations, new patterns, or changed requirements. Update the parent docs to keep them accurate:

**Architecture doc** (`.archflow/tasks/{task}/architecture.md`):
- Mark this phase as "Complete" in the Progress table
- If deviations affected the technical approach (new patterns, changed data model, different tech choices), update the relevant sections (System Architecture, Data Model, Key Decisions, etc.)
- If remaining phases are affected by what was learned, update their Goal, Scope, or Requirements to reflect reality. Add/remove/reorder phases if needed.

**PRD** (`.archflow/tasks/{task}/prd.md`):
- If requirements changed during implementation (discovered to be infeasible, split, or new ones emerged), update the Functional Requirements tables
- Move anything confirmed out of scope to the Out of Scope table with a reason

Only update what actually changed -- don't rewrite sections that are still accurate.

### Step 8: Complete

Update the phase doc: set status to **COMPLETE**, add implementation date.

> Phase complete.
>
> Next: Run `/arch:phase {task} [N+1]` to continue.

### Resuming After Context Loss

If the user runs this command and the phase doc has status IN PROGRESS:

1. Read the phase design doc for the full plan
2. Launch an Explore sub-agent to analyze what's been implemented so far
3. Report what's done and what remains
4. Continue implementation from where it left off
