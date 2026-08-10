import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { GitOid } from "../../src/contracts/canonical.js";
import {
  SERVER_OWNED_PATH_CLASSES,
  outputEntryV1Schema,
  type OutputEntry,
} from "../../src/contracts/durable-primitives.js";
import type { SafeInteger, Sha256Digest } from "../../src/contracts/evidence.js";
import type { RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

/**
 * The adversarial `OutputEntry` matrix (Phase 7, chunk 3). Every expectation below is transcribed
 * from the pinned 14-row branch table in the phase design — its `operation` / `storage` /
 * `file_type` columns, its "Also required" column, and its "Forbidden" column — not from
 * `durable-primitives.ts`. Only the exported names are imported from the implementation. If the
 * two ever disagree, the table is the authority and this file is the report.
 *
 * The table is structurally total but deliberately **not integrity-total**: nothing here requires
 * `payload_bytes` to equal a real byte length, `payload_digest` to equal SHA-256 of those bytes, or
 * `after.oid` to equal `gitBlobOid(bytes)`. Phase 10 verifies those against retained bytes; Phase 7
 * only guarantees the fields are present, typed, and required so the later check is possible.
 */

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

/**
 * `durable-primitives.schema.json` declares no root document, and the new `$def` is not registered
 * yet (chunk 13 owns `versions.ts`), so the Ajv authority is built from a wrapper that `$ref`s the
 * pinned pointer directly — the same reference chunk 9 will use for `implementation-output.outputs[*]`.
 */
const outputEntryValidator = await createJsonSchemaValidator<OutputEntry>(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:archflow:schema:v1:test:output-entry-matrix",
    $ref: "urn:archflow:schema:v1:durable-primitives#/$defs/outputEntry",
  },
  [await schema("durable-primitives"), await schema("primitives"), await schema("path-claim")]
);

type Entry = Record<string, unknown>;

const oid = (fill: string): string => fill.repeat(40).slice(0, 40);
const digest = (fill: string): string => fill.repeat(64).slice(0, 64);

/** Blob identities. `regular` admits 100644 and 100755; `symlink` is locked to 120000 (D9). */
const regular644 = { oid: oid("a1b2"), mode: "100644", size_bytes: 1024 };
const regular755 = { oid: oid("b2c3"), mode: "100755", size_bytes: 2048 };
const symlink = { oid: oid("c3d4"), mode: "120000", size_bytes: 17 };

/** The three recurring property groups named in the design, as data. */
const common = { path: "src/module/file.ts", path_class: "repository-source" } as const;
const git = { storage: "git-object" } as const;
const raw = { storage: "raw-payload", payload_bytes: 0, payload_digest: digest("d4e5") } as const;

/**
 * The pinned branch table, row for row. `required` is the exact key set the row permits (the three
 * groups plus the "Also required" column); `forbidden` is transcribed from the "Forbidden" column.
 * `BRANCH_PROPERTIES` is the universe those two columns partition.
 */
const BRANCH_PROPERTIES = ["before", "after", "previous_path", "payload_bytes", "payload_digest"] as const;
const COMMON_KEYS = ["path", "path_class", "operation", "storage", "file_type"] as const;

type Row = {
  readonly leaf: number;
  readonly alias: string;
  readonly sample: Entry;
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
};

