---
name: archflow-design
description: Design an ArchFlow technical architecture and phased implementation plan from an approved PRD. Use when the user asks to plan architecture, choose implementation approaches, or break a feature into phases.
---

# Create Technical Architecture

Treat the supplied task name as `<task>` and work in `.archflow/tasks/<task>/`.

Run this session as the workflow orchestrator: the decision gate, review gates, and triage stay here because they need the full history, while bulk work — codebase exploration, web research, drafting, fresh-context review — runs in sub-agents that write to disk and return only conclusions. Treat sub-agents as available — both Claude Code and Codex provide them natively; work inline only when spawning actually fails or a piece of work is too small to justify the hand-off.

**Design to the operating envelope.** Build for the scale, criticality, and threat model the PRD states; absent a stated envelope, assume an early-stage product serving thousands of users, not millions, where functionality and maintainability outrank everything else. Handle the failures that are likely or that would lose user data, and stop there — machinery for adversaries, volumes, or partial-failure modes outside the envelope is cost with no payer, and it is the code a small team will be least able to maintain. Prefer the boring, obvious construction over the more general or more defensive one: every abstraction layer, invariant, integrity check, and recovery path has to be bought by a requirement or an actual observed failure, not by a hypothetical. When something would only earn its place at larger scale, record it under Key Decisions as deliberately deferred, with the signal that would make it worth building, and design the simple version now. This applies to every sub-agent brief in this skill — state it in each, since sub-agents see nothing of this conversation.

## Setup and exploration

Read `prd.md`; it is required. If it is absent, stop and direct the user to `archflow-prd <task>`. Read context documents and any existing `architecture.md` — in a multi-root workspace every repo may carry its own `.archflow/context/`; read them all, noting in sub-agent briefs which repo each came from.

Spawn an exploration agent — several in parallel when the PRD spans distinct areas — to explore the current codebase for the requirements and constraints in the PRD: relevant files, functions, and patterns; the correct location for new code; reusable utilities; and conflicts or integration points. When a specific technical challenge needs research, spawn a research agent with web access alongside it for architecture patterns and current framework practices. An agent sees nothing of this conversation, so brief each completely, and have each return only the paths, snippets, and synthesized conclusions the design depends on, not raw survey material.

## Decision gate

Before designing, present and resolve consequential decisions with the user:

- technology choices not already locked in the PRD;
- architecture-pattern tradeoffs;
- rough phase count and order;
- constraints discovered in exploration;
- the operating envelope, if the PRD does not state one — say what you are assuming (early-stage scale, criticality, threat model) and let the user correct it, since every sizing and complexity decision below hangs off it.

Verify candidate technology choices are current before presenting them — a web-capable research agent returns the verdicts without the search material entering this context — so the user is not asked to approve an option the dependency review below would later overturn as stale.

## Write architecture

Spawn a writer agent to draft the architecture; it sees none of this conversation, so provide the full PRD, exploration and research results, resolved user decisions, context documents, and the rubric below. Draft inline only when the task is small enough that the hand-off would cost more than the drafting.

**Architecture rubric** — the bar the writer drafts to and every reviewer judges against:

- A human reviews it in under 10 minutes: the system diagram and the phase list carry the design, prose supports them.
- Diagrams are mermaid, never ASCII/text art.
- Data Model and API Design show actual definitions and contracts with rationale — approval here locks them in, so they must be concrete enough to review.
- Phases are the load-bearing output: independently testable, right-sized to one implementation session, with observable success criteria.
- Nothing exceeds the PRD's operating envelope.

Write `.archflow/tasks/<task>/architecture.md` with this structure:

