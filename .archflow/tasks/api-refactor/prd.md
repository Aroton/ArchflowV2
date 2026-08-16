# Product Requirements: Client-Orchestrated Semantic Workflow API

## Summary

ArchFlow must simplify how Claude Code and Codex move through its workflow without moving the
workflow itself behind one MCP call. The normal user experience remains: open Claude Code or
Codex, invoke the applicable ArchFlow skill, let that client do the work, and make the human
decisions the skill presents.

The skill remains the workflow orchestrator. It directs exploration, drafting, implementation,
verification, triage, remediation, documentation updates, authorized Git work, and the sequence of
semantic MCP calls. MCP remains the durable workflow authority beneath the skill: it validates
prerequisites, derives mechanical bindings, records results, dispatches the independent
opposite-family review, authenticates human decisions, and returns one reconciled next action.

The refactor must replace today's request-building and low-level transition choreography with a
small set of purpose-level MCP actions. A call may collapse bookkeeping that contains no new client
judgment, but it must stop whenever more client work or human judgment is needed. It must never
launch a hidden producer or execute a whole phase autonomously.

## Governing correction

This revision is governed by the user's clarification, preserved here verbatim because it
materially supersedes the prior PRD and design:

> $archflow-prd api-refactor we ran into some issues while working on phase 1 design/impl. It
> rasied some issues and I think it means we have the wrong design, so i'm re-opening PRD.
>
> The idea was that we SIMPLIFY MCp calls, but somehow that turned into one mcp call for everything.
>
> The main transport is still claude or codex.
>
> An example workflow would be to open up codex, run a skill. This skill still directs how to USE
> the mcp. But codex would be responsible for doing the work, what we wanted simplify is how we
> moved through the workflow as that is very complicated right now, not to hide teh entire workflow
> behind one mcp command

The earlier `docs/validation/client-interface-audit.md` remains useful evidence that the current
protocol is too mechanical. Its recommendation to move production and orchestration into a
server-owned autonomous runner is rejected by this clarification and remains historical evidence,
not the target architecture.

## Problem

The current normal loop exposes ArchFlow's durable implementation details to its client. A skill
must interpret status, choose a phase/step/status transition, invoke `archflow-local` to construct
and stage a request, pass a staged reference to one of four low-level MCP tools, and query status
again. Human gates add a long-running MCP request plus an out-of-band local decision write. The
client must understand revisions, fingerprints, request digests, intent identifiers, gate origins,
artifact paths, and transition legality even though those values express no product judgment.

This is costly in three ways:

- the skills spend scarce context on protocol mechanics instead of the work and the human
  conversation;
- equivalent intent is represented by status codes, helper kinds, request envelopes, staged files,
  MCP payloads, and later status, creating avoidable transcription and version-skew failures;
- every mutation returns low-level success rather than the same reconciled view of what the skill
  should do next, so routine progress requires repeated status calls.

The wrong correction would be to make one server call perform production, review, triage,
remediation, verification, commits, and phase advancement. That removes the client from the very
work the user opened Claude Code or Codex to perform. The required correction is semantic
checkpointing: several visible, simple MCP calls directed by the skill, each corresponding to one
meaningful workflow boundary.

## Users

- Humans who work through Claude Code or Codex, inspect the client's output, approve exact
  artifacts, authorize commits, and resolve genuine product or policy decisions.
- Claude Code and Codex sessions running ArchFlow skills as the active producer and workflow
  orchestrator.
- Skill authors who need a stable, purpose-level API rather than a protocol manual.
- Maintainers diagnosing durable state, compatibility, review, gate, and recovery behavior.
- Opposite-family reviewers dispatched by the server to preserve independent review evidence.

## Goals

1. Keep Claude Code or Codex, guided by an ArchFlow skill, responsible for all producer work and
   workflow sequencing.
2. Replace low-level workflow mutations with semantic MCP actions aligned to meaningful client,
   review, and human-decision boundaries.
3. Return a common reconciled workflow view and one next action from every normal call so routine
   mutations do not require a follow-up status query.
4. Remove request construction, staged references, caller-authored integrity fields, and the local
   decision side channel from the normal skill loop.
