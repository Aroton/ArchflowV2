# Phase 2: Review Evidence and Contract Authority

**Status**: DESIGNED
**Task**: mcp-integration
**Goal**: Freeze the trust-bearing semantic, provenance, gate, error, tool, connection, and invocation contracts before any MCP transport or durable workflow implementation adopts them.
**Requirements**: REQ-04, REQ-05, REQ-10, REQ-11, REQ-12, REQ-13, REQ-15, REQ-17, REQ-18, REQ-19, REQ-20, REQ-23, REQ-27, REQ-33, REQ-36, REQ-37, REQ-41, REQ-50

## Context

Phase 1 established the private ESM package, recursive plain-JSON preflight, strict non-mutating Ajv 2020 validation, strict Zod mirrors, canonical phase-instance codecs, and the first six normative v1 schemas. Phase 2 extends those patterns: JSON Schema remains normative, every parser accepting `unknown` performs the plain-JSON preflight, Zod mirrors reject unknown fields without transforming input, and agreement/non-mutation tests protect every overlapping representation. `SCHEMA_IDS` and the public contracts barrel remain the discovery points.

The approved architecture split keeps this phase transport-neutral. It freezes evidence, capability, gate, error, five-tool, and invocation seams that later implementations must adopt, but it does not install or use an MCP SDK, start a server, negotiate a protocol, create protocol fixtures, produce `dist/`, or change package, lock, CI, dependency, or release surfaces. Phase 4 computes canonical repository digests and decides currentness; this phase validates SHA-256 syntax, compares supplied identities, and supplies only internal test doubles for future observation and authority capabilities.

## What We're Building

We will define normative v1 schemas and strict TypeScript contracts for review, triage, and adjudication evidence. Review and adjudication each follow the same trust ladder: raw observed output is semantically derived, then wrapped as agent-declared, server-attested, or degraded evidence. Semantic correctness does not imply provenance or authority. Every persisted or transported evidence value uses the non-self-referential `ReferencedEvidence<T>` wrapper, whose digest identifies the enclosed evidence but is never embedded in that evidence. An internal trust module derives bindings from the observed envelope before it can mint server attestation; a separate future-owner authority capability qualifies every provenance variant and mints the exact `CurrentReviewSet` needed by triage.

We will also freeze an independent nine-kind gate catalogue with object-shaped, kind-correlated decision payloads; separate exhaustive project and protocol error registries; exactly five literal-keyed request/success contract pairs; and immutable transport-neutral connection/invocation contexts. Canonical renderers consume only qualified or branded validated JSON and produce deterministic Markdown. These contracts deliberately contain no persistence, durable state or artifact schema, authority implementation, dispatcher, MCP adapter, or wire projection.

**External dependency surface**: none. Phase 2 uses only the exact Phase 1 dependency graph.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify | `src/contracts/index.ts`, `src/contracts/versions.ts` | Export the public Phase 2 contract surface and register every independently addressable Phase 2 schema ID. |
| Create | `src/contracts/evidence.ts`, `src/contracts/review.ts`, `src/contracts/adjudication.ts`, `src/contracts/triage.ts`, `src/contracts/supplemental.ts` | Define canonical digest syntax, raw/derived/provenance evidence, structured evidence slots, exact-set triage, external evidence references, supplemental choices, and opaque qualification seams. |
| Create | `src/contracts/trust.ts`, `src/contracts/internal/test-capabilities.ts` | Define observation/authority capability consumers and non-public fixture factories; only the internal test module can create fake capabilities. |
| Create | `src/contracts/renderers.ts` | Render qualified review/adjudication evidence and branded triage deterministically from validated JSON. |
| Create | `src/contracts/gates.ts`, `src/contracts/errors.ts`, `src/contracts/tool-names.ts`, `src/contracts/mcp-tools.ts`, `src/contracts/contexts.ts`, `src/contracts/path-claims.ts` | Freeze the single gate catalogue, per-code error registries, shared five-name vocabulary, five correlated tool pairs, lexical path claims, and branded transport-neutral contexts. |
| Create | `src/contracts/schemas/v1/{review,review-evidence,adjudication,adjudication-evidence,evidence-reference,authority-link,evidence-slots,triage,supplemental-review,gate-contract,gate-decision,project-error,protocol-error,mcp-tools,result-expectation,path-claim}.schema.json` | Publish the complete, independently addressable strict JSON Schema 2020-12 authority without introducing state or artifact schemas. |
| Create | `test/unit/{review,adjudication,triage,supplemental,renderers,gates,errors,mcp-tools,contexts,path-claims}.test.ts` | Verify semantic derivation, capability barriers, exact coverage, deterministic rendering, decision/result correlation, registry exhaustiveness, and immutable context behavior. |
| Create | `test/contracts/{review-schema-agreement,authority-schema-agreement,mcp-contract-agreement}.test.ts`, `test/fixtures/contracts/{review,adjudication,triage,supplemental,gates,errors,mcp-tools}/**` | Exercise JSON Schema/Zod agreement, non-mutation, closed-shape negative corpora, all provenance/gate/supplemental variants, and cross-contract substitutions. |
| Modify | `scripts/smoke-temp-bundle.mjs` | Exercise representative Phase 2 parsing/rendering, both error registries, and all five definitions through the temporary ESM bundle. |

No `package.json`, lockfile, dependency policy, notice, CI, release-build script, `src/main.ts`, `src/mcp/`, `src/repository/`, `src/state/`, `src/dispatch/`, `src/decisions/`, `src/init/`, `src/local/`, `dist/`, live protocol fixture, install, registration, or skill file changes in this phase. No durable `state.json`, artifact/import/checkpoint/snapshot, receipt, decision-file, repository identity, or resolved-safe-path schema enters the Phase 2 schema tree.

The listed JSON Schemas cover only serializable public values: raw/derived/provenance evidence, external evidence references, authority-link data, triage candidates/results, gate request contexts and decision envelopes, error values, the five tool request/result contracts, and unbranded result-expectation data. `ObservationCapability`, `VerifiedReferencedEvidence`, branded `AuthorityLink`, qualified evidence, `CurrentReviewSetAuthority`, `CurrentReviewSet`, parsed-call/result brands, branded `ResultExpectation`, immutable connection/invocation objects, and `AbortSignal` are runtime-only values with no JSON representation; their underlying serializable link/context/expectation data is validated before a later owner mints the opaque runtime form.

## Contract Interfaces

### Evidence identities and trust ladder

The external wrapper is the only serializable value that pairs an evidence payload with its digest. It is deliberately non-self-referential: canonical repository code in Phase 4 computes the digest over `evidence`, not over the wrapper. Authority links and finding references may repeat that digest as an identity but never embed another evidence payload. Phase 2 validates digest syntax and compares identities but never claims to calculate repository-canonical bytes or currentness.

`Sha256Digest` has one canonical lexical representation: exactly 64 lowercase ASCII hexadecimal characters matching `^[0-9a-f]{64}$`, with no prefix, whitespace, or Unicode lookalikes. JSON Schema, Zod, and `parseSha256Digest` reject uppercase, `sha256:`-prefixed, padded, short, and long aliases.

```ts
declare const sha256DigestBrand: unique symbol;
export type Sha256Digest = string & { readonly [sha256DigestBrand]: true };
export function parseSha256Digest(value: unknown): Sha256Digest;

export interface ReferencedEvidence<T> {
  readonly evidence_digest: Sha256Digest;
  readonly evidence: T;
}

export type ReviewVerdict = "pass" | "advisory" | "fail";
export interface FindingRef {
  readonly review_evidence_digest: Sha256Digest;
  readonly finding_id: string;
}

export function parseAndDeriveReview(value: unknown): DerivedReview;
export function parseAndDeriveAdjudication(value: unknown): DerivedAdjudication;

export type ReviewEvidence =
  | AgentDeclaredReview
  | ServerAttestedReview
  | DegradedReview;
export type AdjudicationEvidence =
  | AgentDeclaredAdjudication
  | ServerAttestedAdjudication
  | DegradedAdjudication;
```

`RawReview` contains model/agent-authored findings and untrusted claims only. Derivation recomputes blocking count and verdict from closed finding severity/blocking semantics, rejects contradictions, and does not mutate input. `RawAdjudication` is similarly checked into `DerivedAdjudication`: it binds supplied subject, declared-input, pinned-constitution, approved-upstream, and source-evidence identities; retains per-rule/version compliance findings and every `enforced_by` state (`current`, `missing`, `stale`, `unknown`, `failed`, or `digest-mismatch`); and keeps constitution compliance, drift (`aligned`, `incidental`, or `material`), and matched/uncertain triggers independent. Missing or suspect mechanical evidence cannot be upgraded to compliance.

Both families then use distinct closed provenance variants. Agent-declared evidence records model/effort as declared values or `unknown`; server-attested evidence records adapter, CLI, canonical family/model, effort, invocation, envelope-input, observed-output, and result linkage derived from one observed envelope; degraded evidence records a reason and can never claim server assurance. Variant tags and fields cannot be substituted across families or assurance levels.

