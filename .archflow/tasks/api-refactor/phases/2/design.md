# Phase 2 Design: Client-Driven Document Workflows and Nonblocking Decisions

## 1. Goal and phase boundary

Phase 2 makes the already-built semantic workflow model usable through two public MCP tools for
the three document-producing workflows: PRD, task design, and numbered phase design. It completes
the missing direct human-decision service, exposes `archflow_status` and `archflow_apply` alongside
the four legacy tools, proves complete document journeys, and migrates the three document skills
only after those journeys pass.

The phase preserves the central ownership boundary:

- Claude Code or Codex, directed by the active skill, remains the producer and orchestrator.
- The client authors documents, delegates research, performs same-side review, triages findings,
  revises, discusses human gates, and performs authorized Git work.
- MCP derives and records durable authority, dispatches only the existing opposite-family and
  constitution reviews, and executes exactly one server-offered semantic action per call.
- A semantic response always returns control at the next client or human boundary. No handler
  produces content, chooses triage, edits implementation code, runs verification, commits Git, or
  starts successor work.

This is a transitional six-tool release. The legacy four tools and their blocking wrappers remain
available for the unmigrated phase-implementation and exceptional workflows. Phase 2 does not
migrate `$archflow-phase-impl` or `$archflow-status`, retire `archflow-local` commands, remove the
legacy tools, add exceptional constitution/upgrade adapters, measure final real-host tool
selection, or perform the final catalogue cutover; those remain Phase 3 or Phase 4 work as assigned
by the approved task design.

No PRD or task-design correction is required. Their Phase 2 scope and ownership model remain
accurate. This phase design supplies implementation detail that the parent design intentionally
left to phase planning, including separation of public tool names from persisted low-level tool
identity and the exact repairs required before Phase 1's decision projections can become live.

## 2. Upstream requirements and observable outcome

| Upstream requirement | Phase 2 response | Observable evidence |
|---|---|---|
| PRD R1/R2: client owns work; calls remain semantic and bounded | Public status/apply handlers use the Phase 1 one-action executor and explicit capabilities; only review and decision may run their fixed no-actor-boundary substeps. | Instrumented tests fail on producer dispatch, client-document edits, verification/Git execution, production entry from triage/decision, recursive apply, or successor-offer consumption. |
| PRD R3: every call returns one common view | Both semantic handlers project `WorkflowViewV1`; successful apply recomputes authority and returns the same bytes as fresh semantic status for the same invocation. | Status/apply parity tests cover every document-workflow action and all recoverable errors. |
| PRD R4: document skills remain visible orchestrators | Migrate PRD, design, and phase-design skills from helper/envelope choreography to offered status/apply actions while retaining production, review, triage, revision, human conversation, Git, and hand-off responsibilities. | Skill contract tests and end-to-end journeys contain several semantic calls separated by client/human work. |
| PRD R5: inputs carry judgment, not mechanics | Semantic inputs contain task, invocation, opaque offer, and the expected submission only; no staged reference, revision, fingerprint, digest, phase transition, gate ID, or caller-selected restart target is accepted. | Generated/advertised schema tests prove plain object roots, nested unions, compact results, and absence of mechanical fields. |
| PRD R6: review and triage integrity | Reuse the server-owned outer-FIFO counter-review action; return complete findings to the client; require exact client dispositions and a distinct `revise` call before editing. | Findings/no-findings/remediation journeys prove no duplicate review and no server-authored triage. |
| PRD R7: human decisions are explicit and nonblocking | Ordinary gate opening returns the presentation; a later decision call exclusively archives and settles the chosen token/reason. Crash recovery never repeats the prompt. Waiver opening remains a separate derived action. | Archive/settle crash cuts, conflicting-choice races, revision checkpoints, waiver journeys, cancellation, and stale archive tests pass. |
| PRD R8: Git stays client-owned | Design approval returns exact commit instructions; the client creates the task-local commit; read-only semantic status observes proof and offers the successor hand-off. | Design and phase-design journeys prove no server Git and no successor start before the successor invocation. |
| PRD R9: interruption and replay | Authenticate semantic operation identity from offers, immutable decision archives, and `last_transition`; refresh services and status after every durable substep; return failures without projecting false success. | Old retry and fresh status converge at every review/decision boundary after receipt cleanup, while changed, forged, stale, cross-repository, and wrong-phase inputs fail closed. |
| PRD R10/R11: bounded cutover | Advertise two semantic tools next to the legacy four and migrate only the three document skills. Keep legacy durable tool vocabulary and phase-implementation behavior unchanged. | Transitional catalogue has six descriptors; document skills forbid normal helper/staged/decision-side-channel use; phase-implementation skill remains on the legacy path. |
| PRD R12: docs and verification agree | Update every maintained page whose tool, gate, skill, contract, trust-boundary, or test description changes; regenerate schemas and the tracked release payload after source bytes are final. | Focused suites, full `npm run check`, generated-schema check, release reproduction, and maintained-doc review pass. |