5. Preserve the durable state machine, exact-byte authority, review independence, evidence
   freshness, task isolation, attempt bounds, and existing human trust boundaries.
6. Make interruption recovery simple: rerun the skill, inspect semantic status, and continue the
   one safe next action without duplicating recorded effects.
7. Keep the advertised MCP catalogue compact, self-describing, and reliable in both supported
   clients.
8. Replace the current surface coherently across the normal lifecycle, skills, CLI boundary,
   documentation, and representative tests without building speculative runtime infrastructure.
9. Preserve the human's ability to reopen an earlier PRD, task design, or numbered phase design
   from a later active phase, with explicit intent, durable downstream invalidation, exact PRD
   correction history, and fresh-review rules, but without a caller-authored restart transition.

## Non-goals

- Executing an entire PRD, design, phase-design, phase-implementation, or multi-phase workflow in
  one MCP call.
- Moving exploration, production, implementation, triage, remediation, verification,
  documentation synchronization, or Git work into the MCP server.
- Dispatching server-owned write-capable producer agents. Server-dispatched independent review is
  retained because it is an existing trust boundary, not production delegation.
- Adding a background phase runner, job supervisor, pause/cancel control plane, reconnect broker,
  provider proxy, credential broker, producer sandbox, or cross-platform worker runtime.
- Adding a repository-wide worktree scheduler or solving arbitrary concurrent same-user edits as a
  prerequisite for simplifying the API.
- Changing exact artifact approvals, the prohibition on code before phase-design approval, commit
  authority, waiver semantics, or any other human trust boundary merely to reduce call count.
- Replacing the fine-grained durable state machine, canonical records, digests, transactions,
  receipts, or re-authentication. They become private implementation details.
- Minimizing the number of MCP calls until meaningful workflow boundaries disappear. Several
  semantic calls per skill run are expected.
- Creating one universal tool that absorbs constitution editing, repository initialization,
  exploration, legacy upgrade, diagnosis, and the task lifecycle.
- Building permanent compatibility machinery for a prototype. A bounded cutover may run old and
  new surfaces together only until the skills and journeys have migrated.

## Product requirements

### R1. Client-owned orchestration and work

The normal workflow stack is:

`human -> Claude Code/Codex -> ArchFlow skill -> semantic MCP API -> durable kernel`

The active Claude Code or Codex session must remain the producer and workflow orchestrator. Guided
by the skill, it reads the repository, delegates bounded research or implementation where useful,
authors documents and code, runs verification, interprets review findings, performs triage and
remediation, keeps parent documents and implementation notes truthful, and executes Git commands
only after the applicable authority exists.

MCP must not dispatch a producer, decide triage, edit the worktree as a producer, run implementation
verification, or continue a phase after returning. The server may dispatch the existing independent
rubric and constitution reviews and may perform deterministic durable bookkeeping around the one
semantic action the client requested.

### R2. Semantic action granularity

Each public task-lifecycle call must represent one purpose a skill can explain in ordinary
language, such as starting or resuming the requested skill boundary, observing status, submitting
client-produced work, requesting independent review, submitting triage judgment, recording a human
decision, or completing an authorized hand-off.

A semantic call may combine internal transitions when no new client work or human judgment exists
between them. Entering review and recording the dispatched review result is one such bounded
operation. Every compound operation has a fixed, named substep sequence and a distinct private
replay identity per substep; it is not a loop over whatever workflow action happens to come next. A
finding-free result may skip empty triage, but it returns an ordinary gate-opening action so the
skill can author the human-readable gate summary before the server opens the presentation. A call
must return as soon as the next step requires the client to author, inspect, triage, verify, commit,
ask the human, or invoke another skill.

Recording one explicit human decision may use fixed archive-then-settle substeps because no new
judgment lies between them. If interruption leaves the immutable decision archived while its gate
is still open in state, fresh status must offer only a no-submission settlement continuation. It
must not show the presentation again, accept a replacement choice, or execute later revision work.

