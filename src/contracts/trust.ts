import { createHash } from "node:crypto";
import { z } from "zod";

import type { AdjudicationEvidence, DegradedAdjudication, AgentDeclaredAdjudication, ServerAttestedAdjudication } from "./adjudication.js";
import { adjudicationEvidenceSchema, parseAndDeriveAdjudication, parseReferencedAdjudicationEvidence } from "./adjudication.js";
import type { ReferencedEvidence, Sha256Digest } from "./evidence.js";
import { parseSha256Digest } from "./evidence.js";
import {
  authenticAuthorityLink,
  authenticCurrentReviewSetAuthority,
  authenticQualifiedEvidence,
  authenticVerifiedEvidence,
  authorityLinkBrand,
  currentReviewSetAuthorityBrand,
  currentReviewSetBrand,
  observationCapabilityBinding,
  observationCapabilityBrand,
  qualifiedEvidenceBrand,
  registerCurrentReviewSet,
  registerQualifiedEvidence,
  verifiedReferencedEvidenceBrand,
} from "./internal/trust-brands.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { decodePhaseInstance, encodePhaseInstance } from "./phase-instance.js";
import type { AgentDeclaredReview, AdapterId, DegradedReview, ModelFamily, ReviewEvidence, ReviewRole, ServerAttestedReview } from "./review.js";
import { EFFORT_VALUES, parseAndDeriveReview, parseReferencedReviewEvidence, reviewEvidenceSchema } from "./review.js";
import { assertPlainJson } from "./plain-json.js";

export type EvidenceKind = "review" | "adjudication";
export type Assurance = "agent-declared" | "server-attested" | "degraded";
export interface EvidenceValueByKindAndAssurance {
  readonly review: { readonly "agent-declared": AgentDeclaredReview; readonly "server-attested": ServerAttestedReview; readonly degraded: DegradedReview };
  readonly adjudication: { readonly "agent-declared": AgentDeclaredAdjudication; readonly "server-attested": ServerAttestedAdjudication; readonly degraded: DegradedAdjudication };
}
export interface EvidenceRoleByKind { readonly review: ReviewRole; readonly adjudication: "adjudication" }
export interface ObservationRoleByKind { readonly review: "counter-review" | "gate-counter-review"; readonly adjudication: "adjudication" }

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
  readonly effort: (typeof EFFORT_VALUES)[number];
}
export interface ObservationBindingByKind {
  readonly review: ObservationBindingBase<"review"> & ({ readonly role: "counter-review" } | { readonly role: "gate-counter-review"; readonly gate_id: string }) & { readonly rubric_digest: Sha256Digest; readonly producer_family: ModelFamily };
  readonly adjudication: ObservationBindingBase<"adjudication"> & { readonly pinned_constitution_digest: Sha256Digest; readonly approved_upstream_digests: readonly Sha256Digest[]; readonly source_evidence_set_digest: Sha256Digest };
}
export type ObservationCapability<K extends EvidenceKind> = { readonly kind: K; readonly [observationCapabilityBrand]: ObservationBindingByKind[K] };
export type AdapterObservation<K extends EvidenceKind = EvidenceKind> = { readonly [P in K]: ObservationBindingByKind[P] & { readonly raw_output_bytes: Uint8Array; readonly raw_output_digest: Sha256Digest } }[K];

const sameArray = <T>(left: readonly T[], right: readonly T[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
const assertEqual = (actual: unknown, expected: unknown, name: string): void => { if (actual !== expected) throw new TypeError(`${name} does not match observation capability`); };
function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreezeJson(nested);
    Object.freeze(value);
  }
  return value;
}
const copyFreezeJson = <T>(value: T): T => deepFreezeJson(structuredClone(value));
function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}
const digestBytes = (bytes: Uint8Array): Sha256Digest => parseSha256Digest(createHash("sha256").update(bytes).digest("hex"));
const copiedBytes = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);
function assertAdapterFamily(adapter: AdapterId, family: ModelFamily): void {
  const expected = adapter === "claude-cli" ? "claude" : "codex";
  if (family !== expected) throw new TypeError("adapter and model family do not match");
}
function createObservation<K extends EvidenceKind>(binding: ObservationBindingByKind[K], bytes: Uint8Array, rawOutputDigest: Sha256Digest): AdapterObservation<K> {
  const storedBytes = copiedBytes(bytes);
  const observation = { ...binding, raw_output_digest: rawOutputDigest } as ObservationBindingByKind[K] & { readonly raw_output_digest: Sha256Digest; readonly raw_output_bytes: Uint8Array };
  Object.defineProperty(observation, "raw_output_bytes", { enumerable: true, configurable: false, get: () => copiedBytes(storedBytes) });
  return Object.freeze(observation) as AdapterObservation<K>;
}

