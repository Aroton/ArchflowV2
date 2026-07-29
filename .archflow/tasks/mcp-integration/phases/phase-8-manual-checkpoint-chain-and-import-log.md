## Implementation Log: Phase 8 - Manual Checkpoint Chain and Import

**Implemented**: 2026-07-28
**Status**: COMPLETE pending commit
**Requirements advanced**: REQ-11, REQ-21, REQ-26, REQ-39, REQ-50 (none completed — this phase defines formats and pure validation/selection, with adoption and runtime wiring in later phases)

### Decisions Made

- Added two normative durable roots: `manual-checkpoint` and `manual-checkpoint-import`. Both have JSON Schema 2020-12 authority and Zod mirrors because an agent can eventually supply them through the MCP boundary. The registry grows from 32 to 34 schemas, and the agreement table grows from 8 to 18 mirrored roots/`$defs`.
- Kept manual authority self-proving. Revision 1 carries the complete normal or legacy initialization artifact; later checkpoints carry predecessor revision/digest links; the self-digest is derived from canonical bytes and is never stored inside the checkpoint it hashes.
- Added `TaskStateV1.adopted_checkpoint {revision, checkpoint_digest}` as the one Phase 7 durable-shape amendment. Continuation import validation requires the supplied state to record the wrapper's exact predecessor, closing the same-revision/D1-versus-D2 provenance hole found at design review.
- Extended `validateDurableSemantics` in place rather than creating a second cross-document authority. The import family adds four rank-4a carriers and ranks 5c–5t, with five chain-walking rules implemented as separate complete passes so sub-rank always dominates collection index.
- Added the pure `selectGreatestValidChain(anchor, candidates)` boundary. It reads no files and consults no server state; it returns one unique chain (possibly empty) or an explicit `gap`, `fork`, or `foreign-candidate` stop. Task/repository identity, embedded-initialization identity, and chain-wide initialization consistency are whole-set stops, never reasons to truncate and continue.
- Preserved the shared uniqueness helper's prior absent-key behavior while enforcing the durable descriptor rule for present properties: one absent key contributes `undefined`, two absent keys collide, and a present accessor or non-enumerable data property rejects before value access.
- Kept the approved known unsupported path explicit: a task that has normal server state but no prior checkpoint cannot begin a manual chain with these two v1 shapes. Phase 9 owns adoption/bootstrap behavior and Phase 17 owns the manual recovery workflow; the gap must be resolved before Phase 17 ships.

### Deviations from Plan

- **The pinned TypeScript seam could not satisfy its own compile-time criterion.** The design specified `ContinuationManualCheckpointV1.revision: SafeInteger`, but `SafeInteger` includes branded value `1`, making a predecessor-bearing revision-1 checkpoint inhabitable. The shipped interface uses `ContinuationCheckpointRevision`, a `SafeInteger` subtype proven by `parseManualCheckpoint` to be at least 2. A non-vacuous `@ts-expect-error` uses `parseSafeInteger(1)` and fails if the field is loosened back to `SafeInteger`. Consequently, the design's statement that `revision === 1` can never narrow is not literally true for the shipped TypeScript union; production code still narrows on field presence because that is the durable structural discriminator.
- **`hasUniqueObjectPropertyValues` changed by more than `export`.** The design asked for byte-identical behavior, but the repository's durable descriptor convention requires rejecting present accessor and non-enumerable properties before reading them. Counter-review caught an overcorrection that also rejected a single absent key; the final implementation restores the old absence semantics and changes only the two unsafe present-property cases.
- **The selector now checks embedded initialization identity.** The pinned four-step sketch omitted the 5j/5k comparisons even though the surrounding design prose said the selector re-expressed them. The implementation follows the stronger prose and REQ-26 boundary: a foreign embedded task or repository stops the whole candidate set.
- **The `task-state` terminal comment drops the `$def` count instead of changing seven to eight.** The count was a stale-invariant generator; the replacement records only the durable rationale for leaving the two-member enum inline.
- **The four `manual-checkpoint` `$def` agreement rows use the owner's complete transitive reference set.** Ajv compiles the complete owner document when resolving a pointer into it, so the design's pointer-local reference lists do not compile. The owner remains explicit in every row and all transitive references are registered.
- **Selector hashing remains quadratic in candidate count.** `checkpointLinkBreak` re-derives the tail digest while filtering candidates. The selector has no production caller in this phase; Phase 14 may memoize once enumeration supplies a concrete bound or demonstrates a cost. Phase 8 keeps the simple shared-predicate implementation.

### Patterns Established

- A durable union branch whose numeric lower bound must be uninhabitable in TypeScript needs a proof-producing branded subtype; a general `SafeInteger` plus a runtime schema minimum is not enough for compile-time exclusion.
- Candidate-chain identity failures are whole-set failures. Selection never silently filters a foreign task, repository, embedded initialization, or initialization lineage and then returns a shorter chain as authority.
- Structural and semantic ordering have separate jobs: duplicate revisions are structural, chain order/linkage is semantic, and numeric revisions must not reuse the repository's string-only `tupleKey` ordering predicate.
- A descriptor hardening must distinguish a missing property from an invalid present property when preserving an existing helper's semantics. Accessors and non-enumerable data properties fail before read; absence follows the helper's pre-existing comparison model.

### Gotchas

