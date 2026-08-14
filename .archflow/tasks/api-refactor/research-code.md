# API refactor: current-code research

## Scope and baseline

- Repository HEAD is exactly the requested baseline, `8dad5260e31368b45da85bad748704d9a80b9df3` (`main`, also `origin/main`).
- `docs/validation/client-interface-audit.md` is stamped at earlier commit `6637099` and explicitly says its recommendation is not implemented. The diff from that audit commit to the requested baseline adds the audit and strengthens document-artifact/output binding, snapshot, and related status behavior. It does not introduce the proposed semantic MCP tools, autonomous coordinator, repository execution fence, or reduced CLI.
- This note traces repository code and maintained documentation only. No existing `.archflow/tasks` content was read.

## Bottom line

The audit accurately describes the current baseline. ArchFlow has a strong durable transaction kernel, but its public interface still makes the outer model client the workflow coordinator. The server exposes four low-level mutation tools; status is a local CLI operation; request derivation and staging are local CLI operations; human decisions are written by the CLI into a filesystem side channel while an MCP call blocks; the phase skills choose and sequence transitions; and the client performs Git commits. The only model work dispatched by the server is independent review/adjudication, not production or implementation.

The proposed follow-up is consequently a behavioral and trust-boundary change, not a naming cleanup. It affects:

- the advertised MCP contract and all generated/public contract artifacts;
- the locus of workflow scheduling, human decisions, Git effects, and recovery;
- the dispatch boundary for write-capable workers;
- durable ownership/fencing and version coherence;
- the repository constitution's current explicit-human-approval rules;
- the public skill set and almost every normal journey test.

The present code contains reusable integrity mechanisms—canonical JSON, request digests, revision CAS, replay correlation, task transactions, pinned evidence, repository observations, safe Git-scope checks, review dispatch, retained artifacts, and status reconciliation—but no semantic run abstraction or durable coordinator ownership.

## Current public/client-facing surface

### Advertised MCP tools

`src/contracts/tool-names.ts` defines and freezes exactly four tool names:

1. `archflow_state`
2. `archflow_counter_review`
3. `archflow_gate`
4. `archflow_waiver`

`src/contracts/mcp-tools.ts` defines the public inputs and successes. Every full request carries `schema_version`, `task_id`, `intent_id`, `expected_revision`, and `input_fingerprint`. Every tool also accepts a staged-reference form carrying `schema_version`, `task_id`, `intent_id`, and `request_digest`.

The operation-specific public fields remain kernel-level:

- `archflow_state`: caller-selected `phase_instance`, `step`, and `status`, plus an optional artifact/human revision.
- `archflow_counter_review`: `artifact_path` (normally derived by `build-request`).
- `archflow_gate`: phase, human summary, gate kind/context, subject digest, and current evidence.
- `archflow_waiver`: a caller-reconstructed origin containing gate, decision, context, subject, evidence, rule, and scope bindings.

`src/mcp/tools.ts` publishes `AdvertisedToolDescriptor` as only `name`, `inputSchema`, and `outputSchema`; there is no purpose-level tool description field. The input advertisement merges full-payload and staged-reference properties into a plain object root because at least one supported host loses root-level combinators. Strict runtime validation remains authoritative. The advertised description tells the model how to use `archflow-local build-request` and a staged reference, so the MCP catalogue itself embeds the current two-transport choreography.

The four success payloads are operation-specific low-level results (paths, revisions, state/review/gate details, and request digest), not a shared semantic workflow projection. `src/mcp/sdk-adapter.ts` returns the handler's result directly. A caller therefore has to read status after mutation to discover what the workflow means now.

There is no current `archflow_status`, `archflow_start`, `archflow_submit`, `archflow_run`, `archflow_decide`, `archflow_control`, `archflow_diagnose`, common `WorkflowView`, or semantic server-issued decision binding.

### Local CLI

`src/local/commands.ts` advertises 14 flat commands:

