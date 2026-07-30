## Implementation Log: Phase 11 - Snapshots, Implementation Manifests, and Restore

**Implemented**: 2026-07-29
**Status**: COMPLETE
**Requirements advanced**: REQ-08, REQ-11, REQ-13, REQ-21, REQ-22, REQ-23, REQ-25, REQ-26, REQ-33, REQ-39, REQ-50 (durable gates, MCP wiring, status presentation, and full recovery remain assigned to later phases)

### Decisions Made

- Added one schema-only `ResultManifestV1` durable root that embeds its exact validated document or implementation artifact, correlates all duplicated facts, and is addressed by its canonical digest.
- Defined `snapshot_digest` as the domain-separated declared-output state, while `result_digest` alone addresses the retained manifest. Snapshot, diff, index, and worktree identities are derived from authenticated repository observations rather than trusted artifact assertions.
- Made regular-file Git identity path-aware: `oid` and `size_bytes` describe the clean-filtered Git blob, while `content_digest` describes exact projected worktree bytes. Symlink targets remain unconverted.
- Limited zero-copy `git-object` storage to base-tree entries whose ancestry, path, mode, OID, converted size, and projected bytes can all be re-proved. Other surviving outputs use bounded raw payloads.
- Preserved creation-time accounting by resolving an unchanged fingerprint to its already-authenticated authoritative manifest instead of minting a new content address.
- Integrated prepared result capabilities into the state-last transaction kernel. Under the task lock the kernel revalidates facts and caps, then installs payloads, manifest, projection, receipt, and state in that order; receipt-only resume reloads retained authority without invoking preparation.
- Added a flat Secretlint adapter with a canonical detector-set identity, safe finding projection, strict unknown-rule failure, no directive-filter registration, and no upstream secret-bearing messages or data in retained output.
- Kept maintenance schema-specific and caller-bounded. It materializes supplied roots once, authenticates every manifest against its content address, writes a no-clobber record first, and deletes only approved unreferenced attempts or superseded payloads.

### Deviations from Plan

- The implementation counter-review found and corrected three blockers before approval: mixed worktree/blob units in `size_bytes`, absent unchanged-fingerprint reuse, and read/restore paths that did not re-prove durable or Git authority.
- Restore from a Git object requires more than reading raw object bytes when attributes apply. The final implementation reconstructs projected regular-file bytes through Git's destination-path checkout filters and verifies those bytes against the retained observation before use.
- Maintenance cannot currently discover diagnostic attempts categorically from durable authority roots. The implementation accepts caller-enumerated candidates, binds each to its content-addressed target, and proves permitted category/reachability before deletion; Phase 15 remains responsible for complete inventory enumeration.
- `architecture.md` and `reconciliation.ts` were listed as modified implementation files. The architecture already contained the approved semantic amendments and needed only completion evidence; reconciliation already exposed the required bounded observations and required no code change.
- The aggregate release suite remains blocked by the inherited tracked-bundle contradiction. Full verification passed 1,262 of 1,265 tests; the unchanged failures are the three `release-offline` assertions covering stale bundle input, residual runtime loader text, and bundle-input integrity mutation. This phase did not regenerate or weaken tracked release authority.

### Patterns Established

- A persisted path-aware Git identity must keep Git blob facts and projected-worktree facts explicit: blob OID/size are conversion-aware; content digest is over projected bytes.
- Content-address reuse validates and returns the original immutable object. Creation-time accounting is never rewritten to reflect a later retention total.
- Retained Git-object authority is re-proved at every read/restore through base ancestry and tree identity, then projected for the destination path before byte use.
- Caller-owned root and candidate collections are descriptor-checked and materialized once before validation, hashing, reachability, or deletion decisions.
- A resolved real path authenticates containment but does not preserve a lexical symlink leaf. Leaf-sensitive reads and writes reconstruct the lexical path from the authenticated worktree root and repository-relative claim, then use no-follow operations.

### Gotchas

- Under `core.autocrlf` or clean filters, worktree length can differ from `git cat-file -s` for the same path-aware OID. Comparing worktree byte length to blob size makes valid Git-object reuse impossible.
- Reading a Git blob directly is insufficient for restore when its destination path has checkout attributes. The retained OID must be transformed for that exact destination path.
- A manifest whose JSON validates can still be unusable. Reads must validate durable relations, manifest address, projection digests, storage bytes, and any Git ancestry/tree proof.
- Bare `readFile` follows a substituted symlink even at an immutable-looking content address. Payload, manifest, projection, and maintenance reads use the repository no-follow boundary.
- Rename destinations are reciprocal, explicit, and absent at classification and application. There is no overwrite-style rename fallback.

### Key Interfaces

- `src/contracts/durable-result-manifest.ts`: `ResultManifestV1`; `parseResultManifest`; `resultManifestDigest`.
- `src/state/implementation-manifest.ts`: canonical identity derivation and `verifyImplementationManifest` against live Git/index/worktree facts.
- `src/state/snapshots.ts`: `prepareSnapshot`; `installSnapshot`; `readSnapshot`; `readSnapshotPayload`; `resolveExistingSnapshot`; `restoreSnapshotOutput`; projection planning/application.
- `src/repository/git.ts`: `hashGitBlobIdentity`; `readGitBlobBytes`; `readGitBlobProjectedBytes`; ancestry, tree, index, and changed-path observations.
- `src/state/secret-scan.ts`: production `SecretScanner` adapter and byte-safe candidate transformation.
- `src/state/maintenance.ts`: bounded reachability observation and record-first permitted deletion.
- `src/state/transaction.ts`: authenticated prepared-result installation and retained-result receipt resume.

### Verification

- Typecheck passed; focused affected suites passed 79/79; contracts passed 448/448; MCP runtime passed 101/101; the temporary build passed.
- Dependency policy passed for 140 locked entries; notices passed for 140 SPDX entries and 21 mappings; notice mutation and Phase 4 boundary/mutation checks passed.
- Full suite passed 1,262/1,265. Only the three inherited `release-offline` failures described above remain.
- `git diff --check` passed. The implementation counter-review is fully triaged in `reviews/phase-11-impl-counter-review.md`; no blockers remain.

### Follow-ups Not Done Here

- Phase 12 owns durable gate lifecycle and application of the three restore-collision decisions.
- Phase 15 owns handler/CLI wiring and complete maintenance inventory enumeration/attestation.
- Phase 17 owns status presentation, and Phase 18 owns the broader manual/degraded recovery workflow.
- Resolve the inherited release-integrity contradiction before regenerating the tracked release payload.

### Durable Convention Proposal

Propose adding three repository-wide conventions to the target project's eventual `CLAUDE.md`: keep path-aware Git blob size distinct from projected worktree byte size; reconstruct lexical leaf paths before symlink-sensitive no-follow operations; and apply destination-path checkout filters when restoring regular bytes from a retained Git object. They are recorded here for now because `.archflow/` will be removed before PR.
