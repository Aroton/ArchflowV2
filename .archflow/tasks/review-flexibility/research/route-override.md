# Route-override exposure research (task "review-flexibility")

Repo: `/home/aroton/ArchflowV2.feature-review-override-flexibility`, branch `feature/review-override-flexibility`.
Feature commit under study: `6549da8` "Allow a per-dispatch reviewer route override for outages (#5)".
Known gap (stated in the commit message itself): the semantic API advertises only `archflow_status` / `archflow_apply`, and no apply submission carries a `route_override`, so the server-side path has no public entry point.

---

## 1. The per-dispatch route override as implemented (6549da8)

### 1.1 Type shapes

**Input declaration** (what a caller would supply) — `src/contracts/mcp-tools.ts:74-81`:

```ts
export type RouteOverrideDeclaration = {
  readonly reason: string;
  readonly "counter-reviewer"?: ModelRouteV1;
  readonly adjudicator?: ModelRouteV1;
};
export interface CounterReviewInput extends CommonToolInput {
  readonly artifact_path: TaskPathClaim;
  readonly route_override?: RouteOverrideDeclaration;
}
```

`ModelRouteV1` = `{ model, effort, provider? }` from `src/contracts/config.ts:11-17,42`.

**Zod schema** — `src/contracts/mcp-tools.ts:181-197`. `routeOverrideSchema` is
`{ reason, "counter-reviewer"?: route, adjudicator?: route }.strict()` with a `superRefine` requiring at
least one role ("route_override must name counter-reviewer, adjudicator, or both"). The route arm is a
parentless clone of `configRouteSchema` (`overrideRoute`, line ~176) because the advertised catalogue
does not carry the config document, so a cross-document `$ref` would be unresolvable. It rides on
`counterReviewInputSchema` (line 197): `{ ...common, artifact_path, route_override? }.strict()`.

**Evidence record** (what is durably retained) — `src/contracts/review.ts:144-150,181-183`:

```ts
export type RouteOverrideRecord = {
  readonly reason: string;
  // Absent when the config pinned no route for this role at all.
  readonly pinned_model?: string;
  readonly pinned_effort?: (typeof EFFORT_VALUES)[number];
};
```

Present as `route_override?: RouteOverrideRecord` on `ServerAttestedReview` (review.ts:159-170) and on
`ServerAttestedAdjudication` (`src/contracts/adjudication.ts:153`, schema at 159). Both parsers omit
the key rather than materializing `undefined` (review.ts:200-210 comment; adjudication.ts:163 comment).
Generated JSON schemas updated: `src/contracts/schemas/v1/review-evidence.schema.json`,
`adjudication-evidence.schema.json`, `mcp-tools.schema.json` (all contain `route_override`).

### 1.2 Where it is accepted and consumed

- **Route resolution + validation** — `src/dispatch/routing.ts`:
  - `routeFromConfiguredRoute(configured: ModelRouteV1): DispatchRoute` (lines 57-80) is explicitly
    documented as "Shared by the pinned-config path and the per-dispatch override, so an override is
    held to exactly the same rules as a pinned route" — model safe-id, provider/gpt-* mismatch
    rejection, family derivation (`claude-`/`gpt-` prefix, or claude when `provider` set),
    per-adapter effort sets (claude-cli: low..max; codex-cli: all).
  - `configuredRoute(config, phaseKind, role)` (lines 88-94) reads the pin *without validating*:
    `config.overrides?.[phaseKind]?.[role] ?? config.roles[role]` — used to report what was displaced.
  - `resolveDispatchRoute` (96-106) is the throw-on-unroutable version used when no substitute exists.
- **Counter-review engine** — `src/review/counter-review.ts:255-330` (`runCounterReview`):
  - `routeFor(role)` (281-286): substitute if `input.call.input.route_override?.[role]` is present,
    else `resolveDispatchRoute`. Comment at 275-280: the pin is resolved *only* when no substitute was
    named, precisely so an override can get past a config that pins an unroutable/absent route.
  - `overrideRecordFor(role)` (288-297): builds the `RouteOverrideRecord` — reads (not resolves) the
    pinned route; when the config pinned nothing, records `reason` alone.
  - Applied to the rubric dispatch (counter-reviewer, lines ~298-333: `routeFor("counter-reviewer")`,
    `mintReviewObservation({..., route_override: reviewOverride})`) and independently to the
    constitution dispatch (adjudicator, lines ~355-385: `routeFor("adjudicator")`,
    `mintAdjudicationObservation({..., route_override: constitutionOverride})`). Each role's override
    is independent; a role not named keeps its pin.