At exit, a user can invoke any of the three document skills, watch the client perform the work
between several bounded semantic calls, receive nonblocking conversational decisions, resume from
decision crash boundaries without repeating judgment, create authorized design milestones, and
reach the exact next skill without normal request-building or staged references.

## 3. Verified repository constraints and required corrections

### 3.1 Phase 1 seams that remain authoritative

- `src/contracts/semantic-workflow.ts` already defines the public view, invocation, submissions,
  opaque offers, operation keys, and fixed named substeps. All reachable persisted/public JSON
  shapes remain `type` aliases and all public inputs continue to validate and materialize caller
  JSON exactly once.
- `computeAuthoritativeSemanticStatus` in `src/state/semantic-status.ts` is the only semantic read
  entry. `projectSemanticStatus` and `semanticOfferToken` in `src/state/semantic-view.ts` remain the
  only public view/offer projection.
- `planSemanticAction`, `executeSemanticActionSubstep`, and `executeSemanticAction` in
  `src/state/semantic-actions.ts` remain the one-action planning and capability boundary.
- `composeRequest` in `src/state/request-composition.ts` remains the transport-neutral bridge to
  the durable kernel. Semantic handlers do not shell out, stage a request, or self-call MCP.
- Semantic review uses the direct, non-queued counter-review handler service while
  `executeSemanticAction` owns the process-wide outer FIFO. The legacy counter-review handler keeps
  its ordinary queued entry.
- Planning restart, approval-generation filtering, pending-waiver derivation, and retained-result
  accounting from Phase 1 remain shared authority; Phase 2 adds no coordinator state.
- `openDurableGate` and the request/decision archives in `src/state/gates.ts` remain the human-gate
  authority. `gate.json` and `gate.decision` remain disposable compatibility projections, never
  required inputs to semantic resolution.

### 3.2 Public catalogue and runtime are still legacy-specific

The current `TOOL_NAMES`/`ToolName` vocabulary is not merely an advertised catalogue. It is also
reachable from durable `LastTransition`, intent receipts, request/result validation, staged
requests, errors, and exhaustive maps. Appending the two semantic names to that type would widen
persisted low-level contracts and create an unnecessary state migration.

Keep the existing `TOOL_NAMES` and `ToolName` as the exact four low-level durable tools. Add a
separate semantic public vocabulary and an advertised-name union used only by MCP registration and
dispatch:

```ts
const SEMANTIC_TOOL_NAMES = ["archflow_status", "archflow_apply"] as const;
type SemanticToolName = (typeof SEMANTIC_TOOL_NAMES)[number];
type AdvertisedToolName = ToolName | SemanticToolName;
```

Names may be colocated with the existing module, but the type boundary is fixed: semantic names
must not become valid durable transition/receipt `tool` values. Semantic execution continues to
record the underlying low-level durable tool (`archflow_state`, `archflow_counter_review`,
`archflow_gate`, or `archflow_waiver`) plus its semantic operation/substep identity.

`src/mcp/server.ts` currently classifies every call as a low-level full payload or staged
reference and validates every result as `ProjectResult<ToolSuccess>`. The semantic inputs have no
staged arm or caller-authored mechanical fields, and semantic success/failure has a different
compact envelope. The public boundary must therefore discriminate semantic names before legacy
classification, use their strict semantic parsers directly, and validate their compact result
envelopes separately. Unknown/disabled tool handling and the authenticated invocation context stay
shared.

`SemanticResultV1` currently has TypeScript aliases but no complete runtime Zod schema/parser or
generated result definition. Add those before advertisement. `AdvertisedToolDescriptor` also
needs a purpose-level `description`; both semantic tools use plain object input roots and compact
reachable output definitions, with all submission variants nested below `action.submission`.

### 3.3 Decision execution is intentionally incomplete and must be corrected before exposure

Phase 1 left decision execution deferred. The current planner does not retain decision submission
facts, operation recovery special-cases review, and the executor compounds review only. The status
enrichment for an unsettled archive exposes only a marker, hashes that marker into the offer, and
cannot authenticate the original decision operation.

The current close-only checkpoint recognition also assumes the gate-open request identity and
recognizes only payload decision `revise`. The approved design requires a distinct
`afop-...-decision-settle` transition and all existing re-entry choices: ordinary `revise`,
material-drift `revise-current`, and attempts-exhausted `retry-once`/`revise`. A valid checkpoint
must expose no writable resources until the separate `revise` action succeeds.

Additional executor corrections are required at the same boundary:

- a failed lower-level `ProjectResult` must become semantic failure with the fresh safe view, not
  be retained as a substep outcome followed by a false success projection;
- every durable substep must refresh both the authenticated semantic snapshot and the
  `ProductionServices` state used by later composition; refreshing only status while reusing stale
  services is invalid for compound actions;
- a completed material-drift `amend-upstream` restart must authenticate its request/decision
  archive against the phase it authorized even though current state has moved to the upstream
  phase; a naive current-phase archive check must not turn valid restart history into corruption;
- phase-implementation mutation offers must be suppressed while Phase 3 is incomplete. Generic
  semantic status may describe a phase-implementation position, but neither handler may issue or
  accept a phase-implementation mutation offer in Phase 2.

These are Phase 2 implementation prerequisites, not optional cleanup and not changes to the
approved architecture.

## 4. Pinned cross-chunk interfaces

### 4.1 Transitional public tool boundary

The transitional catalogue contains exactly six descriptors: the legacy four plus
`archflow_status` and `archflow_apply`. The legacy tool contract map, staged-reference arm,
mechanical result validation, and durable `ToolName` remain unchanged. A sibling semantic contract
map supplies:

```ts
type SemanticToolContractMap = {
  archflow_status: {
    input: ArchFlowStatusInputV1;
    result: SemanticResultV1;
  };
  archflow_apply: {
    input: ArchFlowApplyInputV1;
    result: SemanticResultV1;
  };
};
```

Both semantic handlers return materialized, schema-validated `SemanticResultV1`. Success contains
one `WorkflowViewV1`. Failure contains a compact code/message/retryable summary and, whenever
durable status remains readable, the fresh safe view. Protocol version/shape errors may omit the
view because no authentic task input was accepted.

The descriptor requirements are fixed:

- `archflow_status`: read durable ArchFlow status for one task and optional producing-skill
  invocation; never mutate; return one reconciled workflow view and, only for the current document
  owner, one bounded offer.
- `archflow_apply`: apply exactly the supplied server offer using only its expected semantic
  submission; never choose or loop to another action; return the newly authenticated view.
- Each input schema has a plain object root with no root `oneOf`, `allOf`, or `$ref`.
- `archflow_apply.action.submission` keeps its discriminated union below the root.
- Advertised outputs expose only the compact semantic result/view graph. Durable artifacts,
  mechanical requests, gate archives, and the legacy project-error corpus are unreachable.
- Runtime parsing remains stricter than advertisement and rejects accessors, non-enumerable data,
  unknown fields, wrong submission kinds, and unsupported schema versions.

### 4.2 Semantic status handler and Phase 2 activation fence

`archflow_status` creates production services from the authenticated startup repository and
`task_id`, computes `computeAuthoritativeSemanticStatus`, and calls `projectSemanticStatus` with
the optional invocation. It performs no repair, initialization, transition, gate open, archive
write, or Git operation.

The handler/session seam must support both an existing task and a repository-ready missing task so
`archflow-prd / resume` can receive `initialize-task`. It derives producer family from the MCP
initialize handshake when a producing invocation is present; it never accepts routing identity in
the tool input.

Add one explicit Phase 2 activation predicate shared by status offer derivation and apply
validation:

- PRD, design, and phase-design `resume`/legal `reopen` invocations may receive document-workflow
  mutation offers.
- Phase-implementation invocation may receive a descriptive view but no mutation offer until
  Phase 3 enables it; its detail directs the caller to the still-supported legacy skill.
- Omitted invocation, as used by the future status skill, remains read-only and receives no offer.
- Open gate, terminal state, reconciliation/repair, wrong owner, stale offer, and cross-repository
  cases continue to suppress mutation regardless of phase.

Hand-off ownership is a separate rule from ordinary current-phase ownership and must narrow the
current Phase 1 `invocationOwnsCurrentPosition` behavior:

- When durable status says `advance-phase`, the predecessor invocation may see
  `ready / start-next-skill`, the exact successor skill, and its arguments, but it receives no
  mutation offer. Current-phase ownership must not win merely because the state has not advanced
  yet.
- A `start-next-skill` offer is derived only when the invocation's target exactly equals
  `status.next_action.target_phase_instance` and that target is enabled on the semantic surface.
  This is the newly invoked successor consuming its own hand-off, never the predecessor finishing
  into someone else's write window.
- During Phase 2, PRD -> design and design -> phase-design hand-offs use that semantic successor
  rule. A phase-design -> phase-implementation hand-off exposes the exact successor name but no
  semantic offer because phase implementation remains disabled; the newly invoked legacy
  phase-implementation skill consumes the still-supported low-level hand-off instead.
- `complete-task`/`finish-task` remains owned by the current final phase-implementation invocation,
  not a successor. It is inactive on the semantic surface until Phase 3 enables phase
  implementation.

