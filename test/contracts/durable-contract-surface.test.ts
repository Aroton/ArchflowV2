import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { documentArtifactV1Schema } from "../../src/contracts/durable-document.js";
import { implementationOutputV1Schema } from "../../src/contracts/durable-implementation-output.js";
import { legacyImportInitializationV1Schema } from "../../src/contracts/durable-legacy-import.js";
import {
  CLAIMABLE_OUTPUT_PATH_CLASSES,
  SERVER_OWNED_PATH_CLASSES,
  canonicalTaskPathsV1Schema,
  declaredInputRefV1Schema,
  outputEntryV1Schema,
  snapshotAccountingV1Schema,
} from "../../src/contracts/durable-primitives.js";
import { taskInitializationV1Schema } from "../../src/contracts/durable-task-initialization.js";
import { PATH_CLASSES } from "../../src/contracts/path-claims.js";
import { SCHEMA_GENERATION_GROUPS } from "../../src/contracts/internal/schema-generation.js";
import {
  createJsonSchemaValidator,
  type JsonSchemaValidator,
  type ZodLikeSchema,
} from "../helpers/json-schema.js";
import { SCHEMA_IDS } from "../../src/contracts/versions.js";

/**
 * The durable contract surface: the registry, the barrel, and the cross-shape properties no single
 * leaf module's tests can see — the claimable/server-owned class partition against `PATH_CLASSES`,
 * the pinned `$def` inventory and its generation-manifest fence, and the negative criteria (D15
 * and the exclusions). The Zod sources are the shape authority and the committed schemas are
 * generated from them (`check:schemas` fences the bytes), so no mirror-agreement loop runs here;
 * the compiled documents are exercised only as third-party consumers.
 *
 * Nothing here edits or restates a leaf module's shape. Every sample is that module's own fixture.
 */

const SRC = new URL("../../src/contracts/", import.meta.url);
const SCHEMA_DIR = new URL("schemas/v1/", SRC);
const FIXTURE_DIR = new URL("../fixtures/contracts/durable/", import.meta.url);

type JsonObject = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

const source = (name: string): string => readFileSync(new URL(name, SRC), "utf8");

const schemaFileNames = (): readonly string[] =>
  readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(".schema.json")).sort();

const schema = (stem: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${stem}.schema.json`, SCHEMA_DIR), "utf8")) as JsonObject;

const fixture = (name: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${name}.valid.json`, FIXTURE_DIR), "utf8")) as JsonObject;

/** Every schema in the directory, keyed by its filename stem. Loaded once, cloned per use. */
const ALL_SCHEMAS: ReadonlyMap<string, JsonObject> = new Map(
  schemaFileNames().map((file) => {
    const stem = file.slice(0, -".schema.json".length);
    return [stem, schema(stem)] as const;
  })
);

/** The durable schema files this suite pins, in the pinned transcription-table order. */
const NEW_SCHEMA_STEMS = [
  "durable-primitives",
  "task-state",
  "intent-receipt",
  "task-initialization",
  "legacy-import-initialization",
  "document-artifact",
  "implementation-output",
] as const;

/** The durable modules this suite pins. `durable.ts` registers no schema; it holds the validator. */
const NEW_MODULES = [
  "durable-primitives.ts",
  "durable-state.ts",
  "durable-intent.ts",
  "durable-task-initialization.ts",
  "durable-legacy-import.ts",
  "durable-document.ts",
  "durable-implementation-output.ts",
  "durable.ts",
] as const;

const references = (...stems: readonly string[]): readonly object[] =>
  stems.map((stem) => clone(ALL_SCHEMAS.get(stem) as JsonObject));

const validator = (stem: string, refs: readonly string[]): JsonSchemaValidator<unknown> =>
  createJsonSchemaValidator<unknown>(clone(ALL_SCHEMAS.get(stem) as JsonObject), references(...refs));

/**
 * A `$def` is never a standalone document, so it is reached through the same one-line `$ref` wrapper
 * a consuming root uses. Compiling the wrapper is also what proves the inventory pointer resolves.
 */
const defValidator = (owner: string, def: string, refs: readonly string[]): JsonSchemaValidator<unknown> =>
  createJsonSchemaValidator<unknown>(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:archflow:schema:v1:test:durable-agreement:${def}`,
      $ref: `${SCHEMA_IDS[owner as keyof typeof SCHEMA_IDS]}#/$defs/${def}`,
    },
    references(...refs)
  );

const BASE = ["primitives", "path-claim"] as const;
const WITH_PRIMITIVES = [...BASE, "durable-primitives"] as const;

