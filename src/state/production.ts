import { sha256Bytes, type CanonicalDocument } from "../contracts/canonical.js";
import { lstat, readFile, readlink } from "node:fs/promises";
import type { BlobIdentity, OutputEntry } from "../contracts/durable-primitives.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger, type SafeCode, type SafeInteger, type TaskSlug } from "../contracts/evidence.js";
import { parseToolCall } from "../contracts/mcp-tools.js";
import { parseRepositoryPathClaim, parseTaskPathClaim, type RepositoryPathClaim } from "../contracts/path-claims.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { SecretScanner } from "../contracts/secret-scan.js";
import type { GitEnvironment, RepositoryOperationContext } from "../repository/git.js";
import { readGitBlobBytes, readGitBlobProjectedBytes } from "../repository/git.js";
import { type RootBoundGitRunner } from "../repository/identity.js";
import { openRepository, resolveRepositorySet } from "../repository/repository-set.js";
import type { RepositorySet } from "../repository/repository-set.js";
import type { RepositoryName } from "../contracts/config.js";
import {
  parseWorkspacePathClaim,
  resolveDeclaredOutputPath,
  resolveRepositoryPath,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  resultAuthorityClaim,
  type ResolvedPath,
  type ResolvedTaskPath,
  type ResolvedWorkspacePath,
} from "../repository/paths.js";
import { createAtomicWriter, createProjectionWriter, type AtomicWriter } from "./atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { createProductionInputFingerprintResolver } from "./fingerprint-readers.js";
import type { GateLifecycleDependencies } from "./gates.js";
import { createTaskLock } from "./lock.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "./read.js";
import { createSecretlintScanner } from "./secret-scan.js";
import {
  prepareProjectionPlan,
  captureProjectionTarget,
  readSnapshot,
  readSnapshotPayload,
  restoreSnapshotOutput,
  type PreparedSnapshot,
  type ProjectionDesired,
  type ProjectionObservation,
  type ProjectionSource,
} from "./snapshots.js";
import type { RetainedManifest, RetainedResultInstallation } from "./transaction.js";
import { retainedResultReferences } from "./retained-result-graph.js";

export type ProductionServices = Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  authority: TransactionAuthority;
  state?: CanonicalDocument<TaskStateV1>;
  dependencies: GateLifecycleDependencies;
  /** Present on authenticated handler sessions after task config repository-set resolution. */
  repository_set?: RepositorySet;
}>;

export type ProductionInput = Readonly<{
  working_directory: string;
  task_id: TaskSlug;
  operation: SafeCode;
  phase_instance?: PhaseInstanceId;
  atomic?: AtomicWriter;
  gate_secret_scanner?: SecretScanner;
}>;

/** Exact retained payload contribution of one authenticated result manifest. */
export function retainedManifestStoredBytes(manifest: ResultManifestV1): SafeInteger {
  let total: number = manifest.accounting.result_bytes;
  if (manifest.source_artifact.artifact_kind === "implementation-output") {
    total += (manifest.source_artifact.secondary_repositories ?? [])
      .reduce((sum, section) => sum + section.accounting.result_bytes, 0);
  }
  return parseSafeInteger(total);
}

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

function context(input: ProductionInput, phase: PhaseInstanceId, attempt: SafeInteger): RepositoryOperationContext {
  return Object.freeze({ task_id: input.task_id, phase_instance: phase, operation: input.operation, attempt });
}

function stateFailure(phase: PhaseInstanceId, issue: string): ProjectResult<never> {
  return fail(createProjectError("STATE_INVALID", { phase_instance: phase, issue_code: issue as SafeCode }));
}

async function resolvePath(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  claim: ReturnType<typeof parseTaskPathClaim>,
  expectedClass?: Parameters<typeof resolveTaskPath>[0]["expectedClass"],
): Promise<ProjectResult<ResolvedPath>> {
  return resolveTaskPath({
    runner,
    taskId: authority.task_id,
    claim,
    ...(expectedClass === undefined ? {} : { expectedClass }),
    context: authority.context,
  });
}

/**
 * Reloads and re-authenticates one retained manifest, without its payload bytes.
 *
 * `readSnapshot` re-proves the manifest against its own digest, its declared semantics, and the Git
 * objects it names, so what this returns is as authenticated as the full installation below. It is
 * the right entry point for readers that only interrogate the manifest — status derivation, evidence
 * correlation, upstream ownership, byte accounting — none of which touch payload bytes or project
 * anything. The full load costs a secret scan and a Git round trip per output on top of this.
 */
