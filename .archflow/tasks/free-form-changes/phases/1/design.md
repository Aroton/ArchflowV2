# Phase 1 — Descendant-Aware Milestone Recovery

## Goal

Deliver one repository-ready authority boundary in which ordinary committed or uncommitted work no longer strands an ArchFlow task between milestones. The workflow must independently prove the original authorized milestone in the current target's first-parent history, reconcile current projected bytes, and return an executable adoption, restore, fresh-authority, successor, completion, or safe inspection path without transferring review or commit authority to a later commit.

This phase implements the complete task. It does not redesign Git, add a general history service, introduce a durable milestone receipt, or weaken review, task isolation, canonical-state, explicit-human-decision, or no-code-before-approved-phase-design boundaries.

## Requirements carried into this phase

- Preserve exact task-design, phase-design, and implementation milestone completion through ordinary descendant commits when the original milestone remains provable on the authorized target.
- Keep historical commit proof separate from the accepted current baseline. A later commit is never described as reviewed or authorized merely because it descends from the milestone.
- Classify governing planning-document drift before ordinary baseline adoption so dependent work cannot consume edited, unreviewed plans.
- Bind baseline decisions to the complete live drift subject, target identity, committed/uncommitted classification, and target-history continuity; revalidate those facts at settlement and refresh a genuinely stale open interface without fabricating a human choice.
- After missing milestone proof, preserve the bounded unchanged no-wait design refresh, otherwise re-enter the owning position for significant fresh production/review when a committable delta exists. A content-preserving rewrite with no delta must produce an actionable inspection, never an empty synthetic commit.
- Make every new semantic action replay-safe, server-selected, race-closed, and usable at task-design, phase-design, intermediate implementation, and final completion boundaries under human and authenticated no-wait authority.
- Preserve unrelated index/worktree bytes and task isolation during adoption, restoration, recovery, handoff, and completion.
- Keep TypeScript contracts, generated JSON Schemas, skills, human-facing rendering, tests, and maintained documentation synchronized with the shipped behavior.

## Concrete repository context

The current failure is distributed across an existing trust boundary rather than isolated to one observer:

- `src/state/implementation-manifest.ts` validates design and implementation milestones at the current target tip. Candidate validation currently couples milestone proof to `HEAD`.
- `src/state/status.ts` composes projection reconciliation, approval/rule evidence, commit observation, baseline-adoption subjects, and the next-action inputs.
- `src/state/next-action.ts` currently falls back to inspection or replays tip-bound commit handling when completion cannot be observed.
- `src/mcp/handlers/state.ts`, `src/state/transitions.ts`, and `src/state/request-composition.ts` close mutation races and therefore must use the same proof and recovery semantics as status.
- `src/state/gates.ts`, `src/state/reconciliation.ts`, `src/state/reconciliation-discovery.ts`, `src/state/gate-decision-interface.ts`, and the gate fingerprint/contracts implement adoption, restoration, and presentation settlement.
- Durable persisted shapes live in `src/contracts/durable-state.ts` and generated schemas; semantic action/public response shapes live in `src/contracts/semantic-workflow.ts` and their generated schemas.
- Existing real-Git and semantic journey coverage is concentrated in `test/integration/implementation-output-builder.test.ts`, `test/integration/semantic-document-journeys.test.ts`, and `test/integration/semantic-implementation-completion-journeys.test.ts`, with contract and gate lifecycle coverage alongside them.

The approved phase remains a sound single increment after the bounded fit check. Historical proof without reconciliation and recovery still leaves promised choices unusable; reconciliation or recovery without exact proof can authorize the wrong commit or loop. Contract-only, documentation-only, and test-only slices are scaffolding rather than stable user outcomes. No parent-document correction is needed.

## Files and surfaces

Implementation should follow concrete call sites discovered during the work; the expected surface is:

- Git and proof: `src/state/implementation-manifest.ts`, `src/repository/git.ts`, and focused proof tests.
- Status and action selection: `src/state/status.ts`, `src/state/next-action.ts`, `src/state/semantic-actions.ts`, `src/state/semantic-view.ts`, `src/state/request-composition.ts`, `src/state/transitions.ts`, and `src/mcp/handlers/state.ts`.
- Reconciliation and gates: `src/state/reconciliation.ts`, `src/state/reconciliation-discovery.ts`, `src/state/gates.ts`, `src/state/gate-core.ts`, `src/state/gate-decision-interface.ts`, plus fingerprints and renderers under `src/contracts/`.
- Durable/public contracts: `src/contracts/durable-state.ts`, `src/contracts/gates.ts`, `src/contracts/durable-gate.ts`, `src/contracts/fingerprints.ts`, `src/contracts/semantic-workflow.ts`, `src/contracts/mcp-tools.ts` where compatibility requires it, and the corresponding generated schemas under `src/contracts/schemas/v1/`.
- Authority eligibility: the existing restart/approval/settlement/waiver cutoff helpers under `src/state/`, generalized only as needed for milestone recovery.
- Client guidance: `skills/archflow-design/SKILL.md`, `skills/archflow-phase-design/SKILL.md`, `skills/archflow-phase-impl/SKILL.md`, and `skills/archflow-status/SKILL.md`.
- Maintained docs: `docs/OVERVIEW.md`, `docs/workflow/LIFECYCLE.md`, `docs/state/DURABLE-STATE.md`, `docs/mcp/SERVER.md`, `docs/review/COUNTER-REVIEW.md`, `docs/contracts/CONTRACTS.md`, and `docs/TESTING.md`.
- Tracked release payload: regenerate and promote `dist/` from an explicit temporary staging directory after source, schema, skill, and documentation bytes settle. This updates the repository payload only and never installs to machine-global locations.
- Verification: existing contract, schema, gate lifecycle, proof, semantic document, and semantic implementation journey suites; add behavior-named tests/files only where an existing suite is not an honest home.

## Work chunks

### 1. Define the persisted and semantic vocabulary

Add additive durable facts for new no-wait milestone target identity, same-position milestone recovery history, and stale baseline-gate supersession. Add the `recover-milestone-authority` and `refresh-stale-baseline` semantic actions as no-submission actions. Extend baseline-adoption context with the target and complete committedness subject used by fingerprints and presentation copy.

Keep every persisted reachable shape a `type` alias. Validate/materialize caller-owned objects once before repeated inspection, and require own data properties to be enumerable wherever descriptor reads protect a shell or slot. Update TypeScript and generated schemas together; old records remain readable, while new writers emit complete paired target facts.

If the advertised MCP tool contract changes, preserve a plain object at every input-schema root. Represent variant fields within that object and keep any combinator below the root; strict server validation remains authoritative and must name offending fields.

### 2. Resolve historical milestones from immutable candidates

Replace tip-only Boolean observation with one structured `MilestoneProof` resolver shared by document and implementation paths. Pin the authorized symbolic target and target head, distinguish target-at-baseline from missing history and unverifiable Git failure, require baseline ancestry, select only the first first-parent child after the exact baseline, and run existing exact subject-specific validators against that immutable commit tree. Re-read target/ref/ancestry after tree inspection to close the observation window.

Preserve all current exact implementation predicates (parent, message, changed paths including rename endpoints, retained modes/OIDs, deletions, and authority) and document predicates (task-local paths, reviewed document blobs, recovery state, human or no-wait authority, and unauthorized-document exclusion). For autonomous design proof, authenticate the candidate's historical `state.json` and correlate its settlement with current state rather than comparing historical state bytes with today's append-only state.

### 3. Separate governing drift, ordinary drift, and milestone proof

Order status composition so complete projection discovery first identifies authenticated governing planning documents, then reconciles ordinary projections, and only then evaluates historical milestone proof. Governing documents that would be consumed by a dependent phase must route to exact restoration, current-owner recovery, or the existing explicit backward restart; they cannot enter ordinary adoption even after their prior milestone was committed. Mixed drift resolves governing authority first and presents remaining ordinary drift on fresh status.

