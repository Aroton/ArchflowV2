# workflow/LIFECYCLE

**Explored:** 2026-08-21 · **Commit:** `869c189` · **Covers:** `assets/workflow.yaml`, `src/contracts/workflow.ts`, `src/contracts/gates.ts`, `src/contracts/config.ts`, `src/state/approval-rules.ts`, `src/state/semantic-*.ts`, `src/mcp/handlers/semantic.ts`, `skills/`

How a task moves from idea to committed code, and where a human must decide.

## The phase graph

The canonical graph lives in `.archflow/workflow.yaml` (shipped from `assets/workflow.yaml`, mirrored as a hard-coded constant in `src/contracts/workflow.ts`). It is short and declarative — five phases, four attributes each: the owning skill, dependency edges (`requires`), whether the phase iterates per phase number, and the gate policy.

```mermaid
flowchart LR
    Explore["explore<br/><i>optional, no gate</i>"] -.-> PRD
    PRD["prd<br/><i>approval-rule subject</i>"] --> Design["design<br/><i>approval-rule subject</i>"]
    Design --> PD["phase-design N<br/><i>per phase, gate: on_trigger</i>"]
    PD --> PI["phase-impl N<br/><i>per phase, gate: on_trigger</i>"]
    PI -->|next phase| PD
    PI --> Done([task complete])
```

One nuance the YAML alone doesn't show: project `approval_rules` decide whether an ordinary clean fixed point waits for a human. A waiting settlement preserves the exact subject/content reason for the presentation. An exact no-wait settlement under the shipped v2 constitution can instead supply upstream, milestone-commit, phase-exit, or successor authority directly. It is evidence the server authenticates, never caller authority; legacy or divergent policy and every exception condition remain human-required.

The optional config section has two lists. `subjects` accepts `prd`, `design`, `phase-design`, and `phase-impl`. `content` entries each carry repository-relative path globs and are considered only for a phase implementation. Matching is whole-path, case-sensitive, and `/`-segmented: `*` and `?` stay within one segment, while `**` spans zero or more complete segments (`**/*.sql` therefore matches both `a.sql` and `db/a.sql`). An absent or empty section records `wait:false`.

An implementation content match is more than a path list at presentation time. The settlement freezes the complete matched-path set; the server joins those paths to the retained implementation output to reconstruct each operation and exact signed byte delta. Rename endpoints are evaluated independently: the old path, new path, or both can match, and a rename away followed by a new add at the old name keeps both operations. This evidence is sorted deterministically and survives later `approval_rules` edits unchanged. A waiting conclusion explains the reviewed diff at the human gate; a no-wait conclusion is consumed only through separately derived exact commit facts.

That decision does not silently rewrite the phase. Approval commits first; the active producer then automatically composes the server-derived `advance` operation and re-runs status until the successor or terminal state is durable. This separation preserves replay and auditability without leaving a customer action gap. If a session stops between the two commits, status recommends the exact destination skill and arguments, and that invocation can complete only its authenticated immediate-predecessor hand-off.

The workflow file's bytes are digest-pinned into each task at creation, so changing the graph mid-task is detectable, not silently applied. Tasks pinned to the retired four-step workflow digest (the one with a separate `adjudicate` step) are invalidated and either restart or go through `archflow-upgrade`; there is no graph migration. Task routing config is deliberately different: every dispatch or state transaction reads the live task-local file, records the parsed shape as `last_seen_config`, and later status calls report field-level changes without invalidating retained evidence or gates. The retired `producer` role remains accepted on read; other invalid or unknown fields block as `config-invalid` until the human fixes the file.

## What each stage produces