/**
 * D2 — the agent-supplied half. Five shapes reachable from the architecture's
 * `archflow_state.artifact` union, plus the three shared `$defs` such a root embeds. Each is
 * anchored on its pinned export name: the import above is the anchor, so a rename in a leaf module
 * fails the build here.
 */
type Mirrored = {
  readonly name: string;
  readonly json: JsonSchemaValidator<unknown>;
  readonly zod: ZodLikeSchema<unknown>;
  readonly sample: unknown;
};

const MIRRORED: readonly Mirrored[] = [
  {
    name: "task-initialization",
    json: validator("task-initialization", WITH_PRIMITIVES),
    zod: taskInitializationV1Schema,
    sample: fixture("task-initialization"),
  },
  {
    name: "legacy-import-initialization",
    json: validator("legacy-import-initialization", WITH_PRIMITIVES),
    zod: legacyImportInitializationV1Schema,
    sample: fixture("legacy-import-initialization"),
  },
  {
    name: "document-artifact",
    json: validator("document-artifact", WITH_PRIMITIVES),
    zod: documentArtifactV1Schema,
    sample: fixture("document-artifact"),
  },
  {
    name: "implementation-output",
    json: validator("implementation-output", [...WITH_PRIMITIVES, "secret-scan-result"]),
    zod: implementationOutputV1Schema,
    sample: fixture("implementation-output"),
  },
  {
    // Not a registry row: `snapshot-accounting` exists only inside `implementation-output.accounting`,
    // so its sample is taken from that fixture's own `accounting` member through a `$ref` wrapper.
    name: "snapshot-accounting",
    json: defValidator("durablePrimitives", "snapshotAccounting", WITH_PRIMITIVES),
    zod: snapshotAccountingV1Schema,
    sample: clone(fixture("implementation-output").accounting),
  },
  {
    name: "outputEntry",
    json: defValidator("durablePrimitives", "outputEntry", WITH_PRIMITIVES),
    zod: outputEntryV1Schema,
    sample: clone((fixture("implementation-output").outputs as readonly unknown[])[0]),
  },
  {
    name: "declaredInputRef",
    json: defValidator("durablePrimitives", "declaredInputRef", WITH_PRIMITIVES),
    zod: declaredInputRefV1Schema,
    sample: clone((fixture("document-artifact").declared_inputs as readonly unknown[])[0]),
  },
  {
    name: "canonicalTaskPaths",
    json: defValidator("durablePrimitives", "canonicalTaskPaths", WITH_PRIMITIVES),
    zod: canonicalTaskPathsV1Schema,
    sample: clone(fixture("task-initialization").canonical_paths),
  },
];

describe("D2 — the agent-supplied roots validate under the Zod authority", () => {
  it("pins exactly the eight roots and $defs", () => {
    expect(MIRRORED.map((entry) => entry.name)).toEqual([
      "task-initialization",
      "legacy-import-initialization",
      "document-artifact",
      "implementation-output",
      "snapshot-accounting",
      "outputEntry",
      "declaredInputRef",
      "canonicalTaskPaths",
    ]);
  });

  for (const entry of MIRRORED) {
    it(`accepts the ${entry.name} sample, and the published schema accepts it too`, () => {
      const result = entry.zod.safeParse(entry.sample);
      expect(result.success, `${entry.name}: Zod rejected`).toBe(true);
      if (result.success) expect(result.data, `${entry.name}: Zod transformed the value`).toEqual(entry.sample);
      expect(entry.json.validate(entry.sample), `${entry.name}: published schema rejected`).toBe(true);
    });

    it(`rejects ${entry.name} with an unknown property`, () => {
      const mutated = { ...(entry.sample as JsonObject), archflow_unknown_property: "x" };
      expect(entry.zod.safeParse(mutated).success).toBe(false);
    });
  }
});

/**
 * The claimable / server-owned partition. This is the assertion that stops a future class added to
 * `path-claims.ts` from landing in neither set — a class in neither is silently unclaimable *and*
 * unprotected, and no leaf chunk's test can see it.
 */
