import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { documentArtifactV1Schema } from "../../src/contracts/durable-document.js";
import { implementationOutputV1Schema } from "../../src/contracts/durable-implementation-output.js";
import {
  manualCheckpointImportV1Schema,
  manualCheckpointV1Schema,
} from "../../src/contracts/durable-checkpoint.js";
import { legacyImportInitializationV1Schema } from "../../src/contracts/durable-legacy-import.js";
import { snapshotAccountingV1Schema } from "../../src/contracts/durable-primitives.js";
import { taskInitializationV1Schema } from "../../src/contracts/durable-task-initialization.js";
import documentArtifactSchema from "../../src/contracts/schemas/v1/document-artifact.schema.json" with { type: "json" };
import durablePrimitivesSchema from "../../src/contracts/schemas/v1/durable-primitives.schema.json" with { type: "json" };
import evidenceSlotsSchema from "../../src/contracts/schemas/v1/evidence-slots.schema.json" with { type: "json" };
import implementationOutputSchema from "../../src/contracts/schemas/v1/implementation-output.schema.json" with { type: "json" };
import legacyImportSchema from "../../src/contracts/schemas/v1/legacy-import-initialization.schema.json" with { type: "json" };
import maintenanceRecordSchema from "../../src/contracts/schemas/v1/maintenance-record.schema.json" with { type: "json" };
import manualCheckpointImportSchema from "../../src/contracts/schemas/v1/manual-checkpoint-import.schema.json" with { type: "json" };
import manualCheckpointSchema from "../../src/contracts/schemas/v1/manual-checkpoint.schema.json" with { type: "json" };
import pathClaimSchema from "../../src/contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import secretScanResultSchema from "../../src/contracts/schemas/v1/secret-scan-result.schema.json" with { type: "json" };
import taskInitializationSchema from "../../src/contracts/schemas/v1/task-initialization.schema.json" with { type: "json" };
import taskStateSchema from "../../src/contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import {
  assertZodAgreement,
  createJsonSchemaValidator,
  hasUniqueObjectPropertyValues,
  isSortedUniqueBy,
  tupleKey,
  type JsonSchemaValidator,
  type ZodLikeSchema,
} from "../../src/contracts/validators.js";
import { PIPELINE_STEPS } from "../../src/contracts/workflow.js";

/**
 * Chunk 11 — the STRUCTURAL half of the phase's adversarial corpus.
 *
 * The authority line: this file exercises only what the *schemas* reject at the parse boundary.
 * Every rejection below is produced by an Ajv validator or a Zod mirror on its own, so nothing here
 * imports `durable.ts` and nothing here calls `validateDurableSemantics`. What the *validator* must
 * reject — the invariant table, the total-order discriminators, the descriptor/throw matrix — is
 * chunk 12's, in `durable-semantics-corpus.test.ts`.
 *
 * That split is load-bearing for three rules the design deliberately made structural rather than
 * semantic, and this file is where the claim is proved: the byte caps as `maximum` (D16 preamble),
 * `stored_bytes === 0` for a `git-object` accounting entry as a discriminated union on `storage`
 * (D16), and intra-document set ordering and uniqueness via `x-archflow-sorted-unique` and
 * `x-archflow-sorted-unique-by` (D11). If any of these ever regressed into `validateDurableSemantics`
 * the cases below would fail here, because no validator runs in this file.
 *
 * Schemas are compiled directly from their JSON rather than through the registry: chunk 13 is the
 * sole writer of `versions.ts` and `schema-registry.test.ts`, and had not registered these seven
 * when this corpus was written.
 */

type JsonObject = Record<string, unknown>;

const json = <T>(value: unknown): T => structuredClone(value) as T;

