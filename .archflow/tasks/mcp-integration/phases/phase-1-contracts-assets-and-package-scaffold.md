# Phase 1: Contracts, Assets, and Package Scaffold

**Status**: COMPLETE
**Implemented**: 2026-07-27
**Task**: mcp-integration
**Goal**: Establish the buildable package foundation and foundational repository contracts.
**Requirements**: REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-10, REQ-15, REQ-17

## Context

This repository currently contains portable skills rather than a Node package. The first implementation edit adds a visible lineage/supersession banner to `docs/mcp-integration-design.md`: its originating heading/body remain intact, and resolving links identify the approved PRD and architecture as normative where they differ. The implementation log records that ordering; Phase 16 later updates surrounding release documentation.

The owner-approved architecture split keeps Phase 1 to package and foundational repository contracts. Review/triage/adjudication evidence, canonical review renderers, the error registry, gate/tool schemas, MCP SDK/server, and tracked offline bundle move to Phase 2. Durable `state.json`, detailed artifact/import/checkpoint/maintenance/snapshot schemas, and repository/Git/path/digest semantics belong to Phase 3. Explore remains fixed workflow vocabulary but is disposable pre-task work: it has no durable phase instance, review evidence, or state record.

## What We're Building

We will create a private ESM package with an exact npm lockfile, CLI-only TypeScript 7 checks, temporary esbuild verification output, Vitest/Vite tests, dependency notices/policy, and CI on exact Node `24.15.0` and `24.18.0`. Phase 1's only direct pins are `zod@4.4.3`, `ajv@8.20.0`, `ajv-formats@3.0.1`, `yaml@2.9.0`, `typescript@7.0.2`, `@types/node@24.13.3`, `esbuild@0.28.1`, `vitest@4.1.10`, and direct dev pin `vite@7.3.6`. The Vite pin constrains Vitest to its supported Vite 7 line; acceptance requires lock-wide proof that `lightningcss` and every copyleft or unreviewed dependency are absent. A live implementation-time currency review rechecks every pin and license before package work.

Foundational validation uses normative JSON Schema 2020-12, strict non-mutating Ajv2020 with `ajv-formats`, and explicit Zod mirrors only where useful to later boundaries. A recursive plain-JSON preflight rejects non-JSON values, cycles, non-plain prototypes, and dangerous own keys before Ajv. One safe YAML 1.2 parser feeds the exact fixed workflow, model/effort-only task config, structured artifact/implementation rubrics, and deterministic constitution frontmatter. Constitution evolution compares the prior pinned rule registry to the candidate and keeps IDs append-only with positive per-rule versions.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify first | `docs/mcp-integration-design.md` | Add the lineage/supersession banner while preserving the originating body. |
| Create | `package.json`, `package-lock.json`, `.gitignore` | Define the private exact-pinned package and ignore only temporary build/test output, never future tracked `dist/`. |
| Create | `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml` | Pin CLI-only TypeScript settings, Vitest/Vite configuration, and both exact Node versions. |
| Create | `THIRD_PARTY_NOTICES.md`, `docs/dependency-upgrades.md`, `scripts/check-{dependency-policy,notices}.mjs` | Enforce the direct allowlist, currency/upgrade review, lock-wide permissive licenses, and complete notices. |
| Create | `src/contracts/{index,versions,plain-json,validators,phase-instance,vocabulary,yaml,workflow,config,rubric,constitution}.ts` | Export validation infrastructure, branded codecs, fixed vocabulary, YAML parsing, and foundational repository contracts. |
| Create | `src/contracts/schemas/v1/{primitives,phase-instance,workflow,config,rubric,constitution-rule}.schema.json` | Provide independently inspectable foundational JSON Schema 2020-12 contracts. |
| Create | `assets/workflow.yaml`, `assets/constitution/{README,00-process,10-architecture,20-data,30-product}.md` | Publish the exact v1 graph and versioned frontmatter-plus-prose policy templates. |
| Create | `test/unit/{plain-json,phase-instance,yaml,workflow-config,rubric,constitution}.test.ts`, `test/contracts/foundational-schema-agreement.test.ts`, `test/fixtures/foundation/**` | Verify foundational schemas, assets, evolution, codecs, parser safety, and agreement. |
| Generate and ignore | temporary build/coverage output | Prove the contract barrel bundles under Node 24 without creating a tracked release artifact or startup command. |