- **MCP handler** — `src/mcp/handlers/counter-review.ts:398-430` calls `runCounterReview` with
  `call` (already parsed through `counterReviewInputSchema`), `config`, `phase_kind` from the session.
- **Evidence minting** — `src/contracts/trust.ts:55,106,119`: the dispatch-result binding carries
  `route_override?`, and `mintReviewObservation` / adjudication equivalent spread it onto the
  server-attested evidence (`...(binding.route_override === undefined ? {} : {...})`).

### 1.3 Digest / fingerprint binding

- **Request digest** (not input fingerprint — two reviews of identical inputs can legitimately differ
  only by reviewer): `src/contracts/fingerprints.ts:79` — the counter-review `RequestDigestSubject`
  selects `Pick<CounterReviewInput, "artifact_path" | "route_override">`; compile-time selector-key
  coverage at line 92; materialization at 251-266 (`exactFields` with dynamically expected keys).
- **Digest builder** — `src/state/request.ts:57-66`: the `archflow_counter_review` arm projects
  `route_override` into `operation_fields` with a comment noting every operation-specific field must
  be projected here or it silently misses the digest.

### 1.4 Surfacing at gates / status

- **Rendered evidence** — `src/contracts/renderers.ts:39-44` `renderRouteOverride` emits a
  "## Route Override" section (`pinned_route: none configured for this role` or
  `pinned_model`/`pinned_effort` + `reason`); appended by `renderReviewEvidence` (line 59) and
  `renderAdjudicationEvidence` (line 95) for server-attested evidence.
