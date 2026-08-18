# Phase 3 Design: Client-Driven Phase Implementation

## 1. Goal and phase boundary

Phase 3 completes the semantic migration of the normal producer lifecycle. The
phase-implementation workflow — producing an implementation output from client-owned code,
verification transcript, and implementation notes; independent review; triage; remediation;
commit authorization; the explicit commit confirmation; commit observation; successor hand-off;
and terminal task completion — becomes usable end to end through `archflow_status` and
`archflow_apply`, and `skills/archflow-phase-impl/SKILL.md` migrates onto that surface.

The ownership boundary is unchanged from Phase 2:

- Claude Code or Codex, directed by the active skill, remains the producer and orchestrator. It
  writes code and documents, delegates implementation chunks, runs every verification command,
  writes the raw transcript, performs same-side review, triages findings, revises and re-verifies,
  discusses human gates, stages and creates the authorized Git commit, and reports the successor.
- MCP derives and records durable authority, builds the implementation subject from the small
  client-owned declaration, dispatches only the existing opposite-family and constitution reviews,
  authenticates human decisions, observes the client-created commit, and executes exactly one
  server-offered semantic action per call.
- A semantic response always returns control at the next client or human boundary. No handler
  writes implementation code, runs a verification command, stages or commits Git, chooses triage,
  or starts successor work.

This is still the transitional six-tool release. The legacy four tools and the normal helper
commands remain available and unchanged for `$archflow-status`, the constitution and legacy-upgrade
workflows, degraded read-only status, seeded legacy checkpoints, and any task that chooses the
legacy path. Phase 3 does not migrate `skills/archflow-status/SKILL.md`, retire the four legacy
tools or `archflow-local build-request`/`envelope`/`gate-preview`/`decide`/`commit`, add
constitution or legacy-upgrade semantic adapters, or measure the final catalogue and real-host
first-call selection; those remain Phase 4 work as assigned by the approved task design.

No PRD correction is required. One parent-design correction is required and made in this same
production change: the `WorkflowViewV1` commit block carries `paths` (plural) rather than the
sketched singular `path`, because an authorized implementation commit is an exact sorted set of
repository paths, not one path. See Section 4.2.

## 2. Upstream requirements and observable outcome

| Upstream requirement | Phase 3 response | Observable evidence |
|---|---|---|
| PRD R1/R2: client owns work; one bounded semantic action per call | The implementation tier reuses the Phase 2 one-action executor, capabilities, and named substep plans with no new action kinds and no new substep codes; only review and decision run their fixed no-actor-boundary substeps. | Instrumented tests fail on producer dispatch, worktree/verification/Git execution by a handler, recursive apply, or consumption of a later offer. |
| PRD R3: every call returns one common view | Status and apply project `WorkflowViewV1` for `archflow-phase-impl` invocations exactly as for documents; every successful or recoverable apply result equals fresh status for the same invocation. | Implementation-tier status/apply parity tests at every boundary including refused submissions and commit observation. |
| PRD R4: implementation remains a visibly client-directed skill | The migrated skill directs implementation, verification, transcript capture, triage, remediation, human conversation, staging, explicit commit confirmation, and hand-off between several semantic calls. | Skill contract tests plus an end-to-end implementation journey with client work between calls. |
| PRD R5: inputs carry judgment, not mechanics | The implementation declaration carries only genuinely client-owned facts: `base_commit`, `outputs`, `restore_targets`, `declared_inputs`; the server derives every manifest, digest, scope, secret, accounting, and evidence field. | Generated-schema and submission-shape tests; no mechanical field is accepted. |
| PRD R6: review and triage integrity | The impl tier reuses the server-owned outer-FIFO review action; review subject and pinned transcript come from durable authority; triage and the separate `revise` re-entry behave as at the document tier. | Findings/no-findings/remediation journeys at the impl tier; no duplicate dispatch; no server-authored triage. |
| PRD R7: decisions conversational, explicit, nonblocking | Commit-authorization, constitution, material-drift, attempts-exhausted, and waiver gates open through `gate-summary` and resolve through the existing archive/settle machinery; `request-changes` on commit authorization stops at the close-only checkpoint before a separate `revise`. | Archive/settle recovery, checkpoint, waiver, and request-changes journeys at the impl tier. |
| PRD R8: client-owned Git, honest commit facts | The authenticated read model already carries the exact authorized implementation commit facts; Phase 3 projects them (plural `paths`, `requires_human_confirmation: true`) instead of the honest generic instruction, and the client stages, confirms, and commits; read-only status observes proof. | Commit-facts projection tests; a journey proving no server Git and observation only after the client commit. |
| PRD R9: durable resumption and idempotence | Implementation actions reuse the existing operation keys, `last_transition` correlation, replay, and archive recovery; commit observation is re-derived from durable authority on every read. | Crash/retry at each impl boundary, stale/forged offers, and commit-observation idempotence tests. |
| PRD R10/R11: bounded cutover, skills stay orchestrators | Only `archflow-phase-impl` migrates; the legacy path stays green; skill contract tests split the cohorts accordingly. | Updated skill-contract suite; legacy regression matrix stays green. |
| PRD R12 / task-design Phase 3 scope: docs and verification agree | Every maintained page whose implementation-workflow description changes is updated in the same change; the tracked release payload is regenerated once after all bytes stabilize. | Focused suites, full `npm run check`, release reproduction, and maintained-doc review pass. |
| Task-design reopen rule: impl can reopen earlier planning; impl is never a target | A phase-impl position is a legal current position for strictly earlier `reopen` offers from the document skills, and the invocation contract already forbids `reopen` intent on `archflow-phase-impl`. | Reopen-from-impl regression tests; contract test that phase-impl `reopen` does not parse. |

