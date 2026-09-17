import { loadReviewDocumentConfiguration } from "./documents.js";
import { loadReviewInputConfiguration, prepareReviewInputs, renderReviewPrompt, type ReviewDocument } from "./inputs.js";
import { canonicalJsonDigest, parseGitOid, sha256Bytes, type GitOid } from "../contracts/canonical.js";
import { REPOSITORY_NAME_PATTERN } from "../contracts/config.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import {
  parseSafeInteger,
  parseSha256Digest,
  parseTaskSlug,
  type SafeInteger,
  type Sha256Digest,
  type TaskSlug,
} from "../contracts/evidence.js";
import { parsePhaseInstanceId, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import {
  MODEL_FAMILIES,
  type LegacyConfirmationAssignmentV1,
  type ModelFamily,
} from "../contracts/review.js";
import { parseRubricV1, type RubricV1 } from "../contracts/rubric.js";
import { parseEffortEnvelopeV3, type EffortEnvelopeV3 } from "../contracts/effort-review.js";

/**
 * The complete server-only counter-review binding. Gate counter-review is a later
 * extension point: it needs a binding-only gate_id and must not be widened into this shape.
 */
export type DispatchSubject = {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly role: "counter-review";
  readonly step: "counter_review";
  /**
   * The durable attempt counter for this phase instance, stamped by the server from transaction
   * authority — never caller prose. It tells the reviewer this is round N of the same subject, so
   * the pinned `prior-triage` context (when present) reads as the record of the round before.
   */
  readonly attempt: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly rubric_digest: Sha256Digest;
  readonly producer_family: ModelFamily;
  readonly invocation_id: string;
  readonly result_id: string;
};

/**
 * The closed vocabulary of evidence the server can pin alongside the artifact. Entries are always
 * assembled by the server from durable authority or explicitly identified supporting evidence; each phase of the
 * context contract grows this enum rather than the envelope shape. `prior-triage` is the
 * mechanical triage record of the previous review round of this same phase instance, assembled by
 * the server from retained result manifests; it is admissible where producer prose is not because
 * every field restates durable triage/review authority.
 */
export const PINNED_CONTEXT_KINDS = [
  "user-ask", "approved-upstream", "imported-reference", "validation-override", "verification-transcript",
  "prior-triage", "interface-excerpt", "conventions", "repo-map",
] as const;
export type PinnedContextKind = (typeof PINNED_CONTEXT_KINDS)[number];

/**
 * One pinned evidence entry. The `status` vocabulary makes every gap visible bytes the reviewer
 * can name: `pinned` carries the evidence, `truncated` carries a bounded excerpt plus the full-file
 * digest, `unavailable` names evidence that could not be assembled, and `omitted-cap` names
 * evidence dropped to fit the envelope byte cap while retaining its digest. A reviewer records
 * gaps under the rubric's `unverifiable-claims` criterion instead of guessing.
 */
export type PinnedContextEntry = { readonly source_version?: string } & (
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
    }
);

/**
 * The one fixed sentence the envelope may say about the reviewer's working directory. The note is
 * a literal, never caller prose: prepending free text to stdin would break byte-provenance, and a
 * variable note would reopen the instruction channel this binding deliberately closes.
 */
export const REPOSITORY_VIEW_NOTE =
  "The repository snapshot is at repositories/primary/, excluding .archflow/tasks. Inspect it without modifying files. It is evidence for claims about the review subject, not a separate review subject. The artifact and pinned context take precedence on conflict.";

/** Fixed child-visible explanation of the retained implementation snapshot. */
export const PRODUCED_REPOSITORY_VIEW_NOTE =
  "The repository snapshot at repositories/primary/ contains the authenticated implementation output, excluding .archflow/tasks. Inspect it without modifying files. Review the declared outputs and their current post-change behavior. Unchanged files are supporting evidence only.";

/** Fixed child-visible navigation and authority boundary for a named repository set. */
export const MULTI_REPOSITORY_VIEW_NOTE =
  "Repository snapshots are at repositories/<name>/; cite files as <name>/<path>. Changed repositories contain the authenticated proposed output; review only their declared outputs and their current post-change behavior. Every other file is supporting evidence only. The artifact and pinned context take precedence on conflict.";

