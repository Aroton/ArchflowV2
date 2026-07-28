# Phase 5: Offline Bundle and Release Integrity

**Status**: COMPLETE
**Implemented**: 2026-07-28
**Task**: mcp-integration
**Goal**: Produce a license-complete deterministic tracked offline payload and prove hostile clean-copy startup.
**Requirements**: REQ-04, REQ-05, REQ-11, REQ-27, REQ-28, REQ-33

## Context

Phase 4 completed the inert stdio runtime behind a thin `src/main.ts`, with SDK ownership isolated under `src/mcp/`, byte-exact live protocol fixtures, unique-OS-temporary smoke builds, exact package/lock policy, and two-patch Node CI. Its temporary builder deliberately emits no tracked release output, and the repository currently has no `dist/`. The context snapshots predate Phases 3 and 4, so the current runtime, Phase 4 design, and implementation log are authoritative here.

**Implementation-start dependency gate:** a live advisory sweep must cover every component embedded in the candidate bundle, not only direct packages. The current `@modelcontextprotocol/server@2.0.0` artifact embeds `fast-uri@3.1.0`, which is affected by four current high-severity advisories: `GHSA-q3j6-qgpj-74h6` (fixed in `3.1.1`), `GHSA-v39h-62p7-jpjc` (fixed in `3.1.2`), `GHSA-4c8g-83qw-93j6` (fixed in `3.1.3`), and `GHSA-v2hh-gcrm-f6hx` (fixed in `3.1.4`). There is no workaround; the safe 3.x floor is `3.1.4`. As of the 2026-07-27 design review, the current MCP server still embeds `3.1.0` and no compatible patched server artifact is available. Before implementation or any tracked-payload mutation, live official sources must confirm the complete advisory snapshot and artifact availability. Prefer a compatible patched artifact followed by design and compatibility review. Otherwise implementation stops unless the user separately accepts a documented prototype-only risk decision that names all current advisories and the focused inert-runtime reachability result. Design approval is not risk acceptance.

This phase packages only the existing inert runtime. It adds no persistence, dispatch, durable gate/state/artifact schema, local helper, installer, runtime dependency, model-result validation, or production handler authority. REQ-11 and REQ-33 remain in the requirement list because the normative architecture assigns them to Phase 5, but this phase supplies release-evidence plumbing only and claims zero behavioral completion for either; later phases retain behavioral ownership.

## What We're Building

Add a separate release build that uses esbuild with `write: false` and a fully explicit Node 24 ESM profile to produce one tracked `dist/archflow-mcp.mjs`. The profile has a stable repository-relative logical output, the existing `createRequire` banner, no splitting, plugins, minification, or release source map, and explicit legal-comment handling. Generated JSON recursively sorts object keys, preserves source-defined semantic array order, sorts set-derived arrays by ordinal repository-relative path/key, uses UTF-8/LF, and ends with one newline. The final output may statically import only `node:process`, `node:buffer`, `node:util`, and `node:crypto`, plus the banner's `node:module`; all other built-in and external imports and dynamic built-in loading fail validation.

Track two strict structural contracts: a release manifest and a release legal-review receipt. One semantic validator correlates their collection algebra, references, digests, canonical bytes, provenance, and recursive payload closure. The manifest records every scanned physical bundle input, every dependency provenance input actually consulted, a closed proof-input set, and the exact generated artifact set. Legal review conservatively inventories recognized third-party roots from contributing prebundles and adjacent source maps without claiming exact embedded physical-byte attribution or constructing composed source-map ranges.

An explicit tracked writer never promotes a stage on its own authority. It validates the candidate, independently materializes a new source root, runs `npm ci`, verifies installed dependency bytes and provenance, rebuilds into a separate stage, byte-compares both closed payloads, and only then replaces the fixed repository `dist/` target. The read-only checker can validate one payload and optionally compare two already-materialized payloads.

## Interfaces and Command Contract

These types and signatures are the shared seams for separately implemented chunks; their algorithms remain implementation choices:

```ts
type Sha256 = string; // validated lowercase 64-character hexadecimal digest

type CanonicalDocument<T> = Readonly<{
  bytes: Uint8Array;
  value: Readonly<T>;
  digest: Sha256;
}>;

type ReleaseFile = Readonly<{
  path: string;
  size: number;
  digest: Sha256;
}>;

type ReleasePayloadSummary = Readonly<{
  payloadRoot: string;
  files: readonly ReleaseFile[];
  bundleDigest: Sha256;
  dependencyInventoryDigest: Sha256;
  manifest: CanonicalDocument<ReleaseManifestV1>;
  legalReview: CanonicalDocument<ReleaseLegalReviewV1>;
}>;

type CurrentRiskDecisionBinding = Readonly<{
  dependencyInventoryDigest: Sha256;
  advisorySnapshotDigest: Sha256;
  reachabilityEvidenceDigest: Sha256;
}>;

type ValidatedReleaseStage = Readonly<{
  stageRoot: string;
  summary: ReleasePayloadSummary;
}>;

type ReproductionProof = Readonly<{
  candidate: ReleasePayloadSummary;
  reproduced: ReleasePayloadSummary;
  comparedFiles: readonly string[];
  proofInputsDigest: Sha256;
  launchProfileDigest: Sha256;
}>;

buildReleasePayload(options: {
  repositoryRoot: string;
  stageRoot: string;
}): Promise<ReleasePayloadSummary>;

validateReleaseSemantics(options: {
  repositoryRoot: string;
  payloadRoot: string;
  manifest: CanonicalDocument<unknown>;
  legalReview: CanonicalDocument<unknown>;
}): Promise<ValidatedReleaseStage>;

materializeReleaseSourceRoot(options: {
  repositoryRoot: string;
  stage: ValidatedReleaseStage;
  materializationRoot: string;
}): Promise<void>;

reproduceReleasePayload(options: {
  repositoryRoot: string;
  stage: ValidatedReleaseStage;
  materializationRoot: string;
  comparisonRoot: string;
}): Promise<ReproductionProof>;

checkReleasePayload(options: {
  repositoryRoot: string;
  payloadRoot: string;
  comparisonRoot?: string;
}): Promise<ReleasePayloadSummary | ReproductionProof>;

writeTrackedReleasePayload(options: {
  repositoryRoot: string;
  candidateStageRoot: string;
}): Promise<ReproductionProof>;
```

