# COMPLEXITY

**Explored:** 2026-08-10 · **Commit:** `50a218d` · **Covers:** the whole repository

A per-subsystem audit of where the machinery is heaviest, what it buys, and what could be simplified. Written to support iterating on the workflow — each item states the concrete problem the complexity solves so a simplification can be judged against it, per the engineering priorities in CLAUDE.md.

## How to read this

Three categories recur:

- **Load-bearing** — the complexity directly implements a human trust boundary. Simplify the *implementation*, never the guarantee.
- **Duplication** — the same logic or shape exists twice or more; consolidation is nearly free correctness.
- **Questionable weight** — machinery whose cost may exceed its prototype-stage value; candidates for the "documented limitation instead of a subsystem" trade.

## Ranked simplification targets

### 1. The manual/offline parallel universe (state layer) — duplication, biggest surface

`manual-import.ts` + `manual-checkpoints.ts` + the manual half of `gates.ts` + parts of `production.ts` (~2,000 lines) re-implement the transaction kernel's invariants for the no-MCP case, and `src/local/manual-workflow.ts` (1,014 lines) drives it. Every invariant change to the normal path carries a mirror obligation here. Worth asking directly: how often is the MCP server actually down, and could degraded mode shrink to "read-only status + stop" instead of a full recording workflow?

### 2. `gates.ts` at 2,311 lines — load-bearing but overdue for a split

At least six responsibilities in one file: gate lifecycle, decision templates, interface projection, approval re-authentication, design-document phase parsing, and the entire manual gate lifecycle (nearly a second implementation of the first). The obvious first move is splitting along those seams without changing behavior.

### 3. Double protocol validation in `mcp/` — questionable weight

`session.ts` (554 lines) is a full JSON-RPC state machine with per-method key allowlists — and then the MCP SDK validates the same messages again, with bespoke reconciliation in `sdk-adapter.ts` for when the two disagree. The output-fidelity check also computes every tool result's projection twice. The containment stance ("the SDK is not the authority") is coherent, but this is the single biggest complexity concentration in `mcp/` — worth deciding explicitly how much SDK distrust the prototype needs.

### 4. Dual shape authorities in `contracts/` — duplication by design, expensive in practice

Agent-facing shapes exist as JSON Schema *and* a Zod mirror, with `assertZodAgreement` proving they match — three artifacts per shape. The error taxonomy exists in full twice (a 2,835-line schema and `errors.ts`). Four custom Ajv keywords carry business logic that also partly exists in `durable.ts` — meaning some rules live in *three* places, and external schema consumers can't evaluate the custom keywords anyway, which undercuts the "schemas are the published authority" motivation. Zod can emit JSON Schema; one generated authority would collapse the whole class.

### 5. Four CLI commands overlap `build-request` — duplication with real remaining callers

`task-init`, `build-document`, `build-implementation-output`, and `hash` are each mostly subsumed by a `build-request` kind, but each retains one caller (degraded mode, the phase-impl skill, the gate-counter recipe's printed instructions). Retiring them means updating those callers first — cheap, but not free.

### 6. `fixed-point.ts` gate satisfaction — load-bearing logic in an unreadable shape

`adjudicationGateSatisfied` is a ~20-clause boolean conjunction where every clause is a silent `continue` with no diagnostic — and a second, independent implementation of "is this gate satisfied" lives in the adjudicate handler's replay path. Decomposing into named predicates that report *which* binding failed would improve both auditability and debuggability. Similarly, `handleAdjudicate` (386 lines, three large inline closures, two distinct replay paths) is the densest handler.

### 7. Naming collisions and small frictions

- **Two unrelated "envelopes"** — the call envelope (`src/local/envelope.ts`) and the dispatch envelope (`src/review/envelopes.ts`). A rename removes a permanent source of confusion.
- **Exit codes lie** — CLI failures return `{"ok": false}` with exit 0; every skill compensates in prose. Decide whether that's a contract or a bug.
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
- The **two-phase, human-confirmed lock repair** and the **one-writer handoff protocol** — honest about what filesystem locks and git can and cannot guarantee.

## Suggested audit order

1. Decide the degraded-mode question (#1) — it dominates the line count.
2. Split `gates.ts` (#2) and name the predicates in `fixed-point.ts` (#6) — pure readability, no behavior change.
3. Pick one shape authority (#4) — mechanical, high leverage.
4. Sweep the small items (#5, #7, #9) opportunistically as touched code.
5. Revisit SDK distrust (#3) only with a deliberate decision about the threat model, since it changes a security stance.
