## Implementation Log: Phase 18 - Manual and Degraded Recovery Workflow

### Decisions Made

- Manual workflow authority is an opaque same-process capability minted by `loadManualAuthority`. It classifies exactly one authenticated authority kind—initial, state-anchored, or continuation—and public CLI payloads never carry a reusable capability.
- `projectCurrentManualState` is the canonical projection for gate lifecycle and checkpoint construction. Initial, adopted, and continuation paths use one checkpoint revision space, and chain-derived `planned_final_phase` is applied before any transition or frozen-state digest is computed.
- Closed manual chains are not replayed as ordinary step transitions. `loadManualImportEvidence` authenticates retained results, gate/waiver archives, and committed Git trees; `reduceAuthenticatedManualChain` then supplies those capabilities to missing-state initialization and mature-state adoption.
- An unresolved gate remains manual authority and blocks import. Resolution, cancellation, or supersession must be archived and checkpointed first; recovery never rewrites a pending gate into a receipt-committed state.
- Retained manual results reuse normal manifest building, cap enforcement, secret scanning, snapshot installation, and projection collision behavior. The installed-result capability is minted only after immutable bytes and projections are installed or exactly revalidated.
- Normal `manual-status` includes the complete `task_status`; degraded and repair-required results remain compact and return exactly one conservative action. The public gate request projection is plain JSON `{ digest, value }`, not canonical byte storage.
- Routine handoff remains an explicit human checkpoint commit/push/clean-pull protocol. `HandoffRecordV1` is reserved for actual two-head divergence, where both heads are preserved and automatic mutation stops.
- The five existing MCP tools, durable checkpoint family, gate kinds, error taxonomy, and runtime dependency set were sufficient; Phase 18 adds no sixth tool or parallel recovery authority.

### Deviations from Plan

- Real bundled-CLI integration exposed two atomic filesystem defects outside the original Files table. `src/state/atomic.ts` now performs explicit temporary-file write, fsync, and rename, and projection installation materializes parent directories before install/remint. These changes were necessary for the designed end-to-end recovery path rather than a new abstraction.
- The checkpoint builder rejects a single milestone that both installs a result and opens a gate. This makes the gate's frozen state identical to the subsequently materialized checkpoint and removes a split-observation path found by counter-review.
- Final projection restoration is derived from the final authoritative result references, not every historical projection. Superseded references for the same phase/step are ignored, while simultaneous conflicting final references still stop.
- Gate publication derives its immutable request from selector and authority facts rather than trusting a caller-supplied request. Unknown fallback tool discriminants are rejected structurally.
- Verification was sized around the Phase 18 trust boundaries and representative terminal flows. Exhaustive crash, file-kind, path, adversarial, and real-host matrices remain assigned to Phases 20 and 21 as the design specifies.
- No PRD requirements changed. The architecture and phase plan were updated only to record the completed implementation and the counter-review-driven refinements above.

### Patterns Established

- Use one canonical state projection before hashing, gate opening, checkpoint construction, and later materialization; separately shaped views of the same authority cannot safely share a frozen digest.
- Keep normal-state revisions and checkpoint-chain revisions explicit. Once state adopts a checkpoint, comparisons against later manual heads use the adopted checkpoint revision rather than the state transaction revision.
- A recovery reducer may consume only authenticated retained archives and observed immutable Git facts. Checkpoint JSON selects evidence; it does not authenticate approval, waiver, gate closure, or committed output by itself.
- Derive disposable projections from the final authoritative reference set. Historical superseded outputs remain retained evidence but must not reappear as current worktree authority.
- An opaque capability that cannot cross CLI JSON should be reminted idempotently from authenticated files after interruption.

### Gotchas

- `planned_final_phase` may first become known from the checkpoint chain after state creation. Dropping that derived value makes final completion unreachable and disables the overrun guard.
- A gate's frozen-state digest is sensitive to revision space, authoritative results, and field stripping. Mixing result installation with gate opening or computing the digest from a different projection bricks later resolution.
- An imported state revision and its `adopted_checkpoint.revision` are intentionally different counters. Pending-head and successor checks must compare checkpoint revisions.
- A public CLI response must remain plain JSON. Returning `Uint8Array` canonical bytes leaks an implementation representation and does not round-trip through the CLI contract.
- Routine clean handoff has no two-head divergence facts; creating a `HandoffRecordV1` for it would fabricate authority.

