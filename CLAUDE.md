# ArchFlow

A lightweight, human-centered development workflow for Claude Code and Codex.

## Repository Structure

This repo contains one portable Agent Skills source of truth in `skills/`. The installer copies it to each client's skill-discovery directory.

## Skills

| Skill | Purpose |
|---------|---------|
| `/archflow-explore` | Explore codebase, produce persistent context references |
| `/archflow-prd <task>` | Research + create PRD for a task |
| `/archflow-design <task>` | Design architecture + phases for a task |
| `/archflow-phase-design <task> N` | Design phase N, sub-agent review, counter-review prompt |
| `/archflow-phase-impl <task> N` | Implement, verify, review, and commit phase N (fresh session) |
| `/archflow-status [task]` | Check status and next action |

In Codex, invoke the same skill names with `$` instead of `/`: `$archflow-explore`, `$archflow-prd`, `$archflow-design`, `$archflow-phase-design`, `$archflow-phase-impl`, and `$archflow-status`.

## How It Works

All working files live in `.archflow/`. Tracked in git during development to preserve progress across sessions. Remove before PR.

```
.archflow/
  context/                    # Persistent codebase references (shared across tasks; per-repo — in a multi-root workspace every repo may carry its own, and skills read all of them)
  tasks/
    my-feature/
      prd.md                  # Product Requirements Document
      architecture.md         # Technical design + phase breakdown
      reviews/                # Cross-client counter-review findings + triage
        prd-counter-review.md
        phase-1-design-counter-review.md
      phases/
        phase-1-setup.md      # Phase design + implementation notes
        phase-2-core.md
```

## Installation

```bash
./install.sh
```

Installs the shared skills to `~/.claude/skills/` and `~/.agents/skills/` for global availability.

## Design Principles

ArchFlow is written for models that keep improving. Skills must encode *intent and trust boundaries*, not workarounds for model weaknesses — workarounds become ceilings as models get better. When writing or editing any skill, apply this litmus test to every rule: **is it here because the model used to be bad at something, or because the human needs it?** Only the second kind gets "never/must/exact" language.

Hard rules — human trust boundaries, never soften:

- Never commit or pass a review gate without explicit user approval.
- Never write code before phase-design approval.
- Every human review gate offers a ready-to-run counter-review prompt for the other client; whether to run it is the human's decision, never the agent's to skip offering or to fake.
- Phase state machine: no doc → DESIGNED → IN PROGRESS → COMPLETE.
- Task isolation: tasks never read each other's files.
- Parent docs (architecture.md, prd.md) are updated when implementation deviates — the plan must always reflect reality.
- Every completed phase writes an implementation log; durable, task-independent conventions get proposed for the target project's CLAUDE.md (`.archflow/` is deleted before PR, so anything permanent must live outside it).

Everything else is a default, not a rule:

- The session running a skill is the workflow orchestrator, and its context is the workflow's scarcest resource. Conversation, decisions, gates, triage, and synthesis stay in the orchestrator; bulk work (exploration, research, drafting, fresh-context review, implementation chunks) is delegated to sub-agents by default — spawned with complete briefs (they see nothing of the conversation), writing outputs to disk, returning only conclusions. Inline work is the exception for pieces too small to justify a hand-off — never a client preference. Phrase delegation as explicit imperatives ("spawn one agent per X, run in parallel, wait for all"), not availability conditionals ("when subagents are available") — Codex delegates only when told explicitly, and both clients now provide native sub-agents.
- State the intent and let the model choose the procedure: "return only what the next step needs to decide," not word caps; "sized to the task," not fixed counts.
- Numbers (agent counts, phase counts, chunk counts, conversation rounds) are calibration hints — phrase as "typically" or "default," never "must."
- Techniques that compensate for model limits (mandatory research, forced sub-agent delegation, fixed decomposition) must be conditional on the task actually needing them.
- The human gate reviews evidence and exercises judgment; the agent performs all labor it is capable of, including running verification itself.
- **Design to the operating envelope.** ArchFlow builds working software a small team can maintain — functionality and maintainability outrank scale. The PRD states the envelope (scale, criticality, threat model); every downstream skill and sub-agent brief is held to it, and the default absent a stated envelope is an early-stage product serving thousands of users, not millions. Abstractions, invariants, integrity machinery, and recovery paths must be bought by a requirement or an observed failure, never by a hypothetical. Over-engineering is a defect that reviewers weight the same as a gap.
- **Review has a materiality bar.** Reviewers report only what changes what gets built; wording, naming, ordering, terminology drift, and polish are never findings. Two severities only — blocker and major — because a "minor" bucket is where nitpick loops live. "Nothing material" is a valid, good result. Revise for blockers and majors, then stop: a second round happens only when revisions changed the document's shape, never to see whether a fresh reviewer can find something. Triage rejects by default anything editorial or beyond the envelope.
- **Artifacts carry rubrics.** Every human-reviewed artifact states the bar it is written to, including a review-time budget — a PRD reads in 5–10 minutes, an architecture in under 10 — and the rubric goes to both writer and reviewer briefs so drafts meet it before the gate, not after. Phase designs and implementation logs are written primarily for the machine that consumes them next; the human gate judges them, but prose is optimized for the implementing agent.
- **Sizing happens once, in the architecture.** `archflow-design` cuts phases to fit one delegated implementation session; phase design and implementation work inside those boundaries. Re-splitting later is a rare, user-approved amendment — the first levers for a phase that feels large are more sub-agent delegation and a less over-specified design document, and repeated splits mean the architecture's sizing is what needs fixing.
