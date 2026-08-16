# Phase 1 Design: Semantic Contracts and Server-Side Composition

## 1. Goal and phase boundary

Phase 1 builds the internal foundation for a client-orchestrated semantic MCP API. It defines the
compact workflow view, the one-action offer and submission contracts, a complete projection from
current durable status, explicit skill invocation and backward-reopen impact, the focused durable
planning-restart kernel absent from this branch, and transport-neutral request composition inside
the loaded server. It
proves that each semantic action resolves to the same authenticated durable operation as today's
`archflow-local build-request` path. For reopen, which this branch does not yet compose, Phase 1
pins the restart invariants first and routes both the additive legacy adapter and semantic executor
through the same new service.

This phase deliberately makes no semantic workflow cutover. It does not advertise
`archflow_status` or `archflow_apply`, change any skill, split the blocking gate path, remove an old
tool or CLI command, or attempt a real-host journey. It does add the backward-compatible optional
restart-history contract and bounded planning-restart path needed by both the legacy transition
surface during migration and the future semantic executor. Phase 2 will expose the document
workflow only after Phase 1 proves complete semantic coverage and parity.

The governing ownership boundary is non-negotiable:

- Claude Code or Codex, directed by the skill, remains the producer and workflow orchestrator.
- The client explores, authors, implements, verifies, triages, remediates, updates documentation,
  and performs authorized Git work.
- The server derives/records durable authority and retains its existing bounded opposite-family
  and constitution review dispatch.
- One semantic mutation performs one server-offered action and returns. No internal executor loops
  to a later action or dispatches a producer.

The superseded Phase 1 transport/catalogue/containment/delegation spike is replaced in full. There
are no implementation files from it to salvage. In particular, this phase contains no long-call or
background transport work, pause/cancel control plane, seven-tool fixture, producer sandbox,
provider proxy, credential broker, bridge helper, platform matrix, delegation constitution
proposal, or evidence-manifest subsystem.

## 2. Upstream requirements and observable outcome

| Upstream requirement | Phase 1 response | Observable evidence |
|---|---|---|
| PRD R1/R2: client owns work; one semantic action per call | Define a bounded semantic action model whose compound actions use fixed named substeps, with no later-action loop or producer capability. | Boundary/crash tests prove one offered action is composed/executed, each substep dispatches at most once, and no later action is selected. |
| PRD R3: one common view | Build one authenticated semantic snapshot and project it into `WorkflowViewV1`. | Corpus covers every current next-action class, full finding fidelity, repository binding, pending waiver, and recoverable blockers. |
| PRD R4: earlier planning phases remain reopenable | Add explicit invocation intent, concrete reopen impact, strict earlier-planning validation, and the bounded restart kernel. | Matrix proves legal PRD/design/phase-design targets, refusal cases, exact downstream invalidation, fresh attempt 1, and pre-restart approval ineligibility even for identical bytes. |
| PRD R5: server derives mechanics | Extract current composition behind an internal service that accepts only semantic submissions; derive reopen target/impact from invocation plus durable state. | Public contracts contain no revision, fingerprint, request digest, intent ID, gate binding, artifact slot, or caller-chosen restart target. |
| PRD R6: review remains independent | Model counter-review as one server-owned semantic action while retaining current handler/dispatch authority. | Parity tests derive the same subject/rubric/routing and terminal evidence request without client fields. |
| PRD R7/R8: decisions and Git remain bounded | Define ordinary gate-summary, no-submission waiver-open, decision, commit-instruction, successor-handoff, and final-completion views without changing live gate/Git behavior. | Status tests distinguish ordinary gate opening, waiver opening, and decision resolution; preserve real design-commit facts; and emit no invented implementation-commit facts. |
| PRD R9: durable replay | Carry a stable semantic operation digest in named-substep intent IDs, use it as restart identity, recover pending waiver from archives, make the PRD ask append exact-once, and keep archived results in the shared retention graph. | Old/fresh retries converge after receipt cleanup; changed/forged input conflicts; one restart record/ask entry survives every crash cut; restart payloads remain quota-counted. |
| PRD R10: remove CLI/server split | Make composition callable in-process while preserving the old CLI as an adapter during migration. | CLI and semantic parity tests resolve identical internal request bytes/digests. |
| Task design Phase 1 | Add contracts, projection, offers, composition, restart kernel, internal executor, tests, and affected maintained docs. | No new advertised semantic tool, skill, or gate-wait change; optional restart history remains backward-readable. |

At phase completion, maintainers can compute one authenticated `SemanticStatusSnapshotV1`, obtain
the exact public view and offer that a future host will see, supply the allowed semantic facts, and
execute every Phase 1-supported bounded operation through the same helper/handler services.
Decision submissions are contract- and projection-complete but deliberately non-executable until
Phase 2 extracts the missing service. Explicit reopen also computes a human-readable impact and
executes one replay-safe restart in the internal seam. Users still run the old workflow until then.

## 3. Verified repository constraints

- `src/contracts/tool-names.ts` and `test/unit/tool-names.test.ts` pin the four currently advertised
  tools. Phase 1 must not edit that list.
- `src/mcp/tools.ts` builds standalone advertised schemas and preserves a plain object input root
  because at least one host loses root-level union branches. The future contracts must follow that
  rule even though they are not advertised yet.
- `src/state/status.ts` exports `TaskStatusV1` and `computeTaskStatus`; `projectBriefStatus` is not
  sufficient because it intentionally removes resources, policies, findings, prompts, and template
  bodies needed by producing skills.
- `TaskStatusV1` itself does not carry repository identity, and its finding projection omits the
  reviewer's evidence and suggested resolution. A semantic offer/view cannot be derived from that
  object alone without losing required authority or triage content.
- `src/state/next-action.ts` derives one action from authenticated status facts. Its internal
  `NextAction.request` and guidance are migration inputs, not fields in the public view.
- `src/local/build-request.ts` already accepts judgment-only facts for initialize, produce,
  running, triage, counter-review, gate, and advance, then derives the exact internal request.
  Extraction should preserve these rules rather than reimplement them.
- This branch has no planning-restart declaration, phase-order helper, restart-history contract, or
  restart planner in `src/`/`test/`; reopening cannot honestly be described as adapter-only work.
  Phase 1 adds that focused durable capability rather than building a second phase model.
- `src/state/gates.ts` currently reports material-drift `amend-upstream` as `redirect-upstream` but
  leaves state at the current triage result. Once the restart kernel exists, that already-explicit
  gate choice must derive and enact the authenticated upstream target through it; retaining the
  current no-op redirect would leave two contradictory reopening semantics.
- The pinned restart semantics are: only `prd`, `design`, or `phase-design-N` may be strictly
  earlier targets in the total workflow order; target-and-downstream authoritative results are
  removed from the active set and retained in sorted restart history; waivers and pending human
  revision are cleared and archived; prior approvals/history/fixed pins remain; target starts at
  produce/running attempt 1; PRD/design clears `planned_final_phase`, phase design retains it.
- `src/state/transaction.ts` currently asserts that every state transaction preserves waivers.
  Restart is the narrow authenticated exception because clearing them is part of its audit record;
  a generic relaxation would weaken every other transition and is forbidden.
- Approval eligibility currently matches only gate kind plus deterministic subject digest in
  `src/state/next-action.ts`, while fingerprints contain no restart generation. Reproducing
  identical bytes can therefore revive an old approval unless every authority consumer applies a
  revision cutoff derived from restart history; filtering only the public next action is
  insufficient because upstream, migration, gate, commit, and advancement checks also consume
  approvals.
