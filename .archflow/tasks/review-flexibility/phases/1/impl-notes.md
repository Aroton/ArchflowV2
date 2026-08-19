# Phase 1 Implementation Notes — Config as an editable input

**Task:** review-flexibility
**Phase:** 1 of 6
**Base commit:** `d4035e9`

## Implementation Log: Phase 1 - Config as an editable input

### Decisions Made

- **`TaskConfigSnapshot = AbsentIsAbsence<ConfigV1>`** (`src/contracts/config.ts:51-61`). Under `exactOptionalPropertyTypes`, zod's `.optional()` infers `field?: T | undefined`, and the explicit `undefined` breaks the `PlainJsonValue` constraint on the whole `TaskStateV1` graph. The snapshot type must be the undefined-stripped alias; defined beside `configV1Schema` so it cannot drift.
- **Self-contained zod mirror for the snapshot** (`src/contracts/durable-state.ts:531-558`). Embedding `configV1Schema` instances would emit cross-document `$ref`s (`urn:archflow:schema:v1:config#...`); no committed schema contains cross-document refs and `task-state.schema.json` is validated with only `primitives` and `path-claim` companions. The mirror is built from parentless per-level clones sharing the same defs (the `mcp-tools.ts` clone precedent), registered as task-state-local `$defs` in `src/contracts/internal/schema-generation-durable.ts`.
- **Resolver returns the accepted value** (`src/state/fingerprint.ts`): `ResolvedInputFingerprint = Readonly<{ subject; fingerprint }>`; `legacyInputFingerprint` recomputes the exact pre-change digested field set with `config_digest` taken from `context.state.value.config_digest` (creation-time record, never live bytes). Retry-once-and-accept; nothing recorded is rewritten; a no-match returns the new composition so the caller's existing mismatch error fires.
- **Expected-digest seam** threaded through `FingerprintReadContext.expected_input_fingerprint` (`src/state/read.ts:38-40`) and `GateReentryFingerprintResolver` (`src/state/gate-core.ts:69`). `exactOptionalPropertyTypes` requires a conditional spread when threading the optional field (in `production.ts`).
- **Recording points for `last_seen_config`** — kernel `buildPlan` (after `assertPreserved`, before `prepared_state` derivation), revision-zero `initialState` seeding, gate open, material-drift restart landing. Settlement commits deliberately leave the baseline unchanged; the notice persists to the next config-observing commit.
- **Status/semantic-view surfaces** — `TaskStatusV1.config_change?: readonly ConfigChangeEntry[]` (absent baseline records nothing and notices nothing); semantic view projects entries verbatim plus a one-line prose mention; never a blocker or action-kind change.
- **`ConfigVerification`** reduced to `{ verified, issue? }`; any `config_verified !== true` derives `inspect-state` (`human_required: true`) with a repair detail naming the config file and read issue; `config-unresolvable` (the status catch path) is folded into the "unreadable" wording.
- **Parsed-config plumbing**: `LiveConfigSnapshot` gained `parsed` (`src/state/read.ts:29-31`); `readTaskConfig` returns the value it already parsed (one parse ever); `readStagedLegacyConfig` supplies it for the staged-legacy fallback.
- **`normalizeForChangeDetection` drops `roles.producer` only** — a retired `producer` under `overrides.<phase>` (schema tolerates it there too) would still report as a change. Accepted as in-scope-for-later; the parser's active roles are `counter-reviewer`/`adjudicator`.

### Deviations from Plan

