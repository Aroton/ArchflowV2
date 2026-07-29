# Phase 9 Design Counter-Review — Transaction Substrate and Exact Replay

**Subject**: `.archflow/tasks/mcp-integration/phases/phase-9-transaction-substrate-and-exact-replay.md` (DESIGNED, 2026-07-29)
**Reviewed**: 2026-07-29
**Reviewer**: cross-client counter-review, fresh context
**Inputs read**: the phase design; `architecture.md` (Phases 6–11, Request/Mutation Flow, Data Model, Directory Structure); `prd.md` REQ-04/08/13/14/21/22/23/24/25/26/39; the Phase 8 design + implementation log; `.archflow/context/`; and the live tree at `7ea7906`, which is authoritative throughout.

**Verdict**: **fail** — substantive findings remain. 4 blocking, 9 major, 8 minor.

The design's core direction is right and several of its choices are better than the architecture they implement: state-as-sole-commit-event with no mutable receipt status, deferral of mutable projections to Phase 11, and refusing to let `proper-lockfile` break leases are all correct calls. The findings below are concentrated in three places: **capabilities the design hands its own kernel are not sufficient for the checks it claims** (blockers 1, 5), **two named packages cannot do what the design assigns them** (blocker 2, majors 5 and 7), and **the classification tables have a hole exactly at the principal crash case** (blocker 3, major 1).

---

## Blockers

### B1. `RequestDigestAuthority` and `TransactionAuthority` cannot perform the correlation the design assigns them

The design states the kernel "verifies their common task/repository context", "rejects … paths outside the authority's task", rejects a `state_path` substituted as the receipt target (Verification Step 6: "state-target … attacks"), and guarantees "Only the derived resolved intent target may be created or written". None of these is implementable from the declared inputs.

- `RequestDigestAuthority` carries `repository_identity_digest`, `task_identity_digest`, `input_fingerprint` — all opaque. `task_identity_digest` is `sha256(canonicalJson({schema_version, task_id, repository_identity_digest}))` (`src/repository/identity.ts:311-330`); `task_id` is **not recoverable** from it, so nothing can check it against `call.input.task_id` (`src/contracts/mcp-tools.ts:30`, `task_id` is in `common`).
- `TransactionAuthority` carries three `ResolvedTaskPath` values. `ResolvedTaskPath` is `string & { brand }` (`src/repository/paths.ts:40`) — it carries **no `path_class`, no repository-relative claim, and no task root**. The kernel therefore cannot assert `state_path` is a `task-state`, `config_path` a `task-config`, or `intent_path` an `intent`, and cannot recompute the task root to test containment. The richer `ResolvedPath` (`paths.ts:42-46`) carries exactly `path_class` + `repositoryRelative` + `absolute` and is what `resolveTaskPath` already returns.
- Most seriously, `intent_path` is **supplied by the caller** rather than derived from `call.input.intent_id`. This directly contradicts the design's own premise that "replay never trusts a deterministic filename by itself" and its Success Criterion "deterministic-path substitution … never succeeds". A caller can point `intent_path` at a *different* intent's receipt in the same task; if that receipt's `request_digest` matches (same semantic operation, different `intent_id`) and state authenticates it, the truth table returns exact replay for an intent the caller never held. The truth table keys only on receipt presence and request-digest equality — **it never compares `receipt.intent_id` to `call.input.intent_id`.**
- The design's own sentence "Phase 9 accepts no caller-owned projection buffers or paths" is contradicted by `TransactionAuthority` accepting three caller-owned paths.

This is not a hard problem — the shipped resolver already supports the fix. `intents/<intent-id>.json` is a first-class path class (`src/contracts/path-claims.ts:92` table, `TASK_CLASS_RULES`), `PathSafeId` is exactly the `intent_id` type, `resolveTaskPath` accepts `expectedClass`, and `containedUnder` deliberately resolves not-yet-existing paths through their existing ancestors (`paths.ts:277-299`).

**Suggested resolution.** (a) Add `task_id: TaskSlug` to `RequestDigestAuthority` — `TaskSlug` lives in `src/contracts/evidence.ts`, so this crosses no import boundary — and have the internal constructor prove `task_identity_digest` is that `task_id`'s digest. (b) Make `TransactionAuthority` carry `ResolvedPath` (not `ResolvedTaskPath`) plus the resolved task root, and require `state_path.path_class === "task-state"` and `config_path.path_class === "task-config"`. (c) **Derive** the intent target inside the kernel from `call.input.intent_id` via `resolveTaskPath({expectedClass: "intent", …})` instead of accepting `intent_path`; then also require `receipt.intent_id === call.input.intent_id` as a truth-table precondition, not an incidental consequence.

### B2. `createExclusive` cannot be built on `write-file-atomic`, and the design does not name a primitive that can

