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

Either way, state which pages will be written or refreshed and stop for confirmation before overwriting anything.

## Parallel exploration

Exploration is bulk reading, and the reading belongs in sub-agent contexts, not this one — this session is the orchestrator: its context is the scarcest resource, so it plans the page set, reviews the results, and runs the commit gate. Spawn one sub-agent per page being written or refreshed, run them in parallel, and wait for all of them. A sub-agent sees nothing of this conversation, so give each a complete brief: the page's scope and target path, the document format above, the stamp values, and any focus area. Each agent explores the *actual code* in its own fresh context, writes its page directly, and returns only the file path and a few-sentence summary; keep this session's own reading to spot checks of the finished pages. Only if a spawn actually fails, run that page's investigation yourself, distilling into the page as you go — a fallback for real failure, never a preference.

After the fan-out, write or update `docs/OVERVIEW.md` yourself as the synthesis pass: the system map, how the sections connect, and cross-links to every page.

All correspondence with the user, especially review and commit gates, is conversational and human-readable. Lead with what changed, why it matters, and the decision needed. Do not dump IDs, digests, JSON, internal workflow paths, or protocol codes unless the user explicitly asks for diagnostics or audit detail.

## CLAUDE.md pointer

The documentation set only stays current if the repository's instructions say so. Ensure the target repository's `CLAUDE.md` (or equivalent) lists the maintained pages and states the rule: *when a change alters behavior a caps-named page describes, update that page in the same change.* Draft the addition and present it at the review gate below — never edit `CLAUDE.md` without the user's approval.

## Review and commit

Summarize the findings and present the written pages for review, together with any proposed `CLAUDE.md` addition. Ask plainly whether the user approves them or wants changes, then stop. Apply requested changes and re-present the meaningful differences until the user explicitly approves. Only then stage the documentation (and the approved `CLAUDE.md` edit) and commit with:

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

Never overwrite existing documentation, commit, or pass the review gate without confirmation.
