# TESTING

**Explored:** 2026-08-23 · **Commit:** `beb0072` · **Covers:** `test/`, `vitest.config.ts`, `package.json`, `scripts/build-temp.mjs`, `scripts/smoke-release-bundle.mjs`, `scripts/test-release-integrity.mjs`

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

`vitest.config.ts` declares five non-overlapping projects. All use the Node environment.

| Project | Directory | Purpose | Ordinary check? |
|---|---|---|---|
| `fast` | `test/unit/`, `test/contracts/` | In-process module behavior, focused durable invariants, package boundaries, and representative public contracts | Yes |
| `extended` | `test/extended/` | Exhaustive schema compilation, advertised-schema traversal, and large corpora | No |
| `integration` | `test/integration/` | Real temporary Git repositories, durable filesystem workflows, child processes, CLI/stdio, installers, and sharded semantic journeys | No |
| `crash` | `test/crash/` | Process termination at persistence cut points and restart recovery | No |
| `real-host` | `test/real-host/` | Installed bundles, authenticated Claude/Codex calls, host selection, provider behavior, and benchmarks | Never automatically |

The fast project currently contains 100 unit files and 27 contract files. Slow workflow tests that formerly lived under `test/unit/` were moved to integration: live config editing, durable transactions and gates, secret rejection, repository path resolution, status classification, implementation-output construction, legacy upgrade, and task workspaces.

The integration project currently contains 81 files and 408 tests. Its independent semantic journeys are deliberately registered through behavior-named one-scenario test files. Vitest schedules files, not ordinary `it` blocks, across its fork workers; keeping dozens of long journeys in three source files made one worker execute almost the entire five-minute critical path while the others went idle. The shared non-test registrar modules retain the scenario bodies without giving up file-level scheduling or the process isolation required by fake reviewer `HOME` and `PATH` values. The integration project uses all available workers because it is an explicit opt-in rather than an everyday background check.

The semantic journey harness returns the apply handler's already-refreshed view directly. Apply/status byte parity is proven separately for an ordinary mutation, a compound review, a human decision, and a refusal carrying a safe view; it is not re-run after every one of the hundreds of journey actions. On the reference 20-core repository machine, this structure reduced the full integration wall time from 322.63 seconds to 53–57 seconds while retaining the real Git, handler, and child-process paths.

The next floor was the handlers themselves, not the tests. A `git` shim on `PATH` counted 4,013 git child processes in the single longest journey: every handler call (and every substep refresh inside an apply) re-discovered the worktree, re-ran the Git preflight, resolved repository identity twice, and re-read the pinned constitution and workflow from an immutable commit. Memoizing those repository-constant reads in production code (per working directory for discovery/preflight, per policy-base commit for constitution and workflow digests, one identity resolve per session) and batching the discovery `rev-parse` flags into one process brought that journey to about 680 calls and 12 seconds, and the full integration project to 27–32 seconds with CPU time roughly halved. Repository identity is still observed live on every call; the remaining spawns are that pair plus genuine milestone and snapshot proofs. When integration time regresses, count spawns with the shim before restructuring tests.

The schema split preserves cheap trust boundaries in the fast project. `schema-registry.test.ts` pins the registry/directory identity, generation inventory, and public barrel; `mcp-advertisement.test.ts` pins the two tool names, descriptions, plain input roots, and byte ceiling. Repeated strict Ajv compilation and the classified MCP corpus live in `test/extended/`.

TypeScript still includes every `test/**/*.ts` file, so optional tests cannot silently rot at compile time. `test/types/mcp-sdk-public-surface.ts` remains compile-only coverage exercised by `npm run typecheck`.

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
- `release:mutations` checks representative hostile payload changes; `release:reproduce` rebuilds and byte-compares tracked `dist/`.
- `check:release` composes those four checks and runs only from `check:deep` or by explicit request.
- `release:write` promotes an explicitly staged candidate into tracked `dist/`; it never installs machine-global assets.

Release validation is not repeated as a Vitest integration wrapper. `check:release` owns tracked-payload validation, guarded smoke startup, independent reproduction, and manifest/provenance mutation checks. A focused fast boundary test pins rejection of the repository itself as a release output root without building or copying any payload bytes.

Real hosts require a separate opt-in:

```text
ARCHFLOW_REAL_HOSTS=1 npm run test:real-host
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_REVIEW_BENCHMARK=1 npm run bench:review
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_CC_SWITCH_PROVIDER=zai npx vitest run --project real-host test/real-host/cc-switch-dispatch.test.ts
```

These commands may use credentials, provider quota, installed CLIs, and long production-derived timeouts. Neither `check` nor `check:deep`, builds, release staging, or release writing invokes them.

## Placement rules

- Put deterministic module behavior and a representative success/failure pair in `unit`.
- Put cheap public wire/shape invariants in `contracts`.
- Put exhaustive matrices or third-party compilation of the full published surface in `extended`.
- Put real Git, multi-file durable workflows, child processes, CLI/stdio, temporary bundles, installers, and cross-service journeys in `integration`.
- Put tracked release payload validation, reproduction, and hostile release mutations in the explicit release scripts composed by `check:release`.
- Put deliberate process termination in `crash`; put any authenticated or provider-dependent behavior in `real-host`.
- Name tests for the behavior they cover, never the workflow phase that introduced them.

There is no coverage percentage gate. Confidence comes from the fast representative layer plus explicitly chosen deeper evidence when the affected boundary warrants it.