At exit, a user can invoke `/archflow-phase-impl <task> N` (or `$archflow-phase-impl`), watch the
client implement and verify between several bounded semantic calls, approve the commit
authorization, explicitly confirm the exact staged commit, reach successor readiness or terminal
completion through semantic hand-off — all with no normal request-building, staged references, or
local decision side channel.

## 3. Verified repository constraints and required corrections

### 3.1 Seams that remain authoritative

Verified against the current branch; Phase 3 builds on them without forking their rules.

- `ApplySubmissionV1`'s succeeded `work-result` variant already carries the optional
  `implementation` facts block (`src/contracts/semantic-workflow.ts:142-152`), and
  `composeProduce` in `src/state/request-composition.ts:228-276` already composes the
  phase-implementation produce: it rejects document facts at the impl tier, captures changed
  governing documents through `includeChangedImplementationDocuments`, and builds the full
  `ImplementationOutputV1` through `buildImplementationOutput` (`src/state/implementation-manifest.ts`).
- The semantic substep vocabulary already contains `start-next-skill` and `finish-task`
  (`SEMANTIC_SUBSTEPS`, `src/contracts/semantic-workflow.ts:204-208`); their request facts
  (`{kind:"advance"}`) are already composed by `composeAdvance`, which accepts both
  `advance-phase` and `complete-task`.
- The direct decision services from Phase 2 (`archiveDirectSemanticGateDecision`,
  `settleDirectSemanticGateDecision`, `enterDirectSemanticRevisionCheckpoint` in
  `src/state/gates.ts`) are gate-kind agnostic. `enactsReentry` already covers
  commit-authorization `revise`, material-drift `revise-current`, and attempts-exhausted
  `retry-once`/`revise`; `amend-upstream` already resolves through the Phase 1 planning-restart
  kernel.
- `deriveNextAction` already emits `commit-phase` with the exact authorized implementation commit
  facts (`commit_paths`, `commit_message`, `commit_target_ref`, `commit_baseline`) derived from the
  authenticated commit-authorization gate context (`src/state/next-action.ts:199-215`), and status
  already proves the client-created commit through
  `implementationOutputCommittedAtCurrentTarget` before exposing `advance-phase`/`complete-task`.
- The verification transcript stays a client-written file at
  `.archflow/runtime/tasks/<task>/cache/phases/<N>/verification.txt`, digested into
  `verification_evidence` by the output builder and re-checked by the pinned review context. The
  semantic surface changes none of this.
- Reopen targeting never yields a phase-implementation target
  (`planningTargetsBefore` in `src/state/semantic-status.ts`), and the invocation contract
  rejects `intent: "reopen"` for `archflow-phase-impl` (asserted in
  `test/contracts/semantic-workflow-contract.test.ts`).

### 3.2 Required corrections before the implementation tier goes live

