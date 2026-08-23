## Implementation Log: Phase 1 - Descendant-Aware Milestone Recovery

### Decisions Made

- `src/state/implementation-manifest.ts` now resolves one structured `MilestoneProof` for document and implementation milestones. It selects the first first-parent child after the authorized baseline, validates that immutable tree, and rechecks symbolic target identity, target/head OIDs, ancestry, and candidate selection after inspection.
- `src/state/status.ts` keeps governing planning drift, ordinary projection reconciliation, and historical milestone proof distinct. Governing bytes cannot enter ordinary adoption; ordinary descendants retain the original milestone; missing proof routes to bounded refresh, fresh authority, or no-delta inspection.
- `src/contracts/durable-state.ts`, `src/contracts/durable-gate.ts`, and `src/contracts/gates.ts` add compatible optional target, recovery, supersession, and committedness facts. New no-wait design and implementation writers emit paired target facts; legacy records remain readable without acquiring invented historical identity.
- `src/state/gates.ts`, `src/state/transitions.ts`, and `src/mcp/handlers/state.ts` implement locked, replay-safe stale-interface refresh and same-position milestone recovery. Both are server-selected no-submission actions and neither records human provenance.
- `skills/archflow-{design,phase-design,phase-impl,status}/SKILL.md` and the affected maintained documentation describe the new actions and preserve the server as sole action selector.

### Deviations from Plan

- No requirements, trust boundaries, or phase boundaries changed. The implementation retained `milestone_target_head` alongside the required target ref/baseline pair because it is useful disclosure and revalidation evidence for the exact no-wait fixed point.
- Focused coverage was added to existing behavior-named suites rather than creating phase-named files.

### Patterns Established

- A historical Git proof is race-closed only when the final check includes symbolic ref identity, not merely equal commit OIDs. This convention is recorded in `CLAUDE.md`.
- A disposable stale gate projection is superseded by a server mutation that preserves immutable request/decision audit evidence and records no synthetic human choice.
- Authority cutoffs use the newest applicable planning restart or milestone recovery revision, preventing byte-identical later work from reviving superseded approvals, settlements, or waivers.

### Gotchas

- Legacy no-wait settlements without target facts may retain exact-tip compatibility, but descendant proof must not infer a historical target from the branch currently checked out.
- `target_head` is disclosure and a first-parent continuity anchor for baseline adoption. An unrelated descendant with the same complete drift subject stays settleable; an identical-byte non-descendant replacement is stale.
- A content-preserving rewritten implementation milestone needs inspection when the retained after-images already equal the clean current target tree; reopening production would otherwise lead to an empty synthetic commit.
- Real-Git integration suites require permission to spawn Git subprocesses in temporary repositories; sandbox `EPERM` is infrastructure failure, not a test assertion.

### Key Interfaces

- `resolveImplementationMilestoneProof(...)` and `resolveDesignMilestoneProof(...)` return `MilestoneProof` with `proven`, `not-created`, `missing-from-history`, or `unverifiable`.
- `assessBaselineSubjectFreshness(request, liveContext, presentedHeadOnCurrentFirstParent)` binds complete drift, target, committedness, and first-parent continuity.
- `refreshStaleBaselineGate(...)` archives and supersedes one stale open baseline interface under the task lock.
- `planMilestoneRecovery(...)` produces the exact same-position attempt-1 recovery draft and `latestAuthorityCutoffRevision(...)` applies its authority cutoff.
- Semantic actions `recover-milestone-authority` and `refresh-stale-baseline` accept no submission and are consumed only through their opaque server offers.

### Verification Evidence

- Focused TypeScript/unit/schema checks and real-Git semantic journeys cover descendant document and implementation milestones, final completion, no-wait target persistence, governing-plan drift, rewritten-history no-delta inspection, first-parent selection, symbolic-ref races, baseline subject continuity, and recovery cutoffs.
- Final required commands and their raw output are recorded in the server-provided verification transcript at `.archflow/runtime/tasks/free-form-changes/cache/phases/1/verification.txt`.
- The tracked `dist/` payload is staged into an explicit temporary directory, promoted from that exact candidate, and reproduced by `npm run check:deep`; no installer or machine-global location is used.