export type MultiRepositoryWorkspaceEntry = {
  readonly name: string;
  readonly path: string;
  readonly repository_identity_digest: Sha256Digest;
  readonly commit: GitOid;
  readonly snapshot_digest?: Sha256Digest;
};

export type MultiRepositoryWorkspaceBinding = {
  readonly kind: "read-only-multi-repository-view";
  readonly note: typeof MULTI_REPOSITORY_VIEW_NOTE;
  readonly repositories: readonly MultiRepositoryWorkspaceEntry[];
};

/**
 * Declares the read-only repository view offered to either review child. A plain checkout binds
 * one commit; an implementation snapshot binds its baseline plus the retained declared-output
 * snapshot applied there. Absence describes the historical empty workspace.
 */
export type ReviewWorkspaceBinding =
  | {
      readonly kind: "read-only-repository-checkout";
      readonly commit: GitOid;
      readonly note: typeof REPOSITORY_VIEW_NOTE;
    }
  | {
      readonly kind: "read-only-produced-repository-snapshot";
      readonly base_commit: GitOid;
      readonly snapshot_digest: Sha256Digest;
      readonly note: typeof PRODUCED_REPOSITORY_VIEW_NOTE;
    }
  | MultiRepositoryWorkspaceBinding;

export type ReviewDiffFile = {
  readonly path: string;
  readonly content_digest: Sha256Digest;
  readonly byte_count: number;
};
export type ReviewDiff = {
  readonly kind: "implementation" | "document" | "revision";
  readonly subject_digest: Sha256Digest;
  readonly base_subject_digest?: Sha256Digest;
  readonly patch: ReviewDiffFile;
  readonly stat: ReviewDiffFile;
};
export type ReviewDiffContext = {
  readonly full: ReviewDiff;
  readonly revision?: ReviewDiff;
  readonly revision_unavailable?: string;
};


export type ReviewEnvelopeInput = {
  readonly phase_kind?: "prd" | "design" | "phase-design" | "phase-impl";
  readonly diffs?: ReviewDiffContext;
  readonly artifact: string;
  readonly documents?: readonly ReviewDocument[];
  readonly governing_document_comparisons?: PlainJsonValue;
  readonly rubric: RubricV1;
  /** Server-owned reviewer scope. Absent only for legacy/tests that exercise the pre-assignment envelope. */
  readonly assignment?: ReviewAssignmentV1;
  readonly context: readonly PinnedContextEntry[];
  readonly subject: DispatchSubject;
  readonly workspace?: ReviewWorkspaceBinding;
};

export const REVIEW_FOCUSES = ["general", "tests"] as const;
export type ReviewFocus = (typeof REVIEW_FOCUSES)[number];
export type ReviewAssignmentV1 = {
  readonly reviewer_id: string;
  readonly focus: ReviewFocus;
  readonly criterion_ids: readonly string[];
  /** Present only on the primary general assignment. Presence, including `[]`, owns the census. */
  readonly expected_upstream_digests?: readonly Sha256Digest[];
  /** Exact archived accepted occurrences this assignment must confirm during remediation. */
  readonly legacy_confirmations?: readonly LegacyConfirmationAssignmentV1[];
};

/**
 * The caller-supplied review envelope before the server stamps the durable attempt counter into
 * the subject. Handlers build this shape; `runCounterReview` completes it from transaction
 * authority, so the round number in the child-visible subject is never a caller claim.
 */
export type ReviewEnvelopeSeed = Readonly<
  Omit<ReviewEnvelopeInput, "subject"> & { readonly subject: Omit<DispatchSubject, "attempt"> }
>;

/** Canonical server-only binding. Never send these bytes to a reviewer process. */
export type DispatchEnvelope = Readonly<{
  readonly result_kind: "review" | "effort-review" | "adjudication";
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly byte_count: number;
}>;

/** Seals the already server-derived, phase-design-only effort input for dispatch. */
export function buildEffortEnvelope(value: EffortEnvelopeV3, context: readonly PinnedContextEntry[] = []): DispatchEnvelope {
  const envelope = parseEffortEnvelopeV3(value);
  return finishEnvelope("effort-review", { ...envelope, context: validateContext(context) } as PlainJsonValue, "dispatch-envelope");
}

