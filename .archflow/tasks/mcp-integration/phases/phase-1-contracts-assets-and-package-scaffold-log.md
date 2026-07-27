## Implementation Log: Phase 1 - Contracts, Assets, and Package Scaffold

### Decisions Made

- Added the design-lineage banner to `docs/mcp-integration-design.md` before creating implementation files. The complete originating body below the banner remains byte-identical to its pre-implementation version.
- Kept JSON Schema 2020-12 normative and used strict, non-mutating Ajv2020 with `ajv-formats`; exported Zod boundary parsers all run the recursive plain-JSON preflight first.
- Kept the approved array-shaped rubric contract and represented its semantic criterion-ID uniqueness rule with the namespaced `x-archflow-unique-by` keyword, registered centrally by `createJsonSchemaValidator` and agreement-tested against Zod.
- Pinned the exact nine direct packages and retained Vite `7.3.6` to keep the Vitest graph on the reviewed permissive-only Vite 7 line.
- Retained the identical TypeScript 7.0.2 standalone notice once at `notices/typescript-7.0.2-NOTICE.txt`, with source and retained digests mapped to all 21 locked TypeScript packages.

### Deviations from Plan

- Added `scripts/build-temp.mjs` and `scripts/smoke-temp-bundle.mjs` instead of relying on an esbuild-only package command. The behavioral smoke is necessary to prove the temporary ESM bundle loads and exercises YAML, Ajv/formats, rejection, and phase-codec behavior under each exact Node version.
- Added `scripts/test-notices-policy.mjs` and the tracked `notices/` asset after implementation counter-review found that an SPDX table alone did not retain mandatory standalone notice content. Mutation cases now reject changed, missing, and newly unmapped notice files.
- Added the `x-archflow-unique-by` semantic schema keyword after counter-review exposed that standard `uniqueItems` compares whole criterion objects rather than criterion IDs.
- No PRD requirement changed, and no Phase 2 or Phase 3 implementation surface entered Phase 1.

### Patterns Established

- Every public parser accepting `unknown` performs `assertPlainJson` before schema parsing so prototypes, accessors, dangerous keys, cycles, and non-JSON values fail before validator inspection.
- JSON Schema/Zod overlap is tested with positive, negative, disagreement, and non-mutation cases; schema-specific semantic constraints are explicitly namespaced and registered in the central Ajv factory.
- Dependency updates regenerate the exact lock deliberately, rerun lock-wide license policy, update retained notices and digests, and execute notice mutation tests.
- Generated verification bundles live only below ignored `.tmp/`; the release `dist/` path remains absent and unignored for Phase 2's tracked artifact.

### Gotchas

- Esbuild can emit an ESM file that still contains CommonJS dynamic-require paths. The temporary bundle injects `createRequire` compatibility and must be behaviorally exercised, not merely produced.
- npm lock metadata is enough for the SPDX inventory but not for package-distributed standalone notices. Those require retained content, exact package mappings, and source/retained digest verification.
- Canonical iterated identities use `phase-design-<n>` and `phase-impl-<n>`; colon forms and all non-canonical numeric aliases are invalid.
- TypeScript's project includes `src`, `test`, and root configuration, so the explicit CLI-only `rootDir` is `.`.

### Key Interfaces

- `src/contracts/versions.ts`: `SCHEMA_IDS` and `SCHEMA_VERSION` define the six foundational v1 schema identities.
- `src/contracts/plain-json.ts`: `assertPlainJson(value: unknown, label?: string): asserts value is PlainJsonValue` is the required first boundary check.
- `src/contracts/validators.ts`: `createJsonSchemaValidator<T>(schema, referencedSchemas?)`, `assertValidJsonSchema<T>(validator, value, label?)`, and `assertZodAgreement<T>(value, jsonValidator, zodSchema, label?)` own strict Ajv and overlap validation.
- `src/contracts/phase-instance.ts`: `parsePositiveSafePhaseNumber(value)`, `encodePhaseInstance(value)`, and `decodePhaseInstance(value)` mint and parse only `prd`, `design`, `phase-design-<n>`, and `phase-impl-<n>` identities.
- `src/contracts/yaml.ts`: `parseSingleYamlDocument(source: string, label: string): unknown` is the sole safe YAML 1.2 entry point.
- `src/contracts/workflow.ts`, `config.ts`, `rubric.ts`, and `constitution.ts` expose the foundational repository parsers; `validateConstitutionEvolution(previous, candidate)` enforces append-only stable rule IDs and positive versions.
- `scripts/check-dependency-policy.mjs`, `check-notices.mjs`, and `test-notices-policy.mjs` enforce the exact dependency/license/notice contract used by CI.
