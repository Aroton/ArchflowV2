---
name: archflow-phase-impl
description: Implement, verify, review, log, and commit one designed ArchFlow phase. Use when the user asks to implement, resume, or complete a task phase.
---

# Implement Phase

Treat the supplied arguments as `<task> <phase-number>`. This skill implements a phase that was designed and approved via `archflow-phase-design`; it is meant to run in a fresh session so the whole phase fits in a clean context.

**Build to the operating envelope.** Implement the approved design and no more: functionality and maintainability first, for the scale, criticality, and threat model the PRD states — absent one, an early-stage product serving thousands of users. Do not add abstraction layers, configuration hooks, defensive invariants, or recovery paths the design did not call for; if implementation reveals one is genuinely needed, that is a deviation worth raising, not a silent addition. State this in every implementation sub-agent brief — an unconstrained agent will over-build.

## Setup and state

1. Read `.archflow/tasks/<task>/architecture.md`; it is required. If missing, stop and direct the user to `archflow-design <task>`.
2. Read the phase design document `phase-<N>-*.md` in `.archflow/tasks/<task>/phases/`; it is required. If missing, stop and direct the user to `archflow-phase-design <task> <N>`.
3. Read relevant `.archflow/context/` documents from every workspace repo that has them, and for phase 2 or later the immediately prior phase's implementation log (older logs only when they cover ground this phase touches).
4. Check `.archflow/tasks/<task>/reviews/` for this phase's review files.

Then act on state:

- **`DESIGNED`**: if `phase-<N>-design-counter-review.md` exists without a `## Triage` section, stop and recommend triaging it first via `archflow-phase-design <task> <N>` — implementing against a design with unaddressed findings wastes the work. Otherwise, the user invoking this skill on an approved design is the instruction to implement: summarize the goal and work breakdown in a few sentences and begin.
- **`IN PROGRESS`**: resume — read the full design, analyze the codebase to determine completed and remaining work, report the result, and continue from that point. If an untriaged `phase-<N>-impl-counter-review.md` exists, triage it (see Implementation counter-review).
- **`COMPLETE`**: report it and suggest the next phase.

## Implement

Set the phase status to `IN PROGRESS`. **Delegate chunks to implementation sub-agents by default.** The orchestrator's context must last the entire phase — implementation, verification, and review — and a delegated chunk costs it a brief out and a summary back, where direct implementation costs the full file reads, edits, and test output. Treat sub-agents as available — both Claude Code and Codex provide them natively. Implement directly only when the phase is small enough (a few chunks touching few files) that delegation overhead buys nothing; the rule is finishing the phase without compaction.

Spawn one implementation agent per chunk. A sub-agent sees nothing of this session, so its brief must be complete: the chunk objective, relevant Files-table paths, the pinned interface contracts, prior-log patterns, and architecture/context conventions. Instruct agents to write files directly and return only a concise summary of modified or created paths. Run chunks in parallel only when their file sets are disjoint — parallel edits to the same file conflict; sequence dependent or overlapping chunks, passing forward the summaries and interfaces they need. After all chunks finish, run the applicable test suite.

## Verify

Run every verification step you can execute yourself: tests, builds, linters, and actually driving the affected flow (run the command, hit the endpoint, exercise the behavior). Fix what fails — routing non-trivial fixes through implementation sub-agents the same way chunks were delegated — and re-verify until your own checks pass.

Then present the evidence — commands run, output observed, behaviors confirmed — alongside anything that genuinely requires human judgment or access you lack (visual/UX checks, production credentials, "does this match your intent"). Stop for the user's verdict. If issues are reported, fix them, re-verify the affected items, and re-present only what changed. Do not proceed until the user confirms.

## Implementation counter-review

Alongside the verification evidence, offer a **counter-review of the implementation by the other client**: emit a copy/paste-ready prompt addressed to the client you are not running in (in Claude Code, write it for Codex; in Codex, for Claude Code). Whether to run it is the user's call. The prompt must be self-contained, along these lines:

```text
Counter-review the implementation of phase <N> of task <task>.

Read first: the design at .archflow/tasks/<task>/phases/phase-<N>-<slug>.md,
.archflow/tasks/<task>/architecture.md, and .archflow/context/ if present —
check every workspace repo for its own .archflow/context/, not just the repo
holding the task.
The changed code is uncommitted — inspect it with git status / git diff, scoped
to the files in the design's Files table.

A different model implemented and already verified this — your job is to find
what it missed: bugs, unhandled edge cases, silent deviations from the design,
unmet success criteria, and violations of the project's established patterns.
This targets the operating envelope in the PRD, so do not ask for hardening,
abstraction, or failure handling beyond what the design called for — code that
exists without a requirement behind it is itself a finding. Do not change any
files.

Report only findings that would change the code: a real defect, an unmet
criterion, a deviation that matters. Style preferences, naming, and speculative
robustness are not findings. Use two severities: blocker (wrong behavior, data
loss, or an unmet success criterion) and major (likely to bite in normal use).

Write your findings to
.archflow/tasks/<task>/reviews/phase-<N>-impl-counter-review.md
as a list, each with a severity and a suggested resolution. If nothing meets that
bar, say so explicitly in that file — that is a valid result.
```

When the user returns and the review file exists without a `## Triage` section, read it and triage every finding: accept it and fix the code, or reject it with a stated reason. Rejecting is a normal outcome — a finding that only expresses a style preference, or that asks for hardening beyond the operating envelope, is rejected by default. Append the dispositions as a `## Triage` section to the review file, re-verify what the fixes touched, and re-present only what changed.

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

Be concrete — the log's reader is the next phase's agent, so every entry is an exact path, signature, or fact a future session would otherwise rediscover the hard way; anything else stays out. Review the log and update only parent-doc content that implementation made inaccurate:

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
Phase <N> complete. Design phase <N+1> next:
Claude Code: /archflow-phase-design <task> <N+1>
Codex: $archflow-phase-design <task> <N+1>
```

Never pass a review or commit gate without confirmation.