export interface ObservationSource {
  readonly observeReview: (capability: ObservationCapability<"review">, observed_output_bytes: Uint8Array) => Readonly<{ observation: AdapterObservation<"review">; evidence: ServerAttestedReview }>;
  readonly observeAdjudication: (capability: ObservationCapability<"adjudication">, observed_output_bytes: Uint8Array) => Readonly<{ observation: AdapterObservation<"adjudication">; evidence: ServerAttestedAdjudication }>;
}

export const observationSource: ObservationSource = Object.freeze({
  observeReview(capability: ObservationCapability<"review">, observedOutputBytes: Uint8Array) {
    const binding = observationCapabilityBinding(capability, "review");
    if (binding === undefined || capability.kind !== "review") throw new TypeError("invalid review observation capability");
    assertAdapterFamily(binding.adapter, binding.family);
    const bytes = copiedBytes(observedOutputBytes);
    const derived = parseAndDeriveReview(decodeJson(bytes));
    for (const [key, expected] of [["task_id", binding.task_id], ["phase_instance", binding.phase_instance], ["role", binding.role], ["subject_digest", binding.subject_digest], ["input_fingerprint", binding.input_fingerprint], ["rubric_digest", binding.rubric_digest], ["producer_family", binding.producer_family]] as const) assertEqual(derived[key], expected, key);
    if (binding.family === binding.producer_family) throw new TypeError("review observation must be opposite-family");
    const raw_output_digest = digestBytes(bytes);
    const observation = createObservation<"review">(binding, bytes, raw_output_digest);
    const evidence: ServerAttestedReview = copyFreezeJson({ ...derived, assurance: "server-attested", adapter: binding.adapter, cli_version: binding.cli_version, model_family: binding.family, model: binding.model, effort: binding.effort, invocation_id: binding.invocation_id, envelope_input_digest: binding.envelope_input_digest, observed_output_digest: raw_output_digest, result_id: binding.result_id });
    return Object.freeze({ observation, evidence });
  },
  observeAdjudication(capability: ObservationCapability<"adjudication">, observedOutputBytes: Uint8Array) {
    const binding = observationCapabilityBinding(capability, "adjudication");
    if (binding === undefined || capability.kind !== "adjudication") throw new TypeError("invalid adjudication observation capability");
    assertAdapterFamily(binding.adapter, binding.family);
    const bytes = copiedBytes(observedOutputBytes);
    const derived = parseAndDeriveAdjudication(decodeJson(bytes));
    for (const [key, expected] of [["task_id", binding.task_id], ["phase_instance", binding.phase_instance], ["subject_digest", binding.subject_digest], ["input_fingerprint", binding.input_fingerprint], ["pinned_constitution_digest", binding.pinned_constitution_digest], ["source_evidence_set_digest", binding.source_evidence_set_digest]] as const) assertEqual(derived[key], expected, key);
    if (!sameArray(derived.approved_upstream_digests, binding.approved_upstream_digests)) throw new TypeError("approved_upstream_digests do not match observation capability");
    const raw_output_digest = digestBytes(bytes);
    const observation = createObservation<"adjudication">(binding, bytes, raw_output_digest);
    const evidence: ServerAttestedAdjudication = copyFreezeJson({ ...derived, assurance: "server-attested", adapter: binding.adapter, cli_version: binding.cli_version, model_family: binding.family, model: binding.model, effort: binding.effort, invocation_id: binding.invocation_id, envelope_input_digest: binding.envelope_input_digest, observed_output_digest: raw_output_digest, result_id: binding.result_id });
    return Object.freeze({ observation, evidence });
  },
});