describe("the claimable and server-owned class sets partition PATH_CLASSES", () => {
  it("is a partition: 3 + 8 = 11, disjoint, union exact", () => {
    const claimable = new Set<string>(CLAIMABLE_OUTPUT_PATH_CLASSES);
    const serverOwned = new Set<string>(SERVER_OWNED_PATH_CLASSES);
    const all = new Set<string>(PATH_CLASSES);

    expect(claimable.size).toBe(3);
    expect(serverOwned.size).toBe(8);
    expect(all.size).toBe(11);

    expect([...claimable].filter((entry) => serverOwned.has(entry))).toEqual([]);
    expect([...claimable, ...serverOwned].sort()).toEqual([...all].sort());
  });

  it("rejects an implementation output claiming each server-owned class, structurally", () => {
    const target = MIRRORED.find((entry) => entry.name === "implementation-output") as Mirrored;
    for (const pathClass of SERVER_OWNED_PATH_CLASSES) {
      const mutated = clone(target.sample) as JsonObject;
      (mutated.outputs as JsonObject[])[0]!.path_class = pathClass;
      expect(target.json.validate(mutated), `${pathClass}: JSON Schema accepted`).toBe(false);
      expect(target.zod.safeParse(mutated).success, `${pathClass}: Zod accepted`).toBe(false);
    }
  });

  it("accepts each of the seven claimable classes", () => {
    const target = MIRRORED.find((entry) => entry.name === "implementation-output") as Mirrored;
    for (const pathClass of CLAIMABLE_OUTPUT_PATH_CLASSES) {
      const mutated = clone(target.sample) as JsonObject;
      (mutated.outputs as JsonObject[])[0]!.path_class = pathClass;
      expect(target.json.validate(mutated), `${pathClass}: JSON Schema rejected`).toBe(true);
      expect(target.zod.safeParse(mutated).success, `${pathClass}: Zod rejected`).toBe(true);
    }
  });
});

/**
 * The pinned `$def` inventory. Every cross-chunk pointer is declared in the design; a chunk that
 * invented a synonym would still pass its own tests, which is why this is asserted centrally.
 */
const DEF_INVENTORY: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "primitives",
    [
      "sha256Digest",
      "safeInteger",
      "safeId",
      "pathSafeId",
      "taskSlug",
      "repositoryPathClaim",
      "phaseInstanceId",
      "gitOid",
      "taskPathClaim",
    ],
  ],
  [
    "durable-primitives",
    [
      "blobTreeMode",
      "blobIdentity",
      "outputEntry",
      "declaredInputRef",
      "canonicalTaskPaths",
      "snapshotAccounting",
      "snapshotAccountingEntry",
    ],
  ],
  [
    "task-state",
    [
      "stepStatus",
      "gateKind",
      "authoritativeResultRef",
      "approvalRef",
      "waiverRef",
      "openGateRef",
      "ruleSettlementConclusion",
      "ruleSettlement",
      "lastTransition",
      "plainJson",
    ],
  ],
];

/** Recursively collect every `$ref` string in a schema document. */
const collectRefs = (node: unknown, into: string[] = []): string[] => {
  if (Array.isArray(node)) for (const child of node) collectRefs(child, into);
  else if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node as JsonObject)) {
      if (key === "$ref" && typeof child === "string") into.push(child);
      else collectRefs(child, into);
    }
  }
  return into;
};

describe("the pinned $def inventory resolves", () => {
  it("every inventory $def exists in its named owner file with that exact name", () => {
    for (const [owner, defs] of DEF_INVENTORY) {
      const defsInFile = Object.keys((ALL_SCHEMAS.get(owner) as JsonObject).$defs as JsonObject);
      for (const def of defs) expect(defsInFile, `${owner} is missing ${def}`).toContain(def);
    }
    // The one whole-root inventory entry.
    expect((ALL_SCHEMAS.get("secret-scan-result") as JsonObject).$id).toBe(SCHEMA_IDS.secretScanResult);
  });

  /**
   * The committed files are generated, so the generation manifest is where a ref-layout rename
   * would originate: a def dropped or renamed there regenerates every `$ref` that reached it.
   * Pinning the manifest keeps the failure at the source instead of at a downstream resolver.
   */
  it("every inventory $def is declared by the generation manifest under that exact name", () => {
    const planned = new Map(
      SCHEMA_GENERATION_GROUPS.flatMap((group) => group.documents).map(
        (document) => [document.file, Object.keys(document.defs ?? {})] as const
      )
    );
    for (const [owner, defs] of DEF_INVENTORY) {
      const declared = planned.get(owner);
      expect(declared, `${owner} is not in the generation manifest`).toBeDefined();
      for (const def of defs) expect(declared, `${owner} manifest is missing ${def}`).toContain(def);
    }
  });

  it("every $ref in the pinned durable schemas resolves — Ajv raises no unresolved reference", () => {
    const everyOther = (stem: string): readonly string[] =>
      [...ALL_SCHEMAS.keys()].filter((other) => other !== stem);

    for (const stem of NEW_SCHEMA_STEMS) {
      expect(() => validator(stem, everyOther(stem)), stem).not.toThrow();
    }
  });

  it("every external $ref in the pinned durable schemas names a registered schema id", () => {
    const registered = new Set<string>(Object.values(SCHEMA_IDS));
    for (const stem of NEW_SCHEMA_STEMS) {
      const document = ALL_SCHEMAS.get(stem) as JsonObject;
      for (const ref of collectRefs(document)) {
        if (ref.startsWith("#/$defs/")) {
          expect(Object.keys(document.$defs as JsonObject), `${stem}: ${ref}`).toContain(
            ref.slice("#/$defs/".length)
          );
          continue;
        }
        const [id, pointer] = ref.split("#");
        expect(registered, `${stem}: ${ref} is not a registered schema id`).toContain(id);
        if (pointer !== undefined && pointer !== "") {
          expect(pointer.startsWith("/$defs/"), `${stem}: ${ref} is not a $defs pointer`).toBe(true);
        }
      }
    }
  });
});

