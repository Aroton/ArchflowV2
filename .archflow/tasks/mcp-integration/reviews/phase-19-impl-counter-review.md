# Phase 19 Implementation Counter-Review

Reviewed: uncommitted working tree against `.archflow/tasks/mcp-integration/phases/phase-19-legacy-upgrade-workflow.md`, `architecture.md`, and `.archflow/context/`. Only one workspace repository is present (`/home/aroto/ArchflowV2.feature/mcp-server`); its `.archflow/context/` is the only context set.

Verified locally: `npm run typecheck` passes; the four Phase 19 test files (`test/unit/legacy-upgrade-phase19.test.ts`, `test/integration/legacy-upgrade-phase19.test.ts`, `test/contracts/skill-contract-phase19.test.ts`, `test/crash/state-initialization.test.ts`) pass, 24 tests; `npm test` fails — 3 tests in `test/integration/release-offline.test.ts` (see finding 1).

Five findings. One blocker, four major.

---

## 1. Blocker — the tracked bundles were not rebuilt, so `npm test` is red

`dist/archflow-local.mjs`, `dist/archflow-mcp.mjs`, `dist/manifest.json`, and `dist/metafile.json` are unchanged (`git status dist` is empty), while shared runtime inputs did change. `npm test` fails three cases in `test/integration/release-offline.test.ts`:

```
AssertionError: stale bundle input: src/init/task-initialization.ts
AssertionError: risk decision bundle binding is stale: fast-uri-3-1-0-local-risk
```

This is the Files-table rows for all four `dist/` artifacts and success criterion 13 ("Full typecheck, unit, integration, contract, MCP-runtime, build, dependency, notice, release-integrity, and release-reproduction checks pass"). Note that only the first failure is the implementer's to fix now: work-breakdown chunk 9 puts the bundle rebuild *before* the human risk-acceptance gate and the release-evidence rebinding *after* it.

**Resolution**: rebuild both tracked bundles and their manifest/metafile, re-run `npm test`, then stop at the mandatory human gate for explicit risk re-acceptance bound to the final MCP bundle digest before touching `release/legal-review.json` and `release/evidence/*`.

---

## 2. Major — the resume phase is derived from `impl-notes` destinations, not from `phase-impl-<n>` in the mapping

`src/init/legacy-upgrade.ts:332-338` and the server-side twin at `src/state/gates.ts:235-244` both skip every mapping entry whose `destination_path` does not end in `/impl-notes.md` before taking the highest `phase-impl-<n>`.

The design states the rule three times as "one past the highest `phase-impl-<n>` **in the mapping**" (Overview §24, chunk 4, chunk 6) and success criterion 9 repeats it. Under that rule the highest `phase_instance` of kind `phase-impl` counts wherever it appears — including the counter-review families, which chunk 4 maps to `reviews/phase-impl-<n>.counter.md` with `phase_instance: phase-impl-<n>`.

The shipped fixture is exactly the case where the two rules disagree, and the tests pin the deviation rather than flag it:

- `test/fixtures/legacy/` has logs for phases 1 and 2 and `reviews/phase-3-impl-counter-review.md` but no phase-3 log.
- `test/integration/legacy-upgrade-phase19.test.ts:108` asserts `resume_phase: "phase-design-3"`. The design's literal rule gives `phase-design-4`.
- `test/unit/legacy-upgrade-phase19.test.ts:101-105` asserts `phase-design-2` while asserting in the same block that the mapping contains a `phase-impl-3` entry.

Both derivation sites agree with each other, so nothing is internally inconsistent — the defect is that the shipped behaviour is not the specified behaviour, and no implementation log records the change. The two readings have opposite hazards, so this needs an explicit decision, not a silent one: the implemented rule redesigns and reimplements a phase whose implementation history was imported; the specified rule would skip a phase that was reviewed but never logged, and `planned_final_phase` would then let the task reach terminal completion with that phase never implemented.

**Resolution**: pick one rule deliberately. If the implemented rule stands, amend the design's three statements and criterion 9 to say "the highest imported implementation log", keep the skill text (which already says "one past the highest mapped implementation log"), and record the deviation in the phase log. If the design's rule stands, drop the `/impl-notes.md` filter in both places and update both tests.

---

## 3. Major — the second `legalMovement` clause is an undesigned denial that blocks the ordinary successor

`src/state/transitions.ts:137-141`:

```ts
if (
  current.phase_instance === "design" &&
  input.legacy_resume_phase !== undefined &&
  target.phase_instance !== input.legacy_resume_phase
) return false;
```

