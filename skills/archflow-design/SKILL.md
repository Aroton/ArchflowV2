---
name: archflow-design
description: Design, review, adjudicate, and obtain explicit approval for an ArchFlow task architecture and phase plan.
---

# Task Design

Treat the argument as `<task>`. Work only in `.archflow/tasks/<task>/` plus shared `.archflow/context/`; never read another task's files. The approved PRD is `.archflow/tasks/<task>/prd.md`, the design is `.archflow/tasks/<task>/design.md`, and durable status is the authority for whether this phase may run.

## Degraded operation

If any workflow tool is unavailable, run input-free `archflow-local manual-status --task <task>` and follow exactly its one `next_action`; do not infer approval or progression from documents. Supply `archflow-local manual-next --task <task>` only the complete plain-JSON selector/source artifact requested by status for the unavailable tool, then use its exact fallback prompt, decision templates, installed checkpoint, and resume action. The helper derives all authority fields and retains results before they become reachable. Manual review/adjudication remains explicitly degraded, uncertainty opens a human gate, and approval or waiver never exists until an immutable schema-valid decision is archived and checkpointed. Re-run `manual-status` after every milestone. If both server and helper are unavailable, stop, reinstall with `./install.sh`, and rerun `manual-status`; create no design milestone while authority cannot be classified.

## Stable rubric

Use this exact JSON object, without editing or reordering it, both when hashing the rubric and when calling `archflow_counter_review`:

```json
{"schema_version":"1","kind":"artifact","mode":"adversarial","criteria":[{"id":"substantive-correctness","text":"Report a blocking defect only when it requires producer action, and cite the specific artifact statement it contradicts or stated requirement it leaves unmet; citation is necessary but not sufficient. The violation must follow from the artifact's own text without assuming implementation behavior, ordering, or environment it does not specify. A contradiction that depends on such an assumption, or a debatable reading of whether stated text satisfies a criterion, is not blocking. Missing handling is a defect only for a condition the artifact claims to cover or a stated requirement demands. Local edge-case handling belongs to the implementer. A sound artifact is expected to yield zero blocking findings; that is successful review, not under-performance.","blocking":true},{"id":"prd-consistency","text":"The design is consistent with the approved PRD and makes no silent product decision.","blocking":true},{"id":"requirement-coverage","text":"Every in-scope requirement maps to a concrete architectural responsibility and verification path.","blocking":true},{"id":"assumption-risk","text":"Material assumptions, dependencies, and irreversible choices are explicit and proportionate to current needs.","blocking":true},{"id":"phase-sizing","text":"The phase plan has coherent dependencies and phases small enough to implement and verify in one focused session.","blocking":true},{"id":"advisory-observations","text":"Use non-blocking findings for completeness suggestions, debatable readings, and observations, including handling for conditions outside the artifact's stated scope. Do not inflate them into blockers merely to report them.","blocking":false}]}
```

Compute `rubric_digest` by piping the rubric JSON to `archflow-local hash` on stdin. Take effective self-review provenance and pinned active rules from status; never author any server-checked identity or read mutable policy as the task's authority.

## Durable loop and calls

Run `archflow-local status --task <task>`, check its JSON `ok` field, perform exactly `next_action`, and re-run status after each durable action. Stop on any human-required or repair action. Never infer progress, review closure, or approval from Markdown or conversation.

Before each pipeline step call `archflow_state` with `status: "running"`. Record terminal state yourself only for `produce`, `self_review`, and `triage`; `archflow_counter_review` and `archflow_adjudicate` own their successful exits. Non-produce requests use one `archflow-local envelope --task <task>` pass. Pipe every `archflow-local` payload as JSON directly on stdin (for example `printf '%s' '<json>' | archflow-local envelope --task <task>`); never write it to a scratch file — `--input <json-file>` remains supported but is unnecessary for generated input.

Produce is two-pass. Draft `design.md`; run `archflow-local build-document --task <task>` with `phase_instance: "design"`, `step: "produce"`, `document_path: "design.md"`, and declared input `{ "input_id": "prd", "path": ".archflow/tasks/<task>/prd.md" }`. Run `envelope` over the complete `archflow_state` request, substitute its fingerprint into both request and artifact, run `envelope` again for the true request digest, then call the tool with byte-equivalent input. On a fingerprint mismatch, use only the returned expected digest and safe next action, discard the old intent, rebuild, and re-run status.

