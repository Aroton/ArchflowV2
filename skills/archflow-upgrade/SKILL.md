---
name: archflow-upgrade
description: Adopt a legacy in-flight ArchFlow task into a distinct canonical task and resume it through one reviewed migration gate.
---

# Upgrade an In-Flight Legacy Task

Treat the arguments as `<legacy-source> <task>`. Create a distinct canonical destination; never convert in place. The source may have a legacy name that is not a valid task slug, but the destination must be a valid, explicitly chosen slug. Keep the source unchanged and require both paths to belong to the same Git worktree.

## Stage the import locally

Confirm repository initialization is complete before staging. Staging and adoption are local steps that never require the server. Run `archflow-local upgrade --task <task>` with operation `preview` and the complete legacy descriptor. Preview validates the repository, baselines, source selection, exclusions, secret scan, mapping, phase continuity, visible document set, and derived resume phase without writing. A PRD and `architecture.md` are required. Explain the proposed import conversationally, including unmapped history and whether the task resumes at phase design or phase implementation. Obtain explicit human approval of that preview.

Stop if preview reports an unresolved task-local constitution edit or secretlint reports selected legacy content. Resolve the policy base before retrying. For a reviewed secret false positive, use `exclude` only for the exact legacy-relative path; never edit the source bytes or suppress scanning.

Only after approval, rerun the exact descriptor with operation `stage` and `approved_preview_digest` set to the preview digest. Staging writes only ignored runtime bytes. It must not create `.archflow/tasks/<task>/config.yaml` or any other visible destination file. Never calculate or edit returned digests, mappings, contexts, or the initialization artifact.

An incompatible pre-fix stage is not recoverable authority. After showing the exact task and import digest and receiving confirmation, use operation `discard-stage`; it removes only that unadopted import directory and an unchanged template-derived config left by the old implementation. Then restart at preview.

## Adopt atomically

With the approved stage in place, run input-free `archflow-local upgrade adopt --task <task>`. Adoption is a local mechanical step over the staged artifact: it authenticates every staged payload and atomically publishes one destination containing:

- `config.yaml`, `state.json`, `prd.md`, and `design.md`;
- every mapped prior phase design at `phases/<n>/design.md`;
- every mapped implementation log at `phases/<n>/impl-notes.md`.

Unmapped history remains in ignored staging. A crash before publication leaves no partial visible task directory. Adoption is retry-safe through the same transaction replay: after an interruption rerun the exact same command, and a completed adoption replays without duplicating effects. Replaced or tampered staged bytes fail closed; never repair them by hand — discard the stage and restart at preview. The human approvals that govern this workflow are the preview approval before `stage` and the later migration-audit decision; adoption itself approves nothing. No MCP call exists before this point, because no task exists yet.

## Review and audit through the semantic surface

After adoption the imported task travels the ordinary semantic workflow under the archflow-design resume invocation: call `archflow_status` with exactly `{"schema_version":"1","task_id":"<task>","invocation":{"skill":"archflow-design","intent":"resume"}}`. Every `archflow_apply` call uses that exact task and invocation plus `"action":{"offer":<next_action.offer>}` and only the submission that `next_action.expected_submission` requests; omit `submission` for `none`. A `review-dispatch` submission is the one optional exception — carry it only for a human-authorized reviewer substitution with the human's reason, and otherwise omit the submission. After each apply, trust its returned fresh view; on a lost, stale, or rejected offer, call `archflow_status` again.

Submit the imported `design.md` as the produce result without changing its bytes — `{"kind":"work-result","outcome":"succeeded"}`; the adopted destination already carries the exact staged bytes. Apply the offered independent review; never perform, spawn, or simulate it. The server labels the imported PRD and phase history as migration references and includes the exact mapping and proposed resume point in the review; they are not treated as old approval evidence. For an offered `triage`, submit exactly one disposition per returned finding, accept only material defects, and reject `unverifiable-` gaps with evidence beginning `envelope-gap: `.

After review reaches its fixed point, status offers the one unconditional `migration-audit` gate instead of separate ordinary PRD and design approval gates. When the current offer expects `gate-summary`, author a concise, self-contained human summary and submit `{"kind":"gate-summary","summary":<summary>}`. Present the imported requirements, overall design, phase history, review findings, omissions, planned final phase, and proposed resume point in plain language, with each available choice and its consequence, and ask one direct question. Every returned presentation requires human judgment; never infer that ordinary autonomous advancement can bypass migration audit. Keep gate IDs, hashes, JSON, internal paths, and protocol codes out of the default response unless the user explicitly asks for diagnostics or audit detail. Stop for the explicit human choice, then submit only `{"kind":"decision","choice":<selected presentation option token>,"reason":<human reason>}`; the server archives that decision and settles it in separate substeps, so a retried call after an interruption converges without recording it twice. Never select a decision yourself.

A revise choice closes the gate without reopening production. Apply the returned no-submission `revise` offer, edit the imported documents as requested, and submit a new `work-result` declaring the actual revision. A **simple** revision is only typo, formatting, or wording work that changes no meaning; it may reuse review evidence for one hop but still requires approval of the final bytes. A **significant** revision is anything else; it resets the attempt count to 1 and automatically runs a fresh counter-review plus constitution review. Uncertainty defaults to significant, and the human may override the classification in either direction. Fresh review then reopens the audit gate over the revised bytes.

## Commit and resume

Acceptance is the fresh human approval for the exact imported document bytes bound into the gate, including an imported current phase design when the resume target is phase implementation. It is also the import-commit authority. When fresh status returns the authorized commit facts, use only what it returns: confirm HEAD matches `baseline` and `target_ref`, stage exactly the one authorized task-local path — `git add -A -- :(top,literal)<path>` for the entry in `commit.paths` — inspect the staged task-local diff, and create the commit yourself with `commit.message` and the same top-anchored literal pathspec, preserving unrelated index and worktree changes. Do not ask for a second commit confirmation. Never push automatically. On Git failure, report it and retry safely.

Then call read-only `archflow_status` with the same invocation so the server observes the commit proof and derives the resume action:

- if phase N has a mapped design and no implementation log, continue with `archflow-phase-impl <task> N`;
- otherwise continue with `archflow-phase-design <task> N` for the next unimplemented phase.

Report the server-derived resume skill exactly and stop; the newly invoked skill owns all further work. Never infer acceptance, approval, a commit, or the resume jump from conversation or files alone. `state.json` plus authenticated gate authority remains the source of truth.

## Degraded operation

If an MCP workflow tool is unavailable, run read-only `archflow-local manual-status --task <task>`, report its classification, and stop. In `upgrade-staged` mode a current-format ignored import stage is reusable but is not durable task authority; resume through this skill in an MCP-enabled session. In `upgrade-restart-required` mode old or ambiguous staging cannot be adopted; report only the helper's exact safe discard action. Record nothing offline and create no destination task directory while the server is unavailable. If the helper or server registration is missing, reinstall with `./install.sh`, restart the host session, and retry the read-only status check.
