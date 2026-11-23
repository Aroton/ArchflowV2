---
name: archflow-counter-review
description: Run a standalone cross-model counter-review of the current working tree or a plan via archflow-local review, optionally targeting a specific model or shorthand such as sol-6.2, astra-6.2, opus, fable, sonnet, hydrogen, or neon. Works without an orchestrated run configured.
---

# Counter-Review

Run a standalone cross-model counter-review of the current working tree (or a proposed plan) using `archflow-local review`. This works directly in any git repository or worktree with no `/archflow-run` configured, and leaves `.archflow/config.yaml` untouched.

## Arguments

The user may pass any combination of:

- **No arguments:** run every configured role from `.archflow/config.yaml` (or ArchFlow's shipped defaults when none exists).
- **A target model or shorthand** (e.g. `sol-6.2`, `astra-6.2`, `opus`, `fable`, `sonnet`, `hydrogen`, `neon`, or a full model ID such as `gpt-6.2-sol`, `claude-opus-5-5`, `gemini-4-neon-high`): override the reviewer route for this call only using `review_routes` in the payload — never edit `.archflow/config.yaml`.
- **An optional effort** (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`), **stage** (`plan` or `implementation`), **roles** (`counter-reviewer`, `test-reviewer`, `adjudicator`), or **focus notes** describing what to pay attention to.

### Model shorthand resolution

Resolve common shorthands to exact model IDs before building the payload:

| Shorthand | Model ID |
| --- | --- |
| `opus`, `opus-5.5`, `opus 5.5` | `claude-opus-5-5` |
| `fable`, `fable-5.2`, `fable 5.2` | `claude-fable-5-2` |
| `sonnet`, `sonnet-5.5`, `sonnet 5.5` | `claude-sonnet-5-5` |
| `sol`, `sol-6.2`, `sol 6.2` | `gpt-6.2-sol` |
| `astra`, `astra-6.2`, `astra 6.2` | `gpt-6.2-astra` |
| `hydrogen`, `gemini` | `gemini-4-hydrogen-high` |
| `neon` | `gemini-4-neon-high` |

Pass any full model ID (`gpt-*`, `claude-*`, `gemini-*`, or a model paired with a cc-switch `provider`) verbatim. If the user passes an unfamiliar alias that does not match a known prefix or a route in `.archflow/config.yaml`, ask the human for the exact model ID rather than guessing (an unrecognized model family is rejected before dispatch).

### Roles and efforts when a model is named

- When the user **names a specific model** without explicitly naming roles:
  - Set `roles` to `["counter-reviewer", "test-reviewer"]`.
  - Set `review_routes` for `counter-reviewer` to `{ "model": "<id>", "effort": "<requested effort or high>" }`, and for `test-reviewer` to `{ "model": "<id>", "effort": "<requested effort or low>" }`.
  - Include `adjudicator` as well when the user asks for constitution review or a full review.
- When the user **does not name a model**: omit `review_routes` and `roles` so every applicable role runs under `.archflow/config.yaml` (or shipped defaults).

## Preparing and running the review

1. Check that `archflow-local --help` lists `review`. If `archflow-local` is missing or predates `review`, tell the human to reinstall with `./install.sh` and stop; never run `./install.sh` yourself.
2. Determine the **stage**: default to `implementation` when the working tree has uncommitted or untracked changes, or `plan` when the user asks to review a plan or there are no working-tree changes and a plan exists in the conversation. For an implementation review with a clean working tree, tell the human there are no uncommitted changes to review and stop (ask whether they want a `plan` review instead).
3. Put temporary payload and result files in a scratch directory **outside** the repository (`mktemp -d`), and remove it afterwards. Never write review scratch files into the repository working tree — untracked files there become part of the reviewed subject or fail the review because the subject changed mid-run.
4. Do not modify any repository files while the review is running.
5. Build the JSON payload (`schema_version: "1"`):
   - `stage`: `"implementation"` or `"plan"`.
   - `base_commit`: the full 40-character `git rev-parse HEAD`.
   - `paths`: unique repository-relative file paths (no directories, nothing under `.git` or `.archflow/tasks`). For `implementation`, gather every changed file against `HEAD` and every non-ignored untracked file (`git diff HEAD --name-only` and `git ls-files --others --exclude-standard`), excluding any nested repository directories. For `plan`, list the files the plan intends to add, change, or delete.
   - `ask`: what the human asked for, including any focus notes from this invocation.
   - `plan`: concise summary of the plan or approach followed (nonblank).
   - `verification` (required for `implementation`): exact checks run and their results, or plainly state what has not been run yet — never fabricate test results.
   - `review_routes` and `roles`: included as determined above.
6. Run the review with the active client as `--producer` (`claude`, `codex`, or `antigravity`):

```bash
archflow-local review --producer <claude|codex|antigravity> --input <tmp>/payload.json > <tmp>/result.json
```

## Reporting the result

Translate the result into a concise, conversational summary for the human — keep raw JSON, digests, internal paths, and protocol codes out of the response unless asked for diagnostics:

- State which reviewer roles and models actually ran and their outcomes.
- List every concrete finding clearly (location, issue, and why it matters) along with your honest assessment of which ones are real bugs to fix versus points you would push back on and why.
- **Honor every `human_review_reasons` entry:** present each one plainly so the human can decide before accepting the work.
- If the review failed (`ok: false` or a failed role), report any partial findings that arrived together with why the missing role failed — never substitute your own review for a failed counter-review.
- Invoking this skill authorizes running the review only: do not edit repository files or commit unless the human asks you to apply the fixes. Offer to fix the valid findings and let them choose.