| Stage | Skill | Artifact | Human approval |
|---|---|---|---|
| explore | `archflow-explore` | the maintained `docs/` set (`OVERVIEW.md`, `section/FILE.md`, stamped with commit + coverage) | review + commit confirmation (not a server gate) |
| task creation | any phase skill | mutable task-local `config.yaml`, `state.json` | — |
| prd | `archflow-prd` | `ask.md` (verbatim request plus clarification Q&A), `prd.md` | `artifact-approval` only when a rule or safety condition requires it; otherwise direct successor authority |
| design | `archflow-design` | `design.md` with a machine-readable `### Phase N:` plan, plus the current `prd.md` projection | conditional `design-approval`; otherwise an exact autonomous milestone commit and successor |
| phase-design | `archflow-phase-design` | `phases/<n>/design.md`, plus the current `design.md` and `prd.md` projections | conditional `design-approval`; otherwise an exact autonomous milestone commit and implementation hand-off |
| phase-impl | `archflow-phase-impl` | code, tracked `phases/<n>/impl-notes.md`, digest-bound ignored verification transcript | conditional `commit-authorization`; exact commit facts distinguish separate human confirmation (`true`) from rule-authorized direct execution (`false`) |
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

On the semantic document path, both an explicit triage submission and review's empty-finding fast path first record `triage: running` through the authenticated `triage-enter` substep. Terminal triage therefore never appears without its normal state-machine entry boundary.

The transaction that first establishes a clean fixed point also evaluates `approval_rules` and persists its complete conclusion. Subject rules apply to all four workflow subjects; content globs are evaluated only for phase implementation. For a content match, the settlement freezes every matching path; joining that set to the retained output supplies the complete per-path operation and exact signed size change, including both independently matched rename endpoints and overlapping rename/add effects. An absent or empty section records `wait:false`; the exact authenticated v2 policy consumes that conclusion autonomously after mandatory review, while a waiting conclusion opens the relevant human gate. Later config edits may be reported alongside a gate or status view without retroactively changing a settlement, and a planning restart makes old settlements ineligible.

Editing the artifact changes the subject digest, which normally invalidates all downstream evidence — the pipeline re-runs until everything agrees about the same bytes. Re-entry is bounded (`max_attempts`, default 3); exhaustion opens an `attempts-exhausted` gate rather than looping forever. A significant human revision begins a new cycle at attempt 1, so exhaustion counts only attempts since the latest such revision.

**What actually ends the loop is triage, not the finding count.** The exit condition is `accepted_count === 0` — a plain `accepted` disposition is the only thing that forces another round (`src/review/fixed-point.ts`). A model-labeled blocker that triage rejects does not continue the loop. The producer accepts every material defect and rejects anything that cannot show a concrete downstream consequence. On later rounds the sealed instruction makes remediation verification primary and permits a new issue only when leaving it unchanged is reasonably likely to change behavior, verification, delivery, approval, or important risk.

`status.evidence.findings` retains each finding and disposition for audit, but ordinary human approval is not used to triage model polish. Rejected non-material observations stay out of the approval agenda. An envelope gap is disclosed there only when it prevented a material judgment; an `attempts-exhausted` gate instead presents the unresolved material defect and asks whether another revision is warranted.

### The editorial revision

When a round's only accepted findings are `accepted-editorial`, the producer applies exactly the recorded revision intents and records produce again — and **nothing re-runs**. The revised artifact declares a server-validated, strictly one-hop `editorial_predecessor` link — `{subject_digest, input_fingerprint, triage_result_digest}` naming the exact reviewed bytes, their inputs, and the triage round that authorized the hop. The retained reviews *and* the constitution verdict stay bound to the declared predecessor for that one hop, and the eventual human gate presents the predecessor→final diff with an explicit disclosure that the evidence evaluated the predecessor bytes. A plain `accepted` disposition anywhere in the round still forces full re-entry — the editorial path exists only for rounds that are editorial through and through.

An editorial round consumes an attempt slot like any other re-entry. That is deliberate: if editorial rounds push a task to its attempt cap, the `attempts-exhausted` gate's retry decision is the intended recovery, keeping the human in the loop rather than letting cosmetic churn extend the loop silently.

### Human revisions after a gate

