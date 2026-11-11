---
name: archflow-constitution
description: Explain, inspect, create, revise, or deprecate ArchFlow repository constitution rules in .archflow/constitution/. Use when a user asks what the constitution is, how rules affect review, or wants to configure repository-wide policy without changing workflow tooling.
---

# ArchFlow Constitution

Treat the constitution as repository-owned policy for human trust boundaries and durable engineering constraints. It is not a task checklist, coding-style guide, or workaround for a model limitation. `archflow-local review` judges the plan or the change under review against the active rules it reads from the repository, along with `.archflow/config.yaml`. Every active rule receives automated compliance review, including rules without a trigger; a rule the change fails is the producing agent's to fix. `review_trigger` is specifically a **human-review trigger**, not a switch for automated review: when it matches, the review reports a human-review reason and the caller must take it to a human. So `review_trigger` is how a repository opts into a human decision — the shipped defaults declare two (material changes to the human-approved plan and SQL-backed database behavior, including embedded queries, ORM operations, and schema/data migrations) — and a model verdict never changes policy by itself.

## Explain the model

When the user asks only for an explanation, describe the model and inspect the repository's existing rules in `.archflow/constitution/` when useful; do not edit files.

Numbered Markdown files in `.archflow/constitution/default/` provide shipped rules; files in `.archflow/constitution/custom/` add repository policy or replace a default by `id`. A deprecated custom replacement suppresses its default; precedence is by directory, not version. Historical flat constitutions remain readable, but do not mix flat and split rules. Only files named `NN-name.md` are rules; `README.md` is explanatory and is not parsed as one. A rule has strict YAML frontmatter followed by non-empty normative prose:

```md
---
id: stable-kebab-case-id
version: 1
status: active
review_trigger: Optional. The observable condition under which a human must decide before the work is accepted.
---
State the repository-wide policy in direct, durable language.
```

`id`, `version`, and `status` are required. `status` is `active` or `deprecated`. `review_trigger` is optional and adds human review to the automatic review every active rule already receives: omit it when a failure should simply be fixed by the agent. `enforced_by` is an optional non-empty YAML list naming real mechanical checks that already enforce the rule; omit it for aspirational or review-only enforcement.

## Configure rules

Before editing, read `.archflow/constitution/README.md` and every numbered rule in both directories (or the root for a legacy flat layout). Determine the effective rules after custom replacements. If the directory is absent, direct the user to `archflow-init`; do not invent a parallel location.

Translate the requested policy into the smallest durable rule set:

- Keep one independently reviewable policy per file.
- Use a stable kebab-case ID beginning with a letter.
- Put new rules and default replacements in `custom/`, using an unused two-digit filename prefix and a descriptive filename. Keep shipped `default/` files intact for explicit refreshes. In a legacy flat repository, keep scoped edits in that layout until the user requests migration; a rule edit does not authorize a forced scaffold refresh.
- Write normative prose that says what must remain true and why it matters.
- Add a `review_trigger` only when the repository genuinely wants a human decision whenever that condition appears; without one, a failed rule is agent work first. Make it concrete and observable from the plan, the changed files, or the reviewed repository snapshot — never a restatement of the rule, and never process facts a reviewer cannot observe (who approved what, commits, dispatch outcomes), which it would only report as uncertain.
- Name `enforced_by` mechanisms only when they exist and can be identified precisely.
- Avoid repository-local formatting preferences, task-specific acceptance criteria, and instructions that compensate for current model weakness. Put those in ordinary project guidance or the plan instead.

For an existing custom ID, preserve its file and identity. To customize a default, create a custom file with the same ID and increment the effective rule version when changing its contents; the custom file replaces the entire rule, including its trigger. An unchanged override remains effective after default refreshes even if the shipped version becomes higher. If its text, status, trigger, or enforcement list changes, increment the positive integer version. If nothing changes, retain the version. Deprecate by changing `status` to `deprecated` and incrementing the version; never delete an ID, reuse it for another meaning, or reactivate a deprecated ID.

After editing, inspect the complete rule set for duplicate IDs within each layer, invalid filenames, invalid frontmatter fields, empty prose, and evolution violations. Show the user the rule diff and explain its practical review effect in plain language.

## Refresh defaults

`archflow-local init --force` adopts the running bundle's defaults and refreshes other scaffold files, including repository config; it preserves `custom/`. For a flat layout it replaces known shipped filenames and moves additional rules into `custom/`, refusing conflicts before writing. Explain that legacy edits to shipped filenames are reset and preserve any intentional replacements in `custom/` before a requested refresh. Run forced initialization only when the user has requested that broader replacement; a scoped rule edit does not authorize resetting config.

## Preserve policy authority

Two shipped rules, `explicit-human-authority` and `approved-design-before-code`, state who decides and that the plan stays truthful; weakening either lets work proceed without a human decision a human owns. Say so before changing them. Likewise `human-approval-for-workflow-control-plane` guards the policy files themselves: a change to `.archflow/config.yaml` or `.archflow/constitution/` is a policy change that must be declared in the reviewed change.

A request to create or change constitution rules authorizes the scoped edits and their commit without another approval. An explanation or inspection request authorizes no edits. Validate the complete rule set, inspect and stage only the intended changes, preserve unrelated work, commit with a message describing the policy change, and report the diff and commit. Preserve custom rules and triggers outside the request. Do not push as part of configuration. A policy change takes effect for the next review that reads the repository; never claim it changed a review that already ran.
