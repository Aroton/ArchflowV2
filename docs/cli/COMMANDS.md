# cli/COMMANDS

**Explored:** 2026-08-31 · **Commit:** `fe0e4ce` · **Covers:** `src/local/`, `src/state/status.ts`, `src/state/request-composition.ts`, `src/init/`, `install.sh`

`archflow-local` is the local adapter surface: repository bootstrap, the legacy-upgrade adapter, bounded diagnostics, a degraded human classifier, and the versioned read-only automation observation used by external controllers. It is deliberately *not* the authority — with one narrow exception (the staged legacy import and its atomic adoption), it derives and verifies rather than writes.

Every workflow action itself is composed server-side. PRD, design, phase design, phase implementation, status reporting, and the post-adoption half of a legacy upgrade run through `archflow_status` and `archflow_apply`; the semantic action planner calls the same transport-neutral request composer (`src/state/request-composition.ts`) that once backed a local request-building command, so the CLI and the live MCP surface never maintained parallel request builders. Hand-assembling request fields was measured as the dominant failure mode — in a full PRD loop, 8 of 10 requests were mechanical transcription — and the inversion removes that door entirely: the caller supplies only judgment, the server derives everything mechanical from durable authority. Git stays client-owned; the semantic view returns the exact authorized commit facts and the client stages and commits them itself.

A packaging note that trips up maintainers: there is no `bin` entry in `package.json`. `install.sh` writes a shell shim into `~/.local/bin` that execs `node dist/archflow-local.mjs`; the source of truth is `src/local/main.ts`.

## Invocation shape

```
archflow-local <command> [--task <task>] [--input <json-file>]
```

- Payload commands read JSON from `--input <file>`, or stdin when `--input` is omitted. If stdin is a TTY and no `--input` was given, the command fails immediately rather than hanging.
- Input-free commands (`automation-status`, `manual-status`, `init`, `clean`, and `upgrade adopt`) never read stdin at all.
- Output is always canonical JSON on stdout. **Failures exit nonzero** and now include thrown argument/handler failures as one structured `{"ok": false, ...}` envelope on stdout plus a concise stderr reason. A classified `automation-status` document—including `blocked`—is successful and exits zero.
- `--help` is generated from the same command table that drives dispatch (`LOCAL_COMMAND_CONTRACTS` in `src/local/commands.ts`), so help can't drift from behavior.

## The command surface

**Pure / stateless** (no task directory touched):

| Command | Purpose |
|---|---|
| `validate` | Run an artifact through its contract parser and echo the parsed value |
| `hash` | SHA-256 of a value's canonical encoding |
| `render` | Preview the canonical Markdown projection of a review or constitution-review result, with digest |
| `init` | Set up the repository: `.archflow/` assets + MCP registrations for every host. Refuses a diverged scaffold file; `init --force` overwrites every diverged file with the shipped template instead |

Initialization diagnostics also list generated ArchFlow assets hidden by an ancestor `.gitignore`. Init does not rewrite repository ignore policy; it names the affected paths so the human can review the rule and explicitly add the intended files.

**Task-scoped, read-only:**

| Command | Purpose |
|---|---|
| `automation-status` | Emit strict automation status v2: reconcile one task, classify its condition, expose authenticated implementation advice, and identify exactly one skill, human, orchestrator, operator, or terminal actor without mutation |
| `manual-status` | Read-only mode classifier: `normal`, `degraded`, `repair-required`, `upgrade-staged` (one strictly validated current import waits for MCP), or `upgrade-restart-required` (old, malformed, incompatible, or ambiguous staging must be explicitly discarded) |

In its normal classification, `manual-status` carries the same `TaskStatusV1.repositories` projection as semantic status: implicit writable `primary` first, then configured secondaries in ordinal name order, with resolved absolute location, resolved mode, current commit, and `last_reviewed_commit` only when current-position server-attested review evidence names that member. Relative declarations are rooted at the primary worktree, absolute declarations are accepted, omitted mode resolves to `context-only`, and `primary` is reserved. Repository config edits and moved-HEAD review notices remain informational and nonblocking.