1. **Activation fence.** `semanticInvocationEnabled` (`src/state/semantic-view.ts:66-70`) admits
   only the three document skills, `handleSemanticApply` refuses phase-impl invocations outright
   (`src/mcp/handlers/semantic.ts:232-234`), and the no-ownership detail appends the "supported
   legacy skill workflow" suffix (`src/state/semantic-view.ts:396-399`). Phase 3 admits
   `archflow-phase-impl` with `intent: "resume"` everywhere the fence is consulted and replaces
   the transitional refusal strings.
2. **Implementation commit facts projection.** The `commit-phase` projection deliberately declines
   commit facts today (`src/state/semantic-view.ts:286-291`). The authenticated read model
   already supplies them, so the projection must attach them — with the plural-path correction in
   Section 4.2 — and map a missing commit-authorization authority (`inspect-state`) to
   `blocked / inspect` rather than exposing invented facts.
3. **Submission-shape validation in both directions.** `composeProduce` requires implementation
   facts at the impl tier and rejects them at document tiers via thrown `TypeError`s that today
   escape `handleSemanticApply` as unhandled internal errors. Apply must validate the submission
   shape before composition in both directions: a facts-free document-style `work-result` at a
   phase-impl position, and a `work-result` carrying implementation facts at a document position,
   each return a semantic submission-mismatch failure with the fresh safe view — never a crash
   or a false success.
4. **Contract tests invert.** `skill-contract-canonical.test.ts` currently pins
   `archflow-phase-impl` to the legacy cohort (legacy producer requirements at lines 86-102, the
   legacy durable hand-off block at 216-226, and the predecessor hand-off block at 271-279), and
   the journey tests pin the phase-impl semantic fence (the closing fence in
   `semantic-document-journeys.test.ts:323-330` and the handler fence in
   `semantic-handlers.test.ts:26-48`). These expectations invert with the migration.

## 4. Pinned cross-chunk interfaces

### 4.1 Implementation invocation ownership

- `archflow-phase-impl` with `phase: N` and `intent: "resume"` becomes an enabled producing
  invocation in `semanticInvocationEnabled`. It can own its current `phase-impl-N` position and
  can consume a `start-next-skill` hand-off whose `target_phase_instance` is exactly
  `phase-impl-N` — the same exact-successor rule the document tier already enforces, so a
  finishing phase-design invocation reports the successor without an offer and only the newly
  invoked implementation skill receives the hand-off offer.
- `finish-task` (`complete-task`) is owned by the current final-phase implementation invocation
  through the ordinary position-ownership branch; no successor consumes it.
- A phase-impl invocation never receives a `reopen` offer (the contract forbids the intent), and
  the document skills' `reopen` offers remain legal while the task's active position is a phase
  implementation: the restart planner supersedes target-and-downstream authority as in Phase 1,
  and after such a restart the implementation invocation again consumes its own fresh hand-off
  through the normal loop.
- All existing ownership suppressions continue to win over the invocation: open gates, terminal
  state, reconciliation/repair findings, wrong phase, stale offers, and cross-repository reuse.

### 4.2 Public commit facts: plural `paths` and honest confirmation

The public commit block becomes:

```ts
readonly commit?: {
  readonly paths: readonly string[];
  readonly message: string;
  readonly target_ref: string;
  readonly baseline: string;
  readonly requires_human_confirmation: boolean;
};
```

- **Design milestones** project one entry: the task-local root already carried by
  `commit_path`, with `requires_human_confirmation: false`. Behavior is otherwise unchanged from
  Phase 2.
- **Implementation commits** project the exact sorted authorized path set (`commit_paths`),
  message, target ref, and baseline from the authenticated commit-authorization gate context, with
  `requires_human_confirmation: true`, and an instruction that names the two client steps: stage
  exactly the authorized paths, show the human the staged diff and message and obtain explicit
  confirmation, create the commit, then request fresh read-only status so the server observes
  proof.
- The singular `path` field is removed. This corrects the parent design's illustrative sketch
  (`.archflow/tasks/api-refactor/design.md` Section 4.1), which predated the pinned fact that an
  implementation commit authorizes a sorted set of paths; the parent design is updated in this
  same production change and the deviation is recorded here. The PRD's requirement — the exact
  authorized path scope, target ref, baseline, and message, never fabricated — is satisfied, not
  changed. The two Phase 2-migrated skills that stage `:(top,literal)<commit.path>` —
  `skills/archflow-design/SKILL.md` and `skills/archflow-phase-design/SKILL.md` — and the
  `skill-contract-canonical` expectations that pin that instruction are updated to the plural
  form in the same change, so no shipped skill ever references a removed field at the
  commit-scope step.
