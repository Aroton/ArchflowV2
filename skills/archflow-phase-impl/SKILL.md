---
name: archflow-phase-impl
description: Implement, verify, review, log, authorize, and complete one durably approved ArchFlow phase.
---

# Phase Implementation

Treat the arguments as `<task> <phase-number>`. Work only in `.archflow/tasks/<task>/`, the implementation paths authorized by its phase design, and shared `.archflow/context/`; never read another task's files. The canonical workflow artifact is `.archflow/tasks/<task>/phases/<phase-number>/impl-notes.md`.

Before changing code, run status and require durable authority for `phase_instance: "phase-impl-<phase-number>"`. A phase-design file or approval in conversation is insufficient. Never write code before the phase design is durably approved.

## Stable rubric

Use this exact JSON object, without editing or reordering it, both when hashing the rubric and when calling `archflow_counter_review`:

```json
{"schema_version":"1","kind":"implementation","mode":"adversarial","criteria":[{"id":"simplicity","text":"The implementation is the simplest maintainable solution that satisfies the approved phase and operating envelope.","blocking":true},{"id":"duplication","text":"New duplication is either removed or demonstrably clearer than an added abstraction.","blocking":true},{"id":"design-conformance","text":"Behavior, files, interfaces, and verification conform to the approved phase design or update the parent documents to reflect a necessary deviation.","blocking":true},{"id":"dead-code","text":"The change leaves no unreachable implementation, unused compatibility path, or speculative extension point.","blocking":true},{"id":"error-handling","text":"Expected boundary failures are handled and tested in proportion to their current risk.","blocking":true},{"id":"justified-abstraction","text":"Every new abstraction solves a concrete current problem and does not generalize beyond the phase requirement.","blocking":true}]}
```

Compute `rubric_digest` with `archflow-local hash`. Use effective self-review provenance and active pinned rules exactly as status reports them; never self-declare or calculate server-checked identities.

## Durable loop and implementation

Run `archflow-local status --task <task>`, inspect JSON `ok`, perform exactly `next_action`, then re-run status. Stop on repair and human-required actions rather than improvising. Before each pipeline step, enter it with `archflow_state` and `status: "running"`. Record terminal exits only for `produce`, `self_review`, and `triage`; the counter-review and adjudication tools own their successful exits.

For `produce`, read `phases/<phase-number>/design.md`, `design.md`, `prd.md`, relevant context, the immediately prior phase's implementation notes, and pinned policy from status. Implement only the approved scope. Run all executable verification from the phase design and exercise the changed behavior. Fix failures before review.

Keep `phases/<phase-number>/impl-notes.md` current. Its implementation log has `## Implementation Log: Phase <phase-number> - <name>` followed by `### Decisions Made`, `### Deviations from Plan`, `### Patterns Established`, `### Gotchas`, `### Key Interfaces`, and `### Verification Evidence`; fill each with exact paths, signatures, commands, and observed facts useful to the next phase. Update `design.md` and `prd.md` whenever implementation changes reality. Preserve the lifecycle no document → `DESIGNED` → `IN PROGRESS` → `COMPLETE` as a projection of durable state, never as a substitute for it.

The implementation artifact is built with `archflow-local build-implementation-output --task <task>`. Supply the current `phase_instance`, `step: "produce"`, base commit, sorted repository-relative outputs and restore targets, sorted declared inputs, and these parent documents: `phases/<phase-number>/design.md` as `phase-design`, `design.md` as `design`, `prd.md` as `prd`, and `phases/<phase-number>/impl-notes.md` as `impl-notes`. The helper observes identities, digests, undeclared changes, accounting, and secret scan; do not author those values.

Produce is two-pass: build initially with the status fingerprint; run `archflow-local envelope --task <task>` over the complete `archflow_state` request; substitute its fingerprint into both request and implementation artifact; run `envelope` again for the true request digest; then call `archflow_state` with byte-equivalent input. All non-produce calls use one envelope pass. On a fingerprint mismatch, discard the intent, take only the returned expected digest and safe action, rebuild with a fresh intent, and re-run status.

