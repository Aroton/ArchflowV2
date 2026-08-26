import { z } from "zod";

import type { GitOid } from "./canonical.js";
import { gitOidV1Schema } from "./canonical.js";
import type { SafeInteger, Sha256Digest } from "./evidence.js";
import { safeIdV1Schema, safeIntegerV1Schema, sha256DigestV1Schema } from "./evidence.js";
import type { DeclaredInputRef } from "./fingerprints.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import { repositoryPathClaimV1Schema } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";
import type { RepositoryName } from "./config.js";
import { repositoryNameV1Schema } from "./config.js";

/** Parentless clone so durable documents never emit an unresolvable config-document `$ref`. */
export const durableRepositoryNameV1Schema = repositoryNameV1Schema.clone(repositoryNameV1Schema.def);

/**
 * Shapes shared by more than one durable root. Every type here is a `type` alias rather than an
 * `interface` (D1): `CanonicalDocument<T extends PlainJsonValue>` grants the implicit index
 * signature it needs only to aliases, and it checks the whole reachable graph, so an `interface`
 * nested anywhere below a durable root fails the constraint at the root.
 */

export const OUTPUT_OPERATIONS = ["add", "modify", "delete", "rename"] as const;
export type OutputOperation = (typeof OUTPUT_OPERATIONS)[number];

export const OUTPUT_FILE_TYPES = ["regular", "symlink"] as const;
export type OutputFileType = (typeof OUTPUT_FILE_TYPES)[number];

export const OUTPUT_STORAGE = ["git-object", "raw-payload"] as const;
export type OutputStorage = (typeof OUTPUT_STORAGE)[number];

/**
 * D9: narrows `GitTreeMode`, which also admits `040000` (a tree) and `160000` (a gitlink). Neither
 * can be a declared output blob, so the rejection is a structural enum rather than a comment.
 */
export const BLOB_TREE_MODES = ["100644", "100755", "120000"] as const;
export type BlobTreeMode = (typeof BLOB_TREE_MODES)[number];

export type RegularBlobIdentity = {
  readonly oid: GitOid;
  readonly mode: "100644" | "100755";
  readonly size_bytes: SafeInteger;
};
export type SymlinkBlobIdentity = {
  readonly oid: GitOid;
  readonly mode: "120000";
  readonly size_bytes: SafeInteger;
};
export type BlobIdentity = RegularBlobIdentity | SymlinkBlobIdentity;

/** Durable classes an implementation output may claim. Ignored workspace bytes are never outputs. */
export const CLAIMABLE_OUTPUT_PATH_CLASSES = [
  "document", "repository-source", "task-branch-constitution",
] as const;
export type ClaimableOutputPathClass = (typeof CLAIMABLE_OUTPUT_PATH_CLASSES)[number];

/**
 * The eight classes an output may never claim. Together with `CLAIMABLE_OUTPUT_PATH_CLASSES` this
 * partitions all 11 durable `PATH_CLASSES`. The two members `READ_ONLY_PATH_CLASSES`
 * (`path-claims.ts:101`) also names are re-listed literally rather than spread: this must stay a
 * closed `as const` tuple whose element type is a literal union, and `READ_ONLY_PATH_CLASSES` is
 * typed `readonly PathClass[]`. `task-ask` is agent-authored PRD-phase context rather than
 * server-owned authority, but it lives here because an implementation output must never claim it.
 */
export const SERVER_OWNED_PATH_CLASSES = [
  "authority-decision", "authority-initialization", "authority-result",
  "shared-constitution", "shared-workflow", "task-ask", "task-config", "task-state",
] as const;

