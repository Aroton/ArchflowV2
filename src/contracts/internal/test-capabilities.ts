import { canonicalDocument, type CanonicalDocument } from "../canonical.js";
import { validateDurableSemantics } from "../durable.js";
import {
  parseResultManifest,
  type ResultManifestV1,
} from "../durable-result-manifest.js";
import type { AuthoritativeResultRef } from "../durable-state.js";
import { encodePhaseInstance, decodePhaseInstance } from "../phase-instance.js";
import type { Assurance, AuthorityLink, AuthorityLinkData, CurrentReviewSetAuthority, EvidenceKind, ObservationBindingByKind, ObservationCapability, RequiredReviewSlots, VerifiedReferencedEvidence } from "../trust.js";
import {
  currentReviewSetAuthorityBrand,
  registerAuthorityLink,
  registerCurrentReviewSetAuthority,
  registerObservationCapability,
  registerVerifiedEvidence,
} from "./trust-brands.js";
import { createVerifiedEvidenceReference } from "./trust-mints.js";
import type { ReferencedEvidence } from "../evidence.js";
import { createInternalResultExpectation, type ResultExpectation, type ResultIdentityPayload } from "../mcp-tools.js";
import type { ToolName } from "../tool-names.js";
import {
  assertAuthenticTransactionOutcome,
  type TransactionOutcome,
} from "../../state/transaction.js";

declare const retainedEvidenceReferenceBrand: unique symbol;
const retainedEvidenceReferences = new WeakSet<object>();

export type RetainedEvidenceReference<K extends EvidenceKind = EvidenceKind, A extends Assurance = Assurance> = Readonly<{
  verified: VerifiedReferencedEvidence<K, A>;
  reference: AuthoritativeResultRef;
  manifest: CanonicalDocument<ResultManifestV1>;
  readonly [retainedEvidenceReferenceBrand]: `${K}:${A}`;
}>;

export function createTestObservationCapability<K extends EvidenceKind>(binding: ObservationBindingByKind[K]): ObservationCapability<K> {
  const copiedBinding = deepFreeze(structuredClone(binding));
  const capability = Object.freeze({ kind: copiedBinding.kind }) as ObservationCapability<K>;
  registerObservationCapability(capability, copiedBinding);
  return capability;
}
export function createTestAuthorityLink<K extends EvidenceKind, A extends Assurance>(data: AuthorityLinkData<K, A>): AuthorityLink<K, A> {
  const link = deepFreeze(structuredClone(data)) as AuthorityLink<K, A>;
  registerAuthorityLink(link, { kind: data.evidence_kind, assurance: data.assurance });
  return link;
}
export function createTestVerifiedReferencedEvidence<K extends EvidenceKind, A extends Assurance>(kind: K, value: ReferencedEvidence<VerifiedReferencedEvidence<K, A>["evidence"]>): VerifiedReferencedEvidence<K, A> {
  const verified = deepFreeze(structuredClone(value)) as VerifiedReferencedEvidence<K, A>;
  registerVerifiedEvidence(verified, { kind, assurance: value.evidence.assurance });
  return verified;
}

export function createRetainedEvidenceReference<K extends EvidenceKind, A extends Assurance>(
  manifestDocument: CanonicalDocument<ResultManifestV1>,
  reference: AuthoritativeResultRef,
): RetainedEvidenceReference<K, A> {
  const canonical = canonicalDocument(parseResultManifest(manifestDocument.value));
  if (
    canonical.digest !== manifestDocument.digest ||
    !Buffer.from(canonical.bytes).equals(Buffer.from(manifestDocument.bytes))
  ) {
    throw new TypeError("retained evidence manifest is not canonical");
  }
  const semantics = validateDurableSemantics({ result_manifest: canonical });
  if (!semantics.ok) throw new TypeError("retained evidence manifest semantics are invalid");
  const manifest = canonical.value;
  const source = manifest.source_artifact;
  if (
    source.artifact_kind !== "review-evidence" &&
    source.artifact_kind !== "adjudication-evidence"
  ) {
    throw new TypeError("retained manifest does not contain review or adjudication evidence");
  }
  if (
    reference.result_digest !== canonical.digest ||
    reference.result_id !== manifest.result_id ||
    reference.phase_instance !== manifest.phase_instance ||
    reference.step !== manifest.step ||
    reference.input_fingerprint !== manifest.input_fingerprint
  ) {
    throw new TypeError("retained evidence reference does not match its manifest");
  }
  const verified = (
    source.artifact_kind === "review-evidence"
      ? createVerifiedEvidenceReference(source.evidence)
      : createVerifiedEvidenceReference(source.evidence)
  ) as VerifiedReferencedEvidence<K, A>;
  if (verified.evidence_digest !== manifest.artifact_digest) {
    throw new TypeError("retained evidence digest does not match its manifest");
  }
  const retained = Object.freeze({
    verified,
    reference: deepFreeze(structuredClone(reference)),
    manifest: canonical,
  }) as RetainedEvidenceReference<K, A>;
  retainedEvidenceReferences.add(retained);
  return retained;
}