const fixture = (name: string): JsonObject =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/contracts/durable/${name}.valid.json`, import.meta.url), "utf8")
  ) as JsonObject;

/**
 * A shape's two authorities plus its canonical sample. `zod` is absent for exactly the two purely
 * server-internal roots — `task-state` and `maintenance-record` — which have JSON Schema authority
 * and no mirror by design (D2). Nothing below invents one for them.
 */
type Shape = {
  readonly name: string;
  readonly json: JsonSchemaValidator<unknown>;
  readonly zod?: ZodLikeSchema<unknown>;
  readonly sample: JsonObject;
};

const validator = (schema: object, references: readonly object[]): JsonSchemaValidator<unknown> =>
  createJsonSchemaValidator<unknown>(json(schema), references.map((reference) => json(reference)));

const taskState: Shape = {
  name: "task-state",
  json: validator(taskStateSchema, [primitivesSchema, pathClaimSchema]),
  sample: fixture("task-state"),
};

const maintenanceRecord: Shape = {
  name: "maintenance-record",
  json: validator(maintenanceRecordSchema, [primitivesSchema, pathClaimSchema]),
  sample: fixture("maintenance-record"),
};

const taskInitialization: Shape = {
  name: "task-initialization",
  json: validator(taskInitializationSchema, [primitivesSchema, pathClaimSchema, durablePrimitivesSchema]),
  zod: taskInitializationV1Schema,
  sample: fixture("task-initialization"),
};

const legacyImport: Shape = {
  name: "legacy-import-initialization",
  json: validator(legacyImportSchema, [primitivesSchema, pathClaimSchema, durablePrimitivesSchema]),
  zod: legacyImportInitializationV1Schema,
  sample: fixture("legacy-import-initialization"),
};

const documentArtifact: Shape = {
  name: "document-artifact",
  json: validator(documentArtifactSchema, [primitivesSchema, pathClaimSchema, durablePrimitivesSchema]),
  zod: documentArtifactV1Schema,
  sample: fixture("document-artifact"),
};

const implementationOutput: Shape = {
  name: "implementation-output",
  json: validator(implementationOutputSchema, [
    primitivesSchema,
    pathClaimSchema,
    durablePrimitivesSchema,
    secretScanResultSchema,
  ]),
  zod: implementationOutputV1Schema,
  sample: fixture("implementation-output"),
};

/**
 * `snapshotAccounting` is a `$def`, never a standalone document, so it is reached through the same
 * one-line `$ref` wrapper `implementation-output.accounting` uses. Compiling it here also proves the
 * pointer in the pinned `$def` inventory resolves.
 */
const snapshotAccounting: Shape = {
  name: "snapshot-accounting",
  json: validator(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:archflow:schema:v1:test:durable-structural-corpus:snapshot-accounting",
      $ref: "urn:archflow:schema:v1:durable-primitives#/$defs/snapshotAccounting",
    },
    [primitivesSchema, pathClaimSchema, durablePrimitivesSchema]
  ),
  zod: snapshotAccountingV1Schema,
  sample: json<JsonObject>(fixture("implementation-output").accounting),
};

const checkpointReferences = [
  primitivesSchema,
  pathClaimSchema,
  durablePrimitivesSchema,
  taskStateSchema,
  taskInitializationSchema,
  legacyImportSchema,
  evidenceSlotsSchema,
];

const manualCheckpoint: Shape = {
  name: "manual-checkpoint",
  json: validator(manualCheckpointSchema, checkpointReferences),
  zod: manualCheckpointV1Schema,
  sample: fixture("manual-checkpoint"),
};

const manualCheckpointImport: Shape = {
  name: "manual-checkpoint-import",
  json: validator(manualCheckpointImportSchema, [...checkpointReferences, manualCheckpointSchema]),
  zod: manualCheckpointImportV1Schema,
  sample: fixture("manual-checkpoint-import"),
};

const continuationImportSample = fixture("manual-checkpoint-import-continuation");
const manualCheckpointContinuation: Shape = {
  name: "manual-checkpoint-continuation",
  json: validator(manualCheckpointSchema, checkpointReferences),
  zod: manualCheckpointV1Schema,
  sample: json<JsonObject>((continuationImportSample.chain as readonly unknown[])[0]),
};

const manualCheckpointImportContinuation: Shape = {
  name: "manual-checkpoint-import-continuation",
  json: validator(manualCheckpointImportSchema, [...checkpointReferences, manualCheckpointSchema]),
  zod: manualCheckpointImportV1Schema,
  sample: continuationImportSample,
};

const SHAPES: readonly Shape[] = [
  taskState,
  maintenanceRecord,
  taskInitialization,
  legacyImport,
  documentArtifact,
  implementationOutput,
  snapshotAccounting,
  manualCheckpoint,
  manualCheckpointImport,
  manualCheckpointContinuation,
  manualCheckpointImportContinuation,
];

const shapeByName = new Map(SHAPES.map((shape) => [shape.name, shape]));
const shape = (name: string): Shape => {
  const found = shapeByName.get(name);
  if (found === undefined) throw new Error(`unknown shape ${name}`);
  return found;
};

/**
 * Rejection means *both* authorities reject. Where a mirror exists the check runs through
 * `assertZodAgreement`, which is what proves the Ajv keyword and the Zod `.refine()` really call the
 * same `isSortedUniqueBy` / `tupleKey`: a one-sided rejection throws "…validators disagree" instead
 * of "…schema validation failed", and the regex below distinguishes the two.
 */
const rejects = (target: Shape, value: unknown, label = "value"): void => {
  expect(target.json.validate(value), `${target.name}/${label}: JSON Schema accepted`).toBe(false);
  const mirror = target.zod;
  if (mirror === undefined) return;
  expect(mirror.safeParse(value).success, `${target.name}/${label}: Zod accepted`).toBe(false);
  expect(() => assertZodAgreement(value, target.json, mirror, `${target.name}/${label}`)).toThrowError(
    /schema validation failed/
  );
};

const accepts = (target: Shape, value: unknown, label = "value"): void => {
  expect(target.json.validate(value), `${target.name}/${label}: JSON Schema rejected`).toBe(true);
  if (target.zod !== undefined) assertZodAgreement(value, target.json, target.zod, `${target.name}/${label}`);
};

/** Replace the value at a dotted path (array indices are numeric segments) on a deep clone. */
const at = (root: JsonObject, path: string, next: (current: unknown) => unknown): JsonObject => {
  const copy = structuredClone(root);
  const segments = path.split(".");
  let cursor = copy as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
  const leaf = segments[segments.length - 1] as string;
  cursor[leaf] = next(cursor[leaf]);
  return copy;
};

/** Delete the property at a dotted path on a deep clone. */
const without = (root: JsonObject, path: string): JsonObject => {
  const copy = structuredClone(root);
  const segments = path.split(".");
  let cursor = copy as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
  delete cursor[segments[segments.length - 1] as string];
  return copy;
};

const items = (value: unknown): readonly unknown[] => value as readonly unknown[];
const shuffled = (value: unknown): unknown => [...items(value)].reverse();
const withDuplicate = (value: unknown): unknown => [items(value)[0], ...items(value)];

// ---------------------------------------------------------------------------------------------
// 1. Set ordering and duplicates
// ---------------------------------------------------------------------------------------------

/**
 * `task-state.waivers` ships with one element, and a one-element array cannot be shuffled into an
 * unsorted permutation. A second waiver is added in sorted order so the permutation case has
 * something to permute; the duplicate case would work either way.
 */
const taskStateTwoWaivers: JsonObject = at(taskState.sample, "waivers", (value) => [
  {
    gate_id: "gate-impl-1-commit",
    rule_id: "constitution:no-vendored-code",
    rule_version: 1,
    subject_digest: "b".repeat(64),
    granted: true,
    expires: "task-complete",
    granted_at_revision: 4,
  },
  ...items(value),
]);

/**
 * Every declared set in the phase, with the shape whose fixture carries it. This list is asserted
 * below to be exactly the set of arrays the seven schemas declare — the design is explicit that
 * after the Phase 8 split *there is no sequence in this phase*, so an array missing from this table
 * is either an unordered collection that should not exist or a set nobody is testing.
 */
const DECLARED_SETS: readonly { readonly shape: string; readonly path: string; readonly base?: JsonObject }[] = [
  { shape: "task-state", path: "authoritative_results" },
  { shape: "task-state", path: "approvals" },
  { shape: "task-state", path: "waivers", base: taskStateTwoWaivers },
  { shape: "maintenance-record", path: "deletions" },
  { shape: "legacy-import-initialization", path: "mapping" },
  { shape: "legacy-import-initialization", path: "staged_payload_refs" },
  { shape: "document-artifact", path: "declared_inputs" },
  { shape: "implementation-output", path: "outputs" },
  { shape: "implementation-output", path: "parent_documents" },
  { shape: "implementation-output", path: "restore_targets" },
  { shape: "implementation-output", path: "declared_inputs" },
  { shape: "implementation-output", path: "undeclared_changes.undeclared_paths" },
  { shape: "snapshot-accounting", path: "counted_entries" },
  { shape: "manual-checkpoint", path: "authoritative_results" },
  { shape: "manual-checkpoint", path: "projections" },
  { shape: "manual-checkpoint", path: "evidence_chain" },
  { shape: "manual-checkpoint", path: "approvals" },
  { shape: "manual-checkpoint", path: "waivers" },
];

describe("durable set ordering and uniqueness are structural", () => {
  for (const declared of DECLARED_SETS) {
    const target = shape(declared.shape);
    const base = declared.base ?? target.sample;

    it(`${declared.shape}.${declared.path} accepts the canonical order`, () => {
      accepts(target, base, `${declared.path} canonical`);
    });

    it(`${declared.shape}.${declared.path} rejects a shuffled permutation`, () => {
      const permuted = at(base, declared.path, shuffled);
      // A one-element set cannot be permuted; every set below is seeded with at least two members.
      expect(permuted).not.toStrictEqual(base);
      rejects(target, permuted, `${declared.path} shuffled`);
    });

    it(`${declared.shape}.${declared.path} rejects a duplicated key`, () => {
      rejects(target, at(base, declared.path, withDuplicate), `${declared.path} duplicated`);
    });
  }
});

/**
 * The sweep. Every array-shaped subschema in the nine schemas must carry an ordering keyword, and
 * the set of them must be exactly the nineteen collections above — nothing exempt, nothing untested.
 */
const SCHEMA_FILES: readonly { readonly name: string; readonly schema: object }[] = [
  { name: "durable-primitives", schema: durablePrimitivesSchema },
  { name: "task-state", schema: taskStateSchema },
  { name: "maintenance-record", schema: maintenanceRecordSchema },
  { name: "task-initialization", schema: taskInitializationSchema },
  { name: "legacy-import-initialization", schema: legacyImportSchema },
  { name: "document-artifact", schema: documentArtifactSchema },
  { name: "implementation-output", schema: implementationOutputSchema },
  { name: "manual-checkpoint", schema: manualCheckpointSchema },
  { name: "manual-checkpoint-import", schema: manualCheckpointImportSchema },
];

const collectArraySubschemas = (): readonly { readonly location: string; readonly keywords: readonly string[] }[] => {
  const found: { location: string; keywords: readonly string[] }[] = [];
  const walk = (node: unknown, location: string): void => {
    if (Array.isArray(node)) {
      node.forEach((element, index) => walk(element, `${location}/${index}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as JsonObject;
    if (record.type === "array" || "items" in record || "prefixItems" in record || "minItems" in record) {
      found.push({
        location,
        keywords: [
          "x-archflow-sorted-unique",
          "x-archflow-sorted-unique-by",
          "x-archflow-unique-by",
        ].filter((keyword) => keyword in record),
      });
    }
    for (const [key, value] of Object.entries(record)) walk(value, `${location}/${key}`);
  };
  for (const file of SCHEMA_FILES) walk(file.schema, file.name);
  return found;
};

