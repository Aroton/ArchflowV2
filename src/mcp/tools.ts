import evidenceSlotsSchema from "../contracts/schemas/v1/evidence-slots.schema.json" with { type: "json" };
import documentArtifactSchema from "../contracts/schemas/v1/document-artifact.schema.json" with { type: "json" };
import durablePrimitivesSchema from "../contracts/schemas/v1/durable-primitives.schema.json" with { type: "json" };
import gateContractSchema from "../contracts/schemas/v1/gate-contract.schema.json" with { type: "json" };
import gateDecisionSchema from "../contracts/schemas/v1/gate-decision.schema.json" with { type: "json" };
import mcpToolsSchema from "../contracts/schemas/v1/mcp-tools.schema.json" with { type: "json" };
import implementationOutputSchema from "../contracts/schemas/v1/implementation-output.schema.json" with { type: "json" };
import legacyImportInitializationSchema from "../contracts/schemas/v1/legacy-import-initialization.schema.json" with { type: "json" };
import manualCheckpointSchema from "../contracts/schemas/v1/manual-checkpoint.schema.json" with { type: "json" };
import manualCheckpointImportSchema from "../contracts/schemas/v1/manual-checkpoint-import.schema.json" with { type: "json" };
import pathClaimSchema from "../contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import projectErrorSchema from "../contracts/schemas/v1/project-error.schema.json" with { type: "json" };
import rubricSchema from "../contracts/schemas/v1/rubric.schema.json" with { type: "json" };
import secretScanResultSchema from "../contracts/schemas/v1/secret-scan-result.schema.json" with { type: "json" };
import supplementalReviewSchema from "../contracts/schemas/v1/supplemental-review.schema.json" with { type: "json" };
import taskInitializationSchema from "../contracts/schemas/v1/task-initialization.schema.json" with { type: "json" };
import taskStateSchema from "../contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import triageSchema from "../contracts/schemas/v1/triage.schema.json" with { type: "json" };
import { TOOL_NAMES, type ToolName } from "../contracts/tool-names.js";

export interface AdvertisedToolDescriptor {
  readonly name: ToolName;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

type JsonObject = Record<string, unknown>;

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const MCP_SCHEMA_ID = "https://archflow.dev/schemas/v1/mcp-tools";

const schemaDocuments = Object.freeze([
  Object.freeze({ key: "mcp-tools", id: MCP_SCHEMA_ID, schema: mcpToolsSchema }),
  Object.freeze({ key: "primitives", id: "urn:archflow:schema:v1:primitives", schema: primitivesSchema }),
  Object.freeze({ key: "path-claim", id: "urn:archflow:schema:v1:path-claim", schema: pathClaimSchema }),
  Object.freeze({ key: "evidence-slots", id: "urn:archflow:schema:v1:evidence-slots", schema: evidenceSlotsSchema }),
  Object.freeze({ key: "rubric", id: "urn:archflow:schema:v1:rubric", schema: rubricSchema }),
  Object.freeze({ key: "gate-contract", id: "urn:archflow:schema:v1:gate-contract", schema: gateContractSchema }),
  Object.freeze({ key: "gate-decision", id: "urn:archflow:schema:v1:gate-decision", schema: gateDecisionSchema }),
  Object.freeze({ key: "supplemental-review", id: "urn:archflow:schema:v1:supplemental-review", schema: supplementalReviewSchema }),
  Object.freeze({ key: "project-error", id: "urn:archflow:schema:v1:project-error", schema: projectErrorSchema }),
  Object.freeze({ key: "durable-primitives", id: "urn:archflow:schema:v1:durable-primitives", schema: durablePrimitivesSchema }),
  Object.freeze({ key: "task-state", id: "urn:archflow:schema:v1:task-state", schema: taskStateSchema }),
  Object.freeze({ key: "task-initialization", id: "urn:archflow:schema:v1:task-initialization", schema: taskInitializationSchema }),
  Object.freeze({ key: "legacy-import-initialization", id: "urn:archflow:schema:v1:legacy-import-initialization", schema: legacyImportInitializationSchema }),
  Object.freeze({ key: "document-artifact", id: "urn:archflow:schema:v1:document-artifact", schema: documentArtifactSchema }),
  Object.freeze({ key: "implementation-output", id: "urn:archflow:schema:v1:implementation-output", schema: implementationOutputSchema }),
  Object.freeze({ key: "manual-checkpoint", id: "urn:archflow:schema:v1:manual-checkpoint", schema: manualCheckpointSchema }),
  Object.freeze({ key: "manual-checkpoint-import", id: "urn:archflow:schema:v1:manual-checkpoint-import", schema: manualCheckpointImportSchema }),
  Object.freeze({ key: "secret-scan-result", id: "urn:archflow:schema:v1:secret-scan-result", schema: secretScanResultSchema }),
  Object.freeze({ key: "triage", id: "urn:archflow:schema:v1:triage", schema: triageSchema })
] as const);

const documentKeysById = new Map<string, string>(schemaDocuments.map(({ id, key }) => [id, key]));

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localReference(sourceKey: string, reference: string): string {
  const hash = reference.indexOf("#");
  const documentId = hash === -1 ? reference : reference.slice(0, hash);
  const fragment = hash === -1 ? "" : reference.slice(hash + 1);
  const targetKey = documentId === "" ? sourceKey : documentKeysById.get(documentId);
  if (targetKey === undefined) throw new TypeError(`unknown normative schema reference: ${reference}`);
  if (fragment !== "" && !fragment.startsWith("/")) throw new TypeError(`unsupported normative schema fragment: ${reference}`);
  return `#/$defs/${targetKey}${fragment}`;
}

function project(value: unknown, sourceKey: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => project(entry, sourceKey));
  if (!isObject(value)) return value;

