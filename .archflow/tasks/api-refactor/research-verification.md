# Verification research for the client-interface follow-up

## Scope and evidence inspected

This is factual research for the `api-refactor` PRD. It does not draft or review the PRD. No `.archflow/tasks` content was read.

Primary source:

- `docs/validation/client-interface-audit.md` (audited 2026-08-14 at commit `6637099`, explicitly a recommendation and not current policy or implementation).

Maintained documentation inspected:

- `docs/OVERVIEW.md`
- `docs/COMPLEXITY.md`
- `docs/PATTERNS.md`
- `docs/DEPENDENCIES.md`
- `docs/TESTING.md`
- `docs/LIMITATIONS.md`
- `docs/workflow/LIFECYCLE.md`
- `docs/workflow/SKILLS.md`
- `docs/mcp/SERVER.md`
- `docs/mcp/DISPATCH.md`
- `docs/cli/COMMANDS.md`
- `docs/review/COUNTER-REVIEW.md`
- `docs/contracts/CONTRACTS.md`
- `docs/state/DURABLE-STATE.md`

Representative implementation and contract evidence inspected:

- Current public contracts and catalogue: `src/contracts/mcp-tools.ts`, `src/contracts/tool-names.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/mcp/sdk-adapter.ts`.
- Current orchestration surfaces: `src/state/next-action.ts`, `src/state/status.ts`, `src/local/build-request.ts`, `src/local/commands.ts`.
- Current runtime/dispatch and persistence: `src/dispatch/workspace.ts`, `src/dispatch/process.ts`, `src/dispatch/coordinator.ts`, `src/state/lock.ts`, `src/state/transaction.ts`, `src/repository/git.ts`.
- Generated schema tooling and release surface: `scripts/generate-schemas.mjs`, `package.json`, release contract/boundary tests.
- Representative unit, contract, integration, crash, installed-distribution, and real-host tests, especially `mcp-advertised-schema`, `skill-contract-*`, `status-request-roundtrip`, `local-cli-command-surface`, `mcp-stdio`, dispatch workspace/coordinator, schema registry, repository boundary, and `real-host/terminal-journey`.

Current repository facts relevant to the acceptance boundary:

- The current advertised MCP surface is exactly four low-level tools: `archflow_state`, `archflow_counter_review`, `archflow_gate`, and `archflow_waiver`.
- Current descriptors contain `name`, `inputSchema`, and `outputSchema`; there is no purpose-level tool description. The input schema description explains only the full-payload/staged-reference parameter groups.
- The current advertised catalogue is fenced below 130,000 serialized characters; the audit records approximately 105,478 bytes after pruning. That is current evidence, not the target budget.
- The current CLI has fourteen flat commands. It composes/stages MCP requests, writes gate decisions, performs task-state maintenance, and exposes status/migration helpers.
- Current status has seventeen `NextActionCode` values and exposes low-level action identity. Brief status removes request templates, so skills currently encode the action-code-to-composer-to-MCP mapping.
- Current concurrency authority is a task-local transaction lock with a 250 ms acquisition deadline. It does not serialize two tasks or two MCP processes that can write the same worktree.
- Current dispatch is review-only. The connected MCP host is the producer; the server dispatches only reviewers/adjudicators. Review children receive a Git-free checkout and task authority is removed.
- Current dispatch containment is explicitly best effort. There is no `SandboxProvider`, filesystem namespace, credential boundary, network boundary, or OS-enforced containment. The child receives canonical host credentials and can technically read outside its view.
- Current process dispatch does have bounded timeout/output, process-group termination, an allowlisted environment, disposable workspace, and retained post-change review snapshots.
- Current durable state and `last_transition` support exact replay of the newest committed call, but there is no durable autonomous run checkpoint, repository fencing generation, worker-process ownership record, or separate repository-maintenance authority described by the audit.
- Current Git behavior leaves implementation staging/commit to the outer agent after a human commit-authorization gate and an additional explicit confirmation. Design milestone commits are also performed by the producer skill after approval. The coordinator does not currently own commit effects.
- Current generated schemas are Zod-derived and fenced by `check:schemas`; registry tests currently pin 32 documents, 31 generated. Any new durable/public document changes those exact registries and counts.
- Current package/release tests pin both executables and the exact script/dependency surface. CLI reduction or new runtime dependencies therefore require deliberate release-test updates, not only source changes.
- Real-host suites are opt-in and intentionally excluded from `npm run check`; the proposed transport and first-call-selection evidence cannot be claimed from the ordinary local gate unless a distinct required evidence procedure is defined.

