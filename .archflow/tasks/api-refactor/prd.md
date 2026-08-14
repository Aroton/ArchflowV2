# Product Requirements: Semantic API and Human-Stepped Autonomous Phase Execution

## Summary

ArchFlow must replace its low-level, client-orchestrated transaction protocol with a small, semantic MCP control plane while preserving the human-stepped workflow. A human remains responsible for explicitly starting PRD, design, each phase-design step, and each phase-implementation step. ArchFlow must never automatically cross one of those top-level boundaries.

Inside a human-started phase-design or phase-implementation step, one durably fenced coordinator must own almost all routine work: production, independent review, triage, remediation, verification, documentation synchronization, and authorized scoped Git effects. It should return to the human only for the exact artifact approval already required by the workflow, a decision the approved artifacts do not resolve, new authority, or another condition the AI cannot safely handle. When the current step completes, ArchFlow stops in a durable state ready for the human to start the next step.

The refactor must preserve ArchFlow's durable state machine and integrity guarantees as internal machinery while removing low-level transitions, request construction, decision side channels, and workflow mutation from the public CLI and normal skill context. Autonomous activity is permitted only inside an exact, human-approved delegation envelope and must stop before any action that requires new authority or irreducible human judgment.

## Source and problem

This PRD actions the plan in `docs/validation/client-interface-audit.md`, as corrected by the user's clarification that humans continue to start every top-level workflow step and autonomy is concentrated inside phase design and phase implementation. The audit is point-in-time validation evidence and is not itself an implementation or policy change; its proposal for one all-phases post-design run is not a requirement of this task.

Today an AI client acts as ArchFlow's workflow coordinator. Even a no-rework document phase requires it to translate status into request-builder kinds, stage authenticated requests, invoke several low-level MCP mutations, poll status, and resolve a blocking gate through a separate CLI/filesystem path. The audit measures roughly 22–23 machine interactions for that routine path. The skills therefore carry state-machine, schema, digest, gate, waiver, repair, and transport knowledge that does not express user intent.

This split is also an authority risk. The MCP server is long-lived while each CLI command loads the currently installed code. After an update, those processes can interpret the same contract differently even though byte digests remain valid. More generally, task-local locking does not serialize writers across tasks sharing a worktree, current dispatch containment is best effort, the server does not dispatch producers, and no durable active-step checkpoint or repository fencing generation exists.

The intended boundary is one public semantic workflow transport and one exclusive live mutation gateway, with canonical durable records remaining the restart and recovery authority.

## Users

- Humans who author and approve requirements, task designs, and phase designs; explicitly start every workflow step; resolve exceptional authority or product decisions; and pause or cancel work.
- Claude Code and Codex workflow clients, which should relay semantic work and decisions rather than coordinate internal transitions.
- Maintainers diagnosing installation, version coherence, durable compatibility, dispatch health, active ownership, and recovery.
- Coordinator-dispatched producers, verifiers, and opposite-family reviewers operating inside bounded private contracts.
- Users with multiple tasks or host sessions sharing one repository and worktree.
- Users adopting legacy work through `$archflow-upgrade`.

## Goals

1. Make MCP the only supported public transport for workflow mutations, decisions, maintenance repairs, migrations, and task commits after repository bootstrap.
2. Provide a small semantic interface for every existing top-level workflow step without collapsing those steps into one autonomous run.
3. Make each phase-design and phase-implementation invocation internally autonomous while preserving human initiation of every step and exact, bounded human authority.
4. Establish one durably fenced coordinator as the exclusive repository/worktree mutation gateway.
5. Enforce the approved delegation envelope mechanically for write-capable workers and deny unauthorized effects before they occur.
6. Preserve current integrity, review-independence, evidence-freshness, task-isolation, recovery, and Git-scope guarantees behind the new public boundary.
7. Separate normal workflow, diagnostics, private worker exchange, and durable-kernel mechanics so each public skill carries only the context its user needs.
8. Deliver a coherent replacement across pre-design, post-design, diagnosis, migration, CLI, skills, documentation, and tests rather than leaving parallel authority paths.

## Non-goals

