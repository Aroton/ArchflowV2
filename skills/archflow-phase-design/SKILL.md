---
name: archflow-phase-design
description: Design one planned ArchFlow phase, run sub-agent and cross-client reviews, and hand off to implementation. Use when the user asks to design, revise, or counter-review a task phase.
---

# Design Phase

Treat the supplied arguments as `<task> <phase-number>`. This skill only designs — implementation happens in a fresh session via `archflow-phase-impl`, so the implementing agent starts with a clean context that reads nothing but the approved design and its inputs.

Run this session as the workflow orchestrator: state handling, review gates, and triage stay here because they need the full history, while bulk work — exploration, research, drafting, fresh-context review — runs in sub-agents that write to disk and return only conclusions. Treat sub-agents as available — both Claude Code and Codex provide them natively; work inline only when spawning actually fails or a piece of work is too small to justify the hand-off.

**Design to the operating envelope.** Build for the scale, criticality, and threat model the PRD states — absent one, an early-stage product serving thousands of users, where functionality and maintainability outrank everything else. Prefer the boring, obvious construction: every abstraction, invariant, integrity check, and recovery path must be bought by a requirement or an observed failure, never a hypothetical. State this in every sub-agent brief in this skill — a writer or reviewer without this constraint will reliably produce more machinery than the product needs.

## Setup and state

1. Read `.archflow/tasks/<task>/architecture.md`; it is required. If missing, stop and direct the user to `archflow-design <task>`.
2. Locate `<phase-number>` in the architecture’s Phases section. If absent, show available phases and stop.
3. Read relevant `.archflow/context/` documents from every workspace repo that has them. If any carry a commit stamp far behind their repo's current HEAD, warn the user that context may be stale and suggest a refresh in the affected area.
4. For phase 2 or later, read the immediately prior phase's design document and implementation log in `.archflow/tasks/<task>/phases/`. The architecture doc is kept accurate as phases complete, so it plus the latest log carries the durable state; consult older logs only when they cover ground this phase touches.
5. Check for an existing `phase-<N>-*.md` design document and for `.archflow/tasks/<task>/reviews/phase-<N>-design-counter-review.md`.

Then act on state:

- **No design document**: design the phase (below).
- **`DESIGNED` with an untriaged counter-review** (a review file with no `## Triage` section): triage it (see Counter-review triage).
- **`DESIGNED` otherwise**: show the design summary and ask whether to revise or proceed to implementation in a fresh session (`archflow-phase-impl <task> <N>`).
- **`IN PROGRESS`**: report that implementation has started and direct the user to `archflow-phase-impl <task> <N>` to resume.
- **`COMPLETE`**: report it and suggest the next phase.

## Explore and design

Spawn an exploration agent and — only when the phase enters unfamiliar territory — a research agent alongside it; run them in parallel and wait for both. An agent sees nothing of this conversation, so brief each completely:

- **Codebase analysis**: use the phase goal, scope, requirements, prior-phase patterns and interfaces, and the summary of earlier work to identify current file state, reusable utilities and patterns, and integration points. Return paths and code snippets.
- **Targeted research**, only for unfamiliar territory: use the PRD and architecture constraints to research the specific technical challenge; return only the synthesized conclusions the design depends on.

Spawn a writer agent to draft the phase design; it sees none of this conversation, so give it the phase definition, PRD, exploration and research findings, the relevant prior design/log documents, and context documents. Draft inline only when the phase is small enough that the hand-off would cost more than the drafting. Create `.archflow/tasks/<task>/phases/phase-<N>-<slug>.md`, slugging the phase name.

The design must be reviewable in one sitting and define **what** and **where**, not line-by-line implementation or pseudocode. Its primary reader is the implementing agent in a fresh session — favor what a machine consumer needs (exact paths, pinned interface names, unambiguous chunk boundaries) over prose written to persuade a human. It is a plan for a competent implementer who will make the local calls themselves, not a specification that pre-decides them. Interface signatures at chunk boundaries are the exception: when chunks will be implemented separately, pin down the exact exports and types they share so the seams stay coherent. Everything else stays at the level of intent — if a paragraph is naming specific expressions, field accesses, or control flow inside a function, it has dropped below the design's altitude and should be cut back to what the code must accomplish. Prose that dense also makes the document expensive to review and revise, which is how design turns into a loop over wording. Use this structure:

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
[Commands and behaviors the implementing agent runs itself, plus edge cases worth exercising. List separately anything only a human can judge — visual/UX checks, intent alignment.]