- `commit` remains a non-offerable client action (`canOffer` continues to exclude it). After the
  client commit, one read-only `archflow_status` reuses the existing Git proof and exposes the
  successor boundary — the owned `finish-task` offer at the planned final phase, or the
  `start-next-skill` report with no offer to this invocation at a non-final phase (Section 4.1);
  observation happens only after the external Git change, never as post-mutation polling.
- Missing or mismatched commit-authorization authority maps to `blocked / inspect` with the
  existing "inspect why the approved implementation commit authority is unavailable" direction.

### 4.3 Implementation work-result submission

The public submission stays exactly the existing shape — no new public field:

```ts
{ kind: "work-result", outcome: "succeeded",
  implementation: {
    base_commit, outputs, restore_targets, declared_inputs: [{ input_id, path }][] },
  human_revision?: HumanRevisionDeclarationV1 }
```

- These are the only facts the client genuinely owns. The server derives operations, blob
  identities, rename detection, snapshot/diff digests, parent-document bindings (with changed
  governing documents captured mechanically), secret scan, undeclared-change report, accounting,
  and `verification_evidence` from the transcript bytes — all inside the existing
  `buildImplementationOutput`.
- Apply validates, before composition, the submission shape in both directions: a `work-result`
  at a `phase-impl` position must carry `implementation` facts, and a `work-result` carrying
  `implementation` facts at a document position must be refused. Today the document-position
  direction is a thrown `TypeError` from `composeProduce` that escapes `handleSemanticApply` as
  an unhandled internal error; Phase 3 replaces both directions with a semantic
  submission-mismatch failure returning the fresh safe view.
- `{ kind: "work-result", outcome: "failed", reason }` records produce failure at the impl tier
  exactly as at the document tier.
- Review reads `phases/<N>/impl-notes.md` as the artifact with the retained co-produced documents
  and the pinned transcript; the skill keeps `impl-notes.md` and the transcript current as
  client-owned work.

### 4.4 Action plans at the implementation tier

No new action kinds and no new substep codes. The implementation tier uses:

| Action | Substeps | Notes |
|---|---|---|
| begin-work | `begin-work` | produce/running entry; identical to document tier. |
| submit-work | `submit-work` | single substep; carries the implementation declaration. |
| review | `review-enter`, `review-run`, (`triage-enter`, `review-empty-triage`) | existing fixed plans; empty review skips client triage and returns the gate-opening action. |
| triage | (`triage-enter`,) `triage` | exact finding coverage as today. |
| revise | `revise-enter` | after accepted triage or any re-entry decision; opens the write window only here. |
| decide | `open-gate` / `decision-archive`, `decision-settle` / `decision-settle` | kind-agnostic; covers commit-authorization, constitution, material-drift, attempts-exhausted. |
| open-waiver | `open-waiver` | derived entirely from authority. |
| start-next-skill | `start-next-skill` | successor phase-design N+1 hand-off. Reported without an offer to the finishing phase-impl invocation; the offer is owned and applied only by the newly invoked phase-design N+1 invocation (Section 4.1 exact-successor rule). |
| finish-task | `finish-task` | final planned phase only; terminal `complete / none` after. |
| commit | none (client Git) | facts returned, no offer; status observes proof. |

### 4.5 Commit authorization, explicit confirmation, observation, completion

The two human boundaries stay distinct, exactly as the task design requires:

1. **Durable authorization.** After review and triage reach the gate boundary, the skill submits a
   `gate-summary`; the server opens the `commit-authorization` gate with server-derived context
   (target ref, baseline, message, authorized paths, diff and artifact digests). The human's
   `authorize-commit` choice with a reason is recorded through `decision-archive` /
   `decision-settle` like every other decision. A `request-changes` choice settles to the
   close-only `semantic-revision-requested` checkpoint with no writable resources; the separate
   `revise` application alone re-enters production, after which the client fixes, re-verifies
   (fresh transcript), and resubmits.
2. **Explicit commit confirmation.** With authorization recorded and the commit observed-pending,
   the view returns the exact commit facts with `requires_human_confirmation: true`. The client
   stages exactly the authorized paths, shows the human the staged diff and the exact message,
   and waits for explicit confirmation. This confirmation is conversational and client-held; the
   durable record is the commit-authorization decision, and no second durable gate is invented.
