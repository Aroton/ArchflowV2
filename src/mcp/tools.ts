import evidenceSlotsSchema from "../contracts/schemas/v1/evidence-slots.schema.json" with { type: "json" };
import documentArtifactSchema from "../contracts/schemas/v1/document-artifact.schema.json" with { type: "json" };
import durablePrimitivesSchema from "../contracts/schemas/v1/durable-primitives.schema.json" with { type: "json" };
import gateContractSchema from "../contracts/schemas/v1/gate-contract.schema.json" with { type: "json" };
import gateDecisionSchema from "../contracts/schemas/v1/gate-decision.schema.json" with { type: "json" };
import mcpToolsSchema from "../contracts/schemas/v1/mcp-tools.schema.json" with { type: "json" };
import implementationOutputSchema from "../contracts/schemas/v1/implementation-output.schema.json" with { type: "json" };
import legacyImportInitializationSchema from "../contracts/schemas/v1/legacy-import-initialization.schema.json" with { type: "json" };
import pathClaimSchema from "../contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import projectErrorSchema from "../contracts/schemas/v1/project-error.schema.json" with { type: "json" };
import rubricSchema from "../contracts/schemas/v1/rubric.schema.json" with { type: "json" };
import secretScanResultSchema from "../contracts/schemas/v1/secret-scan-result.schema.json" with { type: "json" };
import taskInitializationSchema from "../contracts/schemas/v1/task-initialization.schema.json" with { type: "json" };
import taskStateSchema from "../contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import triageSchema from "../contracts/schemas/v1/triage.schema.json" with { type: "json" };
import semanticWorkflowSchema from "../contracts/schemas/v1/semantic-workflow.schema.json" with { type: "json" };
import { ADVERTISED_TOOL_NAMES, type AdvertisedToolName, type SemanticToolName } from "../contracts/tool-names.js";

