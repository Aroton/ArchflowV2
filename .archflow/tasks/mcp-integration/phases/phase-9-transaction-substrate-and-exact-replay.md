# Phase 9: Transaction Substrate and Exact Replay

**Status**: DESIGNED
**Task**: mcp-integration
**Goal**: Establish the exact-once local transaction substrate so one task's prepared operation is committed once under races, crashes, retries, and config drift.
**Requirements**: REQ-04, REQ-08, REQ-13, REQ-14, REQ-21, REQ-22, REQ-23, REQ-24, REQ-26

## Context

Phases 6–8 already provide canonical JSON/digests, task-scoped path resolution, Git conflict/divergence preflight, durable state and artifact schemas, and manual-checkpoint validation. They deliberately provide no filesystem transaction service. The live tree has no `src/state/` directory, and `computeRequestDigest` still accepts an open `operation_fields` object. Phase 8 also left adoption and reconciliation unimplemented; after the approved split, those belong to Phase 10 rather than this phase.

Exact replay needs one stronger authority than the Phase 7 state shape provides. An intent receipt will be an immutable prepared record whose canonical digest and exact outcome digest are authenticated by `state.json`. An unreferenced receipt is only orphaned preparation; the state reference is the sole commit event. The receipt therefore has no mutable `committed` marker, and replay never trusts a deterministic filename by itself. Phase 9 stops at a transport-neutral kernel: workflow transitions and initialization are Phase 10, payload snapshots/restore are Phase 11, and MCP handler wiring is Phase 15.

## What We're Building

Add a normative `intent-receipt` durable root, replace the state's weak `prepared_intent` reference with a complete `committed_intent` binding, and extend the consolidated durable semantic validator to prove receipt/state/outcome/prepared-state agreement. Replace the open request-digest input with closed tool-operation selectors that reuse the shipped request-binding mechanism. Add small internal adapters for atomic replacement and non-renewing task-local locks, safe intent-directory creation, canonical state/config/receipt readers, and a generic state-last transaction function that performs CAS and replay classification before invoking authenticated caller-supplied preparation.

