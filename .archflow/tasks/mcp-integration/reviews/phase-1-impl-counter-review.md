# Phase 1 Implementation Counter-Review

## Findings

1. **Major — The phase-instance codec uses a non-normative `:` encoding.**

   `src/contracts/phase-instance.ts` encodes and accepts `phase-design:42` and `phase-impl:42`, and the unit tests freeze those forms. The approved PRD (`REQ-02`, `VAL-16`) and architecture's Phase Instance contract require `phase-design-<n>` and `phase-impl-<n>`. If this ships, later review, decision, migration, and status paths built from the codec will not match the canonical repository layout.

   **Suggested resolution:** Change the codec and its alias corpus to emit and accept only `phase-design-<n>` / `phase-impl-<n>`, retaining the existing positive-safe canonical integer checks. Add direct tests against the parent-contract examples so the delimiter cannot drift again.

2. **Major — The advertised temporary ESM bundle is not runnable.**

   `npm run build:temp` exits successfully, but importing `.tmp/archflow-contracts.mjs` under Node 24 fails immediately with `Error: Dynamic require of "process" is not supported`, originating in the bundled `yaml` CommonJS code. CI only checks that esbuild produced a file, so it reports success without driving the artifact. This does not prove a working Node-24 ESM bundle as required by the phase verification boundary.

   **Suggested resolution:** Adjust the esbuild configuration so the generated ESM artifact can load its bundled dependencies correctly, then add a Node import/smoke invocation of the generated file to `build:temp` or CI. Keep the output temporary and continue asserting that no `dist/` artifact is produced.

3. **Major — Public Zod boundary parsers bypass the plain-JSON preflight.**

   `parseConfigV1`, `parseRubricV1`, and `parseConstitutionRuleV1` accept `unknown` but call Zod directly. Objects whose required values exist only on a custom prototype are accepted and normalized into apparently valid own-property objects; accessor getters are also executed during parsing. This violates the phase contract that boundary validation reject inherited/non-plain values and dangerous inspection behavior. The tests prove preflight only through `JsonSchemaValidator.assert`/`assertZodAgreement`, leaving the exported direct parsers unprotected.

   **Suggested resolution:** Run `assertPlainJson` before every exported `unknown` boundary parser (or expose one shared preflighted parsing seam and keep raw schemas internal). Add inherited-object, accessor, dangerous-key, and non-JSON cases to each exported parser's tests, not only to the generic validator tests.

4. **Major — The normative rubric JSON Schema and its Zod mirror disagree on duplicate criterion IDs.**

   `rubricV1Schema` rejects two criteria with the same `id` even when their other fields differ, but `rubric.schema.json` uses only `uniqueItems: true`, which rejects duplicate whole objects rather than duplicate IDs. The normative JSON Schema therefore accepts a rubric the Zod mirror rejects, contrary to the required agreement and fail-closed duplicate handling. The contract corpus tests only one-criterion rubrics and miss this contradiction.

   **Suggested resolution:** Represent or validate criterion identity in a way the normative contract can enforce consistently (for example, change the durable shape to an ID-keyed object, or add a clearly defined semantic validation layer used by both paths). Add the existing differing-body duplicate-ID case to the Ajv/Zod agreement corpus and require both validators to reject it for the same contract reason.

5. **Major — The notices check does not prove complete required notices.**

   `scripts/check-notices.mjs` only compares package/version/license table rows with lockfile metadata. It never inspects or retains required notice files or license text. The installed graph already contains `typescript/NOTICE.txt` and `@typescript/typescript-linux-x64/NOTICE.txt`, but their required contents are absent from `THIRD_PARTY_NOTICES.md`; the checker still reports completeness. This falls short of the design's complete license/NOTICE proof and could let future mandatory attribution text disappear silently.

   **Suggested resolution:** Define the retained notice/license artifact policy now, include the applicable notice contents (or tracked verbatim files) for packages that ship them, and make the checker inventory and verify those files/content in addition to SPDX lock metadata. Add a mutation test that removes or changes a required notice and proves the check fails.

6. **Minor — `tsconfig.json` omits the architecture's explicit `rootDir`.**

   The Phase 1 architecture success criteria require CLI-only TypeScript with an explicit `rootDir` and Node types. Node types are configured, but `rootDir` is absent, so TypeScript infers it from the mixed `src`, `test`, and config inputs.

   **Suggested resolution:** Add the intended explicit `rootDir` consistent with the chosen source/test layout, or revise the architecture criterion through the normal approval path if a single root is intentionally inappropriate.

## Triage

Triaged against the approved PRD, architecture, and Phase 1 design on 2026-07-27. All six findings identify valid contract or verification gaps.

| Finding | Disposition | Resolution |
|---------|-------------|------------|
| 1. Non-normative phase-instance delimiter | **Accepted and fixed** | The codec now emits and accepts only `phase-design-<n>` and `phase-impl-<n>`. Parent-contract examples, positive-safe bounds, legacy colon forms, aliases, path syntax, percent escapes, and Unicode digits are covered directly. |
| 2. Temporary ESM bundle is not proven runnable | **Accepted and fixed** | A plain import succeeded in the triage environment, but the bundle still contained a latent CommonJS dynamic-require path and the build did not drive exported behavior. The esbuild API build now supplies Node ESM `createRequire` compatibility, and `build:temp` imports the bundle and exercises YAML parsing, Ajv/formats validation, rejection behavior, and the phase API under the active Node version. CI runs this smoke in both exact Node jobs. |
| 3. Public Zod parsers bypass plain-JSON preflight | **Accepted and fixed** | Every exported foundational `unknown` parser now invokes `assertPlainJson` before Zod. Parser-specific tests prove inherited objects, accessors without getter execution, dangerous keys, and non-JSON values fail at the boundary. |
| 4. Duplicate rubric IDs differ between JSON Schema and Zod | **Accepted and fixed** | The normative rubric schema declares the namespaced `x-archflow-unique-by: id` semantic constraint, and strict Ajv registers the non-mutating keyword used to enforce it. The agreement corpus now proves differing-body duplicate IDs are rejected by both Ajv and Zod without mutation. |
| 5. Notices check proves only SPDX rows | **Accepted and fixed** | The complete TypeScript 7.0.2 standalone notice is retained once with exact source/retained digests and mapped to all 21 locked TypeScript packages, including optional platforms. The checker verifies lock-wide SPDX rows, retained content, installed source notices, and rejects any installed unmapped standalone notice; mutation tests prove changed, missing, and unexpected notice content fails. |
| 6. Missing explicit TypeScript `rootDir` | **Accepted and fixed** | `rootDir` is explicitly `.` so the CLI-only no-emit project consistently covers source, tests, and root configuration while retaining strict Node typings. |
