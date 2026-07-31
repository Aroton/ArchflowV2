# Durable State and Contracts Subsystem

**Date:** 2026-07-31
**Commit:** fccf3fb

Covers `src/contracts/` (41 files), `src/state/` (22 files), `src/review/` (4 files) — the dominant
subsystem of this repo, ~14.5k lines. Repo-wide map, entry points, and build system live in
`architecture.md`; this document is internals, invariants, and data shapes only.

---

## 1. Layering, in one picture

```
src/contracts/**   pure format + semantics. NO filesystem, NO git, NO process.
      ▲                  MUST NOT import src/repository/**  (enforced: test/contracts/repository-boundary.test.ts:27-39)
      │
src/state/**       durable I/O kernel: locks, atomic writes, transactions, gates, snapshots.
      ▲
src/review/**      evidence services: counter-review, adjudication, fixed-point decision.
      ▲
src/mcp, src/dispatch, src/repository   (outside this document)
```

Two directions of authority:

- **Downward:** `state/` and `review/` call `contracts/` for every parse, digest, and semantic check.
  They never re-implement a rule.
- **Never upward:** a contract module cannot observe a byte on disk. Every "is this actually true"
  check that needs the filesystem or git lives in `state/`.

### Universal conventions

| Convention | Where | Rule |
|---|---|---|
| Contract parse functions **throw** | all `parse*` in `contracts/` | `TypeError` / `ZodError` / `ContractValidationError` |
| State/kernel functions **return** | all of `state/`, `review/` | `ProjectResult<T>` (`errors.ts:82`) — never throw for a *semantic* disagreement |
| A thrown error from a kernel path | everywhere | means a **defect in server code**, not bad agent data |
| Errors are registry-constructed | `errors.ts:61-75` | `createProjectError(code, params)`; params are `.strict()` Zod per code |
| Every persisted type is a `type` alias | all `durable-*.ts` | an `interface` anywhere in the graph breaks `CanonicalDocument<T extends PlainJsonValue>` with TS2344 |
| Freeze + brand for authority | `WeakSet`/`WeakMap` + `unique symbol` | see §9 |

---

## 2. Canonical JSON is the root of everything

`src/contracts/canonical.ts`

```ts
export interface CanonicalDocument<T extends PlainJsonValue> {
  readonly bytes: Uint8Array;   // ordinal-sorted keys, 2-space indent, exactly one trailing \n, UTF-8
  readonly value: T;
  readonly digest: Sha256Digest; // sha256 over `bytes`
}
```

- `canonicalJsonBytes` (`canonical.ts:66`) sorts **object keys** ordinally but **preserves array
  order** — array order is semantic. Rejects `undefined` and non-finite numbers rather than emitting
  `null`.
- **Every array that is logically a *set* must therefore declare and enforce its own sort**, or two
  callers hashing identical logical content get different digests. Sort rules are spelled per field
  as `SET — sorted by <key>` in the durable type comments, and enforced by exactly one predicate
  (`isSortedUniqueBy` + `tupleKey`, `validators.ts:93,109`) shared by the Zod mirror and the Ajv
  keyword, so the two authorities cannot drift.
- `parseCanonicalDocument` (`canonical.ts:119`) is the **byte authority**: fatal UTF-8 decode →
  `JSON.parse` → `assertPlainJson` → re-render and **byte-compare**. Any non-canonical form (permuted
  keys, wrong indent, missing/extra trailing newline, duplicate keys) is rejected. Anything read from
  disk that must be trusted goes through this.
- Domain-separated digests exist so unrelated subjects can never collide. Each wraps its subject with
  `{schema_version, digest_kind, …}`:

| digest_kind | Function | File |
|---|---|---|
| `open-gate-frozen-state` | `openGateFrozenStateDigest` | `durable.ts:97` |
| `declared-output-snapshot` | `deriveSnapshotDigest` | `implementation-manifest.ts:106` |
| `implementation-diff` | `deriveImplementationDiffDigest` | `implementation-manifest.ts:114` |
| `declared-index-identity` / `declared-worktree-identity` | `implementation-manifest.ts:140,152` |
| `projection-generation` | `projectionGenerationDigest` | `snapshots.ts:479` |
| `gate-identity` | `computeGateId` → `g-<sha256>` | `fingerprints.ts:306` |
| `gate-context` / `waiver-context` | `computeGateContextDigest` | `fingerprints.ts:321` |
| `pinned-constitution` | `computePinnedConstitutionDigest` | `fingerprints.ts:193` |
| `maintenance-reachability` | `computeMaintenanceProof` | `maintenance.ts:120` |
| `policy-base-commit` | `invalidPolicyBase` | `state/constitution.ts:109` |
| `history-identity` / `repository-candidate` | `canonical.ts:90,94` |

Untagged whole-value digests (deliberately, so they compare against a stored self-digest):
`canonicalJsonDigest(receipt)` (`durable-intent.ts:37`), `checkpointSelfDigest`
(`durable-checkpoint.ts:349`), `intentOutcomeDigest`.

---

## 3. Input discipline: validate-and-materialize once

`src/contracts/plain-json.ts` + the `ownDataSlot`/`materialize` idiom.

`assertPlainJson` (`plain-json.ts:99`) rejects, recursively: accessor properties, **non-enumerable
data properties** (`:85`), symbol keys, non-plain prototypes, cycles, sparse arrays, non-finite
numbers, `__proto__`/`prototype`/`constructor` keys (`:7`), and values that **mutate while being
inspected** (`assertDescriptorStable`, `:24`).

The rule enforced across the whole subsystem (`durable.ts:252-268`, `fingerprints.ts:131`,
`snapshots.ts:108`, `transaction.ts:255-266`, `maintenance.ts:54`, `reconciliation.ts:58`):

> **Validate a caller-owned object once, then `structuredClone` it, and inspect only the clone.**

Why it is load-bearing, not stylistic: an enumerable getter can return one value to a validation
pass and a different value to a hashing pass. That is how an excluded field once reached a request
digest that was supposed to reject it.

The paired shell check (`ownDataField`, `durable.ts:228`) requires **both** `"value" in descriptor`
**and** `descriptor.enumerable`:

- rejecting accessors prevents split observation;
- rejecting non-enumerable *data* properties (stable under repeated reads, so the accessor check does
  not cover them) prevents a field invisible to `JSON.stringify`/`canonicalJsonBytes` — and therefore
  to any digest — from being treated as present.

A shell check that omits `enumerable` is weaker than `assertPlainJson` applied to its own contents.

---

## 4. What is persisted, and where

All durable state lives under the worktree at `.archflow/tasks/<task-id>/`. Path templates are the
single authority in `src/repository/paths.ts:130-163` (task frame) and `:183-189` (repository frame);
17 `PathClass` values are declared in `path-claims.ts:103-115`.

