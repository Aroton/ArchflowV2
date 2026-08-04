# Phase 21 Implementation Counter-Review

Reviewed the uncommitted Phase 21 change set against the phase design, `.archflow/context/`, and the
PRD's VAL-01..VAL-17 definitions. Verification commands were re-run locally: `npm run typecheck`
passes; `npm test` **fails** (3 tests); `npm run release:reproduce` **fails**.

## Blockers

- **blocker — `npm test` and `npm run check` are red; the tracked bundle was never republished after the `src/` change.** The design's Files note is explicit: "`dist/` republication and the existing release re-acceptance path are required **only if** a `src/` file actually changes… If something does change, republish before chunk 8 runs." `src/dispatch/cli.ts` changed (preflight login parsing and `classifyMessage`) and `dist/` was left untouched. Re-run locally: `test/integration/release-offline.test.ts` fails 3/3 — `stale bundle input: src/dispatch/cli.ts` (×2) and `risk decision bundle binding is stale: fast-uri-3-1-0-local-risk` — and `npm run release:reproduce` (inside `check:release`, inside `check`) fails with the same stale-binding error. Success criterion 8 ("`npm test` and `npm run check` pass unchanged, and CI stays green") is unmet, and CI is red on this branch. **Resolution:** run the existing republication path (`release:write`/`release:stage`) and take the `fast-uri-3-1-0-local-risk` re-acceptance to the human gate — the risk re-acceptance is a human decision that must be offered, not performed silently — then re-run `npm test` and `npm run check` before the phase is proposed for commit.

- **blocker — Every installed-launcher result in the report was produced against the pre-change bundle.** `test/real-host/terminal-journey.test.ts:221` copies the tracked `dist/` into the scratch checkout, so the six passing slices exercised a bundle that does not contain the `src/dispatch/cli.ts` change, exactly the ordering hazard the design called out. The report acknowledges this only in VAL-11's *Remaining* column while still marking VAL-11 **passed**, and VAL-16/VAL-17 cite the same run as Phase 21 evidence. **Resolution:** republish first (see above), re-run `npm run test:real-host`, and only then record the installed-launcher observations; until then no VAL may cite that run as installed-distribution evidence.

- **blocker — The VAL-02 "blocked" determination rests on an unsupported attribution.** The report states as fact that "the installed subscription-backed hosts reject both approved active configurations… the production path classifies both as `PROCESS_FAILED`." `PROCESS_FAILED` is precisely the *unclassified* bucket: `classifyNonzero` (`src/dispatch/cli.ts:333`) returns it when no message classifies, and `claudeFailureMessage` extracts a message only from a stdout JSON wrapper carrying `is_error`/`type: "error"` — an argv-, effort-, schema-, or sandbox-level rejection produces no message at all and is indistinguishable from a model rejection. Nothing in the change set records the raw evidence (exit class, stderr excerpt, exact argv, whether `--effort xhigh`/`--effort high` or `--json-schema` was implicated), and `docs/validation/` does not exist. Per the PRD, VAL-02 failure "reopens the automation premise" — that conclusion cannot be published from an unclassified non-zero exit. Note also that the Codex wording quoted in VAL-08 ("… model is not supported …") *would* classify as `UNSUPPORTED_MODEL` under the newly broadened regex and the slug branch of `modelFromMessage`, which contradicts VAL-02's `PROCESS_FAILED` claim for the same slug. **Resolution:** capture and record the actual child stderr/exit class for both directions, separate model rejection from flag/effort/schema rejection, and re-derive VAL-02's status from that evidence — falling back to `pending` if the cause is unresolved rather than `blocked`.

- **blocker — `npm run test:real-host`, the phase's own documented command, is knowingly failing and the report describes it as unexecuted.** Both directions in `test/real-host/dispatch.test.ts` assert a schema-valid, server-attested review using `gpt-5.6-sol`/`claude-opus-5`, and `test/real-host/review-benchmark.test.ts` does the same for twelve turns — the exact configurations the report records as rejected. The opt-in suite therefore fails as shipped, with no marker in the files, while VAL-13 says `test/real-host/dispatch.test.ts` "is unexecuted" and VAL-07 simultaneously says "the Phase 21 opt-in run reached both real authenticated hosts… both approved active-model calls failed." Those two statements cannot both describe the same run. **Resolution:** state in the coverage report (and in the test files) the exact observed outcome of the opt-in run, and either fix the underlying cause so the suite passes or record it as a known-failing suite with the failure text — do not leave a red suite described as unexecuted.