export function createTransactionAuthorityLink<K extends EvidenceKind, A extends Exclude<Assurance, "degraded">>(
  retained: RetainedEvidenceReference<K, A>,
  outcome: TransactionOutcome<ToolName>,
): AuthorityLink<K, A> {
  if (!retainedEvidenceReferences.has(retained)) {
    throw new TypeError("an authenticated retained evidence reference is required");
  }
  assertAuthenticTransactionOutcome(outcome);
  const committed = outcome.state.value.last_transition;
  const reference = retained.reference;
  const evidence = retained.verified.evidence;
  if (
    committed === undefined ||
    committed.result_id !== reference.result_id ||
    outcome.state.value.revision !== outcome.outcome.revision ||
    !outcome.state.value.authoritative_results.some((candidate) =>
      candidate.result_digest === reference.result_digest &&
      candidate.result_id === reference.result_id &&
      candidate.phase_instance === reference.phase_instance &&
      candidate.step === reference.step &&
      candidate.input_fingerprint === reference.input_fingerprint
    )
  ) {
    throw new TypeError("transaction outcome does not authenticate the retained evidence result");
  }
  const phaseInstance = encodePhaseInstance(decodePhaseInstance(evidence.phase_instance));
  const authority = evidence.assurance === "server-attested"
    ? {
        kind: "server" as const,
        invocation_id: evidence.invocation_id,
        result_id: reference.result_id,
        receipt_id: committed.intent_id,
        state_revision: outcome.state.value.revision,
        envelope_input_digest: evidence.envelope_input_digest,
        observed_output_digest: evidence.observed_output_digest,
        result_digest: reference.result_digest,
      }
    : {
        kind: "agent-declared" as const,
        result_id: reference.result_id,
        result_digest: reference.result_digest,
        state_revision: outcome.state.value.revision,
      };
  const data = deepFreeze({
    schema_version: "1" as const,
    evidence_kind: evidence.step === "adjudicate" ? "adjudication" as const : "review" as const,
    assurance: evidence.assurance,
    role: evidence.step === "adjudicate" ? "adjudication" as const : evidence.role,
    task_id: evidence.task_id,
    phase_instance: phaseInstance,
    subject_digest: evidence.subject_digest,
    input_fingerprint: evidence.input_fingerprint,
    evidence_digest: retained.verified.evidence_digest,
    authority,
  }) as unknown as AuthorityLinkData<K, A>;
  const link = data as AuthorityLink<K, A>;
  registerAuthorityLink(link, { kind: data.evidence_kind, assurance: data.assurance });
  return link;
}
export function createTestCurrentReviewSetAuthority(value: Omit<CurrentReviewSetAuthority, typeof currentReviewSetAuthorityBrand> & { readonly slots: RequiredReviewSlots }): CurrentReviewSetAuthority {
  const authority = deepFreeze(structuredClone(value)) as CurrentReviewSetAuthority;
  registerCurrentReviewSetAuthority(authority);
  return authority;
}
export function createTestResultExpectation<K extends ToolName>(value: ResultIdentityPayload<K>): ResultExpectation<K> {
  return createInternalResultExpectation(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
