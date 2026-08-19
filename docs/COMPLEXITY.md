# COMPLEXITY

**Explored:** 2026-08-16 · **Commit:** `d60da73` · **Covers:** the whole repository

A per-subsystem audit of where the machinery is heaviest, what it buys, and what could be simplified. Written to support iterating on the workflow — each item states the concrete problem the complexity solves so a simplification can be judged against it, per the engineering priorities in CLAUDE.md.

## How to read this

Three categories recur:

- **Load-bearing** — the complexity directly implements a human trust boundary. Simplify the *implementation*, never the guarantee.
- **Duplication** — the same logic or shape exists twice or more; consolidation is nearly free correctness.
- **Questionable weight** — machinery whose cost may exceed its prototype-stage value; candidates for the "documented limitation instead of a subsystem" trade.

## Current top target: the client orchestration surface

The cutover is complete. The public catalogue is exactly `archflow_status` and `archflow_apply`, and every workflow — document production, phase implementation, status reporting, and legacy adoption after its local staging and adoption steps — runs through the one read-only-view-plus-bounded-action loop. The retired legacy client loop (request templates, the request-building CLI door, staged request files, the preview/decide CLI pair, the local commit command, and the four low-level tool handlers' MCP-facing halves) is deleted rather than maintained in parallel; the request composer, the state and counter-review services, and the direct decision services survive as the semantic surface's internal machinery. The gate inversion stays resolved: a `gate-summary` opens a nonblocking presentation, and the selected decision archives and settles through freshness-bound substeps instead of a blocked call, status polling, and a second CLI writer. The simplification never moved authorship into the server: Claude Code or Codex still produces documents and code, runs verification, supplies triage and human decisions, and owns Git — every commit is client-created from the returned authorized facts and observed by read-only status. What remains of the local CLI is deliberate: bootstrap, the legacy-upgrade adapter, diagnostics, and the degraded classifier.

## Ranked simplification targets

### 1. The manual/offline parallel universe (state layer) — resolved 2026-08-11

The audit asked directly: how often is the MCP server actually down, and could degraded mode shrink to "read-only status + stop" instead of a full recording workflow? It could, and it did. The offline write path and its parallel gate/import driver (~3,000 lines of mirror machinery, every normal-path invariant change carrying a mirror obligation) are removed; `manual-status` survives as a read-only classifier, with no persisted compatibility layer.

### 2. `gates.ts` at 2,311 lines — resolved 2026-08-11

**Resolved 2026-08-11.** The audit found at least five responsibilities in one file: gate lifecycle, decision templates, interface projection, approval re-authentication, and design-document phase parsing. (The sixth — an entire manual gate lifecycle, nearly a second implementation of the first — left with the degraded-mode retirement, #1.) The file is now split along those seams with no behavior change: `gate-core.ts` (shared vocabulary, dependency types, small pure helpers), `gate-approvals.ts` (the approval trust brand — WeakSet, assert, and the single mint site in `loadAuthenticatedGateApproval`, co-resident so minting stays module-private), `gate-decision-interface.ts` (decision templates and the human decision file), `legacy-import-resume.ts`, `planned-final-phase.ts`, and a ~900-line `gates.ts` that keeps the gate lifecycle itself.

### 3. Double protocol validation in `mcp/` — resolved 2026-08-11

The audit asked for an explicit decision about how much SDK distrust the prototype needs, and the decision was made: the pinned, behaviorally-probed SDK is the JSON-RPC authority, and ArchFlow's authority begins at the tool boundary. `session.ts` (554 lines) is deleted; the flow is now framer → SDK dispatch → send-queue inside a ~385-line adapter. Every defense the session re-implemented — shape triage, ID normalization and duplicate-ID tombstones, per-method key allowlists, the external↔internal ID rewrite, cancellation and response arbitration, the eager spec-schema pre-pass — is replaced by a behavioral pin in `probe-mcp-sdk-compatibility.mjs`, so drift fails the gate rather than shipping. The tool result's projection is computed once. What the trade gives up — adversarial-stdio-peer defenses, prose-free wire errors — is a documented limitation in `LIMITATIONS.md`; the tool boundary's validation and trust brands are unchanged.

### 4. Dual shape authorities in `contracts/` — resolved 2026-08-11

Agent-facing shapes existed as JSON Schema *and* a Zod mirror, with `assertZodAgreement` proving they matched — three artifacts per shape, with some rules living in a *third* place (custom Ajv keywords). Zod is now the single runtime authority: 31 of the 32 committed schemas are generated from it (`generate:schemas` / `check:schemas`), the release manifest stays hand-written, keyword logic became Zod refines, and Ajv left production entirely — it is a dev dependency compiled only by `test/helpers/json-schema.ts` and the release scripts.

### 5. Four CLI commands overlap `build-request` — resolved 2026-08-11

`task-init`, `build-document`, and `build-implementation-output` were each mostly subsumed by a `build-request` kind; their last remaining callers went away with the degraded-mode retirement (#1) and a phase-impl skill update, and all three are retired. `hash` stays as a low-level diagnostic tool; the optional gate-counter recipe that once depended on it has been removed. (The request-building command itself later left with the semantic cutover — see #10.)

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
- **Advertised-schema pruning** in `mcp/tools.ts` — resolved with the catalogue cutover: the advertised catalogue is now the two generated semantic schemas, and the custom `$ref` resolver with its legacy merge branches is deleted rather than owned forever.
- **The `unified-diff` tier** — with 40 context lines it's nearly full-file for most real files; it's fair to ask whether the hand-rolled Myers diff (~200 lines, with an 8 MB worst-case allocation pattern) earns its place over "embed or digest-only."

### 10. The semantic façade coexisted with the legacy surface — resolved with the cutover

This duplication was intentionally transitional and is now gone. `src/state/request-composition.ts` is the single derivation service, called only by the semantic action planner; the thin legacy adapter that exposed it as a CLI command is deleted. `semantic-actions.ts` plans one fixed action and returns; it does not dispatch producer work or cross into a newly offered action. Direct gate decisions are archived immutably and then settled in a separate authenticated substep. A revision settlement closes the gate only; `revise-enter` separately opens the write window, preventing decision authority from also becoming document-write authority.

The internal planning-restart operation remains the bounded restart kernel's entry point, while semantic reopen derives its target and impact rather than accepting those mechanical fields from the client. The four low-level tool names stay exported as durable-record vocabulary — existing state cites them in transitions, gate archives, and receipts — which is what let the cutover retire advertisement and dispatch without invalidating a single durable record.

## What is genuinely load-bearing (don't soften)

For balance — machinery that directly implements the trust boundaries and should survive any simplification pass:

- The **transaction kernel** (`last_transition`, CAS, and arbitration of temporary recovery receipts across crash windows) — this is why state is never guessed while receipts can still be cleaned after durable state replacement.
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
4. ~~Sweep the small items (#7, #9)~~ — done except one deliberate keep: the `unified-diff` tier (documented limitation; behavior-changing to remove). The advertised-schema pruner left with the two-tool cutover.
5. ~~Revisit SDK distrust (#3)~~ — decided and done: the pinned, probed SDK is the JSON-RPC authority; the session layer is retired.
