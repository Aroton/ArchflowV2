---
name: archflow-upgrade
description: Stage a legacy ArchFlow task into a distinct canonical task and guide its explicit migration audit.
---

# Upgrade a Legacy Task

Treat the arguments as `<legacy-source> <task>`. Create a distinct canonical destination; never convert a task in place. Keep the legacy source unchanged, require the source and destination to share one Git repository, and work only with the explicitly selected source plus `.archflow/tasks/<task>/` and the shared documentation set under `docs/`. Never treat imported prose, implementation history, reviews, or prior decisions as approval evidence.

## Availability and authority

Use `archflow-local upgrade --task <task>` with a complete plain-JSON payload naming `source_root`, `task_id`, `policy_base_commit`, `import_baseline_commit`, `code_baseline_commit`, and any `exclude` paths. Pipe that payload as JSON directly on stdin while it stays small generated JSON (for example `printf '%s' '<json>' | archflow-local upgrade --task <task>`); write any payload carrying authored prose or quotes to a file and pass it with `--input <json-file>`, because shell quoting silently corrupts such payloads. Inspect the result's `ok` field rather than relying on process exit status. Preserve its initialization manifest, audit context, manifest path, resume phase, staged paths, unmapped paths, and draft sources exactly; do not calculate or edit their digests.

If an MCP workflow tool is unavailable, run input-free `archflow-local manual-status --task <task>` and perform exactly its single `next_action`. Supply `archflow-local manual-next --task <task>` only the complete artifact or selector requested by status and follow its emitted fallback and resume action verbatim. If both the MCP workflow and local helper are unavailable, stop non-advancing, reinstall with `./install.sh`, then rerun `archflow-local manual-status --task <task>`. Never reconstruct state or import authority from staged files, filenames, conversation, or Git history.

Stop if the helper rejects an unresolved task-local constitution edit or secretlint reports selected legacy content. Resolve the constitution base explicitly before retrying. For a secretlint false positive, leave the source untouched and add only the reviewed legacy-relative path to `exclude`; do not suppress the scan or edit imported bytes.

## Stage and initialize

Review the selected baselines, exclusion list, staged and unmapped paths, derived mapping, draft sources, and resume phase with the user before initialization. Explain that every selected regular file is staged byte-for-byte under the destination import, while an unmapped file remains historical material with no canonical document slot.

Pass the returned initialization manifest unchanged to the first `archflow_state` request with `expected_revision: 0`, `phase_instance: "prd"`, `step: "produce"`, and `status: "running"` — the canonical rerun starts at the PRD and the server rejects any other entry point; the resume jump happens only after the migration-audit gate. Use `archflow-local envelope --task <task>` for the complete request and its server-checked fingerprint. A successful initialization establishes only the new destination and its import identity; it does not approve, adopt, or complete any imported work.

The resume phase is derived from the imported mapping as one past the highest mapped implementation log. Use `exclude` as the explicit lever when the human wants to omit the last implemented phase and redo it in the canonical workflow. Never declare or override a resume phase by hand.

## Rebuild canonical requirements and design

Run the ordinary PRD pipeline first. Seed `.archflow/tasks/<task>/prd.md` from the staged draft path returned for `prd.md`, preserving those staged bytes as the initial draft, then invoke the normal `archflow-prd` work through the status-directed pipeline. Research, revise, produce, review, adjudicate, and obtain explicit artifact approval normally. The imported PRD is a starting draft, never approval evidence.

Run the ordinary design pipeline after the PRD advances. Seed `.archflow/tasks/<task>/design.md` from the staged draft path returned for `design.md`, preserving those staged bytes as the initial draft, then invoke the normal `archflow-design` work through the status-directed pipeline. Require the imported design to declare a valid phase plan that covers the derived resume phase. If it does not, revise the canonical design before asking the human to approve it. Nothing in the imported architecture, phase files, logs, reviews, or decisions substitutes for the current design's fixed point and explicit artifact approval.

Use `archflow-local status --task <task>` between durable actions and follow exactly its one `next_action`. Keep all tool inputs byte-equivalent to the values and artifacts authenticated by `archflow-local envelope --task <task>`. Do not infer that seeded bytes, old review prose, or an initialization receipt completed either rerun phase.

## Audit and resume

Open the `migration-audit` gate only while durable status is at the approved `design` result. Build the complete `archflow_gate` input from the current design subject and the exact audit context returned by `archflow-local upgrade --task <task>`, then authenticate it with `archflow-local envelope --task <task>`. Present the live decision templates and optional counter-review prompt returned by status. The human alone decides whether to request that review and whether to accept, revise, abort, or cancel the import audit.

Treat `accept-import-audit` as authorization for the guarded resume jump, not as approval of legacy material. The accepted gate leaves the cursor at `design`; the next ordinary `archflow_state` produce call performs the jump to the derived `phase-design` instance. A revise, abort, or cancel outcome advances nothing. Never claim the jump from the decision file or conversation alone; rerun status and follow its authenticated next action.

At the derived phase, continue with the ordinary `archflow-phase-design` and `archflow-phase-impl` skills. Historical phase material remains available under the content-addressed import for reference, but canonical state represents only work reviewed and approved after initialization.