## Observable acceptance criteria implied by the audit

The audit's long list is easier to make testable when grouped by externally observable boundary. These are behavioral outcomes, not an implementation design prescription.

### 1. Public semantic MCP surface

- The supported public workflow transport after repository bootstrap is MCP only.
- The final public vocabulary includes semantic pre-design operations (`start`, `submit`, `status`, `decide`), post-design controls (`run`, `status`, `decide`, `control`), compact diagnosis, and semantic legacy upgrade. Exact final naming may follow the audit (`archflow_start`, `archflow_submit`, `archflow_status`, `archflow_run`, `archflow_decide`, `archflow_control`, `archflow_diagnose`, `archflow_upgrade`).
- Every public operation accepts a plain object at the advertised schema root; any submission union/discriminator is nested below that root.
- Every tool has a purpose-level descriptor description, not only parameter-group prose.
- Every normal operation returns one common semantic `WorkflowView`, with the audit's bounded state vocabulary: `ready`, `running`, `escalated`, `paused`, `canceled`, `blocked`, and `complete`.
- `restart-required` and `upgrade-required` are reasons presented under `blocked`, not extra workflow states.
- Public schemas omit low-level state/review/gate payloads and do not expose caller-authored phase/step/status transitions, revisions, fingerprints, digests, intent receipts, staged references, artifact paths already known to the server, gate IDs, evidence ordering, rubric routing, or waiver-origin reconstruction.
- The complete serialized catalogue is measured against a budget selected from a real-host spike, in both supported hosts. The current 130k regression bound is not automatically the target.
- A first-call tool-selection test succeeds in both real hosts without a skill teaching the old status/action/composer/tool mapping.

### 2. Interactive pre-design behavior

- Starting a task pins configuration and opens the PRD work boundary using one semantic call.
- Submitting PRD or task-design work drives capture, automatic opposite-family/constitution review, triage/remediation, and opening a nonblocking human presentation until genuinely new client content or human authority is needed.
- PRD and exact task-design bytes still receive explicit human approval; the exact approved milestones are committed and observed under the repository fence before hand-off.
- Resolving a pre-design decision requires only the server-issued choice binding, human reason, and genuinely choice-specific rationale; all mechanical bindings are server-derived and stale/replay protected.
- The pre-design facade is part of this follow-up. Acceptance cannot leave PRD/design or migration skills dependent on the old low-level tools or `archflow-local` and still call the public refactor complete.

### 3. Autonomous post-design happy path

- From an execution-ready, committed task design, one public `archflow_run(task)` invocation owns all approved phases through completion or a rare escalation.
- The zero-escalation path has zero human prompts and zero client-managed calls between phases.
- Status observation is optional. A `running` response is valid only when execution proceeds independently; polling must never drive progress.
- The run internally owns phase-design production, independent review, constitution review, triage, remediation, implementation, verification, implementation review, parent-document synchronization, implementation logs, scoped commits, phase advancement, and completion reporting.
- A phase cannot enter implementation until a durable phase design exists, has current independent review evidence, and is proven to conform to the approved task design.
- A phase cannot commit until configured verification succeeds, review evidence is current, parent documents are synchronized, an implementation log exists, and the diff is proven task-scoped and inside the approved envelope.
- Completion reports phases, verification, reviews, deviations, and exact commits and does not require another approval to make already-authorized progress durable.

### 4. Escalation and decisions