```markdown
# Architecture: [Task Name]

> Technical design for [Task Name] based on [prd.md](./prd.md)

## Technology Stack
| Layer | Choice | Rationale |
|-------|--------|-----------|
| [Layer] | [Technology] | [Why] |

## System Architecture
[A mermaid diagram of the major components and how data flows between them, plus a short prose walkthrough. Add a second diagram only when one cannot carry the design.]

### Directory Structure
~~~
[Planned layout for new or modified code]
~~~

### Data Model
[Actual table/entity definitions for anything new or changed — columns, types, keys, relationships — each with why it is designed that way. This is the review surface for schema decisions: definitions and rationale, never migration scripts.]

### API Design
[Concrete contracts for new or changed APIs: endpoints or interfaces with request and response shapes. Approved here so phases build against them rather than rediscover them.]

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

**This is where phases get right-sized, and the sizing decided here is the contract.** Downstream skills design and implement within these boundaries; re-splitting a phase later is an exception that costs the user a re-planning cycle, so do the sizing properly now rather than leaving it to be discovered.

Each phase is implemented in its own session, and that session's orchestrator must finish the whole phase — implementation plus verification — without compacting its context. Assume implementation delegates its chunks to sub-agents, because that is the default in `archflow-phase-impl`: the orchestrator spends only ~2–5k tokens per delegated chunk (instructions out, summary back) while the file reads, edits, and test iteration happen in the sub-agent's own fresh window. Against today's ~200k window, session overhead plus phase inputs consume ~40–50k and end-of-phase verification another ~10–30k, which leaves room for roughly 8–12 delegated chunks per phase. These numbers are today's calibration and grow with context windows; the durable rule is the fit. Size phases to land comfortably inside that budget rather than at its edge — a phase packed to the limit is the one that gets split later.

## Sub-agent review

Before the user sees the draft, have it critiqued. Spawn one or more fresh-context reviewer agents — one is usually enough — giving each the draft, the PRD (including its operating envelope), the exploration findings, and the rubric above. Instruct them to find problems, not to affirm: requirements with no phase covering them; phases that are not independently testable; phases oversized against the implementation budget above; decisions whose rationale does not survive scrutiny; and complexity the envelope does not pay for — abstractions, invariants, integrity machinery, or failure handling built for scale, adversaries, or partial-failure modes this product does not face. Over-engineering is a defect here, weighted the same as a gap.

**Hold reviewers to a materiality bar.** A finding qualifies only if acting on it changes what gets built, what the phases contain, or a decision the user would make differently. Wording, naming, section ordering, internal-consistency touch-ups, and restating what the document already says are not findings — the author fixes those silently if they matter at all. Use two severities: **blocker** (build this as written and it fails or misses a requirement) and **major** (likely to cause real rework). Returning "nothing material" is a good outcome, not a failed review.

Alongside the design critique, spawn a dedicated **dependency currency reviewer** with web access whenever the draft names any external dependency — a library, framework, model, service, or pinned version — which is nearly every architecture; skip it only when the design genuinely has no dependency surface. Give it the Technology Stack and Key Decisions, and require its findings to come from live web research, never training knowledge — a model's sense of "current best" is stale by construction. Its mandate:

- **Currency**: for each chosen library, framework, model, or version, verify online that it is still the current recommended option — not deprecated, superseded, unmaintained, or major versions behind — citing enough evidence (latest version, release date, source) for the user to judge.
- **Build vs. buy**: for anything the design implements by hand, check whether a ubiquitous, well-maintained library already solves it. Prefer that library over rolling our own — but only when its license permits: permissive licenses (MIT, Apache-2.0, BSD, ISC) are acceptable; copyleft of any strength (GPL, AGPL, LGPL, MPL) is flagged for the user to decide, never silently adopted.
- **Licenses**: flag any already-chosen dependency whose license conflicts with the project.

Triage the findings and revise for blockers and majors. Run a second round only when the revisions changed the architecture's shape enough that new problems could have been introduced — never to see whether a fresh reviewer can find something. A round that would produce only editorial changes means review is done. Tell the user what review caught and changed.

## Review and commit

Present the architecture, noting what the sub-agent review changed, and stop for review. Alongside it, offer a **counter-review by the other client**: emit a copy/paste-ready prompt addressed to the client you are not running in (in Claude Code, write it for Codex; in Codex, for Claude Code) so a different model reviews the design with fresh eyes. Whether to run it is the user's call. The prompt must be self-contained, along these lines:

```text
Counter-review the architecture at .archflow/tasks/<task>/architecture.md.

Read first: .archflow/tasks/<task>/prd.md and .archflow/context/ if present —
check every workspace repo for its own .archflow/context/, not just the repo
holding the task.

A different model drafted this architecture and already revised it once — your
job is to find what it missed. Challenge requirement-to-phase coverage, phase
independence and sizing, technology choices against the actual codebase and the
current ecosystem (stale versions, superseded models, deprecated APIs, newer
standard options), and integration risks. Challenge complexity too: this targets
the operating envelope in the PRD, so flag abstractions, invariants, integrity
machinery, or failure handling built for scale, adversaries, or partial-failure
modes the product does not face — over-engineering is a defect, not caution. An
architecture must be reviewable in under 10 minutes — padding is a defect too.
Do not rewrite the document or change any files outside the review.

Report only findings that change what gets built or a decision the human would
make differently. Wording, naming, ordering, and internal-consistency polish are
not findings. Use two severities: blocker (build this as written and it fails or
misses a requirement) and major (likely to cause real rework).

Write your findings to
.archflow/tasks/<task>/reviews/architecture-counter-review.md
as a list, each with a severity and a suggested resolution. If nothing meets
that bar, say so explicitly in that file — that is a valid result.
```

When the user returns and the review file exists without a `## Triage` section, read it and triage every finding: accept it and revise the architecture, or reject it with a stated reason. Rejecting is a normal outcome — a finding that only makes the document read better, or that hardens against something outside the operating envelope, is rejected by default and never reopens the review loop. Append the dispositions as a `## Triage` section to the review file and re-present only what changed.

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