describe("no array in this phase is exempt from set ordering", () => {
  it("every array-shaped subschema carries an ordering keyword", () => {
    const exempt = collectArraySubschemas().filter((entry) => entry.keywords.length === 0);
    expect(exempt.map((entry) => entry.location)).toStrictEqual([]);
  });

  it("the arrays the schemas declare are exactly the nineteen collections under test", () => {
    expect(collectArraySubschemas().map((entry) => entry.location).sort()).toStrictEqual(
      [
        "durable-primitives/$defs/snapshotAccounting/properties/counted_entries",
        "document-artifact/properties/declared_inputs",
        "implementation-output/$defs/undeclaredChangeReport/properties/undeclared_paths",
        "implementation-output/properties/declared_inputs",
        "implementation-output/properties/outputs",
        "implementation-output/properties/parent_documents",
        "implementation-output/properties/restore_targets",
        "legacy-import-initialization/properties/mapping",
        "legacy-import-initialization/properties/staged_payload_refs",
        "manual-checkpoint-import/properties/chain",
        "manual-checkpoint/properties/approvals",
        "manual-checkpoint/properties/authoritative_results",
        "manual-checkpoint/properties/evidence_chain",
        "manual-checkpoint/properties/projections",
        "manual-checkpoint/properties/waivers",
        "maintenance-record/properties/deletions",
        "task-state/properties/approvals",
        "task-state/properties/authoritative_results",
        "task-state/properties/waivers",
      ].sort()
    );
    // `chain` is uniqueness-only: its order is semantic, so schemas accept a shuffle.
    expect(DECLARED_SETS).toHaveLength(collectArraySubschemas().length - 1);
  });
});

