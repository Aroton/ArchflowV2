# ArchFlow

A lightweight, human-centered development workflow for Claude Code, Codex, and Google Antigravity.

## Repository Structure

This repo contains one portable Agent Skills source of truth in `skills/`. The installer copies it to each client's skill-discovery directory.

## Skills

The canonical set contains nine portable skills:

| Skill | Purpose |
|---------|---------|
| `/archflow-init` | Initialize repository assets and MCP registrations |
| `/archflow-constitution` | Explain and configure repository-owned constitution rules |
| `/archflow-upgrade <legacy-source> <task>` | Stage a legacy task into a distinct canonical task and guide its migration audit |
| `/archflow-explore` | Explore codebase, produce or refresh the maintained `docs/` documentation set |
| `/archflow-prd <task>` | Research + create PRD for a task |
| `/archflow-design <task>` | Design architecture + phases for a task |
| `/archflow-phase-design <task> N` | Design phase N and run its automatic counter-review |
| `/archflow-phase-impl <task> N` | Implement, verify, review, and commit phase N (fresh session) |
| `/archflow-status [task]` | Check status and next action |

In Claude Code and Antigravity, invoke skills with `/` (e.g. `/archflow-init`). In Codex, invoke the same skill names with `$` instead of `/`: `$archflow-init`, `$archflow-constitution`, `$archflow-upgrade`, `$archflow-explore`, `$archflow-prd`, `$archflow-design`, `$archflow-phase-design`, `$archflow-phase-impl`, and `$archflow-status`.

## How It Works

All working files live in `.archflow/`. Tracked in git during development to preserve progress across sessions. Remove before PR.

```
.archflow/
  workflow.yaml               # Canonical phase graph
  constitution/              # Repository-owned policy rules
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

Installs the shared skills to `~/.claude/skills/`, `~/.agents/skills/`, and `~/.gemini/config/skills/` for global availability.

### Installation safety — hard rule

**Never run `install.sh`, and never otherwise install or update the skills, launchers, or bundle in the shared machine-global locations (`~/.claude/skills/`, `~/.agents/skills/`, `~/.gemini/config/skills/`, `~/.archflow/bundle/`, `~/.local/bin/`), unless the user explicitly asks for an install in the current conversation.** These locations are machine-global: an install from a feature branch immediately changes behavior for other people and for other sessions working from different branches or checkouts. The user saying "install" once does not authorize later installs.

Work on a branch stays inside the repo: the working tree, the tracked `dist/` payload, and scratch/temp directories used by tests. Anything that would place this checkout's bytes into a shared location — `install.sh`, copying bundles into `~/.archflow/`, overwriting launchers — requires an explicit per-action request. If a workflow document (for example a phase design's self-cutover step) instructs an install, treat this rule as overriding it and surface the conflict to the user instead of installing.

## Documentation

Human-readable system documentation lives in `docs/` using a caps-naming convention: **caps-named files (`OVERVIEW.md`, `COMPLEXITY.md`, `section/FILE.md`) are the maintained documentation set**. The set is produced and refreshed by `/archflow-explore`; each page carries an `**Explored:** <date> · **Commit:** <short-hash> · **Covers:** <paths>` stamp so a refresh can diff since the stamped commit and re-explore only pages whose covered code changed. `docs/validation/` is separate: point-in-time validation evidence and benchmark data (read by `test/real-host/review-benchmark.test.ts`), not kept current by explore. The maintained set:

```
docs/
  OVERVIEW.md              # whole-system map, glossary
  COMPLEXITY.md            # per-subsystem simplification audit
  PATTERNS.md              # code conventions and idioms
  DEPENDENCIES.md          # dependency surface and toolchain
  TESTING.md               # test layout and validation matrix
  LIMITATIONS.md           # honest reliability/security boundaries
  workflow/LIFECYCLE.md    # phase graph, pipeline, gates, trust boundaries
  workflow/SKILLS.md       # the nine skills
  mcp/SERVER.md            # MCP server, two semantic tools, protocol plumbing
  mcp/DISPATCH.md          # child reviewer dispatch, sandbox, repo views
  cli/COMMANDS.md          # archflow-local adapters, upgrade adoption, degraded mode
  review/COUNTER-REVIEW.md # dispatch envelopes, pinned context, review flow, constitution review, waivers
  contracts/CONTRACTS.md   # canonical JSON, digests, trust brands
  contracts/AUTOMATION.md  # read-only controller status contract and launch loop
  state/DURABLE-STATE.md   # .archflow layout, transactions, state machine, git boundary