The kernel writes only a new immutable receipt and `state.json`. It does not replace mutable canonical projections: until Phase 11 snapshots and restoration exist, doing so could leave old state authenticating overwritten files after a crash. It also does not invent result manifests, enumerate history, or interpret workflow transitions. `write-file-atomic` supplies state temp-and-rename replacement and no-torn-file reader visibility, not a promise that the newest rename survives power loss. Core `mkdir` supplies atomic same-filesystem lock acquisition with no stale takeover; a lock left by `SIGKILL` blocks for explicit repair.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify | `.archflow/tasks/mcp-integration/architecture.md` | Record the Phase 7 state amendment, success-only receipt scope, resumable orphan behavior, and the state-only REQ-14 limitation with Phase 10/17 owners. |
| Modify | `package.json` | Add exact runtime pin `write-file-atomic@8.0.0`; narrow the supported engine range to Node 24 (`^24.15.0`) so Node 25 is not falsely admitted. |
| Modify | `package-lock.json` | Lock the admitted dependency graph exactly. |
| Modify | `scripts/check-dependency-policy.mjs` | Admit the exact runtime package and updated Node engine while keeping `proper-lockfile` and later-phase packages prohibited. |
| Modify | `THIRD_PARTY_NOTICES.md` | Record the new permissive dependency graph and required notice entries. |
| Modify | `docs/dependency-upgrades.md` | Record pins, maintenance caveats, and the reviewed update procedure. |
| Create | `src/types/write-file-atomic.d.ts` | Declare only the reviewed v8 promise API used by the adapter; avoid adopting stale v4 community typings. |
| Create | `src/contracts/schemas/v1/intent-receipt.schema.json` | Normative strict shape for one immutable prepared receipt. |
| Create | `src/contracts/durable-intent.ts` | Persisted type aliases, parser, and receipt/outcome digest helpers. |
| Modify | `src/contracts/schemas/v1/task-state.schema.json` | Replace `preparedIntentRef`/`prepared_intent` with the complete committed receipt/outcome binding. |
| Modify | `src/contracts/durable-state.ts` | Replace `PreparedIntentRef` with the persisted `CommittedIntentRef` type alias. |
| Modify | `src/contracts/durable.ts` | Admit a receipt document and enforce receipt self-digest, outcome digest, task/repository identity, revision, request, and state-reference agreement in the existing ordered semantic authority. |
| Modify | `src/contracts/errors.ts` | Add the non-retryable `INTENT_NOT_CURRENT` outcome for an immutable receipt superseded by current state. |
| Modify | `src/contracts/schemas/v1/project-error.schema.json` | Mirror the new stable error and safe next action. |
| Modify | `src/contracts/fingerprints.ts` | Replace open operation fields and their denylist with closed, tool-specific request-digest constructors. |
| Modify | `src/contracts/mcp-tools.ts` | Materialize and recursively freeze the complete parsed input graph before installing its non-enumerable authenticity brand, so later digest/result readers cannot observe mutated nested semantics. |
| Modify | `src/contracts/versions.ts` | Register the `intent-receipt` schema ID. |
| Modify | `src/contracts/validators.ts` | Register and compile the new durable schema. |
| Modify | `src/contracts/index.ts` | Export the public contract seam without exporting internal filesystem capabilities. |
| Modify | `src/repository/paths.ts` | Add an internally consumed task-root resolver that mints `ResolvedTaskPath` through the same resolution-time containment authority rather than a state-layer cast. |
| Create | `src/state/authority.ts` | Mint one internal task/repository/path authority from live repository resolution. |
| Create | `src/state/request.ts` | Select closed request fields, compute the digest, and reuse `bindParsedToolCallRequest`. |
| Create | `src/state/fingerprint.ts` | Build the trusted resolver that derives the fingerprint subject from live config, pinned state, canonical Git identities, and immutable parsed-call semantics under the lock. |
| Create | `src/state/atomic.ts` | Use `write-file-atomic` for state replacement and core temp+`link` for exclusive receipt creation. |
| Create | `src/state/lock.ts` | Implement a non-reentrant core `mkdir` task lock with bounded wait and no stale takeover. |
| Create | `src/state/layout.ts` | Safely create/validate the task-local `intents/` directory without accepting symlinks or caller paths. |
| Create | `src/state/read.ts` | Canonical state/config/receipt reads through resolved task paths. |
| Create | `src/state/transaction.ts` | Transport-neutral CAS, replay, config-pin, preparation, and state-last commit orchestration. |
| Modify | `test/contracts/schema-registry.test.ts` | Pin registry membership and schema closure. |
| Modify | `test/contracts/repository-boundary.test.ts` | Update the admitted dependency baseline; preserve contracts→repository isolation and prove `src/contracts/index.ts` exports no `src/state/` filesystem capability. |
| Modify | `test/unit/repository-paths.test.ts` | Pin authentic task-root derivation and containment/error behavior for the new internal resolver. |
| Modify | `test/contracts/gate-error-supplemental-exhaustive.test.ts` | Keep project-error schema/registry exhaustiveness after the new intent error. |
| Modify | `test/contracts/durable-agreement.test.ts` | Add receipt structural authority/state-reference agreement coverage and re-derive the normative-schema-vs-Zod banned-name guard after the state amendment. |
| Modify | `test/unit/durable-semantics.test.ts` | Pin receipt/state semantic precedence and substitution failures. |
| Modify | `test/unit/errors.test.ts` | Pin `INTENT_NOT_CURRENT` ownership, parameters, retryability, and guidance. |
| Modify | `test/unit/fingerprints.test.ts` | Prove closed operation fields and excluded transport/CAS/retry data. |
| Modify | `test/unit/mcp-tools.test.ts` | Prove post-parse/post-identification mutation cannot change any nested tool input observed by hashing, preparation, or result correlation. |
| Create | `test/unit/state-atomic.test.ts` | Exercise adapter success/failure and replacement visibility. |
| Create | `test/unit/state-lock.test.ts` | Exercise contention, independence, non-reentrancy, abandoned-lock blocking, and release behavior. |
| Create | `test/unit/state-transaction.test.ts` | Exercise CAS/replay/config ordering and no-preparation rejection paths. |
| Create | `test/integration/state-transaction.test.ts` | Run real same-filesystem multi-process contention and canonical task-path integration. |
| Create | `test/crash/state-transaction.test.ts` | Use env-gated child-process cut points at receipt-temp/install and state-replace boundaries and verify restart classification; production bundles expose no fault hook. |
| Modify | `scripts/smoke-temp-bundle.mjs` | Update the exhaustive project-error count and smoke the new exported contracts. |

## Interface Contracts

Persisted shapes below are `type` aliases throughout their reachable graph. Names are pinned here because contract, reader, and kernel chunks can be implemented independently.

```ts
export type IntentReceiptV1 = {
  readonly schema_version: "1";
  readonly intent_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly tool: ToolName;
  readonly operation: SafeCode;
  readonly request_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly prior_revision: SafeInteger;
  readonly resulting_revision: SafeInteger;
  readonly result_id: SafeId;
  readonly outcome_digest: Sha256Digest;
  readonly outcome: PlainJsonValue; // exact successful ToolSuccess<K> snapshot
  readonly prepared_state_digest: Sha256Digest;
  readonly prepared_state: TaskStateV1; // revision N+1, committed_intent absent
};

export type CommittedIntentRef = {
  readonly intent_id: PathSafeId;
  readonly request_digest: Sha256Digest;
  readonly receipt_digest: Sha256Digest;
  readonly outcome_digest: Sha256Digest;
  readonly prior_revision: SafeInteger;
  readonly resulting_revision: SafeInteger;
  readonly result_id: SafeId;
};

export function parseIntentReceipt(value: unknown): IntentReceiptV1;
export function intentReceiptDigest(receipt: IntentReceiptV1): Sha256Digest;
export function intentOutcomeDigest(outcome: PlainJsonValue): Sha256Digest;
```

`IntentReceiptV1.outcome` stores only the exact successful `ToolSuccess<K>` value later returned by replay; failed preparation writes no receipt. The root schema requires strict plain JSON but deliberately does not duplicate the five MCP success schemas. Revalidation uses the recorded `tool` and the existing tool result contract. `prior_revision` has `minimum: 0` so Phase 10's separate initializer can share the receipt contract; `resulting_revision` has `minimum: 1`, must equal `prior_revision + 1`, and overflow is rejected before preparation. Phase 9 prepared mode additionally requires a real predecessor with revision at least 1. The receipt's canonical byte length is capped at 1 MiB by the kernel. Receipts remain for the task lifetime in this prototype; no Phase 9 pruning exists.