When the human requests changes at a gate, the producer applies them and classifies the actual diff, explaining the result in plain language. A **simple** revision is strictly typo, formatting, comment, or wording-only work that changes no meaning, behavior, scope, interface, trust boundary, input, verification claim, or parent document. It keeps the attempt count and may retain predecessor review and constitution evidence for one hop, but it cannot resolve or suppress an accepted material finding. The exact small diff is shown and the final bytes always return to the human for approval. A **significant** revision is anything else; uncertainty defaults to significant. It archives old evidence as history, resets the attempt counter to 1, and automatically dispatches fresh reviews before another gate. The human may override the producer's classification in either direction, and the override is durable.

This replaces the former supplemental gate-review loop. There is no optional review after a gate: the ordinary server-dispatched review is automatic before it, and repeats automatically only when a significant human change makes the prior judgment stale. The `baseline-adoption` gate opens before any review by design: it is not approval of produced work but a human decision about which bytes are the reviewed baseline after they drifted.

### The transition edges, precisely

Beyond the forward hand-off (each succeeded step to its successor, same attempt), the state machine (`src/state/transitions.ts`) admits exactly one other same-phase move:

- **any-succeeded step → produce-running (attempt + 1)** — the "new information" door. From triage this is the accepted-finding (or editorial) re-entry; from a succeeded produce or counter_review it is the author withdrawing to incorporate new information. Downstream evidence simply goes stale and is redone — except on the one-hop editorial path, where retained evidence stays bound to the declared predecessor. The same write-window rule applies to an initial phase attempt: once state durably sits at produce running (or failed), implementation edits—including changes to paths projected by an earlier phase—are expected production work, not material drift. Terminal produce seals the new exact subject.

An explicit human-requested **planning restart** is the separate backward edge. From any active nonterminal phase, with no gate open, it may target only a strictly earlier planning position in the total order `prd → design → phase-design-N → phase-impl-N → phase-design-(N+1)`. Restart enters the target at `produce: running` attempt 1, preserves Git and worktree bytes, archives target-and-downstream result references in `restart_history`, clears their active authority plus all waivers and pending human revision, and clears `planned_final_phase` when reopening PRD or task design. Reopening the current planning stage uses ordinary produce re-entry. A material-drift decision of `amend-upstream` invokes this same primitive from its authenticated gate instead of leaving the task stranded at triage.

The phase-completion signal normally fires from **triage-succeeded**: once triage closes the fixed point, the phase can advance through either authenticated human authority or an eligible exact no-wait settlement. Accepted-editorial re-entry can re-establish the reviewed fixed point at **produce-succeeded** using its exact retained predecessor evidence and may record a new rule settlement. A human-requested simple revision is different: it records no settlement, cannot clear an accepted material finding, and always returns to the human for approval of the final bytes. `advance-phase` and `complete-task` are executable actions, not reports: the semantic surface recomputes status and derives the successor before composing the operation. PRD and design boundaries re-authenticate the applicable human-or-rule authority; design also refuses to advance until Git proves the exact task-local milestone commit carries the complete reviewed document set and its bound authority.

An interrupted handoff has two authenticated owners: the current producer can complete the automatic advance, and a resume invocation for the exact server-derived successor may recover it. Semantic ownership implements that literally: `start-next-skill` is offerable only to the exact successor invocation, while ordinary actions belong only to the current document owner. A different phase number or skill receives the common view but no mutation offer.

### Reopening earlier planning work

Resume never means reopen. An explicit backward correction targets only a strictly earlier PRD, task design, or numbered phase design in the canonical total order. The server derives the target and ordered impact from the invoked skill plus current authority; phase implementation, same/current, forward, terminal, open-gate, repair, and reconciliation positions cannot be reopened.

One restart preserves existing repository bytes except for the PRD ask-history append, archives target-and-downstream results in durable restart history, clears active waivers and pending human revision into that history, resets the target to produce attempt 1, and forces fresh review and approval. PRD reopening appends the human's exact correction request to `ask.md`; task design and phase-design reopening do not. The operation binds the expected ask-prefix digest and validates the exact append on replay. Older approvals remain audit evidence but are cut off from authorizing the restarted generation.

