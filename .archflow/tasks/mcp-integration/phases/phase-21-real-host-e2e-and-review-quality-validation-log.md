## Implementation Log: Phase 21 - Real-Host E2E and Review-Quality Validation (In Progress)

### Decisions Made

- `src/dispatch/cli.ts` projects each normative output schema to a non-authoritative provider transport schema through `projectCliOutputSchema(outputSchema, resultKind, adapter, subject?)`. The caller-owned schema is validated and cloned once; local `$defs`/`$ref`, required fields, and closed object shapes remain, while unsupported metadata/composition/constraint keywords are removed per provider. Unchanged `parseAndDeriveReview` and `parseAndDeriveAdjudication` remain the authority before attestation.
- Review subject identity fields are bound to exact envelope constants. The finite finding severity/blocking relationship is represented by two closed transport branches. Codex's state-dependent optional mechanical digests use six exact closed branches rather than becoming unconditional or nullable.
- `test/helpers/real-host.ts` requires `ARCHFLOW_REAL_HOSTS=1` before probing and `ARCHFLOW_REVIEW_BENCHMARK=1` before benchmarking. Opted-in runs remove only `node_modules/.bin` PATH entries so npm package shims cannot shadow the developer's installed first-party CLIs; unavailable opted-in hosts fail instead of skipping.
- The first benchmark remains preserved in Git history at observation digest `61f6b56b0ac92c587c5312f12c3c7babcfd29d1925206d14fa07b81f7c221eea`; its six detections and five false blockers caused threshold rejection. Amendment 1 recalibrated the benchmark and four production skill rubrics with identical blocking burden-of-proof and advisory criteria. The unchanged 12-run matrix produced observation digest `e39457d0ffb34e0727dd085288dc968cda9182fc9bd508d5d5a2a323745f257f`: four `seed-detected`, two `missed`, and six `clean-pass`. The user approved detection 2/3, zero false blockers, complete 12-run triage, and two defects found after non-blocking review; `docs/validation/thresholds.json` binds those thresholds to the immutable digest.
- The user re-accepted the unchanged local-only `fast-uri@3.1.0` exposure and documented asynchronous-shutdown limitation for MCP bundle `9788624d71e48a3b683af3112f0f12e2fc735f7cd598a508e07f2d2e25d92499` and authorized this checkpoint commit.

### Deviations from Plan

- Real probes did not initially reject the configured model slugs. Codex rejected root `allOf`, and Claude rejected the Draft 2020-12 `$schema` URI before model selection. The user explicitly approved provider transport projections; normative schemas and post-validation did not change.
- Claude review output exposed finding-ID and severity/blocking inconsistencies after broad constraint stripping. The projection was narrowed to retain supported simple patterns and to encode the finite blocking relationship. Only the complex task-slug negative-lookahead is replaced by a simple transport pattern; exact task-slug validation remains local.
- One real Claude adjudication returned a matched rule in both matched and uncertain lists. Normative validation correctly refused attestation. No combinatorial cross-array transport-schema generator or weakened adjudication rule was added.
- The first real benchmark completed in 753.3 seconds and failed `VAL-02` with an 83.3% false-blocker rate. The approved recalibration completed in 469.7 seconds with zero false blockers but missed the seeded `LEASE_EXPIRED` handling defect in both directions. The user accepted that measured tradeoff and approved the observed thresholds; no third wording iteration was performed.
- The current installed nine-slice suite covers initialization/pinning, dirty exact replay, manual checkpoint/import, snapshot/restore and cap behavior, recorded maintenance pruning, pre-projection secret rejection, and normal/manual upgrade convergence. Restore collisions and two-phase evidence-path noncollision remain recorded gaps because reproducing the full production state/gate/evidence harness solely at the launcher boundary is disproportionate for this prototype.

### Patterns Established

- Host structured-output schemas are generation aids, never authority. Provider projections may remove unsupported syntax only when the unchanged normative parser post-validates every returned byte before evidence is minted.
- An explicit real-host opt-in must fail visibly when its required hosts are unavailable; it must not silently turn an intended validation run into skips.
- Benchmark observation bytes and their digest are immutable. Human dispositions and derived metrics bind to that digest outside it, so scoring never rewrites the observations it approves or rejects.
- Benchmark input identity includes `rubric_digest`; a rubric-only recalibration therefore cannot retain the prior benchmark input identity.
- The benchmark TypeScript literal and four production Markdown rubrics intentionally duplicate identical calibration text for this prototype; `test/contracts/skill-contract-phase17.test.ts` pins the shared bytes and retained task-specific criteria.
- A failed product-quality gate is recorded as a blocker and reopens the premise named by the PRD; it is not converted into a passing threshold.

