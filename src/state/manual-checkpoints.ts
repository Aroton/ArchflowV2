import { constants as fsConstants } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalDocument,
  parseCanonicalDocument,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import {
  checkpointSelfDigest,
  parseManualCheckpoint,
  type ManualCheckpointV1,
} from "../contracts/durable-checkpoint.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { CheckpointChainEvidence } from "../repository/handoff.js";
import { openResolved, resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import { ensureManualCheckpointDirectory } from "./layout.js";
import type { TransactionDependencies } from "./transaction.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const ioFailure = (authority: TransactionAuthority, operation: string): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }),
  });

/** Installs a canonical checkpoint exactly once at its digest-addressed manual path. */
export async function writeManualCheckpoint(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  checkpoint: ManualCheckpointV1,
): Promise<ProjectResult<CanonicalDocument<ManualCheckpointV1>>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const parsed = parseManualCheckpoint(checkpoint);
  if (parsed.task_id !== authority.task_id ||
      parsed.repository_identity_digest !== authority.repository_identity_digest) {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("STATE_INVALID", {
        phase_instance: authority.context.phase_instance,
        issue_code: "manual-checkpoint-authority-mismatch",
      }),
    });
  }
  const digest = checkpointSelfDigest(parsed);
  const target = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: parseTaskPathClaim(`manual/checkpoints/${parsed.revision}-${digest}.json`),
    expectedClass: "manual-checkpoint",
    context: authority.context,
  });
  if (!target.ok) return target;
  const document = canonicalDocument(parsed);
  try {
    await ensureManualCheckpointDirectory(authority);
    const installed = await dependencies.atomic.createExclusive(target.value, document.bytes);
    if (installed === "exists") {
      const handle = await openResolved(target.value.absolute, fsConstants.O_RDONLY);
      try {
        const existing = new Uint8Array(await handle.readFile());
        if (!Buffer.from(existing).equals(Buffer.from(document.bytes))) {
          return Object.freeze({
            schema_version: "1",
            ok: false,
            error: createProjectError("STATE_INVALID", {
              phase_instance: authority.context.phase_instance,
              issue_code: "manual-checkpoint-address-disagreement",
            }),
          });
        }
      } finally {
        await handle.close();
      }
    }
    return ok(document);
  } catch {
    return ioFailure(authority, "write-manual-checkpoint");
  }
}

/** Reads every canonical checkpoint from the fixed manual directory, sorted by revision and digest. */
export async function readManualCheckpoints(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<CheckpointChainEvidence>> {
  assertInternalTransactionAuthority(authority, dependencies);
  let names: string[];
  try {
    names = await readdir(join(authority.task_root, "manual", "checkpoints"));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return ok(Object.freeze([]));
    return ioFailure(authority, "read-manual-checkpoints");
  }
  const documents: CanonicalDocument<ManualCheckpointV1>[] = [];
  for (const name of names.sort()) {
    if (!/^(?:0|[1-9][0-9]*)-[0-9a-f]{64}\.json$/u.test(name)) {
      return Object.freeze({
        schema_version: "1",
        ok: false,
        error: createProjectError("STATE_INVALID", {
          phase_instance: authority.context.phase_instance,
          issue_code: "manual-checkpoint-inventory-invalid",
        }),
      });
    }
    const target = await resolveTaskPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parseTaskPathClaim(`manual/checkpoints/${name}`),
      expectedClass: "manual-checkpoint",
      context: authority.context,
    });
    if (!target.ok) return target;
    try {
      const handle = await openResolved(target.value.absolute, fsConstants.O_RDONLY);
      try {
        const document = parseCanonicalDocument<ManualCheckpointV1>(
          new Uint8Array(await handle.readFile()),
          "manual checkpoint",
        );
        const checkpoint = parseManualCheckpoint(document.value);
        const expectedName = `${checkpoint.revision}-${checkpointSelfDigest(checkpoint)}.json`;
        if (name !== expectedName || checkpoint.task_id !== authority.task_id ||
            checkpoint.repository_identity_digest !== authority.repository_identity_digest) {
          throw new TypeError("manual checkpoint authority mismatch");
        }
        documents.push(document);
      } finally {
        await handle.close();
      }
    } catch {
      return Object.freeze({
        schema_version: "1",
        ok: false,
        error: createProjectError("STATE_INVALID", {
          phase_instance: authority.context.phase_instance,
          issue_code: "manual-checkpoint-invalid",
        }),
      });
    }
  }
  documents.sort((left, right) => left.value.revision - right.value.revision || left.digest.localeCompare(right.digest));
  return ok(Object.freeze(documents));
}