`prepared_state` is the complete planned state at `resulting_revision`, with `committed_intent` absent. `prepared_state_digest` is `canonicalJsonDigest(prepared_state)`. On a matching receipt-only restart the kernel validates it against the current predecessor state, derives `committed_intent`, and performs only the final state write; it never reruns `prepare`. `intentReceiptDigest` is exactly `canonicalJsonDigest(receipt)` over the whole receipt with no domain tag or field subset, and `intentOutcomeDigest` is exactly the canonical JSON digest of the stored success value.

Final-state derivation is exact: copy the already validated/materialized `prepared_state` and add only the kernel-derived `committed_intent`; no other field may differ. Replay revalidates `{schema_version: "1", ok: true, value: receipt.outcome}` with existing `validateProjectResultStructure` against the authentic parsed call, requires success, and checks its revision plus the receipt's `tool`, operation literal, request/input fingerprints, intent, task, result ID, and outcome digest before returning `ToolSuccess<K>`. It does not mint a caller expectation from receipt data.

The receipt is server-internal and has one normative JSON Schema model only; it is not mirrored in Zod. The schema is strict, reuses durable-primitives `$defs` for IDs/digests/integers/plain JSON, and references the normative task-state root for `prepared_state`.

### One internal authority and closed request binding

The state layer mints one non-exported, registry-authenticated authority from live repository discovery. It contains usable identity and path-class evidence; no caller supplies a write target.

```ts
export type TransactionAuthority = Readonly<{
  task_id: TaskSlug;
  repository_identity: RepositoryIdentity;
  repository_identity_digest: Sha256Digest;
  task_identity_digest: Sha256Digest;
  context: RepositoryOperationContext;
  task_root: ResolvedTaskPath; // constructor-proven absolute root of this task
  state: ResolvedPath;  // path_class === "task-state"
  config: ResolvedPath; // path_class === "task-config"
}> & { readonly [transactionAuthorityBrand]: true };

export function createInternalTransactionAuthority(input: Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  task_id: TaskSlug;
  context: RepositoryOperationContext;
}>): Promise<ProjectResult<TransactionAuthority>>;

// Internal to src/state/request.ts; not exported from contracts/index.ts.
export function identifyTransactionRequest<K extends ToolName>(
  call: Extract<ParsedToolCall, { readonly name: K }>,
  authority: TransactionAuthority,
  recomputedInputFingerprint: Sha256Digest,
): Readonly<{
  call: Extract<RequestIdentifiedToolCall, { readonly name: K }>;
  request_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
}>;
```

The async internal authority constructor accepts only an authentic root-bound runner, verified Git environment, parsed `task_id`, and operation context; it requires `context.task_id === task_id` and snapshots the context once. It calls live `resolveRepositoryIdentity`, computes `TaskIdentity` internally from that observed identity, then asks `src/repository/paths.ts` to resolve/mint the task root plus exact `task-state` and `task-config` paths from the fixed templates. It accepts no recorded identity, root/path, or `InputFingerprintSubject` from its caller. The kernel requires `dependencies.runner`/environment to be the same registered pair used to mint the authority and, immediately after decoding state, calls `verifyRepositoryIdentity(state.repository_identity_digest, observed)` before CAS or receipt/config/fingerprint handling. It obtains the fingerprint subject only from the trusted injected `InputFingerprintResolver`, which derives every digest and Git identity from live canonical repository/state inputs under the task lock and accepts no caller-supplied subject or digest. The kernel validates/materializes the returned subject once, calls `computeInputFingerprint`, and supplies only that digest to `identifyTransactionRequest`.

`identifyTransactionRequest` requires `call.input.task_id === authority.task_id`, uses closed per-tool selectors, and delegates binding to shipped `bindParsedToolCallRequest`. It returns the computed digest alongside the bound call because the shipped binder stores it only in a private WeakMap—the phantom `request_digest` property is never read at runtime. The pair is produced and consumed inside the same kernel turn rather than accepted in `TransactionRequest`; result correlation independently verifies the WeakMap binding. There is no second binding brand or digest-authority object. `intent_id`, `expected_revision`, and caller-asserted `input_fingerprint` are excluded; the resolver-produced fingerprint is included once. Phase 15 must extend the resolver/selector deliberately if `archflow_state.artifact` becomes live.

`parseToolCall` is strengthened at the source: after Zod/tool-specific semantic parsing and before authenticity branding, it asserts/materializes the whole plain input graph once, recursively freezes arrays and nested objects, installs the existing brand as non-enumerable, then freezes the shell. All selectors, preparation, `successFor`, and correlation therefore observe the same immutable semantics. Mutation tests cover nested rubric criteria, gate context/evidence, waiver origin/scope, and path arrays for every applicable tool.

| Tool | Operation literal | Exact semantic fields |
|------|-------------------|-----------------------|
| `archflow_state` | `record-state-boundary` | `phase_instance`, `step`, `status` |
| `archflow_counter_review` | `counter-review` | `artifact_path`, `rubric` |
| `archflow_adjudicate` | `adjudicate` | `artifact_path`, `upstream_paths` |
| `archflow_gate` | `gate` | `phase_instance`, `summary`, `subject_digest`, `current_evidence`, optional `supersedes`, `kind`, `context` |
| `archflow_waiver` | `waiver` | `origin`, `rationale` |