Phase 1 creates no `src/main.ts`, `src/mcp/`, review/evidence schemas, renderers, error/gate/tool contracts, MCP fixtures, or `dist/`. It does not modify `install.sh`, `skills/`, `README.md`, `CLAUDE.md`, `docs/archflow-process.md`, `.gitattributes`, or the user-owned `AGENTS.md`.

## Contract Interfaces

```ts
export const SCHEMA_IDS = {
  primitives: "urn:archflow:schema:v1:primitives",
  phaseInstance: "urn:archflow:schema:v1:phase-instance",
  workflow: "urn:archflow:schema:v1:workflow",
  config: "urn:archflow:schema:v1:config",
  rubric: "urn:archflow:schema:v1:rubric",
  constitutionRule: "urn:archflow:schema:v1:constitution-rule"
} as const;

declare const positiveSafePhaseBrand: unique symbol;
declare const phaseInstanceIdBrand: unique symbol;
export type PositiveSafePhaseNumber = number & { readonly [positiveSafePhaseBrand]: true };
export type PhaseInstanceId = string & { readonly [phaseInstanceIdBrand]: true };
export type PhaseInstance =
  | { readonly kind: "prd" }
  | { readonly kind: "design" }
  | { readonly kind: "phase-design"; readonly phase: PositiveSafePhaseNumber }
  | { readonly kind: "phase-impl"; readonly phase: PositiveSafePhaseNumber };
export function parsePositiveSafePhaseNumber(value: unknown): PositiveSafePhaseNumber;
export function encodePhaseInstance(value: PhaseInstance): PhaseInstanceId;
export function decodePhaseInstance(value: unknown): PhaseInstance;

export const PHASE_IDS = ["explore", "prd", "design", "phase-design", "phase-impl"] as const;
export const PIPELINE_STEPS = ["produce", "self_review", "counter_review", "triage", "adjudicate"] as const;
export const GATE_POLICIES = ["never", "always", "on_trigger"] as const;
export const ITERATION_POLICIES = ["per_phase"] as const;

export interface RubricV1 { readonly schema_version: "1"; readonly kind: "artifact" | "implementation"; readonly mode: "self_review" | "adversarial"; readonly criteria: readonly { readonly id: string; readonly text: string; readonly blocking: boolean }[] }
export interface ConstitutionRuleV1 { readonly id: string; readonly version: number; readonly status: "active" | "deprecated"; readonly text: string; readonly review_trigger?: string; readonly enforced_by?: readonly string[] }
export type ConstitutionRegistry = ReadonlyMap<string, ConstitutionRuleV1>;
export function parseSingleYamlDocument(source: string, label: string): unknown;
export function validateConstitutionEvolution(previous: ConstitutionRegistry, candidate: readonly ConstitutionRuleV1[]): ConstitutionRegistry;
```

Boundary parsers accept `unknown`; only validated codecs mint phase brands. A phase number is a positive safe canonical base-10 integer without signs, leading zeros, decimals, exponents, separators, path syntax, percent escapes, or Unicode digit aliases. Explore is validated in the graph but cannot enter `PhaseInstance`. Config may select role/phase/model/effort only; canonical model family is later derived from trusted adapter metadata. Constitution candidates retain every prior ID, cannot reactivate deprecated rules, and require a version increase for any permitted content/status change.

## Work Breakdown