const rows: readonly Row[] = [
  {
    leaf: 1, alias: "AddGitRegular",
    sample: { ...common, ...git, operation: "add", file_type: "regular", after: regular644 },
    required: ["after"],
    forbidden: ["before", "previous_path", "payload_bytes", "payload_digest"],
  },
  {
    leaf: 2, alias: "AddGitSymlink",
    sample: { ...common, ...git, operation: "add", file_type: "symlink", after: symlink },
    required: ["after"],
    forbidden: ["before", "previous_path", "payload_bytes", "payload_digest"],
  },
  {
    leaf: 3, alias: "AddRawRegular",
    sample: { ...common, ...raw, operation: "add", file_type: "regular", after: regular755 },
    required: ["payload_bytes", "payload_digest", "after"],
    forbidden: ["before", "previous_path"],
  },
  {
    leaf: 4, alias: "AddRawSymlink",
    sample: { ...common, ...raw, operation: "add", file_type: "symlink", after: symlink },
    required: ["payload_bytes", "payload_digest", "after"],
    forbidden: ["before", "previous_path"],
  },
  {
    leaf: 5, alias: "ModifyGitRegular",
    sample: { ...common, ...git, operation: "modify", file_type: "regular", before: regular644, after: regular755 },
    required: ["before", "after"],
    forbidden: ["previous_path", "payload_bytes", "payload_digest"],
  },
  {
    leaf: 6, alias: "ModifyGitSymlink",
    sample: { ...common, ...git, operation: "modify", file_type: "symlink", before: symlink, after: symlink },
    required: ["before", "after"],
    forbidden: ["previous_path", "payload_bytes", "payload_digest"],
  },
  {
    leaf: 7, alias: "ModifyRawRegular",
    sample: { ...common, ...raw, operation: "modify", file_type: "regular", before: regular644, after: regular644 },
    required: ["payload_bytes", "payload_digest", "before", "after"],
    forbidden: ["previous_path"],
  },
  {
    leaf: 8, alias: "ModifyRawSymlink",
    sample: { ...common, ...raw, operation: "modify", file_type: "symlink", before: symlink, after: symlink },
    required: ["payload_bytes", "payload_digest", "before", "after"],
    forbidden: ["previous_path"],
  },
  {
    leaf: 9, alias: "RenameGitRegular",
    sample: { ...common, ...git, operation: "rename", file_type: "regular", before: regular644, after: regular644, previous_path: "src/module/old.ts" },
    required: ["before", "after", "previous_path"],
    forbidden: ["payload_bytes", "payload_digest"],
  },
  {
    leaf: 10, alias: "RenameGitSymlink",
    sample: { ...common, ...git, operation: "rename", file_type: "symlink", before: symlink, after: symlink, previous_path: "src/module/old-link" },
    required: ["before", "after", "previous_path"],
    forbidden: ["payload_bytes", "payload_digest"],
  },
  {
    leaf: 11, alias: "RenameRawRegular",
    sample: { ...common, ...raw, operation: "rename", file_type: "regular", before: regular755, after: regular644, previous_path: "src/module/old.ts" },
    required: ["payload_bytes", "payload_digest", "before", "after", "previous_path"],
    forbidden: [],
  },
  {
    leaf: 12, alias: "RenameRawSymlink",
    sample: { ...common, ...raw, operation: "rename", file_type: "symlink", before: symlink, after: symlink, previous_path: "src/module/old-link" },
    required: ["payload_bytes", "payload_digest", "before", "after", "previous_path"],
    forbidden: [],
  },
  {
    leaf: 13, alias: "DeleteGitRegular",
    // On `delete`, `before` IS the surviving blob and is mode-locked to `file_type`.
    sample: { ...common, ...git, operation: "delete", file_type: "regular", before: regular644 },
    required: ["before"],
    forbidden: ["after", "previous_path", "payload_bytes", "payload_digest"],
  },
  {
    leaf: 14, alias: "DeleteGitSymlink",
    sample: { ...common, ...git, operation: "delete", file_type: "symlink", before: symlink },
    required: ["before"],
    forbidden: ["after", "previous_path", "payload_bytes", "payload_digest"],
  },
];

const leaf = (number: number): Entry => rows.find((row) => row.leaf === number)!.sample;

const without = (base: Entry, ...keys: readonly string[]): Entry => {
  const copy: Entry = { ...base };
  for (const key of keys) delete copy[key];
  return copy;
};

const withProperties = (base: Entry, extra: Entry): Entry => ({ ...base, ...extra });

/**
 * `assertZodAgreement` is the repo idiom for proving a mirror. It raises two distinguishable
 * failures: "validators disagree" when only one authority accepted, and "schema validation failed"
 * when both rejected. Matching the second message is therefore itself the agreement assertion.
 */
