# ArchFlow

A lightweight, human-centered development workflow for Claude Code.

## Repository Structure

This repo contains the ArchFlow command definitions. Source of truth is in `claude/commands/arch/`.

## Commands

| Command | Purpose |
|---------|---------|
| `/arch:explore` | Explore codebase, produce persistent context references |
| `/arch:prd <task>` | Research + create PRD for a task |
| `/arch:design <task>` | Design architecture + phases for a task |
| `/arch:phase <task> N` | Design and implement phase N |
| `/arch:status [task]` | Check status and next action |

## How It Works

All working files live in `.archflow/` (gitignored). Each task gets its own directory:

```
.archflow/
  context/                    # Persistent codebase references (shared across tasks)
  tasks/
    my-feature/
      prd.md                  # Product Requirements Document
      architecture.md         # Technical design + phase breakdown
      phases/
        phase-1-setup.md      # Phase design + implementation notes
        phase-2-core.md
```

## Installation

```bash
./install.sh
```

Copies commands to `~/.claude/commands/arch/` for global availability.
