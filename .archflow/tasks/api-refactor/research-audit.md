# Client interface audit — factual research notes

## Source and status

- Primary source: `docs/validation/client-interface-audit.md`, audited 2026-08-14 at commit `6637099` and explicitly labeled a recommendation for follow-up, not an implemented change.
- Current checkout inspected at `8dad526`. Directly relevant shared documentation and code confirm the audit's description of the current workflow surface and trust model.
- These notes distinguish the audit's proposed target from current repository authority. The audit alone does not authorize autonomous post-design execution; the governing policy must be revised and approved separately first.

## Problem statement

ArchFlow's current public interface exposes the mechanics of its durable transaction/state machine to the AI client. `archflow-local build-request` derives many hashes, revisions, paths, and payload details correctly, but the client still has to:

- read status and interpret one of 17 `NextActionCode` values;
- map that action to one of seven `build-request` kinds;
- invoke one of four low-level MCP tools;
- re-read status after nearly every mutation;
- keep a blocking gate call alive, poll for its projection, and write the decision through a separate CLI/filesystem side channel;
- understand exceptions for initialization, attempts-exhausted gates, staged versus full requests, waivers, and degraded status.

For a normal already-started document phase with no rework, the audit counts seven MCP mutations, seven request-composition calls, one CLI decision write, and at least seven status reads: roughly 22–23 machine interactions. The outer client is therefore the workflow coordinator rather than a participant supplying authored work or human judgment.

This is not only a usability/context-cost problem. The long-lived MCP process and each newly launched CLI process can run different installed contract versions after an update. The CLI currently composes authenticated MCP requests, stages intents, writes gate decisions, and performs stateful maintenance. A digest proves which bytes crossed a boundary but not that differently loaded versions interpret those bytes identically. The proposal treats this as an authority/coherence defect: there should be one exclusive live mutation gateway.

The existing idea of collapsing low-level transitions into `submit work`, `submit triage`, and `decide` is useful before task-design approval, but is still too low-level after design approval. Post-design phase design, implementation, review, remediation, verification, commits, and phase advance are intended to be one autonomous execution loop, not public client-scheduled actions.

## Affected users and clients

- Humans defining and approving the PRD and task design, resolving genuinely exceptional escalations, and exercising pause/cancel control.
- AI workflow clients in both supported host families (Codex and Claude Code) that currently carry detailed state-machine, request-composition, gate, and recovery instructions in their skills.
- Maintainers/operators diagnosing registration, loaded-versus-installed version skew, durable compatibility, locks/receipts, dispatch health, and recovery state.
- Producers, verifiers, and opposite-family reviewers after design approval. In the target they are private, coordinator-dispatched workers, not independent public API actors.
- Users running multiple tasks or multiple host sessions in one repository/worktree, because they currently share the worktree, Git index, and branch and therefore require repository-level write serialization.
- Legacy-task users invoking `$archflow-upgrade`, whose stateful migration should also move behind semantic MCP maintenance operations.

## Current baseline confirmed in shared code/docs

- `src/state/next-action.ts` defines 17 public next-action codes.
- `src/local/build-request.ts` defines seven request kinds: `initialize`, `produce`, `running`, `triage`, `counter-review`, `gate`, and `advance`.
- `src/contracts/tool-names.ts` advertises four tools: `archflow_state`, `archflow_counter_review`, `archflow_gate`, and `archflow_waiver`.
- `src/local/commands.ts` exposes 14 flat CLI commands: `validate`, `hash`, `render`, `snapshot`, `restore`, `clean`, `decide`, `status`, `reconcile`, `init`, `envelope`, `build-request`, `manual-status`, and `upgrade`.
- `src/mcp/tools.ts` advertises descriptors containing only `name`, `inputSchema`, and `outputSchema`, with no tool-level purpose description. Because a known host loses root combinators, the advertised input schema merges the full-payload and staged-reference branches into a mostly optional plain-object root while strict validation remains server-side.
- `test/contracts/mcp-advertised-schema.test.ts` records a current serialized catalogue size of 105,478 bytes after pruning/summarization and enforces a less-than-130,000-byte regression ceiling; the audit treats this as context cost rather than a final target budget.
- `src/state/gates.ts` and `src/state/gate-wait.ts` confirm that opening a gate waits for a decision interface, polling at 500 ms, and then resolves it inline. `test/integration/status-request-roundtrip.test.ts` explicitly starts the MCP request as a pending promise, polls status for the open gate, runs local `decide`, and then awaits the pending request.
- `src/mcp/handlers/waiver.ts` confirms the caller-supplied waiver origin includes and is checked against the archived gate identity, subject/context/evidence digests, decision digest, rule, scope, and eligibility.
- Current maintained docs describe the phase pipeline as `produce -> counter_review -> triage`, task-design and phase-design approval gates, implementation commit authorization plus a second explicit commit confirmation, exact-byte approval, no code before approved phase design, task isolation, review-evidence freshness, durable replay/recovery, and task-scoped Git verification.

