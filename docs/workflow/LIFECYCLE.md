# workflow/LIFECYCLE

**Explored:** 2026-08-13 · **Commit:** `247df34` · **Covers:** `assets/workflow.yaml`, `src/contracts/workflow.ts`, `src/contracts/gates.ts`, `skills/`

How a task moves from idea to committed code, and where a human must decide.

## The phase graph

The canonical graph lives in `.archflow/workflow.yaml` (shipped from `assets/workflow.yaml`, mirrored as a hard-coded constant in `src/contracts/workflow.ts`). It is short and declarative — five phases, four attributes each: the owning skill, dependency edges (`requires`), whether the phase iterates per phase number, and the gate policy.

```mermaid
flowchart LR
    Explore["explore<br/><i>optional, no gate</i>"] -.-> PRD
    PRD["prd<br/><i>gate: always</i>"] --> Design["design<br/><i>gate: always</i>"]
    Design --> PD["phase-design N<br/><i>per phase, gate: on_trigger</i>"]
    PD --> PI["phase-impl N<br/><i>per phase, gate: on_trigger</i>"]
    PI -->|next phase| PD
    PI --> Done([task complete])
```

One nuance the YAML alone doesn't show: `gate: on_trigger` refers to constitution obligations derived after triage. PRD and phase implementation may surface those as their own gate before their mandatory final approval. Task design and phase design instead fold every constitution finding into one mandatory `design-approval`; they never ask for constitution approval and then document approval. Phase implementation still ends at `commit-authorization`. In practice **every phase ends at one final human decision, with earlier trigger gates only where the phase contract keeps them distinct.**

That decision does not silently rewrite the phase. Approval commits first; the active producer then automatically composes the server-derived `advance` operation and re-runs status until the successor or terminal state is durable. This separation preserves replay and auditability without leaving a customer action gap. If a session stops between the two commits, status recommends the exact destination skill and arguments, and that invocation can complete only its authenticated immediate-predecessor hand-off.

The workflow file's bytes are digest-pinned into each task at creation, so changing the graph mid-task is detectable, not silently applied. Tasks pinned to the retired four-step workflow digest (the one with a separate `adjudicate` step) are invalidated — status reports `restore-pinned-config` — and either restart or go through `archflow-upgrade`; there is no migration. The routing config takes the opposite lesson from the `producer` role's removal: the retired key is accepted on read exactly like the retired `independence` evidence field, so a config pinned with it keeps working unchanged and its bytes stay pinned. If pinned config bytes ever fail to parse under the installed tooling, status reports `pinned-config-schema-unsupported` with an `upgrade-tooling` action — resume with tooling that accepts the pinned config, or restart; there is still no migration.

## What each stage produces

| Stage | Skill | Artifact | Human approval |
|---|---|---|---|
| explore | `archflow-explore` | the maintained `docs/` set (`OVERVIEW.md`, `section/FILE.md`, stamped with commit + coverage) | review + commit confirmation (not a server gate) |
| task creation | any phase skill | `config.yaml` (byte-pinned), `state.json` | — |
| prd | `archflow-prd` | `ask.md` (verbatim request plus clarification Q&A), `prd.md` | `artifact-approval`, always |
| design | `archflow-design` | `design.md` with a machine-readable `### Phase N:` plan, plus the current `prd.md` projection | one `design-approval` containing the complete document set and constitution findings; approval authorizes the task-local milestone commit |
| phase-design | `archflow-phase-design` | `phases/<n>/design.md`, plus the current `design.md` and `prd.md` projections | one `design-approval` containing the complete document set and constitution findings; approval authorizes the task-local milestone commit |
| phase-impl | `archflow-phase-impl` | code, tracked `phases/<n>/impl-notes.md`, digest-bound ignored verification transcript | one `commit-authorization` bound to the retained final diff; the resulting commit action is nonhuman |
| status | `archflow-status` | nothing — read-only | surfaces gates, resolves none |

Tracked task documents and authority live under `.archflow/tasks/<task>/`; transient, cache, and diagnostic bytes live under ignored `.archflow/runtime/tasks/<task>/`. Both resolvers enforce the same containment, symlink, and task boundary. The only shared material is repository policy and the maintained `docs/` set. **Tasks never read each other's files** — this isolation is real and test-enforced.

## The pipeline inside each gated stage

