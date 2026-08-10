# Client-ergonomics redesign of the `archflow-local` / MCP request surface

## Context

A client agent driving one PRD produce step through `archflow-local` + the five MCP tools needed six commands and three full manual transcriptions of ~1 KB JSON, and hit three defects: (1) `status` emits a prefilled `run-step` template the server always rejects mid-produce (`TRANSITION_INVALID`, running→running); (2) the template prefills a stale `input_fingerprint` that `envelope` then contradicts; (3) skills require `subject_digest` "from status" but status never emits it — and the client's hand-derivation from source actually got the **wrong value** (the true subject is `canonicalJsonDigest` of the whole `DocumentArtifactV1` envelope, `manifest.artifact_digest`, not the document's `content_digest`). Adopted framing: **every hand-copied digest is a transcription risk the digest system exists to eliminate — removing transcription is an integrity improvement.** Fail-closed digest binding, closed-schema validation, and human gates are never weakened.

All defects verified in code:
- `src/state/next-action.ts:181-185` — selects `run-step`/`produce` purely from absence of an authoritative produce result; never reads `state.step`/`state.status`, so `produce-running` ≡ "not started".
- `src/state/request-templates.ts:129-138` — hardcodes `status: "running"`; `mechanicalPrefix` (`:44-52`) copies stale `state.input_fingerprint`. `src/state/transitions.ts:105-113` rejects running→running.
- `src/state/status.ts:575-588` computes the subject digest, `:762-782` never emits it; `evidence.subject_digest` exists only after **both** reviews are retained.
- Three request wrappings coexist: MCP wire `{name, arguments}`, envelope stdin `{tool, input}` (`src/local/envelope.ts:187-194`), status `next_action.request` `{tool, template, guidance}` (`src/state/next-action.ts:36-40`).
- Tests pinning the defective behavior: `test/unit/state-next-action.test.ts:144-149`, `test/unit/request-templates.test.ts:60-74`. No test round-trips a derived template through envelope to a real tool call.

Two load-bearing facts discovered during design:
- **The fingerprint subject never reads the request's own `input_fingerprint`** (`src/state/fingerprint.ts:95-105`), but a produce request's **request digest** folds in `artifact_digest` (`src/state/request.ts:41`), and the artifact embeds its own `input_fingerprint`. That coupling — not client education — is the real origin of the skills' two-pass prose. Internal substitution in the helper removes it: one external pass, always.
- **`computeCallEnvelope` reads only `tool` and `input` and ignores extra keys**, so unifying the canonical shape is nearly free.

## Decisions (requirements → resolutions)

1. **Canonical shape** = `{"tool": …, "input": …}` (the existing envelope stdin shape). `status.next_action.request` becomes exactly that (rename `template` → `input`; move `guidance` up to `next_action.guidance`). `envelope` output gains the resolved `request: {tool, input}`. MCP wire `{name, arguments}` is protocol-fixed; documented once as the mechanical projection `name ← tool`, `arguments ← input`.
2. **Template rule**: a template's mechanical fields (`phase_instance`, `step`, `status`) are derived from durable state through the **same legality predicate the server enforces** — a template is emitted only if its target is a legal transition from the state it was derived in. Judgment fields stay fail-closed prose placeholders (the existing discipline in `request-templates.ts:10-13`). `input_fingerprint` prefills become the all-zero sentinel (valid hex, guaranteed-wrong, replaced by resolution; skipping envelope still fails closed at the server) — except gate/waiver templates, where `state.input_fingerprint` is genuinely correct (`envelope.ts:151-153` returns exactly it). Covered by a round-trip test against real handlers, not shape assertions.
3. **Composition**: new produce-only `build-request` command: intent + (optionally) document facts → the complete resolved terminal `archflow_state` request. No universal intent router — after the other fixes, status already emits executable requests for everything else (YAGNI per CLAUDE.md).
   *Reversed 2026-08-10*: a full PRD loop run showed 8 of 10 requests still hand-authored through printf (self-review, triage, running boundaries) with only findings/dispositions being genuine judgment. `build-request` now composes every request kind — `running`, `self-review`, `triage`, `counter-review`, `adjudicate`, and `gate` — deriving all mechanical fields (including `rubric_digest`, which retires the separate `archflow-local hash` step) and passing judgment content through verbatim.
4. **Fingerprint resolution is internal to `envelope`**: substitute → re-identify → emit resolved request. Two-pass prose is deleted, not documented — its only justification (the artifact-digest coupling) is removed. Envelope remains a convenience preview, never an authority: the server still independently recomputes the fingerprint (`src/state/transaction.ts:402-416`).
5. **Status completeness**: emit top-level `subject_digest` (whenever loadable) and `expected_self_review_provenance` (always, from routes); prose names the exact fields.
6. **MCP handoff**: the copy cannot be eliminated (arguments come from the model) — make it single and trivially verifiable: exactly one verbatim copy of `request.input`, plus the tool success result echoes `request_digest` so the client compares one 64-hex string against the helper's.
7. **Payload size**: after 3+4, the produce path's stdin payload drops to one ~60-byte intent line; remaining large stdin bodies are judgment artifacts (self-review, triage) the agent must author anyway — unchanged.
8. **Schema budget**: measure first, then trim only the advertised **output** projection (dominant known cost: the result-side `project-error` union, ~⅓ of the shared block per `src/mcp/tools.ts:143-148`); tighten the byte fence to the measured number + headroom. Input schemas and all closed-schema validation untouched.

