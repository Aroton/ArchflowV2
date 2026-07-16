---
name: archflow-phase-design
description: Design one planned ArchFlow phase, run sub-agent and cross-client reviews, and hand off to implementation. Use when the user asks to design, revise, or counter-review a task phase.
---

# Design Phase

Treat the supplied arguments as `<task> <phase-number>`. This skill only designs — implementation happens in a fresh session via `archflow-phase-impl`, so the implementing agent starts with a clean context that reads nothing but the approved design and its inputs.

## Setup and state

1. Read `.archflow/tasks/<task>/architecture.md`; it is required. If missing, stop and direct the user to `archflow-design <task>`.
2. Locate `<phase-number>` in the architecture’s Phases section. If absent, show available phases and stop.
3. Read relevant `.archflow/context/` documents. If they carry a commit stamp far behind the current HEAD, warn the user that context may be stale and suggest a refresh in the affected area.
4. For phase 2 or later, read the immediately prior phase's design document and implementation log in `.archflow/tasks/<task>/phases/`. The architecture doc is kept accurate as phases complete, so it plus the latest log carries the durable state; consult older logs only when they cover ground this phase touches (glob `*-log.md` and judge by name and the architecture's phase list).
5. Check for an existing `phase-<N>-*.md` design document and for `.archflow/tasks/<task>/reviews/phase-<N>-design-counter-review.md`.

Then act on state:

- **No design document**: design the phase (below).
- **`DESIGNED` with an untriaged counter-review** (a review file with no `## Triage` section): triage it (see Counter-review triage).
- **`DESIGNED` otherwise**: show the design summary and ask whether to revise or proceed to implementation in a fresh session (`archflow-phase-impl <task> <N>`).
- **`IN PROGRESS`**: report that implementation has started and direct the user to `archflow-phase-impl <task> <N>` to resume.
- **`COMPLETE`**: report it and suggest the next phase.

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

**Size the phase to the implementation budget.** The implementing session must finish the whole phase — implementation and verification — inside its orchestrator's context window without compaction. Today that window is ~200k tokens; after session overhead and the phase's inputs (~40–50k) and compaction headroom, roughly 100–130k remain for the work. A chunk implemented directly in the orchestrator costs ~15–30k (file reads, edits, test output, iteration); a chunk delegated to a sub-agent costs the orchestrator only ~2–5k (instructions out, summary back), with the heavy lifting in the sub-agent's own fresh window; end-of-phase verification costs another ~10–30k. That puts a delegated phase at roughly 8–12 chunks and a directly-implemented one at 3–5. The numbers are today's calibration and will grow with context windows — the fit is the rule. If the work breakdown exceeds what fits, stop and propose splitting the phase; update the architecture's phase list with user approval before continuing.

## Sub-agent review

Before the user sees the draft, have it critiqued. Spawn one or more fresh-context reviewer agents — sized to the phase, one is usually enough — giving each the draft, the phase definition from the architecture, the relevant PRD requirements, and prior-phase interfaces. Instruct them to find problems, not to affirm: requirement coverage gaps, incoherent chunk seams or missing interface contracts, oversized scope against the budget above, integration risks, and conflicts with established patterns.

Whenever the phase design introduces or pins any external dependency — a library, framework, model, service, or version, including an architecture-level choice this phase is the first to actually install or use — also spawn a dedicated **dependency currency reviewer** with web access; skip it only when the phase genuinely has no dependency surface. Require its findings to come from live web research, never training knowledge — a model's sense of "current best" is stale by construction. It verifies each dependency is still the current recommended option (not deprecated, superseded, unmaintained, or major versions behind), citing enough evidence (latest version, release date, source) for the user to judge; and it checks the work breakdown for anything built by hand that a ubiquitous, well-maintained library already solves — prefer that library over rolling our own, but only when its license permits: permissive licenses (MIT, Apache-2.0, BSD, ISC) are acceptable; copyleft of any strength (GPL, AGPL, LGPL, MPL) is flagged for the user to decide, never silently adopted.

Triage each finding, revise the draft, and repeat until a round surfaces nothing that changes the document — typically one or two rounds; diminishing returns, not a round count, is the stop signal. Tell the user what review caught and changed.

## Present and counter-review

Confirm the document exists and present it, noting what the sub-agent review changed. Alongside it, offer a **counter-review by the other client**: emit a copy/paste-ready prompt addressed to the client you are not running in (in Claude Code, write it for Codex using `$`-invocation conventions; in Codex, for Claude Code) so a different model reviews the design with fresh eyes. Whether to run it is the user's call. The prompt must be self-contained, along these lines:

```text
Counter-review the phase design at .archflow/tasks/<task>/phases/phase-<N>-<slug>.md.

Read first: .archflow/tasks/<task>/architecture.md, .archflow/tasks/<task>/prd.md,
and .archflow/context/ if present.

A different model drafted this design and already revised it once — your job is to
find what it missed. Challenge requirement coverage, chunk seams and interface
contracts, phase sizing, integration risks, dependency currency (stale versions,
superseded models, deprecated APIs), and anything inconsistent with the
architecture or the actual codebase. Do not rewrite the document or change any files
outside the review.

Write your findings to
.archflow/tasks/<task>/reviews/phase-<N>-design-counter-review.md
as a list, each with a severity (blocker / major / minor) and a suggested
resolution. If you find nothing substantive, say so explicitly in that file.
```

Then stop. The user may run the counter-review and come back, give feedback directly, or approve.

## Counter-review triage

When a counter-review file exists without a `## Triage` section, read it and triage every finding: accept it and revise the design, or reject it with a stated reason. Append the dispositions to the review file as a `## Triage` section (finding → accepted/rejected → what changed or why not), and re-present only what changed in the design. Repeat the sub-agent review only if the revisions were substantial.

## Approval and hand-off

Never write implementation code in this skill, and never treat the design as approved without the user saying so. On approval the status stays `DESIGNED`, and you report:

```text
Phase <N> design approved. Implement it in a fresh session so the whole phase
fits in a clean context:
Claude Code: /archflow-phase-impl <task> <N>
Codex: $archflow-phase-impl <task> <N>
```
