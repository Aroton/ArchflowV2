# TESTING

**Explored:** 2026-08-23 · **Commit:** `92fa1f6` · **Covers:** `test/`, `vitest.config.ts`, `package.json`, `scripts/build-temp.mjs`, `scripts/smoke-release-bundle.mjs`

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
| `integration` | `test/integration/` | Real temporary Git repositories, durable filesystem workflows, child processes, CLI/stdio, installers, and full semantic journeys | No |
| `crash` | `test/crash/` | Process termination at persistence cut points and restart recovery | No |
| `real-host` | `test/real-host/` | Installed bundles, authenticated Claude/Codex calls, host selection, provider behavior, and benchmarks | Never automatically |

The fast project currently contains 99 unit files and 27 contract files. Slow workflow tests that formerly lived under `test/unit/` were moved to integration: live config editing, durable transactions and gates, secret rejection, repository path resolution, status classification, implementation-output construction, legacy upgrade, and task workspaces.

The schema split preserves cheap trust boundaries in the fast project. `schema-registry.test.ts` pins the registry/directory identity, generation inventory, and public barrel; `mcp-advertisement.test.ts` pins the two tool names, descriptions, plain input roots, and byte ceiling. Repeated strict Ajv compilation and the classified MCP corpus live in `test/extended/`.

TypeScript still includes every `test/**/*.ts` file, so optional tests cannot silently rot at compile time. `test/types/mcp-sdk-public-surface.ts` remains compile-only coverage exercised by `npm run typecheck`.

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

`npm run check:deep` is an explicit, expensive validation for unusually broad changes. It first runs the ordinary check, then schema-byte regeneration comparison, extended tests, all integration and crash tests, notice/SDK-boundary mutation tests, and the full release check. It does not run real hosts or the review benchmark.

There is intentionally no changed-file detector that guesses when deep verification is necessary. The human chooses it when a change crosses many boundaries, modifies schemas/generation, changes durability/process behavior, or alters release construction.

## Release and real-host validation

The ordinary temporary build (`npm run build:temp`) creates bundles under the OS temporary directory, smoke-exercises them, and removes them. It does not touch tracked `dist/` and does not trigger release reproduction.

Release commands remain separately selectable:

- `release:stage` builds a candidate payload into an explicitly supplied empty directory.
- `release:check` validates a supplied payload; `release:smoke` exercises copied/hostile runtime modes.
- `release:mutations` checks representative hostile payload changes; `release:reproduce` rebuilds and byte-compares tracked `dist/`.
- `check:release` composes those four checks and runs only from `check:deep` or by explicit request.
- `release:write` promotes an explicitly staged candidate into tracked `dist/`; it never installs machine-global assets.

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
- Put real Git, multi-file durable workflows, child processes, CLI/stdio, generated bundles, installers, and cross-service journeys in `integration`.
- Put deliberate process termination in `crash`; put any authenticated or provider-dependent behavior in `real-host`.
- Name tests for the behavior they cover, never the workflow phase that introduced them.

There is no coverage percentage gate. Confidence comes from the fast representative layer plus explicitly chosen deeper evidence when the affected boundary warrants it.