const agreedRejection = (label: string, value: Entry): void => {
  expect(outputEntryValidator.validate(value), `${label}: JSON Schema unexpectedly accepted`).toBe(false);
  expect(outputEntryV1Schema.safeParse(value).success, `${label}: Zod mirror unexpectedly accepted`).toBe(false);
  expect(() => assertZodAgreement(value, outputEntryValidator, outputEntryV1Schema, label)).toThrowError(/schema validation failed/);
};

const agreedAcceptance = (label: string, value: Entry): void => {
  expect(outputEntryValidator.validate(value), `${label}: ${JSON.stringify(outputEntryValidator.validate.errors)}`).toBe(true);
  expect(outputEntryV1Schema.safeParse(value).success, `${label}: Zod mirror rejected`).toBe(true);
  expect(assertZodAgreement(value, outputEntryValidator, outputEntryV1Schema, label)).toBe(value);
};

describe("OutputEntry branch matrix — the pinned table is structurally total", () => {
  it("pins exactly 14 leaves, and the 2 excluded triples are the raw-payload deletes", () => {
    expect(rows).toHaveLength(14);
    const triples = rows.map((row) => `${String(row.sample.operation)}/${String(row.sample.storage)}/${String(row.sample.file_type)}`);
    expect(new Set(triples).size).toBe(14);
    const universe = ["add", "modify", "rename", "delete"].flatMap((operation) =>
      ["git-object", "raw-payload"].flatMap((storage) =>
        ["regular", "symlink"].map((fileType) => `${operation}/${storage}/${fileType}`)));
    expect(universe).toHaveLength(16);
    expect(universe.filter((triple) => !triples.includes(triple))).toEqual([
      "delete/raw-payload/regular",
      "delete/raw-payload/symlink",
    ]);
  });

  it("gives each sample exactly its row's required keys and none of its forbidden ones", () => {
    for (const row of rows) {
      const label = `leaf ${row.leaf} ${row.alias}`;
      expect(Object.keys(row.sample).sort(), label).toEqual([...COMMON_KEYS, ...row.required].sort());
      for (const property of row.forbidden) expect(Object.hasOwn(row.sample, property), `${label}: ${property}`).toBe(false);
      // The two columns partition the branch-property universe: nothing is left unstated.
      const branchRequired = row.required.filter((name) => (BRANCH_PROPERTIES as readonly string[]).includes(name));
      expect([...branchRequired, ...row.forbidden].sort(), label).toEqual([...BRANCH_PROPERTIES].sort());
    }
  });
});

describe("OutputEntry acceptance — one sample per pinned leaf, both authorities", () => {
  for (const row of rows) {
    it(`accepts leaf ${row.leaf} (${row.alias})`, () => {
      agreedAcceptance(`leaf ${row.leaf} ${row.alias}`, row.sample);
    });
  }

  /**
   * `before` on `modify`/`rename` is deliberately free of `file_type`: `file_type` describes the
   * post-state, so a regular file may be replaced by a symlink or the reverse. This is a pinned
   * design decision, NOT an omission in the ladder — do not "fix" it by mode-locking `before`.
   * Only the surviving blob is mode-locked (`after` on add/modify/rename, `before` on delete).
   */
  it("accepts a modify whose regular file becomes a symlink and the reverse", () => {
    const regularToSymlink = {
      ...common, ...git, operation: "modify", file_type: "symlink",
      before: { oid: oid("e5f6"), mode: "100644", size_bytes: 300 },
      after: { oid: oid("f6a7"), mode: "120000", size_bytes: 12 },
    };
    const symlinkToRegular = {
      ...common, ...git, operation: "modify", file_type: "regular",
      before: { oid: oid("0a1b"), mode: "120000", size_bytes: 12 },
      after: { oid: oid("1b2c"), mode: "100644", size_bytes: 300 },
    };
    agreedAcceptance("modify regular -> symlink", regularToSymlink);
    agreedAcceptance("modify symlink -> regular", symlinkToRegular);
  });

  /**
   * A cross-class rename is representable and that is deliberate (the design withdraws the earlier
   * "structurally unrepresentable" claim): both endpoints are runtime-indistinguishable
   * `RepositoryPathClaim` strings and no class can be derived from either here. Phase 10 classifies
   * both endpoints and rejects a disagreeing pair.
   */
  it("accepts a rename whose endpoints in fact belong to different classes", () => {
    agreedAcceptance("cross-class rename", {
      ...leaf(9), path: ".archflow/tasks/demo/reviews/moved.md", previous_path: "src/module/old.ts",
    });
  });
});