```ts
declare const observationCapabilityBrand: unique symbol;
declare const authorityLinkBrand: unique symbol;
declare const verifiedReferencedEvidenceBrand: unique symbol;
declare const currentReviewSetAuthorityBrand: unique symbol;

export type EvidenceKind = "review" | "adjudication";
export type Assurance = "agent-declared" | "server-attested" | "degraded";
export interface EvidenceValueByKindAndAssurance {
  readonly review: {
    readonly "agent-declared": AgentDeclaredReview;
    readonly "server-attested": ServerAttestedReview;
    readonly degraded: DegradedReview;
  };
  readonly adjudication: {
    readonly "agent-declared": AgentDeclaredAdjudication;
    readonly "server-attested": ServerAttestedAdjudication;
    readonly degraded: DegradedAdjudication;
  };
}
export interface EvidenceRoleByKind {
  readonly review: ReviewRole;
  readonly adjudication: "adjudication";
}
export interface ObservationRoleByKind {
  readonly review: "counter-review" | "gate-counter-review";
  readonly adjudication: "adjudication";
}
export type AdapterId = "claude-cli" | "codex-cli";
export type ModelFamily = "claude" | "codex";
export interface ObservationBindingBase<K extends EvidenceKind> {
  readonly kind: K;
  readonly task_id: string;
  readonly phase_instance: PhaseInstanceId;
  readonly role: ObservationRoleByKind[K];
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly invocation_id: string;
  readonly envelope_input_digest: Sha256Digest;
  readonly result_id: string;
  readonly adapter: AdapterId;
  readonly cli_version: string;
  readonly family: ModelFamily;
  readonly model: string;
  readonly effort: (typeof REASONING_EFFORTS)[number];
}
export interface ObservationBindingByKind {
  readonly review: ObservationBindingBase<"review"> & ({
    readonly role: "counter-review";
  } | {
    readonly role: "gate-counter-review";
    readonly gate_id: string;
  }) & {
    readonly rubric_digest: Sha256Digest;
    readonly producer_family: ModelFamily;
  };
  readonly adjudication: ObservationBindingBase<"adjudication"> & {
    readonly pinned_constitution_digest: Sha256Digest;
    readonly approved_upstream_digests: readonly Sha256Digest[];
    readonly source_evidence_set_digest: Sha256Digest;
  };
}
export type ObservationCapability<K extends EvidenceKind> = {
  readonly kind: K;
  readonly [observationCapabilityBrand]: K;
};
export type AdapterObservation<K extends EvidenceKind = EvidenceKind> = {
  readonly [P in K]: ObservationBindingByKind[P] & {
    readonly raw_output_bytes: Uint8Array;
    readonly raw_output_digest: Sha256Digest;
  };
}[K];
export interface ObservationSource {
  readonly observeReview: (
    capability: ObservationCapability<"review">,
    observed_output_bytes: Uint8Array
  ) => Readonly<{ observation: AdapterObservation<"review">; evidence: ServerAttestedReview }>;
  readonly observeAdjudication: (
    capability: ObservationCapability<"adjudication">,
    observed_output_bytes: Uint8Array
  ) => Readonly<{ observation: AdapterObservation<"adjudication">; evidence: ServerAttestedAdjudication }>;
}

export interface ServerAuthorityReferences {
  readonly kind: "server";
  readonly invocation_id: string;
  readonly result_id: string;
  readonly receipt_id: string;
  readonly state_revision: number;
  readonly envelope_input_digest: Sha256Digest;
  readonly observed_output_digest: Sha256Digest;
  readonly result_digest: Sha256Digest;
}
export interface AgentDeclaredAuthorityReferences {
  readonly kind: "agent-declared";
  readonly result_id: string;
  readonly result_digest: Sha256Digest;
  readonly state_revision: number;
}
export interface DegradedAuthorityReferences {
  readonly kind: "degraded";
  readonly checkpoint_digest: Sha256Digest;
  readonly checkpoint_revision: number;
}
export interface AuthorityReferencesByAssurance {
  readonly "agent-declared": AgentDeclaredAuthorityReferences;
  readonly "server-attested": ServerAuthorityReferences;
  readonly degraded: DegradedAuthorityReferences;
}
export interface AuthorityLinkBase<K extends EvidenceKind, A extends Assurance> {
  readonly schema_version: "1";
  readonly evidence_kind: K;
  readonly assurance: A;
  readonly role: EvidenceRoleByKind[K];
  readonly task_id: string;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly evidence_digest: Sha256Digest;
  readonly authority: AuthorityReferencesByAssurance[A];
}
export type AuthorityLinkData<
  K extends EvidenceKind = EvidenceKind,
  A extends Assurance = Assurance
> = { readonly [P in K]: { readonly [Q in A]: AuthorityLinkBase<P, Q> }[A] }[K];
export type AuthorityLink<
  K extends EvidenceKind = EvidenceKind,
  A extends Assurance = Assurance
> = { readonly [P in K]: {
  readonly [Q in A]: AuthorityLinkBase<P, Q> & {
    readonly [authorityLinkBrand]: `${P}:${Q}`;
  };
}[A] }[K];
export type VerifiedReferencedEvidence<
  K extends EvidenceKind = EvidenceKind,
  A extends Assurance = Assurance
> = { readonly [P in K]: {
  readonly [Q in A]: ReferencedEvidence<EvidenceValueByKindAndAssurance[P][Q]> & {
    readonly [verifiedReferencedEvidenceBrand]: `${P}:${Q}`;
  };
}[A] }[K];
export type ReviewEvidenceSlot =
  | Readonly<{
      role: "self-review";
      evidence_digest: Sha256Digest;
      assurance: "agent-declared";
      producer_family: ModelFamily;
      reviewer_family: ModelFamily;
      independence: "same-family-self";
    }>
  | Readonly<{
      role: "counter-review";
      evidence_digest: Sha256Digest;
      assurance: "server-attested" | "degraded";
      producer_family: ModelFamily;
      reviewer_family: ModelFamily;
      independence: "opposite-family";
    }>
  | Readonly<{
      role: "gate-counter-review";
      evidence_digest: Sha256Digest;
      assurance: "server-attested" | "degraded";
      producer_family: ModelFamily;
      reviewer_family: ModelFamily;
      independence: "opposite-family";
      gate_id: string;
    }>;
export type RequiredReviewSlots =
  | readonly [Extract<ReviewEvidenceSlot, { role: "self-review" }>, Extract<ReviewEvidenceSlot, { role: "counter-review" }>]
  | readonly [Extract<ReviewEvidenceSlot, { role: "self-review" }>, Extract<ReviewEvidenceSlot, { role: "counter-review" }>, Extract<ReviewEvidenceSlot, { role: "gate-counter-review" }>];
export interface CurrentReviewSetAuthority {
  readonly task_id: string;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly slots: RequiredReviewSlots;
  readonly [currentReviewSetAuthorityBrand]: true;
}
export interface CurrentEvidenceSetRef {
  readonly set_digest: Sha256Digest;
  readonly slots: RequiredReviewSlots;
}

export interface AuthorityQualifier {
  readonly qualifyReview: <A extends Assurance>(
    link: AuthorityLink<"review", A>,
    value: NoInfer<VerifiedReferencedEvidence<"review", A>>
  ) => QualifiedReviewEvidenceByAssurance[A];
  readonly qualifyAdjudication: <A extends Assurance>(
    link: AuthorityLink<"adjudication", A>,
    value: NoInfer<VerifiedReferencedEvidence<"adjudication", A>>
  ) => QualifiedAdjudicationEvidenceByAssurance[A];
  readonly currentReviews: (
    authority: CurrentReviewSetAuthority,
    reviews: readonly QualifiedReviewEvidence[]
  ) => CurrentReviewSet;
}
```

Later dispatch mints one `ObservationCapability<K>` from immutable `ObservationBindingByKind[K]`; the caller of `observe*` supplies only the output bytes actually read from that invocation. The trust module copies those bytes, computes `raw_output_digest` as SHA-256 over the exact unmodified byte sequence, parses/derives internally, and compares every model-supplied identity against the capability's expected bindings. Adjudication additionally compares the exact pinned constitution, sorted approved-upstream, and source-evidence-set identities. Review checks the rubric and producer/reviewer family relation; the observed role is closed to `counter-review` or gate-bound `gate-counter-review`, so this seam cannot mint a server-attested self-review. Self-review is agent-declared only. The resulting `AdapterObservation` and attestation therefore share one invocation scope; arbitrary adapter/family/effort strings or separately claimed digests cannot enter. The module never creates `ReferencedEvidence`; Phase 4's canonical-content authority hashes the derived evidence payload, creates the public wrapper, verifies wrapper/payload equality on read, and alone mints runtime-only `VerifiedReferencedEvidence<K,A>`.

`AuthorityLink` is scope-bound rather than a reusable global capability. Its mapped discriminants make evidence kind determine the legal role/value family and assurance determine the only legal authority-reference shape. Later state/checkpoint owners validate those references and mint a link for exactly one evidence digest, kind, role, task, phase, subject, and input fingerprint. Qualification requires both that matching link and Phase 4's `VerifiedReferencedEvidence<K,A>`, checks every scope field, preserves the provenance tag, and is idempotent for the identical link plus verified wrapper. Reuse with different bytes, digest, scope, or provenance fails; process-local consumption state is never authority. A separate `CurrentReviewSetAuthority` names the exact common scope and slot set described below. Current-set construction accepts that set exactly—never an arbitrary qualified array.

Public JSON, an altered payload under a retained digest, mutually consistent forged objects, independently supplied bindings, a link from another scope, or copied brand-shaped values cannot mint verified references, capabilities, authority links, qualified evidence, or a current set. Internal test factories are reachable only by direct internal test import and absent from `src/contracts/index.ts`. Phase 2 proves type/runtime correlation and replay/substitution rejection with those fixtures; it does not verify live dispatch observations, persisted receipts/state, manual checkpoint authority, repository digest bytes, or currentness.

The digest domains are closed and non-self-referential:

| Digest | Exact byte domain | Owner / exclusion |
|--------|-------------------|-------------------|
| `raw_output_digest` | Exact CLI stdout result bytes before parsing or newline normalization | Observation trust computes it; it excludes the observation and attestation. |
| `evidence_digest` | Phase 4 canonical JSON bytes of the derived provenance evidence payload only | Excludes `ReferencedEvidence`, authority links, result manifests, receipts, and state. |
| `result_digest` | Phase 4 canonical JSON bytes of the closed version-1 `ResultIdentityPayload<K>` defined below | Includes tool, task, intent, input fingerprint, request digest, result ID, resulting revision, and exact success; excludes its own digest, authority links, intent receipts, and state references. |
| `authority_link_digest` | Phase 4 canonical bytes of serializable `AuthorityLinkData` | The digest is carried only by `AuthorityLinkRef`, never inside `AuthorityLinkData`. |
| `context_digest` | Phase 4 canonical bytes of the kind-correlated gate context only | Excludes common `GateInput` fields, `gate_id`, and the decision envelope. |
| `request_digest` | The architecture's closed canonical request field list, including common request fields and context digest | Excludes `intent_id`, `expected_revision`, connection metadata, `gate_id`, decisions, receipts, and state. |

Retained result/receipt/state/checkpoint validators, not object identity or a consumed-token cache, establish replay authority after restart.

### Exact triage and canonical rendering