Accepted triage and a human request for changes must return a separate, no-submission revision
re-entry action. Applying it may record only the server-derived production write window and must
return before the client edits, verifies, or resubmits. The triage or decision call may not silently
execute that later action. A request-changes decision must therefore close its exact gate at a
durable, status-reconstructible checkpoint with no writable resources; immutable decision
authority plus the current transition must be sufficient to recover the later re-entry without a
new coordinator record.

The PRD intentionally does not optimize for an exact tool count. The design must choose the
smallest clear surface. A shared mutation tool is acceptable only when every invocation is bound to
one server-offered semantic action and returns immediately afterward; it must not become a
polymorphic "run the workflow" operation that chooses or loops through later actions itself.

### R3. Common workflow view and one next action

Every normal semantic call, including status, must return the same compact workflow view. It must
contain enough information for the skill to continue without another discovery call:

- the task and human-readable workflow position;
- the current client-work, review, triage, decision, client-action, ready, blocked, or complete
  condition;
- task-scoped resources by role, path, and access when the client must read or write them;
- current review findings or verification facts when they require client judgment;
- one semantic next action with an ordinary-language explanation;
- one conversational presentation and server-issued choices when human judgment is required;
- the next skill and its arguments when the current boundary is complete.

The ordinary view must not expose phase/step/status triples, revisions, fingerprints, request
digests, intent receipts, staged references, gate identifiers, evidence ordering, waiver-origin
digests, rubric routing, or known mechanical request templates. Resource paths are intentionally
visible because the client owns the work; internal evidence and archive paths are not.

Mutation results must carry the post-action view. Status is for entry, resumption, explicit status
requests, and diagnosis—not mandatory polling after every successful call. A workflow condition
must never imply that hidden server-side production continues after the response.

Review findings returned for triage must retain the reviewer's evidence and suggested resolution,
not only an identifier and summary. A semantic offer must bind the authenticated repository as well
as the task so an otherwise identical task snapshot in another repository cannot reuse it.

### R4. Skill-directed lifecycle

A representative document phase must remain visibly client-directed:

1. the invoked skill starts or resumes the exact requested boundary and receives writable resource
   roles plus the next work instruction;
2. Claude Code or Codex performs the work;
3. the skill submits that result through one semantic action;
4. the skill invokes independent review when returned as the next action;
5. Claude Code or Codex triages findings and submits its semantic judgment; when revision is
   required, the skill applies the returned no-submission production re-entry action before the
   client revises and resubmits;
6. when a gate is required, the skill supplies the concise human-readable summary that will frame
   the decision and receives the durable presentation;
7. the skill presents that gate and records only the user's explicit choice;
8. Claude Code or Codex performs any separately authorized Git action, asks MCP to verify/record
   the result, and reports the server-derived next skill.

An empty review may move directly to the gate-opening action without demanding an empty triage
submission. It may not invent the skill-authored gate summary. A material finding must return
control to the client for judgment. A revision must use the distinct no-submission re-entry action
before client edits, then return to fresh review under the existing evidence rules.

Starting or completing one top-level skill may make the successor ready, but it must not perform
the successor's work. PRD, design, each numbered phase design, and each numbered phase
implementation remain distinct human-invoked skills.

Invoking an earlier planning skill is a distinct, explicit backward-reopen intent, not a mismatched
normal kickoff. The producing skill must identify itself, its optional phase number, and
`intent: "reopen"`; a normal `resume` invocation must never reset earlier work. For an active
nonterminal task with consistent authority and no open human gate, semantic status must validate
the requested PRD, task-design, or numbered phase-design boundary and return exactly one reopen
offer that explains the target, affected workflow positions, authority being invalidated, and
content being preserved. Applying that offer with the human's exact reopening/correction request
must use one canonical durable planning-restart transition: preserve existing Git, index, and
worktree bytes; archive target-and-downstream result authority in restart history; clear active
waivers and pending human revision; reset the reopened boundary to produce/running attempt 1; and
make prior approvals incapable of authorizing new subject bytes. Reopening PRD or task design
clears the obsolete final phase plan; reopening a numbered phase design retains the approved task
plan.