- `read_retained_task_bytes` in `src/state/production.ts` currently counts active results and human
  revision evidence only. Because cleanup must keep restart-history results live, the accounting
  graph and task byte cap must add those references (including cleared pending-revision evidence)
  with digest deduplication or repeated restart can retain unmetered payloads.
- PRD reopening currently relies on skill-authored ask edits. The semantic adapter must own a
  stable-operation-bound, exact-once append so interruption cannot duplicate or lose the human's
  verbatim correction. The restart changes no other Git/index/worktree bytes.
- `TaskInitializationV1` contains pinned repository/config/policy identity but no user ask. The
  current skill writes `ask.md` only after revision-zero initialization. The semantic initializer
  must therefore stage ask bytes as an explicit recoverable side effect without pretending they
  are part of the unchanged initialization artifact.
- `src/local/call-envelope.ts`, `src/state/request.ts`, transaction receipts, and replay already
  bind fingerprints, request identity, revisions, and exact outcomes. They remain internal.
- `src/mcp/handlers/counter-review.ts` is already the bounded independent action: it derives review
  authority, dispatches the opposite family and applicable constitution review, and records its own
  terminal transition.
- `serializeDispatch` currently wraps the individual model calls, not the pre-dispatch replay check
  and final transaction. For semantic `review-run`, move that existing FIFO boundary around the
  whole replay-check/dispatch/commit operation and make its inner dispatches direct, so concurrent
  old/fresh calls dispatch once without a new keyed registry or nested queue.
- `src/state/gates.ts` exposes bounded durable gate opening. Its exported resolver consumes an
  already written `gate.decision` projection, and approval decisions are applied through the
  blocking `runDurableGate` path; no existing service accepts a semantic decision payload. Phase 1
  may compose and exercise gate opening, but direct decision application belongs to Phase 2.
- A `waiver-requested` gate decision closes `open_gate` without creating a waiver or a legacy
  pending-waiver next action. Its `last_transition` and immutable gate archives retain enough
  authority to derive that bounded interval, which the semantic read path must authenticate rather
  than asking the client to reconstruct an origin.
- `src/mcp/handlers/waiver.ts` already authors `Waiver request for <rule_id>` and binds the waiver
  rationale/origin itself. The semantic pending-waiver action must preserve that no-summary-input
  contract rather than routing it through the ordinary gate-summary submission.
- `ImplementationOutputInput` requires genuinely client-owned `base_commit`, `outputs`,
  `restore_targets`, and `declared_inputs`; phase/step/fingerprint/parent document slots are
  server-derived in the semantic contract.
- Caller-owned objects must be materialized once before repeated inspection, and descriptor reads
  require own enumerable data properties. New parsers and offer/submission handling follow these
  existing security conventions.
- Any type reachable from a canonical JSON root is a `type` alias, never an `interface`.
- No other task's `.archflow/tasks/**` files may be read or changed.

## 4. Pinned phase interfaces

### 4.1 Public contract graph

Add a contract module whose durable/plain-JSON graph uses type aliases and strict parsers for:

- `WorkflowConditionV1`;
- `WorkflowResourceV1`;
- `PublicFindingV1` and the minimum prior-disposition/remediation facts;
- `PublicConstitutionRuleV1` and `PublicReviewContextV1`;
- `HumanPresentationV1` with opaque choice tokens;
- `WorkflowPositionV1`, `WorkflowInvocationV1`, and `WorkflowReopenImpactV1`;
- `SemanticNextActionV1`;
- `WorkflowViewV1`;
- internal `SemanticStatusSnapshotV1`, which joins one full status computation to authenticated
  repository identity, complete finding content, optional pending-waiver origin, and restart
  eligibility/impact facts;
- `ApplySubmissionV1` and its `task-ask`, successful/failed `work-result`, `triage`, `gate-summary`,
  `reopening-request`, and `decision` variants;
- internal `SemanticActionOfferV1`, which is canonical but never serialized into the advertised
  response;
- internal `SemanticOperationKeyV1` and the closed named-substep vocabulary used only for
  deterministic derivation/execution, never as a new durable record;
- compact semantic result/error envelopes used by later MCP handlers.

The invocation contract is pinned to:

```ts
type WorkflowInvocationV1 =
  | { skill: "archflow-prd"; intent: "resume" | "reopen" }
  | { skill: "archflow-design"; intent: "resume" | "reopen" }
  | { skill: "archflow-phase-design"; phase: number; intent: "resume" | "reopen" }
  | { skill: "archflow-phase-impl"; phase: number; intent: "resume" };
```

`WorkflowReopenImpactV1` pins the server-derived target, ordered affected positions, concrete
authority effects, clear/retain treatment of `planned_final_phase`, preservation of all existing
Git/index/worktree bytes, whether the action appends PRD ask history, and the requirement for fresh
review/approval. It is public explanation, not caller input.

The exact user-facing action kinds are pinned to:

`initialize-task`, `begin-work`, `submit-work`, `review`, `triage`, `revise`, `reopen`, `open-waiver`,
`decide`, `commit`, `start-next-skill`, `finish-task`, `inspect`, and `none`.

The public condition vocabulary is pinned to:

`awaiting-client`, `awaiting-human`, `ready`, `blocked`, and `complete`.

`awaiting-client` means the host client must act; it never means unseen server work continues.

The view contains role/path/access resources because the client owns the files. It may carry the
canonical same-side rubric and pinned active rule text because design skills need them. It must not
carry internal transition triples, revisions, fingerprints, request/evidence/subject digests,
intent IDs, staged/archive paths, gate IDs/context, waiver origins, routing identities, or request
templates.

`PublicFindingV1` contains the stable ID, severity, blocking flag, summary, reviewer evidence,
suggested resolution, and any current triage disposition/rationale needed for remediation. It does
not expose the review evidence digest used to authenticate those fields internally.

### 4.2 Status projection

Provide pure functions with equivalent behavior to:

```ts
type SemanticProjectionV1 = {
  view: WorkflowViewV1;
  internal_offer?: SemanticActionOfferV1;
};

function projectSemanticStatus(
  snapshot: SemanticStatusSnapshotV1,
  invocation?: WorkflowInvocationV1,
): SemanticProjectionV1;
function semanticOfferToken(offer: SemanticActionOfferV1): string;
```

`projectSemanticStatus` is exhaustive over the current `NextActionCode` union. A compile-time or
test exhaustiveness fence must fail when a new code is added without a semantic mapping.

The projection rules are:

- omitted invocation -> the reconciled current view with no mutation offer;
- `archflow-prd / resume` plus missing task/repository-ready -> `ready / initialize-task`;
- explicit `reopen` naming a strictly earlier PRD/design/phase-design, with active nonterminal
  consistent state and no open gate -> `awaiting-client / reopen` expecting
  `reopening-request` and carrying the exact `WorkflowReopenImpactV1`;
- backward `resume`, same/current or forward `reopen`, any phase-implementation target, terminal,
  open-gate, or repair/reconciliation position -> no reopen offer; project the higher-priority
  current safe action and explain the mismatch, with no mutation offer unless the invocation also
  matches that action's current owner;
- produce entry/retry/re-entry -> `ready / begin-work`;
- produce running -> `awaiting-client / submit-work` with writable resources;
- counter-review pending/running, or a durably finding-free review awaiting deterministic empty
  triage -> `awaiting-client / review` expecting no submission and resuming the first unfinished
  named review substep;
- findings needing dispositions -> `awaiting-client / triage`;
- accepted triage or a human-requested revision awaiting production re-entry -> `ready / revise`
  expecting no submission and no client edits yet; applying it records only produce-running and
  returns `awaiting-client / submit-work` with writable resources;
