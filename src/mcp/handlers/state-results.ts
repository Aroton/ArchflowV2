import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../contracts/canonical.js";
import type { DocumentArtifactV1 } from "../../contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../../contracts/durable-implementation-output.js";
import { parseResultManifest, type ResultManifestV1 } from "../../contracts/durable-result-manifest.js";
import type { AuthoritativeResultRef } from "../../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parseSafeInteger, type SafeId, type SafeInteger } from "../../contracts/evidence.js";
import { parseTaskPathClaim, type RepositoryPathClaim } from "../../contracts/path-claims.js";
import { parseSecretScanResult, type SecretScanCandidate, type SecretScanResult, type SecretScanner } from "../../contracts/secret-scan.js";
import type { OutputEntry } from "../../contracts/durable-primitives.js";
import { hashGitBlobIdentity } from "../../repository/git.js";
import { resolveDeclaredOutputPath, resolveTaskPath, type ResolvedPath, type ResolvedTaskPath } from "../../repository/paths.js";
import type { TransactionAuthority } from "../../state/authority.js";
import { verifyImplementationManifest } from "../../state/implementation-manifest.js";
import {
  captureProjectionTarget,
  deriveDeclaredSnapshotDigest,
  prepareDocumentSnapshot,
  prepareProjectionPlan,
  prepareSnapshot,
  RESULT_BYTE_CAP,
  TASK_BYTE_CAP,
  type PreparedSnapshot,
  type ProjectionDesired,
  type ProjectionPlan,
  type ProjectionSource,
} from "../../state/snapshots.js";
import type { ProductionServices } from "../../state/production.js";

export type PreparedStateResult = Readonly<{
  reference: AuthoritativeResultRef;
  prepared: PreparedSnapshot;
  manifest_target: ResolvedPath;
  projection_plan: ProjectionPlan;
}>;

const ok = <T>(value: T) => Object.freeze({ schema_version: "1" as const, ok: true as const, value });
const contractInvalid = <T>(issueCode: string): ProjectResult<T> => Object.freeze({
  schema_version: "1",
  ok: false,
  error: createProjectError("CONTRACT_INVALID", {
    tool: "archflow_state",
    issue_code: issueCode,
  }),
});

async function target(
  services: ProductionServices,
  claim: string,
  expectedClass: "result-manifest" | "result-payload" | "document",
) {
  return resolveTaskPath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: parseTaskPathClaim(claim),
    expectedClass,
    context: services.authority.context,
  });
}

function scannerCapture(scanner: SecretScanner): Readonly<{
  scanner: SecretScanner;
  result: () => SecretScanResult;
}> {
  let observed: SecretScanResult | undefined;
  return {
    scanner: Object.freeze({
      scan: async (candidates: readonly SecretScanCandidate[]) => {
        observed = parseSecretScanResult(await scanner.scan(candidates));
        return observed;
      },
    }),
    result: () => {
      if (observed === undefined) throw new TypeError("projection scanner did not run");
      return observed;
    },
  };
}

function accounting(
  outputs: ResultManifestV1["outputs"],
  retained: SafeInteger,
  revision: SafeInteger,
): ResultManifestV1["accounting"] {
  const counted = outputs.flatMap((output) => output.storage === "raw-payload"
    ? [{ path: output.path, storage: "raw-payload" as const, stored_bytes: output.payload_bytes }]
    : []);
  const resultBytes = parseSafeInteger(counted.reduce((sum, entry) => sum + entry.stored_bytes, 0));
  return Object.freeze({
    schema_version: "1",
    result_bytes: resultBytes,
    task_bytes: parseSafeInteger(retained + resultBytes),
    result_byte_cap: 26_214_400,
    task_byte_cap: 262_144_000,
    counted_entries: Object.freeze(counted),
    measured_at_revision: revision,
  });
}