- Routine review findings, repairable verification failures, evidence invalidation, ordinary parent-document updates, scoped commits, and phase transitions remain internal work.
- Escalation occurs before effect when continuation would change requirements/architecture/phase plan/scope; needs a constitution exception; exposes an unresolved product tradeoff; requests an external, destructive, privileged, credential/secret/security-sensitive effect; encounters unsafe repository drift/conflict/scope ambiguity; exhausts remediation; or faces ambiguous durable authority.
- Every escalation is durable and conversational: what happened, why current authority is insufficient, relevant evidence, choices, and consequences. Mechanical bindings remain diagnostic detail.
- Opening an escalation returns/notifies without a pending MCP request plus polling/file-decision side channel.
- `archflow_decide` re-authenticates the exact presentation and current observations under the applicable fence. A decision that restores authority resumes execution in the same semantic operation until completion or the next escalation; no separate `advance`, `gate`, or `run` call is needed.
- Waiver request and waiver grant/deny remain separate human authority events; the server derives the waiver origin and eligibility.
- A material PRD/task-design amendment returns an exact-document approval presentation; it does not silently broaden the run envelope.

### 5. Pause, cancel, interruption, and recovery

- Pause takes effect at a defined safe durable boundary and leaves a resumable run.
- Cancel stops execution without marking unfinished phases complete. Destructive cleanup of useful work/evidence requires separate confirmation or remains an administrative follow-up.
- An interrupted `run` can be reissued without duplicate reviews, transitions, decisions, or commits.
- A compatible replacement MCP process reconstructs semantic progress from canonical durable authority; session memory is never required.
- Restart/update behavior is observable: if installed/registered code changes while a run is owned, the current coordinator completes or safely terminates only its current bounded worker operation, records a checkpoint, dispatches no new worker, releases ownership, and returns `blocked` with restart-required guidance.
- A durable contract incompatibility is distinguished from loaded-build skew and routes to upgrade/migration diagnosis.

### 6. Exclusive live authority and Git safety

- Every authoritative workflow mutation, decision, task-state repair, migration, and commit is admitted by a compatible MCP coordinator holding the current durable fence.
- The repository/worktree fence serializes write-capable autonomous execution across tasks and host sessions; a second task/session receives a semantic busy/blocked view rather than becoming another writer.
- The durable record distinguishes loaded server build, contract/schema compatibility version, ephemeral process instance, and fencing generation.
- Every write-capable worker and returned result is bound to the current fencing generation and supervised process identity.
- Ownership is not reclaimed until the previous writer is proved exited or is terminated. Stale-generation results cannot be admitted, staged, or committed.
- Ambiguous orphan edits fail closed and escalate; a replacement worker is not launched over edits that cannot be safely attributed.
- Coordinator-owned commits are exact and scoped: it computes, stages, inspects, creates, observes, and reports the approved commit. An unprovable diff escalates before commit.

### 7. Mechanically enforced worker envelope

- Write-capable producers receive only the repository/task context and capabilities authorized by the approved task-design envelope.
- Attempts to write outside authorized worktree/task paths, touch Git index/refs or commit directly, perform unapproved network/external actions, escalate privilege, or run destructive host operations are denied before effect.
- Denials produce structured evidence the coordinator can either match to existing authority or use to open the smallest escalation.
- Workers cannot grant themselves capabilities, and a stale or unsupervised worker cannot publish results after fence loss.
- Reviewer independence and the existing exact retained-snapshot review semantics remain intact.

### 8. Diagnostics and maintenance

- `$archflow-doctor` owns diagnosis. Normal workflow skills relay only a semantic blocked result and tell the user to invoke the doctor.
- `archflow_diagnose` is observation-only for task/worktree/Git state and returns a compact human report plus one semantic next action. It may at most append a bounded proposal/receipt in repository maintenance authority.
- A proposed repair is durable, stale-safe, replay-safe, independent of possibly malformed task state, and applied only through a server-issued `archflow_decide` choice after re-authentication under the repository maintenance fence.
- The unavailable/incompatible-server CLI fallback does not interpret or mutate task state. It may diagnose installation/registration and change bootstrap configuration only with explicit approval.
- Legacy upgrade is semantic MCP maintenance: a read-only preview first; only a replay-safe maintenance decision may create the distinct canonical task. Denial/cancellation creates no partial task.