```ts
export type TriageDisposition = AcceptedDisposition | RejectedDisposition;
export function validateTriage(
  current: CurrentReviewSet,
  candidate: unknown
): ValidatedTriage;

export function renderReviewEvidence(value: QualifiedReviewEvidence): Uint8Array;
export function renderTriage(value: ValidatedTriage): Uint8Array;
export function renderAdjudicationEvidence(
  value: QualifiedAdjudicationEvidence
): Uint8Array;
```

`CurrentReviewSetAuthority.slots` is a canonical tuple ordered self, counter, then optional gate-counter. Roles are unique; self-review is same-family agent-declared, while counter and gate-counter slots are cross-family even when degraded, and a gate-counter slot binds the exact gate ID. The producer and reviewer families must differ for both counter slots. `CurrentEvidenceSetRef` is the serializable structured gate binding; bare or reordered digest arrays are invalid.

`validateTriage(CurrentReviewSet, unknown)` treats every finding from every required current slot as applicable, including advisory/non-blocking findings. It requires each `(review_evidence_digest, finding_id)` exactly once and rejects duplicate composite references, omissions, foreign reviews, stale-set identities, duplicate slots, and duplicate finding IDs within one review. Equal local IDs in different review digests are valid. A zero-finding pass has an empty disposition list; an advisory review dispositions all advisory findings. Rejected dispositions require evidence; accepted dispositions express revision-producing intent and do not authorize advancement.

Renderers accept only qualified evidence or branded validated triage—not raw, derived, or merely schema-valid public values. Each begins with the literal H1 and metadata keys below, in this order; optional values render as the literal `none`, never by omitting or reordering a key.

| Artifact | Literal H1 | Ordered metadata keys |
|----------|------------|-----------------------|
| Review | `# ArchFlow Review Evidence` | `schema_version`, `task_id`, `phase_instance`, `step`, `role`, `subject_digest`, `input_fingerprint`, `evidence_digest`, `verdict`, `blocking_count`, `matched_rule_versions`, `assurance`, `adapter`, `cli_version`, `model_family`, `model`, `effort`, `invocation_id`, `result_id` |
| Triage | `# ArchFlow Review Triage` | `schema_version`, `task_id`, `phase_instance`, `step`, `subject_digest`, `input_fingerprint`, `current_evidence_set_digest`, `source_evidence_digests`, `accepted_count`, `rejected_count` |
| Adjudication | `# ArchFlow Adjudication Evidence` | `schema_version`, `task_id`, `phase_instance`, `step`, `subject_digest`, `input_fingerprint`, `evidence_digest`, `pinned_constitution_digest`, `approved_upstream_digests`, `source_evidence_set_digest`, `constitution`, `drift`, `matched_rule_versions`, `uncertain_rule_versions`, `assurance`, `adapter`, `cli_version`, `model_family`, `model`, `effort`, `invocation_id`, `result_id` |

Trusted metadata is rendered as canonical scalar or JSON values beneath that header. Every untrusted prose field is emitted only as an indented canonical JSON string under a fixed trusted label; CR, LF, tab, C0/C1 controls, bidi controls, backticks, `<`, `>`, and `&` are visibly `\u`-escaped, so prose cannot create headings, tables, links, fences, or raw HTML. Collections use schema-defined canonical ordering, arrays render as canonical JSON, output is UTF-8 with LF line endings and exactly one terminal LF. Renderers preserve assurance distinctions and render from the qualified validated JSON value only; they do not parse Markdown, compute digests, query repository state, infer provenance, or decide currentness.

### Gate, waiver, and supplemental authority

`gate-contract.schema.json` is the one normative nine-kind catalogue. Each kind contains its exact context schema and decision variants; every decision variant carries its own `x-archflow-effect` annotation (`advance`, `retry`, `redirect-waiver`, `redirect-upstream`, or `non-advancing`). TypeScript, Zod, runtime effect lookup, and fixtures mirror and agreement-check that file; no parallel prose effect registry is authoritative. `GateInput` owns task, phase, subject, input fingerprint, and structured current evidence exactly once. Kind context contains only the fields below and never `gate_id`. The later gate service derives `gate_id` after hashing the closed request.

```ts
export interface RuleVersionRef { readonly rule_id: string; readonly rule_version: number }
export type EvidenceIdentityKind = "prd" | "architecture" | "phase-design" | "implementation-result" | "review" | "adjudication" | "constitution" | "workflow" | "import";
export interface EvidenceIdentityRef { readonly kind: EvidenceIdentityKind; readonly digest: Sha256Digest }
export type WaivableOperation = "review-trigger" | "adjudication-failure";
export interface WaiverScope { readonly operation: WaivableOperation; readonly boundary: "subject" | "phase" | "task" }
export interface HumanRuleResolution { readonly rule: RuleVersionRef; readonly resolution: string }
// PipelineStep is reused from Phase 1's src/contracts/vocabulary.ts.
export type HumanDecisionProvenance =
  | Readonly<{
      schema_version: "1";
      actor_class: "human" | "archforge";
      assurance: "declared-local-trace";
      channel: "connected-host";
      decision_event_id: string;
      connection_id: string;
      request_id_digest: Sha256Digest;
      recorded_at: string;
    }>
  | Readonly<{
      schema_version: "1";
      actor_class: "human" | "archforge";
      assurance: "declared-local-trace";
      channel: "archflow-local";
      decision_event_id: string;
      helper_invocation_id: string;
      recorded_at: string;
    }>;
export interface AuthorityLinkRef {
  readonly link_digest: Sha256Digest;
  readonly purpose: "restore-adoption";
  readonly proposed_generation_digest: Sha256Digest;
  readonly changed_input_fingerprint: Sha256Digest;
}

export interface GateContractByKind {
  readonly "artifact-approval": {
    readonly context: { readonly artifact_kind: "prd" | "design" | "phase-design" | "phase-implementation" };
    readonly decision:
      | { readonly decision: "approve"; readonly reason: string }
      | { readonly decision: "revise" | "reject"; readonly reason: string };
  };
  readonly "review-trigger": {
    readonly context: { readonly matched_rules: readonly RuleVersionRef[]; readonly uncertain_rules: readonly RuleVersionRef[]; readonly eligible_waiver_rules: readonly RuleVersionRef[]; readonly waiver_scope: WaiverScope };
    readonly decision:
      | { readonly decision: "approve"; readonly reason: string }
      | { readonly decision: "revise" | "reject"; readonly reason: string }
      | { readonly decision: "waiver-requested"; readonly reason: string; readonly rule: RuleVersionRef; readonly rationale: string };
  };
  readonly "material-drift": {
    readonly context: { readonly affected_upstream: EvidenceIdentityRef; readonly drift: "material"; readonly affected_claim_ids: readonly string[] };
    readonly decision: { readonly decision: "amend-upstream" | "revise-current" | "reject"; readonly reason: string };
  };
  readonly "adjudication-failure": {
    readonly context: { readonly constitution: "fail" | "uncertain"; readonly failed_rules: readonly RuleVersionRef[]; readonly uncertain_rules: readonly RuleVersionRef[]; readonly eligible_waiver_rules: readonly RuleVersionRef[]; readonly waiver_scope: WaiverScope };
    readonly decision:
      | { readonly decision: "approve"; readonly reason: string; readonly resolutions: readonly HumanRuleResolution[] }
      | { readonly decision: "revise" | "reject"; readonly reason: string }
      | { readonly decision: "waiver-requested"; readonly reason: string; readonly rule: RuleVersionRef; readonly rationale: string };
  };
  readonly "attempts-exhausted": {
    readonly context: { readonly step: PipelineStep; readonly attempts: number; readonly maximum_attempts: number };
    readonly decision: { readonly decision: "retry-once" | "revise" | "abort"; readonly reason: string };
  };
  readonly "constitution-edit": {
    readonly context: { readonly pinned_constitution_digest: Sha256Digest; readonly current_constitution_digest: Sha256Digest; readonly changed_path_class: "task-branch-constitution" };
    readonly decision: { readonly decision: "revert-edit" | "start-base-amendment" | "abort"; readonly reason: string };
  };
  readonly "commit-authorization": {
    readonly context: { readonly target_ref: string; readonly diff_digest: Sha256Digest; readonly current_artifact_digests: readonly Sha256Digest[]; readonly parent_document_digests: readonly Sha256Digest[] };
    readonly decision:
      | { readonly decision: "authorize-commit"; readonly reason: string }
      | { readonly decision: "revise" | "abort"; readonly reason: string };
  };
  readonly "restore-collision": {
    readonly context: { readonly path: TaskPathClaim; readonly recorded_generation_digest: Sha256Digest; readonly current_generation_digest: Sha256Digest; readonly adoption_candidate?: AuthorityLinkRef };
    readonly decision:
      | { readonly decision: "discard-and-restore" | "abort"; readonly reason: string }
      | { readonly decision: "adopt-as-new-generation"; readonly reason: string; readonly adoption_authority: AuthorityLinkRef; readonly rationale: string };
  };
  readonly "migration-audit": {
    readonly context: { readonly source_identity_digest: Sha256Digest; readonly destination_identity_digest: Sha256Digest; readonly import_digest: Sha256Digest; readonly code_baseline_digest: Sha256Digest; readonly policy_baseline_digest: Sha256Digest };
    readonly decision:
      | { readonly decision: "accept-import-audit"; readonly reason: string }
      | { readonly decision: "revise" | "abort"; readonly reason: string };
  };
}
export type GateKind = keyof GateContractByKind;
export type GateContext<K extends GateKind> = GateContractByKind[K]["context"];
export type GateDecisionPayload<K extends GateKind> = GateContractByKind[K]["decision"];
export type GateEffect = "advance" | "retry" | "redirect-waiver" | "redirect-upstream" | "non-advancing";

export interface GateDecisionEnvelopeBase {
  readonly schema_version: "1";
  readonly gate_id: string;
  readonly task_id: string;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
  readonly human_provenance: HumanDecisionProvenance;
}
export type GateDecisionEnvelope<K extends GateKind = GateKind> = {
  readonly [P in K]: GateDecisionEnvelopeBase & { readonly kind: P; readonly payload: GateDecisionPayload<P> };
}[K];

export interface WaiverOriginRef {
  readonly origin_gate_id: string;
  readonly origin_decision_digest: Sha256Digest;
  readonly origin_context_digest: Sha256Digest;
  readonly task_id: string;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly current_evidence_set_digest: Sha256Digest;
  readonly rule: RuleVersionRef;
  readonly scope: WaiverScope;
}
export interface SupplementalGateRef {
  readonly prior_gate_id: string;
  readonly task_id: string;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
}
export interface SupplementalReviewRef extends SupplementalGateRef {
  readonly evidence_slot: Extract<ReviewEvidenceSlot, { role: "gate-counter-review" }>;
}
export interface GateSupersessionRef {
  readonly superseded_gate_id: string;
  readonly accepted_triage_digest: Sha256Digest;
  readonly old_subject_digest: Sha256Digest;
}
export type SupplementalReviewOutcome =
  | { readonly action: "decline"; readonly gate: SupplementalGateRef; readonly reason: string }
  | { readonly action: "ingest"; readonly review: SupplementalReviewRef; readonly reason: string }
  | { readonly action: "triage-no-change"; readonly review: SupplementalReviewRef; readonly triage_digest: Sha256Digest; readonly reason: string }
  | { readonly action: "supersede"; readonly review: SupplementalReviewRef; readonly accepted_triage_digest: Sha256Digest; readonly old_subject_digest: Sha256Digest; readonly new_subject_digest: Sha256Digest; readonly reason: string };
```