Apply repeats this activation check from fresh authority. A caller cannot manufacture a Phase 3
operation from a Phase 1 offer token or by editing its invocation.

### 4.3 Direct nonblocking decision services

Extract a bounded direct-decision seam from `src/state/gates.ts` while preserving the legacy
`runDurableGate` and `resolveDurableGate` behavior. The implementation may factor private helpers
out of the existing file, but must not introduce a second gate state machine. Both semantic and
legacy paths share request loading, template selection, archive validation, closure planning,
approval/waiver/restart effects, receipts, cleanup, and replay checks.

The semantic seam has three capabilities with the following behavior.

#### Archive the submitted decision

- Accept only the server-issued opaque choice token, human reason, optional allowed rationale,
  the authenticated invocation/operation binding, and the connected host context.
- Reload the exact open gate request and reconstruct its active presentation from durable
  authority. Use the existing pure `selectGateDecisionTemplate` mapping; never accept a gate ID,
  digest, rule, scope, or decision template from the client.
- Build connected-host human provenance. Its `decision_event_id` deterministically binds the
  semantic operation digest/substep; connection ID and request-ID digest preserve the actual host
  trace, and `recorded_at` is created only for the first archive.
- Create the immutable decision archive exclusively while the matching `open_gate` remains in
  state. An existing byte-equivalent/authentically equivalent archive is replay; an incompatible
  archive is a conflict. Never replace it or regenerate its provenance/timestamp.
- Return after archive only when interruption occurs. In an uninterrupted apply call, the executor
  immediately refreshes authority and continues to settlement because no actor boundary exists.

#### Settle the authenticated archive

- Accept no decision submission. Reload and authenticate the gate request, immutable decision,
  frozen predecessor, semantic operation identity, current state, and applicable evidence.
- A fresh status call with an exact semantic archive and still-open gate suppresses the
  presentation and derives only a no-submission `decision-settle` continuation. A valid pre-facade
  archive without semantic event binding starts a new one-substep settlement operation over the
  already-authenticated human choice. Missing archive means no decision; invalid, stale,
  superseded, wrong-phase, or conflicting archive yields `blocked / inspect` and never re-prompts.
- Non-reentry choices reuse the existing closure semantics, including approval, cancellation,
  waiver-requested, waiver grant/deny, commit authority, material-drift `amend-upstream`, and any
  required success receipt. Settlement removes only the exact live gate and cleans disposable
  projections after durable state commits.
- Re-entry choices close only to the authenticated `semantic-revision-requested` checkpoint. That
  state remains at triage/succeeded with the same phase, attempt, input fingerprint, authoritative
  results, approvals, and no `pending_human_revision`; revision increments once. Its
  `last_transition` uses durable tool `archflow_gate`, semantic operation
  `semantic-revision-requested`, result ID equal to the gate ID, the distinct
  `afop-...-decision-settle` intent, and a domain-separated direct semantic-decision request digest
  derived from the authenticated operation and archive rather than the original gate-open digest.
- Replay recognizes that exact checkpoint from request archive, decision archive, frozen
  predecessor, decision-settle operation, and current transition. It supports every existing
  re-entry decision and distinguishes human revision (attempt preserved; pending marker created
  only later) from `retry-once` (attempt increments only on the later re-entry).

#### Enter an authenticated revision checkpoint

- Consume only a valid no-submission `revise` offer. Reload its request, decision, frozen
  predecessor, and close-only transition under the task lock.
- Derive the next fingerprint through the existing gate-reentry seam, then enter produce/running
  exactly once. Create `pending_human_revision` only for human revision choices; increment attempt
  only for `retry-once`/ordinary triage retry as already defined by the durable kernel.
- Return writable resources only after that transition commits. Before it, the public view has an
  empty resource list for the checkpoint even if the base legacy status still names document
  resources.

The disposable `gate.decision` file may still be projected for legacy recovery/audit compatibility,
but semantic archive or settlement must not depend on it. The legacy blocking path continues to
wait/read that projection until Phase 4 retires it.

### 4.4 Semantic action planning, execution, refresh, and failures

Extend the Phase 1 action plan without changing the public input contract:

- Preserve a materialized decision submission only in the initial `decision-archive` plan. Never
  carry it into `decision-settle` or accept a replacement after an archive exists.
- Authenticate old exact retries and fresh continuation offers for decision substeps with the same
  rigor already used for review: token, invocation, repository/task, offer, operation key,
  archived request/decision, semantic event binding, last transition, and expected unfinished
  substep must agree.
- Run `decision-archive` followed by an authenticated service/snapshot refresh and then
  `decision-settle` in one normal apply call. Do not consume the next public offer after
  settlement; a returned `revise`, `open-waiver`, `commit`, or successor action belongs to the next
  client call/action.