### Gotchas

- npm/npx prepends ancestor `node_modules/.bin` directories. On this machine `/home/aroto/node_modules/.bin/claude` was an obsolete unauthenticated 2.0.11 shim ahead of the installed 2.1.221 CLI; real-host tests must sanitize only those package-bin entries after opt-in.
- `codex login status` exits zero and writes `Logged in using ChatGPT` to stderr. Authentication accepts one or more recognized success lines across stdout/stderr; exact-count logic produces false `AUTH_UNAVAILABLE`.
- Codex rejects semantic `allOf` in its strict output schema and requires explicit types/required properties. Claude accepts local refs but rejects the Draft 2020-12 metadata and several constraint classes. Neither provider behavior permits weakening local validation.
- A result one byte over the declared result cap is rejected by the durable input schema before snapshot preparation, so it does not return `SNAPSHOT_LIMIT`; retained-task cap overflow does return `SNAPSHOT_LIMIT`.
- `npm run check` may expose the already accepted asynchronous shutdown sampling race in `test/integration/mcp-stdio.test.ts`; the isolated test passed immediately, and the complete gate passed on rerun.

### Key Interfaces

- `src/dispatch/cli.ts`: `projectCliOutputSchema(outputSchema: PlainJsonValue, resultKind: DispatchEnvelope["result_kind"], adapter: AdapterId, subject?: Readonly<Record<string, PlainJsonValue>>): PlainJsonValue`.
- `src/dispatch/cli.ts`: `detectManagedPolicyPaths(paths: readonly string[]): Promise<readonly string[]>` supplies the synthesized-present positive probe.
- `test/helpers/real-host.ts`: `realHostsEnabled()`, `benchmarkEnabled()`, `realHostsAvailable()`, and `requireRealHostsAvailable(condition)` own opt-in, PATH sanitation, and explicit availability failure.
- `test/helpers/task-workspace.ts`: `TaskWorkspaceOptions.configBytes?: Uint8Array` replaces scaffolded config bytes before the policy-base commit.
- `docs/validation/review-benchmark.json`: `benchmark_result_digest` binds `observation_payload`; `human_scoring.observation_digest` binds the approved dispositions and metrics back to it.
- `docs/validation/thresholds.json`: `benchmark_result_digest` binds explicit user-approved observed thresholds to the immutable recalibrated benchmark.
- `docs/release-validation.md` is the phase authority for VAL-01 through VAL-17 status and the reason Phase 21 remains incomplete.

### Verification

- `npm run check` passed on the final tracked bundle: 160 ordinary test files (156 passed, 4 opt-in skipped), 1,698 passed tests, 21 contract files / 476 tests, 13 MCP-runtime files / 119 tests, typecheck, dependency/notices policies, MCP boundary checks, temporary build, release smoke/mutations, and byte-identical reproduction.
- The current installed terminal journey passed 9/9 against tracked `dist/`; the three added slices perform no model dispatch or credential access. The recalibrated review benchmark passed 3/3 and completed 12 real serialized model turns in 469.7 seconds. Focused rubric verification passed 8 tests with one opt-in test skipped; typecheck, 477 contract tests, and the ordinary 1,700-test suite passed.
- Tracked MCP digest is `9788624d71e48a3b683af3112f0f12e2fc735f7cd598a508e07f2d2e25d92499`; dependency inventory digest is `6836db3d7e77b1cf9cb19c0a0c063ff6cfaee5f50e92fdeea28241fb31ec5777`; manifest digest is `eba09ea777891f468405f390c92970ab1f80339d5c24cc3eaae7517f064fe418`; legal-review digest is `2838becf08e5199b7eb341d2d6123a9ba0037319e3f13207c79f995e6bb3d242`.

### Remaining Work Before Phase Completion

- Execute and record the two VAL-01 producer journeys, VAL-12 server-absent/manual journey, and VAL-09 real-client timeout/negotiation observations from `docs/real-host-journeys.md`.
- Decide whether the remaining partial installed boundaries (VAL-05 restore collisions and VAL-16 two-phase evidence noncollision) justify reproducing the full retained-result/gate/evidence harness before the next review gate.
