import { z } from "zod";

import { canonicalJsonDigest, type CanonicalDocument } from "./canonical.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type Sha256Digest, type TaskSlug } from "./evidence.js";
import { GATE_KINDS, type GateKind } from "./gates.js";
import { phaseInstanceIdV1Schema, type PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
import { reviewEvidenceSchema, type ReviewEvidence } from "./review.js";
import { triageCandidateSchema, type TriageCandidate } from "./triage.js";

export type SupplementalReviewRecordV1 = {
  readonly schema_version: "1";
  readonly gate_id: PathSafeId;
  readonly request_digest: Sha256Digest;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly kind: GateKind;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly current_evidence_set_digest: Sha256Digest;
  readonly evidence_digest: Sha256Digest;
  readonly projection_digest: Sha256Digest;
  readonly review: ReviewEvidence;
  readonly triage_digest: Sha256Digest;
  readonly triage: TriageCandidate;
  readonly outcome: "no-change" | "accepted-change";
};

const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
export const supplementalReviewRecordV1Schema = z.object({
  schema_version: z.literal("1"),
  gate_id: pathSafeIdV1Schema,
  request_digest: digest,
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  kind: z.enum(GATE_KINDS),
  subject_digest: digest,
  context_digest: digest,
  input_fingerprint: digest,
  current_evidence_set_digest: digest,
  evidence_digest: digest,
  projection_digest: digest,
  review: reviewEvidenceSchema,
  triage_digest: digest,
  triage: triageCandidateSchema,
  outcome: z.enum(["no-change", "accepted-change"]),
}).strict() as z.ZodType<SupplementalReviewRecordV1>;

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

/** Parses the compound record and enforces its self-digests and exact-cover triage semantics. */
export function parseSupplementalReviewRecord(value: unknown): SupplementalReviewRecordV1 {
  assertPlainJson(value, "supplemental review record");
  const parsed = deepFreezeJson(supplementalReviewRecordV1Schema.parse(value));
  if (
    parsed.review.assurance !== "degraded" ||
    parsed.review.role !== "gate-counter-review" ||
    parsed.review.step !== "counter_review" ||
    parsed.review.producer_family === parsed.review.model_family
  ) throw new TypeError("supplemental review must be degraded opposite-family gate evidence");
  if (canonicalJsonDigest(parsed.review) !== parsed.evidence_digest) {
    throw new TypeError("supplemental evidence digest does not match review");
  }
  if (canonicalJsonDigest(parsed.triage) !== parsed.triage_digest) {
    throw new TypeError("supplemental triage digest does not match triage");
  }
  if (
    parsed.review.task_id !== parsed.task_id ||
    parsed.review.phase_instance !== parsed.phase_instance ||
    parsed.review.subject_digest !== parsed.subject_digest ||
    parsed.review.input_fingerprint !== parsed.input_fingerprint ||
    parsed.triage.task_id !== parsed.task_id ||
    parsed.triage.phase_instance !== parsed.phase_instance ||
    parsed.triage.subject_digest !== parsed.subject_digest ||
    parsed.triage.input_fingerprint !== parsed.input_fingerprint ||
    parsed.triage.current_evidence_set_digest !== parsed.current_evidence_set_digest ||
    parsed.triage.source_evidence_digests.length !== 1 ||
    parsed.triage.source_evidence_digests[0] !== parsed.evidence_digest
  ) throw new TypeError("supplemental review and triage bindings disagree");

  const expected = new Set(parsed.review.findings.map((finding) => finding.finding_id));
  const actual = new Set<string>();
  for (const disposition of parsed.triage.dispositions) {
    if (
      disposition.review_evidence_digest !== parsed.evidence_digest ||
      !expected.has(disposition.finding_id) ||
      actual.has(disposition.finding_id)
    ) throw new TypeError("supplemental triage contains a foreign or duplicate finding");
    actual.add(disposition.finding_id);
  }
  if (actual.size !== expected.size) throw new TypeError("supplemental triage must exactly cover every finding");
  const accepted = parsed.triage.dispositions.filter((item) => item.disposition === "accepted").length;
  if (
    parsed.triage.accepted_count !== accepted ||
    parsed.triage.rejected_count !== parsed.triage.dispositions.length - accepted ||
    parsed.outcome !== (accepted === 0 ? "no-change" : "accepted-change")
  ) throw new TypeError("supplemental triage outcome is contradictory");
  return parsed;
}

export type SupplementalReviewRecordDocument = CanonicalDocument<SupplementalReviewRecordV1>;