Arrays are canonical sorted unique sets. `eligible_waiver_rules` is a subset of the matched/uncertain rules, adjudication resolutions cover exactly every failed/uncertain rule not redirected to waiver, `attempts >= maximum_attempts`, and `retry-once` authorizes exactly one additional attempt. `HumanDecisionProvenance` lives in `gate-decision.schema.json`; IDs use bounded identifier syntax and `recorded_at` is canonical UTC RFC 3339 with milliseconds. The later gate owner mints it from an actual connected-host submission or validated `archflow-local` invocation, retaining the submitter's declared actor class (`human` or `archforge`) and local traceability only. It never claims cryptographic or independently verified human identity; authorization policy evaluates the exact pending gate and accepted actor class. Public JSON carrying the same fields has no authority. The provenance is an immutable part of the envelope: replay of the identical retained `decision_event_id` must have identical actor/channel-specific fields and payload, while reuse with any changed gate, payload, time, connection/request, or helper invocation is rejected. The retained `GateDecisionEnvelope` is therefore the sole explicit-decision evidence; no orphan evidence digest exists. Commit authorization's outer subject is the implementation-output result identity, while its context binds the exact final diff, current artifact set, and parent documents. Mandatory artifact approval is never waivable. Restore adoption requires the context candidate and decision reference to match exactly.

Waiver sequencing is separately exact. `WaiverOriginRef` binds the archived origin gate, decision, context, subject, evidence set, and selected rule/scope; `WaiverInput` carries that reference plus rationale and repeats no free authority. The later gate owner verifies the archived `waiver-requested` payload selected the same rule and scope. `WaiverSuccess` distinguishes `origin_gate_id` from the newly derived `waiver_gate_id`; grant and denial retain the same subject/evidence/rule/scope/provenance binding, and denial is a successful explicit decision rather than an error.

Supplemental review separates a gate-only `SupplementalGateRef` from evidence-bearing `SupplementalReviewRef`; an explicit decline therefore records no fabricated review slot or digest. Evidence-bearing actions require a gate-counter slot whose `gate_id` equals `prior_gate_id`. `triage-no-change` cites its validated triage. An accepted change is represented directly by `supersede`: it closes the prior gate non-advancing and records the accepted triage and old/new subject pair, with `old_subject_digest === review.subject_digest` and `new_subject_digest !== old_subject_digest`; it does not predict a future gate ID. If the rerun later creates a gate for the new subject, that new `GateInput` carries `GateSupersessionRef` back to this prior gate/triage/old subject, with its outer `subject_digest` equal to the recorded new subject. These values live in `supplemental-review.schema.json`, cannot enter `GateDecisionPayload`, and become runtime behavior only in later gate/state owners. Cancellation remains a lifecycle outcome, not a decision.

### Error registries