/**
 * The 14 pinned `OutputEntry` leaves, declared flat rather than as intersections of the three
 * recurring property groups. An intersection is not guaranteed the implicit index signature D1
 * requires, and a leaf that fails that constraint fails it silently at the root, so every leaf
 * spells out all of its properties.
 *
 * `before` and `after` are deliberately asymmetric. On `modify` and `rename`, `before` is an
 * unconstrained `BlobIdentity` — either variant, independent of `file_type` — because a regular
 * file may be replaced by a symlink or the reverse and `file_type` describes the post-state. On
 * `delete`, `before` *is* the surviving blob and is mode-locked to `file_type` instead, and
 * `after` is absent. `delete` forces `git-object` because there is no post-state content to store.
 *
 * `payload_bytes` and `payload_digest`, and `BlobIdentity.oid`, are assertions here, not verified
 * facts: nothing in this format module sees a byte. Phase 11 verifies them at materialization time.
 *
 * A cross-class rename is *representable*: `path` and `previous_path` are runtime-indistinguishable
 * `RepositoryPathClaim` strings and no class can be derived from either here. Phase 11 classifies
 * both endpoints.
 */
type AddGitRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "add"; readonly storage: "git-object";
  readonly file_type: "regular"; readonly after: RegularBlobIdentity;
};
type AddGitSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "add"; readonly storage: "git-object";
  readonly file_type: "symlink"; readonly after: SymlinkBlobIdentity;
};
type AddRawRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "add"; readonly storage: "raw-payload";
  readonly payload_bytes: SafeInteger; readonly payload_digest: Sha256Digest;
  readonly file_type: "regular"; readonly after: RegularBlobIdentity;
};
type AddRawSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "add"; readonly storage: "raw-payload";
  readonly payload_bytes: SafeInteger; readonly payload_digest: Sha256Digest;
  readonly file_type: "symlink"; readonly after: SymlinkBlobIdentity;
};
type ModifyGitRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "modify"; readonly storage: "git-object";
  readonly file_type: "regular"; readonly before: BlobIdentity; readonly after: RegularBlobIdentity;
};
type ModifyGitSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "modify"; readonly storage: "git-object";
  readonly file_type: "symlink"; readonly before: BlobIdentity; readonly after: SymlinkBlobIdentity;
};
type ModifyRawRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "modify"; readonly storage: "raw-payload";
  readonly payload_bytes: SafeInteger; readonly payload_digest: Sha256Digest;
  readonly file_type: "regular"; readonly before: BlobIdentity; readonly after: RegularBlobIdentity;
};
type ModifyRawSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "modify"; readonly storage: "raw-payload";
  readonly payload_bytes: SafeInteger; readonly payload_digest: Sha256Digest;
  readonly file_type: "symlink"; readonly before: BlobIdentity; readonly after: SymlinkBlobIdentity;
};
type RenameGitRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "rename"; readonly storage: "git-object";
  readonly file_type: "regular"; readonly before: BlobIdentity;
  readonly after: RegularBlobIdentity; readonly previous_path: RepositoryPathClaim;
};
type RenameGitSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "rename"; readonly storage: "git-object";
  readonly file_type: "symlink"; readonly before: BlobIdentity;
  readonly after: SymlinkBlobIdentity; readonly previous_path: RepositoryPathClaim;
};
type RenameRawRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "rename"; readonly storage: "raw-payload";
  readonly payload_bytes: SafeInteger; readonly payload_digest: Sha256Digest;
  readonly file_type: "regular"; readonly before: BlobIdentity;
  readonly after: RegularBlobIdentity; readonly previous_path: RepositoryPathClaim;
};
type RenameRawSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "rename"; readonly storage: "raw-payload";
  readonly payload_bytes: SafeInteger; readonly payload_digest: Sha256Digest;
  readonly file_type: "symlink"; readonly before: BlobIdentity;
  readonly after: SymlinkBlobIdentity; readonly previous_path: RepositoryPathClaim;
};
type DeleteGitRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "delete"; readonly storage: "git-object";
  readonly file_type: "regular"; readonly before: RegularBlobIdentity;
};
type DeleteGitSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "delete"; readonly storage: "git-object";
  readonly file_type: "symlink"; readonly before: SymlinkBlobIdentity;
};

/** Written in the pinned leaf order 1-14. Every combination outside it is uninhabitable. */
export type OutputEntry =
  | AddGitRegular
  | AddGitSymlink
  | AddRawRegular
  | AddRawSymlink
  | ModifyGitRegular
  | ModifyGitSymlink
  | ModifyRawRegular
  | ModifyRawSymlink
  | RenameGitRegular
  | RenameGitSymlink
  | RenameRawRegular
  | RenameRawSymlink
  | DeleteGitRegular
  | DeleteGitSymlink;