describe("checkpoint chain revision uniqueness is structural but order is semantic", () => {
  it("pins why tupleKey string ordering cannot order numeric revisions", () => {
    expect(isSortedUniqueBy([{ revision: 9 }, { revision: 10 }], tupleKey("revision"))).toBe(false);

    const nineToTen = at(
      at(
        at(
          at(
            at(
              at(manualCheckpointImportContinuation.sample, "chain.0.revision", () => 9),
              "chain.0.predecessor.revision",
              () => 8
            ),
            "chain.1.revision",
            () => 10
          ),
          "chain.1.predecessor.revision",
          () => 9
        ),
        "predecessor.revision",
        () => 8
      ),
      "expected_state_revision",
      () => 8
    );
    accepts(manualCheckpointImportContinuation, nineToTen, "numeric revision chain 9 to 10");
  });

  it("accepts a shuffled chain through both schema authorities", () => {
    accepts(manualCheckpointImport, at(manualCheckpointImport.sample, "chain", shuffled), "chain shuffled");
  });

  it("rejects a duplicated revision through both schema authorities", () => {
    rejects(manualCheckpointImport, at(manualCheckpointImport.sample, "chain", withDuplicate), "chain duplicated");
  });

  // Chunk 7 owns the complementary assertion that the semantic validator rejects the shuffle.
});

