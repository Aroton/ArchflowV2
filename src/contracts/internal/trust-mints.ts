import { canonicalJsonDigest } from "../canonical.js";
import { assertPlainJson } from "../plain-json.js";
import {
  parseAdjudicationEvidence,
  type AdjudicationEvidence,
  type AgentDeclaredAdjudication,
  type DegradedAdjudication,
  type ServerAttestedAdjudication,
} from "../adjudication.js";
import {
  parseReviewedRepositoriesV1,
  parseReviewEvidence,
  type DegradedReview,
  type ReviewEvidence,
  type ServerAttestedReview,
} from "../review.js";
import type {
  ObservationBindingByKind,
  ObservationCapability,
  VerifiedReferencedEvidence,
} from "../trust.js";
import {
  registerObservationCapability,
  registerVerifiedEvidence,
} from "./trust-brands.js";

export function createReviewObservationCapability(binding: ObservationBindingByKind["review"]): ObservationCapability<"review"> {
  assertPlainJson(binding, "review observation binding");
  const materialized = structuredClone(binding);
  const copiedBinding = deepFreeze({
    ...materialized,
    repositories: parseReviewedRepositoriesV1(materialized.repositories),
  });
  const capability = Object.freeze({ kind: copiedBinding.kind }) as ObservationCapability<"review">;
  registerObservationCapability(capability, copiedBinding);
  return capability;
}
export function createAdjudicationObservationCapability(binding: ObservationBindingByKind["adjudication"]): ObservationCapability<"adjudication"> {
  assertPlainJson(binding, "adjudication observation binding");
  const materialized = structuredClone(binding);
  const copiedBinding = deepFreeze({
    ...materialized,
    repositories: parseReviewedRepositoriesV1(materialized.repositories),
  });
  const capability = Object.freeze({ kind: copiedBinding.kind }) as ObservationCapability<"adjudication">;
  registerObservationCapability(capability, copiedBinding);
  return capability;
}

export function createVerifiedEvidenceReference(
  evidence: ServerAttestedReview,
): VerifiedReferencedEvidence<"review", "server-attested">;
export function createVerifiedEvidenceReference(
  evidence: DegradedReview,
): VerifiedReferencedEvidence<"review", "degraded">;
export function createVerifiedEvidenceReference(
  evidence: ReviewEvidence,
): VerifiedReferencedEvidence<"review">;
export function createVerifiedEvidenceReference(
  evidence: AgentDeclaredAdjudication,
): VerifiedReferencedEvidence<"adjudication", "agent-declared">;
export function createVerifiedEvidenceReference(
  evidence: ServerAttestedAdjudication,
): VerifiedReferencedEvidence<"adjudication", "server-attested">;
export function createVerifiedEvidenceReference(
  evidence: DegradedAdjudication,
): VerifiedReferencedEvidence<"adjudication", "degraded">;
export function createVerifiedEvidenceReference(
  evidence: AdjudicationEvidence,
): VerifiedReferencedEvidence<"adjudication">;
export function createVerifiedEvidenceReference(
  evidence: ReviewEvidence | AdjudicationEvidence,
): VerifiedReferencedEvidence {
  const parsed = (
    evidence.step === "adjudicate"
      ? parseAdjudicationEvidence(evidence)
      : parseReviewEvidence(evidence)
  ) as ReviewEvidence | AdjudicationEvidence;
  const evidenceDigest = canonicalJsonDigest(parsed);
  const verified = deepFreeze({
    evidence_digest: evidenceDigest,
    evidence: parsed,
  }) as VerifiedReferencedEvidence;
  const kind = parsed.step === "adjudicate" ? "adjudication" : "review";
  registerVerifiedEvidence(verified, { kind, assurance: parsed.assurance });
  return verified;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
