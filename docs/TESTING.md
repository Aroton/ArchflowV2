# TESTING

**Explored:** 2026-08-14 · **Commit:** `9331032` · **Covers:** `test/`, `vitest.config.ts`, `package.json`

## Test runner and configuration

- Tests use Vitest 4.1.10 in the Node environment (`vitest.config.ts`). Its only include is `test/**/*.test.ts`; files without the `.test.ts` suffix are not runtime tests.
- TypeScript validation is strict and emit-free (`tsconfig.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `skipLibCheck: false`. The include covers `src/**/*.ts`, all `test/**/*.ts`, and `vitest.config.ts`.
- `test/types/mcp-sdk-public-surface.ts` is therefore compile-time coverage exercised by `npm run typecheck`, not by Vitest.
- The package supports Node `^24.15.0`. Validation is run explicitly by maintainers with the package scripts; the repository does not configure hosted CI.

At this commit, `npm test` passed locally: **165 files discovered, 161 passed, 4 skipped; 1,744 tests discovered, 1,720 passed, 24 skipped**. The skipped groups were the explicitly opt-in real-host suites. Expected failure-path tests write some `INTERNAL_ERROR` diagnostics to stderr while still passing.

## Suite inventory by behavior

### Unit: `test/unit/` (101 files)

The unit layer is broad and normally imports production modules directly.

- **Durable contracts and validation:** canonical JSON/digests, plain-JSON input discipline, branded evidence/path claims, YAML/config/workflow parsing, durable documents, workspace cleanup, initialization, state, gates, implementation outputs, and semantic derivations. Representative files include `test/unit/plain-json.test.ts`, `test/unit/canonical.test.ts`, `test/unit/durable-state.test.ts`, `test/unit/durable-output-entry-matrix.test.ts`, and `test/unit/phase-instance.test.ts`.
- **State authority and persistence:** initialization authority, transition ordering, `last_transition` replay, transactions, atomic replacement, work locks, snapshots, repair, reconciliation, reconstructible gate interfaces, successor-aware next-action derivation, guarded automatic hand-offs, cleanup, current result manifests, and secret rejection/scanning. Cleanup coverage verifies that decisions protect only a manifest's result identity or authenticated artifact identity, incidental nested digests do not retain stale results, and malformed authority fails toward retention. Gate coverage checks canonical preview freshness, decision-bearing request fingerprints, connected-host provenance, and synchronous one-call resolution. Restart coverage checks backward planning moves, archived superseded authority, and exact connected-host replay. Handoff coverage checks every successor, exact destination skill arguments, combined design approval, legacy-gate compatibility, the nonhuman `commit-artifacts` and `commit-phase` steps, real-Git proof of the task-local milestone, terminal completion, and rejection of absent, stale, wrong-subject, or fabricated approval. Representative files include `test/unit/gate-preview.test.ts`, `test/unit/state-transaction.test.ts`, `test/unit/state-gates.test.ts`, `test/unit/state-gate-interface.test.ts`, `test/unit/state-next-action.test.ts`, `test/unit/implementation-output-builder.test.ts`, and `test/unit/workspace-cleanup.test.ts`.
- **Repository/Git safety:** discovery and identity, resolved-path containment, index/history/object behavior, constitution reads, and linked-worktree behavior. These tests use real temporary Git repositories where behavior cannot be represented by a fake runner; examples are `test/unit/repository-paths.test.ts`, `test/unit/repository-index.test.ts`, and `test/unit/repository-identity.test.ts`.
- **MCP runtime:** framing, send queue, SDK adapter, process runner, server, tools, handler authority/error mapping, replay/supersession, and cancellation/overflow translation. The retired session layer's surviving behaviors — repeated-initialize `-32004`, connection capture through the SDK initialized hook, response ordering through the SDK, and the missing-outcome `-32603` invariant — live in `test/unit/mcp-sdk-adapter.test.ts` (`test/unit/mcp-session.test.ts` was deleted with `src/mcp/session.ts`). Representative files include `test/unit/mcp-framing.test.ts`, `test/unit/mcp-sdk-adapter.test.ts`, and `test/unit/mcp-handler-authority.test.ts`.
- **Dispatch and review:** CLI policy/projection, routing and attestation, child-process lifecycle, isolated workspaces, pinned context, review envelopes/diffs, the constitution review, counter-review, and service-level fixed-point behavior. Adjudication tests pin the reduced child contract, deterministic summary derivation, unchanged complete evidence shape, and the digest binding to exact child bytes. See `test/unit/dispatch-cli.test.ts`, `test/unit/dispatch-process.test.ts`, `test/unit/review-services.test.ts`, and `test/unit/adjudication.test.ts`.
- **Initialization and local surfaces:** asset/config scaffolding, host registration crash safety, task initialization, legacy upgrade preview/stage/discard, atomic visible adoption, in-flight resume derivation, local command dispatch, and the read-only `manual-status` classifier (including reusable and incompatible upgrade staging). See `test/unit/init-registration-crash-safety.test.ts`, `test/unit/init-task-initialization.test.ts`, `test/unit/status-classification.test.ts`, `test/unit/legacy-upgrade.test.ts`, and `test/integration/legacy-upgrade.test.ts`.

Success cases are paired with representative boundary failures: malformed/non-plain inputs and split-observation getters; digest, revision, task, and phase mismatches; stale or contradictory evidence; traversal/symlink/class-confusion paths; lock and snapshot limits; secret-bearing output; process cancellation/overflow; and unsupported or unauthenticated host classifications.

### Contract: `test/contracts/` (25 files)

This layer pins the published contract surface: the Zod shape authority's acceptance/rejection behavior, the generated JSON Schemas (strict-compiled as a third-party consumer would), durable semantics, MCP-advertised schemas, skills, and release metadata. Since the 2026-08-11 generation flip, the committed-bytes fence is `npm run check:schemas`; the former Zod↔schema agreement loops are gone, and per-shape suites assert validation under the Zod authority while pinning where the generated documents are deliberately weaker (retired `x-archflow-*` keywords).

- Schema registry, generation-manifest fence, and foundational/shared primitive coverage: `schema-registry.test.ts`, `foundational-schema-agreement.test.ts`, `shared-primitives-schema-agreement.test.ts`, `semantic-keyword-parity.test.ts`.
- Durable structural and semantic corpora, per-shape validation, gate presentations, human-revision classification and reset behavior, state `last_transition`, implementation verification evidence, and result manifests.
- Frozen pre-`ad057d3` gate fixtures prove monotonic V1 archive reading: empty and populated supplemental ledgers remain valid, request supersession remains readable, malformed ledgers fail closed, superseded outcomes cannot act as approvals, and current writer parsers continue rejecting retired fields.
- MCP catalogue/schema/runtime agreement: `mcp-advertised-schema.test.ts`, `mcp-contract-agreement.test.ts`.
- Skill text and workflow trust boundaries, including one design approval, automatic design milestone commit, automatic advance, dual-client successor syntax, and exact predecessor recovery instructions: `skill-contract-canonical.test.ts`, `skill-contract-upgrade.test.ts`.
- Repository/package and release boundaries: `repository-boundary.test.ts`, `release-contracts.test.ts`, `canonical-parity.test.ts`.

Fixtures under `test/fixtures/contracts/`, `test/fixtures/foundation/`, and `test/fixtures/mcp/` provide known-valid documents plus invalid traversal, contradictory review, malformed state, protocol, and adversarial-byte examples. Several corpus tests explicitly prove error precedence and total ordering, not merely acceptance/rejection.

### Integration: `test/integration/` (31 files)

Integration tests assemble production services around real temporary repositories, real child processes, stdio framing, or generated bundles. They cover:

- Repository discovery/object proofs/configuration matrices, linked worktrees, relocation, conflicts, file-kind restore collisions, and deterministic path-limited authorized commits that preserve unrelated staged/worktree state (`repository-git-matrix.test.ts`, `repository-git-object-proofs.test.ts`, `manifest-file-kind-restore-matrix.test.ts`, `local-commit.test.ts`).
- Durable state concurrency, lifecycle, projection, replay, reconciliation, gates/waivers, automatic phase hand-off, human-revision restart behavior, and fixed-point review (`state-transaction.test.ts`, `state-gate-lifecycle.test.ts`, `mcp-handler-state-replay.test.ts`, `review-fixed-point-live.test.ts`). The public-composer lifecycle also exercises compound design production: task design records and reviews `design.md` with `prd.md`; later phase design records its phase document with both writable parents, survives produce re-entry without falling back to older parent authority, and requires the complete set in the authorized milestone commit while historical phase documents stay outside the result.
- Full MCP stdio/tool-handler behavior, cancellation, handler isolation, and counter-review replay including the constitution-review result (`mcp-stdio.test.ts`, `mcp-handlers.test.ts`, `isolation-handler-entry.test.ts`, `mcp-handler-counter-replay.test.ts`).
- Dispatch plumbing/coordinator/CLI behavior through deterministic fake Claude and Codex children (`dispatch-plumbing.test.ts`, `dispatch-coordinator.test.ts`, `dispatch-cli.test.ts`).
- Repository initialization, project registration, installer behavior, local CLI command/payload/stdin discipline, and legacy upgrade/fault recovery (`init-orchestration.test.ts`, `init-registration.test.ts`, `install-script.test.ts`, `local-cli-stdin-discipline.test.ts`, `legacy-staging-faults.test.ts`).
- Offline release behavior (`release-offline.test.ts`).

Representative boundary coverage includes exact-replay versus stale-CAS behavior, two-process same-task races, non-plain handler output, immutable pinned-policy review despite task-branch constitution edits, process cancellation, leaked plumbing bytes, registration collisions, interrupted legacy staging, dirty worktrees, and input-free CLI commands with stdin deliberately held open.

### Crash: `test/crash/` (3 files)

`state-transaction.test.ts`, `state-gate-lifecycle.test.ts`, and `state-initialization.test.ts` spawn fixture children and inject real process termination at persistence cut points. They assert that restart exposes either prior or fully installed authority, exact retained receipts resume safely, substituted retries are rejected, abandoned locks require explicit repair, and partial projections/results never become authoritative. Crash-control fixtures live in `test/fixtures/*child.mjs` and `test/fixtures/crash-projection-writer.mjs`; production modules are also checked not to ship those controls.

### Real-host and installed-distribution: `test/real-host/` (5 files)

- `preflight.test.ts` probes installed/authenticated Claude and Codex versions, identity/auth shapes, unsolicited pre-initialize recovery, managed-policy reporting, and PII omission.
- `dispatch.test.ts` makes real opposite-family review and constitution-review calls and requires schema-valid, server-attested evidence; it rejects same-family routing before dispatch. Successful calls leave no diagnostic attempt record, while failed calls retain one bounded forensic record.
- `failure-classes.test.ts` observes real unsupported-model and cancellation classifications.
- `terminal-journey.test.ts` installs tracked `dist/` into a scratch home and exercises installed `archflow-local`/`archflow-mcp` slices including initialization, fresh-clone authority recovery, dirty-worktree replay, cleanup, secret rejection, and legacy upgrade.
- `review-benchmark.test.ts` pins the benchmark digest/threshold binding in ordinary runs; its actual twelve-call real-model matrix is separately gated.

Real hosts are hermetic by default. `ARCHFLOW_REAL_HOSTS=1 npm run test:real-host` enables the suite and fails if both authenticated host CLIs are unavailable. The benchmark additionally requires `ARCHFLOW_REVIEW_BENCHMARK=1` (`ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_REVIEW_BENCHMARK=1 npm run bench:review`). `test/helpers/real-host.ts` sanitizes package-local host shims from `PATH`, probes versions/authentication, and derives the long timeout from production dispatch. The terminal journey uses a scratch home and needs only the first opt-in; it does not dispatch a model or use credentials.

## Fixtures and reusable harnesses

- `test/helpers/temp-repository.ts` creates isolated Git repositories with global/system Git config disabled, deterministic author identity, `.gitattributes`, linked-worktree, relocation, object, and conflict helpers.
- `test/helpers/task-workspace.ts` creates a committed policy base, stages revision-1 task initialization, and returns real production services for focused tests.
- `test/helpers/resolved-constitution.ts` and `test/helpers/real-host.ts` supply constitution and host-specific seams.
- `test/helpers/json-schema.ts` is the dev-only strict Ajv compiler for the committed JSON Schemas: it registers exactly the surviving `x-archflow-*` keywords and carries `assertZodAgreement`. Production code never compiles a schema; Ajv is a devDependency.
- `test/fixtures/dispatch/` contains deterministic fake Claude/Codex processes, protocol handshakes, plumbing children, and a grandchild-process fixture.
- `test/fixtures/mcp/runtime/` contains initialize/call transcripts and adversarial bytes used by stdio and release smoke tests.
- `test/fixtures/corpus/` contains seeded-defect/control artifacts plus constitution-review (`adjudication-scenarios.json`) and review scenarios; `test/integration/review-corpus.test.ts` and the real benchmark consume them.
- `test/fixtures/legacy/`, `test/fixtures/init/`, and `test/fixtures/release/` cover legacy layouts, fake host registration, and hostile runtime/canary checks.

Temporary repositories and homes are removed by harness cleanup. Git-related suites use availability gates; on a machine without Git those groups skip rather than synthesize Git behavior.

## Validation and build commands

Run from the package root:

```bash
npm ci
npm run typecheck
npm test
npm run test:unit
npm run test:contracts
npm run test:mcp-runtime
npm run build:temp
npm run check
```

`npm run check` is the local aggregate gate. In order it runs:

1. `probe:mcp-sdk-compatibility` — asserts the installed `@modelcontextprotocol/server`/`core` public runtime and declaration behavior and protocol 2025-11-25 behavior. It also carries one behavioral pin per JSON-RPC defense retired with the session layer — malformed-params rejection shapes, unknown methods, pre-initialize serving, cancellation aborting `ctx.mcpReq.signal`, repeated initialize, duplicate in-flight IDs, exotic ID handling, and `__proto__`-key inertness — so an incompatible installed SDK fails this gate instead of silently changing wire behavior.
2. `typecheck`.
3. `test:mcp-runtime` — `test/unit/mcp-*.test.ts` plus `test/integration/mcp-stdio.test.ts`.
4. `npm test`, then `test:contracts` again as an explicit contract gate.
5. `build:temp` — esbuilds temporary contracts/runtime bundles under the OS temp directory, smoke-exercises them, and removes them.
6. `check:notices` plus `test:notices-policy` — lockfile inventory and retained-notice validation with changed/missing/unmapped mutation cases.
7. `check:mcp-sdk-boundary` plus `test:mcp-sdk-boundary-policy` — SDK imports restricted to `src/mcp/sdk-adapter.ts`, with mutation cases for static/type/side-effect/dynamic/re-export/private-path violations.
8. `check:release` — tracked `dist/` validation, hostile/offline bundle smoke, release-integrity mutations, and byte reproduction.

There is no separate lint or formatter command in `package.json`. There is also no coverage command or enforced coverage threshold; `vitest.config.ts` only names `coverage/` as the report directory.

## Local validation and release checks

`npm run check` is the maintainer-run validation gate. It covers the SDK compatibility probe, typecheck, schema drift, focused MCP tests, the full suite, contract tests, temporary builds, notice and SDK-boundary policies, and the release checks below. The repository intentionally has no GitHub Actions workflow, so pull requests do not receive automatic hosted checks.

For an explicit release comparison, `npm run release:stage -- --output <directory>` stages a fresh payload and `npm run release:check -- --payload dist --compare <directory>` compares it with tracked `dist/`.

Release validation is implemented by `scripts/release-support.mjs` and front ends in `scripts/check-release.mjs`, `scripts/build-release.mjs`, `scripts/reproduce-release.mjs`, `scripts/smoke-release-bundle.mjs`, and `scripts/test-release-integrity.mjs`. It checks manifest/artifact closure and digests, build/input provenance, declared runtime assets, exact copies of third-party notices and retained upstream licenses, bundle imports, copied-payload behavior under a hostile guard, exact stdio/adversarial transcripts, module/repository canaries, mutation rejection, safe staging/recovery, and reproducibility. Dependency changes require no approval/evidence artifact. `test/contracts/release-contracts.test.ts` and `test/integration/release-offline.test.ts` add schema and offline behavior coverage.

## Known current limitations and gaps

- **Real-host suites are intentionally outside `npm run check`.** `test/contracts/repository-boundary.test.ts` pins this exclusion. Host/version/provider drift is found only when someone explicitly runs `test:real-host`; the benchmark has a second opt-in.
- **The recorded review benchmark measures one observation per artifact and direction, not repeat stability.** It cannot establish deterministic verdicts or rounds-to-convergence. The deterministic contract suite instead pins the materiality and remediation instructions; a future opt-in convergence benchmark should repeat identical production envelopes and measure blocker-class agreement and remediation closure.
- **Operator-level journeys remain separate evidence.** `docs/validation/release-validation.md` records the two full producer journeys (VAL-01) as unexecuted and a complete installed two-phase phase-design/phase-implementation slice (VAL-16) as an accepted gap; the server-absent manual journey it lists as pending (VAL-12) is moot now that degraded mode is read-only. The automated terminal suite proves named slices, not an entire human workflow.
- **Some real failure classes remain simulated.** The same report records real `TIMEOUT`, `OUTPUT_OVERFLOW`, `RATE_LIMITED`, and logged-out `AUTH_UNAVAILABLE` as fake-only by design (VAL-08), and no observed real host holding a pending gate through its resolved timeout (VAL-09).
- **Real-host security evidence is bounded.** Fake and real dispatch tests check canonical authentication locations, disposable workspaces, scrubbed environment, canaries, output scanning, and PII omission, but `docs/validation/release-validation.md` explicitly records no OS-enforced containment or proof against repository/global-instruction and persistence-capable-tool access (VAL-07). The workspace unit suite additionally proves an atomic credential replacement survives workspace disposal, preventing regression to disposable credential projection.
- **Platform coverage is maintainer-dependent.** Process-group cancellation/reaping cases in `test/integration/dispatch-plumbing.test.ts` and `test/integration/mcp-stdio.test.ts` run only when `process.platform !== "win32"`; there is no hosted platform matrix proving alternate paths.
- **No quantitative coverage gate exists.** Confidence comes from behavioral/corpus/mutation suites and the release matrix, not line/branch percentages.
- **Release-validation documentation is point-in-time evidence.** `docs/validation/release-validation.md` is stamped 2026-08-04 and contains some evolving Phase 21 observations; use executed tests/artifacts and a newly recorded opt-in run when deciding present real-host status rather than treating candidate procedures as current proof.