export async function readRetainedManifest(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  reference: TaskStateV1["authoritative_results"][number],
): Promise<ProjectResult<RetainedManifest>> {
  const manifestTarget = await resolvePath(
    runner,
    authority,
    resultAuthorityClaim(reference.result_digest),
    "authority-result",
  );
  if (!manifestTarget.ok) return manifestTarget;
  const read = await readSnapshot({
    target: manifestTarget.value,
    expected_result_digest: reference.result_digest,
    runner,
    worktree_root: runner.location.worktreeRoot as ResolvedTaskPath,
  });
  if (!read.ok) return read;
  const manifest = read.value.value;
  if (
    manifest.result_id !== reference.result_id ||
    manifest.phase_instance !== reference.phase_instance ||
    manifest.step !== reference.step ||
    manifest.input_fingerprint !== reference.input_fingerprint
  ) return stateFailure(authority.context.phase_instance, "retained-result-reference-mismatch");
  return ok(Object.freeze({ manifest: read.value, manifest_target: manifestTarget.value }));
}

async function beforeImageForRunner(
  runner: RootBoundGitRunner,
  identity: BlobIdentity,
  path: RepositoryPathClaim,
): Promise<Readonly<{ observation: ProjectionObservation; desired: ProjectionDesired }>> {
  const symlink = identity.mode === "120000";
  const bytes = symlink
    ? await readGitBlobBytes(runner, identity.oid)
    : await readGitBlobProjectedBytes(runner, identity.oid, path);
  const observation: ProjectionObservation = Object.freeze({
    state: "present", file_type: symlink ? "symlink" : "regular", mode: identity.mode,
    size_bytes: bytes.byteLength, content_digest: sha256Bytes(bytes),
  });
  const desired: ProjectionDesired = symlink
    ? Object.freeze({ state: "present", file_type: "symlink", mode: "120000", bytes })
    : Object.freeze({ state: "present", file_type: "regular", mode: identity.mode, bytes });
  return Object.freeze({ observation, desired });
}

