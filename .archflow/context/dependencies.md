# Dependencies and Integrations

**Explored:** 2026-07-28
**Commit:** `91a7c95`

## Package and runtime baseline

- `package.json` defines a private ESM package (`"type": "module"`) named `archflow-mcp-server`; `package-lock.json` is the npm lockfile-v3 source of the fully resolved graph.
- The code targets Node.js 24. `tsconfig.json` targets `ES2024` with NodeNext modules, while `scripts/build-temp.mjs` emits a Node 24 ESM smoke bundle. CI exercises the exact Node versions `24.15.0` and `24.18.0` (`.github/workflows/ci.yml`).
- Every direct dependency is exactly pinned. `scripts/check-dependency-policy.mjs` treats the package list, versions, lock metadata, and accepted licenses as policy rather than allowing semver ranges or arbitrary additions.

## Runtime dependencies

| Dependency | Pin | Use |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` | MCP server SDK (phase 4+) for stdio transport binding and tool dispatch. Used in `src/mcp/sdk-adapter.ts` to initialize the Server, handle `Transport`, and implement the `startMcpRuntime` entry point. Includes protocol types and error handling. |
| `zod` | `4.4.3` | Primary TypeScript-side structural and semantic validation throughout `src/contracts/`, including configuration, workflow, gates, evidence, reviews, errors, MCP tool envelopes, and trust records. |
| `ajv` | `8.20.0` | JSON Schema 2020-12 compilation and validation in `src/contracts/validators.ts`; loaded through `ajv/dist/2020.js`. |
| `ajv-formats` | `3.0.1` | Adds standard JSON Schema formats to the Ajv validator in `src/contracts/validators.ts`. |
| `yaml` | `2.9.0` | Strict YAML 1.2 parsing in `src/contracts/yaml.ts`, including rejection of multiple documents, warnings, duplicate keys, merges, aliases, and non-plain-JSON values. This parser feeds configuration, workflow, and rubric loading. |

The contract layer and MCP runtime also use only built-in Node modules: `node:crypto` for SHA-256 trust/evidence digests, `node:util` for deep equality, `node:buffer` for transport framing, and `node:stream` for Readable/Writable transport abstractions. Scripts use built-in filesystem, path, process, OS, assertion, and child-process APIs.

## Development and build dependencies

| Dependency | Pin | Use |
| --- | --- | --- |
| `typescript` | `7.0.2` | Strict, no-emit checking via `npm run typecheck`; options include `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax` (`tsconfig.json`). |
| `@types/node` | `24.13.3` | Node API typings for source, tests, and scripts. The typing patch is intentionally independent of the two tested runtime patches (`docs/dependency-upgrades.md`). |
| `vitest` | `4.1.10` | Node-environment unit and contract tests under `test/**/*.test.ts`; configured in `vitest.config.ts`. |
| `vite` | `7.3.6` | Vitest's pinned toolchain dependency. Vite 7 is intentional: `docs/dependency-upgrades.md` excludes Vite 8 because its reviewed graph brings in MPL-2.0 Lightning CSS. |
| `esbuild` | `0.28.1` | Produces the temporary bundled contract artifact `.tmp/archflow-contracts.mjs`; `scripts/smoke-temp-bundle.mjs` dynamically imports and exercises it. No release `dist/` artifact is produced. |

No ESLint, Prettier, Biome, or separate coverage package/configuration is present. Formatting and import organization are maintained by repository convention and TypeScript checks; Vitest's config reserves `coverage/` as the reports directory but the standard scripts do not run coverage.

## Application configuration

- `src/contracts/config.ts` and `src/contracts/schemas/v1/config.schema.json` define configuration data, not process-environment loading. Version 1 contains per-role model routes (`producer`, `self-reviewer`, `counter-reviewer`, `adjudicator`) with a model name and one of `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; optional skill-specific overrides exist for `explore`, `prd`, `design`, `phase-design`, and `phase-impl`.
- `assets/workflow.yaml` is the bundled workflow policy. `assets/constitution/*.md` is the bundled layered constitution, with ordering documented by `assets/constitution/README.md`.
- The source contains no `process.env` access and the repository has no `.env` template or runtime environment-variable contract. `install.sh` uses shell environment only to resolve `$HOME` and install skills into `~/.claude/skills/` and `~/.agents/skills/`.