- Replacing the fine-grained durable state machine, canonical documents, transactions, evidence, digests, receipts, or re-authentication merely because they become internal.
- Building a generalized job platform, multi-repository scheduler, or distributed execution system.
- Adding an independent terminal workflow transport or a second diagnostic MCP server.
- Adding per-task Git worktrees for concurrent writers in this iteration; serialize one repository/worktree until demonstrated demand justifies more machinery.
- Preserving the old public tools or mutating CLI through a compatibility layer without a demonstrated current-user requirement.
- Making status polling advance work or exposing internal phase work, triage, verification, commits, or sub-transitions as routine client submissions.
- Automatically starting design, a phase design, a phase implementation, or the next phase without a fresh human kickoff of that exact step.
- Treating ordinary review findings, repairable verification failures, or implementation difficulty as reasons for human escalation.
- Claiming protection from an arbitrary malicious same-user process or hostile administrator. The required boundary is mechanical containment of ArchFlow-dispatched workers, with residual local-machine trust documented honestly.
- Changing repository initialization, installation, registration, or constitution editing into autonomous task actions.

## Product requirements

### R1. Governing policy and bounded delegation

The repository must explicitly approve a policy change before automated checkpoints or commits inside phase execution are enabled. The replacement trust boundary must be stage-scoped: a human starts each top-level step, and that kickoff grants prior authority only for the current step inside a bounded delegation envelope. Task-design approval does not authorize ArchFlow to start every later phase automatically.

An approved phase design plus the human's separate phase-implementation kickoff may authorize the coordinator to implement, review, verify, and create the exact scoped milestone commit for that phase without routine mid-step confirmations. The coordinator must stop durably before any material expansion and must stop again after the phase completes so the next top-level step requires another human kickoff.

Every phase-design step unconditionally ends with explicit human approval of the exact reviewed phase-design bytes. Phase implementation cannot be started until that approval is durably recorded, and it still requires its own separate human kickoff.

The envelope must be human-readable, derived from approved durable artifacts rather than caller-authored digest fields, and include at least:

- the approved PRD, task design, architecture, and phase plan;
- the pinned constitution and task configuration;
- the authorized repository and task-local scope;
- permitted local commands and coordinator-owned Git effects;
- the absence of unapproved external, destructive, privileged, credential/secret, or security-sensitive effects.

Until that policy revision is separately and explicitly approved, existing phase-design, implementation, gate, and commit-approval rules remain authoritative. A broad instruction such as "do whatever is needed" is not an acceptable envelope.

### R2. One public transport and one live mutation gateway

After bootstrap, every authoritative workflow mutation, human decision, task-state repair, stateful migration, and task commit must enter through MCP and be admitted by a compatible coordinator holding the current durable fence. A live MCP process owns nothing merely because it exists.

The system must keep these identities distinct and observable in diagnostic evidence:

1. loaded server build;
2. contract/schema compatibility version;
3. ephemeral coordinator process instance;
4. durable fencing generation.

Canonical state, receipts, review evidence, repository observations, checkpoints, and fencing records remain the restart and recovery authority; session memory must never be required to reconstruct semantic progress.

### R3. Common semantic workflow view

Public workflow operations must return a common reconciled view that communicates semantic position and, when applicable, one conversational presentation. The routine state vocabulary must be limited to:

- `ready`: the current step is complete or its prerequisites are satisfied, and the next named top-level step awaits an explicit human kickoff;
- `running`: autonomous work is continuing without another client action;
- `awaiting-approval`: the current PRD, task design, or phase design has reached its reviewed fixed point and awaits the routine explicit human decision over those exact bytes;
- `escalated`: new human authority or irreducible judgment is required;
- `paused`: work stopped at a human-requested safe boundary;
- `canceled`: execution ended without inventing completion;
- `blocked`: no valid workflow decision can currently continue, with a human-readable recovery direction;
- `complete`: all approved phases finished, with a concise result and commit report.

`awaiting-approval` is an expected workflow boundary, not an exceptional escalation. `ready` is returned only after the required approval has been recorded and means the next step is available but not started. Restart and upgrade needs are reasons under `blocked`, not additional workflow states. Status is optional observation and must never advance either an active step or the top-level workflow.

Every advertised MCP tool must have a purpose-level description and a plain object input root. Variant unions may exist only below that root. Public inputs and ordinary responses must omit caller-authored internal transitions, revisions, fingerprints, digests, intent receipts, staged references, known artifact paths, gate IDs, rubric routing, evidence ordering, and waiver-origin reconstruction.

### R4. Semantic pre-design workflow

The same follow-up must provide a semantic MCP facade for interactive definition:

- start a distinct task and open its PRD work boundary from a task identifier;
- submit PRD or task-design work, triage, a significant reopen, or a terminal failure as nested semantic variants;
- internally perform deterministic capture, automatic counter-review, triage/remediation transitions, and nonblocking presentation creation until new authored content or human authority is required;
- observe current semantic position;
- resolve an exact PRD or task-design decision through the common decision path.

PRD and task-design approvals remain explicit human decisions over exact bytes. Their exact scoped milestone commits must be created and observed under the repository fence before hand-off. Approval of one document may make the next step available, but it must not start that step. Phase design and phase implementation likewise begin only from a separate human invocation of the named step.

### R5. Human-stepped workflow with autonomous phase execution

The public workflow remains:

`PRD -> design -> phase design N -> phase implementation N -> phase design N+1 -> phase implementation N+1 -> ...`

A human must explicitly kick off every item in that sequence. Completing or approving one step may return a `ready` view naming the next available step, but the coordinator must not start it automatically. Public skills for PRD, design, phase design, and phase implementation remain distinct human entry points.

Within one human-started phase-design step, the coordinator must own:

1. focused exploration and production of the phase design;
2. independent opposite-family review and applicable constitution review;
3. evidence-based triage and remediation to a fixed point;
4. synchronization with the approved PRD and task design;
5. presentation of the exact reviewed phase-design bytes for mandatory explicit human approval;
6. a durable stop after approval, ready for the human to start phase implementation.

Within one human-started phase-implementation step, the coordinator must own:

1. implementation within the exact approved phase design and stage-scoped envelope;
2. configured verification;
3. independent implementation review, triage, and remediation to a fixed point;
4. synchronization of governing parent documents and creation of the implementation log;
5. exact task-scoped staging, inspection, commit creation, commit observation, and reporting when authorized by the approved policy and kickoff;
6. a durable stop after completion, ready for the human to start the next phase design or finish the task.

Routine internal transitions must not require client scheduling or human prompts. The coordinator may retain current fine-grained transitions as crash-safe checkpoints and must continue through them automatically while the current step remains authorized. It must never interpret internal autonomy as authority to cross into the next human-started workflow step.

### R6. Review, verification, and commit integrity

Autonomy must not weaken these guarantees:

- opposite-family and applicable constitution reviews remain independent of the producer;
- any potentially material revision invalidates stale evidence and starts a fresh review cycle; only demonstrably editorial changes may use the existing one-hop evidence rule;
- the lifecycle remains no document -> `DESIGNED` -> `IN PROGRESS` -> `COMPLETE` internally;
- tasks never read one another's files;
- material deviations update the PRD/design and require new exact human approval when they exceed the envelope;
- every completed phase writes implementation notes;
- canonical bytes, pinned context, digests, replay protection, re-authentication, safe path handling, atomic replacement, and exact evidence bindings remain authoritative.

The coordinator must not commit until configured verification succeeds, review evidence is current, parent documents are synchronized, an implementation log exists, and the exact diff is proven task-scoped and inside the approved envelope. Scope uncertainty must escalate before staging or commit.

### R7. Rare, nonblocking escalation and one decision path

Escalation is permitted only when continuing requires authority or judgment the approved artifacts do not supply, including:

- a material requirements, architecture, phase-plan, safety-policy, or repository-scope change;
- constitution failure or uncertainty, or a waiver decision;
- an unresolved product tradeoff;
- an unapproved external, destructive, privileged, credential/secret, or security-sensitive effect;
- repository drift, unrelated changes, conflicts, or recovery ambiguity that prevents proof of safe commit scope;
- failure of review or verification to converge within the configured remediation budget;
- inconsistent durable authority requiring a choice among plausible histories.

Routine findings, repairable test failures, editorial corrections, evidence invalidation, parent-document updates, authorized scoped commits, and internal phase-step transitions remain inside the active phase-design or phase-implementation invocation. Starting the next top-level step is never treated as an internal transition.

Opening an escalation must durably record and immediately return or notify a human-readable presentation; it must not leave an MCP request blocked while another interface polls and writes a decision file. The presentation must explain what happened, why authority is insufficient, relevant evidence, available choices, and consequences while hiding mechanical bindings by default.

