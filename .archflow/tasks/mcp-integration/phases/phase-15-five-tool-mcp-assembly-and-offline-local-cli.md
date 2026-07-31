# Phase 15: Five-Tool MCP Assembly and Offline Local CLI

**Status**: COMPLETE
**Implementation Date**: 2026-07-31
**Task**: mcp-integration
**Goal**: Assemble persistence, dispatch, adjudication, and decisions behind the complete and only MCP workflow surface.
**Requirements**: REQ-07, REQ-08, REQ-11, REQ-13, REQ-21, REQ-23, REQ-27, REQ-28, REQ-29, REQ-30, REQ-31, REQ-32, REQ-33, REQ-35, REQ-36, REQ-37, REQ-38, REQ-39, REQ-40, REQ-41

## Context

Phases 1–14 built every service this phase needs and wired none of them to a caller. `src/mcp/server.ts` defines the handler seam (`ToolHandler`, `ToolHandlerRegistry`), validates schema version and input before any handler runs, and maps project and protocol errors two ways; `src/mcp/sdk-adapter.ts` accepts `McpRuntimeOptions.handlers`. But `src/main.ts` → `runMcpProcess` → `startMcpRuntime` never passes a registry and `ProcessBindings` has no field for one, so `tools/call` answers `TOOL_DISABLED` for all five tools. Transactions, gates, waivers, checkpoints, snapshots, maintenance, reconciliation, dispatch, counter-review, adjudication, and the review fixed point exist as libraries with real disk behaviour, but three optional `TransactionDependencies` members (`projection_writer`, `read_retained_task_bytes`, `load_retained_result`) and two Phase 14 gate resolvers (`resolve_gate_reentry_fingerprint`, `resolve_supplemental_review`) are unbound; Phase 14 deferred them here by name. `src/local/` does not exist. Phase 14 left `npm test` at 1,479/1,482 with three `release-offline.test.ts` failures this phase owns.

Assembly is not pure wiring. Cross-client counter-review found that several services expose seams the handlers cannot satisfy as-is, so this phase also closes small gaps inside `src/state/gates.ts`, `src/dispatch/cli.ts`, and the release scripts. Those are called out where they occur.

Decisions taken at the design gates:

1. **Upgrade staging is deferred to Phase 19.** The architecture's Phase 15 scope line lists "upgrade staging" among the `archflow-local` operations, but Phase 19 owns `archflow-upgrade` and its offline orchestrator, and no upgrade module exists. Phase 15 ships no upgrade command and no stub. Reconcile the Phase 15/19 scope lines in `architecture.md` during implementation.
2. **The release "loader policy" check is removed, not worked around.** `assertReleaseLoaderPolicy` (`scripts/release-support.mjs:149`) forbids any identifier beginning with `__require`. Rebuilding emits esbuild's `__commonJS` helper because `ajv@8.20.0` is CommonJS and became reachable from `src/main.ts`, so every rebuild fails. The owner never asked for this policy; the real constraint is that dependencies be permissively licensed and distributable, which the license and notice checks already cover. Delete it (chunk 6); do not replace it with a narrower check.
3. **`verifyHeadLegalBaseline` is relaxed, for the same reason.** `architecture.md:514` already records that its byte-immutability rule cannot co-exist with "every decision binds the current bundle digest" across any bundle change — the tracked payload has been unpromotable since Phase 6. Chunk 6 relaxes the rule so an explicitly re-authorized decision promotes atomically, instead of adding a preview/two-pass release operation to satisfy a rule that fights every legitimate change. Digest, license/notice, reproducibility, and offline-smoke checks are untouched.
4. **Two decisions from the previous design round are reversed** by counter-review evidence and are marked **[REVERSED]** in chunk 6: the release builtin-import allowlist must widen (it would reject the live graph at the first staging run), and provenance cannot stay MCP-only (global input equality breaks the moment a second output exists).

## What We're Building

Five thin MCP handlers over existing services, plus a production dependency-assembly module and a dispatch coordinator that supply every callback Phases 12–14 left open. Handlers derive repository, task, host, and phase identity themselves — `InvocationContext` carries a working-directory candidate and a host candidate but no task — perform replay resolution and typed-error mapping around the services, then delegate to `runStateInitialization`/`runStateTransaction`, `runCounterReview`, `runAdjudication`, and the durable gate lifecycle.

`archflow-local` is a second bundled entry point from the same source tree, using `node:util` `parseArgs` and no new dependency. It reuses the existing validate/hash/render/snapshot/restore/decision/reconcile/import libraries and adds the gate-counter ingestion route, a manual-checkpoint writer with enumeration, degraded status, and maintenance root and candidate enumeration. Finally the release machinery grows to two build entries with per-entry provenance, a derived import allowlist, a derived legal closure, and a regenerated `dist/`.

## Files