export interface AdvertisedToolDescriptor {
  readonly name: AdvertisedToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

type JsonObject = Record<string, unknown>;

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const MCP_SCHEMA_ID = "https://archflow.dev/schemas/v1/mcp-tools";

// The server validates the complete recommendation union before it reaches the adapter. MCP hosts
// only need its public discriminator and field map in the advertised output schema; embedding the
// full nested assessment vocabulary twice (once per semantic tool) consumes the catalogue budget
// without admitting any client input or strengthening server-output validation.
const ADVERTISED_IMPLEMENTATION_RECOMMENDATION = deepFreeze({
  type: "object",
  description: "Authenticated advisory implementation agent; successful selection exposes only model and effort.",
  properties: {
    status: { enum: ["ready", "unavailable"] },
    model: { enum: ["gemini-3.7-flash", "glm-5.3-flash", "gpt-5.6-sol"] },
    effort: { enum: ["medium", "xhigh", "max"] },
    phase: { type: "integer", minimum: 1 },
    reason: { enum: ["not-applicable", "not-produced", "subject-stale", "legacy-evidence"] },
    explanation: { type: "string" },
  },
  required: ["status"],
} as const);

const schemaDocuments = Object.freeze([
  Object.freeze({ key: "mcp-tools", id: MCP_SCHEMA_ID, schema: mcpToolsSchema }),
  Object.freeze({ key: "primitives", id: "urn:archflow:schema:v1:primitives", schema: primitivesSchema }),
  Object.freeze({ key: "path-claim", id: "urn:archflow:schema:v1:path-claim", schema: pathClaimSchema }),
  Object.freeze({ key: "evidence-slots", id: "urn:archflow:schema:v1:evidence-slots", schema: evidenceSlotsSchema }),
  Object.freeze({ key: "rubric", id: "urn:archflow:schema:v1:rubric", schema: rubricSchema }),
  Object.freeze({ key: "gate-contract", id: "urn:archflow:schema:v1:gate-contract", schema: gateContractSchema }),
  Object.freeze({ key: "gate-decision", id: "urn:archflow:schema:v1:gate-decision", schema: gateDecisionSchema }),
  Object.freeze({ key: "project-error", id: "urn:archflow:schema:v1:project-error", schema: projectErrorSchema }),
  Object.freeze({ key: "durable-primitives", id: "urn:archflow:schema:v1:durable-primitives", schema: durablePrimitivesSchema }),
  Object.freeze({ key: "task-state", id: "urn:archflow:schema:v1:task-state", schema: taskStateSchema }),
  Object.freeze({ key: "task-initialization", id: "urn:archflow:schema:v1:task-initialization", schema: taskInitializationSchema }),
  Object.freeze({ key: "legacy-import-initialization", id: "urn:archflow:schema:v1:legacy-import-initialization", schema: legacyImportInitializationSchema }),
  Object.freeze({ key: "document-artifact", id: "urn:archflow:schema:v1:document-artifact", schema: documentArtifactSchema }),
  Object.freeze({ key: "implementation-output", id: "urn:archflow:schema:v1:implementation-output", schema: implementationOutputSchema }),
  Object.freeze({ key: "secret-scan-result", id: "urn:archflow:schema:v1:secret-scan-result", schema: secretScanResultSchema }),
  Object.freeze({ key: "triage", id: "urn:archflow:schema:v1:triage", schema: triageSchema }),
  Object.freeze({ key: "semantic-workflow", id: "urn:archflow:schema:v1:semantic-workflow", schema: semanticWorkflowSchema })
] as const);

const documentsByKey = new Map<string, unknown>(schemaDocuments.map(({ key, schema }) => [key, schema]));
const documentKeysById = new Map<string, string>(schemaDocuments.map(({ id, key }) => [id, key]));

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticSchemaFragment(name: SemanticToolName, member: "input" | "result"): JsonObject {
  const definitions = (semanticWorkflowSchema as JsonObject).$defs;
  const key = member === "result" ? "semanticResult" : name === "archflow_status" ? "statusInput" : "applyInput";
  const fragment = isObject(definitions) ? definitions[key] : undefined;
  if (!isObject(fragment)) throw new TypeError(`missing semantic schema fragment for ${name}/${member}`);
  return fragment;
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
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

function parseReference(sourceKey: string, reference: string): { key: string; tokens: readonly string[] } {
  const hash = reference.indexOf("#");
  const documentId = hash === -1 ? reference : reference.slice(0, hash);
  const fragment = hash === -1 ? "" : reference.slice(hash + 1);
  const key = documentId === "" ? sourceKey : documentKeysById.get(documentId);
  if (key === undefined) throw new TypeError(`unknown normative schema reference: ${reference}`);
  if (fragment !== "" && !fragment.startsWith("/")) throw new TypeError(`unsupported normative schema fragment: ${reference}`);
  const tokens = fragment === "" ? [] : fragment.slice(1).split("/").map(unescapePointerToken);
  return { key, tokens };
}

/**
 * Embeds one semantic fragment as a standalone advertised schema. Every definition the fragment
 * can reach is hoisted into a flat top-level $defs and every reference is rewritten to a
 * single-hop `#/$defs/<name>` pointer: at least one MCP host serializes any argument whose
 * advertised schema is a bare `$ref` pointing INTO a nested `$defs` as a JSON string instead of
 * an object, so the advertised surface never exposes a two-level pointer. Only reachable
 * definitions are carried — inlining the whole corpus instead is correct but costs an MCP
 * client two orders of magnitude more context than the fragment it came for.
 */
function embedSchema(entry: JsonObject, sourceKey: string): { fragment: JsonObject; definitions: JsonObject } {
  const definitions: JsonObject = {};
  const placements = new Map<string, string>();
  const takenNames = new Set<string>();

  const place = (reference: string, fromKey: string): string => {
    const { key, tokens } = parseReference(fromKey, reference);
    const placementKey = `${key} ${JSON.stringify(tokens)}`;
    const placed = placements.get(placementKey);
    if (placed !== undefined) return placed;
    const document = documentsByKey.get(key);
    if (document === undefined) throw new TypeError(`unknown advertised schema document: ${reference}`);
    const target = resolvePointer(document, tokens, reference);
    let name = tokens[tokens.length - 1] ?? key;
    if (name.includes("/") || name.includes("~")) throw new TypeError(`advertised schema definition name is not a single pointer token: ${name}`);
    if (takenNames.has(name)) name = `${key}-${name}`;
    if (takenNames.has(name)) throw new TypeError(`colliding advertised schema definition name: ${name}`);
    const localReference = `#/$defs/${name}`;
    // Registered before embedding so a self-referencing definition reuses its own reference.
    placements.set(placementKey, localReference);
    takenNames.add(name);
    definitions[name] = key === "semantic-workflow" && tokens.join("/") === "$defs/implementationRecommendation"
      ? ADVERTISED_IMPLEMENTATION_RECOMMENDATION
      : embed(target, key);
    return localReference;
  };

  const embed = (value: unknown, fromKey: string): unknown => {
    if (Array.isArray(value)) return value.map((entry) => embed(entry, fromKey));
    if (!isObject(value)) return value;
    const projected: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$id" || key === "$schema" || key === "$anchor" || key === "$dynamicAnchor" || key.startsWith("x-archflow-")) continue;
      projected[key] = key === "$ref" && typeof entry === "string" ? place(entry, fromKey) : embed(entry, fromKey);
    }
    return projected;
  };

  return { fragment: embed(entry, sourceKey) as JsonObject, definitions };
}

function standaloneSchema(name: AdvertisedToolName, member: "input" | "result"): Readonly<JsonObject> {
  const { fragment, definitions } = embedSchema(semanticSchemaFragment(name, member), "semantic-workflow");
  return deepFreeze({
    $schema: JSON_SCHEMA_2020_12,
    ...fragment,
    type: "object",
    $defs: definitions
  });
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export const ADVERTISED_TOOL_CATALOGUE: readonly AdvertisedToolDescriptor[] = deepFreeze(
  ADVERTISED_TOOL_NAMES.map((name) => ({
    name,
    description: name === "archflow_status"
      ? "Read durable ArchFlow status for one task and optional producing-skill invocation without mutation; returns one reconciled workflow view and at most one bounded offer for the current document owner."
      : "Apply exactly one supplied server offer using only its expected semantic submission; never chooses or loops to another action and returns the newly authenticated workflow view.",
    inputSchema: standaloneSchema(name, "input"),
    outputSchema: standaloneSchema(name, "result")
  }))
);