- a required unopened ordinary human gate -> `awaiting-client / decide` expecting `gate-summary`;
- an open human gate with no archived decision -> `awaiting-human / decide` expecting `decision`
  plus presentation;
- an open human gate with one exact archived but unsettled decision -> `ready / decide` expecting no
  submission and no repeated human presentation; continue only `decision-settle`;
- an open human gate with an invalid, mismatched, or conflicting decision archive ->
  `blocked / inspect` with no mutation offer;
- an authorized design commit not yet observed -> `awaiting-client / commit` with authenticated
  commit facts, no apply offer, and an instruction to perform client Git then call read-only status;
- an authorized phase-implementation commit not yet observed -> `awaiting-client / commit` with no
  apply offer, no `commit` object, and an honest generic instruction; Phase 3 owns the read-model
  extension that supplies exact facts before cutover;
- an authenticated `waiver-requested` decision with no waiver gate yet open ->
  `awaiting-client / open-waiver` expecting no submission, using only the internal pending-waiver
  origin;
- status-observed nonfinal commit -> `ready / start-next-skill`;
- status-observed final implementation commit -> `ready / finish-task`;
- repair/reconciliation/inspection -> `blocked / inspect` with no mutation offer unless Phase 1
  explicitly maps an already bounded existing repair;
- terminal -> `complete / none`.

The projection must not infer from filenames or conversation. A server-internal
`computeSemanticStatusSnapshot` obtains the base status, `authority.repository_identity_digest`,
complete retained-review finding fields, a pending-waiver origin, an authenticated
post-decision/pre-reentry revision checkpoint, canonical phase ordering, restart-history facts,
active waivers, pending revision, and planned-final-phase treatment from one consistent canonical
read. It also recognizes the narrow review continuation when authenticated terminal review
evidence has no findings and the empty-triage result is not yet recorded; that projects the same
no-submission review operation with `review-empty-triage` unfinished instead of asking the client
for an empty judgment or redispatching review. If that valid checkpoint predates the semantic
surface and has no `afop-` intent, the current offer starts a new review-settlement operation whose
only substep is `review-empty-triage`; a semantic-looking but unauthenticated prefix yields
`blocked / inspect`.

Pending waiver is recognized only when the current `last_transition` is an authenticated
`waiver-requested` decision whose archived request/decision, subject, evidence, rule, and scope all
still bind and no waiver gate has opened or resolved. The waiver rationale is derived from the
authenticated decision; the existing `Waiver request for <rule_id>` summary and all other gate
fields are server-derived. Invalid enrichment yields `blocked / inspect`.

Pin every Phase 2 semantic decision as a fixed two-substep compound operation:
`decision-archive`, then `decision-settle`. The first exclusively installs the exact immutable
decision record while state still contains the matching `open_gate`; its connected-host
`decision_event_id` deterministically binds the semantic operation digest while the remaining
provenance fields retain the actual connection/request trace. With no intervening actor boundary,
the normal call immediately continues to settlement. Create-exclusive replay loads and validates
the existing record and preserves its original provenance/timestamp bytes rather than regenerating
or replacing it. If the call stops between writes, an exact archive
plus matching open gate takes precedence over the ordinary presentation: an old exact call
recomposes the original operation from its submission, while fresh status derives the same
operation from the archived request/frozen predecessor, supplied invocation, and archived
choice/reason, then offers no-submission `decide` with only `decision-settle` unfinished. A valid
pre-facade archive without the semantic event binding starts a new one-substep settlement operation
over that already-authenticated human choice. Missing archive means the decision has not happened;
an invalid, conflicting, or mismatched archive yields `blocked / inspect`, never a second prompt.

Settlement applies the recorded choice under the task lock and installs the appropriate state
transition. For a decision that `enactsReentry`, it removes only that gate, leaves the phase at
triage/succeeded with the same attempt, fingerprint, results, approvals, and no
`pending_human_revision`, increments revision once, and writes an authenticated `last_transition`
whose tool is `archflow_gate`, operation is `semantic-revision-requested`, result ID is the gate ID,
intent ID carries the recovered semantic operation plus `decision-settle`, request digest binds the
direct semantic decision service input, and outcome exactly matches the archive. The archived gate
request separately retains its original open-request digest. It returns before fingerprint
derivation or production re-entry. Other decision outcomes settle through their existing bounded
effect, still without re-prompting. The installed legacy gate resolver keeps its current atomic
decision-plus-reentry behavior; Phase 1 defines/tests both semantic recovery intervals and the
`revise` consumer behind the internal seam, but does not execute a live decision.

Recognize that checkpoint only when there is no open gate, state is still triage/succeeded in the
request phase, `last_transition.resulting_revision` equals current revision, its deterministic
decision substep identity recomposes from the live-gate offer derived from the archived request and
frozen predecessor, the supplied invocation, and archived choice/reason; its request/outcome
digests authenticate the direct decision request and
immutable decision record; and the gate request's own digest, frozen predecessor, subject, current
evidence, phase, attempt context, and
reentry choice all still bind, and no later mutation/restart can have superseded it. Invalid,
forged, stale, wrong-phase, non-reentry, or archive-missing checkpoints yield `blocked / inspect`.
Fresh status then offers `ready / revise` with no writable resources.

The pending-waiver interval requires `open_gate` to be absent and the `archflow_gate` last
transition to end at the current state revision. The archived request must belong to the current task/phase and
current subject/evidence, its authenticated decision must be `waiver-requested`, and no later waiver
result may supersede it. The archived decision digest supplies the private waiver-origin binding.
A mutation response later uses the same snapshot and projection path as status.

Invocation is always bound into an internal offer. Core skills supply it on status and apply;
generic `$archflow-status` omits it and therefore cannot accidentally mint a mutation offer.
`intent: "resume"` is never coerced to `reopen`. For reopen, the target comes only from the skill
variant/phase in the invocation, and the ordered affected positions and authority effects come only
from the authenticated snapshot.

The simplest implementation extracts a private detailed-status assembly seam used by both
`computeTaskStatus` and `computeSemanticStatusSnapshot`; it loads canonical state and retained
evidence once while keeping the serialized legacy `TaskStatusV1` shape unchanged. A second call to
legacy status followed by later file reads is not acceptable because it can join different
revisions.

### 4.3 Opaque one-action offer

The internal `SemanticActionOfferV1` binds:

- task and repository identity;
- durable revision and input fingerprint;
- current phase and exact internal next-action code/step;
- exact `WorkflowInvocationV1`, including `resume` versus `reopen`, plus server-derived target and
  impact for a reopen;
- current subject, evidence, gate, commit, or successor identity when relevant;
- public action kind and expected submission kind;
- a domain/version label.

The public token is `af1_` followed by a lowercase SHA-256 digest of the canonical internal offer.
No internal offer fields are encoded into the token. On use, the server recomputes current status,
rebuilds the authenticated semantic snapshot and internal offer, and compares the token before
composition. Identical task/state bytes under different repository identity digests must produce
different tokens.

Derive a private `SemanticOperationKeyV1` from a domain label, the accepted starting-offer digest,
authenticated repository/task identity, invocation, semantic action family,
phase/attempt/subject identity,
and canonical submission digest. The key binds the volatile offer but is not the offer alone. Its
domain-separated canonical digest is embedded into each distinct internal intent ID:

`afop-<64-hex operation digest>-<closed substep code>`

Substep codes use the lowercase safe-code alphabet and are capped at 58 characters, so the full
format fits the 128-character `PathSafeId` contract. Every action family has a fixed named substep
plan—usually one substep; review is the Phase 1 executable compound plan and uses `review-enter`,
`review-run`, and conditionally `review-empty-triage`; Phase 2 decision execution is pinned to
`decision-archive` and `decision-settle`. Because each completed review/decision state transaction retains its
intent and full request/outcome identity in `last_transition`, the latest substep carries the
operation correlation after normal cleanup deletes its transient receipt. Single-step actions keep
their existing transaction or immutable gate-archive replay path. Receipts are only the existing
within-substep crash buffer; no earlier receipt lifetime is assumed.

