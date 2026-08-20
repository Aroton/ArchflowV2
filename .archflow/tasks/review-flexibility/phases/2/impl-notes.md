# Phase 2 Implementation Notes — Route override through the semantic workflow tools

**Task:** review-flexibility
**Phase:** 2 of 6
**Base commit:** `4f58174`

## Implementation Log: Phase 2 - Route override through the semantic workflow tools

### Decisions Made

- **One optional-kind rule at the single enforcement point** (P2-1). `assertSubmissionMatches` (`src/state/semantic-actions.ts:86-97`) now reads: `"none"` → submission must be undefined; any other kind with a submission present → exact kind match; the one new branch — a submission absent under expected `"review-dispatch"` — is tolerated. No planner-level bypass; no other matcher touched.
- **The plan is the carrier, and the continuation rebuilds the submission parameter** (P2-2). `SemanticActionPlanV1.route_override?` is set at plan time beside the `decision_submission` precedent (`:515`, declared `:66-67`). `substepPlan` (`:620-627`) reconstructs a `{kind:"review-dispatch", route_override}` submission from the plan field and passes it to `requestFacts`, so `review-run` facts (`:357-370`) include `route_override` on both the fresh path (submission parameter) and the continuation path (plan field) — the pinned interface's outcome, implemented by rebuilding the parameter rather than teaching `requestFacts` to read the plan.
- **Arm shape exactly as pinned** (P2-4): `{kind:"review-dispatch", route_override}` with `route_override` required; the route schema is a parentless clone (`overrideRoute` + `routeOverrideDeclarationV1Schema`, `src/contracts/semantic-workflow.ts:323-337`) registered inside the semantic-workflow document — zero `$ref`s in the generated arm, so no cross-document reference can reach the advertised catalogue. `schema-generation-semantic-workflow.ts` needed no edit (verified, not assumed).
- **Honest advertisement** (P2-5): the dispatching review offer (`src/state/semantic-view.ts:182-188`) advertises `expected_submission:"review-dispatch"` with an instruction naming the override as the only reason to submit; the finding-free completion shape keeps `"none"`.
- **One shared outage paragraph across the four reviewing skills** (repo convention of shared dispatch prose): server-reachable route-only scoping, human-authorized substitute route + required reason recorded on evidence, the exact `review-dispatch` JSON shape, never skips the counter-review, explicitly not the degraded-operation stop path. archflow-upgrade gained the one-clause carve-out; archflow-init gained the config `overrides` guidance paragraph (five phase kinds including `explore` — template-faithful).
- **Status provenance type closed**: `StatusEvidence.counter_review_provenance` (`src/state/status.ts:87-94`) now declares `route_override?: RouteOverrideRecord` — the field the gate block has spread in since the override plumbing landed. Pre-existing gap (dates to `6549da8`), one line, fixed here because the phase's success criterion names typed status provenance visibility.
- **Test-scope decisions**: same-family (gpt) substitution through the public path; cross-family rerouting stays pinned at the `runCounterReview` level (`test/integration/review-fixed-point.test.ts`) — the public apply path exercises identical validation/resolution/record code before the family-specific CLI protocol begins.

### Deviations from Plan

- **Plain-json cast at the facts member** (`src/state/semantic-actions.ts:368`): zod's inferred `provider?: string | undefined` on `ModelRouteV1` is not assignable to `PlainJsonValue` under `exactOptionalPropertyTypes`; one targeted `as unknown as PlainJsonValue` follows the composer's existing idiom for this exact value (`composeCounterReview`, `src/state/request-composition.ts:495-497`). The declaration is runtime plain-json-asserted at parse.
- **Crash-window simulation by failing stub, not SIGKILL**: the review crash window sits *between* two committed substeps, so its durable aftermath is exactly "review-enter committed, review-run absent". The journey test produces that authentically through the public path: a stub whose first launch exits 70 (`PROCESS_FAILED`, non-retryable) after the substituted apply commits review-enter — the same durable bytes a kill would leave. The `test/crash/` SIGKILL pattern cuts *inside* one transaction and cannot express this window.
- **No `skill-contract-canonical.test.ts` pin edits were needed**: grep confirmed no assertion pinned the reworded "no-submission `review`" sentences or the upgrade submission rule (the design said "update any … asserting the reworded sentences" — there were none; the `no-submission` pins cover only untouched `open-waiver`/`revise` sentences). New outage pins live in `skill-contract-server-outage.test.ts` (seven substring pins × four skills).
- **`src/state/status.ts` joined the file list** (type gap fix above); otherwise the touched set matches the phase design's summary.