```

**Keep these current.** When a change alters behavior these pages describe — a tool, a command, a gate kind, an envelope rule, a state transition, a trust boundary — update the affected caps-named page in the same change. They are written for humans auditing the workflow: plain language, the *why* behind each system, mermaid diagrams; not API references.

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

- Never choose or pass a returned human gate without explicit user approval. Never commit when returned commit facts require human confirmation without obtaining it; when they do not, execute only those authenticated facts without inventing a confirmation.
- Never write code before the server reports durable phase-design authority, whether that authority came from a passed triggered gate or authenticated rule-based advancement after counter-review.
- The server-dispatched counter-review (opposite client family by default) runs automatically before either a triggered human gate or autonomous advancement. There is no optional review at the end of a gate. A significant human revision starts a fresh automatic review cycle; a simple wording or formatting revision may reuse the prior review for one hop but still requires approval of the final bytes. (The `baseline-adoption` gate opens before any review by design: it is not approval of produced work but a human decision about which bytes are the reviewed baseline after they drifted, typically from later commits or a merge.)
- All correspondence at a human gate is conversational and human-readable. Explain what needs attention, why it matters, and the available choices in plain language. Keep gate IDs, digests, JSON, internal paths, protocol codes, and other mechanical bindings out of the default response; show them only when the user explicitly asks for diagnostics or audit detail.
- Follow only the server-returned semantic action. Submit a gate summary and stop only when offered, treat every returned presentation as human-required, and never invent a gate or infer autonomous authority from review evidence or conversation.
- Phase state machine: no doc → DESIGNED → IN PROGRESS → COMPLETE.
- Task isolation: tasks never read each other's files.
- Parent docs (design.md, prd.md) are updated when implementation deviates — the plan must always reflect reality.
- Every completed phase writes an implementation log; durable, task-independent conventions get proposed for the target project's CLAUDE.md (`.archflow/` is deleted before PR, so anything permanent must live outside it).

Everything else is a default, not a rule:

- The session running a skill is the workflow orchestrator: conversation, decisions, gates, triage, and synthesis stay there. Delegate substantial parallel work when the active skill calls for it, using complete briefs because sub-agents see none of the conversation; keep small work inline. A server-dispatched review is the independent review unless the skill explicitly requests another. Phrase required delegation as a direct instruction, not an availability conditional.
- State the intent and let the model choose the procedure: "return only what the next step needs to decide," not word caps; "sized to the task," not fixed counts.
- Numbers (agent counts, phase counts, chunk counts, conversation rounds) are calibration hints — phrase as "typically" or "default," never "must."
- Techniques that compensate for model limits (mandatory research, forced sub-agent delegation, fixed decomposition) must be conditional on the task actually needing them.
- The human gate reviews evidence and exercises judgment; the agent performs all labor it is capable of, including running verification itself.

## Git, digest, and durable-shape conventions

Learned the hard way in this repository; all apply to any future work.

- **Never pass `--literal-pathspecs` to a Git invocation that uses a `:(top,literal)` pathspec.** The flag disables pathspec magic, so the prefix is then matched as a literal filename and the command silently selects nothing — no error, empty output. `:(top,literal)` alone supplies both literal matching and worktree-root anchoring. `check-attr` takes pathnames rather than pathspecs and needs neither.
- **A race-closed Git proof must revalidate symbolic target identity as well as object identity after inspection.** Re-reading only `HEAD`, the target ref OID, and ancestry misses a concurrent branch switch when both refs name the same commit. Pin the symbolic ref and target head before reading candidate trees, then re-read the symbolic ref, `HEAD`, target ref, ancestry, and candidate selection before returning authority.
- **Validate and materialize a caller-owned object once before inspecting it more than once** — `assertPlainJson` then `structuredClone`. An enumerable getter can otherwise return one value to a validation pass and a different value to a hashing pass, which defeats any assert-don't-filter security property. This is how an excluded field reached a request digest that was supposed to reject it.
- **A type reachable from a persisted root must be a `type` alias, never an `interface`.** `CanonicalDocument<T extends PlainJsonValue>` checks `T` through the whole reachable graph, and TypeScript grants implicit index signatures to type aliases only — so an `interface` nested anywhere inside fails with `TS2344: Index signature for type 'string' is missing`. Branded fields, optional properties, and `readonly` arrays are all fine; the declaration *form* is the whole cause, and blaming the branded strings sends the next reader down a dead end. This also intentionally closes declaration merging on those names: a persisted shape must be exactly what its JSON Schema says, and an ambient merge would silently widen it past the schema.
- **When reading a value through `Object.getOwnPropertyDescriptor`, require `enumerable` as well as `value`.** The two tests guard different hazards. Rejecting accessors prevents split observation (above). Rejecting non-enumerable *data* properties — which are stable under repeated reads, so the accessor check does not cover them — prevents a field that is invisible to `JSON.stringify` and `canonicalJsonBytes`, and therefore to any digest derived from them, from being treated as present. `assertPlainJson` already rejects non-enumerable properties inside a value; a shell or slot check that omits the test is weaker than the check applied to its own contents.
- **A disposable human-facing interface must be reconstructible from durable authority and must never be required to resolve authority already authenticated elsewhere.** Losing or corrupting an interface projection may remove convenience, but it must not strand durable state or force a human to author an internal archive.
- **When one published interface is the only renderer for a human action, its template must enumerate every decision shape the resolver accepts.** Include parallel shapes such as waivers and the cancellation escape path; requiring a human to read server source defeats the interface's trust purpose.
- **A CLI command with no input payload must not read stdin.** Parents commonly keep stdin open, so an input-free command that waits for EOF hangs even though it has everything needed to answer. Parse the command first and read stdin only for commands whose contract requires a payload.
- **Every explicit payload-free state operation must retain its discriminator in both the request digest and `last_transition`.** Hashing only the shared phase/step/status fields collapses distinct refresh and recovery intents into the same replay identity, even though their transition effects differ.
- **Name tests, classes, files, scripts, and identifiers for the behavior they cover, never for the workflow phase that produced them** — phase numbers are workflow state, not code structure, and finding the right artifact must not require knowing project history.
- **An advertised MCP tool inputSchema must keep a plain object root — never a root-level `oneOf`/`allOf`/`$ref`.** At least one host flattens a root-level oneOf by dropping every branch it cannot resolve, advertising the tool as a zero-field object; the model then guesses all-string inputs, and an opaque rejection cannot correct the guess. Merge union arms into one object root (union of properties, shared fields required, a description naming the groups) and keep combinators below the root, where hosts preserve them; the server's strict validation stays the authority, and rejections must name the offending fields.
- **Durable accounting and retention must never be gated on the current schema of a part of the record they do not read.** A task's retained-result graph spans every result it has ever produced, so any reader that walks the whole graph will meet manifests written by older server versions. Byte accounting needs one `accounting` record and the content address that proves the bytes authentic; routing it through the full strict `parseResultManifest` bound it to every artifact schema instead, and renaming one evidence field (`source_evidence_set_digest` to `source_review_envelope_digest`) then made every task holding a pre-rename adjudication result unable to total its own bytes — over manifests contributing zero bytes — which the caller turned into a hard `TypeError` that stranded the task after its review had already run. Prove authenticity with the digest, parse the narrow slice you actually consume, and let the rest of the record be whatever version wrote it.
- **A reviewer responsibility is defined by its authenticated assignment, never by route availability or current roster position.** A missing, invalid, or failed specialist route must not widen another reviewer's criteria. Remediation resolves an accepted finding from the exact evidence and producing run first, then maps that owner by authenticated identity; if the historical owner cannot be recovered uniquely, stop before dispatch instead of transferring the finding or guessing from present ordering.
- **Producers of a sorted path array must sort with the exact comparator the consuming schema enforces — `localeCompare` for gate contexts, code-unit `ordinal` for durable records.** The orderings diverge on mixed-case sets (`README.md` sorts before `archforge-…` by code unit, after by locale), so a default `.sort()` feeding a gate context fails composition with "uncommitted paths must be sorted with no duplicates"; the record side failed the mirror way — a locale-ordered record the receipt parser rejected after archival (see `baselineAdoptionRecord`). Sort for the schema you feed, not the sort that looks natural.
- **Never place an envelope, prompt, schema, or any other unbounded payload in a single argv element.** Linux rejects one element of `MAX_ARG_STRLEN` (128 KiB) or more with `spawn E2BIG` regardless of the 2 MiB `ARG_MAX` total, and Node reports it as a bare spawn error with no hint of which argument. The Antigravity adapter passed the whole review envelope as the `-p` value; a phase design plus its pinned upstream documents crossed the line mid-task and the counter-review died in a way the diagnostics attributed to a cancelled sibling. Feed payloads on stdin or through a workspace file (every adapter does now), and keep `MAX_ARGV_ELEMENT_BYTES` in `src/dispatch/process.ts` as the guard.