Retained approvals remain audit history, but an approval may authorize a phase only when its
resolved revision is newer than the latest restart whose target affects that phase. This generation
check applies even if production recreates byte-identical subject and fingerprint digests, and to
artifact, design, migration-audit, commit, upstream, and advancement authority—not only the public
next-action projection. The phase tested is the phase whose authority the authenticated approval
binds—derived from its gate request and exact current/upstream artifact or canonical import
binding—not the later phase consuming that authority. Existing Git commits remain history; they may be re-observed only after the
new cycle has fresh eligible approval and exact current subject authority.

For a PRD target, the same semantic action must append the human's request exactly once to the
canonical `Reopening and corrections` ask history before the restart fingerprint is derived. The
request bytes are stored verbatim inside server-generated framing—no trimming, normalization, or
reflow—and every existing ask byte remains unchanged. A stable operation/restart identity plus
recoverable write ordering must make a crash before or after the append safe to retry. This is the
only intentional worktree addition made by reopening; the restart itself does not roll back or
rewrite source, plan, or implementation files. The client edits the reopened PRD only after status
returns its new produce window.

The target must be strictly earlier and must be a planning boundary—never a phase implementation.
A request cannot jump forward, reopen a terminal task, cross an open gate, or bypass reconciliation
or repair. The target comes only from the authenticated invocation and server-derived offer, never
from the reopening submission. Reinvoking the current boundary uses ordinary resume/re-entry
instead of restart history; at the current PRD boundary, the skill still preserves the exact
correction in ask history before recording new production. When Phase N planning merely makes a parent PRD or task design
inaccurate without invalidating completed work, the client may update those returned parent
resources in Phase N's compound result instead of rewinding the entire task. If the change
invalidates earlier approved or implemented work, the explicit backward reopen is the safe path.
An already-open material-drift gate is distinct: if the human explicitly chooses its existing
`amend-upstream` option, gate resolution derives the affected planning target from authenticated
evidence and uses the same restart kernel. That is resolution of the sole open gate, not a direct
reopen bypass.

### R5. Intent-level inputs and server-derived integrity

Public inputs may contain only facts or judgment the client or human genuinely owns, including the
task identifier, explicit skill invocation/phase/intent, the original user ask, an exact
backward-reopening/correction request,
a produced-work outcome, review dispositions and rationales, verification observations, the
skill-authored summary used to open a human gate, an opaque server-issued choice, and the human's
reason.

When a task is created, the semantic initialization action must preserve the original ask verbatim
before it returns a PRD work window. Exact retry is idempotent; conflicting ask bytes fail closed.
The first PRD result remains the durable boundary that pins the ask for independent review.

The server must derive current phase and step, legal transition, expected revision, input
fingerprint, request and evidence digests, intent identity, canonical artifact slots, review policy
and routing, gate subject and origin, waiver bindings, successor phase, legal reopen target, and
target-and-downstream invalidation set from durable authority. It must reject stale or inapplicable
semantic actions with the current safe next action rather than asking the client to rebuild a
mechanical payload.

Every advertised input schema must have a plain object root, use nested variants only below that
root, include a purpose-level description, and stay compact enough that both supported clients can
select the intended tool without skill text teaching protocol fields.

### R6. Review, triage, and evidence integrity

The server-owned independent review action must derive the exact subject, pinned repository view,
rubric, producer/reviewer routing, and active constitution rules. One call may enter review,
dispatch the opposite-family rubric and constitution reviews, and atomically record their result,
because no producer judgment exists between those steps.

Claude Code or Codex must retain triage. It accepts only material defects, rejects non-material
preferences with evidence, submits that judgment, applies the separately offered production
re-entry, then owns accepted revisions and resubmission. Potentially material revisions invalidate
review evidence; only the existing one-hop editorial rule may retain it. Attempt exhaustion,
constitution results, material drift, and waivers remain visible human boundaries rather than
being resolved by an autonomous loop.

### R7. Human decisions are conversational, explicit, and nonblocking

When an ordinary human decision is required, status must first offer a gate-opening action that
expects the skill's human-readable summary. The server combines that submitted summary with
authenticated evidence and choices, opens the durable gate, and returns the completed presentation
instead of holding an MCP request open while a local file is polled. The presentation must explain
what is ready, why the decision matters, relevant evidence, the available choices, and each
consequence while keeping mechanical bindings hidden.

