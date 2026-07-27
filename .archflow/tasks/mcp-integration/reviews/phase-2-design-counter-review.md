# Phase 2 Design Counter-Review

Reviewed against `.archflow/tasks/mcp-integration/architecture.md`, `.archflow/tasks/mcp-integration/prd.md`, the Phase 1 design and implementation log, and the current contract implementation. `.archflow/context/` is not present.

## Findings

### 1. Blocker — The promised request/result authority correlation is not implementable from the proposed validator inputs

`validateProjectResult(name, parsedInput, value)` receives only a parsed public request and an untrusted result (phase design lines 541–549). That is insufficient to validate several success fields which are minted only after request processing: projection `path`, resulting `revision`, derived review/adjudication summaries, waiver `gate_id`, and especially a gate decision's `gate_id` and `context_digest`. `GateInput` deliberately contains neither gate ID nor context digest (lines 478–487), while those values require canonical repository identity and canonical request/context hashing owned by later phases. Consequently, a structurally valid success from another invocation of the same tool—most critically another same-kind gate—cannot be distinguished from the current result. `NoInfer` and the parsed-input brand prevent some compile-time mixups but do not provide the missing runtime authority.

This contradicts the architecture's Phase 2 criterion that successes are correlated to the parsed request and that wrong gate decisions are rejected before Phase 3 projects an inert handler result.

**Suggested resolution:** Separate structural result validation from authoritative correlation. Introduce an opaque, handler/transaction-minted `ResultExpectation<K>` (or a definition-bound parsed-call handle) containing the exact expected projection identity, revision, semantic summary, gate ID, request/context digest, and other operation-derived bindings. Require that expectation for authoritative validation. If those values cannot be minted until Phases 4–5, explicitly narrow Phase 2/3 to structural and directly comparable-field checks and move the authority-correlation guarantee to the owning phase.

### 2. Blocker — Server attestation is authorized by an unscoped capability while the caller supplies the facts being attested

`ObservationCapability` carries no invocation or envelope scope, while `AdapterObservationBase` supplies task, phase, role, subject, input fingerprint, invocation/result IDs, envelope and output digests, adapter/CLI/family/model/effort, and the raw output (lines 101–121). Possession of the capability therefore authorizes arbitrary bindings; it does not prove that those bindings were observed together. The trust module also cannot verify `observed_output_digest` because this phase computes no digest. For adjudication, the problem is stronger: the design says raw output supplies pinned-constitution, approved-upstream, and source-evidence identities, but those expected identities are absent from `AdapterObservationBase`, so a model's mutually consistent wrong-policy claim can become server-attested.

That does not meet REQ-17/REQ-33 or the phase criterion that wrong-invocation and wrong-digest provenance cannot qualify.

**Suggested resolution:** Make observation authority invocation-scoped and mint it from immutable expected envelope bindings. The observer must own the observed bytes and their digest, not accept the digest as an independent claim. Add kind-specific trusted bindings for adjudication's exact constitution, upstream, and source-evidence identities, and compare every model-supplied identity to them before attestation. Close adapter/family/effort vocabularies where they are canonical rather than leaving them as arbitrary strings.

### 3. Blocker — The gate and error “frozen contracts” still contain central placeholders

All nine `*Context` types are referenced but never defined (lines 254–263); the prose table at lines 341–351 does not fix field names, cardinality, ordering, bounds, or cross-field constraints. `ProjectErrorDefinitionByCode` is likewise a comment placeholder and `ProjectErrorValue` is used without a defined serialized shape (lines 387–402). The contexts, decision effects, error values, and safe parameters are exactly the seams separate implementation chunks and Phase 3 must consume.

The gate design also regresses from the parent requirement for one exhaustive authority: `GateContextByKind`, `GateDecisionPayloadByKind`, and the prose-only effect classification are independent sources that can drift even if their key sets agree.

**Suggested resolution:** Define the exact nine context interfaces and semantic invariants, the complete error definition/value types, and one `GateContractByKind` catalogue from which context, payload, allowed effect, schema, Zod mirror, and runtime narrowing are derived. Do not hand implementation a prose table plus multiple parallel registries for trust-bearing decisions.