## Majors

- **major — No distinct-PID assertion exists anywhere in the real-host suite.** Chunk 3 pins "a child PID distinct from the parent" and success criterion 2 requires it for both directions; `grep -rn "pid" test/real-host/` returns nothing. VAL-07's *Remaining* column blames the omission on model rejection ("Real distinct-PID … remain unproved because the hosts rejected the selected active models"), which is untrue — the assertion was never written and would not have run even on a successful dispatch. Chunk 3's "a real `cli_version` in the attempt record" is also unimplemented for the two directions: `dispatch.test.ts` reads the attempt bytes only to scan for sentinels and asserts `cli_version` on the minted evidence instead. **Resolution:** assert the child PID (and its difference from `process.pid`) and the attempt record's `cli_version` in `test/real-host/dispatch.test.ts`, and correct VAL-07 to attribute the gap to the missing assertion.

- **major — `archflow_adjudicate` is never dispatched in either direction.** Chunk 3: "drives `archflow_counter_review` **and** `archflow_adjudicate` through real production services, once per producer direction." `test/real-host/dispatch.test.ts` builds only review envelopes against `review.schema.json`; no adjudication envelope, schema, or observation is exercised anywhere under `test/real-host/`. The coverage report does not disclose the omission (VAL-15 rests entirely on prior-phase fixtures). **Resolution:** add the adjudication dispatch per direction, or record it explicitly as unexercised in `docs/release-validation.md`.

- **major — The negotiated MCP era, `clientInfo.name`, and per-connection spawn count of the real clients were never observed.** Success criterion 11 requires the negotiated era of each real client to be recorded, and chunk 2 requires recording the observed server spawn count per connection. `test/real-host/preflight.test.ts:84` only drives an in-process `startMcpRuntime` with a hand-written `clientInfo: { name: "codex-mcp-client" }` handshake — it proves the pre-`initialize` rejection (which is genuinely satisfied) but asserts nothing about what a real client sends or negotiates, and `terminal-journey.test.ts:128` likewise synthesizes the same name. No runbook step supplies it either: `docs/real-host-journeys.md` covers only the VAL-09 timeout clause. The three "probe unknowns" the Verification Steps require to be recorded either way are therefore two-thirds unrecorded. **Resolution:** obtain the observation by connecting a real client to the installed server (a `claude mcp`/`codex mcp` step in the runbook is sufficient if a test cannot drive it), or state in the report that criterion 11 is unmet rather than leaving it implied.

- **major — Chunk 8's slice set is materially incomplete against the success criteria.** The design assigns to chunk 8, and criteria 4 and 6 require: a secret-bearing implementation output rejected before Git projection and before state advancement (pinned at length in the design as *the* correct mapping of the architecture's "secret-bearing checkpoint" wording), a recorded safe maintenance prune, the three `restore-collision` decisions, dirty-worktree exact rerun producing byte-identical outputs with unrelated files untouched, and two-phase non-collision of `phase-design-<n>`/`phase-impl-<n>` evidence paths. None of the five appears in `test/real-host/terminal-journey.test.ts`; only `archflow_state` is ever called over stdio. The omissions are disclosed only in VAL-17's *Remaining* column, not against the criteria they actually belong to. **Resolution:** implement the missing slices, or record each explicitly against its VAL with the reason it was not executed, and downgrade the affected statuses accordingly.

