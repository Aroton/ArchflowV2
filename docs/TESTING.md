# TESTING

**Explored:** 2026-09-12 · **Commit:** `7f97fe0` · **Covers:** `test/`, `vitest.config.ts`, `package.json`, `scripts/build-temp.mjs`, `scripts/smoke-release-bundle.mjs`, `scripts/test-release-integrity.mjs`

Report-workflow coverage exercises irregular extracted JSON, explicit producer interpretation, selective follow-up, partial-feedback visibility, sibling reuse, and independent constitution/approval boundaries. Archived structured-review tests remain for old evidence.

## Diff transport and PRD completion checks

Local Git fixtures exercise complete implementation patch files, large patches beyond the envelope cap, `.archflow/` exclusion, independent follow-up baselines, reverted outputs, and explicit fallback when historical context is unavailable. These checks use no model allowance. Semantic document journeys require the PRD's authorized commit before design can start, covering both human approval and autonomous rule settlement.

`review-diffs.test.ts` also carries generated patches larger than 1 MiB through the Claude, provider-wrapped Claude, Codex, and Antigravity invocation builders. It resolves the transmitted patch/stat paths from the configured child directory, verifies their digests and complete bytes, checks source availability, and pins Claude read tools and Codex read-only sandboxing. `review-fixed-point.test.ts` checks that general, test, and constitution children receive full diffs, with revision diffs scoped to the assigned reviewer. These are deterministic transport checks; they do not prove that an installed host actually exposes its advertised tools or that a model reads the files.

### Real reviewer file access

Run `ARCHFLOW_REAL_HOSTS=1 npm run test:real-host -- test/real-host/reviewer-file-access.test.ts` to require real Claude, Codex, and Antigravity reviewers to return two random values omitted from the prompt: one in unchanged source and another in a deleted patch line. This exercises generated diff files, the shared repository workspace, and production dispatch. Unlike the older multi-repository citation check, missing file access fails the test.

The initial run on 2026-09-14 failed on both routes. Claude (`claude-fable-5`, CLI `2.1.272`) returned the source value but reported permission denials for `../review-diffs/full.patch` and `full.stat`. Codex (`gpt-5.6-sol`, CLI `0.154.0`) reported no text-reading tool and returned neither value. The old Codex adapter disabled both `shell_tool` and `unified_exec`; Claude's invocation did not grant the sibling diff directory. After enabling Codex text-reading tools under its read-only sandbox and granting Claude the diff directory relative to the shared repository view, both routes passed: each returned both exact random values. These checks use the checkout's production dispatch code with the installed host CLIs; they do not update or validate a separately installed ArchFlow bundle. A follow-up run on 2026-09-15 also passed for Antigravity (`gemini-3.7-flash-high`, CLI `1.2.2`), returning both exact values. The installed ArchFlow bundle was separately checked to match the rebuilt checkout bytes.

## The default is deliberately fast

ArchFlow is an iterated-on prototype, so its everyday gate answers one question: did this edit break the typed code, focused behavior, public shape, or temporary bundle? It does not reproduce a release, simulate process crashes, traverse every schema corpus, or call an authenticated model host.

`npm test` runs only the Vitest `fast` project. `npm run check` runs, in order:

1. the pinned MCP SDK compatibility probe;
2. strict emit-free TypeScript validation;
3. the fast Vitest project once;
4. a temporary esbuild plus inert bundle smoke test;
5. the dependency-notice inventory and the production MCP SDK import boundary.

On the repository machine used to define this split, the fast project runs in roughly six seconds and the whole ordinary check stays below ten seconds with dependencies installed. Dependency installation is not part of that budget. The repository has no hosted CI workflow; `npm run check` is the local/CI contract.

Expected failure-path tests can emit an `INTERNAL_ERROR` diagnostic while passing. They may also append to ignored `.archflow/runtime/diagnostics/internal-errors.log`; that file is disposable test/runtime data.

## Vitest projects

`vitest.config.ts` declares five non-overlapping projects. All use the Node environment. To keep the host system responsive during heavy parallel test execution, worker pools leave capacity equivalent to two CPUs by bounding `maxWorkers` to `availableParallelism() - 2` across all test projects. This bounds worker count; it does not pin workers away from particular CPU IDs.

