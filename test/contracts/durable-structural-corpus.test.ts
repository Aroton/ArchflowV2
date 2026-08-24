import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { documentArtifactV1Schema } from "../../src/contracts/durable-document.js";
import { implementationOutputV1Schema } from "../../src/contracts/durable-implementation-output.js";
import { legacyImportInitializationV1Schema } from "../../src/contracts/durable-legacy-import.js";
import { snapshotAccountingV1Schema } from "../../src/contracts/durable-primitives.js";
import { taskStateV1Schema } from "../../src/contracts/durable-state.js";
import { taskInitializationV1Schema } from "../../src/contracts/durable-task-initialization.js";
import documentArtifactSchema from "../../src/contracts/schemas/v1/document-artifact.schema.json" with { type: "json" };
import durablePrimitivesSchema from "../../src/contracts/schemas/v1/durable-primitives.schema.json" with { type: "json" };
import implementationOutputSchema from "../../src/contracts/schemas/v1/implementation-output.schema.json" with { type: "json" };
import legacyImportSchema from "../../src/contracts/schemas/v1/legacy-import-initialization.schema.json" with { type: "json" };
import pathClaimSchema from "../../src/contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import secretScanResultSchema from "../../src/contracts/schemas/v1/secret-scan-result.schema.json" with { type: "json" };
import taskInitializationSchema from "../../src/contracts/schemas/v1/task-initialization.schema.json" with { type: "json" };
import taskStateSchema from "../../src/contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import {
  hasUniqueObjectPropertyValues,
  isSortedUniqueBy,
  tupleKey,
} from "../../src/contracts/validators.js";
import {
  createJsonSchemaValidator,
  type JsonSchemaValidator,
  type ZodLikeSchema,
} from "../helpers/json-schema.js";
import { PIPELINE_STEPS } from "../../src/contracts/workflow.js";

/**
 * Chunk 11 — the STRUCTURAL half of the phase's adversarial corpus.
 *
 * The authority line: this file exercises only what is rejected at the parse boundary. Every
 * rejection below is produced by the Zod shape authority on its own, so nothing here imports
 * `durable.ts` and nothing here calls `validateDurableSemantics`. What the *validator* must
 * reject — the invariant table, the total-order discriminators, the descriptor/throw matrix — is
 * chunk 12's, in `durable-semantics-corpus.test.ts`.
 *
 * That split is load-bearing for three rules the design deliberately made structural rather than
 * semantic, and this file is where the claim is proved: the byte caps as `maximum` (D16 preamble),
 * `stored_bytes === 0` for a `git-object` accounting entry as a discriminated union on `storage`
 * (D16), and intra-document set ordering and uniqueness via the shared `isSortedUniqueBy` /
 * `tupleKey` refinements in the Zod authority (D11). Generation retired the `x-archflow-sorted-*`
 * keywords from the committed schemas, so the ordering half is proven against the Zod parse
 * boundary alone; if any of these ever regressed into `validateDurableSemantics` the cases below
 * would fail here, because no semantic validator runs in this file.
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
 * A shape's Zod authority and its committed generated document, plus its canonical sample. The
 * compiled document is exercised only as a third-party consumer: it must accept what the authority
 * accepts, and the `rejectsInZodAuthority` pins record where the published document is
 * deliberately weaker because generation retired a keyword.
 */
type Shape = {
  readonly name: string;
  readonly json: JsonSchemaValidator<unknown>;
  readonly zod: ZodLikeSchema<unknown>;
  readonly sample: JsonObject;
};

const validator = (schema: object, references: readonly object[]): JsonSchemaValidator<unknown> =>
  createJsonSchemaValidator<unknown>(json(schema), references.map((reference) => json(reference)));

