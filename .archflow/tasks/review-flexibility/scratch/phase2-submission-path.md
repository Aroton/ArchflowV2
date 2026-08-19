# Phase 2 exploration: the semantic submission path end to end

Branch `feature/review-override-flexibility`, task `review-flexibility`. All references are to
the current working tree (phase 1 merged). Purpose: everything a phase design needs to specify
the `review-dispatch` submission kind with exact seams.

---

## 1. Submission-kind declaration surface

Every site that declares or enumerates a submission kind. All contract-level sites live in
`src/contracts/semantic-workflow.ts`:

| Site | What it is | Must change? |
|---|---|---|
| `semantic-workflow.ts:99` | `export const APPLY_SUBMISSION_KINDS = ["none", "task-ask", "work-result", "triage", "gate-summary", "reopening-request", "decision"] as const;` | **Yes** — add `"review-dispatch"` |
| `semantic-workflow.ts:100` | `export type ApplySubmissionKindV1 = (typeof APPLY_SUBMISSION_KINDS)[number];` | auto-widens |
| `semantic-workflow.ts:144-161` | `export type ApplySubmissionV1 = | { kind: "task-ask"; ... } | ... | { kind: "decision"; ... };` | **Yes** — add arm `{ readonly kind: "review-dispatch"; readonly route_override?: RouteOverrideDeclaration }` |
| `semantic-workflow.ts:289` | `semanticNextActionV1Schema` — `expected_submission: z.enum(APPLY_SUBMISSION_KINDS).optional()` | auto-widens via the const array |
| `semantic-workflow.ts:320-328` | `applySubmissionV1Schema = z.union([...])` — the seven parse arms | **Yes** — add the zod arm |
| `semantic-workflow.ts:106` / `:198` | `SemanticNextActionV1.expected_submission?: ApplySubmissionKindV1` and `SemanticActionOfferV1.expected_submission: ApplySubmissionKindV1` | auto-widen; see §2 for the optionality question |

No other enumeration exists. `submissionKind()` (`src/state/semantic-actions.ts:75-76`) derives
`ApplySubmissionKindV1` from `submission?.kind ?? "none"`. Nothing in `renderers.ts`, `src/local/`,
or handlers enumerates kinds; the local CLI has no apply-submission surface (grep for "submission"
in `src/local/` and `src/contracts/renderers.ts` is empty — the renderers' `route_override` hits at
`renderers.ts:59,95` render evidence provenance, not submissions).

### The route shape must be inlined, not `$ref`ed

`RouteOverrideDeclaration` is already defined at `src/contracts/mcp-tools.ts:76-80`:

```ts
export type RouteOverrideDeclaration = {
  readonly reason: string;
  readonly "counter-reviewer"?: ModelRouteV1;
  readonly adjudicator?: ModelRouteV1;
};
```

with its zod form `routeOverrideSchema` (`mcp-tools.ts:188-196`, superRefine: must name
counter-reviewer, adjudicator, or both). For the semantic-workflow document the arm must NOT
reference the shared `configRouteSchema` instance (`src/contracts/config.ts:11-17`): that instance
is registered as `config#/$defs/route` by the leaf schema group
(`src/contracts/internal/schema-generation-leaf.ts:123-129`), and the schema registry keys by
instance identity, so re-registering it under `semantic-workflow#...` would break one document or
the other. Worse, the advertised catalogue's document list (`src/mcp/tools.ts:32-50`) does not
carry the config document, so a cross-document `$ref` to `urn:archflow:schema:v1:config#/$defs/route`
would make `parseReference` throw `unknown normative schema reference` at advertise time. The
established pattern is the parentless clone with inline emission — `mcp-tools.ts:184-196`:

```ts
const overrideRoute = configRouteSchema.clone(configRouteSchema.def) as z.ZodType<ModelRouteV1>;
export const routeOverrideSchema = z.object({ reason: text, "counter-reviewer": overrideRoute.optional(), adjudicator: overrideRoute.optional() }).strict()...
```

Phase 2 should either clone `configRouteSchema` again inside `semantic-workflow.ts` (mirroring
this), or import the type only (`import type { RouteOverrideDeclaration } from "./mcp-tools.js"` —
no import cycle: mcp-tools.ts does not import semantic-workflow.ts) and write a local zod arm.