| Action | File | Purpose |
| --- | --- | --- |
| Modify | `src/mcp/process-runner.ts`, `src/main.ts` | `handlers?: ToolHandlerRegistry` on `ProcessBindings`, forwarded into `start()`; install the registry |
| Create | `src/state/production.ts` | Resolve context/authority; build `GateLifecycleDependencies` from a working directory |
| Create | `src/contracts/supplemental-record.ts` + `schemas/v1/supplemental-review-record.schema.json` | The gate-owned compound supplemental review+triage record |
| Modify | `src/state/gates.ts` | Read the retained record; authenticate triage; stop re-waking on an exact decline |
| Modify | `src/state/atomic.ts`, `src/repository/paths.ts` | Admit `manual-checkpoint` and the supplemental record to `createExclusive`; admit `attempt` to `PROJECTABLE` |
| Modify | `src/state/layout.ts` | Directory ensurers for `manual/checkpoints/` and `attempts/<phase-instance>/` |
| Modify | `src/dispatch/cli.ts` | Thread signal and cancellation source through `CliAdapter.preflight` |
| Create | `src/dispatch/coordinator.ts` | Adapter/workspace/child assembly plus finalized diagnostic attempt records |
| Create | `src/mcp/handlers/{index,session,replay,errors}.ts` | Registry, per-call derivation, pre-dispatch replay resolution, typed-error mapping |
| Create | `src/mcp/handlers/{state,counter-review,adjudicate,gate,waiver}.ts` | One file per tool |
| Create | `src/state/manual-checkpoints.ts` | Write and enumerate `manual/checkpoints/<revision>-<digest>.json` |
| Create | `src/state/status.ts` | Degraded status computation for the offline helper |
| Create | `src/state/maintenance-roots.ts` | Root, manifest, and deletion-candidate enumeration for `computeMaintenanceProof` |
| Create | `src/local/{main,commands}.ts` | `parseArgs` entry, command dispatch, stdout/exit contract, implementations |
| Modify | `.gitattributes` | Pin `dist/archflow-local.mjs` to `text eol=lf -whitespace` — **before** staging |
| Modify | `scripts/release-support.mjs` | Two entries, per-entry provenance, derived import allowlist and legal closure, deleted loader policy, relaxed HEAD baseline |
| Modify | `scripts/{smoke-release-bundle,test-release-integrity}.mjs` | Cover both bundles; drop the `loader-policy` mutation; add local-only source drift |
| Modify | `src/contracts/schemas/v1/release-{manifest,legal-review}.schema.json` | `handler_authority` vocabulary, per-entry provenance, derived `allowed_imports` |
| Modify | `release/legal-review.json`, `release/evidence/*.json` | Derived component closure; re-authored risk decision for a live-handler runtime |
| Create | `release/legal/upstream/**`, `dist/**` | One retained legal source per derived installed component; new `archflow-local.mjs`; regenerated payload |
| Modify | `test/integration/mcp-stdio.test.ts`, `test/unit/mcp-server.test.ts`, `test/contracts/release-contracts.test.ts` | Live-handler and new-vocabulary expectations |
| Create | `test/integration/{mcp-handlers,local-cli,gate-supplemental}-phase15.test.ts` | Handler semantics, helper surface, supplemental round trip |
| Create | `test/unit/state-{manual-checkpoints,maintenance-roots}.test.ts` | The new library gaps |

`package.json` is deliberately unchanged: no `bin` entry (chunk 5).

## Work Breakdown

### 1. Handler plumbing seam

Add `readonly handlers?: ToolHandlerRegistry` to `ProcessBindings` (`process-runner.ts:14`) and forward it in the `start(...)` call at `:115`; `McpRuntimeOptions.handlers` already flows to `createToolBoundary`. Land a test spawning the real runtime with a non-empty registry — none exists today because the field did not. `src/main.ts` is updated in chunk 4; add no placeholder registry. `lifecycle_state: "inert-no-handler"` (`server.ts:207`) stays correct for any unregistered tool; the release-manifest `handler_authority` vocabulary is a separate concept owned by chunk 6.

### 2. Production dependencies and the gate supplemental route

New `src/state/production.ts` — the single place that turns a working directory into working dependencies. Model it on the deps literal at `test/integration/state-gate-lifecycle-phase12.test.ts:85-127`, with the real `lock` and `read_config` that suite stubs.

```ts
export type ProductionServices = Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  authority: TransactionAuthority;        // its .context is the resolved operation context
  state?: CanonicalDocument<TaskStateV1>; // absent before initialization
  dependencies: GateLifecycleDependencies;
}>;

export async function createProductionServices(input: Readonly<{
  working_directory: string;
  task_id: TaskSlug;
  operation: SafeCode;
  phase_instance?: PhaseInstanceId;       // supplied only by archflow_state / archflow_gate
}>): Promise<ProjectResult<ProductionServices>>;
```

`GateLifecycleDependencies` is a superset of `TransactionDependencies`, so one object satisfies both consumers.

**Resolve the bootstrap circularity here, not in callers.** `RepositoryOperationContext` requires `phase_instance` and `attempt` (`git.ts:103-108`) and `createInternalTransactionAuthority` requires the complete context (`authority.ts:47`), yet `authority.state` is the `ResolvedPath` `readTaskState` needs — and `CounterReviewInput`/`AdjudicateInput`/`WaiverInput` carry no `phase_instance` (`mcp-tools.ts:44,46,50`) and nothing carries `attempt`. Two-phase bootstrap: provisional context → provisional authority → read committed state → rebuild context and authority from that state's `phase_instance` and attempt count. Return the resolved context inside `authority` plus the state document already read. With no state file, only the `archflow_state` initialization arm is reachable and the caller-supplied `phase_instance` is authoritative.

Bind: `discoverWorktree` + `preflightGit` (`identity.ts:164`, `git.ts:561`), `createAtomicWriter()` / `createProjectionWriter()` (`atomic.ts:137,186`), `createTaskLock()`, `createProductionInputFingerprintResolver()`, `readTaskState` / `readTaskConfig` / `readIntentReceipt`, `createSecretlintScanner()` as `gate_secret_scanner`. Three members need new implementations: `read_retained_task_bytes(reference?)` (total retained payload bytes, excluding `reference` so replay never double-counts a generation it is about to rewrite); `load_retained_result(reference)` (rehydrate a `RetainedResultInstallation` from the retained manifest and payload, so `loadRetainedEvidence` stops throwing); and `resolve_gate_reentry_fingerprint` (recompute the produce-entry fingerprint through `resolve_input_fingerprint`).