Chunk 6 specifies exactly one clause, an admitting one. This second clause denies. Enumerating its effect from `design/adjudicate/succeeded` with a resolved resume phase `R = phase-design-k, k > 1`:

- `target = R`: clause 1 decides it (admit with an authenticated audit, refuse without). Clause 2 never fires.
- `target = phase-design-j`, `j ∉ {1, k}`: clause 2 returns false, but the ordinary successor clause already returns false. No change.
- `target = phase-design-1`: clause 2 returns false where the ordinary successor clause would return **true**.

So the clause's only behavioural effect is to forbid the natural `design → phase-design-1` move for any legacy-import task with at least one imported implementation log. A human who wants to import legacy material and then rebuild the whole plan from phase 1 has no path: the task cannot leave `design` at all except through an accepted `migration-audit`, and `exclude` cannot express "start over" without excluding every log and thereby changing `import_digest` and the mapping.

If forcing the audit before any post-design movement is intended, it is a trust boundary the design never states and the skill never mentions. If it is not intended, the clause is code with no requirement behind it.

**Resolution**: delete the clause, or — if the intent is that a legacy-import task must not advance past `design` without an audit — state that in the design and in `skills/archflow-upgrade/SKILL.md`, and add a test that pins the refusal.

---

## 4. Major — a legacy task deadlocks at `design` when `imports/` holds no manifest matching `initialization_digest`

`src/state/gates.ts:230-233`: when `imports/` exists but no manifest canonical-digests to `state.initialization_digest`, `findLegacyImportResumePhase` returns a non-advancing `STATE_INVALID` / `legacy-import-manifest-missing`. `src/mcp/handlers/state.ts:231-235` propagates it, and because the handler runs this resolution on **every** `design/adjudicate/succeeded → phase-design-*` transition, the task can never leave `design` again — including by the ordinary successor move, which needs no manifest at all.

Reachable without any tampering:

- The pure-manual route (REQ-50, criterion 11). A human hand-authors the initialization checkpoint after staging — chunk 4 leaves several fields to human choice, and any divergence from the staged bytes (different `import_baseline_commit`, a hand-trimmed `exclude`) yields an `initialization_digest` that no on-disk manifest matches. The task initializes fine, walks `prd` and `design`, and then wedges with no diagnostic pointing at the manifest.
- Staging an upgrade into a task id, changing course, and initializing that same task with `task-init` — this directly contradicts chunk 2's claim that an interrupted staging "leaves inert unreferenced bytes".

The hard failure buys nothing at this site: with `legacy_resume_phase === undefined`, `hasAuthenticatedMigrationAudit` returns false and the jump clause cannot fire, so the jump is already refused. The failure is only load-bearing on the gate path, where `loadLegacyImportResumePhase` (`src/state/gates.ts:247-256`) already converts `undefined` to an error — so `migration-audit` still cannot open without a resolvable manifest.

**Resolution**: return `ok(undefined)` from `findLegacyImportResumePhase` on zero matches (keep the failure for `matches.length > 1`), and add a test that a task whose `imports/` holds a non-matching manifest still takes the ordinary `design → phase-design-1` move while `migration-audit` still refuses to open.

---

## 5. Major — criterion 10 is unproven; the destination walk is synthesized rather than run

`test/integration/legacy-upgrade-phase19.test.ts:226-232` hand-writes `state.json` to `design/adjudicate/succeeded` with `planned_final_phase: 3` instead of driving the pipeline, and the jump case stops at `phase-design-3/produce/**running**` (lines 300-314).

Two consequences:

- Criterion 10 ("After the jump, production at the resume phase resolves both upstreams from the retained results and approvals the walk created") is never exercised. Upstream resolution happens at the produce-**succeeded** boundary via `loadProduceUpstreamSubject` / `requireApprovedUpstreamDigests`; the successful `computeCallEnvelope` at line 305 does not cover it, because `upstreamPaths` in `src/state/fingerprint-readers.ts:86-88` returns an empty list, so the input fingerprint carries no upstream identities. This is the single claim the whole phase shape rests on — the Context section justifies initializing at `prd` and walking both phases precisely to create those results and approvals.
- Criterion 5 ("producing normally through the current pipelines and mandatory human gates") is asserted only for the two artifact-approval gates, which are opened against a hand-written cursor; `produce`, `self_review`, `counter_review`, `triage`, and `adjudicate` never run for `prd` or `design`, so the verification step's "no imported evidence is accepted as current" is not tested either.

The document-seeding half is genuinely covered (`buildDocumentArtifact` + `prepareDocumentResult` + `installSnapshot` over the seeded bytes at lines 199-225), so the `exact`-versus-`collision` concern is not at issue here.

