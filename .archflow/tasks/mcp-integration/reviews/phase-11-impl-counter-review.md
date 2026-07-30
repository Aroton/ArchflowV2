# Phase 11 Implementation Counter-Review

**Task**: mcp-integration
**Phase**: 11 — Snapshots, Implementation Manifests, and Restore
**Reviewed**: 2026-07-29 (uncommitted working tree on `feature/mcp-server`, base `8cede1d`)
**Scope**: the files in the design's Files table only. `AGENTS.md` treated as user-owned and excluded.

`npm run typecheck` passes. `npm test` / `npm run check` show only the three inherited
`test/integration/release-offline.test.ts` failures (`stale bundle input: src/contracts/adjudication.ts`),
whose assertion set is unchanged and which are unrelated to Phase 11 files.

`.archflow/tasks/mcp-integration/architecture.md` is listed as `Modify` but is unchanged; the amendment text it
was supposed to gain (lines 230, 243, 350, 634, 639) already landed in the design commit, so that is not a finding.
`src/state/reconciliation.ts` is also listed as `Modify` and is unchanged; it already accepts only caller-supplied
projection observations and never touches `authoritative_results`, so the design property already holds.

---

## Blockers

### B1. `size_bytes` mixes worktree length and Git blob size, breaking every attribute-converted path

`src/state/implementation-manifest.ts:204` sets a snapshot observation's `size_bytes` to
`bytes.byteLength` — the raw **worktree** length — while `oid` on the same line-group
(`:193`) is `git hash-object --path=<declared-path>`, i.e. the **converted** blob OID. But
`baseIdentity` (`:240`) fills the same `BlobIdentity.size_bytes` field from
`readGitBlobSize` → `git cat-file -s`, which is the converted blob size.

Reproduced with `core.autocrlf=true`, worktree `a\r\nb\r\n`:

```
worktree bytes: 6
tree oid: 422c2b7a…  blob size: 4
hash-object --path: 422c2b7a…
```

`sameIdentity` (`:153`) compares `size_bytes`. Consequences:

- `sameIdentity(after.observation, proof)` at `:339` compares 6 against 4, so **`git-object` storage
  can never be selected for any path under a clean/`text`/`core.autocrlf` filter** — including the
  pure rename the design names as the one legitimate zero-copy case (Work Breakdown 2, success
  criterion 4).
- Within one artifact, `before` must be declared at blob size and `after` at worktree size for the
  same file, so `diff_digest` — "the exact review and commit-authorization subject" — encodes two
  incompatible meanings for one field.
- `deriveSnapshotDigest` therefore also hashes a `size_bytes` that disagrees with
  `deriveDeclaredSnapshotDigest`'s `output.after.size_bytes` (see M5).

The tests do not catch this: `test/integration/repository-git-phase11.test.ts` proves conversion
affects the OID in isolation, but the only `verifyImplementationManifest` case is an unconverted
add in a repo with no attributes.

**Severity**: blocker (unmet success criteria 2 and 4).
**Resolution**: make `SnapshotObservation.size_bytes` the *converted blob* size (length of the bytes
Git would hash for that path, or `readGitBlobSize` of the derived OID) so it is consistent with `oid`
and with `baseIdentity`; keep `content_digest` as SHA-256 of the projected worktree bytes, which the
design already defines that way. Add a `core.autocrlf` / `* text=auto` case that round-trips a
modify and proves a pure rename still reuses its base-tree blob.

### B2. There is no unchanged-fingerprint reuse path, and `prepareSnapshot` actively prevents one

Design chunk 3: "An unchanged fingerprint resolves and validates its existing authoritative manifest
byte-for-byte; its creation-time `accounting` is not rewritten because task revision or retained-byte
totals later changed."

Nothing in the phase resolves a manifest by fingerprint — `input_fingerprint` appears in
`src/state/snapshots.ts` only as a manifest field, never as a lookup key. Worse,
`prepareSnapshot` (`src/state/snapshots.ts:150`) *requires*
`manifest.accounting.task_bytes === retained_task_bytes + resultBytes` and returns
`accounting-mismatch` otherwise. Because `accounting` (with `task_bytes` and
`measured_at_revision`) is embedded in the manifest, re-minting the same logical result at a
different retained total or revision produces different manifest bytes, hence a **different
`result_digest`, hence a second retained generation** — the exact outcome the design forbids.
`installSnapshot`'s content-address reuse cannot help, because the address itself moved.

