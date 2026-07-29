import { constants as fsConstants } from "node:fs";

import {
  parseCanonicalDocument,
  sha256Bytes,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import { parseConfigYaml } from "../contracts/config.js";
import { parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { ParsedToolCall } from "../contracts/mcp-tools.js";
import type { ToolName } from "../contracts/tool-names.js";
import taskStateSchema from "../contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import pathClaimSchema from "../contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import { createJsonSchemaValidator } from "../contracts/validators.js";
import { openResolved, type ResolvedPath } from "../repository/paths.js";
import type { RepositoryOperationContext } from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import type { TransactionAuthority } from "./authority.js";

export type StateReadResult =
  | Readonly<{ kind: "canonical"; document: CanonicalDocument<TaskStateV1> }>
  | Readonly<{ kind: "missing" | "unreadable" | "noncanonical" }>;

export type ReceiptReadResult =
  | Readonly<{ kind: "canonical"; document: CanonicalDocument<IntentReceiptV1> }>
  | Readonly<{ kind: "missing" | "unreadable" | "noncanonical" }>;

export type LiveConfigSnapshot = Readonly<{
  bytes: Uint8Array;
  digest: Sha256Digest;
}>;

export type FingerprintReadContext<K extends ToolName> = Readonly<{
  runner: RootBoundGitRunner;
  authority: TransactionAuthority;
  state: CanonicalDocument<TaskStateV1>;
  call: Extract<ParsedToolCall, { readonly name: K }>;
  live_config: LiveConfigSnapshot;
  context: RepositoryOperationContext;
}>;

export type ConfigReadResult =
  | Readonly<{ kind: "valid"; snapshot: LiveConfigSnapshot }>
  | Readonly<{ kind: "missing" | "unreadable" | "invalid" }>;

const stateValidator = createJsonSchemaValidator<TaskStateV1>(taskStateSchema, [
  primitivesSchema,
  pathClaimSchema,
]);
const decoder = new TextDecoder("utf-8", { fatal: true });

function errnoOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function readBytes(path: ResolvedPath): Promise<Readonly<{ kind: "bytes"; bytes: Uint8Array }> | Readonly<{ kind: "missing" | "unreadable" }>> {
  let handle;
  try {
    handle = await openResolved(path.absolute, fsConstants.O_RDONLY);
    return Object.freeze({ kind: "bytes", bytes: new Uint8Array(await handle.readFile()) });
  } catch (error) {
    return Object.freeze({ kind: errnoOf(error) === "ENOENT" ? "missing" : "unreadable" });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readTaskState(path: ResolvedPath): Promise<StateReadResult> {
  if (path.path_class !== "task-state") throw new TypeError("readTaskState requires a task-state resolved path");
  const read = await readBytes(path);
  if (read.kind !== "bytes") return read;
  try {
    const document = parseCanonicalDocument<TaskStateV1>(read.bytes, "task state");
    stateValidator.assert(document.value, "task state");
    return Object.freeze({ kind: "canonical", document });
  } catch {
    return Object.freeze({ kind: "noncanonical" });
  }
}

export async function readIntentReceipt(path: ResolvedPath): Promise<ReceiptReadResult> {
  if (path.path_class !== "intent") throw new TypeError("readIntentReceipt requires an intent resolved path");
  const read = await readBytes(path);
  if (read.kind !== "bytes") return read;
  try {
    const document = parseCanonicalDocument<IntentReceiptV1>(read.bytes, "intent receipt");
    parseIntentReceipt(document.value);
    return Object.freeze({ kind: "canonical", document });
  } catch {
    return Object.freeze({ kind: "noncanonical" });
  }
}

export async function readTaskConfig(path: ResolvedPath): Promise<ConfigReadResult> {
  if (path.path_class !== "task-config") throw new TypeError("readTaskConfig requires a task-config resolved path");
  const read = await readBytes(path);
  if (read.kind !== "bytes") return read;
  try {
    parseConfigYaml(decoder.decode(read.bytes), "task config");
    return Object.freeze({
      kind: "valid",
      snapshot: Object.freeze({ bytes: read.bytes, digest: sha256Bytes(read.bytes) }),
    });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}