## Review and adjudication

For `self_review`, inspect the final changed bytes and implementation notes against every stable-rubric criterion and pinned rule. Create the agent-declared evidence only from the status subject/fingerprint, effective route, and locally hashed rubric; install it through `archflow_state`. Use `archflow-local render --task <task>` for a canonical projection when needed.

For `counter_review`, call `archflow_counter_review` with `artifact_path: "phases/<phase-number>/impl-notes.md"` and the unchanged rubric. The reviewed subject remains the retained implementation output selected by durable state; do not substitute an informal diff summary.

For `triage`, transcribe the current evidence-set digest, canonical source digest order, and each finding identity from status. Disposition every finding once. Accepted findings change code or parent documents as stated and re-enter produce plus fresh review; rejected findings cite concrete evidence. Install triage through `archflow_state`.

For `adjudicate`, call `archflow_adjudicate` with `artifact_path: "phases/<phase-number>/impl-notes.md"` and `upstream_paths: ["phases/<phase-number>/design.md","design.md"]`. Let the server determine trigger gates.

## Gates, log, and commit authorization

For any skill-opened gate, run `archflow-local envelope --task <task>` on the exact input before the blocking `archflow_gate` call and show its true gate ID. For every open gate, including a server-opened one, re-run status and present its decision templates, paths, and complete optional counter-review prompt. The user alone chooses whether to run the review and which template to authorize. Ingest an elected review with `archflow-local gate-counter --task <task>`, triage it before resolution, and re-enter the fixed point for accepted changes. A decline creates no evidence. Install only the user's chosen template with `archflow-local decide --task <task>` and `kind: "interface"`.

Keep the original `archflow_gate` input and `intent_id` for every supplemental retry. Decline by retrying with status's exact `decline` outcome and create no review. If review is elected, install it, let the blocked call return `SUPPLEMENTAL_REVIEW_REQUIRED`, then retry with status's exact `ingest` outcome. Re-run status after ingest and retry with its exact `triage-no-change` outcome, or, for an accepted change, revise and rebuild the artifact, take the exact new subject digest from `envelope`, retry with the authenticated supersede facts plus that digest, and expect `GATE_SUPERSEDED`. A superseded gate approves nothing: re-enter produce, review, triage, and adjudication to a fixed point before opening a fresh gate. Never fabricate review, triage, subject, or human-decision facts.

If the explicit decision is `waiver-requested`, it is not approval. Re-run status, construct the `archflow_waiver` origin only from the server's archived request and decision plus helper-derived digests, run `envelope` before the blocking waiver call, and handle that gate through the same status/templates/prompt procedure. A denied or cancelled waiver grants nothing.

After all implementation and parent changes are final, ensure `impl-notes.md` contains the durable implementation log and propose every task-independent convention for the target project's `CLAUDE.md`; keep task-specific facts in the notes. Then rebuild the implementation output so its digest binds those final bytes.

The distinct `commit-authorization` gate is mandatory even when no trigger gate opened. When status returns `next_action.code: "open-gate"` and `gate_kind: "commit-authorization"`, transcribe `gate_input` exactly: its subject and current evidence, current-branch `context.target_ref` (read the accompanying guidance), retained implementation `diff_digest`, sorted parent-document digests, and the single manifest artifact digest. These are authenticated resume facts; do not rebuild or author checked values. Run `envelope`, present the true gate ID and optional prompt, and make the byte-equivalent blocking call.

Do not stage or commit anything before status proves an explicit `authorize-commit` decision bound to the final diff and current artifact digests. Never choose that decision for the user or treat conversation as authority. After authorization, status returns `next_action.code: "commit-phase"`; stage only the declared phase outputs, show the exact staged diff and proposed commit message, and stop for the user's explicit confirmation to commit. Only then commit to the authorized current target ref. Re-run status: it advances or completes only after repository authority proves the approved target is still current, the retained base is its ancestor, and the committed tree contains every retained after-image and absence. Record `COMPLETE` only from that durable completion; task completion means the final planned implementation phase is committed, not that QA, staging, release, deployment, or publication occurred.
