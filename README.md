# ArchFlow

A lightweight, human-centered development workflow for Claude Code. Five commands that turn vague ideas into structured implementations with human review at every stage.

## What It Does

ArchFlow guides you through a structured development process:

```
/arch:explore           Understand an existing codebase
       |
/arch:prd my-feature    Define what you're building (PRD)
       |
/arch:design my-feature Design how to build it (architecture + phases)
       |
/arch:phase my-feature 1   Implement phase 1
/arch:phase my-feature 2   Implement phase 2
       ...                  ...until done
```

Every step produces a markdown document you review and approve before moving on. Nothing happens without your sign-off.

## Install

```bash
git clone <this-repo>
cd ArchflowV2
./install.sh
```

This copies the commands to `~/.claude/commands/arch/` so they're available in any project.

## Usage

### 1. Explore (optional)

Map an existing codebase before starting work:

```
/arch:explore
/arch:explore authentication    # focus on a specific area
```

Produces `.archflow/context/` reference docs that all other commands use.

### 2. Define Requirements

```
/arch:prd my-feature
```

Interactive conversation to gather requirements, followed by automated research. Produces a PRD at `.archflow/tasks/my-feature/prd.md`. Review it, request changes, or approve.

### 3. Design Architecture

```
/arch:design my-feature
```

Explores the codebase, discusses key decisions with you, then designs the technical architecture with a phased implementation plan. Produces `.archflow/tasks/my-feature/architecture.md`.

### 4. Implement Phase by Phase

```
/arch:phase my-feature 1
```

Each phase goes through: **design** (you review) -> **implement** (parallel sub-agents) -> **verify** (you test) -> **log** (capture learnings) -> **commit**.

Later phases read logs from earlier phases so they don't repeat mistakes and build on established patterns.

### 5. Check Status

```
/arch:status
/arch:status my-feature
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
      phases/
        phase-1-setup.md            # Phase design doc
        phase-1-setup-log.md        # Implementation learnings
        phase-2-core.md
        phase-2-core-log.md
```

Planning docs are tracked in git during development to preserve progress across sessions. Remove `.archflow/` before creating a PR.

## Key Design Decisions

- **Human-in-the-loop**: You review and approve at every stage
- **Sub-agent powered**: Heavy work (exploration, research, planning, coding) runs in parallel sub-agents. The main agent orchestrates.
- **Inter-phase learning**: Each phase writes a log of decisions, patterns, gotchas, and interfaces. Later phases read all prior logs.
- **Plan stays accurate**: After each phase, the architecture doc and PRD are updated to reflect what actually happened, not just what was planned.
- **Resumable**: If you lose context mid-phase, re-run the command and it picks up where you left off.
- **Task isolation**: Each task is independent. Deleting one has zero impact on others.

## Detailed Process Documentation

See [docs/archflow-process.md](docs/archflow-process.md) for detailed flowcharts, state machines, and the full sub-agent architecture.