Nested values are copied from the already validated parsed call and retain their contract-defined array order. The digest layer performs no extra sorting: collections already declared as sets must arrive parser-canonical and duplicate-free, while `upstream_paths` and rubric criteria remain sequences under their current contracts. Golden fixtures pin every operation literal/field list, and compile-time exhaustiveness fails when a tool or later state-artifact member lacks an explicit selector.

The kernel derives the intent target from `call.input.intent_id` through the repository resolver with `expectedClass: "intent"`, then verifies the returned `ResolvedPath.path_class`, repository-relative claim, and containment under the constructor-proven `authority.task_root`. It never accepts an intent target as a bare `ResolvedTaskPath` or any caller pathname. The state/config resolved objects are checked for their exact classes before use. These are resolution-time containment guarantees under the repository's trusted-filesystem model; `O_NOFOLLOW` applies to the layout check, and the existing documented TOCTOU limitation remains.

### Filesystem and kernel seams

```ts
export type ExclusiveCreateResult = "created" | "exists";

export type AtomicWriter = Readonly<{
  createExclusive(path: ResolvedPath, bytes: Uint8Array): Promise<ExclusiveCreateResult>;
  replace(path: ResolvedPath, bytes: Uint8Array): Promise<void>;
}>;

export class AtomicReplaceError extends Error {
  constructor(input: Readonly<{
    operation: "create-exclusive" | "replace";
    target_may_have_changed: boolean;
    collision: boolean;
  }>);
  readonly operation: "create-exclusive" | "replace";
  readonly target_may_have_changed: boolean;
  readonly collision: boolean;
}

export type TaskLock = Readonly<{
  runExclusive<T>(taskRoot: ResolvedTaskPath, work: () => Promise<T>): Promise<T>;
}>;

export class TaskLockError extends Error {
  constructor(stage: "acquire" | "release");
  readonly stage: "acquire" | "release";
}

export type StateReadResult =
  | Readonly<{ kind: "canonical"; document: CanonicalDocument<TaskStateV1> }>
  | Readonly<{ kind: "missing" | "unreadable" | "noncanonical" }>;

export type ReceiptReadResult =
  | Readonly<{ kind: "canonical"; document: CanonicalDocument<IntentReceiptV1> }>
  | Readonly<{ kind: "missing" | "unreadable" | "noncanonical" }>;

export type LiveConfigSnapshot = Readonly<{
  bytes: Uint8Array;
  digest: Sha256Digest;
}>;

export type ConfigReadResult =
  | Readonly<{ kind: "valid"; snapshot: LiveConfigSnapshot }>
  | Readonly<{ kind: "missing" | "unreadable" | "invalid" }>;

export type FingerprintReadContext<K extends ToolName> = Readonly<{
  runner: RootBoundGitRunner;
  authority: TransactionAuthority;
  state: CanonicalDocument<TaskStateV1>;
  call: Extract<ParsedToolCall, { readonly name: K }>;
  live_config: LiveConfigSnapshot;
  context: RepositoryOperationContext;
}>;

export type CanonicalWorkflowDigestReader = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<Sha256Digest>>;
export type CanonicalConstitutionDigestReader = CanonicalWorkflowDigestReader;
export type CanonicalGitIdentityReader = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<readonly GitIdentityRef[]>>;
export type CanonicalDeclaredInputReader = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<readonly DeclaredInputRef[]>>;
export type InputFingerprintResolver = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<InputFingerprintSubject>>;

export function createInternalInputFingerprintResolver(input: Readonly<{
  read_workflow_digest: CanonicalWorkflowDigestReader;
  read_constitution_digest: CanonicalConstitutionDigestReader;
  read_artifact_identities: CanonicalGitIdentityReader;
  read_upstream_identities: CanonicalGitIdentityReader;
  read_declared_inputs: CanonicalDeclaredInputReader;
}>): InputFingerprintResolver;

export type TransactionDependencies = Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  atomic: AtomicWriter;
  lock: TaskLock;
  resolve_input_fingerprint: InputFingerprintResolver;
  read_state: (path: ResolvedPath) => Promise<StateReadResult>;
  read_config: (path: ResolvedPath) => Promise<ConfigReadResult>;
  read_receipt: (path: ResolvedPath) => Promise<ReceiptReadResult>;
}>;

export type NextStateDraft = Omit<TaskStateV1, "revision" | "committed_intent"> & {
  readonly revision?: never;
  readonly committed_intent?: never;
};

export type PreparedTransaction<K extends ToolName> = Readonly<{
  expectation: ResultExpectation<K>;
  result: StructurallyValidProjectResult<K>;
  next_state: NextStateDraft;
}>;

export type TransactionRequest<K extends ToolName = ToolName> = Readonly<{
  call: Extract<ParsedToolCall<K>, { readonly name: K }>;
  authority: TransactionAuthority;
}>;

export async function runStateTransaction<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  prepare: (
    current: CanonicalDocument<TaskStateV1>,
    call: Extract<RequestIdentifiedToolCall, { readonly name: K }>,
  ) => Promise<ProjectResult<PreparedTransaction<K>>>,
): Promise<ProjectResult<Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  outcome: ToolSuccess<K>;
  replayed: boolean;
}>>>;
```

