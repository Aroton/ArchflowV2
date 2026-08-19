import { z, type ZodType } from "zod";

import { durableSchemaGroup } from "./schema-generation-durable.js";
import { errorSchemaGroup } from "./schema-generation-errors.js";
import { gateSchemaGroup } from "./schema-generation-gate.js";
import { leafSchemaGroup } from "./schema-generation-leaf.js";
import { mcpToolsSchemaGroup } from "./schema-generation-mcp-tools.js";
import { semanticWorkflowSchemaGroup } from "./schema-generation-semantic-workflow.js";

/** A hand-authored JSON Schema fragment emitted verbatim in place of a def's Zod emission. */
export type GeneratedDefOverride = Readonly<Record<string, unknown>>;

export type SchemaDocumentPlan = {
  /** File stem: the document is written to `src/contracts/schemas/v1/<file>.schema.json`. */
  readonly file: string;
  /** The document `$id` — always the `SCHEMA_IDS` value for this schema. */
  readonly id: string;
  /** Zod source of the document root; emitted inline, with `$ref`s to every registered def. */
  readonly root: ZodType;
  /**
   * The `$defs` layout in emission order: def name → the exact Zod object other schemas in this
   * manifest reference. Identity matters — a `$ref` is emitted only where the registered object
   * itself appears, so defs must be the shared exported schema, not a structural copy. A name
   * containing `/` publishes a nested member — `archflow_state/input` is written to
   * `$defs.archflow_state.input` and referenced as `#/$defs/archflow_state/input`, the form the
   * per-tool input/success/result inventory of `mcp-tools.schema.json` pins.
   */
  readonly defs?: Readonly<Record<string, ZodType>>;
  /**
   * Hand-authored emissions keyed by def name. The def's Zod schema stays registered so `$ref`s
   * to it still resolve, but its emitted body is replaced verbatim — the escape hatch for defs
   * Zod cannot emit faithfully, such as the recursive plain-json def when its group migrates.
   */
  readonly overrides?: Readonly<Record<string, GeneratedDefOverride>>;
  /**
   * Only migrated documents are emitted and byte-checked; until a document's runtime authority
   * flips to Zod, its committed schema stays hand-written. A false entry still registers its
   * defs, so already-migrated documents can cross-reference it by URI ahead of its own flip.
   */
  readonly migrated: boolean;
};

export type SchemaGenerationGroup = {
  readonly group: "leaf" | "durable" | "gate" | "errors" | "mcp-tools" | "semantic-workflow";
  readonly documents: readonly SchemaDocumentPlan[];
};

/**
 * The deliberately hand-written release manifest schema is excluded from generation because it
 * describes the release payload itself and has no runtime Zod source. `check:schemas`
 * independently asserts the generator never emits it.
 */
export const HAND_WRITTEN_SCHEMA_FILES: readonly string[] = Object.freeze([
  "release-manifest",
]);

/** The full emission manifest. Each group module owns exactly one shape group's documents. */
export const SCHEMA_GENERATION_GROUPS: readonly SchemaGenerationGroup[] = Object.freeze([
  leafSchemaGroup,
  durableSchemaGroup,
  gateSchemaGroup,
  errorSchemaGroup,
  mcpToolsSchemaGroup,
  semanticWorkflowSchemaGroup,
]);

/** Keeps annotation order while dropping the per-schema envelope Zod stamps on every emission. */
function stripEmissionEnvelope(emitted: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(emitted).filter(([key]) => key !== "$schema" && key !== "$id"));
}

function requireEmitted(
  schemas: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>,
  registryId: string
): Readonly<Record<string, unknown>> {
  const emitted = schemas[registryId];
  if (emitted === undefined) throw new Error(`schema generation emitted nothing for registry id ${registryId}`);
  return emitted;
}

/**
 * Renders every migrated document to its committed serialization: draft 2020-12, `$schema` then
 * `$id` then `$defs` then the root body, 2-space indent, trailing newline. Key order inside each
 * body is Zod's deterministic emission order, so repeated runs are byte-identical.
 */
export function renderGeneratedSchemaFiles(): Readonly<Record<string, string>> {
  const documents = SCHEMA_GENERATION_GROUPS.flatMap((group) => group.documents);
  const documentIds = new Map<string, string>();
  const registry = z.registry<{ id: string }>();
  for (const document of documents) {
    if (HAND_WRITTEN_SCHEMA_FILES.includes(document.file)) {
      throw new Error(`${document.file} is a hand-written schema and must never enter the generation manifest`);
    }
    if (documentIds.has(document.file)) throw new Error(`duplicate schema generation entry for ${document.file}`);
    documentIds.set(document.file, document.id);
    registry.add(document.root, { id: document.file });
    for (const [name, def] of Object.entries(document.defs ?? {})) {
      registry.add(def, { id: `${document.file}#${name}` });
    }
  }

  const resolveUri = (currentFile: string) => (registryId: string): string => {
    const separator = registryId.indexOf("#");
    const file = separator === -1 ? registryId : registryId.slice(0, separator);
    const documentId = documentIds.get(file);
    if (documentId === undefined) throw new Error(`unregistered schema document in reference: ${registryId}`);
    if (separator === -1) return documentId;
    const pointer = `#/$defs/${registryId.slice(separator + 1)}`;
    return file === currentFile ? pointer : `${documentId}${pointer}`;
  };

  const rendered: Record<string, string> = {};
  for (const document of documents) {
    if (!document.migrated) continue;
    const { schemas } = z.toJSONSchema(registry, { target: "draft-2020-12", uri: resolveUri(document.file) });
    const defs: Record<string, unknown> = {};
    for (const name of Object.keys(document.defs ?? {})) {
      const override = document.overrides?.[name];
      const body = override ?? stripEmissionEnvelope(requireEmitted(schemas, `${document.file}#${name}`));
      const segments = name.split("/");
      let target = defs;
      for (const segment of segments.slice(0, -1)) {
        const nested = target[segment] ?? {};
        if (typeof nested !== "object" || nested === null) throw new Error(`nested def name collides with a schema body: ${name}`);
        target[segment] = nested;
        target = nested as Record<string, unknown>;
      }
      target[segments[segments.length - 1] as string] = body;
    }
    const assembled = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: document.id,
      ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
      ...stripEmissionEnvelope(requireEmitted(schemas, document.file)),
    };
    rendered[`${document.file}.schema.json`] = `${JSON.stringify(assembled, null, 2)}\n`;
  }
  return rendered;
}
