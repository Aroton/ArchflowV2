# Phase 2 override plumbing — verification findings

Repo: `/home/aroton/ArchflowV2.feature-review-override-flexibility` (branch `feature/review-override-flexibility`).
All paths below are relative to repo root unless absolute. Line numbers verified against the working tree on 2026-08-19.

## 1. The claim: VERIFIED

**The downstream half exists and is complete; the upstream half (submission → facts) is missing, and today no live code path populates `facts.route_override`.**

### Who calls `composeCounterReview`, and where facts originate

- `composeCounterReview` lives at `src/state/request-composition.ts:481-507`. It reads `snapshot.route_override` (the composer's "facts" object):
  ```ts
  // request-composition.ts:495-497
  const routeOverride = snapshot.route_override === undefined
    ? undefined
    : structuredClone(record(snapshot.route_override, "build-request counter-review route_override")) as PlainJsonValue;
  ```
  and passes it into the `archflow_counter_review` tool input at `:504` (`...(routeOverride === undefined ? {} : { route_override: routeOverride })`). Its only shape gate is `record()` (must be a non-array object); the comment at `:493-494` says the server (zod) does the real validation.
- `composeCounterReview` is reached only from `composeRequest` (`request-composition.ts:901-904`, `case "counter-review"`).
- Live callers of `composeRequest` (grep, whole `src/`): exactly three, all semantic:
  - `src/state/semantic-actions.ts:558` (`executeSemanticActionSubstep`, compose-request execution),
  - `src/state/semantic-actions.ts:823` (`composeSemanticActionRequest`),
  - `src/mcp/handlers/semantic.ts:197` (`run_counter_review` capability).
  The retired local `build-request` staging path is gone (`src/contracts/mcp-tools.ts:180-183` comment; `LOCAL_COMMANDS` in `src/local/commands.ts:31-34` has no build-request command).
- The **only live producer** of `kind: "counter-review"` facts is `requestFacts` in `src/state/semantic-actions.ts:347-350`:
  ```ts
  case "review":
    if (substep === "review-enter") return { execution: "compose-request", facts: { kind: "running", step: "counter_review", intent_id: intentId } };
    if (substep === "review-run") return { execution: "counter-review-handler", facts: { kind: "counter-review", intent_id: intentId } };
    return { execution: "compose-request", facts: { kind: "triage", intent_id: intentId, dispositions: [] } };
  ```
  The `submission` parameter is available at the signature (`:326`) but **never consulted for the review action** — facts never carry `route_override`. This line is the exact seam Phase 2 threads.
- Every writer of `route_override` in `src/` (full grep): contracts (types/schemas: `mcp-tools.ts`, `review.ts`, `adjudication.ts`, `trust.ts`, `fingerprints.ts`, `renderers.ts`), the composer passthrough (`request-composition.ts:495-504`), the digest selector (`state/request.ts:63`), evidence minting (`review/counter-review.ts:281-297, 330, 380`), observation types (`dispatch/cli.ts:303, 313`), status projection (`state/status.ts:1121-1123`). None of these *originate* an override; the only origin point is the tool input, which on live paths is composed from facts that never carry one.

### Population today: test-only

- `test/integration/review-fixed-point.test.ts:787-795` — `commitCounter` hand-builds `parseToolCall("archflow_counter_review", { ..., route_override: override.declaration })` and drives `runCounterReview` directly, bypassing composition and the semantic layer entirely.
- `test/unit/state-request.test.ts:140-159`, `test/unit/fingerprints.test.ts:181-183, 209-224`, `test/unit/mcp-tools.test.ts:31-36`, `test/unit/renderers.test.ts:55-59` — hand-built subjects/inputs.
- No test (or live code) ever passes `route_override` through `composeRequest` facts; `test/integration/semantic-composition-parity.test.ts:98,143` composes counter-review facts without it.

**Conclusion: the override is fully implemented from the composed tool input downward, and unreachable above it. The claim is verified.**

## 2. End-to-end flow once facts carry the override

1. **Submission → facts (Phase 2's new work).** `archflow_apply` input is parsed by `parseArchFlowApplyInputV1` (`src/state/semantic-actions.ts:381`), which runs `applySubmissionV1Schema` (`src/contracts/semantic-workflow.ts:320-328`; kinds enumerated at `:99` — `"none" | "task-ask" | "work-result" | "triage" | "gate-summary" | "reopening-request" | "decision"`, no `review-dispatch` yet). The submission is bound into the operation identity by `operationKey` (`semantic-actions.ts:124-141`, `submission_digest: canonicalJsonDigest(submission ?? { kind: "none" })`) → `semanticOperationDigest` (`:149-155`).
2. **Facts → composed tool input.** For `review` at substep `review-run`, `planSemanticAction` → `requestFacts` (`:347-350`) → execution `counter-review-handler` → the `run_counter_review` capability (`src/mcp/handlers/semantic.ts:195-201`) calls `composeRequest(services, plan.request_facts)` → `composeCounterReview` clones `route_override` into the `archflow_counter_review` input. **Critical coupling:** when the review action starts at `review-enter` and chains to `review-run` inside one apply, the review-run plan is rebuilt by `substepPlan` (`semantic-actions.ts:599-612`), which calls `requestFacts(original.action_kind, substep, intentId, undefined)` — **the submission is dropped**. Phase 2 must carry the submission (or its override) onto `SemanticActionPlanV1` (as `decision_submission` is at `:64, 493`) and thread it through `substepPlan`, or the chained review-run will dispatch on the pinned route despite the submission.
3. **Validation + digest.** Inside composition, `computeCallEnvelope` (`src/local/call-envelope.ts:118` and again `:126`) runs `parseToolCall` → `counterReviewInputSchema` → full zod validation (see §3). `identifyTransactionRequest` (`call-envelope.ts:127` → `src/state/request.ts:61-64`) folds `route_override` into `operation_fields`, so the **request_digest covers the override** (selector `src/contracts/fingerprints.ts:74-76`, materialization `:251-261`, closed-field check `exactFields`). The input_fingerprint deliberately does *not* cover the override (it hashes workflow/constitution/rubric/artifact identities only, `fingerprints.ts:168-179`).
4. **Dispatch route selection.** `handleCounterReview` (`src/mcp/handlers/counter-review.ts:398-434`) calls `runCounterReview` (`src/review/counter-review.ts:261-455`):
   ```ts
   // counter-review.ts:280-285 — pin resolved only when no substitute named
   const routeFor = (role: RoutingRole): DispatchRoute => {
     const substitute = input.call.input.route_override?.[role];
     return substitute === undefined
       ? resolveDispatchRoute(input.config, input.phase_kind, role)
       : routeFromConfiguredRoute(substitute);
   };
   ```
   `routeFromConfiguredRoute` (`src/dispatch/routing.ts:57-80`) validates the substitute exactly like a pinned route (see §7). The same `routeFor` runs for the constitution/adjudicator child (`:347`), and the review fires on the `review-run` substep via `dependencies.dispatch(route, envelope, reviewOutputSchema)` (`:309-310`) — matching the claim's "children fire on review-run".
5. **Evidence record.** `overrideRecordFor` (`counter-review.ts:288-298`) reads (does not resolve) the displaced pin via `configuredRoute` (`routing.ts:88-94`) and stamps `{ reason, pinned_model?, pinned_effort? }` — a `RouteOverrideRecord` (`src/contracts/review.ts:144-150`, schema `:181-185`) — onto the review evidence (`counter-review.ts:330`) and adjudication evidence (`:380`) through `mintReviewObservation`/`mintAdjudicationObservation` → `src/contracts/trust.ts:106,119`. Per-role: an unnamed role keeps its pin and gets no record.
6. **Surfacing.**
   - Retained evidence markdown: `renderRouteOverride` (`src/contracts/renderers.ts:39-44`) is emitted by `renderReviewEvidence` (`:59`) and `renderAdjudicationEvidence` (`:95`), written into retained results by `src/state/evidence-results.ts:162,178` and printable via the local CLI `render` command (`src/local/commands.ts:45,150`).
   - Status/gate projection: `counter_review_provenance.route_override` (`src/state/status.ts:1112-1124`, type at `:87`) — the comment at `:1118-1120` says the gate correspondence is built from this block, so the human at the approval gate sees the deviation. Logs: nothing else; there is no separate dispatch log line for overrides.

## 3. Validation on the semantic path — confirmed live, in composition

- `counterReviewInputSchema` (`src/contracts/mcp-tools.ts:197`) = `{ ...common, artifact_path, route_override: routeOverrideSchema.optional() }.strict()`; `routeOverrideSchema` (`:188-196`) enforces: `reason: text` (non-blank, ≤4096, `/\S/`), strict keys, each route via `overrideRoute` (a parentless clone of `configRouteSchema`, `:187`), and `superRefine` "must name counter-reviewer, adjudicator, or both". `configRouteSchema` (`src/contracts/config.ts:11-17`) enforces `model` non-blank, `effort ∈ REASONING_EFFORTS` (`low|medium|high|xhigh|max|ultra`), optional `provider` (non-blank).
- **When it runs relative to facts assembly:** after facts assembly, *inside* composition — `composeCounterReview` → `computeCallEnvelope` → `parseToolCall(tool, input)` at `src/local/call-envelope.ts:118` (and again on the fingerprint-resolved input at `:126`), then a third time at the handler seam `src/mcp/handlers/semantic.ts:199` (`parseToolCall("archflow_counter_review", composed.value.envelope.request.input)`). So a submission-sourced override **is** validated by `routeOverrideSchema` on the semantic path, not only in config parsing. Before that, the submission itself is validated once by `applySubmissionV1Schema` at `planSemanticAction` (`semantic-actions.ts:381`). Dispatchability (family/provider/effort-vs-adapter) is validated last, at dispatch time, by `routeFromConfiguredRoute`.
- Note: a zod failure inside `composeRequest` throws a raw `ZodError` (not a `ProjectError`); on the semantic path `handleSemanticApply` (`semantic.ts:236-243`) rethrows non-`SemanticAction*` errors. The submission schema at the plan boundary is the intended first gate; the composer-side zod is defense in depth. If Phase 2 wants clean client errors for bad override shapes, the submission schema should carry them (it parses first).
- The composer's own `record()` check (`request-composition.ts:495-497`) only rejects non-object shapes, as its comment states.

## 4. Test seams for the new behavior

Existing fixtures/mocks:
- **Child-dispatch fakes:** `test/helpers/semantic-journeys.ts:85-137` (`installSemanticReviewStub`) — a scripted `codex` binary on PATH returning findings lists per review and passing constitution rules; plus `semanticJourneyHarness` (`:33-75`) driving real `handleSemanticApply`/`handleSemanticStatus`. The fixed-point harness `commitCounter` (`test/integration/review-fixed-point.test.ts:768-843`) injects an in-process `dispatch: async (route) => {...}` that records `DispatchRoute`s.
- **Semantic apply→review integration:** journeys in `test/integration/semantic-implementation-journeys.test.ts` etc. reach review via `reachImplementationHandoff` + `journeyApply(h, invocation, view)` with no submission at the review step.

Recommended seams:
- **(a) Unit — submission→facts threading:** `test/unit/semantic-actions.test.ts` `apply(snapshot, invocation, submission)` helper (`:63-72`) around `planSemanticAction`. Model on the existing analogous tests: "strictly matches submissions and binds changed work facts to a different operation" (`:86-101`) and the review-continuation fixtures (`:127-153`, incl. the `counter_review/running` snapshot whose plan is `{ substeps: ["review-run"], execution: "counter-review-handler", request_facts: { kind: "counter-review" } }`). Assert: `request_facts.route_override` equals the submission's declaration; `operation_digest` differs with vs without the submission; a `review-dispatch` submission against a non-review offer (and vice versa) throws `SEMANTIC_SUBMISSION_MISMATCH`; and — for the §2 coupling — the chained `substepPlan(initial, "review-run")` facts still carry the override (this may belong at the `executeSemanticAction` level, `:294-361`).
- **(b) Integration — dispatch under substitute route + evidence record:** two tiers.
  - Composition tier: `test/integration/semantic-composition-parity.test.ts` already composes `kind: "counter-review"` facts against real production services (`:98,143`) — extend with `route_override` facts and assert the composed envelope input + request_digest change.
  - Live tier: `semanticJourneyHarness` + `installSemanticReviewStub` (add a `claude` stub or keep the pinned codex stub and override the *adjudicator* to claude, or have the stub write which binary ran to the count file): apply `review` with the `review-dispatch` submission, then read retained evidence (`loadRetainedEvidence` / `dependencies.load_retained_manifest`, as `review-fixed-point.test.ts:1077-1100` does) and assert `RouteOverrideRecord` with the human `reason` and displaced pin. The existing gold standard for the assertion half is `review-fixed-point.test.ts:1102-1182` ("dispatches the substitute route per role and records the displaced pin on the evidence", "substitutes the adjudicator alone and supplies a role the config never pinned") — those tests keep passing unchanged since they feed hand-built tool calls.
- **(c) Operation-digest binding:** the submission is hashed into `SemanticOperationKeyV1.submission_digest` (`semantic-actions.ts:124-141`), so with/without (and reason-edited) submissions must yield distinct `operation_digest`s — same assertion pattern as `semantic-actions.test.ts:86-101`. The request-level binding is already pinned by `test/unit/state-request.test.ts:139-159` ("carries a counter-review route override into the request digest" — 5 distinct overrides ⇒ 5 distinct digests) and `test/unit/fingerprints.test.ts:208-225` (pairwise separation + closed selector). Replay identity at the semantic layer: a `review-run` continuation retry must reproduce the same submission bytes for `candidateOperationDigest === recoveredOperationDigest` (`semantic-actions.ts:433-465`, `authenticatedOldReviewRetry`); the dropped-submission retry composes a different request_digest and re-dispatches fresh under the pinned route (pre-dispatch replay `src/mcp/handlers/replay.ts:16-38` matches by identified request). Worth one explicit test.

## 5. Suites Phase 2 touches (and ones it must not break)

Current override coverage (all downstream, hand-built; all keep passing unchanged):
- `test/integration/review-fixed-point.test.ts:1102-1182` — dispatch + evidence record, per-role partial override, unpinned-role case.
- `test/unit/mcp-tools.test.ts:31-36` — zod parse of override on the tool input.
- `test/unit/state-request.test.ts:139-159`, `test/unit/fingerprints.test.ts:179-184, 208-225` — digest sensitivity.
- `test/unit/renderers.test.ts:55-59` — markdown rendering of the record.

Golden/corpus tests to watch:
- `test/unit/fingerprints.test.ts:163-170` pins golden request digests — baselines carry no `route_override`, so a new submission kind does not move them (adding a *new selected field* would; none is needed).
- Adding `review-dispatch` to `applySubmissionV1Schema` changes the generated `src/contracts/schemas/v1/semantic-workflow.schema.json`: `npm run generate:schemas` (else `npm run check:schemas` fails; it is in `npm run check`, not plain `npm test`). `test/contracts/semantic-workflow-contract.test.ts:40-49` requires the apply root to stay a plain object with variants nested below root — keep the new arm inside the `applySubmission` union def, per the CLAUDE.md rule (root-level `oneOf` is flattened by some hosts). `test/contracts/mcp-advertised-schema.test.ts:334-340` pins `action.properties.submission === { $ref: "#/$defs/applySubmission" }` — still fine; the advertised catalogue embeds from the committed schema (`src/mcp/tools.ts:141-166`).
- `APPLY_SUBMISSION_KINDS` (`semantic-workflow.ts:99`) feeds `expected_submission` enums in offers and `assertSubmissionMatches` (`semantic-actions.ts:82-87`). The review offer currently declares `expected_submission: "none"` (`src/state/semantic-view.ts:186` for `counter_review`, `:194` for the empty-triage variant). Phase 2 must either widen the review shape's expectation or special-case review in `assertSubmissionMatches` (the way `assertWorkResultFactsMatchPosition` special-cases submit-work, `semantic-actions.ts:94-115`). Note `fixedSubsteps`/`requestFacts` take `expectedSubmission` but review ignores it today (`:293-319, 347-350`).
- No corpus test covers semantic submissions' exhaustive kinds, so no golden breaks there; `durable-*-corpus`, `review-corpus`, `review-schema-agreement` cover durable/review documents and are unaffected.
- Skills: `skills/` contains **no** mention of route_override or review-dispatch today — if the workflow expects the orchestrating model to know it may submit a review-dispatch (e.g. on reviewer outage), the skill text and/or the review action's `instruction` string (`semantic-view.ts:185`) is where that surfaces; changing the instruction changes offer bytes but offers are recomputed per status call (not persisted), so no migration issue.

## 6. Tracked dist/ bundle

- `dist/` is git-tracked (`git ls-files dist` → `archflow-local.mjs`, `archflow-mcp.mjs`, `legal/…`, `manifest.json`, `metafile.json`) and built by esbuild from `src/main.ts` and `src/local/main.ts` (`scripts/release-support.mjs:55-56`), with `src/contracts/schemas/v1/*.json` and assets as release inputs (`:112-119, 347-349`). **Skills are NOT bundle inputs** — `install.sh` copies `skills/` directly (`SKILLS_SOURCE_DIR="$SCRIPT_DIR/skills"`); but the server code and generated schemas are, so any `src/` change (including regenerated schemas) requires rebuilding dist.
- Exact loop (from `package.json` scripts and `scripts/write-tracked-release.mjs` usage string):
  ```bash
  npm run release:stage -- --output <tmpdir>
  npm run release:write -- --stage <tmpdir>
  ```
- What fails if forgotten: `scripts/check-release.mjs --payload dist` hashes every bundle input and fails with `stale bundle input: <path>` (`release-support.mjs:550, 572, 642, 1050`); it runs inside `test/contracts/release-offline.test.ts` ("validates and starts the tracked payload from a guarded hostile copy") and `npm run check:release` (part of `npm run check`). `test/integration/install-script.test.ts:18` copies `dist/` verbatim, so it silently tests stale bytes rather than failing. Also run `npm run generate:schemas` after touching zod contracts (`check:schemas` is in `npm run check`).

## 7. Everything else on the dispatch path that reads/restricts overrides

All in `routeFromConfiguredRoute` unless noted — an override is held to *exactly* the pinned-route rules:
- **Model id:** must satisfy `safeIdV1Schema` (`routing.ts:58-60`) else `CONFIG_INVALID { issue_code: "model-not-safe-id" }`.
- **Family derivation:** `claude-*` ⇒ claude/claude-cli, `gpt-*` ⇒ codex/codex-cli, anything else ⇒ `CONFIG_MODEL_UNSUPPORTED` (`routing.ts:31-35`). A `provider` implies claude family regardless of prefix (so `glm-5.3` + provider routes through claude-cli), **but `gpt-*` + provider is rejected** `CONFIG_INVALID { issue_code: "provider-unsupported" }` (`routing.ts:65-67`; mirrored in the launcher `src/dispatch/cli.ts:658-660`). Provider wrapping launches `cc-switch start claude <provider> -- <argv>` (`cli.ts:583-599`).
- **Effort allowlist per adapter:** claude-cli supports `low..max` (no `ultra`); codex-cli supports all `EFFORT_VALUES` (`routing.ts:41-51`) else `CONFIG_INVALID { issue_code: "effort-unsupported" }`. (The zod layer already restricts to `REASONING_EFFORTS` = `low|medium|high|xhigh|max|ultra`.)
- **Adapter/family consistency:** `assertAdapterFamily` (`src/contracts/trust.ts:80-83`) throws on mismatch during observation minting.
- **Pin resolution order:** the pin is resolved only when no substitute names the role (`counter-review.ts:276-285`) — resolving first would strand tasks on `route-missing`/`effort-unsupported` pins, the exact outages the override relieves. The *displaced* pin is read unvalidated via `configuredRoute` so reporting never fails on unroutable pins (`routing.ts:82-94`).
- **Constitution cross-check:** `crossCheckRuleFindings(plan.registry, observedConstitution.evidence, constitutionRoute.adapter)` (`counter-review.ts:382-386`) runs against the *substitute* adapter — an adjudicator override that swaps family changes which family's observation capability the output must match.
- **No independence/family rule on the live path:** evidence slots record `reviewer_family` as provenance only (`trust.ts:133, 154`, `evidence-results.ts:450`); the only opposite-family enforcement is on legacy supplemental gates (`durable-gate.ts:180-186`). So an override that makes the reviewer same-family as the producer is legal and merely recorded. No sandbox flags read the override; the repository view / workspace binding is independent of route.
- **FIFO note:** the semantic review action wraps the whole flow in `serializeDispatch` and passes `serialize_dispatch: async (op) => op()` to the inner handler (`semantic.ts:195-201` → `handleCounterReview(call, context, true)`; `counter-review.ts:449-455`) — Phase 2 tests exercising the live path run inside that outer FIFO.

## Hidden couplings / surprises (summary)

1. `substepPlan` drops the submission (`semantic-actions.ts:601`) — the chained review-enter → review-run inside one apply would lose the override unless the plan carries it (mirror `decision_submission`).
2. Review's `expected_submission` is `"none"` and `assertSubmissionMatches` rejects any submission against `"none"` (`semantic-actions.ts:84-85`) — the acceptance rule needs a review-specific relaxation or a new expected kind.
3. Retry semantics: the operation digest binds the submission bytes; a review-run continuation retry that omits/edits the submission composes a different request and re-dispatches fresh under the pinned route (no replay match) — legitimate but worth pinning in a test.
4. `route_override` changes the request_digest but not the input_fingerprint — evidence subject binding (`input_fingerprint`) is unaffected by an override.
5. Schema regeneration + dist rebuild are both required for the new submission kind to reach an installed client (`generate:schemas`, then `release:stage`/`release:write`).