On a compound continuation, accept the embedded digest only after recomposing the preceding
substep and matching its tool, operation, request digest, input fingerprint, outcome, and legal
successor state to authenticated `last_transition`. An old exact call derives a candidate digest
from its starting offer/submission and must match; a fresh mid-action call must match the current
offer, then carries the authenticated digest to the same first unfinished substep. Review accepts no
client submission. Decision accepts one submission only at `decision-archive`; after that immutable
record exists, a continuation accepts no new submission and recovers the exact bytes from the
archive. A changed single-step or starting decision submission derives a different digest and
conflicts with the current semantic transition or gate archive. A random token or forged intent
prefix never becomes replay; a genuinely older action after another actor transition returns the
fresh view.

For reopen, the operation digest also supplies the stable restart ID. Exact retry validates that
ID, source/target, exact request, landing state, superseded authority, and any PRD ask append against
authenticated restart history rather than relying on a cleaned receipt. A changed request or
invocation is a conflict. Prior approvals remain historical records but never satisfy approval for
a newly produced subject.

Phase 1 must not add a transient offer file, semantic operation record, receipt-retention exception,
server session map, signing secret, background record, or new durable offer archive. Durable state,
authenticated `last_transition`, and the current substep's ordinary recovery receipt remain
authority.

### 4.4 Semantic composition input

The internal composer accepts a materialized semantic request, authenticated production services,
and current full status. It never accepts caller-authored mechanical fields.

```ts
type SemanticActionRequestV1 = {
  task_id: string;
  invocation: WorkflowInvocationV1;
  offer: string;
  submission?: ApplySubmissionV1;
};
```

Submission rules:

- `initialize-task` requires `task-ask` with the exact original user text;
- `reopen` requires `{kind: "reopening-request", request: string}` containing non-whitespace text
  within the existing 4,096-character human-reason limit;
  target/phase and invalidation fields are forbidden and derived from invocation/offer;
- `begin-work`, `revise`, `review`, `open-waiver`, handoff, and final completion require no
  submission; `revise` is legal only for the authenticated post-triage or human-requested revision
  position and records only produce-running before returning `submit-work`; accepted-triage re-entry
  uses the ordinary attempt-incrementing transition, while an authenticated revision-decision
  checkpoint derives the gate re-entry fingerprint, preserves the attempt for a human revision (or
  increments it for `retry-once`), and creates `pending_human_revision` only in the resulting
  produce/running state;
- `submit-work` requires successful or failed `work-result`;
- document success snapshots the canonical offered resource set and accepts no document path/body;
- phase-implementation success requires `base_commit`, output paths, restore targets, and declared
  inputs; canonical parents, transcript path, phase/step, and fingerprint are derived;
- `triage` requires exactly one disposition per current rubric finding;
- ordinary gate opening requires `gate-summary` with the exact human-readable summary authored by
  the skill; gate kind, subject, evidence, context, and choices remain server-derived;
- `open-waiver` derives the existing `Waiver request for <rule_id>` summary, rationale, rule, scope,
  subject, evidence, and origin from authenticated status/archive facts and rejects any submission;
- `decide` requires the server-issued choice token and human reason, plus only option-specific
  rationale when that option needs it, except an authenticated archive-before-state
  `decision-settle` continuation requires and permits no submission;
- a pending human-requested revision requires the existing simple/significant declaration on the
  successful work result.

Wrong, missing, or extra submission kinds fail before any transaction.

Accepted reopening request bytes are not trimmed, normalized, or reflowed. They become the durable
restart reason. For PRD, server-generated framing surrounds those exact bytes in one
`Reopening and corrections` entry; the same stable operation ID makes an existing byte-identical
append an exact retry and any other tail a conflict. A current-PRD correction does not use the
semantic reopen action: the skill enters ordinary produce re-entry and preserves the exact request
in ask history, creating no restart-history record.

For `initialize-task`, extend the task-scaffolding service with an internal semantic entry that
creates the canonical `ask.md` from the exact UTF-8 encoding of `task-ask.text`—without trimming,
normalizing, or appending a newline—using exclusive-create semantics before composing revision zero.
An existing byte-identical ask is an idempotent retry; different bytes are a collision and no state
transition runs. The existing `TaskInitializationV1` request bytes remain unchanged and parity is
asserted over that request. The ask side effect has its own assertions: it is written before state,
survives an interrupted initialization for exact retry, and is later pinned only when the first PRD
produce result declares `user-ask`. Do not add an ask field to `TaskInitializationV1`, invent a
second authority record, or let research begin before staging succeeds.

### 4.5 Planning-restart kernel

Add optional `restart_history` to `TaskStateV1`. Each `PlanningRestartRecord` is a closed type alias
containing stable restart ID, source and target phase instances, exact request as `reason`, restart
revision, sorted superseded result references, sorted cleared waiver references, optional cleared
pending human revision, and connected-human provenance. History is sorted/unique by restart ID;
state without the field remains valid.

The canonical workflow order is:

`prd < design < phase-design-1 < phase-impl-1 < phase-design-2 < phase-impl-2 < ...`

Only PRD, design, or a numbered phase design may be restart targets, and only when strictly earlier
than the current position. The service refuses terminal state, an open gate, reconciliation/repair
ambiguity, blank request, same/current or forward target, and every phase-implementation target.
It derives the target from `WorkflowInvocationV1`; no public restart submission contains one.

One accepted restart atomically/recoverably:

- retains authoritative results strictly earlier than the target and moves target-and-downstream
  references into the restart record;
- clears active waivers and pending human revision into that record, while retaining approvals,
  human-revision/restart history, and fixed pins as audit history;
- enters the target at produce/running attempt 1 with a recomputed target fingerprint;
- clears `planned_final_phase` for PRD/design and retains it for phase design;
- preserves Git, index, source/task documents, and cleanup authority; nothing is checked out,
  reverted, deleted, or committed.

For PRD only, before deriving the target fingerprint, the server installs one generated
`Reopening and corrections` append containing the request bytes verbatim. It uses the same stable
restart ID and recoverable receipt/atomic replace path as the state operation. Recovery accepts
only the exact operation-bound append, then finishes or authenticates the restart; it never
duplicates the entry or silently accepts unrelated ask edits. This append adds bytes but rewrites
none of the existing ask. A same-PRD correction does not run this helper or create
`restart_history`; because no backward semantic restart is occurring, the current PRD skill enters
normal produce re-entry and remains the writer of that history entry.

The generic state transaction continues to preserve waivers and pending revision. Its preservation
assertion gains one explicit trusted-restart branch that checks the cleared values exactly equal the
restart record and rejects every other difference. Workspace cleanup treats result manifests and
decision archives referenced by restart history as live. Replay validates restart identity,
source/target, request, landing revision/position/status/attempt/fingerprint, cleared authority, and
ask append where applicable.

