import { z } from "zod";

import type { GitOid } from "./canonical.js";
import { gitOidV1Schema } from "./canonical.js";
import type { CanonicalTaskPaths } from "./durable-primitives.js";
import { canonicalTaskPathsV1Schema } from "./durable-primitives.js";
import type { Sha256Digest, TaskSlug } from "./evidence.js";
import { sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";

/**
 * The document a normally-initialized task adopts once, carrying every pinned input the rest of the
 * workflow compares against. Phase 7 defines the format only: nothing records, adopts, or enforces
 * these values until Phase 9.
 *
 * D1 — a `type` alias, not an `interface`. This root is a member of `CanonicalDocument<DurableArtifact>`
 * in chunk 10, and `T extends PlainJsonValue` is checked through the whole reachable graph.
 *
 * D2 — this shape is Zod-mirrored because an agent supplies it across the MCP tool boundary through
 * `archflow_state.artifact`, so it must be validated from untrusted input. The mirror below is a
 * mirror and never a second model: `assertZodAgreement` proves the two authorities accept and reject
 * exactly the same values.
 *
 * D15 — there is deliberately **no** re-pin field, no amendment field, no upgrade field, and no
 * second config digest, here or in any schema, `SCHEMA_IDS` key, or module this phase adds. The
 * absence is a requirement of the architecture, so it is asserted negatively rather than assumed;
 * do not add one "for future flexibility".
 */
export type TaskInitializationV1 = {
  readonly schema_version: "1";
  /** The discriminant of the `DurableArtifact` union (chunk 10). */
  readonly artifact_kind: "task-initialization";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly code_baseline_commit: GitOid;
  /** Explicitly approved and human-committed; never derived from the working tree. */
  readonly policy_base_commit: GitOid;
  readonly constitution_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  /** The exact whole-file `config.yaml` bytes — the only config digest this shape carries (D15). */
  readonly config_digest: Sha256Digest;
  readonly canonical_paths: CanonicalTaskPaths;
};

const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;

/**
 * `.strict()` so an unknown field is rejected at the parse boundary rather than inside the semantic
 * validator, matching `additionalProperties: false` in `task-initialization.schema.json`. Every
 * field is required: absence is expressed as `.optional()` plus omission from `required`, never as
 * `null`, and this shape has no optional field.
 */
export const taskInitializationV1Schema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("task-initialization"),
  task_id: taskSlugV1Schema,
  repository_identity_digest: sha256Digest,
  code_baseline_commit: gitOidV1Schema,
  policy_base_commit: gitOidV1Schema,
  constitution_digest: sha256Digest,
  workflow_digest: sha256Digest,
  config_digest: sha256Digest,
  canonical_paths: canonicalTaskPathsV1Schema,
}).strict() as unknown as z.ZodType<TaskInitializationV1>;

/** Throws, per the contract-layer convention. */
export function parseTaskInitialization(value: unknown): TaskInitializationV1 {
  assertPlainJson(value, "task initialization");
  return taskInitializationV1Schema.parse(value);
}