## Gates: where humans decide

Ten gate kinds exist (`src/contracts/gates.ts`):

| Gate kind | Opens when |
|---|---|
| `artifact-approval` | a PRD reaches a fixed point with `wait:true`, or policy/safety requires judgment; archived legacy gates remain readable under their original contract |
| `design-approval` | task design or phase design reaches a fixed point with `wait:true`, or constitution policy requires judgment; one decision covers the complete document set, findings, and milestone commit authority |
| `commit-authorization` | a phase implementation reaches a fixed point with `wait:true`; content triggers show the operation and byte delta for every frozen matched path |
| `constitution-review` | the constitution review found a rule `fail`/`uncertain`, or a rule's `review_trigger` matched, or both (derived after triage; one gate discloses both axes and offers a waiver per rule *and* axis) |
| `material-drift` | an approved upstream document drifted materially (derived after triage); `amend-upstream` durably restarts at the affected planning document |
| `attempts-exhausted` | the produce/review loop hit its attempt cap (the gate composer's exhaustion arm derives it from the same fixed-point assessment status advertises) |
| `baseline-adoption` | files changed after the recorded review bytes they were left at — typically later commits or a merge — block reconciliation outside a produce window; the human either adopts the current bytes as the reviewed baseline (no re-review; the next implementation phase still reviews what it touches) or restores the recorded bytes; a file deleted by an already-committed change with an adoption-sourced record (no retained bytes to restore, no before-image to re-declare) offers adopting the committed deletion instead, retiring the stale recorded presence (the gate composer derives all three shapes from the reconciliation findings status advertises) |
| `constitution-edit` | legacy compatibility for previously opened policy-edit gates; current counter-review does not emit this gate because task policy is already pinned immutably |
| `restore-collision` | a drift repair would overwrite conflicting bytes |
| `migration-audit` | an atomically adopted legacy import has completed its automatic design review and triage; one decision binds every imported document digest, phase plan, commit authority, and the derived phase-design or phase-implementation resume point |

Every gate is a durable pair of canonical documents (request + decision record) bound to a gate ID, context digest, subject digest, and the current evidence set. Decisions carry human provenance. The semantic path archives a connected-host decision immutably and settles it in a separate nonblocking substep. A revision settlement closes the gate only; writable document resources stay hidden until `revise-enter` separately opens production. Two properties keep decisions honest:

- **Supersession**: if the subject changes while a gate is open, the gate returns `GATE_SUPERSEDED` and approves nothing — the work re-enters the pipeline and a fresh gate opens.
- **Re-verification**: later code never trusts a recorded approval reference alone; it re-reads and re-validates the underlying documents.

The machine bindings above are audit authority, not the default human interface. The server also derives a reconstructible conversational presentation: a title, summary, direct question, relevant evidence, and labeled choices with consequences. For a content-triggered implementation, the bounded archived summary carries the frozen trigger (with an omitted count if its path list is exceptionally large), while the semantic presentation keeps the complete deterministic operation and signed-byte-delta `details`. Those details are reconstructed from settlement plus retained output, never from mutable config or the live worktree. Skills show that presentation and hide identifiers, digests, JSON, internal paths, and protocol codes unless the human asks for diagnostics.

## Hard trust boundaries

These rules recur across every skill and are enforced by the server wherever mechanically possible:

- **Every gate that opens requires an explicit human decision on the exact bytes.** Silence, elapsed time, agent prose, or a model verdict never supplies approval. A clean no-wait result does not create a gate; the server must authenticate its settlement and return the next exact action.
- **No code before approved phase design.** Durable state must say `phase-impl-<n>`; a design file existing on disk is explicitly insufficient.
- **Every commit has exact durable authority.** A triggered document gate or implementation `commit-authorization` binds human authority to the reviewed subject and exact Git facts; an eligible no-wait settlement lets the server derive the same exact facts from rule authority. `requires_human_confirmation:true` alone requires the separate conversational confirmation; `false` is executed directly. Both branches verify baseline, target, sorted paths, staged diff, and message, then call read-only status for proof. Because a design milestone covers the whole task directory, an unrelated task document sitting in it would ride along unreviewed; status refuses the commit and identifies the obstruction.
- **Every nonterminal hand-off is explicit for both clients.** Skills print the exact server-derived successor as `Claude: /<skill> ...` and `Codex: $<skill> ...`; terminal completion prints no next command.
- **Waivers are narrow.** A `waiver-requested` decision is not approval; a granted waiver covers one rule version + one subject digest + one task, and evaporates on any change.
- **Fail closed, honestly.** With the MCP server unavailable nothing records progress — degraded mode is a read-only status, not an offline workflow; `repair-required` states never become progress; "task complete" means the last planned phase is committed — it does not imply QA, staging, or release.

## Merging main into a task branch

Task branches live long enough that merging `main` becomes routine, and the design intends it to be a non-event: immutable pins read either the task's own files or the `policy_base_commit` tree, never `HEAD`, so a merge that does not touch `.archflow/` changes no pinned digest and trips no baseline check. The task-local routing config likewise stays as the task branch left it; if a merge deliberately edits that file, normal live-config change reporting applies. Status otherwise simply continues the current phase.

Two windows need care, and both are about commit proofs, not pins:

- **Do not merge between an approval and its authorized commit.** Design `design-approval` and implementation `commit-authorization` bind the commit that was `HEAD` when the human decided, and the proof requires the authorized commit to be its direct child with `HEAD` still in place. A merge in that window moves `HEAD`, the milestone can no longer be recognized, and status correctly refuses to re-offer a commit that cannot succeed — the decision is taken again against the new baseline. Merge before opening the gate, or after the authorized commit has landed.
- **During phase implementation, merged files are ordinary incoming changes.** The implementation proof only requires the approved base to remain an ancestor, so a merge is safe mid-implementation; but merged files surface in the undeclared-change scan and must be folded into the declared outputs (or the phase design revised) before the final diff is authorized.

One more window matters, after a milestone: files a completed phase projected (its committed sources, docs, dist) keep being re-hashed against their recorded review bytes, so a merge that touches them makes reconciliation drift and blocks the next gate. That drift is resolved by the `baseline-adoption` gate: the human decides once — keep the current versions (they become the reviewed baseline without re-review) or restore the recorded ones — and the pipeline resumes where it stood. Adopting does not immunize the files: later drift opens a fresh decision, and a restore is only offered when a retained manifest still holds the recorded bytes (drift on top of an adoption can only be adopted again, since adopted bytes live in the worktree and git, not in durable authority). A deletion adds a third shape: when the newest record is adoption-sourced (digest-only, nothing to restore) and the file is gone from HEAD as well as the worktree — the deletion was already committed, typically by an authorized milestone commit — no produce can re-declare it either, because the base commit holds no before-image. The gate then offers keeping the deletion: the human accepts the committed absence, the record stores it as `adopted_absences`, and discovery retires the stale presence exactly like a declared deletion — unless the produce re-entry still has re-declarable work to cover (drifted paths, or worktree-only deletions), in which case that comes first and the deletion settles at its own decision right after the fresh terminal produce.

If a merge does conflict inside `.archflow/` — only possible when both branches carry it, for example two task branches — `.gitattributes` marks those files binary: resolve by taking one side wholesale rather than merging line-by-line, because a hand-merged state file matches no recorded digest.

## Where this is heading

The cutover is complete: the public catalogue is exactly the two semantic tools, and every workflow — document production, phase implementation, status reporting, and legacy adoption after its local staging and adoption steps — runs through the one client-orchestrated loop. The façade performs one bounded action, never producer work or Git, and returns a fresh view before any successor action can begin. For auditing which parts of the machinery earn their weight, start with `../COMPLEXITY.md`.
