# Recoverable Free-Form Changes Between Phases

## Summary

ArchFlow must remain a structured development workflow, not a lock on the repository. During a long, multi-phase task, users and agents need to make ordinary out-of-band edits, maintenance commits, workflow-record commits, and merges. Those changes may touch files produced by a completed phase.

ArchFlow should continue to detect when current files differ from the recorded reviewed baseline and require an explicit decision where appropriate. Once that decision is resolved, however, the workflow must always return to a supported path. An ordinary descendant commit after an already-committed task-design, phase-design, or implementation milestone must not make the original commit authority unusable and strand the task before its successor. In particular, choosing to keep current versions after an already-committed implementation phase must resume the workflow.

## Problem

An implementation phase can be reviewed, authorized, and committed successfully while durable workflow state still awaits the separate successor handoff. If another commit advances the branch during that window, ArchFlow no longer recognizes the authorized phase commit because the proof currently depends on that commit still being the branch tip.

When the later commit also changes files in the completed phase's output set, ArchFlow correctly detects post-review drift and opens a baseline-adoption decision. Choosing **Keep the current versions** records the new file digests, but it does not restore phase-completion eligibility. Status then retries the original exact-tip commit check, discards the now-unusable commit facts, and returns an inspection state with no supported recovery action.

The reported implementation-phase failure conflates three facts that need distinct treatment:

1. the exact phase output that was reviewed and authorized;
2. whether the exact authorized implementation commit actually occurred; and
3. which file versions the human currently accepts as the repository baseline after later work.

Design milestones expose the same underlying problem even when no projected file changed: their exact commit can cease to count as soon as a later commit becomes the branch tip. The recovery guarantee therefore needs to cover every workflow milestone commit, while preserving the different document and implementation review boundaries.

The result is especially costly in long tasks: a small test-performance improvement intended to speed up many remaining phases can make the entire task impossible to continue without unsupported state edits or artificial Git operations.

## Users and Situations

The primary user is a human working with an AI agent on a multi-phase ArchFlow task. Common situations include:

- optimizing slow tests between phases;
- making a small maintenance or debugging edit outside the active phase;
- committing durable workflow records after an implementation commit;
- merging or committing unrelated repository work;
- changing a file that an earlier completed phase produced; and
- reaching the same condition after the final phase commit but before task completion is recorded.

## Goals

- Let normal repository work coexist with an in-progress ArchFlow task.
- Preserve task-design, phase-design, and implementation milestone completion once the exact authorized commit is provably present in the current target's history.
- Reconcile later file drift independently from proof of the earlier authorized commit.
- Guarantee an actionable continuation or fresh-review path for valid, representable repository states.
- Preserve explicit human control, exact-byte authority, and honest descriptions of what was and was not reviewed.
- Eliminate the need to edit authenticated state directly, create synthetic commits or merges, or reconstruct an already-created commit solely to unstick the workflow.

## Non-Goals

- Silently accepting changed files or bypassing an offered human decision.
- Treating a later descendant commit as though it were the reviewed and authorized phase commit.
- Weakening task-design or phase-design milestone authority, implementation commit authorization, task isolation, review, verification, or state-authentication boundaries.
- Guaranteeing the quality or intent of out-of-band changes that the human elects to adopt without fresh review.
- Automatically accepting rewritten or unrelated history when the original authorized commit can no longer be proven.
- Redesigning Git, the entire baseline-adoption interface, or the general phase state machine beyond what recoverable repository movement requires.

## Product Requirements

### R1. Authorized workflow milestones survive ordinary descendant commits

Once an exact task-design, phase-design, or implementation milestone commit can be proven to have occurred under its applicable authority and remains reachable in the current authorized target's history, later descendant commits must not erase that completion fact.

- An unrelated descendant commit must leave the successor or task-completion action available without opening a baseline decision.
- A workflow-record commit must behave like any other unrelated descendant commit.
- The same behavior must apply to human-authorized and authenticated rule-authorized design and implementation milestones while preserving their distinct confirmation semantics.
- The workflow must not require an authorized milestone commit to remain the current branch tip after it has occurred.

### R2. Current baseline and historical commit proof are reconciled separately

