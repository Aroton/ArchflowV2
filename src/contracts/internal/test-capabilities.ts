import type { Assurance, AuthorityLink, AuthorityLinkData, CurrentReviewSetAuthority, EvidenceKind, ObservationBindingByKind, ObservationCapability, RequiredReviewSlots, VerifiedReferencedEvidence } from "../trust.js";
import {
  currentReviewSetAuthorityBrand,
  registerAuthorityLink,
  registerCurrentReviewSetAuthority,
  registerObservationCapability,
  registerVerifiedEvidence,
} from "./trust-brands.js";
import type { ReferencedEvidence } from "../evidence.js";
import { createInternalResultExpectation, type ResultExpectation, type ResultIdentityPayload } from "../mcp-tools.js";
import type { ToolName } from "../tool-names.js";

export function createTestObservationCapability<K extends EvidenceKind>(binding: ObservationBindingByKind[K]): ObservationCapability<K> {
  const copiedBinding = deepFreeze(structuredClone(binding));
  const capability = Object.freeze({ kind: copiedBinding.kind }) as ObservationCapability<K>;
  registerObservationCapability(capability, copiedBinding);
  return capability;
}
export function createReviewObservationCapability(binding: ObservationBindingByKind["review"]): ObservationCapability<"review"> {
  const copiedBinding = deepFreeze(structuredClone(binding));
  const capability = Object.freeze({ kind: copiedBinding.kind }) as ObservationCapability<"review">;
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