`validate`, `hash`, `render`, `snapshot`, `restore`, `clean`, `decide`, `status`, `reconcile`, `init`, `envelope`, `build-request`, `manual-status`, and `upgrade`.

Important current roles are:

- `status` computes the reconciled task view and exact next transition.
- `build-request` derives, authenticates, and usually stages the next low-level MCP request.
- `envelope` resolves a hand-authored complete request when the composer has no semantic kind.
- `decide` writes the live human choice which an already-open gate request is polling.
- `manual-status` is a second status/classification route when MCP is unavailable.
- `init` changes repository/bootstrap assets and host registrations.
- `upgrade` previews, stages, or discards a legacy adoption.
- snapshot/cleanup/debug commands expose retained-result and contract mechanics in the same installed executable.

The code is slightly more nuanced than the audit's broad CLI category labels: `restore` reads cached snapshot bytes and `reconcile` computes a projection from supplied authority rather than directly replacing durable task state. They are nevertheless part of the supported agent-facing workflow/maintenance protocol. `build-request` writes staged intent files and has a special initialization path that creates the task scaffold before canonical state exists; `decide` writes the side-channel decision; `upgrade` can stage/discard migration state; and `clean`/`snapshot` change runtime-maintenance material.

`src/local/build-request.ts` recognizes seven kinds: `initialize`, `produce`, `running`, `triage`, `counter-review`, `gate`, and `advance`. It correctly derives mechanical facts from durable status, but the caller still selects which semantic transition to compose. There is no composer kind for waiver or a general failed result. Initialization is the only kind without a staged reference. Attempts-exhausted and some exceptional paths fall back to status request templates plus `envelope`.

### Skills are the workflow controller and protocol manual

The repository has the nine current public skills only: init, constitution, upgrade, explore, PRD, design, phase-design, phase-impl, and status. There is no run or doctor skill.

`skills/archflow-prd/SKILL.md`, `skills/archflow-design/SKILL.md`, `skills/archflow-phase-design/SKILL.md`, and `skills/archflow-phase-impl/SKILL.md` teach the status/build-request/staged-reference/MCP loop in detail. They explain which running marker to enter, which terminal result to record, when to call counter-review, how to compose triage, how to open a blocking gate, how to record a CLI decision, and when to advance.

`skills/archflow-phase-impl/SKILL.md` explicitly says the current session is both producer and workflow orchestrator. It instructs that session to edit the repository, run verification and same-side review, call the server's opposite-family review, author triage dispositions, update parent documents and implementation notes, ask for commit authorization, stage the declared outputs, ask again for explicit commit confirmation, run Git, then tell the server to observe and advance. This is direct evidence that the current MCP server is not the post-design runner.

## Current behavior by audit finding

