# ArchFlow

A lightweight, human-centered development workflow for Claude Code and Codex.

## Repository Structure

This repo contains one portable Agent Skills source of truth in `skills/`. The installer copies it to each client's skill-discovery directory.

## Skills

| Skill | Purpose |
|---------|---------|
| `/archflow-explore` | Explore codebase, produce persistent context references |
| `/archflow-prd <task>` | Research + create PRD for a task |
| `/archflow-design <task>` | Design architecture + phases for a task |
| `/archflow-phase <task> N` | Design and implement phase N |
| `/archflow-status [task]` | Check status and next action |

In Codex, invoke the same skill names with `$` instead of `/`: `$archflow-explore`, `$archflow-prd`, `$archflow-design`, `$archflow-phase`, and `$archflow-status`.

## How It Works

All working files live in `.archflow/`. Tracked in git during development to preserve progress across sessions. Remove before PR.

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

Installs the shared skills to `~/.claude/skills/` and `~/.agents/skills/` for global availability.