export async function prepareDocumentResult(input: Readonly<{
  services: ProductionServices;
  artifact: DocumentArtifactV1;
  result_id: SafeId;
  retained_task_bytes: SafeInteger;
  measured_at_revision: SafeInteger;
  scanner: SecretScanner;
}>): Promise<ProjectResult<PreparedStateResult>> {
  const documentTarget = await target(input.services, input.artifact.document_path, "document");
  if (!documentTarget.ok) return documentTarget;
  if (documentTarget.value.repositoryRelative !== input.artifact.projection_target) {
    return contractInvalid("document-projection-target-mismatch");
  }
  const captured = await captureProjectionTarget(documentTarget.value);
  if (captured.rollback.state !== "present" || captured.rollback.file_type !== "regular") {
    return contractInvalid("document-projection-not-regular-file");
  }
  const bytes = captured.rollback.bytes;
  if (bytes.byteLength !== input.artifact.byte_count || sha256Bytes(bytes) !== input.artifact.content_digest) {
    return contractInvalid("document-content-mismatch");
  }
  const identity = await hashGitBlobIdentity(input.services.runner, bytes, input.artifact.projection_target);
  const after = Object.freeze({
    oid: parseGitOid(identity.oid),
    mode: "100644" as const,
    size_bytes: parseSafeInteger(identity.size_bytes),
  });
  const output: OutputEntry = Object.freeze({
    path: input.artifact.projection_target,
    path_class: "document" as const,
    operation: "add" as const,
    storage: "raw-payload" as const,
    payload_bytes: parseSafeInteger(bytes.byteLength),
    payload_digest: sha256Bytes(bytes),
    file_type: "regular" as const,
    after,
  });
  const projections = Object.freeze([{ path: output.path, content_digest: output.payload_digest }]);
  if (deriveDeclaredSnapshotDigest([output], projections) !== input.artifact.snapshot_digest) {
    return contractInvalid("document-snapshot-digest-mismatch");
  }
  const capture = scannerCapture(input.scanner);
  const plan = await prepareProjectionPlan([{
    path: output.path,
    target: documentTarget.value,
    desired: { state: "present", file_type: "regular", mode: "100644", bytes },
    authenticated_before: captured.observation,
    rollback: captured.rollback,
    git_tracked: true,
  }], capture.scanner, input.services.runner.location.worktreeRoot as ResolvedTaskPath);
  if (!plan.ok) return plan;
  const manifestValue: ResultManifestV1 = {
    schema_version: "1",
    task_id: input.services.authority.task_id,
    repository_identity_digest: input.services.authority.repository_identity_digest,
    result_id: input.result_id,
    phase_instance: input.artifact.phase_instance,
    step: input.artifact.step,
    artifact_digest: canonicalJsonDigest(input.artifact),
    source_artifact: input.artifact,
    input_fingerprint: input.artifact.input_fingerprint,
    snapshot_digest: input.artifact.snapshot_digest,
    outputs: [output],
    projections,
    accounting: accounting([output], input.retained_task_bytes, input.measured_at_revision),
    secret_scan: capture.result(),
  };
  const manifest = canonicalDocument(manifestValue);
  const manifestTarget = await target(input.services, `results/sha256/${manifest.digest}/manifest.json`, "result-manifest");
  const payloadTarget = await target(input.services, `results/sha256/${manifest.digest}/payload/${output.path}`, "result-payload");
  if (!manifestTarget.ok) return manifestTarget;
  if (!payloadTarget.ok) return payloadTarget;
  const prepared = await prepareDocumentSnapshot({
    runner: input.services.runner,
    manifest: manifestValue,
    payloads: [{ path: output.path, bytes, target: payloadTarget.value }],
    retained_task_bytes: input.retained_task_bytes,
  });
  if (!prepared.ok) return prepared;
  return ok(Object.freeze({
    reference: Object.freeze({
      phase_instance: input.artifact.phase_instance,
      step: input.artifact.step,
      result_digest: prepared.value.result_digest,
      result_id: input.result_id,
      input_fingerprint: input.artifact.input_fingerprint,
      manifest_path: manifestTarget.value.repositoryRelative,
    }),
    prepared: prepared.value,
    manifest_target: manifestTarget.value,
    projection_plan: plan.value,
  }));
}