For ordinary drift, bind the gate subject to the exact target ref, the target head observed for disclosure and continuity, the complete sorted changed/deleted digest set, and sorted uncommitted paths derived against the pinned target tree. Settlement recomputes that semantic subject under the task lock and requires the presented head to remain on the current target's first-parent history. An unrelated descendant that preserves the subject therefore remains settleable; a non-descendant target replacement is stale even when its paths, bytes, and committedness happen to match. Changed bytes, drift membership, branch, committedness, or relevant history also refuse stale settlement.

### 4. Add replay-safe stale-interface and missing-proof recovery

Implement server-selected `refresh-stale-baseline` to supersede only an open baseline-adoption request whose recomputed live subject differs. Record immutable supersession audit evidence, remove only the stale open reference/disposable projection, and allow status to render a fresh decision without inventing cancellation, adoption, restoration, approval, or human provenance.

Implement `recover-milestone-authority` for representable missing proof and current-owner governing-document drift. Revalidate repository identity, target/ref/head, state revision, subject, complete drift classification, and cause under the task lock; preserve repository bytes; stay in the same phase instance; supersede active phase results; clear and record active waivers/pending human revision; reset to significant production attempt 1; recompute the production fingerprint; and append one replay-safe recovery record. Generalize authority cutoffs so approvals, settlements, and waivers older than the newest planning restart or milestone recovery cannot revive.

Retain the unchanged no-wait design baseline-refresh exception. Before implementation recovery, detect a content-preserving rewrite with no committable delta and return a plain-language inspection naming safe remedies instead of offering recovery that can only create an empty commit. Treat Git/object/identity failures as unverifiable, not ordinary missing proof.

### 5. Wire every completion boundary and human interface

Make status projection and the mutation that consumes handoff/final completion invoke the same structured proof resolver and reconciliation ordering. Preserve original commit facts only while the target is still the authorized baseline; after proof succeeds, expose the normal successor or completion without attributing authorization to descendants. Ensure task-design, phase-design, intermediate implementation, later-active-phase reconciliation, and final completion all share these semantics for human and no-wait authority.

Update baseline-adoption rendering to enumerate every applicable accepted decision shape, including restore, deletion adoption where valid, cancellation/abort, and the fresh-clone limitation for uncommitted versions. State plainly that keeping current versions accepts a workflow baseline but performs no fresh review and grants no commit authority. Update owning skills only to follow server-returned no-submission actions and explain consequences; they must not infer recovery from Git evidence or choose a human decision.

### 6. Prove behavior and document the trust boundary

Add focused real-Git negatives and positives for first-parent candidate selection, descendants/merges, movement before commit, wrong target/message/path/tree/authority, rewritten history, missing objects, and concurrent ref movement. Add contract/schema/lifecycle coverage for additive compatibility, exact semantic subjects, recovery cutoffs, stale-gate supersession, replay refusal, governing-document classification, and truthful rendering.

Add representative semantic journeys for human and no-wait document milestones, non-final and final implementation milestones, the reported multi-commit adoption journey, restoration, repeated/worktree-only drift, governing-document edits, later-active-phase reconciliation, stale decision races, missing-proof fresh recovery, and the no-empty-commit rewritten-history inspection. Use sentinels to prove unrelated index/worktree changes are preserved.

Update every maintained caps-named page listed above in the same change so the documented lifecycle, durable authority, semantic actions, review boundary, contracts, and verification matrix match the implementation.

After source, generated schema, skill, and documentation bytes settle, build the release candidate into an explicitly created empty temporary directory and promote that exact candidate into tracked `dist/`. Treat the resulting payload and manifest changes as generated outputs of this phase; do not run the repository installer or copy this checkout into shared machine-global locations.

## Pinned cross-chunk interfaces