## Recommended product/interface plan

### 1. Establish the authority boundary

Use MCP as the only supported public workflow transport. A live MCP process is only a coordinator candidate; it becomes the exclusive mutation gateway only after acquiring the current durable repository/worktree fence. Canonical durable state, receipts, evidence, repository observations, and fencing generations remain recovery authority. Process/session memory is never authoritative.

Keep four identities distinct:

1. loaded server build;
2. contract/schema compatibility version;
3. ephemeral process instance;
4. durable fencing generation.

One durable repository/worktree execution fence serializes all write-capable autonomous work because tasks share a worktree, index, and branch. Read-only reviewers may run concurrently. Every write-capable producer is bound to the current fencing generation and coordinator-supervised process identity. A replacement coordinator must prove the prior writer has exited or been terminated, reconcile the worktree, and reject results from stale generations. Ambiguous orphan edits fail closed and escalate.

### 2. Split public control, diagnostics, private workers, and the durable kernel

- Public control plane: small semantic MCP surface for starting/resuming, observing, resolving decisions, and pause/cancel.
- Diagnostic plane: one compact `archflow_diagnose` tool and `$archflow-doctor`; a task-state-read-only local fallback exists only when compatible MCP diagnostics cannot run.
- Private worker protocol: coordinator-owned artifact, finding, triage, verification, and remediation exchanges with producers/reviewers.
- Durable kernel: retain useful existing transitions, evidence bindings, handlers, receipts, digests, and recovery as internal modules rather than model-authored public payloads.

### 3. Public semantic contracts

Post-design control plane:

- `archflow_status(task_id, optional detail)` returns a common reconciled `WorkflowView`; observation never drives progress.
- `archflow_run(task_id)` starts, attaches to, or resumes the complete authorized autonomous run and continues until completion or escalation.
- `archflow_decide(server-issued binding, choice, reason, only genuinely option-specific rationale)` resolves workflow, escalation, waiver, or diagnostic-repair presentations; when authority is restored, the same operation resumes execution automatically.
- `archflow_control(task_id, pause|cancel, conditional confirmation)` stops at a safe durable boundary.

Pre-design facade, required in the same follow-up rather than deferred:

- `archflow_start(task_id)` creates and pins the task and opens the PRD write window.
- `archflow_submit(task_id, nested submission)` accepts pre-design `work`, `triage`, `reopen`, or `failure` and internally performs deterministic transitions/review/presentation creation until new content or human input is required.
- `archflow_decide` resolves PRD/design decisions through the same common binding.

Administrative/diagnostic additions:

- `archflow_diagnose(optional task/scope)` is observation-only for task state, worktree, and Git; it may append only a bounded repository-maintenance proposal/receipt. An approved repair is performed through `archflow_decide` after re-authentication under the maintenance fence.
- `archflow_upgrade(legacy source, distinct target task)` performs read-only inspection and returns a migration preview as a server-issued maintenance decision. Only `archflow_decide` may re-authenticate and apply the adoption.

