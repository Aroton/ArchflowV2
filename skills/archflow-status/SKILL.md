---
name: archflow-status
description: Show ArchFlow task status and recommend exactly one next action. Use when the user asks about project progress, phase state, or what to do next.
---

# Project Status

Optionally accept a task name. Inspect `.archflow/` without changing files.

1. If `.archflow/` is absent, report that no ArchFlow tasks exist and direct the user to `archflow-prd <task-name>`.
2. List task directories under `.archflow/tasks/`; when a task was supplied, report only that task.
3. For every reported task, inspect `prd.md`, `architecture.md` (including its Progress table), and every phase design and implementation-log file. Present:

   ```markdown
   ## ArchFlow Status

   ### [task-name]
   PRD: Done / Not started
   Architecture: Done / Not started
   Phases:
   | # | Name | Status |
   |---|------|--------|
   | 1 | ... | Complete |
   | 2 | ... | In Progress |
   | 3 | ... | Not Started |

   **Next**:
   Claude Code: `/archflow-[skill] [arguments]`
   Codex: `$archflow-[skill] [arguments]`
   ```

   If several tasks exist, use a compact version for each.
4. Check `.archflow/tasks/<task>/reviews/` for counter-review files lacking a `## Triage` section. An untriaged counter-review means the authoring skill should be resumed to triage it, and that takes priority as the next action (PRD or architecture reviews → the skill that wrote the document; `phase-N-design-*` → `archflow-phase-design`; `phase-N-impl-*` → `archflow-phase-impl`).
5. If context documents exist, report when they were last updated. If they carry a commit stamp, compare it against the current HEAD (`git rev-list --count <stamp>..HEAD`) and flag significant drift with a suggestion to re-run `archflow-explore`, focused on the areas that changed most.
6. Show the five most recent commit subjects using `git log --oneline -5`.
7. Recommend exactly one next action for the requested or most active task: create a PRD, design architecture, triage an untriaged counter-review, or advance the next incomplete phase — `archflow-phase-design <task> N` when the phase has no design doc, `archflow-phase-impl <task> N` (in a fresh session) when it is `DESIGNED` or `IN PROGRESS` — or declare completion. If context does not exist, recommend exploration only when it is the most useful next action.

Replace `[skill] [arguments]` with exactly one applicable next action; always display both copy/paste-ready client forms.