| Project | Directory | Purpose | Ordinary check? |
|---|---|---|---|
| `fast` | `test/unit/`, `test/contracts/` | In-process module behavior, focused durable invariants, package boundaries, and representative public contracts | Yes |
| `extended` | `test/extended/` | Exhaustive schema compilation, advertised-schema traversal, and large corpora | No |
| `integration` | `test/integration/` | Real temporary Git repositories, durable filesystem workflows, child processes, CLI/stdio, installers, and sharded semantic journeys | No |
| `crash` | `test/crash/` | Process termination at persistence cut points and restart recovery | No |
| `real-host` | `test/real-host/` | Installed bundles, authenticated Claude/Codex calls, host selection, provider behavior, and benchmarks | Never automatically |

The fast project contains the in-process unit and contract suites. Slow workflow tests that formerly lived under `test/unit/` were moved to integration: live config editing, durable transactions and gates, secret rejection, repository path resolution, status classification, implementation-output construction, legacy upgrade, task workspaces, and — most recently — repository-set resolution, state initialization, and reconciliation discovery over a live repository set. The rule behind every one of those moves: **a test that spawns `git` belongs in `integration`, not in `unit`.** The fast project is in-process by definition, and the integration suite is git-spawn bound (see below), so a temporary repository is an integration-scale cost wherever the file lives.

The integration project registers its independent semantic journeys, multi-repository implementation journeys, and automation status controller loops through behavior-named one-scenario test files. Vitest schedules files, not ordinary `it` blocks, across its fork workers; keeping dozens of long journeys in large files previously forced one worker to execute almost the entire critical path while others sat idle. Sharding multi-repository implementation journeys and automation status controller loops into behavior files allows Vitest to saturate all responsive worker lanes without making volatile suite counts part of the maintained architecture contract.

The crash test project is similarly split into behavior-named files (`state-gate-lifecycle-conflicts.test.ts`, `state-gate-lifecycle-open-recovery.test.ts`, `state-gate-lifecycle-resolve-recovery.test.ts`), bringing the crash test suite duration down to ~35 seconds.

The semantic journey harness returns the apply handler's already-refreshed view directly. Apply/status byte parity is proven separately for an ordinary mutation, a compound review, a human decision, and a refusal carrying a safe view; it is not re-run after every one of the hundreds of journey actions.

The schema generation pipeline (`src/contracts/internal/schema-generation.ts`) uses single-pass schema emission with local pointer rewriting, reducing schema verification (`check:schemas`) from ~17 seconds down to <0.5 seconds while preserving 100% byte parity. In `test/extended/` and `test/unit/`, compiled Ajv validator instances are cached to eliminate redundant JSON Schema re-compilations across corpus evaluations.

Automation status crosses all three non-host layers. Fast contract/unit tests pin the strict five-arm runtime contract, generated-schema registry, exhaustive semantic-action mapping, owner descriptors, blocked categories, token exclusion, and observation-ID stability/sensitivity. Integration tests invoke the real temporary bundle to prove input-free stdin behavior, exit/output discipline, absent/staged/unreadable classifications, representative configured and exceptional checkpoints, and a clean descriptor-driven PRD-to-completion loop. Polling tests snapshot `.archflow` before and after repeated reads; a cold-process benchmark uses a temporary Git-counting shim and checks time and spawn ceilings without credentials or model dispatch. The benchmark is a repository-local regression signal, not a universal latency guarantee; its measured reference result is documented in `contracts/AUTOMATION.md`.

TypeScript still includes every `test/**/*.ts` file, so optional tests cannot silently rot at compile time. `test/types/mcp-sdk-public-surface.ts` remains compile-only coverage exercised by `npm run typecheck`.

Default approval coverage combines seed-policy assertions with semantic journeys. `semantic-default-human-review.test.ts` exercises embedded queries, ORM writes, schema migrations, deterministic SQL paths, combined path/policy triggers, automatic security/contract/policy completion, and custom human-review rules. Scripted adjudicator judgments prove routing and exact approval/commit boundaries, not live-model classification accuracy. Every active rule still reaches automated compliance review. Existing governing-document tests cover authenticated material-plan comparisons and meaning-preserving maintenance; remediation and controller tests cover unresolved blockers and manual handoffs.