### 9. CLI and skill boundary

- After initialization, normal workflow skills invoke zero `archflow-local` workflow commands.
- No distributed CLI command composes an MCP request, stages live intents, writes decisions, mutates/reconciles/repairs task workflow state, runs stateful migration, creates/restores snapshots, advances phases, or commits task work.
- The remaining local executable surface is limited to installation, project registration, repository initialization, build/launch diagnosis, read-only unavailable-server diagnosis, and explicitly approved bootstrap/registration repair.
- `$archflow-prd`, `$archflow-design`, and `$archflow-upgrade` use the semantic MCP facade.
- `$archflow-phase-design` and `$archflow-phase-impl` cease to be public entry points. Their still-useful trust and work instructions become private runner-owned worker briefs.
- `$archflow-run` and `$archflow-doctor` become public skills; `$archflow-status` remains read-only semantic observation.
- Normal skills contain no old low-level tool names, phase transition triples, revisions/digests/receipts/staged references, CLI fallbacks, gate-opening mechanics, review-triage protocol, commit confirmation protocol, locks, or build identities.

### 10. Preserved integrity guarantees

- Canonical durable bytes, exact digests/fingerprints, replay receipts, pinned context, state transactions, atomic replacement, and re-authentication remain authoritative internally.
- Opposite-family review and applicable constitution review remain producer-independent.
- Any potentially material revision invalidates old review evidence and runs a fresh cycle; only demonstrably editorial changes may reuse one-hop evidence.
- Task isolation remains strict; tasks do not read each other's files.
- The phase lifecycle remains no document -> `DESIGNED` -> `IN PROGRESS` -> `COMPLETE` even though public calls no longer expose each transition.
- Implementation deviations update PRD/design as required; a material expansion escalates for exact human approval.
- Every completed phase writes implementation notes.
- Existing structural safety around path containment, safe Git scope, secret rejection, strict plain-JSON parsing/materialization, and durable archive reading must not regress.

## Representative verification matrix

The audit explicitly asks for client-level and adversarial tests. The following is the smallest representative matrix that exercises each observable boundary without duplicating every internal permutation.

### Contract/schema tests

- Replace the four-name catalogue pin with the intended semantic tool set and assert each descriptor includes a nonempty purpose-level description.
- For every tool: strict-compile the standalone input/output; assert a plain object root with no root `oneOf`/`allOf`/`anyOf`/`$ref`; assert nested discriminated variants keep their types; assert no internal state/review/gate schema is reachable.
- Add parser/generated-schema agreement and portable-structure/runtime-semantic corpus cases for all `WorkflowView`, submission, control, decision-binding, diagnosis, migration, and error variants.
- Pin that all public operations return the same `WorkflowView` envelope and only the seven semantic state values.
- Add stale, replayed, wrong-task, wrong-fence-generation, wrong-build/contract, and option-specific-rationale decision-binding cases.
- Update schema registry/generation counts and committed JSON schema drift checks; do not hand-edit generated documents.
- Keep the advertised-catalogue reachability/deep-freeze tests and replace the current 130k bound only after the real-host spike sets a measured budget.
- Keep public contracts free of internal authority mint factories and preserve the contracts-to-repository dependency direction.

### Skill contract tests

- Enumerate the new public skill set and assert retired phase skills are absent from installation/discovery/public docs while any private briefs are not public skills.
- For normal skills, assert the audit's forbidden vocabulary is absent (`archflow_state`, `phase_instance`, transition status triples, expected revision/fingerprint/digest/intent/staged reference, build-request/envelope, submission of phase work, triage, gate opening, commit confirmation, phase advance, local fallbacks, locks/receipts/build identities).
- Assert PRD/design/upgrade use only shipped semantic MCP tools; run/status/doctor roles are distinct; doctor alone contains fallback diagnostic guidance.
- Preserve conversational-gate, exact human-ask, explicit document approval, constitution, review-independence, and task-isolation contract assertions where still applicable.