The CLI forms are fixed as `npm run release:stage -- --output <empty-dir>`, `npm run release:check -- --payload <dir> [--compare <dir>]`, `npm run release:reproduce`, `npm run release:write -- --stage <dir>`, `npm run release:smoke -- --payload <dir>`, and `npm run release:mutations`. On success, each command writes one canonical JSON summary to stdout. Diagnostics go to stderr. Exit status is `0` for success, `1` for an operation or validation failure, and `2` for invalid usage. The non-promoting reproduction command independently stages, materializes, installs, rebuilds, and compares without touching `dist/`. The tracked-write command creates its own dedicated materialization and comparison roots and must complete the same independent reproduction path before touching `dist/`.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/contracts/schemas/v1/release-manifest.schema.json` | Define the closed/versioned manifest shape, input/artifact collections, build entries and roles, launch profile, and evidence bindings. |
| Create | `src/contracts/schemas/v1/release-legal-review.schema.json` | Define the closed/versioned legal receipt, current-component, gate-decision, amendment, and supersession shapes. |
| Modify | `src/contracts/versions.ts` | Register both stable release schema identifiers without changing unrelated contract authority. |
| Modify | `test/contracts/schema-registry.test.ts` | Compile and register both release schemas from their JSON Schema authorities. |
| Create | `test/contracts/release-contracts.test.ts` | Prove strict shape, canonical-document rules, collection algebra, legal correlation, and representative invalid records. |
| Create | `release/legal-review.json` | Store the canonical reviewed current component inventory, retained dependency gate decisions, amendments/supersessions, and exact provenance evidence; map byte-identically to `dist/legal/review.json`. |
| Create | `release/legal/upstream/**` | Retain exact applicable upstream license/notice source bytes and map each relative path byte-identically below `dist/legal/upstream/`, without creating a first-party license grant. |
| Create | `scripts/release-support.mjs` | Own the profile, path codec, canonical documents, hashes, sole semantic validator, materializer, provenance checks, and shared interfaces. |
| Create | `scripts/build-release.mjs` | Expose the external empty-stage build form and validate the complete in-memory payload before materialization. |
| Create | `scripts/write-tracked-release.mjs` | Independently materialize, install, verify, rebuild, compare, and only then replace the fixed tracked payload. |
| Create | `scripts/check-release.mjs` | Read-only validation of one payload and optional comparison of two validated payloads. |
| Create | `scripts/reproduce-release.mjs` | Exercise the fresh-`npm ci` materialization/rebuild proof without promoting tracked output. |
| Create | `scripts/test-release-integrity.mjs` | Mutation-test representative schema, graph, provenance, path, write, normalization, and proof-input failures. |
| Create | `scripts/smoke-release-bundle.mjs` | Run exact-payload and guarded hostile-copy protocol exercises through direct Node. |
| Create | `test/fixtures/release/hostile-runtime-guard.cjs` | Instrument the declared global runtime surfaces before bundle import and report violations on inherited fd 3. |
| Create | `test/integration/release-offline.test.ts` | Exercise tracked hostile-copy startup, path/root safety, proof binding, and independent-root byte reproduction. |
| Modify | `test/integration/mcp-stdio.test.ts` | Preserve temporary-build isolation while removing the obsolete no-tracked-`dist/` assertion. |
| Create | `dist/archflow-mcp.mjs`, `dist/metafile.json`, `dist/manifest.json` | Track the inert executable and its canonical graph and integrity evidence. |
| Create | `dist/legal/review.json`, `dist/legal/THIRD_PARTY_NOTICES.md`, `dist/legal/upstream/**` | Track the canonical reviewed receipt, sole generated human-readable legal projection, and byte-identical upstream legal sources; these are the exact `dist/legal/` closure. |
| Modify | `.gitattributes` | Force generated `dist/` text to LF while marking exact retained upstream legal source bytes `-text`. |
| Modify | `package.json` | Add the fixed stage/check/write/smoke/mutation commands and aggregate release verification without changing dependencies. |
| Modify | `.github/workflows/ci.yml` | Pin action identities, disable package-manager caching for reproduction, and compare true clean-checkout payloads on both Node patches. |

## Contract and Evidence Rules

- JSON Schema is the only structural authority: `release-manifest.schema.json` owns the closed/versioned manifest shapes, and `release-legal-review.schema.json` owns the closed/versioned legal receipt, current-component, gate-decision, amendment, and supersession shapes. `validateReleaseSemantics(...)` is the one semantic authority correlating the two canonical documents; there is no Zod mirror, TypeScript parser, or second shape model.
- `bundle_inputs` contains every scanned `metafile.inputs` physical path exactly once with repository/dependency origin, size, and digest. `contributing_inputs` is exactly the sorted subset of sole-output input keys whose `bytesInOutput > 0`; zero-byte and scanned-only inputs remain bound but do not support physical-presence claims. Repository-owned bundle records and `release_control_inputs` use portable repository-relative paths with whole-file size/digests. Bundle-owned repository paths remain bundle inputs and are never duplicated in controls.
- `release_control_inputs` is the closed union of every non-bundle repository file needed to reproduce or substantiate the release: `package.json`, `package-lock.json`, `.gitattributes`, `.github/workflows/ci.yml`; all release support/build/check/write/smoke/mutation scripts; `release/legal-review.json` and `release/legal/upstream/**`; both new release schemas, `src/contracts/versions.ts`, `test/contracts/schema-registry.test.ts`, and `test/contracts/release-contracts.test.ts`; all proof scripts/tests/fixtures; and every non-bundle declared schema/workflow/constitution asset. `proof_inputs` and declared-content collections are sorted reference subsets resolving to repository bundle/control records, never duplicate physical-input authorities. This closed repository-owned union is the exact preinstall materialization allowlist.
- Declared content coverage is all tracked `src/contracts/schemas/v1/*.schema.json`, including both new release schemas; `assets/workflow.yaml`; and exactly `assets/constitution/README.md`, `00-process.md`, `10-architecture.md`, `20-data.md`, and `30-product.md`. The current eight bundled schemas are `evidence-slots.schema.json`, `gate-contract.schema.json`, `gate-decision.schema.json`, `mcp-tools.schema.json`, `path-claim.schema.json`, `primitives.schema.json`, `project-error.schema.json`, and `rubric.schema.json`; every other tracked schema and declared asset is a release control unless the actual metafile makes it a bundle input. No path may appear in both.
- `dependency_provenance_inputs` uses a separate installed-package namespace. Every record binds exact package name, exact package version, package-relative forward-slash path, size, and digest for each adjacent source map, package manifest, license/notice file, and other installed dependency file actually consulted. Records resolve only beneath that exact package's post-`npm ci` installed root; repository-relative paths and retained repository evidence never enter this collection. `package-lock.json` is the repository control for registry/tarball identity. Every installed record is re-read and verified before legal derivation, rebuild, or byte comparison; omission, substitution, package-root escape, or stale bytes fail.
- For every dependency-owned contributing prebundle, discover and bind its adjacent source map when present and record whether that map is expected. Conservatively inventory every recognized mapped third-party component/root, distinguish an embedded version from an installed same-name version, fail unknown mapped roots and missing expected maps, and retain the empty-Ajv-JSON/source-content limitation. The known current embedded closure is `ajv@8.18.0`, `ajv-formats@3.0.1`, `fast-uri@3.1.0`, `fast-deep-equal@3.1.3`, `json-schema-traverse@1.0.0`, and `content-type@1.0.5`. This evidence does not claim exact physical-byte attribution to an embedded component and does not compose source-map ranges.
- `proof_inputs` is the exact sorted reference set for `scripts/smoke-release-bundle.mjs`, `scripts/test-release-integrity.mjs`, `test/fixtures/release/hostile-runtime-guard.cjs`, `test/integration/release-offline.test.ts`, `test/integration/mcp-stdio.test.ts`, `test/fixtures/mcp/runtime/initialize.json`, `calls.json`, and `adversarial-bytes.json`, plus `package.json` command wiring and `.github/workflows/ci.yml`. Those files are repository bundle/control records with one physical owner; omission, substitution, or staleness invalidates the proof.
- Build entries and executable roles are closed and sorted. Phase 5 permits exactly one `mcp-stdio` entry/output with handler authority `inert-no-handler`; schema v1 reserves the planned `local-cli` role for Phase 12 without building it or introducing a plugin framework.
- Each current vulnerability disposition binds the exact bundle digest, entry/role set, `inert-no-handler` authority, `dependency_inventory_digest`, complete live advisory-snapshot digest, focused reachability-evidence digest, and prototype-only scope. Semantic validation recomputes `dependency_inventory_digest` over canonical dependency-origin `bundle_inputs`, `dependency_provenance_inputs`, and `current_components`. Advisory snapshots and reachability evidence are canonical records referenced by digest. Any bundle, dependency inventory, handler-authority, or entry change invalidates the decision. Phase 12 must rerun the advisory sweep and reachability decision before adding its handler or entry.
- Gate decisions have stable IDs and canonical lowercase 64-character digests. The sole carry-forward baseline is `HEAD:release/legal-review.json`: when present, every accepted decision in it remains byte-identical in the candidate; when it and all prior release legal artifacts are absent, the initial baseline is empty. A missing or inconsistent HEAD source/output pair—including `HEAD:dist/legal/review.json` not matching the canonical source bytes or missing/mismatched upstream counterparts—fails closed. Corrections append typed amendment/supersession records rather than mutating retained decisions. This is one narrow HEAD comparison for retained audit records, not a history subsystem.
- Canonical `release/legal-review.json` maps byte-identically to `dist/legal/review.json`. Each `release/legal/upstream/<relative>` maps byte-identically to `dist/legal/upstream/<relative>`. `dist/legal/THIRD_PARTY_NOTICES.md` is the only generated human projection; these paths are the exact `dist/legal/` closure.
- The inventory explicitly records that this repository currently has no project license and therefore has unresolved public-distribution status. It makes no first-party license grant and no unsupported documentation-license or copyleft determination.

## Filesystem, Runtime, and CI Boundaries

- One portable repository-relative path codec emits forward slashes and rejects absolute paths, drive-qualified paths, UNC paths, backslashes, empty paths or segments, and `.`/`..` segments. All input/output roots are canonicalized and proven non-overlapping by realpath. Filesystem roots, symlinks at any traversed component, and non-regular files fail through `lstat` checks.
- Stage, materialization, and comparison roots are new, empty, dedicated roots. The tracked target is fixed to the real repository `dist/`; the writer uses safe exact traversal of the validated generated closure and cannot redirect it. Mutation coverage includes symlink ancestors and pre-existing external targets.
- Hostile smoke children use a cwd inside the copied payload and launch only `process.execPath` with explicit arguments and a minimal explicit environment. The launcher removes `NODE_OPTIONS`, `NODE_PATH`, preload/loader variables, package-manager variables, and inherited environment not on the allowlist; supplies controlled empty or unusable HOME, XDG, npm-cache, and temp locations; and places repository/module canaries that must remain unread/unresolved. The manifest binds this launch profile, executable/argv/env keys, cwd class, stdio/fd mapping, guard identity, canary identities, and transcript/fixture digests.
- Before bundle import, the guarded run patches Node-core connection/listener surfaces in `net`, `tls`, `dgram`, `http`, `https`, and `http2`, plus `globalThis.fetch`, `WebSocket`, and `EventSource`, and reports attempted use on inherited fd 3. Negative fixtures exercise DNS and WebSocket attempts. Together, the fixed five-builtin allowlist, rejection of dynamic built-in loading, pre-import Node-core/global guards, empty fd-3 oracle, and exact transcript behaviorally prove that the exercised hostile startup/protocol run opens no network connection or listener, satisfying the architecture's Node-core behavioral proof. This is not a claim of general OS capability isolation.
- `.gitattributes` treats canonical generated `.mjs`, JSON, and generated notice text below `dist/` as LF. Later, more-specific `release/legal/upstream/** -text` and `dist/legal/upstream/** -text` rules preserve exact upstream retained source bytes without disabling normalization for generated legal JSON. Verification checks clean-checkout normalization and mutates attributes/line endings to prove drift is detected.
- CI pins `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` and `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0` after runner-compatibility review. Package-manager caching is disabled for the independent-install proof. The manifest binds workflow and action identities, while byte reproducibility is explicitly scoped to the payload and not the mutable hosted-runner executor.

## Work Breakdown

1. **Complete dependency safety gate**: Immediately before implementation, sweep live official advisories for every direct and embedded candidate component, confirm all four `fast-uri@3.1.0` advisories, the `3.1.4` safe 3.x floor, exact embedded path, and compatible patched-artifact availability. Prefer a patched artifact and return for design/compatibility review; otherwise stop for a separate risk decision that binds all required evidence.
2. **Release contracts and shared seams**: Add and register the strict manifest and legal-review JSON Schemas, canonical-document types, exact shared signatures, and fixed CLI/output/exit contract. Implement only one cross-document semantic validator and test representative structural and relationship failures.
3. **Portable paths and root safety**: Centralize the forward-slash path codec, canonical non-overlap rules, `lstat` traversal, empty dedicated-root preconditions, and fixed real-repository `dist/` target. Cover symlink ancestors, non-regular files, filesystem roots, pre-existing external targets, and overlapping roots.
4. **Deterministic staged builder and declared coverage**: Build only `src/main.ts` under the fixed Node-24 ESM profile, bind all scanned/contributing inputs and the exact closed repository-control/materialization union, and reject imports outside the five allowed `node:` specifiers or dynamic built-in loading. Keep proof and declared-content collections as references to their sole repository owners and validate the in-memory payload before writing the external stage.
5. **Provenance and exact legal mapping**: Populate package-scoped dependency-provenance records, bind adjacent source maps and the known embedded closure, distinguish installed from embedded versions, and fail unknown roots or missing maps. Map canonical review and upstream sources exactly into the fixed `dist/legal/` closure, generate only `THIRD_PARTY_NOTICES.md`, and avoid source-map range composition, exact physical-byte attribution claims, or a first-party license grant.
6. **Independent reproduction and tracked writer**: Materialize only the validated repository-owned allowlist into a fresh root, require no `node_modules`, run `npm ci`, verify every installed dependency/provenance input, rebuild to a distinct comparison root, and byte-compare closed payloads. Make `writeTrackedReleasePayload` execute this path itself before replacing only the fixed `dist/` closure; keep ordinary check read-only.
7. **HEAD baseline, decisions, and proof binding**: Bind the closed proof-input references and stable vulnerability decision IDs/digests, including the recomputed dependency-inventory digest. Compare only the consistent HEAD legal source/output baseline, enforce byte-identical accepted-decision retention, use amendments/supersessions for corrections, and preserve the Phase 12 rerun requirement.
8. **Hostile clean-copy proof**: Run the exact copied payload uninstrumented and then with pre-import Node-core/global guards, direct `process.execPath`, child cwd, minimal scrubbed environment, unusable ambient roots, repository/module canaries, bound launch profile, fd-3 oracle, and exact transcript. Exercise DNS/WebSocket negatives and prove the exercised run opens no network connection or listener without claiming OS sandboxing.
9. **Tracked-byte and CI normalization proof**: Add `.gitattributes` ordering for canonical LF generated text and byte-exact legal sources, verify clean-checkout and mutation behavior, pin the two action SHAs after compatibility review, disable install caching, and reproduce under exact Node `24.15.0` and `24.18.0` clean checkouts.
10. **Commands and aggregate verification**: Wire the fixed stage/check/write/smoke/mutation commands, schema tests, release integration test, existing stdio integration, temporary-build isolation, and aggregate local/CI checks. Add no dependency, SBOM/signing/publishing system, installer, helper, OS sandbox, or runtime subsystem.

## Success Criteria

- [ ] Before implementation or tracked output mutation, a live complete advisory sweep confirms the current embedded closure and resolves all four `fast-uri@3.1.0` advisories through a compatible patched artifact and reviewed design revision, or implementation stops pending separate explicit prototype-risk acceptance naming the full snapshot and inert reachability result.
- [ ] Both release documents validate against their sole strict JSON Schema shape authorities and the sole semantic correlation authority; canonical bytes/digests, all closed collections, exact schema/asset ownership, recursive artifacts, and representative zero-byte/scanned-only cases reject unknown, overlapping, unresolved, stale, partial, or extra data.
- [ ] The release build produces exactly one `mcp-stdio` Node-24 ESM executable with `inert-no-handler`, no release source map, no local helper, no dynamic built-in loading, and only `node:process`, `node:buffer`, `node:util`, `node:crypto`, and banner `node:module` imports.
- [ ] The repository-control union is complete, whole-file digest-bound, and the exact preinstall materialization authority; bundle paths have one owner, while declared content and proof inputs are reference subsets. Dependency provenance uses exact package/version/package-relative records resolved and reverified only inside the post-`npm ci` package root.
- [ ] Every dependency provenance input actually consulted is reverified after independent `npm ci`; adjacent maps and the known embedded closure are conservatively inventoried with unknown/missing roots rejected, installed and embedded versions distinguished, and no unsupported exact-byte/source-map attribution claim.
- [ ] The exact proof-input set and launch profile are digest-bound. Each current risk decision carries the recomputed canonical dependency-inventory digest plus canonical advisory-snapshot and reachability-evidence references; omission, substitution, staleness, bundle/dependency/handler/entry changes, or Phase 12 expansion invalidates it.
- [ ] `writeTrackedReleasePayload` independently materializes, installs, verifies dependency and legal provenance, rebuilds, and byte-compares before replacing fixed real-repository `dist/`; a validated candidate stage cannot authenticate itself, while read-only check may compare two payloads without mutation.
- [ ] The sole consistent HEAD legal baseline governs carry-forward: prior accepted decisions remain byte-identical, corrections use amendment/supersession records, source review/upstream bytes map exactly to the fixed `dist/legal/` closure, and the sole generated projection is `THIRD_PARTY_NOTICES.md`. The inventory records the missing project license, unresolved distribution status, and empty-Ajv-JSON limitation.
- [ ] Path/root validation rejects non-portable paths, roots, overlaps, symlinks, non-regular files, pre-existing external targets, and unsafe traversal; all intermediate roots are new, empty, dedicated, and outside each other and the repository.
- [ ] Exact-payload and guarded hostile-copy runs use direct Node, a copied-payload cwd, scrubbed minimal environment, controlled ambient roots, canaries, the fixed import policy, pre-import Node-core/global guards, empty fd 3, and exact transcript to prove behaviorally that the exercised run opens no network connection or listener; no general OS-isolation claim is made.
- [ ] Clean-checkout normalization preserves canonical LF generated text and exact upstream legal bytes; true clean CI checkouts with pinned action SHAs, disabled install caching, and both exact Node patches reproduce a byte-identical payload, while the runner itself is outside the byte-reproducibility claim.
- [ ] Release contracts, mutations, reproduction, hostile-copy, Phase 4 compatibility/runtime, temporary-build, full aggregate, and CI checks pass with no dependency or behavior beyond inert packaging; REQ-11/REQ-33 behavioral completion remains unclaimed.

## Verification Steps

1. Before implementation mutation, use live official advisory, registry, SDK-release, and source evidence to enumerate the full current embedded closure and all four `fast-uri@3.1.0` advisories, verify the `3.1.4` safe 3.x floor and lack/presence of a compatible patched server, and either return for a patch design revision or obtain a separate fully bound prototype-risk decision.
2. Compile both strict schemas and exercise the sole semantic validator against unknown shape, overlaps, duplicate ownership, incomplete repository controls, broken proof/content references, package-root provenance escape, stale canonical bytes/digests, scanned/contributing mismatch, zero-byte inputs, artifact self-reference, and recursive extra/missing files. Confirm no second shape model exists.
3. Stage twice into new empty non-overlapping roots. Inspect the manifest for the sole `mcp-stdio` entry, exact eight current bundled schemas, complete repository-control/materialization union and declared-content references, every scanned input, the exact `bytesInOutput > 0` subset, five allowed imports, no dynamic loader, and no source map or `local-cli` output.
4. Verify exact package/version/package-relative dependency records only below fresh post-`npm ci` package roots, the six embedded versions, installed/embedded distinctions, map/root failures, retained bytes, and the empty-Ajv-JSON limitation without composed-range or exact embedded-byte claims.
5. Verify exact review/upstream source mappings, the fixed `dist/legal/` closure, and sole generated notice. Test empty and consistent HEAD baselines, missing/mismatched HEAD counterparts, decision retention/amendment, and recomputation of `dependency_inventory_digest` from its three canonical collections.
6. Prove tracked writing independently materializes, installs, verifies, rebuilds, and compares before fixed `dist/`; mutate candidate, proof reference, dependency record, symlink/target/path/root, and comparison output to confirm fail-closed behavior.
7. Run both hostile modes through direct Node and verify the fixed import policy, dynamic-load rejection, pre-import Node-core/global guards, DNS/WebSocket negatives, empty fd 3, exact transcript, and clean shutdown behaviorally prove the exercised run opens no connection or listener.
8. Check `.gitattributes` normalization and clean-checkout reproduction on both pinned Node/action versions with caching disabled.
9. Run the fixed CLI forms and full aggregate, asserting canonical stdout, stderr diagnostics, exit codes, release/runtime tests, mutations, reproduction, hostile-copy, temporary builds, dependency/notices, and CI-equivalent checks.

---
*Designed: 2026-07-27*
