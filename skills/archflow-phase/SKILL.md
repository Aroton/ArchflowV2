---
name: archflow-phase
description: Design, implement, verify, log, and commit one planned ArchFlow phase. Use when the user asks to start, resume, or complete a task phase.
---

# Design and Implement Phase

Treat the supplied arguments as `<task> <phase-number>`.

## Setup and state

1. Read `.archflow/tasks/<task>/architecture.md`; it is required. If missing, stop and direct the user to `archflow-design <task>`.
2. Locate `<phase-number>` in the architecture’s Phases section. If absent, show available phases and stop.
3. Read relevant `.archflow/context/` documents. If they carry a commit stamp far behind the current HEAD, warn the user that context may be stale and suggest a refresh in the affected area.
4. For phase 2 or later, read the immediately prior phase's design document and implementation log in `.archflow/tasks/<task>/phases/`. The architecture doc is kept accurate as phases complete, so it plus the latest log carries the durable state; consult older logs only when they cover ground this phase touches (glob `*-log.md` and judge by name and the architecture's phase list).
5. Check for an existing `phase-<N>-*.md` design document.

If no design exists, design the phase. If status is `DESIGNED`, show its summary and ask whether to implement or revise. If `IN PROGRESS`, inspect the repository, report completed and remaining work, and offer to continue. If `COMPLETE`, report it and suggest the next phase.

## Explore and design

Use an exploration agent and, where needed, a research agent when available; otherwise perform the same work directly. Investigate in parallel where possible:

- **Codebase analysis**: use the phase goal, scope, requirements, prior-phase patterns and interfaces, and the summary of earlier work to identify current file state, reusable utilities and patterns, and integration points. Return paths and code snippets.
- **Targeted research**, only for unfamiliar territory: use the PRD and architecture constraints to research the specific technical challenge; return only the synthesized conclusions the design depends on.

Delegate phase-design drafting to a writing agent when available; otherwise draft it directly. Give the writer the phase definition, PRD, exploration and research findings, the relevant prior design/log documents, and context documents. Create `.archflow/tasks/<task>/phases/phase-<N>-<slug>.md`; create `phases/` if needed. Derive `<slug>` from the phase name: lowercase with spaces replaced by hyphens.

The design must be reviewable in one sitting and define **what** and **where**, not line-by-line implementation or pseudocode. Interface signatures at chunk boundaries are the exception: when chunks will be implemented separately, pin down the exact exports and types they share so the seams stay coherent. Use this structure:

```markdown
# Phase N: [Name]

**Status**: DESIGNED
**Task**: [task name]
**Goal**: [From architecture doc]
**Requirements**: [REQ-IDs]

## Context
[1–2 paragraphs: earlier work and decisions that affect this phase.]

## What We're Building
[1–2 paragraphs: high-level approach; no code.]

## Files
| Action | File | Purpose |
|--------|------|---------|
| Create | [path] | [What it does] |
| Modify | [path] | [What changes and why] |

## Work Breakdown
1. **[Chunk name]**: [1–2 sentences: what to build, not how.]
2. **[Chunk name]**: [1–2 sentences.]
3. **[Chunk name]**: [1–2 sentences; note dependencies.]

## Success Criteria
- [ ] [Observable behavior from the user perspective]
- [ ] [Observable behavior]
- [ ] [Tests pass / build succeeds]

## Verification Steps
[Specific commands, behaviors, and edge cases for the user to check.]

---
*Designed: [date]*
```

The work breakdown should contain a handful of coherent chunks — typically 3–6, sized to the phase. Confirm the document exists, present it, and stop for the user to say `implement` or provide feedback.

## Implement

After approval, set the phase status to `IN PROGRESS`. Implement directly by default — a single agent with full context produces more coherent code than several that cannot see each other's changes. Fan out to parallel implementation agents only when chunks touch disjoint files and the phase is large enough that parallelism pays for the coordination cost.

When delegating a chunk, provide its objective, relevant Files-table paths, the pinned interface contracts, prior-log patterns, and architecture/context conventions. Instruct agents to write files directly and return only a concise summary of modified or created paths. Run independent chunks in parallel; wait for dependencies and pass their summaries to dependent work. After all chunks finish, run the applicable test suite.

## Verify

Run every verification step you can execute yourself: tests, builds, linters, and actually driving the affected flow (run the command, hit the endpoint, exercise the behavior). Fix what fails and re-verify until your own checks pass.

Then present the evidence — commands run, output observed, behaviors confirmed — alongside anything that genuinely requires human judgment or access you lack (visual/UX checks, production credentials, "does this match your intent"). Stop for the user's verdict. If issues are reported, fix them, re-verify the affected items, and re-present only what changed. Do not proceed until the user confirms.

## Log and update parents

Create `phase-<N>-<slug>-log.md` with this structure:

```markdown
## Implementation Log: Phase N - [Name]

### Decisions Made
[Key technical decisions and why]

### Deviations from Plan
[What changed and why]

### Patterns Established
[Patterns future phases should follow]

### Gotchas
[Unexpected issues and workarounds]

### Key Interfaces
[Exact paths, exports, and function signatures future phases depend on]
```

Be concrete. Review the log and update only parent-doc content that implementation made inaccurate:

- In `architecture.md`, mark the phase complete; update system architecture, data model, decisions, and remaining phases when actual deviations require it, including adding, removing, or reordering phases.
- In `prd.md`, update requirements made infeasible, split, or newly necessary; move confirmed exclusions to Out of Scope with a reason.

Then check the log for rules that outlive this task: durable conventions every future session should follow regardless of ArchFlow (error-handling patterns, "always use X repo, never query directly", build/test gotchas). Propose adding those to the project's `CLAUDE.md` — `.archflow/` is removed before PR, so anything permanent must live outside it. Task-specific detail stays in the log.

## Confirm, commit, complete

Ask the user for explicit confirmation to commit and stop. Apply requested changes and repeat until approval. Then stage the files this phase created or modified — not unrelated working-tree changes — and commit:

```text
<Task Title> Phase <N>: <Phase Name>

<2–3 sentence summary of delivered work, key decisions, and deviations>
```

After committing, set the phase design status to `COMPLETE`, add the implementation date, and present the next phase with copy/paste-ready commands:

```text
Phase <N> complete. Continue with phase <N+1>:
Claude Code: /archflow-phase <task> <N+1>
Codex: $archflow-phase <task> <N+1>
```

Never write code before design approval, and never pass a review or commit gate without confirmation.

When resuming after context loss with an `IN PROGRESS` document, read the full design, analyze the codebase to determine completed and remaining work, report the result, and continue from that point.