```ts
export type ErrorOwner =
  | "contracts" | "config" | "repository" | "paths" | "policy"
  | "state" | "intent" | "snapshot" | "gate" | "routing"
  | "dispatch" | "sandbox" | "protocol" | "integrity";
export type ErrorProjection = "project" | "protocol";
// Table notation: SafeId is 1–128 ASCII `[A-Za-z0-9][A-Za-z0-9._:-]*`;
// SafeCode is 1–64 lowercase `[a-z0-9][a-z0-9_-]*`; SafeVersion is 1–64
// ASCII alphanumeric/dot/hyphen characters; SafeInteger is 0..Number.MAX_SAFE_INTEGER.
export interface StrictParameterParser<P extends Readonly<Record<string, unknown>>> {
  readonly parse: (value: unknown) => P;
}
export interface ErrorDefinition<
  P extends Readonly<Record<string, unknown>>,
  O extends ErrorOwner,
  R extends boolean,
  A extends string,
  X extends ErrorProjection
> {
  readonly owner: O;
  readonly retryable: R;
  readonly parameter_parser: StrictParameterParser<P>;
  readonly action: A;
  readonly projection: X;
}
export type CompleteErrorRegistry<
  C extends string,
  O extends ErrorOwner,
  X extends ErrorProjection
> = Readonly<{
  [K in C]: ErrorDefinition<Readonly<Record<string, unknown>>, O, boolean, string, X>;
}>;
export type ProjectErrorCode =
  | "CONTRACT_INVALID" | "RESULT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED"
  | "WORKFLOW_INVALID" | "CONFIG_INVALID" | "CONFIG_MODEL_UNSUPPORTED"
  | "CONFIG_FAMILY_UNSUPPORTED" | "RUNTIME_VERSION_UNSUPPORTED"
  | "REPOSITORY_NOT_FOUND" | "REPOSITORY_MISMATCH" | "TASK_INVALID"
  | "PATH_INVALID" | "PATH_ESCAPE" | "TASK_SCOPE_VIOLATION"
  | "GIT_CONFLICT" | "GIT_DIVERGED" | "HANDOFF_REQUIRED"
  | "POLICY_BASE_INVALID" | "WORKFLOW_MISMATCH" | "PINNED_CONFIG_MISMATCH" | "STALE_SKILLS"
  | "STATE_MISSING" | "STATE_INVALID" | "TRANSITION_INVALID" | "INPUT_FINGERPRINT_MISMATCH"
  | "STATE_CONFLICT" | "SUPPLEMENTAL_REVIEW_REQUIRED" | "INTENT_MISMATCH"
  | "SNAPSHOT_LIMIT" | "SNAPSHOT_INVALID" | "RESTORE_COLLISION" | "RECONCILIATION_REQUIRED" | "SECRET_DETECTED"
  | "GATE_ACTIVE" | "GATE_DECISION_INVALID" | "GATE_CANCELLED"
  | "UNSUPPORTED_HOST" | "UNSUPPORTED_MODEL" | "FAMILY_MISMATCH"
  | "CLI_VERSION_UNSUPPORTED" | "AUTH_UNAVAILABLE" | "CLI_MISSING"
  | "SANDBOX_UNAVAILABLE" | "SANDBOX_PROBE_FAILED"
  | "RATE_LIMITED" | "TIMEOUT" | "CANCELLED" | "MODEL_OUTPUT_INVALID" | "IO_ERROR"
  | "OUTPUT_OVERFLOW" | "PROCESS_FAILED" | "INTERNAL_ERROR";
export type ProtocolErrorCode =
  | "TOOL_NOT_FOUND" | "TOOL_DISABLED" | "UNSUPPORTED_PROTOCOL" | "INITIALIZATION_REPEATED";
declare function defineError<
  P extends Readonly<Record<string, unknown>>,
  O extends ErrorOwner,
  R extends boolean,
  A extends string,
  X extends ErrorProjection
>(owner: O, retryable: R, parser: StrictParameterParser<P>, action: A, projection: X): ErrorDefinition<P, O, R, A, X>;
export const PROJECT_ERROR_DEFINITIONS = {
  CONTRACT_INVALID: defineError("contracts", false, CONTRACT_INVALID_PARAMETERS, "correct-contract", "project"),
  RESULT_INVALID: defineError("integrity", false, RESULT_INVALID_PARAMETERS, "repair-retained-result", "project"),
  CONTRACT_VERSION_UNSUPPORTED: defineError("contracts", false, CONTRACT_VERSION_UNSUPPORTED_PARAMETERS, "upgrade-caller", "project"),
  WORKFLOW_INVALID: defineError("config", false, WORKFLOW_INVALID_PARAMETERS, "repair-workflow", "project"),
  CONFIG_INVALID: defineError("config", false, CONFIG_INVALID_PARAMETERS, "repair-config", "project"),
  CONFIG_MODEL_UNSUPPORTED: defineError("config", false, CONFIG_MODEL_UNSUPPORTED_PARAMETERS, "select-supported-model", "project"),
  CONFIG_FAMILY_UNSUPPORTED: defineError("config", false, CONFIG_FAMILY_UNSUPPORTED_PARAMETERS, "select-supported-family", "project"),
  RUNTIME_VERSION_UNSUPPORTED: defineError("config", false, RUNTIME_VERSION_UNSUPPORTED_PARAMETERS, "upgrade-runtime", "project"),
  REPOSITORY_NOT_FOUND: defineError("repository", false, REPOSITORY_NOT_FOUND_PARAMETERS, "open-repository", "project"),
  REPOSITORY_MISMATCH: defineError("repository", false, REPOSITORY_MISMATCH_PARAMETERS, "reopen-task-worktree", "project"),
  TASK_INVALID: defineError("repository", false, TASK_INVALID_PARAMETERS, "repair-task", "project"),
  PATH_INVALID: defineError("paths", false, PATH_INVALID_PARAMETERS, "use-valid-path-claim", "project"),
  PATH_ESCAPE: defineError("paths", false, PATH_ESCAPE_PARAMETERS, "use-task-relative-path", "project"),
  TASK_SCOPE_VIOLATION: defineError("paths", false, TASK_SCOPE_VIOLATION_PARAMETERS, "use-task-scoped-path", "project"),
  GIT_CONFLICT: defineError("repository", false, GIT_CONFLICT_PARAMETERS, "resolve-git-conflict", "project"),
  GIT_DIVERGED: defineError("repository", false, GIT_DIVERGED_PARAMETERS, "reconcile-git-history", "project"),
  HANDOFF_REQUIRED: defineError("repository", false, HANDOFF_REQUIRED_PARAMETERS, "complete-clean-handoff", "project"),
  POLICY_BASE_INVALID: defineError("policy", false, POLICY_BASE_INVALID_PARAMETERS, "restore-policy-base", "project"),
  WORKFLOW_MISMATCH: defineError("policy", false, WORKFLOW_MISMATCH_PARAMETERS, "restore-pinned-workflow", "project"),
  PINNED_CONFIG_MISMATCH: defineError("policy", false, PINNED_CONFIG_MISMATCH_PARAMETERS, "restore-pinned-config", "project"),
  STALE_SKILLS: defineError("policy", false, STALE_SKILLS_PARAMETERS, "refresh-skills", "project"),
  STATE_MISSING: defineError("state", false, STATE_MISSING_PARAMETERS, "initialize-state", "project"),
  STATE_INVALID: defineError("state", false, STATE_INVALID_PARAMETERS, "repair-state", "project"),
  TRANSITION_INVALID: defineError("state", false, TRANSITION_INVALID_PARAMETERS, "select-valid-transition", "project"),
  INPUT_FINGERPRINT_MISMATCH: defineError("state", false, INPUT_FINGERPRINT_MISMATCH_PARAMETERS, "create-fresh-intent", "project"),
  STATE_CONFLICT: defineError("state", true, STATE_CONFLICT_PARAMETERS, "reread-and-retry-intent", "project"),
  SUPPLEMENTAL_REVIEW_REQUIRED: defineError("state", false, SUPPLEMENTAL_REVIEW_REQUIRED_PARAMETERS, "triage-supplemental-review", "project"),
  INTENT_MISMATCH: defineError("intent", false, INTENT_MISMATCH_PARAMETERS, "create-fresh-intent", "project"),
  SNAPSHOT_LIMIT: defineError("snapshot", false, SNAPSHOT_LIMIT_PARAMETERS, "reduce-snapshot", "project"),
  SNAPSHOT_INVALID: defineError("snapshot", false, SNAPSHOT_INVALID_PARAMETERS, "repair-snapshot", "project"),
  RESTORE_COLLISION: defineError("snapshot", false, RESTORE_COLLISION_PARAMETERS, "resolve-restore-gate", "project"),
  RECONCILIATION_REQUIRED: defineError("snapshot", false, RECONCILIATION_REQUIRED_PARAMETERS, "run-reconciliation", "project"),
  SECRET_DETECTED: defineError("snapshot", false, SECRET_DETECTED_PARAMETERS, "remove-secret", "project"),
  GATE_ACTIVE: defineError("gate", false, GATE_ACTIVE_PARAMETERS, "resolve-recorded-gate", "project"),
  GATE_DECISION_INVALID: defineError("gate", false, GATE_DECISION_INVALID_PARAMETERS, "record-valid-gate-decision", "project"),
  GATE_CANCELLED: defineError("gate", false, GATE_CANCELLED_PARAMETERS, "restart-gate-flow", "project"),
  UNSUPPORTED_HOST: defineError("routing", false, UNSUPPORTED_HOST_PARAMETERS, "select-supported-host", "project"),
  UNSUPPORTED_MODEL: defineError("routing", false, UNSUPPORTED_MODEL_PARAMETERS, "select-supported-model", "project"),
  FAMILY_MISMATCH: defineError("routing", false, FAMILY_MISMATCH_PARAMETERS, "select-correct-family", "project"),
  CLI_VERSION_UNSUPPORTED: defineError("dispatch", false, CLI_VERSION_UNSUPPORTED_PARAMETERS, "upgrade-cli", "project"),
  AUTH_UNAVAILABLE: defineError("dispatch", false, AUTH_UNAVAILABLE_PARAMETERS, "repair-authentication", "project"),
  CLI_MISSING: defineError("dispatch", false, CLI_MISSING_PARAMETERS, "install-cli", "project"),
  SANDBOX_UNAVAILABLE: defineError("sandbox", false, SANDBOX_UNAVAILABLE_PARAMETERS, "repair-sandbox", "project"),
  SANDBOX_PROBE_FAILED: defineError("sandbox", false, SANDBOX_PROBE_FAILED_PARAMETERS, "repair-sandbox", "project"),
  RATE_LIMITED: defineError("dispatch", true, RATE_LIMITED_PARAMETERS, "retry-after-backoff", "project"),
  TIMEOUT: defineError("dispatch", true, TIMEOUT_PARAMETERS, "retry-unchanged-attempt", "project"),
  CANCELLED: defineError("dispatch", true, CANCELLED_PARAMETERS, "restart-child-attempt", "project"),
  MODEL_OUTPUT_INVALID: defineError("dispatch", true, MODEL_OUTPUT_INVALID_PARAMETERS, "retry-unchanged-attempt", "project"),
  IO_ERROR: defineError("dispatch", true, IO_ERROR_PARAMETERS, "retry-unchanged-attempt", "project"),
  OUTPUT_OVERFLOW: defineError("dispatch", false, OUTPUT_OVERFLOW_PARAMETERS, "reduce-output", "project"),
  PROCESS_FAILED: defineError("dispatch", false, PROCESS_FAILED_PARAMETERS, "repair-before-fresh-attempt", "project"),
  INTERNAL_ERROR: defineError("integrity", false, INTERNAL_ERROR_PARAMETERS, "stop-and-inspect", "project"),
} as const satisfies CompleteErrorRegistry<ProjectErrorCode, ErrorOwner, "project">;
export const PROTOCOL_ERROR_DEFINITIONS = {
  TOOL_NOT_FOUND: defineError("protocol", false, TOOL_NOT_FOUND_PARAMETERS, "call-advertised-tool", "protocol"),
  TOOL_DISABLED: defineError("protocol", false, TOOL_DISABLED_PARAMETERS, "wait-for-tool-enable", "protocol"),
  UNSUPPORTED_PROTOCOL: defineError("protocol", false, UNSUPPORTED_PROTOCOL_PARAMETERS, "negotiate-supported-protocol", "protocol"),
  INITIALIZATION_REPEATED: defineError("protocol", false, INITIALIZATION_REPEATED_PARAMETERS, "open-new-connection", "protocol"),
} as const satisfies CompleteErrorRegistry<ProtocolErrorCode, "protocol", "protocol">;
export type ProjectErrorDefinitionByCode = typeof PROJECT_ERROR_DEFINITIONS;
export type ProtocolErrorDefinitionByCode = typeof PROTOCOL_ERROR_DEFINITIONS;
export type ErrorValue<R, K extends keyof R> = Readonly<{
  schema_version: "1";
  code: K;
  owner: R[K] extends ErrorDefinition<any, infer O, any, any, any> ? O : never;
  retryable: R[K] extends ErrorDefinition<any, any, infer B, any, any> ? B : never;
  diagnostic: Readonly<{
    template_id: K;
    parameters: R[K] extends ErrorDefinition<infer P, any, any, any, any> ? P : never;
  }>;
  next_action: R[K] extends ErrorDefinition<any, any, any, infer A, any> ? A : never;
}>;
export type ProjectError = {
  readonly [K in ProjectErrorCode]: ErrorValue<ProjectErrorDefinitionByCode, K>;
}[ProjectErrorCode];
export type ProtocolError = {
  readonly [K in ProtocolErrorCode]: ErrorValue<ProtocolErrorDefinitionByCode, K>;
}[ProtocolErrorCode];
export type ProjectResult<T> =
  | { readonly schema_version: "1"; readonly ok: true; readonly value: T }
  | { readonly schema_version: "1"; readonly ok: false; readonly error: ProjectError };
```

`ProjectErrorCode` and `ProtocolErrorCode` are distinct, non-overlapping literal unions. The implementation transcribes every row below into the two source objects using `as const satisfies CompleteErrorRegistry<ProjectErrorCode, ErrorOwner, "project">` and `as const satisfies CompleteErrorRegistry<ProtocolErrorCode, "protocol", "protocol">`, without a widening annotation; `ProjectErrorDefinitionByCode` and `ProtocolErrorDefinitionByCode` are inferred from those objects. Missing/extra keys fail `satisfies`, while code-specific owner/retryability/parser/action/projection literals remain correlated in `ErrorValue`. Each `parameter_parser` is a strict non-transforming parser for its row's closed parameter object; definitions never carry a duplicate example `parameters` value. The two objects are recursively frozen after construction. The following rows are exhaustive and specify each literal property independently. Braced parameter shapes use only the bounded table primitives defined above or named contract types and never accept arbitrary exception text, paths, peer input, stdout, or stderr.

