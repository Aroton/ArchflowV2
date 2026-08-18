# Phase 4 Design: Exceptional Adapters, Retirement, Skills/Docs, and Final Host Proof

## 1. Goal and phase boundary

Phase 4 completes the cutover. The semantic boundary becomes the only normal documented
workflow: `$archflow-status` migrates onto read-only `archflow_status`, the legacy-upgrade
workflow gets the two narrow pieces it needs to leave the low-level surface (local atomic
adoption of a staged import, and a semantic `migration-audit` gate arm), the four low-level
tools leave the advertised catalogue, the normal helper choreography retires, the skill
contract tests invert, the maintained documentation set describes the client-orchestrated
boundary, the historical client-interface audit is annotated as superseded, and the final
catalogue is measured with representative authenticated host selection and journey evidence
in Claude Code and Codex.

The ownership boundary is unchanged:

- Claude Code or Codex, directed by the active skill, remains the producer and orchestrator
  for every workflow, including status reporting and legacy upgrade.
- MCP remains durable authority: it reconciles status, records results, dispatches the
  existing independent reviews, authenticates human decisions, and observes client commits.
  No new action kind, substep code, capability, or durable state shape is added by this
  phase. `archflow_apply` gains exactly one new gate-kind arm (`migration-audit`) through the
  existing generic `gate-summary`/`decide` machinery.
- The task-lifecycle surface stays exactly `archflow_status` + `archflow_apply`. Adoption of
  a staged legacy import stays a purpose-specific local adapter (`archflow-local upgrade`),
  never a task `archflow_apply` action — the task does not exist yet at adoption time.

Out of scope, unchanged from the task design: repository bootstrap/init, exploration,
constitution rule editing (verified below to need no adapter at all), any autonomous runner,
background control plane, or compatibility layer beyond what already shipped in Phases 1-3.

### 1.1 A correction the exploration forces