All advertised tool inputs keep a plain object root. Discriminated variants remain nested below it. Every tool gets a purpose-level description and returns the same common `WorkflowView` where applicable.

### 4. Workflow view and semantic states

The proposed routine vocabulary is:

- `ready`: approved task design is committed/observed and execution may begin;
- `running`: autonomous work continues independently;
- `escalated`: new human authority or irreducible judgment is required;
- `paused`: human-requested safe stop;
- `canceled`: execution ended without claiming completion;
- `blocked`: no currently valid workflow decision can continue; presentation may require restart, upgrade, or `$archflow-doctor`;
- `complete`: all approved phases finished, with a concise result/commit report.

`restart-required` and `upgrade-required` are blocked reasons, not extra states. A `running` response is valid only if progress does not depend on polling. Escalations are conversational and omit gate IDs, digests, paths, and protocol codes by default.

### 5. Autonomous run responsibility

One post-design run must:

1. re-authenticate the approved task design and delegation envelope;
2. reconcile durable state and resume any incomplete semantic operation;
3. produce and independently review the next phase design;
4. triage/remediate to a fixed point inside the approved envelope;
5. record the reviewed phase design and enter implementation without public hand-off;
6. implement, verify, independently review, triage, and remediate to a fixed point;
7. synchronize parent documents and write the phase implementation log;
8. compute, stage, inspect, create, observe, and report the exact task-scoped milestone commit;
9. advance to the next approved phase and repeat, or return a completion report.

Current fine-grained transitions remain useful as internal crash-safe checkpoints. Routine findings and repairable test failures stay inside the loop. A configurable remediation limit converts failure to converge into an escalation. The runner classifies its own revisions conservatively; anything that may invalidate evidence triggers fresh independent review, while demonstrably editorial changes may use the one-hop retained-evidence path.

### 6. Delegation envelope and worker capabilities

Task-design approval must bind an exact, human-readable execution envelope containing at least:

- the approved PRD, task design, architecture, and phase plan;
- repository constitution and task configuration;
- authorized repository and task-local scope;
- allowed local commands and Git effects;
- the absence of unapproved external, destructive, privileged, credential/secret, or security-sensitive effects.

The envelope is semantic policy derived from approved durable artifacts, not caller-authored digest metadata. It must be enforced mechanically. Write-capable workers receive dispatcher-controlled access limited to the authorized worktree/task files; other tasks and Git metadata are excluded. Network/external effects, privilege escalation, destructive operations, and out-of-scope writes are denied unless specifically authorized. Workers may inspect Git but cannot stage, update refs, or commit; the fenced coordinator owns those actions. A denied capability returns structured evidence for the coordinator to prove authorized or escalate before effect.

### 7. Nonblocking decisions and controls

Replace the current blocking gate call plus filesystem decision side channel:

1. originating operation durably records a server-issued presentation in workflow or maintenance authority;
2. MCP returns/notifies immediately so the client can converse with the human;
3. `archflow_decide` binds the response to the exact presentation, acquires the applicable fence, re-authenticates observations, records provenance/replay protection, applies the effect, and resumes automatically when safe.

A design-amending choice may result in a drafted amendment and a new exact-document approval presentation. A `waiver-requested` choice automatically derives the separate waiver decision; the later grant/deny remains explicit new human authority.

Pause stops at the next safe durable boundary and remains resumable. Cancel never marks unfinished phases complete. Cleanup that would destroy material work/evidence requires separate confirmation or later administration.

### 8. CLI and skills

Keep the local executable only for bootstrap and unavailable-server diagnosis:

- installation, project-scoped registration, repository initialization;
- version/launch diagnostics;
- task-state-read-only doctor fallback when MCP cannot start or lacks compatible diagnostics;
- explicitly approved installation/registration repair needed to restore MCP.

Remove agent-facing workflow/mutation roles from `build-request`, `envelope`, `validate`, `hash`, `render`, `snapshot`, `restore`, `clean`, `reconcile`, `manual-status`, `decide`, workflow `status`, and stateful `upgrade`; internalize useful pure logic. No CLI command should compose an MCP request, stage a live intent, write a decision, mutate workflow state, repair task state, run a stateful migration, or commit task work.