`createExclusive` is pinned to: create a unique same-directory temp with `open(..., "wx")`; write all bytes; `fsync` and close; install with `fs.link(temp, target)`; then unlink the temp. `link` supplies the no-clobber commit point; `EEXIST` returns `"exists"`. A crash may leave only a non-authoritative uniquely named temp, never a truncated final receipt. Best-effort cleanup removes only the adapter's own known temp; no scan or age-based deletion occurs. `replace` alone uses `write-file-atomic@8.0.0` for `state.json`.

The adapter rejects a class mismatch before I/O: `createExclusive` accepts only `path_class === "intent"`, and `replace` accepts only `path_class === "task-state"`. This makes a state-target substitution impossible even for an otherwise authentic resolved path.

The lock is a fixed direct child directory under the resolved task root created with core `mkdir`. Acquisition polls only until a fixed bounded deadline; it never reads owner metadata to decide takeover, never uses age/staleness, and never removes an existing lock. It is non-reentrant. Normal callback completion removes its own lock in `finally`; a `SIGKILL`-abandoned lock remains and blocks for explicit repair. Owner metadata is diagnostic only. Independent task roots do not contend.

`runStateTransaction` first requires authentic capabilities and exact path classes as programmer-boundary preconditions needed to locate the lock/state safely; these are not project-result precedence cases. It derives the intent target, acquires the task lock, and canonically reads state. It verifies state repository identity against the authority's freshly observed repository, then checks CAS directly from `call.input.expected_revision` before any receipt/config/fingerprint semantic classification; there is no second CAS input. Initial absent, unreadable, or noncanonical state is returned as `CONTRACT_INVALID` with fixed safe `issue_code` because no trustworthy `phase_instance` exists. Only later cross-document failures use `STATE_INVALID` and the decoded current state's phase instance.

The production fingerprint resolver is created only inside `src/state/fingerprint.ts` from the named canonical readers; its constructor and reader capabilities are not exported from `src/contracts/index.ts`. It derives workflow/config/constitution digests from the live snapshot and state pins, Git identities through the Phase 6 canonical repository readers, rubric/phase semantics from the now-deep-frozen parsed call, and declared inputs from the closed per-tool selector. It rejects any state pin disagreement and returns a fresh plain subject. Unit tests may inject a resolver through `TransactionDependencies`; production MCP wiring in Phase 15 may obtain only the internal production factory, never pass an `InputFingerprintSubject` or digest.

For a new or write-ahead intent it reads the live resolved `config.yaml`, verifies those exact bytes against state, asks the trusted resolver to derive an `InputFingerprintSubject` from canonical inputs, validates/materializes that subject once, computes the fingerprint, and compares it with `call.input.input_fingerprint`. It then identifies/binds the call and classifies the exact request digest. A state-authenticated replay instead uses the receipt's already committed input fingerprint to identify the call, first requiring it to equal the caller assertion; it does not reread mutable inputs. Only a new intent may call `prepare`. `prepare` must be pure with respect to repository state, bounded, non-blocking, and perform no model/network/child-process/filesystem I/O while the lock is held; Phase 15 dispatches long-running work outside this kernel. A violation is a caller protocol bug, not a reason to extend or steal the lock.

The kernel descriptor-reads every plan slot once, authenticates/correlates the result expectation and result against the request-bound call, and requires success. Before the first write it requires `expectation.resulting_revision === current.revision + 1`, the correlated success's `revision` equals that value, and `resulting_revision` is safe. It validates/clones `next_state` once, sets the planned revision itself, preserves all substrate identity fields and `adopted_checkpoint` exactly, constructs receipt and final state, and validates both the prepared relation `(current, receipt)` and committed relation `(final state, receipt)` before installing the receipt. Runtime forbidden keys or malformed caller plans are programmer-boundary `TypeError`s; project errors are reserved for environmental/durable failures.

Branded result/expectation capabilities are never passed to `assertPlainJson` or `structuredClone`. Only internally materialized unbranded success/state snapshots are digested or written. Phase 9 accepts no caller-owned projection buffers or paths.

The kernel safely creates/checks `intents/`, installs the receipt exclusively, replaces state last, and canonically rereads state before returning. An existing receipt is always parsed and classified; a deterministic filename alone conveys no authority.

| Receipt/current-state relation after CAS | Request relation | Outcome |
|------------------------------------------|------------------|---------|
| Receipt absent and state does not claim this intent | — | Verify config/fingerprint, call `prepare`, install receipt, then state. |
| State authenticates this exact receipt at current revision | digest and `intent_id` equal | Revalidate and return exact typed success replay. |
| State authenticates this exact receipt | request digest differs | `INTENT_MISMATCH`. |
| Any canonical receipt's embedded `intent_id` differs from the derived target/call, or its tool/operation is inconsistent | — | `TASK_INVALID` with the exact receipt identity issue code; never classify it as changed reuse. |
| Any canonical receipt has foreign task/repository identity or its stored fingerprint conflicts with the fingerprint used by its request digest | — | `TASK_INVALID` at the exact receipt identity/fingerprint issue code. |
| Locally valid uncommitted receipt has `prior_revision > current.revision` | any | `TASK_INVALID {issue_code: "intent-receipt-future-revision"}`; never wait for or infer future state. |
| Receipt is valid write-ahead for exactly current revision N → N+1; state still at N and does not claim it | digest, intent, tool/operation, task/repository identity, and input fingerprint all equal | Recheck live config and caller fingerprint, validate embedded prepared state, derive final binding, write state only, return success without `prepare`. |
| Locally valid receipt has `resulting_revision <= current.revision` but current state does not authenticate it | digest equal | `INTENT_NOT_CURRENT`; retain it and require current-state inspection, never advise automatic re-execution. |
| Any uncommitted/superseded receipt | request digest differs | `INTENT_MISMATCH`. |
| Any receipt read is unreadable | — | `IO_ERROR {operation: "intent-receipt-read", attempt}`. |
| Uncommitted receipt is noncanonical | — | `CONTRACT_INVALID {issue_code: "intent-receipt-noncanonical"}` because no trusted receipt/state phase exists. |
| State claims this intent but receipt is missing | — | `STATE_INVALID {issue_code: "intent-receipt-missing"}`; never replay. |
| State claims this intent but receipt is noncanonical | — | `STATE_INVALID {issue_code: "intent-receipt-noncanonical"}`; never replay. |
| State claims this intent but canonical receipt is substituted | — | Consolidated committed-mode `STATE_INVALID` at the exact rank-8b mismatch; never replay. |