**Severity**: blocker (unmet success criterion 1; verification step "unchanged-fingerprint reuse").
**Resolution**: add the resolve-existing path — given `(phase_instance, step, input_fingerprint)` and
the current `AuthoritativeResultRef`, read and byte-validate the existing manifest via
`readSnapshot` and return it unchanged; only fall through to `prepareSnapshot` when no matching
authoritative manifest exists. Cover it with a test that changes `retained_task_bytes` between two
calls and asserts one retained generation and a stable `result_digest`.

### B3. No read/restore-time re-proof for `git-object` entries, and no way to obtain their bytes

Design chunk 2: "re-run both proofs on every read/restore … A missing later proof for an entry that
did choose `git-object` is `SNAPSHOT_INVALID`, never a fallback to object existence." Chunk 3:
"Validate stored byte counts/digests, commit reachability for `git-object` entries, projection
digests, embedded artifact digest, and every manifest/artifact correlation on read or restore."

`readSnapshot` (`src/state/snapshots.ts:188`) validates only the content address plus a
**caller-supplied** `validate_manifest`. It performs no `isCommitAncestorOfHead`, no
`readCommitTreeBlob` proof, no projection-digest check, and no `validateDurableSemantics` call, so
none of the manifest/artifact correlations in `durable.ts` are guaranteed on read. Separately, no
function in the phase reads a Git object's *content* (`readGitBlobSize` reads only the size), so a
`git-object`-stored output has no byte source at restore time at all — `ProjectionSource.desired.bytes`
must come from somewhere, and for those entries nothing can produce it.

`readSnapshot` and `readSnapshotPayload` also have zero test coverage and no callers.

**Severity**: blocker (unmet success criteria 1 and 4).
**Resolution**: take a runner and the current authority in `readSnapshot`, re-run
ancestry + `ls-tree` OID/mode proof for every `storage: "git-object"` entry and fail
`SNAPSHOT_INVALID` on any missing proof; validate projection digests and run
`validateDurableSemantics({ result_manifest })` there rather than delegating to the caller; and add
a `cat-file`-backed byte read so `git-object` entries can actually be restored. Test both the happy
path and a rewound/pruned base commit.

---

## Major

### M1. Maintenance never binds a supplied manifest to its content address, and double-reads `input.manifests`

`computeMaintenanceProof` (`src/state/maintenance.ts:72-91`) accepts `MaintenanceManifest` objects
and trusts `item.manifest.outputs` to enumerate reachable payloads, but never checks
`canonicalJsonDigest(item.manifest) === item.result_digest`. A supplied manifest that omits one
`raw-payload` output makes a live payload look unreachable, and it is then admitted for deletion at
`:97`. That is deletion authority derived from unauthenticated input, against chunk 7's
"Missing, contradictory, or incomplete roots fail closed."

