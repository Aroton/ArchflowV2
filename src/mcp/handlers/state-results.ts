import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes, type GitOid } from "../../contracts/canonical.js";
import type { RepositoryName } from "../../contracts/config.js";
import type { DocumentArtifactV1 } from "../../contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../../contracts/durable-implementation-output.js";
import { parseResultManifest, type ResultManifestV1 } from "../../contracts/durable-result-manifest.js";
import type { AuthoritativeResultRef } from "../../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parseSafeInteger, type SafeId, type SafeInteger, type Sha256Digest } from "../../contracts/evidence.js";
import { parseTaskPathClaim, type RepositoryPathClaim } from "../../contracts/path-claims.js";
import { parseSecretScanResult, type SecretScanCandidate, type SecretScanResult, type SecretScanner } from "../../contracts/secret-scan.js";
import type { OutputEntry } from "../../contracts/durable-primitives.js";
import { hashGitBlobIdentity } from "../../repository/git.js";
import {
  parseWorkspacePathClaim,
  resolveDeclaredOutputPath,
  resolveRepositoryPath,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  resultAuthorityClaim,
  type ResolvedPath,
  type ResolvedTaskPath,
} from "../../repository/paths.js";
import type { TransactionAuthority } from "../../state/authority.js";
import { verifyImplementationManifest, verifyImplementationRepositorySection } from "../../state/implementation-manifest.js";
import type { RepositorySet } from "../../repository/repository-set.js";
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
import { phaseDocumentDefaults } from "../../state/phase-documents.js";

export type PreparedStateResult = Readonly<{
  reference: AuthoritativeResultRef;
  prepared: PreparedSnapshot;
  manifest_target: ResolvedPath;
  projection_plan: ProjectionPlan;
  secondary_projection_plans?: readonly Readonly<{
    repository: RepositoryName;
    repository_identity_digest: Sha256Digest;
    base_commit: GitOid;
    snapshot_digest: Sha256Digest;
    projection_plan: ProjectionPlan;
    worktree_root: ResolvedTaskPath;
  }>[];
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
  expectedClass: "authority-result" | "document",
) {
  return resolveTaskPath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: parseTaskPathClaim(claim),
    expectedClass,
    context: services.authority.context,
  });
}