The Files table declares `src/state/atomic.ts` as an adapter "over `write-file-atomic`" providing both `createExclusive` and `replace`. `write-file-atomic@8.0.0` installs exclusively by `rename`, which **clobbers unconditionally**; it exposes no no-clobber mode (verified: `npm view write-file-atomic@8.0.0` — `main: ./lib/index.js`, single `signal-exit` dependency, no exclusive-create option in its API). The design correctly demands "a same-directory fully written temporary plus an atomic no-clobber install primitive; it must never implement check-then-rename" but never names the primitive, and the file's stated purpose points the implementer at the one package that cannot supply it.

The naive substitute is worse than a documentation gap. `fs.open(path, 'wx')` is no-clobber but installs an **empty file first**, so a crash mid-write leaves a truncated receipt at the final path. That receipt then hits the last truth-table row (`missing/corrupt` → `STATE_INVALID`/`RECONCILIATION_REQUIRED`, non-advancing) *and* poisons that `intent_id` forever, because every subsequent `createExclusive` collides. The design's Success Criterion "Faults at every boundary leave prior/next canonical state or a precise non-advancing error" would be violated by its own most likely implementation.

**Suggested resolution.** Pin the primitive explicitly: write the fully-formed temp in the same directory (`open` + write + `fsync` + `close`), install with `fs.link(temp, target)` — the only POSIX operation that is simultaneously no-clobber and installs already-complete content — then `unlink(temp)`. Classify `EEXIST` from `link` as the proven `collision` (`target_may_have_changed: false`). State the stray-temp policy for a crash between `link` and `unlink`, and correct the Files table so `atomic.ts` is described as "over `write-file-atomic` for `replace` and `node:fs` for `createExclusive`". Also record that `write-file-atomic` does not `fsync` the containing directory — which the design's power-loss disclaimer already anticipates but attributes to rename semantics rather than to the missing directory sync.

### B3. The initial canonical-state read has no constructible error

The pinned precedence begins "canonical state validity → CAS → …", and chunk 6 requires reading live state "only through resolved task-path classes" and requiring "exact canonical bytes". But `parseCanonicalDocument` **throws** a `TypeError` on non-UTF-8, non-JSON, or non-canonical bytes (`src/contracts/canonical.ts:118-141`), and the two candidate outcomes cannot be built:

- `STATE_MISSING` requires `{ phase_instance }` (`src/contracts/errors.ts`, `PROJECT_PARAMETER_SCHEMAS.STATE_MISSING`).
- `STATE_INVALID` requires `{ phase_instance, issue_code }`.

The `phase_instance` parameter runs `decodePhaseInstance` under `.strict()`, so `createProjectError` **throws a ZodError** when the value is absent or undecodable. A missing or corrupt `state.json` supplies no `phase_instance` at all. This is precisely the failure mode that Phase 7's rank-2 carriability guard exists to prevent (`src/contracts/durable.ts:252-263`) — the design reintroduces it one layer up.

The later arbitration rows are safe by accident (prior state was read successfully under the lock, so its `phase_instance` is available), but the design does not say the prior state's value is what those errors carry, and step 1 of the precedence has no answer at all.

**Suggested resolution.** Pin, per row: unreadable/absent/non-canonical state at the *initial* read reports `CONTRACT_INVALID { issue_code }` (the only state-family-adjacent code with no `phase_instance`); every later row that reports `STATE_INVALID` explicitly carries the **prior** state's `phase_instance`. State that the canonical readers catch `parseCanonicalDocument`'s `TypeError` and map it, rather than letting a programmer-boundary throw escape a path the design classifies as a returnable outcome.

### B4. The preparer, not the kernel, chooses the revision the caller sees

The design asserts "`NextStateDraft` prevents the preparer from choosing the revision … the kernel sets `revision = current.revision + 1`". That is true of `state.json` and false of everything the caller observes, because `PreparedTransaction` also carries `expectation` and `result`, and the shipped contracts bind the revision into both:

- `createInternalResultExpectation` rejects `resulting_revision !== success.revision` (`src/contracts/mcp-tools.ts:128`).
- `correlateProjectResult` rejects `expectation.resulting_revision !== result.value.revision` (`mcp-tools.ts:129`).
- Every `ToolSuccess` shape carries its own `revision` field (`successSchemas`, `mcp-tools.ts:74-80`).

So the preparer must pick `resulting_revision` and embed it in `success.revision`. Nothing in the design compares that number to `current.revision + 1`. A preparer that picks `current.revision + 5` produces: `state.revision = N+1`, `receipt.resulting_revision = N+1`, and a returned `outcome` claiming `revision: N+5`. The consolidated semantic validator cannot catch it — the design explicitly says the receipt contract "does not duplicate the five MCP result schemas", so no rank inspects inside `outcome`. The receipt self-digest then seals the disagreement immutably, and every later replay reproduces it. This is exactly the split authority the phase exists to eliminate.