| Audit finding/target | Verifiable baseline behavior | Concrete mismatch |
|---|---|---|
| One semantic workflow surface | Four kernel tools, 17 `NextActionCode` values, seven composer kinds, and 14 CLI commands are connected by skill prose and request templates. | The client translates among five representations of one action instead of expressing one intent. |
| Common semantic status/result | `src/state/status.ts` returns a rich low-level `TaskStatusV1` with phase/step state, resources, review policy, gates, evidence, reconciliation, request templates, and `next_action`; the brief projection removes templates/guidance but still reports a transition code. Mutation successes are different per tool. | There is no common `ready/running/escalated/paused/canceled/blocked/complete` view, and status reads are required to know what follows a write. |
| Optional observation | Normal skills run status before and after nearly every operation. | Status is the scheduler input for the client, not optional observation. |
| Server owns deterministic transitions | `archflow_state` accepts client-selected phase/step/status. `build-request` refuses illegal choices but does not choose the workflow loop for the caller. | Legality is server-checked, but scheduling remains client-owned. |
| Automatic review is internal | `src/mcp/handlers/counter-review.ts` already selects the canonical rubric, assembles pinned read-only views, dispatches opposite-family rubric and applicable constitution reviews, and installs both terminal results atomically. | A separate caller-authored `counter_review/running` transition and later client sequencing are still required. |
| Nonblocking human escalation | `src/state/gates.ts` opens a durable gate and then waits; `src/state/gate-wait.ts` polls `gate.decision` every 500 ms until another process writes it or the call is aborted. | Gate opening and decision resolution are one blocked MCP request plus a CLI/filesystem side channel. |
| Human supplies only judgment | `src/state/gate-decision-interface.ts` already renders conversational title/summary/details/question/options and accepts a short choice plus reason/choice-specific rationale. | The supported resolver is `archflow-local decide`, not MCP, and the original MCP call must remain outstanding. |
| Waiver bindings are server-owned | `src/mcp/handlers/waiver.ts` reopens the archived origin request and decision and verifies every caller-supplied gate/digest/rule/scope field. | The public tool requires redundant mechanical bindings the server already possesses and re-authenticates. |
| One autonomous post-design run | No durable run entity, run state, run checkpoint, pause state, cancel state, or run-completion report exists. The state graph tracks task phases and fine-grained pipeline transitions. | There is nothing that can start/attach/resume across all phases without the outer skill continuing to drive it. |
| Server owns phase production/implementation | `src/dispatch` supports counter-review and constitution/adjudication children. Producers are the outer skill/session. | No private producer/verifier protocol or write-capable server-dispatched implementation worker exists. |
| Server owns triage/remediation | The outer skill authors every finding disposition. `build-request` binds and validates exact coverage; the state kernel records it. | The server has no autonomous materiality/triage/remediation loop. |
| Server owns scoped commits | Current status derives an exact commit action, baseline/ref/message/scope and later observes Git. The phase skill executes `git add`/`git commit` after separate authorization and confirmation. | The coordinator does not stage or commit; current policy intentionally leaves that action with the user-facing session. |
| Exclusive live mutation gateway | `src/state/lock.ts` provides a filesystem-backed task lock used around individual state transactions. `src/dispatch/cli.ts` has a module-level FIFO for child reviews in one server process. | Neither is a durable repository/worktree execution fence. Separate tasks share a worktree/Git index, separate MCP processes do not share the review FIFO, and the lock does not cover a whole worker/run. |
| Restartable coordinator ownership | Durable state, last-transition correlation, retained evidence, staged-request validation, and reconciliation support transaction recovery. | No durable coordinator owner, fencing generation, supervised worker identity, stale-worker rejection, or orphan-writer recovery is recorded. |
| Pause/cancel control | The MCP runtime propagates per-request cancellation through an `AbortSignal`; gate waits and dispatched child process groups can stop. | Request cancellation is ephemeral transport lifecycle, not a durable pause/cancel intent with a safe-boundary result that another session can observe/resume. |
| Loaded/installed build coherence | MCP is a long-lived stdio process; every local CLI call loads the currently installed bundle. Server metadata is fixed to `{name: "archflow-mcp", version: "0.0.0"}`. The built distribution manifest contains bundle/executable hashes, but runtime workflow/status does not compare them. Registration launches `archflow-mcp` from the environment. | An updated CLI can compose or write around an older loaded server; request digests bind bytes, not agreement about their semantics. No semantic restart-required view or active-build ownership exists. |
| Diagnostics are separate and compact | `src/init/diagnostics.ts` checks installation/registration, CLI versions/auth, runtime ignore rules, and dispatch limitations. `manual-status` classifies normal/degraded/repair-required/upgrade conditions. | There is no MCP diagnostic tool, no loaded-vs-installed coordinator diagnosis, no active-run/fence diagnosis, and no maintenance decision domain independent of task state. Diagnostic protocol is spread through normal skills/CLI. |
| Upgrade is semantic MCP maintenance | `src/init/legacy-upgrade.ts` and the upgrade skill use the local executable to preview/stage/discard; state initialization adopts a stage later. | Stateful migration remains split across CLI and MCP and has no common server-issued decision/resolver path. |
| Small, self-describing catalogue | The audit measured the four-tool catalogue at about 105 KB. `test/contracts/mcp-advertised-schema.test.ts` enforces a 130,000-byte fence and the plain-object-root workaround. Descriptors lack purpose text and include deep internal schemas. | Tool selection depends heavily on skill protocol prose; adding tools naively would enlarge an already substantial catalogue. |