The skill discusses that presentation with the human. Only after the human chooses does the skill
call the semantic decision action with the server-issued choice and the human's reason. The server
re-authenticates the live subject and decision, records it, and returns the next semantic action.
It does not automatically resume client work. When the choice requires revision, decision recording
archives and closes only that gate, leaves production closed, and returns the separate
no-submission re-entry action; that later action alone derives the next fingerprint and opens the
write window. A lost decision response or fresh status must reconstruct the same action from the
authenticated archive and current transition. A waiver request and a later grant or denial remain
separate decisions because the latter supplies new authority. After a waiver is requested, status
must durably recover a separate, no-submission waiver-opening action—including after interruption.
That action derives the existing waiver summary (`Waiver request for <rule_id>`), rationale, rule,
scope, subject, evidence, and origin entirely from authenticated authority, opens exactly one
waiver gate, and returns its presentation. It must not ask the skill for another summary or to
reconstruct gate IDs, archive digests, the rule, or the waiver scope.

No approval, commit authority, waiver, or workflow advance may be inferred from silence, a model
verdict, or the existence of artifact bytes.

### R8. Client-owned Git and explicit hand-offs

Git remains a client action directed by the skill. MCP may derive and return the exact authorized
path, target ref, baseline, and message and may later verify the observed commit, but it must not
replace the client with a server coordinator that stages and commits an entire phase.

The semantic implementation workflow must not advertise those exact commit facts until its
authenticated read model actually supplies them. Extending that read model is part of the
implementation-workflow cutover; earlier phases may present only an honest generic legacy commit
instruction rather than fabricate missing values.

Existing trust rules remain unchanged:

- design artifacts are committed only under their exact approved design authority;
- implementation commit authorization remains bound to current verification, review evidence,
  truthful parent documents, implementation notes, and the exact scoped diff;
- the user sees and explicitly confirms an implementation commit before the client creates it;
- no phase advances until the server verifies the required authority and observed commit.

The completion action may collapse mechanical hand-off transitions after those prerequisites are
already true. After the client changes Git, one read-only status call may re-observe the commit and
return the now-legal hand-off; this is observation of an external client action, not redundant
polling after an MCP mutation. The hand-off must return the next skill rather than starting that
skill's work.

### R9. Durable resumption and semantic idempotence

After interruption, host restart, or a lost response, rerunning the applicable skill and invoking
semantic status must identify exactly one safe next action from durable truth. Reissuing an action
whose exact effect is already recorded must return the current view without duplicating reviews,
decisions, transitions, or commits. Conflicting content or judgment must fail closed and explain
what the skill should inspect or resubmit.

Each semantic mutation must derive a stable operation key from the accepted starting-offer binding,
authenticated repository/task identity, the semantic action family, its phase/attempt/subject, and
the canonical client submission. The key is not the volatile offer alone. The current compound
operations include review and, at decision cutover, archive-then-settle; each state-transaction
substep carries the same operation-key digest
in a distinct deterministic internal intent ID, so authenticated `last_transition` preserves that
compound correlation after transient receipts are cleaned. Existing receipts remain only the
within-substep crash buffer. Single-step actions continue to use their existing transaction or
immutable gate-archive replay authority.

Before rejecting an old offer as stale, the server must inspect the authenticated current position
and semantic intent carried by `last_transition`. An exact retry derives the original key from its
starting offer/submission; a fresh offer observed after interruption validates against current
status and resumes the authenticated key already carried by the preceding substep. Both converge
on the same first unfinished substep. Review accepts no client submission. Decision accepts one
submission only before its immutable archive exists; an archive-before-state continuation accepts
none and recovers the exact choice/reason from authority. Changed starting or single-step
submission bytes derive a different key and conflict with the recorded transition or gate archive.
No new coordinator or offer archive may provide this correlation.

