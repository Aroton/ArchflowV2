# Phase 1 Design Counter-Review

> Subject: `phases/phase-1-contracts-assets-and-package-scaffold.md`
> Reviewed against: `architecture.md`, `prd.md`, the current repository at `cfc3ecadaeb4e0b5e17f434565b7e6d9c9fa30b8`, and live official dependency/API sources on 2026-07-27. `.archflow/context/` is absent.

## Findings

### 1. Major — The exact Vitest graph introduces a copyleft dependency without the required human decision

The design says all direct and transitive licenses are acceptable and makes `vitest@4.1.10` part of the exact Phase 1 graph. A clean resolution currently produces `vitest@4.1.10 -> vite@8.1.5 -> lightningcss@1.33.0` (plus its platform binding), and Lightning CSS is MPL-2.0. The architecture's dependency-review policy says copyleft of any strength must be flagged for the user to decide, never silently adopted. This is therefore not an implementation-time notices detail: the phase design currently presupposes an approval that has not occurred.

Official evidence: [Vitest 4.1.10 manifest](https://github.com/vitest-dev/vitest/blob/v4.1.10/packages/vitest/package.json), [Vite 8.1.5 manifest](https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/package.json), and [Lightning CSS 1.33.0 license](https://github.com/parcel-bundler/lightningcss/blob/v1.33.0/LICENSE).

**Suggested resolution:** Before approving Phase 1, either obtain and record explicit human acceptance of MPL-2.0 and pin the required notice/source-compliance checks, or choose an exact test dependency graph that remains within the already accepted permissive-license policy. Remove the unconditional claim that all transitive licenses are acceptable until that decision is made.

### 2. Major — Triage identity can collapse unrelated findings from different reviews

`deriveTriage(reviews, dispositions)` is specified to cover every “distinct finding ID” across a set of review evidence. Finding IDs are model-authored and only promised to be stable; two independent reviews can both emit a local ID such as `F-1` for different defects. Treating the bare ID as the key either collapses two applicable findings into one disposition or makes valid evidence ambiguous, contrary to REQ-11's requirement to disposition each applicable finding exactly once.

**Suggested resolution:** Freeze a composite finding identity such as `(review evidence digest, finding_id)`, deterministically namespace IDs at evidence ingestion, or explicitly reject cross-review collisions. Pin the choice in `TriageDisposition`/`ValidatedTriage` and add a corpus case with two evidence items that use the same local ID for different findings.

### 3. Major — `GateContextV1` admits decision sets forbidden by the PRD and architecture

The proposed contract makes `kind: GateKind` and `allowed_decisions: GateDecision[]` independent. A schema-valid `constitution-edit` context can therefore advertise `approve`, although REQ-16/REQ-20 explicitly forbid an approval-shaped resolution, and a `restore-collision` context can advertise generic decisions instead of the architecture's exact three choices. Phase 5 cannot safely repair this after Phase 1 freezes and advertises the foundational contract.

**Suggested resolution:** Replace the independent fields with a discriminated union or a single centralized exhaustive kind-to-legal-decisions map used by both JSON Schema and Zod. Enforce non-empty, duplicate-free, exact decision sets and add positive/negative fixtures for every gate kind.

### 4. Major — The adjudication contract omits constitution-compliance evidence required by REQ-15 and REQ-19

`ConstitutionResult` contains only a verdict plus matched and uncertain rule-ID arrays. `DriftResult` and `Trigger` carry evidence, but a constitution failure—especially missing, stale, unknown, or failed `enforced_by` evidence—need not correspond to a trigger and has nowhere to retain its supporting evidence. The PRD requires separate constitution/drift results with supporting evidence, and later canonical rendering cannot reconstruct evidence that the frozen result type discarded.

**Suggested resolution:** Add digest-bound per-rule compliance evidence/findings to `ConstitutionResult` (or a clearly linked adjudication evidence collection), including the state of `enforced_by` evidence. Define the currently omitted `ValidatedAdjudication` interface and add fail/uncertain/missing/stale mechanical-evidence fixtures.

### 5. Major — Known-tool validation failures contradict the parent stable-error contract

The phase deliberately maps bad versions, unknown fields, disabled `artifact`, and malformed nested inputs to an SDK-generated `isError: true` result with no `structuredContent`. However, the PRD's normative MCP boundary and the architecture say failures expose a stable code, retryability, and safe diagnostic, while `tools/list` advertises a closed `ProjectResult<O>` result schema. The SDK behavior is real and current, but this phase design is silently creating an exception to the parent contract rather than reconciling it.

**Suggested resolution:** Either amend the PRD/architecture explicitly so pre-handler known-tool argument failures are protocol/SDK errors outside the project envelope, including the observable stable contract clients may rely on, or add an adapter boundary that maps those failures into the declared `CONTRACT_*` project envelope without invoking business handlers. Keep unknown tool names on the separate JSON-RPC path and fixture-test the chosen distinction.

### 6. Major — Explore is in the fixed workflow but cannot be represented at the state boundary

The design includes `explore` in `PHASE_IDS` and the published graph, while `PhaseInstance`, `PhaseInstanceId`, and therefore `StateInput` omit it. REQ-06 defines Explore's `produce` pipeline and REQ-08 says every pipeline step records entry and exit through `archflow_state`; REQ-02, conversely, lists only PRD/design/iterated design and implementation evidence identities. The current contract cannot satisfy both readings.

**Suggested resolution:** Obtain an explicit parent-contract decision: either add a canonical `explore` phase instance and define its disposable state/evidence semantics, or amend REQ-08/workflow wording to exempt Explore from durable state while retaining its graph entry. Then make the vocabulary, codec, workflow validator, state schema, and fixtures agree.

### 7. Major — Request-sourced repository/task identity has no defined transport seam

`IdentityCapture` allows `source: "request"` and carries raw repository/task strings, and the adapter chunk is expected to capture and test that source. None of the five tool inputs carries identity, and the design does not name an MCP `_meta` field, initialization binding, or other request-context location from which it comes. Phase 2 is assigned identity validation, but it cannot validate or bind a transport field that Phase 1 never defines; different chunks can invent incompatible sources.

**Suggested resolution:** Define the exact MCP connection/request metadata location, versioned shape, precedence, absence/duplication rules, and trust status now, with wire fixtures. If no request identity channel is intended, remove the request variant from the Phase 1 contract and introduce it only when its owning phase defines the transport.

### 8. Major — Server-attested provenance is exposed as a forgeable public constructor seam

The design exports `attestServerReview(review, binding)` but does not define `ServerBinding`, its required observed fields, who is allowed to construct it, or how persisted acceptance verifies its linkage to server state/receipts. A schema-valid caller-created binding could therefore manufacture `server-attested` evidence, contrary to REQ-11 and REQ-33. The other omitted types (`AgentBinding`, `DegradedBinding`, `ReviewEvidence`, and their assurance-specific fields) also leave the most important cross-chunk trust boundary unpinned.

**Suggested resolution:** Specify every binding/evidence type and invariant in the phase contract. Keep server attestation behind an internal/opaque adapter capability rather than a generally callable constructor, and require persisted acceptance to verify the attestation against the observed invocation/result identity—not merely the schema-shaped provenance fields. Add forged-binding and wrong-invocation fixtures.

### 9. Major — The phase design changes the parent Phase 1 state-schema acceptance criterion without approval

The architecture's Phase 1 scope calls for normative strict durable schemas and its success criteria explicitly require valid workflow/review/**state** samples to round-trip. The phase design reinterprets “state samples” as inert `archflow_state` request samples, disables `artifact`, and defers durable `state.json` entirely. Phase 2 does own the detailed state/artifact schema family, so the documents are genuinely inconsistent; the lower-level phase design cannot resolve that inconsistency merely by calling its interpretation a clarification.

**Suggested resolution:** Reconcile the architecture with explicit user approval before implementation: either amend the Phase 1 scope/criterion to say “inert state-tool request samples” and name Phase 2 as the first owner of durable state schemas, or add the minimum durable state contract and samples required by the current Phase 1 wording. Do not let implementation choose between two normative acceptance boundaries.

### 10. Major — The offline bundle handoff to Phase 9 is not pinned

Phase 1 creates `.gitignore`, generates `dist/archflow-mcp.js`, and verifies cached `npm ci --offline`, but never states whether the bundle is tracked, packaged as a retained release artifact, or ignored. REQ-28 ultimately requires an installed, version-pinned command that starts offline, and Phase 9 assumes an offline bundle exists from a clean checkout. A cache-warmed install test does not define how that payload reaches a clean installer checkout.

**Suggested resolution:** Specify the cross-phase artifact contract now: whether `dist` is committed, attached as a hash-verified release/tarball asset, or reproducibly built before packaging from a separately provisioned dependency cache. Align `.gitignore`, package scripts, Phase 9 inputs, and the clean-checkout test with that choice; distinguish “offline startup” from “offline dependency installation.”

### 11. Minor — The exported phase types statically admit encodings the runtime contract forbids

`PhaseInstance.phase` is an unconstrained `number` and `PhaseInstanceId` uses `` `${number}` ``, which admits zero, negative, decimal, exponent, `NaN`, and unsafe-number forms at TypeScript call sites even though the prose requires a positive safe canonical integer and byte-for-byte round-trip. Runtime validation can reject them, but the advertised cross-chunk types do not encode the invariant.

**Suggested resolution:** Use an opaque validated positive-safe phase-number type and a branded canonical `PhaseInstanceId` constructed only by the codec, while keeping boundary parsers on plain `string`/`unknown`. Add compile-time assertions alongside the runtime alias corpus.

## Overall assessment

No dependency version is stale as of 2026-07-27, and the MCP beta.5 assumptions about Standard Schema inputs, pre-handler argument rejection, skipped SDK output validation for `isError`, separate unknown-tool JSON-RPC errors, protocol `2025-11-25`, and direct 2025-era stdio remain current. The remaining defects are concentrated in trust-bearing contract seams and one unresolved license decision. No blocker requires abandoning the phase, but the major findings should be resolved before design approval because Phase 1 is intended to freeze the interfaces every later phase consumes.

## Triage

Triaged against the approved PRD/architecture, the revised phase design, live npm manifests and official dependency/API documentation on 2026-07-27. The owner approved both parent-contract corrections on 2026-07-27; the PRD and architecture now record them.

| Finding | Disposition | Resolution |
|---------|-------------|------------|
| 1. Vitest graph introduces MPL-2.0 | **Accepted** | Added exact direct dev pin `vite@7.3.6`, which Vitest 4.1.10 supports and which prevents current resolution to Vite 8/Lightning CSS. The design now requires lock-wide proof of no `lightningcss`, no copyleft package, and complete license/NOTICE evidence; it no longer presupposes transitive acceptability. MPL is not adopted. |
| 2. Triage identity collisions | **Accepted** | Architecture Phase 2 owns composite `FindingRef { review_evidence_digest, finding_id }`; every disposition keys that pair, and fixtures cover two reviews that both use local ID `F-1`. |
| 3. Illegal gate-decision combinations | **Accepted in part** | Architecture Phase 2 freezes discriminated gate contexts and one exhaustive `GATE_DECISIONS_BY_KIND` authority shared by JSON Schema, Zod, result correlation, and fixtures. Parent-fixed constitution-edit, restore-collision, commit-authorization, waiver, and supplemental outcomes are separated and exact. New Phase 6 still derives and compares the authoritative set before publishing/resolving a durable gate. |
| 4. Missing constitution-compliance evidence | **Accepted** | Architecture Phase 2 owns digest-bound per-rule compliance findings, rule version/outcome, all `enforced_by` states, separate drift/triggers, `ValidatedAdjudication`, renderers, and missing/stale/unknown/failed/digest-mismatch fixtures. |
| 5. Known-tool failures violate stable-error contract | **Accepted** | Architecture Phase 2 owns beta.5's low-level `Server` seam, safe parsing of known calls into stable `CONTRACT_*` results, exact tool/error schemas, and `projectCallToolResult`; only unknown/disabled names remain protocol errors. Its SDK currency check must prove an equivalent seam if the deprecated-but-supported API changes. |
| 6. Explore cannot be represented at state boundary | **Accepted** | The owner approved treating Explore as disposable pre-task work present only in workflow vocabulary, with no phase/review/state evidence. PRD REQ-08 now explicitly exempts Explore from durable state recording. |
| 7. Undefined request identity transport | **Accepted** | Architecture Phase 2 defines immutable startup/initialize repository/host candidates and required request `task_id`; new Phase 3 validates/canonicalizes them before reads. No request may override repository or host identity or use hidden metadata. |
| 8. Forgeable server-attested provenance | **Accepted in part** | Architecture Phase 2 defines all binding/evidence types, internal opaque observation/attestation minting, receipt/state/result linkage verification, and forged/wrong-invocation fixtures. Schema-shaped provenance alone cannot upgrade assurance. |
| 9. Phase design reinterprets parent state criterion | **Accepted** | The owner approved the architecture split: Phase 2 owns inert `archflow_state` request/tool schemas, while new Phase 3 owns durable `state.json` and detailed artifact schemas. Narrowed Phase 1 contains neither surface. |
| 10. Offline bundle handoff unspecified | **Accepted** | Architecture Phase 2 tracks `dist/archflow-mcp.js` and `dist/manifest.json` with bundle/source/schema/assets/package/lock identities and clean-checkout offline proof. New Phase 9 updates the same artifact for full assembly; new Phase 10 verifies it before installation. |
| 11. Phase types over-admit invalid encodings | **Accepted** | Added opaque `PositiveSafePhaseNumber` and canonical `PhaseInstanceId` brands minted only by validators/codecs, with boundary parsers accepting `unknown` and both compile-time and runtime invalid-alias fixtures. |

The revisions are substantial, so the fully reconciled design requires another fresh-context review before it is presented for approval.

## Post-triage sizing review

A fresh-context review found the reconciled Phase 1 still oversized because package/assets/validator foundations and trust-bearing review/MCP/bundle contracts competed for one implementation session. The user approved a split and full downstream renumbering on 2026-07-27:

- Phase 1 now ends at the buildable package, validation infrastructure, branded codec, and workflow/config/rubric/constitution contracts/assets.
- New architecture Phase 2 owns review/triage/adjudication, gate/error/tool interfaces, inert MCP protocol proof, provenance linkage, and tracked offline bundle.
- New Phase 3 owns durable state and detailed artifact/repository schemas; old Phases 2–15 become new Phases 3–16.

This sizing decision supersedes the final sentence above: the narrowed Phase 1 is now sized to five implementation chunks, while the trust-bearing work receives its own phase and review gate.