### Unit/service tests

- Semantic next-operation derivation from durable checkpoints, including resume after every internal state boundary.
- Repository fence acquire/busy/release/generation increment, separate task identity, maintenance-vs-execution authority, and loaded-build/contract compatibility.
- Worker admission checks: correct generation/process/result, stale generation, process mismatch, orphan status, and cancellation.
- Update policy: loaded-vs-installed drift during a bounded worker operation permits a checkpoint but no subsequent dispatch.
- Escalation classifier tests for each audit category and negative cases proving ordinary failures remain internal.
- Pause/cancel safe-boundary transitions and cleanup-confirmation behavior.
- Coordinator materiality classification and fresh-review invalidation.
- Commit service tests for exact scope, baseline/target ref, unrelated changes, parent-document/log presence, configured verification/review evidence, commit creation, and observation.
- Diagnostic report/proposal tests independent of task-state parsing; stale/replayed repair decisions and maintenance-fence checks.
- Capability profile construction and denial before spawning/effect.

### Integration tests

- One multi-phase zero-escalation journey: one `archflow_run`, no human decisions, no phase-level client calls, exact commits and final report.
- One journey for each escalation category, showing immediate presentation, one decision, automatic resume, and no follow-up advance/gate/run call.
- Pre-design start -> submit/review/remediate -> exact PRD approval/commit -> task design approval/commit -> `ready` hand-off.
- Pause/resume and cancel, including cancel without false completion and a separate destructive-cleanup confirmation when applicable.
- Transport interruption at representative checkpoints before/after worker dispatch, review persistence, decision resolution, commit creation, and phase advance; reissue without duplicates.
- Two tasks and two host sessions competing for one worktree fence.
- Orphan producer: prove termination before reclaim; reject stale returned output; ambiguous partial edits remain blocked.
- Installed-build update while a run is active: current bounded operation checkpoints, then restart-required; a compatible new process resumes.
- Diagnostic flow with malformed task state, plus unavailable-server fallback proving no task-state writes.
- Legacy preview/deny/approve/replay, including no partial canonical destination.
- Public gate/decision path is nonblocking and has no `archflow-local decide`, polling loop, or filesystem decision channel.
- Retire/replace `test/integration/status-request-roundtrip.test.ts` assertions whose sole purpose is the old seven-mutation choreography; keep underlying kernel lifecycle coverage as internal service tests.

### Crash/fault tests

- Process death around fence acquisition/release, durable checkpoint replacement, worker launch/admission, escalation proposal/decision, exact staging/commit observation, and task completion.
- Recovery chooses prior or fully installed authority, never a partial semantic operation.
- A stale coordinator/worker cannot write after a newer fencing generation.
- Maintenance proposals and repair receipts survive malformed task state and crash without becoming self-authorizing.

### Adversarial worker tests

- Attempted write outside authorized repository/task paths.
- Attempted cross-task read/write.
- Direct `.git` index/ref write, staging, and commit.
- Unapproved model-initiated network/external request (distinct from the first-party model provider transport needed to run the worker).
- Privilege escalation and destructive host command.
- Result returned after cancellation, fence loss, or process replacement.
- All cases must prove denial before effect and structured escalation evidence; an output scan alone is insufficient.

### Real-host and installed-distribution tests

- Before fixing the run transport, spike both hosts for maximum expected call duration, stdio EOF, host interruption/cancellation, reconnect/idempotent attach, and pause/cancel while run work is active.
- Based on that evidence, select attached run-until-boundary only if supported; otherwise test the smallest durable supervisor/background runner.
- Measure the whole catalogue in both hosts and prove correct first-call selection without old protocol instructions.
- Update the installed terminal journey to exercise the semantic surface and prove the distributed CLI cannot mutate workflow/task state.
- Keep opposite-family routing, authentication, timeout, failure-class, output-schema, and installed-release smoke coverage.
- Because real-host tests are currently opt-in and excluded from `npm run check`, the PRD must define what run output/artifact is required as acceptance evidence for the transport/catalogue decisions.