#### The gate-owned supplemental route

The fourth member, `resolve_supplemental_review`, cannot be built from existing pieces, and three adjacent defects must be fixed with it.

**One immutable compound record is the authority.** Pin `decisions/<gate-id>/supplemental-review.json`, a new canonical contract embedding: the validated `ReviewEvidence`; its **exact-cover triage** with complete finding dispositions and a no-change/accepted outcome; the `gate_id` and the archived gate request's bindings; the evidence digest; and the Markdown projection digest. Admit that exact path to `createExclusive` in `atomic.ts` and to the `decision` path class in `paths.ts` — the class currently admits only `decisions/<gate-id>/{request,decision}.json` (`paths.ts:62-68,148-152`), and `ensureDecisionDirectory` only makes directories. The gate ID is the non-colliding key, so the record never enters `state.authoritative_results` or the `PipelineStep` map that `loadRetainedEvidence` walks. One record rather than parallel review and triage records: fewer moving parts for the same property.

**The producer is `archflow-local gate-counter`, and it writes the record first.** The previous design had the gate service retain the payload "when it accepts a supplemental review". That is circular: the first supplemental wake calls the resolver with only `{authority, request}` (`gates.ts:1041-1044`), and acceptance itself runs through `authenticSupplementalReview` → the same resolver (`gates.ts:472-500`). The record must already exist. So chunk 5's `gate-counter` command creates (or re-creates byte-identically) the record **first** and atomically publishes the Markdown projection **last**. The resolver reads only the retained record; the projection remains a wake-up interface with no authority.

**This route is `assurance: "degraded"`, always.** `parseReviewEvidence` will structurally accept a `server-attested` object (`review.ts:150-179`), but genuine attestation is minted only from an invocation-scoped observation capability (`trust.ts:88-105`), and a second-terminal helper observes no dispatch. Today `authenticSupplementalReview` compares the evidence only against the caller-authored `evidence_slot`, so a forged slot and forged evidence agree. Therefore: reject `server-attested` on this route outright; bind `gate_id` in the record (`ReviewEvidence` carries none — only the slot does); derive the producer family from the archived gate request's authenticated current-evidence slots and require the reviewer family to be its exact opposite. The architecture already classifies manual fallback as explicitly degraded.

**Authenticate the triage before `triage-no-change` or `supersede`.** `SupplementalReviewOutcome` carries bare `triage_digest` / `accepted_triage_digest` strings (`supplemental.ts:12-14`), and the supersession path copies `accepted_triage_digest` straight into the archived decision without reading any triage artifact (`gates.ts:607-612`) — a fabricated digest can supersede a gate, which REQ-41 forbids. Authenticate the digest, the complete finding dispositions, and the no-change/accepted outcome from the retained record before admitting either action. Decline stays the only resolver-free branch.

**Stop an exact decline from re-waking the waiter.** `currentSupplementalLedger` accepts an exact decline (`gates.ts:461-464`), but `runDurableGate` sets `already_recorded` only for non-decline entries (`gates.ts:1029-1030`), so the persistent projection wakes the waiter again and returns `SUPPLEMENTAL_REVIEW_REQUIRED` — contradicting REQ-41's requirement that declining not prevent an otherwise valid decision. Fix in `gates.ts`: any exact authenticated caller outcome, decline included, has handled that projection. Prove it with an end-to-end `runDurableGate` decline-then-decision test, not a resolver-level one.

### 3. Dispatch coordinator

New `src/dispatch/coordinator.ts`. Both `RunCounterReviewDependencies["dispatch"]` and `RunAdjudicationDependencies["dispatch"]` have the same shape — both envelope builders return `DispatchEnvelope` and both result types are structurally identical — so one function satisfies both slots.

```ts
export type DispatchCoordinatorInput = Readonly<{
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
  host: HostIdentity;                 // context.connection.initialization_candidates.host
  repository_root: string;
  phase_instance: PhaseInstanceId;
  signal: AbortSignal;
  cancellation_source: DispatchChildSpec["cancellation_source"];
  allow_claude_dispatch: boolean;     // required, not optional — see below
}>;

export function createDispatchCoordinator(input: DispatchCoordinatorInput): (
  route: DispatchRoute,
  envelope: DispatchEnvelope,
  outputSchema: PlainJsonValue,
) => Promise<Readonly<{ cli_version: string; extracted_output_bytes: Uint8Array }>>;
```

`host` is mandatory: `selectCliAdapter` (`cli.ts:468-478`) is the **only** producer of `UNSUPPORTED_HOST` in `src/`, so it carries all of REQ-29's server-side enforcement. `createDispatchWorkspace` needs the root explicitly rather than defaulting to `process.cwd()`.

Order inside the returned function: `selectCliAdapter` → `createDispatchWorkspace` → `adapter.preflight` → `adapter.buildInvocation` → add `{ signal, cancellation_source }` → `runDispatchChild` → `classifyFailure` / `parseOutput` → `workspace.dispose()` in a `finally`.

**Do not call `serializeDispatch` and do not mint observations.** Both are the callers' job: `counter-review.ts:92-93` and `adjudication.ts:384-385` already wrap the injected callback in `serializeDispatch`, so a nested call chains onto a queue slot that cannot settle until the outer operation resolves — a permanent hang. Minting happens at `counter-review.ts:94-101` and `adjudication.ts:388-395`, needs a subject the coordinator does not carry, and the slot's return type has no room for it.