### 4. Major — Waiver and supplemental authority are neither single-sourced nor tied to the originating gate

`WaiverRequestPayload.scope` repeats phase/subject/evidence authority already present in the outer `GateInput`, but no equality rule prevents the human payload from naming another subject or evidence set. `WaiverDecisionBinding` repeats subject/evidence both outside and inside `scope` (lines 502–510), again without an equality invariant. `WaiverInput` contains no reference to the archived `waiver-requested` gate decision that authorized the sequential waiver gate, despite REQ-18 and the architecture requiring exact gate identity and a recorded request. The meaning of the success `gate_id`—originating review gate or new waiver gate—is consequently ambiguous.

The design also says waiver decisions and supplemental ingestion/triage/decline/supersession are separate contracts (line 357), but no exact supplemental contract, schema, file owner, or correlation interface is included. This falls short of the architecture's Phase 2 criterion that waiver and supplemental choices cannot be substituted across kinds.

**Suggested resolution:** Derive waiver scope from the originating gate's common authority instead of repeating it in a human payload, or require exact equality in one normative contract. Add a digest-bound origin gate/decision reference and distinguish origin versus waiver gate IDs. Define the exact supplemental request/outcome contracts and their current gate/subject bindings now, or remove the claim that Phase 2 freezes them and assign them explicitly to a later owner.

### 5. Major — Current-review and gate evidence sets omit assurance, independence, gate identity, and exact-slot semantics

`CurrentReviewSetAuthority.allowed_evidence` records only `{role, evidence_digest}` (lines 194–204). It cannot express that normal counter-review must be server-attested and opposite-family, that degraded counter-review must still be cross-family, or that a `gate-counter-review` belongs to the exact current gate rather than another gate with the same task/phase/subject/input. `required_roles` and `allowed_evidence` are arrays with no pinned uniqueness/cardinality rules. Similarly, `GateInput.current_evidence_digests` is an untyped digest array with no role mapping, duplicate rule, or canonical set ordering.

The triage text also never makes “applicable” exact: REQ-11–REQ-13 require every current finding, including advisory/non-blocking findings, to receive one disposition, but the design does not state that or define zero-finding behavior.

**Suggested resolution:** Define a canonical unique slot set whose entries include role, digest, acceptable assurance, verified family/independence authority, and exact `gate_id` for supplemental slots. Bind gates to that structured set rather than a bare digest array. State that all findings from every required current slot are applicable, define empty/pass/advisory behavior, and test duplicate slots, wrong assurance/family, stale evidence, reordered sets, and same-subject/different-gate substitution.

### 6. Major — Authority-link hashing and reuse semantics are not safe for persistence and replay

The serializable authority link contains `evidence_digest` plus authority-side `result_digest`, but the design never fixes the byte domain of `result_digest` or whether the serialized link is inside that result. If it is, the result becomes self-referential; if it is not, the retained location and verification owner are unspecified. This is precisely the digest-ownership boundary the phase is intended to freeze.

The design also promises to reject reuse of an `AuthorityLink` (lines 225 and 607). A process-local consumed-token/`WeakSet` interpretation conflicts with idempotent retries, restart, reconciliation, and rebuilding canonical projections from the same retained evidence. Durable authority cannot depend on whether a link object happened to be consumed in one process.

**Suggested resolution:** Define every hash domain and containment boundary explicitly, including whether the result digest covers raw model output, derived evidence, wrapper, link, manifest, or some closed subset; keep self-references outside the hashed object. Make qualification idempotent for the identical link plus verified wrapper and reject only reuse with a different digest, value, or scope. Persisted state/result/checkpoint validation—not process-local token consumption—must establish replay authority.

### 7. Major — The error registries are neither behaviorally exhaustive nor internally consistent

