# ArchFlow

A lightweight, human-centered development workflow for Claude Code and Codex. Six portable Agent Skills turn vague ideas into structured implementations with human review at every stage.

## What It Does

ArchFlow guides you through a structured development process:

```
/archflow-explore       Understand an existing codebase
       |
/archflow-prd my-feature    Define what you're building (PRD)
       |
/archflow-design my-feature Design how to build it (architecture + phases)
       |
/archflow-phase-design my-feature 1   Design phase 1 (review, approve)
/archflow-phase-impl my-feature 1     Implement phase 1 (fresh session)
/archflow-phase-design my-feature 2   ...until done
```

Every step produces a markdown document you review and approve before moving on. Nothing happens without your sign-off. Before each document reaches you, sub-agent reviewers have already critiqued and improved it — and at every gate you get a ready-to-paste prompt to have the *other* client (Claude Code ↔ Codex) counter-review the work.

## Install

```bash
git clone <this-repo>
cd ArchflowV2
./install.sh
```

This installs both integrations:

- Claude Code skills in `~/.claude/skills/`
- Codex skills in `~/.agents/skills/`

Install just one with `./install.sh --claude` or `./install.sh --codex`. Restart Codex after installing if the skills are not listed yet.

## Usage

### 1. Explore (optional)

Map an existing codebase before starting work:

```
/archflow-explore
/archflow-explore authentication    # focus on a specific area
```

In Codex, replace the leading `/` with `$`; for example, `$archflow-explore`.

Produces `.archflow/context/` reference docs that all other skills use.

Context is per-repo. When the session is a multi-root workspace — a primary director plus additional repos added as extra folders — each repo can carry its own `.archflow/context/` (run explore against each). The task's `.archflow/tasks/` tree lives in one repo, but every skill reads context documents from all workspace repos.

### 2. Define Requirements

```
/archflow-prd my-feature
```

Interactive conversation to gather requirements, followed by automated research. Produces a PRD at `.archflow/tasks/my-feature/prd.md`. Review it, request changes, or approve.

The PRD records an **operating envelope** — realistic scale, criticality, and threat model. Everything downstream is designed and reviewed against it, so the architecture solves the problem you actually have instead of one a thousand times larger.

### 3. Design Architecture

```
/archflow-design my-feature
```

Explores the codebase, discusses key decisions with you, then designs the technical architecture with a phased implementation plan. Produces `.archflow/tasks/my-feature/architecture.md`.

This is where phases get right-sized, and that sizing is the contract for everything after it.

### 4. Design Each Phase

```
/archflow-phase-design my-feature 1
```

Explores the codebase, drafts the phase design, runs a sub-agent review loop on it, then presents it with a ready-to-paste counter-review prompt for the other client. Findings land in `.archflow/tasks/my-feature/reviews/` and get triaged into the design. You approve when it's right.

Phase design works inside the boundary the architecture set — it doesn't re-cut it. Phases are sized so each fits one implementation session, orchestrated through sub-agents, without context compaction; a phase that turns out not to fit even when fully delegated is a rare, user-approved amendment to the architecture rather than a routine split.

### 5. Implement Each Phase

```
/archflow-phase-impl my-feature 1
```

Run this in a **fresh session** so the whole phase gets a clean context. It reads only the approved design and its inputs, then: **implement** (sub-agent delegation by default) -> **verify** (agent runs the checks, you review the evidence) -> **counter-review** (optional cross-client review of the diff) -> **log** (capture learnings) -> **commit**.

Later phases read the up-to-date architecture doc and the latest log so they don't repeat mistakes and build on established patterns.

### 6. Check Status

```
/archflow-status
/archflow-status my-feature
```

See where things stand and what to do next.

## File Structure

All planning artifacts live in `.archflow/` within your project:

```
.archflow/
  context/                          # Shared codebase references
    architecture.md
    patterns.md
    dependencies.md
  tasks/
    my-feature/                     # One directory per task
      prd.md                        # Product requirements
      architecture.md               # Technical design + phase plan
      reviews/                      # Cross-client counter-reviews + triage
        prd-counter-review.md
        phase-1-design-counter-review.md
        phase-1-impl-counter-review.md
      phases/
        phase-1-setup.md            # Phase design doc
        phase-1-setup-log.md        # Implementation learnings
        phase-2-core.md
        phase-2-core-log.md
```

Planning docs are tracked in git during development to preserve progress across sessions. Remove `.archflow/` before creating a PR.

## Key Design Decisions

- **Human-in-the-loop**: You review and approve at every stage — the agent does the labor (including running verification), you exercise the judgment
- **Reviewed before you see it**: Every document (PRD, architecture, phase design) goes through a sub-agent review before reaching your gate — fresh-context critics find gaps, the author triages and revises
- **Rubrics with review-time budgets**: Each artifact states what good looks like — a PRD reads in 5–10 minutes; an architecture in under 10, carried by mermaid diagrams and concrete data-model/API contracts — and writers draft to that bar before reviewers ever see it
- **Review has a materiality bar**: Reviewers report only what changes what gets built, at two severities (blocker, major). Wording, naming, and polish are never findings, "nothing material" is a valid result, and a second round happens only when revisions actually changed the document's shape — so review converges instead of looping
- **Built for your actual scale**: The PRD fixes an operating envelope — scale, criticality, threat model — and every design and reviewer is held to it. Over-engineering counts as a defect, weighted the same as a gap
- **Cross-client counter-review**: Every gate emits a ready-to-paste prompt so the other client (Claude Code ↔ Codex) can review the document or diff with a different model; findings land in `reviews/` and get triaged explicitly
- **Sized to the context budget, once**: A phase must finish — implementation plus verification — inside one session's context window without compaction. Implementation delegates chunks to sub-agents by default, which keeps the orchestrator's window lean (a delegated chunk costs it a few thousand tokens instead of tens of thousands). Sizing is decided in the architecture and holds from there; later re-splitting is an exception, not a step
- **Inter-phase learning**: Each phase writes a log of decisions, patterns, gotchas, and interfaces. The architecture doc absorbs deviations so later phases read current truth, not a log pile; durable conventions get promoted to the project's CLAUDE.md.
- **Plan stays accurate**: After each phase, the architecture doc and PRD are updated to reflect what actually happened, not just what was planned.
- **Resumable**: If you lose context mid-phase, re-run the skill and it picks up where you left off.
- **Task isolation**: Each task is independent. Deleting one has zero impact on others.

## Detailed Process Documentation

See [docs/archflow-process.md](docs/archflow-process.md) for detailed flowcharts, state machines, and the full sub-agent architecture.