## Concrete current journey

`test/integration/status-request-roundtrip.test.ts` is the clearest executable specification of the present contract. Its document-phase helper performs:

1. compose/call `produce/succeeded`;
2. compose/call `counter_review/running`;
3. compose/call `archflow_counter_review` (which records success itself);
4. compose/call `triage/running`;
5. compose/call `triage/succeeded`;
6. start `archflow_gate` as a pending promise, poll status until its presentation exists, call the local decision writer, and await the pending request;
7. compose/call the phase advance.

The same integration suite performs `git add` and `git commit` outside the server after status reports approval, then asks status/server to observe the commit and advance. This test behavior is not incidental scaffolding; it follows the skill contract and is the current client API.

Thus the audit's approximately 22–23 interactions for a no-rework document phase remains representative: seven request compositions, seven MCP calls, a CLI decision, and repeated status reads, before additional Git work.

## Durable kernel and trust mechanisms that currently carry authority

The refactor cannot treat the existing low-level payloads as mere verbosity. They front real integrity properties that will still need an internal owner if removed from public inputs:

- `src/local/call-envelope.ts`, `src/state/staged-requests.ts`, and `src/mcp/server.ts` materialize and validate a request, bind it to task/intent/digest, rehydrate staged bytes through the same strict parser, and fail closed on any mismatch.
- `expected_revision` provides compare-and-swap behavior; intent and last-transition records distinguish replay/resume from conflicting reuse.
- canonical JSON and request/result digests bind exact semantics, while `input_fingerprint` binds the relevant current authority.
- state transitions run through task-scoped transactions and atomic replacement under the task lock.
- status reconciles durable workflow state with repository/config/artifact/evidence observations instead of trusting a caller's claimed next action.
- counter-review selects server-owned rubric/configuration and retains server-attested results against an exact subject and pinned repository view.
- implementation outputs bind the base commit, exact retained after-images/absences, verification-transcript digest, parent documents, and declared outputs; Git observation checks the authorized target and committed tree.
- human gate presentations are disposable projections reconstructed from durable gate request/decision archives; losing the presentation does not erase authority.
- task isolation, evidence freshness, significant-revision invalidation, constitution review, implementation logs, and parent-document synchronization are explicit state/skill invariants.

A semantic API can hide request digests, revisions, phase triples, gate IDs, and staged references from the model client, but a requirement must identify which internal authority still derives and verifies each of them. Public-call atomicity cannot mean collapsing all intermediate persistence into one filesystem transaction: those checkpoints are the current basis for replay and recovery.

## Trust-boundary implications

### 1. The requested autonomous policy conflicts with active repository policy

The repository's current hard rules are explicit in `AGENTS.md` and `assets/constitution/00-process.md`:

- never pass a review gate or commit without explicit human approval;
- never write code before phase-design approval;
- automatic opposite-client review precedes the human gate;
- significant human revisions require a fresh automatic review cycle;
- implementation commit authorization and the later commit confirmation are separate.

`assets/constitution/10-architecture.md`, `20-data.md`, and `30-product.md` further require implementation to follow an approved phase design, parent-document synchronization, task/evidence isolation, exact subject bytes, and visible safe failure.

The audit deliberately proposes replacing repeated post-design human authority with bounded prior authorization from exact task-design approval. Nothing in the baseline grants that authority. A PRD that requires a zero-prompt autonomous run must make the governing policy decision an explicit prerequisite/dependency; implementing it under unchanged rules would be a trust-boundary violation, not backward-compatible behavior.