**Resolution**: extend the jump scenario with one produce-succeeded call at `phase-design-3` carrying a real document artifact, asserting both upstreams resolve from the retained `prd`/`design` results and their approvals. Driving the two rerun phases through the real step transitions rather than a written `state.json` would also close criterion 5; if that is judged disproportionate for a prototype, say so in the phase log rather than leaving the criterion silently unchecked.

---

## Workflow items, not findings

- `.archflow/tasks/mcp-integration/phases/phase-19-legacy-upgrade-workflow-log.md` (Files table, chunk 9) does not exist yet. Expected at this point in the phase, but it is where findings 2 and 5 need to be recorded if either is resolved by accepting the current behaviour.
- `release/legal-review.json` and `release/evidence/*` are correctly untouched — chunk 9 gates them behind the human risk re-acceptance.

## Checked and not reported

- `validateLegacyMapping`'s non-prefixed branch (`src/state/initialization.ts:113-120`) composes a deliberately unclassifiable claim to obtain a `PATH_INVALID` result instead of returning one directly. It behaves correctly for every reachable input; a `destination_path` long enough to overflow 1024 bytes once prefixed would throw instead, but that needs a hand-authored hostile manifest, which the PRD puts out of scope, and `createToolBoundary` converts the throw to a clean internal failure.
- `phaseForLegacyDestination`'s gate-counter pattern is narrower than `PATH_SAFE_ID`. The stager never emits gate-counter mappings, and nothing requires supporting one.
- Merging non-regular skipped entries into `unmapped` is forced by the `StagedLegacyUpgrade` shape the design pins, which has no `skipped` field.
- The `migration-audit` gate context is not cross-checked against the retained manifest. The design specifies exactly three open preconditions and does not ask for it; the jump is separately bound to the manifest whose digest matches `initialization_digest`.
- `commitDigest` parameterization, the `code_baseline_digest` / `policy_baseline_digest` separation for equal commits, `import` path-class writes, `exclude` as a pre-parse escape, zero-byte payloads, rerun idempotence, and the destination preflight ordering all match the design and are covered by the shipped tests.

## Triage

- **Finding 1 (tracked bundles not rebuilt) — rejected as an implementation defect; retained as the active release gate.** The source and tests reached the verification gate before release finalization, and the release writer atomically validates the bundle-bound `fast-uri@3.1.0` acceptance while promoting the tracked payload. A post-triage candidate was built outside the repository and produced MCP digest `52e5ab4d4a824925dc0a9690294ad1b27580356e383c42f0b1e463327d92bf2f`; the user has not yet accepted that digest. Updating tracked `dist/` piecemeal before that acceptance would bypass the repository's release transaction rather than fix code. The three release failures therefore remain the expected non-passing gate until explicit acceptance authorizes risk/legal evidence and tracked-payload promotion.

- **Finding 2 (resume derivation differs from the approved mapping rule) — accepted.** Both derivation sites again count every mapped `phase-impl-<n>`, including implementation counter-review mappings, exactly as the approved design states. The fixture's log-less phase with an implementation counter-review now derives `phase-design-4`; the unit and integration expectations were updated, and the integration walk revises the imported design to add a fourth phase before design approval.

- **Finding 3 (ordinary successor denied when a later resume exists) — accepted.** The extra denial clause was removed. The authenticated migration-audit clause remains the sole added admission for a non-successor jump, while ordinary `design` to `phase-design-1` remains legal. A focused transition test pins that a resolved later legacy resume phase does not suppress the ordinary successor.

- **Finding 4 (zero matching manifest deadlocks the ordinary successor) — accepted.** `findLegacyImportResumePhase` now returns no jump authority for zero matches and still rejects ambiguity. The state handler bypasses manifest discovery entirely for the natural `phase-design-1` successor; a later jump remains refused without a matching manifest, and `loadLegacyImportResumePhase` still makes migration-audit opening fail closed. Focused tests cover a non-matching retained manifest and the ordinary successor with a later resume value.

- **Finding 5 (resume-phase upstream resolution unproven) — accepted.** The integration scenario now continues past the authenticated jump and submits a real `phase-design-4` document artifact at `produce/succeeded`. Success through the real state handler proves the retained PRD/design results and their artifact approvals satisfy upstream loading, and the final authoritative-result assertion pins the new resume-phase result alongside both upstream references. The test continues to seed and prepare PRD/design artifacts directly so it isolates Phase 19's new import and jump seams; the unchanged per-step review pipeline remains covered by its owning Phase 14/17 integration suites rather than being duplicated here.