Contestable calls made (reverse at review if desired):
- Keep code `run-step` for mid-step states (distinct `detail` + correct template) rather than adding a `record-step-result` code — a new code ripples through four skills for no behavioral gain.
- `build-request` derives canonical per-phase `document_path`/`declared_inputs` defaults (moves facts from prose into one shared module also used by templates).
- Echo `request_digest` in tool success values (small additive result-schema change across five tools; it is what makes the model-typed copy *trivially* verifiable).

## Phases

Each phase is independently landable and testable. Run the three `test/contracts/skill-contract-*.test.ts` suites every phase — they are the prose tripwire.

### Phase 1 — Truthful next action + legality-derived templates (defect 1, template half of defect 2)

- `src/state/transitions.ts`: extract/export a pure `nextLegalSameSubjectTarget(state)` helper shared with `legalMovement`: `running` → same-step `succeeded|failed` (terminal record); `failed` → same-step `running` retry (attempt stays server-derived, never in templates); `succeeded` → successor step's `running` entry.
- `src/state/next-action.ts` (`:181-185`, and the fall-through at `:203`): branch on `state.status` when no authoritative produce result exists — `running` → `run-step`/`produce` with detail "Record the terminal produce result"; `failed` → retry detail. Same treatment for `self_review`/`triage` continuation.
- `src/state/request-templates.ts`: replace hardcoded `status: "running"` (`:133`) with the derived legal target. Mid-produce the emitted template is the terminal `status: "succeeded"` request with a fail-closed artifact placeholder whose guidance names the `build-request` invocation (Phase 4); `failed` alternative named in guidance. Replace `input_fingerprint: state.input_fingerprint` (`:50`) with the `"0".repeat(64)` sentinel for state/counter-review/adjudicate templates; keep the state value for gate/waiver templates.
- Tests: update `test/unit/state-next-action.test.ts:144-149` (produce-running now derives the terminal-record action) and `test/unit/request-templates.test.ts:60-74`; add a unit test asserting **every** emitted template's target passes `planStateTransition` legality from the state it was derived in, for every reachable `(step, status)`.

### Phase 2 — `envelope` resolves the fingerprint internally (defect 2; kills the two-pass)

- `src/local/envelope.ts` (`computeCallEnvelope`): after `fingerprintFor`, substitute the fingerprint into **exactly two contract-defined places** — `input.input_fingerprint` and, when present, `input.artifact.input_fingerprint` — re-parse the resolved call, run `identifyTransactionRequest` over *that*. Output adds `request: {tool, input}` (resolved); `request_digest`/`artifact_digest` now describe the resolved request. Keep the substitutor an explicit two-field function — never generic digest rewriting (retry chains embed `prior_input_fingerprint`; waiver inputs embed `origin.input_fingerprint`; neither may be touched — add a fixture for each).
- Envelope becomes idempotent: `envelope(envelope(x).request) ≡ envelope(x)` — pin with a test.
- Tests: rewrite the manual two-pass dance at `test/integration/local-cli-command-surface.test.ts:160-178` to consume `request`; idempotence + non-substitution fixtures. `test/real-host/terminal-journey.test.ts` is safe (asserts with `toMatchObject`; no existing output field renamed).

### Phase 3 — Canonical request shape + status completeness (defect 3; reqs 1, 5)

- `src/state/next-action.ts`: `NextActionRequest` becomes `{tool, input}`; `guidance` moves to a `next_action.guidance` sibling. `src/state/request-templates.ts` return shape follows. Result: `status.next_action.request` is byte-pipeable to `envelope` once placeholders are filled.
- `src/state/status.ts`: emit top-level `subject_digest` whenever the produce subject loads (the `:577` guard stays — mid-produce absence is correct); emit `expected_self_review_provenance` = `{assurance: "agent-declared", producer_family, model_family, model, effort}` derived from `routes` (always present when routes resolve), distinct from the retrospective `evidence.self_review_provenance`. Additive frozen fields only (`manual-workflow.ts` embeds `task_status` verbatim).
- Tests: `test/unit/state-status.test.ts` (new fields, request shape), `test/unit/request-templates.test.ts`, frozen-plain-JSON walkers over new fields.

### Phase 4 — `build-request` composer (reqs 3, 7)