The invariants the audit says remain are already backed by code and policy: independent review, stale-evidence invalidation, reviewed phase designs, fixed-point verification/review, task isolation, parent synchronization, implementation logs, conversational human escalation, and explicit waivers. The changed item is who may close checkpoints and create commits inside the approved envelope.

### 2. Current reviewer isolation is not a sufficient producer sandbox

`src/dispatch/workspace.ts` and `docs/mcp/DISPATCH.md` explicitly call the present boundary “best-effort,” not enforced isolation. A review child gets a disposable pinned repository view; the real repository path is omitted from its environment/prompt, and task workflow files are removed. Claude is launched with read/grep/glob-only tooling; Codex uses a read-only sandbox with many features disabled. Authentication remains in the user's canonical CLI home, and there is no filesystem-level prevention of reading outside the disposable view.

These controls are appropriate to read-only independent review but do not satisfy the audit's proposed write-worker guarantees. There is no present capability type/profile for authorized filesystem writes, Git-index/ref denial, network/external-effect denial, privilege/destructive denial, or a structured capability-request result. Extending dispatch to production changes the consequence of a containment failure from information exposure to repository/host mutation, so the PRD must state the enforcement outcome rather than relying on prompt instructions.

### 3. Task locks do not protect the shared worktree

Each production-service instance creates a `TaskLock` at the task's ignored `transient/.transaction-lock`. The directory lock gives cross-process mutual exclusion for that task's atomic transaction and has explicit repair behavior. It does not serialize two tasks editing the same checkout, does not fence Git, and is released between transitions. The review dispatch FIFO serializes only children in one Node process and is documented not to coordinate multiple MCP servers or interactive clients.

Any requirement allowing the coordinator to dispatch writers and commit must account for the repository/worktree as shared authority. Otherwise two individually valid task owners can edit/stage/commit the same checkout concurrently.

### 4. Process cancellation is not ownership recovery

`src/dispatch/process.ts` has bounded child execution, process-group termination, escalation to SIGKILL, output caps, and abort handling. These are useful process primitives. They do not persist a writer identity or fencing generation, prove a previous process exited across coordinator restart, classify unattributed partial worktree edits, or prevent a late result from an old generation from being admitted. The baseline's transaction replay safety alone cannot solve an orphan that may still be changing repository bytes.

### 5. Coordinator-owned Git changes the current human boundary

The code already computes exact artifact/diff/target bindings and refuses unsafe observations, but the final stage/commit action occurs in the outer interactive session after explicit authorization and confirmation. Moving it into an autonomous run requires preserving at least the current scope proof, target-ref/baseline checks, exact staged-diff inspection, committed-tree observation, unrelated-change handling, and fail-closed behavior under drift. It also requires the approved delegation envelope to grant this effect; it cannot be inferred merely because the task reached implementation.

## Compatibility and evolution constraints

### Contract shape and generated artifacts

- The MCP contract source is Zod/TypeScript in `src/contracts`; `src/contracts/index.ts` exports many tool and durable types, so the refactor changes compile-time public surface as well as runtime handlers.
- JSON Schemas under `src/contracts/schemas/v1` and contract-agreement/schema-generation tests must remain synchronized with the TypeScript validators.
- Advertised tool inputs must retain a plain object root. Root-level `oneOf`, `allOf`, or `$ref` is forbidden by repository convention because a real host flattened it into a zero-field schema. Variant combinators can remain below the root.
- Caller-owned objects are validated/materialized once before repeated inspection; persisted reachable shapes are type aliases, not interfaces; descriptor reads require enumerable data properties. These repository conventions protect digest/schema integrity and still apply to new semantic bindings/views.
- Tool output/error projections are intentionally pruned for host portability and catalogue size. A common view should not accidentally re-advertise the full durable-state/review/gate graph through every tool.

### Durable-data and in-flight compatibility

The baseline has schema version `1` across durable state, intents, evidence, and tool contracts. The audit recommends a direct public replacement for this prototype, but durable records and an in-flight loaded server are separate compatibility questions. Requirements need an explicit outcome for:

- existing valid v1 tasks at each fine-grained checkpoint;
- a request staged by old CLI code but encountered after replacement;
- an old coordinator process remaining connected after installation changes;
- partially open blocking gates/decision projections;
- upgrade-required versus restart-required states;
- replayed public intents after transport interruption.

A compatibility layer for old public tools is not automatically required; the repository priorities favor direct/simple replacement. However, “removed from advertisement” and “old durable task can be reconciled/resumed safely” are different decisions and should not be conflated.

### Runtime and host constraints

- The MCP server is stdio and long-lived per host session. `src/mcp/sdk-adapter.ts` captures connection/client identity once and creates handlers once.
- Installed host registration configures long tool timeouts, and current review dispatch allows up to fifteen minutes. Existing tests prove request cancellation and process-group cleanup at the adapter/process level, not a multi-phase run surviving host teardown.
- Server metadata reports version `0.0.0`; there is no loaded bundle digest or compatibility identity in normal status/result.
- The distribution has separate `archflow-mcp` and `archflow-local` bundles plus a manifest, so loaded-vs-installed identity is observable in principle but unused by workflow authority today.
- The audit correctly leaves attached-long-call versus durable background runner unresolved pending real-host evidence. Product requirements should specify observable guarantees—forward progress without polling, safe reissue, pause/cancel behavior, EOF/interruption recovery—without assuming a transport mechanism before the requested spike.

### Catalogue and discoverability constraints

`test/contracts/mcp-advertised-schema.test.ts` verifies exact advertised names, strict/host-portable schemas, plain object roots, output agreement, and a whole-catalogue byte fence. All of those tests currently pin the four low-level tools and will need intentional replacement. The audit's target has eight semantic tools when pre-design, post-design, diagnosis, and upgrade are counted (`start`, `submit`, `status`, `run`, `decide`, `control`, `diagnose`, `upgrade`), not merely four renamed tools. To satisfy the audit, the PRD scope cannot silently defer pre-design or migration and still claim the normal low-level surface is retired.

Every proposed descriptor needs purpose text and enough result semantics for first-call selection, while excluding internal state/review/gate schemas. Real-host catalogue/tool-selection measurement is an acceptance dependency because schema byte size alone does not establish correct model selection.

## Likely code and test impact surface

This is an impact map, not a prescribed architecture.

### Core contracts and advertisement

- `src/contracts/tool-names.ts`
- `src/contracts/mcp-tools.ts`
- `src/contracts/errors.ts`
- `src/contracts/durable-intent.ts`
- `src/contracts/durable-state.ts`
- `src/contracts/index.ts`
- `src/contracts/schemas/v1/**`
- `src/mcp/tools.ts`
- `src/mcp/sdk-adapter.ts`
- `src/mcp/server.ts`
- `src/mcp/handlers/index.ts`

### Existing reusable workflow kernels

- `src/local/build-request.ts` (derivation/composition logic currently coupled to CLI/status)
- `src/local/call-envelope.ts`
- `src/state/staged-requests.ts`
- `src/mcp/handlers/state.ts` and `state-results.ts`
- `src/mcp/handlers/counter-review.ts`
- `src/mcp/handlers/gate.ts`
- `src/mcp/handlers/waiver.ts`
- `src/state/status.ts`, `next-action.ts`, and `request-templates.ts`
- `src/state/gates.ts`, `gate-wait.ts`, and `gate-decision-interface.ts`
- transaction/lock/production/reconciliation modules under `src/state`
- repository/Git and implementation-manifest observation modules

### New behavior touches current missing boundaries

- `src/dispatch/**` for producer/verifier execution and enforced capability results;
- repository-wide durable ownership/fencing and maintenance authority (no current equivalent);
- durable semantic run/control/checkpoint and completion projection (no current equivalent);
- loaded-build/contract/process/fencing identity and update handling;
- nonblocking common decision creation/resolution;
- diagnostic and legacy-upgrade semantic paths independent of malformed task state;
- coordinator-owned scoped Git effects.

