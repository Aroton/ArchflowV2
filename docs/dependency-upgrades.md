# Dependency upgrades

ArchFlow uses exact direct versions and an exact npm lockfile. Dependency changes are deliberate review events, not routine range resolution.

## Currency review — 2026-07-27

Registry metadata was reviewed for every Phase 1 direct pin. The selected versions are current on the review date, with two intentional line choices:

| Package | Pin | Review result |
| --- | --- | --- |
| `zod` | `4.4.3` | Current; MIT |
| `ajv` | `8.20.0` | Current; MIT |
| `ajv-formats` | `3.0.1` | Current; MIT |
| `yaml` | `2.9.0` | Current; ISC |
| `typescript` | `7.0.2` | Current; Apache-2.0 |
| `@types/node` | `24.13.3` | Current compatible Node 24 typing line; MIT. Runtime and typing patch versions are intentionally independent. |
| `esbuild` | `0.28.1` | Current; MIT |
| `vitest` | `4.1.10` | Current; MIT |
| `vite` | `7.3.6` | Current supported Vite 7 line; MIT. Vite 8 is intentionally excluded because its current graph introduces MPL-2.0 Lightning CSS. |

## Upgrade procedure

1. Review official registry/repository release and license metadata for each proposed direct update and its resolved graph.
2. Edit only exact versions in `package.json`, then deliberately regenerate `package-lock.json` with the intended npm version.
3. Update `THIRD_PARTY_NOTICES.md` from the resolved lock inventory.
4. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:contracts`, `npm run build:temp`, `npm run check:dependencies`, `npm run check:notices`, and `npm run test:notices-policy` on both supported exact Node versions.
5. Review schema, serialized-format, CLI, and protocol migrations before accepting the regenerated lock.

The dependency policy rejects direct ranges, packages outside the phase allowlist, missing/unreviewed licenses, copyleft licenses, Lightning CSS, and dependencies reserved for later phases. Any policy expansion requires explicit review rather than weakening the checker as part of an unrelated update.
