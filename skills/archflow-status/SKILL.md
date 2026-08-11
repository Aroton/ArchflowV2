---
name: archflow-status
description: Report reconciled durable ArchFlow truth and exactly one server-derived next action.
---

# Workflow Status

Accept an optional `<task>`. This skill is read-only: it does not edit artifacts, resolve gates, repair authority, stage files, or commit.

If `.archflow/` is absent, report that repository initialization is required. If no task is supplied, list directory names directly under `.archflow/tasks/`; do not ask the helper to enumerate tasks. Run input-free `archflow-local manual-status --task <task>` once for each selected task; a failing command exits nonzero and prints a JSON error body, and the JSON `ok` field remains the authority for structured details.

The helper-classified result is the only authority for task state. Report its mode exactly as `normal`, `degraded`, or `repair-required` and exactly one `next_action`. In `normal` mode, report the complete returned `task_status`: its task, revision, phase instance, step, step status, attempt, verified configuration state, reconciliation state, evidence availability and assessment, open gate, and blocking reasons. In `degraded` mode, no durable state exists for the task: report exactly the single returned wait-for-server action — the MCP server records all progress, there is no offline recording, and the workflow skills proceed once the server is available — and claim no position, evidence, or gate facts. In `repair-required` mode, state exists but cannot be read: report the returned position summary and only the returned action. Do not derive progress from `prd.md`, `design.md`, `phases/<n>/design.md`, `phases/<n>/impl-notes.md`, filenames, status lines, Git history, conversation, or missing files.

When configuration is not verified, report only the expected and observed digests supplied by status. Explain that an intentional routing, model, or effort change needs a distinct new task or the explicit upgrade workflow. Never echo configuration contents as part of the mismatch.

When normal-mode `task_status` reports an open gate, include its kind and ID, the task-root decision path, every ready-to-write decision template, and the complete optional counter-review prompt and paths returned by status. These values come from the live gate projection and cover constitution-review gates (derived by the server after triage) as well as skill-opened gates. State that the user alone chooses whether to run the optional review and which decision to authorize; do not select, write, approve, waive, cancel, or resolve anything.

For a normal-mode open gate, also report the exact supplemental outcomes `task_status` makes available for the current gate lifecycle. Explain that every retry keeps the original `archflow_gate` input and `intent_id`: decline creates no review; an elected recorded review first yields `SUPPLEMENTAL_REVIEW_REQUIRED`, then uses `ingest`, then `triage-no-change` or accepted-change supersession with the new artifact digest returned by `envelope`. `GATE_SUPERSEDED` approves nothing and requires the fixed point and a fresh gate. Do not perform or infer any of these human choices.

Present `next_action.code`, its detail, whether a human is required, and any returned phase instance, step, skill, gate kind, or gate ID verbatim. Recommend that one action only. In particular:

- `initialize-repository`, `create-task`, `run-step`, `commit-phase`, `advance-phase`, and `complete-task` identify workflow work, not inferred permission to skip the named skill. `commit-phase` means authorization exists but Git has not yet proved the authorized outputs committed on the approved current target; it does not itself authorize staging or committing without the phase skill's explicit confirmation gate.
- `open-gate`, `resolve-open-gate`, and `triage-supplemental-review` are human trust boundaries and remain pending until durable authority proves resolution.
- `resume-exact-intent`, `restore-or-record-new-transition`, `inspect-retained-receipt`, `create-fresh-intent`, `resolve-current-authority`, `restore-pinned-config`, and `inspect-state` are reported as blocking recovery work exactly as returned; do not invent a repair. During fixed-point re-entry after accepted triage findings, an edit to the produce document is expected rather than blocking: status reports it under `reconciliation.expected_reentry_edits` and still derives the normal prefilled produce running entry, while `restore-or-record-new-transition` remains the answer for drift on any other recorded file.
- `task-complete` means the final planned implementation phase is committed. It does not imply QA, staging, release, deployment, or publication.

When the result is not `ok`, report its structured error and safe next action without promoting partial information to state. For `repair-required`, recommend only the returned action; unreadable, corrupt, or contradictory authority never becomes progress. If the helper itself is unavailable, report only this static non-advancing action: reinstall with `./install.sh`, then rerun `archflow-local manual-status --task <task>`. Do not reconstruct a status while both server and helper are unavailable.