### CLI, distribution, and skills

- `src/local/commands.ts`, `src/local/main.ts`, init/diagnostic/legacy-upgrade code, CLI docs, shims, and built bundles;
- all task workflow skills, with phase-design/phase-impl retirement as public entry points and new run/doctor skills;
- `install.sh`, generated `dist/**`, and manifest/registration diagnostics if executable identity becomes part of coherence.

### Tests currently coupled to the old contract

- tool-name, MCP input/output, schema agreement, advertised-catalogue, staged-request, envelope, and error-projection contract tests;
- request-template/build-request/status-next-action unit tests;
- `test/integration/status-request-roundtrip.test.ts` and fixed-point/live review journeys;
- SDK adapter lifecycle/cancellation tests;
- dispatch workspace/CLI/process tests;
- Git observation, task-lock, replay, state-transaction, evidence freshness, task isolation, snapshot/recovery, and implementation-manifest tests;
- real-host validation journeys and catalogue discovery evidence.

The integrity tests in the last group are not obsolete merely because their public driver changes. Tests whose only assertion is repeated human gate/commit confirmation will conflict with the new approved-delegation policy; tests for exact authority, review independence, scope, replay, and recovery remain load-bearing.

### Maintained documentation

Repository instructions require caps-named maintained docs to change with behavior. At minimum this refactor affects `docs/OVERVIEW.md`, `COMPLEXITY.md`, `PATTERNS.md`, `DEPENDENCIES.md`, `TESTING.md`, `LIMITATIONS.md`, `workflow/LIFECYCLE.md`, `workflow/SKILLS.md`, `mcp/SERVER.md`, `mcp/DISPATCH.md`, `cli/COMMANDS.md`, `review/COUNTER-REVIEW.md`, `contracts/CONTRACTS.md`, and `state/DURABLE-STATE.md`, plus new point-in-time validation evidence.

## Requirements questions the PRD must settle

These are product-boundary decisions exposed by the code, not detailed design recommendations:

1. **Policy authorization:** Is the repository constitution being deliberately changed so exact task-design approval grants autonomous phase-design acceptance, implementation, and scoped commits? Until separately approved, the old gates remain mandatory.
2. **Scope completeness:** Does this task include all eight audit-level semantic intents (pre-design, run control, diagnostics, and migration), skill changes, and retirement of the old advertised/CLI surface, or only a subset? The audit's acceptance criteria require the full set.
3. **Delegation envelope:** What repository/task paths, local commands, Git effects, external/network effects, credentials, destructive operations, and privilege boundaries are authorized by design approval? Which events always escalate?
4. **Worker enforcement:** What observable guarantees constitute mechanical denial for out-of-scope writes, Git mutation, network/external effects, privilege escalation, and destructive actions? Current dispatch is explicitly best-effort/read-only only.
5. **Run semantics:** What durable states and checkpoints distinguish ready, running, escalated, paused, canceled, blocked, and complete? At what safe boundaries must pause/cancel take effect, and what evidence survives cancellation?
6. **Concurrency/ownership:** What is the repository/worktree unit of exclusivity, how is ownership presented, and what must happen when another task/session competes or a prior writer may still be alive?
7. **Recovery:** What must be idempotent after MCP disconnect, server restart, lost in-memory session, worker crash, ambiguous partial edits, open old-style gate, and late stale worker result?
8. **Version/update behavior:** Which identities are exposed/compared (loaded build, durable contract, process, fence generation), and when does the system return restart-required versus upgrade-required? What happens to an in-flight bounded operation after installation changes?
9. **Human decisions:** Which choices are genuine new authority, what minimal choice/reason/rationale crosses the public boundary, and which successful decisions automatically resume work? Waiver and maintenance decisions must remain explicit and replay/staleness safe.
10. **Commit authority:** Which exact commits may the runner create under prior approval, what scope proof is required, and which Git drift/unrelated-change conditions force escalation before staging or committing?
11. **Transport guarantees:** What real-host evidence is required for long run calls, EOF, reconnect, progress, pause/cancel during activity, and catalogue selection? Status polling cannot be required for forward progress.
12. **Compatibility posture:** Are old public tools removed immediately, hidden but temporarily callable, or rejected with a semantic upgrade result? Separately, which existing v1 durable checkpoints must resume under the new implementation?
13. **Diagnostic boundary:** What may diagnosis observe or append, what bootstrap repair remains local, and how can maintenance decisions stay authoritative if task state is malformed? Normal skills must not regain the old diagnostic protocol by prose.
14. **Completion:** What exact evidence appears in the final report (phases, reviews, verification, deviations, logs, commits), and what conditions prohibit `complete`?

