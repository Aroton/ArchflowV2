---
name: archflow-explore
description: Explore a codebase and produce or refresh its maintained documentation set in docs/. Use when the user asks to map a repository, understand its architecture or conventions, document how a system works, or start or refresh ArchFlow exploration.
---

# Explore Codebase

Produce or refresh the repository's maintained documentation set in `docs/`. Caps-named files — `docs/OVERVIEW.md`, `docs/<section>/FILE.md`, and root pages like `docs/PATTERNS.md` — are that set: tracked in git, permanent, and shared by humans auditing the system, future agent sessions, and reviewers reading the repository checkout. Lowercase files in `docs/` are historical working documents; never overwrite or delete them.

A focus area may be supplied with the invocation. If `.archflow/workflow.yaml` or `.archflow/constitution/` is absent, stop and direct the user to `archflow-init` before writing documentation.

## Document format

Every maintained page follows one convention:

- **Caps filename**, either at the docs root (`OVERVIEW.md`) or in a section directory mirroring the source layout (`mcp/SERVER.md` for `src/mcp/`).
- **A stamp under the title**: `**Explored:** <date> · **Commit:** <git rev-parse --short HEAD> · **Covers:** <the source paths this page documents>`. The stamp is what makes staleness detectable and refresh incremental.
- **Human-readable prose**: what each system accomplishes and *why it exists*, in plain language — not an API reference. Use mermaid diagrams where a picture carries the mechanism. Call out trust boundaries, honest limitations, and surprises a maintainer would want to know.
- **Sized to the subsystem** — a page per major subsystem, not per file.

The default set is `docs/OVERVIEW.md` (whole-system map and glossary) plus one section page per major subsystem. Add, merge, or split pages when the repository's shape demands it — per-package sections in a monorepo, root pages such as `PATTERNS.md`, `TESTING.md`, or `DEPENDENCIES.md` when conventions, test strategy, or the dependency surface deserve their own reference.

## Setup and mode

Read `docs/` for existing caps-named pages and their stamps, then choose the mode:

- **Fresh**: no maintained pages exist. Plan the full set sized to the repository and present the plan.
- **Refresh**: pages exist. For each page, run `git diff --name-only <stamped-commit>..HEAD` against its `Covers` paths; re-explore only pages whose covered code changed, plus anything the user's focus area names. Unchanged pages keep their stamps.

Either way, state which pages will be written or refreshed and perform the requested documentation work. The invocation authorizes routine page updates and their commit; preserve unrelated user edits and stop only when conflicting changes cannot be reconciled safely.

## Parallel exploration

Delegate exploration when its size or separable subsystems justify parallel contexts; a small refresh can stay inline. Group related pages or subsystems into as few independent briefs as the work needs rather than assigning one agent per page. A sub-agent sees none of this conversation, so include its scope, target pages, document format, stamp values, and focus area. Have it inspect actual code, write its assigned pages, and return the paths plus conclusions needed for synthesis. Review every result before committing.

Write or update `docs/OVERVIEW.md` when the system map, glossary, subsystem relationships, or maintained page set changed. Otherwise preserve its existing bytes and stamp.

All correspondence with the user is conversational and human-readable. Lead with what changed, why it matters, and any unresolved blocker. Do not dump IDs, digests, JSON, internal workflow paths, or protocol codes unless the user explicitly asks for diagnostics or audit detail.

## CLAUDE.md pointer

The documentation set only stays current if the repository's instructions say so. Ensure the target repository's `CLAUDE.md` (or equivalent) lists the maintained pages and states the rule: *when a change alters behavior a caps-named page describes, update that page in the same change.* Include that focused documentation-maintenance addition in the requested work, preserving existing instructions and unrelated policy.

## Review and commit

Review the written pages against the code and check links, coverage stamps, and any documentation-maintenance addition. Stage only the intended documentation and instruction changes, preserve unrelated index and worktree changes, and commit without another approval with:

```text
Archflow: Explore Codebase Docs
```

Report completion with both refresh and workflow-next actions. The next task will use the canonical tree `.archflow/tasks/<task>/{config.yaml,state.json,prd.md,design.md}` and `.archflow/tasks/<task>/phases/<n>/{design.md,impl-notes.md}`; never create the legacy `.archflow/context/` or `phases/phase-<n>-*.md` layouts.

```text
Documentation committed. Refresh or focus exploration anytime:
Claude Code: /archflow-explore [focus]
Codex: $archflow-explore [focus]

Next, define the task:
Claude Code: /archflow-prd <task>
Codex: $archflow-prd <task>
```

Report the findings, changed pages, and commit. Do not launch the successor skill or infer authority to bypass an existing human gate.