const taskState: Shape = {
  name: "task-state",
  json: validator(taskStateSchema, [primitivesSchema, pathClaimSchema]),
  zod: taskStateV1Schema,
  sample: fixture("task-state"),
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

const SHAPES: readonly Shape[] = [
  taskState,
  taskInitialization,
  legacyImport,
  documentArtifact,
  implementationOutput,
  snapshotAccounting,
];

const shapeByName = new Map(SHAPES.map((shape) => [shape.name, shape]));
const shape = (name: string): Shape => {
  const found = shapeByName.get(name);
  if (found === undefined) throw new Error(`unknown shape ${name}`);
  return found;
};

/** Rejection by the Zod shape authority — the only validator production code runs. */
const rejects = (target: Shape, value: unknown, label = "value"): void => {
  expect(target.zod.safeParse(value).success, `${target.name}/${label}: Zod accepted`).toBe(false);
};

/**
 * Rejection the published document cannot see. Generation retired the `x-archflow-sorted-unique`,
 * `x-archflow-sorted-unique-by`, and `x-archflow-max-utf8-bytes` keywords from the committed
 * schemas, so the compiled document deliberately accepts these values; the Zod refinements — the
 * shared `isSortedUniqueBy` / `tupleKey` predicates — are the surviving runtime authority and must
 * keep rejecting them.
 */
const rejectsInZodAuthority = (target: Shape, value: unknown, label = "value"): void => {
  expect(target.json.validate(value), `${target.name}/${label}: generated schema kept a retired keyword`).toBe(true);
  expect(target.zod.safeParse(value).success, `${target.name}/${label}: Zod accepted`).toBe(false);
};

const accepts = (target: Shape, value: unknown, label = "value"): void => {
  const result = target.zod.safeParse(value);
  expect(result.success, `${target.name}/${label}: Zod rejected`).toBe(true);
  if (result.success) expect(result.data, `${target.name}/${label}: Zod transformed the value`).toEqual(value);
  expect(target.json.validate(value), `${target.name}/${label}: published schema rejected`).toBe(true);
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
    scope: { operation: "review-trigger", boundary: "subject" },
    granted: true,
    expires: "task-complete",
    granted_at_revision: 4,
  },
  ...items(value),
]);

const retainedCounter = (taskState.sample.authoritative_results as JsonObject[]).find((reference) =>
  reference.phase_instance === "phase-impl-1" && reference.step === "counter_review")!;
const revisionEvidence = [{
  ...retainedCounter,
  step: "adjudicate",
  result_digest: "8".repeat(64),
  result_id: "phase-impl-1:adjudicate:1",
}, retainedCounter];
const revisionRecord = (gateId: string, fill: string): JsonObject => ({
  phase_instance: "phase-impl-1",
  gate_id: gateId,
  gate_kind: "constitution-review",
  predecessor_subject_digest: fill.repeat(64),
  predecessor_input_fingerprint: "8".repeat(64),
  resulting_subject_digest: "9".repeat(64),
  resulting_result_digest: fill === "1" ? "a".repeat(64) : "b".repeat(64),
  classification: "simple",
  rationale: "Wording only.",
  previous_attempt: 2,
  resulting_attempt: 2,
  evidence: revisionEvidence,
});
const { open_gate: _revisionOpenGate, ...taskStateWithoutOpenGate } = taskState.sample;
const taskStateRevisionCollections: JsonObject = {
  ...taskStateWithoutOpenGate,
  step: "produce",
  status: "running",
  attempt: 2,
  pending_human_revision: {
    gate_id: "gate-pending",
    gate_kind: "constitution-review",
    predecessor_subject_digest: "c".repeat(64),
    predecessor_input_fingerprint: "8".repeat(64),
    requested_at_revision: 7,
    attempt: 2,
    evidence: revisionEvidence,
  },
  human_revision_history: [revisionRecord("gate-a", "1"), revisionRecord("gate-b", "2")],
};

const restartResult = (phaseInstance: string, fill: string): JsonObject => ({
  phase_instance: phaseInstance,
  step: "produce",
  result_digest: fill.repeat(64),
  result_id: `${phaseInstance}:produce:1`,
  input_fingerprint: "8".repeat(64),
});
const restartWaiver = (gateId: string, fill: string): JsonObject => ({
  gate_id: gateId,
  rule_id: `constitution:${gateId}`,
  rule_version: 1,
  subject_digest: fill.repeat(64),
  scope: { operation: "review-trigger", boundary: "subject" },
  granted: true,
  expires: "task-complete",
  granted_at_revision: 4,
});
const restartRecord = (restartId: string, fromPhase: string, targetPhase: string): JsonObject => ({
  restart_id: restartId,
  source_phase_instance: fromPhase,
  target_phase_instance: targetPhase,
  reason: "Planning authority required correction.",
  restarted_at_revision: 4,
  superseded_results: [restartResult("design", "a"), restartResult("phase-design-1", "b")],
  cleared_waivers: [restartWaiver("gate-a", "c"), restartWaiver("gate-b", "d")],
  human_provenance: restartId === "restart-a"
    ? {
        schema_version: "1",
        actor_class: "human",
        assurance: "declared-local-trace",
        channel: "archflow-local",
        decision_event_id: `${restartId}-decision`,
        helper_invocation_id: `${restartId}-helper`,
        recorded_at: "2026-08-16T12:00:00.000Z",
      }
    : {
        schema_version: "1",
        actor_class: "human",
        assurance: "connected-request-trace",
        channel: "connected-host",
        connection_id: "connection-1",
        invocation_id: "invocation-1",
        request_id_digest: "f".repeat(64),
        request_digest: "e".repeat(64),
      },
});
const taskStateRestartCollections: JsonObject = {
  ...taskStateWithoutOpenGate,
  restart_history: [
    restartRecord("restart-a", "phase-impl-1", "design"),
    restartRecord("restart-b", "phase-impl-2", "phase-design-1"),
  ],
};