- **Status projection** — `src/state/status.ts:1111-1126`: `counter_review_provenance` in the gate's
  evidence block gains `route_override` when present ("without it the human sees which model reviewed
  but never that it was not the configured one").
- **Internal build-request composition** — `src/state/request-composition.ts`:
  - `PAYLOAD_SHAPE` (line 79) documents `"route_override"?:{"reason":..., "counter-reviewer"?:{model,effort,provider?}, "adjudicator"?:{...}}`.
  - `composeCounterReview` (lines ~481-509): accepts `snapshot.route_override` from the request facts,
    `structuredClone(record(...))`s it, and spreads it into the composed `archflow_counter_review`
    tool input. **This means the composition seam already accepts a route override in its facts —
    the semantic layer just never supplies one.**

### 1.5 Existing tests

`test/unit/dispatch-routing.test.ts`, `test/unit/fingerprints.test.ts`,
`test/unit/mcp-tools.test.ts`, `test/unit/renderers.test.ts`, `test/unit/state-request.test.ts`,
`test/integration/review-fixed-point.test.ts` (+ live variant) all carry route_override cases.

---

## 2. The semantic workflow API (public surface)

### 2.1 Two advertised tools

`src/mcp/tools.ts:157-166` — `ADVERTISED_TOOL_CATALOGUE` builds descriptors for
`archflow_status` and `archflow_apply` only (`ADVERTISED_TOOL_NAMES` in
`src/contracts/tool-names.ts`). Input/output schemas are standalone embeddings of fragments from the
generated `src/contracts/schemas/v1/semantic-workflow.schema.json` (`semanticSchemaFragment`,
tools.ts:59-65; `embedSchema` hoists reachable defs into flat `$defs` with single-hop pointers,
tools.ts:102-139; note tools.ts:96-100: hosts serialize a bare nested `$ref` argument as a string, so
no two-level pointers). `standaloneSchema` (141-149) forces `type: "object"` at the root.

### 2.2 Input contract — `src/contracts/semantic-workflow.ts`

- `ArchFlowStatusInputV1` (158-162): `{ schema_version, task_id, invocation? }`.
- `ArchFlowApplyInputV1` (164-169):
  ```ts
  { schema_version, task_id, invocation,
    action: { offer: af1_<64hex>, submission?: ApplySubmissionV1 } }
  ```
- `ApplySubmissionV1` (139-156), a discriminated union on `kind`:
  - `task-ask` `{ text }`
  - `reopening-request` `{ request }`
  - `work-result` `outcome:"succeeded"` with optional `implementation` facts and `human_revision`
  - `work-result` `outcome:"failed"` `{ reason }`
  - `triage` `{ dispositions: [...] }`
  - `gate-summary` `{ summary }`
  - `decision` `{ choice, reason, option_rationale? }`
- Closed enums: `APPLY_SUBMISSION_KINDS` (line 99) = `none | task-ask | work-result | triage |
  gate-summary | reopening-request | decision`; `SEMANTIC_ACTION_KINDS` (94-98) = `initialize-task,
  begin-work, submit-work, review, triage, revise, reopen, open-waiver, decide, commit,
  start-next-skill, finish-task, inspect, none`.
- **Root-object convention satisfied**: `archFlowApplyInputV1Schema` (311-312) is a plain
  `z.object` root; the submission union is nested below `action.submission` ("Plain object root; all
  variants are nested below `invocation` and `action.submission`"). Any route-override addition must
  keep this — put it inside an existing object level, never a root-level combinator.
- Generated schema: `semantic-workflow.schema.json` is produced by `npm run generate:schemas`
  (scripts/generate-schemas.mjs; `npm run check:schemas` verifies). Source of truth is the zod in
  `semantic-workflow.ts`; contract tests: `test/contracts/semantic-workflow-contract.test.ts`,
  `mcp-advertised-schema.test.ts`, `mcp-contract-agreement.test.ts`, `semantic-keyword-parity.test.ts`.

### 2.3 Apply routing — `src/state/semantic-actions.ts`

- `planSemanticAction` (line ~379) parses the apply input, projects the current offer, enforces
  submission matching (`assertSubmissionMatches`, 91-96: strict — `expected === "none"` means
  `submission` must be `undefined`; otherwise exact kind equality), then position-specific checks
  (`assertWorkResultFactsMatchPosition`, 98-122).
- **Operation identity binds the submission**: `operationKey` (lines 111-141) computes
  `submission_digest = canonicalJsonDigest({digest_kind:"semantic-submission", submission: submission ?? {kind:"none"}})`
  into `SemanticOperationKeyV1`; `semanticOperationDigest` derives the durable intent id
  (`afop-<digest>-<substep>`). So anything carried inside the submission is automatically bound into
  the authenticated operation identity; a sibling field outside `submission` would need to be added
  to this digest explicitly.
- `requestFacts(action, substep, intentId, submission)` (lines ~333-380) maps action+submission to
  composition facts. The review case (lines 345-350):
  ```ts
  case "review":
    if (substep === "review-enter") return { execution: "compose-request", facts: { kind: "running", step: "counter_review", intent_id } };
    if (substep === "review-run") return { execution: "counter-review-handler", facts: { kind: "counter-review", intent_id } };
    return { execution: "compose-request", facts: { kind: "triage", intent_id, dispositions: [] } };
  ```
  **The `review-run` facts omit `route_override` entirely** — this is the exact seam where a
  declaration would be injected into `composeCounterReview`, which already reads
  `snapshot.route_override`.
- Continuation/replay authentication (`authenticatedSemanticReviewContinuation`, 195-218;
  replay-matching at ~450-475 `authenticatedOldReviewRetry`): the operation digest is recovered from
  the durable last transition, so a review-run retry must reproduce the *same* operation digest —
  i.e. the same submission bytes, hence the same route_override. This falls out naturally if the
  override lives in the submission digest.

### 2.4 The apply executor — `src/mcp/handlers/semantic.ts`

- `handleSemanticApply` (224-244) → `executeSemanticAction(services, snapshot, input, capabilities)`.
- `capabilities.run_counter_review` (195-201): composes the request from `plan.request_facts`
  (`composeRequest`), parses the composed tool input with `parseToolCall("archflow_counter_review", ...)`
  — which runs `counterReviewInputSchema`, so a `route_override` present in the facts is fully
  validated here — then delegates to `handleCounterReview(call, context, true)`.
- Direct `archflow_counter_review` execution through `execute_composed_request` is refused
  (191-192: "counter review must use the direct inner review seam").

### 2.5 When dispatches are triggered relative to apply

Counter-review children are dispatched only by the semantic **`review`** action, substep
`review-run` (execution kind `counter-review-handler`), which internally composes the
`archflow_counter_review` request and runs the rubric dispatch plus (when active constitution rules
exist) the constitution/adjudicator dispatch — both inside one `runCounterReview` call
(counter-review.ts:261+). The `review` action is offered after `submit-work` at every position
(prd, design, phase-design, phase-impl) and again after each revision cycle. Substep sequencing:
`["review-enter", "review-run", "review-empty-triage"]` (semantic-actions.ts:285-290), with
authenticated continuations when resuming mid-review.

The **`review` action's `expected_submission` today is `"none"`** (`src/state/semantic-view.ts:185-186`,
193-194) — the apply call is `{"offer": ...}` with no `submission` key at all. This is the central
design fact: any override carrier must either relax that "none" or live beside `submission`.

---

## 3. Recommended carrier points (with alternatives)

**Recommended: a new optional submission arm used only by the `review` action —
`{ kind: "review-dispatch", route_override: {...} }` (name TBD).**
- Add to `ApplySubmissionV1`, `applySubmissionV1Schema`, `APPLY_SUBMISSION_KINDS`
  (semantic-workflow.ts:99,139-156,301-309); regenerate `semantic-workflow.schema.json`
  (`npm run generate:schemas`). Root stays a plain object (union nested under `action.submission`).
- Relax submission matching for `review` only: accept `none` *or* the new kind
  (`assertSubmissionMatches`, semantic-actions.ts:91-96; the view's `expected_submission` can stay
  `"none"` — matching must treat the override arm as an optional extra, mirroring how
  `isArchivedDecisionRetry` already bypasses strict matching at ~427).
- Thread it through `requestFacts` case `"review"` / substep `review-run`
  (semantic-actions.ts:349): spread `...(submission.route_override === undefined ? {} : { route_override: submission.route_override })`
  into the `{ kind: "counter-review" }` facts. `composeCounterReview`
  (request-composition.ts:481-509) then passes it to the composed tool input, and
  `parseToolCall`/`counterReviewInputSchema` performs the real validation (role coverage, route
  legality) — the semantic layer needs only a shape-level check, exactly like the existing comment
  says ("the server validates it against the same rules as a pinned route").
- Operation identity: free — the override lands inside `submission_digest` via `operationKey`.
- Reuse the `RouteOverrideDeclaration` shape (reason + per-role `ModelRouteV1`) verbatim so the
  semantic vocabulary matches `CounterReviewInput.route_override`; consider defining the submission
  arm as `{ kind, route_override: RouteOverrideDeclaration }` (required, not optional, so an empty
  override never reaches digest land) and make the whole submission optional in practice by
  continuing to accept the no-submission form.

**Alternative A: optional sibling on `action`** — `action: { offer, submission?, route_override? }`
(archFlowApplyInputV1Schema line 312). Simpler mental model ("submission = workflow data,
route_override = dispatch parameter") and does not touch the submission-kind enum, but:
`operationKey` must be extended to bind it (otherwise it is unauthenticated), `assertSubmissionMatches`
must gate it to the review action, and it creates a second place callers can put things. Also the
advertised schema grows a top-level field hosts may present on every action.

**Alternative B: piggyback on `work-result`** — rejected: the dispatch happens on the *next* apply
(the `review` action), not on `submit-work`; an override on work-result would have to be persisted
across calls for no benefit and would couple producer facts to dispatch parameters.

**Status-side (optional) companion**: the view's `review` instruction
(semantic-view.ts:185) could mention that an override submission exists, and/or a blocked/outage
condition could surface it — but keep gate-facing text conversational per CLAUDE.md
(no digests/protocol codes in default responses).

---

## 4. Config schema and template

### 4.1 Schema — `src/contracts/config.ts`

- `configRouteSchema` (11-17): `{ model, effort ∈ REASONING_EFFORTS, provider? }.strict()`.
- `configRolesSchema` (19-25): `{ producer? (retired, accepted on read only), "counter-reviewer"?,
  adjudicator? }`.
- **`configOverridesSchema` (27-33) already exists**: per-phase-kind roles —
  `{ explore?, prd?, design?, "phase-design"?, "phase-impl"? }`, each a `configRolesSchema`.
- `configV1Schema` (35-40): `{ schema_version, roles, overrides?, max_attempts? }.strict()` —
  `overrides` is optional, so existing configs parse unchanged.
- Consumed by `configuredRoute`/`resolveDispatchRoute` (routing.ts:88-106) with fallback
  `overrides[phaseKind][role] ?? roles[role]`. Note `RoutingPhaseKind` includes `explore`, though no
  dispatch runs for explore today (schema-level symmetry only).
- Generated JSON schema: `config` entry in `src/contracts/internal/schema-generation-leaf.ts:123-133`
  (`defs: { route, roles, overrides }`) → `src/contracts/schemas/v1/config.schema.json`.

### 4.2 Template — `assets/config.template.yaml`

Ships `schema_version`, `roles` (gpt-5.6-sol xhigh counter-reviewer + adjudicator), a comment block
explaining `provider`/cc-switch with a glm-5.3 example, `max_attempts` comment, and a commented
Codex-host orientation block. **No `overrides:` section appears anywhere** — hand-edit-only today.
Installed by `archflow-local init` via `src/init/assets.ts:21`
(`["config.template.yaml", ".archflow/config.yaml"]`); copied and byte-pinned per task at
`src/init/task-initialization.ts:67-82`; the legacy-upgrade path byte-compares against the template
(`src/init/legacy-upgrade.ts:476-483`). Adding an `overrides` block is a commented example +
explanatory comment in the template; the schema already accepts it (no code change), but changing
the template changes what new tasks pin and what the upgrade comparison expects
(check `legacy-upgrade.ts:480` — actual-vs-template equality — before editing).

---

## 5. Skills touch points

Skill files under `skills/` (each a `SKILL.md`; only `archflow-constitution` has an `agents/`
subfile). Current text:

- **`skills/archflow-init/SKILL.md`** — describes init and the scaffold; does not document
  `config.yaml` routing contents at all. This is where config-template guidance (roles, provider,
  per-phase-kind `overrides`, when to use them vs a per-dispatch override) most naturally belongs,
  or wherever the design decides routing documentation lives.
- **`skills/archflow-prd/SKILL.md:38`**, **`skills/archflow-design/SKILL.md:24`**,
  **`skills/archflow-phase-design/SKILL.md:24`**, **`skills/archflow-phase-impl/SKILL.md:30`** —
  each contains the "Apply the offered no-submission `review` ... never perform, spawn, simulate, or
  replace it" paragraph. These are the files that must learn the override submission: when a
  dispatch fails on an outage, ask the human, and only then apply the `review` offer with the
  override submission carrying the human's reason. phase-impl:30 additionally covers the
  runs-many-minutes/background guidance.
- **`skills/archflow-status/SKILL.md:18`** — enumerates the semantic action kinds; likely needs a
  line only if the override changes the action vocabulary (it should not — same `review` kind).
- `skills/archflow-constitution/SKILL.md`, `archflow-explore/SKILL.md`, `archflow-upgrade/SKILL.md` —
  no review-dispatch text today; upgrade mentions `config.yaml` only as a byte-pinned task asset.

**Caution**: `test/contracts/skill-contract-canonical.test.ts` asserts exact skill phrases
(e.g. line 267 `omit \`submission\` for \`none\``, 233/274 "separate no-submission ..." wording).
Skill edits must keep or deliberately update these assertions.

## 6. Docs touch points (caps-named maintained set)

Already carrying route-override text from 6549da8: `docs/review/COUNTER-REVIEW.md` (section around
lines 84-93: escape-hatch rationale, validation parity, human-chooses policy),
`docs/mcp/DISPATCH.md:18`, `docs/LIMITATIONS.md`, `docs/contracts/CONTRACTS.md`.
Will need updates when the semantic path lands: `docs/mcp/SERVER.md` (the two semantic tools and
their submissions), `docs/review/COUNTER-REVIEW.md` (how a skill requests the override),
`docs/workflow/SKILLS.md` (skill vocabulary), plus `docs/state/DURABLE-STATE.md` only if the
submission changes durable shapes (it should not — `RouteOverrideRecord` already persists).
The config-template `overrides` surfacing belongs in whichever page documents configuration
(DURABLE-STATE.md pins config; DISPATCH.md describes routing resolution).

## 7. Test touch points

Semantic carrier: `test/contracts/semantic-workflow-contract.test.ts`,
`test/contracts/semantic-keyword-parity.test.ts`, `test/contracts/mcp-advertised-schema.test.ts`,
`test/contracts/mcp-contract-agreement.test.ts`, `test/integration/semantic-handlers.test.ts`,
`test/integration/semantic-composition-parity.test.ts`,
`test/integration/semantic-document-journeys.test.ts` (helpers in `test/helpers/semantic-journeys.ts`),
`test/unit/mcp-tools.test.ts`. Existing override coverage to build on:
`test/unit/dispatch-routing.test.ts`, `test/unit/fingerprints.test.ts`,
`test/unit/state-request.test.ts`, `test/unit/renderers.test.ts`,
`test/integration/review-fixed-point*.test.ts`. Skill wording:
`test/contracts/skill-contract-canonical.test.ts`. Schema regeneration check: `npm run check:schemas`.