export async function readRetainedResult(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  reference: TaskStateV1["authoritative_results"][number],
  repositorySet?: RepositorySet,
): Promise<ProjectResult<RetainedResultInstallation>> {
  const loaded = await readRetainedManifest(runner, authority, reference);
  if (!loaded.ok) return loaded;
  const manifestDocument = loaded.value.manifest;
  const manifestTarget = loaded.value.manifest_target;
  const manifest = manifestDocument.value;

  const payloads: PreparedSnapshot["payloads"][number][] = [];
  const payloadTargets = new Map<RepositoryPathClaim, ResolvedWorkspacePath>();
  const payloadBytes = new Map<RepositoryPathClaim, Uint8Array>();
  for (const output of manifest.outputs) {
    if (output.storage !== "raw-payload") continue;
    const payloadTarget = await resolveTaskWorkspacePath({
      runner,
      taskId: authority.task_id,
      claim: parseWorkspacePathClaim(`cache/results/${reference.result_digest}/payload/${output.path}`),
      expectedClass: "workspace-result-payload",
      context: authority.context,
    });
    if (!payloadTarget.ok) return payloadTarget;
    let bytes = await readSnapshotPayload({
      target: payloadTarget.value,
      expected_digest: output.payload_digest,
      expected_bytes: output.payload_bytes,
      snapshot_digest: manifest.snapshot_digest,
      worktree_root: runner.location.worktreeRoot as ResolvedTaskPath,
    });
    if (!bytes.ok) {
      try {
        const projection = await resolveDeclaredOutputPath({
          runner,
          taskId: authority.task_id,
          claim: output.path,
          pathClass: output.path_class,
          context: authority.context,
        });
        let restored: Uint8Array | undefined;
        if (projection.ok) {
          try {
            const metadata = await lstat(projection.value.absolute);
            restored = metadata.isSymbolicLink()
              ? Buffer.from(await readlink(projection.value.absolute), "utf8")
              : metadata.isFile()
                ? new Uint8Array(await readFile(projection.value.absolute))
                : undefined;
            if (restored !== undefined &&
                (restored.byteLength !== output.payload_bytes || sha256Bytes(restored) !== output.payload_digest)) {
              restored = undefined;
            }
          } catch {
            restored = undefined;
          }
        }
        restored ??= output.file_type === "symlink"
          ? await readGitBlobBytes(runner, output.after.oid)
          : await readGitBlobProjectedBytes(runner, output.after.oid, output.path);
        if (restored.byteLength !== output.payload_bytes || sha256Bytes(restored) !== output.payload_digest) {
          return bytes;
        }
        bytes = ok(restored);
      } catch {
        return stateFailure(authority.context.phase_instance, "active-result-cache-missing-rerun-required");
      }
    }
    if (!bytes.ok) return bytes;
    const retainedBytes = bytes.value;
    payloads.push(Object.freeze({ path: output.path, bytes: retainedBytes, target: payloadTarget.value }));
    payloadTargets.set(output.path, payloadTarget.value);
    payloadBytes.set(output.path, retainedBytes);
  }

  const resolveOutput = async (claim: RepositoryPathClaim, output?: OutputEntry): Promise<ProjectResult<ResolvedPath>> => {
    if (output !== undefined) {
      return resolveDeclaredOutputPath({
        runner, taskId: authority.task_id, claim, pathClass: output.path_class, context: authority.context,
      });
    }
    const prefix = `.archflow/tasks/${authority.task_id}/`;
    return claim.startsWith(prefix)
      ? resolveTaskPath({
          runner, taskId: authority.task_id, claim: parseTaskPathClaim(claim.slice(prefix.length)), context: authority.context,
        })
      : resolveRepositoryPath({ runner, claim, context: authority.context });
  };
  const beforeImage = async (
    identity: BlobIdentity,
    path: RepositoryPathClaim,
  ) => beforeImageForRunner(runner, identity, path);
  const sources: ProjectionSource[] = [];
  for (const output of manifest.outputs) {
    const target = await resolveOutput(output.path, output);
    if (!target.ok) return target;
    const cached = payloadBytes.get(output.path);
    if (cached !== undefined && output.operation === "delete") {
      return stateFailure(authority.context.phase_instance, "retained-result-payload-operation-mismatch");
    }
    const desired = cached === undefined
      ? await restoreSnapshotOutput({
          target: manifestTarget,
          expected_result_digest: reference.result_digest,
          runner,
          worktree_root: runner.location.worktreeRoot as ResolvedTaskPath,
          output_path: output.path,
        })
      : ok(output.file_type === "symlink"
          ? Object.freeze({ state: "present" as const, file_type: "symlink" as const, mode: "120000" as const, bytes: cached })
          : Object.freeze({ state: "present" as const, file_type: "regular" as const, mode: output.operation === "delete" ? "100644" : output.after.mode as "100644" | "100755", bytes: cached }));
    if (!desired.ok) return desired;
    const before = output.operation === "add"
      ? undefined
      : await beforeImage(output.before, output.operation === "rename" ? output.previous_path : output.path);
    sources.push(Object.freeze({
      path: output.path, target: target.value, desired: desired.value,
      authenticated_before: before?.observation ?? Object.freeze({ state: "absent" as const }),
      ...(before === undefined ? {} : { rollback: before.desired }),
      git_tracked: true,
      ...(output.operation === "rename" ? { rename_pair: Object.freeze({ role: "destination" as const, peer_path: output.previous_path }) } : {}),
    }));
    if (output.operation === "rename") {
      const previous = await resolveOutput(output.previous_path);
      if (!previous.ok) return previous;
      sources.push(Object.freeze({
        path: output.previous_path,
        target: previous.value,
        desired: Object.freeze({ state: "absent" as const }),
        authenticated_before: before!.observation,
        rollback: before!.desired,
        git_tracked: true,
        rename_pair: Object.freeze({ role: "source" as const, peer_path: output.path }),
      }));
    }
  }
  const projectionPlan = await prepareProjectionPlan(
    sources,
    createSecretlintScanner(),
    runner.location.worktreeRoot as ResolvedTaskPath,
  );
  if (!projectionPlan.ok) return projectionPlan;
  const secondaryProjectionPlans: NonNullable<RetainedResultInstallation["secondary_projection_plans"]>[number][] = [];
  const secondarySections = manifest.source_artifact.artifact_kind === "implementation-output"
    ? manifest.source_artifact.secondary_repositories ?? []
    : [];
  if (secondarySections.length > 0 && repositorySet === undefined) {
    return stateFailure(authority.context.phase_instance, "retained-secondary-repository-set-unavailable");
  }
  for (const section of secondarySections) {
    const member = repositorySet!.members.find((candidate) => candidate.name === section.repository);
    if (member === undefined || member.mode !== "writable" || member.identity.digest !== section.repository_identity_digest) {
      return stateFailure(authority.context.phase_instance, "retained-secondary-repository-mismatch");
    }
    if (section.outputs.length === 0) continue;
    const secondarySources: ProjectionSource[] = [];
    for (const output of section.outputs) {
      const source = await readRetainedRepositoryOutput({
        primary_runner: runner, authority, reference, repository_set: repositorySet!,
        repository: section.repository, output_path: output.path,
      });
      if (!source.ok) return source;
      secondarySources.push(source.value);
      if (output.storage === "raw-payload" && source.value.desired.state === "present") {
        const payloadTarget = await resolveTaskWorkspacePath({
          runner, taskId: authority.task_id,
          claim: parseWorkspacePathClaim(`cache/results/${reference.result_digest}/repositories/${section.repository}/payload/${output.path}`),
          expectedClass: "workspace-result-payload", context: authority.context,
        });
        if (!payloadTarget.ok) return payloadTarget;
        payloads.push(Object.freeze({ repository: section.repository, path: output.path, bytes: source.value.desired.bytes, target: payloadTarget.value }));
      }
      if (output.operation === "rename") {
        const previousTarget = await resolveRepositoryPath({
          runner: member.binding.runner, claim: output.previous_path, context: authority.context,
        });
        if (!previousTarget.ok) return previousTarget;
        const before = await beforeImageForRunner(member.binding.runner, output.before, output.previous_path);
        secondarySources.push(Object.freeze({
          path: output.previous_path, target: previousTarget.value, desired: Object.freeze({ state: "absent" as const }),
          authenticated_before: before.observation, rollback: before.desired, git_tracked: true,
          rename_pair: Object.freeze({ role: "source" as const, peer_path: output.path }),
        }));
      }
    }
    const preparedSecondary = await prepareProjectionPlan(
      secondarySources, createSecretlintScanner(), member.binding.runner.location.worktreeRoot as ResolvedTaskPath,
    );
    if (!preparedSecondary.ok) return preparedSecondary;
    secondaryProjectionPlans.push(Object.freeze({
      repository: section.repository, repository_identity_digest: section.repository_identity_digest,
      base_commit: section.base_commit, snapshot_digest: section.snapshot_digest,
      projection_plan: preparedSecondary.value,
      worktree_root: member.binding.runner.location.worktreeRoot as ResolvedTaskPath,
    }));
  }
  return ok(Object.freeze({
    prepared: Object.freeze({ manifest: manifestDocument, result_digest: manifestDocument.digest, payloads: Object.freeze(payloads) }),
    manifest_target: manifestTarget,
    projection_plan: projectionPlan.value,
    worktree_root: runner.location.worktreeRoot as ResolvedTaskPath,
    ...(secondaryProjectionPlans.length === 0 ? {} : { secondary_projection_plans: Object.freeze(secondaryProjectionPlans) }),
  }));
}

