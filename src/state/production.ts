import { canonicalJsonDigest, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../contracts/canonical.js";
import { lstat, readFile, readlink } from "node:fs/promises";
import type { BlobIdentity, OutputEntry } from "../contracts/durable-primitives.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { computeInputFingerprint } from "../contracts/fingerprints.js";
import { parseSafeInteger, type SafeCode, type SafeInteger, type TaskSlug } from "../contracts/evidence.js";
import { parseToolCall } from "../contracts/mcp-tools.js";
import { parseRepositoryPathClaim, parseTaskPathClaim, type RepositoryPathClaim } from "../contracts/path-claims.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { SecretScanner } from "../contracts/secret-scan.js";
import { parseSupplementalReviewRecord } from "../contracts/supplemental-record.js";
import type { GitEnvironment, RepositoryOperationContext } from "../repository/git.js";
import { createGitRunner, preflightGit, readGitBlobBytes, readGitBlobProjectedBytes } from "../repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../repository/identity.js";
import {
  gateSupplementalReviewClaim,
  openResolved,
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
  readSnapshot,
  readSnapshotPayload,
  restoreSnapshotOutput,
  type PreparedSnapshot,
  type ProjectionDesired,
  type ProjectionObservation,
  type ProjectionSource,
} from "./snapshots.js";
import type { RetainedResultInstallation } from "./transaction.js";

export type ProductionServices = Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  authority: TransactionAuthority;
  state?: CanonicalDocument<TaskStateV1>;
  dependencies: GateLifecycleDependencies;
}>;

export type ProductionInput = Readonly<{
  working_directory: string;
  task_id: TaskSlug;
  operation: SafeCode;
  phase_instance?: PhaseInstanceId;
  atomic?: AtomicWriter;
  gate_secret_scanner?: SecretScanner;
}>;

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

export async function readRetainedResult(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  reference: TaskStateV1["authoritative_results"][number],
): Promise<ProjectResult<RetainedResultInstallation>> {
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
  ): Promise<Readonly<{ observation: ProjectionObservation; desired: ProjectionDesired }>> => {
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
  };
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
          target: manifestTarget.value,
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
  return ok(Object.freeze({
    prepared: Object.freeze({ manifest: read.value, result_digest: read.value.digest, payloads: Object.freeze(payloads) }),
    manifest_target: manifestTarget.value,
    projection_plan: projectionPlan.value,
    worktree_root: runner.location.worktreeRoot as ResolvedTaskPath,
  }));
}

/** Resolves repository authority and binds every production state/gate dependency. */
export async function createProductionServices(input: ProductionInput): Promise<ProjectResult<ProductionServices>> {
  const atomic = input.atomic ?? createAtomicWriter();
  const gateSecretScanner = input.gate_secret_scanner ?? createSecretlintScanner();
  const provisionalPhase = input.phase_instance ?? ("prd" as PhaseInstanceId);
  const provisionalContext = context(input, provisionalPhase, parseSafeInteger(1));
  const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), provisionalContext);
  if (!discovered.ok) return discovered;
  const environment = await preflightGit(discovered.value, provisionalContext);
  if (!environment.ok) return environment;
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
      })
    : provisionalAuthority;
  if (!authorityResult.ok) return authorityResult;
  const authority = authorityResult.value;
  const resolver = createProductionInputFingerprintResolver();

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
      for (const reference of current.document.value.authoritative_results) {
        if (reference.result_digest === excluded?.result_digest) continue;
        const retained = await readRetainedResult(discovered.value, authority, reference);
        if (!retained.ok) throw new TypeError("retained result accounting is unavailable");
        total += retained.value.prepared.manifest.value.accounting.result_bytes;
      }
      return parseSafeInteger(total);
    },
    load_retained_result: (reference) => readRetainedResult(discovered.value, authority, reference),
    resolve_gate_reentry_fingerprint: async ({ request, current }) => {
      const liveConfig = await readTaskConfig(authority.config);
      if (liveConfig.kind !== "valid") return stateFailure(current.value.phase_instance, "task-config-invalid");
      const call = parseToolCall("archflow_state", {
          schema_version: "1",
          task_id: authority.task_id,
          intent_id: request.intent_id,
          expected_revision: current.value.revision,
          input_fingerprint: current.value.input_fingerprint,
          phase_instance: request.phase_instance,
          step: "produce",
          status: "running",
      });
      const subject = await resolver({
        runner: discovered.value,
        authority,
        state: current,
        call,
        live_config: liveConfig.snapshot,
        context: authority.context,
      });
      return subject.ok ? ok(computeInputFingerprint(subject.value)) : subject;
    },
    resolve_supplemental_review: async ({ request }) => {
      const target = await resolvePath(
        discovered.value,
        authority,
        gateSupplementalReviewClaim(request.gate_id),
        "authority-decision",
      );
      if (!target.ok) return target;
      let handle;
      try {
        handle = await openResolved(target.value.absolute, 0);
        const document = parseCanonicalDocument(
          new Uint8Array(await handle.readFile()),
          "supplemental review record",
        );
        const record = parseSupplementalReviewRecord(document.value);
        const producerFamilies = new Set(request.current_evidence.slots.map((slot) => slot.producer_family));
        if (
          record.gate_id !== request.gate_id ||
          record.request_digest !== request.request_digest ||
          record.task_id !== request.task_id ||
          record.phase_instance !== request.phase_instance ||
          record.kind !== request.kind ||
          record.subject_digest !== request.subject_digest ||
          record.context_digest !== request.context_digest ||
          record.current_evidence_set_digest !== request.current_evidence.set_digest ||
          producerFamilies.size !== 1 ||
          !producerFamilies.has(record.review.producer_family) ||
          record.review.model_family === record.review.producer_family ||
          canonicalJsonDigest(record.review) !== record.evidence_digest
        ) return stateFailure(authority.context.phase_instance, "supplemental-review-authority-invalid");
        return ok(Object.freeze({
          evidence: record.review,
          gate_id: record.gate_id,
          triage_digest: record.triage_digest,
          triage_outcome: record.outcome,
        }));
      } catch {
        return stateFailure(authority.context.phase_instance, "supplemental-review-authority-invalid");
      } finally {
        await handle?.close().catch(() => undefined);
      }
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