- **major — Two VAL rows are marked `passed` in contradiction of the report's own status definitions.** The report defines `passed` as "the full success condition has recorded evidence" and `partial` as "a meaningful boundary is proved but at least one required boundary is not." VAL-05 is **passed** with a *Remaining* column stating "dirty installed MCP rerun and installed restore-collision decisions were not repeated in Phase 21"; VAL-11 is **passed** with a *Remaining* column stating its terminal run "is reinforcement of the pre-change bundle rather than evidence for the changed source." A non-empty remaining boundary is by definition `partial`. Relatedly, `terminal-journey.test.ts:350-357` observes that the result-byte cap is rejected by durable-schema validation rather than `SNAPSHOT_LIMIT` — an honest and correctly pinned deviation from criterion 6 ("receives `SNAPSHOT_LIMIT` above **either** cap"), but it lives only in a test comment and never reaches the report. **Resolution:** move VAL-05 and VAL-11 to `partial`, and surface the result-cap classification in the report.

- **major — The mismatch slice cannot tell which rejection it observed.** `terminal-journey.test.ts:287-306` mutates the staged initialization artifact's `config_digest` and `code_baseline_commit` and asserts only `{ ok: false, error: { code: expect.any(String) } }`. Any error passes, including one unrelated to the boundary under test — and the `adopt` helper (`:192-204`) computes `input_fingerprint` from the *unmutated* draft and then transmits the mutated artifact, so the call plausibly trips a generic fingerprint/intent check before either initialization validation runs. The design assigns "artifact and commit-mismatch failures" to this boundary specifically. **Resolution:** pin the exact expected error code per mutation (and, if the fingerprint check fires first, restructure the call so the intended validation is the one exercised).

- **major — `loggedIn = successLines.length === 1` is unrequested strictness that can produce a false `AUTH_UNAVAILABLE`.** `src/dispatch/cli.ts:242-245` now scans both channels for `^Logged in` but requires *exactly one* match. A CLI that echoes the success line on both stdout and stderr, or repeats it, is authenticated yet reports `AUTH_UNAVAILABLE` and aborts every dispatch. Nothing in the design, the probe, or the fixtures requires the exact count; the observation the change is based on is "the line can arrive on stderr," which `>= 1` (or `.some(...)`) expresses exactly. No test covers the multi-line case, so the strictness is also unguarded. The same construct is duplicated in `test/helpers/real-host.ts:54-57` and would skip the whole suite for the same reason. **Resolution:** accept one or more success lines in both places.

- **major — The benchmark artifact's self-digest covers the fields a human must later fill.** `review-benchmark.test.ts:250-276` computes `benchmark_result_digest` over `resultPayload`, which contains `runs[].disposition: null` and `primary_human_scored_metrics` (all null / `pending-human-disposition`). Success criterion 9 requires `docs/validation/thresholds.json` to be "bound to the benchmark result digest" and computed "from a recorded human disposition per run" — but the moment a human records a disposition in that file, the digest recorded inside it no longer describes its own contents, so the threshold binding either points at a superseded document or must be recomputed and no longer binds the observations it approved. **Resolution:** digest only the immutable observation payload (schema version, corpus manifest digest, directions, run conditions, runs' observed fields), and hold dispositions plus the derived metrics either in a separate document bound to that digest or in fields explicitly excluded from it.

- **major — Managed-policy detection is asserted tautologically and the design's synthesized-present-path assertion is missing.** Chunk 2 requires asserting "that detection returns a well-formed set **and that a synthesized present path is reported**." `preflight.test.ts:58-71` asserts `managed_policy_present: claude.managed_policy_paths.length > 0` — a value derived from the same object, so the field can never disagree — plus uniqueness and a leading `/`. On a machine with no managed-policy files (the likely case, and the report never says which) all three assertions hold vacuously and nothing about detection is proved. **Resolution:** add the synthesized-present-path case (a temporary path fed through the same detection seam) so the positive branch is exercised independently of what happens to exist on the machine.

## Triage

### Blocker 1 — Accepted and resolved

After source fixes settled, the user explicitly re-accepted the unchanged local-only
`fast-uri@3.1.0` exposure and asynchronous-shutdown limitation for exact MCP digest
`9788624d71e48a3b683af3112f0f12e2fc735f7cd598a508e07f2d2e25d92499`. Release evidence and tracked
`dist/` were rebound only afterward. `release:write`, reproduction, and the complete `npm run check`
gate pass.

### Blocker 2 — Accepted