describe("OutputEntry rejection — both authorities agree on every off-table shape", () => {
  it("rejects a raw-payload delete: there is no post-state content to store", () => {
    agreedRejection("delete + raw-payload", withProperties(leaf(13), { storage: "raw-payload", payload_bytes: 10, payload_digest: digest("2c3d") }));
    agreedRejection("delete + raw-payload, no payload fields", withProperties(leaf(14), { storage: "raw-payload" }));
  });

  it("rejects a git-object entry carrying payload fields", () => {
    agreedRejection("add/git + payload_digest", withProperties(leaf(1), { payload_digest: digest("3d4e") }));
    agreedRejection("add/git + both payload fields", withProperties(leaf(1), { payload_bytes: 8, payload_digest: digest("3d4e") }));
    agreedRejection("modify/git + payload fields", withProperties(leaf(5), { payload_bytes: 8, payload_digest: digest("3d4e") }));
    agreedRejection("rename/git + payload fields", withProperties(leaf(9), { payload_bytes: 8, payload_digest: digest("3d4e") }));
    agreedRejection("delete/git + payload fields", withProperties(leaf(13), { payload_bytes: 8, payload_digest: digest("3d4e") }));
  });

  it("rejects a raw-payload entry missing payload_digest", () => {
    for (const number of [3, 4, 7, 8, 11, 12]) {
      agreedRejection(`leaf ${number} without payload_digest`, without(leaf(number), "payload_digest"));
    }
  });

  it("rejects a raw-payload entry missing payload_bytes", () => {
    for (const number of [3, 4, 7, 8, 11, 12]) {
      agreedRejection(`leaf ${number} without payload_bytes`, without(leaf(number), "payload_bytes"));
    }
  });

  it("rejects a delete carrying after", () => {
    agreedRejection("delete/regular + after", withProperties(leaf(13), { after: regular644 }));
    agreedRejection("delete/symlink + after", withProperties(leaf(14), { after: symlink }));
  });

  it("rejects an add carrying before", () => {
    agreedRejection("add/git/regular + before", withProperties(leaf(1), { before: regular644 }));
    agreedRejection("add/git/symlink + before", withProperties(leaf(2), { before: symlink }));
    agreedRejection("add/raw/regular + before", withProperties(leaf(3), { before: regular644 }));
    agreedRejection("add/raw/symlink + before", withProperties(leaf(4), { before: symlink }));
  });

  it("rejects a rename missing previous_path", () => {
    for (const number of [9, 10, 11, 12]) {
      agreedRejection(`leaf ${number} without previous_path`, without(leaf(number), "previous_path"));
    }
  });

  it("rejects an add carrying previous_path", () => {
    for (const number of [1, 2, 3, 4]) {
      agreedRejection(`leaf ${number} + previous_path`, withProperties(leaf(number), { previous_path: "src/module/old.ts" }));
    }
  });

  it("rejects a modify carrying previous_path", () => {
    for (const number of [5, 6, 7, 8]) {
      agreedRejection(`leaf ${number} + previous_path`, withProperties(leaf(number), { previous_path: "src/module/old.ts" }));
    }
  });

  it("rejects file_type regular with a symlink after mode", () => {
    for (const number of [1, 3, 5, 7, 9, 11]) {
      agreedRejection(`leaf ${number} after.mode 120000`, withProperties(leaf(number), { after: { oid: oid("4e5f"), mode: "120000", size_bytes: 12 } }));
    }
  });

  it("rejects file_type symlink with a regular after mode", () => {
    for (const number of [2, 4, 6, 8, 10, 12]) {
      agreedRejection(`leaf ${number} after.mode 100644`, withProperties(leaf(number), { after: { oid: oid("5f6a"), mode: "100644", size_bytes: 12 } }));
      agreedRejection(`leaf ${number} after.mode 100755`, withProperties(leaf(number), { after: { oid: oid("5f6a"), mode: "100755", size_bytes: 12 } }));
    }
  });

  /** D9: `160000` (gitlink) and `040000` (tree) are outside the narrowed blob-mode enum entirely. */
  it("rejects the gitlink mode 160000 in every blob position", () => {
    const gitlink = { oid: oid("6a7b"), mode: "160000", size_bytes: 12 };
    agreedRejection("add after.mode 160000", withProperties(leaf(1), { after: gitlink }));
    agreedRejection("add/symlink after.mode 160000", withProperties(leaf(2), { after: gitlink }));
    agreedRejection("modify before.mode 160000", withProperties(leaf(5), { before: gitlink }));
    agreedRejection("rename before.mode 160000", withProperties(leaf(9), { before: gitlink }));
    agreedRejection("delete before.mode 160000", withProperties(leaf(13), { before: gitlink }));
  });

  it("rejects the tree mode 040000 in every blob position", () => {
    const tree = { oid: oid("7b8c"), mode: "040000", size_bytes: 12 };
    agreedRejection("add after.mode 040000", withProperties(leaf(1), { after: tree }));
    agreedRejection("add/symlink after.mode 040000", withProperties(leaf(2), { after: tree }));
    agreedRejection("modify before.mode 040000", withProperties(leaf(5), { before: tree }));
    agreedRejection("rename before.mode 040000", withProperties(leaf(9), { before: tree }));
    agreedRejection("delete before.mode 040000", withProperties(leaf(13), { before: tree }));
  });

  /** On delete, `before` IS the surviving blob, so unlike modify/rename it is mode-locked. */
  it("rejects a regular delete whose before is a symlink, and a symlink delete whose before is regular", () => {
    agreedRejection("delete/regular before.mode 120000", withProperties(leaf(13), { before: symlink }));
    agreedRejection("delete/symlink before.mode 100644", withProperties(leaf(14), { before: regular644 }));
  });

  it("rejects all eleven server-owned path classes", () => {
    expect(SERVER_OWNED_PATH_CLASSES).toHaveLength(11);
    for (const pathClass of SERVER_OWNED_PATH_CLASSES) {
      agreedRejection(`path_class ${pathClass}`, withProperties(leaf(1), { path_class: pathClass }));
      agreedRejection(`delete + path_class ${pathClass}`, withProperties(leaf(13), { path_class: pathClass }));
    }
  });
});