**Suggested resolution.** Before constructing the receipt, require `expectation.resulting_revision === current.revision + 1`; after correlation, require the extracted success's `revision` to equal it; and set `receipt.resulting_revision` from the *verified* value rather than computing it independently. Additionally pin that the kernel runs `validateDurableSemantics(createCommittedIntentSubject(plannedState, plannedReceipt))` on the planned pair **before** the first write — the design constructs both documents but never says the pair is validated before it is durable.

---

## Major

### M1. The truth table's second column misses the principal crash case, and `INTENT_RETIRED` conflates three different states

Row 4 reads `present | absent or references a later intent | equal → INTENT_RETIRED`. Take the phase's own headline crash: receipt installed, process dies before `state.json` is replaced. State is still at revision `N`, and its `committed_intent` references intent `W` with `resulting_revision = N` — an **earlier** intent, not a later one, and not absent. **No row matches.** The classification of the case the phase was split off to handle is undefined.

Beyond the wording, three materially different situations collapse into one non-retryable outcome with next action `create-fresh-intent`:

1. **Orphan** — prepared, never committed (the crash above). Nothing happened; the caller is told to abandon a usable `intent_id`, and the orphan receipt blocks that ID permanently because `createExclusive` will always collide.
2. **Superseded-but-committed** — this intent *did* commit at revision `M`, another writer has since advanced state. The caller is told to create a fresh intent, i.e. to **redo work that already succeeded** — in direct tension with REQ-23 ("Repeating the same intent with the same inputs is safe and does not duplicate authoritative artifacts").
3. **Never-referenced foreign receipt** — a receipt that was never this task's commit.

REQ-22 requires that on restart the workflow "can resume, reconcile, safely retry, or provide a precise repair action". Case 1 currently yields the weakest of those four.