- `MilestoneProof` is the only status/mutation interpretation of historical milestone existence. Callers receive a structured server-derived result; no public or client-supplied Boolean can assert proof.
- Candidate selection is exactly the first commit on the authorized target's first-parent path after the authorized baseline. Validators inspect that immutable candidate; they never scan other refs for a matching tree.
- `proven` carries the original candidate identity plus the freshly pinned target ref/head. `not-created` is only target-at-baseline. Missing ancestry/candidate mismatch and Git unavailability remain distinguishable so recovery never treats an observation failure as absence.
- Projection reconciliation precedes milestone proof for action selection, with governing-document classification preceding ordinary adoption. Adoption records current baseline facts only and never mutates milestone authority.
- New no-wait milestone target facts are written together. Legacy settlements without those facts remain readable but cannot gain invented historical target identity.
- `recover-milestone-authority` and `refresh-stale-baseline` accept no client submission. Their opaque offers bind the complete server-observed state and repository subject; apply revalidates it under the task lock and is replay-safe.
- A milestone recovery is a fresh significant production boundary, not a human approval, waiver, decision, or reviewed result. Its revision participates in the same eligibility-cutoff calculation as planning restart history.
- Baseline settlement identity includes target ref, complete changed/deleted paths and digests, committed/uncommitted classification, and first-parent continuity from the presented target head. The exact head is retained for disclosure/audit and as the continuity anchor, but an unrelated descendant alone does not make an otherwise identical choice stale; an identical-byte non-descendant replacement does.
- Governing task-design or phase-design bytes cannot be adopted into successor authority. Restoration may recover exact reviewed bytes; retaining changed governing bytes requires owning-boundary fresh authority.
- Status and all consuming mutations re-run the same proof/reconciliation logic; semantic views expose only the one server-derived action and human-readable consequences.

## Success criteria

- An exact authorized milestone remains recognized after unrelated descendants at every design and implementation completion boundary, including final task completion.
- Projected output drift produces an exact, honest adoption/restore decision; either successful settlement leads to a usable next action when historical proof remains valid.
- A governing planning-document edit cannot expose dependent work until restored or freshly reviewed through its owner.
- Repeated drift and non-descendant target replacement present a fresh decision, while an unrelated descendant preserving the semantic drift subject and first-parent continuity does not force duplicate human approval.
- Representable missing proof re-enters the same owning phase and completes through fresh production/review/authority; a content-preserving rewrite cannot lead to an empty synthetic commit.
- Human and no-wait authority remain distinct, and no descendant, adopted byte, recovery record, stale-interface refresh, or agent prose is reported as review or human approval.
- Stale/replayed offers and concurrently changed repository facts fail closed to fresh status without losing durable audit evidence or unrelated worktree/index changes.
- Existing durable records parse; new state and public schemas agree with TypeScript; task isolation and canonical digest validation remain intact.
- Maintained documentation and canonical skills describe the shipped actions and trust boundary.

## Executable verification

Run narrow suites during implementation, expanding exact file selections as behavior-named tests are added:

```bash
npx vitest run test/integration/implementation-output-builder.test.ts
npx vitest run test/integration/repository-git-object-proofs.test.ts
npx vitest run test/integration/semantic-document-journeys.test.ts
npx vitest run test/integration/semantic-implementation-completion-journeys.test.ts
npx vitest run test/integration/state-gate-lifecycle.test.ts
npm run typecheck
npm run check:schemas
```

Before completion, run the repository's proportional full validation:

```bash
npm run check
release_stage_dir="$(mktemp -d)"
npm run release:stage -- --output "$release_stage_dir"
npm run release:write -- --stage "$release_stage_dir"
npm run check:deep
```

Create `release_stage_dir` as a new empty temporary directory immediately before these commands (for example with `mktemp -d`) and pass the same explicit path to both release commands. Payload promotion occurs only after the candidate stage succeeds; `check:deep` then validates and reproduces the tracked `dist/` bytes against the final source inputs.

Verification evidence must show actual returned semantic actions and successful consumption, not merely the absence of an inspection. It must also show exact candidate rejection, identical-drift descendant settlement, identical-byte non-descendant replacement refusal, stale-offer recomposition, compatibility parsing, replay safety, and preservation of unrelated repository bytes.

## Deviations from parent documents

None. The bounded fit check confirms the approved single-phase scope and verification story against the current repository. Concrete filenames may shift only when an existing neighboring module is the simpler home; such movement does not change the pinned interfaces, authority boundaries, or acceptance behavior above.