describe("unique object keys are enumerable data properties", () => {
  it("distinguishes absent keys from accessors and non-enumerable data properties", () => {
    const enumerable = [{ revision: 1 }, { revision: 2 }];
    const accessor = Object.defineProperty({}, "revision", {
      enumerable: true,
      get: () => { throw new Error("accessor must not be read"); },
    });
    const hidden = Object.defineProperty({}, "revision", { value: 2, enumerable: false });

    expect(hasUniqueObjectPropertyValues("revision", enumerable)).toBe(true);
    expect(hasUniqueObjectPropertyValues("revision", [{ revision: 1 }, {}])).toBe(true);
    expect(hasUniqueObjectPropertyValues("revision", [{}, {}])).toBe(false);
    expect(hasUniqueObjectPropertyValues("revision", [{ revision: 1 }, accessor])).toBe(false);
    expect(hasUniqueObjectPropertyValues("revision", [{ revision: 1 }, hidden])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The multi-key tuple order is the pinned one
// ---------------------------------------------------------------------------------------------

/**
 * `authoritative_results` sorts by the tuple `(phase_instance, step)`. The join is `U+0000`, not the
 * `":"` that `validators.ts`'s older `ruleKey` uses, precisely because `SafeId` admits `":"` and a
 * `":"`-joined key can collide across a component boundary. The pair below is the witness: under the
 * pinned join `phase-design-1` precedes `phase-design-11`, and under a `":"` join the order inverts,
 * because `":"` (U+003A) sorts *above* `"1"` (U+0031) while `U+0000` sorts below everything.
 */
const resultRef = (phaseInstance: string, step: string, fill: string): JsonObject => ({
  phase_instance: phaseInstance,
  step,
  result_digest: fill.repeat(64),
  result_id: `${phaseInstance}:${step}:1`,
  input_fingerprint: fill.repeat(64),
  manifest_path: `.archflow/tasks/mcp-integration/results/${phaseInstance}-${step}/manifest.json`,
});

const tupleOrderedPair = [resultRef("phase-design-1", "produce", "1"), resultRef("phase-design-11", "produce", "2")];

describe("the authoritative_results tuple key is the pinned U+0000 join", () => {
  it("the witness pair orders differently under a ':' join", () => {
    expect("phase-design-1\u0000produce" < "phase-design-11\u0000produce").toBe(true);
    expect("phase-design-1:produce" < "phase-design-11:produce").toBe(false);
  });

  it("accepts the pair in U+0000-joined order", () => {
    accepts(taskState, at(taskState.sample, "authoritative_results", () => tupleOrderedPair), "tuple order");
    expect(isSortedUniqueBy(tupleOrderedPair, tupleKey(["phase_instance", "step"]))).toBe(true);
  });

  it("rejects the pair in the order a ':' join would call sorted", () => {
    const inverted = [...tupleOrderedPair].reverse();
    expect(isSortedUniqueBy(inverted, tupleKey(["phase_instance", "step"]))).toBe(false);
    rejects(taskState, at(taskState.sample, "authoritative_results", () => inverted), "':' order");
  });

  it("orders on the full tuple, not on phase_instance alone", () => {
    const sameInstance = [
      resultRef("phase-impl-1", "counter_review", "3"),
      resultRef("phase-impl-1", "produce", "4"),
    ];
    accepts(taskState, at(taskState.sample, "authoritative_results", () => sameInstance), "second component");
    rejects(
      taskState,
      at(taskState.sample, "authoritative_results", () => [...sameInstance].reverse()),
      "second component reversed"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Byte caps and the D16 structural zero-byte rule
// ---------------------------------------------------------------------------------------------

describe("byte accounting is bound structurally, not by the validator", () => {
  it("accepts both caps at their exact value", () => {
    const atCap = at(at(snapshotAccounting.sample, "result_bytes", () => 26_214_400), "task_bytes", () => 262_144_000);
    accepts(snapshotAccounting, atCap, "at cap");
  });

  it("rejects result_bytes above 26214400", () => {
    rejects(snapshotAccounting, at(snapshotAccounting.sample, "result_bytes", () => 26_214_401), "result_bytes");
  });

  it("rejects task_bytes above 262144000", () => {
    rejects(snapshotAccounting, at(snapshotAccounting.sample, "task_bytes", () => 262_144_001), "task_bytes");
  });

  it("rejects a git-object accounting entry with non-zero stored_bytes (D16)", () => {
    const entries = items(snapshotAccounting.sample.counted_entries) as readonly JsonObject[];
    const gitObjectIndex = entries.findIndex((entry) => entry.storage === "git-object");
    expect(gitObjectIndex).toBeGreaterThanOrEqual(0);
    rejects(
      snapshotAccounting,
      at(snapshotAccounting.sample, `counted_entries.${gitObjectIndex}.stored_bytes`, () => 1),
      "git-object stored_bytes"
    );
  });

  it("accepts a raw-payload accounting entry with non-zero stored_bytes", () => {
    const entries = items(snapshotAccounting.sample.counted_entries) as readonly JsonObject[];
    const rawIndex = entries.findIndex((entry) => entry.storage === "raw-payload");
    expect(rawIndex).toBeGreaterThanOrEqual(0);
    accepts(
      snapshotAccounting,
      at(snapshotAccounting.sample, `counted_entries.${rawIndex}.stored_bytes`, () => 4096),
      "raw-payload stored_bytes"
    );
  });

  it("rejects the same three cases when the accounting is embedded in an implementation output", () => {
    rejects(
      implementationOutput,
      at(implementationOutput.sample, "accounting.result_bytes", () => 26_214_401),
      "embedded result_bytes"
    );
    rejects(
      implementationOutput,
      at(implementationOutput.sample, "accounting.task_bytes", () => 262_144_001),
      "embedded task_bytes"
    );
    rejects(
      implementationOutput,
      at(implementationOutput.sample, "accounting.counted_entries.1.stored_bytes", () => 1),
      "embedded git-object stored_bytes"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Every `>= 1` field rejects 0 (D8)
// ---------------------------------------------------------------------------------------------

/**
 * `SafeInteger` admits `0` (`primitives.schema.json#/$defs/safeInteger` has `"minimum": 0`), so each
 * positive count pins its own minimum at the field and must not `$ref` it. Fourteen fields do.
 */
const POSITIVE_FIELDS: readonly { readonly shape: string; readonly path: string }[] = [
  { shape: "task-state", path: "revision" },
  { shape: "task-state", path: "attempt" },
  { shape: "task-state", path: "approvals.0.resolved_at_revision" },
  { shape: "task-state", path: "open_gate.opened_at_revision" },
  { shape: "task-state", path: "waivers.0.rule_version" },
  { shape: "task-state", path: "waivers.0.granted_at_revision" },
  { shape: "task-state", path: "prepared_intent.prior_revision" },
  { shape: "maintenance-record", path: "performed_at_revision" },
  { shape: "snapshot-accounting", path: "measured_at_revision" },
  { shape: "task-state", path: "adopted_checkpoint.revision" },
  { shape: "manual-checkpoint", path: "revision" },
  { shape: "manual-checkpoint", path: "attempt" },
  { shape: "manual-checkpoint-continuation", path: "predecessor.revision" },
  { shape: "manual-checkpoint-import-continuation", path: "expected_state_revision" },
];

describe("every >= 1 field rejects 0 (D8)", () => {
  it("pins the fourteen positive-field routes and eleven exercised shapes", () => {
    expect(POSITIVE_FIELDS).toHaveLength(14);
    expect(SHAPES).toHaveLength(11);
  });

  for (const field of POSITIVE_FIELDS) {
    it(`${field.shape}.${field.path} rejects 0 and accepts 1`, () => {
      const target = shape(field.shape);
      rejects(target, at(target.sample, field.path, () => 0), field.path);
      accepts(target, at(target.sample, field.path, () => 1), field.path);
    });
  }

  it("a field that genuinely admits 0 still does", () => {
    accepts(documentArtifact, at(documentArtifact.sample, "byte_count", () => 0), "byte_count");
    accepts(
      implementationOutput,
      at(implementationOutput.sample, "undeclared_changes.unrepresentable_count", () => 0),
      "unrepresentable_count"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Unknown fields
// ---------------------------------------------------------------------------------------------

describe("unknown fields are rejected on every shape", () => {
  for (const target of SHAPES) {
    it(`${target.name} rejects an unknown root property`, () => {
      rejects(target, at(target.sample, "unexpected_property", () => "x"), "unknown root property");
    });
  }

  it("nested objects are closed too", () => {
    rejects(
      implementationOutput,
      at(implementationOutput.sample, "parent_documents.0.unexpected_property", () => "x"),
      "unknown nested property"
    );
    rejects(taskState, at(taskState.sample, "open_gate.unexpected_property", () => "x"), "unknown nested property");
    rejects(
      taskInitialization,
      at(taskInitialization.sample, "canonical_paths.unexpected_property", () => "x"),
      "unknown nested property"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 6. `step` (D19)
// ---------------------------------------------------------------------------------------------

describe("both artifact roots carry step in every authority (D19)", () => {
  for (const target of [documentArtifact, implementationOutput]) {
    it(`${target.name} rejects an omitted step`, () => {
      rejects(target, without(target.sample, "step"), "omitted step");
    });

    it(`${target.name} rejects a sixth step value`, () => {
      rejects(target, at(target.sample, "step", () => "verify"), "sixth step");
    });

    it(`${target.name} accepts every PIPELINE_STEPS member`, () => {
      for (const step of PIPELINE_STEPS) accepts(target, at(target.sample, "step", () => step), `step=${step}`);
    });
  }

  it("the JSON Schema enum members are exactly PIPELINE_STEPS", () => {
    for (const schema of [documentArtifactSchema, implementationOutputSchema]) {
      const properties = (schema as unknown as JsonObject).properties as JsonObject;
      expect((properties.step as JsonObject).enum).toStrictEqual([...PIPELINE_STEPS]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 7. `null` is never a value
// ---------------------------------------------------------------------------------------------

const schemaDirectory = new URL("../../src/contracts/schemas/v1/", import.meta.url);
const moduleDirectory = new URL("../../src/contracts/", import.meta.url);

/** `$comment` prose legitimately mentions the word; the rule is about declared JSON, not English. */
const stripComments = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(stripComments);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as JsonObject)
      .filter(([key]) => key !== "$comment" && key !== "title" && key !== "description")
      .map(([key, value]) => [key, stripComments(value)])
  );
};

describe("absence is omission, never null", () => {
  it("no schema in schemas/v1 declares null anywhere outside prose", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(schemaDirectory).filter((name) => name.endsWith(".schema.json"))) {
      const parsed = JSON.parse(readFileSync(new URL(file, schemaDirectory), "utf8")) as unknown;
      if (JSON.stringify(stripComments(parsed)).includes('"null"')) offenders.push(file);
      const walk = (node: unknown, location: string): void => {
        if (Array.isArray(node)) {
          node.forEach((element, index) => walk(element, `${location}/${index}`));
          return;
        }
        if (node === null || typeof node !== "object") return;
        const record = node as JsonObject;
        const type = record.type;
        if (type === "null" || (Array.isArray(type) && type.includes("null"))) offenders.push(`${file}${location}/type`);
        if ("const" in record && record.const === null) offenders.push(`${file}${location}/const`);
        if (Array.isArray(record.enum) && record.enum.includes(null)) offenders.push(`${file}${location}/enum`);
        for (const [key, value] of Object.entries(record)) walk(value, `${location}/${key}`);
      };
      walk(parsed, "");
    }
    expect(offenders).toStrictEqual([]);
  });

  it("no durable-* module uses .nullable() or z.null", () => {
    const modules = readdirSync(moduleDirectory).filter(
      (name) => name.startsWith("durable-") && name.endsWith(".ts")
    );
    expect(modules.length).toBeGreaterThanOrEqual(7);
    const offenders = modules.filter((name) => {
      const source = readFileSync(new URL(name, moduleDirectory), "utf8");
      return source.includes(".nullable(") || source.includes("z.null");
    });
    expect(offenders).toStrictEqual([]);
  });

  it("supplying null for an optional field is rejected", () => {
    for (const path of ["open_gate", "prepared_intent", "terminal"]) {
      accepts(taskState, without(taskState.sample, path), `${path} omitted`);
      rejects(taskState, at(taskState.sample, path, () => null), `${path} null`);
    }
    accepts(
      implementationOutput,
      without(implementationOutput.sample, "constitution_edit_gate_id"),
      "constitution_edit_gate_id omitted"
    );
    rejects(
      implementationOutput,
      at(implementationOutput.sample, "constitution_edit_gate_id", () => null),
      "constitution_edit_gate_id null"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Shape-specific structural pins
// ---------------------------------------------------------------------------------------------

describe("shape-specific structural pins", () => {
  it("manual-checkpoint enforces the initialization and continuation branches", () => {
    const initialWithPredecessor = at(manualCheckpoint.sample, "predecessor", () => ({
      revision: 1,
      checkpoint_digest: "a".repeat(64),
    }));
    rejects(manualCheckpoint, initialWithPredecessor, "revision 1 with predecessor");
    rejects(manualCheckpoint, without(manualCheckpoint.sample, "initialization"), "revision 1 without initialization");
    rejects(
      manualCheckpointContinuation,
      at(manualCheckpointContinuation.sample, "initialization", () => manualCheckpoint.sample.initialization),
      "revision 2+ with initialization"
    );
    rejects(
      manualCheckpointContinuation,
      without(manualCheckpointContinuation.sample, "predecessor"),
      "revision 2+ without predecessor"
    );
    rejects(manualCheckpoint, at(manualCheckpoint.sample, "revision", () => 0), "revision 0");
    rejects(
      manualCheckpointContinuation,
      at(manualCheckpointContinuation.sample, "revision", () => 1),
      "continuation revision 1"
    );
  });

  it("manual-checkpoint-import forbids every continuation field individually in initial mode", () => {
    const fields: readonly [string, unknown][] = [
      ["predecessor", continuationImportSample.predecessor],
      ["expected_state_revision", continuationImportSample.expected_state_revision],
      ["expected_state_digest", continuationImportSample.expected_state_digest],
    ];
    for (const [field, value] of fields) {
      rejects(manualCheckpointImport, at(manualCheckpointImport.sample, field, () => value), `${field} in initial`);
    }
  });

  it("manual-checkpoint-import requires every continuation field individually", () => {
    for (const field of ["predecessor", "expected_state_revision", "expected_state_digest"]) {
      rejects(
        manualCheckpointImportContinuation,
        without(manualCheckpointImportContinuation.sample, field),
        `${field} missing in continuation`
      );
    }
    rejects(manualCheckpointImport, at(manualCheckpointImport.sample, "chain", () => []), "empty chain");
  });

  it("manual-checkpoint owned definitions are closed", () => {
    for (const path of ["projections.0", "evidence_chain.0", "evidence_chain.0.current_evidence"]) {
      rejects(manualCheckpoint, at(manualCheckpoint.sample, `${path}.unexpected_property`, () => "x"), path);
    }
    rejects(
      manualCheckpointContinuation,
      at(manualCheckpointContinuation.sample, "predecessor.unexpected_property", () => "x"),
      "predecessor"
    );
  });

  it("legacy-import mapping never carries disposition 'approved'", () => {
    for (const disposition of ["draft", "historical"]) {
      accepts(legacyImport, at(legacyImport.sample, "mapping.0.disposition", () => disposition), disposition);
    }
    rejects(legacyImport, at(legacyImport.sample, "mapping.0.disposition", () => "approved"), "approved");
  });

  it("document-artifact path_class is the const 'document'", () => {
    for (const pathClass of ["review", "import", "repository-source", "task-state"]) {
      rejects(documentArtifact, at(documentArtifact.sample, "path_class", () => pathClass), pathClass);
    }
    accepts(documentArtifact, at(documentArtifact.sample, "path_class", () => "document"), "document");
  });

  it("parent_documents role is one of exactly four", () => {
    for (const role of ["prd", "design", "phase-design", "impl-notes"]) {
      accepts(implementationOutput, at(implementationOutput.sample, "parent_documents.0.role", () => role), role);
    }
    for (const role of ["architecture", "document", "review"]) {
      rejects(implementationOutput, at(implementationOutput.sample, "parent_documents.0.role", () => role), role);
    }
  });

  it("open_gate is a single object, never an array", () => {
    rejects(taskState, at(taskState.sample, "open_gate", (value) => [value]), "open_gate array");
    rejects(taskState, at(taskState.sample, "open_gate", (value) => [value, value]), "nested gates");
  });

  it("deletions is non-empty", () => {
    rejects(maintenanceRecord, at(maintenanceRecord.sample, "deletions", () => []), "empty deletions");
  });

  it("outputs is non-empty", () => {
    rejects(implementationOutput, at(implementationOutput.sample, "outputs", () => []), "empty outputs");
  });

  it("human_reason is bounded at both ends", () => {
    const bounded = (text: string): JsonObject => at(maintenanceRecord.sample, "human_reason", () => text);
    rejects(maintenanceRecord, bounded(""), "empty human_reason");
    accepts(maintenanceRecord, bounded("a"), "one-byte human_reason");
    accepts(maintenanceRecord, bounded("a".repeat(4096)), "human_reason at 4096 bytes");
    rejects(maintenanceRecord, bounded("a".repeat(4097)), "human_reason at 4097 bytes");
    // The cap is UTF-8 *bytes*, not code units: 2049 two-byte characters is 4098 bytes in 2049 chars.
    const multiByte = "é".repeat(2049);
    expect(Buffer.byteLength(multiByte, "utf8")).toBe(4098);
    expect(multiByte.length).toBe(2049);
    rejects(maintenanceRecord, bounded(multiByte), "human_reason above 4096 UTF-8 bytes");
  });

  it("an implementation output cannot claim a server-owned path class", () => {
    for (const pathClass of ["task-state", "result-manifest", "intent", "decision"]) {
      rejects(
        implementationOutput,
        at(implementationOutput.sample, "outputs.0.path_class", () => pathClass),
        `path_class=${pathClass}`
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Permutation fixtures
// ---------------------------------------------------------------------------------------------

describe("every canonical fixture is accepted and every shuffled-set variant is not", () => {
  for (const target of SHAPES) {
    it(`${target.name} round-trips its canonical sample`, () => {
      accepts(target, target.sample, "canonical");
    });

    it(`${target.name} rejects each of its shuffled-set variants`, () => {
      // `task-initialization` declares no array, so its list is empty by design; the assertion at
      // the end of this block is what pins that rather than letting it pass vacuously here.
      const sets = DECLARED_SETS.filter((declared) => declared.shape === target.name);
      for (const declared of sets) {
        const base = declared.base ?? target.sample;
        rejects(target, at(base, declared.path, shuffled), `${declared.path} shuffled`);
      }
    });
  }

  it("the two initialization shapes declare the only sets they can", () => {
    // `task-initialization` declares no array at all, so it has no permutation variant. Asserted
    // rather than left implicit: a later phase adding a collection there must add its ordering rule.
    expect(DECLARED_SETS.filter((declared) => declared.shape === "task-initialization")).toStrictEqual([]);
    expect(DECLARED_SETS.filter((declared) => declared.shape === "legacy-import-initialization")).toHaveLength(2);
  });
});