Later changes to files in a completed phase's projected output set must continue to trigger the applicable baseline reconciliation.

- The decision must be bound to the exact live set of changed or deleted paths and to the versions the human is deciding about.
- Choosing to keep current versions must record those exact versions as the current accepted baseline without claiming they received fresh counter-review or commit authorization.
- Choosing to restore recorded versions must remain available when the retained bytes can be restored safely.
- A later change after an adoption must create a fresh reconciliation decision; adoption must not immunize a path from future drift detection.
- A later phase result that legitimately produces the same path must supersede the older baseline record through the normal output rules.

### R3. A resolved baseline decision always leads to a usable next action

After an applicable baseline-adoption decision settles, ArchFlow must recompute authority and return a supported semantic action.

- If the earlier exact authorized implementation commit is provably reachable and current drift has been adopted or restored, the workflow must allow the successor phase handoff or final task completion.
- ArchFlow must not replay stale commit facts, ask the client to recreate the old commit, or return a generic inspection state solely because the target advanced after that commit.
- The same guarantee applies when one or more later commits follow the maintenance change before status is requested.
- No offered adoption or restore choice may settle into a state that the semantic workflow cannot leave.

### R4. Missing historical milestone proof fails safely and recoverably

If the exact authorized task-design, phase-design, or implementation milestone commit cannot be proven, ArchFlow must not infer that it occurred or transfer its authority to a later commit.

- Movement that happened after authorization but before the authorized commit was created must be distinguished from ordinary descendants of an already-created commit.
- Rewritten, replaced, or unrelated target history must not be accepted as proof of the original commit.
- An unchanged design subject that remains eligible for the existing server-proven autonomous milestone-baseline refresh may use that bounded recovery without re-reviewing unchanged bytes.
- Otherwise, the workflow must re-enter the milestone's owning task-design, phase-design, or implementation position as a significant revision with current repository bytes preserved, then run the fresh production, review, approval or rule settlement, verification where applicable, and commit handling required by that subject.
- Inspection may remain appropriate for corrupt or genuinely unverifiable authority, but it must not be the terminal response to ordinary branch advancement. Any inspection response must identify an actionable recovery rather than requiring authenticated state edits.

### R5. Committed and uncommitted maintenance remain representable

Free-form work may be committed, uncommitted, or accompanied by unrelated changes.

- Already-committed maintenance must not require a synthetic follow-up commit merely to fit the workflow.
- Current worktree versions may be presented for adoption where existing baseline rules allow it.
- If adopted bytes are not committed, the human-facing result must state that a fresh clone recovers only the last committed repository and durable workflow boundary.
- Unrelated worktree or commit changes outside the reconciled output set must be preserved and must not expand the authority granted by adoption.

### R6. Human presentation remains explicit and honest

The user-facing decision must explain, in plain language:

- which practical file changes or deletions require a decision;
- whether keeping them performs fresh review or only accepts them as the current baseline;
- the consequence of restoring recorded versions; and
- when the workflow instead needs a significant revision and fresh review.

The agent must never choose a returned decision for the human. Settlement must revalidate the observed bytes and relevant Git facts so concurrent changes produce a fresh decision rather than applying a stale one.

### R7. Recovery works at every completion boundary

Equivalent repository movement must be recoverable when it occurs:

- after a task-design or phase-design milestone commit but before its successor handoff is consumed;
- after the phase commit but before the successor handoff is consumed;
- after phase advancement while later work is active; and
- after the final planned phase commit but before task completion is recorded.

The current phase and task history must remain truthful throughout; recovery must not silently move work to the wrong phase or read another task's files.

### R8. Maintained documentation matches the behavior

The maintained documentation must describe the separation between historical phase-commit proof and the current adopted baseline, the supported recovery paths, and the fact that adoption is not review. Pages covering lifecycle, durable state, semantic status/actions, review boundaries, and the whole-system overview must be updated when their described behavior changes.

## Acceptance Scenarios