export type AdjudicationSubject = {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly role: "adjudication";
  readonly step: "adjudicate";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly pinned_constitution_digest: Sha256Digest;
  /** Archived V1 observation seam; fresh V2 subjects omit it. */
  readonly approved_upstream_digests?: readonly Sha256Digest[];
  readonly source_review_envelope_digest: Sha256Digest;
  readonly invocation_id: string;
  readonly result_id: string;
};

export type AdjudicationRuleInput = {
  readonly slot: string;
  readonly text: string;
  readonly review_trigger?: string;
  readonly enforced_by: readonly string[];
};

export type AdjudicationUpstreamInput = {
  readonly upstream_digest: Sha256Digest;
  readonly artifact: string;
};

export type AdjudicationEnvelopeInput = {
  readonly phase_kind?: "prd" | "design" | "phase-design" | "phase-impl";
  readonly diffs?: ReviewDiffContext;
  readonly artifact: string;
  readonly documents?: readonly ReviewDocument[];
  readonly context?: readonly PinnedContextEntry[];
  readonly governing_document_comparisons?: PlainJsonValue;
  readonly rules: readonly AdjudicationRuleInput[];
  readonly source_review_envelope_digest: Sha256Digest;
  readonly workspace?: ReviewWorkspaceBinding;
  readonly subject: AdjudicationSubject;
};

const EVIDENCE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const utf8 = new TextEncoder();

function parseEvidenceId(value: unknown, field: "invocation_id" | "result_id"): string {
  if (typeof value !== "string" || !EVIDENCE_ID.test(value)) {
    throw new TypeError(`${field} must use the review evidence identifier vocabulary`);
  }
  return value;
}

const sortedExpectedCache = new WeakMap<readonly string[], readonly string[]>();

function getSortedExpected(expected: readonly string[]): readonly string[] {
  let cached = sortedExpectedCache.get(expected);
  if (cached === undefined) {
    cached = Object.freeze([...expected].sort());
    sortedExpectedCache.set(expected, cached);
  }
  return cached;
}

function exactFields(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = getSortedExpected(expected);
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
    "attempt",
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
  if (!MODEL_FAMILIES.includes(value.producer_family as ModelFamily)) {
    throw new TypeError("dispatch subject producer_family is invalid");
  }
  const attempt = parseSafeInteger(value.attempt);
  if (attempt < 1) throw new TypeError("dispatch subject attempt must be at least 1");
  return {
    task_id: parseTaskSlug(value.task_id),
    phase_instance: parsePhaseInstanceId(value.phase_instance),
    role: value.role,
    step: value.step,
    attempt,
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
    ...(value.approved_upstream_digests === undefined ? [] : ["approved_upstream_digests"]),
    "source_review_envelope_digest",
    "invocation_id",
    "result_id",
  ], "adjudication subject");
  if (value.role !== "adjudication" || value.step !== "adjudicate") {
    throw new TypeError("adjudication subject must bind the adjudication step");
  }
  const approvedUpstreamDigests = value.approved_upstream_digests?.map(parseSha256Digest);
  if (approvedUpstreamDigests !== undefined && (
    new Set(approvedUpstreamDigests).size !== approvedUpstreamDigests.length ||
    approvedUpstreamDigests.some((digest, index) => index > 0 && approvedUpstreamDigests[index - 1]! >= digest)
  )) throw new TypeError("approved_upstream_digests must be sorted and unique");
  return {
    task_id: parseTaskSlug(value.task_id),
    phase_instance: parsePhaseInstanceId(value.phase_instance),
    role: value.role,
    step: value.step,
    subject_digest: parseSha256Digest(value.subject_digest),
    input_fingerprint: parseSha256Digest(value.input_fingerprint),
    pinned_constitution_digest: parseSha256Digest(value.pinned_constitution_digest),
    ...(approvedUpstreamDigests === undefined ? {} : { approved_upstream_digests: approvedUpstreamDigests }),
    source_review_envelope_digest: parseSha256Digest(value.source_review_envelope_digest),
    invocation_id: parseEvidenceId(value.invocation_id, "invocation_id"),
    result_id: parseEvidenceId(value.result_id, "result_id"),
  };
}