Multi-repository coverage (a task config that names writable and context-only secondaries alongside the primary) is layered the same way. Unit tests pin the dispatch workspace's ordered named snapshots (`dispatch-workspace.test.ts`), config key-order insensitivity (`config-change.test.ts`), and the structured repository-set failure shapes. Integration files build real secondaries with `test/helpers/temp-repository.ts` and prove one behavior each: `repository-set.test.ts` and `state-reconciliation-discovery-repository-set.test.ts` (live set resolution and reconciliation), `multi-repository-counter-review.test.ts` (the plural read-only view reaches the child in name order, evidence pins every member, and a secondary that vanishes before or during dispatch is named in a retryable error while the review stays current), `multi-repository-retained-result.test.ts` (exact secondary after-images reload, forged projection roots and targets are refused, undeclared writable-secondary dirt is reported while context-only dirt is ignored), `secondary-implementation-milestone-proof.test.ts` (the complete proof set survives descendants), `status-baseline-repository-unavailable.test.ts` (a repository leaving the writable set yields a typed error), and the sharded `multi-repo-impl-*.test.ts` suite (primary-then-api commit succession under no-wait authority, a content rule matched only in the secondary opening the human commit gate, target movement before and after the gate, waiver settlement under a content-rule wait, and api-only adopt/restore/deletion reconciliation). The former `test/crash/multi-root-projection-rollback.test.ts` was removed: secondary projection rollback is proven in-process by the retained-result and transaction tests without a process kill. `test/real-host/multi-repository-dispatch.test.ts` is the opt-in end-to-end proof that a context-only secondary reaches a real reviewer of each family and is pinned in server-attested evidence; reviewer prose citing `api/<path>` is recorded softly, never required.

Review-scope coverage is split by boundary. `review-envelopes.test.ts` pins implementation-specific scope and preserves document review guidance. `review-reports.test.ts` exercises readable extraction from conventional and irregular JSON, empty-output refusal, server-bound provenance, and the one-report-field child schema across all adapters. Pinned-context, reviewer-routing, fixed-point, and semantic journey tests cover producer-selected verification, complete previous reports, sibling reuse, partial feedback, and finish/revise/escalate responses. Archived finding-owner and ledger tests remain compatibility coverage; they do not define the fresh report protocol. Opt-in `review-scope.test.ts` asks real reviewers to catch a changed output breaking an unchanged consumer without reporting unrelated pre-existing defects.

Validation override and review push-through use the same layered rule. Fast contract tests pin request bounds, the dedicated request-digest discriminator, kind-specific gate evidence, grant/deny/cancel vocabulary, old attempts-exhausted archive acceptance, durable ordinal ordering, public authenticated-versus-invalid audit arms, strict automation v1, and optional automation v2 audit. Unit tests cover review-round-history construction, the minimum of two distinct completed rounds, complete accepted occurrence derivation, and omission of the choice when evidence is partial or stale. Integration journeys own the stateful proof: failed implementation request, exact gate subject, grant/deny/cancel return to the unchanged failed attempt, not-run disclosure, generic-plus-specialized push-through settlement, replay, and continued policy/drift/approval/commit enforcement.

Milestone recovery crosses the contract, real-Git, gate, and semantic-journey layers. Focused integration coverage proves first-parent candidate selection through descendants and merges; rejects wrong targets, messages, paths, trees, authorities, rewritten history, missing objects, and ref races; and exercises document, intermediate implementation, and final-completion handoffs under human and no-wait authority. Gate and journey coverage binds the complete drift subject, committed/uncommitted classification, stale-interface refresh and replay refusal, governing-document routing, adoption/restore continuation, missing-proof fresh recovery, the no-empty-commit rewrite inspection, and preservation of unrelated index/worktree sentinels.

## Commands and targeting

Fresh-review acceptance is layered across report contracts, routing and fixed-point unit tests, and stateful semantic journeys. The producer response is required even when report text sounds clean. Finish proceeds to ordinary policy and approval evaluation; revision selects known previous reviewers and supplies concrete verification requests; escalation asks for human judgment. Legacy taxonomy and disposition fixtures remain readable archive coverage. Skill contract tests audit proportional investigation and consequential review guidance rather than imposing a finding taxonomy on new output.

`test/unit/triage-benchmark.test.ts` is a credential-free, in-process regression signal. It times the public `validateTriage` and `buildHumanGatePresentation` seams after warm-up, using representative taxonomy, validation-override, and fully bound review-push-through shapes, and requires their measured p95 to remain below 100 ms on the implementation host. It performs no filesystem, Git, child-process, network, or provider work and is not a universal host-latency guarantee. That local signal is distinct from `test/real-host/review-benchmark.test.ts`, which is opt-in, uses installed credentials and provider calls, and remains human-scored evidence rather than automated acceptance.