The client must resolve any workflow, waiver, or maintenance presentation using a server-issued choice binding, human reason, and only genuinely choice-specific rationale. The coordinator must re-authenticate the exact presentation and observations, protect against stale/replayed decisions, apply the chosen effect, and automatically resume the current step when authority is restored. No follow-up call is needed merely to resume that same step. Completion still stops at the next top-level boundary and waits for its human kickoff. A waiver request and its later grant or denial remain distinct human decisions because the latter supplies new authority.

### R8. Pause, cancel, update, and interruption behavior

Humans must be able to request pause or cancel through the semantic control plane.

- Pause takes effect at a defined safe durable boundary and leaves the active step resumable.
- Cancel stops without marking an unfinished step or phase complete.
- Cleanup that removes material work or evidence requires proportional explicit confirmation or remains a later administrative action.
- An interrupted phase step can be reissued or reattached without duplicating reviews, transitions, decisions, or commits.

If the installed or registered build changes during an active step, the coordinator may finish or safely terminate only its current bounded worker operation, must checkpoint, dispatch no new worker, release ownership, and return a restart-required blocked view. A compatible restarted process may acquire a new generation and resume the same step. Durable contract incompatibility must route to upgrade/migration diagnosis rather than being treated as ordinary build skew.

Existing valid durable tasks, including tasks stopped at current fine-grained checkpoints or an open legacy gate, must either reconcile into an equivalent semantic position and resume without duplicating effects or fail closed with an explicit upgrade/recovery path. Retiring the old public transport must not strand otherwise compatible canonical authority, but it does not require keeping the old tools as a callable compatibility facade.

The attached-call versus minimally supervised/background step transport must be selected from real-host evidence about the maximum expected duration of one phase-design or phase-implementation invocation, stdio EOF, interruption, reconnect, and concurrent pause/cancel. Whichever transport is selected must make reconnect idempotent and must not require polling for progress.

### R9. Repository/worktree fencing and worker ownership

One durable repository/worktree execution fence must serialize write-capable task execution across all tasks and host sessions sharing the worktree, Git index, and branch. A second writer must receive a semantic busy/blocked view rather than concurrent mutation. Read-only reviewers may continue concurrently against pinned views.

Each write-capable producer launch and returned result must be bound to the current fencing generation and a coordinator-supervised process identity. Ownership may be reclaimed only after the prior writer is proven exited or is terminated and the worktree is reconciled. Results from stale generations must not be admitted, staged, or committed. If an orphan may still be editing or partial edits cannot be attributed safely, recovery must fail closed and escalate before another producer starts.

Execution and repository-maintenance authority must have an explicit precedence and exclusion model so diagnostic repairs cannot race an active writer.

### R10. Mechanically enforced worker capabilities

Write-capable workers must receive a dispatcher-controlled capability profile derived from the approved envelope. Enforcement must deny before effect:

- filesystem access outside the authorized repository and task scope, including access to other tasks;
- direct Git index/ref writes, staging, or commits by workers;
- unapproved network or external actions;
- privilege escalation;
- destructive host operations.

Workers may inspect Git; coordinator-owned Git effects remain subject to the fence and commit requirements. Workers cannot grant themselves capabilities. A denied request must produce structured evidence that lets the coordinator prove it is already authorized or open the smallest necessary escalation.

Authenticated first-party model-provider transport is permitted infrastructure and must be distinguished from model-initiated arbitrary external access. If required enforcement is unavailable on a supported platform, the workflow must fail closed and explain the limitation.

### R11. Diagnosis and safe maintenance

Add one compact diagnostic MCP intent and a dedicated `$archflow-doctor` skill. Diagnosis must cover, as applicable, registration and launchability, loaded versus installed/registered build, durable compatibility, active or stale ownership, locks and receipts, resumability, Git scope and unrelated changes, and producer/reviewer dispatch health.

Diagnosis is observation-only with respect to task state, the worktree, and Git. It may append only a bounded repository-maintenance proposal or receipt independent of potentially malformed task state. A repair must be presented conversationally, approved through the common decision path, re-authenticated against exact observed bytes/build/fencing context, and applied only under the maintenance fence with stale and replay protection.

When MCP cannot start or lacks compatible diagnostics, the doctor's local fallback may inspect installation and registration and may repair only bootstrap configuration after explicit approval. It must not interpret or mutate task workflow state.

Normal workflow skills must relay a semantic blocked explanation and direct the user to `$archflow-doctor`; they must not embed diagnostic trees, CLI recipes, or repair mechanics.