  const projected: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$id" || key === "$schema" || key === "$anchor" || key === "$dynamicAnchor" || key.startsWith("x-archflow-")) continue;
    projected[key] = key === "$ref" && typeof entry === "string" ? localReference(sourceKey, entry) : project(entry, sourceKey);
  }
  return projected;
}

function schemaFragment(name: ToolName, member: "input" | "result"): JsonObject {
  const definitions = (mcpToolsSchema as JsonObject).$defs;
  const tool = isObject(definitions) ? definitions[name] : undefined;
  const fragment = isObject(tool) ? tool[member] : undefined;
  if (!isObject(fragment)) throw new TypeError(`missing normative schema fragment for ${name}/${member}`);
  return fragment;
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function parseLocalReference(reference: string): { key: string; tokens: readonly string[] } {
  if (!reference.startsWith("#/$defs/")) throw new TypeError(`unexpected advertised schema reference: ${reference}`);
  const [key, ...tokens] = reference.slice("#/$defs/".length).split("/").map(unescapePointerToken);
  if (key === undefined || key === "") throw new TypeError(`unexpected advertised schema reference: ${reference}`);
  return { key, tokens };
}

function resolvePointer(root: unknown, tokens: readonly string[], reference: string): unknown {
  let node: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(node)) node = node[Number(token)];
    else if (isObject(node)) node = node[token];
    else node = undefined;
    if (node === undefined) throw new TypeError(`unresolvable advertised schema reference: ${reference}`);
  }
  return node;
}

function collectReferences(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, into);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") into.push(entry);
    else collectReferences(entry, into);
  }
}

/**
 * Keeps a document subtree only where a reachable reference lands on or passes through it.
 * Arrays on a pointer path are kept whole so sibling removal cannot renumber an index a
 * reference depends on; object siblings off every marked path are dropped.
 */
function extractSubtrees(node: unknown, markedPaths: readonly (readonly string[])[]): unknown {
  if (markedPaths.some((tokens) => tokens.length === 0)) return node;
  if (!isObject(node)) return node;
  const extracted: JsonObject = {};
  for (const [key, entry] of Object.entries(node)) {
    const descend = markedPaths.filter((tokens) => tokens[0] === key).map((tokens) => tokens.slice(1));
    if (descend.length > 0) extracted[key] = extractSubtrees(entry, descend);
  }
  return extracted;
}