Several row-wide profiles/actions cannot carry the architecture-required safe diagnostics or recovery action. For example, `SNAPSHOT_LIMIT` needs offending paths and current/cap byte counts, but all snapshot errors receive only the digest profile and `reduce-or-repair-snapshot`; that action is wrong for `RESTORE_COLLISION`, `SECRET_DETECTED`, and `RECONCILIATION_REQUIRED`. `SUPPLEMENTAL_REVIEW_REQUIRED` requires triage/reject/accepted-change handling before retry, not merely “reread and retry.” `WAIVER_DENIED` is registered as an error even though denial is also a valid `WaiverSuccess`, and `RESULT_INVALID` points to caller correction while malformed handler results are said to become `INTERNAL_ERROR`.

Cancellation and protocol ownership remain ambiguous: `CANCELLED` and `GATE_CANCELLED` do not distinguish child/MCP cancellation from explicit non-advancing gate cancellation, and an “exhaustive” protocol registry with only `TOOL_NOT_FOUND` and `UNSUPPORTED_PROTOCOL` does not say who owns standard parse/invalid-request/invalid-params/internal/cancellation errors, repeated initialization, or Phase 3 disabled operations.

**Suggested resolution:** Define parameters and one safe next action per code, not per broad row. Add a source/projection matrix covering SDK protocol, known-tool contract errors, handler integrity failures, child dispatch, and durable gate lifecycle. Resolve denial/cancellation/result-invalid duplication, and either enumerate the full ArchFlow protocol registry or explicitly scope out standard MCP/JSON-RPC errors and define their adapter mapping.

### 8. Major — The five-tool boundary consumes path and generic types whose authority is not owned

`TaskRelativePath` is used in four success/request shapes (lines 453–475), but it does not exist in Phase 1, this phase explicitly excludes path schemas, and Phase 4 owns path safety. A Phase 2 parser cannot honestly mint a safe task-relative-path brand, while Phase 3 must already parse and advertise these schemas. Several other shared names (`ReviewRole`, `RuleVersionRef`, `ConstitutionResult`, `DriftResult`, and qualified evidence types) are referenced without a concrete module/export definition.

The generic seam also remains unsafe when `name` is widened to `ToolName`: `ParsedToolInput<K>` becomes a union/intersection shape whose brand does not preserve a single correlated call, and `ToolDefinition<K>` types both schemas merely as `object`, with no type/schema-ID relation to `ToolInput<K>` and `ProjectResult<ToolSuccess<K>>`.

**Suggested resolution:** Introduce a lexical, explicitly untrusted bounded path claim for Phase 2 and reserve a distinct Phase 4 resolved-safe-path brand. Assign every shared primitive/type to a concrete file and public export. Represent a parsed call as a mapped discriminated pair `{name: P, input: ParsedToolInput<P>}` (or return a definition-bound validator closure), and bind each definition to exact input and wrapped-output schema IDs. Test widened-name and same-tool cross-request substitutions.

### 9. Major — Connection and invocation “immutability” has no runtime minting boundary

Lines 555–575 expose constructible structural interfaces only. TypeScript `readonly` and `Readonly<T>` do not copy or freeze runtime objects, and the existing Phase 1 validators return the original input. A caller can therefore forge or mutate host/protocol/working-directory candidates after construction. A blanket deep-freeze promise is also incompatible with treating `AbortSignal` as a live cancellation object.

**Suggested resolution:** Define internal branded constructors that validate, copy, and deep-freeze startup and initialization data exactly once; expose only read views. State that `AbortSignal` is a live externally owned capability excluded from cloning/freezing, while transport metadata is snapshotted. Test mutation of both source objects and nested context objects after construction, plus repeated initialization rejection.

### 10. Major — Human override and commit-authorization evidence do not bind a complete decision subject

`adjudication-failure/approve` requires `human_evidence_digest`, but there is no human-evidence value/reference schema, retention path, renderer, or mint/verification owner. Digest syntax alone cannot establish that the evidence exists, applies to the exact unresolved rules, or was retained with the decision.

Commit authorization binds the canonical diff as outer `subject_digest` and repeats `authorized_diff_digest`, but the PRD requires authorization of the final implementation diff **and current artifact digests**. `current_evidence_digests` are review evidence, not the implementation manifest, parent-document outputs, or other current artifact identities. The context table intentionally contains only commit target/ref metadata, leaving the exact artifact set unrepresented.