| Code | Owner | Retryable | Exact safe parameters | Action | Projection |
|------|-------|-----------|-----------------------|--------|------------|
| `CONTRACT_INVALID` | contracts | false | `{tool?: ToolName, issue_code: SafeCode, schema_version?: SafeVersion}` | `correct-contract` | project |
| `RESULT_INVALID` | integrity | false | `{tool: ToolName, result_id: SafeId, expected_digest?: Sha256Digest, observed_digest?: Sha256Digest}` | `repair-retained-result` | project |
| `CONTRACT_VERSION_UNSUPPORTED` | contracts | false | `{schema_version: SafeVersion, supported_version: SafeVersion}` | `upgrade-caller` | project |
| `WORKFLOW_INVALID` | config | false | `{issue_code: SafeCode}` | `repair-workflow` | project |
| `CONFIG_INVALID` | config | false | `{issue_code: SafeCode}` | `repair-config` | project |
| `CONFIG_MODEL_UNSUPPORTED` | config | false | `{model: SafeId}` | `select-supported-model` | project |
| `CONFIG_FAMILY_UNSUPPORTED` | config | false | `{family: SafeId}` | `select-supported-family` | project |
| `RUNTIME_VERSION_UNSUPPORTED` | config | false | `{component: SafeId, version: SafeVersion}` | `upgrade-runtime` | project |
| `REPOSITORY_NOT_FOUND` | repository | false | `{repository_candidate_digest: Sha256Digest}` | `open-repository` | project |
| `REPOSITORY_MISMATCH` | repository | false | `{expected_digest: Sha256Digest, observed_digest: Sha256Digest}` | `reopen-task-worktree` | project |
| `TASK_INVALID` | repository | false | `{task_id: SafeId, issue_code: SafeCode}` | `repair-task` | project |
| `PATH_INVALID` | paths | false | `{task_id: SafeId, path_class: SafeCode}` | `use-valid-path-claim` | project |
| `PATH_ESCAPE` | paths | false | `{task_id: SafeId, path_class: SafeCode}` | `use-task-relative-path` | project |
| `TASK_SCOPE_VIOLATION` | paths | false | `{task_id: SafeId, path_class: SafeCode}` | `use-task-scoped-path` | project |
| `GIT_CONFLICT` | repository | false | `{operation: SafeCode}` | `resolve-git-conflict` | project |
| `GIT_DIVERGED` | repository | false | `{expected_digest: Sha256Digest, observed_digest: Sha256Digest}` | `reconcile-git-history` | project |
| `HANDOFF_REQUIRED` | repository | false | `{phase_instance: PhaseInstanceId}` | `complete-clean-handoff` | project |
| `POLICY_BASE_INVALID` | policy | false | `{expected_digest: Sha256Digest, observed_digest?: Sha256Digest}` | `restore-policy-base` | project |
| `WORKFLOW_MISMATCH` | policy | false | `{expected_digest: Sha256Digest, observed_digest: Sha256Digest}` | `restore-pinned-workflow` | project |
| `PINNED_CONFIG_MISMATCH` | policy | false | `{expected_digest: Sha256Digest, observed_digest: Sha256Digest}` | `restore-pinned-config` | project |
| `STALE_SKILLS` | policy | false | `{expected_digest: Sha256Digest, observed_digest: Sha256Digest}` | `refresh-skills` | project |
| `STATE_MISSING` | state | false | `{phase_instance: PhaseInstanceId}` | `initialize-state` | project |
| `STATE_INVALID` | state | false | `{phase_instance: PhaseInstanceId, issue_code: SafeCode}` | `repair-state` | project |
| `TRANSITION_INVALID` | state | false | `{phase_instance: PhaseInstanceId, from: SafeCode, to: SafeCode}` | `select-valid-transition` | project |
| `INPUT_FINGERPRINT_MISMATCH` | state | false | `{expected_digest: Sha256Digest, observed_digest: Sha256Digest}` | `create-fresh-intent` | project |
| `STATE_CONFLICT` | state | true | `{expected_revision: SafeInteger, observed_revision: SafeInteger}` | `reread-and-retry-intent` | project |
| `SUPPLEMENTAL_REVIEW_REQUIRED` | state | false | `{gate_id: SafeId, evidence_digest: Sha256Digest}` | `triage-supplemental-review` | project |
| `INTENT_MISMATCH` | intent | false | `{expected_digest: Sha256Digest, observed_digest: Sha256Digest}` | `create-fresh-intent` | project |
| `SNAPSHOT_LIMIT` | snapshot | false | `{limit_scope: "result" | "task", offending_paths: nonempty readonly TaskPathClaim[] (all exact offending paths, sorted unique), current_bytes: SafeInteger, byte_cap: SafeInteger}` | `reduce-snapshot` | project |
| `SNAPSHOT_INVALID` | snapshot | false | `{snapshot_digest: Sha256Digest, issue_code: SafeCode}` | `repair-snapshot` | project |
| `RESTORE_COLLISION` | snapshot | false | `{gate_id: SafeId, path_class: SafeCode}` | `resolve-restore-gate` | project |
| `RECONCILIATION_REQUIRED` | snapshot | false | `{recorded_digest: Sha256Digest, observed_digest: Sha256Digest}` | `run-reconciliation` | project |
| `SECRET_DETECTED` | snapshot | false | `{path_class: SafeCode, detector_id: SafeId}` | `remove-secret` | project |
| `GATE_ACTIVE` | gate | false | `{gate_id: SafeId, gate_kind: GateKind}` | `resolve-recorded-gate` | project |
| `GATE_DECISION_INVALID` | gate | false | `{gate_id: SafeId, gate_kind: GateKind, issue_code: SafeCode}` | `record-valid-gate-decision` | project |
| `GATE_CANCELLED` | gate | false | `{gate_id: SafeId, gate_kind: GateKind}` | `restart-gate-flow` | project |
| `UNSUPPORTED_HOST` | routing | false | `{host: SafeId}` | `select-supported-host` | project |
| `UNSUPPORTED_MODEL` | routing | false | `{model: SafeId}` | `select-supported-model` | project |
| `FAMILY_MISMATCH` | routing | false | `{expected_family: ModelFamily, observed_family: ModelFamily}` | `select-correct-family` | project |
| `CLI_VERSION_UNSUPPORTED` | dispatch | false | `{adapter: AdapterId, version: SafeVersion}` | `upgrade-cli` | project |
| `AUTH_UNAVAILABLE` | dispatch | false | `{adapter: AdapterId}` | `repair-authentication` | project |
| `CLI_MISSING` | dispatch | false | `{adapter: AdapterId}` | `install-cli` | project |
| `SANDBOX_UNAVAILABLE` | sandbox | false | `{capability: SafeId}` | `repair-sandbox` | project |
| `SANDBOX_PROBE_FAILED` | sandbox | false | `{capability: SafeId, failure_class: SafeCode}` | `repair-sandbox` | project |
| `RATE_LIMITED` | dispatch | true | `{adapter: AdapterId, attempt: SafeInteger}` | `retry-after-backoff` | project |
| `TIMEOUT` | dispatch | true | `{adapter: AdapterId, attempt: SafeInteger, limit_ms: SafeInteger}` | `retry-unchanged-attempt` | project |
| `CANCELLED` | dispatch | true | `{source: "client" | "transport", attempt: SafeInteger}` | `restart-child-attempt` | project |
| `MODEL_OUTPUT_INVALID` | dispatch | true | `{adapter: AdapterId, attempt: SafeInteger, issue_code: SafeCode}` | `retry-unchanged-attempt` | project |
| `IO_ERROR` | dispatch | true | `{operation: SafeCode, attempt: SafeInteger}` | `retry-unchanged-attempt` | project |
| `OUTPUT_OVERFLOW` | dispatch | false | `{adapter: AdapterId, byte_count: SafeInteger, byte_cap: SafeInteger}` | `reduce-output` | project |
| `PROCESS_FAILED` | dispatch | false | `{adapter: AdapterId, exit_class: SafeCode}` | `repair-before-fresh-attempt` | project |
| `INTERNAL_ERROR` | integrity | false | `{correlation_id: SafeId}` | `stop-and-inspect` | project |
| `TOOL_NOT_FOUND` | protocol | false | `{tool_name_digest: Sha256Digest}` | `call-advertised-tool` | protocol |
| `TOOL_DISABLED` | protocol | false | `{tool: ToolName, lifecycle_state: SafeCode}` | `wait-for-tool-enable` | protocol |
| `UNSUPPORTED_PROTOCOL` | protocol | false | `{offered_version: SafeVersion, supported_version: SafeVersion}` | `negotiate-supported-protocol` | protocol |
| `INITIALIZATION_REPEATED` | protocol | false | `{connection_id: SafeId}` | `open-new-connection` | protocol |

Standard MCP/JSON-RPC parse, invalid-request, invalid-params, internal-error, method-not-found, and request-cancelled values are SDK-owned wire errors and are intentionally not duplicated in the ArchFlow registries. The adapter mapping is fixed: malformed JSON/JSON-RPC maps to the corresponding SDK error; an unknown tool maps to `TOOL_NOT_FOUND`; a known tool with invalid Phase 2 input returns project `CONTRACT_INVALID`; a disabled tool maps to `TOOL_DISABLED`; repeated initialization maps to `INITIALIZATION_REPEATED`; a malformed or cross-correlated handler result is logged and projected as safe project `INTERNAL_ERROR`; client/transport cancellation also drives SDK request cancellation while a spawned child attempt records project `CANCELLED`; durable gate cancellation alone records `GATE_CANCELLED`. Waiver denial remains a successful `WaiverSuccess`, never an error. Protocol diagnostics never include a raw unknown tool name or arbitrary peer input. Registry mutation and constructor/parser tests fail on overlap, wrong code-specific parameters, a missing/extra code, wrong owner/retryability/action, arbitrary interpolation, or illegal projection.

### Correlated tool contracts and transport-neutral contexts