async function payloadTarget(services: ProductionServices, resultDigest: string, path: RepositoryPathClaim, repository?: string) {
  return resolveTaskWorkspacePath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: parseWorkspacePathClaim(repository === undefined
      ? `cache/results/${resultDigest}/payload/${path}`
      : `cache/results/${resultDigest}/repositories/${repository}/payload/${path}`),
    expectedClass: "workspace-result-payload",
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
  repository_set?: RepositorySet;
}>): Promise<ProjectResult<PreparedStateResult>> {
  const canonicalDefaults = phaseDocumentDefaults(
    input.services.authority.task_id,
    input.artifact.phase_instance,
  );
  const allowedAdditionalPaths = new Set(canonicalDefaults?.additional_document_paths ?? []);
  const suppliedAdditionalPaths = (input.artifact.additional_documents ?? [])
    .map((document) => document.document_path);
  if (
    suppliedAdditionalPaths.some((path) => !allowedAdditionalPaths.has(path)) ||
    suppliedAdditionalPaths.some((path, index) => index > 0 && suppliedAdditionalPaths[index - 1]! >= path)
  ) {
    return contractInvalid("document-additional-documents-unauthorized");
  }
  const declaredDocuments = [{
    document_path: input.artifact.document_path,
    byte_count: input.artifact.byte_count,
    content_digest: input.artifact.content_digest,
    projection_target: input.artifact.projection_target,
  }, ...(input.artifact.additional_documents ?? [])]
    .sort((left, right) => left.projection_target < right.projection_target ? -1 : left.projection_target > right.projection_target ? 1 : 0);
  if (new Set(declaredDocuments.map((document) => document.projection_target)).size !== declaredDocuments.length) {
    return contractInvalid("document-projection-target-duplicate");
  }
  const observedDocuments = [];
  for (const document of declaredDocuments) {
    const documentTarget = await target(input.services, document.document_path, "document");
    if (!documentTarget.ok) return documentTarget;
    if (documentTarget.value.repositoryRelative !== document.projection_target) {
      return contractInvalid("document-projection-target-mismatch");
    }
    const captured = await captureProjectionTarget(documentTarget.value);
    if (captured.rollback.state !== "present" || captured.rollback.file_type !== "regular") {
      return contractInvalid("document-projection-not-regular-file");
    }
    const bytes = captured.rollback.bytes;
    if (bytes.byteLength !== document.byte_count || sha256Bytes(bytes) !== document.content_digest) {
      return contractInvalid("document-content-mismatch");
    }
    const identity = await hashGitBlobIdentity(input.services.runner, bytes, document.projection_target);
    const output: OutputEntry = Object.freeze({
      path: document.projection_target,
      path_class: "document" as const,
      operation: "add" as const,
      storage: "raw-payload" as const,
      payload_bytes: parseSafeInteger(bytes.byteLength),
      payload_digest: sha256Bytes(bytes),
      file_type: "regular" as const,
      after: Object.freeze({
        oid: parseGitOid(identity.oid),
        mode: "100644" as const,
        size_bytes: parseSafeInteger(identity.size_bytes),
      }),
    });
    observedDocuments.push(Object.freeze({ documentTarget: documentTarget.value, captured, bytes, output }));
  }
  const outputs = Object.freeze(observedDocuments.map((document) => document.output));
  const projections = Object.freeze(outputs.map((output) => Object.freeze({
    path: output.path,
    content_digest: output.payload_digest,
  })));
  if (deriveDeclaredSnapshotDigest(outputs, projections) !== input.artifact.snapshot_digest) {
    return contractInvalid("document-snapshot-digest-mismatch");
  }
  const capture = scannerCapture(input.scanner);
  const plan = await prepareProjectionPlan(observedDocuments.map((document) => ({
    path: document.output.path,
    target: document.documentTarget,
    desired: { state: "present", file_type: "regular", mode: "100644", bytes: document.bytes },
    authenticated_before: document.captured.observation,
    rollback: document.captured.rollback,
    git_tracked: true,
  })), capture.scanner, input.services.runner.location.worktreeRoot as ResolvedTaskPath);
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
    outputs,
    projections,
    accounting: accounting(outputs, input.retained_task_bytes, input.measured_at_revision),
    secret_scan: capture.result(),
  };
  const manifest = canonicalDocument(manifestValue);
  const manifestTarget = await target(input.services, resultAuthorityClaim(manifest.digest), "authority-result");
  if (!manifestTarget.ok) return manifestTarget;
  const payloads = [];
  for (const document of observedDocuments) {
    const payload = await payloadTarget(input.services, manifest.digest, document.output.path);
    if (!payload.ok) return payload;
    payloads.push({ path: document.output.path, bytes: document.bytes, target: payload.value });
  }
  const prepared = await prepareDocumentSnapshot({
    runner: input.services.runner,
    manifest: manifestValue,
    payloads,
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
  // Reject stale or caller-selected secondary bases before any manifest verification, payload
  // preparation, or retained-result work. RepositorySet HEAD is the authenticated submission base.
  const repositorySet = input.services.repository_set;
  const secondarySections = input.artifact.secondary_repositories ?? [];
  const writableMembers = repositorySet?.members.filter((member, index) => index > 0 && member.mode === "writable") ?? [];
  if (secondarySections.length !== writableMembers.length ||
      secondarySections.some((section, index) => section.repository !== writableMembers[index]?.name)) {
    return contractInvalid("implementation-secondary-repository-set-mismatch");
  }
  if (secondarySections.some((section, index) => section.base_commit !== writableMembers[index]?.head)) {
    return contractInvalid("implementation-secondary-base-commit-mismatch");
  }
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
  const secondaryPrepared: Array<{
    repository: typeof secondarySections[number]["repository"];
    repository_identity_digest: typeof secondarySections[number]["repository_identity_digest"];
    base_commit: typeof secondarySections[number]["base_commit"];
    snapshot_digest: typeof secondarySections[number]["snapshot_digest"];
    projection_plan: ProjectionPlan;
    worktree_root: ResolvedTaskPath;
    projections: ResultManifestV1["projections"];
    raw_payloads: ReadonlyMap<RepositoryPathClaim, Uint8Array>;
  }> = [];
  for (let index = 0; index < secondarySections.length; index += 1) {
    const section = secondarySections[index]!;
    const member = writableMembers[index]!;
    const sectionFacts = await verifyImplementationRepositorySection(input.services.authority, member, section);
    const sectionSources: ProjectionSource[] = [];
    const addSecondarySource = async (
      path: RepositoryPathClaim,
      desired: ProjectionDesired,
      tracked: boolean,
      renamePair?: ProjectionSource["rename_pair"],
    ): Promise<ProjectResult<void>> => {
      const resolved = await resolveRepositoryPath({
        runner: member.binding.runner, claim: path, context: input.services.authority.context,
      });
      if (!resolved.ok) return resolved;
      const captured = await captureProjectionTarget(resolved.value);
      sectionSources.push(Object.freeze({
        path, target: resolved.value, desired, authenticated_before: captured.observation,
        rollback: captured.rollback, git_tracked: tracked,
        ...(renamePair === undefined ? {} : { rename_pair: renamePair }),
      }));
      return ok(undefined);
    };
    for (const output of section.outputs) {
      if (output.operation === "rename") {
        const added = await addSecondarySource(output.previous_path, { state: "absent" }, true, {
          role: "source", peer_path: output.path,
        });
        if (!added.ok) return added;
      }
      if (output.operation === "delete") {
        const added = await addSecondarySource(output.path, { state: "absent" }, true);
        if (!added.ok) return added;
        continue;
      }
      const resolved = await resolveRepositoryPath({
        runner: member.binding.runner, claim: output.path, context: input.services.authority.context,
      });
      if (!resolved.ok) return resolved;
      const captured = await captureProjectionTarget(resolved.value);
      const bytes = sectionFacts.raw_payloads.get(output.path) ??
        (captured.rollback.state === "present" ? captured.rollback.bytes : undefined);
      if (bytes === undefined) return contractInvalid("implementation-secondary-after-image-unavailable");
      const desired: ProjectionDesired = output.file_type === "regular"
        ? { state: "present", file_type: "regular", mode: output.after.mode as "100644" | "100755", bytes }
        : { state: "present", file_type: "symlink", mode: "120000", bytes };
      const added = await addSecondarySource(output.path, desired, output.operation !== "add", output.operation === "rename"
        ? { role: "destination", peer_path: output.previous_path }
        : undefined);
      if (!added.ok) return added;
    }
    const sectionPlan = await prepareProjectionPlan(
      sectionSources, input.scanner, member.binding.runner.location.worktreeRoot as ResolvedTaskPath,
    );
    if (!sectionPlan.ok) return sectionPlan;
    const snapshotByPath = new Map(sectionFacts.snapshot_entries.map((entry) => [entry.path, entry]));
    const sectionProjections: ResultManifestV1["projections"][number][] = [];
    for (const output of section.outputs) {
      if (output.operation === "delete") continue;
      const observed = snapshotByPath.get(output.path);
      if (observed?.state !== "present") return contractInvalid("implementation-secondary-projection-identity-missing");
      sectionProjections.push(Object.freeze({ repository: section.repository, path: output.path, content_digest: observed.content_digest }));
    }
    secondaryPrepared.push({
      repository: section.repository, repository_identity_digest: section.repository_identity_digest,
      base_commit: section.base_commit, snapshot_digest: section.snapshot_digest,
      projection_plan: sectionPlan.value,
      worktree_root: member.binding.runner.location.worktreeRoot as ResolvedTaskPath,
      projections: Object.freeze(sectionProjections), raw_payloads: sectionFacts.raw_payloads,
    });
  }
  const changedSecondaryPrepared = secondaryPrepared.filter((entry) => entry.projection_plan.entries.length > 0);
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
    ...(changedSecondaryPrepared.length === 0 ? {} : {
      secondary_projections: Object.freeze(changedSecondaryPrepared.map((entry) => Object.freeze({
        repository: entry.repository,
        repository_identity_digest: entry.repository_identity_digest,
        projections: entry.projections,
      }))),
    }),
    accounting: input.artifact.accounting,
    secret_scan: input.artifact.secret_scan,
  };
  parseResultManifest(manifestValue);
  const manifest = canonicalDocument(manifestValue);
  const manifestTarget = await target(input.services, resultAuthorityClaim(manifest.digest), "authority-result");
  if (!manifestTarget.ok) return manifestTarget;
  const payloads = [];
  for (const [path, bytes] of facts.raw_payloads) {
    const targetResult = await payloadTarget(input.services, manifest.digest, path);
    if (!targetResult.ok) return targetResult;
    payloads.push(Object.freeze({ path, bytes, target: targetResult.value }));
  }
  for (const section of secondaryPrepared) {
    for (const [path, bytes] of section.raw_payloads) {
      const targetResult = await payloadTarget(input.services, manifest.digest, path, section.repository);
      if (!targetResult.ok) return targetResult;
      payloads.push(Object.freeze({ repository: section.repository, path, bytes, target: targetResult.value }));
    }
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
    }),
    prepared: prepared.value,
    manifest_target: manifestTarget.value,
    projection_plan: plan.value,
    ...(changedSecondaryPrepared.length === 0 ? {} : {
      secondary_projection_plans: Object.freeze(changedSecondaryPrepared.map((entry) => Object.freeze({
        repository: entry.repository,
        repository_identity_digest: entry.repository_identity_digest,
        base_commit: entry.base_commit,
        snapshot_digest: entry.snapshot_digest,
        projection_plan: entry.projection_plan,
        worktree_root: entry.worktree_root,
      }))),
    }),
  }));
}