export interface ServerAuthorityReferences { readonly kind: "server"; readonly invocation_id: string; readonly result_id: string; readonly receipt_id: string; readonly state_revision: number; readonly envelope_input_digest: Sha256Digest; readonly observed_output_digest: Sha256Digest; readonly result_digest: Sha256Digest }
export interface AgentDeclaredAuthorityReferences { readonly kind: "agent-declared"; readonly result_id: string; readonly result_digest: Sha256Digest; readonly state_revision: number }
export interface DegradedAuthorityReferences { readonly kind: "degraded"; readonly checkpoint_digest: Sha256Digest; readonly checkpoint_revision: number }
export interface AuthorityReferencesByAssurance { readonly "agent-declared": AgentDeclaredAuthorityReferences; readonly "server-attested": ServerAuthorityReferences; readonly degraded: DegradedAuthorityReferences }
export interface AuthorityLinkBase<K extends EvidenceKind, A extends Assurance> { readonly schema_version: "1"; readonly evidence_kind: K; readonly assurance: A; readonly role: EvidenceRoleByKind[K]; readonly task_id: string; readonly phase_instance: PhaseInstanceId; readonly subject_digest: Sha256Digest; readonly input_fingerprint: Sha256Digest; readonly evidence_digest: Sha256Digest; readonly gate_id?: string; readonly authority: AuthorityReferencesByAssurance[A] }
export type AuthorityLinkData<K extends EvidenceKind = EvidenceKind, A extends Assurance = Assurance> = { readonly [P in K]: { readonly [Q in A]: AuthorityLinkBase<P, Q> }[A] }[K];
export type AuthorityLink<K extends EvidenceKind = EvidenceKind, A extends Assurance = Assurance> = { readonly [P in K]: { readonly [Q in A]: AuthorityLinkBase<P, Q> & { readonly [authorityLinkBrand]: `${P}:${Q}` } }[A] }[K];
export type VerifiedReferencedEvidence<K extends EvidenceKind = EvidenceKind, A extends Assurance = Assurance> = { readonly [P in K]: { readonly [Q in A]: ReferencedEvidence<EvidenceValueByKindAndAssurance[P][Q]> & { readonly [verifiedReferencedEvidenceBrand]: `${P}:${Q}` } }[A] }[K];

export type ReviewEvidenceSlot =
  | Readonly<{ role: "self-review"; evidence_digest: Sha256Digest; assurance: "agent-declared"; producer_family: ModelFamily; reviewer_family: ModelFamily; independence: "same-family-self" }>
  | Readonly<{ role: "counter-review"; evidence_digest: Sha256Digest; assurance: "server-attested" | "degraded"; producer_family: ModelFamily; reviewer_family: ModelFamily; independence: "opposite-family" }>
  | Readonly<{ role: "gate-counter-review"; evidence_digest: Sha256Digest; assurance: "server-attested" | "degraded"; producer_family: ModelFamily; reviewer_family: ModelFamily; independence: "opposite-family"; gate_id: string }>;