const recoveryRecord = (recoveryId: string, phaseInstance: string, fill: string): JsonObject => ({
  recovery_id: recoveryId,
  phase_instance: phaseInstance,
  cause: "milestone-proof-missing",
  target_ref: "refs/heads/main",
  target_head: fill.repeat(40),
  subject_digest: fill.repeat(64),
  recovered_at_revision: 4,
  superseded_results: [restartResult("phase-impl-1", "a"), restartResult("phase-impl-2", "b")],
  cleared_waivers: [restartWaiver("gate-a", "c"), restartWaiver("gate-b", "d")],
});
const taskStateMilestoneRecoveryCollections: JsonObject = {
  ...taskStateWithoutOpenGate,
  milestone_recovery_history: [
    recoveryRecord("recovery-a", "phase-impl-1", "a"),
    recoveryRecord("recovery-b", "phase-impl-2", "b"),
  ],
};

const taskStateBaselineAdoptionCollections: JsonObject = {
  ...taskStateWithoutOpenGate,
  baseline_adoptions: [
    {
      gate_id: "gate-adoption-a",
      adopted_at_revision: 5,
      adopted_projections: [
        { path: "src/alpha.ts", content_digest: "a".repeat(64) },
        { path: "src/beta.ts", content_digest: "b".repeat(64) },
      ],
      adopted_absences: ["docs/retired-a.md", "docs/retired-b.md"],
    },
    {
      gate_id: "gate-adoption-b",
      adopted_at_revision: 6,
      adopted_projections: [
        { path: "docs/OVERVIEW.md", content_digest: "c".repeat(64) },
        { path: "src/gamma.ts", content_digest: "d".repeat(64) },
      ],
    },
  ],
};

/**
 * Rule settlements, sorted by the triple `(phase_instance, subject_digest,
 * settled_at_revision)` — the exact-restart key, where the same pair legally re-settles at a new
 * revision. The two entries differ on every component, so both the shuffle and the duplicate
 * cases bite.
 */
const taskStateRuleSettlementCollections: JsonObject = {
  ...taskStateWithoutOpenGate,
  rule_settlements: [
    {
      task_id: "mcp-integration",
      phase_instance: "phase-design-1",
      step: "triage",
      subject_digest: "a".repeat(64),
      conclusion: { wait: false, match: null },
      config_digest: "b".repeat(64),
      settled_at_revision: 5,
    },
    {
      task_id: "mcp-integration",
      phase_instance: "phase-impl-1",
      step: "triage",
      subject_digest: "a".repeat(64),
      conclusion: { wait: true, match: { kind: "content", paths: ["db/a.sql", "db/b.sql"] } },
      config_digest: "b".repeat(64),
      settled_at_revision: 6,
    },
  ],
};

const documentArtifactAdditionalDocuments: JsonObject = {
  ...documentArtifact.sample,
  additional_documents: [
    {
      document_path: "design.md",
      byte_count: 1024,
      content_digest: "a".repeat(64),
      projection_target: ".archflow/tasks/demo/design.md",
    },
    {
      document_path: "prd.md",
      byte_count: 2048,
      content_digest: "b".repeat(64),
      projection_target: ".archflow/tasks/demo/prd.md",
    },
  ],
};

/**
 * Every declared set in the phase, with the shape whose fixture carries it. This list is asserted
 * below to be exactly the set of arrays these schemas declare — the design is explicit that
 * after the Phase 8 split *there is no sequence in this phase*, so an array missing from this table
 * is either an unordered collection that should not exist or a set nobody is testing.
 */