Target skill roles:

- retain `$archflow-init`, `$archflow-constitution`, `$archflow-explore`, `$archflow-status`;
- keep `$archflow-prd` and `$archflow-design` as thin pre-design conversational MCP clients;
- keep `$archflow-upgrade` as thin exceptional migration guidance over semantic MCP;
- retire `$archflow-phase-design` and `$archflow-phase-impl` as public entry points; preserve their useful guidance in private worker briefs;
- add `$archflow-run` for autonomous post-design execution;
- add `$archflow-doctor` for health/recovery.

Normal skills should contain human conversation and semantic MCP intents only. They should not encode CLI recipes, transition/state codes, request templates, schema/digest/receipt/lock/build identities, or repair trees. On diagnostic blockage they relay the human-readable symptom and point to the doctor.

## Priority and dependency order

The audit gives this exact implementation sequence:

1. Approve the explicit policy change defining bounded task-design delegation, automatic checkpoint/commit authority, and escalation conditions.
2. Run real-host transport/catalogue spikes: maximum tool-call duration, stdio EOF, interruption, concurrent pause/cancel, reconnect, and whole-catalogue advertisement/tool selection. Choose attached versus minimally supervised execution and set a measured catalogue budget.
3. Define `WorkflowView`; semantic `start`/`submit`/`status`/`run`/`decide`/`control`; compact diagnose/upgrade contracts; common decision binding; the four internal identities; update policy; repository fence; worker capability profile; and task-run checkpoints.
4. Extract semantic internal services from `build-request` and current state/review/gate handlers so the coordinator uses them without CLI/MCP self-round-trips.
5. Add diagnose/upgrade, build-session mismatch handling, maintenance decisions, and doctor fallback; reduce CLI scope before deleting mutation commands.
6. Implement a resumable, capability-restricted, fenced coordinator for one complete phase, including orphan recovery, independent review, remediation, verification, scoped commit, and advance.
7. Make escalation opening nonblocking; unify workflow/diagnostic decision resolution in `archflow_decide`; automatically resume after successful authority restoration.
8. Extend the coordinator across all approved phases and produce a single completion report.
9. Finish the required pre-design facade; rewrite normal/upgrade skills; retire public phase skills; add run/doctor skills; prove normal and exceptional paths in real hosts.
10. Retire low-level MCP tools and agent-facing CLI workflow commands. Prefer direct replacement over a compatibility layer unless a demonstrated current-user requirement justifies compatibility machinery.

Key dependencies:

- Policy approval precedes enforcement changes; current gates remain mandatory until then.
- Real-host transport results precede the final run architecture and catalogue budget.
- Semantic contracts, fencing, identities, capability profile, and checkpoint semantics precede coordinator implementation.
- Internal service extraction precedes coordinator composition.
- The one-phase coordinator and nonblocking decision path precede multi-phase automation.
- CLI mutation removal follows availability of semantic MCP diagnostics/maintenance and the coordinator paths that replace it.
- Public phase-skill retirement follows full autonomous execution and preservation of their useful instructions as private briefs.

## Intended outcomes and success signals

