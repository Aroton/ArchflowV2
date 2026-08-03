---
name: archflow-explore
description: Explore a codebase and produce persistent ArchFlow context references. Use when the user asks to map a repository, understand its architecture or conventions, or start or refresh ArchFlow exploration.
---

# Explore Codebase

Create reference documents in `.archflow/context/`; they persist across tasks and sessions. A focus area may be supplied with the invocation. If `.archflow/workflow.yaml` or `.archflow/constitution/` is absent, stop and direct the user to `archflow-init` before writing context.

## Setup

Create `.archflow/context/` if needed. If context documents already exist, explain that refreshing overwrites them and stop for confirmation.

## Parallel exploration

Decompose exploration into independent investigations sized to the repository. The default set below fits most single-package repos; add, merge, or split documents when the repo's shape demands it — for example, per-package documents in a monorepo, or a dedicated document for a dominant subsystem. When the user supplied a focus area, each investigation must go deeper in that area.

Exploration is bulk reading, and the reading belongs in sub-agent contexts, not this one — this session orchestrates, reviews the results, and runs the commit gate. Spawn one sub-agent per investigation, run them in parallel, and wait for all of them. A sub-agent sees nothing of this conversation, so give each a complete brief: its investigation scope and target document path from the list below, plus any focus area. Each agent explores in its own fresh context, writes its document directly, and returns only the file path and a few-sentence summary; keep this session's own reading to spot checks of the finished documents. Treat sub-agents as available — both Claude Code and Codex provide them natively. Only if spawning actually fails, run the same investigations yourself sequentially, distilling into each document as you go rather than accumulating raw exploration in context.

1. **Structure and architecture**: map top-level directories, key entry points, application wiring/import and dependency flow, build system, and configuration. Write a clean, scannable document with paths and small code snippets to `.archflow/context/architecture.md`.
2. **Patterns and conventions**: find naming conventions; error handling, state-management, and data-access patterns; testing framework, layout, and fixtures; formatting, import organization, and module conventions. Write concrete examples to `.archflow/context/patterns.md`.
3. **Dependencies and integrations**: identify key dependencies and their uses; external APIs, databases, and auth providers; environment variables and config; linters, formatters, and CI/CD. Write findings to `.archflow/context/dependencies.md`.

Stamp every context document's header with the date and current commit (`git rev-parse --short HEAD`) so later skills can detect staleness.

## Review and commit

Summarize the findings and present the written context files for review (default set):

- `.archflow/context/architecture.md`
- `.archflow/context/patterns.md`
- `.archflow/context/dependencies.md`

Stop. Apply requested changes and re-present until the user explicitly approves. Only then stage the context documents and commit with:

```text
Archflow: Explore Codebase Context
```

Report completion with both refresh and workflow-next actions. The next task will use the canonical tree `.archflow/tasks/<task>/{config.yaml,state.json,prd.md,design.md}` and `.archflow/tasks/<task>/phases/<n>/{design.md,impl-notes.md}`; never create the legacy `architecture.md` or `phases/phase-<n>-*.md` layout.

```text
Context committed. Refresh or focus exploration anytime:
Claude Code: /archflow-explore [focus]
Codex: $archflow-explore [focus]

Next, define the task:
Claude Code: /archflow-prd <task>
Codex: $archflow-prd <task>
```

Never overwrite existing context, commit, or pass the review gate without confirmation.
