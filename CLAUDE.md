# ArchFlow

A lightweight, human-centered development workflow for Claude Code and Codex.

## Repository Structure

This repo contains one portable Agent Skills source of truth in `skills/`. The installer copies it to each client's skill-discovery directory.

## Skills

The canonical set contains eight portable skills:

| Skill | Purpose |
|---------|---------|
| `/archflow-init` | Initialize repository assets and project-scoped MCP registrations |
| `/archflow-upgrade <legacy-source> <task>` | Stage a legacy task into a distinct canonical task and guide its migration audit |
| `/archflow-explore` | Explore codebase, produce persistent context references |
| `/archflow-prd <task>` | Research + create PRD for a task |
| `/archflow-design <task>` | Design architecture + phases for a task |
| `/archflow-phase-design <task> N` | Design phase N, sub-agent review, counter-review prompt |
| `/archflow-phase-impl <task> N` | Implement, verify, review, and commit phase N (fresh session) |
| `/archflow-status [task]` | Check status and next action |

In Codex, invoke the same skill names with `$` instead of `/`: `$archflow-init`, `$archflow-upgrade`, `$archflow-explore`, `$archflow-prd`, `$archflow-design`, `$archflow-phase-design`, `$archflow-phase-impl`, and `$archflow-status`.

## How It Works

All working files live in `.archflow/`. Tracked in git during development to preserve progress across sessions. Remove before PR.

```
.archflow/
  workflow.yaml               # Canonical phase graph
  constitution/              # Repository-owned policy rules
  context/                   # Persistent codebase references (shared across tasks)
  tasks/
    my-feature/
      config.yaml             # Versioned task configuration
      state.json              # Durable workflow authority
      prd.md                  # Product requirements
      design.md               # Technical design + phase plan
      phases/
        1/
          design.md           # Phase design
          impl-notes.md       # Implementation notes
        2/
          design.md
          impl-notes.md
```

## Installation

```bash
./install.sh
```

Installs the shared skills to `~/.claude/skills/` and `~/.agents/skills/` for global availability.

## Engineering Priorities

ArchFlow is an open-source prototype. Optimize for a useful, working, maintainable implementation—not hypothetical production, commercial, monetization, or release requirements.

Use this priority order when making tradeoffs:

1. Make the current user workflow work.
2. Choose the simplest design that meets the current requirement.
3. Keep the code readable, maintainable, and easy to change.
4. Add tests and safeguards proportional to the real risk.
5. Pursue exhaustive correctness, generality, or release polish only when the user explicitly asks for it or a demonstrated blocker requires it.

Default guidance:

- Prefer direct code and existing patterns over new abstractions, frameworks, layers, registries, or generalized machinery.
- Do not build for speculative future requirements. Avoid compatibility layers, migration systems, extension points, exhaustive matrices, and release infrastructure until they are actually needed.
- Validate important boundaries and representative failure cases, but do not attempt to prove every theoretical permutation. Tests should buy confidence, not completeness for its own sake.
- Treat licensing proportionally. Respect licenses and obvious attribution obligations, but default to package metadata and ordinary notices. Do not audit every file, build forensic license validators, or create release-grade legal inventories unless distribution makes them necessary, the user requests them, or a concrete legal issue blocks the prototype.
- A documented limitation or TODO is often better than a large subsystem. Prefer a reversible simple decision over an elaborate attempt to eliminate all uncertainty.
- Existing plans are revisable. If a planned phase is disproportionate to prototype goals, propose a simpler scope at the next design/review gate instead of implementing complexity merely because an older document mentions it.
- Before adding substantial complexity, explain the concrete current problem it solves and ask the user when the tradeoff materially expands scope.

Working and maintainable beats perfect. Simplicity does not override the human trust boundaries below, but those boundaries should be implemented with the least machinery that reliably preserves them.

## Design Principles

ArchFlow is written for models that keep improving. Skills must encode *intent and trust boundaries*, not workarounds for model weaknesses — workarounds become ceilings as models get better. When writing or editing any skill, apply this litmus test to every rule: **is it here because the model used to be bad at something, or because the human needs it?** Only the second kind gets "never/must/exact" language.

Hard rules — human trust boundaries, never soften:

- Never commit or pass a review gate without explicit user approval.
- Never write code before phase-design approval.
- Every human review gate offers a ready-to-run counter-review prompt for the other client; whether to run it is the human's decision, never the agent's to skip offering or to fake.
- Phase state machine: no doc → DESIGNED → IN PROGRESS → COMPLETE.
- Task isolation: tasks never read each other's files.
- Parent docs (design.md, prd.md) are updated when implementation deviates — the plan must always reflect reality.
- Every completed phase writes an implementation log; durable, task-independent conventions get proposed for the target project's CLAUDE.md (`.archflow/` is deleted before PR, so anything permanent must live outside it).

Everything else is a default, not a rule:

- The session running a skill is the workflow orchestrator, and its context is the workflow's scarcest resource. Conversation, decisions, gates, triage, and synthesis stay in the orchestrator; bulk work (exploration, research, drafting, fresh-context review, implementation chunks) is delegated to sub-agents by default — spawned with complete briefs (they see nothing of the conversation), writing outputs to disk, returning only conclusions. Inline work is the exception for pieces too small to justify a hand-off — never a client preference. Phrase delegation as explicit imperatives ("spawn one agent per X, run in parallel, wait for all"), not availability conditionals ("when subagents are available") — Codex delegates only when told explicitly, and both clients now provide native sub-agents.
- State the intent and let the model choose the procedure: "return only what the next step needs to decide," not word caps; "sized to the task," not fixed counts.
- Numbers (agent counts, phase counts, chunk counts, conversation rounds) are calibration hints — phrase as "typically" or "default," never "must."
- Techniques that compensate for model limits (mandatory research, forced sub-agent delegation, fixed decomposition) must be conditional on the task actually needing them.
- The human gate reviews evidence and exercises judgment; the agent performs all labor it is capable of, including running verification itself.

## Git, digest, and durable-shape conventions

Learned the hard way in this repository; all apply to any future work.

- **Never pass `--literal-pathspecs` to a Git invocation that uses a `:(top,literal)` pathspec.** The flag disables pathspec magic, so the prefix is then matched as a literal filename and the command silently selects nothing — no error, empty output. `:(top,literal)` alone supplies both literal matching and worktree-root anchoring. `check-attr` takes pathnames rather than pathspecs and needs neither.
- **Validate and materialize a caller-owned object once before inspecting it more than once** — `assertPlainJson` then `structuredClone`. An enumerable getter can otherwise return one value to a validation pass and a different value to a hashing pass, which defeats any assert-don't-filter security property. This is how an excluded field reached a request digest that was supposed to reject it.
- **A type reachable from a persisted root must be a `type` alias, never an `interface`.** `CanonicalDocument<T extends PlainJsonValue>` checks `T` through the whole reachable graph, and TypeScript grants implicit index signatures to type aliases only — so an `interface` nested anywhere inside fails with `TS2344: Index signature for type 'string' is missing`. Branded fields, optional properties, and `readonly` arrays are all fine; the declaration *form* is the whole cause, and blaming the branded strings sends the next reader down a dead end. This also intentionally closes declaration merging on those names: a persisted shape must be exactly what its JSON Schema says, and an ambient merge would silently widen it past the schema.
- **When reading a value through `Object.getOwnPropertyDescriptor`, require `enumerable` as well as `value`.** The two tests guard different hazards. Rejecting accessors prevents split observation (above). Rejecting non-enumerable *data* properties — which are stable under repeated reads, so the accessor check does not cover them — prevents a field that is invisible to `JSON.stringify` and `canonicalJsonBytes`, and therefore to any digest derived from them, from being treated as present. `assertPlainJson` already rejects non-enumerable properties inside a value; a shell or slot check that omits the test is weaker than the check applied to its own contents.
- **A disposable human-facing interface must be reconstructible from durable authority and must never be required to resolve authority already authenticated elsewhere.** Losing or corrupting an interface projection may remove convenience, but it must not strand durable state or force a human to author an internal archive.
- **When one published interface is the only renderer for a human action, its template must enumerate every decision shape the resolver accepts.** Include parallel shapes such as waivers and the cancellation escape path; requiring a human to read server source defeats the interface's trust purpose.
- **A CLI command with no input payload must not read stdin.** Parents commonly keep stdin open, so an input-free command that waits for EOF hangs even though it has everything needed to answer. Parse the command first and read stdin only for commands whose contract requires a payload.