- Happy-path post-design execution is one public `archflow_run` call, zero human prompts, and no client-managed phase-to-phase calls.
- Status is optional observation and reports semantic progress rather than the next low-level transition the caller must enact.
- Human involvement after design is rare and limited to new authority, unresolved product judgment, explicit policy/waiver decisions, and pause/cancel.
- One compatible fenced coordinator performs every authoritative mutation; durable records allow compatible restart/resume without session memory.
- No CLI/MCP split-brain mutation path or filesystem decision side channel remains.
- A successful escalation decision resumes automatically.
- Approved PRD/design bytes and exact commits are observed under the fence before autonomous hand-off; run cannot begin from merely conversational or uncommitted approval.
- The runner cannot implement without a durable independently reviewed conforming phase design, and cannot commit without current review/verification, synchronized parent docs, implementation notes, and proven task-scoped diff.
- Worker attempts at out-of-scope writes, Git mutations, network/external effects, privilege escalation, and destructive operations are prevented before effect and surfaced as structured escalation evidence.
- Two sessions/tasks cannot concurrently dispatch write-capable workers into one repository/worktree; stale/orphan results cannot be admitted.
- Normal skills have no low-level protocol vocabulary or post-init CLI workflow calls.
- Advertised MCP tools are purpose-described, compact, plain-object-rooted, and usable correctly on first call in both real hosts without skill prose teaching old protocol mappings.
- Completion yields an auditable summary of phases, verification, reviews, deviations, and commits, without another progress-blocking approval.
- Existing integrity guarantees remain covered: independent review, evidence freshness, task isolation, canonical/digest/replay integrity, crash recovery, Git scope, parent synchronization, and implementation logs.

## Explicit constraints and non-goals

- This is a prototype-oriented direct refactor, not a generalized distributed job platform.
- Do not replace the durable state machine merely to simplify the public API; keep useful fine-grained internal checkpoints, receipts, digests, and transactions.
- Public call atomicity means one semantic client intent, not one filesystem transaction.
- MCP is the only supported public workflow transport. An independent terminal workflow transport is explicitly out of scope for this iteration.
- Do not create a second diagnostic MCP server; keep one compact diagnostic tool on the same coordinator path.
- Do not create a CLI compatibility frontend or parallel mutator by default. Add compatibility only for a demonstrated current-user need.
- Do not defer pre-design and migration facades while replacing post-design tools; the final surface must have no low-level dependency in those journeys.
- Keep advertised input schemas at a plain object root; place unions/discriminators below the root.
- Durable state, receipts, evidence, Git observations, and fencing remain authoritative; process memory does not.
- Preserve opposite-family review independence, applicable constitution review, evidence invalidation on significant change, the phase state machine, task isolation, parent-document synchronization, implementation logs, exact-byte/digest/replay checks, pinned context, re-authentication, task-scoped Git checks, and atomic state replacement.
- Human-readable escalations hide mechanical IDs/digests/paths by default.
- Constitution waivers and all expansions of authority remain explicit human decisions.
- A broad authorization such as “do whatever is needed” is not an acceptable delegation envelope.
- Unsafe effects are denied before execution; the runner must not attempt them and merely report afterward.
- Cancel/pause cannot invent completion, and cleanup must be proportional to destruction risk.
- Updating this audit does not alter current policy. Existing phase-design approval, commit authorization, and commit confirmation remain mandatory until policy is separately revised and approved.

## Escalation categories

The autonomous runner should escalate only when it lacks authority or irreducible human judgment, specifically when:

- continuation materially changes requirements, architecture, phase plan, safety policy, or authorized repository scope;
- constitution compliance fails/is uncertain or a waiver is required;
- implementation exposes a product tradeoff unresolved by the approved PRD/design;
- an operation needs unapproved external, destructive, privileged, credential/secret, or security-sensitive effects;
- drift, unrelated changes, conflicts, or recovery ambiguity make safe commit scope uncertain;
- review/verification does not converge within the configured autonomous remediation budget;
- durable authority is inconsistent and repair requires choosing among plausible histories.

The escalation should ask for the smallest new decision that restores a safe envelope. Ordinary findings, repairable verification failures, editorial corrections, evidence invalidation, parent updates, milestone commits, and phase transitions are not escalation-worthy by themselves.

## Unresolved choices requiring design/spike decisions

