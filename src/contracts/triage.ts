import { z } from "zod";

import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { taskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import {
  CLAIM_TYPES,
  CONFIDENCE_LEVELS,
  REVIEW_FINDING_SEVERITIES,
  isSubstantiveClaim,
  type ClaimType,
  type ConfidenceLevel,
  type ReviewEvidence,
  type ReviewFindingSeverity,
} from "./review.js";
import type { CurrentReviewSet } from "./trust.js";
import { authenticCurrentReviewSet, registerValidatedTriage, validatedTriageBrand } from "./internal/trust-brands.js";

export const TRIAGE_DISPOSITIONS = [
  "accepted",
  "accepted-editorial",
  "rejected",
  "escalated-human",
  "deferred",
] as const;
export type TriageDispositionKind = (typeof TRIAGE_DISPOSITIONS)[number];

export type FindingRef = { readonly review_evidence_digest: Sha256Digest; readonly finding_id: string };
export type AcceptedDisposition = FindingRef & { readonly disposition: "accepted"; readonly rationale: string; readonly revision_intent: string };
/** Non-blocking wording/formatting acceptance: the fix changes bytes but no meaning, so it re-enters produce without invalidating review evidence. */
export type AcceptedEditorialDisposition = FindingRef & { readonly disposition: "accepted-editorial"; readonly rationale: string; readonly revision_intent: string };
export type RejectedDisposition = FindingRef & { readonly disposition: "rejected"; readonly rationale: string; readonly evidence: string };
export type EscalatedHumanDisposition = FindingRef & { readonly disposition: "escalated-human"; readonly rationale: string };
export type DeferredDisposition = FindingRef & { readonly disposition: "deferred"; readonly rationale: string; readonly evidence?: string };
export type TriageDisposition =
  | AcceptedDisposition
  | AcceptedEditorialDisposition
  | RejectedDisposition
  | EscalatedHumanDisposition
  | DeferredDisposition;
/**
 * One carried entry of the server-computed disposition ledger. At each triage install the
 * server embeds the round's dispositions with the reviewer-authored finding details of that
 * round — resolvable then because the reviewed evidence is still the retained counter-review
 * result — and carries the predecessor's ledger forward, so each entry's details survive the
 * supersession that would otherwise make earlier rounds unreconstructable. Producers cannot
 * supply entries: {@link validateTriage} refuses a candidate that arrives with one.
 *
 * For rejected findings `evidence` is the rejection evidence (the disposition's own), matching
 * how the prior-triage record renders rejections; for accepted findings it is the finding's
 * original evidence. The finding detail fields are optional so a predecessor triage installed
 * without resolvable details still carries its dispositions forward.
 */
type TriageDispositionLedgerEntryBase = FindingRef & {
  readonly disposition: TriageDispositionKind;
  /** Durable attempt counter of the round whose review this disposition answered. */
  readonly attempt: SafeInteger;
  readonly rationale?: string;
  readonly revision_intent?: string;
  readonly evidence?: string;
  readonly summary?: string;
  readonly suggested_resolution?: string;
};
export type TriageDispositionLedgerEntryV2 = TriageDispositionLedgerEntryBase & {
  readonly claim_type: ClaimType;
  readonly confidence: ConfidenceLevel;
  readonly falsifier: string;
};
export type GeneralTriageDispositionLedgerEntryV3 = TriageDispositionLedgerEntryBase & {
  readonly claim_type: ClaimType;
  readonly confidence: ConfidenceLevel;
  readonly falsifier: string;
  readonly reviewer_id: string;
  readonly reviewer_focus: "general";
  readonly routing_role: "counter-reviewer";
  readonly criterion_id: string;
  readonly summary: string;
  /** Reviewer-authored finding evidence; disposition evidence remains separate. */
  readonly evidence: string;
  readonly disposition_evidence?: string;
  readonly suggested_resolution: string;
};
export type TestTriageDispositionLedgerEntryV3 = TriageDispositionLedgerEntryBase & {
  readonly claim_type: ClaimType;
  readonly confidence: ConfidenceLevel;
  readonly falsifier: string;
  readonly reviewer_id: string;
  readonly reviewer_focus: "tests";
  readonly routing_role: "test-reviewer";
  readonly criterion_id: string;
  readonly required_behavior_or_risk_boundary: string;
  readonly coverage_or_oracle_problem: string;
  readonly consequence: string;
  readonly proposed_verification_change: string;
  readonly disposition_evidence?: string;
};
export type TriageDispositionLedgerEntryV3 = GeneralTriageDispositionLedgerEntryV3 | TestTriageDispositionLedgerEntryV3;
export type DetailedLegacyTriageDispositionLedgerEntry = TriageDispositionLedgerEntryBase & {
  readonly severity: ReviewFindingSeverity;
  readonly blocking: boolean;
};
export type DetailLessLegacyTriageDispositionLedgerEntry = TriageDispositionLedgerEntryBase;
export type TriageDispositionLedgerEntry =
  | TriageDispositionLedgerEntryV3
  | TriageDispositionLedgerEntryV2
  | DetailedLegacyTriageDispositionLedgerEntry
  | DetailLessLegacyTriageDispositionLedgerEntry;
/**
 * Server-computed identity of one completed counter-review round. This history is distinct from
 * the disposition ledger: a byte-identical recurring finding may replace the same occurrence key,
 * and a finding-free round contributes no disposition at all, while both still count as completed
 * rounds for review push-through eligibility.
 */
export type ReviewRoundHistoryEntryV1 = {
  readonly attempt: SafeInteger;
  readonly review_evidence_digest: Sha256Digest;
};
export type TriageCandidate = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "triage";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly current_evidence_set_digest: Sha256Digest;
  readonly source_evidence_digests: readonly Sha256Digest[];
  readonly dispositions: readonly TriageDisposition[];
  /** Counts ONLY plain `accepted` dispositions; editorial acceptance is counted separately. */
  readonly accepted_count: number;
  readonly rejected_count: number;
  /** Required in new artifacts ({@link validateTriage} refuses its absence); optional structurally so retained pre-editorial triage results keep loading. */
  readonly accepted_editorial_count?: number;
  readonly escalated_human_count?: number;
  readonly deferred_count?: number;
  /** Server-computed reviewer memory; never present on a producer-supplied candidate. */
  readonly disposition_ledger?: readonly TriageDispositionLedgerEntry[];
  /** Server-computed completed-round memory; optional only for retained pre-change artifacts. */
  readonly review_round_history?: readonly ReviewRoundHistoryEntryV1[];
};
export type ValidatedTriage = TriageCandidate & {
  readonly accepted_editorial_count: number;
  readonly escalated_human_count: number;
  readonly deferred_count: number;
  readonly [validatedTriageBrand]: true;
};

