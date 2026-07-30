import { canonicalJsonDigest } from "../contracts/canonical.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import {
  parseSha256Digest,
  parseTaskSlug,
  type Sha256Digest,
  type TaskSlug,
} from "../contracts/evidence.js";
import { parsePhaseInstanceId, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { type ModelFamily } from "../contracts/review.js";
import { parseRubricV1, type RubricV1 } from "../contracts/rubric.js";

export const REVIEW_ENVELOPE_BYTE_CAP = 1_048_576;

/**
 * The complete counter-review binding sent to the child. Gate counter-review is a later
 * extension point: it needs a binding-only gate_id and must not be widened into this shape.
 */
export type DispatchSubject = {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly role: "counter-review";
  readonly step: "counter_review";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly rubric_digest: Sha256Digest;
  readonly producer_family: ModelFamily;
  readonly invocation_id: string;
  readonly result_id: string;
};

export type ReviewEnvelopeInput = {
  readonly artifact: string;
  readonly rubric: RubricV1;
  readonly subject: DispatchSubject;
};

export type DispatchEnvelope = {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly byte_count: number;
};

/** Phase 14 adds a result-kind discriminator to DispatchEnvelope; Phase 13 is review-only. */

export class ReviewEnvelopeError extends Error {
  public readonly project_error: ProjectError;

  public constructor(projectError: ProjectError) {
    super(`review envelope failed: ${projectError.code}`);
    this.name = "ReviewEnvelopeError";
    this.project_error = projectError;
  }
}

const EVIDENCE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const utf8 = new TextEncoder();

function parseEvidenceId(value: unknown, field: "invocation_id" | "result_id"): string {
  if (typeof value !== "string" || !EVIDENCE_ID.test(value)) {
    throw new TypeError(`${field} must use the review evidence identifier vocabulary`);
  }
  return value;
}

function exactFields(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function materialize<T>(value: T): T {
  assertPlainJson(value, "review envelope input");
  return structuredClone(value) as T;
}

function validateSubject(value: DispatchSubject): DispatchSubject {
  exactFields(value, [
    "task_id",
    "phase_instance",
    "role",
    "step",
    "subject_digest",
    "input_fingerprint",
    "rubric_digest",
    "producer_family",
    "invocation_id",
    "result_id",
  ], "dispatch subject");
  if (value.role !== "counter-review" || value.step !== "counter_review") {
    throw new TypeError("dispatch subject must be an ordinary counter-review");
  }
  if (value.producer_family !== "claude" && value.producer_family !== "codex") {
    throw new TypeError("dispatch subject producer_family is invalid");
  }
  return {
    task_id: parseTaskSlug(value.task_id),
    phase_instance: parsePhaseInstanceId(value.phase_instance),
    role: value.role,
    step: value.step,
    subject_digest: parseSha256Digest(value.subject_digest),
    input_fingerprint: parseSha256Digest(value.input_fingerprint),
    rubric_digest: parseSha256Digest(value.rubric_digest),
    producer_family: value.producer_family,
    invocation_id: parseEvidenceId(value.invocation_id, "invocation_id"),
    result_id: parseEvidenceId(value.result_id, "result_id"),
  };
}

/**
 * Builds the sole Phase 13 child input. The closed input and subject shells deliberately make
 * producer history, findings, triage, repository context, and agent instructions unrepresentable.
 */
export function buildReviewEnvelope(value: ReviewEnvelopeInput): DispatchEnvelope {
  const snapshot = materialize(value);
  exactFields(snapshot, ["artifact", "rubric", "subject"], "review envelope input");
  if (typeof snapshot.artifact !== "string") throw new TypeError("review envelope artifact must be text");
  const parsedRubric = parseRubricV1(snapshot.rubric);
  const rubric = {
    schema_version: parsedRubric.schema_version,
    kind: parsedRubric.kind,
    mode: parsedRubric.mode,
    criteria: parsedRubric.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      blocking: criterion.blocking,
    })),
  } as const;

  const envelope = {
    schema_version: "1",
    artifact: snapshot.artifact,
    rubric,
    subject: validateSubject(snapshot.subject),
  } as const satisfies PlainJsonValue;
  // Child-visible versioning is deliberately the first field. The shared canonical encoder sorts
  // object keys ordinally (putting `artifact` first), so this boundary uses the already validated,
  // explicitly constructed insertion order. The digest below remains canonical and independently
  // domain-separated.
  const bytes = utf8.encode(`${JSON.stringify(envelope, null, 2)}\n`);
  if (bytes.byteLength > REVIEW_ENVELOPE_BYTE_CAP) {
    throw new ReviewEnvelopeError(createProjectError("CONTRACT_INVALID", { issue_code: "envelope-byte-cap" }));
  }

  const digest = canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "dispatch-envelope",
    artifact: envelope.artifact,
    rubric: envelope.rubric,
    subject: envelope.subject,
  });
  return Object.freeze({ bytes, digest, byte_count: bytes.byteLength });
}

/** Phase 14 supplies an output-schema input to buildInvocation; this module implements neither. */