- Keep review as `review-enter` -> `review-run` -> optional `review-empty-triage` under one outer
  FIFO. Do not generalize this into a dynamic workflow interpreter or a loop over action kinds.
- Replace snapshot-only refresh with a refresh that returns services and snapshot from the same
  newly authenticated repository/task state. Every later substep composes against those refreshed
  services.
- Inspect every lower-level result before refresh. A project/protocol/contract/state failure ends
  the semantic call as failure and attaches the fresh safe view when readable. No failed substep
  can be projected as semantic success.
- After any success, recompute authority once and return the exact projection for the original
  invocation. Status/apply parity tests compare this view with a new status call.

The executor capability set remains closed to state/composition, bounded counter-review,
gate/waiver open, direct decision archive/settle, revision entry, service refresh, and exact ask
staging. There is no producer, test runner, filesystem editing, Git, recursive apply, or arbitrary
handler registry capability.

### 4.5 Semantic MCP handlers

Add one handler per semantic tool, or one small module exporting both, and register them through the
advertised-name registry without widening the legacy durable registry type.

`archflow_status` implements Section 4.2.

`archflow_apply` performs this fixed sequence:

1. validate/materialize semantic input once;
2. create fresh production services and semantic snapshot;
3. enforce the Phase 2 document activation fence;
4. recompute/authenticate the offered action and expected submission;
5. execute only that action's fixed bounded service plan;
6. refresh services/snapshot between compound substeps and after completion;
7. return validated semantic success or a compact failure with the fresh safe view.

The capability adapter invokes in-process services, never the public MCP boundary:

- composed state operations use the existing state transaction handler/service;
- review uses the direct counter-review service beneath its outer FIFO;
- ordinary gate opening calls `openDurableGate` and returns its presentation without waiting;
- pending-waiver opening derives all fields from authenticated pending-waiver authority and opens
  exactly one waiver gate without a client summary or origin;
- decision/revision uses Section 4.3;
- semantic ask initialization stages the exact ask through the Phase 1 recoverable seam;
- design commit remains external; status only observes Git through the existing proof path.

Ordinary `gate-summary` and no-submission `open-waiver` must not route through the blocking
`handleGate`/`handleWaiver` wrappers. Those wrappers remain registered for legacy callers and keep
their existing wait/decision behavior.

### 4.6 Document skill contract after cutover

Migrate exactly these canonical skills after live journeys pass:

- `skills/archflow-prd/SKILL.md`
- `skills/archflow-design/SKILL.md`
- `skills/archflow-phase-design/SKILL.md`

Each skill:

- calls `archflow_status` on entry with its exact `resume` invocation, or `reopen` only when the
  human explicitly asked to reopen an earlier planning boundary;
- uses only returned resource roles/paths and never reads another task;
- performs the client work, then submits one `work-result` through the current offer;
- invokes the offered independent review and performs client-owned triage;
- applies the separate no-submission `revise` offer before editing after accepted triage or a human
  request for changes;
- supplies a concise human-readable `gate-summary`, receives the nonblocking presentation,
  explains every choice, stops for explicit human judgment, and later submits only the selected
  opaque token and human reason;
- treats `waiver-requested` as non-approval, applies the separate no-submission `open-waiver`, and
  repeats the human conversation for the waiver gate;
- performs authorized design Git itself from returned commit facts, then calls read-only semantic
  status so the server can observe proof;
- reports the exact successor skill but never starts its work in the current invocation;
- contains no normal `archflow-local build-request`, `envelope`, staged reference, low-level
  transition triple, caller-authored fingerprint/digest/revision, blocking gate call, or local
  decision side channel.

PRD initialization sends the exact original ask in `task-ask` before research or clarification.
Reopening sends the human's exact correction in `reopening-request`; the server owns target
derivation and the PRD ask-history append. Phase design continues to support compound updates to
returned PRD/task-design parents when planning makes them inaccurate.

`skills/archflow-phase-impl/SKILL.md` remains unchanged on the legacy surface until Phase 3.
`skills/archflow-status/SKILL.md` remains unchanged until Phase 4. Contract tests split these
transitional groups rather than forcing all producer skills to use one surface prematurely.

## 5. Deliverables and file scope

The implementation should prefer focused edits to these existing seams. A small behavior-named
module is allowed when it prevents further growth of the 1,000-line gate module, but no registry,
coordinator, compatibility framework, or generalized action engine is justified.

### 5.1 Contracts, generated schemas, and catalogue

- `src/contracts/semantic-workflow.ts`: complete semantic result schemas/parsers and any internal
  authenticated decision enrichment needed by the pinned interfaces.
