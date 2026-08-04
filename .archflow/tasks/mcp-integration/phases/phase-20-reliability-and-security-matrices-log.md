## Implementation Log: Phase 20 - Reliability and Security Matrices

### Decisions Made

- `src/init/registration.ts` now routes ArchFlow-owned `.mcp.json` and `.codex/config.toml` serialization through the local `replaceHostConfig(path, source): Promise<void>` helper: same-directory exclusive temporary file, explicit `0o644` mode, file `fsync`, close, and atomic `rename`. The state/projection path-class allowlists remain unchanged.
- `src/state/production.ts` exports `ProductionInput` with optional `atomic?: AtomicWriter` and `gate_secret_scanner?: SecretScanner`; `createProductionServices(input: ProductionInput): Promise<ProjectResult<ProductionServices>>` defaults them to `createAtomicWriter()` and `createSecretlintScanner()`. `src/init/legacy-upgrade.ts` similarly adds `projection_writer?: ProjectionWriter` to `StageLegacyUpgradeInput`, defaulting inside `stageLegacyUpgrade(...)`.
- Each crash child owns and exports its import-safe `CUT_POINTS` list and rejects any requested cut outside that same list. `test/crash/state-transaction.test.ts` imports their union for both MCP and local bundle scans; no independent registry was added.
- `test/helpers/task-workspace.ts` deliberately imports `src/**` and says so in its header. `createTaskWorkspace(options: TaskWorkspaceOptions): Promise<TaskWorkspace>` creates a real neutralized Git repository, committed policy base, initialized revision-1 PRD task, production services, and disposer for integration-oriented tests.
- Dispatch shutdown and cancellation retain the shipped termination implementation. Phase 20 proves eventual reaping for the direct child and descendants that remain in its process group, observes that `runtime.handle.close()` resolves before that reaping completes, and records `setsid()` descendants and synchronous shutdown completion as unsupported rather than silently changing lifecycle semantics.
- The user accepted the unchanged local-only `fast-uri@3.1.0` exposure, the documented asynchronous shutdown limitation, and commit for MCP bundle digest `3ac59d3481a435801442a09761a104d49984a4b2fff9145ea7b58900a6823aba` on 2026-08-04.

### Deviations from Plan

- Implementation counter-review found that the first gate-secret test called `prepareProjectionPlan` directly. It was replaced with a real `runDurableGate` discard-and-restore path in `test/integration/state-gate-lifecycle-phase12.test.ts`; the immutable decision archive is permitted because it precedes replanning, while state, approvals, receipt, projection, and target bytes remain unchanged.
- The first file-kind SIGKILL test wrapped a hand-written writer. It now loads `src/state/atomic.ts` through Vite, wraps the shipped `createProjectionWriter()`, and proves complete prior/next binary generations at both projection cuts.
- The planned shutdown observation produced the narrower result anticipated by the design: `close()` does not await in-flight termination, although asynchronous process-group cleanup succeeds. No source redesign was absorbed; `docs/reliability-security-limitations.md` states the observed ordering and does not claim SIGKILL escalation.
- The host-config crash fix pins new replacement files to `0o644`; it does not attempt a metadata-preservation subsystem. The fault test observes the temporary mode under umask `0o002` and proves the prior file survives a pre-rename failure.
- Generated release changes include `dist/legal/review.json` as the byte-identical payload copy of `release/legal-review.json`. No PRD requirement, durable schema, MCP tool, gate kind, error code, runtime dependency, or workflow graph changed.

### Patterns Established

- A fault-injection override belongs at the composition root and must be consumed through the real production path in at least one test; testing only override identity is not propagation coverage.
- Crash cut declaration, validation, and bundle exclusion share the owning fixture's exported `CUT_POINTS`; a second hand-maintained inventory is not authoritative.
- Lifecycle tests distinguish signal delivery, eventual descendant reaping, and the timing of API completion. One observation must not be described as another.
- Host-facing atomic replacements create the temporary file with an explicit mode rather than inheriting ambient umask.

### Gotchas

