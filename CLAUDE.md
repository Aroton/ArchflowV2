# ArchFlow

A lightweight, human-centered development workflow for Claude Code, Codex, and Google Antigravity: a standalone cross-model counter-review (`archflow-local review`), a repository scaffold for it (`archflow-local init`), and an orchestrated-run workflow (`/archflow-run`) built on both.

## Repository Structure

- `skills/` holds the portable Agent Skills, the single source of truth. The installer copies them to each client's skill-discovery directory.
- `src/` holds the `archflow-local` CLI: `review` (the counter-review) and `init` (the repository scaffold). `dist/` is the tracked offline bundle the installer ships; `assets/` holds the shipped config template, constitution rules, and rubrics.
- `docs/` holds the maintained documentation set (see Documentation); `test/` holds the vitest suites.

## Skills

The canonical set contains four portable skills:

| Skill | Purpose |
|---------|---------|
| `/archflow-init` | Scaffold `.archflow/config.yaml` and the constitution by running `archflow-local init`, and clean up registrations older versions left |
| `/archflow-constitution` | Explain and configure repository-owned constitution rules |
| `/archflow-explore` | Explore codebase, produce or refresh the maintained `docs/` documentation set |
| `/archflow-run <name> [ask]` | Plan a large job once, then orchestrate it across fresh sessions with per-task sub-agents, worktrees, and cross-model review; markdown state (Claude Code orchestrator) |

In Claude Code and Antigravity, invoke skills with `/` (e.g. `/archflow-init`). In Codex, invoke the same skill names with `$` instead of `/`: `$archflow-init`, `$archflow-constitution`, and `$archflow-explore`. `/archflow-run` is installed for every client but currently needs Claude Code as its orchestrator.

## When ArchFlow applies

`/archflow-run` is required only when the user asks for an orchestrated run or the current work belongs to an existing `.archflow/runs/<name>/`. Ordinary conversation, planning mode, code review, and direct implementation requests proceed normally; the presence of `.archflow/`, installed skills, or this repository does not require starting a run. Start one when the user asks for it, not merely because they ask for a plan or code changes.

A run is markdown-driven: its state lives in `.archflow/runs/<name>/` and git, and its own STOP and halt rules (plan approval before code, declared STOPs, cross-model review on every task) govern it. Repository engineering, documentation, and installation-safety rules apply to all work.

## How It Works

Working files live in `.archflow/`. `config.yaml` (reviewer routing) and `constitution/` (policy rules) are what `archflow-local review` reads; a run keeps its own files under `runs/`. Run directories and the run's generated agents in `.claude/agents/` are working files: tracked in git during development to preserve progress across sessions, removed before a PR.

```
.archflow/
  config.yaml                 # Reviewer routing
  constitution/               # Repository-owned policy rules
    default/                  # Shipped rules, refreshed by init --force
    custom/                   # Repository rules and same-ID replacements
  runs/
    my-run/
      PLAN.md                 # Requirements, architecture, invariants, task table, STOPs
      PROGRESS.md             # Status line, task log, handoffs
      DECISIONS.md            # Decisions and waivers
      BRIEF.md                # Reference-and-validation brief for every counter-review
      reviews/                # Per-task findings
      research/               # Persisted research
      packets/                # Per-task packets (gitignored)
```

## Installation

```bash
./install.sh
```

Installs the `archflow-local` launcher and bundle, and the shared skills to `~/.claude/skills/`, `~/.agents/skills/`, and `~/.gemini/config/skills/` for global availability.

### Installation safety — hard rule

**Never run `install.sh`, and never otherwise install or update the skills, launchers, or bundle in the shared machine-global locations (`~/.claude/skills/`, `~/.agents/skills/`, `~/.gemini/config/skills/`, `~/.archflow/bundle/`, `~/.local/bin/`), unless the user explicitly asks for an install in the current conversation.** These locations are machine-global: an install from a feature branch immediately changes behavior for other people and for other sessions working from different branches or checkouts. The user saying "install" once does not authorize later installs.

Work on a branch stays inside the repo: the working tree, the tracked `dist/` payload, and scratch/temp directories used by tests. Anything that would place this checkout's bytes into a shared location — `install.sh`, copying bundles into `~/.archflow/`, overwriting launchers — requires an explicit per-action request. If a workflow document (for example a run's plan or a task packet) instructs an install, treat this rule as overriding it and surface the conflict to the user instead of installing.

## Documentation

Human-readable system documentation lives in `docs/` using a caps-naming convention: **caps-named files (`OVERVIEW.md`, `COMPLEXITY.md`, `section/FILE.md`) are the maintained documentation set**. The set is produced and refreshed by `/archflow-explore`; each page carries an `**Explored:** <date> · **Commit:** <short-hash> · **Covers:** <paths>` stamp so a refresh can diff since the stamped commit and re-explore only pages whose covered code changed; a test checks every stamp and that each covered path exists. `docs/validation/` and `docs/research/` are separate: point-in-time evidence and research that no test reads and explore does not keep current. The maintained set:

```
docs/
  OVERVIEW.md              # whole-system map, glossary
  COMPLEXITY.md            # per-subsystem simplification audit
  PATTERNS.md              # code conventions and idioms
  DEPENDENCIES.md          # dependency surface and toolchain
  TESTING.md               # test layout and validation matrix
  LIMITATIONS.md           # honest reliability/security boundaries
  workflow/SKILLS.md       # the four skills
  mcp/DISPATCH.md          # child reviewer dispatch, sandbox, repo views
  cli/COMMANDS.md          # archflow-local review and init
  review/COUNTER-REVIEW.md # dispatch envelopes, review flow, constitution review, waivers
```

