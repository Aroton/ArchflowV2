import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Bytes } from "../contracts/canonical.js";
import { parseConfigYaml } from "../contracts/config.js";
import type { LegacyImportInitializationV1, StagedPayloadRef } from "../contracts/durable-legacy-import.js";
import type { LiveConfigSnapshot } from "./read.js";
import type { TransactionAuthority } from "./authority.js";

function importRoot(authority: TransactionAuthority, initialization: LegacyImportInitializationV1): string {
  return join(authority.workspace_root, "cache", "imports", initialization.import_digest);
}

export async function readStagedLegacyConfig(
  authority: TransactionAuthority,
  initialization: LegacyImportInitializationV1,
): Promise<LiveConfigSnapshot | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(join(importRoot(authority, initialization), "config.yaml")));
    parseConfigYaml(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "staged task config");
    const digest = sha256Bytes(bytes);
    if (digest !== initialization.config_digest) return undefined;
    return Object.freeze({ bytes, digest });
  } catch {
    return undefined;
  }
}

export async function readStagedLegacyPayload(
  authority: TransactionAuthority,
  initialization: LegacyImportInitializationV1,
  reference: StagedPayloadRef,
): Promise<Uint8Array | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(join(importRoot(authority, initialization), "payload", reference.legacy_path)));
    if (bytes.byteLength !== reference.byte_count || sha256Bytes(bytes) !== reference.digest) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}