`src/contracts/internal/schema-generation-semantic-workflow.ts` needs **no new def entry**: the arm
nests inside the existing `applySubmission: applySubmissionV1Schema` def (line 38). Only a
separately-registered override shape would need a defs entry.

---

## 2. `assertSubmissionMatches` and how `expected_submission` is set

`src/state/semantic-actions.ts:82-87`:

```ts
function assertSubmissionMatches(expected: ApplySubmissionKindV1, submission: ApplySubmissionV1 | undefined): void {
  const actual = submissionKind(submission);
  if (expected === "none" ? submission !== undefined : actual !== expected) {
    throw new SemanticActionPlanError("SEMANTIC_SUBMISSION_MISMATCH", expectedSubmissionMessage(expected, actual));
  }
}
```

Semantics today: `expected === "none"` means "no submission allowed at all"; any other expected
value means "exactly this kind, required". A single literal cannot express "optional".

`expected_submission` typing: `ApplySubmissionKindV1` — a single string literal, **required** on
`SemanticActionOfferV1` (`semantic-workflow.ts:198`), optional on `SemanticNextActionV1` (`:106`).
It is set per action in the projection shapes (`ProjectionShape.expected_submission?`,
`src/state/semantic-view.ts:34`):

- review (counter_review ready): `semantic-view.ts:182-187` — `action_kind: "review"`,
  `instruction: "Run or resume the server-owned independent review action."`,
  `expected_submission: "none"` (the line 185 the task cites).
- review (finding-free settlement): `semantic-view.ts:189-195` — `expected_submission: "none"`.
- all other actions: produce/submit-work/triage/decide/etc. throughout `mapRunStep` (:156-207)
  and `mapNextAction` (:209-322).
- Defaulted in `offerFor` (`semantic-view.ts:350`): `expected_submission: shape.expected_submission ?? "none"`, then mirrored into the public view at `:415`.

Called from exactly one place: `planSemanticAction` at `semantic-actions.ts:413`
`if (!isArchivedDecisionRetry) assertSubmissionMatches(offer.expected_submission, input.action.submission);`
— note the existing precedent of a bypass: `isArchivedDecisionRetry` (:412) skips the assertion for
a decision retry.

### Cleanest way to accept "none" OR "review-dispatch"

Two viable designs:

**(a) Planner-level relaxation (design.md's own sketch, `.archflow/tasks/review-flexibility/design.md:77`).**
Keep the view/offer advertising `expected_submission: "none"` and special-case review in
`planSemanticAction` (or inside `assertSubmissionMatches` keyed on the offer's action kind):
accept `undefined | {kind:"review-dispatch"}` when `offer.action_kind === "review"`. Zero type
widening, mirrors the `isArchivedDecisionRetry` bypass. Downside: the public view then says
`expected_submission: "none"` while a submission is actually accepted — the advertised contract
misleads the client model, and the skill prose must carry the truth alone.

**(b) Honest optional-kind literal.** Add `"review-dispatch"` to `APPLY_SUBMISSION_KINDS`, set the
counter_review shape (`semantic-view.ts:186`) to `expected_submission: "review-dispatch"`, and
teach `assertSubmissionMatches` one new rule: `review-dispatch` is an *optional* kind —
`undefined` also matches. The optionality is a property of the kind, encoded at the single
enforcement point with a comment. The view/offer then honestly advertise the accepted kind, and
the instruction can reference it. This changes review offer digests (`expected_submission` is
inside `SemanticActionOfferV1`, hashed by `semanticOfferToken`, `semantic-view.ts:363-365`), which
is safe for in-flight tasks: review continuations authenticate via `currentOfferMatches` or
recovered operation digests (`semantic-actions.ts:458-465`), never via offer-digest stability, and
the decision-continuation invariant at `:773` (`expected_submission !== "none"`) concerns the
decide action only.

The finding-free review shape (`:189-195`) should stay `"none"` under either design: no dispatch
happens at review-empty-triage, so an override there is meaningless and should be rejected.

---

## 3. `requestFacts` — where the override threads in

`src/state/semantic-actions.ts:321-374`. Per action, facts are built inline; kinds that consume a
submission guard on it (`submission?.kind !== "task-ask" → TypeError`, etc.). The review case,
`:347-350`:

```ts
case "review":
  if (substep === "review-enter") return { execution: "compose-request", facts: { kind: "running", step: "counter_review", intent_id: intentId } };
  if (substep === "review-run") return { execution: "counter-review-handler", facts: { kind: "counter-review", intent_id: intentId } };
  return { execution: "compose-request", facts: { kind: "triage", intent_id: intentId, dispositions: [] } };
```

**Threading point**: the `review-run` facts object. The downstream composer already accepts and
reads a `route_override` member of the counter-review facts — `src/state/request-composition.ts:481-507`
(`composeCounterReview`):

```ts
const routeOverride = snapshot.route_override === undefined
  ? undefined
  : structuredClone(record(snapshot.route_override, "build-request counter-review route_override")) as PlainJsonValue;
...
return computeCallEnvelope(services, { tool: "archflow_counter_review", input: {
  ...mechanicalInput(services, state, intentId),
  artifact_path: paths.artifact_path,
  ...(routeOverride === undefined ? {} : { route_override: routeOverride }),
} });
```

The composer's documented payload shape already includes it (`request-composition.ts:79`:
`'"route_override"?:{"reason":<why the pinned reviewer was substituted>,...}'`). So
`facts: { kind: "counter-review", intent_id, route_override }` is already a legal composer input —
the composition gap really is only producing it.

**Critical wrinkle that refutes "no extra work"**: `substepPlan` (`semantic-actions.ts:599-612`)
builds the in-process review-run continuation and calls
`requestFacts(original.action_kind, substep, intentId, undefined)` — **the submission is dropped**
(line 601). The whole review action runs enter→run→(empty-triage) inside one apply
(`executeReviewAction`, :686-732), so by the time review-run composes, the submission parameter is
gone. Fix options:

- **(i) Plan field (house style)**: `SemanticActionPlanV1` already carries extracted submission
  payloads — `task_ask`, `reopening_request`, `decision_submission` (:61-64), populated in
  `planSemanticAction`'s return (:491-493). Add `route_override?: ...` the same way, then merge it
  into the review-run facts either in `substepPlan` or at the `run_counter_review` capability.
- **(ii) Forward the submission** through `substepPlan` into `requestFacts` (change the
  `undefined` argument). Touches the generic continuation path used by every action.

(i) is the smaller, precedented seam. `composeSemanticActionRequest` (:815-824) exposes
`plan.request_facts` externally, so whichever facts object carries the override is also the
externally composable shape (already covered by PAYLOAD_SHAPE prose).

**Cross-session loss edge**: a crash between review-enter and review-run. Continuation recovery
(:433-446) reuses the operation digest from `last_transition.intent_id` — which binds the
submission *digest* but not its value; nothing durable stores the override itself. The resumed
apply (no submission, fresh offer → `currentOfferMatches` true) dispatches review-run **without**
the override, silently falling back to the pinned route. A client resending the identical
submission cannot reproduce the old operation digest either (the fresh offer's bytes differ), and
recovery does not require it. The phase design must either accept and document this edge or
persist the override; there is no free way to keep it.

**Facts shape the composer reads**: `{ kind, intent_id, ...per-kind fields }` as a plain-json
record (`composeRequest` :855-924 clones and switches on `snapshot.kind`; counter-review at
:901-904). Only `composeCounterReview` consumes `route_override`.

---

## 4. `operationKey` — submission binding into operation identity

`src/state/semantic-actions.ts:117-141`:

```ts
const submissionDigest = canonicalJsonDigest({
  schema_version: "1",
  digest_kind: "semantic-submission",
  submission: submission ?? { kind: "none" },
} as PlainJsonValue);
return Object.freeze({ schema_version: "1", offer_digest: match[1] as Sha256Digest, ..., submission_digest: submissionDigest });
```

- `submission_digest` is a **required** member of `SemanticOperationKeyV1`
  (`semantic-workflow.ts:226`), hashed into `semanticOperationDigest` (:149-155).
- `planSemanticAction` builds the key from the actual input submission (:424
  `const key = operationKey(input.action.offer, operationOffer, input.action.submission);`).
- The digest flows into intent ids: `semanticSubstepIntentId` (:157-160) mints
  `afop-<operation-digest>-<substep>`, recorded on durable transitions.
- Replay matching compares the whole digest: `authenticateSemanticLastTransition` (:175-193)
  requires `parsed.operation_digest === operationDigest` plus tool/operation/fingerprint (and
  request digest when known). Review continuation recovery (:195-214) reads the digest back from
  `last_transition.intent_id`.

**Confirmed**: a submission arriving on the review action is automatically bound into the
authenticated operation identity and into every replay/continuation check — no extra work. Two
nuances: (1) in-process substeps reuse `original.operation_digest` (`substepPlan` :600-601), so
the binding holds across enter→run; (2) the "authenticated old review retry" allowance (:459-462)
requires `candidateOperationDigest === recoveredOperationDigest` — an old-offer retry must resend
a byte-identical submission (same rule the decision retry enforces at :426-428).

---

## 5. Schema regeneration

- `package.json:26`: `"generate:schemas": "node scripts/generate-schemas.mjs"`; `:27`
  `"check:schemas"` is the same script with `--check` (fails on drift; part of `npm run check`).
- The script esbuild-bundles `src/contracts/internal/schema-generation.ts`, imports
  `renderGeneratedSchemaFiles()` (`schema-generation.ts:86-139`), and writes each migrated
  document to **`src/contracts/schemas/v1/<file>.schema.json`** (script constant at line 13 —
  there is no repo-root `schemas/` directory).
- The semantic-workflow group is `src/contracts/internal/schema-generation-semantic-workflow.ts:23-51`:
  root `workflowViewV1Schema`, defs including `applySubmission` (:38); emission is deterministic
  (byte-identical reruns).
- Root-shape convention **holds automatically**: verified
  `src/contracts/schemas/v1/semantic-workflow.schema.json` has a plain object root (properties
  `schema_version … config_change`), no root `oneOf`/`allOf`/`$ref`, and `$defs.applyInput`'s
  `action.properties.submission` is exactly `{"$ref": "#/$defs/applySubmission"}`. The zod union
  arm nests inside that def (zod emits the union as a nested `anyOf`); the guard comment at
  `semantic-workflow.ts:330` ("Plain object root; all variants are nested below `invocation` and
  `action.submission`") stays true.
- The advertised MCP catalogue is derived from this same generated document:
  `src/mcp/tools.ts:59-65` picks `$defs.applyInput`, and `embedSchema` (:102-139) hoists reachable
  defs into a flat `$defs` with single-hop refs. A new union arm (with an inlined route shape)
  flows into the advertised surface automatically, still below root. The advertised byte budget
  test pins `JSON.stringify({tools}).length < 28_200` with ~23.5KB current — a few hundred bytes
  of inline route shape fits the headroom but should be re-measured.

---

## 6. Review offer instruction and route provenance in the view

- Current text, `src/state/semantic-view.ts:182-187` (mapRunStep, case `"counter_review"`):
  headline "Independent review is ready", `instruction: "Run or resume the server-owned
  independent review action."`, `expected_submission: "none"`. **The override mention belongs in
  this instruction** (and/or the shape's `detail`); the sibling finding-free shape (:189-195,
  "Finish the finding-free review without redispatching it.") should not offer it.
- **No per-dispatch route provenance in the semantic view today.** The internal detailed status
  carries it: `counter_review_provenance` at `src/state/status.ts:87-94`
  (`{assurance, producer_family, model_family, model, effort}`) built at `:1112-1126`, which
  appends `route_override` "Present only when a human substituted this review's route for the
  pinned one... the human sees which model reviewed but never that it was not the configured one."
  But `PublicReviewContextV1` (`semantic-workflow.ts:55-58`) projects only rubric + active_rules
  (`reviewContext`, semantic-view.ts:114-135). Evidence renderers render the override
  (`src/contracts/renderers.ts:59, 95`). Surfacing provenance in `WorkflowViewV1` would be new
  contract surface — separate decision from the submission kind.

---

## 7. Server-side flow from MCP input to state transaction

There is **no parser/validation map keyed by submission kind** — the zod union is the only
validator, and kind-specific handling is inline. Complete path:

1. MCP host → `src/mcp/server.ts:132` `parseArchFlowApplyInputV1(args)` — validates through
   `archFlowApplyInputV1Schema` → `applySubmissionV1Schema` (`semantic-workflow.ts:331, 320-328`).
2. `src/mcp/handlers/index.ts:14` routes `archflow_apply` → `handleSemanticApply`
   (`src/mcp/handlers/semantic.ts:224-244`).
3. `executeSemanticAction` → `planSemanticAction` (re-parses the input,
   `semantic-actions.ts:381`) → `assertSubmissionMatches` (:413) → `operationKey` (:424) →
   substeps + `requestFacts` (:469).
4. Review runs `executeReviewAction` inside the dispatch FIFO (:799-803); the `review-run`
   substep executes via the `run_counter_review` capability (`semantic.ts:195-201`):
   `composeRequest(live.services, plan.request_facts)` → `parseToolCall("archflow_counter_review",
   composed.value.envelope.request.input)` — this re-validates the whole input including
   `route_override` against `routeOverrideSchema` (`mcp-tools.ts:188-197`, applied by
   `inputFor` :218-222) → `handleCounterReview(call, context, true)`.
5. `runCounterReview` (`src/review/counter-review.ts:261+`) consumes
   `input.call.input.route_override` per role (:281 `routeFor`, :289 `overrideRecordFor`),
   substitutes the dispatch route, and records a `RouteOverrideRecord` `{reason, pinned_model?,
   pinned_effort?}` on the minted review evidence (:330) and constitution evidence (:380) —
   "the override is validated exactly like a pinned route and recorded on the evidence it
   produces" (:257-259).
6. The transaction commits evidence + state transition under the `afop-<digest>-<substep>`
   intent id; `assertCompletedReviewSubstep` (:663-674) authenticates the landed transition.

So the new kind needs exactly: the zod/type arm (§1), the `assertSubmissionMatches` widening
(§2), and the facts threading + plan field (§3). Everything downstream already exists — the
"only gap is submission → request facts" claim is *almost* right; the two extras are the
assertion seam and the `substepPlan` submission drop.

---

## 8. Phase 1 precedent (`config_change`)

- Type: `semantic-workflow.ts:135` `readonly config_change?: readonly ConfigChangeEntry[];`
  (doc comment :131-134), inside `WorkflowViewV1` (:119-136).
- Zod: `configChangeValueV1Schema` (:295, `z.json()` shared instance) and
  `configChangeEntryV1Schema` (:298-302); wired into `workflowViewV1Schema` (:304).
- Generator changes (commit 31fe7a3, `schema-generation-semantic-workflow.ts` +8 lines): two def
  registrations — `configChangeEntry` (:36) and `plainJson` (:37) — plus
  `overrides: { plainJson: PLAIN_JSON_FRAGMENT }` (:48, the hand-written fragment `z.json()`
  cannot emit in a `$def`).
- Projection: `semantic-view.ts:405-410` (one prose line appended to `detail`) and `:437`
  (verbatim entries on the view).

A new submission *kind* is strictly simpler: it nests inside the already-registered
`applySubmission` def, so the generator file needs **no edit at all** — only
`npm run generate:schemas` and committing
`src/contracts/schemas/v1/semantic-workflow.schema.json`. (CLAUDE.md convention reminder: the arm
must be a `type`-alias union member, never an `interface` — `ApplySubmissionV1` already is one.)

---

## 9. Tests that enumerate kinds or pin schemas/digests

Searched `test/` for `APPLY_SUBMISSION_KINDS`, `applySubmission`, `expected_submission`,
`route_override`, schema pins, and golden digests:

- **`test/contracts/mcp-advertised-schema.test.ts`** — the tightest pins:
  - `:250-273` byte budget: `JSON.stringify({tools: ADVERTISED_TOOL_CATALOGUE}).length` <
    28_200 (currently ≈23.5KB; inline route shape adds a few hundred bytes — re-measure).
  - `:334-340` pins `action.properties.submission` toEqual `{$ref: "#/$defs/applySubmission"}`
    (holds automatically after the arm is added).
  - `:343-405` exact-reachable-closure is self-consistent (walks the schema itself), so new
    defs/arms are accepted; but `:326-327` "no retired staged reference" and root-object fences
    stay green as long as the arm is not at root.
- **`test/contracts/semantic-workflow-contract.test.ts`** (116 lines) — parse round-trips of
  apply input; nothing breaks by adding an arm; **add review-dispatch coverage here** (valid arm,
  missing-both-roles rejection, and the optional-submission behavior).
- **`test/contracts/durable-structural-corpus.test.ts`** — `:755-765` pins the exact "null
  offenders" list including `semantic-workflow.schema.json/$defs/plainJson/anyOf/0/type`; a new
  arm introduces no null so the list is unchanged. Its corpus validates against the `mcp-tools`
  document, not the submission union.
- **`test/contracts/schema-registry.test.ts` / `retired-surface.test.ts`** — pin document
  names/ids and the two-tool catalogue; unaffected.
- **`test/unit/fingerprints.test.ts`** — golden request digests already cover `route_override`
  on `archflow_counter_review` operation fields (:181-183 sensitivity cases, :209-220 uniqueness);
  no golden fixture pins the `semantic-submission`/`semantic-operation` digest kinds, so adding
  the arm changes no pinned digest. (New coverage opportunity: submission-digest sensitivity.)
- **`test/unit/semantic-view.test.ts`** — `:187, :262` pin other actions' `expected_submission`;
  the review offer fixture at :293-299 uses `expected_submission: "none"` but only asserts token
  shape/stability. **No test found pinning the review action's advertised `expected_submission`**,
  so design (b) in §2 breaks no existing assertion (re-grep `kind: "review"` + `toMatchObject`
  before implementation to confirm).
- **Integration journeys** (`config-editing.test.ts:132-249`, `semantic-*-journeys.test.ts`,
  `semantic-upgrade-journeys.test.ts:197-328`) — pin `expected_submission` for submit-work /
  decide / start-next-skill shapes only. They drive review applies with no submission; they keep
  passing under either §2 design, and are the natural place to add an override-carrying review
  journey (design.md:202 already plans "Override requested via review-dispatch during an outage
  scenario runs under the substitute and appears on evidence with reason").
- **Crash/replay** — `mcp-handler-counter-replay.test.ts` operates at the tool level (fingerprint
  + intent identity), no submission kinds; semantic replay is exercised via journeys. If the
  design addresses the §3 crash edge, that is new coverage, not existing.
- **Skills prose** (already mapped in `scratch/phase2-skills-pins.md`): the four reviewing skills
  document submission kinds in prose; the outage procedure must mention `review-dispatch`.

---

## Minimal ordered change set (contracts → state → schema regen → view)

1. `src/contracts/semantic-workflow.ts`: add `"review-dispatch"` to `APPLY_SUBMISSION_KINDS`
   (:99); add the `ApplySubmissionV1` arm (:144-161) with `route_override?: RouteOverrideDeclaration`
   (type import from `mcp-tools.ts:76-80`); add the zod arm to `applySubmissionV1Schema`
   (:320-328) using a parentless `configRouteSchema` clone (mcp-tools.ts:184-196 pattern).
2. `src/state/semantic-actions.ts`: widen `assertSubmissionMatches` (:82-87) per §2 (pick design
   (a) or (b)); thread the override — add `route_override` to `SemanticActionPlanV1` (:51-66)
   populated in `planSemanticAction`'s return (:481-494), and include it in the `review-run` facts
   (:349) / merge in `substepPlan` (:599-612) so the in-process continuation keeps it.
3. `npm run generate:schemas`; commit `src/contracts/schemas/v1/semantic-workflow.schema.json`.
4. `src/state/semantic-view.ts`: review instruction text (:182-187) mentions the optional
   override; under design (b) also set the shape's `expected_submission` there.
5. Tests: contract test coverage for the arm; advertised-schema byte-budget re-measure; an
   override-carrying review journey; skills prose per `scratch/phase2-skills-pins.md`.
