# Dependency upgrades

ArchFlow uses exact direct versions and an exact npm lockfile. Dependency changes are deliberate review events, not routine range resolution.

## Currency review — 2026-07-27

Registry metadata was reviewed for every Phase 1 direct pin. The selected versions are current on the review date, with two intentional line choices:

| Package | Pin | Review result |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0-beta.5` | Current v2 beta/latest tag; root package declares MIT. Its exact dependency `@modelcontextprotocol/core@2.0.0-beta.5` also declares MIT. |
| `zod` | `4.4.3` | Current; MIT |
| `ajv` | `8.20.0` | Current; MIT |
| `ajv-formats` | `3.0.1` | Current; MIT |
| `yaml` | `2.9.0` | Current; ISC |
| `typescript` | `7.0.2` | Current; Apache-2.0 |
| `@types/node` | `24.13.3` | Current compatible Node 24 typing line; MIT. Runtime and typing patch versions are intentionally independent. |
| `esbuild` | `0.28.1` | Current; MIT |
| `vitest` | `4.1.10` | Current; MIT |
| `vite` | `7.3.6` | Current supported Vite 7 line; MIT. Vite 8 is intentionally excluded because its current graph introduces MPL-2.0 Lightning CSS. |

### MCP beta compatibility evidence

The exact `@modelcontextprotocol/server@2.0.0-beta.5` and locked `@modelcontextprotocol/core@2.0.0-beta.5` roots were rechecked on 2026-07-27 before admission. The public server root exports `Server` and `specTypeSchemas`; `@modelcontextprotocol/server/stdio` exports `StdioServerTransport`. The public declarations retain method-string request handlers with `ctx.mcpReq.signal`, a configurable `supportedProtocolVersions` list that accepts the singleton `["2025-11-25"]`, `Server.projectCallToolResult`, and `close`. The neutral public `specTypeSchemas` includes `ListToolsResult` and `RequestId`, and the package names `2025-11-25` as its latest supported 2025 protocol revision.

The package remains explicitly beta and warns that breaking changes are possible before v2 stabilizes. [Upstream's current maintenance guidance](https://github.com/modelcontextprotocol/typescript-sdk#readme) still identifies v1.x as the production-supported release until v2 stabilizes and promises v1 bug and security fixes for at least six months after v2 ships. This project deliberately accepts the exact reviewed beta instead of installing the monolithic `@modelcontextprotocol/sdk` v1 as a fallback. The low-level `Server` class is deprecated in favor of `McpServer` for ordinary high-level use but remains documented for advanced use; Phase 4 may isolate that deliberate exception only after its compatibility gate passes. No optional MCP framework or Node adapter package is admitted.

Node `24.15.0` remains the functional package floor and lower CI matrix entry. Production and release verification should use the current Node 24 LTS security patch (`24.18.0` at this review); the separately pinned `@types/node` patch need only remain compatible with the Node 24 major.

## Upgrade procedure

1. Review official registry/repository release and license metadata for each proposed direct update and its resolved graph.
2. Edit only exact versions in `package.json`, then deliberately regenerate `package-lock.json` with the intended npm version.
3. Update `THIRD_PARTY_NOTICES.md` from the resolved lock inventory.
4. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:contracts`, `npm run build:temp`, `npm run check:dependencies`, `npm run check:notices`, and `npm run test:notices-policy` on both supported exact Node versions.
5. Review schema, serialized-format, CLI, and protocol migrations before accepting the regenerated lock.

The dependency policy rejects direct ranges, packages outside the phase allowlist, missing/unreviewed licenses, copyleft licenses, Lightning CSS, and dependencies reserved for later phases. Any policy expansion requires explicit review rather than weakening the checker as part of an unrelated update.