describe("schema registry invariants", () => {
  it("SCHEMA_IDS holds 33 entries in exact bijection with the schema directory", () => {
    expect(Object.keys(SCHEMA_IDS)).toHaveLength(33);
    expect(new Set(Object.values(SCHEMA_IDS)).size).toBe(33);
    expect(schemaFileNames()).toHaveLength(33);

    const idsInFiles = [...ALL_SCHEMAS.values()].map((document) => document.$id as string).sort();
    expect(idsInFiles).toEqual([...Object.values(SCHEMA_IDS)].sort());
  });

  it("registers the pinned durable keys with the pinned urn ids and filenames", () => {
    const pinned = {
      durablePrimitives: "durable-primitives",
      taskState: "task-state",
      intentReceipt: "intent-receipt",
      taskInitialization: "task-initialization",
      legacyImportInitialization: "legacy-import-initialization",
      documentArtifact: "document-artifact",
      implementationOutput: "implementation-output",
    } as const;

    expect(Object.values(pinned).sort()).toEqual([...NEW_SCHEMA_STEMS].sort());
    for (const [key, stem] of Object.entries(pinned)) {
      expect(SCHEMA_IDS[key as keyof typeof SCHEMA_IDS]).toBe(`urn:archflow:schema:v1:${stem}`);
      expect((ALL_SCHEMAS.get(stem) as JsonObject).$id).toBe(SCHEMA_IDS[key as keyof typeof SCHEMA_IDS]);
    }
  });

  it("the barrel carries the durable roots after errors.js, with no duplicate export line", () => {
    const barrel = source("index.ts");
    const lines = barrel.split("\n");
    const starExports = lines
      .map((line) => /^export \* from "\.\/(?<module>[^"]+)";$/u.exec(line)?.groups?.module)
      .filter((module): module is string => module !== undefined);

    expect(new Set(starExports).size, "duplicate export * line in index.ts").toBe(starExports.length);

    const errorsAt = starExports.indexOf("errors.js");
    expect(errorsAt).toBeGreaterThanOrEqual(0);
    const expectedModules = NEW_MODULES
      .map((module) => module.replace(/\.ts$/u, ".js"))
      .toSpliced(7, 0, "durable-result-manifest.js", "durable-gate.js");
    expect(starExports.slice(errorsAt + 1, errorsAt + 1 + expectedModules.length)).toEqual(expectedModules);

    // `durable.ts` carries no schema; the two spliced modules carry their own registry rows.
    expect(expectedModules).toHaveLength(NEW_SCHEMA_STEMS.length + 3);
    for (const line of lines) expect(line.trim()).not.toBe('export * from "./durable.js"; export * from "./durable.js";');
  });
});

/**
 * D15, asserted negatively (verification step 14). A missing feature and an overlooked one are
 * indistinguishable at the review gate, so the absence is proved rather than assumed. The sweep is
 * structural — property names and file names — because both initialization schemas carry a
 * `$comment` that *states* the absence and would defeat a raw text match.
 */