### Patterns Established

- **Optional-kind submission matching**: when a submission kind's absence is legal, encode it once in `assertSubmissionMatches` (absence-tolerant, present-exact) and advertise the kind honestly on the offer — never relax the matcher while advertising `"none"`.
- **Per-document schema clones, again**: the parentless-clone `$def` pattern from phase 1 (config snapshot mirror) is now the established answer for any shared schema instance crossing a persisted/advertised document boundary.
- **Between-substep crash simulation**: durable aftermath of an interrupted multi-substep apply is reproduced by a stub that fails the first dispatch after the boundary commits — no process killing, identical durable bytes.

### Gotchas

- zod-inferred optionals (`field?: T | undefined`) are not `PlainJsonValue` under `exactOptionalPropertyTypes`; shed the inferred `undefined` with the composer's targeted cast, never by redefining the shared type.
- The advertised catalogue grew to **25,440 bytes** (arm fully inlined; was ~23.5 KB) against the `< 28_200` budget pin — ~2.7 KB headroom remains; re-measure when the next arm lands.
- Skills are not dist-bundle inputs (`install.sh` copies `skills/` directly); the dist rebuild covers src/schema bytes only — but it is still required after this phase's src changes, or `release-offline` fails with "stale bundle input".
- `substepPlan` now passes a reconstructed submission to `requestFacts` for every substep of a review plan; safe because the only submission-consuming throw in `requestFacts` lives under `case "triage"` (a different action kind that never carries `route_override`).

### Key Interfaces

- `ApplySubmissionV1` arm: `{ readonly kind: "review-dispatch"; readonly route_override: RouteOverrideDeclaration }` — `RouteOverrideDeclaration` type-imported from `src/contracts/mcp-tools.ts`, never redefined (`src/contracts/semantic-workflow.ts:164`).
- `APPLY_SUBMISSION_KINDS` includes `"review-dispatch"` (`:101`); the `expected_submission` zod enum auto-widened.
- `assertSubmissionMatches` rule as quoted in Decisions (`src/state/semantic-actions.ts:86-97`).
- `SemanticActionPlanV1.route_override?: RouteOverrideDeclaration` (`:66-67`, set `:515`, consumed `:620-627`).
- Dispatching review offer: `expected_submission: "review-dispatch"` (`src/state/semantic-view.ts:182-188`).
- `StatusEvidence.counter_review_provenance.route_override?: RouteOverrideRecord` (`src/state/status.ts:87-94`).

### Verification Evidence

All commands run from `4f58174` + this change; raw, unedited output in the phase verification transcript (`.archflow/runtime/tasks/review-flexibility/cache/phases/2/verification.txt`):

- `npm run typecheck` — 0 errors (whole repo).
- `npm run generate:schemas` — 32 schemas written; git shows only `semantic-workflow.schema.json` changed (expected_submission enum + the self-contained arm); the other 31 byte-identical.
- `npm run test:unit` — 106 files, 1165 tests passed (was 1161; +4 matcher/continuation/crash-window tests).
- `npm run test:contracts` — 27 files, 502 tests passed (was 501; +1 advertised-arm pin).
- `npx vitest run test/integration` — first run 219/221 with the 2 failures in `release-offline` on "stale bundle input: src/contracts/schemas/v1/semantic-workflow.schema.json" (run preceded the rebuild, phase-1 pattern; both runs recorded in the transcript). After the dist rebuild: **40 files, 221 tests passed**.
- `npx vitest run test/crash` — 3 files, 34 tests passed.
- `npm run release:stage -- --output <tmpdir>` + `npm run release:write -- --stage <tmpdir>` — tracked `dist/` payload rebuilt (`archflow-mcp.mjs`, `manifest.json`, `metafile.json` changed; `archflow-local.mjs` byte-identical — no local-adapter input changed this phase).
- `npx vitest run test/integration/release-offline.test.ts` — 3/3 passed against the rebuilt bundle.

Behavior pins: public-apply substitution runs the child under the substitute route with `RouteOverrideRecord` + human reason on retained evidence and `counter_review_provenance.route_override` in status (`test/integration/review-dispatch-override.test.ts`); request digest changes with the override while the subject input fingerprint stays identical (`test/integration/semantic-composition-parity.test.ts`); crash-window semantics per P2-3 pinned at unit and journey level (lost value dispatches configured, resent substitution rides the recovered operation identity as a fresh request); advertised schema root plain, arm self-contained, 25,440 bytes < 28,200 budget.