/**
 * Advertised schemas carry only the $defs subtrees transitively reachable from the tool's own
 * fragment. Inlining the whole corpus instead is correct but costs an MCP client two orders of
 * magnitude more context than the fragment it came for: the shared block measured ~131 KB
 * repeated per member, with the result-only project-error union alone a third of it.
 */
function reachableDefinitions(fragment: JsonObject, projected: ReadonlyMap<string, unknown>): JsonObject {
  const marked = new Map<string, (readonly string[])[]>();
  const visited = new Set<string>();
  const pending: string[] = [];
  collectReferences(fragment, pending);
  while (pending.length > 0) {
    const reference = pending.pop() as string;
    const { key, tokens } = parseLocalReference(reference);
    const pointer = `${key} ${JSON.stringify(tokens)}`;
    if (visited.has(pointer)) continue;
    visited.add(pointer);
    const document = projected.get(key);
    if (document === undefined) throw new TypeError(`unknown advertised schema document: ${reference}`);
    const target = resolvePointer(document, tokens, reference);
    const paths = marked.get(key);
    if (paths === undefined) marked.set(key, [tokens]);
    else paths.push(tokens);
    collectReferences(target, pending);
  }
  const definitions: JsonObject = {};
  for (const { key } of schemaDocuments) {
    const paths = marked.get(key);
    if (paths === undefined) continue;
    definitions[key] = extractSubtrees(projected.get(key), paths);
  }
  return definitions;
}

/**
 * The advertised result projection replaces the full project-error union with this open summary
 * of the fields every project error carries. The full union is ~36 KB and is reachable from all
 * five result envelopes — measured at 179 KB of a 284 KB catalogue, nearly two thirds of the
 * whole advertised surface. Advertised output schemas are host-side advisory; the server's own
 * result validation still runs against the full normative union, and the summary is deliberately
 * open (`additionalProperties: true`) so every real error object keeps validating against it.
 */
const ADVERTISED_ERROR_SUMMARY: JsonObject = {
  type: "object",
  required: ["code"],
  properties: {
    code: { type: "string" },
    owner: { type: "string" },
    retryable: { type: "boolean" },
    next_action: { type: "string" }
  },
  additionalProperties: true
};

function resolveFragmentReference(reference: string, projected: ReadonlyMap<string, unknown>): unknown {
  const { key, tokens } = parseLocalReference(reference);
  const document = projected.get(key);
  if (document === undefined) throw new TypeError(`unknown advertised schema document: ${reference}`);
  return resolvePointer(document, tokens, reference);
}

interface BranchShape {
  readonly properties: JsonObject;
  readonly required: ReadonlySet<string>;
}

const CONTEXT_PLACEHOLDER = JSON.stringify({ type: "object" });

/**
 * Resolves one oneOf branch of a tool input fragment to its flat property surface. A branch is
 * an object schema, a $ref to one, or an allOf composition of both; an allOf entry that is
 * itself a bare oneOf (the gate kind/context pairing) contributes each variant field as a
 * per-field union, replacing a bare `{type: "object"}` placeholder where one exists, so the
 * per-kind context shapes survive the merge instead of collapsing to an untyped object.
 */