const DECLARED_SETS: readonly { readonly shape: string; readonly path: string; readonly base?: JsonObject }[] = [
  { shape: "task-state", path: "authoritative_results" },
  { shape: "task-state", path: "approvals" },
  { shape: "task-state", path: "waivers", base: taskStateTwoWaivers },
  { shape: "task-state", path: "pending_human_revision.evidence", base: taskStateRevisionCollections },
  { shape: "task-state", path: "human_revision_history", base: taskStateRevisionCollections },
  { shape: "task-state", path: "human_revision_history.0.evidence", base: taskStateRevisionCollections },
  { shape: "task-state", path: "restart_history", base: taskStateRestartCollections },
  { shape: "task-state", path: "restart_history.0.superseded_results", base: taskStateRestartCollections },
  { shape: "task-state", path: "restart_history.0.cleared_waivers", base: taskStateRestartCollections },
  { shape: "task-state", path: "milestone_recovery_history", base: taskStateMilestoneRecoveryCollections },
  { shape: "task-state", path: "milestone_recovery_history.0.superseded_results", base: taskStateMilestoneRecoveryCollections },
  { shape: "task-state", path: "milestone_recovery_history.0.cleared_waivers", base: taskStateMilestoneRecoveryCollections },
  { shape: "task-state", path: "baseline_adoptions", base: taskStateBaselineAdoptionCollections },
  { shape: "task-state", path: "baseline_adoptions.0.adopted_projections", base: taskStateBaselineAdoptionCollections },
  { shape: "task-state", path: "baseline_adoptions.0.adopted_absences", base: taskStateBaselineAdoptionCollections },
  { shape: "task-state", path: "rule_settlements", base: taskStateRuleSettlementCollections },
  { shape: "task-state", path: "rule_settlements.1.conclusion.match.paths", base: taskStateRuleSettlementCollections },
  { shape: "legacy-import-initialization", path: "mapping" },
  { shape: "legacy-import-initialization", path: "staged_payload_refs" },
  { shape: "document-artifact", path: "declared_inputs" },
  { shape: "document-artifact", path: "additional_documents", base: documentArtifactAdditionalDocuments },
  { shape: "implementation-output", path: "outputs" },
  { shape: "implementation-output", path: "parent_documents" },
  { shape: "implementation-output", path: "restore_targets" },
  { shape: "implementation-output", path: "declared_inputs" },
  { shape: "implementation-output", path: "undeclared_changes.undeclared_paths" },
  { shape: "snapshot-accounting", path: "counted_entries" },
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
      rejectsInZodAuthority(target, permuted, `${declared.path} shuffled`);
    });

    it(`${declared.shape}.${declared.path} rejects a duplicated key`, () => {
      rejectsInZodAuthority(target, at(base, declared.path, withDuplicate), `${declared.path} duplicated`);
    });
  }
});

/**
 * The sweep. Generation retired the ordering keywords, so no array-shaped subschema may carry one
 * any more — the ordering authority is the Zod refinement exercised above — and the set of arrays
 * must still be exactly the declared collections above: nothing new, nothing untested.
 */
