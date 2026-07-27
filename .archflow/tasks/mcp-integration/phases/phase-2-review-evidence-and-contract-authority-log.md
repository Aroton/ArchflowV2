## Implementation Log: Phase 2 - Review Evidence and Contract Authority

### Decisions Made

- Kept the Phase 2 boundary transport-neutral and dependency-neutral: no MCP SDK, server lifecycle, persistence, dispatch, state, artifact, package, lockfile, CI, or release surface was added.
- Made every trust-bearing runtime value identity-backed. Observation capabilities, verified evidence wrappers, authority links, qualified evidence, current review sets, validated triage, immutable contexts, parsed request identities, structural results, and result expectations are accepted only when minted by their private owner; schema-shaped objects, casts, and spread clones cannot acquire authority.
- Kept JSON Schema 2020-12 normative while registering narrowly scoped `x-archflow-*` keywords in the central strict Ajv factory for cross-field semantics JSON Schema cannot express natively. Zod/runtime and JSON Schema agreement tests cover each keyword without transforming input.
- Bound server-attested evidence to exact adapter/family, invocation, envelope, output, result, task, phase, subject, fingerprint, assurance, role, and optional gate identities. Gate-counter evidence cannot be reused across gates with otherwise identical scope.
- Split tool result handling into structural validation and authoritative correlation. `bindParsedToolCallRequest` attaches the canonical request digest to an authentic parsed call; `correlateProjectResult` then requires authentic request, expectation, and result identities and compares every invocation and success field.
- Used the shared `SafeId`, canonical lowercase SHA-256, lexical-only `TaskPathClaim`, and exact five-name `TOOL_NAMES` vocabulary across correlated contracts.
- Rendered review, triage, and adjudication Markdown only from authenticated qualified/validated values. Public bundle smoke proves forged values are rejected; positive rendering uses internal test-only authority fixtures.

### Deviations from Plan

- The counter-review found that enumerable symbol brands and structural-only consumers allowed forged authority. The implementation replaced those brands with private WeakMap/WeakSet identity registries and non-enumerable test-only mints, while preserving the planned public types and later-owner boundaries.
- Added central semantic schema keywords for review summaries, adjudication claims, gate decisions, supplemental outcomes, MCP correlations, result expectations, sorted unique arrays, and UTF-8 byte limits. These are required to make the approved cross-field contract genuinely normative and agreement-testable rather than leaving semantics only in Zod.
- Added `bindParsedToolCallRequest` and `RequestIdentifiedToolCall` to carry the canonical request digest into result correlation. This closes the approved same-tool/different-request rejection requirement that a parsed input alone could not satisfy.
- Expanded the planned adversarial verification into exhaustive table-driven coverage: all 15 decision effect annotations, 29 gate kind/decision pairs, 56 error definitions, and four supplemental outcomes are checked rather than sampled.
- No PRD requirement or remaining phase scope changed. `architecture.md` required only its Phase 2 progress update.

### Patterns Established

- Runtime brands protect authority only when the owner authenticates object identity at every consumer. TypeScript brands or enumerable symbols alone are never a trust boundary.
- Minted trust graphs are defensively copied and recursively frozen. Mutable byte sequences remain private and are returned only as copies so retained digests cannot outlive mutable content.
- Every public `unknown` parser still performs the recursive plain-JSON preflight; semantic evidence parsers compose the complete raw validator rather than reusing a structural `.shape` that drops refinements.
- Cross-field schema rules that JSON Schema 2020-12 cannot express use a narrowly named, centrally registered Ajv keyword with strict metadata plus positive, negative, agreement, and non-mutation tests.
- Schema/runtime registries are checked exhaustively when they are closed catalogues. Gate effects, error ownership/actions, supplemental variants, schema IDs, and tool names cannot rely on representative samples.
- Bundle smoke exercises public capability boundaries: it verifies internal mints are absent and that public consumers reject fabricated authority.

### Gotchas

- Object spread copies enumerable symbol properties, so a symbol-branded value is forgeable unless consumers also authenticate identity; non-enumerability alone is insufficient without an owner registry.
- `Uint8Array` cannot be made deeply immutable by `Object.freeze` in the same way as plain JSON. Observation bytes require private storage and copy-on-read.
- Standard JSON Schema cannot express derived review aggregates, subject-to-mechanical-evidence equality, canonical lexicographic array ordering, or most gate/tool cross-field correlations. Relaxing Ajv would hide these gaps; strict custom keywords keep one validation boundary.
- JSON object property order is not semantic authority. Error correlation uses structural equality and preserves the validated input rather than comparing `JSON.stringify` output.
- The available verification runtime is Node `24.11.1`, below the architecture's eventual `24.15.0` functional floor. Phase 2 typecheck, 183 tests, strict contract suites, and the temporary bundle all pass, but release/CI floor verification remains a later-phase responsibility.

### Key Interfaces

- `src/contracts/evidence.ts`: `parseSha256Digest`, `parseSafeId`, `parseSafeCode`, `parseSafeVersion`, `parseSafeInteger`, and `ReferencedEvidence<T>` own shared lexical identities.
- `src/contracts/review.ts` and `adjudication.ts`: `parseAndDeriveReview`, `parseReviewEvidence`, `parseReferencedReviewEvidence`, `parseAndDeriveAdjudication`, `parseAdjudicationEvidence`, and `parseReferencedAdjudicationEvidence` own complete semantic parsing.
- `src/contracts/trust.ts`: `observationSource`, `parseAuthorityLinkData`, `parseCurrentEvidenceSetRef`, `parseReferencedEvidence`, `authorityQualifier`, and the qualified/current-set types define the future dispatch, repository, and state authority seams.
- `src/contracts/triage.ts`: `validateTriage(current: CurrentReviewSet, candidate: unknown): ValidatedTriage` requires exact composite finding coverage.
- `src/contracts/renderers.ts`: `renderReviewEvidence`, `renderTriage`, and `renderAdjudicationEvidence` accept authenticated values and emit deterministic UTF-8/LF Markdown.
- `src/contracts/gates.ts`: `GATE_KINDS`, `GATE_CONTRACTS`, `parseGateContract`, `validateGateDecision`, `parseGateDecisionEnvelope`, and `gateDecisionEffect` own the nine-kind decision catalogue.
- `src/contracts/errors.ts`: `PROJECT_ERROR_DEFINITIONS`, `PROTOCOL_ERROR_DEFINITIONS`, `createProjectError`, `createProtocolError`, `parseProjectError`, and `parseProtocolError` own the closed error registries.
- `src/contracts/mcp-tools.ts`: `TOOL_DEFINITIONS`, `parseToolCall`, `bindParsedToolCallRequest`, `validateProjectResultStructure`, and `correlateProjectResult` define the exact five transport-neutral pairs and correlation seam.
- `src/contracts/contexts.ts`: `createInvocationContext` consumes an authentic immutable connection context while retaining `AbortSignal` as the only live external capability; connection minting remains internal.
- `src/contracts/versions.ts`: `SCHEMA_IDS` registers all 22 independently loadable v1 schemas, including the HTTPS MCP tool and result-expectation authorities.
- `src/contracts/internal/test-capabilities.ts`: direct-import-only factories exercise later-owner authority in tests and are absent from `src/contracts/index.ts` and the temporary public bundle.
