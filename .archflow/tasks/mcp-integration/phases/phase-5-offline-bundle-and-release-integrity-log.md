## Implementation Log: Phase 5 - Offline Bundle and Release Integrity

**Implemented**: 2026-07-28
**Status**: COMPLETE

### Decisions Made

- Kept the release executable limited to the existing inert `mcp-stdio` entry with `inert-no-handler`; no local helper, persistence, dispatch, or production handler authority was introduced.
- Recorded the user's explicit local-only, non-production risk acceptance for embedded `fast-uri@3.1.0` in canonical evidence bound to all four current high-severity advisories, patched-artifact availability, and focused inert-runtime reachability. Bundle, dependency, entry, or handler-authority changes invalidate the decision.
- Used strict JSON Schema as the structural authority and one release semantic validator for manifest/legal collection algebra, physical metafile inputs, dependency provenance, component/license closure, launch profile, evidence references, and generated payload closure.
- Added a non-promoting `release:reproduce` command so the aggregate and CI exercise fresh source materialization, `npm ci`, installed-byte verification, rebuild, and byte comparison without mutating tracked output.
- Made tracked `dist/` replacement recoverable through deterministic promotion/backup paths and a canonical transaction marker checked by every release operation.

### Deviations from Plan

- Added `scripts/reproduce-release.mjs` and `npm run release:reproduce`. The original command list exposed reproduction only inside the writer; counter-review showed that aggregate and CI verification otherwise could pass without exercising the fresh-install path.
- Added four canonical files below `release/evidence/` rather than retaining risk-evidence digests without resolvable records. This makes the accepted prototype exception durable and independently verifiable.
- Strengthened the planned tracked replacement with deterministic crash recovery and fault probes after counter-review identified a rename interruption window.
- Expanded hostile smoke from initialization-only coverage to initialization, every call fixture, and all adversarial byte sequences in exact and guarded modes.

### Patterns Established

- Release evidence references resolve to canonical tracked records and are recomputed; digest-shaped strings alone never establish authority.
- Repository, candidate, materialization, and comparison roots are canonicalized and checked pairwise before work; validated candidates are rechecked before proof issuance.
- Generated release projections are checked against their sources: legal review and upstream licenses map byte-identically, while the notice is regenerated from the canonical receipt.
- Residual executable loader syntax is checked independently of esbuild's static metafile so computed built-in loading cannot bypass the import allowlist.

### Gotchas

- `npm audit` cannot see `fast-uri@3.1.0` embedded inside the MCP server prebundle; the live advisory sweep and source-map inventory are separate release evidence.
- TypeScript `7.0.2` exposes its scanner through the unstable AST surface rather than the former root parser API. The narrow emitted-loader scanner enforces forward progress and has nested-template regressions.
- The ambient developer Node was below the project floor, so final aggregate verification explicitly invoked exact Node `24.15.0` and `24.18.0` binaries.
- Retained upstream legal bytes may intentionally omit a final newline; `.gitattributes` marks those paths `-text` while generated release text is canonical LF.

### Key Interfaces

- `scripts/release-support.mjs`: `buildReleasePayload(options)`, `validateReleaseSemantics(options)`, `materializeReleaseSourceRoot(options)`, `reproduceReleasePayload(options)`, `checkReleasePayload(options)`, `writeTrackedReleasePayload(options)`, `recoverTrackedRelease(repositoryRoot)`, and `assertReleaseLoaderPolicy(source)`.
- `scripts/reproduce-release.mjs`: non-promoting fresh-install reproduction CLI used by `check:release` and CI.
- `src/contracts/schemas/v1/release-manifest.schema.json`: sole structural authority for manifest, provenance, adjacent-map, launch-profile, and artifact records.
- `src/contracts/schemas/v1/release-legal-review.schema.json`: sole structural authority for component, legal-source, risk-decision, amendment, and supersession records.
- `release/legal-review.json` and `release/evidence/*.json`: canonical legal/risk source records mapped and referenced by the generated payload.
- `dist/manifest.json`: tracked payload authority; bundle digest `16faf6365bc502ec0c0e00f150b43c300e65dfa9dcace1cce3d98d850b8cbbd0`, dependency-inventory digest `1f93c687b91691f3afb99d657246504a9b369311333ecd4e8c77abab1a23c046`.

### Verification

- Full aggregate passed under exact Node `24.15.0` and `24.18.0`.
- 292 full tests, 55 release/contract tests, and 86 focused MCP runtime tests passed.
- Fresh-`npm ci` reproduction compared 14 payload files byte-for-byte.
- Exact and guarded hostile copies exercised initialization, calls, malformed JSON, partial JSON, and invalid UTF-8 with byte-equal transcripts and zero network-oracle bytes.
- Seventeen release-integrity mutations covered schema, graph, provenance, root/path, map expectation, launch profile, legal mapping, loader policy, nested roots, and transaction recovery.

### Durable Convention Proposal

No new project-wide `CLAUDE.md` convention is proposed. The canonical release-evidence, embedded-advisory, and transaction-recovery rules are specific to this MCP release task and are enforced by its scripts and tests.