Define one approval-authority phase resolver plus
`latestRestartRevisionAffectingPhase(state, authorityPhase)`. The resolver authenticates the gate
request and derives the phase whose authority is being consumed: its phase must agree with the
current/upstream document or implementation artifact's producer `phase_instance`; an imported
projection uses its canonical `ProduceUpstreamBinding`; migration-audit authority uses the
authenticated migration-audit request phase. It must never use a later consuming phase merely
because that consumer is asking the question. Then select the greatest `restarted_at_revision`
whose restart target is at or before `authorityPhase`. An approval is eligible only when
`resolved_at_revision` is strictly greater than that cutoff (or no cutoff exists). Use that
predicate at every authority consumer—status/next action, current and upstream subject approval,
evidence/adjudication, gate opening/resolution, transition advance, migration audit/resume, and
commit authorization/observation. Loading
older archives for diagnostics remains allowed. A byte-identical artifact/fingerprint or existing
Git commit cannot bypass the post-restart gate; Git proof is considered only after a fresh eligible
approval rebinds the current subject.

Define one deduplicated retained-result reference graph used by snapshot creation, installation,
replay exclusion, status/workspace accounting, cleanup, and the task byte cap. Its roots are active
`authoritative_results`, current `pending_human_revision.evidence`,
`human_revision_history[].evidence`,
`restart_history[].superseded_results`, and
`restart_history[].cleared_pending_human_revision.evidence`. Deduplicate by result digest across all
roots. A restart may change which root owns a reference but never reduces retained bytes while the
manifest/payload stays live.

Route the existing material-drift `amend-upstream` gate choice through this planner as a separate
authorized entry. Resolve the sealed affected-upstream digest through the existing canonical
upstream-subject seam, not a result-only lookup: enumerate `expectedProduceUpstreamBindings` for the
current phase, load each binding through `loadProduceUpstreamSubject`, and require exactly one
unique authenticated subject after deduplicating bindings that resolve to the same
`artifact_digest`. Its document artifact `phase_instance` supplies the actual producer planning
position; for a legacy-import projection the synthesized artifact already carries its canonical
binding phase. This distinction preserves a compound phase-design result that updated a parent: the
restart targets the phase design that produced those bytes, not the older nominal path owner. A
missing, conflicting-phase, changed, or unauthenticated subject fails closed. The resolver then temporarily removes
only the exact open gate while planning, uses the gate ID as restart ID, archives the human
decision, and replaces state with the planned restart. Replay validates both decision archive and
restart record. This does not let status/apply reopen across an open gate; every direct invocation
still refuses until the gate is resolved.

### 4.6 Transport-neutral request composition

Move the derivation currently embedded in `src/local/build-request.ts` into internal functions
named for behavior, not this phase. The simplest acceptable split is:

- task initialization composition plus recoverable exact-ask staging;
- strict planning restart composition plus recoverable exact-once PRD correction staging;
- running/produce-result composition;
- triage composition;
- counter-review composition;
- ordinary gate-open composition from `gate-summary`;
- pending-waiver composition with no submission, preserving the current handler's server-derived
  summary/origin behavior; direct decision/grant resolution is Phase 2 work;
- successor-handoff/final-completion composition after read-only status has observed client Git.

The existing CLI calls those functions and then stages its legacy envelope exactly as before. The
semantic composer calls the same functions in-process and retains the resolved full request. No
function shells out to `archflow-local`, invokes the MCP boundary recursively, or writes a staged
request for server-to-server handoff.

Parity is defined as equality of:

- selected internal tool/bounded service;
- resolved input fingerprint and request digest;
- artifact bytes/digest and parent-document set;
- triage evidence binding;
- review subject/policy derivation;
- ordinary gate kind, subject, context, and exact submitted summary bytes;
- waiver kind, subject, context, origin, and exact server-derived summary bytes;
- target phase/commit proof facts;
- restart source/target, exact reason, invalidated results/waivers/pending revision, resulting
  attempt/fingerprint, and planned-final-phase treatment;
- success/error classification.

The CLI output may retain a different generated intent ID. Parity tests supply the same explicit
intent when comparing exact request bytes.

### 4.7 Internal one-action executor

Add an internal executor callable from tests and later MCP handlers. It performs exactly:

1. validate/materialize input once;
2. create or receive production services and compute full status;
3. bind the exact invocation and validate either the current offer or an old offer whose derived operation digest matches the
   fully authenticated semantic `last_transition` before rejecting it;
4. derive or carry forward the operation digest and validate the expected submission;
5. execute the first unfinished substep, settle its existing receipt, and explicitly continue only
   to the next fixed named substep with no intervening actor boundary;
6. recompute/re-authenticate status between substeps and project the final next view.

Implement plans directly per action family rather than through a registry/interpreter. Most plans
contain one substep. `revise` is exactly one `revise-enter` substep that composes the existing
produce/running re-entry and returns before client work. From accepted triage it uses the ordinary
author re-entry. From an authenticated `semantic-revision-requested` checkpoint it reloads and
validates the immutable gate request/decision, computes the re-entry fingerprint, and alone creates
the existing `pending_human_revision` marker while entering produce/running; decision execution
does neither. Exact retry after that commit authenticates the `revise-enter` transition and pending
marker and returns `submit-work` without repeating the transition. Review is exactly `review-enter`,
`review-run`, and, only after a finding-free result, `review-empty-triage`, each with a distinct
deterministic intent. `review-enter` composes the
existing counter-review/running transition, `review-run` invokes `handleCounterReview`, and
`review-empty-triage` composes the zero-disposition triage result only after authenticated evidence
has no findings. `review-run` rechecks replay inside the existing process-wide dispatch FIFO before
any model call and holds that non-authoritative concurrency guard through its commit; a process
death before durable evidence may rerun external work and is not misreported as recorded replay.
No `while` over workflow actions, recursive apply, dynamic substep discovery, queued continuation, event
emission, producer dispatch, verification runner, Git staging/commit, or automatic successor-start
is allowed. Interruption at any named boundary must resume the first unfinished substep from
authenticated `last_transition`; the currently installing substep may additionally use its ordinary
recovery receipt.

The Phase 2 decision plan is nevertheless contract-pinned now: `decision-archive` exclusively
creates the exact bound decision, and `decision-settle` alone mutates state. A fresh continuation
with the archive already present supplies no submission and cannot redispatch human judgment; the
archive supplies the original choice/reason and semantic event binding. Settlement never derives a
revision fingerprint or enters production. When its choice requires re-entry, it creates only the
closed `semantic-revision-requested` checkpoint consumed later by `revise-enter`.

Reopen is one bounded action. It validates the explicit `reopen` invocation, impact, offer, and
exact request; performs only the optional PRD append plus one planning-restart state transition;
then returns the reopened produce window. It does not edit the reopened artifact, dispatch review,
resolve a gate, or advance successor work. Exact replay may authenticate either
`last_transition` or the restart-history record after normal receipt cleanup. A current-PRD
correction remains the ordinary skill-owned produce re-entry path.

The live nonblocking gate swap remains Phase 2. In Phase 1, gate-opening executor cases run against
the existing bounded open service in isolated integration fixtures. Decision offers and
submissions plus both decision substeps are validated/projected, but the executor must reject both
starting and settlement execution as not yet available rather than writing `gate.decision` or
entering the blocking wrapper. Synthetic open-gate-plus-decision archives exercise the
no-submission settlement projection; closed `semantic-revision-requested` fixtures exercise the
next status and `revise-enter` consumer. They are intentionally not claimed as parity with the
current helper, whose legacy gate call still combines decision and re-entry. Phase 2 extracts the
payload-accepting decision service and executes archive/settlement. Installed `archflow_gate`
remains unchanged.

## 5. Deliverables and file scope

Equivalent names are acceptable only when the ownership boundaries remain equally direct. Do not
add registries, job abstractions, coordinators, or a parallel state model.

### Contract and schema files

- `src/contracts/semantic-workflow.ts` — type aliases, strict parsers, public-view and internal-offer
  contracts.
- `src/contracts/phase-instance.ts` — canonical total ordering and strict earlier-planning target
  predicate.