/**
 * Re-authenticates one retained secondary output through its current bound repository member.
 * The returned projection source is ready for collision preparation; live locations never enter
 * durable authority and raw payloads use the repository-qualified collision-free cache path.
 */
export async function readRetainedRepositoryOutput(input: Readonly<{
  primary_runner: RootBoundGitRunner;
  authority: TransactionAuthority;
  reference: TaskStateV1["authoritative_results"][number];
  repository_set: RepositorySet;
  repository: RepositoryName;
  output_path: RepositoryPathClaim;
}>): Promise<ProjectResult<ProjectionSource>> {
  const loaded = await readRetainedManifest(input.primary_runner, input.authority, input.reference);
  if (!loaded.ok) return loaded;
  const manifest = loaded.value.manifest.value;
  if (manifest.source_artifact.artifact_kind !== "implementation-output") {
    return stateFailure(input.authority.context.phase_instance, "retained-secondary-output-not-implementation");
  }
  const section = manifest.source_artifact.secondary_repositories?.find((item) => item.repository === input.repository);
  const projectionSet = manifest.secondary_projections?.find((item) => item.repository === input.repository);
  const member = input.repository_set.members.find((item) => item.name === input.repository);
  if (section === undefined || projectionSet === undefined || member === undefined || member.mode !== "writable" ||
      member.identity.digest !== section.repository_identity_digest ||
      projectionSet.repository_identity_digest !== section.repository_identity_digest) {
    return stateFailure(input.authority.context.phase_instance, "retained-secondary-repository-mismatch");
  }
  const output = section.outputs.find((item) => item.path === input.output_path);
  if (output === undefined) return stateFailure(input.authority.context.phase_instance, "retained-secondary-output-not-declared");
  const target = await resolveRepositoryPath({
    runner: member.binding.runner, claim: input.output_path, context: input.authority.context,
  });
  if (!target.ok) return target;
  let desired: ProjectionDesired;
  if (output.operation === "delete") {
    desired = Object.freeze({ state: "absent" });
  } else {
    let bytes: Uint8Array;
    if (output.storage === "raw-payload") {
      const payloadTarget = await resolveTaskWorkspacePath({
        runner: input.primary_runner,
        taskId: input.authority.task_id,
        claim: parseWorkspacePathClaim(`cache/results/${input.reference.result_digest}/repositories/${input.repository}/payload/${output.path}`),
        expectedClass: "workspace-result-payload",
        context: input.authority.context,
      });
      if (!payloadTarget.ok) return payloadTarget;
      const payload = await readSnapshotPayload({
        target: payloadTarget.value, expected_digest: output.payload_digest,
        expected_bytes: output.payload_bytes, snapshot_digest: section.snapshot_digest,
        worktree_root: input.primary_runner.location.worktreeRoot as ResolvedTaskPath,
      });
      if (!payload.ok) return payload;
      bytes = payload.value;
    } else {
      try {
        bytes = output.file_type === "symlink"
          ? await readGitBlobBytes(member.binding.runner, output.after.oid)
          : await readGitBlobProjectedBytes(member.binding.runner, output.after.oid, output.path);
      } catch {
        return stateFailure(input.authority.context.phase_instance, "retained-secondary-git-object-unavailable");
      }
    }
    const projection = projectionSet.projections.find((item) => item.path === output.path);
    if (projection === undefined || sha256Bytes(bytes) !== projection.content_digest) {
      return stateFailure(input.authority.context.phase_instance, "retained-secondary-projection-mismatch");
    }
    desired = output.file_type === "symlink"
      ? Object.freeze({ state: "present", file_type: "symlink", mode: "120000", bytes })
      : Object.freeze({ state: "present", file_type: "regular", mode: output.after.mode, bytes });
  }
  const before = output.operation === "add" || output.operation === "rename"
    ? Object.freeze({ observation: Object.freeze({ state: "absent" as const }), desired: Object.freeze({ state: "absent" as const }) })
    : await beforeImageForRunner(member.binding.runner, output.before, output.path);
  return ok(Object.freeze({
    path: output.path,
    target: target.value,
    desired,
    authenticated_before: before.observation,
    rollback: before.desired,
    git_tracked: output.operation !== "add",
  }));
}