### Key Interfaces

- `src/local/manual-workflow.ts`: `loadManualAuthority(...)`, `classifyManualWorkflowStatus(...)`, `buildCheckpointImportStateCall(...)`, `buildManualFallback(...)`, `runManualNext(...)`, and `runManualHandoff(...)` compose the helper-facing workflow.
- `src/state/manual-checkpoints.ts`: `projectCurrentManualState(...)`, `buildNextManualCheckpoint(...)`, `deriveFinalManualProjections(...)`, and `writeManualCheckpoint(...)` derive and install manual milestone authority.
- `src/state/manual-import.ts`: `loadManualImportEvidence(...)` and `reduceAuthenticatedManualChain(...)` authenticate and reduce closed chains for both initialization and mature-state adoption.
- `src/state/production.ts`: `createRetainedTaskAccounting(...)`, `installManualRetainedResult(...)`, and `remintManualRetainedResult(...)` share retained-result authority with normal production.
- `src/state/status.ts`: `computeTaskStatus(...)`, `computeDegradedStatus(...)`, and `manualCheckpointHeadIsPending(...)` expose truthful normal and degraded position.
- `src/repository/handoff.ts`: `inspectManualHandoff(...)` reports clean readiness or a divergence-preserving stop without choosing or mutating a successor.

### Counter-Review Resolution

- The incompatible current-state shapes, revision counters, and mixed gate/result transition were resolved with `projectCurrentManualState`, a single checkpoint revision space, post-install authority projection, and explicit mixed-operation rejection.
- Chain-derived `planned_final_phase` is resolved before materialization, applied to every authority branch, and covered by terminal-completion and overrun rejection tests.
- All three import wrappers now pass through real handler identification; missing and mature adoption authenticate gate/waiver and committed-tree evidence; divergent handoff, all five fallbacks, unknown-tool rejection, and representative invalid inventory are covered.
- Normal-mode status again carries all `TaskStatusV1` facts required by the status skill, while degraded results remain intentionally smaller. Skill contracts pin the correspondence.
- The final audit reported no blocker or major finding after targeted real-handler final-completion, local manual unit, TypeScript, and diff checks passed.

### Verification

- The focused Phase 18 suite passed 5 files / 22 tests, covering manual workflow unit behavior, real-handler recovery integration, skill contracts, initialization, and checkpoint behavior.
- After the final authoritative-projection correction, the local manual unit suite passed 8/8 and the targeted real-handler committed-implementation test passed with final terminal completion and exact replay without duplicate result submission.
- TypeScript checking and `git diff --check` passed after the final review fixes.
- The implementation was approved after counter-review, and the user explicitly accepted the exact bundle risk and authorized commit. `release:stage`, `release:write`, and `check:release` then passed for MCP digest `1f83196572e000c09d3c185b3b2c7f91e334fda474a10e2b6cb2e294288936a0`, local-helper digest `c1691e4e6083018af8092bb451e58bec266e9412a4f48baf1fa283874a7c5c18`, dependency-inventory digest `6836db3d7e77b1cf9cb19c0a0c063ff6cfaee5f50e92fdeea28241fb31ec5777`, and manifest digest `6db314edf478cf104495969cce1b8011551835a5dca325d18daa4e163013db12`.
- Release legal closure removed the now-unreachable `signal-exit` and `write-file-atomic` components and their staged license payloads after the atomic writer stopped depending on that package path.

### Proposed Durable Conventions

- Propose adding to repository policy: when a state field and an adopted subordinate artifact have independent revision counters, name both domains explicitly and compare like with like.
- Propose adding to repository policy: derive current projections from the final authoritative reference set, not the historical union of all retained outputs.
- Propose adding to repository policy: CLI JSON boundaries expose values and digests, never typed-array representations of canonical bytes.

No policy file was changed; these proposals require explicit user approval before becoming durable repository rules.
