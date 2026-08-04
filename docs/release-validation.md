# Release validation coverage

**Snapshot:** 2026-08-04
**Task:** `mcp-integration`
**Phase:** 21, in progress

This report distinguishes three kinds of evidence:

- **Recorded deterministic evidence** is a prior phase log plus the exact fake-CLI, in-process,
  contract, integration, crash, or release test that the phase ran.
- **Real-host or installed evidence** requires an observed opt-in run against the real Claude Code
  and Codex binaries or the installed launchers. A test file or operator runbook is a candidate
  procedure, not evidence that the procedure ran.
- **Human evidence** requires an executed operator journey or dispositioned benchmark. It is not
  inferred from fixtures, model output shape, or an unexecuted runbook.

`passed` means the full success condition has recorded evidence. `partial` means a meaningful
boundary is proved but at least one required boundary is not. `pending` means the required human or
real-host observation has not run. `blocked` means an external prerequisite prevents satisfaction.

The Phase 21 opt-in suite reached both installed, authenticated hosts. The approved provider-
transport schema projection is now implemented in `src/dispatch/cli.ts`: it adapts the host-visible
schema to each CLI's supported subset, while the unchanged normative parsers still post-validate
model output before attestation. `test/unit/dispatch-cli.test.ts` proves the projection does not
weaken normative semantic rejection. Real counter-review now succeeds in both producer directions.
Real Codex adjudication succeeds; Claude adjudication reaches the model and returns structured
output, but that one response is correctly rejected by normative post-validation because
`uncertain_rule_versions` contradicts its rule findings. Thus the remaining adjudication failure is
model-output semantics, not the obsolete provider-schema incompatibility described by earlier
drafts of this report.

The tracked release is now published and byte-reproduced. `dist/manifest.json` binds
`dist/archflow-mcp.mjs` to digest
`9788624d71e48a3b683af3112f0f12e2fc735f7cd598a508e07f2d2e25d92499`. The installed terminal
suite in `test/real-host/terminal-journey.test.ts` was rerun from this current `dist/` and all nine
implemented scenarios passed. Those results are valid installed-distribution evidence for the
specific slices named below; they do not imply coverage for terminal slices the suite does not
implement.

## Coverage