const gitOid = gitOidV1Schema;
const safeInteger = safeIntegerV1Schema as unknown as z.ZodType<SafeInteger>;
const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;

/**
 * D9's vocabulary declaration as a Zod value: nothing composes it — both blob-identity variants pin
 * their own mode subset — but `durable-primitives.schema.json` publishes it as the `blobTreeMode`
 * `$def`, so the generator needs the schema object to emit.
 */
export const blobTreeModeV1Schema = z.enum(BLOB_TREE_MODES);

/** Emitted as the `claimableOutputPathClass` `$def`; every output leaf reaches it by `$ref`. */
export const claimableOutputPathClassV1Schema = z.enum(CLAIMABLE_OUTPUT_PATH_CLASSES);

/**
 * Exported for schema generation only: nothing outside this module declares a field of either
 * blob-identity type, and the matrix exercises both through `outputEntryV1Schema`.
 */
export const regularBlobIdentityV1Schema = z.object({
  oid: gitOid,
  mode: z.enum(["100644", "100755"]),
  size_bytes: safeInteger,
}).strict();

export const symlinkBlobIdentityV1Schema = z.object({
  oid: gitOid,
  mode: z.literal("120000"),
  size_bytes: safeInteger,
}).strict();

export const blobIdentityV1Schema = z.union([regularBlobIdentityV1Schema, symlinkBlobIdentityV1Schema]);

/** The three recurring property groups, as Zod values rather than TypeScript types (see D1). */
const common = {
  path: repositoryPathClaimV1Schema,
  path_class: claimableOutputPathClassV1Schema,
} as const;
const gitStorage = { storage: z.literal("git-object") } as const;
const rawStorage = {
  storage: z.literal("raw-payload"),
  payload_bytes: safeInteger,
  payload_digest: sha256Digest,
} as const;

const addGitRegular = z.object({ ...common, ...gitStorage, operation: z.literal("add"), file_type: z.literal("regular"), after: regularBlobIdentityV1Schema }).strict();
const addGitSymlink = z.object({ ...common, ...gitStorage, operation: z.literal("add"), file_type: z.literal("symlink"), after: symlinkBlobIdentityV1Schema }).strict();
const addRawRegular = z.object({ ...common, ...rawStorage, operation: z.literal("add"), file_type: z.literal("regular"), after: regularBlobIdentityV1Schema }).strict();
const addRawSymlink = z.object({ ...common, ...rawStorage, operation: z.literal("add"), file_type: z.literal("symlink"), after: symlinkBlobIdentityV1Schema }).strict();

const modifyGitRegular = z.object({ ...common, ...gitStorage, operation: z.literal("modify"), file_type: z.literal("regular"), before: blobIdentityV1Schema, after: regularBlobIdentityV1Schema }).strict();
const modifyGitSymlink = z.object({ ...common, ...gitStorage, operation: z.literal("modify"), file_type: z.literal("symlink"), before: blobIdentityV1Schema, after: symlinkBlobIdentityV1Schema }).strict();
const modifyRawRegular = z.object({ ...common, ...rawStorage, operation: z.literal("modify"), file_type: z.literal("regular"), before: blobIdentityV1Schema, after: regularBlobIdentityV1Schema }).strict();
const modifyRawSymlink = z.object({ ...common, ...rawStorage, operation: z.literal("modify"), file_type: z.literal("symlink"), before: blobIdentityV1Schema, after: symlinkBlobIdentityV1Schema }).strict();

const renameGitRegular = z.object({ ...common, ...gitStorage, operation: z.literal("rename"), file_type: z.literal("regular"), before: blobIdentityV1Schema, after: regularBlobIdentityV1Schema, previous_path: repositoryPathClaimV1Schema }).strict();
const renameGitSymlink = z.object({ ...common, ...gitStorage, operation: z.literal("rename"), file_type: z.literal("symlink"), before: blobIdentityV1Schema, after: symlinkBlobIdentityV1Schema, previous_path: repositoryPathClaimV1Schema }).strict();
const renameRawRegular = z.object({ ...common, ...rawStorage, operation: z.literal("rename"), file_type: z.literal("regular"), before: blobIdentityV1Schema, after: regularBlobIdentityV1Schema, previous_path: repositoryPathClaimV1Schema }).strict();
const renameRawSymlink = z.object({ ...common, ...rawStorage, operation: z.literal("rename"), file_type: z.literal("symlink"), before: blobIdentityV1Schema, after: symlinkBlobIdentityV1Schema, previous_path: repositoryPathClaimV1Schema }).strict();