- **The PRD planning-restart landing is a comparing site, not a flip site** (`src/mcp/handlers/state.ts:~200`). The phase design (following the task design's D2 correction) listed `state.ts:200` among the no-expected write sites that flip a legacy task to the new composition. It cannot be: the landing commits through the kernel, whose claim compare (`liveIdentification`) and equality pin (`buildPlan`) bind the next state's fingerprint to the request's claimed value, so a legacy-recorded task would hard-fail a planning restart with `INPUT_FINGERPRINT_MISMATCH`. The site now passes `expected_input_fingerprint = restartInput.input_fingerprint` and preserves the accepted composition. The no-expected flip sites are revision zero, the material-drift restart landing (a gate-lifecycle write outside the kernel), and gate-reentry landings. Phase-design Deviations item 9 records this; the task design's D2 wording and the phase design's Chunk B / pinned-interfaces text were updated in the same change. Pinned by `test/integration/mcp-handler-state-replay.test.ts` ("restarts a legacy-composition task to PRD while preserving its recorded fingerprint").
- **The kernel injection order** (`src/state/transaction.ts`, `buildPlan`): the initial Chunk D placement applied `withLastSeenConfig` before `assertPreserved`; `isExactPlanningRestartDraft` rebuilds its expected draft from the current state (no `last_seen_config`) and deep-compares, so every planning-restart transaction on a state whose baseline is absent or differs threw `TypeError: next state draft changed gate authority`. Moved to the design's pinned position: after `assertPreserved`, before `prepared_state` derivation. Found by the failing `mcp-handler-state-replay` test; empirically confirmed and fixed.
- **File-list additions beyond the design's summary**: `src/contracts/config.ts` (snapshot type), `src/contracts/internal/schema-generation-durable.ts` and `schema-generation-semantic-workflow.ts` (schema registration), `src/state/gate-core.ts` (reentry seam typing, 2 lines), `src/state/legacy-stage.ts` (parsed plumbing), `src/contracts/semantic-workflow.ts` + regenerated `semantic-workflow.schema.json` (view notice field), and the tracked `dist/` payload (rebuilt; `release-offline`/`install-script` verify the bundle against src inputs).
- **Verification item 7 (real-host)**: `test/real-host/terminal-journey.test.ts` was updated (config-mutation expects success + notice; artifact config-digest mutation now records provenance rather than being rejected at the retired revision-zero boundary), but the suite cannot execute: it drives local-CLI commands (`build-request`, `envelope`, `status`, `decide`) retired by main's commit `8229038`; all 11 tests fail at fixture setup before any config behavior, pre-existing and unrelated to this phase (`test/contracts/retired-surface.test.ts` pins those commands as retired). Left updated-but-unrun for that reason.
- **Cross-repository discrimination**: with config bytes out of the fingerprint, the negative fixture in `semantic-document-journeys.test.ts` pinned identity on distinct root-commit bytes (`test/helpers/task-workspace.ts` `rootBytes` option) — the old fixture only violated it by timing luck.
- The design's "settlement writes never read config" was imprecise: they do read config via `validateLiveGateState`; they only fail to *record* (behavior matches intent).
- Revision-zero seeding required reordering the config read ahead of `initialState` in `identifyStateInitialization`: config-invalid/unreadable now surfaces before artifact-semantics errors (both fail-closed `CONTRACT_INVALID`-class paths; precedence change only).

### Patterns Established

- **Comparing vs. writing fingerprint sites**: any computation whose result lands in a kernel-committed state must supply the claim as `expected_input_fingerprint` (the accepted value is then what the kernel pins); only writes that bypass the kernel (gate lifecycle) or seed fresh state (revision zero) may flip composition. Future callers of the resolver should be classified against this rule.
- **Persisted zod snapshots**: undefined-stripped `type` alias beside the schema (plain-JSON constraint), plus a self-contained per-document mirror — never shared schema instances across documents (cross-document `$ref`s are unresolvable in committed schemas).
- **`withLastSeenConfig`** (`src/state/config-change.ts:84`): generic over `Draft extends { readonly last_seen_config?: TaskConfigSnapshot }` — usable by kernel drafts, full state gate drafts, and revision-zero seeding without importing `NextStateDraft` (no cycle). Stores the *normalized* snapshot so a cosmetic producer-retire never rewrites committed bytes.
- Test naming per behavior, not phase: `config-editing.test.ts` (was `config-pinning.test.ts`), `config-change.test.ts`, integration `config-editing.test.ts`.

### Gotchas

- `createProductionServices` caches the state snapshot at creation: rewriting `state.json` on disk does not change what a live services instance's envelope claims. Tests that simulate a legacy recording must create a fresh services instance after the rewrite (bit us in the replay test; documented there).
- The tracked `dist/` bundle must be rebuilt after any src change or `release-offline` fails with "stale bundle input" — `npm run release:stage -- --output <tmpdir>` then `npm run release:write -- --stage <tmpdir>`.
- A `z.json()` field in a schema-generated document needs the repo's registered-def + hand-fragment pattern (`PLAIN_JSON_FRAGMENT`, exported from `schema-generation-durable.ts`).
- The handler-session unit case cannot go through `handleCounterReview` anymore: past the removed pin it proceeds into real child dispatch. Exercise `openHandlerSession` directly (the site the design names).
- `parseConfigYaml`'s zod output carries `| undefined` optionals; tests cast through `as TaskConfigSnapshot`, mirroring the production cast in `src/state/read.ts`.

### Key Interfaces

- `createInternalInputFingerprintResolver` → `ProjectResult<ResolvedInputFingerprint>` where `ResolvedInputFingerprint = Readonly<{ subject: InputFingerprintSubject; fingerprint: Sha256Digest }>` (`src/state/fingerprint.ts:25-37`).
- `FingerprintReadContext.expected_input_fingerprint?: Sha256Digest` (`src/state/read.ts:38-40`).
- `TaskStateV1.last_seen_config?: TaskConfigSnapshot`; `TaskConfigSnapshot = AbsentIsAbsence<ConfigV1>` (`src/contracts/config.ts`, `durable-state.ts:307`); `ConfigChangeEntry = { path, before?, after? }` (`durable-state.ts:314-319`).
- `src/state/config-change.ts`: `normalizeForChangeDetection(config)`, `computeConfigChange(before, after) → readonly ConfigChangeEntry[]`, `withLastSeenConfig(draft, parsedLiveConfig) → Draft`.
- `TaskStatusV1.config_change?: readonly ConfigChangeEntry[]`; `WorkflowViewV1.config_change?` (`src/contracts/semantic-workflow.ts:135`).
- `ConfigVerification = { verified: boolean; issue?: string }` (`src/state/status.ts:55-58`).
- Golden request-digest fixtures regenerated once for the config-free composition (`test/unit/fingerprints.test.ts`).

### Verification Evidence

All commands run from `d4035e9` + this change; raw output in the phase verification transcript:

- `npm run typecheck` — 0 errors (whole repo).
- `npm run generate:schemas` — 32 schemas written; diff reviewed: `project-error.schema.json` (−54, `E_PINNED_CONFIG_MISMATCH` removed), `task-state.schema.json` (+95, `last_seen_config` + snapshot defs), `semantic-workflow.schema.json` (+58, view `config_change` + `configChangeEntry`/`plainJson` defs).
- `npm run test:unit` — 106 files, 1161 tests passed.
- `npm run test:contracts` — 27 files, 500 tests passed (durable-semantics corpus `config_digest` agreement rows unchanged; no `E_PINNED_CONFIG_MISMATCH` rows remain).
- `npx vitest run test/crash test/integration/state-transaction.test.ts test/integration/state-gate-lifecycle.test.ts test/integration/state-projection-fresh-task.test.ts` — 6 files, 72 tests passed.
- `npx vitest run test/integration` (full, re-run after the tracked payload rebuild) — 39 files, 217 tests passed. (First full run failed only `release-offline`×2 on a stale dist bundle; rebuilt and re-run — the transcript records both runs.)
- Real-host `terminal-journey.test.ts` — updated but not runnable in this environment (drives local-CLI commands retired in `8229038`; fails at fixture setup before any config behavior; pre-existing).

Behavior pins: mid-task edit accepted with field-level notice and baseline update (`test/integration/config-editing.test.ts`); open gate + recorded evidence survive an edit, settlement leaves the notice until the next config-observing commit; legacy-recorded task transacts post-cutover, keeps its composition on the ordinary path and through a planning restart, converges at the gate-reentry landing, and its pre-cutover reentry landing still replays; unparseable config fails closed (`CONFIG_INVALID`, `config-invalid` + `inspect-state`).