| ID | Status | Evidence and boundary actually proved | Remaining boundary |
|---|---|---|---|
| VAL-01 | **pending** | `docs/real-host-journeys.md` specifies the Claude-producer and Codex-producer terminal journeys, including exact human gates, two implementation phases, commit authorization, separate commit confirmation, and final-state capture. Prior normal-mode mechanics are covered by `test/integration/review-fixed-point-live-phase17.test.ts`, `test/unit/state-next-action-phase17.test.ts`, and the Phase 17 implementation log. | Neither operator journey has been executed: `docs/validation/journey-val01-claude.md` and `docs/validation/journey-val01-codex.md` do not exist. There is therefore no real terminal proof of either full producer direction, exact final-diff authorization, or merged implementation. |
| VAL-02 | **blocked** | Phase 14 recorded deterministic fake-CLI fixed-point mechanics in `test/integration/review-corpus-phase14.test.ts` and `test/integration/review-fixed-point-phase14.test.ts`. The real benchmark in `docs/validation/review-benchmark.json` completed all 12 serialized turns in both producer directions in 753.3 seconds; immutable observations are bound by digest `61f6b56b0ac92c587c5312f12c3c7babcfd29d1925206d14fa07b81f7c221eea`. The user dispositioned all runs: six `seed-detected`, one `clean-pass`, and five `false-blocker`, yielding approval detection 1.0, false-blocker rate 0.8333333333333334, triage completeness 12, and zero defects found after pass. | The user rejected release thresholds because five of six controls produced false blockers. `docs/validation/thresholds.json` intentionally does not exist. The quality gate failed and reopens the central automation premise; VAL-02 cannot advance through threshold tuning or added mechanics without a revised, approved product approach. |
| VAL-03 | **passed** | The Phase 12/14/15 recorded suites prove pinned-constitution gating and exact waiver authority: `test/integration/state-gate-lifecycle-phase12.test.ts` (grant, denial, cancellation, stale/wrong binding, exact replay), `test/unit/review-phase14-services.test.ts` (exact rule/version/subject/operation/boundary waiver binding), and `test/integration/gate-supplemental-phase15.test.ts` (real handler waiver round trip). | This is a deterministic durable-authority condition; Phase 21 adds no required real-host boundary. |
| VAL-04 | **passed** | The Phase 14 log records 64/64 focused tests. `test/unit/review-phase14-services.test.ts` proves material-upstream ordering, stale evidence, exact approval authority, and required re-entry; `test/integration/review-fixed-point-phase14.test.ts` proves accepted findings cause artifact rewrites and only the final aligned digest advances. | No outstanding boundary identified for the stated material-drift condition. |
| VAL-05 | **partial** | `test/integration/mcp-handler-state-replay-phase15.test.ts` proves a byte-identical authoritative result on exact replay; `test/integration/mcp-handler-counter-replay-phase15.test.ts` proves replay/recovery does not relaunch a reviewer. `test/crash/state-transaction.test.ts` proves receipt/result/state cut recovery, while the Phase 9 log records the real multi-process and crash-cut matrix. The current installed suite proves byte-identical snapshot/restore and exact initialization replay in a dirty worktree with unrelated tracked/untracked bytes unchanged. | Phase 21 still does not prove all three installed restore-collision decisions (discard-and-restore, adopt, abort). |
| VAL-06 | **partial** | `test/crash/state-transaction.test.ts` covers before/after result, receipt, projection, and state replacement cuts; `test/crash/state-gate-lifecycle-phase12.test.ts` covers conflicting opens/resolves, pending gates, and SIGKILL resume. `test/integration/state-transaction.test.ts` proves one same-task winner, stale CAS rejection, independent tasks, and exact replay. `test/unit/state-repair.test.ts` proves repair is explicit and never guesses among successors. The current installed suite additionally proves manual checkpoint/import, snapshot/restore, retained-task-cap `SNAPSHOT_LIMIT`, result-cap schema rejection without partial authority, a recorded safe maintenance prune, and secret-bearing implementation-output rejection before projection or state advancement. | A result one byte above the result cap fails at durable-schema validation rather than returning the Phase 21 success criterion's required `SNAPSHOT_LIMIT`; no partial authority is installed. |
| VAL-07 | **partial** (owner-accepted) | Phase 13 records clean generated homes, scrubbed environment, temporary cwd, selected-credential-only access, suppression flags, and fake-child canary scans in `test/integration/dispatch-cli.test.ts`. Phase 21 now records successful, schema-valid, server-attested real reviews in both producer directions, distinct wrapper/CLI PIDs, real persisted-attempt `cli_version` values, completed sentinel/canary scans, and omission of Claude auth PII from persisted diagnostics. | There is no OS-enforced containment or proof against repository/global-instruction or persistence-capable-tool access. The owner accepts this explicit limitation; the successful real-host evidence strengthens but cannot close that boundary. |
| VAL-08 | **partial** | The exact five-tool surface and closed schemas are recorded by `test/integration/mcp-handlers-phase15.test.ts`, `test/contracts/mcp-advertised-schema.test.ts`, and `test/contracts/mcp-contract-agreement.test.ts`. Replay/conflict behavior is covered by the Phase 9/15 transaction and handler suites. Phase 21 exercised real cancellation, real unsupported-model classification, and successful selected-model review dispatch through both adapters. The provider transport projection admits host-supported schema syntax, then unchanged normative validation rejects semantic contradictions before attestation. The latest adapter is included in the published and reproduced bundle. | Real `TIMEOUT`, `OUTPUT_OVERFLOW`, `RATE_LIMITED`, and logged-out `AUTH_UNAVAILABLE` remain fake-only by design; provoking them would consume the full timeout, excessive output/quota, or alter developer credentials. |
| VAL-09 | **partial** | `test/integration/state-gate-lifecycle-phase12.test.ts` and `test/crash/state-gate-lifecycle-phase12.test.ts` prove durable pending gates, invalid-decision rejection, single exact resolution after resume, and gate-ID archives. `test/integration/gate-supplemental-phase15.test.ts` proves optional supplemental review/decline and triage handling. The Phase 21 preflight run also proved unsolicited pre-`initialize` rejection followed by recovery. | No real Claude or Codex client has been observed holding a pending gate until its resolved MCP timeout. The timeout procedures in `docs/real-host-journeys.md` are unexecuted, and the real clients' negotiated MCP era and delivered `clientInfo.name` remain unrecorded. |
| VAL-10 | **passed** | `test/integration/state-transaction.test.ts` proves two real processes racing one task yield one winner plus stale CAS, exact replay is distinct, and separate tasks proceed independently. `test/crash/state-gate-lifecycle-phase12.test.ts` extends the race proof to gate opens/resolutions. Repository path ownership is enforced by `test/unit/repository-paths.test.ts`. | No outstanding boundary identified for concurrency and task isolation. |
| VAL-11 | **passed** | `test/unit/repository-paths.test.ts` rejects traversal, absolute paths, symlink escape, class confusion, and cross-task access. `test/integration/repository-git-matrix.test.ts` proves linked worktrees, relocation, and names outside the simple ASCII case. Phase 16 recorded init/registration coverage in `test/integration/init-registration-phase16.test.ts` and policy-base pinning in `test/unit/init-task-initialization-phase16.test.ts`. Against current published `dist/`, the installed suite proves initialization ownership, missing/uncommitted policy rejection, revision-1 adoption, config mismatch, exact artifact mismatch as `PINNED_CONFIG_MISMATCH`, and missing-commit mismatch as `CONTRACT_INVALID`, with no state created for either rejected artifact. | No outstanding boundary identified for the stated path and initialization condition. |
| VAL-12 | **pending** | Phase 18 recorded in-process/manual-helper component evidence in `test/integration/manual-workflow-phase18.test.ts`: authenticated checkpoint chains, gate/waiver archives, import wrappers, retained committed outputs, recovery, completion, and exact replay. The current installed suite additionally proves a manual checkpoint/import slice without duplicate checkpoint bytes. `docs/real-host-journeys.md` specifies the server-absent full journey and separate server-enabled import/reconcile recovery. | `docs/validation/journey-val12-manual.md` does not exist. The required real server-absent run has not demonstrated PRD/design approval, two phase decisions, a live waiver, commit authorization, completion, and recovery without repeated decisions. |
| VAL-13 | **passed** | `test/unit/dispatch-process.test.ts` proves exact planted-value scans across output channels; Phase 13 fake-CLI tests prove scrubbed provider/routing environment. The MCP stdio suite and Phase 15 release smoke prove protocol-only stdout and no listener for the bundled server. Phase 21's successful real reviews in both directions complete the real provider/routing sentinel and envelope-canary scans across child output, final review output, and persisted diagnostics. | No outstanding boundary identified for the stated sentinel and stdio/listener condition. |
| VAL-14 | **blocked** | The PRD and Phase 15 log consistently keep local subscription-authenticated Claude dispatch behind this release criterion. | No written Anthropic clarification or qualified legal determination exists. Internal risk acceptance is insufficient; Phase 22 owns publication of this external blocker unless the owner explicitly revises the PRD criterion. |
| VAL-15 | **passed** | `test/unit/adjudication.test.ts` covers positive, negative, uncertain, missing, stale, failed, and digest-mismatched mechanism evidence. `test/unit/review-phase14-services.test.ts` proves triggered/uncertain gates and exact obligation resolution. `test/integration/mcp-adjudicate-constitution-gate-phase15.test.ts` proves task-branch constitution edits gate before dispatch and cannot fabricate success. | No outstanding boundary identified for constitution trigger/mechanism and task-branch edit handling. |
| VAL-16 | **partial** | Phase 17 recorded real service/Git flows in `test/integration/review-fixed-point-live-phase17.test.ts`, phase-design approval as an implementation upstream, phase-numbered path contracts in `test/contracts/skill-contract-phase17.test.ts`, and commit-authorization next actions in `test/unit/state-next-action-phase17.test.ts`. | Phase 21 did not implement the two-phase installed slice covering both phase-design and phase-impl review, supplemental review/decline, decision archives, rerun, and non-colliding evidence paths. |
| VAL-17 | **passed** | Phase 19 recorded in-process staging, unchanged source, distinct destination, unapproved imported authority, normal initialization, manual adoption, migration audit, and conservative resume in `test/unit/legacy-upgrade-phase19.test.ts` and `test/integration/legacy-upgrade-phase19.test.ts`. Phase 20 adds collision, repository-ownership, secret-rejection, interruption, and exact-rerun tests in `test/integration/legacy-staging-faults-phase20.test.ts`. Against current published `dist/`, the installed suite proves normal and manual upgrade source preservation, equivalent conservative adoption milestones, convergence after a pre-authority manifest-loss interruption, exact rerun without decisions, and MCP adoption without overwriting the source or destination task. | No outstanding boundary identified for the stated legacy-upgrade condition. |

