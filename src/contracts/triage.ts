import { z } from "zod";

import type { Sha256Digest, TaskSlug } from "./evidence.js";
import { taskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import type { CurrentReviewSet } from "./trust.js";
import { authenticCurrentReviewSet, registerValidatedTriage, validatedTriageBrand } from "./internal/trust-brands.js";


export type FindingRef = { readonly review_evidence_digest: Sha256Digest; readonly finding_id: string };
export type AcceptedDisposition = FindingRef & { readonly disposition: "accepted"; readonly rationale: string; readonly revision_intent: string };
export type RejectedDisposition = FindingRef & { readonly disposition: "rejected"; readonly rationale: string; readonly evidence: string };
export type TriageDisposition = AcceptedDisposition | RejectedDisposition;
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
  readonly accepted_count: number;
  readonly rejected_count: number;
};
export type ValidatedTriage = TriageCandidate & { readonly [validatedTriageBrand]: true };

const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, "must contain a non-whitespace character");
const findingRefShape = { review_evidence_digest: digest, finding_id: id };
const acceptedDispositionSchema = z.object({ ...findingRefShape, disposition: z.literal("accepted"), rationale: nonBlank, revision_intent: nonBlank }).strict();
const rejectedDispositionSchema = z.object({ ...findingRefShape, disposition: z.literal("rejected"), rationale: nonBlank, evidence: nonBlank }).strict();
export const triageDispositionSchema = z.discriminatedUnion("disposition", [acceptedDispositionSchema, rejectedDispositionSchema]);
export const triageCandidateSchema = z.object({
  schema_version: z.literal("1"), task_id: taskSlugV1Schema,
  phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u),
  step: z.literal("triage"), subject_digest: digest, input_fingerprint: digest,
  current_evidence_set_digest: digest, source_evidence_digests: z.array(digest),
  dispositions: z.array(triageDispositionSchema),
  accepted_count: z.number().int().nonnegative().safe(), rejected_count: z.number().int().nonnegative().safe(),
}).strict();

/** Structural parse only; exact current-review coverage is established by {@link validateTriage}. */
export function parseTriageCandidate(value: unknown): TriageCandidate {
  assertPlainJson(value, "review triage candidate");
  return triageCandidateSchema.parse(value);
}

const refKey = (value: FindingRef): string => `${value.review_evidence_digest}:${value.finding_id}`;

export function validateTriage(current: CurrentReviewSet, candidate: unknown): ValidatedTriage {
  if (!authenticCurrentReviewSet(current)) throw new TypeError("an authenticated current review set is required");
  const parsed = parseTriageCandidate(candidate);
  if (parsed.task_id !== current.task_id || parsed.phase_instance !== current.phase_instance || parsed.subject_digest !== current.subject_digest || parsed.input_fingerprint !== current.input_fingerprint || parsed.current_evidence_set_digest !== current.current_evidence_set.set_digest) throw new TypeError("triage scope does not match current review set");
  const expectedDigests = current.current_evidence_set.slots.map((slot) => slot.evidence_digest);
  if (parsed.source_evidence_digests.length !== expectedDigests.length || parsed.source_evidence_digests.some((digestValue, index) => digestValue !== expectedDigests[index])) throw new TypeError("source_evidence_digests must exactly match canonical current slots");
  const expected = new Set<string>();
  for (const review of current.reviews) {
    const localIds = new Set<string>();
    for (const finding of review.evidence.findings) {
      if (localIds.has(finding.finding_id)) throw new TypeError(`review ${review.evidence_digest} has duplicate finding_id ${finding.finding_id}`);
      localIds.add(finding.finding_id);
      expected.add(refKey({ review_evidence_digest: review.evidence_digest, finding_id: finding.finding_id }));
    }
  }
  const actual = new Set<string>();
  for (const disposition of parsed.dispositions) {
    const key = refKey(disposition);
    if (actual.has(key)) throw new TypeError(`duplicate triage disposition ${key}`);
    if (!expected.has(key)) throw new TypeError(`foreign or stale triage disposition ${key}`);
    actual.add(key);
  }
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) throw new TypeError("triage dispositions must exactly cover every current finding");
  const accepted = parsed.dispositions.filter((value) => value.disposition === "accepted").length;
  const rejected = parsed.dispositions.length - accepted;
  if (parsed.accepted_count !== accepted || parsed.rejected_count !== rejected) throw new TypeError("triage disposition counts are contradictory");
  const validated = Object.freeze({ ...parsed, source_evidence_digests: Object.freeze([...parsed.source_evidence_digests]), dispositions: Object.freeze(parsed.dispositions.map((value) => Object.freeze({ ...value }))) }) as ValidatedTriage;
  registerValidatedTriage(validated);
  return validated;
}