`automation-status --task <task>` is the supported polling surface. Its success body is the strict versioned document itself, not an `ok/value` envelope. The readable path reuses authoritative semantic status and projects it without an invocation, so no mutation offer exists. State absence becomes PRD ownership; staged or unreadable authority becomes a safe blocked category; a repository failure too early to classify remains a structured command failure. See [`../contracts/AUTOMATION.md`](../contracts/AUTOMATION.md) for the complete action union, controller loop, freshness rules, benchmark, and trust boundary.

The command emits schema version 2. Its required implementation recommendation is copied from semantic status and never participates in actor or action selection; no-state, staged-import, and unreadable-state edge documents use unavailable/not-applicable advice without fabricating a phase. The v1 parser and schema remain compatibility surfaces, but the command does not emit v1.

**Task-scoped, mutating:**

| Command | Purpose |
|---|---|
| `snapshot` / `restore` | Install / read back a content-addressed retained result |
| `clean` | Remove only unreferenced authority plus stale or reconstructible work; reports removed/retained file and byte counts |
| `reconcile` | Compare recorded projections against what's on disk |
| `set-commit-authority` | Explicitly re-anchor task milestone or policy commit authority to a target Git commit (e.g. `HEAD`) |
| `upgrade` | The legacy-adoption adapter, below |

## upgrade: the legacy-adoption adapter

Adoption of a legacy in-flight task is the one workflow that must start before any task exists, so it stays a purpose-specific local adapter rather than a task `archflow_apply` action. Its operations:

- `preview` — validate the repository, baselines, source selection, exclusions, secret scan, mapping, phase continuity, visible document set, and derived resume phase, without writing. An unresolved task-local constitution edit or a secret finding blocks staging.
- `stage` — write the approved import (bound by `approved_preview_digest`) into ignored runtime only; no visible destination file is created. An incompatible pre-fix stage is discarded with `discard-stage`.
- `adopt` — the input-free `archflow-local upgrade adopt --task <task>` form (registered as `upgrade-adopt`; `upgrade adopt` is the one two-token CLI form). It runs the existing initialization transaction locally over the staged artifact, atomically publishing `config.yaml`, `state.json`, `prd.md`, `design.md`, and the mapped phase documents. Adoption is retry-safe through the transaction's replay machinery; replaced or tampered staged bytes fail closed.

After adoption the task exists and the workflow returns to the semantic surface: the imported design travels the ordinary review/triage cycle and the one `migration-audit` gate through `archflow_status`/`archflow_apply`, and acceptance authorizes the task-local import commit the client creates itself. The human approvals are the preview approval before `stage` and the migration-audit decision; adoption itself is mechanical.

## One naming note

Internal request-digest derivation lives in `src/local/call-envelope.ts` — the authentication wrapper the composer binds around one durable request. It is unrelated to `src/review/envelopes.ts`, the sealed evidence package sent to a child reviewer (see `../review/COUNTER-REVIEW.md`). The shared name is a known collision; a rename is on the simplification list.

## Degraded mode

When the MCP server is unavailable, there is no offline recording path — the server is the only writer of workflow progress. What remains is `manual-status`, a read-only classifier that never blocks on stdin:

- `normal` — the server's durable state is present and readable; the result delegates to task status and returns the one `next_action`.
- `degraded` — no durable state exists for the task; the single next action is to wait for the server. Once it is available, proceed through the workflow skills as usual (reinstall with `./install.sh` if the server binary is missing).
- `repair-required` — state is present but unreadable; the result is a position summary for a human to act on.
- `upgrade-staged` — no state exists, but one current-format import stage is reusable once the session exposes MCP.
- `upgrade-restart-required` — no state exists and staging is old, malformed, incompatible, or ambiguous; the shared strict descriptor inspector reports only exact import digests for safe explicit cleanup and adoption uses the same classification.

Nothing in this mode advances the workflow, resolves gates, or records progress.

`clean --task <id>` is safe to run after an automatic cleanup warning. It never reads stdin, never treats cache as authority, and never rolls a committed transition back.

Repository-aware recovery keeps the existing primary spelling and adds `--repository <name>` for a configured writable secondary. Restore and reconciliation guidance always name the affected repository; the helper resolves that name through the current task configuration and checks its identity and mode rather than accepting a filesystem path. A restore validates every selected repository group before writing, applies primary then ordinal secondaries, and rolls back in reverse on an ordinary failure. Context-only members are never restore targets.