The task design says Phase 4 "adds the narrow constitution and legacy-upgrade semantic
adapters needed to retire their low-level dependencies." Verified against the pinned
repository bytes, the constitution skill has **no** low-level dependency to retire:
`skills/archflow-constitution/SKILL.md` names no MCP tool and no `archflow-local` command,
and `test/contracts/skill-contract-canonical.test.ts:103-111` pins exactly that
(`not.toContain("archflow-local")`, `not.toContain("archflow_")`). The only
`constitution-edit` gate producer in production code is `detectTaskLocalConstitutionEdit`
(`src/state/constitution.ts:165`), called only by the legacy-upgrade staging path
(`src/init/legacy-upgrade.ts:251`), which this phase covers through the upgrade adapter.
Constitution-review gates and waivers already work through the semantic `gate-summary` /
`decide` / `open-waiver` actions from Phase 2. So Phase 4 builds **no constitution adapter**;
the constitution skill and its contract stay byte-unchanged except for any catalogue-wide
test enumeration. This is a scope narrowing the task design explicitly permits ("may expose
a narrow validation adapter **if cutover needs one**" — `design.md` Section 3.5), recorded
here rather than as a parent-document correction.

### 1.2 Self-cutover of the implementing session

This task (`api-refactor`) has been driven end to end by the legacy installed skills — the
very choreography Phase 4 deletes. The phase-implementation session therefore cannot run on
the installed legacy skill and then delete it underneath itself. The pinned procedure:

1. The `/archflow-phase-impl api-refactor 4` session starts by reinstalling the repository
   skills (`bash install.sh`) so it runs the already-migrated semantic
   `skills/archflow-phase-impl/SKILL.md` against the currently installed server build (which
   already advertises the semantic pair).
2. It consumes the `phase-impl-4` hand-off through the semantic invocation and performs all
   workflow steps — including this phase's own design-milestone commit — through the
   semantic surface: the client stages the authorized task-local path and creates the commit
   itself; read-only `archflow_status` observes the proof.
3. Legacy deletion lands in the working tree as part of the phase's single authorized
   change; the session never needs the deleted paths afterward. `archflow-local
   manual-status`, `init`, `upgrade`, and the diagnostic commands survive for degraded and
   bootstrap use.

This dogfooding is also evidence: the live task must operate fully semantically before the
legacy paths are deleted, which is exactly the "old tools retire only after the replacement
journeys pass" rule applied to the last journey that matters — this one.

## 2. Upstream requirements and observable outcome

| Upstream requirement | Phase 4 response | Observable evidence |
|---|---|---|
| PRD R2/R3: one bounded action, common view | No new action kinds; the migration-audit gate uses the existing generic `gate-summary`/`decide` shapes; status skill reads the same `WorkflowViewV1`. | Contract and journey tests; no catalogue growth. |
| PRD R10: authority boundary and cutover | `ADVERTISED_TOOL_NAMES` shrinks to the semantic pair; normal `build-request`/`envelope`/`decide`/`gate-preview`/staged requests/`commit`/full `status` helper paths retire; `init`, `manual-status`, `upgrade`, diagnostics stay local. | Advertised-schema, smoke, and skill-contract suites pin the two-tool catalogue and the retired vocabulary's absence. |
| PRD R11: skills and exceptional workflows | `$archflow-status` becomes a read-only semantic consumer that never calls `archflow_apply`; `$archflow-upgrade` keeps its purpose-specific staging CLI and then uses the ordinary semantic review/decision/commit shapes; `$archflow-constitution` verified adapter-free and untouched. | Migrated skill texts; inverted contract tests; upgrade journey through the semantic surface. |
| PRD R7 (upgrade slice): decisions conversational and nonblocking | The one `migration-audit` gate opens through the skill-authored `gate-summary` and resolves through the existing `decision-archive`/`decision-settle` machinery; a `revise` choice uses the existing close-only checkpoint + separate `revise`. | Migration-audit journey with both choices and crash cuts. |
| PRD R8 (upgrade slice): client-owned Git | Migration-audit acceptance is the import-commit authority; the view returns exact commit facts (one task-local path, `requires_human_confirmation: false`, matching the established design-milestone rule); the client commits; status observes proof and reports the resume skill. | Commit-facts projection test; observation journey. |
| PRD R9: durable resumption | Adoption and the migration-audit arm reuse existing transaction/replay/archive machinery; staged-import restart classification stays in `manual-status`. | Replay tests at the adoption and gate boundaries. |
| PRD R12: documentation and verification | Every maintained page whose described behavior changes updates in the same change; the historical audit gets a status-line annotation only; final catalogue measured; real-host selection/journey evidence recorded under `docs/validation/`. | Full `npm run check`; updated docs; validation artifacts. |
| Task-design Phase 4 exit: no skill depends on an advertised low-level tool; catalogue/schema/host tests pass in both clients; docs describe client-owned orchestration | All nine skills audited; upgrade skill's low-level vocabulary removed; host proof per Section 8. | Inverted `skill-contract-*` suites; opt-in real-host suite results. |

At exit, a user invokes `/archflow-status`, `/archflow-upgrade`, or any producing skill and
every workflow — normal lifecycle, status reporting, and legacy adoption — runs through
`archflow_status`/`archflow_apply` plus the two retained local adapters (`init`,
`upgrade` staging/adoption) and the degraded `manual-status` ladder, with no
`archflow-local build-request`, `envelope`, `decide`, `gate-preview`, `commit`, or staged
reference anywhere in skill text, advertised tools, or maintained docs.

## 3. Verified repository constraints and required corrections

### 3.1 Seams that remain authoritative (verified at the pinned commit)

- `ADVERTISED_TOOL_NAMES` (`src/contracts/tool-names.ts:17`) spreads
  `[...TOOL_NAMES, ...SEMANTIC_TOOL_NAMES]`; shrinking it changes `tools/list`, the
  `TOOL_NOT_FOUND` gate (`src/mcp/server.ts:267`), and the protocol error enum
  (`src/contracts/errors.ts:109`) in one move. `TOOL_NAMES` itself stays: the four names
  remain durable-record vocabulary (`last_transition.tool`, gate archives, receipts) in
  existing state — retirement removes advertisement and handlers, not history.
- `handleState` and `handleCounterReview` are invoked directly by the semantic handler
  (`src/mcp/handlers/semantic.ts:188,200`); `openDurableGate` backs `openComposedGate` and
  `openComposedWaiver` (`semantic.ts:113,155`). These are internal services, not legacy
  surface; they survive retirement.
- Old-surface-only code, with no semantic caller (verified by import grep):
  `src/mcp/handlers/gate.ts`, `src/mcp/handlers/waiver.ts`, `runDurableGate`
  (`src/state/gates.ts:1469`), `src/state/gate-wait.ts` (sole caller `runDurableGate`),
  `src/state/gate-direct.ts` (sole callers the two retiring handlers),
  `rehydrateStagedToolCall` (`src/state/staged-requests.ts`, sole caller
  `src/mcp/server.ts:308`), `writeStagedRequest` (sole caller the retiring
  `src/local/build-request.ts:30`), the `envelope` CLI command, the `gate-preview` local
  wrapper (`src/local/gate-preview.ts`) and the shared `src/state/gate-preview.ts`
  preview machinery, and the `decide` command's `writeGateDecision*` path. The two
  gate-preview modules are consumed by retained `request-composition.ts`
  (`:37,48,662,672,776`) only inside the legacy gate/waiver decision branches (the
  `requested !== undefined` arms of `composeGate`/`composeWaiver` that serve the retiring
  `build-request` decision kinds), so their deletion removes those branches with them.
  **Not** in this list: `computeCallEnvelope`
  (`src/local/call-envelope.ts`) — it is shared request-digest derivation, imported by
  `src/state/request-composition.ts:47` and called by every `compose*` function
  (`:214,321,343,367,480,509,680,703`), so only its CLI command wrapper retires.
- `composeGate` (`src/state/request-composition.ts:516+`) derives
  commit-authorization/design-approval/artifact-approval/constitution-review/
  attempts-exhausted/material-drift — but never `migration-audit`, even though
  `deriveNextAction` already emits `open-gate` with `gate_kind: "migration-audit"`
  (`src/state/next-action.ts:312-314`) and `openDurableGate` deep-validates the
  migration-audit context (`src/state/gates.ts:323-395`). The semantic gate path is one
  composer arm away from covering upgrade.
- `composeInitialize` (`src/state/request-composition.ts:205-227`) composes only a fresh
  `task-initialization` at `prd`; the `legacy-import-initialization` artifact arm lives in
  `runStateInitialization` (`src/state/initialization.ts:70-253`), which **already** reads
  the staged legacy config itself (`src/state/initialization.ts:252-256,290`) — so a local
  adopt subcommand over that transaction inherits the fallback with no new code. The old
  handler's session opener carries a second copy
  (`src/mcp/handlers/session.ts:47-53`) that simply deletes with its retiring handler.
- `archflow-local upgrade` (`src/init/legacy-upgrade.ts`) already owns
  preview/stage/discard-stage with `approved_preview_digest` binding, constitution-edit
  detection, and staging under ignored runtime; `manual-status`
  (`src/local/status-classification.ts`) already classifies
  `upgrade-staged`/`upgrade-restart-required`.
- The real-host harness pattern exists: `ARCHFLOW_REAL_HOSTS=1` opt-in with `claude`/`codex`
  auth probes (`test/helpers/real-host.ts`), digest-bound measurement recorded under
  `docs/validation/` with a thresholds sidecar (`test/real-host/review-benchmark.test.ts`),
  and an install-into-scratch-home template (`test/real-host/terminal-journey.test.ts`).
  No existing test drives a real host as an MCP client — that suite is new.
- `docs/validation/client-interface-audit.md` is consumed by no test or script; its
  `**Status:**` header line (line 3) is the annotation point. Nothing parses it, so the
  annotation is prose-only and the measured numbers stay untouched.

### 3.2 Required corrections before retirement can land

1. **Semantic migration-audit arm.** Add the `migration-audit` arm to `composeGate` and the
   semantic view mapping, deriving the gate request from the same
   `facts.migration_audit` authority the legacy `request-templates.ts:179-191` template
   used, with `openDurableGate`'s existing deep validation unchanged. Without it, an
   imported task wedges at its review boundary the moment `archflow_gate` retires.
2. **Local atomic adoption.** Extend `archflow-local upgrade` with an `adopt` subcommand
   that runs the existing `runStateInitialization` initialization transaction locally over
   the staged `legacy-import-initialization` artifact. That transaction already reads the
   staged legacy config (`src/state/initialization.ts:252-256`), so adopt inherits the
   fallback and the session-opener copy deletes with its retiring handler. Adoption stays
   mechanical: the
   human approvals that gate it are the preview approval (before `stage`) and the later
   `migration-audit` gate.
3. **Status-skill transport.** `skills/archflow-status/SKILL.md` currently drives
   `archflow-local manual-status` (its only helper call). It must call read-only
   `archflow_status` (`task_id`, no invocation → no mutation offer) as the primary path and
   demote `manual-status` to the degraded/unavailable ladder, including staged-import
   classification when semantic status reports the task missing.
4. **Contract-test inversion.** `skill-contract-canonical.test.ts`'s negative vocabulary is
   scoped to the semantic producer cohort (lines 180-196) while `archflow-upgrade` still
   pins `archflow_state`/`archflow_gate`/`envelope`/`build-request` strings and
   `skill-contract-upgrade.test.ts` checks against the low-level `TOOL_NAMES`
   (lines 31-41). After `ADVERTISED_TOOL_NAMES` shrinks, the canonical allow-list itself
   rejects any skill naming a retired tool — the cohort split collapses to "no skill names
   them" — and the upgrade contract's pinned choreography strings invert to the
   adapter-plus-semantic flow.
5. **Script and smoke pins.** `scripts/smoke-release-bundle.mjs` hard-codes the six-name
   `tools/list` expectation (~lines 133-138) and moves to the semantic pair;
   `scripts/probe-mcp-sdk-compatibility.mjs` probes with `archflow_state` and moves to
   `archflow_status`. `scripts/smoke-temp-bundle.mjs` pins no `tools/list` result — its
   tool assertion is the four-name `TOOL_DEFINITIONS` durable-contract pin (~lines 77-82),
   which survives retirement unchanged because the durable request contracts stay
   (Section 4.1).
6. **Request templates retire.** `src/state/request-templates.ts` guidance (which instructs
   `build-request`/`envelope` and verbatim old-tool calls) and the full `archflow-local
   status` command that serves it lose every consumer once the status skill migrates; the
   task design's retirement condition ("once all semantic composers cover every emitted
   action") is met exactly when correction 1 lands. `NextAction`'s prefilled `request`
   projection and the `STAGED_REQUEST_NOT_FOUND`/`STAGED_REQUEST_MISMATCH` error kinds'
   build-request next-actions go with them, and `APPROVAL_ARTIFACT_KINDS` — which retained
   `request-composition.ts:42,658` imports from the templates module — relocates into the
   retained composition code rather than being deleted; `computeTaskStatus`,
   `deriveNextAction`, and the `--brief`-free `manual-status` classification stay.

## 4. Pinned cross-chunk interfaces

### 4.1 Advertised catalogue after cutover

- `ADVERTISED_TOOL_NAMES = [...SEMANTIC_TOOL_NAMES]` — exactly `archflow_status` and
  `archflow_apply`, both purpose-described, plain-object-rooted, from the existing semantic
  schema fragments. `ADVERTISED_TOOL_CATALOGUE` drops the legacy branches
  (`legacySchemaFragment`, `mergedInputFragment`, the legacy `ADVERTISED_ERROR_SUMMARY`
  substitution in `src/mcp/tools.ts`).
- `TOOL_NAMES` remains exported as durable vocabulary for reading and writing existing
  state records; nothing advertises or dispatches it.
- The server tool boundary keeps the semantic arm and classifies everything else
  `TOOL_NOT_FOUND`; the versioned/staged-reference input classification
  (`classifyVersionedArgs`, staged rehydration) is deleted with its only callers.
- `handleState` and `handleCounterReview` remain registered as internal services invoked by
  the semantic handler; the MCP-facing `handleGate`/`handleWaiver` handlers and their
  waiting machinery (`runDurableGate`, `gate-wait.ts`, `gate-direct.ts`) are deleted.
- Generated schemas regenerate: advertised-descriptor schema changes, `project-error`
  schema loses the staged-request kinds, `mcp-tools` schema keeps the durable request
  contracts (still the internal request vocabulary) minus advertised-descriptor metadata
  that no longer has a consumer.

### 4.2 Legacy-upgrade workflow after cutover

Pinned sequence for `skills/archflow-upgrade/SKILL.md`:

1. **Preview and stage (local adapter, unchanged mechanics).** `archflow-local upgrade
   preview` with the full legacy descriptor; human approves the exact preview; `stage`
   with `approved_preview_digest`; `discard-stage` for pre-adoption fixes. Constitution-edit
   and secret findings still block staging.
2. **Adopt (local adapter, new subcommand).** Input-free `archflow-local upgrade adopt
   --task <task>` runs the existing initialization transaction over the staged artifact,
   atomically publishing `config.yaml`, `state.json`, `prd.md`, `design.md`, and mapped
   phase documents. Adoption is retry-safe through the existing transaction/replay
   machinery; an unexpected staged-bytes mismatch fails closed. No MCP call and no task
   exist before this point, so nothing about `archflow_apply` changes.
3. **Semantic review and audit gate.** The skill then drives the ordinary semantic surface
   with the `archflow-design` resume invocation: submit the imported design unchanged as
   the produce result, run the offered independent review, triage findings, and open the
   one `migration-audit` gate through `gate-summary` — the new composer arm, resolved by
   the existing `decision-archive`/`decision-settle` substeps. A `revise` choice takes the
   existing close-only checkpoint and separate `revise` re-entry, then fresh review; the
   imported-task significant/simple revision classification behaves as at every other gate.
4. **Import commit and resume.** `migration-audit` acceptance is the import-commit
   authority. The view returns the exact commit facts — the single task-local root as the
   one-element `paths` list, server-derived message/target/baseline,
   `requires_human_confirmation: false`, matching the established design-milestone rule
   (the old input-free `archflow-local commit` performed the same authority, and the
   shipped upgrade skill already instructs "Do not ask for a second commit confirmation";
   PRD R8's explicit pre-commit confirmation governs implementation commits, not import
   milestones). The client stages exactly the authorized path and creates the commit;
   read-only `archflow_status` observes proof and returns the server-derived resume
   skill, matching the shipped `deriveResumePhase` derivation
   (`src/init/legacy-upgrade.ts:140-161`): `archflow-phase-impl <task> N` when phase N
   has a mapped design and no implementation log (the imported design already exists, so
   implementation is next); otherwise `archflow-phase-design <task> N` for the next
   phase without a mapped design. The rewritten skill preserves the shipped sentence
   verbatim.
   **Parent-design correction:** the task design's Section 3.5 upgrade diagram sketched a
   third "Human confirms the commit" diamond and a "commit confirmation" entry in its
   closing decisions sentence. That sketch predates the pinned milestone rule; the parent
   design is corrected in this same production change (the diamond is removed and the
   sentence names preview approval and migration-audit acceptance as the distinct
   decisions, with acceptance as the commit authority), and the deviation is recorded
   here.
5. **Degraded ladder.** Server unavailable → read-only `manual-status` classification
   (which still detects `upgrade-staged`/`upgrade-restart-required`), stop, reinstall.
   Staging and adoption never require the server.

The upgrade skill text names only: `archflow-local upgrade` (preview/stage/discard-stage/
adopt), `archflow_status`, `archflow_apply`, and `archflow-local manual-status` degraded.
Its contract test pins move accordingly, including the frozen header and the
`--task <task>` requirement on every `archflow-local` snippet.

### 4.3 Status skill after cutover

`skills/archflow-status/SKILL.md`:

- keeps its task-selection rule (list `.archflow/tasks/` directories itself when no task is
  named; never asks a helper to enumerate);
- calls read-only `archflow_status` with `{schema_version, task_id}` and **no invocation** —
  the generic read that returns the reconciled view with no mutation offer — and renders
  condition, headline/detail, and the one next action, printing the successor in both
  client forms from `next_action.skill`/`skill_args` exactly as today;
- renders an open-gate `presentation` with one direct question and never resolves, records,
  or calls `archflow_apply`;
- falls back to `archflow-local manual-status` when the MCP server is unavailable, and also
  when semantic status reports the named task missing/unreadable — that is how a staged,
  not-yet-adopted legacy import (`upgrade-staged`) stays visible; the five manual
  classifications and their directions are unchanged;
- never names `archflow_state`/`archflow_counter_review`/`archflow_gate`/`archflow_waiver`,
  `build-request`, `envelope`, `decide`, `gate-preview`, or `commit`.

### 4.4 Retired local surface

| Retired | Kept (local) |
|---|---|
| `archflow-local build-request` (+ staged-request write/rehydrate machinery) | `archflow-local init` |
| `archflow-local envelope` (CLI command only; `computeCallEnvelope` stays as the shared request-digest derivation) | `archflow-local manual-status` (degraded read-only classification) |
| `archflow-local decide` (+ disposable decision-interface write path) | `archflow-local upgrade` preview/stage/discard-stage/**adopt** |
| `archflow-local gate-preview` (+ `state/gate-preview.ts` when no consumer remains) | `validate`, `hash`, `render`, `snapshot`, `restore`, `clean`, `reconcile` (diagnostics and bounded recovery) |
| `archflow-local commit` (clients commit from semantic facts) | |
| `archflow-local status` (full template-driven projection; `request-templates.ts` and the prefilled `NextAction.request` retire with it) | |

`LOCAL_COMMANDS` and `docs/cli/COMMANDS.md` reflect the survivors; every surviving command's
prose is scrubbed of retired vocabulary. The `channel: "archflow-local"` provenance values in
durable contracts remain readable history and are untouched.

### 4.5 Contract-test inversion

- The canonical allow-list (`archflow-local <cmd>` ∈ `LOCAL_COMMANDS`, `archflow_*` ∈
  `ADVERTISED_TOOL_NAMES`) becomes the global enforcement: with the catalogue at two tools,
  any skill naming a retired tool fails the contract, cohort or not.
- The `semanticProducerSkills` cohort block's positive pins (resume invocations, offer
  submission, `commit.paths`, triage vocabulary) extend to the migrated `archflow-status`
  (read-only pins: `archflow_status` with no invocation, no `archflow_apply`) and the
  rewritten `archflow-upgrade` (adapter + semantic choreography pins). The legacy cohort
  expectations are deleted — there is no legacy cohort.
- `skill-contract-upgrade.test.ts` re-pins against `ADVERTISED_TOOL_NAMES`, replaces the
  `archflow_state`/`archflow_gate`/`envelope`/`build-request` choreography strings with the
  Section 4.2 pins, and keeps the enumeration/outage-ladder requirements.
- `skill-contract-server-outage.test.ts` keeps `manual-status` as the only manual helper and
  updates the archflow-status primary-driver pin from the CLI string to `archflow_status`.

### 4.6 Final catalogue measurement and host proof

- `test/contracts/mcp-advertised-schema.test.ts` pins exactly two tools, their names, plain
  roots, descriptions, and a byte budget for `JSON.stringify({tools: ADVERTISED_TOOL_CATALOGUE})`;
  the assertion records the measured final size in its comment alongside the historical
  1,316,997-byte unpruned and 105,478-byte four-tool figures.
- A new opt-in real-host suite (gated by the existing `ARCHFLOW_REAL_HOSTS=1` +
  auth-probe helper, outside `npm run check` per `repository-boundary.test.ts`) drives each
  authenticated host as an MCP client against the installed bundle in a scratch home:
  1. **Advertisement**: the host's tool list contains exactly the two semantic names.
  2. **First-call selection**: given a scratch task and a plain-language status question,
     the host's first ArchFlow tool call is `archflow_status` — no skill-authored protocol
     hints in the prompt.
  3. **Representative journey slice**: initialize the scratch task semantically
     (`initialize-task` with a `task-ask`) and reach `begin-work`/`submit-work` through the
     host, proving end-to-end semantic calls in both clients.
  Results land under `docs/validation/` as a digest-bound JSON artifact with a thresholds
  sidecar (the review-benchmark pattern) plus a short operator runbook entry, so the
  evidence is reproducible without being a CI dependency.

### 4.7 Maintained docs and the historical audit

Every caps-named page whose described behavior changes updates in the same change. Verified
current stances and the cutover edit:

- Heavy: `docs/OVERVIEW.md` (6-advertised/4-durable framing, two-client-loops paragraph),
  `docs/mcp/SERVER.md` (catalogue section, staged-request boundary, status-skill note),
  `docs/cli/COMMANDS.md` (build-request/envelope/decide/gate-preview choreography,
  "last legacy producer path" framing), `docs/workflow/LIFECYCLE.md` (dual-track contrasts,
  "where this is heading"), `docs/workflow/SKILLS.md` (per-skill migration split,
  compose-don't-transcribe conventions), `docs/contracts/CONTRACTS.md` (tool-contract
  cluster, "three document-producing workflows" phrasing), `docs/COMPLEXITY.md`
  (transitional-duplication audit sections), `docs/TESTING.md` (suite inventory, six-name
  smoke pin).
- Moderate: `docs/review/COUNTER-REVIEW.md` (legacy gate choreography halves),
  `docs/state/DURABLE-STATE.md` (legacy-path contrasts, staged-request layout notes).
- Minor: `docs/DEPENDENCIES.md` (six-tool paragraph), `docs/PATTERNS.md` (example names),
  `docs/mcp/DISPATCH.md` (legacy-call sentence), `docs/LIMITATIONS.md` only if a claim
  changes.
- `docs/validation/client-interface-audit.md`: extend the header `**Status:**` line to
  record that the choreography measurements stand as point-in-time evidence and that the
  autonomous-runner recommendation was superseded by the implemented client-orchestrated
  two-tool surface; body bytes untouched.
- `docs/validation/real-host-journeys.md` operator runbook gains the host-selection
  journey; `README.md` and the `CLAUDE.md`/`AGENTS.md` docs-tree captions are updated if
  they name retired vocabulary (the two guidance files stay byte-identical to each other).

## 5. Deliverables and file scope

### 5.1 Upgrade adapter (source)

- `src/init/legacy-upgrade.ts`: `adopt` subcommand over `runStateInitialization`, which
  already reads the staged legacy config (`src/state/initialization.ts:252-256`) — no
  fallback is added; the session-opener copy at `src/mcp/handlers/session.ts:47-53`
  deletes with its retiring handler.
- `src/local/commands.ts` + `src/local/main.ts`: register `upgrade adopt`; contracts and
  `LOCAL_COMMANDS` update.
- `src/state/request-composition.ts`: `composeGate` gains the `migration-audit` arm from
  `facts.migration_audit` (parity with the legacy template's derived fields).
- `src/state/semantic-view.ts`: map the migration-audit gate position to
  `awaiting-client / decide` expecting `gate-summary`, and the import-commit milestone to
  the existing one-path commit-facts projection.

### 5.2 Retirement (source)

- `src/contracts/tool-names.ts`, `src/contracts/errors.ts`,
  `src/contracts/mcp-tools.ts` (advertised metadata only), `src/mcp/tools.ts`,
  `src/mcp/server.ts`, `src/mcp/handlers/index.ts`.
- Delete: `src/mcp/handlers/gate.ts`, `src/mcp/handlers/waiver.ts`,
  `src/state/gate-wait.ts`, `src/state/gate-direct.ts`, `runDurableGate` in
  `src/state/gates.ts`, `src/state/staged-requests.ts`,
  `src/local/build-request.ts`, `src/local/gate-preview.ts` and
  `src/state/gate-preview.ts` (together with their only retained call sites — the
  `requested !== undefined` legacy decision branches in `composeGate`/`composeWaiver` in
  `src/state/request-composition.ts`), the `envelope`, `decide`, `commit`, and full
  `status` CLI commands, and `src/state/request-templates.ts` (with the prefilled
  `NextAction.request` projection and the staged-request error kinds' next-actions;
  `APPROVAL_ARTIFACT_KINDS` relocates into the retained composition code). The `envelope`
  and `status`
  retirements remove only their command wrappers: `computeCallEnvelope`
  (`src/local/call-envelope.ts`) stays — it is the request-digest derivation every retained
  `compose*` function calls. Shared request composition (`composeRequest`), `handleState`,
  `handleCounterReview`, `openDurableGate`, the direct decision services, and
  `computeTaskStatus`/`deriveNextAction` remain.
- `scripts/probe-mcp-sdk-compatibility.mjs` (probe tool moves to `archflow_status`) and
  `scripts/smoke-release-bundle.mjs` (six-name `tools/list` expectation moves to the
  semantic pair). `scripts/smoke-temp-bundle.mjs`'s four-name `TOOL_DEFINITIONS` pin stays:
  it asserts the durable request contracts, which survive (Section 4.1).
- `.archflow/tasks/api-refactor/design.md`: correct the Section 3.5 upgrade diagram and its
  closing decisions sentence per the parent-design correction in Section 4.2 step 4.
- Regenerate `src/contracts/schemas/v1/*`.

### 5.3 Skills and contract tests

- Rewrite `skills/archflow-status/SKILL.md` (Section 4.3) and `skills/archflow-upgrade/
  SKILL.md` (Section 4.2). No other skill text changes.
- Invert `test/contracts/skill-contract-canonical.test.ts`,
  `test/contracts/skill-contract-upgrade.test.ts`,
  `test/contracts/skill-contract-server-outage.test.ts` (Section 4.5).
- Update `test/contracts/mcp-advertised-schema.test.ts`,
  `test/contracts/mcp-contract-agreement.test.ts`, and every suite that pins six tools,
  staged requests, or legacy handler dispatch; keep the semantic journey matrix and the
  legacy-seeded checkpoint projections green (existing durable state must still map).

### 5.4 New tests

- Migration-audit semantic journey: adopt → submit imported design → review (stubbed,
  findings and no-findings) → triage → `gate-summary` → migration-audit presentation →
  `accept` → import commit facts → client commit → status observation → resume skill;
  `revise` choice → checkpoint → `revise` → fresh review; crash cuts at the adoption
  transaction and the gate archive/settle boundary; staged-bytes tamper fails closed.
- Retirement negatives: `tools/list` advertises exactly the pair; calls to retired names
  fail `TOOL_NOT_FOUND` with the safe view; no staged-request rehydration path exists;
  the deleted CLI commands are absent from `LOCAL_COMMANDS` and reject at the CLI entry.
- Status-skill semantic path: no-invocation read returns no mutation offer; task-missing
  fallback classification preserved.
- Real-host selection/journey suite (Section 4.6) + validation artifacts.

### 5.5 Docs and release payload

- Section 4.7 page set; audit annotation; runbook entry.
- Regenerate the tracked `dist/` payload once after all bytes stabilize; reinstall with
  `bash install.sh` (self-cutover, Section 1.2) before the phase's own milestone commit.

## 6. Work chunks and ordering

### Chunk A: Upgrade adapter and migration-audit arm

1. `composeGate` migration-audit arm + semantic-view mapping + unit/parity tests.
2. `archflow-local upgrade adopt` with the relocated staged-config fallback; replay and
   tamper tests.
3. Migration-audit semantic journey (Section 5.4) against a staged fixture.

Chunk A is independently verifiable and leaves the six-tool catalogue intact.

### Chunk B: Status skill migration

1. Rewrite `skills/archflow-status/SKILL.md` onto `archflow_status` with the
   manual-status fallback ladder.
2. Status-skill semantic-path tests; update the server-outage contract pin.

Also independently verifiable; the full `status` command still exists at this point.

### Chunk C: Retirement

1. Shrink `ADVERTISED_TOOL_NAMES`; delete the old-only handlers, waiting machinery,
   staged requests, envelope/gate-preview/decide/commit/status commands, and request
   templates (Section 5.2); regenerate schemas.
2. Update scripts, advertised-schema/contract-agreement suites, and every six-tool pin.
3. Retirement-negative tests (Section 5.4).

Requires A (migration-audit arm) and B (no remaining `status`-command consumer). This is
the chunk that performs the self-cutover reinstall first (Section 1.2).

### Chunk D: Skills, contract inversion, docs, audit annotation

1. Rewrite `skills/archflow-upgrade/SKILL.md`; invert the three skill-contract suites.
2. Update the Section 4.7 maintained pages and annotate the audit.

Requires C (the vocabulary being asserted against is gone).

### Chunk E: Final measurement, host proof, release

1. Catalogue byte measurement and budget pin.
2. Real-host selection/journey suite + `docs/validation/` artifacts + runbook.
3. Full `npm run check`; `npm run release:write`; release smoke/mutation/reproducibility;
   reinstall; the phase's own client-side milestone commit and status observation.

## 7. Review and risk controls

- **An imported task wedges at its gate.** The migration-audit composer arm lands in Chunk
  A, before any retirement in Chunk C, and the journey proves the gate opens and resolves
  semantically while the old tools still exist — the "replacement journeys pass before old
  tools retire" rule applied literally.
- **Adoption via CLI becomes a second workflow frontend.** It is one subcommand reusing the
  existing initialization transaction; the task does not exist yet; everything after
  adoption is ordinary semantic surface. The upgrade contract test pins that the skill names
  no other local mutation path.
- **Retirement breaks existing durable tasks.** Durable vocabulary (`TOOL_NAMES`, gate
  archives, provenance channels) is untouched; the semantic snapshot already projects every
  seeded checkpoint (Phase 1); the legacy-seeded projection matrix stays green through
  Chunk C.
- **Retirement strands the implementing session.** Section 1.2's reinstall-first procedure
  is pinned; the session's own milestone commit uses the semantic client-git path, and
  `manual-status` survives as the degraded ladder.
- **Deleted commands orphan shared code.** Each deletion is justified by the verified
  sole-caller inventory (Section 3.1); anything that gains a consumer during implementation
  stays and the deviation is recorded in impl notes.
- **Contract-test inversion loosens enforcement.** The allow-list becomes stricter, not
  looser: with two advertised names, any retired-tool mention anywhere fails globally; the
  upgrade skill's dedicated contract keeps its enumeration and outage-ladder requirements.
- **Host proof becomes flaky CI.** The suite is opt-in (`ARCHFLOW_REAL_HOSTS=1`), auth-probed,
  outside `npm run check`, with digest-bound recorded artifacts — the review-benchmark
  pattern — and a deterministic scratch-home setup.
- **The audit annotation rewrites history.** Header status line only; the measured body
  bytes are untouched and no test consumes them.
- **Docs drift.** The Section 4.7 page set updates in the same change as the behavior, and
  the final full check plus release reproduction run after the last doc byte lands.

No acceptance test may infer approval, adopt an import without the staged approved preview,
or create a commit without the exact durable authority the workflow already requires.

## 8. Success criteria

Phase 4 is complete only when all of the following hold:

1. The advertised catalogue is exactly `archflow_status` and `archflow_apply`,
   purpose-described, plain-object-rooted, within the measured byte budget; retired names
   fail `TOOL_NOT_FOUND`; the serialized catalogue size is recorded with the historical
   figures.
2. No skill text names a retired tool, `build-request`, `envelope`, `decide`,
   `gate-preview`, `archflow-local commit`, or a staged reference; the inverted contract
   suites enforce this globally through the two-name allow-list.
3. `$archflow-status` reports position, blockers, open-gate presentations (without
   resolving them), and the exact next skill in both client forms through read-only
   `archflow_status`, never calls `archflow_apply`, and keeps the manual-status degraded and
   staged-import classification ladders.
4. A complete legacy-upgrade journey runs without any low-level tool: preview approval,
   stage, local atomic adopt, semantic submit/review/triage, the one migration-audit gate
   through `gate-summary` and archive/settle decisions, both decision outcomes, import
   commit facts with client-side commit, status-observed proof, and the server-derived
   resume skill; crash/replay at the adoption and gate boundaries converges without
   duplicate effects, and tampered staged bytes fail closed.
5. Existing durable tasks and seeded checkpoints continue to project and operate through
   the semantic surface; durable history vocabulary is untouched.
6. The constitution skill is byte-unchanged with its documentation-only contract intact
   (the verified no-adapter finding).
7. Maintained docs describe the client-orchestrated two-tool boundary with no retired
   choreography; the historical audit carries the supersession annotation with its
   measurements intact; `CLAUDE.md`/`AGENTS.md` remain byte-identical to each other.
8. The opt-in real-host suite passes in authenticated Claude Code and Codex: advertisement,
   first-call selection of `archflow_status` without protocol hints, and a representative
   semantic journey slice; digest-bound evidence lands under `docs/validation/`.
9. The full `npm run check` passes (SDK probe on the semantic pair, typecheck, schema
   drift, MCP runtime, unit, contract, bundle, notices, SDK boundary, release
   smoke/mutation/reproducibility against the regenerated tracked payload), and the
   phase's own milestone commit was created client-side from semantic commit facts.

## 9. Executable verification

Run focused checks per chunk, then the full sequence after final bytes stabilize.

```bash
npm run typecheck
npm run generate:schemas
npm run check:schemas

npx vitest run \
  test/contracts/semantic-workflow-contract.test.ts \
  test/contracts/mcp-advertised-schema.test.ts \
  test/contracts/mcp-contract-agreement.test.ts \
  test/contracts/skill-contract-canonical.test.ts \
  test/contracts/skill-contract-upgrade.test.ts \
  test/contracts/skill-contract-server-outage.test.ts \
  test/unit/semantic-view.test.ts \
  test/unit/semantic-actions.test.ts \
  test/unit/mcp-tools.test.ts \
  test/integration/semantic-handlers.test.ts \
  test/integration/semantic-status-authority.test.ts \
  test/integration/semantic-composition-parity.test.ts \
  test/integration/semantic-document-journeys.test.ts \
  test/integration/semantic-implementation-journeys.test.ts \
  test/integration/semantic-implementation-completion-journeys.test.ts \
  test/integration/semantic-upgrade-journeys.test.ts \
  test/integration/review-fixed-point-live.test.ts \
  test/integration/state-gate-lifecycle.test.ts \
  test/crash/state-gate-lifecycle.test.ts

npm run test:mcp-runtime
npm run test:contracts
npm test
npm run build:temp
```

(`semantic-upgrade-journeys.test.ts` is the new migration-audit journey file; the exact
name may differ if implementation groups it with existing suites — the coverage in Section
5.4 is the requirement, not the filename.)

The upgrade journey must cover, at minimum: the full clean adopt→audit→commit→resume path
with a stubbed finding-free review; a findings path with triage and `revise`; the `revise`
audit choice through the checkpoint; crash cuts before/after adoption's state replacement
and before/after the gate decision archive; tampered/replaced staged bytes failing closed;
`upgrade-restart-required` classification after a stale stage; and the resume-skill
derivation for both shapes (a mapped design without an implementation log resuming at
`archflow-phase-impl <task> N`; a phase without a mapped design resuming at
`archflow-phase-design <task> N`).

Real-host proof (operator-run, opt-in):

```bash
ARCHFLOW_REAL_HOSTS=1 npx vitest run test/real-host/host-selection.test.ts
```

plus the existing real-host suites, with results recorded under `docs/validation/`.

After source, schemas, skills, tests, and documentation are final:

```bash
bash install.sh        # self-cutover reinstall before the phase's own commit
npm run release:write
npm run check
```

## 10. Handoff

Implementation may begin only after this exact phase design is independently reviewed,
explicitly approved by the user, committed through the authorized task-local milestone, and
durable status advances to `phase-impl-4`. The implementation session follows Section 1.2
(reinstall first; dogfood the semantic surface; create the phase's own milestone commit
client-side). It must write implementation notes recording any deviation from these pinned
interfaces — especially any deleted module that turned out to have a live consumer — and
the final verification evidence. This is the planned final phase: after its completion
authority and terminal hand-off, the task is complete and no successor skill is reported.