describe("D15 — no re-pin, amendment, upgrade, or second config digest exists", () => {
  const FORBIDDEN = /re-?pin|amend|upgrade|migrat/iu;
  const ANNOTATIONS = new Set(["$comment", "title", "description"]);

  const propertyNames = (node: unknown, into: string[] = []): string[] => {
    if (Array.isArray(node)) for (const child of node) propertyNames(child, into);
    else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node as JsonObject)) {
        if (ANNOTATIONS.has(key)) continue;
        if (key === "properties" && child !== null && typeof child === "object") {
          into.push(...Object.keys(child as JsonObject));
        }
        propertyNames(child, into);
      }
    }
    return into;
  };

  /** Strip block and line comments so a comment stating the absence cannot satisfy the sweep. */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");

  it("no SCHEMA_IDS key or value names one", () => {
    for (const [key, id] of Object.entries(SCHEMA_IDS)) {
      expect(FORBIDDEN.test(key), `SCHEMA_IDS.${key}`).toBe(false);
      expect(FORBIDDEN.test(id), id).toBe(false);
    }
  });

  it("no file under schemas/v1/ names one", () => {
    for (const file of schemaFileNames()) expect(FORBIDDEN.test(file), file).toBe(false);
  });

  it("neither initialization schema declares such a property, or a second config digest", () => {
    for (const stem of ["task-initialization", "legacy-import-initialization"]) {
      const names = propertyNames(ALL_SCHEMAS.get(stem));
      expect(names.filter((name) => FORBIDDEN.test(name)), stem).toEqual([]);
      expect([...new Set(names.filter((name) => name.includes("config")))], stem).toEqual(["config_digest"]);
    }
  });

  it("neither initialization module declares such a field, or a second config digest", () => {
    for (const name of ["durable-task-initialization.ts", "durable-legacy-import.ts"]) {
      const text = stripComments(source(name));
      expect(FORBIDDEN.test(text), `${name} names a re-pin/amendment/upgrade construct`).toBe(false);
      const configFields = [...text.matchAll(/\b(?<field>[a-z_]*config[a-z_]*)\b/gu)].map(
        (match) => match.groups?.field
      );
      expect([...new Set(configFields)], name).toEqual(["config_digest"]);
    }
  });
});

/** Verification step 18 — the exclusions. */
describe("the phase's exclusions hold", () => {
  it("uses null only for PlainJson data and the explicit autonomous settlement match", () => {
    const nullNodes: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, `${at}/${index}`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node as JsonObject)) {
        if (key === "type" && (child === "null" || (Array.isArray(child) && child.includes("null")))) {
          nullNodes.push(`${at}/type`);
        }
        if (key === "const" && child === null) nullNodes.push(`${at}/const`);
        if (key === "enum" && Array.isArray(child) && child.includes(null)) nullNodes.push(`${at}/enum`);
        walk(child, `${at}/${key}`);
      }
    };
    for (const [stem, document] of ALL_SCHEMAS) walk(document, stem);
    // Optional durable fields still use omission. PlainJson permits null data, and the approved
    // autonomous settlement arm deliberately pins `match: null` to make the conclusion complete.
    expect(nullNodes).toEqual([
      "intent-receipt/$defs/plainJson/anyOf/0/type",
      "semantic-workflow/$defs/plainJson/anyOf/0/type",
      "task-state/$defs/ruleSettlementConclusion/oneOf/0/properties/match/type",
      "task-state/$defs/ruleSettlementConclusion/oneOf/0/properties/match/const",
      "task-state/$defs/plainJson/anyOf/0/type",
    ]);
  });

  it("no new module uses .nullable() or z.null", () => {
    for (const name of NEW_MODULES) {
      const text = source(name);
      expect(text, `${name} uses .nullable()`).not.toMatch(/\.nullable\s*\(/u);
      expect(text, `${name} uses z.null`).not.toMatch(/\bz\.null\b/u);
    }
  });

  it("no new module adds an error code beyond the five pinned ones", () => {
    const pinned = new Set([
      "STATE_INVALID",
      "SNAPSHOT_INVALID",
      "TASK_INVALID",
      "CONTRACT_INVALID",
      "INPUT_FINGERPRINT_MISMATCH",
    ]);
    for (const name of NEW_MODULES) {
      for (const match of source(name).matchAll(/"(?<code>[A-Z][A-Z_]{3,})"/gu)) {
        const code = match.groups?.code as string;
        if (!/_/u.test(code)) continue;
        expect(pinned, `${name} names error code ${code}`).toContain(code);
      }
    }
  });

  it("no module in src/contracts/ reaches node:fs, node:child_process, or src/repository/", () => {
    for (const name of readdirSync(SRC).filter((entry) => entry.endsWith(".ts"))) {
      const text = source(name);
      expect(text, `${name} imports node:fs`).not.toMatch(/from\s+"node:fs/u);
      expect(text, `${name} imports node:child_process`).not.toMatch(/from\s+"node:child_process"/u);
      expect(text, `${name} imports src/repository`).not.toMatch(/from\s+"[./]*(\.\.\/)?repository\//u);
    }
  });
});