```ts
declare const taskPathClaimBrand: unique symbol;
export type TaskPathClaim = string & { readonly [taskPathClaimBrand]: true };
export function parseTaskPathClaim(value: unknown): TaskPathClaim;

export interface CommonToolInput {
  readonly schema_version: "1";
  readonly task_id: string;
  readonly intent_id: string;
  readonly expected_revision: number;
  readonly input_fingerprint: Sha256Digest;
}

export interface StateInput extends CommonToolInput {
  readonly phase_instance: PhaseInstanceId;
  readonly step: "produce" | "self_review" | "counter_review" | "triage" | "adjudicate";
  readonly status: "running" | "succeeded" | "failed";
  // `artifact` is intentionally absent and rejected by the closed schema.
}
export interface StateSuccess {
  readonly path: TaskPathClaim;
  readonly revision: number;
  readonly status: StateInput["status"];
}
export interface CounterReviewInput extends CommonToolInput {
  readonly artifact_path: TaskPathClaim;
  readonly rubric: RubricV1;
}
export interface CounterReviewSuccess {
  readonly path: TaskPathClaim;
  readonly verdict: ReviewVerdict;
  readonly blocking_count: number;
  readonly revision: number;
}
export interface AdjudicateInput extends CommonToolInput {
  readonly artifact_path: TaskPathClaim;
  readonly upstream_paths: readonly TaskPathClaim[];
}
export interface AdjudicateSuccess {
  readonly path: TaskPathClaim;
  readonly constitution: ConstitutionResult;
  readonly drift: DriftResult;
  readonly triggers: readonly RuleVersionRef[];
  readonly revision: number;
}
export type GateInput = {
  readonly [K in GateKind]: CommonToolInput & {
    readonly phase_instance: PhaseInstanceId;
    readonly summary: string;
    readonly subject_digest: Sha256Digest;
    readonly current_evidence: CurrentEvidenceSetRef;
    readonly supersedes?: GateSupersessionRef;
    readonly kind: K;
    readonly context: GateContext<K>;
  }
}[GateKind];
export type GateSuccess = {
  readonly [K in GateKind]: {
    readonly kind: K;
    readonly decision: GateDecisionEnvelope<K>;
    readonly notes: string;
    readonly revision: number;
  }
}[GateKind];
export interface WaiverInput extends CommonToolInput {
  readonly origin: WaiverOriginRef;
  readonly rationale: string;
}
export interface WaiverDecisionBinding {
  readonly origin_gate_id: string;
  readonly waiver_gate_id: string;
  readonly task_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly subject_digest: Sha256Digest;
  readonly current_evidence_set_digest: Sha256Digest;
  readonly scope: WaiverScope;
  readonly human_provenance: HumanDecisionProvenance;
}
export type WaiverSuccess =
  | (WaiverDecisionBinding & { readonly granted: true; readonly expires: "task-complete"; readonly notes: string; readonly revision: number })
  | (WaiverDecisionBinding & { readonly granted: false; readonly notes: string; readonly revision: number });

export interface ToolContract<Input, Success> {
  readonly input: Input;
  readonly success: Success;
}
export interface ToolContractMap {
  readonly archflow_state: ToolContract<StateInput, StateSuccess>;
  readonly archflow_counter_review: ToolContract<CounterReviewInput, CounterReviewSuccess>;
  readonly archflow_adjudicate: ToolContract<AdjudicateInput, AdjudicateSuccess>;
  readonly archflow_gate: ToolContract<GateInput, GateSuccess>;
  readonly archflow_waiver: ToolContract<WaiverInput, WaiverSuccess>;
}
export const TOOL_NAMES = ["archflow_state", "archflow_counter_review", "archflow_adjudicate", "archflow_gate", "archflow_waiver"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
// ToolContractMap must satisfy Record<ToolName, ToolContract<unknown, unknown>> exactly.
export type ToolInput<K extends ToolName> = ToolContractMap[K]["input"];
export type ToolSuccess<K extends ToolName> = ToolContractMap[K]["success"];
export type ResultIdentityPayload<K extends ToolName = ToolName> = {
  readonly [P in K]: Readonly<{
    schema_version: "1";
    tool: P;
    task_id: string;
    intent_id: string;
    input_fingerprint: Sha256Digest;
    request_digest: Sha256Digest;
    result_id: string;
    resulting_revision: number;
    success: ToolSuccess<P>;
  }>;
}[K];
export interface ToolDefinition<K extends ToolName> {
  readonly name: K;
  readonly input_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${K}/input`;
  readonly result_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${K}/result`;
}
export const TOOL_DEFINITIONS: {
  readonly [K in keyof ToolContractMap]: ToolDefinition<K>;
};
declare const parsedToolInputBrand: unique symbol;
declare const structuralResultBrand: unique symbol;
declare const resultExpectationBrand: unique symbol;
export type ParsedToolInput<K extends keyof ToolContractMap> =
  ToolInput<K> & { readonly [parsedToolInputBrand]: K };
export type ParsedToolCall<K extends ToolName = ToolName> = {
  readonly [P in K]: Readonly<{ name: P; input: ParsedToolInput<P> }>;
}[K];
export function parseToolCall<K extends ToolName>(
  name: K,
  value: unknown
): Extract<ParsedToolCall, { name: K }>;
export type StructurallyValidProjectResult<K extends ToolName> =
  ProjectResult<ToolSuccess<K>> & { readonly [structuralResultBrand]: K };
export function validateProjectResultStructure<K extends ToolName>(
  call: Extract<ParsedToolCall, { name: K }>,
  value: unknown
): StructurallyValidProjectResult<K>;
export type ResultExpectationDataByTool = {
  readonly [P in ToolName]: ResultIdentityPayload<P>;
};
export type ResultExpectation<K extends ToolName> = ResultExpectationDataByTool[K] & {
  readonly [resultExpectationBrand]: K;
};
export function correlateProjectResult<K extends ToolName>(
  call: Extract<ParsedToolCall, { name: K }>,
  expectation: NoInfer<ResultExpectation<K>>,
  result: NoInfer<StructurallyValidProjectResult<K>>
): ProjectResult<ToolSuccess<K>>;
```

The exact pairs above match the architecture table and add authority fields required by the PRD. Numeric revisions/counts are non-negative safe integers; task, intent, rule, reason, and summary values use bounded validated primitives. `TaskPathClaim` is only a bounded (1–1024 UTF-8 bytes) slash-separated lexical claim: it rejects empty paths, leading `/`, drive/UNC prefixes, backslashes, NUL/control characters, and empty, `.` or `..` components, but it does not resolve symlinks, case, repository roots, or task containment. Phase 4 alone converts a claim into a resolved-safe-path authority. Shared `ReviewRole`/review result types live in `review.ts`, `ConstitutionResult`/`DriftResult` in `adjudication.ts`, `RuleVersionRef` in `gates.ts`, canonical `PipelineStep` remains the Phase 1 export from `vocabulary.ts`, and digest/path/five-tool-name primitives live in `evidence.ts`, `path-claims.ts`, and `tool-names.ts`; all public names are re-exported by `src/contracts/index.ts`.

`archflow_state` has no `artifact` field in Phase 2: present, `null`, or unknown artifact data is rejected until the durable union exists. `GateInput.supersedes` is absent normally; when present, the retained supplemental supersession must match its prior gate, accepted triage, and old subject, while the input's outer subject is the recorded new subject. The key-first parser returns a mapped discriminated `ParsedToolCall`, so a widened `ToolName` remains a correlated union rather than a widened input/brand pair. Each definition names the exact input and versioned `ProjectResult` schema fragments. Structural validation checks closed shape, code ownership, direct request/result equalities (including state status and gate kind), and internal envelope consistency only. It cannot authorize a minted path, revision, semantic summary, gate/waiver ID, context digest, or result identity.

Later transaction/result owners create a `ResultExpectation<K>` only after deriving the canonical request digest and complete `ResultIdentityPayload<K>`, including projection path, resulting revision, review/adjudication semantics, and exact gate or waiver envelope. Phase 2 freezes that non-self-referential result hash domain and exposes the correlation consumer and unbranded JSON shape but no public mint; its internal test capability supplies expectations. `correlateProjectResult` requires call, expectation, and structural result to share the same literal tool, verifies the expectation's task/intent/input/request identity against the parsed call, and compares every success field to `expectation.success`; the payload's `resulting_revision` must also equal the success revision. An expectation from another invocation or same-kind gate therefore fails. Until a later phase can mint that authority, Phase 3 performs only structural/direct-field validation and cannot claim authoritative correlation. `WaiverInput.task_id` must equal `origin.task_id`; the archived origin fixes rule, scope, subject, phase, and current evidence set. Gate success also requires `notes === decision.payload.reason`; waiver grant and denial retain exact origin/waiver gate, task/rule-version/subject/current-evidence/scope/human bindings, while only a grant carries task-bound expiry. A malformed handler result or failed authoritative correlation becomes a newly constructed safe `INTERNAL_ERROR`; a corrupted retained result discovered independently is `RESULT_INVALID`. No SDK-owned or wire-protocol type appears here.

```ts
declare const connectionContextBrand: unique symbol;
declare const invocationContextBrand: unique symbol;
export interface ConnectionContext {
  readonly connection_id: string;
  readonly startup_repository_candidate: Readonly<{
    readonly working_directory: string;
  }>;
  readonly initialization_candidates: Readonly<{
    readonly client: Readonly<{ readonly name: string; readonly version: string }>;
    readonly host: "claude" | "codex" | "unknown";
    readonly protocol_version: string;
  }>;
  readonly [connectionContextBrand]: true;
}

export interface InvocationContext {
  readonly invocation_id: string;
  readonly connection: ConnectionContext;
  readonly signal: AbortSignal;
  readonly transport_metadata: Readonly<{
    readonly request_id: string | number;
    readonly operation: "tools/call";
  }>;
  readonly [invocationContextBrand]: true;
}
export interface ConnectionContextFactory {
  readonly captureStartup: (seed: unknown) => Readonly<{
    initialize: (candidates: unknown) => ConnectionContext;
  }>;
}
export function createInvocationContext(
  connection: ConnectionContext,
  seed: unknown,
  signal: AbortSignal
): InvocationContext;
```

The internal `ConnectionContextFactory` captures and validates a startup repository candidate before initialization, then accepts client/host/protocol candidates exactly once; a repeated call fails with protocol `INITIALIZATION_REPEATED`. Both constructor stages defensively copy and recursively freeze plain data before minting the runtime brand, so mutating the source or returned nested views cannot change the snapshot. `createInvocationContext` requires a branded connection, copies/freezes invocation ID and transport metadata, and retains the supplied `AbortSignal` by identity as an explicitly live externally owned cancellation capability; the signal is neither cloned nor frozen. Request bodies have no repository/client/host/protocol override field. Constructors and test factories are internal and absent from the public barrel except for read-only branded context types and the invocation consumer required by Phase 3. Phase 3 adopts these interfaces and proves transport behavior; Phase 4 resolves and validates repository identity.

## Work Breakdown

