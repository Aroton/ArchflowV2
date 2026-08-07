# Context notes for mcp-e2e-test PRD (gathered 2026-08-04)

Sources: two Explore agents (implementation/test map; git-history validation timeline) plus live findings from this session. Raw inputs for drafting `.archflow/tasks/mcp-e2e-test/prd.md`.

## Session-observed defects (found organically, before PRD drafting)

1. `archflow-local task-init` on a canonically-uninitialized repo (no `.archflow/config.yaml`) maps template ENOENT to retryable `IO_ERROR` / `retry-unchanged-attempt` — permanent condition presented as transient; `status` said `create-task` instead of `initialize-repository`. (src/init/task-initialization.ts createTaskConfig; bundle line ~51519)
2. Phase 21 installed-validation ran a real install into the operator's real `$HOME`, silently replacing legacy skills with canonical ones (`~/.claude/skills`, `~/.agents/skills`, `.archflow-installed` marker + bundle stamped Aug 4 19:36). Environment contamination between validation and daily use; user expected legacy skills.

## Test inventory (current)

- 160 test files, ~1241 cases: unit 102 files/~768, contracts 21/~278, integration 28/~142 (real git repos, real child processes, real bundles, fake CLIs), crash 4/~30 (real SIGKILL at write cuts), real-host 5/~23 (opt-in `ARCHFLOW_REAL_HOSTS=1`; benchmark needs `ARCHFLOW_REVIEW_BENCHMARK=1`).
- Run: `npm test`, `npm run check` (full gate), `npm run test:real-host` (opt-in, `--no-file-parallelism`), `npm run bench:review`.
- CI (`.github/workflows/ci.yml`): full check on Node 24.15.0/24.18.0 + release stage/compare. CI never runs real-host or installed-launcher tests.
- `install-script-phase16.test.ts` runs `install.sh --claude` into temp HOME (payload verification, PATH failure message). `terminal-journey.test.ts` (opt-in) installs from tracked dist/ into scratch HOME and drives installed launchers through 12 scenarios; asserts real `~/.claude/skills` byte-unchanged (yet the real install still happened separately — see defect 2).

## Phase 21 validation ledger (docs/release-validation.md @ HEAD 2090a4a)

- VAL-01 **blocked**: neither operator journey (Claude-producer, Codex-producer) executed; evidence files `docs/validation/journey-val01-claude.md`, `journey-val01-codex.md` do not exist. Post-Amendment-2, installed discovery verified healthy on both hosts (Claude enumerates 5 tools; Codex fetched catalogue, attempted archflow_state).
- Amendment 2 root cause: strict clientInfo schema (extra fields from real hosts: Claude title/description/websiteUrl; Codex title) killed server at connection-ready before tools/list. Found only by manual probing — invisible to entire automated suite. Regression now unit-level only.
- Open: non-interactive `codex exec` cancels MCP tool calls host-side ("user cancelled MCP tool call", no tools/call frame reaches server) — no real Codex tool call has ever landed on the server.
- VAL-12 **pending**: server-absent manual journey unexecuted (`journey-val12-manual.md` missing).
- VAL-09 **partial**: real pending-gate MCP timeout never observed; protocol-era mismatch (Codex requests 2025-06-18, server pins 2025-11-25) needs interoperability review; no automated era-mismatch test.
- VAL-08 partial: real TIMEOUT / OUTPUT_OVERFLOW / RATE_LIMITED / logged-out AUTH_UNAVAILABLE fake-CLI-only by design.
- VAL-02 closed: thresholds.json detection 2/3, false-blocker 0, bound to benchmark digest, explicit-user-approval. (Earlier 83.3% false-blocker failure superseded by rubric recalibration.)
- VAL-07 partial (owner-accepted): no OS-enforced containment for dispatch children. VAL-16 partial (owner-accepted): no installed two-phase slice. VAL-14 blocked (external legal, Phase 22 owns).
- Real Claude adjudication never produced a normatively valid observation (uncertain_rule_versions contradiction) — one real direction unproven.
- MCP rev 2026-07-28 hosts spawn a probe child: every real connection starts the server twice; no assertion may depend on process count.
- Runbook hygiene: journeys use process-scoped `--strict-mcp-config --mcp-config`, `claude -p --no-session-persistence`, `codex exec --ephemeral` to avoid granting durable trust to temp paths.