/** Resolves repository authority and binds every production state/gate dependency. */
export async function createProductionServices(input: ProductionInput): Promise<ProjectResult<ProductionServices>> {
  const atomic = input.atomic ?? createAtomicWriter();
  const gateSecretScanner = input.gate_secret_scanner ?? createSecretlintScanner();
  const provisionalPhase = input.phase_instance ?? ("prd" as PhaseInstanceId);
  const provisionalContext = context(input, provisionalPhase, parseSafeInteger(1));
  const repository = await openRepository(input.working_directory, provisionalContext);
  if (!repository.ok) return repository;
  const discovered = Object.freeze({ value: repository.value.runner });
  const environment = Object.freeze({ value: repository.value.environment });
  const provisionalAuthority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: input.task_id,
    context: provisionalContext,
  });
  if (!provisionalAuthority.ok) return provisionalAuthority;
  const observed = await readTaskState(provisionalAuthority.value.state);
  if (observed.kind === "unreadable") {
    return fail(createProjectError("IO_ERROR", { operation: input.operation, attempt: provisionalContext.attempt }));
  }
  if (observed.kind === "noncanonical") return stateFailure(provisionalPhase, "task-state-noncanonical");

  const resolvedContext = observed.kind === "canonical"
    ? context(input, observed.document.value.phase_instance, observed.document.value.attempt)
    : provisionalContext;
  const authorityResult = observed.kind === "canonical"
    ? await createInternalTransactionAuthority({
        runner: discovered.value,
        environment: environment.value,
        task_id: input.task_id,
        context: resolvedContext,
        identity_source: provisionalAuthority.value,
      })
    : provisionalAuthority;
  if (!authorityResult.ok) return authorityResult;
  const authority = authorityResult.value;
  // Manifests are immutable and content-addressed, and every consumer below walks the same
  // `authoritative_results` list, so one services instance reloads each at most once. The key spans
  // every field `readRetainedManifest` cross-checks, not just the digest: two references can carry
  // the same digest and disagree elsewhere, and that disagreement must still be caught. The full
  // installation is deliberately not cached — it observes the live worktree, which a transaction
  // can change under it.
  const manifestCache = new Map<string, ProjectResult<RetainedManifest>>();
  const loadRetainedManifest = async (
    reference: TaskStateV1["authoritative_results"][number],
  ): Promise<ProjectResult<RetainedManifest>> => {
    const key = [
      reference.result_digest,
      reference.result_id,
      reference.phase_instance,
      reference.step,
      reference.input_fingerprint,
    ].join("\u0000");
    const cached = manifestCache.get(key);
    if (cached !== undefined) return cached;
    const loaded = await readRetainedManifest(discovered.value, authority, reference);
    manifestCache.set(key, loaded);
    return loaded;
  };
  const resolver = createProductionInputFingerprintResolver(async ({ state }) => {
    const reference = [...state.value.authoritative_results].reverse().find((candidate) =>
      candidate.phase_instance === state.value.phase_instance && candidate.step === "produce");
    if (reference === undefined) return ok(undefined);
    const retained = await loadRetainedManifest(reference);
    if (!retained.ok) return retained;
    const artifact = retained.value.manifest.value.source_artifact;
    return artifact.artifact_kind === "document" || artifact.artifact_kind === "implementation-output"
      ? ok(artifact)
      : ok(undefined);
  });

  const dependencies: GateLifecycleDependencies = Object.freeze({
    runner: discovered.value,
    environment: environment.value,
    atomic,
    projection_writer: createProjectionWriter(),
    lock: createTaskLock(),
    resolve_input_fingerprint: resolver,
    read_state: readTaskState,
    read_config: readTaskConfig,
    read_receipt: readIntentReceipt,
    gate_secret_scanner: gateSecretScanner,
    read_retained_task_bytes: async (excluded) => {
      const current = await readTaskState(authority.state);
      if (current.kind !== "canonical") return parseSafeInteger(0);
      let total = 0;
      const retainedReferences = retainedResultReferences(current.document.value);
      for (const reference of retainedReferences) {
        if (reference.result_digest === excluded?.result_digest) continue;
        const retained = await loadRetainedManifest(reference);
        if (!retained.ok) throw new TypeError("retained result accounting is unavailable");
        total += retainedManifestStoredBytes(retained.value.manifest.value);
        parseSafeInteger(total);
      }
      return parseSafeInteger(total);
    },
    load_retained_result: async (reference) => {
      const retained = await loadRetainedManifest(reference);
      if (!retained.ok) return retained;
      const needsRepositorySet = retained.value.manifest.value.source_artifact.artifact_kind === "implementation-output" &&
        (retained.value.manifest.value.source_artifact.secondary_repositories?.length ?? 0) > 0;
      if (!needsRepositorySet) return readRetainedResult(discovered.value, authority, reference);
      const liveConfig = await readTaskConfig(authority.config);
      if (liveConfig.kind !== "valid") return stateFailure(authority.context.phase_instance, "task-config-invalid");
      const repositorySet = await resolveRepositorySet(
        { runner: discovered.value, environment: environment.value }, liveConfig.snapshot.parsed, authority.context,
      );
      if (!repositorySet.ok) return repositorySet;
      return readRetainedResult(discovered.value, authority, reference, repositorySet.value);
    },
    load_retained_manifest: loadRetainedManifest,
    resolve_gate_reentry_fingerprint: async ({ request, current, target_phase_instance, expected_input_fingerprint }) => {
      const liveConfig = await readTaskConfig(authority.config);
      if (liveConfig.kind !== "valid") return stateFailure(current.value.phase_instance, "task-config-invalid");
      const call = parseToolCall("archflow_state", {
          schema_version: "1",
          task_id: authority.task_id,
          intent_id: request.intent_id,
          expected_revision: current.value.revision,
          input_fingerprint: current.value.input_fingerprint,
          phase_instance: target_phase_instance ?? request.phase_instance,
          step: "produce",
          status: "running",
      });
      const resolved = await resolver({
        runner: discovered.value,
        authority,
        state: current,
        call,
        live_config: liveConfig.snapshot,
        ...(expected_input_fingerprint !== undefined ? { expected_input_fingerprint } : {}),
        context: authority.context,
      });
      return resolved.ok ? ok(resolved.value.fingerprint) : resolved;
    },
  });
  return ok(Object.freeze({
    runner: discovered.value,
    environment: environment.value,
    authority,
    ...(observed.kind === "canonical" ? { state: observed.document } : {}),
    dependencies,
  }));
}