**Suggested resolution:** Define a retained versioned human-override evidence contract correlated to the exact gate and unresolved rule set, or make the retained decision record itself the sole evidence and remove the orphan digest. Define commit authorization over the implementation-output manifest/result identity plus its exact diff and current parent/artifact digests, with one canonical decision subject rather than loosely related fields.

### 11. Major — Canonical Markdown is byte-deterministic but not yet a trustworthy human projection

The renderer contract promises fixed headings/order and “defined Markdown escaping,” but does not enumerate REQ-11's required header fields per artifact or specify how untrusted model prose is prevented from rendering counterfeit headings, tables, links, fences, or raw HTML. Unicode coverage does not address bidi/control-character spoofing. A byte-stable projection can still mislead the human at the review gate.

**Suggested resolution:** Pin exact per-artifact templates and field inventories. Render untrusted prose in a visibly delimited, non-structural representation; reject or visibly encode control/bidi characters and raw HTML. Add golden cases for heading/table/fence/link/HTML injection, embedded CR/LF, and bidi controls, not just generic escaping and Unicode.

### 12. Major — The phase is still oversized and its requirement traceability understates what it freezes

The design contains eight nominal chunks but covers roughly ten production modules, twelve normative schemas, eleven named test suites plus large fixture corpora, and six tightly coupled subsystems. Chunks 2, 4, 5, and 6 are each subsystem-sized and depend on many of the undefined seams above. The “close adversarial verification” chunk then multiplies every variant across JSON Schema, Zod, runtime, compile-time, mutation, and rendering tests. This is high risk for one implementation/review/verification session even with delegation.

The requirement list also omits contracts this phase normatively freezes: at least REQ-13, REQ-18–REQ-20, REQ-23, REQ-36–REQ-37, REQ-41, and REQ-50 are directly implicated by current-set authority, waiver/gate decisions, replay, supplemental behavior, and migration decisions. The architecture coverage table names Phase 2 for several of them, while the phase header does not, making approval evidence incomplete.

**Suggested resolution:** Split evidence/authority/triage/rendering from gate/error/tool/context authority, or demonstrate a finer independently implementable breakdown that fits the phase budget after resolving the blockers. With explicit user approval, update both the architecture and phase requirement lists to reflect the normative contracts Phase 2 actually owns, and map each to success and verification evidence; otherwise narrow the phase's freeze claims.

### 13. Minor — The established bundle-smoke convention is omitted from the file plan

Phase 1's implementation log records behavioral exercise of the temporary ESM bundle as a durable convention. The current smoke script exercises only YAML, generic Ajv, and phase-number APIs. Phase 2 changes the public barrel with JSON-schema imports, renderers, registries, and all five tool definitions, but the file plan says build scripts remain unchanged. Source-level Vitest success will not prove those exports initialize and behave through esbuild.

**Suggested resolution:** Include `scripts/smoke-temp-bundle.mjs` in the file plan and exercise representative Phase 2 parsing/rendering, both registries, and all five tool definitions from the emitted `.tmp/archflow-contracts.mjs`; modify the build script only if the new resource imports require it.

### 14. Minor — Canonical SHA-256 lexical identity is not pinned

`Sha256Digest` is shown only as a branded string and the prose says syntax will be validated, but it never chooses a canonical lowercase/prefix representation. Uppercase, prefixed, or whitespace variants can create unequal aliases for the same digest in paths, finding references, gate inputs, and sets.

**Suggested resolution:** Specify one exact lexical form (for example, exactly 64 lowercase hexadecimal characters with no prefix), use it consistently in JSON Schema/Zod/runtime parsing, and reject uppercase, prefixed, and whitespace variants in agreement fixtures.

## Dependency currency

No substantive dependency finding remains. Phase 2 genuinely adds no package, the inherited exact Phase 1 graph is sufficient for this work, and live npm metadata confirms the direct pins remain current within their intentional Node-24/Vite-7 compatibility lines. The reviewed Vitest version still supports Vite 7. This does not reduce the sizing or contract-authority findings above.

## Triage