- `src/contracts/durable-state.ts` and its generated/schema mirrors — optional
  `PlanningRestartRecord[]`, semantic validation, and backward-readability coverage.
- `src/contracts/mcp-tools.ts` — the additive legacy `planning_restart` declaration used only so
  the old transition surface and new semantic path share one bounded kernel during migration.
- `src/contracts/internal/schema-generation-semantic-workflow.ts` — focused schema emission, or a
  small addition to the existing generator when a separate file would add no clarity.
- `src/contracts/internal/schema-generation.ts` — register the new schema document.
- `src/contracts/schemas/v1/semantic-workflow.schema.json` — generated, never hand-edited.
- `src/contracts/index.ts` only if existing barrel conventions require public contract export; do
  not export MCP catalogue implementation from the contract barrel.

### Status, offer, and composition files

- `src/state/semantic-view.ts` — exhaustive status projection and public action offer token.
- `src/state/semantic-status.ts` — consistent authenticated snapshot assembly, including full
  finding fidelity, pending-waiver archive validation, and post-decision revision-checkpoint
  validation; combine it with `semantic-view.ts` if one direct file is clearer than two small
  files.
- `src/state/request-composition.ts` — transport-neutral extraction of current build-request
  derivation, if keeping it in `build-request.ts` would preserve the transport coupling.
- `src/state/semantic-actions.ts` — submission validation, stable operation-key/named-substep intent
  derivation, one-action composition/execution, and post-action view.
- `src/state/restart-authority.ts`, or a direct existing home — latest-affecting-restart cutoff and
  the one authenticated approval-authority-phase resolver/predicate consumed by all authority
  checks; do not copy cutoff or producer/consumer phase logic between status, gates, and
  transitions.
- `src/state/retained-result-graph.ts`, or a direct existing home — one deduplicated reference-root
  union shared by accounting and cleanup; do not maintain separate notions of live and billable
  results.
- `src/state/transitions.ts` — strict planning-restart plan and replay validation.
- `src/state/transaction.ts` — narrow authenticated-restart preservation exception; generic
  waiver/pending-revision preservation stays unchanged.
- `src/state/workspace-cleanup.ts` — retain authority referenced from restart history.
- `src/state/gates.ts` — enact authenticated material-drift `amend-upstream` through the same
  planner and replay-check its archived decision/restart identity; extract the smallest private
  gate-authorized re-entry planner so semantic `revise-enter` can consume a fully authenticated
  close-only checkpoint while the installed live-gate resolver retains atomic legacy behavior.
- `src/state/produce-subject.ts` only if a small resolver over the existing canonical binding/loader
  seam is clearer than keeping that exact loop private to `gates.ts`; retained results and imported
  projections must share the same authentication path, and retained upstream approvals must use
  restart-generation eligibility.
- `src/state/status.ts`, `src/state/next-action.ts`, and `src/state/production.ts` — consume the
  shared approval cutoff and retained-result graph for projections, evidence, commits, snapshots,
  and byte accounting without widening their serialized public shapes.
- `src/state/phase-documents.ts` or one directly named sibling — operation-bound exact-once PRD ask
  append; do not put human-history formatting into the generic transaction layer.
- `src/init/task-initialization.ts` — add only the idempotent exact-ask staging seam used by semantic
  initialization; keep the current initialization artifact contract and legacy caller behavior.
- `src/local/build-request.ts` — reduced to input parsing/CLI adaptation plus legacy staging,
  including the additive restart adapter over the shared composer.
- `src/local/call-envelope.ts` only for the minimum export/refactor needed to reuse envelope/request
  derivation; do not weaken its caller-owned object checks.
- Existing state/review/gate handler modules only when extracting a bounded callable service is
  necessary. Avoid wrapper-only files.
- `src/mcp/handlers/state.ts` only for the additive legacy restart adapter and connected-human
  provenance; semantic execution must call the same bounded service rather than duplicate it.

### Tests

- `test/contracts/semantic-workflow-contract.test.ts` — schemas, plain JSON, forbidden public
  fields, token grammar, generated drift, and type-shape constraints.
- `test/unit/semantic-view.test.ts` — exhaustive next-action/status projection corpus.
- `test/unit/semantic-actions.test.ts` — submission matching, offer derivation, one-action boundary,
  operation/substep intent derivation, stale/replay behavior, and old/fresh mid-action convergence.
- `test/integration/semantic-composition-parity.test.ts` — current CLI composer versus internal
  semantic composer across all routine action families.
- Extend phase-order, durable-state, state-transition, handler replay, gate-lifecycle,
  workspace-cleanup, and crash suites for the restart invariants in Section 4.5, including active
  waivers, exact PRD append, gate-authorized upstream amendment, identical-byte approval cutoffs,
  and retained-byte cap/accounting.
- Extend existing transition, replay, gate, and implementation-output tests only where reusing
  their fixtures is clearer than duplicating setup.
- `test/helpers/task-workspace.ts` only for a small shared fixture API needed by the parity matrix.

Name every test/file for behavior, never for "phase 1."

### Maintained documentation

- Update `docs/contracts/CONTRACTS.md` for the new internal/public semantic contract graph.
- Update `docs/PATTERNS.md` if request composition moves from a local adapter to a shared internal
  service.
- Update `docs/COMPLEXITY.md` to record which choreography remains until Phase 2 and which internal
  duplication Phase 1 removed.
- Update `docs/state/DURABLE-STATE.md` and `docs/workflow/LIFECYCLE.md` for the optional restart
  record, invalidation, and strict backward edge.
- Update `docs/mcp/SERVER.md` and `docs/cli/COMMANDS.md` only for the additive low-level restart
  adapter that remains available during migration.
- Do not describe `archflow_status` or `archflow_apply` as available and do not change skills; the
  semantic surface is still internal in this phase.

## 6. Work chunks

### Chunk A: Contract graph and generated schema

Implement the aliases/parsers in Section 4.1, nested invocation/apply-submission unions, reopen
impact, the internal offer shape, compact result/error envelope, optional restart-history record,
and generated schemas. Tests must validate representative views/submissions and reject accessors,
non-enumerable values, unknown fields, non-plain JSON, invalid resource access, unrecognized
actions/conditions, and mechanical target/invalidation fields smuggled into public submissions.

The schema generator must be deterministic and `check:schemas` clean. The public apply input shape
must remain a plain object root when Phase 2 embeds it into an MCP tool; include a contract test now
so later advertisement cannot reintroduce the host regression.

### Chunk B: Full-status projection and offers

Build a table-driven status corpus covering missing task, every pipeline step/status, fixed-point
outcomes, evidence unavailable, accepted/editorial remediation, all gate kinds, design and
implementation commit actions, every phase handoff, terminal task, reconciliation findings,
config mismatch, retained-receipt ambiguity, and inspect-state fallbacks.

Add seeded cases for otherwise identical task snapshots in two repository identities, full finding
evidence/suggested-resolution fidelity, interruption after finding-free terminal review but before
empty triage, interruption immediately after `waiver-requested`, an already opened or resolved
waiver, malformed or stale waiver-origin archives, a valid pre-facade finding-free review
checkpoint with no semantic prefix, an open gate with an exact semantic or pre-facade unsettled
decision archive, an authenticated post-decision revision checkpoint, and forged, conflicting,
stale, archive-missing, wrong-phase, or non-reentry semantic-looking transitions.

Add the invocation matrix: omitted invocation, current and exact-successor resume, backward resume,
legal earlier PRD/design/phase-design reopen from every later position, same/current and forward
reopen, phase-implementation target, terminal, open gate, and repair/reconciliation. Assert the
impact's ordered positions and concrete authority effects match the same snapshot used for the
offer.