### Existing regression suite to preserve

- `npm run typecheck`, `npm run check:schemas`, focused MCP runtime tests, ordinary tests, contract tests, temporary bundle smoke, notice policy, MCP SDK boundary, and release integrity/reproducibility.
- Review independence and pinned context; current-evidence freshness; significant-revision restart; task isolation; canonical/digest/replay integrity; transaction/crash recovery; secret rejection; safe path/Git scope; parent-document synchronization; implementation log and verification transcript binding.
- Tests that enforce fresh human approval for every post-design phase design or implementation commit should be replaced only after the separate trust-policy change is approved, and then replaced with bounded-delegation plus fail-closed escalation tests rather than simply deleted.

## Maintained documentation impact

Behavioral completion would require coordinated updates to essentially the entire maintained caps-named set because the audit changes every documented public surface and several trust boundaries:

- `docs/OVERVIEW.md`: replace the three-surface authority map, client choreography, evidence pipeline, gate/advance narrative, glossary, and degraded-mode description with coordinator/control-plane/diagnostic/private-worker boundaries.
- `docs/COMPLEXITY.md`: mark the client-orchestration target's disposition and document any coordinator/fencing complexity retained as load-bearing.
- `docs/PATTERNS.md`: update CLI/MCP conventions; add semantic-view, server-issued decision binding, durable fence/generation, coordinator-owned side-effect, and worker-capability conventions if these become established patterns.
- `docs/DEPENDENCIES.md`: update MCP/host integration, process supervision, filesystem/Git enforcement, environment/network/auth boundaries, runtime dependencies, scripts, and release entries. This is mandatory if containment or a background supervisor adds a dependency or platform constraint.
- `docs/TESTING.md`: replace suite inventory and journeys with the coordinator, fence, capability, diagnostic, semantic-contract, crash, and real-host matrix; state how opt-in transport/catalogue proof is recorded.
- `docs/LIMITATIONS.md`: revise the no-sandbox/best-effort dispatch claims. Distinguish mechanically enforced producer capability limits from residual trusted-machine/same-user/managed-context limitations; document supported platforms and any unavailable-enforcement fail-closed behavior.
- `docs/workflow/LIFECYCLE.md`: document the approved task-design delegation envelope, internal phase checkpoints, rare escalation policy, pause/cancel, automatic commits/advance, and the exact human authority that remains.
- `docs/workflow/SKILLS.md`: publish run/doctor, retire public phase skills, thin PRD/design/status/upgrade roles, and remove low-level protocol/degraded-mode recipes from normal skills.
- `docs/mcp/SERVER.md`: replace the four-tool catalogue and staged-reference public flow with semantic tools/common view; document coordinator candidature, fence admission, update/restart behavior, nonblocking decisions, and internalized kernels.
- `docs/mcp/DISPATCH.md`: add producer dispatch, supervised process identity, write-capability profiles, task/repository scope, stale-result admission, orphan recovery, and preserve reviewer independence.
- `docs/cli/COMMANDS.md`: document the reduced bootstrap/diagnostic-only executable and explicitly remove the workflow-mutating/composing command surface.
- `docs/review/COUNTER-REVIEW.md`: distinguish public decisions from private automatic checkpoints; update review/triage/remediation ownership, evidence invalidation, and rare constitution/waiver escalation.
- `docs/contracts/CONTRACTS.md`: add common `WorkflowView`, semantic input contracts, decision/maintenance bindings, run/fence/checkpoint identities, and clarify which old request/staging contracts remain internal or are retired.
- `docs/state/DURABLE-STATE.md`: add repository execution and maintenance fences, fencing generations, run checkpoints, worker ownership, maintenance proposals/receipts, pause/cancel/completion states, restart recovery, and coordinator-owned Git boundary.

