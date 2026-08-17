import { constants as fsConstants } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import {
  parseCanonicalDocument,
  sha256Bytes,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import { parseGateRequest } from "../contracts/durable-gate.js";
import { parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import {
  createPreparedIntentSubject,
  validateDurableSemantics,
} from "../contracts/durable.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import {
  gateRequestClaim,
  intentReceiptClaim,
  openResolved,
  resolveTaskWorkspacePath,
  resolveDeclaredOutputPath,
  resolveTaskPath,
  type ResolvedPath,
  type ResolvedWorkspacePath,
} from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import type { ReconciliationInput } from "./reconciliation.js";
import type { GateLifecycleDependencies } from "./gates.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const stateInvalid = (authority: TransactionAuthority, issueCode: string): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", {
      phase_instance: authority.context.phase_instance,
      issue_code: issueCode,
    }),
  });
const ioFailure = (authority: TransactionAuthority, operation: string): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }),
  });

async function readCanonical<T extends PlainJsonValue>(
  path: ResolvedPath | ResolvedWorkspacePath,
  label: string,
  parse: (value: unknown) => T,
): Promise<"missing" | "invalid" | CanonicalDocument<T>> {
  let handle;
  try {
    handle = await openResolved(path.absolute, fsConstants.O_RDONLY);
    const document = parseCanonicalDocument<T>(new Uint8Array(await handle.readFile()), label);
    parse(document.value);
    return document;
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? "missing" : "invalid";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function currentProjectionDigest(path: ResolvedPath): Promise<"missing" | ProjectionDigestRef["content_digest"]> {
  try {
    const metadata = await lstat(path.absolute);
    if (metadata.isSymbolicLink()) return sha256Bytes(Buffer.from(await readlink(path.absolute), "utf8"));
    if (!metadata.isFile()) throw new TypeError("projection is not a regular file or symlink");
    const handle = await openResolved(path.absolute, fsConstants.O_RDONLY);
    try {
      return sha256Bytes(new Uint8Array(await handle.readFile()));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return "missing";
    throw error;
  }
}

function outputClassFor(
  manifest: ResultManifestV1,
  path: ProjectionDigestRef["path"],
) {
  for (const output of manifest.outputs) {
    if (output.path === path || (output.operation === "rename" && output.previous_path === path)) {
      return output.path_class;
    }
  }
  return undefined;
}

async function discoverProjections(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
): Promise<ProjectResult<Readonly<{
  recorded: readonly ProjectionDigestRef[];
  current: readonly ProjectionDigestRef[];
}>>> {
  const loadManifest = dependencies.load_retained_manifest;
  if (loadManifest === undefined) {
    return stateInvalid(authority, "reconciliation-result-loader-unavailable");
  }
  const newest = new Map<ProjectionDigestRef["path"], Readonly<{
    projection: ProjectionDigestRef;
    measured_at_revision: number;
    target: ResolvedPath;
  }>>();
  try {
    for (const reference of state.value.authoritative_results) {
      const loaded = await loadManifest(reference);
      if (!loaded.ok) return loaded;
      const manifest = loaded.value.manifest.value;
      for (const projection of manifest.projections) {
        const pathClass = outputClassFor(manifest, projection.path);
        if (pathClass === undefined) return stateInvalid(authority, "reconciliation-projection-unbound");
        const target = await resolveDeclaredOutputPath({
          runner: dependencies.runner,
          taskId: authority.task_id,
          claim: projection.path,
          pathClass,
          context: authority.context,
        });
        if (!target.ok) return target;
        const candidate = Object.freeze({
          projection,
          measured_at_revision: manifest.accounting.measured_at_revision,
          target: target.value,
        });
        const prior = newest.get(projection.path);
        if (prior === undefined || candidate.measured_at_revision > prior.measured_at_revision) {
          newest.set(projection.path, candidate);
        }
      }
    }
    const recorded: ProjectionDigestRef[] = [];
    const current: ProjectionDigestRef[] = [];
    for (const candidate of [...newest.values()]
      .sort((left, right) => left.projection.path.localeCompare(right.projection.path))) {
      recorded.push(candidate.projection);
      const digest = await currentProjectionDigest(candidate.target);
      if (digest !== "missing") {
        current.push(Object.freeze({ path: candidate.projection.path, content_digest: digest }));
      }
    }
    return ok(Object.freeze({ recorded: Object.freeze(recorded), current: Object.freeze(current) }));
  } catch {
    return ioFailure(authority, "discover-reconciliation-projections");
  }
}

async function discoverGateHead(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
): Promise<ProjectResult<Readonly<{
  head?: NonNullable<ReconciliationInput["active_heads"]["gate"]>;
  blocker?: string;
}>>> {
  const open = state.value.open_gate;
  if (open === undefined) return ok(Object.freeze({}));
  const requestPath = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: gateRequestClaim(open.gate_id),
    expectedClass: "authority-decision",
    context: authority.context,
  });
  if (!requestPath.ok) return requestPath;
  const request = await readCanonical(requestPath.value, "gate request", parseGateRequest);
  if (request === "missing") return ok(Object.freeze({ blocker: "active-gate-request-missing" }));
  if (request === "invalid") return ok(Object.freeze({ blocker: "active-gate-request-invalid" }));
  try {
    if (request.value.gate_id !== open.gate_id ||
        request.value.subject_digest !== open.subject_digest ||
        request.value.context_digest !== open.context_digest) {
      return ok(Object.freeze({ blocker: "active-gate-request-mismatch" }));
    }
    return ok(Object.freeze({ head: Object.freeze({
      gate_id: request.value.gate_id,
      subject_digest: request.value.subject_digest,
      context_digest: request.value.context_digest,
    }) }));
  } catch {
    return ok(Object.freeze({ blocker: "active-gate-request-mismatch" }));
  }
}

async function discoverIntent(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
): Promise<ProjectResult<Readonly<{
  intent?: ReconciliationInput["intent"];
  blocker?: string;
}>>> {
  let names: string[];
  try {
    names = await readdir(join(authority.workspace_root, "transient", "intents"));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return ok(Object.freeze({}));
    return ioFailure(authority, "discover-reconciliation-intents");
  }
  const candidates: CanonicalDocument<IntentReceiptV1>[] = [];
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(name)) continue;
    // `.request.json` names are staged requests, a different path class in the same directory;
    // resolving one as an intent receipt would fail classification and abort discovery.
    if (name.endsWith(".request.json")) continue;
    const target = await resolveTaskWorkspacePath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: intentReceiptClaim(parsePathSafeId(name.slice(0, -5))),
      expectedClass: "workspace-intent",
      context: authority.context,
    });
    if (!target.ok) return target;
    const receipt = await readCanonical(target.value, "intent receipt", parseIntentReceipt);
    if (receipt === "missing" || receipt === "invalid") continue;
    if (receipt.value.prior_revision !== state.value.revision ||
        receipt.value.resulting_revision !== state.value.revision + 1 ||
        receipt.value.prepared_state.revision !== receipt.value.resulting_revision) continue;
    if (!validateDurableSemantics(createPreparedIntentSubject(state, receipt)).ok) continue;
    candidates.push(receipt);
  }
  if (candidates.length > 1) {
    return ok(Object.freeze({ blocker: "retained-receipt-ambiguity" }));
  }
  const receipt = candidates[0];
  return receipt === undefined
    ? ok(Object.freeze({}))
    : ok(Object.freeze({ intent: Object.freeze({ request_digest: receipt.value.request_digest, receipt }) }));
}

/** Discovers only the live authority needed by reconciliation; it never promotes or repairs it. */
export async function discoverReconciliationInput(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
): Promise<ProjectResult<ReconciliationInput>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const projections = await discoverProjections(dependencies, authority, state);
  if (!projections.ok) return projections;
  const gate = await discoverGateHead(dependencies, authority, state);
  if (!gate.ok) return gate;
  const intent = await discoverIntent(dependencies, authority, state);
  if (!intent.ok) return intent;
  const blockers = [gate.value.blocker, intent.value.blocker]
    .filter((value): value is string => value !== undefined);
  return ok(Object.freeze({
    state,
    recorded_projections: projections.value.recorded,
    current_projections: projections.value.current,
    active_heads: Object.freeze({
      ...(gate.value.head === undefined ? {} : { gate: gate.value.head }),
    }),
    ...(intent.value.intent === undefined ? {} : { intent: intent.value.intent }),
    ...(blockers.length === 0 ? {} : { blocking_reasons: Object.freeze(blockers) }),
  }));
}