The interval after a human revision decision and before production re-entry must be represented by
the immutable bound gate request/decision plus the authenticated current `last_transition`, not by
conversation or a disposable interface. Status must fail closed on a missing, stale, forged,
wrong-phase, or superseded binding and must never recreate the old open gate or infer writable
authority.

The earlier interval after decision-archive creation but before state settlement must likewise be
recoverable from the exact archive plus still-open matching gate. A semantic operation binding in
the existing human provenance may correlate the original call; a valid pre-facade archive may start
a new settlement-only operation. Neither case may re-prompt the human.

No in-memory coordinator, long-running job record, heartbeat, worker generation, or background
notification channel may be required to resume this client-driven workflow.

Every result manifest/payload kept live by active authority, current or archived pending human
revision, human-revision history, or restart history must remain in the same deduplicated retained-byte graph used for snapshot
creation, status accounting, and the task byte cap. Moving a reference from the active set to audit
history must never free quota while the bytes remain on disk; references shared with active,
human-revision, or other restart history count once.

A backward reopen is one semantic action over the canonical planning-restart transaction, not a
new coordinator or history model. Its offer binds the explicit invocation intent, requested earlier
skill and phase, authenticated current position, concrete invalidation impact, and expected
`reopening-request` submission. Its operation key also binds the exact request bytes and becomes a
stable restart identity across retries. Exact retry must converge on one restart-history entry and,
for PRD, one ask-history append; a changed request, different target, open gate, terminal task,
forward target, implementation target, or stale offer fails closed. The restart transaction may
clear authenticated active waivers and pending human revision only through its narrow validated
restart plan; generic transaction preservation checks must remain strict for every other action.
After interruption, the authenticated target position/resources and, for PRD, updated ask history
must be sufficient for the skill to resume without a public restart ID or caller-rebuilt binding;
the resulting PRD review must bind that updated ask.

### R10. Authority boundary, CLI, and cutover

After repository bootstrap, normal workflow-state mutations must enter through the semantic MCP
API used by the skills. The normal loop must not invoke `archflow-local build-request`, `envelope`,
`decide`, or another local command to construct an MCP payload, stage a live request, or write a
decision side channel.

The installed local helper may remain for repository initialization, installation/registration,
read-only degraded status, and explicitly bounded recovery that cannot run through a compatible
server. Pure request-derivation code may be refactored into internal services shared by handlers;
it must not remain a second normal workflow frontend.

The semantic facade must operate over existing valid durable state. During implementation the old
tools may remain available until all affected skills and journeys use their replacements. The final
cutover removes or unadvertises the old low-level mutation surface and obsolete normal helper
commands; it must not invent a durable migration layer unless real existing state proves one is
needed.

### R11. Skills and exceptional workflows

The PRD, design, phase-design, and phase-implementation skills must remain substantive
orchestrators. They own conversation, research/delegation, artifact production, implementation,
verification, triage, remediation, Git, and synthesis. Their MCP instructions name semantic
actions and how to respond to the returned view, not schemas, digests, staged references, or
transition triples.

`$archflow-status` uses the common semantic view. `$archflow-init` remains the bootstrap boundary,
and `$archflow-explore` remains repository documentation work. Constitution editing and legacy
upgrade keep purpose-specific human workflows; they may reuse the common status/decision shapes
but must not be forced through a universal task-lifecycle action. A dedicated diagnostic surface is
optional follow-up work unless removing normal request construction demonstrably requires it.

### R12. Documentation and verification

Every maintained caps-named page whose described behavior changes must be updated in the same
implementation change. The historical client-interface audit must remain recognizable as
point-in-time evidence; an explicit note may state that its autonomous-runner recommendation was
superseded, but its measurements must not be rewritten as current proof.

Verification must cover the public contract, semantic journeys, trust-boundary preservation,
interruption/replay, skill behavior, final catalogue, and the absence of the retired normal
choreography. Tests must prove both what the API does and what it deliberately does not do: start
or review calls cannot produce, triage, verify, commit, or advance a whole phase without the
required client work and human decisions.

## Delivery dependencies and design decisions

The implementation plan must resolve, in this order:

1. the exact semantic action set and compact common workflow view, mapped to every normal durable
   next action without exposing mechanical fields;