```text
npm test
npm test -- test/unit/plain-json.test.ts
npm run test:unit
npm run test:contracts
npm run test:extended
npm run test:integration
npm run test:integration -- test/integration/mcp-stdio.test.ts
npm run test:crash
npm run check
npm run check:deep
```

Passing a file or filename fragment after `--` narrows within the selected project. This is the preferred debugging loop; an integration failure does not require running every integration journey.

For a sharded semantic journey, target its behavior-named `.test.ts` wrapper. The adjacent registrar module is intentionally not a test entrypoint.

`npm run check:deep` is an explicit, expensive validation for unusually broad changes. It first runs the ordinary check, then schema-byte regeneration comparison, extended tests, all integration and crash tests, notice/SDK-boundary mutation tests, and the full release check. It does not run real hosts or the review benchmark.

The integration timing budget is 40 seconds on the reference machine (27–32 seconds measured). Validate performance with at least two complete runs after changing journey layout, worker configuration, shared harnesses, or production code that affects status/apply cost. Machine-independent correctness remains the pass/fail contract; the recorded wall-time budget is the regression signal for this repository's development environment.

There is intentionally no changed-file detector that guesses when deep verification is necessary. Choose it when a change crosses many boundaries, modifies schemas/generation, changes durability/process behavior, or alters release construction.

## Release and real-host validation

The ordinary temporary build (`npm run build:temp`) creates bundles under the OS temporary directory, smoke-exercises them, and removes them. It does not touch tracked `dist/` and does not trigger release reproduction.

Release commands remain separately selectable:

- `release:stage` builds a candidate payload into an explicitly supplied empty directory.
- `release:check` validates a supplied payload; `release:smoke` exercises copied/hostile runtime modes.
- `release:mutations` checks representative hostile payload changes in parallel across isolated temp workspaces; `release:reproduce` rebuilds and byte-compares tracked `dist/`.
- `check:release` composes those four checks concurrently via `scripts/run-concurrent.mjs` and runs only from `check:deep` or by explicit request.
- `release:write` promotes an explicitly staged candidate into tracked `dist/`; it never installs machine-global assets.

Release validation is not repeated as a Vitest integration wrapper. `check:release` owns tracked-payload validation, guarded smoke startup, independent reproduction, and manifest/provenance mutation checks. A focused fast boundary test pins rejection of the repository itself as a release output root without building or copying any payload bytes.

Real hosts require a separate opt-in:

```text
ARCHFLOW_REAL_HOSTS=1 npm run test:real-host
ARCHFLOW_REVIEW_BENCHMARK_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/archflow-review-benchmark.XXXXXX")"
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_REVIEW_BENCHMARK=1 ARCHFLOW_REVIEW_BENCHMARK_STAGE="$ARCHFLOW_REVIEW_BENCHMARK_STAGE" ARCHFLOW_REVIEW_BENCHMARK_OUTPUT="$ARCHFLOW_REVIEW_BENCHMARK_STAGE/review-benchmark.json" npm run bench:review
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_CC_SWITCH_PROVIDER=zai npx vitest run --project real-host test/real-host/cc-switch-dispatch.test.ts
```

These commands may use credentials, provider quota, installed CLIs, and long production-derived timeouts. Neither `check` nor `check:deep`, builds, release staging, or release writing invokes them.

`test/real-host/installed-terminal-semantic.test.ts` scratch-installs the tracked payload and exercises the current launcher boundary: the supported `archflow-local` commands, absence of retired request-building adapters, and read-only `archflow_status` over stdio. Producing semantic journeys remain in `host-selection.test.ts`, where authenticated Claude and Codex exercise `archflow_status` followed by `archflow_apply`. Direct reviewer journeys validate readable report child output and server-owned Review V4 provenance and judgment-only Adjudication V2 output, with reviewer identities and attribution derived from authenticated dispatch rather than report prose. Routes mirror shipped defaults so host latency and behavior measure the configuration users actually receive.

The review benchmark reviews the corpus in `test/fixtures/corpus/artifacts/` (thirteen cases: nine seeded with exactly one claim each, four clean controls) in both producer directions with the exact production design rubric (`design-v3`), so its measurements are about the policy tasks actually run under. Seeded classes cover single-statement contradictions, unhandled named results, verification shortcuts, and — added after a real design passed review with a budget that could not fit its own measured snapshot — cross-section arithmetic gaps and constants that cannot jointly hold. Routine fast contract tests in `test/contracts/review-benchmark-contract.test.ts` pin the production rubric digest, corpus digest, 26-turn matrix arithmetic, schema validity, seeded-claim detection and clean-control classification, and the split between immutable observations and human scoring. Authenticated execution requires dedicated `ARCHFLOW_REVIEW_BENCHMARK_STAGE` and `ARCHFLOW_REVIEW_BENCHMARK_OUTPUT` paths under temporary storage and writes only to the staged output; quality is a human disposition recorded in `docs/validation/`, never a CI assertion, and replacing tracked validation evidence is a separate, deliberately authorized workflow.

