---
name: archflow-prd
description: Define, review, adjudicate, and obtain explicit approval for an ArchFlow product requirements document.
---

# Product Requirements Document

Treat the argument as `<task>`. This is a normal-mode phase skill: durable state and every server-checked value come from the local helper and the five workflow tools. Work only in `.archflow/tasks/<task>/` plus shared `.archflow/context/`; never read another task's files.

## Degraded operation

If any workflow tool is unavailable, do not substitute an informal file edit or infer progress. Run input-free `archflow-local manual-status --task <task>`, report its `normal`, `degraded`, or `repair-required` mode, and perform exactly its single `next_action`. For an unavailable `archflow_state`, `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, or `archflow_waiver`, pass only the complete plain-JSON selector and source artifact requested by status to `archflow-local manual-next --task <task>`; use the returned fallback artifact, prompt, decision templates, checkpoint result, and resume action verbatim. The helper derives every digest, anchor, result reference, evidence binding, and gate fact, retains outputs before checkpointing them, and stops for schema-valid review or an explicit human decision where required. Re-run `manual-status` after every manual milestone. If both server and helper are unavailable, stop non-advancing, reinstall with `./install.sh`, and rerun `manual-status`; never create a purported PRD milestone from conversation or filenames.

## Stable rubric

Use this exact JSON object, without editing or reordering it, both when hashing the rubric and when calling `archflow_counter_review`:

```json
{"schema_version":"1","kind":"artifact","mode":"adversarial","criteria":[{"id":"substantive-correctness","text":"Report a blocking defect only when it requires producer action, and cite the specific artifact statement it contradicts or stated requirement it leaves unmet; citation is necessary but not sufficient. The violation must follow from the artifact's own text without assuming implementation behavior, ordering, or environment it does not specify. A contradiction that depends on such an assumption, or a debatable reading of whether stated text satisfies a criterion, is not blocking. Missing handling is a defect only for a condition the artifact claims to cover or a stated requirement demands. Local edge-case handling belongs to the implementer. A sound artifact is expected to yield zero blocking findings; that is successful review, not under-performance.","blocking":true},{"id":"brief-fitness","text":"The PRD solves the stated user brief without expanding into speculative scope.","blocking":true},{"id":"completeness","text":"The goals, user workflow, requirements, exclusions, risks, and success measures are complete enough to design against.","blocking":true},{"id":"testable-requirements","text":"Each requirement is specific and observable enough to verify without guessing intent.","blocking":true},{"id":"stated-assumptions","text":"Material assumptions and unresolved human choices are explicit and do not masquerade as requirements.","blocking":true},{"id":"advisory-observations","text":"Use non-blocking findings for completeness suggestions, debatable readings, and observations, including handling for conditions outside the artifact's stated scope. Do not inflate them into blockers merely to report them.","blocking":false}]}
```

Compute `rubric_digest` by piping that literal to `archflow-local hash` on stdin. Use the effective self-review provenance and pinned active rules reported by status; never self-declare routing, model family, model, or effort and never substitute mutable worktree policy.

## Durable loop

Run `archflow-local status --task <task>`, inspect the JSON result's `ok` field rather than relying on the process exit code, perform exactly its `next_action`, then run status again. Continue until status requests human judgment or reports that the phase advanced. Do not infer state, approval, or evidence currency from Markdown, filenames, conversation, or an absent gate.

If `next_action` is `initialize-repository`, stop and direct the user to `archflow-init`. If it is `create-task`, run `archflow-local task-init --task <task>`, use that returned initialization artifact in the first `archflow_state` request, and obtain its exact fingerprint and request digest from `archflow-local envelope --task <task>`. For reconciliation, configuration, checkpoint, or inspection actions, report the helper's one safe action. Never improvise repair; use only the degraded-operation path above when a capability is actually unavailable.

For each pipeline step, call `archflow_state` with `status: "running"` before doing its work. The skill records the terminal `succeeded` or `failed` state for `produce`, `self_review`, and `triage`. `archflow_counter_review` and `archflow_adjudicate` install their own successful terminal state; do not send a second successful state transition after either tool returns.

Pipe every `archflow-local` payload as JSON directly on stdin (for example `printf '%s' '<json>' | archflow-local envelope --task <task>`); never write it to a scratch file — `--input <json-file>` remains supported but is unnecessary for generated input. Every non-produce tool request uses one `archflow-local envelope --task <task>` pass over the complete proposed tool input, then uses the returned `input_fingerprint` in the tool call. A produce request is two-pass:

1. Draft `.archflow/tasks/<task>/prd.md`, then run `archflow-local build-document --task <task>` for `phase_instance: "prd"`, `step: "produce"`, `document_path: "prd.md"`, and an empty `declared_inputs` array, initially using the fingerprint reported by status.
2. Run `archflow-local envelope --task <task>` over the complete `archflow_state` request. Substitute its fingerprint into both the request and the document artifact's `input_fingerprint`.
3. Run `archflow-local envelope --task <task>` again over that substituted request to obtain the true request digest, then call `archflow_state` with the byte-equivalent input.

If a tool reports a fingerprint mismatch, discard the pending intent, take the expected digest and safe next action from the result, rebuild the request with a fresh intent, and re-run status. This is recovery, not the normal recipe.

## Phase work

When status selects `produce`, research only as much as the brief needs and write `.archflow/tasks/<task>/prd.md`. Capture the problem, users, goals and non-goals, testable requirements, assumptions, risks, and success criteria. Keep the artifact useful for architecture decisions rather than prescribing implementation prematurely.

When status selects `self_review`, evaluate the current PRD against every criterion in the stable rubric and the pinned active rules. Construct one complete agent-declared self-review artifact using only the current subject digest, input fingerprint, phase instance, effective self-review provenance from status, and the rubric digest from `archflow-local hash`. Record every substantive finding; an empty finding list is valid only after actually applying the rubric. To preview its canonical projection, pipe `{"kind":"review","value":<the complete review artifact>}` to `archflow-local render` on stdin (`archflow-local --help` lists each command's payload), and install the artifact through `archflow_state`.

When status selects `counter_review`, call `archflow_counter_review` with `artifact_path: "prd.md"` and the exact stable rubric. Do not manufacture, summarize into authority, or edit the server-attested result.

When status selects `triage`, transcribe status's current evidence set, canonical source evidence digest order, and every finding identity into one triage artifact. Give every finding exactly one accepted or rejected disposition. Accepted findings include a concrete revision intent; rejected findings cite artifact evidence. If any finding is accepted, revise `prd.md` and follow status back through fresh production and review. Install triage through `archflow_state`.

When status selects `adjudicate`, call `archflow_adjudicate` with `artifact_path: "prd.md"` and `upstream_paths: []`. Let the server evaluate the pinned constitution and open any required gate.

## Human gates

The PRD always requires an `artifact-approval` gate after the fixed point closes. Assemble its complete `archflow_gate` input only by transcribing the current subject, evidence, revision, and fingerprint exposed by status, with `context: {"artifact_kind":"prd"}`. Use a fresh intent. Before making the blocking call, run `archflow-local envelope --task <task>` with that exact input and present the returned gate ID and optional counter-review prompt to the user. Then call `archflow_gate` with byte-equivalent input.

For every open gate, including one opened inside adjudication, re-run status and present its ready-to-write decision templates, paths, and complete optional counter-review prompt. The user alone chooses whether to run that review and which decision template to authorize. If they run it, follow the generated recipe and `archflow-local gate-counter --task <task>`; if status then requests supplemental triage, disposition every returned finding and accept any artifact-changing result only by revising the PRD and re-entering the fixed point. If they decline, record no review. Install the chosen template with `archflow-local decide --task <task>` using `kind: "interface"`, then let the blocked call resume.

Keep the original `archflow_gate` input and `intent_id` for every supplemental retry. Decline by retrying with status's exact `decline` outcome and create no review. If review is elected, install it, let the blocked call return `SUPPLEMENTAL_REVIEW_REQUIRED`, then retry with status's exact `ingest` outcome. Re-run status after ingest and retry with its exact `triage-no-change` outcome, or, for an accepted change, revise and rebuild the artifact, take the exact new subject digest from `envelope`, retry with the authenticated supersede facts plus that digest, and expect `GATE_SUPERSEDED`. A superseded gate approves nothing: re-enter produce, review, triage, and adjudication to a fixed point before opening a fresh gate. Never fabricate review, triage, subject, or human-decision facts.

If the explicit decision is `waiver-requested`, it is not approval. Re-run status, construct the `archflow_waiver` origin only from the server's archived request and decision plus helper-derived digests, run `envelope` before the blocking waiver call, and handle the waiver gate through the same status/templates/prompt procedure. A denied or cancelled waiver grants nothing.

Never claim approval, select a decision, or pass the gate for the user. Stop until the user's explicit decision. After the approved gate resolves, re-run status and report the durable next action; approval in conversation alone is not authority.
