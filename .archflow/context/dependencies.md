# Dependencies and Integrations

**Explored:** 2026-07-27
**Commit:** `8e3144c`

## Package and runtime baseline

- `package.json` defines a private ESM package (`"type": "module"`) named `archflow-mcp-server`; `package-lock.json` is the npm lockfile-v3 source of the fully resolved graph.
- The code targets Node.js 24. `tsconfig.json` targets `ES2024` with NodeNext modules, while `scripts/build-temp.mjs` emits a Node 24 ESM smoke bundle. CI exercises the exact Node versions `24.15.0` and `24.18.0` (`.github/workflows/ci.yml`).
- Every direct dependency is exactly pinned. `scripts/check-dependency-policy.mjs` treats the package list, versions, lock metadata, and accepted licenses as policy rather than allowing semver ranges or arbitrary additions.

## Runtime dependencies

| Dependency | Pin | Use |
| --- | --- | --- |
| `zod` | `4.4.3` | Primary TypeScript-side structural and semantic validation throughout `src/contracts/`, including configuration, workflow, gates, evidence, reviews, errors, MCP tool envelopes, and trust records. |
| `ajv` | `8.20.0` | JSON Schema 2020-12 compilation and validation in `src/contracts/validators.ts`; loaded through `ajv/dist/2020.js`. |
| `ajv-formats` | `3.0.1` | Adds standard JSON Schema formats to the Ajv validator in `src/contracts/validators.ts`. |
| `yaml` | `2.9.0` | Strict YAML 1.2 parsing in `src/contracts/yaml.ts`, including rejection of multiple documents, warnings, duplicate keys, merges, aliases, and non-plain-JSON values. This parser feeds configuration, workflow, and rubric loading. |

The contract layer also uses only built-in Node modules: `node:crypto` for SHA-256 trust/evidence digests and `node:util` for deep equality. Scripts use built-in filesystem, path, process, OS, assertion, and child-process APIs.

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

At this commit, `src/` contains the shared contract and validation layer only. There is no executable MCP server entry point, transport binding, HTTP client, database driver, filesystem-backed state store, or cloud service integration. There are no calls to `fetch`, no database/auth-provider packages, and no application secrets or API-key requirements.

The future MCP integration is described in `docs/mcp-integration-design.md`: it is intended to dispatch short-lived `claude -p` and `codex exec` processes using the user's existing subscription authentication. The design explicitly avoids requiring or forwarding `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, because those variables can switch child processes to metered API authentication. That behavior is design intent, not implemented runtime behavior in the current source tree.

`scripts/check-dependency-policy.mjs` additionally rejects packages reserved for later implementation phases: `@anthropic-ai/sandbox-runtime`, `@modelcontextprotocol/server`, `execa`, `proper-lockfile`, and `write-file-atomic`. Their absence is deliberate and confirms that MCP transport/dispatch, sandboxing, locking, and atomic state persistence have not yet landed.

Schema identifiers such as `https://archflow.dev/schemas/v1/mcp-tools` in `src/contracts/versions.ts` and `src/contracts/schemas/v1/*.json` are stable identifiers/references; the current validators register and resolve the bundled local schemas rather than fetching them over the network.

## Dependency, license, and notice policy

- `scripts/check-dependency-policy.mjs` enforces the exact direct allowlist, exact versions, npm lockfile v3 metadata, and permissive-license allowlist (`0BSD`, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT). It rejects Lightning CSS, later-phase packages, direct optional/peer/bundled dependencies, incomplete resolution metadata, and unreviewed licenses.
- `THIRD_PARTY_NOTICES.md` inventories the resolved graph. `scripts/check-notices.mjs` reconciles it against the lockfile and installed packages and verifies retained NOTICE digests; `notices/typescript-7.0.2-NOTICE.txt` is the retained asset currently under policy.
- `scripts/test-notices-policy.mjs` mutation-tests that changed, missing, and unreviewed notice content is rejected.
- `docs/dependency-upgrades.md` records the reviewed pins and the upgrade procedure. Dependency upgrades require deliberate lock regeneration, notice refresh, policy checks, and verification on both supported Node versions.

## CI/CD and verification

GitHub Actions is the only CI/CD integration (`.github/workflows/ci.yml`). On every push and pull request, an Ubuntu job runs for each supported Node version with read-only repository contents permission:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm run test:contracts`
5. `npm run build:temp`
6. `npm run check:dependencies`
7. `npm run check:notices`
8. `npm run test:notices-policy`
9. Assert that no tracked/release `dist` directory was produced

`npm run check` provides the corresponding local aggregate, though it invokes the broad `npm test` and then the contract subset again. There is no deployment, package publication, container build, release workflow, or external CI service configured.