The same lines read `input.manifests` twice (`.map(...)` at `:72`, `.length` at `:73`) without the
materialize-once treatment `roots` gets at `:59-61`. This is the split-observation hazard CLAUDE.md
records verbatim ("Validate and materialize a caller-owned object once before inspecting it more than
once"); `input.candidates` is likewise never materialized.

**Resolution**: `ownEnumerableData` + `assertPlainJson` + `structuredClone` `manifests` and
`candidates` the way `roots` is handled, then require
`canonicalJsonDigest(item.manifest) === item.result_digest` for every supplied manifest before it
contributes reachability.

### M2. `unreferenced-attempt` deletion is admitted with no unreferenced-ness proof

`src/state/maintenance.ts:93-98`: an `unreferenced-attempt` candidate is permitted purely because
`candidate.target.path_class === "attempt"`. Nothing in the roots walk relates attempts to anything,
so any attempt path the caller hands in is deleted. `test/unit/state-maintenance.test.ts:32-45`
confirms this — the state has empty `authoritative_results` and the attempt is deleted anyway. The
design requires "only proven `unreferenced-attempt` or `superseded-payload` candidates". The
`superseded-payload` branch is never exercised by any test.

**Resolution**: either collect attempt references from the supplied roots and require the candidate
to be absent from that set, or — if attempts are genuinely outside the walk in this phase — make
that explicit by rejecting the category here and recording it as a documented Phase 15 limitation.
Add a `superseded-payload` case, including one where the payload *is* reachable and must be refused.

### M3. Immutable content addresses are read with `readFile`, bypassing `openResolved`/`O_NOFOLLOW`

`openResolved` is documented as "Containment step 7, and the only sanctioned way to open a resolved
path" (`src/repository/paths.ts:315,577`) and is used consistently in `read.ts`, `layout.ts`, and
`implementation-manifest.ts` — and in `readSnapshot`/`readSnapshotPayload` in this very file. But:

- `installOne` (`src/state/snapshots.ts:161`) uses `readFile(target.absolute)`.
- `observe` (`src/state/snapshots.ts:268`) uses `readFile(path.absolute)`.
- `performMaintenance` (`src/state/maintenance.ts:148,155`) uses `readFile(...)` for both the record
  and each deletion candidate.

Concrete failure for `installOne`: `createExclusive` links onto an existing symlink and returns
`"exists"`; `readFile` then follows the symlink, the bytes match, `installSnapshot` reports
`"reused"`, and the payload is never actually written. The transaction commits a result whose
payload only later fails to open (because `readSnapshotPayload` *does* use `O_NOFOLLOW`). The design
explicitly asks for these operations "without weakening containment."

**Resolution**: route all four reads through `openResolved(target.absolute, 0)`.

### M4. The result-installation capability never binds its reference to the bytes that get installed

Design chunk 6 pins `prepareResultInstallation` as the seam that "validates/materializes caller-owned
inputs once, stages immutable bytes in memory, and mints a non-exported WeakMap-authenticated
capability", and `installPlan` as the point that "revalidates its observed source facts and caps
under the task lock before installing payload/manifest/projections, receipt, and state".

`src/state/transaction.ts:100-110` only clones the plan and stores an opaque `install` closure; it
never sees bytes. `installPlan` (`:606-609`) just calls `install()`. Nothing checks that
`reference.result_digest` / `reference.manifest_path` name what `install()` writes, and no cap or
source-fact revalidation happens under the lock. `test/unit/state-transaction.test.ts:275-309`
installs with `result_digest: D("9")` and a callback that writes nothing, and passes.

**Resolution**: have `prepareResultInstallation` take the `PreparedSnapshot` (or at least its
`result_digest` and resolved manifest target) rather than a bare closure, assert
`reference.result_digest === prepared.result_digest` and that `manifest_path` matches the resolved
target at mint time, and re-run the cap preflight inside the lock before installing.

### M5. Two unreconciled derivations of `snapshot_digest`, and a document's `after.oid` is never derived

`deriveDeclaredSnapshotDigest` (`src/state/snapshots.ts:43`) rebuilds snapshot entries from
`outputs` + `projections`; `deriveSnapshotDigest` (`src/state/implementation-manifest.ts:95`)
builds them from live observations. `prepareSnapshot` gates on the first, `verifyImplementationManifest`
on the second, and no test proves the two agree for a single artifact — B1 is already one way they
diverge.

For document artifacts there is no second derivation at all. The design requires the document's
snapshot entry to carry "the independently derived regular-file OID", but `durable.ts:232-247`
checks only `after.mode`, `after.size_bytes`, and `payload_digest`; `after.oid` is never computed
from `git hash-object --path=<projection_target>` anywhere. It stays a Phase 7 assertion, contrary
to "The server derives and compares these facts when creating the result."

**Resolution**: add a contract/unit test that runs one real implementation output through both
producers and asserts equality; derive and compare the document's `after.oid` at materialization.

### M6. `.archflow/` paths are silently forced to mode `100644`

`src/state/implementation-manifest.ts:190`:

```ts
mode = resolved.repositoryRelative.startsWith(".archflow/") || (stat.mode & 0o111) === 0
  ? "100644" : "100755";
```

An executable file under `.archflow/` is recorded as `100644` in `snapshot_digest` and
`worktree_identity_digest` even though Git's tree mode would be `100755`. There is no comment, no
design basis, and `observe()` in `snapshots.ts:269` does not apply the same rule, so the two modules
describe the same file differently. The design requires the derivation to verify "tree mode", not to
normalize it.

**Resolution**: drop the `.archflow/` clause and report the real mode. If task-owned outputs must
never be executable, reject the observation instead of rewriting it.

### M7. The Secretlint byte transform is duplicated, while `detector_set_id` pins it as one version

`SECRETLINT_DETECTOR_SET_ID` (`src/state/secret-scan.ts:34-42`) hashes
`byte_transform_version: "utf8-or-latin1-v1"` as if there were a single transform, but
`candidateContent` (`src/state/snapshots.ts:283`) re-implements `secretScanText` independently. Any
future divergence changes what is scanned without changing the pinned detector-set identity — the
one thing that identifier exists to prevent.

**Resolution**: have `prepareProjectionPlan` call `secretScanCandidateFromBytes` and delete
`candidateContent`.

### M8. `renameNoClobber` is unreachable, and the rename rule is not enforced at classification

`createProjectionWriter` exposes `renameNoClobber` (`src/state/atomic.ts:367-383`), but
`applyDesired` never renames — it writes the destination bytes and removes the source as two
independent entries — so the function has no caller and no requirement behind it. Relatedly,
`prepareProjectionPlan` has no rename-pair concept at all, so the design's "its destination must be
absent at derivation, classification, and apply" is enforced only at derivation
(`implementation-manifest.ts:321`) and, incidentally, at apply. Nothing in the plan records that two
entries form a rename or refuses a rename whose destination's authenticated before-image is present.

**Resolution**: delete `renameNoClobber` and its `ProjectionWriter` slot, or wire it and drop the
write+remove path. Either way, carry the rename pairing into `ProjectionPlanEntry` so classification
can reject a present destination directly.

### M9. Several pinned verification cuts were not written

The design's chunk 8 and Verification Steps pin coverage that is absent:

- No `test/crash/*` file was added or modified — there is **no** real-process fault cut around
  payload, manifest, projection, receipt, or state authority movement, and no
  record-before-delete or representative deletion cut for maintenance.
- No receipt-only resume test. `dependencies.resume_result` has no implementation and no caller, so
  success criterion 7 ("receipt-only retry restores retained bytes without a second preparation
  call") is an unexercised hook; today any receipt-only retry of `record-document-artifact` /
  `record-implementation-output` returns `result-resume-unavailable`.
- No `readSnapshot` / `readSnapshotPayload` coverage at all.
- `verifyImplementationManifest` is exercised only for one unconverted `add`. No modify, delete,
  rename, symlink, binary, executable-mode, index-only, unicode/space, or `git prune --expire=now`
  case, despite those being named in Verification Steps and criteria 2 and 4.
- The cap test checks `CAP + 1` on both scopes but never the "reaches but never exceeds" edge at
  exactly `CAP`, and never asserts that a rejected result wrote no partial payload (criterion 5).

**Resolution**: add the crash cuts and the resume test at minimum; those two carry criteria 7 and 8.
The `verifyImplementationManifest` operation matrix and the exact-cap edge are cheap additions to the
existing integration and unit files.

## Triage

### B1 — Accepted

`size_bytes` must use the converted Git blob size wherever it accompanies a path-aware blob OID.
The implementation and real attribute/autocrlf verification will be corrected; projected-byte
SHA-256 remains over worktree bytes.

### B2 — Accepted

The content-address installer is not an unchanged-fingerprint resolver. A dedicated current-reference
reuse path will validate and return the existing manifest unchanged, preserving its creation-time
accounting and result address.

### B3 — Accepted

Schema parsing is insufficient at this trust boundary. Snapshot read/restore will own durable semantic
validation, projection correlation, base ancestry/tree proof, and Git-object byte loading.

### M1 — Accepted

Maintenance inputs will be materialized once, and every supplied manifest will be bound to its
canonical content address before it contributes deletion authority.

### M2 — Rejected in part; coverage accepted

The claimed `unreferenced-attempt` authority defect is rejected. Attempts are categorically diagnostic,
are not a member of any durable authority/evidence reference shape, and cannot authorize advancement;
with complete inventory attestation, explicit caller candidacy, and independent human approval, every
attempt is unreachable by construction. Adding a speculative attempt-reference graph would contradict
the approved schema-specific walk. The missing `superseded-payload` and reachable-payload refusal tests
are accepted and will be added.

### M3 — Accepted

All reads of resolved immutable/projection/maintenance targets will use the repository's no-follow
open primitive.

### M4 — Accepted

The capability must bind the prepared snapshot, resolved manifest target, reference, and projection
plan rather than an unconstrained callback. The task-lock path will revalidate the prepared facts/caps
and install that exact bound material.

### M5 — Accepted

The two snapshot derivations will share one normalized producer, and document materialization will
derive its path-aware Git OID rather than trust it.

### M6 — Accepted

The undocumented `.archflow/` executable-mode rewrite will be removed; observations will report the
actual filesystem/Git mode.

### M7 — Accepted

Projection scanning will use the detector-set-bound byte adapter from `secret-scan.ts`.

### M8 — Accepted

Projection planning will carry explicit rename pairing and enforce absent destination at
classification and apply. The unused alternate rename primitive will be removed unless the resulting
plan uses it directly.

### M9 — Accepted within the approved proportional boundary

Add receipt-only retained-result resume, read/read-payload, authority-moving crash coverage, exact cap
edges, and representative add/modify/delete/rename/filter/symlink/mode/prune cases. This does not reopen
the deliberately rejected exhaustive maintenance/process-kill matrix from the design review.