Every `ConfigReadResult` is likewise total after the replay short-circuit: `valid` with equal digest continues; `valid` with a different digest is `PINNED_CONFIG_MISMATCH`; `missing` or `unreadable` is `IO_ERROR {operation: "task-config-read", attempt}`; and `invalid` is `CONFIG_INVALID {issue_code: "task-config-invalid"}`. Every locally canonical receipt first passes all rank-3/rank-4b checks, including successor arithmetic, before a revision row above is considered.

After the programmer-boundary capability/path preconditions needed to read the task, project-result precedence under the lock is: constructible canonical-state result → live repository-identity agreement → `call.input.expected_revision` CAS → receipt shell/revision classification → state-authenticated replay or live config pin → caller fingerprint assertion → exact request/relation classification → preparation or orphan completion. A committed replay returns before live config/fingerprint rechecking because it is already authoritative; a write-ahead orphan must pass both before it can become committed. Thus a byte-identical delivery using its original expected revision N returns `STATE_CONFLICT` after the N+1 commit; exact replay requires the caller to refresh `expected_revision` to N+1. The expected revision is excluded from the request digest, so the refreshed call binds the same logical request. No API scans history.

If receipt install, state replacement, or lock release reports an ambiguous error, the kernel rereads canonical state and receipt. Authenticated final state returns success. Unchanged predecessor plus the exact installed write-ahead receipt returns an `IO_ERROR` using `authority.context.attempt`, but the next invocation can resume it after any required lock repair and refreshed CAS without preparation. Unchanged predecessor without the receipt returns the original `IO_ERROR`; another canonical state returns `RECONCILIATION_REQUIRED` using the planned state digest and observed canonical state digest; unreadable state uses `STATE_INVALID {issue_code: "transaction-outcome-ambiguous"}` only when the previously decoded phase instance is available, otherwise `CONTRACT_INVALID`. Release diagnostics after an authenticated commit do not turn success into failure.

`AtomicReplaceError.target_may_have_changed` becomes true only after the link/rename commit point may have run; collision is true only for `EEXIST`. `TaskLockError.stage` distinguishes acquire/release. One policy constant fixes lock directory name, poll interval, and deadline. There is no compromise/stale callback because no takeover occurs. Out-of-band removal is unsupported filesystem tampering.

Runtime failures never serialize raw paths, causes, or package messages. Fixed `IO_ERROR.operation` values are `task-lock-acquire`, `task-lock-release`, `task-config-read`, `input-fingerprint-read`, `intent-receipt-read`, `intent-receipt-create`, and `task-state-replace`, always with `authority.context.attempt`. Missing/unreadable config uses `task-config-read`; structurally invalid config is `CONFIG_INVALID {issue_code: "task-config-invalid"}`; a valid different digest is `PINNED_CONFIG_MISMATCH`. A proven receipt-create collision re-enters the truth table, and exact `ProjectResult` failures from canonical fingerprint readers propagate unchanged.

`INTENT_NOT_CURRENT` is owned by `intent`, non-retryable, and has next action `inspect-current-state`. Parameters are exactly `{intent_id, receipt_revision, current_revision}` using `pathSafeId` and safe integers; it carries no receipt bytes or path.

## Decisions

1. State is the sole commit authority; an installed receipt is resumable preparation, never success by itself.
2. Receipt creation is temp + `fs.link` + unlink. Rename and direct `open("wx")` at the final target are prohibited.
3. Core `mkdir` locking replaces `proper-lockfile`; abandoned locks require explicit repair and are never age-broken.
4. One state-layer authority carries task identity and full resolved-path objects. The kernel derives the intent path from the authenticated call.
5. The shipped `bindParsedToolCallRequest`/`RequestIdentifiedToolCall` seam is reused; no parallel request brand exists.
6. Receipts contain successful outcomes only and remain for task lifetime; mutable projections remain Phase 11 work.

## Durable Semantic Ranks and Issue Codes

`DurableSemanticSubject` gains a discriminated intent relation rather than two ambiguous optional slots:

```ts
export type DurableIntentRelation =
  | Readonly<{
      mode: "prepared";
      predecessor: CanonicalDocument<TaskStateV1>;
      receipt: CanonicalDocument<IntentReceiptV1>;
    }>
  | Readonly<{
      mode: "committed";
      state: CanonicalDocument<TaskStateV1>;
      receipt: CanonicalDocument<IntentReceiptV1>;
    }>;

export function createPreparedIntentSubject(
  predecessor: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>,
): DurableSemanticSubject;

export function createCommittedIntentSubject(
  state: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>,
): DurableSemanticSubject;
```

