# Config pinning in ArchFlow — research for task "review-flexibility"

Repo: /home/aroton/ArchflowV2.feature-review-override-flexibility (branch feature/review-override-flexibility)
All paths relative to repo root unless absolute.

## 1. Config parsing / validation / shape

### Contract (src/contracts/config.ts)

- `configRouteSchema` (L11-17): `{ model: string, effort: "low"|"medium"|"high"|"xhigh"|"max"|"ultra", provider?: string }` — `.strict()`. `provider` is a cc-switch provider id (claude routes only).
- `configRolesSchema` (L19-25): `{ producer?: Route (retired, accepted on read only), "counter-reviewer"?: Route, adjudicator?: Route }` — `.strict()`. `ROUTING_ROLES = ["counter-reviewer", "adjudicator"]` (L8).
- `configOverridesSchema` (L27-33): optional per-phase-kind role tables for `explore | prd | design | phase-design | phase-impl`.
- `configV1Schema` (L35-40): `{ schema_version: "1", roles, overrides?, max_attempts?: positive safe int }` — `.strict()`.
- `parseConfigV1(value)` (L45-48): `assertPlainJson` then zod parse. `parseConfigYaml(source, label)` (L50-52): `parseSingleYamlDocument` then `parseConfigV1`. The parsed result is a plain JSON object (diffable).

### Read path

- `src/state/read.ts:106-121` `readTaskConfig(path)` — requires `path_class === "task-config"`; reads bytes; `parseConfigYaml` to validate; returns:
  - `{ kind: "valid", snapshot: { bytes, digest: sha256Bytes(bytes) } }` (`LiveConfigSnapshot`, L27-30),
  - `{ kind: "invalid", digest }` when bytes won't parse (digest travels with the failure so a schema rejection of the pinned bytes is distinguishable from a byte change),
  - `{ kind: "missing" | "unreadable" }`.
  Note: the parsed value is discarded; only bytes + digest survive this read.
- `src/state/authority.ts:75-82`: `createInternalTransactionAuthority` resolves the task's `config.yaml` as `authority.config` (`task-config` path class).
- Typed re-parse for dispatch: `src/mcp/handlers/session.ts:67-75` (`HandlerSession.config`), `src/state/status.ts:765`, `src/state/request-composition.ts:596-599`.

### Consumption (routing)

- `src/dispatch/routing.ts`:
  - `configuredRoute(config, phaseKind, role)` (L88-94): `config.overrides?.[phaseKind]?.[role] ?? config.roles[role]` — unvalidated read (for reporting what an override displaced).
  - `resolveDispatchRoute` (L96-106): validates via `routeFromConfiguredRoute` (L57-80): model must be a safe id; family from prefix (`claude-*`/`gpt-*`) unless `provider` forces claude; effort must be adapter-supported. Failures throw `DispatchRoutingError` with `CONFIG_INVALID`/`CONFIG_MODEL_UNSUPPORTED`.
- `src/state/status.ts:772-782`: status resolves live routes for the current phase kind into `status.routes` (`{counter_reviewer, adjudicator}`), and `status.max_attempts` at L1036.
- `src/review/counter-review.ts:283-293`: dispatch resolves role routes from `session.config`; L293 keeps the unvalidated `configuredRoute` to report what a `route_override` displaced.
- `src/state/request-composition.ts:596-614`: reads live config `max_attempts` for the fixed-point exhaustion assessment (`review/fixed-point.ts:443` `subject.max_attempts ?? DEFAULT_MAX_ATTEMPTS`).

### Creation of the task config file

- `src/init/task-initialization.ts:67-90ish` `createTaskConfig(worktreeRoot, taskId)`: copies `.archflow/config.yaml` (itself installed from `assets/config.template.yaml`, `src/init/assets.ts:21`) to `.archflow/tasks/<task>/config.yaml`.

## 2. Config digest lifecycle

### Computation + storage

- `src/contracts/fingerprints.ts:383-405`:
  - `computePinnedConfigDigest(configBytes) = sha256Bytes(configBytes)` (L388-390). Doc comment: "There is no in-task amendment and no re-pin schema".
  - `verifyPinnedConfig(expected, observedBytes)` (L397-405) → `{expected_digest, observed_digest}` error `PINNED_CONFIG_MISMATCH` only; never config content.