| Class | On-disk template (task-relative) | Mutability | Root type | Shape authority |
|---|---|---|---|---|
| `task-state` | `state.json` | **replaced** | `TaskStateV1` | `task-state.schema.json` only (no Zod — deliberate) |
| `intent` | `intents/<intent-id>.json` | **immutable, create-exclusive** | `IntentReceiptV1` | `intent-receipt.schema.json` only |
| `result-manifest` | `results/sha256/<result-digest>/manifest.json` | **immutable** | `ResultManifestV1` | `result-manifest.schema.json` only |
| `result-payload` | `results/sha256/<result-digest>/payload/<output-path>` | **immutable** | raw bytes | — |
| `decision` | `decisions/<gate-id>/request.json`, `.../decision.json` | **immutable** | `GateRequestV1`, `GateDecisionRecordV1` | JSON Schema (+ Zod mirror for the record) |
| `gate-interface` | `gate.json`, `gate.decision` | **replaced / deleted** | `ActiveGateV1`, human-authored decision | `active-gate.schema.json` |
| `maintenance-record` | `maintenance/<id>.json` | **immutable** | `MaintenanceRecordV1` | JSON Schema only |
| `manual-checkpoint` | `manual/checkpoints/<revision>-<digest>.json` | caller-owned | `ManualCheckpointV1` | Zod (agent-supplied) |
| `document` | `prd.md`, `design.md`, `phases/<n>/{design,impl-notes}.md` | projected | — | — |
| `review` | `reviews/<phase>.{self,counter,triage,adjudication}.md`, `reviews/<phase>.gate-counter.<gate-id>.md` | projected | — | — |
| `attempt`, `import` | `attempts/…`, `imports/<digest>/…` | — | — | — |
| `task-config` | `config.yaml` | read-only pin | YAML | `config.ts` |