The constructors set exactly one mode and reject structural lookalikes/missing slots. Existing subjects preserve their current precedence exactly. New checks are inserted as follows:

| Position | Checks | Reporting |
|----------|--------|-----------|
| rank 3 after existing self-digests | full receipt canonical digest when supplied with an asserted digest | `TASK_INVALID` using receipt `task_id` |
| rank 4b after existing carrier checks | receipt-local outcome/prepared-state digests and revision/prepared-state shape | `TASK_INVALID` using receipt `task_id` |
| rank 8a after existing input-fingerprint checks, before rank 9 | prepared mode: predecessor revision/identity/pins/adopted-checkpoint ↔ receipt prepared successor agreement | `STATE_INVALID` using decoded predecessor `phase_instance` |
| rank 8b after prepared-mode checks, before rank 9 | committed mode: final state equals prepared state plus only the derived committed binding; receipt/reference agreement | `STATE_INVALID` using decoded final state `phase_instance` |

Exact new `DURABLE_ISSUE_CODES` are:

- `intent-receipt-self-digest-mismatch`
- `intent-receipt-outcome-digest-mismatch`
- `intent-receipt-prepared-state-digest-mismatch`
- `intent-receipt-revision-not-successor`
- `intent-receipt-future-revision`
- `intent-receipt-prepared-state-revision-mismatch`
- `intent-receipt-prepared-state-committed-intent-present`
- `intent-receipt-task-mismatch`
- `intent-receipt-repository-mismatch`
- `intent-receipt-initialization-mismatch`
- `intent-receipt-config-mismatch`
- `intent-receipt-workflow-mismatch`
- `intent-receipt-constitution-mismatch`
- `intent-receipt-policy-base-mismatch`
- `intent-receipt-adopted-checkpoint-mismatch`
- `intent-receipt-intent-mismatch`
- `intent-receipt-request-mismatch`
- `intent-receipt-input-fingerprint-mismatch`
- `intent-receipt-reference-digest-mismatch`
- `intent-receipt-reference-outcome-mismatch`
- `intent-receipt-reference-revision-mismatch`
- `intent-receipt-reference-result-mismatch`
- `intent-receipt-final-state-mismatch`

Fixed kernel-boundary issue codes (not members of `DURABLE_ISSUE_CODES`) are `task-state-missing`, `task-state-unreadable`, `task-state-noncanonical`, `intent-receipt-missing`, `intent-receipt-noncanonical`, `intent-receipt-tool-mismatch`, `intent-receipt-operation-mismatch`, `task-config-invalid`, and `transaction-outcome-ambiguous`. Parser `TypeError`s are caught and projected at the applicable read boundary. Receipt-local checks are constructible from receipt `task_id`; both relation modes run only after their state is decoded. Prepared-mode tests mutate `task_id`, repository/initialization/config/workflow/constitution/policy digests, `policy_base_commit`, and `adopted_checkpoint` independently. Committed-mode tests prove exact deep equality to `prepared_state` plus only the derived `committed_intent`.

## Non-Goals and Deferred Ownership

- Phase 9's mature-state kernel intentionally rejects absent state. Phase 10 owns a separate revision-0 initialization entry point that shares Phase 9's authority, lock, exclusive-receipt, atomic-state, and semantic primitives but does not call `runStateTransaction`; it also owns legal workflow transitions, manual-chain adoption, bounded current-intent reconciliation, and explicit repair for abandoned locks or foreign/superseded receipts. A `SIGKILL` receipt-only crash resumes only after that explicit lock repair; tests may simulate the approved repair by removing the exact verified test lock directory.
- Phase 11 owns payload/result manifests, mutable projection replacement, snapshot restoration, retention accounting beyond the 1 MiB receipt cap, and cross-class output path verification.
- Phase 15 owns MCP wiring and long-running dispatch outside the locked kernel.
- Phase 17 owns truthful status that can expose the recorded receipt-only limitation; until then state-only status reports the prior committed revision.
- This phase does not promise hostile-filesystem TOCTOU resistance, cross-clone/distributed locking, newest-rename power-loss durability, receipt pruning, or automatic abandoned-lock recovery.
- The mature Phase 9 kernel preserves `adopted_checkpoint` exactly. Phase 10 may add a separate adoption planner/seam that deliberately changes it; it may not silently weaken this kernel's preservation invariant.

## Work Breakdown