`docs/validation/client-interface-audit.md` is point-in-time validation evidence, not part of the maintained set. It should not be silently rewritten as current implementation documentation; if implementation evidence is recorded, use a new point-in-time validation report or an explicit status annotation that preserves the audit's original claim.

## Risks the PRD must surface

- **Current hard-policy conflict.** Repository policy currently says never pass a review gate or commit without explicit human approval and never write code before exact phase-design approval. The audit explicitly proposes changing that trust model. The audit itself grants no authority. Autonomous post-design checkpoints/commits cannot be accepted until the constitution/governing policy is separately revised and explicitly approved.
- **Scope size.** This touches contracts, generated schemas, MCP discovery/runtime, state/durable layouts, Git authority, dispatch, skills/install assets, CLI/release packaging, documentation, and every testing layer. Treating it as a schema rename would leave dangerous parallel mutation paths.
- **Transport uncertainty.** The audit intentionally defers attached versus durable background execution to a real-host spike. Host timeouts, stdin EOF, cancellation semantics, and whether a concurrent control call is possible can invalidate an attached design.
- **Containment gap.** Current review dispatch explicitly has no OS sandbox. The new requirement is stronger: write-capable workers must be mechanically denied filesystem/Git/network/privileged/destructive effects before action. Prompts, CLI flags, environment scrubbing, and output scanning do not satisfy it.
- **Credential/provider distinction.** A model CLI needs authenticated provider transport, while model-initiated arbitrary network/external actions must be denied. The capability model must state this distinction or the requirement is internally contradictory.
- **Repository-wide serialization.** The current task-local lock is insufficient. A durable repository fence must survive multiple server processes and task identities without making stale process/session memory authoritative.
- **Orphan process ambiguity.** Process-group kill is not a complete process-tree proof on every platform. Reclaiming a fence while a writer may survive can corrupt scope; safe failure may leave the workflow blocked until human diagnosis.
- **Coordinator-owned Git is new authority.** Current production code mostly verifies Git and leaves commits to the client. Staging/ref mutation and exact commit creation must be built under the fence with fail-closed unrelated-change handling.
- **Producer dispatch is new.** Current server dispatches reviewers only and treats the connected host as producer. Autonomous work requires a producer route, private brief/result contract, credentials/model-family policy, and review-family independence after the producing child is selected.
- **Malformed-state repair.** Diagnostic proposals must remain usable when task state is corrupt without becoming a second unguarded authority store. Maintenance and execution fence precedence must be explicit.
- **Compatibility/release skew.** The distributed CLI and long-lived MCP process currently can load different versions. Removing CLI mutation closes one path, but build identity, contract compatibility, registration state, dist bundles, and restart policy all need direct tests.
- **Catalogue budget/tool selection.** Smaller schemas do not automatically yield correct host selection. Both size and first-call behavior need measured evidence; a numeric budget is currently unknown.
- **Remediation convergence.** The audit requires a configured budget but does not define it. Too small recreates routine human gates; unbounded loops can consume time indefinitely.
- **Migration and pre-design cannot be deferred.** Leaving upgrade or PRD/design on the old tools/CLI preserves the dual public contract and version-skew problem the refactor is meant to remove.
- **Test authority.** Ordinary `npm run check` currently excludes real-host suites, while the audit makes real-host transport/catalogue evidence a prerequisite. Acceptance evidence must be explicitly named and recorded.

## Non-goals supported by the audit