const deleteGitRegular = z.object({ ...common, ...gitStorage, operation: z.literal("delete"), file_type: z.literal("regular"), before: regularBlobIdentityV1Schema }).strict();
const deleteGitSymlink = z.object({ ...common, ...gitStorage, operation: z.literal("delete"), file_type: z.literal("symlink"), before: symlinkBlobIdentityV1Schema }).strict();

/**
 * D10 — a *nested* discriminated union, pinned exactly. Two obvious alternatives were probed live
 * against the pinned `zod@4.4.3` and throw at **parse** time, not construction time, so a build
 * that only constructs the schema looks fine: four flat options sharing `operation: "add"` throws
 * `Duplicate discriminator value "add"`, and a plain `z.union([...])` used as one option of the
 * outer `discriminatedUnion` throws `Invalid discriminated union option at index "0"`. Each option
 * is therefore itself a `discriminatedUnion`, one level per discriminator.
 *
 * The outer options are ordered `add`, `modify`, `rename`, `delete` to match the JSON Schema
 * `if`/`then`/`else` ladder, so the two authorities can be read side by side.
 */
export const outputEntryV1Schema = z.discriminatedUnion("operation", [
  z.discriminatedUnion("storage", [
    z.discriminatedUnion("file_type", [addGitRegular, addGitSymlink]),
    z.discriminatedUnion("file_type", [addRawRegular, addRawSymlink]),
  ]),
  z.discriminatedUnion("storage", [
    z.discriminatedUnion("file_type", [modifyGitRegular, modifyGitSymlink]),
    z.discriminatedUnion("file_type", [modifyRawRegular, modifyRawSymlink]),
  ]),
  z.discriminatedUnion("storage", [
    z.discriminatedUnion("file_type", [renameGitRegular, renameGitSymlink]),
    z.discriminatedUnion("file_type", [renameRawRegular, renameRawSymlink]),
  ]),
  z.discriminatedUnion("storage", [
    z.discriminatedUnion("file_type", [deleteGitRegular, deleteGitSymlink]),
  ]),
]) as unknown as z.ZodType<OutputEntry>;

/**
 * The five canonical locations a task's durable state occupies, all in the worktree frame. Carried
 * verbatim by both initialization artifacts so a reader never re-derives them from `task_id`.
 */
export type CanonicalTaskPaths = {
  /** `.archflow/tasks/<task_id>` */
  readonly task_root: RepositoryPathClaim;
  readonly config: RepositoryPathClaim;
  readonly state: RepositoryPathClaim;
  /** `.archflow/workflow.yaml` — shared, not task-scoped. */
  readonly workflow: RepositoryPathClaim;
  /** `.archflow/constitution` — shared, not task-scoped. */
  readonly constitution_root: RepositoryPathClaim;
};

export const canonicalTaskPathsV1Schema = z.object({
  task_root: repositoryPathClaimV1Schema,
  config: repositoryPathClaimV1Schema,
  state: repositoryPathClaimV1Schema,
  workflow: repositoryPathClaimV1Schema,
  constitution_root: repositoryPathClaimV1Schema,
}).strict() as unknown as z.ZodType<CanonicalTaskPaths>;

/**
 * The mirror for `DeclaredInputRef` (`fingerprints.ts:11`), which ships with a JSON `$def` here and
 * nowhere else. Deliberately carries no ordering rule: every `declared_inputs` field that holds a
 * set of these declares the sort itself, on `input_id`.
 */
export const declaredInputRefV1Schema = z.object({
  input_id: safeIdV1Schema,
  digest: sha256DigestV1Schema,
}).strict() as unknown as z.ZodType<DeclaredInputRef>;