function validateWorkspace(value: ReviewWorkspaceBinding): ReviewWorkspaceBinding {
  if (value.kind === "read-only-repository-checkout") {
    exactFields(value, ["kind", "commit", "note"], "review workspace binding");
    if (value.note !== REPOSITORY_VIEW_NOTE) {
      throw new TypeError("review workspace note must be the fixed checkout literal");
    }
    return {
      kind: value.kind,
      commit: parseGitOid(value.commit),
      note: value.note,
    };
  }
  if (value.kind === "read-only-multi-repository-view") {
    exactFields(value, ["kind", "note", "repositories"], "review workspace binding");
    if (value.note !== MULTI_REPOSITORY_VIEW_NOTE) {
      throw new TypeError("review workspace note must be the fixed multi-repository literal");
    }
    if (!Array.isArray(value.repositories) || value.repositories.length < 2) {
      throw new TypeError("multi-repository workspace must contain at least two repositories");
    }
    const repositories = value.repositories.map((repository, index): MultiRepositoryWorkspaceEntry => {
      exactFields(
        repository,
        repository.snapshot_digest === undefined
          ? ["name", "path", "repository_identity_digest", "commit"]
          : ["name", "path", "repository_identity_digest", "commit", "snapshot_digest"],
        "multi-repository workspace entry",
      );
      if (repository.name !== "primary" && !(typeof repository.name === "string" && REPOSITORY_NAME_PATTERN.test(repository.name))) {
        throw new TypeError("multi-repository workspace name is invalid");
      }
      const name = repository.name as MultiRepositoryWorkspaceEntry["name"];
      if (repository.path !== name) throw new TypeError("multi-repository workspace path must equal name");
      return {
        name,
        path: name,
        repository_identity_digest: parseSha256Digest(repository.repository_identity_digest),
        commit: parseGitOid(repository.commit),
        ...(repository.snapshot_digest === undefined ? {} : { snapshot_digest: parseSha256Digest(repository.snapshot_digest) }),
      };
    });
    const names = repositories.map((repository) => repository.name);
    if (names[0] !== "primary" || new Set(names).size !== names.length ||
        names.some((name, index) => index > 1 && names[index - 1]! >= name)) {
      throw new TypeError("multi-repository workspace names must be primary-first, sorted, and unique");
    }
    return { kind: value.kind, note: value.note, repositories };
  }
  exactFields(value, ["kind", "base_commit", "snapshot_digest", "note"], "review workspace binding");
  if (value.kind !== "read-only-produced-repository-snapshot") {
    throw new TypeError("review workspace kind is invalid");
  }
  if (value.note !== PRODUCED_REPOSITORY_VIEW_NOTE) {
    throw new TypeError("review workspace note must be the fixed produced-snapshot literal");
  }
  return {
    kind: value.kind,
    base_commit: parseGitOid(value.base_commit),
    snapshot_digest: parseSha256Digest(value.snapshot_digest),
    note: value.note,
  };
}

function parseNonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must contain text`);
  }
  return value;
}

function validateAssignment(
  value: ReviewAssignmentV1,
  rubric: RubricV1,
): ReviewAssignmentV1 {
  const expectedFields = [
    "reviewer_id", "focus", "criterion_ids",
    ...(value.expected_upstream_digests === undefined ? [] : ["expected_upstream_digests"]),
    ...(value.legacy_confirmations === undefined ? [] : ["legacy_confirmations"]),
  ];
  exactFields(value, expectedFields, "review assignment");
  if (!(REVIEW_FOCUSES as readonly string[]).includes(value.focus)) {
    throw new TypeError("review assignment focus is invalid");
  }
  const stableGeneralId = /^general(?:-[1-9][0-9]*)?$/u;
  if ((value.focus === "general" && !stableGeneralId.test(value.reviewer_id)) ||
      (value.focus === "tests" && value.reviewer_id !== "test")) {
    throw new TypeError("review assignment reviewer_id must use the stable identifier vocabulary for its focus");
  }
  if (!Array.isArray(value.criterion_ids)) {
    throw new TypeError("review assignment criterion_ids must be an array");
  }
  const allowed = rubric.criteria.map((criterion) => criterion.id);
  const selected = value.criterion_ids.map((criterion) => parseNonBlank(criterion, "review assignment criterion"));
  if (new Set(selected).size !== selected.length || selected.some((criterion) => !allowed.includes(criterion))) {
    throw new TypeError("review assignment criteria must be unique members of the rubric");
  }
  const canonical = allowed.filter((criterion) => selected.includes(criterion));
  if (canonical.some((criterion, index) => criterion !== selected[index])) {
    throw new TypeError("review assignment criteria must follow canonical rubric order");
  }

  let expectedUpstreamDigests: readonly Sha256Digest[] | undefined;
  if (value.expected_upstream_digests !== undefined) {
    if (value.focus !== "general" || (value.reviewer_id !== "general" && value.reviewer_id !== "general-1")) {
      throw new TypeError("approved-upstream alignment belongs only to the primary general assignment");
    }
    if (!Array.isArray(value.expected_upstream_digests)) {
      throw new TypeError("expected_upstream_digests must be an array");
    }
    expectedUpstreamDigests = Object.freeze(value.expected_upstream_digests.map(parseSha256Digest));
    if (new Set(expectedUpstreamDigests).size !== expectedUpstreamDigests.length ||
        expectedUpstreamDigests.some((digest, index) => index > 0 && expectedUpstreamDigests![index - 1]! >= digest)) {
      throw new TypeError("expected_upstream_digests must be sorted and unique");
    }
  }

  let legacyConfirmations: readonly LegacyConfirmationAssignmentV1[] | undefined;
  if (value.legacy_confirmations !== undefined) {
    if (!Array.isArray(value.legacy_confirmations) || value.legacy_confirmations.length === 0) {
      throw new TypeError("legacy_confirmations must be a non-empty array");
    }
    legacyConfirmations = Object.freeze(value.legacy_confirmations.map((confirmation) => {
      exactFields(confirmation, ["finding_id", "criterion_ids"], "legacy confirmation assignment");
      if (!EVIDENCE_ID.test(confirmation.finding_id)) {
        throw new TypeError("legacy confirmation finding_id must use the evidence identifier vocabulary");
      }
      if (!Array.isArray(confirmation.criterion_ids) || confirmation.criterion_ids.length === 0) {
        throw new TypeError("legacy confirmation must name at least one permitted criterion");
      }
      const criteria = confirmation.criterion_ids.map((criterion: string) =>
        parseNonBlank(criterion, "legacy confirmation criterion"));
      if (new Set(criteria).size !== criteria.length || criteria.some((criterion: string) => !allowed.includes(criterion))) {
        throw new TypeError("legacy confirmation criteria must be unique members of the rubric");
      }
      const canonicalCriteria = allowed.filter((criterion) => criteria.includes(criterion));
      if (canonicalCriteria.some((criterion, index) => criterion !== criteria[index])) {
        throw new TypeError("legacy confirmation criteria must follow canonical rubric order");
      }
      return Object.freeze({ finding_id: confirmation.finding_id, criterion_ids: Object.freeze(criteria) });
    }));
    const findingIds = legacyConfirmations.map((confirmation) => confirmation.finding_id);
    if (new Set(findingIds).size !== findingIds.length) {
      throw new TypeError("legacy confirmation finding_ids must be unique");
    }
  }
  if (selected.length === 0 && expectedUpstreamDigests === undefined && legacyConfirmations === undefined) {
    throw new TypeError("review assignment must name a rubric criterion or a present responsibility");
  }
  return Object.freeze({
    reviewer_id: value.reviewer_id,
    focus: value.focus,
    criterion_ids: Object.freeze(selected),
    ...(expectedUpstreamDigests === undefined ? {} : { expected_upstream_digests: expectedUpstreamDigests }),
    ...(legacyConfirmations === undefined ? {} : { legacy_confirmations: legacyConfirmations }),
  });
}

function parseEncoding(value: unknown): "utf8" | "base64" {
  if (value !== "utf8" && value !== "base64") {
    throw new TypeError("pinned context encoding must be utf8 or base64");
  }
  return value;
}

function validateContext(values: readonly PinnedContextEntry[]): readonly PinnedContextEntry[] {
  return values.map(entry => {
    const { source_version, ...content } = entry;
    const checked = validateContextContent([content])[0]!;
    return source_version === undefined ? checked : { ...checked, source_version: parseNonBlank(source_version, "context source version") };
  });
}

function validateContextContent(values: readonly PinnedContextEntry[]): readonly PinnedContextEntry[] {
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
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("adjudication rules must be a non-empty array");
  }
  const rules = values.map((value) => {
    const expected = value.review_trigger === undefined
      ? ["slot", "text", "enforced_by"]
      : ["slot", "text", "review_trigger", "enforced_by"];
    exactFields(value, expected, "adjudication rule");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.slot)) {
      throw new TypeError("rule slot must use the opaque slot vocabulary");
    }
    const enforcedBy = value.enforced_by.map((mechanism: string) => parseNonBlank(mechanism, "enforced_by entry"));
    if (new Set(enforcedBy).size !== enforcedBy.length) throw new TypeError("enforced_by entries must be unique");
    return {
      slot: value.slot,
      text: parseNonBlank(value.text, "rule text"),
      ...(value.review_trigger === undefined
        ? {}
        : { review_trigger: parseNonBlank(value.review_trigger, "review_trigger") }),
      enforced_by: enforcedBy,
    };
  });
  const slots = rules.map((rule) => rule.slot);
  if (new Set(slots).size !== slots.length) {
    throw new TypeError("adjudication rule slots must be unique");
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

export function sealDispatchInput(
  resultKind: DispatchEnvelope["result_kind"], envelope: unknown,
  digestKind: "dispatch-envelope" | "adjudication-envelope" = resultKind === "adjudication" ? "adjudication-envelope" : "dispatch-envelope",
): DispatchEnvelope {
  assertPlainJson(envelope, "server review input");
  const record = structuredClone(envelope) as Readonly<Record<string, PlainJsonValue>>;
  const sealed = { ...record, review_configuration: loadReviewInputConfiguration(), document_configuration: loadReviewDocumentConfiguration() };
  const provisionalBytes = utf8.encode(`${JSON.stringify(sealed)}\n`);
  const prepared = prepareReviewInputs({ result_kind: resultKind, bytes: provisionalBytes, digest: "" as Sha256Digest, byte_count: provisionalBytes.byteLength });
  const rendered = {
    prompt: renderReviewPrompt(prepared, `review-inputs/${prepared.reviewer_id}`),
    files: prepared.files.map(({ content: _content, encoding: _encoding, ...file }) => file),
  };
  const finalRecord = { ...sealed, rendered_inputs: rendered };
  const bytes = utf8.encode(`${JSON.stringify(finalRecord)}\n`);
  const binding = { ...finalRecord, digest_kind: digestKind };
  assertPlainJson(binding);
  const digest = canonicalJsonDigest(binding);
  return Object.freeze({ result_kind: resultKind, bytes, digest, byte_count: bytes.byteLength });
}
const finishEnvelope = sealDispatchInput;

function validateDiffs(value: ReviewDiffContext, subjectDigest: Sha256Digest): ReviewDiffContext {
  exactFields(value, ["full", ...(value.revision === undefined ? [] : ["revision"]),
    ...(value.revision_unavailable === undefined ? [] : ["revision_unavailable"])], "review diffs");
  for (const [kind, diff] of [["full", value.full], ["revision", value.revision]] as const) {
    if (diff === undefined) { if (kind === "full") throw new TypeError("full review diff is required"); continue; }
    exactFields(diff, ["kind", "subject_digest", "patch", "stat", ...(kind === "revision" ? ["base_subject_digest"] : [])], "review diff");
    if ((kind === "full" ? !["implementation", "document"].includes(diff.kind) : diff.kind !== kind) ||
        parseSha256Digest(diff.subject_digest) !== subjectDigest) throw new TypeError("review diff subject mismatch");
    if (kind === "revision") parseSha256Digest(diff.base_subject_digest);
    for (const [extension, file] of [["patch", diff.patch], ["stat", diff.stat]] as const) {
      exactFields(file, ["path", "content_digest", "byte_count"], "review diff file");
      const name = kind === "full" ? "full" : `since-${diff.base_subject_digest}`;
      if (file.path !== `review-diffs/${name}.${extension}`) throw new TypeError("invalid review diff path");
      parseSha256Digest(file.content_digest);
      parseSafeInteger(file.byte_count);

    }
  }
  if (value.revision_unavailable !== undefined && (value.revision !== undefined || typeof value.revision_unavailable !== "string" || !value.revision_unavailable.trim())) {
    throw new TypeError("invalid revision diff availability");
  }
  return value;
}

/** Validates and seals server-derived review inputs; rendering is shared with preview. */
export function buildReviewEnvelope(value: ReviewEnvelopeInput): DispatchEnvelope {
  const snapshot = materialize(value);
  exactFields(
    snapshot,
    [
      "artifact", "rubric", "context", "subject",
      ...["phase_kind", "documents", "governing_document_comparisons"].filter(key => key in snapshot),
      ...(snapshot.diffs === undefined ? [] : ["diffs"]),
      ...(snapshot.assignment === undefined ? [] : ["assignment"]),
      ...(snapshot.workspace === undefined ? [] : ["workspace"]),
    ],
    "review envelope input",
  );
  if (typeof snapshot.artifact !== "string") throw new TypeError("review envelope artifact must be text");
  const workspace = snapshot.workspace === undefined ? undefined : validateWorkspace(snapshot.workspace);
  const parsedRubric = parseRubricV1(snapshot.rubric);
  const assignment = snapshot.assignment === undefined
    ? undefined
    : validateAssignment(snapshot.assignment, parsedRubric);
  const rubric = {
    schema_version: parsedRubric.schema_version,
    kind: parsedRubric.kind,
    mode: parsedRubric.mode,
    criteria: parsedRubric.criteria.filter((criterion) =>
      assignment === undefined || assignment.criterion_ids.includes(criterion.id)).map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      blocking: criterion.blocking,
    })),
  } as const;

  const context = validateContext(snapshot.context);
  const envelope = {
    schema_version: "1",
    artifact: snapshot.artifact,
    ...(snapshot.phase_kind === undefined ? {} : { phase_kind: snapshot.phase_kind }),
    ...(snapshot.documents === undefined ? {} : { documents: snapshot.documents }),
    ...(snapshot.governing_document_comparisons === undefined ? {} : { governing_document_comparisons: snapshot.governing_document_comparisons }),
    ...(snapshot.diffs === undefined ? {} : { diffs: validateDiffs(snapshot.diffs, snapshot.subject.subject_digest) }),
    rubric,
    ...(assignment === undefined ? {} : { assignment }),
    context,
    ...(workspace === undefined ? {} : { workspace }),
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
  const workspace = snapshot.workspace === undefined ? undefined : validateWorkspace(snapshot.workspace);
  exactFields(
    snapshot,
    ["artifact", "rules", "source_review_envelope_digest", "subject",
      ...["phase_kind", "documents", "context", "governing_document_comparisons"].filter(key => key in snapshot),
      ...(workspace === undefined ? [] : ["workspace"]),
      ...(snapshot.diffs === undefined ? [] : ["diffs"])],
    "adjudication envelope input",
  );
  if (typeof snapshot.artifact !== "string") throw new TypeError("adjudication envelope artifact must be text");
  const rules = validateRules(snapshot.rules);
  const subject = validateAdjudicationSubject(snapshot.subject);
  const sourceEvidenceSetDigest = parseSha256Digest(snapshot.source_review_envelope_digest);
  if (sourceEvidenceSetDigest !== subject.source_review_envelope_digest) {
    throw new TypeError("source_review_envelope_digest must match the adjudication subject");
  }
  const envelope = {
    schema_version: "2",
    artifact: snapshot.artifact,
    ...(snapshot.phase_kind === undefined ? {} : { phase_kind: snapshot.phase_kind }),
    ...(snapshot.documents === undefined ? {} : { documents: snapshot.documents }),
    ...(snapshot.governing_document_comparisons === undefined ? {} : { governing_document_comparisons: snapshot.governing_document_comparisons }),
    ...(snapshot.diffs === undefined ? {} : { diffs: validateDiffs(snapshot.diffs, subject.subject_digest) }),
    rules,
    source_review_envelope_digest: sourceEvidenceSetDigest,
    ...(workspace === undefined ? {} : { workspace }),
    ...(snapshot.context === undefined ? {} : { context: validateContext(snapshot.context) }),
    subject,
  } as const satisfies PlainJsonValue;
  return finishEnvelope("adjudication", envelope, "adjudication-envelope");
}
