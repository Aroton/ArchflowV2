import type { GitOid } from "./canonical.js";
import type { PredecessorLink } from "./durable-checkpoint.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { handoffRecordV1Validator } from "./validators.js";

export type PreservedHandoffHead = {
  readonly head_oid: GitOid;
  readonly authoritative_checkpoint: PredecessorLink;
};

export type CleanHandoffPosition = {
  readonly head_oid: GitOid;
  readonly state_revision: SafeInteger;
  readonly state_digest: Sha256Digest;
  readonly authoritative_checkpoint: PredecessorLink;
};

export type HandoffRecordV1 = {
  readonly schema_version: "1";
  readonly record_kind: "handoff-record";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly preserved_heads: readonly [PreservedHandoffHead, PreservedHandoffHead];
  readonly common_authoritative_checkpoint: PredecessorLink;
  readonly selected_successor_head: GitOid;
  readonly clean_handoff: CleanHandoffPosition;
};

export function parseHandoffRecord(value: unknown): HandoffRecordV1 {
  assertPlainJson(value, "handoff record");
  return handoffRecordV1Validator.assert(structuredClone(value), "handoff record");
}
