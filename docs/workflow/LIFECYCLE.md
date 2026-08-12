# workflow/LIFECYCLE

**Explored:** 2026-08-12 · **Commit:** `e7a63c0` · **Covers:** `assets/workflow.yaml`, `src/contracts/workflow.ts`, `src/contracts/gates.ts`, `skills/`

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

One nuance the YAML alone doesn't show: `gate: on_trigger` refers only to the gates the constitution verdict can demand (derived after triage). The phase skills impose an additional mandatory human gate on top — phase-design always opens an `artifact-approval` gate, and phase-impl always opens a `commit-authorization` gate (`src/local/build-request.ts` picks the kind from the phase). In practice **every phase ends at a human decision.**

The workflow file's bytes are digest-pinned into each task at creation, so changing the graph mid-task is detectable, not silently applied. Tasks pinned to the retired four-step workflow digest (the one with a separate `adjudicate` step) are invalidated — status reports `restore-pinned-config` — and either restart or go through `archflow-upgrade`; there is no migration.

## What each stage produces

| Stage | Skill | Artifact | Human approval |
|---|---|---|---|
| explore | `archflow-explore` | the maintained `docs/` set (`OVERVIEW.md`, `section/FILE.md`, stamped with commit + coverage) | review + commit confirmation (not a server gate) |
| task creation | any phase skill | `config.yaml` (byte-pinned), `state.json` | — |
| prd | `archflow-prd` | `ask.md` (verbatim request plus clarification Q&A), `prd.md` | `artifact-approval`, always |
| design | `archflow-design` | `design.md` with a machine-readable `### Phase N:` plan | `artifact-approval`, always |
| phase-design | `archflow-phase-design` | `phases/<n>/design.md` | `artifact-approval` + any triggered gate |
| phase-impl | `archflow-phase-impl` | code, `phases/<n>/verification.txt`, `phases/<n>/impl-notes.md` | `commit-authorization`, **then** a second explicit confirm-to-commit |
| status | `archflow-status` | nothing — read-only | surfaces gates, resolves none |

All task files live under `.archflow/tasks/<task>/`; the only cross-task material is the maintained `docs/` set, which lives in the repository proper. **Tasks never read each other's files** — this isolation is real and test-enforced.

## The pipeline inside each gated stage

Every gated stage runs the same evidence pipeline to a fixed point:

1. **produce** — write or revise the artifact. Its SHA-256 becomes the *subject digest*. The PRD producer performs one bounded, deterministic author checklist; other phases may use a same-side review sized to their risk. Nothing here becomes review authority — the first recorded review is the server-dispatched opposite-family one.
2. **counter_review** — one tool call, up to two dispatches, one atomic commit. The server dispatches the *opposite model family* (Claude ⇄ Codex) against a sealed envelope plus a read-only repo checkout at a pinned commit — evidence the producer cannot author. Then, only when the pinned constitution has active rules (the server decides, never the agent), it dispatches a second opposite-family child for the constitution and drift review — sealed envelope, deliberately no checkout. Both results commit in one atomic state transaction; `constitution: {status: "not-run"}` simply means no active rules exist.
3. **triage** — the producer must disposition **every** rubric finding, one of three ways:
   - **accepted** — the finding demands a substantive fix; the work re-enters produce and all evidence is redone against the new bytes.
   - **accepted-editorial** — the fix is purely wording or formatting and the finding is non-blocking (the server refuses this disposition for blocking findings). See the editorial path below.
   - **rejected** — with a written rationale. Findings prefixed `unverifiable-` mean "the reviewer lacked evidence," and are rejected with an `envelope-gap:` rationale, never accepted.

   The constitution verdict is never triaged: a failing or uncertain rule, a matched `review_trigger`, or material drift opens a human gate *after* triage, through the ordinary gate flow — status derives the pending gate and `build-request` (kind `"gate"`) composes the complete request mechanically; the human decides at the gate. One counter-review yields at most one constitution decision: compliance and trigger are separate judgments about the same rules that usually share a root cause, so a single `constitution-review` gate discloses both axes rather than asking twice about one rule.

Editing the artifact changes the subject digest, which invalidates all downstream evidence — the pipeline re-runs until everything agrees about the same bytes. Re-entry is bounded (`max_attempts`, default 3); exhaustion opens an `attempts-exhausted` gate rather than looping forever.

**What actually ends the loop is triage, not the finding count.** The exit condition is `accepted_count === 0` — a plain `accepted` disposition is the only thing that forces another round (`src/review/fixed-point.ts`). A model-labeled blocker that triage rejects does not continue the loop. The producer accepts every material defect and rejects anything that cannot show a concrete downstream consequence. On later rounds the sealed instruction makes remediation verification primary and permits a new issue only when leaving it unchanged is reasonably likely to change behavior, verification, delivery, approval, or important risk.