- `src/contracts/internal/schema-generation-semantic-workflow.ts` and generated
  `src/contracts/schemas/v1/semantic-workflow.schema.json`: emit input and result roots.
- `src/contracts/tool-names.ts`: add semantic/advertised vocabularies without widening durable
  `ToolName`.
- `src/contracts/mcp-tools.ts` and generated `mcp-tools.schema.json`: remain authoritative for the
  legacy four only; touch only where the public boundary needs a shared discriminant that does not
  widen persisted shapes.
- `src/mcp/tools.ts`: six descriptors, purpose descriptions, semantic standalone schemas, and
  compact reachable output definitions.

### 5.2 Decision and semantic state/action services

- `src/state/gates.ts` plus, if extraction materially improves readability, one narrow
  behavior-named decision-resolution module: shared direct archive, settlement, close-only
  checkpoint, legacy wrapper reuse, receipt/restart/replay behavior.
- `src/state/gate-decision-interface.ts`: preserve pure token-to-template selection and legacy
  disposable projection behavior.
- `src/state/semantic-status.ts`: exact archive/revision enrichment, all re-entry decisions,
  material-drift restart authentication, and fail-closed markers.
- `src/state/semantic-view.ts`: exact archive-bound offers, checkpoint resource suppression, and
  Phase 2 activation fence, including narrowing `invocationOwnsCurrentPosition` so only the exact
  enabled successor invocation receives `start-next-skill` while `finish-task` remains current-
  implementation owned.
- `src/state/semantic-actions.ts`: decision plan/recovery/compound execution, fresh service refresh,
  and failure propagation.
- `src/state/request-composition.ts`, `src/state/pending-waiver.ts`, and existing restart/reentry
  services only where the direct adapters require shared authenticated derivation; do not fork
  their rules.

### 5.3 MCP runtime

- `src/mcp/server.ts`: advertised-name discrimination and separate legacy/semantic runtime result
  validation.
- `src/mcp/tools.ts` and `src/mcp/sdk-adapter.ts`: advertise/serve the transitional six-tool
  catalogue.
- `src/mcp/handlers/index.ts` and `src/mcp/handlers/session.ts`: register semantic handlers and open
  an authenticated document/missing-task semantic session without weakening legacy sessions.
- New behavior-named semantic status/apply handler file(s).
- `src/mcp/handlers/counter-review.ts`, `gate.ts`, and `waiver.ts` only to expose/reuse bounded
  in-process services while preserving their legacy wrapper behavior.

### 5.4 Skills, tests, docs, and release payload

- The three document skills named in Section 4.6 and their canonical skill contract tests.
- Focused contract/unit/integration/crash tests listed in Section 8; new test filenames describe
  behavior, never this workflow phase.
- Smoke bundle expectations in `scripts/smoke-temp-bundle.mjs` and
  `scripts/smoke-release-bundle.mjs` for the transitional catalogue.
- Maintained documentation pages whose current statements change:
  `docs/OVERVIEW.md`, `docs/COMPLEXITY.md`, `docs/DEPENDENCIES.md`, `docs/PATTERNS.md`,
  `docs/TESTING.md`, `docs/workflow/LIFECYCLE.md`, `docs/workflow/SKILLS.md`,
  `docs/mcp/SERVER.md`, `docs/mcp/DISPATCH.md`, `docs/cli/COMMANDS.md`,
  `docs/review/COUNTER-REVIEW.md`, `docs/contracts/CONTRACTS.md`, and
  `docs/state/DURABLE-STATE.md`.
- Update `docs/LIMITATIONS.md` only if implementation changes an actual limitation or timeout/
  failure claim.
- Regenerated tracked `dist/` payload after all source, skill, schema, and documentation bytes are
  final.

## 6. Work chunks and ordering

### Chunk A: Separate the public semantic transport contract

1. Keep low-level `ToolName` closed to four and add semantic/advertised name types.
2. Complete runtime/generated semantic result contracts.
3. Add purpose-described semantic descriptors with plain input roots and compact results.
4. Add boundary parsing/result-validation branches without registering live mutating handlers yet.
5. Update contract, catalogue, SDK-adapter, stdio, and bundle-shape tests.

Chunk A pins the transport types used by all later chunks. It must not advertise a handler that
can mutate until Chunks B and C complete; test construction may inject inert handlers.

### Chunk B: Extract and authenticate direct decisions

1. Factor shared gate archive/closure helpers without changing legacy behavior.
2. Implement connected-host archive creation/replay and conflict handling.
3. Implement settlement, including approvals, waivers, cancellation, material-drift restart,
   receipts, and close-only re-entry decisions.
4. Implement authenticated revision entry and correct semantic archive/checkpoint enrichment.
5. Suppress resources before revise and cover all re-entry choices.
6. Run gate lifecycle/crash tests against semantic and legacy paths.