const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const nonBlank = z.string().min(1).regex(/\S/, "must contain a non-whitespace character");
const findingRefShape = { review_evidence_digest: digest, finding_id: id };
const acceptedDispositionSchema = z.object({ ...findingRefShape, disposition: z.literal("accepted"), rationale: nonBlank, revision_intent: nonBlank }).strict();
const acceptedEditorialDispositionSchema = z.object({ ...findingRefShape, disposition: z.literal("accepted-editorial"), rationale: nonBlank, revision_intent: nonBlank }).strict();
const rejectedDispositionSchema = z.object({ ...findingRefShape, disposition: z.literal("rejected"), rationale: nonBlank, evidence: nonBlank }).strict();
const escalatedHumanDispositionSchema = z.object({ ...findingRefShape, disposition: z.literal("escalated-human"), rationale: nonBlank }).strict();
const deferredDispositionSchema = z.object({ ...findingRefShape, disposition: z.literal("deferred"), rationale: nonBlank, evidence: nonBlank.optional() }).strict();
export const triageDispositionSchema = z.discriminatedUnion("disposition", [
  acceptedDispositionSchema,
  acceptedEditorialDispositionSchema,
  rejectedDispositionSchema,
  escalatedHumanDispositionSchema,
  deferredDispositionSchema,
]);
const ledgerEntryBaseShape = {
  ...findingRefShape,
  disposition: z.enum(TRIAGE_DISPOSITIONS),
  attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  rationale: nonBlank.optional(),
  revision_intent: nonBlank.optional(),
  evidence: nonBlank.optional(),
  summary: nonBlank.optional(),
  suggested_resolution: nonBlank.optional(),
} as const;
const triageDispositionLedgerEntryV2Schema = z.object({
  ...ledgerEntryBaseShape,
  claim_type: z.enum(CLAIM_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  falsifier: nonBlank,
}).strict();
const ledgerEntryV3AttributionShape = {
  claim_type: z.enum(CLAIM_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  falsifier: nonBlank,
  reviewer_id: id,
  criterion_id: id,
} as const;
const generalTriageDispositionLedgerEntryV3Schema = z.object({
  ...ledgerEntryBaseShape,
  ...ledgerEntryV3AttributionShape,
  reviewer_focus: z.literal("general"),
  routing_role: z.literal("counter-reviewer"),
  summary: nonBlank,
  evidence: nonBlank,
  disposition_evidence: nonBlank.optional(),
  suggested_resolution: nonBlank,
}).strict();
const testTriageDispositionLedgerEntryV3Schema = z.object({
  ...ledgerEntryBaseShape,
  ...ledgerEntryV3AttributionShape,
  reviewer_focus: z.literal("tests"),
  routing_role: z.literal("test-reviewer"),
  required_behavior_or_risk_boundary: nonBlank,
  coverage_or_oracle_problem: nonBlank,
  consequence: nonBlank,
  proposed_verification_change: nonBlank,
  disposition_evidence: nonBlank.optional(),
}).strict();
export const triageDispositionLedgerEntryV3Schema = z.discriminatedUnion("reviewer_focus", [
  generalTriageDispositionLedgerEntryV3Schema,
  testTriageDispositionLedgerEntryV3Schema,
]);
const detailedLegacyTriageDispositionLedgerEntrySchema = z.object({
  ...ledgerEntryBaseShape,
  severity: z.enum(REVIEW_FINDING_SEVERITIES),
  blocking: z.boolean(),
}).strict();
const detailLessLegacyTriageDispositionLedgerEntrySchema = z.object(ledgerEntryBaseShape).strict();
export const triageDispositionLedgerEntrySchema = z.union([
  triageDispositionLedgerEntryV3Schema,
  triageDispositionLedgerEntryV2Schema,
  detailedLegacyTriageDispositionLedgerEntrySchema,
  detailLessLegacyTriageDispositionLedgerEntrySchema,
]) as unknown as z.ZodType<TriageDispositionLedgerEntry>;
export const reviewRoundHistoryEntryV1Schema = z.object({
  attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  review_evidence_digest: digest,
}).strict() as unknown as z.ZodType<ReviewRoundHistoryEntryV1>;
export const reviewRoundHistoryV1Schema = z.array(reviewRoundHistoryEntryV1Schema)
  .superRefine((history, context) => {
    history.forEach((entry, index) => {
      if (index > 0 && history[index - 1]!.attempt >= entry.attempt) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "review round history must be sorted by attempt with no duplicates",
        });
      }
    });
  });
