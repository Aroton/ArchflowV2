import { z } from "zod";
import { canonicalJsonBytes, canonicalJsonDigest } from "../contracts/canonical.js";
import { sha256DigestV1Schema, type Sha256Digest } from "../contracts/evidence.js";
import { parseWorkspacePathClaim, resolveTaskWorkspacePath } from "../repository/paths.js";
import { ensureAttemptDirectory } from "../state/layout.js";
import type { RetainedChildOutputContext } from "../dispatch/retained-child-output.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assetRoot } from "../init/assets.js";
import { parseSingleYamlDocument } from "../contracts/yaml.js";
import type { ConfigV1 } from "../contracts/config.js";
import {
  DEFAULT_IMPLEMENTATION_SETTINGS, implementationCatalogSchema, implementationSelectionInputSchema,
  type ImplementationSelectionInput,
} from "../contracts/implementation-selection.js";

/** Fresh reads apply to the next assessment; evidence retains the complete effective snapshot. */
export async function loadImplementationSelectionInput(
  config: ConfigV1["implementation"],
  root?: string,
): Promise<ImplementationSelectionInput> {
  try {
    const source = await readFile(join(root ?? await assetRoot(), "implementation-models.yaml"), "utf8");
    const catalog = implementationCatalogSchema.parse(parseSingleYamlDocument(source, "implementation-models.yaml"));
    return implementationSelectionInputSchema.parse({
      status: "ready", catalog, settings: { ...DEFAULT_IMPLEMENTATION_SETTINGS, ...config },
    }) as ImplementationSelectionInput;
  } catch (error) {
    return { status: "unavailable", explanation: `Implementation selection data is missing or invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
}


const capturedSelectionSchema = z.object({
  binding: sha256DigestV1Schema,
  input_digest: sha256DigestV1Schema,
  input: implementationSelectionInputSchema,
}).strict();

/** Like retained child output, this task-local retry convenience is disposable, never authority. */
export async function captureImplementationSelectionInput(
  context: RetainedChildOutputContext,
  binding: Sha256Digest,
  load: () => Promise<ImplementationSelectionInput>,
  readOnly = false,
): Promise<ImplementationSelectionInput> {
  const writer = context.dependencies.projection_writer;
  if (writer === undefined) return load();
  const claim = parseWorkspacePathClaim(`diagnostics/attempts/${context.phase_instance}/implementation-selection-${binding}.json`);
  const target = await resolveTaskWorkspacePath({
    runner: context.dependencies.runner, taskId: context.authority.task_id, claim,
    expectedClass: "workspace-attempt", context: context.authority.context,
  });
  if (!target.ok) return load();
  try {
    const record = capturedSelectionSchema.parse(JSON.parse(await readFile(target.value.absolute, "utf8")));
    const input = record.input as ImplementationSelectionInput;
    if (record.binding === binding && canonicalJsonDigest(input) === record.input_digest) return input;
  } catch { /* Missing or corrupt runtime data causes a fresh capture, never a workflow failure. */ }
  const input = await load();
  if (readOnly) return input;
  try {
    await ensureAttemptDirectory(context.authority, context.phase_instance);
    await writer.replaceRegular(target.value, canonicalJsonBytes({ binding, input_digest: canonicalJsonDigest(input), input }), false);
  } catch { /* Losing retention only costs another capture on retry. */ }
  return input;
}
