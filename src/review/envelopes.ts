import { canonicalJsonDigest, parseGitOid, type GitOid } from "../contracts/canonical.js";
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
import { MODEL_FAMILIES, type ModelFamily } from "../contracts/review.js";
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
 * assembled mechanically from durable authority — never author-curated — and each phase of the
 * context contract grows this enum rather than the envelope shape. `prior-triage` is the
 * mechanical triage record of the previous review round of this same phase instance, assembled by
 * the server from retained result manifests; it is admissible where producer prose is not because
 * every field restates durable triage/review authority.
 */
export const PINNED_CONTEXT_KINDS = [
  "user-ask", "approved-upstream", "imported-reference", "verification-transcript",
  "prior-triage", "interface-excerpt", "conventions", "repo-map",
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

/**
 * The one fixed sentence the envelope may say about the reviewer's working directory. The note is
 * a literal, never caller prose: prepending free text to stdin would break byte-provenance, and a
 * variable note would reopen the instruction channel this envelope deliberately closes.
 */
export const REPOSITORY_VIEW_NOTE =
  "Your working directory is a read-only checkout of the repository at this commit, excluding .archflow/tasks. Use it to verify repository claims; the artifact and pinned context remain the review subject and take precedence on conflict.";

/** Fixed child-visible explanation of the retained implementation snapshot. */
export const PRODUCED_REPOSITORY_VIEW_NOTE =
  "Your working directory is a sealed read-only post-change repository snapshot reconstructed from the authenticated implementation output, excluding .archflow/tasks. The artifact names the changed paths and baseline; inspect the files in this snapshot as the review subject.";

/** Fixed child-visible navigation and authority boundary for a named repository set. */
export const MULTI_REPOSITORY_VIEW_NOTE =
  "Your working directory contains read-only repository snapshots at `./<name>`; cite files as `<name>/<path>`. A repository entry with `snapshot_digest` is a sealed post-change tree reconstructed from authenticated implementation output and is part of the review subject. An entry without `snapshot_digest` is commit-pinned read-only context and may not contain this phase's work; the artifact and pinned context remain the review subject and take precedence on conflict.";

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

export type ReviewEnvelopeInput = {
  readonly artifact: string;
  readonly rubric: RubricV1;
  readonly context: readonly PinnedContextEntry[];
  readonly subject: DispatchSubject;
  readonly workspace?: ReviewWorkspaceBinding;
};

/**
 * The caller-supplied review envelope before the server stamps the durable attempt counter into
 * the subject. Handlers build this shape; `runCounterReview` completes it from transaction
 * authority, so the round number in the child-visible subject is never a caller claim.
 */
export type ReviewEnvelopeSeed = Readonly<
  Omit<ReviewEnvelopeInput, "subject"> & { readonly subject: Omit<DispatchSubject, "attempt"> }
>;

/**
 * The fixed framing and method every rubric-review child receives as `instructions.review`. The
 * child otherwise sees only data — artifact, rubric, pinned context, subject — and the rubric
 * says what counts as a defect, not how to look for one. This literal supplies the search: read
 * everything first, trace every stated commitment into the sections that depend on it, recompute,
 * verify against the view, and only then apply the materiality bar. It is a literal for the same
 * reason as {@link REPOSITORY_VIEW_NOTE}: variable prose would reopen the caller-instruction
 * channel this envelope deliberately closes.
 */
export const REVIEW_INSTRUCTION =
  "You are the independent counter-reviewer for the artifact in this envelope. Read the whole artifact and every pinned context entry before judging anything; the pinned approved upstream documents state what the artifact must satisfy. Then work through the artifact section by section: trace each stated constant, budget, invariant, interface claim, and policy into every other section that depends on it and check that they jointly hold; recompute derived figures rather than accepting them; verify repository and interface claims against the pinned evidence and the read-only repository view when one is provided; follow each stated property through the inputs and lifecycle events the system will actually meet. Frame your evaluation around the finite question: 'What would break in production or fail execution?' A true observation or discrepancy that does not change downstream implementation, break an approved boundary, or alter verification is not a defect and must not be reported. Only after that pass apply the rubric's materiality bar to decide what to report. Every finding cites the exact evidence and names its concrete consequence. Return the structured result the output schema describes and nothing else.";

/**
 * The fixed remediation instruction the envelope adds as `instructions.prior_triage` when a
 * `prior-triage` context entry is pinned. It gives the round two tasks of equal weight: verify the
 * accepted revision intents, and review the revised and dependent sections as an initial review
 * would. The passing round of most tasks is a remediation round, so narrowing it to intent
 * verification alone let revision-introduced defects through. Same literal discipline as above.
 */
export const PRIOR_TRIAGE_INSTRUCTION =
  "This is a remediation review. The artifact already received a full review; the pinned prior-triage record is that round's outcome. Two tasks: first, verify that every accepted revision intent in the pinned prior-triage record was carried out. Second, review every section the revision changed, and every section that depends on changed content, at the same materiality bar as an initial review: revisions introduce defects, so trace each revised constant, contract, or mechanism into the claims, budgets, and verification stories that rely on it. Do not re-raise completed or rejected findings in variant form; challenge a prior disposition only by naming its finding_id and showing that the revision intent was not carried out or that the change introduced a material defect. Do not open a new sweep of unchanged sections: report an issue outside the changed and dependent sections only when it would break production or fail execution and the revision made it visible. Do not report optional polish, harmless wording refinements, true-but-inconsequential observations, or other non-material items that induce specification drift. A remediation round that finds nothing material must return no findings; that is the intended terminal state of review, not a failure of diligence.";

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
  readonly source_review_envelope_digest: Sha256Digest;
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
  readonly source_review_envelope_digest: Sha256Digest;
  readonly workspace?: ReviewWorkspaceBinding;
  readonly subject: AdjudicationSubject;
};