---
*Designed: [date]*
```

**The phase boundary from the architecture is the contract — design within it.** Sizing was decided in `archflow-design`, and re-cutting it here costs the user a re-planning cycle and fragments the work into phases too small to deliver anything observable. When a phase feels large, the first lever is delegation, not a smaller phase: implementation delegates chunks to sub-agents, so the implementing orchestrator carries briefs and summaries, not file contents — the architecture already sized the phase to fit one fully delegated session (the calibration numbers live there). The second lever is the design's own altitude — a phase usually looks oversized because the document is over-specified, not because the work is.

Propose a split only when the work genuinely cannot be finished in one implementation session even fully delegated. That is a rare outcome and a user decision: stop, explain what does not fit, and get approval to amend the architecture's phase list before continuing. If it starts happening on most phases, the architecture's sizing is the thing to fix, and say so rather than absorbing it phase by phase.

## Sub-agent review

Before the user sees the draft, have it critiqued. Spawn one or more fresh-context reviewer agents — sized to the phase, one is usually enough — giving each the draft, the phase definition from the architecture, the relevant PRD requirements and operating envelope, and prior-phase interfaces. Instruct them to find problems, not to affirm: requirement coverage gaps, incoherent chunk seams or missing interface contracts, integration risks, conflicts with established patterns, and complexity the envelope does not pay for — invariants, integrity machinery, or failure handling built for scale, adversaries, or partial-failure modes this product does not face. Over-engineering is a defect here, weighted the same as a gap.

**Hold reviewers to a materiality bar** — this is what keeps review from turning into a loop over wording. A finding qualifies only if acting on it changes what gets built: code that would be written differently, a seam that does not fit, a requirement left uncovered, a risk that would cause rework. Wording, naming, section ordering, terminology drift between paragraphs, restating what the document already says, and additional hardening beyond the envelope are not findings — the author fixes anything worth fixing there silently, without a review round. Use two severities: **blocker** (implement this as written and it fails or misses a requirement) and **major** (likely to cause real rework). Returning "nothing material" is a good outcome, not a failed review. Do not ask reviewers to judge phase sizing; the architecture owns that.

Whenever the phase design introduces or pins an external dependency the architecture review did not already clear — a library, framework, model, service, or version, including an architecture-level choice this phase is the first to actually install or use — also spawn a dedicated **dependency currency reviewer** with web access. Skip it when the phase has no new dependency surface; do not re-litigate choices already reviewed and approved at architecture time unless something has actually changed since. Require its findings to come from live web research, never training knowledge — a model's sense of "current best" is stale by construction. It verifies each dependency is still the current recommended option (not deprecated, superseded, unmaintained, or major versions behind), citing enough evidence (latest version, release date, source) for the user to judge; and it checks the work breakdown for anything built by hand that a ubiquitous, well-maintained, permissively-licensed library already solves — prefer that library over rolling our own; copyleft of any strength is flagged for the user to decide, never silently adopted.

Triage the findings and revise for blockers and majors. Run a second round only when the revisions changed the design's shape enough that new problems could have been introduced — never to see whether a fresh reviewer can find something. A round that would produce only editorial changes means review is done. Tell the user what review caught and changed.

## Present and counter-review

Confirm the document exists and present it, noting what the sub-agent review changed. Alongside it, offer a **counter-review by the other client**: emit a copy/paste-ready prompt addressed to the client you are not running in (in Claude Code, write it for Codex using `$`-invocation conventions; in Codex, for Claude Code) so a different model reviews the design with fresh eyes. Whether to run it is the user's call. The prompt must be self-contained, along these lines:

```text
Counter-review the phase design at .archflow/tasks/<task>/phases/phase-<N>-<slug>.md.

Read first: .archflow/tasks/<task>/architecture.md, .archflow/tasks/<task>/prd.md,
and .archflow/context/ if present — check every workspace repo for its own
.archflow/context/, not just the repo holding the task.

A different model drafted this design and already revised it once — your job is to
find what it missed. Challenge requirement coverage, chunk seams and interface
contracts, integration risks, dependency currency (stale versions, superseded
models, deprecated APIs), and anything inconsistent with the architecture or the
actual codebase. Challenge complexity too: this targets the operating envelope in
the PRD, so flag invariants, integrity machinery, or failure handling built for
scale, adversaries, or partial-failure modes the product does not face —
over-engineering is a defect, not caution. Phase sizing is set by the architecture
and is not under review. Do not rewrite the document or change any files outside
the review.

Report only findings that change what gets built: code that would be written
differently, a seam that does not fit, an uncovered requirement, a risk that would
cause rework. Wording, naming, ordering, terminology drift, and polish are not
findings. Use two severities: blocker (implement this as written and it fails or
misses a requirement) and major (likely to cause real rework).

Write your findings to
.archflow/tasks/<task>/reviews/phase-<N>-design-counter-review.md
as a list, each with a severity and a suggested resolution. If nothing meets that
bar, say so explicitly in that file — that is a valid result.
```

Then stop. The user may run the counter-review and come back, give feedback directly, or approve.

## Counter-review triage

When a counter-review file exists without a `## Triage` section, read it and triage every finding: accept it and revise the design, or reject it with a stated reason. Rejecting is a normal outcome — a finding that only makes the document read better, or that hardens against something outside the operating envelope, is rejected by default and never reopens the review loop. Append the dispositions to the review file as a `## Triage` section (finding → accepted/rejected → what changed or why not), and re-present only what changed in the design. Repeat the sub-agent review only if the revisions were substantial.

## Approval and hand-off

Never write implementation code in this skill, and never treat the design as approved without the user saying so. On approval the status stays `DESIGNED`, and you report:

```text
Phase <N> design approved. Implement it in a fresh session so the whole phase
fits in a clean context:
Claude Code: /archflow-phase-impl <task> <N>
Codex: $archflow-phase-impl <task> <N>
```