1. **Parent contract and dependency admission**: Record the Phase 7/REQ-14 architecture amendments; admit only `write-file-atomic@8.0.0`, its lock-resolved permissive transitive graph (currently `signal-exit@4`), the Node-24 engine range, a reviewed local v8 declaration, exact notices, and upgrade policy. Keep `proper-lockfile` prohibited.
2. **Receipt and committed-state contracts**: Add the strict success-only receipt with full prepared state and replace the weak state intent reference with the exact committed binding. Extend registration, agreement fixtures, error vocabulary, and pinned semantic ranks/issue codes.
3. **Closed request identity**: Replace open `operation_fields` with exhaustive selectors, reuse `bindParsedToolCallRequest`, and mint one task/path authority in `src/state/`. Pin operation literals, field lists, golden digests, derived intent paths, direct call-owned CAS, and fingerprint precedence.
4. **Atomic create/replace adapter**: Implement temp-write/fsync/close + core link + unlink for exclusive receipt install and `write-file-atomic` replacement for state. Unit faults use injected fakes; real crash cut points are env-gated child-only hooks excluded from `dist/`.
5. **Task lock adapter**: Implement the fixed core `mkdir` lock with bounded polling, no stale/owner takeover, non-reentrancy, and explicit abandoned-lock blocking. Prove same-task contention and independent-task concurrency without distributed claims.
6. **Layout, canonical readers, and constructible errors**: Derive the intent path from the authenticated call; safely materialize/check `intents/`; canonically read state/config/receipt; and map initial missing/corrupt state to constructible `CONTRACT_INVALID` results.
7. **Pure planning and resumable classification**: Compose CAS, authority/call authenticity, the complete current/orphan/not-current/mismatch truth table, live config and fingerprint checks, expectation/result revision correlation, and validate-once prepared-state construction before any write.
8. **State-last execution and ambiguity arbitration**: Install the validated write-ahead receipt without overwrite, resume matching orphans without preparation, replace state last, reread authority, and classify post-commit ambiguity from durable facts.
9. **Crash and multi-process proof**: Exercise receipt-temp/link/state-replace cut points with `SIGKILL`, plan mutation attacks, same-task races, independent tasks, path/layout attacks, original-CAS conflict versus refreshed-CAS replay, and restart arbitration.

## Success Criteria

- [ ] Current state authenticates the exact immutable receipt and outcome returned by replay; an unreferenced receipt, altered receipt/outcome, deterministic-path substitution, or post-state mismatch never succeeds.
- [ ] Request digests are built by exhaustive per-tool selectors and bound through the shipped authentic-call WeakMap; structural lookalikes, another call, caller-selected identity/fingerprint digests, transport, CAS, retry, timestamp, cancellation, and caller-asserted fingerprint fields cannot enter through alternate names or spreading.
- [ ] CAS runs on every invocation before intent handling. Changed reuse returns `INTENT_MISMATCH`, stale writers return `STATE_CONFLICT`, one of two same-task processes wins, and independent tasks do not contend.
- [ ] The kernel reads live resolved `config.yaml` under the lock and checks it against the state pin before preparation; callers cannot substitute saved bytes, and any drift returns `PINNED_CONFIG_MISMATCH` without content or write side effects.
- [ ] Phase 9 uses temp+link no-clobber creation for one immutable receipt and overwrite-style replacement only for state, exactly once and last. A matching receipt-only crash resumes by writing state without preparation; other faults leave prior/next canonical state or a precise non-advancing error.
- [ ] Lock acquisition/release and atomic replacement errors fail explicitly until commitment; ambiguous post-state-replace/release outcomes reread authority and return success iff state authenticates the receipt. A live or abandoned lock is never broken automatically. Tests claim same-filesystem coordination and no-torn replacement only, not cross-clone exclusion or newest-rename power-loss durability.
- [ ] Exact old-intent reuse after a later commit returns `INTENT_NOT_CURRENT` with inspection guidance, changed reuse returns `INTENT_MISMATCH`, immutable receipts are never overwritten, and missing/corrupt current receipts never replay.
- [ ] Focused typecheck, contract, unit, race, crash, dependency, and notice verification passes on the supported Node floor/current patch. The inherited three release-integrity failures remain separately identified unless independently resolved.

## Verification Steps

1. Run `npm ci`, then `npm run check:dependencies`, `npm run check:notices`, and `npm run test:notices-policy`; verify the exact lock admits only the reviewed permissive graph and still rejects later-phase dependencies.
2. Run `npm run typecheck` and the focused receipt/schema/error/fingerprint tests. Mutate every duplicated state/receipt field, result ID, embedded outcome, and receipt bytes independently; each mutation must fail at its pinned semantic rank. Golden request digests must change only for the exact per-tool semantic fields in the table.
3. Run the atomic and crash suites with fake failures plus real env-gated children killed at receipt-temp, receipt-link, state-replace-before, and state-replace-after cut points. Use `SIGKILL` for abandoned-lock and receipt-only crash cases. Restart must resume only an exact write-ahead receipt and treat only state-authenticated authority as committed.
4. Run lock/race suites in separate Node processes against one task and two independent tasks. Pin one winner plus `STATE_CONFLICT`, long event-loop stalls without takeover, `SIGKILL`-abandoned-lock repair blocking, acquire/release behavior, non-reentrancy, and no cross-task serialization.
5. Exercise exact replay with refreshed `expected_revision`, the same byte-identical delivery with original CAS returning `STATE_CONFLICT`, resumable orphan, exact not-current intent, changed reuse, caller-fingerprint mismatch, safe-integer overflow, forged/mispaired calls or authority, receipt substitution, live config drift, expectation revision N+5, accessor/non-enumerable plans, and concurrent mutation. Verify pinned precedence and no success side effects.
6. Exercise first-use `intents/` creation plus absolute, traversal, sibling-task, symlink, non-directory, duplicate, state-target, and receipt-overwrite attacks. Only the derived resolved intent target may be created or written.
7. Run `npm run test:unit`, `npm run test:contracts`, `npm run test:mcp-runtime`, and `npm run build:temp`. Run `npm test` to confirm all Phase 9-owned tests pass and record separately whether the same three inherited `release-offline` assertions remain the only failures.

---
*Designed: 2026-07-29*