### R12. Semantic legacy upgrade

Add a compact MCP upgrade intent that takes the legacy source and distinct target task identifier, performs read-only inspection, and returns a server-issued migration preview. Only an explicitly approved, replay-safe common maintenance decision may create the canonical target under the maintenance fence. Denial or cancellation must leave no partially canonical task.

`$archflow-upgrade` must become thin guidance over this semantic flow and must not retain a separate CLI mutation path.

### R13. CLI end state

Keep the installed local executable only for capabilities that must exist before or without compatible MCP diagnostics:

- installation, project-scoped registration, and repository initialization;
- build/version and launch diagnosis;
- task-state-read-only diagnosis when the server or compatible diagnostic tool is unavailable;
- explicitly approved repair of installation or registration needed to restore MCP.

No distributed CLI command may construct an MCP request, stage a live intent, write a workflow decision, mutate/reconcile/repair task state, run a stateful migration, create/restore workflow snapshots, advance a phase, or commit task work. Useful pure mechanics may remain internal services, and developer-only utilities may move to repository scripts rather than remain an agent-facing parallel workflow frontend.

### R14. Skill end state

The public skill set must:

- retain bootstrap, constitution, exploration, and read-only semantic status roles;
- keep PRD and task-design skills as thin conversational clients of their semantic MCP operations;
- keep `$archflow-phase-design` and `$archflow-phase-impl` as distinct public entry points that a human invokes for each numbered phase;
- make each phase skill a thin controller for one internally autonomous, coordinator-owned step rather than a protocol manual or outer-client work loop;
- keep upgrade as thin semantic migration guidance;
- add `$archflow-doctor` for exceptional health and recovery; no all-phases `$archflow-run` entry point is required.

Normal workflow skills must not teach low-level tool names, phase/step/status triples, revisions, fingerprints, digests, receipts, staged references, request construction, gate-opening mechanics, review-transition choreography, commit confirmation, locks, build identities, or `archflow-local` fallbacks. They may name the next human-started workflow step, but must never start it automatically. After initialization, normal workflow skills must invoke zero local workflow commands.

### R15. Maintained documentation and validation evidence

Implementation must update every affected caps-named maintained page in the same change. Because this refactor changes the public surface, lifecycle, trust model, dispatch, state, CLI, skills, contracts, testing, dependencies, and known limitations, the expected impact includes:

- `docs/OVERVIEW.md`, `COMPLEXITY.md`, `PATTERNS.md`, `DEPENDENCIES.md`, `TESTING.md`, and `LIMITATIONS.md`;
- `docs/workflow/LIFECYCLE.md` and `SKILLS.md`;
- `docs/mcp/SERVER.md` and `DISPATCH.md`;
- `docs/cli/COMMANDS.md`;
- `docs/review/COUNTER-REVIEW.md`;
- `docs/contracts/CONTRACTS.md`;
- `docs/state/DURABLE-STATE.md`.

The source audit under `docs/validation/` must remain recognizable as point-in-time evidence rather than being silently rewritten as maintained current-state documentation. New implementation evidence may be recorded separately or by an explicit status annotation that preserves the original claim.

## Delivery dependencies and required decisions

The implementation plan must respect these dependency gates:

1. Propose and explicitly approve the stage-scoped delegation policy before enabling automated checkpoints or commits inside phase implementation. Preserve fresh human kickoff at every top-level workflow boundary.
2. Run real-host spikes in both supported clients for the lifetime of one phase-design or phase-implementation call, stdio EOF, interruption/reconnect, concurrent pause/cancel, and whole-catalogue advertisement/tool selection. Use the evidence to choose the step transport and a measured complete-catalogue budget.
3. Define the common workflow view, semantic step-start intents, common decision binding, top-level ready boundaries, build/contract/process/fence identities, update policy, repository and maintenance fencing, worker capability profile, checkpoints, safe-stop semantics, and remediation budget.
4. Extract reusable semantic services from current request composition and state/review/gate kernels so the coordinator can call them without CLI or MCP self-round-trips.
5. Establish semantic diagnosis, upgrade, build-skew handling, maintenance decisions, and the read-only doctor fallback before removing the CLI mutation paths they replace.
6. Prove a fenced, resumable, capability-restricted coordinator through one complete phase-design step, including autonomous review/remediation and a durable stop for human approval and phase-implementation kickoff.
7. Make escalation opening nonblocking, unify decision resolution, and automatically resume after restored authority.
8. Implement the autonomous phase-implementation step through verification, review/remediation, scoped commit, and a durable stop before the next human-started phase.
9. Complete the PRD/design facade and phase-skill simplification, preserving the distinct public workflow steps without parallel mutation authority.
10. Retire the low-level advertised MCP and agent-facing CLI workflow surfaces after their semantic replacements are proven.

