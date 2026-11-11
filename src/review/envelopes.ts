import { loadReviewInputConfiguration, prepareReviewInputs, renderReviewPrompt } from "./inputs.js";
import { createReviewResponseSchema } from "./response-schema.js";
import { canonicalJsonDigest, type GitOid } from "../contracts/canonical.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";

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
 * Declares the read-only repository views offered to either review child: the primary view holds
 * the proposed work and `baseline` the same repository at the starting commit.
 */
export type ReviewWorkspaceBinding = MultiRepositoryWorkspaceBinding;

export const REVIEW_FOCUSES = ["general", "tests"] as const;
export type ReviewFocus = (typeof REVIEW_FOCUSES)[number];
export type ReviewAssignmentV1 = {
  readonly reviewer_id: string;
  readonly focus: ReviewFocus;
  readonly criterion_ids: readonly string[];
};

/** Canonical server-only binding. Never send these bytes to a reviewer process. */
export type DispatchEnvelope = Readonly<{
  readonly result_kind: "review" | "adjudication";
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly byte_count: number;
}>;

const utf8 = new TextEncoder();

export function sealDispatchInput(
  resultKind: DispatchEnvelope["result_kind"], envelope: unknown,
  digestKind: "dispatch-envelope" | "adjudication-envelope" = resultKind === "adjudication" ? "adjudication-envelope" : "dispatch-envelope",
): DispatchEnvelope {
  assertPlainJson(envelope, "server review input");
  const record = structuredClone(envelope) as Readonly<Record<string, PlainJsonValue>>;
  const sealed = { ...record, response_schema: createReviewResponseSchema(resultKind, record), review_configuration: loadReviewInputConfiguration() };
  const provisionalBytes = utf8.encode(`${JSON.stringify(sealed)}\n`);
  const prepared = prepareReviewInputs({ result_kind: resultKind, bytes: provisionalBytes, digest: "" as Sha256Digest, byte_count: provisionalBytes.byteLength });
  const rendered = {
    prompt: renderReviewPrompt(prepared, `review-inputs/${prepared.reviewer_id}`),
    files: prepared.files.map(({ content: _content, ...file }) => file),
  };
  const finalRecord = { ...sealed, rendered_inputs: rendered };
  const bytes = utf8.encode(`${JSON.stringify(finalRecord)}\n`);
  const binding = { ...finalRecord, digest_kind: digestKind };
  assertPlainJson(binding);
  const digest = canonicalJsonDigest(binding);
  return Object.freeze({ result_kind: resultKind, bytes, digest, byte_count: bytes.byteLength });
}