export class ReviewEnvelopeError extends Error {
  public readonly project_error: ProjectError;
  /** The serialized size that failed the byte cap, when that is what failed. */
  public readonly envelope_byte_count?: number;

  public constructor(projectError: ProjectError, envelopeByteCount?: number) {
    super(`review envelope failed: ${projectError.code}`);
    this.name = "ReviewEnvelopeError";
    this.project_error = projectError;
    if (envelopeByteCount !== undefined) this.envelope_byte_count = envelopeByteCount;
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
    "approved_upstream_digests",
    "source_review_envelope_digest",
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
    throw new ReviewEnvelopeError(
      createProjectError("CONTRACT_INVALID", { issue_code: "envelope-byte-cap" }),
      bytes.byteLength,
    );
  }
  const digest = canonicalJsonDigest({
    ...(envelope as Readonly<Record<string, PlainJsonValue>>),
    digest_kind: digestKind,
  });
  return Object.freeze({ result_kind: resultKind, bytes, digest, byte_count: bytes.byteLength });
}

/**
 * Builds the sole counter-review child input. The closed input and subject shells deliberately make
 * free-form producer history and agent instructions unrepresentable. `context` is the one
 * sanctioned channel for repository-derived evidence, and it admits only mechanically assembled,
 * digest-recorded entries in the closed `PINNED_CONTEXT_KINDS` vocabulary — never free-form
 * instructions or author-curated material. The one piece of round history that is representable is
 * the `prior-triage` kind: the previous round's triage record for this same phase instance,
 * assembled by the server from retained triage and review manifests — admissible because every
 * field restates durable authority (reviewer-authored findings and their recorded dispositions),
 * never producer-curated prose. The only prose the child receives is server-owned literals:
 * {@link REVIEW_INSTRUCTION} always, plus {@link PRIOR_TRIAGE_INSTRUCTION} exactly when such an
 * entry is pinned. The optional `workspace` binding names the read-only
 * repository checkout the dispatcher materializes; its note is a fixed literal so the field can
 * never smuggle caller prose.
 */
export function buildReviewEnvelope(value: ReviewEnvelopeInput): DispatchEnvelope {
  const snapshot = materialize(value);
  exactFields(
    snapshot,
    snapshot.workspace === undefined
      ? ["artifact", "rubric", "context", "subject"]
      : ["artifact", "rubric", "context", "subject", "workspace"],
    "review envelope input",
  );
  if (typeof snapshot.artifact !== "string") throw new TypeError("review envelope artifact must be text");
  const workspace = snapshot.workspace === undefined ? undefined : validateWorkspace(snapshot.workspace);
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

  const context = validateContext(snapshot.context);
  const envelope = {
    schema_version: "1",
    artifact: snapshot.artifact,
    rubric,
    context,
    // Both instructions are fixed literals. The review framing is always present; the remediation
    // literal appears exactly when a prior-triage record is pinned, and its presence is derived
    // from validated context, never a caller switch.
    instructions: {
      review: REVIEW_INSTRUCTION,
      ...(context.some((entry) => entry.kind === "prior-triage")
        ? { prior_triage: PRIOR_TRIAGE_INSTRUCTION }
        : {}),
    },
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
    workspace === undefined
      ? ["artifact", "rules", "approved_upstreams", "source_review_envelope_digest", "subject"]
      : ["artifact", "rules", "approved_upstreams", "source_review_envelope_digest", "workspace", "subject"],
    "adjudication envelope input",
  );
  if (typeof snapshot.artifact !== "string") throw new TypeError("adjudication envelope artifact must be text");
  const rules = validateRules(snapshot.rules);
  const approvedUpstreams = validateUpstreams(snapshot.approved_upstreams);
  const subject = validateAdjudicationSubject(snapshot.subject);
  const sourceEvidenceSetDigest = parseSha256Digest(snapshot.source_review_envelope_digest);
  if (sourceEvidenceSetDigest !== subject.source_review_envelope_digest) {
    throw new TypeError("source_review_envelope_digest must match the adjudication subject");
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
    source_review_envelope_digest: sourceEvidenceSetDigest,
    ...(workspace === undefined ? {} : { workspace }),
    instructions: {
      rule_coverage: "Return exactly one rule finding for every supplied rule, using its id as rule_id and version as rule_version. Do not omit, duplicate, or invent rules.",
      drift_coverage: "Return exactly one drift finding for every supplied approved upstream, using its upstream_digest. Do not omit, duplicate, or invent upstreams. Use drift=aligned with an empty affected_claim_ids array when no approved claim is affected; otherwise name every affected claim using lowercase kebab-case IDs.",
      enforcement_context: "A rule's enforced_by labels name where that rule is mechanically enforced in the repository. They are context for your judgment, not evidence you are asked to verify or report on. Judge every rule the same way: from the artifact and the evidence supplied here.",
      uncertainty: "Report uncertain compliance only when the artifact, approved upstreams, and supplied repository snapshot leave the question genuinely open. Absence of runtime-only evidence is not by itself a reason to be uncertain.",
      trigger: "A rule's review_trigger names a condition the repository wants a human to look at. Report trigger=matched only when that condition is directly evidenced by the artifact, its co-produced documents, or the supplied repository snapshot, and trigger=uncertain only when those genuinely leave it open. Workflow mechanics the server owns—gate authority, approvals, commits, and dispatch outcomes—are never evidence for a trigger; report not-matched. A rule with no review_trigger is always not-matched, with trigger_evidence stating that the rule declares no trigger.",
    },
    subject,
  } as const satisfies PlainJsonValue;
  return finishEnvelope("adjudication", envelope, "adjudication-envelope");
}