Every gated stage runs the same evidence pipeline to a fixed point:

1. **produce** — write or revise the artifact. Its SHA-256 becomes the *subject digest*. Both design stages are deliberately compound: task design records `design.md` with the current `prd.md`, while phase design records its primary phase document with the current `design.md` and `prd.md`. Planning can therefore correct governing documents without creating unauthenticated drift. Parents remain in the result even when unchanged; this preserves the phase's ownership of their current projections across retries. The PRD producer performs one bounded, deterministic author checklist; other phases may use a same-side review sized to their risk. Nothing here becomes review authority — the first recorded review is the server-dispatched one.
2. **counter_review** — one tool call, up to two dispatches, one atomic commit. The server dispatches the configured reviewer (opposite family by default, same family only by explicit config) against a sealed control envelope plus a server-built read-only repository view — evidence the producer cannot author. For implementations, retained after-images are applied to the attested baseline so the child reviews the exact post-change tree without transporting source files through JSON. Then, only when the pinned constitution has active rules (the server decides, never the agent), a second reviewer child receives its own sealed envelope and the same repository snapshot for constitution and drift review. Both results commit in one atomic state transaction; `constitution: {status: "not-run"}` simply means no active rules exist.
3. **triage** — the producer must disposition **every** rubric finding, one of three ways:
   - **accepted** — the finding demands a substantive fix; the work re-enters produce and all evidence is redone against the new bytes.
   - **accepted-editorial** — the fix is purely wording or formatting and the finding is non-blocking (the server refuses this disposition for blocking findings). See the editorial path below.
   - **rejected** — with a written rationale. Findings prefixed `unverifiable-` mean "the reviewer lacked evidence," and are rejected with an `envelope-gap:` rationale, never accepted.

   The constitution verdict is never triaged. For PRD and phase implementation, a failing or uncertain rule, matched `review_trigger`, or material drift opens a human gate after triage. For task design and phase design, those same findings are carried into the final `design-approval` presentation with their rationale and evidence, so the human gets one self-contained decision rather than a constitution decision followed by document approval.

Editing the artifact changes the subject digest, which normally invalidates all downstream evidence — the pipeline re-runs until everything agrees about the same bytes. Re-entry is bounded (`max_attempts`, default 3); exhaustion opens an `attempts-exhausted` gate rather than looping forever. A significant human revision begins a new cycle at attempt 1, so exhaustion counts only attempts since the latest such revision.

**What actually ends the loop is triage, not the finding count.** The exit condition is `accepted_count === 0` — a plain `accepted` disposition is the only thing that forces another round (`src/review/fixed-point.ts`). A model-labeled blocker that triage rejects does not continue the loop. The producer accepts every material defect and rejects anything that cannot show a concrete downstream consequence. On later rounds the sealed instruction makes remediation verification primary and permits a new issue only when leaving it unchanged is reasonably likely to change behavior, verification, delivery, approval, or important risk.

`status.evidence.findings` retains each finding and disposition for audit, but ordinary human approval is not used to triage model polish. Rejected non-material observations stay out of the approval agenda. An envelope gap is disclosed there only when it prevented a material judgment; an `attempts-exhausted` gate instead presents the unresolved material defect and asks whether another revision is warranted.

### The editorial revision

When a round's only accepted findings are `accepted-editorial`, the producer applies exactly the recorded revision intents and records produce again — and **nothing re-runs**. The revised artifact declares a server-validated, strictly one-hop `editorial_predecessor` link — `{subject_digest, input_fingerprint, triage_result_digest}` naming the exact reviewed bytes, their inputs, and the triage round that authorized the hop. The retained reviews *and* the constitution verdict stay bound to the declared predecessor for that one hop, and the eventual human gate presents the predecessor→final diff with an explicit disclosure that the evidence evaluated the predecessor bytes. A plain `accepted` disposition anywhere in the round still forces full re-entry — the editorial path exists only for rounds that are editorial through and through.

An editorial round consumes an attempt slot like any other re-entry. That is deliberate: if editorial rounds push a task to its attempt cap, the `attempts-exhausted` gate's retry decision is the intended recovery, keeping the human in the loop rather than letting cosmetic churn extend the loop silently.

### Human revisions after a gate