- Restore replanning scans only tracked projection sources. A gate-secret fixture must mark its source tracked or `prepareProjectionPlan` correctly has no scan candidate.
- `resolveDurableGate` archives the human decision before restore replanning. `SECRET_DETECTED` therefore guarantees no advancing receipt/state/projection, not zero durable bytes.
- A crash test around a hand-written `writeFile`/`rename` sequence cannot detect regressions in `createProjectionWriter()`. The child must load the shipped TypeScript implementation (the test uses the existing Vite fixture convention).
- `runtime.handle.close()` triggers abort and eventual process-group reaping but does not wait for the dispatch handler promise. Immediate `process.kill(pid, 0)` probes see the child and in-group grandchild alive after close returns.
- `npm run release:write` requires `-- --stage <staged-directory>`; running it without the stage argument only prints usage and changes nothing.

### Key Interfaces

- `src/state/production.ts`: `ProductionInput` now includes `atomic?: AtomicWriter` and `gate_secret_scanner?: SecretScanner`; `createProductionServices(input: ProductionInput): Promise<ProjectResult<ProductionServices>>` installs the supplied capabilities in `services.dependencies`.
- `src/init/legacy-upgrade.ts`: `StageLegacyUpgradeInput.projection_writer?: ProjectionWriter`; `stageLegacyUpgrade(input: StageLegacyUpgradeInput): Promise<ProjectResult<StagedLegacyUpgrade>>` routes every staging projection through it.
- `test/helpers/task-workspace.ts`: `createTaskWorkspace(options: TaskWorkspaceOptions): Promise<TaskWorkspace>` returns `{ root, taskId, initialization, services, dispose }` after real revision-1 initialization.
- `test/fixtures/crash-projection-writer.mjs`: `createCrashProjectionWriter(writer, cutPoint, killAtCut)` wraps `replaceRegular`, `replaceSymlink`, and `remove` with before/after cuts.
- `test/fixtures/{state-transaction-child,state-phase10-child,state-phase12-gate-child}.mjs`: exported `CUT_POINTS` are the authoritative crash vocabularies consumed by their entrypoints and the bundle scan.
- `docs/reliability-security-limitations.md` is the human-facing authority for the seven accepted unsupported cells until Phase 22 publishes the support matrix.

### Counter-Review Resolution

- All four findings in `reviews/phase-20-impl-counter-review.md` were accepted and fixed: real gate-secret propagation, the shipped projection writer under SIGKILL, direct shutdown-completion ordering, and explicit host-config mode.
- Post-triage focused verification passed 71/71 tests. The complete non-release suite then passed 152 files / 1,678 tests before release promotion.

### Verification

- Final `npm run check` passed: 153 test files / 1,681 tests, 21 contract files / 476 tests, 13 MCP-runtime files / 119 tests, TypeScript, SDK compatibility, temporary bundle smoke, dependency/notices policies, MCP boundary checks, tracked-release validation, guarded smoke, mutation checks, and byte-identical reproduction.
- Crash verification passed 48/48 tests. The Phase 20 changed-suite integration run passed 151/151 before counter-review, and the four corrected findings passed their focused suites after triage.
- The final tracked release has MCP digest `3ac59d3481a435801442a09761a104d49984a4b2fff9145ea7b58900a6823aba`, local-helper digest `b29193860007eecbe4bc05d694ae3fd88a96e2dc905d4fcc37bc2a5ee78f0f58`, dependency-inventory digest `6836db3d7e77b1cf9cb19c0a0c063ff6cfaee5f50e92fdeea28241fb31ec5777`, manifest digest `c25f09ed8cedb488555733bc44614960dbc76b861d23fe5219f822edd16f33e2`, and legal-review digest `4f2a366bf0ebfdff1f1fa703831216ae9b06d1e3cb7114071fdc66c282d9cfe9`.

### Proposed Durable Conventions

- Propose adding to repository policy: a test for an injected composition capability must traverse its real consumer and assert the consumer's durable postconditions; identity-only assertions prove wiring, not propagation.
- Propose adding to repository policy: process-lifecycle evidence must say whether it proves signal delivery, eventual exit, or exit-before-API-completion; do not collapse those into a generic “reaped” claim.
- Propose adding to repository policy: every same-directory temporary replacement of a user-owned file supplies an explicit file mode rather than accepting ambient umask.

No policy file was changed for these proposals; they require separate explicit approval.