The original launcher run copied pre-change `dist/` and was removed as evidence. After approved
republication, the installed suite reran against current tracked `dist/` and passed 6/6. The report
uses only that current run and retains the slices the test still omits.

### Blocker 3 — Accepted

The original model-rejection attribution was wrong. Temporary, cleaned PATH wrappers isolated a
provider transport-schema incompatibility rather than a model failure. After explicit user
approval, `src/dispatch/cli.ts` gained provider-specific, non-authoritative schema projections;
unchanged normative parsers still reject semantic contradictions before attestation. Both real
review directions and Codex adjudication now succeed. Claude adjudication reaches the configured
model but one observed response correctly failed normative cross-field validation. The deliberately
invalid Codex slug remains a separate genuine `UNSUPPORTED_MODEL` observation.

### Blocker 4 — Accepted

The coverage report now records the actual opt-in outcomes rather than calling the suite unexecuted.
The initially proposed projection was raised as a material decision and implemented only after the
user approved it. The 12-turn benchmark subsequently completed with immutable observation digest
`61f6b56b0ac92c587c5312f12c3c7babcfd29d1925206d14fa07b81f7c221eea`; human dispositions and
threshold approval remain deliberately unset.

### Major 1 — Accepted

`test/real-host/dispatch.test.ts` now observes a temporary wrapper PID and the actual CLI child PID,
asserts both differ from the test PID, and asserts the persisted failed/succeeded attempt's real
`cli_version`. Both real review directions now also produce successful server-attested evidence.

### Major 2 — Accepted

The real-host suite now builds and sends production adjudication envelopes in both producer
directions. Provider schema rejection occurs before observation minting or a handler-level
`archflow_adjudicate` state transaction, and the report explicitly retains that remaining boundary.

### Major 3 — Accepted

`docs/real-host-journeys.md` now provides a scratch-only, sanitized wire-observer procedure for each
real client. It records only spawn count, protocol version, and client/server identity fields, and
requires the criterion to remain unmet if the client exposes none of them. No raw payload, auth
output, environment, or arbitrary `_meta` is recorded.

### Major 4 — Accepted through truthful partial coverage

The missing installed dirty-rerun, maintenance-prune, restore-collision, two-phase path, and
secret-output slices are each mapped to their affected VAL in `docs/release-validation.md`. Copying
the mature state/gate/evidence harnesses solely to repeat their already-recorded in-process proofs at
the stale installed boundary is disproportionate while republication and provider schema
compatibility remain blocked. No affected VAL claims full installed coverage.

### Major 5 — Accepted

VAL-05 remains `partial` for its omitted installed dirty-replay/collision boundaries. VAL-11 was
initially downgraded while `dist/` was stale, then returned to `passed` only after the exact mismatch
codes were pinned, the approved bundle was published, and the current installed suite passed. The
report also records that result-cap-plus-one is rejected by durable-schema validation rather than
`SNAPSHOT_LIMIT`, while retained-task-cap-plus-one does return `SNAPSHOT_LIMIT`.

### Major 6 — Accepted

The installed mismatch table now pins config-artifact mismatch to `PINNED_CONFIG_MISMATCH` and a
missing commit to `CONTRACT_INVALID`. The envelope remains computed over the authentic artifact and
the mutation is transmitted afterward, so the intended initialization validation—not a stale input
fingerprint—wins. The focused two-case run passes.

### Major 7 — Accepted

Production preflight and the real-host availability helper now accept one or more recognized Codex
login-success lines across stdout/stderr. Fake CLI regressions cover both stderr-with-warning and
duplicate stdout/stderr success lines.

### Major 8 — Accepted

`review-benchmark.test.ts` now digests only `observation_payload`. Human dispositions and derived
metrics live in `human_scoring`, bind back through `observation_digest`, and can be filled without
changing the immutable digest that a later `thresholds.json` approves. The opt-out contract test
proves disposition edits preserve the digest and observation edits change it.

### Major 9 — Accepted

`detectManagedPolicyPaths(paths)` is now an exported narrow detection seam. The real-host preflight
suite creates one temporary present path and one absent path and proves the production detector
returns exactly the present path, independently of developer-machine policy state.