1. **Record design lineage**: Add and verify the banner before package files, preserve all source-design body bytes below it, resolve both normative links, and record the sequence in the implementation log.
2. **Establish package, license, and CI policy**: Recheck pin currency/licenses, create the private exact package/lock and TypeScript/esbuild/Vitest/Vite configuration, enforce the nine-package direct allowlist and complete permissive-only lock notices, and run exact Node floor/current-patch CI.
3. **Build validation and canonical syntax foundations**: Implement recursive plain-JSON validation, strict non-mutating Ajv2020 plus formats, explicit Zod agreement helpers, safe single-document YAML parsing, schema IDs, fixed vocabulary, and the opaque phase codec with compile-time/runtime proofs.
4. **Publish foundational repository contracts and assets**: Author and validate the exact workflow, model/effort config, artifact/implementation rubric, constitution frontmatter/templates, cross-file uniqueness, and append-only versioned constitution evolution against the prior pinned snapshot.
5. **Close foundational verification**: Run clean install, typecheck, temporary bundle, Node matrix, schema/agreement/mutation corpora, YAML/location cases, phase aliases, asset goldens, dependency allowlist, and full lock license/NOTICE checks; confirm all Phase-2/3 surfaces remain absent.

## Success Criteria

- [x] The source design receives only a resolving lineage/supersession banner above an otherwise byte-preserved originating body, and the implementation log records that it was first.
- [x] Clean exact-lock install, `tsc --noEmit`, foundational tests, and temporary Node-24 ESM bundle pass on exact Node `24.15.0` and `24.18.0`; the current Node `24.11.1` shell is not acceptance evidence.
- [x] All nine direct pins are exact and current at implementation time. Direct `vite@7.3.6` constrains Vitest's graph; the lock excludes `lightningcss`, copyleft, missing/unreviewed licenses, later-phase dependencies, and stale notices.
- [x] Plain-JSON preflight and strict non-mutating Ajv/Zod agreement reject non-plain/inherited objects, cycles/non-JSON values, dangerous keys, unknown properties, invalid formats, and contradictory validator acceptance.
- [x] Workflow/config share the safe one-document YAML path. Exact graph topology, role/phase/model/effort config, rubric kind/mode, constitution frontmatter, cross-file rule uniqueness, and append-only rule evolution pass; malformed/unknown/duplicate/reused/reactivated/unversioned cases fail with located diagnostics.
- [x] Only codecs/validators mint positive-safe phase numbers and canonical phase IDs; compile-time assertions and runtime aliases reject invalid forms, and Explore remains graph-only pre-task vocabulary.
- [x] No review/triage/adjudication schema or renderer, error/gate/tool contract, MCP dependency/server/fixture, tracked bundle, durable state/artifact schema, persistence, dispatch, or installer work enters Phase 1.

## Verification Steps

1. Compare the source-design body below its banner byte-for-byte with the prior version and resolve the PRD/architecture links.
2. Record live official currency/license evidence for all nine direct pins. From the exact lock, assert direct `vite@7.3.6`, no `lightningcss`, no copyleft, complete license/NOTICE files, no ranges, and no unapproved dependency.
3. On exact Node `v24.15.0` and `v24.18.0`, independently run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:contracts`, `npm run check:dependencies`, `npm run check:notices`, and the temporary build; ensure temporary output is ignored and no `dist/` artifact is created.
4. Run plain-JSON/Ajv/Zod/YAML corpora for prototypes, inherited values, dangerous keys, cycles, non-finite/unsupported values, formats, unknown keys, duplicate/multiple YAML documents, aliases/tags, and Unicode source locations.
5. Run graph/config/rubric/constitution fixtures and old-to-new constitution evolution cases for append, versioned edit/deprecate, deletion, renumber/reuse, reactivation, and missing/non-incremented versions. Run compile-time brand assertions and runtime phase aliases, then use scoped status/diff checks to prove every Phase-2/3 and excluded surface remains untouched.

---
*Designed: 2026-07-26*