## External integrations and persistence

At this commit, `src/` contains the contract, validation, and MCP stdio transport layers. The MCP server implementation (`src/mcp/`) provides:

- **Transport**: stdio-based message framing via `src/mcp/framing.ts` (JSON-line protocol), `src/mcp/send-queue.ts` (send buffering), and `src/mcp/process-runner.ts` (Node process integration).
- **Server**: `src/mcp/sdk-adapter.ts` binds the `@modelcontextprotocol/server` SDK, `src/mcp/server.ts` implements tool boundary enforcement and response verification, and `src/mcp/tools.ts` defines the advertised tool catalogue.
- **Session management**: `src/mcp/session.ts` handles JSON-RPC invocation context and argument projection.

There is no HTTP client, database driver, filesystem-backed state store, or cloud service integration. There are no calls to `fetch`, no database/auth-provider packages, and no application secrets or API-key requirements.

The MCP integration dispatches short-lived `claude -p` and `codex exec` processes using the user's existing subscription authentication, as designed in `docs/mcp-integration-design.md`. The design explicitly avoids requiring or forwarding `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, because those variables can switch child processes to metered API authentication.

`scripts/check-dependency-policy.mjs` additionally rejects packages reserved for later implementation phases: `@anthropic-ai/sandbox-runtime`, `execa`, `proper-lockfile`, and `write-file-atomic`. Their absence is deliberate and confirms that sandboxing, locking, and atomic state persistence have not yet landed.

Schema identifiers such as `https://archflow.dev/schemas/v1/mcp-tools` in `src/contracts/versions.ts` and `src/contracts/schemas/v1/*.json` are stable identifiers/references; the current validators register and resolve the bundled local schemas rather than fetching them over the network.

## Dependency, license, and notice policy

- `scripts/check-dependency-policy.mjs` enforces the exact direct allowlist, exact versions, npm lockfile v3 metadata, and permissive-license allowlist (`0BSD`, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT). It rejects Lightning CSS, later-phase packages, direct optional/peer/bundled dependencies, incomplete resolution metadata, and unreviewed licenses.
- `THIRD_PARTY_NOTICES.md` inventories the resolved graph. `scripts/check-notices.mjs` reconciles it against the lockfile and installed packages and verifies retained NOTICE digests; `notices/typescript-7.0.2-NOTICE.txt` is the retained asset currently under policy.
- `scripts/test-notices-policy.mjs` mutation-tests that changed, missing, and unreviewed notice content is rejected.
- `docs/dependency-upgrades.md` records the reviewed pins and the upgrade procedure. Dependency upgrades require deliberate lock regeneration, notice refresh, policy checks, and verification on both supported Node versions.

## CI/CD and verification

GitHub Actions is the only CI/CD integration (`.github/workflows/ci.yml`). On every push and pull request, an Ubuntu job runs for each supported Node version (`24.15.0`, `24.18.0`) with read-only repository contents permission:

1. `npm ci`
2. `npm run probe:phase4-mcp-compatibility` — MCP SDK compatibility checks
3. `npm run typecheck`
4. `npm run test:mcp-runtime` — Unit and integration tests for MCP transport and process binding
5. `npm test` — Full test suite
6. `npm run test:contracts` — Contract-specific tests
7. `npm run build:temp` — Temporary bundle artifact for smoke testing
8. `npm run check:dependencies` — Dependency policy verification
9. `npm run check:notices` — Third-party notice inventory validation
10. `npm run test:notices-policy` — Notice mutation tests
11. `npm run check:phase4-mcp-boundary` — Phase 4 MCP module boundary checks
12. `npm run test:phase4-mcp-boundary-policy` — Phase 4 boundary mutation tests
13. `npm run release:check` — Release payload verification
14. `npm run release:smoke` — Release bundle smoke tests
15. `npm run release:mutations` — Release integrity mutation tests
16. `npm run release:reproduce` — Release reproducibility verification

`npm run check` provides the corresponding local aggregate that runs all verification steps in sequence. There is no deployment, package publication, container build, or external CI service configured; releases are staged to a tracked `dist/` directory for reproducibility validation.
