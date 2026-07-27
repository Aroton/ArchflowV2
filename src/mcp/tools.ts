import evidenceSlotsSchema from "../contracts/schemas/v1/evidence-slots.schema.json" with { type: "json" };
import gateContractSchema from "../contracts/schemas/v1/gate-contract.schema.json" with { type: "json" };
import gateDecisionSchema from "../contracts/schemas/v1/gate-decision.schema.json" with { type: "json" };
import mcpToolsSchema from "../contracts/schemas/v1/mcp-tools.schema.json" with { type: "json" };
import pathClaimSchema from "../contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import projectErrorSchema from "../contracts/schemas/v1/project-error.schema.json" with { type: "json" };
import rubricSchema from "../contracts/schemas/v1/rubric.schema.json" with { type: "json" };
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
  Object.freeze({ key: "project-error", id: "urn:archflow:schema:v1:project-error", schema: projectErrorSchema })
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

function standaloneSchema(name: ToolName, member: "input" | "result"): Readonly<JsonObject> {
  const definitions = Object.fromEntries(
    schemaDocuments.map(({ key, schema }) => [key, project(schema, key)])
  );
  return deepFreeze({
    $schema: JSON_SCHEMA_2020_12,
    ...project(schemaFragment(name, member), "mcp-tools") as JsonObject,
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
  TOOL_NAMES.map((name) => ({
    name,
    inputSchema: standaloneSchema(name, "input"),
    outputSchema: standaloneSchema(name, "result")
  }))
);