- New `src/local/build-request.ts`; register in `src/local/commands.ts` (`LOCAL_COMMANDS`, `LOCAL_COMMAND_CONTRACTS`, dispatch) + `src/local/main.ts` usage. Payload: `{"intent_id": …, "document": {document_path, declared_inputs}?}` or `{"intent_id": …, "implementation": {…}}`; `--task` required.
- Behavior: read durable state → derive `phase_instance`/`step`/`expected_revision` → `buildDocumentArtifact`/`buildImplementationOutput` with placeholder fingerprint → assemble the full terminal `archflow_state` request → resolve through `computeCallEnvelope` → return `{request: {tool, input}, input_fingerprint, request_digest, artifact_digest}`.
- Extract the canonical per-phase defaults (`reviewPaths` + declared-input table currently living in skill prose: prd→`ask.md`/`user-ask`, etc.) into one shared module used by both `request-templates.ts` and `build-request`, so `document` may be omitted for document phases.
- The produce sequence becomes: draft `prd.md` → `build-request` → one MCP call with `request.input`.
- Tests: integration coverage in `local-cli-command-surface.test.ts` (or dedicated file); stdin-discipline/usage-table tests in `local-cli-payload-input.test.ts` update automatically from the contracts table — verify.

### Phase 5 — Round-trip executability test (req 2's test; gate on phases 1–4)

- New `test/integration/status-request-roundtrip.test.ts` on the `temp-repository` + `createProductionServices` + `createToolHandlers` pattern (see `mcp-handlers.test.ts`): loop `computeTaskStatus` → take `next_action.request` → fill **only** placeholders via the prescribed helper (`build-request` for produce-terminal; literal rubric for counter-review) → `computeCallEnvelope` → invoke the real handler with `request.input` → assert `ok`. Intent assertions: **no `TRANSITION_INVALID` and no `INPUT_FINGERPRINT_MISMATCH` ever occurs on a derived action.** Cover explicitly: the mid-produce state (record running, re-status, derived request records the terminal result and executes) and fingerprint drift (mutate `ask.md` between status and build-request; call still succeeds because resolution happens at build time).
- Convert **one** step of `test/real-host/terminal-journey.test.ts` to consume `next_action.request` + envelope `request` for real-host parity.

### Phase 6 — Skill prose overhaul

- All four phase skills (`skills/archflow-{prd,design,phase-design,phase-impl}/SKILL.md`) + `archflow-status`: delete the two-pass produce recipes (prd:32-36, design:30, phase-design:30-32, phase-impl:36) in favor of the one-envelope/`build-request` flow; name the exact new status fields (`subject_digest`, `expected_self_review_provenance`) everywhere prose currently says "from status"; state that the subject digest is the canonical artifact-envelope digest, never the document content hash, and never hand-computed; document the single MCP re-wrap (`name ← tool`, `arguments ← input`) and the `request_digest` comparison against the tool result echo; keep the stdin rule and the template-verbatim sentence (adjusted to the `{tool, input}` shape).
- Tests: `test/contracts/skill-contract-canonical.test.ts` shared-prose assertions (verified: no pinned sentence covers the sections being rewritten, but re-run all three suites).

### Phase 7 — Result `request_digest` echo + schema budget (req 6 finish, req 8; independent, measure-first)

- `src/mcp/handlers/state.ts` (`success` at `:157-161`) + sibling gate/review/waiver handlers: add `request_digest` to the tool success value; additive change to the result fragments in `mcp-tools.schema.json`. Durable receipts already carry it; replay semantics unchanged.
- Schema budget: (a) add a per-tool × member × `$defs`-key measurement breakdown (script or test annotation) so trimming is evidence-driven; (b) the one known safe cut is the advertised **output** `project-error` union — replace with an *open* summary shape (required `{code, owner, retryable, next_action}`, `additionalProperties: true`, so real results still validate against it); (c) optionally strip `description` strings from advertised (not normative) projections; (d) tighten the fence at `test/contracts/mcp-advertised-schema.test.ts:365` to measured + ~20% headroom. Exact-reachable-closure assertions and all server-side validation retained. If measurement shows the win is small, stop after (a) and keep the current fence.

## Not doing

- ~~No universal build-request intent router~~ (reversed 2026-08-10 — see decision 3); no new NextAction codes; no relaxation of any digest check, closed schema, or transition rule; ~~no scratch-file contract (stdin rule stays)~~ (reversed 2026-08-10 — prose payloads carrying authored text now go via `--input <json-file>`; the stdin rule broke on apostrophes/backticks in findings, and the server's own gate-counter recipe already instructed scratch files); no changes to `transitions.ts` legality semantics — templates conform to the law, never the reverse.
- Still not doing after the 2026-08-10 reversal: no `archflow_waiver` composer and no adjudication-triggered gate-kind composers in `build-request` (status does not prefill those either; the gate-counter recipe covers the waiver path).

## Verification

- Per phase: the named unit/integration suites plus all three `skill-contract-*` contract suites.
- End-to-end: Phase 5's round-trip test is the acceptance test for the client's original complaint — it mechanically replays the failing scenario (status mid-produce → derived request → real handler) and the drift scenario.
- Full: `npm test` (unit + integration + contracts); real-host `terminal-journey` after Phase 5's conversion; after Phase 7, the schema-budget fence with the new measured number.
- Manual: re-run the client's PRD flow — expected shape: draft `prd.md` → `build-request` (one small stdin line) → one MCP call, zero hand-copied digests, `request_digest` in the tool result matching the helper's.