**Keep these current.** When a change alters behavior these pages describe — a command, an envelope rule, a routing or sandbox rule, a trust boundary — update the affected caps-named page in the same change. They are written for humans auditing the system: plain language, the *why* behind each part, mermaid diagrams; not API references.

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

Within a `/archflow-run`, these human trust boundaries are hard rules:

- No implementation starts until the human explicitly approves the plan, and every declared STOP is approved explicitly; silence is not approval.
- Every task gets the cross-model counter-review. If it cannot run, report the blocker and do not merge the task; never substitute self-review. The human may explicitly waive it for a named task; record the waiver in the run's `DECISIONS.md`.
- Never push, deploy, install into machine-global locations, or delete user data without the human asking.
- Correspondence with the human is conversational and human-readable: what needs attention, why it matters, and the choices in plain language. Keep digests, JSON, internal paths, and protocol codes out of it unless asked for diagnostics.
- The plan must always reflect reality: update it when implementation deviates. Durable, task-independent conventions get proposed for the project's CLAUDE.md (`.archflow/runs/` is deleted before a PR, so anything permanent must live outside it).

Everything else is a default, not a rule:

- The session running a skill is the orchestrator: conversation, decisions on findings, and synthesis stay there. Delegate substantial parallel work when the active skill calls for it, using complete briefs because sub-agents see none of the conversation; keep small work inline. A cross-model counter-review (`archflow-local review`) is the independent review unless the skill explicitly requests another. Phrase required delegation as a direct instruction, not an availability conditional.
- State the intent and let the model choose the procedure: "return only what the next step needs to decide," not word caps; "sized to the task," not fixed counts.
- Numbers (agent counts, task counts, chunk counts, conversation rounds) are calibration hints — phrase as "typically" or "default," never "must."
- Techniques that compensate for model limits (mandatory research, forced sub-agent delegation, fixed decomposition) must be conditional on the task actually needing them.
- A human STOP reviews evidence and exercises judgment; the agent performs all labor it is capable of, including running verification itself.

## Code conventions

Learned the hard way in this repository; all apply to any future work.

- **Validate and materialize a caller-owned object once before inspecting it more than once** — `assertPlainJson` then `structuredClone` (`parseSimpleReviewInput` in `src/contracts/simple-review.ts`). An enumerable getter can otherwise return one value to a validation pass and a different value to a later hashing or sending pass, which defeats any assert-don't-filter property: a field the validation rejected can still reach the bytes that are digested or sent.
- **When reading a value through `Object.getOwnPropertyDescriptor`, require `enumerable` as well as `value`** (`src/dispatch/cli.ts`, `src/dispatch/failure-classification.ts`). The two tests guard different hazards. Rejecting accessors prevents split observation (above). Rejecting non-enumerable *data* properties — which are stable under repeated reads, so the accessor check does not cover them — prevents a field that is invisible to `JSON.stringify` and `canonicalJsonBytes`, and therefore to any digest derived from them, from being treated as present. `assertPlainJson` already rejects non-enumerable properties inside a value; a descriptor check that omits the test is weaker than the check applied to its own contents.
- **A CLI command with no input payload must not read stdin** (`src/local/main.ts`). Parents commonly keep stdin open, so an input-free command that waits for EOF hangs even though it has everything needed to answer. Parse the command first and read stdin only for commands whose contract requires a payload.
- **Name tests, classes, files, scripts, and identifiers for the behavior they cover, never for the workflow phase that produced them** — a phase or task number is workflow state, not code structure, and finding the right artifact must not require knowing project history.
- **A reviewer responsibility is defined by its authenticated assignment, never by route availability or current roster position** (`reviewAssignment` in `src/review/rubrics.ts`).
- **Never place an envelope, prompt, schema, or any other unbounded payload in a single argv element.** Linux rejects one element of `MAX_ARG_STRLEN` (128 KiB) or more with `spawn E2BIG` regardless of the 2 MiB `ARG_MAX` total, and Node reports it as a bare spawn error with no hint of which argument. The Antigravity adapter once passed the whole review envelope as the `-p` value, and a large enough plan with its pinned context crossed the line mid-run. Feed payloads on stdin or through a workspace file (every adapter does now), and keep `MAX_ARGV_ELEMENT_BYTES` in `src/dispatch/process.ts` as the guard.
- **Cleanup of anything an earlier ArchFlow wrote is ownership-guarded** (`src/init/legacy-registration-cleanup.ts`, `install.sh`). Remove an item only when it matches the exact shape ArchFlow wrote, never follow or act through a symbolic link, and keep and report everything else. A person's own file under the same name, in a repository or a machine-global skills folder, must survive an upgrade.
- **`test/unit/standalone-review-prompt-snapshots.test.ts` pins the bytes every reviewer receives**: the prompt, the files it references, and the response schema each adapter sends. A diff there is a change to review behavior. Regenerate the snapshots only when that change is intended, and say so in the change.
- **A change to `assets/` or to anything bundled into `archflow-local` regenerates `dist/` in the same change**, through `release:stage` → `release:check` → `release:write`, never by hand. The installer and its integration test verify the tracked payload against the manifest, so a stale `dist/` fails them even when the source is right.
