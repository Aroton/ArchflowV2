# COMPLEXITY

**Explored:** 2026-08-12 · **Commit:** `ae25739` · **Covers:** the whole repository

A per-subsystem audit of where the machinery is heaviest, what it buys, and what could be simplified. Written to support iterating on the workflow — each item states the concrete problem the complexity solves so a simplification can be judged against it, per the engineering priorities in CLAUDE.md.

## How to read this

Three categories recur:

- **Load-bearing** — the complexity directly implements a human trust boundary. Simplify the *implementation*, never the guarantee.
- **Duplication** — the same logic or shape exists twice or more; consolidation is nearly free correctness.
- **Questionable weight** — machinery whose cost may exceed its prototype-stage value; candidates for the "documented limitation instead of a subsystem" trade.

## Ranked simplification targets

### 1. The manual/offline parallel universe (state layer) — resolved 2026-08-11

The audit asked directly: how often is the MCP server actually down, and could degraded mode shrink to "read-only status + stop" instead of a full recording workflow? It could, and it did. `manual-import.ts`, `manual-checkpoints.ts`, the manual half of `gates.ts`, and the `manual-workflow.ts` driver (~3,000 lines of mirror machinery, every normal-path invariant change carrying a mirror obligation) are retired; `manual-status` survives as a read-only classifier. Pre-retirement checkpoint chains are stranded with no recovery path — see `LIMITATIONS.md`.

### 2. `gates.ts` at 2,311 lines — resolved 2026-08-11

**Resolved 2026-08-11.** The audit found at least five responsibilities in one file: gate lifecycle, decision templates, interface projection, approval re-authentication, and design-document phase parsing. (The sixth — an entire manual gate lifecycle, nearly a second implementation of the first — left with the degraded-mode retirement, #1.) The file is now split along those seams with no behavior change: `gate-core.ts` (shared vocabulary, dependency types, small pure helpers), `gate-approvals.ts` (the approval trust brand — WeakSet, assert, and the single mint site in `loadAuthenticatedGateApproval`, co-resident so minting stays module-private), `gate-decision-interface.ts` (decision templates and the human decision file), `legacy-import-resume.ts`, `planned-final-phase.ts`, and a ~900-line `gates.ts` that keeps the gate lifecycle itself.

### 3. Double protocol validation in `mcp/` — resolved 2026-08-11

The audit asked for an explicit decision about how much SDK distrust the prototype needs, and the decision was made: the pinned, behaviorally-probed SDK is the JSON-RPC authority, and ArchFlow's authority begins at the tool boundary. `session.ts` (554 lines) is deleted; the flow is now framer → SDK dispatch → send-queue inside a ~385-line adapter. Every defense the session re-implemented — shape triage, ID normalization and duplicate-ID tombstones, per-method key allowlists, the external↔internal ID rewrite, cancellation and response arbitration, the eager spec-schema pre-pass — is replaced by a behavioral pin in `probe-mcp-sdk-compatibility.mjs`, so drift fails the gate rather than shipping. The tool result's projection is computed once. What the trade gives up — adversarial-stdio-peer defenses, prose-free wire errors — is a documented limitation in `LIMITATIONS.md`; the tool boundary's validation and trust brands are unchanged.

### 4. Dual shape authorities in `contracts/` — resolved 2026-08-11

Agent-facing shapes existed as JSON Schema *and* a Zod mirror, with `assertZodAgreement` proving they matched — three artifacts per shape, with some rules living in a *third* place (custom Ajv keywords). Zod is now the single runtime authority: 34 of the 35 committed schemas are generated from it (`generate:schemas` / `check:schemas`), the release manifest stays hand-written, keyword logic became Zod refines, and Ajv left production entirely — it is a dev dependency compiled only by `test/helpers/json-schema.ts` and the release scripts.

### 5. Four CLI commands overlap `build-request` — resolved 2026-08-11

`task-init`, `build-document`, and `build-implementation-output` were each mostly subsumed by a `build-request` kind; their last remaining callers went away with the degraded-mode retirement (#1) and a phase-impl skill update, and all three are retired. `hash` stays — the gate-counter recipe's printed instructions still use it.

### 6. `fixed-point.ts` gate satisfaction — resolved 2026-08-11

The audit found `adjudicationGateSatisfied` as a ~20-clause boolean conjunction of silent `continue`s and `handleCounterReview` as the densest handler. Both are decomposed with zero behavior change: gate satisfaction is now named binding-failure predicates (`approvalBindingFailure`, `requestBindingFailure`, `decisionBindingFailure`, `evidenceBindingFailure`) aggregated by an exported evaluator that reports *which* binding failed first, `assessCurrentEvidence` is named steps ending in a priority-ordered `decideNextAction`, and the counter-review handler's four large closures are module-level functions — the transaction planner's new explicit inputs bag documents exactly what the atomic commit depends on.

### 7. Naming collisions and small frictions

- **Two unrelated "envelopes"** — resolved 2026-08-11: the call envelope is now `src/local/call-envelope.ts`, distinct from the dispatch envelope (`src/review/envelopes.ts`).
- **Exit codes lie** — resolved 2026-08-11: it was a bug. Any `{"ok": false}` result now also exits nonzero, and the skills' prose compensations are gone; the JSON body remains the authority for structured details.
- **A ~30-line prose recipe as a string literal** in production code (`renderGateCounterPrompt`) embeds exact CLI command lines — now pinned by a test asserting every `archflow-local <name>` it prints is a published command.
- **`commands.ts` mixes dispatch with implementation** — resolved 2026-08-11: every command body is a named module-level handler; `runLocalCommand` is a pure dispatch table.
- Small duplicated helpers — resolved 2026-08-11: strict-UTF-8 decoding and the `visibleContent`/`visibleBytes` twins are one shared `src/contracts/utf8.ts` module with a single `TextDecoder` singleton.

### 8. Version-coupled external surfaces — fragility, not complexity

The child-CLI lockdown argvs (long literal flag lists per host) and the regex-based failure classifier in `dispatch/cli.ts` will drift as the `claude`/`codex` CLIs evolve. When a host update breaks dispatch, look here first.

### 9. Things that look removable

- **`workflow.ts`** parses workflow YAML and then rejects anything that doesn't deep-equal a hard-coded constant — a full file/schema/parse pipeline validating a compile-time value. Deliberate keep (2026-08-11): 47 tested lines; the pinned graph now also anchors the generated `workflow.schema.json` emission, so removal is no longer free.
- **Orphaned schemas** — resolved 2026-08-12: the true orphans (`authority-link`, `evidence-reference`, and the retired dependency-review receipt) are deleted; only the release manifest stays by declared exception as a hand-written input to `release-support.mjs`.
- **`internal/test-capabilities.ts`** — resolved 2026-08-11: the three production-imported factories now live in `internal/trust-mints.ts` (mints beside the `trust-brands.ts` registries they register with); `test-capabilities.ts` keeps only test-only factories and no production module imports it.
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
2. ~~Split `gates.ts` (#2) and name the predicates in `fixed-point.ts` (#6)~~ — done: six focused gate modules; named binding-failure predicates.
3. ~~Pick one shape authority (#4)~~ — done: Zod generates the schemas; Ajv is dev-only.
4. ~~Sweep the small items (#7, #9)~~ — done except the two deliberate keeps: the advertised-schema pruner (still buying its measured saving) and the `unified-diff` tier (documented limitation; behavior-changing to remove).
5. ~~Revisit SDK distrust (#3)~~ — decided and done: the pinned, probed SDK is the JSON-RPC authority; the session layer is retired.