Chunk B may proceed in parallel with Chunk A because it consumes Phase 1 semantic operation types
and existing durable gate contracts, not the public handler registry.

### Chunk C: Complete the one-action executor and live handlers

1. Add decision submission retention and archive/settle recovery to semantic planning.
2. Refresh services plus snapshot between substeps and propagate every failed lower-level result.
3. Add the Phase 2 document activation fence and exact successor-only hand-off ownership; preserve
   current final-implementation ownership for future `finish-task`.
4. Implement status/apply handlers and bounded capabilities for state, review, gate open, waiver
   open, direct decision, revision entry, initialization, and fresh projection.
5. Register/advertise the two tools beside the legacy four.
6. Prove each apply result equals fresh status and that no handler crosses an actor boundary.

Chunk C begins only after the relevant contracts from A and decision services from B are stable.

### Chunk D: Prove complete document journeys and recovery

1. Add representative PRD, design, and phase-design journeys for findings and no findings.
2. Cover accepted triage, significant human revision, editorial behavior, constitution/waiver
   presentations, cancellation, milestone Git observation, successor invocation, and reopen.
3. Add archive-before-settlement, close-only-before-revise, lost-response, exact retry, fresh
   status, race, stale/forged/wrong-phase/cross-repository, and cleanup-after-receipt tests.
4. Seed existing legacy checkpoints and pre-facade decision archives to prove no state migration or
   repeated prompt.
5. Prove phase implementation receives no semantic mutation offer in this transitional release.

### Chunk E: Migrate document skills, docs, and tracked release bytes

1. Rewrite the three document skills against the proven view/actions.
2. Split skill contract expectations between semantic document skills and the legacy
   phase-implementation/status skills.
3. Update all affected maintained pages in the same change.
4. Run focused and full verification.
5. Only after source/schema/skill/doc bytes are frozen, regenerate the tracked release payload and
   run release smoke, mutation, and reproducibility checks.

## 7. Review and risk controls

- **Durable tool vocabulary accidentally widens.** Tests pin low-level `ToolName`, transition,
  receipt, and legacy schema enums to the original four while the advertised catalogue contains
  six names through a separate type.
- **Apply becomes a hidden workflow runner.** Executor tests instrument capabilities, allow only
  fixed review/decision substeps, and assert the returned next offer is never consumed.
- **Archive crash asks the human twice.** Status loads archives before rendering presentation; one
  exact archive yields settlement only, and every invalid archive blocks.
- **Revision edits begin too early.** Close-only settlement returns no writable resources; only a
  separately authenticated `revise` action enters produce and exposes document slots.
- **Decision identity reuses the gate-open request.** The settle transition binds its own semantic
  operation/substep and direct-decision digest while retaining the immutable gate request as
  separate authority.
- **Legacy gate behavior regresses.** Existing blocking handler/CLI tests remain green, and shared
  helpers are exercised through both direct semantic and legacy wrapper paths.
- **Stale in-memory state corrupts a compound action.** Every substep obtains new services and a
  snapshot from the same canonical read before composition or settlement continues.
- **A failed inner result becomes apparent success.** Result classification precedes refresh;
  negative tests require semantic failure plus the safe current view and no later substep.
- **Phase implementation is accidentally half-cut-over.** Status/apply share an explicit document
  activation fence and tests refuse phase-implementation offers until Phase 3. A document
  predecessor also receives no `start-next-skill` offer: only the exact enabled successor may
  consume a semantic hand-off, while a phase-design -> phase-implementation hand-off remains for
  the newly invoked legacy skill.
- **Waiver flow collapses two human decisions.** `waiver-requested` returns `open-waiver`; opening
  derives its summary/origin; grant/deny is a later presentation and decision.
- **Material-drift restart looks corrupt after changing phase.** Replay authenticates the archived
  request's producer phase and restart-history landing rather than demanding equality with the new
  current phase.
- **Public schemas consume host context.** Advertised graphs include only compact semantic inputs,
  view, findings, rubric/rules, presentation, and error summary; byte-size tests retain a
  proportional transitional cap. Final catalogue measurement/host selection remains Phase 4.
- **Skill migration strands recovery.** Live seeded journeys pass before skill edits, old tools
  remain advertised, and degraded read-only status remains documented.
- **Tracked release bytes become stale.** Regenerate once after all contributing bytes stabilize,
  then run the normal release check rather than repeatedly promoting intermediate payloads.

No acceptance test may infer approval, create a commit, or advance a phase without the exact human
and durable authority required by the existing workflow.

## 8. Success criteria

Phase 2 is complete only when all of the following hold:

1. The transitional MCP catalogue advertises six purpose-described tools; semantic inputs have
   plain object roots and compact result graphs, while durable low-level tool identity remains four.
