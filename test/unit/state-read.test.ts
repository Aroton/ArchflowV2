import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseRepositoryPathClaim, type PathClass } from "../../src/contracts/path-claims.js";
import {
  parseWorkspacePathClaim,
  type ResolvedPath,
  type ResolvedTaskPath,
  type ResolvedTaskWorkspacePath,
  type ResolvedWorkspacePath,
} from "../../src/repository/paths.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "../../src/state/read.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archflow-state-read-"));
  roots.push(root);
  return root;
}

function resolved(absolute: string, pathClass: PathClass): ResolvedPath {
  return Object.freeze({
    path_class: pathClass,
    repositoryRelative: parseRepositoryPathClaim(".archflow/tasks/demo/value"),
    absolute: absolute as ResolvedTaskPath,
  });
}

function workspaceResolved(absolute: string): ResolvedWorkspacePath {
  return Object.freeze({
    path_class: "workspace-intent",
    workspaceRelative: parseWorkspacePathClaim("transient/intents/intent-1.json"),
    repositoryRelative: parseRepositoryPathClaim(".archflow/work/tasks/demo/transient/intents/intent-1.json"),
    absolute: absolute as ResolvedTaskWorkspacePath,
  });
}

async function validState(): Promise<TaskStateV1> {
  return JSON.parse(await readFile(new URL("../fixtures/contracts/durable/task-state.valid.json", import.meta.url), "utf8")) as TaskStateV1;
}

describe("canonical state and receipt readers", () => {
  it("returns canonical validated state and exact immutable-receipt documents", async () => {
    const root = await temporaryRoot();
    const state = await validState();
    const statePath = join(root, "state.json");
    await writeFile(statePath, canonicalJsonBytes(state));
    const stateRead = await readTaskState(resolved(statePath, "task-state"));
    expect(stateRead.kind).toBe("canonical");
    if (stateRead.kind !== "canonical") return;
    expect(stateRead.document.value).toEqual(state);
    expect(stateRead.document.bytes).toEqual(canonicalJsonBytes(state));

    const { last_transition: _transition, ...prepared } = state;
    const outcome = { path: "state.json", revision: prepared.revision, status: prepared.status };
    const receipt: IntentReceiptV1 = {
      schema_version: "1",
      intent_id: "intent-1" as IntentReceiptV1["intent_id"],
      task_id: prepared.task_id,
      repository_identity_digest: prepared.repository_identity_digest,
      tool: "archflow_state",
      operation: "record-state-boundary" as IntentReceiptV1["operation"],
      request_digest: "a".repeat(64) as IntentReceiptV1["request_digest"],
      input_fingerprint: prepared.input_fingerprint,
      prior_revision: (prepared.revision - 1) as IntentReceiptV1["prior_revision"],
      resulting_revision: prepared.revision,
      result_id: "result-1" as IntentReceiptV1["result_id"],
      outcome_digest: canonicalJsonDigest(outcome),
      outcome,
      prepared_state_digest: canonicalJsonDigest(prepared),
      prepared_state: prepared,
    };
    const receiptPath = join(root, "intent-1.json");
    await writeFile(receiptPath, canonicalJsonBytes(receipt));
    const receiptRead = await readIntentReceipt(workspaceResolved(receiptPath));
    expect(receiptRead.kind).toBe("canonical");
    if (receiptRead.kind === "canonical") expect(receiptRead.document.value).toEqual(receipt);
  });

  it("classifies missing, unreadable, noncanonical bytes, and canonical structural failures", async () => {
    const root = await temporaryRoot();
    expect(await readTaskState(resolved(join(root, "missing.json"), "task-state"))).toEqual({ kind: "missing" });

    const directory = join(root, "directory");
    await mkdir(directory);
    expect(await readTaskState(resolved(directory, "task-state"))).toEqual({ kind: "unreadable" });

    const malformed = join(root, "malformed.json");
    await writeFile(malformed, "not json\n");
    expect(await readTaskState(resolved(malformed, "task-state"))).toEqual({ kind: "noncanonical" });

    const structurallyInvalid = join(root, "invalid.json");
    await writeFile(structurallyInvalid, canonicalJsonBytes({ schema_version: "1" }));
    expect(await readTaskState(resolved(structurallyInvalid, "task-state"))).toEqual({ kind: "noncanonical" });
    expect(await readIntentReceipt(workspaceResolved(structurallyInvalid))).toEqual({ kind: "noncanonical" });
  });

  it("rejects path-class substitution before I/O", async () => {
    const root = await temporaryRoot();
    await expect(readTaskState(workspaceResolved(join(root, "missing")) as never)).rejects.toThrow(/task-state/u);
    await expect(readIntentReceipt(resolved(join(root, "missing"), "task-state") as never)).rejects.toThrow(/workspace-intent resolved/u);
  });
});

describe("task config reader", () => {
  it("returns exact bytes and their digest only after UTF-8/YAML/schema validation", async () => {
    const root = await temporaryRoot();
    const path = join(root, "config.yaml");
    const bytes = new TextEncoder().encode('schema_version: "1"\nroles: {}\n');
    await writeFile(path, bytes);
    const result = await readTaskConfig(resolved(path, "task-config"));
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.snapshot.bytes).toEqual(bytes);
    expect(result.snapshot.digest).toBe(sha256Bytes(bytes));
  });

  it("classifies missing, unreadable, malformed UTF-8, and invalid config without diagnostics", async () => {
    const root = await temporaryRoot();
    expect(await readTaskConfig(resolved(join(root, "missing.yaml"), "task-config"))).toEqual({ kind: "missing" });
    const directory = join(root, "directory");
    await mkdir(directory);
    expect(await readTaskConfig(resolved(directory, "task-config"))).toEqual({ kind: "unreadable" });
    const malformed = join(root, "malformed.yaml");
    await writeFile(malformed, Uint8Array.from([0xc3, 0x28]));
    expect(await readTaskConfig(resolved(malformed, "task-config"))).toEqual({ kind: "invalid" });
    const invalid = join(root, "invalid.yaml");
    await writeFile(invalid, "schema_version: '1'\nroles:\n  producer:\n    model: ''\n    effort: low\n");
    expect(await readTaskConfig(resolved(invalid, "task-config"))).toEqual({ kind: "invalid" });
    await expect(readTaskConfig(resolved(invalid, "task-state"))).rejects.toThrow(/task-config/u);
  });
});