**Cancellation must reach preflight.** `CliAdapter.preflight(workspace)` takes no signal and both preflight children get a fresh never-aborted `AbortController().signal` (`cli.ts:183-196`), so MCP cancellation during version/auth preflight terminates no descendants. Widen the `CliAdapter.preflight` signature to carry the invocation signal and cancellation source, and pass them to those children.

**Attempt-record finalization spans the whole operation.** `runDispatchChild` returns a failed `ProjectResult` for cancellation, timeout, overflow, and I/O (`process.ts:218-234`), and preflight or launch can fail earlier — so a record written only after successful output parsing is unreachable exactly when the required cancellation test needs it. Finalize the record in a `finally`-style path around the selected-adapter operation, recording whatever managed-policy and version facts were obtained, and never let a failure writing this diagnostic record mask the primary classified error.

`CliPreflight` (`cli.ts:66`) returns `{ cli_version, managed_policy_present, managed_policy_paths }` and nothing consumes it. Retain it at the existing `attempt` path class — `attempts/<phase-instance>/<attempt-id>.json`, declared at `paths.ts:154` with no writer. Do **not** add it to `ReviewObservationMint` / `AdjudicationObservationMint`: those shapes were frozen in Phase 2. Because `attempts/` is diagnostic and cannot authorize advancement, the record belongs to the **mutable** partition: add `attempt` to `PROJECTABLE` (`atomic.ts:141-143`) and write it via `createProjectionWriter().replaceRegular`, with a new `attempts/<phase-instance>/` ensurer. `atomic.replace` is restricted to `task-state`/`gate-interface` (`:104-107`), so the projection writer is the available mutable route. No new zod contract.

**`allow_claude_dispatch` is a required, deliberately-set field.** `selectCliAdapter("codex")` returns `CONFIG_FAMILY_UNSUPPORTED` without it, so a Codex producer cannot reach its Claude-family reviewer — one of the two supported producer directions would be silently dead. Separate implementation enablement from release authorization: wire the value deliberately in production and fixtures, and test **both** producer directions. Record that architecture release criterion 3 / VAL-14 (`architecture.md:371`) still forbids a release that enables the Claude subscription-dispatch path until written clarification or a qualified legal determination exists. An option default must not decide this.

### 4. The five handlers

Depends on chunks 1–3. `index.ts` exports `createToolHandlers(): ToolHandlerRegistry`, the only registry the process installs.

`session.ts` holds shared derivation. It does **not** identify requests generically: `runStateTransaction` (`transaction.ts:381,391`), `runStateInitialization` (`initialization.ts:266,346`), `runCounterReview` (`:107`), and `runAdjudication` (`:416`) all call `identifyTransactionRequest` themselves; only `GateOpenInput` (`gates.ts:114-129`) needs a caller-supplied `request_digest` + `input_fingerprint`, so that derivation is scoped to the gate and waiver arms.

```ts
export async function openHandlerSession(
  call: ParsedToolCall,
  context: InvocationContext,
): Promise<ProjectResult<Readonly<{
  services: ProductionServices;
  config: ConfigV1;                  // parsed from the pinned config.yaml
  host: HostIdentity;
  producer_family: ModelFamily;      // the host's own family
  phase_kind: keyof NonNullable<ConfigV1["overrides"]>;
  measured_at_revision: SafeInteger;
}>>>;
```

`config`, `phase_kind`, `producer_family`, and `measured_at_revision` are required members of `RunCounterReviewInput`/`RunAdjudicationInput` and are not deferrable: both services **throw** when the envelope subject is not consistently server-derived (`counter-review.ts:78-84`, `adjudication.ts:368-372`). The session therefore also builds the envelope subject from server-side facts. It additionally performs the pinned-`config.yaml` digest check for the counter-review and adjudicate arms: `runStateTransaction` raises `PINNED_CONFIG_MISMATCH` at `transaction.ts:362`, nothing on the dispatch path does, and `architecture.md:65` requires it before dispatch.

**Replay must be resolved before dispatch** (`replay.ts`). `runCounterReview` and `runAdjudication` both resolve routes and dispatch *before* `runStateTransaction`, where replay detection lives (`counter-review.ts:85-119`, `adjudication.ts:374-428`). Wiring handlers straight to those services would burn a second model attempt on a replayed intent, violating REQ-23/REQ-25. The handler therefore performs an authenticated pre-dispatch intent/replay resolution against committed state and any intent receipt, and returns the committed outcome — or resumes a receipt-only prepared state — without calling the service at all. The service runs only for a genuinely new intent. This is deliberately a handler-side check rather than a refactor pushing dispatch inside a kernel-owned prepare path in both services: same property, far smaller blast radius. Require call-count tests for exact replay and receipt-only recovery.

**Typed dispatch errors must not become `INTERNAL_ERROR`** (`errors.ts`). `resolveDispatchRoute` throws `DispatchRoutingError` (`routing.ts:19-28`), adapter and preflight failures throw `CliAdapterError` (`cli.ts:125-149`), and `runDispatchChild` throws `DispatchProcessError` (`process.ts:40-49`); neither service catches them, and the boundary deliberately flattens uncaught throws — losing REQ-29/31/35 classification and this phase's own success criterion. The handler wraps each service call and maps every typed error to its carried `project_error`, reserving throws for defects. The `dispatch` slot's return type stays exactly as Phase 14 froze it. Exercise every stable failure class through the live handler boundary.

Handlers return plain-JSON `ProjectResult<ToolSuccess<K>>` only — the boundary `structuredClone`s and validates twice, so getters and non-JSON values become `INTERNAL_ERROR`. Cancellation terminates at `context.signal`.