2. `archflow_status` is mechanically read-only and returns one common view; omitted/wrong-owner/
   phase-implementation invocations receive no mutation offer.
3. `archflow_apply` accepts only the current document offer and expected submission, executes one
   bounded action, and returns a view byte-equivalent to fresh status for the same invocation.
4. Direct decisions create one immutable connected-host archive and settle it once. Interruption
   after archival suppresses the old presentation and resumes without a new human submission.
5. Every re-entry decision stops at an authenticated close-only checkpoint with no writable
   resources; separate `revise` opens production exactly once with correct attempt and pending
   human revision behavior.
6. Ordinary gate-summary/open, waiver-requested/open-waiver, waiver grant/deny, cancellation,
   material-drift restart, significant revision, and approval paths preserve current authority.
7. Representative PRD, design, and phase-design journeys perform production, review, triage,
   remediation, human conversation, and Git in the client across several semantic calls.
8. A no-findings review skips empty client triage but still requires a skill-authored gate summary
   and explicit exact human approval.
9. Legal PRD/design/phase-design reopening uses only invocation plus exact human request, preserves
   worktree/Git bytes, and returns fresh target production; illegal targets fail closed.
10. Design milestone commits are created by the client, observed by read-only status, and handed
    off only when the newly invoked enabled successor applies the authenticated offer. The
    predecessor sees the exact successor but no offer; phase-design -> phase-implementation remains
    for the newly invoked legacy skill until Phase 3.
11. The three document skills contain no normal helper request construction, staged reference,
    low-level transition choreography, blocking decision wait, or local decision write. Legacy
    phase implementation remains functional.
12. Semantic handler tests prove there is no producer dispatch, client-document write,
    verification execution, Git mutation, triage judgment, recursive apply, or successor work.
13. Generated schemas, maintained docs, smoke bundles, and tracked release payload describe the
    same transitional behavior, and the full repository check passes.

## 9. Executable verification

Run focused checks during each chunk, then the full sequence after final bytes stabilize.

```bash
npm run typecheck
npm run generate:schemas
npm run check:schemas

npx vitest run \
  test/contracts/semantic-workflow-contract.test.ts \
  test/contracts/mcp-advertised-schema.test.ts \
  test/unit/tool-names.test.ts \
  test/unit/mcp-tools.test.ts \
  test/unit/semantic-actions.test.ts \
  test/unit/semantic-view.test.ts \
  test/unit/state-gates.test.ts \
  test/integration/semantic-status-authority.test.ts \
  test/integration/semantic-composition-parity.test.ts \
  test/integration/state-gate-lifecycle.test.ts \
  test/crash/state-gate-lifecycle.test.ts \
  test/integration/mcp-handlers.test.ts \
  test/integration/mcp-stdio.test.ts \
  test/contracts/skill-contract-canonical.test.ts

npm run test:mcp-runtime
npm run test:contracts
npm test
npm run build:temp
```

Add behavior-named journey/crash test files as needed and include them in the focused command. The
tests must cover:

- six-tool descriptor/schema/runtime agreement and four-tool durable identity;
- status read-only behavior, invocation ownership, activation fence, stale/cross-repository offers;
- predecessor/successor hand-off ownership: the predecessor receives successor identity with no
  offer, the exact enabled successor receives `start-next-skill`, phase implementation remains
  legacy-only, and future `finish-task` ownership stays with the current final implementation;
- exact decision archive/settle identities, old/fresh replay, pre-facade settlement, conflict races,
  and failures between every named substep;
- close-only revision resources/attempt/pending-marker rules for `revise`, `revise-current`,
  `retry-once`, and attempts-exhausted human revision;
- waiver, cancellation, material-drift restart, approval, design commit observation, and hand-off;
- findings/no-findings/remediation PRD, design, phase-design, and legal reopen journeys;
- negative ownership instrumentation and semantic-result/fresh-status byte equality;
- semantic document skill rules alongside legacy phase-implementation rules.

After source, schemas, skills, tests, and documentation are final:

```bash
npm run release:write
npm run check
```

`npm run check` must pass its normal SDK compatibility, typecheck, schema drift, MCP runtime, unit,
contract, bundle, notice, SDK-boundary, release smoke, mutation, and reproducibility gates. Do not
pull Phase 4's authenticated real-host catalogue selection matrix into this phase.

## 10. Handoff

Implementation may begin only after this exact phase design is independently reviewed, explicitly
approved by the user, committed through the authorized task-local milestone, and durable status
advances to `phase-impl-2`. Phase 2 implementation must write its implementation notes, including
any actual deviation from these pinned interfaces and the final verification evidence. Phase 3
then owns semantic phase-implementation production, verification, commit authorization, and
handoff; it must not be started by Phase 2's semantic apply handler.