1. **Unrelated implementation descendant:** Phase 1's exact authorized implementation commit is created. An unrelated commit advances the same branch before the handoff. Status still allows entry to Phase 2 and does not open baseline adoption or inspection.
2. **Unrelated design descendant:** An exact authorized task-design or phase-design milestone commit is created. A maintenance or workflow-record commit advances the same branch before the successor handoff. Status still allows the planned successor and does not return inspection solely because the milestone is no longer the branch tip.
3. **Reported performance-maintenance journey:** Phase 1's exact authorized commit is created. A later committed test-performance change modifies several Phase 1 output files, and a subsequent workflow-record commit advances the branch again. ArchFlow opens the exact baseline decision. Choosing to keep current versions leads to Phase 2 without a synthetic commit or state edit.
4. **Restore journey:** The same projected-file drift occurs, but the human chooses to restore retained reviewed versions. The restore completes safely and the Phase 2 handoff becomes available.
5. **Fresh-authority journey:** The target moved but the exact authorized task-design, phase-design, or implementation milestone commit never occurred or is no longer provably reachable. ArchFlow does not report completion. An unchanged, eligible autonomous design subject receives the bounded milestone-baseline refresh; other cases re-enter the owning position as a significant revision that can complete normally.
6. **Final phase:** A later descendant commit occurs after the final authorized implementation commit. Unrelated changes still allow task completion; projected drift allows completion after a valid adoption or restore decision.
7. **Repeated drift:** The human adopts current versions, files change again, and ArchFlow opens a fresh decision. Resolving it again returns a usable successor or completion action.
8. **Both authority modes:** Design and implementation descendant journeys, plus projected implementation drift, succeed for human authority and authenticated no-wait rule authority without conflating their distinct confirmation semantics.
9. **Stale decision race:** Files or relevant target history change after the decision is presented but before it settles. The stale decision is refused and fresh status presents the current recovery path.
10. **Uncommitted current versions:** The human adopts eligible worktree changes. ArchFlow preserves them, discloses their recovery limitation, and does not claim they were reviewed or committed.

## Assumptions

- The existing baseline-adoption model remains the primary human decision for post-review projected-file drift.
- Normal continuation can prove that the original authorized milestone commit remains an ancestor of the current authorized target; losing that ancestry is a different recovery case.
- Later implementation phases remain responsible for reviewing the files and changes they actually declare and touch.
- Material changes to requirements, architecture, interfaces, trust boundaries, or verification claims still require the governing documents to be updated and re-reviewed through existing workflow rules.
- Existing task isolation, canonical state, digest validation, and explicit-human-gate rules remain authoritative.

## Risks

- **Retroactive over-authorization:** A descendant-aware completion check could accidentally treat later maintenance as reviewed design or implementation output. Historical milestone proof and current baseline adoption must remain separately represented and described.
- **False history match:** Rebases, squashes, resets, cherry-picks, target replacement, or detached history could resemble ordinary advancement. Recovery must fail closed unless the exact authorized commit and relevant target relationship are proven.
- **Misleading adoption language:** Users may interpret “reviewed baseline” as fresh code review. The presentation and docs must state that adoption accepts current bytes without counter-review.
- **Uncommitted durability gap:** Digest-only adoption of worktree bytes cannot make those bytes recoverable in a fresh clone. The workflow must disclose that limitation without turning it into a repository lock.
- **Race conditions:** A gate could be decided against bytes or history that changed after presentation. Settlement must revalidate both.
- **Excess machinery:** The fix could grow into a generalized Git-history subsystem. The design should implement only the proof and recovery paths required for ordinary descendant movement and safe failure.

## Observable Success Criteria

- The reported commit sequence can continue to Phase 2 after **Keep the current versions** without manual state changes, history rewriting, or artificial commits.
- An unrelated commit between an authorized task-design, phase-design, or implementation milestone commit and its handoff no longer blocks progress.
- ArchFlow never reports that a later descendant commit itself was reviewed or authorized when only the earlier exact commit was.
- When the original milestone commit is missing or no longer provable, status returns either the eligible unchanged-design baseline refresh or a significant-revision route at the owning workflow position instead of falsely advancing or dead-ending on ordinary inspection.
- Repeated post-phase maintenance and the final-phase equivalent remain recoverable.
- Automated integration coverage exercises design and implementation descendant commits, projected-file adoption, restoration, missing historical proof, both authority modes, final completion, and stale decision settlement.
- Maintained documentation and human gate copy accurately explain the resulting behavior and trust boundary.