Seed identical-byte subjects before and after each legal restart target. Assert status, approved
upstream loading, evidence/adjudication, gate composition, migration resume, commit observation,
and advancement all resolve the phase whose authority the approval binds, then ignore approvals
at/before that phase's latest affecting restart while accepting a fresh later approval. Include
legacy artifact-approval, design-approval, migration-audit, and commit-authorization kinds. Boundary
cases prove reopening phase design preserves earlier PRD/design authority, reopening design
preserves PRD authority but invalidates design/migration/later authority, and reopening PRD
invalidates all downstream authority; no later consumer may substitute its own phase for the
producer's authenticated phase.

Project only authenticated status facts. Verify role resources, rubric/rules, findings,
presentations, available design-commit facts, and next skill survive where required, while the
phase-implementation commit case contains no fabricated fact and mechanical fields never leak. Add
an exhaustive switch/fence so a future `NextActionCode` addition cannot silently map to a generic
action.

### Chunk C: Extract request composition

Refactor `build-request` bottom-up. Move pure/shared derivation without changing its CLI contract,
output, staged path, request digest, error classification, or tests. Materialize caller-owned input
once at the boundary, then pass immutable facts into the extracted functions.

Use parity fixtures for:

- revision-zero initialization request parity plus recoverable exact-ask staging/retry;
- document produce for PRD, task design, and compound phase design;
- implementation output with representative add/modify/delete/restore and declared inputs;
- running entries and terminal failure;
- empty and finding-bearing triage;
- no-submission revision re-entry after accepted triage, proving parity records only
  produce-running before writable resources are returned; human-requested re-entry uses the
  separately pinned semantic decision-checkpoint fixtures below because the installed helper still
  combines those operations;
- counter-review;
- artifact/design/constitution/material-drift/attempts-exhausted/commit gates;
- authenticated no-submission waiver gate opening recovered after interruption, including the
  existing server-derived summary, but not decision/grant execution;
- status-observed design/implementation commits, phase handoff, and final completion.
- planning restart from active phase design/implementation to each legal target, including exact
  source/target/result/waiver/pending-revision/final-plan parity between the legacy and semantic
  adapters over the shared kernel;
- material-drift `amend-upstream` target derivation from authenticated artifact evidence, decision
  archive/restart identity, landing-state replay, retained-result and imported-projection upstreams,
  compound parent projections, and refusal of missing, changed, conflicting-phase, or mismatched
  evidence;
- PRD correction staging, exact generated framing, byte preservation, and same-PRD ordinary
  re-entry versus later-phase restart.

If an exceptional current action cannot be composed from the semantic submission without exposing
mechanical fields, keep it `blocked / inspect` and record the concrete gap for its owning later
phase. Do not add a generic escape hatch.

### Chunk D: Offers, replay, and one-action execution

Implement `af1_<digest>`, stable semantic operation keys, the parseable
`afop-<operation-digest>-<substep>` intent format, `last_transition` authentication, within-substep
receipt replay, old/fresh mid-action convergence, submission matching, one bounded execution, and
post-action projection.

Test kill/failure points before and after every named substep, receipt lookup, offer validation,
internal request resolution, transaction commit, and final status projection. A response-projection
failure after a committed action must be recoverable by exact retry/status; it must not rerun the
action. The exact old call and a fresh offer from each mid-action position must select the same
unfinished substep. Concurrent old/new retries permit at most one dispatch/transition per substep.
After each committed substep, run ordinary workspace cleanup before the retry assertions; prove no
test or implementation relies on the deleted prior receipt. Reject forged operation prefixes,
wrong old offers, and a `last_transition` whose tool/request/outcome identity does not recompose.

For decision recovery, construct canonical open gates with missing, exact semantic, exact
pre-facade, invalid, changed, and conflicting decision archives. Missing projects the ordinary
human presentation; an exact archive projects no-submission `decide / decision-settle` without a
second prompt; invalid/conflicting bindings yield `blocked / inspect`. Phase 1 validates the
starting submission and continuation contract but rejects execution as deferred. Separately seed
the Phase 2 `semantic-revision-requested` close-only result and prove fresh status returns
no-submission `revise`; missing/changed archives, wrong subject/evidence/phase, stale revisions,
non-reentry choices, and forged transitions fail to inspect. `revise-enter` alone derives the
fingerprint, creates `pending_human_revision`, and enters produce/running; exact old/fresh retry
returns `submit-work` once. Keep the installed legacy decision-plus-reentry path green.

For reopen, cut failures before/after ask atomic replacement, receipt creation, state replacement,
and cleanup. Exact old/fresh retry must converge on one operation-bound ask entry and one restart
record; changed request/target/invocation must conflict. Exercise active waivers to prove only the
authenticated restart can clear them, and assert old approvals do not authorize newly produced
subjects. Snapshot Git history, index, source files, and all existing task/worktree bytes before
each case and prove only the expected PRD append and state projections change.
Include request bytes with leading/trailing whitespace, Unicode, embedded headings/newlines, and
the same wording in two distinct later reopen operations; identity, not content-only deduplication,
must distinguish legitimate repeated corrections while preserving all earlier ask bytes.

Build retained-result graphs for one and repeated restarts, current and cleared pending-revision evidence, and
digests shared with active/human-revision history. Assert cleanup liveness and retained-byte totals
use the same deduplicated roots, replay exclusion does not double-count, status reports the same
total, and a new result crossing the 250 MiB task cap is refused even when most prior bytes are held
only by restart history.

Instrument the executor in tests. Assert zero producer dispatch calls, verification subprocesses,
Git stage/commit calls, direct decision-resolution calls, recursive apply calls, or execution of a
second returned offer. Assert `triage` and `decide` stop before revision re-entry, and `revise`
performs only its one `revise-enter` transition before returning client work.

### Chunk E: Integration parity, docs, and cleanup

Run the whole parity matrix, keep every old CLI/MCP journey green, update only the maintained pages
named above, and remove extraction leftovers that no longer have a caller. Do not delete staged
request support, low-level tools, gate waiting, or CLI commands in this phase.

## 7. Review and risk controls

- **No premature semantic swap:** no new semantic tool is advertised and installed skills/gate-wait
  behavior are unchanged. The existing low-level catalogue changes only by the additive bounded
  planning-restart declaration required for migration parity; its plain-root and size tests remain.
- **No second state machine:** semantic actions call the existing composers, handlers, transition
  planner, and transaction kernel. The view projects an authenticated snapshot whose base action is
  `TaskStatusV1`; its only added projections are explicit invocation/reopen, the verified legacy
  pending-waiver interval, and the narrow finding-free review settlement/continuation required to
  skip empty client judgment. Restart lands on an existing phase/step/status position.
- **No omnibus executor:** one offer, one bounded action, one new view. Compound actions have fixed
  named substeps, not a dynamic plan or later-action loop; instrumented negative tests reject
  producer/verification/Git capabilities.
- **No fake idempotence:** each substep intent carries the shared operation digest in authenticated
  `last_transition`; only the currently installing substep relies on its recovery receipt. Old and
  fresh mid-action retries converge before stale rejection, while forged or unrelated stale tokens
  are not called successful merely because state moved.
- **No destructive reopen:** explicit intent and the offered impact precede mutation; strict
  planning ordering forbids same/forward/implementation targets; one restart ID binds the exact
  request, ask append, invalidation record, and landing state; Git/index/source bytes are asserted
  unchanged.
- **No open-gate bypass:** direct reopen refuses every open gate. Only the authenticated
  material-drift `amend-upstream` decision removes its own gate while invoking the shared planner,
  and its archived decision/restart identity is replay-checked.
