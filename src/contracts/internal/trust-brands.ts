import type {
  Assurance,
  EvidenceKind,
  ObservationBindingByKind,
} from "../trust.js";

export const observationCapabilityBrand: unique symbol = Symbol("ObservationCapability");
export const authorityLinkBrand: unique symbol = Symbol("AuthorityLink");
export const verifiedReferencedEvidenceBrand: unique symbol = Symbol("VerifiedReferencedEvidence");
export const currentReviewSetAuthorityBrand: unique symbol = Symbol("CurrentReviewSetAuthority");
export const qualifiedEvidenceBrand: unique symbol = Symbol("QualifiedEvidence");
export const currentReviewSetBrand: unique symbol = Symbol("CurrentReviewSet");
export const validatedTriageBrand: unique symbol = Symbol("ValidatedTriage");

type TrustIdentity = Readonly<{ kind: EvidenceKind; assurance: Assurance }>;

const observationCapabilities = new WeakMap<object, ObservationBindingByKind[EvidenceKind]>();
const authorityLinks = new WeakMap<object, TrustIdentity>();
const verifiedEvidence = new WeakMap<object, TrustIdentity>();
const currentReviewAuthorities = new WeakSet<object>();
const qualifiedEvidence = new WeakMap<object, TrustIdentity>();
const currentReviewSets = new WeakSet<object>();
const validatedTriages = new WeakSet<object>();

export function registerObservationCapability<K extends EvidenceKind>(value: object, binding: ObservationBindingByKind[K]): void {
  observationCapabilities.set(value, binding);
}

export function observationCapabilityBinding<K extends EvidenceKind>(value: object, kind: K): ObservationBindingByKind[K] | undefined {
  const binding = observationCapabilities.get(value);
  return binding?.kind === kind ? binding as ObservationBindingByKind[K] : undefined;
}

export function registerAuthorityLink(value: object, identity: TrustIdentity): void {
  authorityLinks.set(value, Object.freeze({ ...identity }));
}

export function authenticAuthorityLink(value: object, identity: TrustIdentity): boolean {
  const actual = authorityLinks.get(value);
  return actual?.kind === identity.kind && actual.assurance === identity.assurance;
}

export function registerVerifiedEvidence(value: object, identity: TrustIdentity): void {
  verifiedEvidence.set(value, Object.freeze({ ...identity }));
}

export function authenticVerifiedEvidence(value: object, identity: TrustIdentity): boolean {
  const actual = verifiedEvidence.get(value);
  return actual?.kind === identity.kind && actual.assurance === identity.assurance;
}

export function registerCurrentReviewSetAuthority(value: object): void { currentReviewAuthorities.add(value); }
export function authenticCurrentReviewSetAuthority(value: object): boolean { return currentReviewAuthorities.has(value); }

export function registerQualifiedEvidence(value: object, identity: TrustIdentity): void {
  qualifiedEvidence.set(value, Object.freeze({ ...identity }));
}

export function authenticQualifiedEvidence(value: object, kind: EvidenceKind, assurance?: Assurance): boolean {
  const actual = qualifiedEvidence.get(value);
  return actual?.kind === kind && (assurance === undefined || actual.assurance === assurance);
}

export function registerCurrentReviewSet(value: object): void { currentReviewSets.add(value); }
export function authenticCurrentReviewSet(value: object): boolean { return currentReviewSets.has(value); }
export function registerValidatedTriage(value: object): void { validatedTriages.add(value); }
export function authenticValidatedTriage(value: object): boolean { return validatedTriages.has(value); }