3. **Observation and hand-off.** After the client creates the commit, one read-only
   `archflow_status` proves it through the existing implementation commit proof and returns
   `start-next-skill` (to phase-design N+1) or, at the planned final phase, `finish-task`.
   Under the Section 4.1 exact-successor rule these differ in ownership: at the planned final
   phase the implementation invocation owns and applies its `finish-task` offer and reports
   terminal completion; at a non-final phase the implementation invocation receives
   `start-next-skill` as a reported successor with no offer — it prints the
   `archflow-phase-design <task> N+1` command in both client forms and stops, and only the
   newly invoked phase-design N+1 invocation consumes that hand-off offer. The implementation
   skill never starts successor work.

The authorization→commit→observation sequence is idempotent under status re-reads: repeated
status calls re-derive the same facts from durable authority and never re-prompt, re-dispatch, or
re-observe a different commit.

### 4.6 Remediation and exceptional gates at the implementation tier

- **Accepted triage** returns the separate no-submission `revise`; the client re-enters
  production, fixes, re-runs verification, writes a fresh transcript, and resubmits. Fresh
  opposite-family review sees the changed subject; the existing evidence-freshness and
  fixed-point rules apply unchanged.
- **Attempts exhaustion** opens its gate after the fixed-point assessment; `try-review-again`
  (`retry-once`) and `request-changes` settle through the existing checkpoint machinery with
  their existing attempt semantics.
- **Material drift** during implementation review opens the material-drift gate;
  `update-earlier-work` (`amend-upstream`) resolves through the Phase 1 planning-restart kernel
  and moves the task to the upstream planning boundary, while `change-current-work`
  (`revise-current`) takes the close-only checkpoint and `revise` re-entry.
- **Constitution triggers** surface as constitution gates; `waiver-requested` returns the
  separate no-submission `open-waiver` whose summary, rule, scope, subject, evidence, and origin
  are fully server-derived; grant/deny is a later decision.
- All of these reuse Phase 2 machinery verbatim; Phase 3 adds only impl-tier journey coverage and
  any fence/ownership corrections the journeys expose.

### 4.7 Phase-implementation skill after cutover

`skills/archflow-phase-impl/SKILL.md` is rewritten to the proven semantic surface:

- calls `archflow_status` on entry with its exact `{skill: "archflow-phase-impl", phase: N,
  intent: "resume"}` invocation, consuming a pending hand-off or its current position;
- implements only within the approved phase design; keeps `impl-notes.md`, the writable parent
  documents, and the raw verification transcript current; delegates bounded implementation
  chunks to sub-agents as before;
- submits one `work-result` carrying the implementation declaration, invokes the offered review,
  performs client-owned triage, and applies the separate no-submission `revise` before editing;
- supplies the human-readable `gate-summary` for the commit-authorization gate, presents every
  choice, and records only the human's explicit token and reason; treats `waiver-requested` as
  non-approval and applies the separate `open-waiver`;
- after `authorize-commit`, stages exactly the returned `commit.paths`, shows the staged diff and
  exact message, obtains the explicit confirmation, creates the commit itself, then calls
  read-only `archflow_status` so the server observes proof;
- applies its own `finish-task` offer at the planned final phase and reports terminal completion;
  at a non-final phase it reports the `archflow-phase-design <task> N+1` successor in both
  client forms from the offer-free `start-next-skill` report and stops — it never applies a
  `start-next-skill` offer and never starts successor work (Section 4.1 exact-successor rule);
- contains no normal `archflow-local build-request`, `envelope`, staged reference, low-level
  transition triple, caller-authored digest, blocking gate call, local decision write, or
  `archflow-local commit`.

`skills/archflow-status/SKILL.md` remains unchanged on the legacy surface until Phase 4.

## 5. Deliverables and file scope

Focused edits at existing seams; no new registry, framework, or coordinator machinery.

### 5.1 Contracts and projection

- `src/contracts/semantic-workflow.ts` and generated
  `src/contracts/schemas/v1/semantic-workflow.schema.json`: commit block `path` → `paths`
  (sorted, non-empty); no other public shape change.
- `src/state/semantic-view.ts`: enable the implementation invocation; project implementation
  commit facts with confirmation semantics; replace the transitional refusal strings; map missing
  commit authority to `blocked / inspect`.