- **No broad waiver exception:** generic transactions still preserve waivers and pending human
  revision. Only a fully validated restart may clear exactly the values archived in its record.
- **No repeated human decision:** an exact decision archive beside its still-open gate suppresses
  the presentation and projects only no-submission settlement; conflicting or malformed archives
  fail to inspect, and settlement never enters production.
- **No digest-generation confusion:** deterministic identical bytes are expected; current approval
  authority therefore requires a resolved revision after the latest restart affecting the
  authenticated producer/authority phase, never a later consuming phase. One shared resolver and
  predicate cover every authority consumer, not just status.
- **No unmetered audit payloads:** cleanup and byte accounting traverse one deduplicated retained
  result graph rooted in active, human-revision, restart, and cleared-pending evidence. Moving a
  reference to history cannot lower quota.
- **No token authority:** the `af1_` digest is checked against a recomputed canonical offer and then
  every underlying durable authority is revalidated by existing services.
- **No weakened JSON boundary:** materialize input once, reject accessors and non-enumerable data,
  preserve assert-don't-filter behavior, and use type aliases throughout reachable shapes.
- **No hidden path authority:** resource paths are outputs; document slots and implementation
  parent/transcript paths remain server-derived. Client-supplied output/input paths continue through
  existing path classification and task-isolation checks. The PRD ask slot is server-derived and
  only the operation-bound append helper writes it.
- **No misleading docs:** Phase 1 documents contracts/internal structure only and explicitly says
  the semantic tools are not yet installed.
- **Proportionality:** reuse existing generators, status, composers, receipts, and fixtures. Do not
  build a semantic operation record, generalized action/substep registry, migration system, worker
  protocol, benchmark framework, or release evidence manifest.

## 8. Success criteria

Phase 1 is complete only when:

1. Every current readable durable position projects to one validated `WorkflowViewV1`; a generic
   status has no mutation offer, and a compatible explicit invocation receives at most one `af1_`
   offer. The open-gate/archive settlement, pending-waiver, post-decision revision, and legal/illegal
   reopen matrices are represented.
2. The public contract contains everything producing skills need—resources, findings, policy,
   presentation, available authenticated commit facts, next skill, and concrete reopen impact—and
   none of the forbidden mechanical fields; the current implementation-commit case is explicitly
   generic.
3. Apply submissions contain only exact ask/reopening text, client work outcome/declarations,
   triage judgment, skill-authored ordinary gate summary, human revision declaration, or human
   choice/reason; reopening contains no target/invalidation field and pending-waiver opening accepts
   no submission. `revise` also accepts no submission and is the required separate action before
   any post-triage or human-requested client edit.
4. The semantic composer derives the same internal request bytes/digest and bounded service choice
   as the current helper for every Phase 1-supported action family; both newly added restart
   adapters use one kernel and satisfy the exact Section 4.5 invariants. Direct decision resolution
   and creation of the close-only human-revision checkpoint are explicitly deferred to Phase 2;
   Phase 1 validates/projects both archive-before-state and closed-checkpoint fixtures and executes
   the bounded `revise` consumer without claiming legacy decision parity.
5. Existing non-restart CLI/MCP requests remain byte-compatible, the additive legacy restart path
   is plain-rooted and bounded, and all existing journeys stay green.
6. Stable operation keys and distinct named-substep intents survive ordinary prior-receipt cleanup
   through authenticated `last_transition`; exact old and fresh mid-action retries converge, while
   changed, forged, or genuinely stale use fails closed with the fresh semantic view.
7. Exact reopen retry converges on one restart record and, for PRD, one verbatim operation-bound ask
   entry across every crash cut; changed request/invocation conflicts, active waivers clear only
   through the narrow restart branch, and material-drift
   `amend-upstream` enacts exactly the authenticated target instead of a no-op redirect.
8. Every approval authority consumer derives the authenticated producer/authority phase and applies
   that phase's latest-affecting-restart revision cutoff; byte-identical subjects, old
   migration/design approvals, and existing Git proof cannot skip a required fresh post-restart
   human gate, while a later exact approval works. Reopening phase design preserves earlier
   PRD/design authority, reopening design preserves PRD authority, and reopening PRD invalidates
   downstream authority.
9. Active, current-pending, human-revision, restart-superseded, and cleared-pending evidence share one deduplicated
   retained-result graph for cleanup, snapshot/status accounting, replay, and the task byte cap;
   repeated restart cannot retain unmetered payloads.
10. Offer identity includes authenticated repository identity and invocation; public findings retain
   evidence/suggested resolution; unsettled archived decisions, pending waiver, post-decision
   revision re-entry, and reopened production resume from authenticated archives without
   client-rebuilt bindings or repeated human judgment.
11. One executor invocation cannot perform a second offered action, producer work, triage judgment,
   verification, Git staging/commit, or successor work; every permitted compound substep is named
   and ends before the next actor boundary. Triage/decision cannot enter production, while the
   separate one-substep `revise` action does nothing beyond authenticated produce-running re-entry
   and creation of the already-defined pending-human-revision marker when its gate decision
   requires one. The pinned decision compound archives once and settles state once; an interrupted
   continuation accepts no new decision submission.
12. No new semantic tool, skill, gate-wait behavior, or human authority rule is activated. The only
    durable extension is backward-readable optional restart history, and the only old-surface
    addition is its bounded migration adapter.
13. Generated schemas, focused tests, all existing durable/review/gate tests affected by the
   refactor, and the full repository check pass.
14. Maintained contracts, patterns, complexity, durable-state, lifecycle, server, and CLI pages
    describe Phase 1 truth without presenting the future semantic API as installed.

## 9. Executable verification

During implementation, run the focused checks while iterating:

```bash
npm run typecheck
npm run check:schemas
npm test -- test/contracts/semantic-workflow-contract.test.ts
npm test -- test/unit/semantic-view.test.ts test/unit/semantic-actions.test.ts
npm test -- test/integration/semantic-composition-parity.test.ts
npm test -- test/unit/phase-instance.test.ts test/unit/state-transitions.test.ts
npm test -- test/integration/mcp-handler-state-replay.test.ts test/unit/workspace-cleanup.test.ts
npm test -- test/unit/state-next-action.test.ts test/integration/state-transaction.test.ts
npm test -- test/crash/state-transaction.test.ts
```

Then run the existing contract and workflow regression slices most likely to catch extraction
drift:

```bash
npm test -- test/integration/status-request-roundtrip.test.ts
npm test -- test/integration/status-reentry-edit.test.ts
npm test -- test/integration/state-gate-lifecycle.test.ts
npm test -- test/integration/review-fixed-point-live.test.ts
npm run test:contracts
```

Before review, run the complete repository gate:

```bash
npm run check
```

No authenticated real-host run, OS-specific sandbox tool, provider credential access, constitution
workflow, or policy commit is required for this phase. If the refactor changes generated schema
bytes, commit the generator source and generated output together and require `check:schemas` to
prove no drift.

## 10. Handoff

The Phase 1 implementation log must identify:

- the final contract and internal service file locations;
- the restart-history shape, PRD append framing/recovery behavior, and narrow transaction
  preservation exception actually implemented;
- the shared approval-generation cutoff consumers and retained-result accounting roots;
- any current action deliberately left `blocked / inspect` and why;
- the parity matrix and replay strategy actually implemented;
- maintained documentation updated;
- verification commands and results;
- any durable convention worth proposing outside `.archflow/`.

Phase 2 may advertise the semantic tools and split live gates only after this phase's reviewed code
is committed under the existing explicit implementation authority. Phase 1 approval alone does not
authorize implementation, advertise a partial API, change a skill, remove an old surface, or alter
human authority.