/**
 * The compile-time half of the criterion: the TypeScript union must have no inhabitant for any
 * off-table shape. `@ts-expect-error` is the assertion — it fails `npm run typecheck` if the line
 * below it *does* compile, and `tsconfig.json` includes `test/**\/*.ts`, so this file is covered.
 * The branded helpers exist so that each error is caused by the branch violation under test rather
 * than by an unbranded `path`, `oid`, or digest.
 */
const PATH = "src/module/file.ts" as unknown as RepositoryPathClaim;
const OID = oid("a1b2") as unknown as GitOid;
const SIZE = 1024 as unknown as SafeInteger;
const DIGEST = digest("d4e5") as unknown as Sha256Digest;
const REGULAR = { oid: OID, mode: "100644", size_bytes: SIZE } as const;

// @ts-expect-error a `delete` may not use raw-payload storage (row 13/14 pin `git-object`).
const deleteRaw: OutputEntry = { path: PATH, path_class: "document", operation: "delete", storage: "raw-payload", payload_bytes: SIZE, payload_digest: DIGEST, file_type: "regular", before: REGULAR };
// @ts-expect-error a git-object entry may not carry payload fields (row 1 Forbidden).
const gitWithPayload: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "git-object", file_type: "regular", after: REGULAR, payload_bytes: SIZE, payload_digest: DIGEST };
// @ts-expect-error a raw-payload entry requires payload_digest (row 3 Also required).
const rawNoDigest: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "raw-payload", payload_bytes: SIZE, file_type: "regular", after: REGULAR };
// @ts-expect-error a raw-payload entry requires payload_bytes (row 3 Also required).
const rawNoBytes: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "raw-payload", payload_digest: DIGEST, file_type: "regular", after: REGULAR };
// @ts-expect-error a `delete` may not carry `after` (row 13 Forbidden).
const deleteWithAfter: OutputEntry = { path: PATH, path_class: "document", operation: "delete", storage: "git-object", file_type: "regular", before: REGULAR, after: REGULAR };
// @ts-expect-error an `add` may not carry `before` (row 1 Forbidden).
const addWithBefore: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "git-object", file_type: "regular", after: REGULAR, before: REGULAR };
// @ts-expect-error a `rename` requires `previous_path` (row 9 Also required).
const renameNoPrevious: OutputEntry = { path: PATH, path_class: "document", operation: "rename", storage: "git-object", file_type: "regular", before: REGULAR, after: REGULAR };
// @ts-expect-error an `add` may not carry `previous_path` (row 1 Forbidden).
const addWithPrevious: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "git-object", file_type: "regular", after: REGULAR, previous_path: PATH };
// @ts-expect-error a `modify` may not carry `previous_path` (row 5 Forbidden).
const modifyWithPrevious: OutputEntry = { path: PATH, path_class: "document", operation: "modify", storage: "git-object", file_type: "regular", before: REGULAR, after: REGULAR, previous_path: PATH };
// @ts-expect-error file_type "regular" locks the surviving blob out of mode 120000.
const regularSymlinkMode: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "git-object", file_type: "regular", after: { oid: OID, mode: "120000", size_bytes: SIZE } };
// @ts-expect-error file_type "symlink" locks the surviving blob to mode 120000.
const symlinkRegularMode: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "git-object", file_type: "symlink", after: { oid: OID, mode: "100644", size_bytes: SIZE } };
// @ts-expect-error D9: 160000 (gitlink) is outside the narrowed blob-mode enum.
const gitlinkMode: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "git-object", file_type: "regular", after: { oid: OID, mode: "160000", size_bytes: SIZE } };
// @ts-expect-error D9: 040000 (tree) is outside the narrowed blob-mode enum.
const treeMode: OutputEntry = { path: PATH, path_class: "document", operation: "add", storage: "git-object", file_type: "regular", after: { oid: OID, mode: "040000", size_bytes: SIZE } };
// @ts-expect-error on delete, `before` is the surviving blob and is mode-locked to file_type.
const deleteRegularSymlinkBefore: OutputEntry = { path: PATH, path_class: "document", operation: "delete", storage: "git-object", file_type: "regular", before: { oid: OID, mode: "120000", size_bytes: SIZE } };
// @ts-expect-error `task-state` is server-owned and outside ClaimableOutputPathClass.
const serverOwnedClass: OutputEntry = { path: PATH, path_class: "task-state", operation: "add", storage: "git-object", file_type: "regular", after: REGULAR };

const uninhabitable = [
  deleteRaw, gitWithPayload, rawNoDigest, rawNoBytes, deleteWithAfter, addWithBefore, renameNoPrevious,
  addWithPrevious, modifyWithPrevious, regularSymlinkMode, symlinkRegularMode, gitlinkMode, treeMode,
  deleteRegularSymlinkBefore, serverOwnedClass,
];

describe("OutputEntry compile-time negative fixture", () => {
  it("covers fifteen shapes the TypeScript union cannot express", () => {
    // The real assertion is the fifteen `@ts-expect-error` directives above: each fails the build if
    // its line ever compiles. This runtime check only keeps the fixtures reachable, and confirms the
    // same values are rejected by both runtime authorities as well.
    expect(uninhabitable).toHaveLength(15);
    for (const [index, value] of uninhabitable.entries()) {
      agreedRejection(`uninhabitable fixture ${index}`, value as unknown as Entry);
    }
  });
});