1. **Establish shared primitives and lexical claims**: Add canonical lowercase SHA-256 parsing, `ReferencedEvidence<T>`, bounded IDs, `TaskPathClaim`, exact `TOOL_NAMES`/`ToolName`, schema IDs, and concrete module/barrel ownership; reuse Phase 1's `PipelineStep`. Prove that a lexical claim is not a Phase 4 resolved-safe-path brand. This shared chunk is the only dependency of both the error and tool-contract chunks.
2. **Implement review and adjudication semantics**: Add raw findings/reviews and adjudications, strict derivation for verdict/count, compliance, mechanical evidence, drift, and trigger consistency, plus all three closed provenance variants without treating semantic validation as authority.
3. **Freeze observation and authority-link seams**: Implement invocation-scoped observation capabilities that own immutable expected bindings and observed bytes. Define Phase 4-owned verified wrappers and scope-bound nested-mapped authority links; qualification is idempotent for an identical link/wrapper and rejects different payload, digest, assurance, or scope. Keep fixture factories internal.
4. **Add exact-set triage and supplemental contracts**: Implement canonical evidence slots, `CurrentReviewSetAuthority`, composite finding references, `validateTriage`, waiver-origin references, and all supplemental outcomes. Cover advisory and zero-finding sets, same local IDs across distinct reviews, and wrong-gate supplemental substitution.
5. **Implement canonical anti-spoofing renderers**: Implement the three exact H1/header inventories and non-structural canonical-JSON encoding for untrusted prose. Golden-test fixed order, exact LF bytes, and heading/table/fence/link/HTML/control/bidi injection.
6. **Freeze gate, waiver, and decision authority**: Implement the single nine-kind catalogue, exact context and object-payload mappings, effect annotations, semantic constraints, decision envelopes, commit subject, restore authority, and waiver sequencing. Keep cancellation and supplemental actions outside the decision map.
7. **Freeze exhaustive error ownership**: Against chunk 1's `ToolName`, encode every per-code row in the two literal registries, strict serialized values, safe parameters, unique action, and project/protocol projection. Test the SDK mapping matrix, denial/cancellation distinctions, and registry mutations; this chunk does not import tool request/result contracts.
8. **Define five tool pairs, result expectations, and contexts**: Against chunks 1 and 7, publish the exact `ToolContractMap`, mapped `ParsedToolCall`, structural validator, closed result identity payload, opaque later-owner `ResultExpectation`, authoritative correlator, exact schema fragment IDs, and branded defensive-copy connection/invocation constructors. Reject state artifacts, identity overrides, widened-name substitutions, repeated initialization, and source mutation.
9. **Run an early whole-contract and bundle checkpoint**: Typecheck the public barrel and literal maps, load every schema by `SCHEMA_IDS`, run initial agreement/correlation tests, and update `scripts/smoke-temp-bundle.mjs` to execute representative Phase 2 parsing/rendering, both registries, and all five definitions through the temporary ESM bundle.
10. **Close adversarial verification**: Complete positive/negative/non-mutation corpora for every variant, brand, slot, gate, supplemental action, error, tool, expectation, path claim, and context; rerun all project checks and a scoped diff proving Phase 3+ and dependency surfaces remain untouched.

## Requirement Traceability

| Requirements | Phase 2 evidence | Verification focus |
|--------------|------------------|--------------------|
| REQ-04, REQ-05 | Versioned strict schemas, pinned identity/digest fields, closed phase/step/config error vocabulary | Schema/Zod agreement, unknown-field rejection, registry mutation |
| REQ-10, REQ-11, REQ-12 | Rubric-bound review derivation, exact finding/verdict semantics, structured triage, anti-spoofing canonical projections | Contradiction and exact-coverage corpora; renderer attack goldens |
| REQ-13, REQ-23 | Subject/input/current-slot authority, digest domains, idempotent identical qualification, intent/revision/fingerprint inputs and result expectations | Stale/substituted evidence and same/different-intent correlation cases |
| REQ-15, REQ-17, REQ-19, REQ-33 | Pinned-constitution/upstream/mechanical-evidence adjudication, scoped observation capability, server-attested provenance | Wrong-policy/upstream/invocation/family/output substitution fixtures |
| REQ-18, REQ-20 | Origin-bound waiver and exact nine-kind human decision catalogue | Wrong gate/rule/scope/subject decisions and non-advancing denial tests |
| REQ-27 | Literal five-entry `ToolContractMap` and per-tool schema fragments | Missing/extra/sixth-tool and temporary-bundle smoke checks |
| REQ-36, REQ-37 | Gate request/decision/cancellation/resume contracts without implementing lifecycle | Cross-kind/stale/replay envelope rejection and SDK cancellation ownership |
| REQ-41 | Gate-bound supplemental review reference and closed disposition/supersession outcomes | Wrong-gate/subject slot, decline, no-change, accepted-change, supersession cases |
| REQ-50 | Exact migration-audit context/payload within the existing gate/tool set | Import/code/policy identity substitution and no-sixth-tool checks |

## Success Criteria

- [ ] Closed schemas and strict non-transforming parsers distinguish raw, semantically derived, agent-declared, server-attested, and degraded review and adjudication values; derivation recomputes claims but never grants authority.
- [ ] `ReferencedEvidence<T>` is the only serializable wrapper pairing evidence with its digest; links/references repeat identities only. Phase 4 alone verifies repository-canonical payload bytes and mints opaque `VerifiedReferencedEvidence`; altered payload under a retained digest cannot qualify.
- [ ] Observation trust parses exact raw output bytes and derives bindings from one kind-correlated envelope before minting attestation. Its review role is counter or gate-counter only, so self-review remains agent-declared. Mapped types correlate evidence kind, legal role/value family, assurance, and authority references; qualification is idempotent for the identical scoped link/wrapper but rejects payload, digest, provenance, or scope substitution, and exact-role authority alone mints `CurrentReviewSet`.
- [ ] `validateTriage(CurrentReviewSet, unknown)` dispositions every applicable composite finding identity exactly once, rejects duplicate IDs within one review plus duplicate/omitted/foreign/stale composite references, and allows equal local IDs across different review digests.
- [ ] Renderers accept qualified/branded validated JSON only, emit the exact three header inventories, encode untrusted prose as visibly escaped non-structural canonical JSON, and produce deterministic UTF-8/LF bytes with one terminal LF; spoofing cannot create trusted Markdown structure.
- [ ] The single exhaustive `gate-contract.schema.json` catalogue covers exactly nine kinds and derives context, object payload, effect, TypeScript, Zod, and runtime narrowing. Common task/phase/subject/input/evidence scope occurs once in `GateInput`; exact channel-specific decision provenance retains declared human/Archforge actor and local traceability without identity-proof claims, and envelopes preserve complete commit, waiver, restore, migration, and supplemental authority without fabricating evidence for decline or predicting a later gate ID.
- [ ] Separate exhaustive project/ArchFlow-protocol registries contain every listed code once with per-code owner, boolean retryability, exact safe parameters, one action token, and legal projection. SDK-standard error ownership and mappings are explicit; waiver denial, child cancellation, gate cancellation, retained corruption, and malformed handler output are not conflated.
- [ ] A strict literal-keyed `ToolContractMap` contains exactly five pairs and exact schema fragment IDs. Mapped `ParsedToolCall` preserves widened-name correlation; structural validation makes no minted-authority claim; the exact non-self-referential `ResultIdentityPayload` is the result hash domain and a scoped opaque `ResultExpectation` is required to reject wrong invocation/gate/revision/path/semantic results. State artifacts are rejected and `ProjectResult` is versioned.
- [ ] `TaskPathClaim` is explicitly lexical and untrusted. Internal branded constructors copy/deep-freeze connection and invocation snapshots, reject repeated initialization, retain only `AbortSignal` as a live identity, and expose no request identity override path.
- [ ] Every normative schema is independently loadable from `SCHEMA_IDS`; JSON Schema and strict Zod accept/reject the same plain JSON without mutation, and all project typechecks/tests pass with no new dependency or Phase 3+ surface.

## Verification Steps

1. Run `npm run typecheck`, the Phase 2 unit suites, and all contract agreement suites. Confirm each public `unknown` parser rejects non-plain prototypes, accessors, cycles, dangerous keys, non-JSON values, and unknown fields before semantic handling, and confirm no input is mutated.
2. Exercise review/adjudication corpora for contradictory verdict/count, invalid rule/version or digest links, every mechanical-evidence state, inconsistent compliance/drift/triggers, all provenance tags, server-attested-self-review rejection, and cross-family substitutions. Compile-time fixtures instantiate both narrow and broad-union `AuthorityLink`/`VerifiedReferencedEvidence` types and reject assurance/reference and kind/role/value mixing. Runtime attempts cover direct brands, observation-created wrappers, payload changes under a retained digest, reused/wrong-scope links, incomplete/wrong-role current sets, and mutually consistent forged JSON.
3. Exercise triage against two reviews sharing local finding IDs and against duplicate, missing, extra, foreign, stale, wrong-assurance/family, reordered, and wrong-gate references. Render every golden twice; compare exact header inventory and bytes, and attack headings, tables, fences, links, raw HTML, CR/LF, controls, and bidi characters.
4. Assert the one gate catalogue has exactly nine keys and JSON Schema, Zod, mapped-union TypeScript, runtime narrowing, and effect classification agree. Prove common scope occurs once; reject duplicate common fields, `gate_id` in contexts, cross-kind envelopes, forged/mutated/reused human provenance, incomplete commit subjects, orphan rule resolutions, mismatched restore authority, wrong waiver origins, evidence-bearing declines, and under-bound supplemental supersession.
5. Mutation-test both error registries for every code-specific owner, retryability, exact parameter parser, action, and projection, including compile-time preservation after `typeof` inference. Exercise `SNAPSHOT_LIMIT` result/task scope, the complete sorted set of exact offending paths, and current/cap bytes, plus the SDK/project mapping matrix for malformed protocol input, unknown/disabled/known-invalid tools, repeated initialization, malformed handlers, retained corruption, child cancellation, durable gate cancellation, and waiver denial.
6. Assert chunk 1's five-name tuple, `ToolContractMap`, and exact schema fragments agree. Compile-time and runtime fixtures reject widened-name, unbranded, cross-tool, same-tool/different-request, wrong-expectation, wrong revision/path/semantic/gate/waiver, corrupt error, and state-artifact substitutions. Canonicalize `ResultIdentityPayload` twice to the same bytes, prove each included field changes its digest, and prove excluded links/receipts/state cannot enter it. Exercise `TaskPathClaim` lexical attacks and confirm it never becomes resolved path authority.
7. Mutate source and nested data around both context constructors, verify defensive copy/deep freeze and one-shot initialization, and prove the live `AbortSignal` still changes cancellation state. Confirm request schemas expose no repository/client/host/protocol override and the public barrel exports no capability/link/expectation/context fixture mint.
8. Run the complete existing project check, dependency/license policy, updated temporary-bundle smoke, and scoped `git diff --check`/status review. Confirm package/lock/dependency/CI/main/MCP/protocol/dist/persistence/dispatch/state/artifact/decision lifecycle surfaces are unchanged and every Phase 2 schema is registered and independently loadable.

---
*Designed: 2026-07-27*