2. a direct server-side adapter from those actions to the existing status, production, transition,
   review, triage, gate, and commit-verification services;
3. a nonblocking MCP decision path over the existing durable gate archive;
4. client-owned artifact and implementation submission boundaries, including which substantive
   verification and changed-path facts the client must supply;
5. semantic idempotence and cutover behavior for tasks stopped at every existing durable
   checkpoint;
6. a bounded migration of the skills and local-helper surface, followed by retirement of old
   advertised tools only after representative journeys pass;
7. the final advertised catalogue size and first-call selection in Claude Code and Codex.

The design must prefer direct reuse of the current durable kernel over a new coordinator,
registry, job layer, compatibility system, or generalized action framework.

## Verification requirements

Acceptance evidence must include:

- generated-schema and contract tests for every semantic input and the common workflow view,
  including plain-object roots, purpose descriptions, compact reachable schemas, and the absence of
  public mechanical fields;
- a representative PRD, task-design, phase-design, and phase-implementation journey in which the
  client performs work between several semantic MCP calls and each response returns the next view;
- a no-findings journey that skips meaningless empty triage, requires a skill-authored gate
  summary, and still requires exact human approval;
- a remediation journey proving the client—not MCP—triages, revises, verifies, and resubmits, with
  a separate no-submission production re-entry after accepted triage or a human request for
  changes and fresh opposite-family review over changed bytes;
- a lost-response/fresh-status revision-decision journey proving the closed gate reconstructs one
  no-submission re-entry from immutable archives and the current transition; forged, stale,
  wrong-phase, non-reentry, or missing bindings fail closed, and exact re-entry happens once;
- human gate, waiver, significant-revision, design commit, implementation commit confirmation, and
  hand-off journeys preserving current authority, including waiver opening with no client summary;
- interruption and replay at each semantic boundary and between every named compound-action
  substep without duplicate review, transition, decision, or commit;
- decision crash cuts before/after immutable archive creation and state settlement, proving an
  exact archive plus still-open gate resumes as no-submission settlement, never a repeated prompt;
- existing durable checkpoints mapped to the same semantic next action without a new state
  migration when the bytes are already valid;
- negative tests that no task-lifecycle tool dispatches a producer, edits implementation code,
  runs verification, commits, or crosses into successor work;
- skill contract tests proving the clients still perform production/orchestration while low-level
  protocol vocabulary and normal `archflow-local` request construction are absent;
- real-host catalogue advertisement and representative first-call selection in authenticated
  Claude Code and Codex sessions after the final descriptors stabilize;
- the normal typecheck, generated-schema drift, unit, integration, contract, crash, bundle,
  SDK-boundary, and release checks.

Real-host evidence is intentionally limited to tool discovery/selection and representative
semantic calls. Multi-hour call lifetime, background notification, concurrent pause/cancel,
provider credential brokering, and write-worker containment are not requirements because this
design has no server-owned phase runner.

## Success criteria

The refactor is complete when all of the following are observable:

1. A user opens Claude Code or Codex, invokes the applicable skill, and that client visibly performs
   the work and coordinates several purpose-level MCP calls.
2. No public call performs a whole document or implementation phase autonomously.
3. A normal skill no longer constructs requests, stages references, carries revisions/digests,
   writes gate decisions through the CLI, or polls status after every successful mutation.
4. Every semantic call returns the common reconciled view and exactly one next action.
5. The client receives writable resources when work is required; MCP receives only the resulting
   semantic facts or judgment and derives all mechanical authority fields.
6. Independent reviews remain server-dispatched and opposite-family; triage, remediation, and
   verification remain client-owned, and no client revision begins until a separate semantic
   re-entry action has durably reopened production.
7. Exact artifact approvals, commit authorization, waiver boundaries, evidence freshness, task
   isolation, and phase ordering behave exactly as before unless separately approved.
8. An interrupted skill resumes from durable status without duplicated effects or a background
   coordinator, including the closed-gate interval between a request-changes decision and its
   separate production re-entry and the earlier archive-before-state settlement interval.
