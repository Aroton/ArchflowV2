import { z } from "zod";

import type { DeclaredInputRef } from "./fingerprints.js";
import { declaredInputRefV1Schema } from "./durable-primitives.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { phaseInstanceIdV1Schema } from "./phase-instance.js";
import type { RepositoryPathClaim, TaskPathClaim } from "./path-claims.js";
import { repositoryPathClaimV1Schema, taskPathClaimV1Schema } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";
import type { PipelineStep } from "./vocabulary.js";
import { PIPELINE_STEPS } from "./vocabulary.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";

/**
 * A document an agent produced — a PRD, a design, a phase design, a review — projected into the
 * repository. This shape carries exactly the review provenance REQ-11 needs: where the document
 * lives, what it digests to, which pipeline step produced it, and which declared inputs it was
 * produced from. Phase 7 defines the format only; nothing writes or projects one until Phase 9.
 *
 * D1 — a `type` alias, not an `interface`. This root becomes a member of
 * `CanonicalDocument<DurableArtifact>` in chunk 10, and `T extends PlainJsonValue` is checked
 * through the whole reachable graph, so an `interface` anywhere inside fails with `TS2344`.
 *
 * D2 — Zod-mirrored, because an agent supplies it across the MCP tool boundary through
 * `archflow_state.artifact` and it must therefore be validated from untrusted input. This Zod
 * source is the shape authority: the committed `document-artifact.schema.json` is generated from
 * it, so the published document cannot drift.
 *
 * D3 — the two path frames, and they are runtime-**indistinguishable**. `document_path` is a
 * `TaskPathClaim` (relative to the task root) and `projection_target` is a `RepositoryPathClaim`
 * (relative to the worktree root). `taskPathClaimV1Schema` and `repositoryPathClaimV1Schema` are the
 * same object (`path-claims.ts:31-45`) cast to two brands, so there is no runtime frame check and
 * there cannot be one. The brand and the `$ref` name the frame at each reference site — which is the
 * whole reason the one-line `taskPathClaim` `$def` exists alongside `repositoryPathClaim`.
 *
 * D19 — `step` is required, and in all three authorities: this alias, the JSON Schema `enum` over
 * `PIPELINE_STEPS`, and the Zod `z.enum` below. It is not decorative. The fingerprint correlation in
 * `validateDurableSemantics` keys on `(phase_instance, step)`; before the field existed that
 * invariant was written as if this shape carried one and compared against nothing.
 *
 * **The fingerprint guard this field feeds is self-declared, and that limitation is attributed.**
 * Every input to it — `phase_instance` and `step` — comes from the same subject the invariant
 * polices, and no invariant in this phase requires a supplied artifact to correspond to the state's
 * in-flight step. A producer can therefore skip the only fingerprint check in the phase by declaring
 * a different `step`. That is acceptable for a format phase, which never sees a transition; Phase 9
 * (Transaction Kernel, Intent/CAS, and Crash Recovery) owns the missing half, because only the
 * transaction kernel knows which step a request is transitioning.
 */
export type DocumentArtifactV1 = {
  readonly schema_version: "1";
  /** The `DurableArtifact` discriminant. */
  readonly artifact_kind: "document";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  /** D19 — the step that produced this document. */
  readonly step: PipelineStep;
  /** TASK-relative frame (D3). */
  readonly document_path: TaskPathClaim;
  /** A const, not the 18-member `PathClass` union: a document artifact is always class `document`. */
  readonly path_class: "document";
  /** `SafeInteger`, not `>= 1`: a zero-byte document is legal, so D8 forces no own minimum. */
  readonly byte_count: SafeInteger;
  readonly content_digest: Sha256Digest;
  /** SET — sorted by `input_id`, duplicates rejected (D11). */
  readonly declared_inputs: readonly DeclaredInputRef[];
  readonly input_fingerprint: Sha256Digest;
  /** Domain-separated canonical declared-output snapshot; never the retained result address. */
  readonly snapshot_digest: Sha256Digest;
  /** REPOSITORY frame (D3). */
  readonly projection_target: RepositoryPathClaim;
  /**
   * Declares this document as an editorial revision of the produce result it replaces: the
   * predecessor's retained artifact digest and input fingerprint, plus the retained result digest
   * of the triage whose only accepted findings were `accepted-editorial`. The link is what lets
   * predecessor-bound review/triage evidence stay current for exactly one hop; record time
   * refuses it unless the named triage authorizes it and the bytes actually changed.
   */
  readonly editorial_predecessor?: EditorialPredecessorRef;
};

export type EditorialPredecessorRef = {
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly triage_result_digest: Sha256Digest;
};

export const editorialPredecessorRefV1Schema = z.object({
  subject_digest: sha256DigestV1Schema,
  input_fingerprint: sha256DigestV1Schema,
  triage_result_digest: sha256DigestV1Schema,
}).strict() as unknown as z.ZodType<EditorialPredecessorRef>;

/**
 * The authority. `declared_inputs` calls `isSortedUniqueBy` with `tupleKey("input_id")` — the
 * shared exported ordering predicates — so every shape enforces literally the same rule (D11).
 */
export const documentArtifactV1Schema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("document"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  document_path: taskPathClaimV1Schema,
  path_class: z.literal("document"),
  byte_count: safeIntegerV1Schema,
  content_digest: sha256DigestV1Schema,
  declared_inputs: z.array(declaredInputRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("input_id")), "declared_inputs must be sorted by input_id with no duplicates"),
  input_fingerprint: sha256DigestV1Schema,
  snapshot_digest: sha256DigestV1Schema,
  projection_target: repositoryPathClaimV1Schema,
  editorial_predecessor: editorialPredecessorRefV1Schema.optional(),
}).strict() as unknown as z.ZodType<DocumentArtifactV1>;

/** Throws, per the contract-layer convention. */
export function parseDocumentArtifact(value: unknown): DocumentArtifactV1 {
  assertPlainJson(value, "document artifact");
  return documentArtifactV1Schema.parse(value);
}