Reviewer coverage is layered rather than measured by a percentage. Unit and contract tests pin invocation legality, route precedence, specialist fallback, authenticated assignments, report extraction, archive compatibility, and judgment-only constitution slots. Integration tests cover initial and selected verification dispatch, upstream-authority failures before dispatch, sibling retention, partial report visibility, and exact failure attribution. Adapter tests send a valid 300 KiB envelope through all three transports and prove no argv element approaches the 131,072-byte process limit.

Effort selection adds focused checks at each trust seam. Unit and contract tests verify screenshot scores, enabled profiles, inclusive thresholds and minimum, cost ordering, shortfall behavior, unknown profiles, omitted effort, fallback, deterministic evidence, and archived readability. Fresh child output contains bound difficulty and a required rationale, never model choices or workload scores. Integration tests exercise manifest-free designs, captured settings, recommendation/status stability, and selector failure using bounded reasoning while ordinary review settles. Calibration examples contrast broad file copying with small but genuinely difficult mechanisms; scripted tests validate selection plumbing, not a model's judgment quality.

The focused live selector check uses the configured effort-reviewer route through production workspace creation, CLI preflight, schema projection, dispatch, extraction, and bound evidence construction. Run `ARCHFLOW_REAL_HOSTS=1 npx vitest run --project real-host test/real-host/implementation-selection.test.ts`. It requires only the configured reviewer host; expected categories stay outside the model prompt. Optionally set `ARCHFLOW_IMPLEMENTATION_SELECTION_REPORT` to a report path. The [2026-09-15 observed run](validation/implementation-selection-live-2026-09-15.json) used Luna/xhigh through Codex 0.154.0 and matched all three expectations: 120-file copying → routine/Muse, unresolved cache synchronization → hard/Astra low, scheduler derivation → exceptional/Astra high. These are synthetic design assessments, not implementation execution or a complete multi-reviewer workflow.

## Recommendation and automation-version coverage

Contract tests validate the minimal `ImplementationRecommendationV1` ready and unavailable shapes, plus strict automation version acceptance and cross-version rejection. Semantic journeys cover governing-design selection, stale evidence, legacy ready projection, legacy blocked fallback, and identical actions across recommendation variants. CLI/controller-loop tests pin current V3 emission and retained V1/V2 compatibility, positionless unavailable advice, observation identity, and the rule that advice never launches or reroutes a producer. Skill contract tests require phase design, phase implementation entry, and generic status to render the model, effort when supplied, and returned rationale.

## Placement rules

- Put deterministic module behavior and a representative success/failure pair in `unit`.
- Put cheap public wire/shape invariants in `contracts`.
- Put exhaustive matrices or third-party compilation of the full published surface in `extended`.
- Put real Git, multi-file durable workflows, child processes, CLI/stdio, temporary bundles, installers, and cross-service journeys in `integration`. Anything that spawns `git` — even a one-commit temporary repository — is integration, never unit; build it with `test/helpers/temp-repository.ts` rather than an inline scaffold.
- Put tracked release payload validation, reproduction, and hostile release mutations in the explicit release scripts composed by `check:release`.
- Put deliberate process termination in `crash`; put any authenticated or provider-dependent behavior in `real-host`.
- Name tests for the behavior they cover, never the workflow phase that introduced them.

There is no coverage percentage gate. Confidence comes from the fast representative layer plus explicitly chosen deeper evidence when the affected boundary warrants it.


## Automation responsibility

Automation regressions cover bounded transient retries, persistence across producer restarts and deleted diagnostics, corrupted recovery state, intentional policy-trigger classification, five-round remediation accounting, and v3 manual handoffs. Integration controller fixtures simulate an explicit human launch at each successor boundary rather than inferring permission to run the next skill.

Verification evidence regressions cover optional logs during implementation capture, historical manifests with changed or missing caches, bounded UTF-8 log excerpts, and review retry after replacing a log without changing the implementation result. The retry journey also checks that subsequent cache changes do not mutate completed review authority.