- Replacing the fine-grained durable state machine, transaction kernel, canonical documents, digests, receipts, review evidence, or re-authentication merely because they disappear from public inputs.
- Building a generalized job platform. The recommended architecture is the smallest resumable coordinator above existing kernels.
- Providing an independent terminal workflow transport. A future terminal client would need a separate transport-policy decision and must use the same fenced coordinator.
- Running a second diagnostic MCP server. Diagnosis belongs on the same MCP transport/coordinator with a separate skill and compact tool.
- Adding per-task isolated Git worktrees for concurrency in this iteration. The audit chooses repository/worktree serialization until demonstrated demand justifies more machinery.
- Preserving the old public tools/CLI via a compatibility layer by default. The repository's prototype priority favors direct replacement unless a current user requirement proves compatibility necessary.
- Treating status polling as scheduling, or exposing internal phase submissions/triage/advance as a post-design public API.
- Turning ordinary review/verification difficulty into human escalation.
- Claiming protection against an arbitrary malicious same-user process or hostile local administrator. Worker capabilities must still be enforced against dispatched workers, but the broader local threat model remains a separately documented limitation unless scope explicitly expands it.
- Changing bootstrap and repository-policy configuration into autonomous workflow actions; init and constitution remain explicit surfaces.

## Assumptions and decisions the PRD must state explicitly

- **Policy prerequisite:** whether this task includes the separate constitution/policy revision and approval or is blocked before enabling automatic post-design gates/commits. Until that approval exists, old human gates remain mandatory.
- **Delivery completeness:** whether acceptance covers the audit's full surface in one task (pre-design, post-design, diagnosis, upgrade, CLI retirement, skill rewrite) or uses phases that still end with one coherent public transport and no unsupported interim dual-authority state.
- **Run transport:** selected only after the named real-host spike; define attach/reconnect/cancellation semantics and how status/control reach an active run.
- **Catalogue budget:** the measured numeric bound and the first-call selection success criterion in Claude Code and Codex.
- **Remediation budget:** configuration source, counting semantics, reset conditions, and escalation presentation after exhaustion.
- **Safe boundaries:** exact points where pause, cancel, build update, and worker permission requests may stop; what happens to partial edits and verification output.
- **Delegation envelope:** exact durable inputs, repository/task scope, allowed Git/test commands, external effects, and what constitutes material expansion.
- **Capability mechanism/platforms:** what enforces filesystem, Git, network/external, privilege, and destructive-operation limits; supported host platforms; fail-closed behavior when enforcement is unavailable.
- **Provider access:** authenticated first-party model transport is permitted infrastructure, distinct from model-initiated external actions.
- **Producer routing:** how the coordinator selects producer family/model/effort, how it authenticates it, and how opposite-family review remains independent.
- **Common decision binding:** what minimal opaque/server-issued token the client relays, how task identity may be derived, and how stale/replay/choice-specific rationale is handled.
- **Repository fence scope:** one worktree/branch at a time; maintenance-versus-execution precedence; lease/generation ownership; recovery proof for dead/orphaned processes.
- **Commit authority:** exactly which commits task-design approval preauthorizes, allowed paths/messages/target refs, how parent-doc changes are included, and what always escalates.
- **Artifact exchange before design:** whether authored PRD/design bytes remain direct repository writes discovered by the server or travel in semantic submissions. Whichever model is chosen must remain observable, exact-byte-bound, and not reintroduce caller-authored paths/mechanical facts.
- **Diagnostic maintenance root:** where proposals/receipts live independently of malformed task state, their retention/cleanup, and why they cannot mutate without `archflow_decide` plus the maintenance fence.
- **CLI end state:** exact retained commands and whether developer-only utilities move to repository scripts rather than the installed agent-facing executable.
- **Compatibility stance:** direct replacement is assumed; if compatibility is required, name the current user need and prove it cannot create a parallel mutator.
- **Acceptance evidence:** required local gate plus the exact opt-in real-host runs/artifacts used to approve transport and catalogue behavior.

## Recommended PRD author conclusion

The PRD should define success at the semantic boundary: one MCP-only interactive facade before design, one fenced autonomous run after approved design, one common durable decision path, compact diagnosis/upgrade maintenance, and no CLI or skill orchestration of internal transitions. It should preserve the existing durable integrity kernel but make repository fencing, producer capability enforcement, crash-safe semantic checkpoints, and policy-approved bounded delegation explicit requirements. The policy prerequisite and unresolved real-host/capability decisions are material assumptions, not implementation details.