export type RequiredReviewSlots = readonly [Extract<ReviewEvidenceSlot, { role: "self-review" }>, Extract<ReviewEvidenceSlot, { role: "counter-review" }>] | readonly [Extract<ReviewEvidenceSlot, { role: "self-review" }>, Extract<ReviewEvidenceSlot, { role: "counter-review" }>, Extract<ReviewEvidenceSlot, { role: "gate-counter-review" }>];
export interface CurrentReviewSetAuthority { readonly task_id: string; readonly phase_instance: PhaseInstanceId; readonly subject_digest: Sha256Digest; readonly input_fingerprint: Sha256Digest; readonly slots: RequiredReviewSlots; readonly [currentReviewSetAuthorityBrand]: true }
export interface CurrentEvidenceSetRef { readonly set_digest: Sha256Digest; readonly slots: RequiredReviewSlots }

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const phaseSchema = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u) as unknown as z.ZodType<PhaseInstanceId>;
const familySchema = z.enum(["claude", "codex"]);
const safeInteger = z.number().int().nonnegative().safe();
const agentAuthoritySchema = z.object({ kind: z.literal("agent-declared"), result_id: idSchema, result_digest: digestSchema, state_revision: safeInteger }).strict();
const serverAuthoritySchema = z.object({ kind: z.literal("server"), invocation_id: idSchema, result_id: idSchema, receipt_id: idSchema, state_revision: safeInteger, envelope_input_digest: digestSchema, observed_output_digest: digestSchema, result_digest: digestSchema }).strict();
const degradedAuthoritySchema = z.object({ kind: z.literal("degraded"), checkpoint_digest: digestSchema, checkpoint_revision: safeInteger }).strict();
const authorityReferencesSchema = z.discriminatedUnion("kind", [agentAuthoritySchema, serverAuthoritySchema, degradedAuthoritySchema]);
export const authorityLinkDataSchema = z.object({ schema_version: z.literal("1"), evidence_kind: z.enum(["review", "adjudication"]), assurance: z.enum(["agent-declared", "server-attested", "degraded"]), role: z.enum(["self-review", "counter-review", "gate-counter-review", "adjudication"]), task_id: idSchema, phase_instance: phaseSchema, subject_digest: digestSchema, input_fingerprint: digestSchema, evidence_digest: digestSchema, gate_id: idSchema.optional(), authority: authorityReferencesSchema }).strict().superRefine((link, context) => {
  if ((link.evidence_kind === "adjudication") !== (link.role === "adjudication")) context.addIssue({ code: "custom", path: ["role"], message: "role must match evidence kind" });
  const expectedAuthorityKind = link.assurance === "server-attested" ? "server" : link.assurance;
  if (link.authority.kind !== expectedAuthorityKind) context.addIssue({ code: "custom", path: ["authority", "kind"], message: "authority references must match assurance" });
  if ((link.role === "gate-counter-review") !== (link.gate_id !== undefined)) context.addIssue({ code: "custom", path: ["gate_id"], message: "gate_id is required only for gate-counter-review authority" });
});
const slotBase = { evidence_digest: digestSchema, producer_family: familySchema, reviewer_family: familySchema };
const selfSlotSchema = z.object({ ...slotBase, role: z.literal("self-review"), assurance: z.literal("agent-declared"), independence: z.literal("same-family-self") }).strict().superRefine((slot, context) => { if (slot.producer_family !== slot.reviewer_family) context.addIssue({ code: "custom", message: "self-review families must match" }); });
const counterSlotSchema = z.object({ ...slotBase, role: z.literal("counter-review"), assurance: z.enum(["server-attested", "degraded"]), independence: z.literal("opposite-family") }).strict().superRefine((slot, context) => { if (slot.producer_family === slot.reviewer_family) context.addIssue({ code: "custom", message: "counter-review families must differ" }); });
const gateCounterSlotSchema = z.object({ ...slotBase, role: z.literal("gate-counter-review"), assurance: z.enum(["server-attested", "degraded"]), independence: z.literal("opposite-family"), gate_id: idSchema }).strict().superRefine((slot, context) => { if (slot.producer_family === slot.reviewer_family) context.addIssue({ code: "custom", message: "gate-counter-review families must differ" }); });
export const requiredReviewSlotsSchema = z.union([z.tuple([selfSlotSchema, counterSlotSchema]), z.tuple([selfSlotSchema, counterSlotSchema, gateCounterSlotSchema])]);
export const currentEvidenceSetRefSchema = z.object({ set_digest: digestSchema, slots: requiredReviewSlotsSchema }).strict();
export const referencedEvidenceSchema = z.union([
  z.object({ evidence_digest: digestSchema, evidence: reviewEvidenceSchema }).strict(),
  z.object({ evidence_digest: digestSchema, evidence: adjudicationEvidenceSchema }).strict(),
]);
export function parseAuthorityLinkData(value: unknown): AuthorityLinkData { assertPlainJson(value, "authority link data"); return authorityLinkDataSchema.parse(value) as AuthorityLinkData; }
export function parseRequiredReviewSlots(value: unknown): RequiredReviewSlots { assertPlainJson(value, "required review slots"); const slots = requiredReviewSlotsSchema.parse(value) as RequiredReviewSlots; validateSlots(slots); return slots; }
export function parseCurrentEvidenceSetRef(value: unknown): CurrentEvidenceSetRef { assertPlainJson(value, "current evidence set reference"); const parsed = currentEvidenceSetRefSchema.parse(value); validateSlots(parsed.slots); return parsed as CurrentEvidenceSetRef; }
export function parseReferencedEvidence(value: unknown): ReferencedEvidence<ReviewEvidence | AdjudicationEvidence> {
  assertPlainJson(value, "referenced evidence");
  if (typeof value !== "object" || value === null || !("evidence" in value)) throw new TypeError("referenced evidence wrapper is required");
  const evidence = value.evidence;
  if (typeof evidence !== "object" || evidence === null || !("step" in evidence)) throw new TypeError("referenced evidence kind is required");
  return evidence.step === "adjudicate" ? parseReferencedAdjudicationEvidence(value) : parseReferencedReviewEvidence(value);
}