- `src/state/semantic-actions.ts` and `src/mcp/handlers/semantic.ts`: both-direction
  submission-shape validation before composition (facts-free at a phase-impl position;
  implementation facts at a document position); remove the apply-side fence.
- `.archflow/tasks/api-refactor/design.md`: correct the Section 4.1 commit sketch to `paths`
  (parent-document correction recorded in this design).

### 5.2 Tests

- Invert the fence expectations in `test/integration/semantic-document-journeys.test.ts` (the
  phase-impl hand-off becomes semantic) and `test/integration/semantic-handlers.test.ts`.
- New behavior-named implementation journey tests (e.g.
  `test/integration/semantic-implementation-journeys.test.ts`) using the existing journey harness,
  review stub, and real `buildImplementationOutput`, covering Sections 4.3-4.6 including crash
  cuts and commit observation.
- Extend `test/unit/semantic-view.test.ts` (commit-facts projection, ownership, inspect mapping),
  `test/unit/semantic-actions.test.ts` (both-direction submission validation), and
  `test/integration/semantic-composition-parity.test.ts` where new composition paths exist.
- Rewrite the `archflow-phase-impl` cohort blocks in
  `test/contracts/skill-contract-canonical.test.ts` from legacy to semantic expectations, and
  update the document-skill commit-instruction pins in the same file (the
  `:(top,literal)<commit.path>` expectation becomes the plural staging instruction).
- Keep the legacy implementation matrix green (`review-fixed-point-live.test.ts`,
  `state-gate-lifecycle` integration/crash, `local-commit.test.ts`,
  `implementation-output-builder.test.ts`, `secret-rejection.test.ts`,
  `state-next-action.test.ts`).

### 5.3 Skill, docs, and release payload

- `skills/archflow-phase-impl/SKILL.md` (Section 4.7). In the same change, the commit-staging
  instructions in `skills/archflow-design/SKILL.md` and `skills/archflow-phase-design/SKILL.md`
  move from the singular `commit.path` to the plural `commit.paths` (behavior-preserving wording
  only; their journeys and gates are untouched).