`status.evidence.findings` retains each finding and disposition for audit, but ordinary human approval is not used to triage model polish. Rejected non-material observations stay out of the approval agenda. An envelope gap is disclosed there only when it prevented a material judgment; an `attempts-exhausted` gate instead presents the unresolved material defect and asks whether another revision is warranted.

### The editorial revision

When a round's only accepted findings are `accepted-editorial`, the producer applies exactly the recorded revision intents and records produce again — and **nothing re-runs**. The revised artifact declares a server-validated, strictly one-hop `editorial_predecessor` link — `{subject_digest, input_fingerprint, triage_result_digest}` naming the exact reviewed bytes, their inputs, and the triage round that authorized the hop. The retained reviews *and* the constitution verdict stay bound to the declared predecessor for that one hop, and the eventual human gate presents the predecessor→final diff with an explicit disclosure that the evidence evaluated the predecessor bytes. A plain `accepted` disposition anywhere in the round still forces full re-entry — the editorial path exists only for rounds that are editorial through and through.

An editorial round consumes an attempt slot like any other re-entry. That is deliberate: if editorial rounds push a task to its attempt cap, the `attempts-exhausted` gate's retry decision is the intended recovery, keeping the human in the loop rather than letting cosmetic churn extend the loop silently.

### The transition edges, precisely

Beyond the forward hand-off (each succeeded step to its successor, same attempt), the state machine (`src/state/transitions.ts`) admits exactly one other same-phase move:

- **any-succeeded step → produce-running (attempt + 1)** — the "new information" door. From triage this is the accepted-finding (or editorial) re-entry; from a succeeded produce or counter_review it is the author withdrawing to incorporate new information. Downstream evidence simply goes stale and is redone — except on the one-hop editorial path, where retained evidence stays bound to the declared predecessor. Because re-entry is sanctioned, the artifact drifting on disk while state sits at produce running (or failed) is an *expected re-entry edit*, not material drift.

The phase-completion signal fires from **triage-succeeded**: once triage closes the fixed point (and any post-triage gates resolve), the phase can advance — for phase-impl that is what arms the commit-authorization flow, and the legacy-import design jump fires from the same point.

## Gates: where humans decide

Eight gate kinds exist (`src/contracts/gates.ts`):

| Gate kind | Opens when |
|---|---|
| `artifact-approval` | a PRD, design, or phase design reaches its fixed point |
| `commit-authorization` | a phase implementation is ready to commit |
| `constitution-review` | the constitution review found a rule `fail`/`uncertain`, or a rule's `review_trigger` matched, or both (derived after triage; one gate discloses both axes and offers a waiver per rule *and* axis) |
| `material-drift` | an approved upstream document drifted materially (derived after triage) |
| `attempts-exhausted` | the produce/review loop hit its attempt cap (status prefills its request; `build-request` composes only the approval kinds, so complete it through `archflow-local envelope`) |
| `constitution-edit` | a task branch tried to amend its own governing constitution (detected at counter-review time; on the first round, with no retained review set to bind, this is a plain `constitution-edited-on-task-branch` error instead) |
| `restore-collision` | a drift repair would overwrite conflicting bytes |
| `migration-audit` | a legacy import is ready for its guarded resume jump |

Every gate is a durable pair of canonical documents (request + decision record) bound to a gate ID, context digest, subject digest, and the current evidence set. Decisions carry human provenance. Two properties keep them honest:

- **Supersession**: if the subject changes while a gate is open, the gate returns `GATE_SUPERSEDED` and approves nothing — the work re-enters the pipeline and a fresh gate opens.
- **Re-verification**: later code never trusts a recorded approval reference alone; it re-reads and re-validates the underlying documents.

## Hard trust boundaries

These rules recur across every skill and are enforced by the server wherever mechanically possible:

- **Nothing is approved until a human explicitly decides, on the exact bytes.** Silence, elapsed time, agent prose, or a model verdict never supplies approval. Skills re-run `status` after a gate rather than trusting conversation memory.
- **No code before approved phase design.** Durable state must say `phase-impl-<n>`; a design file existing on disk is explicitly insufficient.
- **Committing is a double lock.** An `authorize-commit` gate decision bound to the final diff, *and then* a separate stop where the user sees the exact staged diff and message and explicitly confirms.
- **Waivers are narrow.** A `waiver-requested` decision is not approval; a granted waiver covers one rule version + one subject digest + one task, and evaporates on any change.
- **Fail closed, honestly.** With the MCP server unavailable nothing records progress — degraded mode is a read-only status, not an offline workflow; `repair-required` states never become progress; "task complete" means the last planned phase is committed — it does not imply QA, staging, or release.

## Where this is heading

The lifecycle above is the current, MCP-backed workflow; the legacy skill-only flow it replaced lives in git history. For auditing which parts of the machinery earn their weight, start with `../COMPLEXITY.md`.