export type QualifiedReviewEvidenceByAssurance = { readonly [A in Assurance]: VerifiedReferencedEvidence<"review", A> & { readonly authority: AuthorityLink<"review", A>; readonly [qualifiedEvidenceBrand]: `review:${A}` } };
export type QualifiedReviewEvidence = QualifiedReviewEvidenceByAssurance[Assurance];
export type QualifiedAdjudicationEvidenceByAssurance = { readonly [A in Assurance]: VerifiedReferencedEvidence<"adjudication", A> & { readonly authority: AuthorityLink<"adjudication", A>; readonly [qualifiedEvidenceBrand]: `adjudication:${A}` } };
export type QualifiedAdjudicationEvidence = QualifiedAdjudicationEvidenceByAssurance[Assurance];
export interface CurrentReviewSet { readonly task_id: string; readonly phase_instance: PhaseInstanceId; readonly subject_digest: Sha256Digest; readonly input_fingerprint: Sha256Digest; readonly current_evidence_set: CurrentEvidenceSetRef; readonly reviews: readonly QualifiedReviewEvidence[]; readonly [currentReviewSetBrand]: true }

function assertLinkMatches<K extends EvidenceKind, A extends Assurance>(kind: K, link: AuthorityLink<K, A>, value: VerifiedReferencedEvidence<K, A>): void {
  const authenticatedAssurance = (["agent-declared", "server-attested", "degraded"] as const).find((assurance) =>
    authenticAuthorityLink(link, { kind, assurance }) && authenticVerifiedEvidence(value, { kind, assurance })
  );
  if (authenticatedAssurance === undefined) throw new TypeError("untrusted authority link or verified evidence");
  const evidence = value.evidence as ReviewEvidence | AdjudicationEvidence;
  if (evidence.assurance !== authenticatedAssurance || link.assurance !== authenticatedAssurance) throw new TypeError("authority assurance does not match authenticated identity");
  const expectedAuthorityKind = evidence.assurance === "server-attested" ? "server" : evidence.assurance;
  if (link.authority.kind !== expectedAuthorityKind) throw new TypeError("authority references do not match assurance");
  const phaseInstance = encodePhaseInstance(decodePhaseInstance(evidence.phase_instance));
  if (link.evidence_kind !== kind || link.assurance !== evidence.assurance || link.evidence_digest !== value.evidence_digest || link.task_id !== evidence.task_id || link.phase_instance !== phaseInstance || link.subject_digest !== evidence.subject_digest || link.input_fingerprint !== evidence.input_fingerprint) throw new TypeError("authority link does not match verified evidence");
  if (link.role !== (kind === "review" ? (evidence as ReviewEvidence).role : "adjudication")) throw new TypeError("authority role does not match evidence");
  if ((link.role === "gate-counter-review") !== (link.gate_id !== undefined)) throw new TypeError("authority gate binding does not match role");
  if (evidence.assurance === "server-attested") {
    if (link.authority.kind !== "server"
      || link.authority.invocation_id !== evidence.invocation_id
      || link.authority.result_id !== evidence.result_id
      || link.authority.envelope_input_digest !== evidence.envelope_input_digest
      || link.authority.observed_output_digest !== evidence.observed_output_digest) {
      throw new TypeError("server authority provenance does not match evidence");
    }
  }
}
function validateSlots(slots: readonly ReviewEvidenceSlot[]): asserts slots is RequiredReviewSlots {
  if ((slots.length !== 2 && slots.length !== 3) || slots[0]?.role !== "self-review" || slots[1]?.role !== "counter-review" || (slots.length === 3 && slots[2]?.role !== "gate-counter-review")) throw new TypeError("review slots must use canonical role order");
  for (const slot of slots) {
    if (slot.role === "self-review") { if (slot.assurance !== "agent-declared" || slot.independence !== "same-family-self" || slot.producer_family !== slot.reviewer_family) throw new TypeError("invalid self-review slot"); }
    else if (slot.independence !== "opposite-family" || slot.producer_family === slot.reviewer_family) throw new TypeError("invalid opposite-family review slot");
  }
  if (new Set(slots.map((slot) => slot.evidence_digest)).size !== slots.length) throw new TypeError("review slot evidence digests must be unique");
}
const currentSetDigest = (slots: RequiredReviewSlots): Sha256Digest => parseSha256Digest(createHash("sha256").update(JSON.stringify(slots)).digest("hex"));