## PRD-relevant acceptance implications grounded in current code

- A successful happy-path test must demonstrate one post-design public run intent with no status-driven scheduling, per-phase calls, CLI decision writes, Git commands by the outer client, or human prompts.
- A mutation/result contract should always return or make observable the same semantic workflow view; per-tool low-level success alone would preserve the mandatory status round-trip.
- Opening an escalation must durably return a presentation without retaining a background MCP request that waits for `gate.decision`.
- Resolving a workflow decision must derive live bindings server-side and resume when authority is restored; requiring a later gate/advance/run call would preserve the old protocol leak.
- Two task IDs and two MCP host sessions must be exercised against the same checkout, because current task locking/process FIFO do not establish repository exclusivity.
- Recovery tests need a write-capable worker killed or orphaned across coordinator replacement; current child cancellation tests alone do not prove stale-result/worktree safety.
- Worker adversarial tests must verify effects are denied before they occur, not only omitted from prompts or later detected.
- Upgrade and diagnosis must be tested when ordinary task state is missing, malformed, stale, or written by an incompatible version, because their authority cannot depend solely on a healthy task projection.
- Existing exact-byte/digest/replay/revision/evidence/Git-scope tests should continue to pass at the internal boundary even when the model never sees those fields.
- The whole advertised catalogue must be measured and selected correctly in both supported real hosts. The present plain-object-root host workaround is a hard compatibility constraint.

## Concise evidence index

- Audit and intended target: `docs/validation/client-interface-audit.md`
- Tool names/contracts: `src/contracts/tool-names.ts`, `src/contracts/mcp-tools.ts`
- Advertisement/SDK behavior: `src/mcp/tools.ts`, `src/mcp/sdk-adapter.ts`, `src/mcp/server.ts`
- Handler registry and kernels: `src/mcp/handlers/index.ts`, `state.ts`, `counter-review.ts`, `gate.ts`, `waiver.ts`
- CLI surface/composition: `src/local/commands.ts`, `build-request.ts`, `call-envelope.ts`, `status-classification.ts`
- Staging/replay: `src/state/staged-requests.ts`, durable intent/transaction modules
- Status/action model: `src/state/status.ts`, `next-action.ts`, `request-templates.ts`
- Blocking gate/decision path: `src/state/gates.ts`, `gate-wait.ts`, `gate-decision-interface.ts`
- Lock/concurrency: `src/state/lock.ts`, `src/state/production.ts`, `src/dispatch/cli.ts`
- Dispatch boundary: `src/dispatch/coordinator.ts`, `workspace.ts`, `cli.ts`, `process.ts`; `docs/mcp/DISPATCH.md`
- Current skill orchestration: `skills/archflow-{prd,design,phase-design,phase-impl,status,upgrade}/SKILL.md`
- Executable journey: `test/integration/status-request-roundtrip.test.ts`
- Catalogue constraints: `test/contracts/mcp-advertised-schema.test.ts`
- Active policy: `AGENTS.md`, `assets/constitution/00-process.md`, `10-architecture.md`, `20-data.md`, `30-product.md`