- Computed at task creation: `src/init/task-initialization.ts:232` `config_digest: computePinnedConfigDigest(configBytes)` into `TaskInitializationV1`. Legacy import path: `src/init/legacy-upgrade.ts:340`.
- Durable homes of `config_digest`:
  - `TaskInitializationV1.config_digest` — `src/contracts/durable-task-initialization.ts:41` ("the only config digest this shape carries (D15)", L40).
  - `LegacyImportInitializationV1.config_digest` — `src/contracts/durable-legacy-import.ts:78` (L58: destination's config bytes, "the only one").
  - `TaskStateV1.config_digest` — `src/contracts/durable-state.ts:271`. One of the "five pinned-input fields" deliberately duplicated between state.json and the initialization document so status can read state.json alone (comment L239-244, REQ-14/REQ-21); `validateDurableSemantics` compares them field-by-field.
- State↔initialization agreement check (provenance, not live bytes): `src/contracts/durable.ts:713-714` — `state.config_digest !== initialization.config_digest` → `STATE_INVALID` issue `configDigestMismatch` (`DURABLE_ISSUE_CODES.configDigestMismatch` = "config-digest-mismatch", durable.ts:117). Also `intentReceiptConfigMismatch` (durable.ts:134).

### Every fail-closed mismatch site (live bytes vs pinned digest)

All raise `PINNED_CONFIG_MISMATCH` with `{expected_digest, observed_digest}`:

1. **Input-fingerprint resolver** — `src/state/fingerprint.ts:79-87` (`createInternalInputFingerprintResolver`): `context.live_config.digest !== state.config_digest` → fail. This gates every fingerprint computation (workflow/constitution pin checks follow at L92/L95 with `workflow-pin-mismatch` / `constitution-pin-mismatch` STATE_INVALID codes).
2. **Transaction kernel** — `src/state/transaction.ts:406-417` (`liveIdentification`): reads config, rejects invalid/unreadable, then L412 `config.snapshot.digest !== current.value.config_digest` → fail, before preparation.
3. **Initialization adoption** — `src/state/initialization.ts:252-263` (`identifyStateInitialization`): L258 `config.snapshot.digest !== initialization.config_digest` → fail (revision-zero and re-identification; legacy staged-config fallback at L253-256).
4. **Durable gates** — `src/state/gates.ts:126-139` (`validateLiveGateState`): L137 digest comparison, before gate open/settle. Also `src/state/gates.ts:671-691` (material-drift planning restart) re-reads live config and resolves a fingerprint with it.
5. **Handler session** — `src/mcp/handlers/session.ts:45-61` (`openHandlerSession`): L56 `state.config_digest !== configRead.snapshot.digest` → fail; runs before every MCP tool handler including counter-review dispatch.
6. **Local CLI call envelope** — `src/local/call-envelope.ts:84-93` (`fingerprintFor`): L88 digest comparison before `computeCallEnvelope`.
7. **Status (soft, non-error)** — `src/state/status.ts:742-770`: `verifyPinnedConfig(state.config_digest, read.snapshot.bytes)` (L760); mismatch → blocker `"pinned-config-mismatch"` (L764) and `config: unavailableConfig(...)`; distinct branch `"pinned-config-schema-unsupported"` (L746-751) when bytes are exactly pinned but this build won't parse them.

### Status/next-action plumbing for the mismatch

- `deriveNextAction` — `src/state/next-action.ts:261-276`: `config_verified !== true` → action `restore-pinned-config` (registered at L17) with the "requires a new task or the explicit upgrade flow" text; `config_schema_unsupported` → `upgrade-tooling`. Input wired at `src/state/status.ts:1191-1194`.
- `src/state/semantic-view.ts:246`: `case "restore-pinned-config"` renders an `inspect` semantic view entry.
- Error contract: `src/contracts/errors.ts:19` (code), `:92` (digestsParams), `:120` (remediation `"restore-pinned-config"`, category policy, non-retryable).
- `ConfigVerification` shape: `src/state/status.ts:55`, `:224`, `unavailableConfig` at `:389`.

## 3. Input fingerprint composition and what assumes config is pinned

### Subject + computation

`src/contracts/fingerprints.ts:24-37` `InputFingerprintSubject`:
```
schema_version: "1"; workflow_digest; config_digest; constitution_digest;
artifact_identities[]; upstream_identities[]; rubric_digest; phase_instance; declared_inputs[]
```
`computeInputFingerprint` (L171-184): canonical JSON digest of all of the above (sets sorted, duplicates rejected). The caller's `input_fingerprint` is always an assertion; the server recomputes.

### Where config enters

- Only via `context.live_config.digest` in `src/state/fingerprint.ts:106` (subject field `config_digest`) — after the pin check at L79. Production readers (`src/state/fingerprint-readers.ts:161-169`): workflow digest from policy-base commit tree, constitution digest from policy base, artifact/upstream identities (path selectors currently always empty, L82-88), declared inputs from the caller's artifact.

### Everything downstream of the fingerprint (assumes stability)

- **Request digest** — `computeRequestDigest` (fingerprints.ts:324-336) embeds `input_fingerprint`; drives intent receipts and replay.
- **Gate identity** — `computeGateId` (L338-351) embeds `request_digest` (hence the fingerprint).
- **Intent receipts** — `durable-intent.ts:33` `input_fingerprint`; replay path `identifyFromReceipt` `src/state/transaction.ts:435-443` compares receipt fingerprint to caller's.
- **In-flight state** — `TaskStateV1.input_fingerprint` (durable-state.ts:268, "D13 the in-flight step's fingerprint"); compared against the stepped artifact by `validateDurableSemantics` rank 8 (durable.ts:748-758 → `INPUT_FINGERPRINT_MISMATCH`).
- **Kernel check** — `src/state/transaction.ts:429-431`: recomputed fingerprint vs caller's claim.
- **Gate open/settle** — `src/state/gates.ts:138` `inputFingerprint !== current.value.input_fingerprint` → `INPUT_FINGERPRINT_MISMATCH`.
- **Evidence manifests** — `authoritative_results[*].input_fingerprint`; correlation checks at `src/state/evidence-results.ts:354`, `:499`, `:568`, `:631` (derived vs `state.input_fingerprint`), `:645` (predecessor chains).
- **Fixed point** — `src/review/fixed-point.ts:43-48`, `:107-125`: evidence is bound to `(subject_digest, input_fingerprint)`; a new review round requires fingerprint equality with its predecessor unless the subject digest changed.
- **Dispatch envelopes** — `src/review/envelopes.ts:34` (`DispatchSubject.input_fingerprint`, exact-field list L229-241, parse L257), `:162` (`AdjudicationSubject.input_fingerprint`), parse at L272/293. The child reviewer's envelope pins the fingerprint of what it reviewed.
- **Counter-review result binding** — `src/review/counter-review.ts:209/227/229/355/412` (result references carry the fingerprint).
- **MCP handlers** — `src/mcp/handlers/state.ts:196-215` (planning-restart landing fingerprint recompute), replay handlers under `src/mcp/handlers/replay.ts`.
- **Local envelope** — `src/local/call-envelope.ts:53-64, 94-105`.

### Consequence of removing `config_digest` from the subject

`InputFingerprintSubject.schema_version` is the literal `"1"` (fingerprints.ts:25) — changing composition without a version change silently re-hashes every subject. Every in-flight task would fail: kernel recompute (transaction.ts:429), gate validation (gates.ts:138), receipt replay (transaction.ts:439-443), manifest correlation (evidence-results.ts:354/631), fixed-point binding (fixed-point.ts:107-125), archived dispatch-envelope digests. So the design needs either a subject schema bump with an explicit story for existing tasks (accept break / migrate / dual-compute), or to keep `config_digest` in the subject but sourced from a stable value (e.g. the creation-time digest or a constant) so live edits stop moving the fingerprint.

## 4. Status view generation (where a change notice goes)

Flow for the semantic `archflow_status` tool:

- `src/mcp/handlers/semantic.ts:81-88` `handleSemanticStatus` → `openSemanticSession` (L48-58) → `computeAuthoritativeSemanticStatus` (`src/state/semantic-status.ts`, enrichments type at L28-36) → which wraps `computeTaskStatusDetailed` (`src/state/status.ts:706` `computeTaskStatusDetailedInternal`) → `projectSemanticStatus` (`src/state/semantic-view.ts`) → `WorkflowViewV1`.

Natural insertion points:

- **Config verification block** — `src/state/status.ts:742-770` already reads live config, parses it (`parsedConfig`, L743/765), and computes verification. A field-level change notice is computed here: diff `parsedConfig` against a durable last-seen snapshot.
- **Status shape** — `TaskStatusV1.config` (status.ts:224) and `.routes` (L225-226, populated at L772-782) — a `config_changes` field would join these; the semantic projection (`contracts/semantic-workflow.ts` + `semantic-view.ts`) then renders it. `next_action` assembly at status.ts:1188-1214.
- **Gate presentations** — `buildHumanGatePresentation` (`src/state/gate-decision-interface.ts:267`), invoked at status.ts:605; open-gate projection binding at status.ts:1141-1170 (archived gate request read via `readArchivedGateRequest`). Precedent for routing-relevant info in gate correspondence: `counter_review_provenance.route_override` at status.ts:1113-1124 ("without it the human sees which model reviewed but never that it was not the configured one"). "Changes since the previous gate" needs the config (digest or parsed snapshot) recorded at gate-open time in the archived gate request (`ArchivedGateRequestV1`, `src/contracts/durable-gate.ts`) or derived from state's last-seen at open time.

### Where durable "last seen config" could live

- `TaskStateV1` (`src/contracts/durable-state.ts:251-300`) is the natural home; precedent for a later optional field: `baseline_adoptions` (L298, schema L547-548 with sorted-set refinement and semantics checks L558-560). A `last_seen_config_digest` + parsed snapshot (or just digest + bytes hash of parsed canonical form) would be optional so old state.json parses (`readTaskState` strict zod at read.ts:79-91).
- Writes go through the state transaction (`runStateTransaction`, `src/state/transaction.ts`) which advances `revision` monotonically and writes canonical state.json via the atomic writer (`src/state/atomic.ts` — `AtomicWriter.replace`, path classes L158). The transaction is the only legitimate state mutator; updating last-seen would ride the next committed transaction (e.g. record-state-boundary) rather than a side write, preserving single-writer authority.
- The initialization document is immutable after adoption, so it can keep recording the creation-time digest (provenance) while state records last-seen. Status reads state.json alone (durable-state.ts:239-244), so last-seen must be in state.json (or a state-referenced archive) to appear in status.
- `validateDurableSemantics` (`src/contracts/durable.ts`) may need a rank clause if last-seen must not exceed current revision etc.

## 5. Field-level diffing feasibility

- `parseConfigYaml` returns a plain, `assertPlainJson`-validated object (`ConfigV1`): closed, shallow schema (`roles{2-3 roles × 3-4 fields}`, `overrides{5 kinds}`, `max_attempts`). A small recursive diff (added/removed/changed leaf paths) is trivial and needs no new dependency.
- No existing generic deep-diff utility in src (only `deriveImplementationDiffDigest`, `src/state/implementation-manifest.ts:345`, which digests git commit diffs — not reusable for field diffs).
- Care: the retired `producer` role (config.ts:20-22) round-trips in old configs; the diff should treat it as a normal field (removal notice) or deliberately ignore it. Since YAML reordering/comment changes produce byte changes with no field change, the notice must be computed on the parsed structure (digest of canonicalized parsed config), not raw bytes.

## 6. Tests covering config pinning

Primary:

- `test/unit/config-pinning.test.ts` — seven tests, one per enforcement site: initialization (`identifyStateInitialization`), transaction kernel (`runStateTransaction`), fingerprint resolver, local call envelope (`computeCallEnvelope`), retired-producer byte pin, durable gate (`openDurableGate`), handler session (`handleCounterReview` via `openHandlerSession`). Asserts `PINNED_CONFIG_MISMATCH` with exact digests and that no config content leaks into the serialized error. All of these flip semantics under the new design (edits must succeed; mismatch assertions removed or inverted).
- `test/unit/fingerprints.test.ts` — `config_digest: digest("b")` in the subject fixture (L48) and the `describe("pinned config digest")` block (L353+; fixtures `test/fixtures/contracts/fingerprints/config.yaml`, `config-reordered.yaml`).

Other files referencing `config_digest` / `PINNED_CONFIG_MISMATCH` / `verifyPinnedConfig` (grep-verified; each constructs states or assertions that assume the pin):

- Contracts: `test/contracts/durable-contract-surface.test.ts`, `test/contracts/durable-semantics-corpus.test.ts`, `test/unit/durable-semantics.test.ts`.
- Crash: `test/crash/state-initialization.test.ts`, `test/crash/state-transaction.test.ts`, `test/crash/state-gate-lifecycle.test.ts`.
- Integration: `state-transaction.test.ts`, `state-gate-lifecycle.test.ts`, `state-projection-fresh-task.test.ts`, `mcp-handler-state-replay.test.ts`, `mcp-handler-counter-replay.test.ts`, `counter-review-pinned-context.test.ts`, `review-fixed-point.test.ts`, `review-fixed-point-live.test.ts`.
- Unit: `state-initialization.test.ts`, `state-transaction.test.ts`, `state-gates.test.ts`, `state-transitions.test.ts`, `state-status.test.ts`, `state-next-action.test.ts`, `state-evidence-results.test.ts`, `state-production.test.ts`, `state-reconciliation*.test.ts`, `semantic-actions.test.ts`, `semantic-view.test.ts`, `planning-restart-runtime.test.ts`, `implementation-output-builder.test.ts`, `review-services.test.ts`, `init-task-initialization.test.ts`, `legacy-upgrade.test.ts`, `task-workspace.test.ts`, `workspace-cleanup.test.ts`.
- Real-host: `test/real-host/terminal-journey.test.ts`.
- Template/config schema: `test/unit/init-config-template.test.ts`, `test/unit/workflow-config.test.ts`.

Docs that describe pinning and must change in the same commit (per CLAUDE.md caps-docs rule): `docs/state/DURABLE-STATE.md` (L34 "pinned configuration", L133 pinned-config-schema-unsupported narrative), `docs/DEPENDENCIES.md` (L70 routing, L108 "byte-pinned per task"), `docs/mcp/DISPATCH.md` (L18 routing + route_override), plus `docs/review/COUNTER-REVIEW.md`, `docs/contracts/CONTRACTS.md`, `docs/workflow/LIFECYCLE.md` where the pin/gate rules are described. Skills under `skills/` that tell users a config change requires a new task also need review.

## 7. Hazards / dual-purpose uses of the config digest

1. **Provenance beyond mismatch detection.** `config_digest` is one of the five pinned-input fields duplicated between state.json and the initialization/legacy-import document and cross-checked by `validateDurableSemantics` (durable.ts:710-724). That check authenticates state↔initialization agreement, not live bytes — it can survive, but the field itself should stay in both documents as "config at task creation" provenance. Removing it entirely breaks D15 invariants and legacy-import staging (initialization.ts:252-263; legacy-upgrade.ts:340, 472-483).
2. **Fingerprint stability / in-flight tasks.** Removing `config_digest` from `InputFingerprintSubject` changes every recomputed fingerprint (subject `schema_version` is a literal `"1"`); all durable bindings listed in §3 then mismatch for existing tasks. Needs an explicit version/break/migration decision.
3. **Evidence honesty vs editable routing.** Today the fingerprint binds collected review evidence to the routing config; after unpinning, evidence produced under route A remains valid when config moves to route B. The mitigation is exactly the planned change notice + gate-presentation delta; the `counter_review_provenance` block (status.ts:1113-1124) already records the actually-used model/effort/override per review, which keeps old evidence honest.
4. **`route_override` framing becomes stale.** `RouteOverrideDeclaration` (contracts/mcp-tools.ts:70-77) is documented as "a per-dispatch substitute for the pinned routing … never touches the pinned config"; with editable config the vocabulary ("pinned", "restore-pinned-config", `PINNED_CONFIG_MISMATCH`) needs reworking, and the outage-escape use case partially overlaps "just edit config.yaml now".
5. **Invalid configs.** Fail-closed `CONFIG_INVALID` on unparseable/invalid bytes should remain (an edit that breaks the schema still must not dispatch garbage); only the *byte-difference* fail path goes away. Status keeps distinct blockers `config-invalid`/`config-missing`/`config-unreadable` (status.ts:752-758) — these stay meaningful.
6. **`pinned-config-schema-unsupported`** (status.ts:746-751 → `upgrade-tooling`) compares bytes to the pinned digest; after unpinning, "bytes won't parse under this build" no longer needs the digest comparison — an unparseable live config is just `config-invalid`.
7. **max_attempts changes mid-task** immediately change fixed-point exhaustion math (request-composition.ts:596-614 reads live config today, but only reachable while the pin holds); the change notice should flag `max_attempts` edits as routing/behavior-relevant at gates.
8. **Gate-id / request-digest stability.** Because gate ids derive from request digests which embed the fingerprint, config-in-fingerprint also means a config edit today would prevent opening the "same" gate; after unpinning, gates stay addressable across config edits — verify replay paths (`mcp/handlers/replay.ts`) don't assume otherwise.
