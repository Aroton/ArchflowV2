---
name: archflow-constitution
description: Explain, inspect, create, revise, or deprecate ArchFlow repository constitution rules in .archflow/constitution/. Use when a user asks what the constitution is, how rules affect review, or wants to configure repository-wide policy without changing workflow tooling.
---

# ArchFlow Constitution

Treat the constitution as repository-owned policy for human trust boundaries and durable engineering constraints. It is not a task checklist, coding-style guide, or workaround for a model limitation. During counter-review, ArchFlow judges the exact task subject against the active rules pinned from the task's immutable, human-approved policy-base commit. A matching `review_trigger` can require a human decision; a model verdict never changes policy by itself.

## Explain the model

When the user asks only for an explanation, describe the model and inspect the repository's existing rules when useful; do not edit files.

Each numbered Markdown file in `.archflow/constitution/` defines one rule. Only files named `NN-name.md` are rules; `README.md` is explanatory and is not parsed as one. A rule has strict YAML frontmatter followed by non-empty normative prose:

```md
---
id: stable-kebab-case-id
version: 1
status: active
review_trigger: Describe the observable condition that warrants a human gate.
---
State the repository-wide policy in direct, durable language.
```

`id`, `version`, and `status` are required. `status` is `active` or `deprecated`. `review_trigger` is optional. `enforced_by` is an optional non-empty YAML list naming real mechanical checks that already enforce the rule; omit it for aspirational or review-only enforcement.

## Configure rules

Before editing, read `.archflow/constitution/README.md` and every numbered rule. If the directory is absent, direct the user to `archflow-init`; do not invent a parallel location.

Translate the requested policy into the smallest durable rule set:

- Keep one independently reviewable policy per file.
- Use a stable kebab-case ID beginning with a letter.
- Choose an unused two-digit filename prefix and a descriptive filename.
- Write normative prose that says what must remain true and why it matters.
- Make a trigger concrete and observable. Describe when human attention is warranted, not a vague restatement of the rule.
- Name `enforced_by` mechanisms only when they exist and can be identified precisely.
- Avoid repository-local formatting preferences, task-specific acceptance criteria, and instructions that compensate for current model weakness. Put those in ordinary project guidance, the PRD, or a phase design instead.

For an existing ID, preserve its file and identity. If its text, status, trigger, or enforcement list changes, increment the positive integer version. If nothing changes, retain the version. Deprecate by changing `status` to `deprecated` and incrementing the version; never delete an ID, reuse it for another meaning, or reactivate a deprecated ID.

After editing, inspect the complete rule set for duplicate IDs, invalid filenames, invalid frontmatter fields, empty prose, and evolution violations. Show the user the rule diff and explain its practical review effect in plain language.

## Preserve policy authority

Prefer constitution maintenance on the repository's policy or base branch before starting affected tasks. A task branch may also carry a constitution change as an ordinary reviewed output, but the active task remains governed by its pinned policy-base commit; changing or committing worktree policy does not silently repin it. Treat that edit as policy for future tasks after it reaches their approved base. Never claim that an existing task adopted the new rule merely because the file changed.

Do not create task state, resolve gates, commit, or push as part of configuration unless the user separately authorizes those actions. Before any commit, summarize the rules added, revised, or deprecated and obtain explicit approval for the exact change.