## Benchmark disposition and quality decision

`docs/validation/review-benchmark.json` contains 12 of 12 completed real review turns: six corpus
cases reviewed once in each producer direction, serialized over 753.3 seconds. Its immutable
observation digest is
`61f6b56b0ac92c587c5312f12c3c7babcfd29d1925206d14fa07b81f7c221eea`.

The user reviewed every finding against the corpus manifest and approved these dispositions:

- Six seeded-case runs are `seed-detected`; approval detection rate is 1.0.
- One control run is `clean-pass` and five are `false-blocker`; false-blocker rate is 5/6, or
  0.8333333333333334. Codex produced two of the three false-blocked controls in its direction;
  Claude produced three of three.
- Triage completeness is 12 of 12, and defects found after pass is zero.

The high detection rate does not compensate for the 83.3% false-blocker rate. The user explicitly
rejected release thresholds, so `docs/validation/thresholds.json` was not created. This is the PRD's
named failure condition: independent review did not demonstrate acceptable useful quality on clean
controls, and the automation premise must be revisited rather than hidden by more mechanics.

## Phase 21 gaps mapped to VALs

The incomplete terminal slices affect these claims directly:

- **VAL-05:** no current installed exercise of discard-and-restore, adopt, and abort collision
  decisions. The installed dirty-worktree exact initialization replay now proves unrelated tracked
  and untracked bytes plus durable task authority remain byte-identical.
