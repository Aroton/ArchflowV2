# COMPLEXITY

**Explored:** 2026-08-10 · **Commit:** `50a218d` · **Covers:** the whole repository

A per-subsystem audit of where the machinery is heaviest, what it buys, and what could be simplified. Written to support iterating on the workflow — each item states the concrete problem the complexity solves so a simplification can be judged against it, per the engineering priorities in CLAUDE.md.

## How to read this

Three categories recur:

- **Load-bearing** — the complexity directly implements a human trust boundary. Simplify the *implementation*, never the guarantee.
- **Duplication** — the same logic or shape exists twice or more; consolidation is nearly free correctness.
- **Questionable weight** — machinery whose cost may exceed its prototype-stage value; candidates for the "documented limitation instead of a subsystem" trade.

## Ranked simplification targets

### 1. The manual/offline parallel universe (state layer) — resolved 2026-08-11

The audit asked directly: how often is the MCP server actually down, and could degraded mode shrink to "read-only status + stop" instead of a full recording workflow? It could, and it did. `manual-import.ts`, `manual-checkpoints.ts`, the manual half of `gates.ts`, and the `manual-workflow.ts` driver (~3,000 lines of mirror machinery, every normal-path invariant change carrying a mirror obligation) are retired; `manual-status` survives as a read-only classifier. Pre-retirement checkpoint chains are stranded with no recovery path — see `LIMITATIONS.md`.

### 2. `gates.ts` at 2,311 lines — load-bearing but overdue for a split

**Resolved 2026-08-11.** The audit found at least five responsibilities in one file: gate lifecycle, decision templates, interface projection, approval re-authentication, and design-document phase parsing. (The sixth — an entire manual gate lifecycle, nearly a second implementation of the first — left with the degraded-mode retirement, #1.) The file is now split along those seams with no behavior change: `gate-core.ts` (shared vocabulary, dependency types, small pure helpers), `gate-approvals.ts` (the approval trust brand — WeakSet, assert, and the single mint site in `loadAuthenticatedGateApproval`, co-resident so minting stays module-private), `gate-decision-interface.ts` (decision templates and the human decision file), `legacy-import-resume.ts`, `planned-final-phase.ts`, and a ~900-line `gates.ts` that keeps the gate lifecycle itself.

### 3. Double protocol validation in `mcp/` — questionable weight

`session.ts` (554 lines) is a full JSON-RPC state machine with per-method key allowlists — and then the MCP SDK validates the same messages again, with bespoke reconciliation in `sdk-adapter.ts` for when the two disagree. The output-fidelity check also computes every tool result's projection twice. The containment stance ("the SDK is not the authority") is coherent, but this is the single biggest complexity concentration in `mcp/` — worth deciding explicitly how much SDK distrust the prototype needs.

### 4. Dual shape authorities in `contracts/` — duplication by design, expensive in practice

Agent-facing shapes exist as JSON Schema *and* a Zod mirror, with `assertZodAgreement` proving they match — three artifacts per shape. The error taxonomy exists in full twice (a 2,835-line schema and `errors.ts`). Four custom Ajv keywords carry business logic that also partly exists in `durable.ts` — meaning some rules live in *three* places, and external schema consumers can't evaluate the custom keywords anyway, which undercuts the "schemas are the published authority" motivation. Zod can emit JSON Schema; one generated authority would collapse the whole class.

### 5. Four CLI commands overlap `build-request` — resolved 2026-08-11

`task-init`, `build-document`, and `build-implementation-output` were each mostly subsumed by a `build-request` kind; their last remaining callers went away with the degraded-mode retirement (#1) and a phase-impl skill update, and all three are retired. `hash` stays — the gate-counter recipe's printed instructions still use it.

### 6. `fixed-point.ts` gate satisfaction — load-bearing logic in an unreadable shape

`adjudicationGateSatisfied` is a ~20-clause boolean conjunction where every clause is a silent `continue` with no diagnostic. Decomposing into named predicates that report *which* binding failed would improve both auditability and debuggability. Similarly, `handleCounterReview` (~387 lines, now running both the rubric dispatch and the constitution-review dispatch and committing them in one transaction) is the densest handler.

### 7. Naming collisions and small frictions

- **Two unrelated "envelopes"** — the call envelope (`src/local/envelope.ts`) and the dispatch envelope (`src/review/envelopes.ts`). A rename removes a permanent source of confusion.
- **Exit codes lie** — resolved 2026-08-11: it was a bug. Any `{"ok": false}` result now also exits nonzero, and the skills' prose compensations are gone; the JSON body remains the authority for structured details.
- **A ~30-line prose recipe as a string literal** in production code (`renderGateCounterPrompt`) embeds exact CLI command lines; any rename silently invalidates it unless a test pins it.
- **`commands.ts` mixes dispatch with implementation** — three commands have full bodies inline in the dispatcher; extracting them leaves a pure table.
- Small duplicated helpers: strict-UTF-8 decoding appears inline in at least four places; `visibleContent`/`visibleBytes` are the same function twice.

### 8. Version-coupled external surfaces — fragility, not complexity

The child-CLI lockdown argvs (long literal flag lists per host) and the regex-based failure classifier in `dispatch/cli.ts` will drift as the `claude`/`codex` CLIs evolve. When a host update breaks dispatch, look here first.

### 9. Things that look removable

- **`workflow.ts`** parses workflow YAML and then rejects anything that doesn't deep-equal a hard-coded constant — a full file/schema/parse pipeline validating a compile-time value.
- **Five orphaned schemas** (referenced by nothing) and two release/legal schemas (~800 lines) tangential to the workflow the server runs.
- **`internal/test-capabilities.ts`** — 248 lines of test factories in the production tree, imported by three production modules that would need untangling first.
- **Advertised-schema pruning** in `mcp/tools.ts` — a small custom JSON-Schema `$ref` resolver owned forever, motivated by a measured 179 KB saving; worth keeping only while that saving matters.
- **The `unified-diff` tier** — with 40 context lines it's nearly full-file for most real files; it's fair to ask whether the hand-rolled Myers diff (~200 lines, with an 8 MB worst-case allocation pattern) earns its place over "embed or digest-only."

## What is genuinely load-bearing (don't soften)

For balance — machinery that directly implements the trust boundaries and should survive any simplification pass:

- The **transaction kernel** (receipt-as-commit-point, CAS, arbitration of crash windows) — this is why state is never guessed.
- **Canonical JSON + strict re-render parsing + domain-tagged digests** — why "same digest" means "same bytes" everywhere.
- **`assertPlainJson` + materialize-once** — closed a real bug class (split observation), not a hypothetical one.
- The **WeakSet trust-brand pattern** — why approvals, review sets, and write authority cannot be forged by shape. Non-obvious but cheap, and it's the codebase's signature.
- **Fail-closed pinned context** and the closed envelope shape — why review evidence can't be quietly narrated around.
- **Root-bound git runner + `.gitattributes` pinning + "absence is never exit 128"** — each closed a reproduced silent-wrong-answer hole.
- The **two-phase, human-confirmed lock repair** — honest about what filesystem locks can and cannot guarantee.

## Suggested audit order

1. ~~Decide the degraded-mode question (#1)~~ — decided and done: degraded mode is read-only status only.
2. Split `gates.ts` (#2) and name the predicates in `fixed-point.ts` (#6) — pure readability, no behavior change.
3. Pick one shape authority (#4) — mechanical, high leverage.
4. Sweep the small items (#7, #9) opportunistically as touched code (#5 is done).
5. Revisit SDK distrust (#3) only with a deliberate decision about the threat model, since it changes a security stance.
