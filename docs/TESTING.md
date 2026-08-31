# TESTING

**Explored:** 2026-08-31 · **Commit:** `fe0e4ce` · **Covers:** `test/`, `vitest.config.ts`, `package.json`, `scripts/build-temp.mjs`, `scripts/smoke-release-bundle.mjs`, `scripts/test-release-integrity.mjs`

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

`vitest.config.ts` declares five non-overlapping projects. All use the Node environment. To keep the host system responsive during heavy parallel test execution, worker pools reserve CPUs 0 and 1 by bounding `maxWorkers` to `availableParallelism() - 2` across all test projects.

| Project | Directory | Purpose | Ordinary check? |
|---|---|---|---|
| `fast` | `test/unit/`, `test/contracts/` | In-process module behavior, focused durable invariants, package boundaries, and representative public contracts | Yes |
| `extended` | `test/extended/` | Exhaustive schema compilation, advertised-schema traversal, and large corpora | No |
| `integration` | `test/integration/` | Real temporary Git repositories, durable filesystem workflows, child processes, CLI/stdio, installers, and sharded semantic journeys | No |
| `crash` | `test/crash/` | Process termination at persistence cut points and restart recovery | No |
| `real-host` | `test/real-host/` | Installed bundles, authenticated Claude/Codex calls, host selection, provider behavior, and benchmarks | Never automatically |

The fast project currently contains 101 unit files and 30 contract files. Slow workflow tests that formerly lived under `test/unit/` were moved to integration: live config editing, durable transactions and gates, secret rejection, repository path resolution, status classification, implementation-output construction, legacy upgrade, task workspaces, and — most recently — repository-set resolution, state initialization, and reconciliation discovery over a live repository set. The rule behind every one of those moves: **a test that spawns `git` belongs in `integration`, not in `unit`.** The fast project is in-process by definition, and the integration suite is git-spawn bound (see below), so a temporary repository is an integration-scale cost wherever the file lives.

The integration project contains 106 registered files and 484 tests. Its independent semantic journeys, multi-repository implementation journeys, and automation status controller loops are deliberately registered through behavior-named one-scenario test files. Vitest schedules files, not ordinary `it` blocks, across its fork workers; keeping dozens of long journeys in large files previously forced one worker to execute almost the entire critical path while others sat idle. Sharding multi-repository implementation journeys into 6 behavior files and automation status controller loops into 5 behavior files allows Vitest to saturate all responsive worker lanes.

The crash test project is similarly split into behavior-named files (`state-gate-lifecycle-conflicts.test.ts`, `state-gate-lifecycle-open-recovery.test.ts`, `state-gate-lifecycle-resolve-recovery.test.ts`), bringing the crash test suite duration down to ~35 seconds.

The semantic journey harness returns the apply handler's already-refreshed view directly. Apply/status byte parity is proven separately for an ordinary mutation, a compound review, a human decision, and a refusal carrying a safe view; it is not re-run after every one of the hundreds of journey actions.

The schema generation pipeline (`src/contracts/internal/schema-generation.ts`) uses single-pass schema emission with local pointer rewriting, reducing schema verification (`check:schemas`) from ~17 seconds down to <0.5 seconds while preserving 100% byte parity. In `test/extended/` and `test/unit/`, compiled Ajv validator instances are cached to eliminate redundant JSON Schema re-compilations across corpus evaluations.

Automation status crosses all three non-host layers. Fast contract/unit tests pin the strict five-arm runtime contract, generated-schema registry, exhaustive semantic-action mapping, owner descriptors, blocked categories, token exclusion, and observation-ID stability/sensitivity. Integration tests invoke the real temporary bundle to prove input-free stdin behavior, exit/output discipline, absent/staged/unreadable classifications, representative configured and exceptional checkpoints, and a clean descriptor-driven PRD-to-completion loop. Polling tests snapshot `.archflow` before and after repeated reads; a cold-process benchmark uses a temporary Git-counting shim and checks time and spawn ceilings without credentials or model dispatch. The benchmark is a repository-local regression signal, not a universal latency guarantee; its measured reference result is documented in `contracts/AUTOMATION.md`.

TypeScript still includes every `test/**/*.ts` file, so optional tests cannot silently rot at compile time. `test/types/mcp-sdk-public-surface.ts` remains compile-only coverage exercised by `npm run typecheck`.

Multi-repository coverage (a task config that names writable and context-only secondaries alongside the primary) is layered the same way. Unit tests pin the dispatch workspace's ordered named snapshots (`dispatch-workspace.test.ts`), config key-order insensitivity (`config-change.test.ts`), and the structured repository-set failure shapes. Integration files build real secondaries with `test/helpers/temp-repository.ts` and prove one behavior each: `repository-set.test.ts` and `state-reconciliation-discovery-repository-set.test.ts` (live set resolution and reconciliation), `multi-repository-counter-review.test.ts` (the plural read-only view reaches the child in name order, evidence pins every member, and a secondary that vanishes before or during dispatch is named in a retryable error while the review stays current), `multi-repository-retained-result.test.ts` (exact secondary after-images reload, forged projection roots and targets are refused, undeclared writable-secondary dirt is reported while context-only dirt is ignored), `secondary-implementation-milestone-proof.test.ts` (the complete proof set survives descendants), `status-baseline-repository-unavailable.test.ts` (a repository leaving the writable set yields a typed error), and the sharded `multi-repo-impl-*.test.ts` suite (primary-then-api commit succession under no-wait authority, a content rule matched only in the secondary opening the human commit gate, target movement before and after the gate, waiver settlement under a content-rule wait, and api-only adopt/restore/deletion reconciliation). The former `test/crash/multi-root-projection-rollback.test.ts` was removed: secondary projection rollback is proven in-process by the retained-result and transaction tests without a process kill. `test/real-host/multi-repository-dispatch.test.ts` is the opt-in end-to-end proof that a context-only secondary reaches a real reviewer of each family and is pinned in server-attested evidence; reviewer prose citing `api/<path>` is recorded softly, never required.