/**
 * One projected worktree file, named by path and content digest. Result manifests record the
 * projections a snapshot materialized, and reconciliation re-derives each digest from the worktree
 * to detect drift against the recorded set.
 */
export type ProjectionDigestRef = {
  /** Omission denotes the primary repository for archive compatibility. */
  readonly repository?: RepositoryName;
  readonly path: RepositoryPathClaim;
  readonly content_digest: Sha256Digest;
};

export const projectionDigestRefV1Schema = z.object({
  repository: durableRepositoryNameV1Schema.optional(),
  path: repositoryPathClaimV1Schema,
  content_digest: sha256Digest,
}).strict() as unknown as z.ZodType<ProjectionDigestRef>;

/**
 * D16 — `git-object ⇒ stored_bytes === 0` is *structural*, a two-branch discriminated union on
 * `storage` rather than a rule inside `validateDurableSemantics`. A git-object entry stores no
 * bytes of its own, so the only admissible value is `0` and the contradiction is uninhabitable.
 * The genuinely cross-shape half — `stored_bytes === payload_bytes` for a `raw-payload` entry —
 * needs the matching `OutputEntry` and stays semantic.
 */
export type SnapshotAccountingEntry =
  | { readonly path: RepositoryPathClaim; readonly storage: "git-object"; readonly stored_bytes: 0 }
  | { readonly path: RepositoryPathClaim; readonly storage: "raw-payload"; readonly stored_bytes: SafeInteger };

/** 25 MiB. */
const RESULT_BYTE_CAP = 26_214_400;
/** 250 MiB. */
const TASK_BYTE_CAP = 262_144_000;

export type SnapshotAccountingV1 = {
  readonly schema_version: "1";
  readonly result_bytes: SafeInteger;
  readonly task_bytes: SafeInteger;
  readonly result_byte_cap: 26214400;
  readonly task_byte_cap: 262144000;
  /** SET — sorted by `path`, duplicates rejected. */
  readonly counted_entries: readonly SnapshotAccountingEntry[];
  readonly measured_at_revision: SafeInteger;
};

/** Exported for schema generation only: nothing outside this module declares a field of the entry type. */
export const snapshotAccountingEntryV1Schema = z.discriminatedUnion("storage", [
  z.object({ path: repositoryPathClaimV1Schema, storage: z.literal("git-object"), stored_bytes: z.literal(0) }).strict(),
  z.object({ path: repositoryPathClaimV1Schema, storage: z.literal("raw-payload"), stored_bytes: safeInteger }).strict(),
]);

/**
 * The caps are structural `maximum`s, not validator rules. `measured_at_revision` pins its own
 * `.min(1)` rather than reusing `safeIntegerV1Schema` (D8): `SafeInteger` admits `0`, and there is
 * no revision `0`. `result_bytes` and `task_bytes` admit `0` and pin the full integer range
 * themselves — a capped derivation of the registered `safeInteger` would emit as a bare `$ref`
 * plus `maximum`, which Ajv strict mode rejects when it compiles the generated document.
 *
 * The `counted_entries` ordering rule calls `isSortedUniqueBy` with `tupleKey("path")` — the
 * shared exported ordering predicates — so every shape enforces literally the same rule.
 */
export const snapshotAccountingV1Schema = z.object({
  schema_version: z.literal("1"),
  result_bytes: z.number().int().min(0).max(RESULT_BYTE_CAP),
  task_bytes: z.number().int().min(0).max(TASK_BYTE_CAP),
  result_byte_cap: z.literal(RESULT_BYTE_CAP),
  task_byte_cap: z.literal(TASK_BYTE_CAP),
  counted_entries: z.array(snapshotAccountingEntryV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("path")), "counted_entries must be sorted by path with no duplicates"),
  measured_at_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict() as unknown as z.ZodType<SnapshotAccountingV1>;

/** Throws, per the contract-layer convention. */
export function parseSnapshotAccounting(value: unknown): SnapshotAccountingV1 {
  assertPlainJson(value, "snapshot accounting");
  return snapshotAccountingV1Schema.parse(value);
}