- Run transport: keep `archflow_run` attached until completion/escalation versus use the smallest durable supervisor/background runner. This must be decided from real-host evidence about maximum call duration, stdio teardown/EOF, interruption, and concurrent pause/cancel.
- Notification/attachment mechanics: exact behavior when a long-running call is interrupted, how clients reconnect/attach, and how completion/escalation is delivered without status polling.
- Catalogue budget: a measured maximum for the entire advertised catalogue in both real hosts, including compact diagnose and upgrade tools.
- Exact `WorkflowView` schema, progress-detail levels, common return shape, and common server-issued decision/choice binding.
- Exact semantic checkpoint model for resumability and what constitutes a bounded worker operation/safe stop boundary.
- Exact durable repository/worktree fencing format, acquisition/recovery protocol, maintenance-fence relationship, and process/worker liveness proof.
- Exact worker capability mechanism for filesystem scoping, Git denial, network/external denial, privileged/destructive denial, and capability-request evidence.
- Configured autonomous remediation budget and the threshold/presentation for non-convergence escalation.
- Detailed update/compatibility policy: how compatibility is declared, how loaded/installed/registered identities are compared, and what durable versions require migration rather than restart.
- Exact cancel cleanup policy and which cleanup actions need separate confirmation.
- Exact compact scope of doctor inspection, bounded maintenance proposal/receipt shape, and task-state-read-only fallback contract.
- Exact migration preview/decision binding for `archflow_upgrade` and how denial/cancellation guarantees no partially canonical task.
- Whether any compatibility layer is justified by a demonstrated current user; the stated default is no compatibility layer.
- Isolated per-task worktrees are deliberately deferred; they should be reconsidered only if real concurrent-write demand justifies them.

## Risks

- Policy mismatch: implementing autonomy before revising the governing human-approval rules would silently violate current trust boundaries.
- Authority split/version skew: retaining CLI mutation or request construction allows newly installed code to mutate around an older loaded coordinator with different semantics.
- Host transport limitations: long-running attached MCP calls may be killed on timeout/EOF or prevent concurrent pause/cancel; a wrong choice could make the workflow hang or require polling.
- Concurrency/corruption: task-level locks alone do not protect the shared worktree/index/branch. Multiple writers, stale fencing generations, or orphaned workers can contaminate or misattribute changes.
- Recovery ambiguity: process loss during edits can leave partial work whose ownership/scope cannot be proven. Safe behavior is escalation, which may reduce autonomy in difficult recovery cases.
- Capability enforcement gap: prompt-only restrictions are insufficient; without mechanical sandboxing, autonomous workers could make unauthorized filesystem, Git, network, privileged, or destructive changes before escalation.
- Over-broad delegation: a vague envelope could hide material design expansion and weaken meaningful human approval.
- Evidence staleness: autonomous remediation or parent-document edits could reuse obsolete review evidence unless conservative materiality classification and fresh-review rules remain enforced.
- Commit safety: coordinator-owned Git increases consequence of scope-classification bugs; exact staging, task-scoped diff proof, verification, review freshness, log/parent synchronization, and commit observation must remain prerequisites.
- Diagnostic repair risk: if doctor/maintenance decisions depend on malformed task state or lack stale/replay fences, recovery can worsen corruption or apply an outdated repair.
- Catalogue/tool-selection risk: adding semantic, diagnostic, and upgrade tools without removing internal schemas can retain the current 105 KB context burden and poor first-call selection.
- Transitional incompleteness: replacing only post-design paths would leave PRD/design/upgrade skills tied to low-level tools and CLI, preserving the split surface.
- Loss of useful crash checkpoints: collapsing the implementation into one coarse transaction would undermine restart/replay guarantees; the public interface should be coarse while internals remain fine-grained.
- Excess infrastructure: turning the prototype into a generalized worker/job platform, compatibility framework, or multi-worktree system would conflict with the repository's simplicity priorities.

## Concise interpretation for PRD authorship

The follow-up is an API and orchestration ownership refactor with a required policy change. Its product promise is: before design approval, clients submit human-authored documents and decisions through a small semantic MCP facade; after exact task-design approval and commit observation, one fenced coordinator autonomously completes all approved phases, surfacing only completion, optional observation, explicit pause/cancel, or rare decisions that genuinely require new human authority. The implementation should reuse current durable integrity machinery internally, eliminate CLI mutation and public low-level protocol details, mechanically constrain workers, and fail closed on version, concurrency, scope, capability, or recovery ambiguity.