export interface AuthorityQualifier {
  readonly qualifyReview: <A extends Assurance>(link: AuthorityLink<"review", A>, value: NoInfer<VerifiedReferencedEvidence<"review", A>>) => QualifiedReviewEvidenceByAssurance[A];
  readonly qualifyAdjudication: <A extends Assurance>(link: AuthorityLink<"adjudication", A>, value: NoInfer<VerifiedReferencedEvidence<"adjudication", A>>) => QualifiedAdjudicationEvidenceByAssurance[A];
  readonly currentReviews: (authority: CurrentReviewSetAuthority, reviews: readonly QualifiedReviewEvidence[]) => CurrentReviewSet;
}
export const authorityQualifier: AuthorityQualifier = Object.freeze({
  qualifyReview<A extends Assurance>(link: AuthorityLink<"review", A>, value: NoInfer<VerifiedReferencedEvidence<"review", A>>): QualifiedReviewEvidenceByAssurance[A] {
    assertLinkMatches("review", link, value);
    const qualified = Object.freeze({ ...value, authority: link }) as QualifiedReviewEvidenceByAssurance[A];
    registerQualifiedEvidence(qualified, { kind: "review", assurance: link.assurance });
    return qualified;
  },
  qualifyAdjudication<A extends Assurance>(link: AuthorityLink<"adjudication", A>, value: NoInfer<VerifiedReferencedEvidence<"adjudication", A>>): QualifiedAdjudicationEvidenceByAssurance[A] {
    assertLinkMatches("adjudication", link, value);
    const qualified = Object.freeze({ ...value, authority: link }) as QualifiedAdjudicationEvidenceByAssurance[A];
    registerQualifiedEvidence(qualified, { kind: "adjudication", assurance: link.assurance });
    return qualified;
  },
  currentReviews(authority: CurrentReviewSetAuthority, reviews: readonly QualifiedReviewEvidence[]): CurrentReviewSet {
    if (!authenticCurrentReviewSetAuthority(authority)) throw new TypeError("invalid current review set authority");
    validateSlots(authority.slots);
    if (reviews.length !== authority.slots.length) throw new TypeError("reviews must exactly cover required slots");
    authority.slots.forEach((slot, index) => {
      const review = reviews[index];
      if (review === undefined || !authenticQualifiedEvidence(review, "review") || !authenticQualifiedEvidence(review, "review", review.evidence.assurance) || review.evidence_digest !== slot.evidence_digest || review.evidence.role !== slot.role || review.evidence.assurance !== slot.assurance || review.evidence.producer_family !== slot.producer_family || review.evidence.model_family !== slot.reviewer_family || review.authority.task_id !== authority.task_id || review.authority.phase_instance !== authority.phase_instance || review.authority.subject_digest !== authority.subject_digest || review.authority.input_fingerprint !== authority.input_fingerprint || (slot.role === "gate-counter-review" && review.authority.gate_id !== slot.gate_id)) throw new TypeError(`review does not match slot ${index}`);
    });
    const slots = copyFreezeJson(authority.slots);
    const current = Object.freeze({ task_id: authority.task_id, phase_instance: authority.phase_instance, subject_digest: authority.subject_digest, input_fingerprint: authority.input_fingerprint, current_evidence_set: Object.freeze({ set_digest: currentSetDigest(slots), slots }), reviews: Object.freeze([...reviews]) }) as CurrentReviewSet;
    registerCurrentReviewSet(current);
    return current;
  },
});
