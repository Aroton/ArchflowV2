# ArchFlow

A lightweight, human-centered development workflow for Claude Code and Codex. Eight portable Agent Skills turn vague ideas into structured implementations with human review at every stage.

## What It Does

ArchFlow guides you through a structured development process:

```
/archflow-init          Initialize repository assets and MCP registration
       |
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

An in-flight legacy task takes an explicit side path into a new task, then rejoins the ordinary PRD and design flow:

```
/archflow-upgrade .archflow/tasks/legacy-task new-task
       |
/archflow-prd new-task
       |
/archflow-design new-task
```

The phase skills marshal the MCP-backed workflow and stop at durable human approval gates. Before each document advances, self-review, independent counter-review, triage, and adjudication evidence must reach a fixed point. Every gate also offers an optional ready-to-run prompt for the configured opposite producer family.

## Install

```bash
git clone <this-repo>
cd ArchflowV2
./install.sh
```

This verifies the tracked offline payload, installs the server and local-helper bundle under
`${ARCHFLOW_HOME:-$HOME/.archflow}/bundle/`, creates `archflow-mcp` and `archflow-local`
launchers under `${ARCHFLOW_BIN:-$HOME/.local/bin}/`, and installs both skill integrations:

- Claude Code skills in `~/.claude/skills/`
- Codex skills in `~/.agents/skills/`

The launcher directory must already be on `PATH`; otherwise the installer prints the exact
`export PATH=...` line and stops. Install just one skill integration with
`./install.sh --claude` or `./install.sh --codex`. Restart Codex after installing if the skills
are not listed yet.

From the repository you want to initialize, run `/archflow-init` in Claude Code or
`$archflow-init` in Codex. Initialization scaffolds the repository-owned ArchFlow assets and
project MCP registrations, then reports the host approval/trust steps that still require you.
It does not create a task, commit changes, or claim that host approval has completed.

> **Self-hosting note:** Phase 19 ships and proves the legacy upgrade path, while this repository deliberately finishes its own `mcp-integration` task under the legacy system. For any in-flight legacy task, either finish it with the legacy tooling or run `archflow-upgrade` into a distinct new task. ArchFlow never performs a silent in-place conversion.

## Usage

### 1. Initialize

From the repository you want ArchFlow to manage:

```
/archflow-init
```

In Codex, run `$archflow-init`. Review and commit the repository assets before creating a task; initialization itself creates no task and makes no commit.

### 2. Upgrade an In-Flight Legacy Task

Choose this path instead of silently converting an existing task:

```
/archflow-upgrade .archflow/tasks/legacy-task new-task
```

In Codex, run `$archflow-upgrade .archflow/tasks/legacy-task new-task`. The source and destination must be in the same repository, and the destination must be a distinct task. The skill stages the selected legacy bytes without modifying the source, initializes the new task, reruns the canonical PRD and design approval pipelines, opens the migration audit, and resumes at the phase derived from imported implementation logs. Use its explicit exclusion list when you intend to redo the last implemented phase. Legacy documents and reviews remain historical material, never approval evidence.

### 3. Explore (optional)

Map an existing codebase before starting work:

```
/archflow-explore
/archflow-explore authentication    # focus on a specific area
```

In Codex, replace the leading `/` with `$`; for example, `$archflow-explore`.

Produces `.archflow/context/` reference docs that all other skills use.

### 4. Define Requirements

```
/archflow-prd my-feature
```

Creates or revises `.archflow/tasks/my-feature/prd.md`, then drives its review evidence and explicit artifact-approval gate.

### 5. Design Architecture

```
/archflow-design my-feature
```

Creates or revises the technical design and phase plan at `.archflow/tasks/my-feature/design.md`, then drives its review evidence and explicit artifact-approval gate. Finite plans use consecutive exact `### Phase N: Name` headings starting at 1. An intentionally open-ended plan instead uses `<!-- archflow:phase-plan:open-ended -->` with no phase headings; malformed or ambiguous plans cannot be approved.

### 6. Design Each Phase

```
/archflow-phase-design my-feature 1
```

Creates or revises `.archflow/tasks/my-feature/phases/1/design.md` and drives review, triage, adjudication, and any required human gate. It reports `DESIGNED` only when durable state proves the fixed point is closed.

Phases are sized to the implementation budget: each must fit one implementation session — orchestrated through sub-agents — without context compaction. If a design reveals more work than fits, the phase gets split and the technical design is updated.

### 7. Implement Each Phase

```
/archflow-phase-impl my-feature 1
```

Run this in a **fresh session** so the whole phase gets a clean context. It implements the approved phase, verifies the result, and records `.archflow/tasks/my-feature/phases/1/impl-notes.md`. It stages or commits nothing until an explicit commit-authorization decision is bound to the current diff.

Later phases read the up-to-date `design.md` and prior `impl-notes.md` so they build on current decisions and interfaces.

### 8. Check Status

```
/archflow-status
/archflow-status my-feature
```

See reconciled durable state and exactly one next action for each task.

## File Structure

All workflow artifacts live in `.archflow/` within your project:

```
.archflow/
  workflow.yaml                     # Canonical phase graph
  constitution/                     # Repository-owned policy rules
  context/                          # Shared codebase references
    architecture.md
    patterns.md
    dependencies.md
  tasks/
    my-feature/                     # One directory per task
      config.yaml                   # Versioned task configuration
      state.json                    # Durable workflow authority
      prd.md                        # Product requirements
      design.md                     # Technical design + phase plan
      phases/
        1/
          design.md                 # Phase design
          impl-notes.md             # Implementation notes
        2/
          design.md
          impl-notes.md
      reviews/                      # Durable review projections
      decisions/                    # Archived human gate decisions
      results/                      # Content-addressed retained results
```

Planning docs are tracked in git during development to preserve progress across sessions. Remove `.archflow/` before creating a PR.

## Key Design Decisions

- **Human-in-the-loop**: You review and approve at every stage — the agent does the labor (including running verification), you exercise the judgment
- **Durable review fixed point**: Every document records self-review plus a configured opposite-producer-family counter-review, then durable triage and adjudication resolve the findings before the workflow can advance
- **Optional gate review**: Every human gate offers a ready-to-run prompt for an additional opposite-producer-family review; the human decides whether to run it, and any resulting findings are durably triaged before the gate resolves
- **Sized to the context budget**: A phase must finish — implementation plus verification — inside one session's context window without compaction. Implementation delegates chunks to sub-agents by default, which keeps the orchestrator's window lean (a delegated chunk costs it a few thousand tokens instead of tens of thousands)
- **Inter-phase learning**: Each phase writes `impl-notes.md` with decisions, patterns, gotchas, and interfaces. The technical design absorbs deviations so later phases read current truth; durable conventions get promoted to the project's CLAUDE.md.
- **Plan stays accurate**: After each phase, `design.md` and `prd.md` are updated to reflect what actually happened, not just what was planned.
- **Resumable**: If you lose context mid-phase, re-run the skill and it picks up where you left off.
- **Task isolation**: Each task is independent. Deleting one has zero impact on others.

## Detailed Process Documentation

See [docs/archflow-process.md](docs/archflow-process.md) for the legacy skill-only process diagrams. Phase 22 will replace them with the MCP-backed workflow documentation.