**`archflow_state` — per-artifact preparation.** `planStateTransition` returns only `NextStateDraft` (`transitions.ts:180-205`) while `runStateTransaction` requires a complete `PreparedTransaction` with a correlated expectation and result (`transaction.ts:88-92`), and a succeeded artifact additionally requires an authenticated result reference and installation (`:580-631`). So the `prepare` callback is a table, not a two-way branch:

| Artifact arm | Preparation |
| --- | --- |
| absent state (`task-initialization`, `legacy-import-initialization`) | `runStateInitialization` |
| `document` | snapshot preparation (`prepareDocumentSnapshot`) |
| `implementation-output` | implementation-manifest verification + snapshot preparation |
| `review-evidence`, `triage` | `prepareEvidenceResult` |
| `manual-checkpoint-import` | `planCheckpointAdoption` |
| artifact-free transition | `planStateTransition` |

Each succeeded arm builds the exact expectation/result/reference/installation tuple before entering the kernel.

**`archflow_counter_review`** — `runCounterReview`. A `fail` verdict is a successful tool result.

**`archflow_adjudicate`** — bind all eight `RunAdjudicationDependencies` members. **Four are adapter closures, not identity bindings**: each slot is narrower than the function behind it, so write a closure and source the extra arguments from the session — `prepare_evidence` → `prepareEvidenceResult` (also needs `authority`, `runner`, `scanner`, `retained_task_bytes` from chunk 2, the kind-tagged `EvidenceResultValue` wrapper, and a `result_id` that must equal the envelope subject's or the server-attested check at `evidence-results.ts:244-250` throws); `load_current_review_set` → `loadCurrentReviewSet` (3 args vs 2); `load_constitution` → `resolvePinnedConstitution(runner, commit, context)`; `detect_constitution_edit` → `detectTaskLocalConstitutionEdit` (4 args vs 0, including the pinned constitution digest). `RunCounterReviewDependencies.prepare_evidence` gets the same treatment.

**`derive_approved_upstreams` is real work.** The slot is `(state, paths) => Promise<ProjectResult<readonly AdjudicationUpstreamInput[]>>` (`adjudication.ts:138-141`). `requireApprovedUpstreamDigests` is *not* it: synchronous, takes approvals not paths, returns digests not upstream inputs, throws instead of returning `ProjectResult`, and `runAdjudication` already applies it internally at `:364`. Implement it: resolve each task-relative upstream path, read and digest its canonical bytes, prove a matching `artifact-approval` in `state.approvals`, and build each `AdjudicationUpstreamInput`.

**`open_gate` needs two adapters, not one.** `runAdjudication` calls `open_gate` for a detected constitution edit *before* dispatch or any result commit (`adjudication.ts:332-342`), so a single "the result has committed by now" derivation is false for that arm.

- *Pre-dispatch constitution-edit adapter*: derive gate inputs from current canonical state and the original call — its `expected_revision`, `intent_id`, `input_fingerprint`, and `phase_instance` are the call's own. In this arm the service returns only `{gate}`, while the wire `AdjudicateSuccess` requires `path`, `constitution`, `drift`, `triggers`, and `revision` (`mcp-tools.ts:47`). The handler therefore returns a **classified non-success** naming the open constitution-edit gate and its retry contract; it must not fabricate a success shape.
- *Post-commit adapter*: for adjudication-result obligations, derive `expected_revision` from post-commit state, `phase_instance` and `current_evidence` from the committed adjudication evidence, `input_fingerprint` from the retained result reference, and `intent_id`/`request_digest` deterministically from canonical task identity plus the committed intent. `architecture.md:292` requires gate IDs to be deterministic and caller-known, so this must reproduce exactly on re-entry.

**Crash/restart re-entry needs authority and result recovery, not just an assessment.** `assessCurrentEvidence` treats a prior gate as satisfied only through `AuthenticatedGateApproval` capabilities (`fixed-point.ts:150-201`), which are minted only by `loadAuthenticatedGateApproval` rereading canonical state plus the archived request and decision (`gates.ts:296-370`). Calling `assessCurrentEvidence` without loading them will reselect an already-resolved obligation. Pin three seams on the adjudicate crash path:

1. **Subject assembly**: authentic constitution, retained evidence set, **every** authenticated gate approval, live waivers, and max attempts.
2. **Deterministic next-unsatisfied-gate derivation** from that subject.
3. **An authenticated retired-outcome loader** that reconstructs the adjudication wire result from its retained result and receipt. After a synthetic gate advances the revision the original receipt is no longer the current `committed_intent`, so the handler must answer from retained authority — never by calling `runAdjudication`, which would redispatch.

**`archflow_gate`** — `runDurableGate(dependencies, input & { signal })`. Supplemental ingestion flows through the chunk-2 record; retry effects (`revise`, `revise-current`, `retry-once`) re-enter through `resolve_gate_reentry_fingerprint`. Reconnect after cancellation observes the existing open gate.

**`archflow_waiver`** — the `waiver` gate kind through the same lifecycle with `waiver_origin_gate_id`. Granted waivers are later consumed by `waiverInForce`.

Update `src/main.ts` to install the registry, and update `mcp-stdio.test.ts` / `mcp-server.test.ts`: the `valid_disabled` fixture no longer produces `TOOL_DISABLED`.

### 5. `archflow-local`

Depends on chunk 2; parallel with chunk 4. `src/local/main.ts` uses `node:util` `parseArgs`; no CLI dependency is installed and none should be added. Commands: `validate`, `hash`, `render`, `snapshot`, `restore`, `maintain`, `decide`, `gate-counter`, `status`, `reconcile`, `import`, `checkpoint`. No `upgrade` command and no stub. The helper never speaks MCP and must not appear in `tools/list`.

Thin adapters over existing exports cover `validate`, `hash`, `render`, `snapshot`, `restore`, `decide`, `reconcile`, and `import`: `contracts/{validators,canonical,renderers}.ts`, `state/snapshots.ts`, `createManualGateFile` with `ensureDecisionDirectory`, `reconcileCurrentAuthority`, and `planCheckpointAdoption` / `importGateDecisions` / `selectGreatestValidChain` with the break-code family. Four commands are not thin:

**`gate-counter`** ingests the other client's structured JSON: validate it, bind the exact task/gate/subject/input digests, **create the chunk-2 immutable record first**, then canonically render and **atomically rename** the complete projection to `reviews/<phase-instance>.gate-counter.<gate-id>.md` **last**. Re-running with identical input must reuse the existing record byte-identically rather than fail. That projection is the sole wake-up trigger for a blocked gate — `gates.ts:1027` resolves `gateCounterReviewClaim(phase_instance, gate_id)` and `:1032-1034` hands it to `waitForGateInterface`. Per `architecture.md:292` this is the human's second-terminal step.

**`checkpoint`** writes and enumerates manual checkpoints. `manualCheckpointV1Schema`, `parseManualCheckpoint`, and `checkpointSelfDigest` exist; the writer and enumeration do not. Enumeration returns `CanonicalDocument`s — the filename encodes a digest callers need and `CheckpointChainEvidence` (`handoff.ts:32`) is already that type. **Checkpoints join the immutable partition**: add `manual-checkpoint` to the `createExclusive` allowlist plus a `manual/checkpoints/` ensurer, since `createExclusive` opens its temp with `wx` in `dirname(target)` and never mkdirs. `.archflow/context/state-and-contracts.md:841-842` and `patterns.md:355` warn that a loose allowlist erodes the immutable/mutable partition; immutable-after-creation checkpoints are exactly what it is for. `manual-checkpoint` is already in `PROJECTABLE`, but that route overwrites and cannot express create-once.

**`maintain`** is the largest. `computeMaintenanceProof` needs fully resolved and digested `MaintenanceCandidate[]` in addition to roots and manifests (`maintenance.ts:54-58`), and `performMaintenance` needs a complete human-authored, proof-bound `MaintenanceRecordV1` plus its resolved create-exclusive target (`:151-189`). So `maintenance-roots.ts` also carries a **bounded candidate enumerator** limited to unreferenced attempt records and superseded non-authoritative payloads — nothing else is ever a deletion candidate. `maintain` then takes the explicit human reason and maintenance ID, builds and validates the proof-bound record, resolves its target, and only then deletes admitted candidates. Root enumeration is a bounded schema-specific walk (validated current state → checkpoint chains → resumable receipts → decision/review evidence, including the new supplemental records → their named manifests → those manifests' named payloads); it is **not** a general graph engine. Be accurate about `inventory_complete`: typed as the literal `true` (`maintenance.ts:20`) and checked in `computeMaintenanceProof:68`, it is a caller assertion nothing verifies, so the enumerator's correctness is the real guarantee and gets a direct test.

```ts
// src/state/manual-checkpoints.ts
export async function writeManualCheckpoint(d: TransactionDependencies, a: TransactionAuthority, c: ManualCheckpointV1): Promise<ProjectResult<CanonicalDocument<ManualCheckpointV1>>>;
export async function readManualCheckpoints(d: TransactionDependencies, a: TransactionAuthority): Promise<ProjectResult<CheckpointChainEvidence>>;

// src/state/status.ts — task, revision, chain head, open obligations, blocking reasons
export async function computeDegradedStatus(d: TransactionDependencies, a: TransactionAuthority): Promise<ProjectResult<DegradedStatus>>;

// src/state/maintenance-roots.ts
export async function enumerateMaintenanceRoots(d: TransactionDependencies, a: TransactionAuthority): Promise<ProjectResult<MaintenanceRoots>>;
export async function enumerateMaintenanceManifests(d: TransactionDependencies, a: TransactionAuthority, roots: MaintenanceRoots): Promise<ProjectResult<readonly MaintenanceManifest[]>>;
export async function enumerateMaintenanceCandidates(d: TransactionDependencies, a: TransactionAuthority, roots: MaintenanceRoots): Promise<ProjectResult<readonly MaintenanceCandidate[]>>;
```

**`status`** is only what the helper itself computes and prints. Phase 17 owns normal-mode `archflow-status`, Phase 18 owns degraded skill flows.

**No `package.json` `bin`.** The package is `"private": true` with no `files`/`exports`, `install.sh` installs only skills, and `dist/archflow-mcp.mjs` line 1 is the esbuild `createRequire` banner rather than a `#!` shebang — an `npm link` launcher would not execute, and adding a shebang changes bundle bytes and the launch profile. Document `node dist/archflow-local.mjs`; launchers and installer are Phase 16's.

### 6. Release rebuild

Last, since it bundles what the others produce. Sequencing matters here.

**Step 0 — `.gitattributes` first.** `dist/archflow-local.mjs` is unspecified while `archflow-mcp.mjs` is pinned `-whitespace`, and the bundle carries trailing-whitespace lines `git diff --check` would flag. `.gitattributes` is also in `REQUIRED_CONTROLS` (`release-support.mjs:95`), so editing it after staging fails "release controls record is stale" (`:618`).

**Delete the loader policy** (Context decision 2): `assertReleaseLoaderPolicy` (`:149`), both call sites (`:926`, `:1184`), its exact-banner assertion, and the `loader-policy` mutation class (`test-release-integrity.mjs:219-222`). Keep `RELEASE_BUILD_PROFILE.banner` — it defines `require` for the CommonJS interop.

**Two build entries**: replace the single `entry`/`output` in `RELEASE_BUILD_PROFILE` (`:53`) with an ordered entry list and update the single-output invariants at `:1176`, `:995`, `:930`, `:952-953`, `:45`, `:1200`, `:1206`, `:1230`, and the legal-review `entry_bindings` byte match at `:805`.

**[REVERSED] Per-entry provenance replaces the previous "keep it single-bundle-bound" decision.** That decision does not survive: `:933` requires the **global** metafile input set to equal top-level `bundle_inputs`, which fails the moment a second output exists, and a local-only source or dependency change would carry no provenance at all — contradicting the architecture's requirement that the manifest bind the complete server/helper assembly. Model minimal per-entry provenance: entry/output digest plus the exact source and dependency input set per output. Per-input byte contribution does **not** need generalizing. Validate each output against its entry, and mutation-test local-only source drift. `launch_profile` may still stay scoped to the mcp-stdio entry — the local bundle is deliberately not launch-profiled — but `bundle_inputs` and provenance cannot.

**[REVERSED] The builtin-import allowlist must widen.** `RELEASE_BUILD_PROFILE.allowedImports` and the launch-profile schema permit only buffer/crypto/module/process/util (`:67-73`; `release-manifest.schema.json:312-314`), enforced at both build (`:1180-1182`) and payload (`:938-939`) validation. The previous round never touched it, so staging would have failed on the first run. A probe over the production graph that live handlers create confirms it needs at least `node:async_hooks`, `node:child_process`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:perf_hooks`, `node:timers/promises` — and also several **bare** builtin specifiers (`buffer`, `fs`, `path`, `process`, `tty`, `util`, `worker_threads`) plus an unresolved optional `supports-color` reached through `debug`, which is a different hazard from a missing `node:` prefix. Do **not** hand-write the list: derive the exact union from the two real staged outputs, decide explicitly how to treat the bare specifiers and the optional package import, then update the schema, derivation, validator, and contract tests, and validate imports per output. Independent of the loader-policy deletion.

**Derive the legal closure; do not enumerate it.** Legal validation derives every contributing installed package with `bytes_in_output > 0` and demands exact equality with `current_components` (`:712-723`), a unique retained `release/legal/upstream/…` source per component whose digest equals the installed `LICENSE` bytes plus a `package_identity` from `package-lock.json` (`:727-746`), and strict one-to-one component↔upstream mapping (`:767-771`). The previous round's fixed list of five new packages and fixed 14 → 20 file count are both wrong: the live graph also reaches `yaml`, `write-file-atomic`, `signal-exit`, and the Secretlint closure (`@secretlint/core`, `@secretlint/profiler`, `@secretlint/secretlint-rule-preset-recommend`, `boundary`, `debug`, `ms`, `structured-source`) — roughly eighteen contributors, not eight. So: derive the installed contributor closure from the staged manifest **across both outputs**, retain one exact installed-copy legal source per resulting component, disambiguate any component whose version collides with an existing embedded copy (`ajv-formats@3.0.1`, `fast-deep-equal@3.1.3`, `json-schema-traverse@1.0.0` do), and drive the file plan and tests from that derived closure. Keep one version note: the existing `fast-uri` risk decision is scoped to **3.1.0** while the installed copy is **3.1.4** — check whether the four advisories apply to 3.1.4 before assuming a second decision is needed.

**`handler_authority` vocabulary**: the enum `["inert-no-handler", "local-cli-handler"]` (`release-manifest.schema.json:253`, `release-legal-review.schema.json:161`) cannot express "the mcp-stdio entry now has live handlers". Make the minimal change that does — e.g. add `"mcp-tool-handler"` to both enums and widen the `"const": "inert-no-handler"` risk scope at `release-legal-review.schema.json:264`. Reconcile `release-support.mjs:806,952,1230`; `release/legal-review.json`; `release/evidence/user-risk-acceptance.json:16`; `release/evidence/focused-inert-reachability.json:5`; `test/contracts/release-contracts.test.ts:111,190,208,320`.

**Re-author the fast-uri risk evidence.** `focused-inert-reachability.json` currently finds that "the inert handler-free runtime exposes no identified route from untrusted JSON-RPC input to URI normalization", and the decision lists `handler-authority-change` in its own `invalidated_by`. Live handlers make that finding false by its own terms. Rewrite it for the live runtime; the acceptance is a human decision.

**Relax `verifyHeadLegalBaseline` (Context decision 3), then one plain ordering.** `:1361-1381` requires every HEAD `dependency_gate_decisions` record to appear byte-identically in the candidate, while `validateLegalCorrelation:800-806` requires every decision to bind the *current* bundle digest, inventory digest, entry bindings, and handler-authority scope, and a supersession must retain the superseded decision — which carries the old digest. The previous round's "commit first, then write" merely moved the changed decision into HEAD to evade the check while temporarily committing an inconsistent legal set. Relax the rule so an explicitly re-authorized decision promotes atomically. Single ordering: `.gitattributes` → `release:stage` → read the final digests and entry bindings off the staged payload → author the decision and evidence → `release:stage` again → `release:write`. No intermediate commit, no new release operation.

**Smoke coverage**: `smoke-release-bundle.mjs` spawns one bundle and must cover the helper too; its `TOOL_DISABLED` expectation at `:180` becomes whatever a live handler returns in the scrubbed hostile copy. Scrubbed environment, fd-3 network oracle, and canaries stay unchanged, as does `reproduce-release.mjs`.

Regenerating `dist/` clears the two stale-`bundle_inputs` failures at `release-offline.test.ts:45,78`; the loader deletion clears `:61`.

## Success Criteria

- [ ] Live `tools/list` returns exactly the five tools with the normative schemas and no sixth workflow tool.
- [ ] Valid and invalid calls exhibit replay, mismatch, conflict, family, host, path, child, and blocking semantics with no partial-success side effect on disk; every stable dispatch failure class arrives classified, never as `INTERNAL_ERROR`.
- [ ] An exact replay returns the committed outcome and launches no model child.
- [ ] Cancelling an in-flight call — including during adapter preflight — leaves durable truth intact, kills active descendants, and still records the diagnostic attempt; reconnecting observes existing state or gate instead of duplicating work.
- [ ] The bundled server writes only MCP traffic to stdout, nothing to stderr on a clean run, and opens no network listener.
- [ ] Supplemental review works end to end: `gate-counter` retains the immutable record then publishes the projection; the resolver authenticates only from the record; a forged projection, a forged slot, a `server-attested` claim, and a fabricated triage digest are all rejected; an exact decline does not re-wake the gate and does not block an otherwise valid decision.
- [ ] Both producer directions dispatch successfully, with the Claude-family path deliberately configured and its release authorization still recorded as blocked by VAL-14.
- [ ] `archflow-local` performs its named local operations without MCP, shares the server's schemas and renderers, and never appears in `tools/list`.
- [ ] `archflow-local checkpoint` atomically extends only a valid reconciled chain and refuses gap, fork, and foreign-candidate chains; server adoption imports only its greatest valid checkpoint through the `manual-checkpoint-import` union tag.
- [ ] The regenerated tracked manifest describes both build entries with per-entry provenance, binds the derived import allowlist and derived legal closure, and passes clean-checkout offline startup.
- [ ] `npm test` reports **1,482/1,482** plus this phase's new tests.
- [ ] No upgrade command, no `package.json` `bin`, no replacement for the deleted loader policy, and no preview/two-pass release operation.

## Verification Steps

1. `npm run typecheck`
2. `npm test` — 1,482/1,482 plus new tests, zero failures.
3. `npm run test:contracts`
4. `npm run test:mcp-runtime`
5. `npm run build:temp`
6. `npm run check:dependencies`
7. `.gitattributes` → `npm run release:stage` → author legal decision/evidence → `npm run release:stage` → `npm run release:write` → `npm run check:release`
8. `npm run check`
9. `git diff --check`

Edge cases the new suites must cover:

- A `tools/call` outside a Git worktree, and inside one with no task state — clean project failures, not crashes.
- **`git` binary absent from `PATH`.** `smoke-release-bundle.mjs:71-83` sets `PATH` to `dirname(process.execPath)` only, and `:119-127` requires empty stderr, an empty oracle, exit 0, and exactly seven frames. A live handler reaches `discoverWorktree`/`preflightGit`, which spawn a `git` that is not there. Confirm the ENOENT maps to a clean project error rather than a throw.
- Exact replay and receipt-only recovery, asserted by **model-call count**, not just returned bytes.
- Each typed dispatch failure — routing, unsupported host, family mismatch, CLI missing, auth unavailable, timeout, overflow, cancellation — surfacing its own code through the live boundary.
- Cancellation during preflight and during the child: descendants die, the attempt record exists with its managed-policy telemetry, and no evidence is retained.
- Supplemental round trip and every rejection listed in the success criteria, driven through `runDurableGate`.
- Constitution-edit pre-dispatch gate: `archflow_adjudicate` returns a classified non-success naming the open gate and never a fabricated success shape.
- Adjudication crash window: state committed, gate not published — re-entry loads every authenticated approval, derives the next unsatisfied gate deterministically, and reconstructs the retired wire result without redispatching.
- Both producer directions through the fake-CLI fixtures (`test/fixtures/dispatch/fake-{claude,codex}.mjs`), using the temp-`bin` symlink + scenario-file pattern.
- `checkpoint` against gap, fork, and foreign-candidate chains.
- `enumerateMaintenanceRoots` and `enumerateMaintenanceCandidates` against a repository with a known reachable set: assert both match exactly. (Do not assert `performMaintenance` "fails closed" on incomplete roots — `inventory_complete` is a literal-typed caller assertion, so the enumerator is the only real guarantee.)
- Release: local-only source drift is detected by per-entry provenance; a handler returning non-plain-JSON surfaces as `INTERNAL_ERROR`.

Follow repository test conventions: real filesystem and real `git`, hand-built dependency literals (no `vi.mock`), `test/helpers/temp-repository.ts` and `resolved-constitution.ts`, and the `harness()` shape at `state-gate-lifecycle-phase12.test.ts:85-127` with the real `lock` and `read_config`.

**Human judgment only:**

- Accepting the re-authored `fast-uri` risk decision, and whether installed `fast-uri@3.1.4` needs its own. The existing acceptance is scoped to `handler_authority: "inert-no-handler"` and version 3.1.0 and declares itself invalidated by a handler-authority change.
- The production `allow_claude_dispatch` value, and confirming that VAL-14 still blocks releasing that path.
- Confirming the `verifyHeadLegalBaseline` relaxation and the deleted loader policy are not to be replaced.
- Confirming the `createExclusive` allowlist widenings (`manual-checkpoint`, the supplemental record) and `attempt` joining the mutable partition.
- Confirming the reconciled Phase 15/19 scope wording in `architecture.md`.

---
*Designed: 2026-07-31*