**Suggested resolution.** (a) Rewrite column 2 as "does not authenticate this receipt" so the table is total. (b) Add a resume branch for case 1: when the existing receipt's `request_digest` matches *and* `receipt.prior_revision === current.revision`, re-run `prepare`, require the newly planned outcome digest to equal the receipt's (a differing digest is a hard failure, not a silent overwrite), reuse the existing immutable receipt, and complete the state write. This preserves "no post-commit receipt rewrite", keeps exact-once, and turns the crash case into the resume REQ-22 asks for. (c) If (b) is rejected, record explicitly that a crashed intent is permanently retired, that orphan receipts accumulate under `intents/` with no named pruning owner (Phase 11's maintenance criterion names results, attempts, and payloads — not receipts), and give case 2 its own outcome so a committed intent is never told to re-execute.

### M2. Exact replay is unreachable from a byte-identical retry, and the design never says so

CAS is checked before intent handling, directly from `call.input.expected_revision`. The first invocation carries `expected_revision = N`; after commit, state is at `N+1`. A duplicate delivery of the **identical** call therefore returns `STATE_CONFLICT`, never replay. Replay is reachable only when the caller refreshes `expected_revision` to `N+1` — i.e. `expected_revision` must equal `resulting_revision`, the opposite of what the original call carried.

This is coherent (it is why `expected_revision` is excluded from the request digest, and `STATE_CONFLICT`'s shipped next action is literally `reread-and-retry-intent`, `src/contracts/errors.ts`), and `architecture.md:75` documents the refresh — but only for the `SUPPLEMENTAL_REVIEW_REQUIRED` case. The phase design never states it. Verification Step 5 says "Exercise exact current replay … Verify the pinned precedence"; an implementer who writes that test with the original `expected_revision` will get `STATE_CONFLICT`, conclude the precedence is wrong, and "fix" it by moving intent handling ahead of CAS — destroying Success Criterion 3.

**Suggested resolution.** Pin in the design that the canonical duplicate-delivery retry returns `STATE_CONFLICT` first and that exact replay requires `expected_revision === resulting_revision`; add both legs to Verification Step 5 as distinct pinned outcomes.

### M3. A second request-digest binding registry, which the shipped correlation function cannot consume

`src/contracts/mcp-tools.ts` already ships the binding seam this phase reinvents: `bindParsedToolCallRequest(call, digest)` recording into a module-private `requestDigests` WeakMap (`mcp-tools.ts:72-73`), producing `RequestIdentifiedToolCall`. `correlateProjectResult` — which the kernel must call to validate the prepared plan — accepts **only** `Extract<RequestIdentifiedToolCall, {name: K}>` and reads `requestDigests.get(call)`, throwing if absent (`mcp-tools.ts:129`).

The design's `TransactionRequest` carries `call: ParsedToolCall<K>` plus a separate branded `RequestDigestBinding<K>` backed by a *new* private WeakSet. As specified, the kernel holds a call the shipped correlation function will reject. The design never says how it bridges them.

This also compounds a proportionality problem the repository's own priorities flag (`CLAUDE.md`, "Prefer direct code and existing patterns over new abstractions"): the phase introduces three new brand registries (`RequestDigestBinding`, `RequestDigestAuthority`, `TransactionAuthority`), one of which duplicates a shipped mechanism, and a fourth `TransactionAuthority ↔ RequestDigestAuthority` correlation check that exists only because the design split one authority into two objects. None has a production caller until Phase 15.

**Suggested resolution.** Reuse `bindParsedToolCallRequest` and drop `RequestDigestBinding` — the shipped WeakMap already provides the "binding paired with another call" rejection the design wants. Merge `TransactionAuthority` and `RequestDigestAuthority` into one internally-minted authority carrying identity digests, `task_id`, and resolved paths, so the cross-authority correlation check disappears rather than being tested.

### M4. The "never breaks a stale lease" claim is not achievable by configuration in `proper-lockfile@4.1.2`

The design states: "The wrapper never asks `proper-lockfile` to break or acquire an existing stale lease … Acquisition invokes the package with no internal stale retry only after the wrapper observes absence."

Verified against the published `proper-lockfile@4.1.2` source (`lib/lockfile.js`): `lock()` normalizes `options.stale = Math.max(options.stale || 0, 2000)` and `options.update = Math.max(Math.min(options.update, options.stale / 2), 1000)` (`:219-221`). **`stale` cannot be set to zero**, and on the `EEXIST` path the package stats the lock and, if `mtime` is older than `stale`, removes it and reacquires (`:46-78`). The design's property is therefore *entirely* a property of the wrapper's observe-absence-then-`lock()` discipline, which is an unavoidable check-then-act — not something the package can be configured into. The design should say that plainly rather than asserting the stronger claim, because Success Criterion 6 ("A live or abandoned lock is never broken automatically") reads as a package guarantee.

Three further behaviours are unpinned and load-bearing:
- **The lock-policy constant set fixes only "the custom task-local lock path and bounded acquisition wait."** It must also fix `stale`, `update`, `retries`, and `realpath` — those are what make the no-takeover discipline sound, and the ≥2000 ms clamp must be recorded so a later reader does not "simplify" it away.
- `lock()` defaults `realpath: true` and resolves the **target** file through `fs.realpath` (`:16-22`), so it throws `ENOENT` when the target does not exist. Phase 9 always has state, but Phase 10 (revision 0 → 1) will not; decide now whether `lockfilePath` is paired with `realpath: false` and record the symlink consequence either way.
- **`proper-lockfile` releases held locks on process exit** via a `signal-exit` handler (`:172-183` documents the unref'd update timer as safe precisely because of this). That directly shapes the crash suite: a child terminated by `process.exit()` or an ordinary signal **releases its lock on the way out**, so only `SIGKILL` produces a genuinely abandoned lease. Verification Step 4's "abandoned-lock repair blocking" and "long stalls without takeover" cases must specify the kill mechanism, or they will silently test the release path instead.
- `runExclusive` is **not reentrant**: a nested same-task transaction in one process blocks until the bounded wait expires. Worth one sentence, since Phase 10 composes over this kernel.

### M5. `write-file-atomic@8.0.0` ships no type declarations, and the design admits typings only for `proper-lockfile`

Verified against npm: `write-file-atomic@8.0.0` declares `main: ./lib/index.js` and **no `types`, `typings`, or `exports`**. The repository compiles with `strict` and, notably, `skipLibCheck: false` (`tsconfig.json`). `import writeFileAtomic from "write-file-atomic"` will fail `tsc --noEmit` with TS7016. The only `@types/write-file-atomic` on npm is `4.0.3` — four majors behind, so it cannot be adopted without verifying it against the v8 surface.

Two smaller dependency-admission gaps travel with it:
- Chunk 1 says only "Move the two Phase 9 packages from the prohibited-future set into the exact runtime allowlist." Adding `@types/proper-lockfile@4.1.4` **also** requires editing `expectedDevelopment` in `scripts/check-dependency-policy.mjs:10-16`; `compareDirect` demands exact equality and will fail otherwise.
- `write-file-atomic@8.0.0`'s engines are `^22.22.2 || ^24.15.0 || >=26.0.0`. The project declares `>=24.15.0`, which admits Node 25.x — a range the package excludes. Chunk 1 says "pin the Node `24.15.0` engine compatibility" without noting the gap.

**Suggested resolution.** Decide explicitly between adding `@types/write-file-atomic` (with a pinned check that its v4 surface matches the v8 call the adapter makes) and a local ambient `declare module` in the adapter; list the chosen artifact in the Files table; add the dev-allowlist edit to chunk 1; and record the Node 25 engine gap as an accepted limitation or narrow the declared range.

### M6. `npm run build:temp` will fail, and the Files table omits the file that makes it fail

`scripts/smoke-temp-bundle.mjs:83` asserts `Object.keys(contracts.PROJECT_ERROR_DEFINITIONS).length === 52`. Adding `INTENT_RETIRED` makes it 53. `build:temp` runs `smokeTemporaryBundles` directly (`scripts/build-temp.mjs:6`), and Verification Step 7 runs `npm run build:temp`. The design's Files table does not list `scripts/smoke-temp-bundle.mjs`.

Three further guards are touched by this phase and unlisted:
- `test/contracts/durable-agreement.test.ts:355-362` asserts "no Zod schema anywhere names a field of task-state, maintenance-record, or `PreparedIntentRef`" over a literal banned-name list containing `prepared_intent` and `prior_revision`. Renaming to `committed_intent` and adding `receipt_digest`/`outcome_digest` requires that list to be re-derived — and note `prior_revision` moves into the receipt while `resulting_revision`, `intent_id`, and `request_digest` already appear in shipped Zod schemas (`mcp-tools.ts:50, 128`), so the guard cannot simply be extended by name.
- `test/contracts/gate-error-supplemental-exhaustive.test.ts:166` requires the set of codes exercised from `project-error.schema.json` to equal the registry keys exactly — a useful self-check, worth naming as the guard that proves the new `$def` was added correctly rather than leaving it to be discovered.
- No boundary test will exist for the new `src/state/` layer. `test/contracts/repository-boundary.test.ts:28-38` prohibits only `src/contracts → src/repository`. The design relies on `src/contracts/index.ts` not exporting filesystem capabilities, and on `fingerprints.ts` importing no repository type — both currently unenforced for the new directory.

### M7. The admitted dependency graph is understated, and `check:notices` is exhaustive over the whole lock

The design says "two exact permissive runtime dependencies … plus the exact MIT development typings package". Verified transitive closure: `proper-lockfile@4.1.2` → `graceful-fs@^4.2.4`, `retry@^0.12.0`, `signal-exit@^3.0.2`; `write-file-atomic@8.0.0` → `signal-exit@^4.0.1`; `@types/proper-lockfile@4.1.4` → `@types/retry@*` (a **floating** range). That is ~8 newly locked packages including **two `signal-exit` majors**.

`scripts/check-notices.mjs:50-73` builds `expectedSpdx` from **every** entry in `lock.packages` — dev dependencies included — and fails on both missing *and* stale inventory rows, so `THIRD_PARTY_NOTICES.md` needs an exact `name@version | LICENSE` row for each. `scripts/check-dependency-policy.mjs:118-135` additionally requires `integrity` + `resolved` on every locked entry and license membership in the approved set (all eight qualify: MIT/ISC). The design's chunk 1 should enumerate the graph so the notice work is scoped, and should note the `@types/retry: *` floating range as reproducibility-by-lock only.

### M8. Parent documents are not updated, and two deviations from `architecture.md` are unrecorded

ArchFlow's hard rule is that parent docs are updated when implementation deviates. The Files table lists no edit to `architecture.md`, yet this phase makes two changes to it and one to a shipped Phase 7 contract:

- **Second amendment to Phase 7's shipped `task-state`.** Phase 8 amended it once (adding `adopted_checkpoint`) and recorded that amendment explicitly in the architecture's Phase 7 entry. Phase 9 *removes* `prepared_intent` and replaces it with `committed_intent` — a larger change to the same shipped schema — with no corresponding record. `src/contracts/durable-state.ts:87-92, 109` must also be updated: its D13 note names `prepared_intent` as one of the four inputs to REQ-14's derived blocking reason.
- **REQ-14 consequence.** After this change, `state.json` contains **no representation of an in-flight or orphaned intent**. `archflow-status`, which "reads `state.json` alone" by design, therefore cannot report a task whose last transaction crashed after receipt creation; the task looks entirely normal until the next call with that `intent_id` returns `INTENT_RETIRED`. That is a defensible tradeoff, but it is a narrowing of REQ-14's "blocking reason" and belongs in the design as a recorded limitation with a named owner.
- **Receipts no longer carry error identity.** `architecture.md:231` specifies the intent receipt as binding "exact result **or error** identity". The kernel "requires success", so failures produce no receipt and are re-executed on retry. Record the narrowing.

### M9. Specification depth is materially below this task's own established bar

Phase 7 and Phase 8 designs pin: a `Decisions` section, shapes field by field, exact cross-chunk seams with every export, the complete list of new `issue_code` literals (Phase 8 pinned twenty-two), the extended invariant table by sub-rank, a `$def` inventory, and a `Non-Goals and Deferred Ownership` section. Phase 9 — which is comparable or larger in surface (2 runtime deps, 1 new normative schema, 5 new modules, a semantic-validator extension, a closed-digest rewrite, and 6 new/modified suites including multi-process and crash) — has **none of them**, and jumps from Interface Contracts straight to the Work Breakdown.

This matters because the design states "contract, reader, and kernel chunks can be implemented independently" and Verification Step 2 requires each mutation to "fail at its **pinned** semantic rank" — but nothing is pinned:

- No `issue_code` literals for any receipt clause, so `DURABLE_ISSUE_CODES` cannot be extended from this document.
- No sub-rank numbers. "Follows the existing three document self-digests" / "follows the existing rank-4 carrier checks" / "follows the existing rank-7 state/pin comparisons before rank-9" leaves the position relative to **rank 8** (`INPUT_FINGERPRINT_MISMATCH`, `durable.ts:584-594`) undefined, and rank 8 sits inside the same `state !== undefined` block the rank-7 clauses do.
- No reporting function for the receipt slot. `stateInvalid` needs a `phase_instance` the receipt does not have; `artifactInvalid` switches on `artifact_kind`, which the receipt does not have. `TASK_INVALID { task_id, issue_code }` is constructible from the receipt, but the design does not say so.
- No statement that `IntentReceiptV1` is **unmirrored** in Zod. Phase 7's rule is that union-reachable shapes are mirrored and server-internal shapes have exactly one model; the receipt is server-internal, so the answer is "no mirror" — but it is asserted nowhere, and `durable-agreement.test.ts` greps for exactly this.
- No field-by-field schema for `intent-receipt.schema.json`: no `$def` reuse from `durable-primitives`, no `minimum: 1` on the revisions (`SafeInteger` admits `0`, per the D8 convention already applied throughout `task-state.schema.json`), no bound on `outcome`.

**Suggested resolution.** Add the four missing sections before implementation. The reviewer time this costs is much smaller than the cross-chunk rework it prevents, and Phase 8's log shows the pinned-literal approach working.

---

## Minor

### m1. `intentReceiptDigest` risks diverging from the digest the validator uses
Rank 3 self-digest checks in `durable.ts` all call `canonicalJsonDigest(value)` directly. A separately named `intentReceiptDigest` invites a domain tag or field subset. Pin it as an exact alias of `canonicalJsonDigest` over the whole receipt, or drop it and use `canonicalJsonDigest`.

### m2. `runStateTransaction` discards the tool-typed outcome
The return type is `outcome: PlainJsonValue`, but `correlateProjectResult` returns `ProjectResult<ToolSuccess<K>>`. Every consumer — starting with Phase 15 — must re-validate to recover the type it just proved. Return `ToolSuccess<K>` and keep the plain-JSON snapshot as an internal digesting detail.

### m3. Receipt `outcome` is unbounded and permanently retained
Every committed transition writes one immutable receipt embedding the full tool success, under a directory the design gives no pruning owner. Phase 7's 25 MiB/250 MiB accounting bounds payload snapshots, not receipts. State a bound (or state that the five success shapes are inherently small and why) and name the retention owner.

### m4. The phase's writes leave the established path-safety idiom without saying so
`openResolved` (`src/repository/paths.ts:481`) is the repository's sanctioned open and ORs in `O_NOFOLLOW`. Neither `write-file-atomic` nor the proposed `link`-based create uses it; `write-file-atomic` additionally performs its own `realpath` on the target. Containment was proven at resolution time and `containedUnder` explicitly documents its TOCTOU window (`paths.ts:322-328`), so this is acceptable — but the design should say "resolution-time containment plus `O_NOFOLLOW` on the layout check only", rather than "rejects symlink … attacks" unqualified.

### m5. Fault hooks belong in fakes, not in the shipped adapter
Chunk 4 says the adapter should "expose deterministic fault hooks around temp/install/rename boundaries". `AtomicWriter` and `TaskLock` are already injectable interfaces, so unit and ordering faults belong in fakes. Only the real multi-process crash suite needs a real cut point; pin that mechanism (env-gated child, `process.kill` at a named boundary) and confirm it cannot reach `dist/`, which Phase 5's integrity checks cover byte-for-byte.

### m6. `prepare` runs while the task lock is held
`architecture.md:73` requires the opposite shape for long waits: a gate commits under the lock, releases, and reacquires on resolution. Phase 9 holds the lock across the caller-supplied `prepare`. State the invariant — `prepare` must be bounded and non-blocking; a blocking preparer is a caller protocol error, not something the lock policy accommodates — so Phase 12 does not discover it late.

### m7. `NextStateDraft` does not protect `adopted_checkpoint`
The kernel's preserved-identity list is seven fields; `adopted_checkpoint` is not among them, so a preparer may drop it. Phase 8's rank-5s invariant (`durable.ts:442-451`) then fails for any later continuation import, with an error that points at the import rather than the transition that erased the field. Phase 10 owns *writing* it; Phase 9 should own not *losing* it, or say explicitly why not.

### m8. `NextStateDraft`'s `?: never` guard is compile-time only
`exactOptionalPropertyTypes: true` makes it effective at the type level, but a runtime draft carrying `revision: undefined` reaches `assertPlainJson`, which rejects `undefined` as "not a JSON value" — producing a `TypeError` where the design's classification would expect a shaped rejection. One sentence on which boundary owns this is enough.

---

## What I checked and did not find fault with

Recorded so the next reviewer does not re-derive it:

- **Per-tool semantic field lists are correct** against the live parsers (`src/contracts/mcp-tools.ts:33-41, 55-61`). `archflow_state` (`phase_instance`, `step`, `status`), `archflow_counter_review` (`artifact_path`, `rubric`), `archflow_adjudicate` (`artifact_path`, `upstream_paths`), `archflow_gate` (all seven, `supersedes` optional), and `archflow_waiver` (`origin`, `rationale`) each exhaust their input minus `common`. `WaiverInput.origin` is a nested `WaiverOriginRef` carrying rule ID, rule version, subject digest, scope, and evidence-set digest, so REQ-18's binding is captured despite the two-field appearance. `archflow_state` has no `artifact` member today, so the Phase 15 deferral is a genuine deferral, not a live hole.
- **`intent` is already a first-class path class** (`src/contracts/path-claims.ts:86-92`, `TASK_CLASS_RULES`), and `architecture.md:210` already places `intents/<intent-id>.json` in the directory structure — so B1's fix requires no new contract.
- **Excluding `intent_id`, `expected_revision`, and the caller-asserted `input_fingerprint` from operation fields is correct** and closes the `KNOWN LIMITATION` block in `src/contracts/fingerprints.ts` exactly as its `OWNER:` line instructs.
- **The receipt/state digest relationship is acyclic** — state names the receipt, the receipt has no back-reference — and the "no mutable `committed` marker on the receipt" decision is the right one.
- **`containedUnder` resolves not-yet-existing paths** through their nearest existing ancestor (`paths.ts:277-299`), so the intent target and the `intents/` parent are both resolvable before creation.
- **Vitest picks up `test/crash/**` automatically** (`vitest.config.ts` includes `test/**/*.test.ts`), and `test:unit` is already a declared script, so the pinned script list in `repository-boundary.test.ts:81-100` need not change.
- **`write-file-atomic@8.0.0` and `proper-lockfile@4.1.2` both exist at the pinned versions** with approved licenses, and `@types/proper-lockfile@4.1.4` is real.
- **Deferring mutable canonical projections to Phase 11** is well argued and materially improves crash safety over `architecture.md:70`, which would have had Phase 9 replace projections it cannot restore.

---

## Suggested triage order

1. **B1** and **B4** first — both change the interface contracts every later chunk builds on.
2. **B2**, **B3**, **M4**, **M5** — these determine what chunks 4, 5, and 6 can actually be built from.
3. **M1** and **M2** — the classification and precedence tables, which the crash and race suites encode directly.
4. **M9** — add the missing pinned sections, then re-run design review before implementation begins.
5. **M3**, **M6**, **M7**, **M8** and the minors can be folded into the revision without a further gate.

## Triage

All findings were accepted. The design and parent architecture were revised before a fresh review.

### Blockers

- **B1 — authority objects cannot perform their assigned checks: accepted.** Replaced the three-brand arrangement with one registry-authenticated state-layer `TransactionAuthority` carrying `task_id`, freshly observed identity, a repository-resolved task root, and class-bearing state/config `ResolvedPath` objects. The kernel derives the class-bearing `intents/<call.input.intent_id>.json` target itself and explicitly compares the receipt intent to the authenticated call; it accepts no caller intent path.
- **B2 — no implementable no-clobber receipt primitive: accepted.** Pinned `createExclusive` to same-directory temp `open("wx")` → full write/fsync/close → `fs.link(temp, target)` → unlink. `EEXIST` is the collision result; a crash can leave only a uniquely named non-authoritative temp, never a truncated final receipt.
- **B3 — missing/corrupt initial state has no constructible error: accepted.** Initial missing, unreadable, and noncanonical state now map to `CONTRACT_INVALID` with fixed issue codes and caught parser errors. `STATE_INVALID` is used only after a trustworthy state supplies `phase_instance`.
- **B4 — preparer controls the returned revision: accepted.** Before any write, the kernel now requires expectation, correlated success, prepared state, and `current.revision + 1` to agree, rejects safe-integer overflow, constructs both durable documents itself, and validates their complete semantic subject.

### Major

- **M1 — principal receipt-only crash is missing and intent states are conflated: accepted.** The receipt now embeds the full prepared successor state and its digest. A matching receipt at predecessor revision resumes the state write without rerunning preparation. A later non-authenticating state returns new `INTENT_NOT_CURRENT` with `inspect-current-state`; foreign or changed reuse remains `INTENT_MISMATCH`.
- **M2 — exact replay is unreachable with the original CAS: accepted.** The design explicitly pins original expected revision N → `STATE_CONFLICT` after commit N+1, and refreshed expected revision N+1 → replay. Expected revision remains excluded from the logical request digest, and both legs are required verification cases.
- **M3 — duplicate request-binding registry: accepted.** Removed `RequestDigestBinding` and `RequestDigestAuthority`; the selector delegates to shipped `bindParsedToolCallRequest`, and the kernel consumes `RequestIdentifiedToolCall` as required by `correlateProjectResult`.
- **M4 — `proper-lockfile` cannot guarantee no stale takeover: accepted.** Removed the dependency entirely. The design now uses a non-reentrant core `mkdir` lock with bounded polling, no age/owner takeover, and explicit `SIGKILL`-abandoned-lock repair blocking.
- **M5 — `write-file-atomic` lacks current typings and Node 25 is unsupported: accepted.** Added a narrow reviewed local v8 ambient declaration and rejected stale v4 community types. The project engine is narrowed to `^24.15.0`.
- **M6 — exhaustive build/guard files omitted: accepted.** Added `scripts/smoke-temp-bundle.mjs`, the exhaustive gate-error suite, a re-derived durable-agreement guard, and state-layer public-export boundary assertions to the file plan.
- **M7 — dependency graph understated: accepted.** With `proper-lockfile` removed, the design admits only exact `write-file-atomic@8.0.0` and its lock-resolved permissive transitive graph (currently `signal-exit@4`), with exhaustive notice/policy checks.
- **M8 — parent deviations unrecorded: accepted.** Updated `architecture.md` with the Phase 7 `prepared_intent`→`committed_intent` amendment, success-only receipt scope, resumable receipt-only behavior, and the state-only REQ-14 limitation owned by Phases 10 and 17.
- **M9 — insufficient specification depth: accepted.** Added explicit Decisions, field-level receipt semantics, exact semantic-rank insertions and issue-code literals, constructible error ownership, the unmirrored-schema decision, retention/size constraints, and Non-Goals/Deferred Ownership.

### Minor

- **m1 — receipt digest helper could diverge: accepted.** Pinned it as the exact whole-receipt `canonicalJsonDigest` alias with no tag or subset.
- **m2 — typed outcome discarded: accepted.** `runStateTransaction` now returns `ToolSuccess<K>`.
- **m3 — unbounded permanent receipt: accepted.** Added a 1 MiB canonical receipt cap and task-lifetime retention; no speculative pruning subsystem is introduced.
- **m4 — path-safety guarantee overstated: accepted.** The design now states resolution-time containment plus `O_NOFOLLOW` for the layout check and preserves the documented trusted-filesystem/TOCTOU limitation.
- **m5 — production fault hooks: accepted.** Unit faults use injected fakes; real crash coverage uses named env-gated child cut points that must be absent from production bundles.
- **m6 — preparer runs under the lock: accepted.** Pinned `prepare` as pure, bounded, non-blocking, and free of filesystem/model/network/child-process I/O; long-running dispatch remains outside the kernel.
- **m7 — `adopted_checkpoint` can be lost: accepted.** The mature Phase 9 kernel preserves it exactly. Phase 10 may add a distinct adoption planner that deliberately changes it, not weaken this seam implicitly.
- **m8 — `?: never` is compile-time only: accepted.** Runtime forbidden keys and malformed plans are explicitly programmer-boundary `TypeError`s after single descriptor-read/materialization, not shaped durable failures.

## Fresh-review follow-up

The substantial counter-review revision received another fresh-context adversarial review. Its five findings were accepted and revised:

- **Prepared and committed receipt relations were ambiguous: accepted.** Added discriminated `prepared` and `committed` semantic subjects. Prepared mode compares the predecessor with every preserved successor identity/pin/checkpoint field at rank 8a; committed mode proves exact final-state derivation at rank 8b.
- **Kernel dependencies and error construction were incomplete: accepted.** Defined reader result unions, dependency/authority/error constructors, runner/context/attempt ownership, derived task-root/intent resolution, and exact missing/unreadable/noncanonical/substituted receipt outcomes.
- **Nested parsed-call semantics remained mutable: accepted.** Added a `mcp-tools.ts` change to materialize and recursively freeze the complete parsed input graph before installing the existing non-enumerable brand, with mutation coverage for all nested tool inputs.
- **Fingerprint authority did not prove live inputs: accepted.** Removed fingerprint data from the caller-minted request/authority seam. The kernel now invokes an internal production resolver under the lock, built from named canonical readers and accepting no caller subject/digest, then validates/materializes and hashes its result once.
- **Phase 10 initialization could not use the mature-state kernel: accepted.** Parent architecture now assigns Phase 10 a distinct state-absent initializer sharing Phase 9's authority/lock/receipt/atomic/semantic primitives; `runStateTransaction` remains explicitly mature-state only.
- **Live repository identity was only self-consistent, not observed: accepted.** The authority constructor now resolves repository identity from the authentic runner/Git environment, computes task identity internally, derives all paths, and verifies decoded state against the observed repository before CAS/intent processing.
- **Receipt/config classifications were not total: accepted.** Added an exhaustive mapping for every config/receipt read variant, future/superseded/orphan/committed revision relation, identity/tool/operation/fingerprint inconsistency, and the exact constructible error/issue code for each.

The final fresh-context closure review found no remaining blocker or major issue.