## Gap list (agent's raw findings)

1. No test drives server through a real MCP client library/host; `@modelcontextprotocol/client` forbidden by repository-boundary test; all protocol tests hand-roll JSON-RPC; terminal-journey fakes clientInfo itself. (Consequence: Amendment 2 class of bug.)
2. No automated protocol-era-mismatch (2025-06-18 vs 2025-11-25) test.
3. notifications/*, resources/*, prompts/*, sampling, protocol-level cancellation only covered by adversarial-bytes fixture.
4. No skill is ever executed: skill tests grep SKILL.md text only; no "prompt → skill → MCP tool → durable state" test; archflow-explore/archflow-status/init agents have no contract test at all.
5. Operator journeys (VAL-01 x2, VAL-12) never executed — manual runbooks in docs/real-host-journeys.md.
6. Real-host suites never in CI; adapter drift vs real claude/codex versions undetected at merge.
7. install.sh --codex and no-flag both-hosts paths not separately asserted (phase16 test uses --claude only).
8. No test that a real host actually loads/connects via ArchFlow-written `.mcp.json`/`.codex/config.toml` (runbooks use process-scoped configs instead).
9. Stale context docs: architecture.md/state-and-contracts.md claim inert runtime, miss src/init, src/local, src/mcp/handlers, real-host tests; wrong counts (76/10 vs actual 102/28).
10. test/types/mcp-sdk-public-surface.ts not picked up by vitest glob (typecheck-only).
11. Documented open boundaries (docs/reliability-security-limitations.md): no OS containment, dispatch child can read repo + real $HOME, Codex tool-surface emptiness unprovable, openResolved TOCTOU, setsid() escapees.

## Implementation map (abbrev)

- Deliverables: archflow-mcp (src/main.ts → dist/archflow-mcp.mjs), archflow-local (src/local/main.ts → dist/archflow-local.mjs, 21 commands), 8 skills, scaffold assets. ~30.5k LoC TS, 162 files, 45 JSON Schemas.
- Subsystems: src/mcp (framing/session/send-queue/server/sdk-adapter, pinned protocol 2025-11-25) + src/mcp/handlers (live 5-tool registry); src/contracts (Ajv+Zod dual, validateDurableSemantics); src/state (~30 files durable kernel, gates, checkpoints, manual mode, reconciliation); src/repository (git+path safety); src/dispatch (routing FAMILY_MISMATCH, cli adapters, workspace disposable HOME, coordinator); src/review (envelopes, counter-review, adjudication, fixed-point DEFAULT_MAX_ATTEMPTS=3); src/init; src/local (manual-workflow.ts 1008 lines).
- 5 tools: archflow_state/counter_review/adjudicate/gate/waiver; CommonToolInput {schema_version, task_id, intent_id, expected_revision, input_fingerprint}.
- Gates: 9 kinds, deterministic g-<sha256>, immutable decisions/ archive, disposable gate.json interface, supersession GATE_SUPERSEDED. Waiver = gate with origin re-authenticated from archived request+decision.
- Install: install.sh verifies manifest sha256+size fail-closed, stages to ~/.archflow/bundle, launchers to ~/.local/bin, skills with .archflow-installed ownership manifest. Registration per-repo via archflow-local init (.mcp.json timeout 3600000; .codex/config.toml managed block).
- Host identity from clientInfo.name: claude-code / codex-mcp-client / unknown.

## User's brief

Task mcp-e2e-test: PRD defining what testing is missing to reach ~85% confidence everything works BEFORE manual testing begins. So: PRD should prioritize automated (or at least agent-executable) coverage that de-risks the manual operator journeys, not replace them.

## Pending before PRD loop can run

- User reviews/commits scaffolding (.archflow/workflow.yaml, constitution/, config.yaml, .mcp.json, .codex/config.toml).
- User approves archflow MCP server in Claude Code (/mcp or session restart); archflow_* tools not in this session yet.