function branchShape(branch: unknown, projected: ReadonlyMap<string, unknown>): BranchShape {
  const properties: JsonObject = {};
  const required = new Set<string>();
  const addProperty = (field: string, schema: unknown): void => {
    const existing = properties[field];
    if (existing === undefined || JSON.stringify(existing) === CONTEXT_PLACEHOLDER) properties[field] = schema;
  };
  const absorbVariants = (variants: readonly unknown[]): void => {
    const schemasByField = new Map<string, unknown[]>();
    for (const variant of variants) {
      if (!isObject(variant) || !isObject(variant.properties)) continue;
      for (const [field, schema] of Object.entries(variant.properties)) {
        const collected = schemasByField.get(field) ?? [];
        if (!collected.some((entry) => JSON.stringify(entry) === JSON.stringify(schema))) collected.push(schema);
        schemasByField.set(field, collected);
      }
    }
    for (const [field, schemas] of schemasByField) addProperty(field, schemas.length === 1 ? schemas[0] : { oneOf: schemas });
  };
  const absorb = (part: unknown): void => {
    if (!isObject(part)) return;
    if (typeof part.$ref === "string") {
      absorb(resolveFragmentReference(part.$ref, projected));
      return;
    }
    if (isObject(part.properties)) for (const [field, schema] of Object.entries(part.properties)) addProperty(field, schema);
    if (Array.isArray(part.required)) for (const field of part.required) if (typeof field === "string") required.add(field);
    if (Array.isArray(part.allOf)) {
      for (const entry of part.allOf) {
        if (isObject(entry) && Array.isArray(entry.oneOf)) absorbVariants(entry.oneOf);
        else absorb(entry);
      }
    }
  };
  absorb(branch);
  return { properties, required };
}

/**
 * MCP hosts expect an advertised inputSchema whose root is a plain object schema. The normative
 * input contract is a oneOf (full payload | staged reference) built from $ref/allOf composition,
 * and at least one host flattens a root-level oneOf by dropping every branch it cannot resolve —
 * observed advertising all five tools as zero-field objects, which left models composing calls
 * from guessed (all-string) types. The advertised projection therefore merges the branches into
 * one object schema: the union of both groups' properties, the fields common to both groups as
 * required, and a description naming the groups. Root-level combinators are deliberately absent;
 * the server's strict oneOf validation in parseToolCall is unchanged and remains the authority.
 */
function mergedInputFragment(name: ToolName, fragment: JsonObject, projected: ReadonlyMap<string, unknown>): JsonObject {
  const branches = fragment.oneOf;
  if (!Array.isArray(branches) || branches.length !== 2) throw new TypeError(`expected a two-branch oneOf input fragment for ${name}`);
  const [full, staged] = branches.map((branch) => branchShape(branch, projected)) as [BranchShape, BranchShape];
  if (!staged.required.has("request_digest")) throw new TypeError(`expected the staged-reference branch second in the ${name} input fragment`);

  const properties: JsonObject = {};
  for (const shape of [full, staged]) {
    for (const [field, schema] of Object.entries(shape.properties)) if (!(field in properties)) properties[field] = schema;
  }
  const required = [...full.required].filter((field) => staged.required.has(field));
  const fullOptional = Object.keys(full.properties).filter((field) => !full.required.has(field));
  const description = "Exactly one parameter group is accepted (enforced server-side, not by this schema). " +
    `Full payload — required: ${[...full.required].join(", ")}` +
    (fullOptional.length > 0 ? `; optional: ${fullOptional.join(", ")}. ` : ". ") +
    `Staged reference — required: ${[...staged.required].join(", ")}; pass the staged.reference object returned by archflow-local build-request verbatim. ` +
    "Values must match the property schemas exactly: JSON numbers and objects are passed as numbers and objects, never stringified.";
  return { description, additionalProperties: false, required, properties };
}

function standaloneSchema(name: ToolName, member: "input" | "result"): Readonly<JsonObject> {
  const projected = new Map<string, unknown>(
    schemaDocuments.map(({ key, schema }) => [
      key,
      member === "result" && key === "project-error"
        ? structuredClone(ADVERTISED_ERROR_SUMMARY)
        : project(schema, key)
    ])
  );
  const fragment = project(schemaFragment(name, member), "mcp-tools") as JsonObject;
  const advertised = member === "input" ? mergedInputFragment(name, fragment, projected) : fragment;
  return deepFreeze({
    $schema: JSON_SCHEMA_2020_12,
    ...advertised,
    type: "object",
    $defs: reachableDefinitions(advertised, projected)
  });
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export const ADVERTISED_TOOL_CATALOGUE: readonly AdvertisedToolDescriptor[] = deepFreeze(
  TOOL_NAMES.map((name) => ({
    name,
    inputSchema: standaloneSchema(name, "input"),
    outputSchema: standaloneSchema(name, "result")
  }))
);
