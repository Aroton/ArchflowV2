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

/**
 * The closed vocabulary of evidence the server can pin alongside the artifact. Entries are always
 * assembled mechanically from durable authority — never author-curated — and each phase of the
 * context contract grows this enum rather than the envelope shape.
 */
export const PINNED_CONTEXT_KINDS = [
  "user-ask", "approved-upstream", "verification-transcript",
  "interface-excerpt", "conventions", "repo-map",
] as const;
export type PinnedContextKind = (typeof PINNED_CONTEXT_KINDS)[number];

/**
 * One pinned evidence entry. The `status` vocabulary makes every gap visible bytes the reviewer
 * can name: `pinned` carries the evidence, `truncated` carries a bounded head plus the full-file
 * digest, `unavailable` names evidence that could not be assembled, and `omitted-cap` names
 * evidence dropped to fit the envelope byte cap while retaining its digest. A reviewer records
 * gaps under the rubric's `unverifiable-claims` criterion instead of guessing.
 */
export type PinnedContextEntry =
  | {
      readonly kind: PinnedContextKind;
      readonly label: string;
      readonly status: "pinned";
      readonly content_digest: Sha256Digest;
      readonly encoding: "utf8" | "base64";
      readonly content: string;
    }
  | {
      readonly kind: PinnedContextKind;
      readonly label: string;
      readonly status: "truncated";
      readonly content_digest: Sha256Digest;
      readonly encoding: "utf8" | "base64";
      readonly content: string;
      readonly total_byte_count: number;
    }
  | {
      readonly kind: PinnedContextKind;
      readonly label: string;
      readonly status: "unavailable";
      readonly note: string;
    }
  | {
      readonly kind: PinnedContextKind;
      readonly label: string;
      readonly status: "omitted-cap";
      readonly content_digest: Sha256Digest;
      readonly note: string;
    };

export type ReviewEnvelopeInput = {
  readonly artifact: string;
  readonly rubric: RubricV1;
  readonly context: readonly PinnedContextEntry[];
  readonly subject: DispatchSubject;
};

export type DispatchEnvelope = Readonly<{
  readonly result_kind: "review" | "adjudication";
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly byte_count: number;
}>;

export type AdjudicationSubject = {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly role: "adjudication";
  readonly step: "adjudicate";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly pinned_constitution_digest: Sha256Digest;
  readonly approved_upstream_digests: readonly Sha256Digest[];
  readonly source_evidence_set_digest: Sha256Digest;
  readonly invocation_id: string;
  readonly result_id: string;
};

export type AdjudicationRuleInput = {
  readonly id: string;
  readonly version: number;
  readonly text: string;
  readonly review_trigger?: string;
  readonly enforced_by: readonly string[];
};

export type AdjudicationUpstreamInput = {
  readonly upstream_digest: Sha256Digest;
  readonly artifact: string;
};

export type AdjudicationEnvelopeInput = {
  readonly artifact: string;
  readonly rules: readonly AdjudicationRuleInput[];
  readonly approved_upstreams: readonly AdjudicationUpstreamInput[];
  readonly source_evidence_set_digest: Sha256Digest;
  readonly subject: AdjudicationSubject;
};

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

function validateAdjudicationSubject(value: AdjudicationSubject): AdjudicationSubject {
  exactFields(value, [
    "task_id",
    "phase_instance",
    "role",
    "step",
    "subject_digest",
    "input_fingerprint",
    "pinned_constitution_digest",
    "approved_upstream_digests",
    "source_evidence_set_digest",
    "invocation_id",
    "result_id",
  ], "adjudication subject");
  if (value.role !== "adjudication" || value.step !== "adjudicate") {
    throw new TypeError("adjudication subject must bind the adjudication step");
  }
  const approvedUpstreamDigests = value.approved_upstream_digests.map(parseSha256Digest);
  if (new Set(approvedUpstreamDigests).size !== approvedUpstreamDigests.length ||
      approvedUpstreamDigests.some((digest, index) => index > 0 && approvedUpstreamDigests[index - 1]! >= digest)) {
    throw new TypeError("approved_upstream_digests must be sorted and unique");
  }
  return {
    task_id: parseTaskSlug(value.task_id),
    phase_instance: parsePhaseInstanceId(value.phase_instance),
    role: value.role,
    step: value.step,
    subject_digest: parseSha256Digest(value.subject_digest),
    input_fingerprint: parseSha256Digest(value.input_fingerprint),
    pinned_constitution_digest: parseSha256Digest(value.pinned_constitution_digest),
    approved_upstream_digests: approvedUpstreamDigests,
    source_evidence_set_digest: parseSha256Digest(value.source_evidence_set_digest),
    invocation_id: parseEvidenceId(value.invocation_id, "invocation_id"),
    result_id: parseEvidenceId(value.result_id, "result_id"),
  };
}

function parseNonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must contain text`);
  }
  return value;
}

function parseEncoding(value: unknown): "utf8" | "base64" {
  if (value !== "utf8" && value !== "base64") {
    throw new TypeError("pinned context encoding must be utf8 or base64");
  }
  return value;
}

function validateContext(values: readonly PinnedContextEntry[]): readonly PinnedContextEntry[] {
  return values.map((value) => {
    if (!(PINNED_CONTEXT_KINDS as readonly string[]).includes(value.kind)) {
      throw new TypeError("pinned context kind is not in the closed vocabulary");
    }
    const kind = value.kind;
    const label = parseNonBlank(value.label, "pinned context label");
    switch (value.status) {
      case "pinned":
        exactFields(value, ["kind", "label", "status", "content_digest", "encoding", "content"], "pinned context entry");
        return {
          kind, label, status: value.status,
          content_digest: parseSha256Digest(value.content_digest),
          encoding: parseEncoding(value.encoding),
          content: typeof value.content === "string" ? value.content : (() => { throw new TypeError("pinned context content must be text"); })(),
        };
      case "truncated":
        exactFields(value, ["kind", "label", "status", "content_digest", "encoding", "content", "total_byte_count"], "truncated context entry");
        if (!Number.isSafeInteger(value.total_byte_count) || value.total_byte_count < 1) {
          throw new TypeError("truncated context total_byte_count must be a positive safe integer");
        }
        return {
          kind, label, status: value.status,
          content_digest: parseSha256Digest(value.content_digest),
          encoding: parseEncoding(value.encoding),
          content: typeof value.content === "string" ? value.content : (() => { throw new TypeError("truncated context content must be text"); })(),
          total_byte_count: value.total_byte_count,
        };
      case "unavailable":
        exactFields(value, ["kind", "label", "status", "note"], "unavailable context entry");
        return { kind, label, status: value.status, note: parseNonBlank(value.note, "unavailable context note") };
      case "omitted-cap":
        exactFields(value, ["kind", "label", "status", "content_digest", "note"], "omitted context entry");
        return {
          kind, label, status: value.status,
          content_digest: parseSha256Digest(value.content_digest),
          note: parseNonBlank(value.note, "omitted context note"),
        };
      default:
        throw new TypeError("pinned context status is invalid");
    }
  });
}

function validateRules(values: readonly AdjudicationRuleInput[]): readonly AdjudicationRuleInput[] {
  const rules = values.map((value) => {
    const expected = value.review_trigger === undefined
      ? ["id", "version", "text", "enforced_by"]
      : ["id", "version", "text", "review_trigger", "enforced_by"];
    exactFields(value, expected, "adjudication rule");
    if (!EVIDENCE_ID.test(value.id)) throw new TypeError("rule id must use the evidence identifier vocabulary");
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
      throw new TypeError("rule version must be a positive safe integer");
    }
    const enforcedBy = value.enforced_by.map((mechanism) => parseNonBlank(mechanism, "enforced_by entry"));
    if (new Set(enforcedBy).size !== enforcedBy.length) throw new TypeError("enforced_by entries must be unique");
    return {
      id: value.id,
      version: value.version,
      text: parseNonBlank(value.text, "rule text"),
      ...(value.review_trigger === undefined
        ? {}
        : { review_trigger: parseNonBlank(value.review_trigger, "review_trigger") }),
      enforced_by: enforcedBy,
    };
  });
  const keys = rules.map((rule) => `${rule.id}:${String(rule.version)}`);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) {
    throw new TypeError("adjudication rules must be sorted and unique");
  }
  return rules;
}

function validateUpstreams(values: readonly AdjudicationUpstreamInput[]): readonly AdjudicationUpstreamInput[] {
  const upstreams = values.map((value) => {
    exactFields(value, ["upstream_digest", "artifact"], "approved upstream");
    if (typeof value.artifact !== "string") throw new TypeError("approved upstream artifact must be text");
    return { upstream_digest: parseSha256Digest(value.upstream_digest), artifact: value.artifact };
  });
  const digests = upstreams.map((upstream) => upstream.upstream_digest);
  if (new Set(digests).size !== digests.length ||
      digests.some((digest, index) => index > 0 && digests[index - 1]! >= digest)) {
    throw new TypeError("approved upstreams must be sorted and unique");
  }
  return upstreams;
}

function finishEnvelope(
  resultKind: DispatchEnvelope["result_kind"],
  envelope: PlainJsonValue,
  digestKind: "dispatch-envelope" | "adjudication-envelope",
): DispatchEnvelope {
  const bytes = utf8.encode(`${JSON.stringify(envelope, null, 2)}\n`);
  if (bytes.byteLength > REVIEW_ENVELOPE_BYTE_CAP) {
    throw new ReviewEnvelopeError(createProjectError("CONTRACT_INVALID", { issue_code: "envelope-byte-cap" }));
  }
  const digest = canonicalJsonDigest({
    ...(envelope as Readonly<Record<string, PlainJsonValue>>),
    digest_kind: digestKind,
  });
  return Object.freeze({ result_kind: resultKind, bytes, digest, byte_count: bytes.byteLength });
}

/**
 * Builds the sole counter-review child input. The closed input and subject shells deliberately make
 * producer history, findings, triage, and agent instructions unrepresentable. `context` is the one
 * sanctioned channel for repository-derived evidence, and it admits only mechanically assembled,
 * digest-recorded entries in the closed `PINNED_CONTEXT_KINDS` vocabulary — never free-form
 * instructions or author-curated material.
 */
export function buildReviewEnvelope(value: ReviewEnvelopeInput): DispatchEnvelope {
  const snapshot = materialize(value);
  exactFields(snapshot, ["artifact", "rubric", "context", "subject"], "review envelope input");
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
    context: validateContext(snapshot.context),
    subject: validateSubject(snapshot.subject),
  } as const satisfies PlainJsonValue;
  // Child-visible versioning is deliberately the first field. The shared canonical encoder sorts
  // object keys ordinally (putting `artifact` first), so this boundary uses the already validated,
  // explicitly constructed insertion order. The digest below remains canonical and independently
  // domain-separated.
  return finishEnvelope("review", envelope, "dispatch-envelope");
}

/**
 * Builds the adjudicator's complete child-visible authority. Instructions deliberately mention
 * only values present in these bytes; envelope_input_digest is server-side provenance.
 */
export function buildAdjudicationEnvelope(value: AdjudicationEnvelopeInput): DispatchEnvelope {
  const snapshot = materialize(value);
  exactFields(
    snapshot,
    ["artifact", "rules", "approved_upstreams", "source_evidence_set_digest", "subject"],
    "adjudication envelope input",
  );
  if (typeof snapshot.artifact !== "string") throw new TypeError("adjudication envelope artifact must be text");
  const rules = validateRules(snapshot.rules);
  const approvedUpstreams = validateUpstreams(snapshot.approved_upstreams);
  const subject = validateAdjudicationSubject(snapshot.subject);
  const sourceEvidenceSetDigest = parseSha256Digest(snapshot.source_evidence_set_digest);
  if (sourceEvidenceSetDigest !== subject.source_evidence_set_digest) {
    throw new TypeError("source_evidence_set_digest must match the adjudication subject");
  }
  const upstreamDigests = approvedUpstreams.map((upstream) => upstream.upstream_digest);
  if (upstreamDigests.length !== subject.approved_upstream_digests.length ||
      upstreamDigests.some((digest, index) => digest !== subject.approved_upstream_digests[index])) {
    throw new TypeError("approved upstreams must match the adjudication subject");
  }

  const envelope = {
    schema_version: "1",
    artifact: snapshot.artifact,
    rules,
    approved_upstreams: approvedUpstreams,
    source_evidence_set_digest: sourceEvidenceSetDigest,
    instructions: {
      rule_coverage: "Return exactly one rule finding for every supplied rule, using its id as rule_id and version as rule_version.",
      mechanism_evidence: "For a rule with declared enforced_by labels, return uncertain compliance and one unknown-state entry for each declared mechanism. Do not claim current mechanical evidence.",
      undeclared_mechanisms: "For a rule with no declared enforced_by labels, return an empty enforced_by list.",
    },
    subject,
  } as const satisfies PlainJsonValue;
  return finishEnvelope("adjudication", envelope, "adjudication-envelope");
}