Review-scope coverage is split by boundary. `review-envelopes.test.ts` pins implementation-only rubric and constitution instructions while preserving document review wording. `pinned-context.test.ts` proves remediation receives only latest accepted intents. `reviewer-tags.test.ts` and `review-fixed-point.test.ts` prove accepted-owner reruns, closure of rejected and editorial findings, and the single first-reviewer fallback for unattributed accepted findings. The cumulative ledger remains covered as durable audit input rather than reviewer context. Opt-in `review-scope.test.ts` asks both real reviewer families to catch a changed output breaking an unchanged consumer without reporting an unrelated pre-existing defect.

Milestone recovery crosses the contract, real-Git, gate, and semantic-journey layers. Focused integration coverage proves first-parent candidate selection through descendants and merges; rejects wrong targets, messages, paths, trees, authorities, rewritten history, missing objects, and ref races; and exercises document, intermediate implementation, and final-completion handoffs under human and no-wait authority. Gate and journey coverage binds the complete drift subject, committed/uncommitted classification, stale-interface refresh and replay refusal, governing-document routing, adoption/restore continuation, missing-proof fresh recovery, the no-empty-commit rewrite inspection, and preservation of unrelated index/worktree sentinels.

## Commands and targeting

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

There is intentionally no changed-file detector that guesses when deep verification is necessary. The human chooses it when a change crosses many boundaries, modifies schemas/generation, changes durability/process behavior, or alters release construction.

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
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_REVIEW_BENCHMARK=1 npm run bench:review
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_CC_SWITCH_PROVIDER=zai npx vitest run --project real-host test/real-host/cc-switch-dispatch.test.ts
```

These commands may use credentials, provider quota, installed CLIs, and long production-derived timeouts. Neither `check` nor `check:deep`, builds, release staging, or release writing invokes them.

The review benchmark reviews the corpus in `test/fixtures/corpus/artifacts/` (thirteen cases: ten seeded with exactly one defect each, three clean controls) in both producer directions with the exact production design rubric (`design-v3`), so its measurements are about the policy tasks actually run under. Seeded classes cover single-statement contradictions, unhandled named results, verification shortcuts, and — added after a real design passed review with a budget that could not fit its own measured snapshot — cross-section arithmetic gaps and constants that cannot jointly hold. The offline half of `review-benchmark.test.ts` pins the rubric digest, matrix size, and the split between immutable observations and human scoring; quality is a human disposition recorded in `docs/validation/`, never a CI assertion.

Specific-reviewer coverage is layered rather than measured by a percentage. Unit and contract tests pin phase-specific invocation legality, role routing precedence, shipped Luna/xhigh defaults, skill flags, sealed assignment validation/order/digests, non-overlapping rubric partitions, fresh and legacy public provenance, and economical test-review language. Fixed-point integration tests cover the initial general/Luna/adjudicator merge, Luna-only remediation, specialist-owner disappearance with full-general fallback, invocation and one-dispatch override provenance, and exact `test-reviewer` failure attribution including pre-launch route rejection. The process test reproduces the original collision shape with concurrent Codex children of the same result kind and asserts one shared repository view but distinct output roots and `TMPDIR`s. This guards the high-value behavior without an expensive matrix of every route combination.

Effort review adds focused checks at each trust seam. Unit tests cover exact component-fence extraction, repository/path ordering, absent and invalid hazard registries, segment-aware matches and E floors, all score totals and conditional routing branches, blocker-first behavior, phase maxima, and the absence of a Sol-max profile. Contract tests pin strict raw-versus-attested shapes and archive compatibility. Integration tests prove phase-design-only fixed routing, all-child settlement and retained retry, one-dispatch substitution provenance, exact post-dispatch rebinding, blocker independence from triage, attempt lifecycle, and action invariance with or without recommendation data.

## Recommendation and automation-version coverage

Contract tests validate the `ImplementationRecommendationV1` ready, blocked, unavailable, substituted-provenance, and malformed shapes, plus strict automation v1/v2 self-acceptance and cross-version rejection. Semantic and integration journeys cover governing-design evidence selection, stale and legacy evidence, live registry drift, and identical actions across recommendation variants. CLI/controller-loop tests pin v2 emission, `effort-reviewer` failure vocabulary, positionless unavailable advice, observation identity, and the rule that advice never launches or reroutes a producer. Skill contract tests require phase design, phase implementation entry, and generic status to render only the returned union, keep actual routing separate, and preserve the exact server action.

## Placement rules

- Put deterministic module behavior and a representative success/failure pair in `unit`.
- Put cheap public wire/shape invariants in `contracts`.
- Put exhaustive matrices or third-party compilation of the full published surface in `extended`.
- Put real Git, multi-file durable workflows, child processes, CLI/stdio, temporary bundles, installers, and cross-service journeys in `integration`. Anything that spawns `git` — even a one-commit temporary repository — is integration, never unit; build it with `test/helpers/temp-repository.ts` rather than an inline scaffold.
- Put tracked release payload validation, reproduction, and hostile release mutations in the explicit release scripts composed by `check:release`.
- Put deliberate process termination in `crash`; put any authenticated or provider-dependent behavior in `real-host`.
- Name tests for the behavior they cover, never the workflow phase that introduced them.

There is no coverage percentage gate. Confidence comes from the fast representative layer plus explicitly chosen deeper evidence when the affected boundary warrants it.