- `SafeInteger` includes 1, so `revision === 1` could not prove the original two-member union impossible on its continuation branch. Raw numeric literals are also not a valid compile-time witness because they fail the `SafeInteger` brand first; the negative test must start from `parseSafeInteger(1)`.
- `tupleKey` stringifies components. It reports `[{revision:9},{revision:10}]` as not ordinally sorted, so checkpoint revisions use numeric-safe uniqueness structurally and semantic linkage for order. Tests pin that a correctly linked 9-to-10 chain is accepted.
- Ajv `$def` wrappers still compile the complete owner schema. A test that supplies only the pointer's apparent direct references can fail even when the pointer body itself does not use the missing roots.
- Zod object parsing materializes enumerable output, so descriptor hazards must be checked at the raw/plain-JSON boundary or in the shared predicate itself; a refinement over Zod's cloned object cannot prove the caller's original enumerability.
- The inherited `currentEvidenceSetRefSchema` remains weaker than `parseCurrentEvidenceSetRef` for cross-slot evidence-digest uniqueness. Phase 13 owns that gap when evidence documents become load-bearing.
- The tracked release payload remains stale. Phase 8 adds two schema files, but the observed failure still stops earlier at the inherited Phase 5/6 contradiction; clean HEAD reproduces the same three release-offline assertion texts.

### Key Interfaces

- `src/contracts/durable-checkpoint.ts`: `PredecessorLink`; `ContinuationCheckpointRevision`; `ProjectionDigestRef`; `EvidenceChainEntry`; `InitialManualCheckpointV1`; `ContinuationManualCheckpointV1`; `ManualCheckpointV1`; `InitialImportV1`; `ContinuationImportV1`; `ManualCheckpointImportV1`.
- `src/contracts/durable-checkpoint.ts`: `authoritativeResultRefV1Schema`, `approvalRefV1Schema`, `waiverRefV1Schema`, `openGateRefV1Schema`, `predecessorLinkV1Schema`, `projectionDigestRefV1Schema`, `evidenceChainEntryV1Schema`, `manualCheckpointV1Schema`, `manualCheckpointImportV1Schema`.
- `src/contracts/durable-checkpoint.ts`: `parseManualCheckpoint(value) -> ManualCheckpointV1`; `parseManualCheckpointImport(value) -> ManualCheckpointImportV1`; `checkpointSelfDigest(checkpoint) -> Sha256Digest`.
- `src/contracts/durable-checkpoint.ts`: `CHECKPOINT_BREAK_CODES`; `InitialChainAnchor`; `ContinuationChainAnchor`; `ChainAnchor`; `chainAnchor(wrapper) -> ChainAnchor`; `checkpointSelfBreak`; `checkpointLinkBreak`; `chainHeadBreak`.
- `src/contracts/durable-checkpoint.ts`: `CHAIN_SELECTION_OUTCOMES`; `ChainSelectionOutcome`; `ChainSelection`; `selectGreatestValidChain(anchor, candidates) -> ChainSelection`.
- `src/contracts/durable-state.ts`: `AdoptedCheckpointRef`; optional `TaskStateV1.adopted_checkpoint`.
- `src/contracts/durable.ts`: `DurableArtifact` now has five members; `DURABLE_ISSUE_CODES` has 44 literals; `validateDurableSemantics` owns import ranks 4a and 5c–5t without changing `DurableSemanticSubject`'s three slots.
- Schemas: `src/contracts/schemas/v1/manual-checkpoint.schema.json`, `manual-checkpoint-import.schema.json`, and the amended `task-state.schema.json#/$defs/adoptedCheckpointRef`.

### Verification

- Node `24.18.0`: typecheck passed; unit suite **644/644**; contract suite **445/445**; MCP runtime **99/99**; temporary contract/runtime bundle built and exercised.
- Full suite: **1111/1114** passed. The three failures are exactly the inherited `test/integration/release-offline.test.ts` cases: stale `src/contracts/adjudication.ts` bundle input and stale `fast-uri-3-1-0-local-risk` binding. A detached clean worktree at base `3891341` reproduced byte-identical assertion text.
- Dependency policy passed for 124 locked entries; notices passed for 124 SPDX entries and 21 reviewed NOTICE mappings; notice mutation policy, Phase 4 MCP boundary, and boundary mutation policy passed. Release smoke passed; `release:check`, `release:mutations`, and `release:reproduce` remain blocked by the inherited release-integrity contradiction.
- Differential counter-review fuzzed every JSON pointer in all three fixtures across 1,688 mutations and observed zero Ajv/Zod disagreements.
- Structural non-vacuity probes removed chain revision uniqueness and revision-1 initialization presence; the intended rejection cases flipped to Ajv acceptance. The mirror-free sentinel failed on a temporary Zod `prepared_intent` occurrence.
- Semantic/selector probes inverted `checkpointLinkBreak` (23 failures), mutated `checkpointSelfDigest` (15 failures across both suites), and removed 5c, 5q, 5t, 5m, 5j/5k, and 5s or weakened 5s presence (5, 1, 1, 2, 4, 3, and 1 failures respectively). Every mutation was reverted before the clean runs.
- The implementation counter-review is fully triaged in `reviews/phase-8-impl-counter-review.md`; no blockers remain.

### Follow-ups Not Done Here

- Resolve the normal-state-without-checkpoint bootstrap path before Phase 17 ships (Phase 9 adoption plus Phase 17 manual workflow).
- Bind initialization `canonical_paths` to its task identity when Phase 10 owns path-template classification.
- Resolve checkpoint/result/decision/evidence reference targets in their owning runtime phases; Phase 8 intentionally only defines shapes and pure comparisons.
- Revisit selector digest memoization in Phase 14 only if candidate enumeration demonstrates a meaningful bound or cost.
- Resolve the inherited release-integrity contradiction before regenerating the tracked payload.

### Durable Convention Proposal

No new project-wide convention is proposed. The two durable rules this phase exercised — persisted-root reachability requires `type` aliases, and descriptor reads require enumerable data properties before value access — are already present in `AGENTS.md`. The missing-versus-invalid descriptor distinction and continuation revision brand are important here but remain too context-specific to add as universal rules.