Design must resolve, using the required evidence where noted:

- attached versus minimally supervised/background execution for one active step and its reconnect/notification semantics;
- the numeric whole-catalogue budget and first-call-selection evidence in both hosts;
- the exact workflow-view and opaque decision-binding schemas;
- remediation-budget source, counting, reset, and escalation behavior;
- safe boundaries for pause, cancel, build update, and worker permission requests;
- repository/maintenance fence format, acquisition, generation, liveness, and recovery;
- the worker containment mechanism, supported platforms, provider-access distinction, and fail-closed behavior;
- producer routing and authentication while preserving opposite-family review independence;
- coordinator-authorized commit scope, target refs, messages, and parent-document inclusion;
- pre-design exact-byte artifact exchange;
- maintenance proposal/receipt storage and cleanup independent of malformed task state;
- cancellation cleanup semantics;
- direct replacement unless a demonstrated current-user requirement justifies compatibility machinery.

## Verification requirements

Acceptance evidence must include:

- contract and generated-schema tests for the semantic MCP inputs, common workflow view, nested variants, purpose descriptions, plain-object roots, forbidden internal schema reachability, stale/replayed decision bindings, and exact public state vocabulary;
- a measured whole-catalogue budget and correct first-call selection in Claude Code and Codex without old protocol instructions;
- a semantic PRD/design journey through exact approvals, scoped commit observation, and a `ready` hand-off that names but does not start the next step;
- a multi-phase journey proving that each PRD, design, phase-design, and phase-implementation boundary requires a fresh human kickoff and that no successor starts automatically;
- one phase-design invocation that performs routine production, review, triage, and remediation without client scheduling, then returns `awaiting-approval`; approval changes the view to `ready` without starting phase implementation;
- one phase-implementation invocation that performs routine implementation, verification, review, remediation, documentation/log synchronization, and authorized scoped commit without client scheduling, then stops before the next phase;
- each escalation category, proving immediate presentation, one decision, and automatic resume of the current step without starting its successor;
- pause/resume, cancel without false completion, active-step interruption, idempotent reissue/reattach, and no duplicated review/transition/decision/commit;
- two tasks and two host sessions competing for the repository fence;
- build update at a bounded operation, compatible restart/resume, and incompatible-state upgrade diagnosis;
- orphan-producer termination/recovery, stale-result rejection, and fail-closed ambiguous edits;
- malformed-task diagnosis and replay-safe maintenance repair independent of that task state;
- semantic legacy preview, denial/cancellation with no partial task, approval, and replay rejection;
- adversarial worker attempts at out-of-scope/cross-task filesystem access, Git mutation, arbitrary network/external actions, privilege escalation, destructive operations, and result publication after cancellation/fence loss, all denied before effect;
- crash/fault tests around fence ownership, checkpoints, worker launch/admission, decisions, exact commit creation/observation, and completion;
- preservation of review independence, evidence freshness, task isolation, canonical/digest/replay integrity, safe Git scope, parent-document synchronization, implementation logs, secret rejection, and transaction recovery;
- the normal typecheck, generated-schema drift, unit, integration, contract, bundle, SDK-boundary, notice, and release integrity/reproducibility gates.

Real-host suites are currently opt-in rather than part of `npm run check`; the implementation plan must define the exact runs and durable evidence required for the transport and catalogue decisions. Tests that exist solely to enforce outer-client low-level choreography or repeated mid-step commit confirmations may be replaced only after policy approval. Tests proving human initiation of each top-level step and exact phase-design approval remain required, and every removed check must be replaced with bounded-delegation and fail-closed-escalation coverage.

## Success criteria

The refactor is complete when all of the following are observable:

1. Humans explicitly start PRD, design, every numbered phase-design step, and every numbered phase-implementation step; completion of one step never starts its successor.
2. A routine phase-design invocation runs its internal production/review/remediation loop without client scheduling, returns `awaiting-approval` for mandatory approval of the exact bytes, and becomes `ready` only after approval without starting phase implementation.
3. A routine phase-implementation invocation runs implementation, verification, review/remediation, documentation/log work, and authorized scoped commit without client scheduling, then stops before the next phase kickoff.
4. All workflow work and exact human decisions use only the semantic MCP facade; upgrade has no low-level or CLI mutation dependency.
5. Status is optional observation and a `running` view means the currently invoked step progresses independently.
6. One compatible, durably fenced coordinator performs all authoritative task/worktree/Git mutations inside an active step, and compatible restart reconstructs that step solely from canonical records.
7. Competing writers, stale generations, surviving or ambiguous orphan writers, unprovable diffs, unauthorized worker effects, and incompatible builds fail closed before further mutation.
8. Worker capability tests prove denial before effect, while authorized producer and reviewer flows remain functional and independent.
9. Escalations are rare, durable, conversational, nonblocking, and resolved through one re-authenticated decision that resumes the current step automatically when safe.
10. Pause, cancel, interruption, and build updates stop at defined durable boundaries without false completion or duplicated effects.
11. No normal skill contains the old protocol vocabulary or invokes a local workflow command after initialization; phase-design and phase-implementation remain public human entry points, and `$archflow-doctor` owns exceptional diagnosis.
12. No installed CLI command or old advertised MCP tool remains as a parallel workflow mutator once its semantic replacement is accepted.
13. The complete advertised catalogue meets the evidence-based budget and selects the correct first tool in both supported hosts.
14. Maintained documentation, schemas, release surfaces, and representative local/real-host verification all describe and prove the same implemented boundary.

## Assumptions

- The user's clarification supersedes the audit wherever the audit proposes one autonomous post-design run or retirement of public phase skills. This task retains the full coherent API refactor—semantic PRD/design/phase operations, diagnosis, upgrade, CLI reduction, skills, documentation, and verification—but preserves human kickoff of every top-level step.
- The prototype will use one repository/worktree writer fence rather than per-task worktrees.
- Direct replacement is preferred; no compatibility layer is required unless a concrete current user need is established during design.
- The selected active-step transport and numeric catalogue budget are intentionally unknown until the required real-host spike produces evidence.
- The exact containment implementation is a design decision, but prompt-only restrictions, environment scrubbing, or output scanning alone do not meet the deny-before-effect requirement.
- Authenticated model-provider transport needed to run an approved worker is allowed infrastructure; arbitrary model-initiated external access is not.
- Existing low-level handlers and request-derivation logic may be retained as internal services where that is the simplest maintainable path.
- Existing policy remains in force throughout development until an exact approved revision changes it; no PRD approval alone authorizes bypassing current gates.
- "Almost entirely automated" means routine work within the currently invoked phase-design or phase-implementation step proceeds without client scheduling. Exact artifact approval, new authority, unresolved product judgment, safety ambiguity, and inability to converge remain legitimate human boundaries.

## Risks

- A policy change that is vague or implemented early could silently weaken explicit human authority.
- Host lifetime or concurrency behavior may make an attached long-running phase step unreliable and force a small durable supervisor.
- Repository fencing and coordinator-owned Git increase the consequence of ownership, liveness, or scope-classification bugs.
- The current best-effort dispatch model may not provide enforceable filesystem, Git, network, privilege, and destructive-operation boundaries on every supported platform.
- Orphaned writers and ambiguous partial edits may require human recovery more often than the happy-path autonomy suggests.
- Autonomous remediation can reuse stale evidence or drift outside the design unless materiality classification is conservative and enforced.
- Diagnostics independent of malformed task state could become a second unsafe authority store unless proposals are bounded, re-authenticated, fenced, and replay-safe.
- An incomplete transition could preserve the very CLI/MCP version-skew and dual-authority risk the refactor is intended to remove.
- Adding semantic, diagnostic, and upgrade tools without removing internal schemas may retain the current catalogue cost and poor host selection.
- An undefined remediation budget can either recreate routine human gates or permit unbounded autonomous loops.
- The work spans contracts, generated schemas, state, dispatch, Git, runtime, CLI, skills, installation assets, documentation, and every test layer; sequencing errors could strand users between old and new surfaces.
- An over-eager coordinator could cross a completed-step boundary and erase the human's intended control of workflow sequencing; durable `ready` stops and negative tests must make that impossible.