When the human requests changes at a gate, the producer applies them and classifies the actual diff, explaining the result in plain language. A **simple** revision is strictly typo, formatting, comment, or wording-only work that changes no meaning, behavior, scope, interface, trust boundary, input, verification claim, or parent document. It keeps the attempt count and may retain the predecessor's review and constitution evidence for one hop, but the exact small diff is shown and the final bytes always return to the human for approval. A **significant** revision is anything else; uncertainty defaults to significant. It archives old evidence as history, resets the attempt counter to 1, and automatically dispatches a fresh rubric review and constitution review before another gate. The human may override the producer's classification in either direction, and the override is durable. A design-stage retry always re-records its writable parents with the primary document, preventing an unchanged parent from falling back to an older approval merely because only the primary document changed in the latest revision.

This replaces the former supplemental gate-review loop. There is no optional review after a gate: the ordinary server-dispatched review is automatic before it, and repeats automatically only when a significant human change makes the prior judgment stale.

### The transition edges, precisely

Beyond the forward hand-off (each succeeded step to its successor, same attempt), the state machine (`src/state/transitions.ts`) admits exactly one other same-phase move:

- **any-succeeded step → produce-running (attempt + 1)** — the "new information" door. From triage this is the accepted-finding (or editorial) re-entry; from a succeeded produce or counter_review it is the author withdrawing to incorporate new information. Downstream evidence simply goes stale and is redone — except on the one-hop editorial path, where retained evidence stays bound to the declared predecessor. The same write-window rule applies to an initial phase attempt: once state durably sits at produce running (or failed), implementation edits—including changes to paths projected by an earlier phase—are expected production work, not material drift. Terminal produce seals the new exact subject.

An explicit human-requested **planning restart** is the separate backward edge. From any active nonterminal phase, with no gate open, it may target only a strictly earlier planning position in the total order `prd → design → phase-design-N → phase-impl-N → phase-design-(N+1)`. Restart enters the target at `produce: running` attempt 1, preserves Git and worktree bytes, archives target-and-downstream result references in `restart_history`, clears their active authority plus all waivers and pending human revision, and clears `planned_final_phase` when reopening PRD or task design. Reopening the current planning stage uses ordinary produce re-entry. A material-drift decision of `amend-upstream` invokes this same primitive from its authenticated gate instead of leaving the task stranded at triage.

The phase-completion signal fires from **triage-succeeded**: once triage closes the fixed point, the phase can advance — for phase-impl that is what arms the commit-authorization flow, and the legacy-import design jump fires from the same point. `advance-phase` and `complete-task` are executable actions, not reports: `build-request` kind `advance` recomputes status, derives the successor, and stages the existing `archflow_state` operation. PRD re-verifies `artifact-approval`. Design boundaries re-verify `design-approval` and refuse to advance until Git proves the approved task-local commit is the direct child of the bound baseline, contains every document in the approved result plus durable decision authority, touches no other task, and leaves the task root clean.

## Gates: where humans decide

Nine gate kinds exist (`src/contracts/gates.ts`):

| Gate kind | Opens when |
|---|---|
| `artifact-approval` | a PRD reaches its fixed point; archived legacy design gates remain readable and finish under their original contract |
| `design-approval` | task design or phase design reaches its fixed point; one decision includes document approval, constitution findings, and task-local milestone commit authority |
| `commit-authorization` | a phase implementation is ready to commit |
| `constitution-review` | the constitution review found a rule `fail`/`uncertain`, or a rule's `review_trigger` matched, or both (derived after triage; one gate discloses both axes and offers a waiver per rule *and* axis) |
| `material-drift` | an approved upstream document drifted materially (derived after triage); `amend-upstream` durably restarts at the affected planning document |
| `attempts-exhausted` | the produce/review loop hit its attempt cap (status prefills its request; `build-request` composes only the approval kinds, so complete it through `archflow-local envelope`) |
| `constitution-edit` | legacy compatibility for previously opened policy-edit gates; current counter-review does not emit this gate because task policy is already pinned immutably |
| `restore-collision` | a drift repair would overwrite conflicting bytes |
| `migration-audit` | an atomically adopted legacy import has completed its automatic design review and triage; one decision binds every imported document digest, phase plan, commit authority, and the derived phase-design or phase-implementation resume point |

Every gate is a durable pair of canonical documents (request + decision record) bound to a gate ID, context digest, subject digest, and the current evidence set. Decisions carry human provenance. Two properties keep them honest:

- **Supersession**: if the subject changes while a gate is open, the gate returns `GATE_SUPERSEDED` and approves nothing — the work re-enters the pipeline and a fresh gate opens.
- **Re-verification**: later code never trusts a recorded approval reference alone; it re-reads and re-validates the underlying documents.

The machine bindings above are audit authority, not the default human interface. The server also derives a reconstructible conversational presentation: a title, summary, direct question, relevant evidence, and labeled choices with consequences. Skills show that presentation and hide identifiers, digests, JSON, internal paths, and protocol codes unless the human asks for diagnostics.

## Hard trust boundaries

These rules recur across every skill and are enforced by the server wherever mechanically possible:

- **Nothing is approved until a human explicitly decides, on the exact bytes.** Silence, elapsed time, agent prose, or a model verdict never supplies approval. Skills re-run `status` after a gate rather than trusting conversation memory.
- **No code before approved phase design.** Durable state must say `phase-impl-<n>`; a design file existing on disk is explicitly insufficient.
- **Every commit has one human lock.** The skill first runs `gate-preview`, presents its conversational decision and choices, and asks once. `build-request` recomputes that preview and carries `{choice, reason}` into one bounded gate call; the connected handler archives and resolves it synchronously instead of waiting for `archflow-local decide`. Implementation `commit-authorization` binds the retained final diff, exact target ref, baseline, message, and sorted paths. Approval exposes nonhuman `commit-phase`; design and migration approval similarly expose nonhuman `commit-artifacts`. Input-free `archflow-local commit` re-derives the current authority and commits only those paths, preserving unrelated index/worktree state. Design and migration previews bind the exact task root, target, baseline, and message but do not claim a pre-decision final diff digest, because their final archive includes server-minted time/random provenance created after approval. Because the design milestone covers the whole task directory, an unapproved task document sitting in it would ride along unreviewed; status refuses the commit and says which file is in the way rather than making a commit it would then have to reject — and once such a commit exists, it reports the mismatch and asks a human to look instead of re-offering a step that can no longer succeed.
- **Every nonterminal hand-off is explicit for both clients.** Skills print the exact server-derived successor as `Claude: /<skill> ...` and `Codex: $<skill> ...`; terminal completion prints no next command.
- **Waivers are narrow.** A `waiver-requested` decision is not approval; a granted waiver covers one rule version + one subject digest + one task, and evaporates on any change.
- **Fail closed, honestly.** With the MCP server unavailable nothing records progress — degraded mode is a read-only status, not an offline workflow; `repair-required` states never become progress; "task complete" means the last planned phase is committed — it does not imply QA, staging, or release.

## Merging main into a task branch

Task branches live long enough that merging `main` becomes routine, and the design intends it to be a non-event: every pin reads either the task's own files or the immutable `policy_base_commit` tree, never `HEAD`, so a merge that does not touch `.archflow/` changes no pinned digest and trips no baseline check. The workflow graph, constitution, and routing config a task answers to are exactly what they were before the merge; status simply continues the current phase.

Two windows need care, and both are about commit proofs, not pins:

- **Do not merge between an approval and its authorized commit.** Design `design-approval` and implementation `commit-authorization` bind the commit that was `HEAD` when the human decided, and the proof requires the authorized commit to be its direct child with `HEAD` still in place. A merge in that window moves `HEAD`, the milestone can no longer be recognized, and status correctly refuses to re-offer a commit that cannot succeed — the decision is taken again against the new baseline. Merge before opening the gate, or after the authorized commit has landed.
- **During phase implementation, merged files are ordinary incoming changes.** The implementation proof only requires the approved base to remain an ancestor, so a merge is safe mid-implementation; but merged files surface in the undeclared-change scan and must be folded into the declared outputs (or the phase design revised) before the final diff is authorized.

If a merge does conflict inside `.archflow/` — only possible when both branches carry it, for example two task branches — `.gitattributes` marks those files binary: resolve by taking one side wholesale rather than merging line-by-line, because a hand-merged state file matches no recorded digest.

## Where this is heading

The lifecycle above is the current, MCP-backed workflow; the legacy skill-only flow it replaced lives in git history. For auditing which parts of the machinery earn their weight, start with `../COMPLEXITY.md`.