9. The normal post-bootstrap path uses no local request-building or decision side channel.
10. Old valid task state continues through the semantic facade; the low-level public tools retire
    only after the replacement journeys pass.
11. The final tool catalogue is compact, purpose-described, plain-rooted, and selects correctly in
    both supported clients without skill-authored protocol hints.
12. Maintained documentation, skills, schemas, and representative local/real-host tests describe
    the same client-orchestrated boundary.
13. From a later active phase, invoking an earlier PRD, design, or phase-design skill produces one
    human-explainable reopen offer; applying it preserves Git/worktree bytes, durably archives and
    invalidates target-and-downstream workflow evidence, restarts attempt 1 at that planning
    boundary, and requires fresh production, review, approval, and any applicable milestone commit;
    identical bytes cannot reuse pre-restart approval authority and archived result bytes remain
    inside the task retention cap.

## Assumptions

- Claude Code and Codex already provide the agent context, sub-agent facilities, shell access, and
  human conversation needed to remain the producer; ArchFlow need not recreate those facilities in
  the server.
- Existing durable transition, status, review, gate, commit-proof, and reconciliation services can
  be reused behind semantic handlers with focused refactoring.
- Phase 1 will add the focused planning-restart transition and optional restart-history authority
  needed by this branch, using the already validated phase-ordering and invalidation semantics;
  the semantic surface derives its target and hides every mechanical request field.
- The current server-owned counter-review dispatch is the only model dispatch this task needs.
- A semantic action can be idempotent by re-reading current durable authority and exact subject
  bytes; a public client-authored intent or digest is not inherently required.
- Direct replacement is appropriate after an in-repository transition period because ArchFlow is
  an open-source prototype; the restart-history addition is optional and backward-readable, so old
  valid tasks require no migration.
- The task-lifecycle surface is exactly `archflow_status` plus `archflow_apply`; bootstrap and
  purpose-specific constitution/upgrade adapters remain separate concerns rather than variants of
  a universal task action.

## Risks

- A nominally semantic tool may become a generic action multiplexer that merely hides the same
  state machine behind opaque variant names.
- Over-combining calls may recreate an autonomous runner; under-combining them may leave skills
  translating low-level transitions.
- Collapsing accepted triage or a request-changes decision into production re-entry can either
  cross the one-action boundary or let client edits begin before durable write authority. A
  separate no-submission revision action, an archive/transition-authenticated decision checkpoint,
  and lost-response journey tests must preserve that boundary.
- Treating an archived-but-unsettled decision as an ordinary open gate can ask the human to decide
  twice. Status must detect the exact archive first and expose only no-submission settlement;
  conflicting archives fail closed.
- A common view may omit a resource, finding, or client action the skill genuinely needs, forcing
  fallback status calls or internal-path reconstruction.
- Server/client version skew may still produce confusing failures unless every semantic response
  is self-describing and incompatible calls fail with one safe recovery direction.
- Removing staged request files changes replay behavior; semantic idempotence must be proven at
  each boundary rather than assumed.
- A nonblocking decision path can approve stale bytes if live gate and subject re-authentication is
  weakened during refactoring.
- Temporary coexistence of old and new surfaces can become permanent dual authority unless the
  cutover phase has explicit deletion criteria.
- Tool schemas can remain too large or ambiguous even with simpler inputs if internal result and
  error graphs stay reachable from the advertised catalogue.
- Skills may be shortened so aggressively that they stop directing the client work and human
  conversation the user explicitly wants them to own.
- Treating an earlier skill invocation as a simple mismatch could silently remove the current
  workflow's backward-reopen capability; reopen target, impact, exact request, replay, and fresh-review
  journeys must be covered before cutover.
- A PRD ask append or waiver-clearing restart could partially land if it is bolted onto generic
  mutation code. Stable restart identity, recoverable exact-once append tests, and a narrowly
  authorized preservation exception must prove crash safety without weakening other transitions.
- Retaining approvals and result payloads for audit can accidentally make old identical-byte
  approval current again or make archived bytes invisible to quota accounting. One shared
  restart-generation eligibility predicate and one deduplicated retained-result graph must govern
  every authority/storage consumer.