const SCHEMA_FILES: readonly { readonly name: string; readonly schema: object }[] = [
  { name: "durable-primitives", schema: durablePrimitivesSchema },
  { name: "task-state", schema: taskStateSchema },
  { name: "task-initialization", schema: taskInitializationSchema },
  { name: "legacy-import-initialization", schema: legacyImportSchema },
  { name: "document-artifact", schema: documentArtifactSchema },
  { name: "implementation-output", schema: implementationOutputSchema },
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
  it("no array-shaped subschema carries a retired ordering keyword", () => {
    const carrying = collectArraySubschemas().filter((entry) => entry.keywords.length > 0);
    expect(carrying.map((entry) => entry.location)).toStrictEqual([]);
  });

  it("the arrays the schemas declare are exactly the collections under test", () => {
    expect(collectArraySubschemas().map((entry) => entry.location).sort()).toStrictEqual(
      [
        "durable-primitives/$defs/snapshotAccounting/properties/counted_entries",
        "document-artifact/properties/additional_documents",
        "document-artifact/properties/declared_inputs",
        "implementation-output/$defs/undeclaredChangeReport/properties/undeclared_paths",
        "implementation-output/properties/declared_inputs",
        "implementation-output/properties/outputs",
        "implementation-output/properties/parent_documents",
        "implementation-output/properties/restore_targets",
        "legacy-import-initialization/properties/mapping",
        "legacy-import-initialization/properties/staged_payload_refs",
        "task-state/$defs/configApprovalRules/properties/content",
        "task-state/$defs/configApprovalRules/properties/content/items/properties/paths",
        "task-state/$defs/configApprovalRules/properties/subjects",
        "task-state/$defs/plainJson/anyOf/4",
        "task-state/$defs/humanRevisionRecord/properties/evidence",
        "task-state/$defs/pendingHumanRevision/properties/evidence",
        "task-state/$defs/planningRestartRecord/properties/cleared_waivers",
        "task-state/$defs/planningRestartRecord/properties/superseded_results",
        "task-state/properties/approvals",
        "task-state/properties/authoritative_results",
        "task-state/properties/baseline_adoptions",
        "task-state/properties/baseline_adoptions/items/properties/adopted_absences",
        "task-state/properties/baseline_adoptions/items/properties/adopted_projections",
        "task-state/properties/human_revision_history",
        "task-state/properties/milestone_recovery_history",
        "task-state/properties/milestone_recovery_history/items/properties/cleared_waivers",
        "task-state/properties/milestone_recovery_history/items/properties/superseded_results",
        "task-state/properties/restart_history",
        "task-state/$defs/ruleSettlementConclusion/oneOf/1/properties/match/oneOf/1/properties/paths",
        "task-state/properties/rule_settlements",
        "task-state/properties/waivers",
      ].sort()
    );
    // The recursive PlainJson array is value data, not a set. The three `configApprovalRules`
    // arrays are the mirrored config document's human-authored vocabulary: `subjects` rejects
    // repeats in the config parser itself, but none of the three demands a sorted hand the way a
    // server-authored set does — their agreement cases live in foundational-schema-agreement.
    expect(DECLARED_SETS).toHaveLength(collectArraySubschemas().length - 4);
  });
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
    rejectsInZodAuthority(taskState, at(taskState.sample, "authoritative_results", () => inverted), "':' order");
  });

  it("orders on the full tuple, not on phase_instance alone", () => {
    const sameInstance = [
      resultRef("phase-impl-1", "counter_review", "3"),
      resultRef("phase-impl-1", "produce", "4"),
    ];
    accepts(taskState, at(taskState.sample, "authoritative_results", () => sameInstance), "second component");
    rejectsInZodAuthority(
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
 * positive count pins its own minimum at the field and must not `$ref` it.
 */
const POSITIVE_FIELDS: readonly { readonly shape: string; readonly path: string }[] = [
  { shape: "task-state", path: "revision" },
  { shape: "task-state", path: "attempt" },
  { shape: "task-state", path: "approvals.0.resolved_at_revision" },
  { shape: "task-state", path: "open_gate.opened_at_revision" },
  { shape: "task-state", path: "waivers.0.rule_version" },
  { shape: "task-state", path: "waivers.0.granted_at_revision" },
  { shape: "task-state", path: "last_transition.resulting_revision" },
  { shape: "snapshot-accounting", path: "measured_at_revision" },
];

describe("every >= 1 field rejects 0 (D8)", () => {
  it("pins the eight positive-field routes and six exercised shapes", () => {
    expect(POSITIVE_FIELDS).toHaveLength(8);
    expect(SHAPES).toHaveLength(6);
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

describe("absence is omission except in contracts that explicitly classify absence", () => {
  it("declares null only for automation observations, PlainJson data, and the autonomous settlement match", () => {
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
    expect(offenders).toStrictEqual([
      "automation-status.schema.json",
      "automation-status.schema.json/oneOf/0/properties/state_revision/anyOf/1/type",
      "automation-status.schema.json/oneOf/1/properties/state_revision/anyOf/1/type",
      "automation-status.schema.json/oneOf/2/properties/state_revision/anyOf/1/type",
      "automation-status.schema.json/oneOf/3/properties/state_revision/anyOf/1/type",
      "automation-status.schema.json/oneOf/4/properties/state_revision/anyOf/1/type",
      "automation-status.schema.json/oneOf/4/properties/position/type",
      "automation-status.schema.json/oneOf/5/properties/state_revision/anyOf/1/type",
      "gate-contract.schema.json",
      "gate-contract.schema.json/$defs/approvalTrigger/oneOf/0/properties/conclusion/oneOf/0/properties/match/type",
      "intent-receipt.schema.json",
      "intent-receipt.schema.json/$defs/plainJson/anyOf/0/type",
      "semantic-workflow.schema.json",
      "semantic-workflow.schema.json/$defs/plainJson/anyOf/0/type",
      "task-state.schema.json",
      "task-state.schema.json/$defs/ruleSettlementConclusion/oneOf/0/properties/match/type",
      "task-state.schema.json/$defs/ruleSettlementConclusion/oneOf/0/properties/match/const",
      "task-state.schema.json/$defs/plainJson/anyOf/0/type",
    ]);
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
    for (const path of ["open_gate", "last_transition", "terminal"]) {
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

  it("outputs is non-empty", () => {
    rejects(implementationOutput, at(implementationOutput.sample, "outputs", () => []), "empty outputs");
  });

  it("an implementation output cannot claim a server-owned path class", () => {
    for (const pathClass of ["task-state", "authority-result", "authority-initialization", "authority-decision"]) {
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
        rejectsInZodAuthority(target, at(base, declared.path, shuffled), `${declared.path} shuffled`);
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