export async function prepareImplementationResult(input: Readonly<{
  services: ProductionServices;
  artifact: ImplementationOutputV1;
  result_id: SafeId;
  retained_task_bytes: SafeInteger;
  measured_at_revision: SafeInteger;
  scanner: SecretScanner;
}>): Promise<ProjectResult<PreparedStateResult>> {
  const facts = await verifyImplementationManifest(
    input.services.runner,
    input.artifact,
    input.services.authority.context,
  );
  const sources: ProjectionSource[] = [];
  const addSource = async (
    path: RepositoryPathClaim,
    pathClass: ImplementationOutputV1["outputs"][number]["path_class"],
    desired: ProjectionDesired,
    tracked: boolean,
    renamePair?: ProjectionSource["rename_pair"],
  ) => {
    const resolved = await resolveDeclaredOutputPath({
      runner: input.services.runner,
      taskId: input.services.authority.task_id,
      claim: path,
      pathClass,
      context: input.services.authority.context,
    });
    if (!resolved.ok) throw resolved.error;
    const captured = await captureProjectionTarget(resolved.value);
    sources.push(Object.freeze({
      path,
      target: resolved.value,
      desired,
      authenticated_before: captured.observation,
      rollback: captured.rollback,
      git_tracked: tracked,
      ...(renamePair === undefined ? {} : { rename_pair: renamePair }),
    }));
  };
  for (const output of input.artifact.outputs) {
    if (output.operation === "rename") {
      await addSource(output.previous_path, output.path_class, { state: "absent" }, true, {
        role: "source", peer_path: output.path,
      });
    }
    if (output.operation === "delete") {
      await addSource(output.path, output.path_class, { state: "absent" }, true);
      continue;
    }
    const raw = facts.raw_payloads.get(output.path);
    const resolved = await resolveDeclaredOutputPath({
      runner: input.services.runner,
      taskId: input.services.authority.task_id,
      claim: output.path,
      pathClass: output.path_class,
      context: input.services.authority.context,
    });
    if (!resolved.ok) return resolved;
    const captured = await captureProjectionTarget(resolved.value);
    const bytes = raw ?? (captured.rollback.state === "present" ? captured.rollback.bytes : undefined);
    if (bytes === undefined) return contractInvalid("implementation-after-image-unavailable");
    const desired: ProjectionDesired = output.file_type === "regular"
      ? { state: "present", file_type: "regular", mode: output.after.mode as "100644" | "100755", bytes }
      : { state: "present", file_type: "symlink", mode: "120000", bytes };
    await addSource(output.path, output.path_class, desired, output.operation !== "add", output.operation === "rename" ? {
      role: "destination", peer_path: output.previous_path,
    } : undefined);
  }
  const capture = scannerCapture(input.scanner);
  const plan = await prepareProjectionPlan(
    sources,
    capture.scanner,
    input.services.runner.location.worktreeRoot as ResolvedTaskPath,
  );
  if (!plan.ok) return plan;
  const snapshotByPath = new Map(facts.snapshot_entries.map((entry) => [entry.path, entry]));
  const projections = [];
  for (const output of input.artifact.outputs) {
    if (output.operation === "delete") continue;
    const observed = snapshotByPath.get(output.path);
    if (observed?.state !== "present") return contractInvalid("implementation-projection-identity-missing");
    projections.push({ path: output.path, content_digest: observed.content_digest });
  }
  const manifestValue: ResultManifestV1 = {
    schema_version: "1",
    task_id: input.services.authority.task_id,
    repository_identity_digest: input.services.authority.repository_identity_digest,
    result_id: input.result_id,
    phase_instance: input.artifact.phase_instance,
    step: input.artifact.step,
    artifact_digest: canonicalJsonDigest(input.artifact),
    source_artifact: input.artifact,
    input_fingerprint: input.artifact.input_fingerprint,
    snapshot_digest: input.artifact.snapshot_digest,
    outputs: input.artifact.outputs,
    projections,
    accounting: input.artifact.accounting,
    secret_scan: input.artifact.secret_scan,
  };
  parseResultManifest(manifestValue);
  const manifest = canonicalDocument(manifestValue);
  const manifestTarget = await target(input.services, `results/sha256/${manifest.digest}/manifest.json`, "result-manifest");
  if (!manifestTarget.ok) return manifestTarget;
  const payloads = [];
  for (const [path, bytes] of facts.raw_payloads) {
    const payloadTarget = await target(input.services, `results/sha256/${manifest.digest}/payload/${path}`, "result-payload");
    if (!payloadTarget.ok) return payloadTarget;
    payloads.push(Object.freeze({ path, bytes, target: payloadTarget.value }));
  }
  const prepared = prepareSnapshot({
    manifest: manifestValue,
    payloads,
    retained_task_bytes: input.retained_task_bytes,
    validate_manifest: parseResultManifest,
  });
  if (!prepared.ok) return prepared;
  return ok(Object.freeze({
    reference: Object.freeze({
      phase_instance: input.artifact.phase_instance,
      step: input.artifact.step,
      result_digest: prepared.value.result_digest,
      result_id: input.result_id,
      input_fingerprint: input.artifact.input_fingerprint,
      manifest_path: manifestTarget.value.repositoryRelative,
    }),
    prepared: prepared.value,
    manifest_target: manifestTarget.value,
    projection_plan: plan.value,
  }));
}