- Maintained pages whose implementation-workflow statements change:
  `docs/workflow/SKILLS.md`, `docs/workflow/LIFECYCLE.md`, `docs/mcp/SERVER.md`,
  `docs/state/DURABLE-STATE.md`, `docs/review/COUNTER-REVIEW.md`, `docs/TESTING.md`,
  `docs/COMPLEXITY.md`, `docs/PATTERNS.md`, `docs/cli/COMMANDS.md` (the helper remains; only its
  "last legacy producer skill" framing changes), and `docs/OVERVIEW.md` — its two-client-loop
  paragraph ("Phase implementation and `/archflow-status` still use `archflow-local status` /
  `build-request` and the four low-level tools") and its implementation-commit sentence
  ("Input-free `archflow-local commit` performs either authorized commit") both describe
  behavior Phase 3 replaces: implementation moves to the semantic surface, where the client
  stages the authorized paths, obtains the explicit confirmation, and creates the commit itself
  under `requires_human_confirmation`, while `archflow-local commit` remains for the legacy
  path. `docs/LIMITATIONS.md` only if an actual limitation claim changes.
- Regenerate the tracked `dist/` payload once after source, schema, skill, test, and
  documentation bytes are final.

## 6. Work chunks and ordering

### Chunk A: Enable the implementation invocation and project honest commit facts

1. Change the public commit block to plural `paths`; update the generated schema, the
   design-milestone projection, and the parent design sketch.
2. Admit `archflow-phase-impl / resume` in `semanticInvocationEnabled`; remove the handler-side
   refusal and the transitional detail suffixes.
3. Project implementation commit facts with `requires_human_confirmation: true`; map missing
   authority to `blocked / inspect`.
4. Update the commit-staging wording in the two document skills and their
   `skill-contract-canonical` pins so no skill references the removed field; update
   view/schema/unit tests.

Chunk A leaves the legacy four-tool path untouched; it does touch the two live semantic document
skills' commit instruction wording, which is why their expectations update in the same change.

### Chunk B: Implementation submission, review, triage, and remediation

1. Add impl-tier submission-shape validation in apply before composition.
2. Journey: begin-work → client implementation (files, impl-notes, transcript) → submit-work with
   the declaration → review (stubbed findings and no-findings) → triage → `revise` → fresh
   verification and resubmit.
3. Parity at every step; hostile/stale/cross-repository offer reuse at the impl tier.

### Chunk C: Commit authorization through terminal completion

1. Journey: gate-summary → commit-authorization presentation → `authorize-commit` decision →
   commit facts with confirmation flag → client stages/confirms/commits → status observes proof →
   `start-next-skill` to phase-design N+1, reported with no offer to the finishing
   implementation invocation (the offer belongs to the newly invoked phase-design N+1
   invocation), and, at the planned final phase, `finish-task` → `complete / none`.
2. `request-changes` → close-only checkpoint → `revise` → re-verification; attempts-exhausted,
   material-drift (`update-earlier-work` restart and `change-current-work`), constitution, and
   waiver branches at the impl tier.
3. Idempotence: repeated status between authorization, commit, and observation re-derives the
   same facts; reopen from an active phase-impl position to each earlier planning boundary; no
   reopen offer ever targets phase implementation.

Chunks B and C may proceed in parallel once A lands.

### Chunk D: Migrate the skill and contract tests, update docs

1. Rewrite `skills/archflow-phase-impl/SKILL.md` against the proven actions.
2. Move the skill to the semantic cohort in `skill-contract-canonical.test.ts`; rewrite the
   legacy-only expectation blocks.
3. Update every affected maintained page in the same change, including `docs/OVERVIEW.md`'s
   two-client-loop paragraph and implementation-commit sentence (Section 5.3).

### Chunk E: Final verification and tracked release bytes

1. Full focused matrix, then `npm run check`.
2. Regenerate the tracked release payload and run the release smoke/mutation/reproducibility
   gates.

## 7. Review and risk controls

- **Apply becomes a runner at the impl tier.** No new action kinds, substep codes, or
  capabilities are added; negative tests instrument producer/verification/Git boundaries and the
  returned next offer is never consumed.
- **Commit facts are fabricated.** Facts come only from the authenticated commit-authorization
  gate context; missing authority blocks with `inspect`, and the projection is table-tested
  against seeded authority-present and authority-absent states.
- **The plural-path contract edit strands the migrated document skills.** The design and
  phase-design skills' staging instructions and their contract pins move to `commit.paths` in the
  same change as the field rename, so no shipped skill references a removed field.
- **The two human boundaries collapse.** The confirmation flag stays `true` for implementation
  commits; journey tests require the client-held confirmation step between authorization and the
  commit, and no second durable gate is invented for it.
- **Implementation submission becomes a path-heavy protocol.** The public block stays at the four
  client-owned facts; everything else is derived; schema tests pin the shape.
- **Facts-free submission crashes the composer.** Apply validates submission shape before
  composition and returns a semantic failure with the fresh view.
- **Stale offers or cross-repository reuse reach the impl tier.** Existing offer binding covers
  it; impl-tier hostile tests re-prove it.
- **Observation is mistaken for polling.** Observation happens only after the external client
  commit; no post-mutation status is required after any apply.
- **Reopen from an implementation position regresses.** Regression tests reopen PRD, design, and
  each earlier phase-design from an active phase-impl position and prove downstream
  invalidation plus a clean fresh hand-off back into implementation.
- **Legacy behavior regresses.** The full legacy implementation matrix stays green; the legacy
  skill path remains functional for any task not yet migrated.
- **Skill migration strands recovery.** Journeys pass before the skill text changes; degraded
  read-only status remains documented; old tools remain advertised through Phase 4.
- **Docs or release bytes go stale.** Docs update in the same change; the payload regenerates
  once after all bytes stabilize.

No acceptance test may infer approval, create a commit, or advance a phase without the exact
human and durable authority the workflow already requires.

## 8. Success criteria

Phase 3 is complete only when all of the following hold:

1. The transitional catalogue is unchanged at six purpose-described tools; a phase-impl
   invocation receives real mutation offers, and no transitional "legacy workflow" refusal
   remains for it.
2. A complete implementation journey runs semantically: begin-work, client implementation and
   verification with a raw transcript, work-result declaration, review, triage, remediation
   through the separate `revise`, commit-authorization gate, explicit commit confirmation,
   client-created commit, observed proof, and the successor boundary — `start-next-skill`
   reported with no offer to the finishing implementation invocation at a non-final phase
   (the offer is consumed only by the newly invoked phase-design N+1 invocation), or the
   owned and applied `finish-task` at the planned final phase.
3. Every apply result equals fresh status for the same invocation at every implementation-tier
   boundary, including refused submissions and blocked inspect states.
4. Commit facts are exact and honest: plural authorized paths, message, target ref, baseline,
   `requires_human_confirmation: true`; missing authority blocks; no invented values; the design
   milestone projection carries one path with confirmation `false`.
5. `request-changes` on commit authorization settles to the close-only checkpoint, returns no
   writable resources, and requires the separate `revise` before edits; attempts-exhausted,
   material-drift (both choices), constitution, and waiver paths preserve current authority.
6. MCP performs no implementation edit, verification run, Git staging/commit, triage judgment, or
   successor start; tests instrument each boundary.
7. An interrupted implementation run resumes from durable status without duplicated reviews,
   decisions, transitions, or commit observations; stale, forged, wrong-phase, and
   cross-repository offers fail closed.
8. An active phase implementation can reopen each earlier planning boundary explicitly, and no
   reopen offer ever targets phase implementation.
9. `skills/archflow-phase-impl/SKILL.md` contains no normal helper request construction, staged
   reference, low-level transition choreography, blocking decision wait, local decision write, or
   helper commit command, while retaining implementation, verification, triage, remediation,
   human-conversation, Git, and hand-off responsibilities; the legacy path remains green.
10. Generated schemas, maintained docs, smoke bundles, and the tracked release payload describe
    the same behavior, and the full repository check passes.

## 9. Executable verification

Run focused checks during each chunk, then the full sequence after final bytes stabilize.

```bash
npm run typecheck
npm run generate:schemas
npm run check:schemas

npx vitest run \
  test/contracts/semantic-workflow-contract.test.ts \
  test/contracts/mcp-advertised-schema.test.ts \
  test/contracts/skill-contract-canonical.test.ts \
  test/unit/semantic-view.test.ts \
  test/unit/semantic-actions.test.ts \
  test/unit/mcp-tools.test.ts \
  test/integration/semantic-handlers.test.ts \
  test/integration/semantic-status-authority.test.ts \
  test/integration/semantic-composition-parity.test.ts \
  test/integration/semantic-document-journeys.test.ts \
  test/integration/semantic-implementation-journeys.test.ts \
  test/integration/review-fixed-point-live.test.ts \
  test/integration/state-gate-lifecycle.test.ts \
  test/crash/state-gate-lifecycle.test.ts

npm run test:mcp-runtime
npm run test:contracts
npm test
npm run build:temp
```

The implementation journey tests must cover, at minimum: the full clean journey with a stubbed
finding-free review; a findings journey with accepted triage, `revise`, fresh verification, and
resubmit; the commit-authorization gate with `authorize-commit`, the confirmation step, client
commit, observation, and both endings — the non-final `start-next-skill` successor reported with
no offer to the finishing implementation invocation (pinned by an explicit
`offer === undefined` expectation, matching the document-tier predecessor rule already asserted
in `semantic-document-journeys.test.ts`) and the owned `finish-task` ending;
`request-changes` → checkpoint → `revise`; attempts-exhausted, material-drift, constitution, and
waiver branches; facts-free and implementation-facts-at-document-position submission refusals;
stale/forged/cross-repository offers; crash cuts at every named substep boundary already covered
generically, plus authorization→commit→observation idempotence; reopen from an active
implementation position to each earlier planning boundary; and negative ownership
instrumentation (no producer, no verification, no Git, no successor start).

After source, schemas, skill, tests, and documentation are final:

```bash
npm run release:write
npm run check
```

`npm run check` must pass its normal SDK compatibility, typecheck, schema drift, MCP runtime,
unit, contract, bundle, notice, SDK-boundary, release smoke, mutation, and reproducibility gates.
Do not pull Phase 4's `$archflow-status` migration, exceptional adapters, legacy-tool retirement,
or real-host catalogue measurement into this phase.

## 10. Handoff

Implementation may begin only after this exact phase design is independently reviewed, explicitly
approved by the user, committed through the authorized task-local milestone, and durable status
advances to `phase-impl-3`. Phase 3 implementation must write its implementation notes, including
any actual deviation from these pinned interfaces and the final verification evidence. Phase 4
then owns the status-skill migration, exceptional adapters, legacy-surface retirement, and the
final host proof; it must not be started by Phase 3's semantic apply handler.