If status reports initialization, reconciliation, configuration, checkpoint, or inspection work instead of this phase, surface its one safe action. Do not invent degraded or legacy behavior; use only the helper-classified degraded-operation path above.

## Phase work

For `produce`, read the approved `prd.md`, relevant shared context, and the pinned policy returned by status. Write `design.md` with system boundaries, data and control flow, key interfaces and decisions, requirement mapping, risks, verification strategy, and an implementation phase plan. Every finite plan uses consecutive headings starting at 1 in the exact form `### Phase N: Name`; alternate dashes, tables, skipped numbers, and other heading forms are not phase authority. If the task is intentionally open-ended, include the exact marker `<!-- archflow:phase-plan:open-ended -->` and no `### Phase` headings. Design artifact approval fails closed when neither representation is valid. Prefer the simplest maintainable design for the stated operating envelope. If design makes the PRD inaccurate, update `prd.md` in the same production change and declare it as an input/parent reality rather than hiding the deviation.

For `self_review`, apply every stable-rubric criterion and pinned rule to the current design. Build the agent-declared review from the current subject/fingerprint, status-provided effective self-review route, and locally hashed rubric. Install it as a review-evidence artifact with `archflow_state`; to preview its canonical projection, pipe `{"kind":"review","value":<that review artifact>}` to `archflow-local render` on stdin (`archflow-local --help` lists each command's payload).

For `counter_review`, call `archflow_counter_review` with `artifact_path: "design.md"` and the unchanged rubric. For `triage`, transcribe the status-provided evidence-set digest, canonical source digest order, and finding identities; disposition every finding exactly once. Accepted findings revise the design, and the PRD when reality changed, then re-enter fresh production and review. For `adjudicate`, call `archflow_adjudicate` with `artifact_path: "design.md"` and `upstream_paths: ["prd.md"]`.

## Human gates and approval

The design always requires an `artifact-approval` gate. Transcribe its subject, current evidence, revision, and fingerprint from status into a complete `archflow_gate` input with `context: {"artifact_kind":"design"}` and a fresh intent. Run `archflow-local envelope --task <task>` before the blocking call, present its true gate ID and optional counter-review prompt, then call `archflow_gate` with byte-equivalent input.

Whenever any gate is open, re-run status. Present its decision templates, paths, and complete optional counter-review prompt; this status surface also covers gates opened inside adjudication. The user decides whether to run that review and which template to authorize. If run, follow the generated prompt and ingest it with `archflow-local gate-counter --task <task>`, then triage any supplemental findings before resolution. Accepted changes revise the artifact and re-enter the fixed point. A decline creates no evidence. Write only the user's chosen template using `archflow-local decide --task <task>` with `kind: "interface"`.

Keep the original `archflow_gate` input and `intent_id` for every supplemental retry. Decline by retrying with status's exact `decline` outcome and create no review. If review is elected, install it, let the blocked call return `SUPPLEMENTAL_REVIEW_REQUIRED`, then retry with status's exact `ingest` outcome. Re-run status after ingest and retry with its exact `triage-no-change` outcome, or, for an accepted change, revise and rebuild the artifact, take the exact new subject digest from `envelope`, retry with the authenticated supersede facts plus that digest, and expect `GATE_SUPERSEDED`. A superseded gate approves nothing: re-enter produce, review, triage, and adjudication to a fixed point before opening a fresh gate. Never fabricate review, triage, subject, or human-decision facts.

If the explicit decision is `waiver-requested`, it is not approval. Re-run status, construct the `archflow_waiver` origin only from the server's archived request and decision plus helper-derived digests, run `envelope` before the blocking waiver call, and handle that gate through the same status/templates/prompt procedure. A denied or cancelled waiver grants nothing.

Never pass a gate or claim approval without the user's explicit decision. After approval resolves, re-run status. Report the phase plan and next durable action; `planned_final_phase` is recorded by the server from exact `### Phase N: Name` headings in the approved design, while only `<!-- archflow:phase-plan:open-ended -->` records an intentionally open-ended plan. This skill never authors that state field.