- **VAL-06:** the installed suite now proves secret-bearing implementation-output rejection before
  projection/state advancement and records a safe maintenance prune. Its current snapshot run
  returns `SNAPSHOT_LIMIT` above the retained-task byte cap, while a result one
  byte above the result cap fails earlier at durable-schema validation
  (`/accounting/result_bytes must be <= 26214400`); the result-cap case does **not** return
  `SNAPSHOT_LIMIT`. That remains a deviation from the Phase 21 success criterion requiring
  `SNAPSHOT_LIMIT` above either cap.
- **VAL-16:** no installed two-phase evidence-path non-collision or full phase-design/phase-impl
  review, supplemental, decision, and rerun sequence.

The provider transport projection was explicitly approved and implemented; it is not a replacement
contract. Both real review directions now pass transport validation, unchanged normative validation,
and server attestation. Real Codex adjudication also succeeds. Real Claude adjudication reaches the
same host-output boundary, but its observed response is correctly refused before attestation because
`uncertain_rule_versions` contradicts the returned rule findings. That leaves one real adjudication
direction incomplete for the Phase 21 validation envelope without weakening VAL-03, VAL-04, or
VAL-15's deterministic authority. Distinct wrapper/CLI PIDs and persisted-attempt `cli_version` are
now asserted on the real dispatch paths.

The real clients' negotiated MCP era, delivered `clientInfo.name`, and per-connection server spawn
count are not yet observed. `test/real-host/preflight.test.ts` and the terminal test synthesize a
Codex initialize request and cannot supply that evidence. The sanitized manual procedure in
`docs/real-host-journeys.md` is the current practical path to recording it; until it is executed for
both clients, the Phase 21 negotiation criterion and the associated VAL-09 real-client boundary are
unmet.

## Release decision

VAL-01 through VAL-06 are **not all passed**: VAL-01 is pending, VAL-02 is blocked, and VAL-05 and VAL-06 are partial. Archforge work therefore
remains blocked by the PRD's terminal-validation gate. Independently, VAL-14 blocks release of the
local Claude subscription-dispatch path.

VAL-02 now requires a revised and explicitly approved product approach to independent review before
release or Archforge work can proceed; rerunning this benchmark or inventing thresholds does not
resolve the rejected quality gate. Other evidence-producing actions remain: obtain a normatively
valid Claude adjudication observation without relaxing post-validation and execute the three
journeys in `docs/real-host-journeys.md`. This report must be updated from observed artifacts; the
presence of procedures or test sources alone must never be promoted to a pass.
