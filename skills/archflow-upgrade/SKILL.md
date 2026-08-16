---
name: archflow-upgrade
description: Adopt a legacy in-flight ArchFlow task into a distinct canonical task and resume it through one reviewed migration gate.
---

# Upgrade an In-Flight Legacy Task

Treat the arguments as `<legacy-source> <task>`. Create a distinct canonical destination; never convert in place. The source may have a legacy name that is not a valid task slug, but the destination must be a valid, explicitly chosen slug. Keep the source unchanged and require both paths to belong to the same Git worktree.

## Preflight before writing

Confirm repository initialization is complete and that the current session exposes the ArchFlow MCP tools before staging. If an MCP workflow tool is unavailable, run read-only `archflow-local manual-status --task <task>`, explain whether no stage exists, a reusable current stage exists, or an incompatible pre-fix stage must be discarded, and stop; record nothing offline and do not create the destination task directory. If the helper or server registration is missing, reinstall with `./install.sh`, restart the host session, and retry the read-only status check.

Run `archflow-local upgrade --task <task>` with operation `preview` and the complete legacy descriptor. Preview validates the repository, baselines, source selection, exclusions, secret scan, mapping, phase continuity, visible document set, and derived resume phase without writing. A PRD and `architecture.md` are required. Explain the proposed import conversationally, including unmapped history and whether the task resumes at phase design or phase implementation. Obtain explicit human approval of that preview.

Stop if preview reports an unresolved task-local constitution edit or secretlint reports selected legacy content. Resolve the policy base before retrying. For a reviewed secret false positive, use `exclude` only for the exact legacy-relative path; never edit the source bytes or suppress scanning.

Only after approval, rerun the exact descriptor with operation `stage` and `approved_preview_digest` set to the preview digest. Staging writes only ignored runtime bytes. It must not create `.archflow/tasks/<task>/config.yaml` or any other visible destination file. Never calculate or edit returned digests, mappings, contexts, or the initialization artifact.

An incompatible pre-fix stage is not recoverable authority. After showing the exact task and import digest and receiving confirmation, use operation `discard-stage`; it removes only that unadopted import directory and an unchanged template-derived config left by the old implementation. Then restart at preview.

## Adopt and review once

Initialize through `archflow_state` at expected revision 0 with phase `design`, step `produce`, status `running`, and the returned legacy-import initialization artifact. Use `archflow-local envelope --task <task>` for the complete fingerprinted request. The server authenticates every staged payload and atomically publishes one destination containing:

- `config.yaml`, `state.json`, `prd.md`, and `design.md`;
- every mapped prior phase design at `phases/<n>/design.md`;
- every mapped implementation log at `phases/<n>/impl-notes.md`.

Unmapped history remains in ignored staging. A crash before publication leaves no partial visible task directory.

Record the imported `design.md` as the design produce result without changing its bytes, then follow status through the ordinary automatic counter-review and triage. The server labels the imported PRD and phase history as migration references and includes the exact mapping and proposed resume point in the review. They are not treated as old approval evidence.

After review reaches its fixed point, status opens one `migration-audit` gate instead of separate PRD and design approval gates. Present the imported requirements, overall design, phase history, review findings, omissions, planned final phase, and proposed resume point in plain language. Ask the human to accept, revise, abort, or cancel. Keep gate IDs, hashes, JSON, and runtime paths out of the default response.

Before presenting that question, run `archflow-local gate-preview --task <task>` with the human summary. After the user explicitly chooses one returned option and gives a reason, run `build-request` with `{"kind":"gate","summary":<same summary>,"preview_digest":<returned digest>,"decision":{"choice":<option token>,"reason":<human reason>}}` and call `archflow_gate` once with its staged reference. The call resolves synchronously; never start it before asking the user or wait for a second process or approval channel. Re-preview after any stale-preview refusal.

A significant revision runs a fresh automatic review before returning to the gate. A simple typo, formatting, or wording-only revision may reuse review evidence for one hop but still requires approval of the final bytes. Uncertainty is significant, and the human may override the classification.

## Commit and resume

Acceptance is the fresh human approval for the exact imported document bytes bound into the gate, including an imported current phase design when the resume target is phase implementation. It also authorizes one task-local import milestone commit. When status returns `commit-artifacts`, run the input-free `archflow-local commit --task <task>`; it re-derives the bound path, message, target, and baseline and preserves unrelated changes. Do not ask for a second commit confirmation. Never push automatically.

After the commit is observed, follow the authenticated resume action:

- if phase N has a mapped design and no implementation log, continue with `archflow-phase-impl <task> N`;
- otherwise continue with `archflow-phase-design <task> N` for the next unimplemented phase.

Never infer acceptance, approval, a commit, or the resume jump from conversation or files alone. `state.json` plus authenticated gate authority remains the source of truth.
