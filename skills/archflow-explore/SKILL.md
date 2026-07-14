---
name: archflow-explore
description: Explore a codebase and produce persistent ArchFlow context references. Use when the user asks to map a repository, understand its architecture or conventions, or start or refresh ArchFlow exploration.
---

# Explore Codebase

Create reference documents in `.archflow/context/`; they persist across tasks and sessions. A focus area may be supplied with the invocation.

## Setup

Create `.archflow/context/` if needed. If context documents already exist, explain that refreshing overwrites them and stop for confirmation.

## Parallel exploration

Run the following three independent investigations in parallel when subagents are available. Each writes its output directly and returns only its file path. If parallel agents are unavailable, perform the same investigations before proceeding. When the user supplied a focus area, each investigation must go deeper in that area.

1. **Structure and architecture**: map top-level directories, key entry points, application wiring/import and dependency flow, build system, and configuration. Write a clean, scannable document with paths and small code snippets to `.archflow/context/architecture.md`.
2. **Patterns and conventions**: find naming conventions; error handling, state-management, and data-access patterns; testing framework, layout, and fixtures; formatting, import organization, and module conventions. Write concrete examples to `.archflow/context/patterns.md`.
3. **Dependencies and integrations**: identify key dependencies and their uses; external APIs, databases, and auth providers; environment variables and config; linters, formatters, and CI/CD. Write findings to `.archflow/context/dependencies.md`.

## Review and commit

Summarize the findings and present these files for review:

- `.archflow/context/architecture.md`
- `.archflow/context/patterns.md`
- `.archflow/context/dependencies.md`

Stop. Apply requested changes and re-present until the user explicitly approves. Only then stage the context documents and commit with:

```text
Archflow: Explore Codebase Context
```

Report completion with both refresh and workflow-next actions:

```text
Context committed. Refresh or focus exploration anytime:
Claude Code: /archflow-explore [focus]
Codex: $archflow-explore [focus]

Next, define the task:
Claude Code: /archflow-prd <task>
Codex: $archflow-prd <task>
```

Never overwrite existing context, commit, or pass the review gate without confirmation.