Repository frame: `.archflow/workflow.yaml` (`shared-workflow`), `.archflow/constitution/NN-*.md`
(`shared-constitution` **and** `task-branch-constitution` — same template, distinguished by
*operation*, narrowed by the caller's `expectedClass`, `paths.ts:176-182`), everything else outside
`.archflow/` is `repository-source`.

`.transaction-lock` (a directory) and `intents/`, `decisions/<gate>/`, `results/sha256/<d>/payload/`
are created and verified by `state/layout.ts` with `O_NOFOLLOW | O_DIRECTORY` plus an `lstat`
symlink check before use.

### Two-authority rule for shapes

| Situation | Authorities |
|---|---|
| Agent supplies it over MCP (`archflow_state.artifact`, gate inputs) | normative JSON Schema **and** a Zod mirror, proven equivalent by `assertZodAgreement` (`validators.ts:380`) |
| Purely server-internal (`TaskStateV1`, `IntentReceiptV1`, `ResultManifestV1`, `MaintenanceRecordV1`) | **JSON Schema only.** Do not add a mirror — success criteria grep for one (`durable-state.ts:11-17`, `durable-maintenance.ts:7-10`) |

`assertZodAgreement` fails if the two disagree on accept/reject, if either mutated the input, or if
Zod *transformed* the value. Mirrors must be mirrors, never a second model.

---

## 5. `TaskStateV1` — the durable state of truth

`src/contracts/durable-state.ts:124-163`

```ts
type TaskStateV1 = {
  schema_version: "1"; task_id: TaskSlug; repository_identity_digest: Sha256Digest;
  revision: SafeInteger;            // >= 1, strictly monotonic
  phase_instance: PhaseInstanceId;  // prd | design | phase-design-<n> | phase-impl-<n>
  step: PipelineStep;               // produce | self_review | counter_review | triage | adjudicate
  status: "running" | "succeeded" | "failed";
  attempt: SafeInteger;             // >= 1
  input_fingerprint: Sha256Digest;  // the IN-FLIGHT step's, not a completed one's
  initialization_digest; config_digest; workflow_digest; constitution_digest; policy_base_commit;
  authoritative_results: AuthoritativeResultRef[];  // SET sorted by (phase_instance, step)
  approvals: ApprovalRef[];                          // SET sorted by gate_id
  waivers: WaiverRef[];                              // SET sorted by gate_id
  open_gate?: OpenGateRef;          // AT MOST ONE — a concurrent gate is unrepresentable
  committed_intent?: CommittedIntentRef;
  adopted_checkpoint?: AdoptedCheckpointRef;
  terminal?: "complete" | "abandoned";
};
```

Non-obvious invariants:

- **The five pinned-input fields are deliberately duplicated** from the initialization document
  (`repository_identity_digest`, `config_digest`, `workflow_digest`, `constitution_digest`,
  `policy_base_commit`). `archflow-status` reads `state.json` alone. What keeps them honest is not
  deduplication but **field-by-field comparison** in `validateDurableSemantics` rank 7
  (`durable.ts:911-932`). Do not "normalize" this away.
- **There is deliberately no recorded blocking reason.** It is a *function* of `open_gate`,
  `terminal`, and attempt exhaustion; recording it would create a second source of truth
  (`durable-state.ts:118-122`).
- `input_fingerprint` is the *in-flight* step's. Per-result fingerprints live in
  `authoritative_results[*].input_fingerprint`. Confusing the two silently breaks the only
  pre-transition fingerprint guard.
- Digest-shaped reference fields (`result_digest`, `gate_id`, `decision_digest`, …) are **references,
  not authority**. `validateDurableSemantics` resolves none of them — its subject has no slot that
  could carry the target. Resolution belongs to whoever materializes the target.
- `open_gate.frozen_state_digest` = `openGateFrozenStateDigest(state)`, which hashes the state
  **excluding `open_gate`** to avoid a digest cycle (`durable.ts:97`). `stateWithOpen`
  (`gates.ts:191`) also strips `committed_intent` before computing it.

---

## 6. `validateDurableSemantics` — the single semantic authority

`src/contracts/durable.ts:374` (the file's whole 1055 lines are essentially this one function).

**Exactly two exits, and only two:**

| Exit | Meaning |
|---|---|
| `return ProjectResult{ok:false}` | semantic disagreement, one of 5 pinned error codes |
| `throw TypeError` | **input-discipline violation** — a defect in the calling server code |

Structural failure never arrives here: the caller has already validated against the normative JSON
Schema or Zod mirror. The only two structural residues are ranks 2 and 4 (phase-instance
decodability), because the JSON `pattern` is weaker than `decodePhaseInstance`
(`phase-instance.ts:39`, which rejects phase numbers past `MAX_SAFE_INTEGER`).

**The subject is a bag of independent slots** (`durable.ts:56-76`):

```ts
type DurableSemanticSubject = {
  state?; artifact?; maintenance?; result_manifest?; gate_request?; gate_decision?;
  intent_relation?: { mode: "prepared"; predecessor; receipt } | { mode: "committed"; state; receipt };
};
```

Build the intent relation only through `createPreparedIntentSubject` / `createCommittedIntentSubject`
(`durable.ts:78,87`).

**Evaluation order is normative, not incidental.** `ProjectResult` carries exactly one error, so the
reported error is the minimum under *(rank, sub-rank, slot, collection path, index)*, and the clauses
are written in that order. Rank summary:

| Rank | What it checks | Lines |
|---|---|---|
| 1 | input discipline (own enumerable data slots, materialize) | 375-430 |
| 2 | `state.phase_instance` **carriability** — must precede everything that reports `STATE_INVALID`, whose param runs the decoder under `.strict()` | 440-448 |
| 3 | self-digest agreement per document; gate request↔decision binding; envelope binding; waiver origin binding | 450-501 |
| 4a/4b | remaining phase-instance decodability; implementation-output ⇒ `phase-impl`; result-manifest ↔ source artifact correlation; receipt-local arithmetic | 503-695 |
| 5 | manual-checkpoint import chain (see §11) | 697-818 |
| 5a/5b/6 | rename `previous_path !== path`; `restore_targets ⊆ outputs[].path`; accounting sums + 1:1 output↔entry correspondence | 820-891 |
| 7 | state ↔ artifact ↔ maintenance agreement, incl. the five duplicated pins | 899-932 |
| 8 | in-flight `INPUT_FINGERPRINT_MISMATCH` (guarded on `(phase_instance, step)` equality — the guard is a **correctness condition, not an optimization**) | 944-954 |
| 8a/8b | prepared-intent successorship; committed state = prepared state **plus only** the kernel-derived `committed_intent` | 957-1040 |
| 9 | maintenance arithmetic and position vs. state revision | 1043-1052 |

`DURABLE_ISSUE_CODES` (`durable.ts:109-197`) names every emittable `issue_code` so the rejection
corpus (`test/contracts/durable-semantics-corpus.test.ts`) asserts against the same literals the
validator constructs. `INPUT_FINGERPRINT_MISMATCH` is deliberately absent — its params are exactly
the two digests under `.strict()`, so it carries no `issue_code` and `createProjectError` throws if
given one.

Two deliberate non-goals, so nothing re-implements them:

- **No template-based path classification.** The class↔template tables are in `src/repository/paths.ts`,
  which `contracts/**` may never import. A cross-class rename is *representable* here and not rejected.
- **`payload_bytes`, `payload_digest`, `after.oid` are assertions here, never verified facts.** Nothing
  in this module sees a byte. `CanonicalDocument.bytes` is never inspected. Byte/Git verification is
  `state/implementation-manifest.ts` and `state/snapshots.ts`.

---

## 7. Validation layer

`src/contracts/validators.ts`

`createJsonSchemaValidator` (`:215`) builds an Ajv 2020 instance with `strict: true`,
`allowUnionTypes: false`, `coerceTypes: false`, `removeAdditional: false`, `useDefaults: false`, and
these custom keywords:

| Keyword | Predicate | Note |
|---|---|---|
| `x-archflow-unique-by` | `hasUniqueObjectPropertyValues` (`:52`) | reads via descriptors, so an accessor yields `undefined` rather than firing a getter |
| `x-archflow-sorted-unique` / `-by` | `isSortedUniqueBy` (`:93`) + `tupleKey` (`:109`) | **same exported functions the Zod mirrors call** |
| `x-archflow-max-utf8-bytes` | byte-length bound | |
| `x-archflow-nfc` | NFC normalization — **not expressible as a `pattern`**, so without it Ajv would accept NFD where Zod rejects, failing `assertZodAgreement` | |
| `x-archflow-review-summary`, `-adjudication-semantics`, `-gate-semantics`, `-supplemental-semantics`, `-mcp-semantics`, `-result-expectation-semantics` | cross-field folds mirroring the Zod `superRefine`s | |
| `x-archflow-effect` | annotation only (`valid: true`) | |

`tupleKey` joins components with `U+0000`, which is injective because every ID primitive and
`path-claim.schema.json` reject `U+0000`–`U+001F`. The `":"`-joined `ruleKey` is deliberately **not**
reused for ordering — `SafeId` admits `":"` and can collide across a component boundary.

Compiled normative validators exported: `intentReceiptV1Validator`, `handoffRecordV1Validator`,
`resultManifestV1Validator`, `gateRequestV1Validator`, `gateDecisionRecordV1Validator`,
`activeGateV1Validator` (`:323-365`). `state/read.ts:49` compiles its own for `TaskStateV1`.

Primitive vocabulary (`evidence.ts:55-61`), all branded strings:
`Sha256Digest` `^[0-9a-f]{64}$` · `SafeId` `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` · `PathSafeId` (same
minus `:`) · `TaskSlug` (lowercase, ≤64) · `SafeCode` `[a-z0-9][a-z0-9_-]{0,63}` · `SafeVersion` ·
`SafeInteger` (**admits 0** — every "revision" field pins its own `.min(1)`, called D8 in comments).
`PathSafeId`/`TaskSlug` additionally reject Windows reserved device names and trailing dot/space
(`evidence.ts:39-53`) because they are embedded as single path segments.

Errors: `errors.ts` is a closed registry of 55 project codes + 4 protocol codes, each with owner,
`retryable`, a `.strict()` parameter schema, and a `next_action`. `parseProjectError` (`:101`)
round-trips a serialized error through `constructError` and requires deep equality — a serialized
error cannot claim an owner/retryable/next_action that disagrees with the registry.

---

## 8. The transaction substrate and exact replay

`src/state/transaction.ts` — `runStateTransaction` (`:1016`).

### The durable protocol

Every mutating tool call carries a caller-chosen `intent_id`. The kernel commits at most once per
intent, via an **immutable receipt as the commit point**:

```
                        ┌─ task lock (mkdir .transaction-lock, 10ms poll / 250ms deadline) ─┐
1. read state.json  → parseCanonicalDocument + task-state schema + validateDurableSemantics
2. verifyRepositoryIdentity(state.repository_identity_digest, authority)
3. expected_revision === state.revision           else STATE_CONFLICT
4. read intents/<intent_id>.json
   ├─ EXISTS → handleExisting()  (§ replay, below)
   └─ ABSENT →
5. liveIdentification(): read config.yaml, compare to state.config_digest (PINNED_CONFIG_MISMATCH),
      resolve_input_fingerprint → computeInputFingerprint → must equal call.input.input_fingerprint
      → identifyTransactionRequest → request_digest
6. caller's prepare(current, call) → PreparedTransaction { expectation, result, next_state }
7. buildPlan(): correlateProjectResult, assertPreserved, validateResultInstallationBinding,
      build IntentReceiptV1 (<= 1 MiB), committedState(receipt), validate prepared + committed
8. installResultFacts()  — payloads then manifest (createExclusive), then projections
9. atomic.createExclusive(intents/<id>.json, receipt.bytes)     ← THE COMMIT POINT
10. atomic.replace(state.json, final.bytes)                      ← publication
11. re-read state.json, re-validate committed subject
                        └──────────────── lock released ─────────────────┘
```

**Ordering is the crash-recovery contract.** Immutable result bytes are installed before the receipt;
the receipt is created before state is replaced. So every crash cut leaves either the prior state or
a completely reconstructible successor.

### Atomicity primitives — `src/state/atomic.ts`

- `createExclusive` (`:57`): write to `.<name>.<pid>.<uuid>.tmp` → `fsync` → `link()` to target.
  `EEXIST` ⇒ `"exists"`. **Only immutable classes are accepted**: `intent`, `maintenance-record`,
  `result-manifest`, `result-payload`, `decision` (`:58-64`).
- `replace` (`:104`): `write-file-atomic`; **only** `task-state` and `gate-interface` (`:105`).
- `removeGateInterface`: only `gate-interface`.
- `ProjectionWriter` (`:141-188`): only the 7 `PROJECTABLE` classes.

`AtomicReplaceError.target_may_have_changed` is the signal that decides whether a failure can be
reported as plain `IO_ERROR` or must go through arbitration.

### Replay — `handleExisting` (`transaction.ts:905`)

Given an existing receipt, the kernel classifies without re-running preparation:

| Condition | Outcome |
|---|---|
| `state.committed_intent.intent_id === intent_id` | `authenticateCommitted` → validate committed subject, re-derive `request_digest` from the receipt, rebuild the tool success from `receipt.outcome`, return `replayed: true` |
| `receipt.prior_revision > state.revision` | `TASK_INVALID intent-receipt-future-revision` |
| `receipt.resulting_revision <= state.revision` | `INTENT_NOT_CURRENT` |
| otherwise (immediate successor) | re-drive `installPlan` with `receiptAlreadyExists: true` — re-installs retained result bytes via `load_retained_result`, then replaces state |

Any receipt whose `request_digest` differs from the freshly recomputed one ⇒ `INTENT_MISMATCH`.
**The same `intent_id` with different inputs is always a mismatch, never a silent overwrite.**

### Arbitration — `arbitrate` (`transaction.ts:704`)

When a write fails ambiguously or the lock release fails, the kernel re-reads `state.json` and:

- digest === planned final ⇒ the write actually landed; verify receipt and return `replayed: false`;
- digest === predecessor ⇒ nothing landed ⇒ `IO_ERROR` for the named operation;
- neither ⇒ `RECONCILIATION_REQUIRED{recorded_digest, observed_digest}`;
- state missing/noncanonical ⇒ `transaction-outcome-ambiguous`.

### `assertPreserved` (`transaction.ts:272`)

A `prepare` callback may **never** change identity/pins (`task_id`, repository identity,
initialization, config, workflow, constitution, policy base) — that throws. It may only change
`adopted_checkpoint`/`open_gate`/`approvals`/`waivers` if the prepared object is an authentic
checkpoint-adoption plan (`assertInternalCheckpointAdoptionPlan`, `checkpoints.ts:43`, which
re-derives the plan's `next_state` digest from a `WeakMap`). `NextStateDraft` structurally forbids
carrying `revision` or `committed_intent` (`transaction.ts:83`, `materializeDraft` `:260`).

### Revision 0 — `src/state/initialization.ts:419`

`runStateInitialization` is the **only** state-absent transaction. It commits revision 1 exactly
once, validates `canonical_paths` against the authenticated task root (`:76-89`), and resolves every
declared commit with `rev-parse --verify --quiet <oid>^{commit}`. `planStateTransition` explicitly
refuses initialization artifacts (`transitions.ts:123-126`) so revision 1 can only be minted here.

### Crash coverage

`test/crash/` drives real `SIGKILL` at enumerated cuts:
`state-transaction.test.ts` (manifest cut, receipt temp-sync, receipt link, before/after state
replace, abandoned lock), `state-initialization.test.ts`, `state-checkpoint-adoption.test.ts`,
`state-gate-lifecycle-phase12.test.ts` (open cuts, resolve cuts, concurrent processes).

### Lock — `src/state/lock.ts`

`mkdir` of `<task_root>/.transaction-lock` is the mutex; `AsyncLocalStorage` rejects re-entrant
acquisition of the same root (`:174`). An abandoned lock is **never** reclaimed automatically:
`inspectAbandonedTaskLock` pins device/inode/birthtime/ctime and holds an open FD, and
`removeConfirmedAbandonedTaskLock` requires an explicit `humanConfirmedNoLiveWriter` boolean and
re-verifies identity through a quarantine rename before `rmdir` (`:103-151`).

---

## 9. Authority brands (how "you can't fake this" is implemented)

The pattern throughout: a module-private `WeakSet`/`WeakMap` plus a non-enumerable `unique symbol`
property, an internal `create*`/`register*`, and an exported `assert*`/`authentic*`.

| Brand | Minted by | Asserted by |
|---|---|---|
| `TransactionAuthority` | `createInternalTransactionAuthority` (`state/authority.ts:47`) | `assertInternalTransactionAuthority` — also checks the runner/environment pair matches the registry |
| `ParsedToolCall` | `parseToolCall` (`mcp-tools.ts:110`) | `assertAuthenticParsedToolCall` (`:105`) |
| `ResultExpectation` / `StructurallyValidProjectResult` | `createInternalResultExpectation` / `validateProjectResultStructure` | `correlateProjectResult` (`:180`) |
| `InternalResultInstallation` | `prepareResultInstallation` (`transaction.ts:147`) | one-shot: consumed via `consumedResultInstallations` (`:526-529`) |
| `TransactionOutcome` | `outcomeResult` (`transaction.ts:294`) | `assertAuthenticTransactionOutcome` (`:168`) |
| `AuthenticatedGateApproval` | `loadAuthenticatedGateApproval` (`gates.ts:296`) | `assertAuthenticatedGateApproval` (`:72`) |
| `ResolvedConstitution` | `resolvePinnedConstitution` (`state/constitution.ts:122`) | `assertResolvedConstitution` (`:50`) |
| `CheckpointAdoptionPlan` | `planCheckpointAdoption` (`checkpoints.ts:69`) | `assertInternalCheckpointAdoptionPlan` (`:43`) |
| `ObservationCapability`, `AuthorityLink`, `VerifiedReferencedEvidence`, `QualifiedEvidence`, `CurrentReviewSet(Authority)`, `ValidatedTriage` | `contracts/internal/trust-brands.ts` | same file |
| `AbandonedTaskLockPlan` | `inspectAbandonedTaskLock` (`lock.ts:73`) | membership + FD identity |

---

## 10. Gates, waivers, and manual decisions

Format: `src/contracts/gates.ts` (197 dense lines) + `src/contracts/durable-gate.ts`.
Lifecycle: `src/state/gates.ts` (1218 lines).

### The gate contract table

`GateContractByKind` (`gates.ts:31-41`) pairs each of the 9 kinds with its **context** shape and its
**decision payload** union. `GATE_CONTRACTS` (`:118`) exposes the Zod pair per kind.

| Kind | Decisions | Effect (`gates.ts:114`) |
|---|---|---|
| `artifact-approval` | approve / revise / reject | advance / retry / non-advancing |
| `review-trigger` | approve / revise / reject / **waiver-requested** | … / redirect-waiver |
| `material-drift` | amend-upstream / revise-current / reject | redirect-upstream / retry / non-advancing |
| `adjudication-failure` | approve(+resolutions) / revise / reject / waiver-requested | |
| `attempts-exhausted` | retry-once / revise / abort | retry / retry / non-advancing |
| `constitution-edit` | revert-edit / start-base-amendment / abort | |
| `commit-authorization` | authorize-commit / revise / abort | advance / retry / non-advancing |
| `restore-collision` | discard-and-restore / **adopt-as-new-generation** / abort | advance / advance / non-advancing |
| `migration-audit` | accept-import-audit / revise / abort | |

`validateGateDecision` (`gates.ts:170`) adds the cross-field rules a schema cannot express:
a `waiver-requested` rule must be in `eligible_waiver_rules`; an `adjudication-failure` `approve`
must carry a **sorted exact set** of resolutions for every failed/uncertain rule that is *not*
waiver-eligible; a `restore-collision` `adopt-as-new-generation` must deep-equal the context's
`adoption_candidate`.

### State machine

```
no gate ──openDurableGate──▶ open_gate set (revision+1, frozen_state_digest)
                             + decisions/<gate-id>/request.json  (immutable, create-exclusive)
                             + gate.json (ActiveGateV1 projection, replaceable)
                                     │
                          human writes gate.decision (mutable interface)
                                     │
              ┌──────────────────────┴──────────────────────┐
              │                                              │
   non-advancing / retry                              earnsReceipt(record)
   resolveDurableGate (:914)                          resolveAdvancingGate (:1073)
   archive decision.json → replace state              archive → installReceipt → replace state
   → remove gate.json + gate.decision                 → remove gate.json + gate.decision
```

Key invariants:

- **`gate_id` is deterministic**: `computeGateId({task_identity_digest, intent_id, request_digest})`
  → `g-<sha256>` (`fingerprints.ts:306`). The same request re-derives the same gate, which is what
  makes crash recovery and idempotent re-open possible.
- **`decisions/<gate-id>/request.json` and `decision.json` are immutable** (`createExclusive`). A
  losing racer sees `"exists"` and must agree byte-for-byte, else `gate-request-collision` /
  `gate-resolution-race` / `gate-supersession-race`.
- **`gate.json` / `gate.decision` are disposable projections.** They can be lost or corrupted without
  stranding durable state: `openDurableGate` re-derives `gate.json` from the archived request
  (`gates.ts:586-591`). Conversely a human-authored `gate.decision` found before state names the gate
  is **preserved only if it binds this exact immutable request**, else removed (`:683-694`).
- **`ActiveGateV1.decision_template` must enumerate every decision shape the resolver accepts** —
  `["payload","human_provenance"]` for ordinary gates, `["granted","scope","origin","notes",
  "human_provenance"]` for waiver gates, plus `cancellation_fields` always
  (`durable-gate.ts:78-90`, built at `gates.ts:217-225`). Requiring a human to read server source to
  learn a valid decision shape defeats the interface's purpose.
- **Success receipts cannot be manufactured without an authenticated fingerprint.** `resolveDurableGate`
  refuses an advancing/granted record with `gate-success-requires-run-service` /
  `gate-success-receipt-resume-required` (`:957`, `:994`); only `runDurableGate` →
  `resolveAdvancingGate`, which carries `input_fingerprint`, may install one.
- **Waiting happens outside the lock.** `waitForGateInterface` (`gate-wait.ts:55`) polls at 500 ms and
  returns only a *signal*; the resolver re-reads under the lock. A markdown supplemental review is a
  wake-up signal only — the evidence is authenticated separately.

### Waivers

A waiver is itself a gate whose `context` is a `WaiverGateContext = { origin: WaiverOriginRef;
rationale }` (`durable-gate.ts:35`). Presence of `"origin" in context` is the discriminator used
everywhere (`waiverContext`, `gates.ts:230`).

- `authenticateWaiverOrigin` (`gates.ts:397`) re-reads the origin gate's request+decision from disk
  and requires the origin decision to be `decided` with payload `waiver-requested`, the same rule,
  the same scope, the same `current_evidence.set_digest`, and `decision.digest ===
  origin.origin_decision_digest`.
- `allowed_decisions` for a waiver gate is `["grant","deny","cancel"]` (`gates.ts:673`).
- A granted waiver appends a `WaiverRef` with `expires: "task-complete"` (`nextStateForRecord`,
  `gates.ts:714`). `waiverInForce` (`fixed-point.ts:365`) requires `granted`, the exact
  `rule_id`+`rule_version`, exact `subject_digest`, exact scope operation+boundary, and
  `state.terminal === undefined`.

### Gate-authorized re-entry

`enactsReentry` (`gates.ts:722`) — `review-trigger:revise`, `adjudication-failure:revise`,
`material-drift:revise-current`, `attempts-exhausted:{retry-once,revise}`. These do **not** append an
approval; they plan a transition back to `produce/running` with `attempt+1` and a freshly resolved
fingerprint (`planGateAuthorizedReentry`, `:747`). Preconditions: `exactOpenGateMatches` (including
`frozen_state_digest`), `status === "succeeded"`, `step ∈ {triage, adjudicate}`.
`validateCompletedReentry` (`:812`) replays this: at exactly `opened_at_revision + 1` the enacted
landing state and its re-derived fingerprint must agree; beyond that, the immutable archived record
plus the fact that state moved past its opened revision is the replay authority.

### Manual/offline gates

`createManualGateFile` (`gates.ts:1169`) is a no-clobber primitive for the offline helper.
`importGateDecisions` (`:1189`) derives checkpoint-ready `approvals`/`waivers` from complete,
request-bound manual pairs — and **throws if a live gate is open**.

### Supplemental review ledger

`SupplementalReviewOutcome` (`supplemental.ts:10-14`): `decline | ingest | triage-no-change |
supersede`. The ledger lives on `ActiveGateV1.supplemental` and is copied into the decision record;
a `supersede` entry is forbidden in the ledger itself (`durable-gate.ts:108-110`) and instead
archives an `outcome: "superseded"` decision record (`gates.ts:607-618`).
`currentSupplementalLedger` (`:444`) rebuilds the ledger from the projection and **re-authenticates
each non-decline entry** against live gate-counter-review evidence (`authenticSupplementalReview`,
`:472`) — a projection entry is never trusted on its own.

---

## 11. Manual checkpoint chain and import

`src/contracts/durable-checkpoint.ts`

A `ManualCheckpointV1` is a degraded-assurance snapshot of state (`assurance: "degraded"` is a
literal, `:246`) in three forms discriminated by revision and anchor (`superRefine`, `:269-288`):

| Form | `revision` | Required | Forbidden |
|---|---|---|---|
| `InitialManualCheckpointV1` | `1` | `initialization` (embedded, full document) | `predecessor`, `state_anchor` |
| `ContinuationManualCheckpointV1` | ≥2 | `predecessor: {revision, checkpoint_digest}` | `initialization`, `state_anchor` |
| `StateAnchoredManualCheckpointV1` | ≥2 | `state_anchor: {anchor_kind:"state", state_revision, state_digest}` | `initialization`, `predecessor` |

A `ManualCheckpointImportV1` wraps a chain with `import_mode: "initial" | "state-anchored" |
"continuation"`; each mode requires and forbids specific anchor fields (`:308-335`).

Chain rules are three small total functions, reused by both the validator and the selector:

- `checkpointSelfBreak` (`:411`) — a continuation's revision is exactly `predecessor.revision + 1`
  (or `state_anchor.state_revision + 1`).
- `checkpointLinkBreak` (`:424`) — **revision before digest**: gap first, then predecessor-digest
  mismatch.
- `chainHeadBreak` (`:437`) — head agrees with the wrapper's anchor.

`selectGreatestValidChain` (`:473`) picks the unique greatest linked chain from an unordered
candidate set and **stops** rather than guessing: `"fork"` (≥2 heads or ≥2 successors), `"gap"`
(an unconsumed candidate at or above the expected head revision), `"foreign-candidate"` (wrong task,
wrong repository, or a differing `initialization_digest`).

Ranks 5c–5t in `durable.ts:697-818` bind the whole thing: every checkpoint belongs to the wrapper's
task and repository, every checkpoint names the head's `initialization_digest`, `initial` mode
forbids a supplied state while the other two require one, and the supplied state must match the
independently expected revision + digest + repository, with `adopted_checkpoint` **absent** for
`state-anchored` (bootstrap) and **present and matching `predecessor`** for `continuation`.

Adoption: `planCheckpointAdoption` (`checkpoints.ts:69`) replays the entire chain through
`planStateTransition`, requires the selected chain to be *exactly* the supplied chain, requires the
call's `(phase_instance, step, status, input_fingerprint)` to equal the chain head, and produces a
successor naming `adopted_checkpoint = {head.revision, checkpointSelfDigest(head)}`. Initial-mode
adoption goes through `state/initialization.ts:114` instead (revision 0 → 1).

---

## 12. Snapshots, result manifests, and projections

`src/state/snapshots.ts` + `src/contracts/durable-result-manifest.ts`

```ts
type ResultManifestV1 = {
  task_id; repository_identity_digest; result_id; phase_instance; step;
  artifact_digest;                 // canonical digest of the (unwrapped) source artifact
  source_artifact: DocumentArtifactV1 | ImplementationOutputV1 | EvidenceArtifactV1;  // EMBEDDED
  input_fingerprint;
  snapshot_digest;                 // domain-separated DECLARED-OUTPUT snapshot, NOT the content address
  outputs: OutputEntry[]; projections: ProjectionDigestRef[];
  accounting: SnapshotAccountingV1; secret_scan: SecretScanResult;
};
```

- **Content address vs. snapshot digest.** The manifest's *content address* is
  `canonicalDocument(manifest).digest`, which names its directory
  `results/sha256/<result-digest>/`. `snapshot_digest` is a different, domain-tagged digest of the
  declared output scope, re-derivable by `deriveDeclaredSnapshotDigest(outputs, projections)`
  (`snapshots.ts:57`). Confusing them is the most likely bug in this area.
- The source artifact is **embedded**, so a later read re-establishes `artifact_digest` and every
  duplicated wrapper fact without request-lifetime memory.
- `OutputEntry` (`durable-primitives.ts:168-182`) is a **14-leaf flat union**, written out longhand:
  `{add,modify,rename,delete} × {git-object,raw-payload} × {regular,symlink}` minus uninhabitable
  combinations (`delete` is `git-object`-only and has no `after`). Two structural details:
  - the leaves are flat, not intersections, because an intersection is not guaranteed the implicit
    index signature that `CanonicalDocument` needs;
  - the Zod schema is a **nested** `discriminatedUnion` (operation → storage → file_type,
    `:247-263`) because flat options sharing a discriminator value, or a plain `z.union` inside a
    `discriminatedUnion`, throw at **parse** time under the pinned `zod@4.4.3` — a build that only
    constructs the schema looks fine.
  - `git-object ⇒ stored_bytes === 0` is structural (`SnapshotAccountingEntry`, `:305-307`), not a
    validator rule.
- **Byte caps are declared twice and must stay in sync**: `snapshots.ts:36-37` (25 MiB result /
  250 MiB task) and `durable-primitives.ts:310-312,318-319` (`26214400` / `262144000` as literal
  types). Exceeding either ⇒ `SNAPSHOT_LIMIT{limit_scope, offending_paths (sorted), current_bytes,
  byte_cap}`.

Lifecycle:

| Function | Line | Contract |
|---|---|---|
| `prepareSnapshot` | `:108` | validate+materialize once, re-derive `snapshot_digest`, verify every raw payload's length and sha256, preflight **both** caps, check declared accounting |
| `installSnapshot` | `:218` | payloads **first**, manifest **last**; existing identical bytes are *reused*, never clobbered; disagreeing bytes ⇒ `immutable-install-disagreement` |
| `readSnapshot` | `:237` | re-parse canonically, re-run `validateDurableSemantics`, re-derive snapshot digest, and for `git-object` outputs prove `base_commit` is an ancestor of HEAD and each blob's tree entry, size, and projected bytes |
| `resolveExistingSnapshot` | `:352` | reuse an existing result only when `(phase_instance, step, input_fingerprint)` all match |
| `restoreSnapshotOutput` | `:299` | reload one after-image from git or the retained payload |

### Projections

`ProjectionPlan` is the mutable-worktree side. `prepareProjectionPlan` (`:494`):

1. materializes each `ProjectionSource` field-by-field through descriptors;
2. **re-anchors `target.absolute` to the lexical worktree path** (`atLexicalLeaf`, `:102`;
   `resolvePath(worktreeRoot, repositoryRelative)`) — `ResolvedPath.absolute` is realpath-normalized
   for containment and therefore names a *symlink's referent*, which is wrong for mutation and leaf
   observation. Same fix in `implementation-manifest.ts:177`;
3. checks rename-pair consistency (source must go absent, destination must be currently absent);
4. runs the secret scanner over git-tracked present bytes — `detected` **or** `unavailable` ⇒
   `SECRET_DETECTED` (fail-closed, `:585-588`);
5. classifies each entry `exact | restore-ready | collision`.

`applyProjectionPlan` (`:632`) refuses if any collision exists, **re-observes every target twice**
(whole-set precheck, then per-entry immediately before writing), and on drift performs an ordered
`rollback` (`:654`) that re-verifies each applied after-image before undoing it, returning
`rolled-back` or `repair-required`.

`ImplementationOutputV1` verification is `state/implementation-manifest.ts:273` — it authenticates
every declared output against the base tree, the index, and the live worktree, recomputes all four
identity digests, and requires them to equal the supplied ones. It also requires the supplied
`undeclared_changes` report to deep-equal the live `git` working set (`:326`).

---

## 13. Fingerprints, request digests, and pins

`src/contracts/fingerprints.ts`

```ts
type InputFingerprintSubject = {
  schema_version; workflow_digest; config_digest; constitution_digest;
  artifact_identities: GitIdentityRef[];   // SET sorted by path
  upstream_identities: GitIdentityRef[];   // SET sorted by path
  rubric_digest; phase_instance;
  declared_inputs: DeclaredInputRef[];     // SET sorted by input_id
};
```

- `computeInputFingerprint` (`:174`) sorts all three sets and **throws on a duplicate key** — two
  entries claiming one key is a caller bug, not something this layer may silently resolve.
- **The caller's `input_fingerprint` is always an assertion, never authority.** The server recomputes
  it via `resolve_input_fingerprint` and compares (`transaction.ts:376-380`,
  `initialization.ts:339-345`). Mismatch ⇒ `INPUT_FINGERPRINT_MISMATCH`.
- `createInternalInputFingerprintResolver` (`state/fingerprint.ts:64`) refuses any caller-supplied
  digest: it re-reads workflow and constitution digests and compares them against the state's pins
  (`workflow-pin-mismatch`, `constitution-pin-mismatch`) before assembling the subject.
- `computeRequestDigest` (`:292`) has **one closed field list** — schema version, tool, repository
  identity, task identity, operation tag, that operation's `operation_fields`, and the recomputed
  fingerprint. `closedOperationFields` (`:214`) calls `exactFields()` per operation, so an added or
  missing field throws rather than silently changing (or not changing) the digest.
  `ExactSelectorCoverage` (`:98-110`) is a compile-time proof that the selector key list covers
  exactly the non-common input fields of every tool.
- Config pinning is `sha256` over the **exact whole `config.yaml` bytes** (`:338`). There is
  deliberately no re-pin, amendment, or upgrade field anywhere (D15 in
  `durable-task-initialization.ts:24-27`). `PINNED_CONFIG_MISMATCH` carries only the two digests —
  never config content.
- The constitution digest is `computePinnedConstitutionDigest` over the *commit tree's* numbered rule
  files (`state/constitution.ts:122`), never the worktree. `detectTaskLocalConstitutionEdit` (`:165`)
  treats uncommitted bytes only as a wake-up signal; the comparison digest always comes from HEAD.

---

## 14. Review evidence, triage, adjudication, fixed point

Trust model: `src/contracts/trust.ts` + `src/contracts/internal/trust-brands.ts`.

**Assurance** ∈ `agent-declared | server-attested | degraded`. A `CurrentEvidenceSetRef` is an
ordered 2- or 3-tuple of slots with hard-coded role order and independence rules
(`validateSlots`, `trust.ts:210`):

| Slot | Role | Assurance | Independence |
|---|---|---|---|
| 0 | `self-review` | `agent-declared` | `same-family-self` (producer === reviewer family) |
| 1 | `counter-review` | `server-attested` or `degraded` | `opposite-family` (producer ≠ reviewer) |
| 2 (optional) | `gate-counter-review` + `gate_id` | `server-attested` or `degraded` | `opposite-family` |

Evidence digests must be unique across slots. `set_digest` is sha256 over `JSON.stringify(slots)`
(`currentEvidenceSetRef`, `:218`).

- `observationSource` (`trust.ts:93`) is the only way to mint `server-attested` evidence: it requires
  an `ObservationCapability` whose binding it re-reads from a private `WeakMap`, re-parses the raw
  adapter bytes, and asserts every derived field equals the capability binding — including
  `family !== producer_family` for reviews (**opposite-family is enforced at observation time**).
- `loadCurrentReviewSet` (`state/evidence-results.ts:558`) is the **production** path to the branded
  set: it reconstructs self+counter from retained result manifests on disk. Callers supply neither an
  authority brand nor invented receipt/revision facts. `deriveCurrentEvidenceSet` (`:482`) re-checks
  role, assurance, family relationship, and that both reviews share subject, fingerprint, rubric, and
  producer family.
- `validateTriage` (`triage.ts:53`) requires the dispositions to **exactly cover** every finding of
  every current review — no duplicates, no foreign/stale refs, no omissions — and the
  accepted/rejected counts to be consistent. Returns a branded `ValidatedTriage`.
- `parseAndDeriveAdjudication` (`adjudication.ts:133`) recomputes the `constitution` and `drift`
  folds and the matched/uncertain rule lists from `rule_findings`, requires `drift_findings` to
  exactly cover `approved_upstream_digests` in order, and rejects "current" mechanical evidence bound
  to the wrong subject or a `pass` compliance backed by non-current evidence.
- `crossCheckRuleFindings` (`review/adjudication.ts:85`) adds the registry-dependent half: findings
  must be exactly the active rules, in id order, at the right versions, with exactly the declared
  enforcement mechanisms — and a rule with declared mechanisms can never be `pass`.
- `assessCurrentEvidence` (`review/fixed-point.ts:263`) computes the next action purely from durable
  state + retained manifests: `self_review → counter_review → triage → adjudicate →
  adjudication-gate → advance`, with re-entry to `produce` when triage accepted findings or the
  adjudication went stale, and `attempts-exhausted` when re-entry is required at
  `attempt >= max_attempts` (default 3, `:32`). Attempt exhaustion is evaluated **only** when
  re-entry is required.
- `requireApprovedUpstreamDigests` (`:346`) refuses any upstream that lacks a durable
  `artifact-approval` binding its exact digest.
- Evidence is retained through the same result machinery as any other output:
  `prepareEvidenceResult` (`evidence-results.ts:233`) renders deterministic markdown
  (`contracts/renderers.ts`, which escapes control/bidi characters), builds a one-output manifest at
  `.archflow/tasks/<task>/reviews/<phase>.<role>.md`, and requires a **clean** secret scan (`:313`).
  `durable.ts:642-675` independently pins that exact path shape per evidence role.

---

## 15. MCP tool contract surface

`src/contracts/mcp-tools.ts` — 5 tools, closed:

| Tool | Input | Success |
|---|---|---|
| `archflow_state` | `{…common, phase_instance, step, status, artifact?}` | `{path, revision, status}` |
| `archflow_counter_review` | `{…common, artifact_path, rubric}` | `{path, verdict, blocking_count, revision}` |
| `archflow_adjudicate` | `{…common, artifact_path, upstream_paths}` | `{path, constitution, drift, triggers, revision}` |
| `archflow_gate` | `{…common, phase_instance, summary, subject_digest, current_evidence, supersedes?, supplemental_outcome?, kind, context}` | `{kind, decision (envelope), notes, revision}` |
| `archflow_waiver` | `{…common, origin, rationale}` | `WaiverSuccess` (granted true/false variants) |

`CommonToolInput` = `{schema_version, task_id, intent_id, expected_revision, input_fingerprint}`.
`ToolContractMap` is proven exhaustive over `ToolName` at compile time (`:55-56`).

Pipeline (all four steps are required, in order):

1. `parseToolCall(name, value)` (`:110`) — deep clone, Zod parse, kind-specific re-parse for gate
   context / evidence set / supplemental outcome, deep freeze, brand.
2. `identifyTransactionRequest` (`state/request.ts:69`) — derives the `RequestDigestSubject` and binds
   `request_digest` to the parsed call.
3. `validateProjectResultStructure` (`:161`) — parses success against the per-tool schema plus
   cross-checks (state status must equal the input status; gate envelope must bind kind/task/phase/
   subject and `notes === payload.reason`; waiver result must bind its origin).
4. `correlateProjectResult` (`:180`) — requires all three brands, matching tool, matching
   `request_digest`/`task_id`/`intent_id`/`input_fingerprint`, and `expectation.success` deep-equal to
   the result.

`operationFor(call)` (`transaction.ts:214`) maps a call to the receipt's `operation` code; the same
map appears in `request.ts:27-35` and `fingerprints.ts:223-231` as a `satisfies Record<…>` so a new
artifact kind fails to compile in all three places.

---

## 16. End-to-end walkthrough: recording a produced artifact

`archflow_state{step: "produce", status: "succeeded", artifact: <ImplementationOutputV1>}`

1. **Parse** — `parseToolCall("archflow_state", input)`; the artifact goes through the Zod mirror
   (which the JSON Schema agrees with).
2. **Authority** — `createInternalTransactionAuthority` resolves repository identity, task identity,
   `task_root`, `state.json`, `config.yaml` as branded `ResolvedPath`s.
3. **Verify bytes** — `verifyImplementationManifest` re-observes every declared path (lexical leaf,
   not realpath), proves base-tree/index/worktree identity, and recomputes all four digests.
4. **Prepare result** — build `ResultManifestV1`, `prepareSnapshot` (caps + payload identity), resolve
   `results/sha256/<d>/manifest.json` and payload targets, `prepareProjectionPlan` (secret scan,
   collision classification), then `prepareResultInstallation` mints a **one-shot** capability.
5. **Transact** — `runStateTransaction`:
   - lock; read + validate state; `expected_revision` check;
   - recompute the input fingerprint and the request digest;
   - `prepare()` returns `{expectation, result, next_state: planStateTransition(...), result_installation}`;
   - `buildPlan` correlates, `assertPreserved`, `validateResultInstallationBinding` (paths must be
     inside the authenticated task root, manifest path must equal the content-addressed template,
     projection targets must match declared outputs), builds and validates the receipt and the
     committed successor;
   - install payloads → manifest → projections → `createExclusive(intent)` → `replace(state.json)`;
   - re-read and re-validate; return `{state, outcome, replayed:false}`.
6. **Gate** — the caller opens e.g. `commit-authorization`: `openDurableGate` re-derives `gate_id`,
   archives `request.json`, publishes `gate.json`, and bumps state with `open_gate` +
   `frozen_state_digest`. A human writes `gate.decision`. `runDurableGate` waits outside the lock,
   then `resolveAdvancingGate` archives `decision.json`, installs a gate receipt, appends an
   `ApprovalRef`, replaces state, and removes both interface files.

Any crash cut leaves either the prior revision or a fully reconstructible successor; re-invoking with
the same `intent_id` replays, and with different inputs returns `INTENT_MISMATCH`.

---

## 17. Pitfalls when changing this subsystem

1. **Never add a Zod mirror** for `TaskStateV1`, `IntentReceiptV1`, `ResultManifestV1`, or
   `MaintenanceRecordV1`. Tests grep for one.
2. **Never declare a persisted shape as an `interface`.** `type` alias only, transitively —
   otherwise `CanonicalDocument<T extends PlainJsonValue>` fails with TS2344 at the root, and the
   error blames the branded strings, not the declaration form.
3. **Adding a field to a durable root changes every digest that covers it.** Check: the JSON Schema,
   the Zod mirror (if any), `closedOperationFields` if it is request-bearing, and any
   `exactFields`/`Object.keys(...).sort()` equality check that enumerates slots
   (`durable.ts:405`, `transaction.ts:512-517`, `checkpoints.ts:72`).
4. **Adding an array field requires deciding set-vs-sequence and declaring the sort**, in both
   authorities, via `isSortedUniqueBy`/`tupleKey`.
5. **Keep the rank order in `validateDurableSemantics`.** Moving a clause changes which error a given
   invalid document reports, and the corpus tests assert exact codes. Rank 2 must stay before
   anything that can report `STATE_INVALID`.
6. **Preserve the write ordering** payload → manifest → projection → receipt → state. Reordering
   breaks every crash test and the replay proof.
7. **Widening `createExclusive`/`replace` path classes** (`atomic.ts:58-64`, `:105`) removes the
   immutable/mutable partition that the whole recovery argument rests on.
8. **A new gate kind** must be added to `GateContractByKind`, `GATE_KINDS`, `contexts`, `decisions`,
   `effects` (exhaustive `satisfies`), the two `discriminatedUnion` ladders in `gates.ts:125-147`,
   `DECISIONS` in `state/gates.ts:46`, and the matching JSON Schemas.
9. **Never pass `--literal-pathspecs` alongside a `:(top,literal)` pathspec** — the flag disables
   pathspec magic and the command silently selects nothing.
10. **Read the lexical leaf, not `ResolvedPath.absolute`,** whenever you observe or mutate a target
    that may be a symlink (`snapshots.ts:102`, `implementation-manifest.ts:176-177`).

---

## 18. Test map

| Area | Tests |
|---|---|
| Semantic corpus + structural corpus | `test/contracts/durable-semantics-corpus.test.ts`, `durable-structural-corpus.test.ts` |
| Ajv ↔ Zod agreement | `durable-agreement.test.ts`, `foundational-schema-agreement.test.ts`, `review-schema-agreement.test.ts`, `gate-error-schema-agreement.test.ts`, `mcp-contract-agreement.test.ts` |
| Canonical bytes parity with the release script | `canonical-parity.test.ts` |
| Layering | `repository-boundary.test.ts` |
| Schema registry completeness | `schema-registry.test.ts` |
| Real-SIGKILL crash cuts | `test/crash/state-{transaction,initialization,checkpoint-adoption,gate-lifecycle-phase12}.test.ts` |

Commands: `npm run typecheck`, `npm test`, `npm run test:contracts`, `npm run check` (full gate).