export const triageCandidateSchema = z.object({
  schema_version: z.literal("1"), task_id: taskSlugV1Schema,
  phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u),
  step: z.literal("triage"), subject_digest: digest, input_fingerprint: digest,
  current_evidence_set_digest: digest, source_evidence_digests: z.array(digest),
  dispositions: z.array(triageDispositionSchema),
  accepted_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), rejected_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  accepted_editorial_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  escalated_human_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  deferred_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  disposition_ledger: z.array(triageDispositionLedgerEntrySchema).optional(),
  review_round_history: reviewRoundHistoryV1Schema.optional(),
}).strict().superRefine((triage, context) => {
  if (new Set(triage.source_evidence_digests).size !== triage.source_evidence_digests.length) {
    context.addIssue({ code: "custom", path: ["source_evidence_digests"], message: "source evidence digests must be unique" });
  }
  const seen = new Set<string>();
  triage.dispositions.forEach((disposition, index) => {
    const key = `${disposition.review_evidence_digest}:${disposition.finding_id}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["dispositions", index], message: "duplicate disposition for a finding" });
    seen.add(key);
  });
  const seenLedger = new Set<string>();
  triage.disposition_ledger?.forEach((entry, index) => {
    const key = `${entry.review_evidence_digest}:${entry.finding_id}`;
    if (seenLedger.has(key)) {
      context.addIssue({ code: "custom", path: ["disposition_ledger", index], message: "duplicate ledger finding occurrence" });
    }
    seenLedger.add(key);
  });
});

/** Structural parse only; exact current-review coverage is established by {@link validateTriage}. */
export function parseTriageCandidate(value: unknown): TriageCandidate {
  assertPlainJson(value, "review triage candidate");
  const parsed = triageCandidateSchema.parse(structuredClone(value));
  const dispositions: TriageDisposition[] = parsed.dispositions.map((d) => {
    if (d.disposition === "deferred") {
      const res: DeferredDisposition = {
        review_evidence_digest: d.review_evidence_digest,
        finding_id: d.finding_id,
        disposition: "deferred",
        rationale: d.rationale,
        ...(d.evidence !== undefined ? { evidence: d.evidence } : {}),
      };
      return res;
    }
    return d;
  });
  const {
    accepted_editorial_count,
    escalated_human_count,
    deferred_count,
    disposition_ledger,
    review_round_history,
    ...rest
  } = parsed;
  return {
    ...rest,
    dispositions,
    ...(accepted_editorial_count === undefined ? {} : { accepted_editorial_count }),
    ...(escalated_human_count === undefined ? {} : { escalated_human_count }),
    ...(deferred_count === undefined ? {} : { deferred_count }),
    ...(disposition_ledger === undefined ? {} : { disposition_ledger }),
    ...(review_round_history === undefined ? {} : { review_round_history }),
  };
}

const refKey = (value: FindingRef): string => `${value.review_evidence_digest}:${value.finding_id}`;

export function validateTriage(
  current: CurrentReviewSet,
  candidate: unknown,
  dispositionLedger?: readonly TriageDispositionLedgerEntry[],
  reviewRoundHistory?: readonly ReviewRoundHistoryEntryV1[],
): ValidatedTriage {
  if (!authenticCurrentReviewSet(current)) throw new TypeError("an authenticated current review set is required");
  const parsed = parseTriageCandidate(candidate);
  if (parsed.disposition_ledger !== undefined) {
    throw new TypeError("disposition_ledger is server-computed; triage candidates must not carry one");
  }
  if (parsed.review_round_history !== undefined) {
    throw new TypeError("review_round_history is server-computed; triage candidates must not carry one");
  }
  let parsedDispositionLedger: readonly TriageDispositionLedgerEntry[] | undefined;
  if (dispositionLedger !== undefined) {
    assertPlainJson(dispositionLedger, "triage disposition ledger");
    parsedDispositionLedger = z.array(triageDispositionLedgerEntrySchema).parse(structuredClone(dispositionLedger));
  }
  let parsedReviewRoundHistory: readonly ReviewRoundHistoryEntryV1[] | undefined;
  if (reviewRoundHistory !== undefined) {
    assertPlainJson(reviewRoundHistory, "review round history");
    parsedReviewRoundHistory = reviewRoundHistoryV1Schema.parse(structuredClone(reviewRoundHistory));
  }
  if (parsed.task_id !== current.task_id || parsed.phase_instance !== current.phase_instance || parsed.subject_digest !== current.subject_digest || parsed.input_fingerprint !== current.input_fingerprint || parsed.current_evidence_set_digest !== current.current_evidence_set.set_digest) throw new TypeError("triage scope does not match current review set");
  const expectedDigests = current.current_evidence_set.slots.map((slot) => slot.evidence_digest);
  if (parsed.source_evidence_digests.length !== expectedDigests.length || parsed.source_evidence_digests.some((digestValue, index) => digestValue !== expectedDigests[index])) throw new TypeError("source_evidence_digests must exactly match canonical current slots");
  const expected = new Set<string>();
  const findingsByKey = new Map<string, ReviewEvidence["findings"][number]>();
  for (const review of current.reviews) {
    const localIds = new Set<string>();
    for (const finding of review.evidence.findings) {
      if (localIds.has(finding.finding_id)) throw new TypeError(`review ${review.evidence_digest} has duplicate finding_id ${finding.finding_id}`);
      localIds.add(finding.finding_id);
      const key = refKey({ review_evidence_digest: review.evidence_digest, finding_id: finding.finding_id });
      expected.add(key);
      findingsByKey.set(key, finding);
    }
  }
  const actual = new Set<string>();
  const isEditorialAllowed = parsed.phase_instance === "prd" || parsed.phase_instance === "design";
  for (const disposition of parsed.dispositions) {
    const key = refKey(disposition);
    if (actual.has(key)) throw new TypeError(`duplicate triage disposition ${key}`);
    if (!expected.has(key)) throw new TypeError(`foreign or stale triage disposition ${key}`);
    const finding = findingsByKey.get(key)!;
    if (disposition.disposition === "accepted-editorial") {
      if (isSubstantiveClaim(finding)) {
        throw new TypeError(
          `accepted-editorial is refused for substantive finding ${key}; a substantive finding's fix is never purely editorial — use "accepted", "rejected", "escalated-human", or "deferred"`
        );
      }
      if (!isEditorialAllowed) {
        throw new TypeError(
          `accepted-editorial is refused for position ${parsed.phase_instance}; editorial produce is supported only for PRD and design — use "accepted"`
        );
      }
    }
    if (disposition.disposition === "deferred") {
      const isDefectOrBlocking = ("claim_type" in finding && finding.claim_type === "defect") ||
        (!("claim_type" in finding) && finding.blocking === true);
      if (isDefectOrBlocking) {
        throw new TypeError(
          `deferred is refused for defect finding ${key}; a defect cannot be deferred without remediation or falsification — use "accepted", "rejected", or "escalated-human"`
        );
      }
      if (isSubstantiveClaim(finding)) {
        if (typeof disposition.evidence !== "string" || disposition.evidence.trim().length === 0) {
          throw new TypeError(
            `deferred requires non-blank evidence demonstrating non-material consequence for substantive finding ${key}`
          );
        }
      } else {
        if (typeof disposition.rationale !== "string" || disposition.rationale.trim().length === 0) {
          throw new TypeError(
            `deferred requires non-blank rationale for finding ${key}`
          );
        }
      }
    }
    actual.add(key);
  }
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) throw new TypeError("triage dispositions must exactly cover every current finding");
  const accepted = parsed.dispositions.filter((value) => value.disposition === "accepted").length;
  const acceptedEditorial = parsed.dispositions.filter((value) => value.disposition === "accepted-editorial").length;
  const rejected = parsed.dispositions.filter((value) => value.disposition === "rejected").length;
  const escalatedHuman = parsed.dispositions.filter((value) => value.disposition === "escalated-human").length;
  const deferred = parsed.dispositions.filter((value) => value.disposition === "deferred").length;
  if (parsed.accepted_editorial_count === undefined) throw new TypeError("triage requires accepted_editorial_count");
  if (parsed.escalated_human_count === undefined) throw new TypeError("triage requires escalated_human_count");
  if (parsed.deferred_count === undefined) throw new TypeError("triage requires deferred_count");
  if (
    parsed.accepted_count !== accepted ||
    parsed.rejected_count !== rejected ||
    parsed.accepted_editorial_count !== acceptedEditorial ||
    parsed.escalated_human_count !== escalatedHuman ||
    parsed.deferred_count !== deferred
  ) {
    throw new TypeError("triage disposition counts are contradictory");
  }
  const validated = Object.freeze({
    ...parsed,
    accepted_editorial_count: parsed.accepted_editorial_count,
    escalated_human_count: parsed.escalated_human_count,
    deferred_count: parsed.deferred_count,
    ...(parsedDispositionLedger === undefined
      ? {}
      : { disposition_ledger: Object.freeze(parsedDispositionLedger.map((entry) => Object.freeze({ ...entry }))) }),
    ...(parsedReviewRoundHistory === undefined
      ? {}
      : { review_round_history: Object.freeze(parsedReviewRoundHistory.map((entry) => Object.freeze({ ...entry }))) }),
    source_evidence_digests: Object.freeze([...parsed.source_evidence_digests]),
    dispositions: Object.freeze(parsed.dispositions.map((value) => Object.freeze({ ...value }))),
  }) as ValidatedTriage;
  registerValidatedTriage(validated);
  return validated;
}