| Finding | Disposition | Design response |
|---------|-------------|-----------------|
| 1. Request/result authority correlation | Accepted | Split result handling into `validateProjectResultStructure` and expectation-based `correlateProjectResult`. Added a mapped `ParsedToolCall`, opaque later-owner `ResultExpectation<K>`, complete expected success/request/revision identity, an internal-only test mint, and an explicit Phase 3 structural-only boundary. |
| 2. Unscoped observation authority | Accepted | Replaced caller-supplied attestation facts with invocation-scoped capabilities minted from immutable kind-specific expected bindings. The observer now owns/copies exact output bytes, computes their raw SHA-256 digest, checks policy/evidence bindings, and uses closed adapter/family/effort vocabularies. |
| 3. Placeholder gate/error contracts | Accepted | Replaced the gate placeholders with one exact nine-kind `GateContractByKind`/`gate-contract.schema.json` authority and semantic invariants. Replaced error placeholders/grouped behavior with complete serialized value types, literal code unions, and one exhaustive per-code source table. |
| 4. Waiver and supplemental authority | Accepted | Added exact `WaiverOriginRef`, `SupplementalReviewRef`, and `SupplementalReviewOutcome` contracts. Waivers bind the archived origin decision/context/subject/evidence/rule/scope and distinguish origin from waiver gate IDs; supplemental actions bind the exact prior gate and subject. |
| 5. Current-review slot semantics | Accepted | Added canonical tuple-shaped review slots carrying role, digest, assurance, producer/reviewer family, independence, and exact gate ID where applicable. Gates consume a structured set reference; triage covers every advisory/blocking finding and defines zero-finding behavior. |
| 6. Hash domains and replay | Accepted | Defined raw-output, evidence, result, authority-link, context, and request byte domains with self-reference exclusions. Qualification is now idempotent for the identical verified wrapper/link and rejects only payload, digest, provenance, or scope substitution; durable validators own replay authority. |
| 7. Error behavior and protocol ownership | Accepted | Assigned exact safe parameters and a single recovery action to every code, removed `WAIVER_DENIED`, separated child from durable-gate cancellation and retained corruption from handler integrity failure, added disabled/repeated-initialization protocol codes, and fixed the SDK/MCP mapping matrix. |
| 8. Path/type/generic authority | Accepted | Introduced lexical-only `TaskPathClaim` with an explicit Phase 4 safety boundary, assigned shared types to concrete modules/barrel exports, replaced the generic parsed input with a mapped discriminated call, and bound definitions to exact schema fragments. |
| 9. Runtime context immutability | Accepted | Added internal branded one-shot constructors that validate, defensively copy, and deep-freeze plain connection/invocation data. `AbortSignal` is explicitly retained by identity as the sole live non-frozen capability; repeated initialization is rejected. |
| 10. Human and commit evidence | Accepted | Made the retained decision envelope itself the human override evidence and removed the orphan evidence digest. Commit authorization now uses the implementation-result identity as subject and binds the final diff, current artifacts, parent documents, and target ref. |
| 11. Canonical Markdown trust | Accepted | Pinned exact H1/header inventories for review, triage, and adjudication. Untrusted prose is rendered only as visibly escaped canonical JSON under trusted labels, with explicit heading/table/fence/link/HTML/control/bidi attack cases. |
| 12. Sizing and traceability | Accepted in part | Added all omitted requirement IDs to the architecture and phase design and expanded the breakdown from eight compound chunks to ten independently delegable chunks. A second split was not adopted: the user already approved separating this contract-authority phase from the inert MCP boundary, and the revised ten-chunk phase fits the skill's delegated 8–12 chunk calibration. |
| 13. Temporary-bundle smoke | Accepted | Added `scripts/smoke-temp-bundle.mjs` to the file plan, work breakdown, success evidence, and verification so representative Phase 2 exports, both registries, and all five definitions execute from the emitted temporary ESM bundle. |
| 14. SHA-256 lexical identity | Accepted | Fixed the only valid spelling to exactly 64 lowercase ASCII hex characters with no prefix or whitespace and added agreement fixtures for uppercase, prefixed, padded, short, and long aliases. |
