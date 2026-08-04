import { canonicalJsonDigest, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../contracts/canonical.js";
import type { BlobIdentity, OutputEntry } from "../contracts/durable-primitives.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
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
  resolveDeclaredOutputPath,
  resolveRepositoryPath,
  resolveTaskPath,
  type ResolvedPath,
  type ResolvedTaskPath,
} from "../repository/paths.js";
import { createAtomicWriter, createProjectionWriter, type AtomicWriter } from "./atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { createProductionInputFingerprintResolver } from "./fingerprint-readers.js";
import type { GateLifecycleDependencies } from "./gates.js";
import { createTaskLock } from "./lock.js";
import { ensurePayloadParent, ensureResultDirectory, ensureTaskProjectionParent } from "./layout.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "./read.js";
import { createSecretlintScanner } from "./secret-scan.js";
import {
  applyProjectionPlan,
  installSnapshot,
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
import type { PreparedStateResult } from "../mcp/handlers/state-results.js";
import type { ManualAuthority } from "../local/manual-workflow.js";
import { resolveManualAuthority } from "../local/manual-workflow.js";

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
    parseTaskPathClaim(reference.manifest_path.replace(`.archflow/tasks/${authority.task_id}/`, "")),
    "result-manifest",
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
  const payloadTargets = new Map<RepositoryPathClaim, ResolvedPath>();
  for (const output of manifest.outputs) {
    if (output.storage !== "raw-payload") continue;
    const taskRelative = `results/sha256/${reference.result_digest}/payload/${output.path}`;
    const payloadTarget = await resolvePath(runner, authority, parseTaskPathClaim(taskRelative), "result-payload");
    if (!payloadTarget.ok) return payloadTarget;
    const bytes = await readSnapshotPayload({
      target: payloadTarget.value,
      expected_digest: output.payload_digest,
      expected_bytes: output.payload_bytes,
      snapshot_digest: manifest.snapshot_digest,
      worktree_root: runner.location.worktreeRoot as ResolvedTaskPath,
    });
    if (!bytes.ok) return bytes;
    payloads.push(Object.freeze({ path: output.path, bytes: bytes.value, target: payloadTarget.value }));
    payloadTargets.set(output.path, payloadTarget.value);
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
    const desired = await restoreSnapshotOutput({
      target: manifestTarget.value,
      expected_result_digest: reference.result_digest,
      runner,
      worktree_root: runner.location.worktreeRoot as ResolvedTaskPath,
      output_path: output.path,
      ...(payloadTargets.get(output.path) === undefined ? {} : { payload_target: payloadTargets.get(output.path)! }),
    });
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

declare const retainedTaskAccountingBrand: unique symbol;
/** Opaque accounting authority consumed by the shared result preparation seam. */
export type RetainedTaskAccounting = Readonly<{ readonly [retainedTaskAccountingBrand]: true }>;
const retainedAccounting = new WeakMap<object, Readonly<{ task_bytes: SafeInteger; measured_at_revision: SafeInteger }>>();

/** Mints accounting only from an authenticated normal state or manual authority. */
export async function createRetainedTaskAccounting(input: Readonly<{
  services: ProductionServices;
  manual_authority?: ManualAuthority;
}>): Promise<RetainedTaskAccounting> {
  let taskBytes: SafeInteger;
  let revision: SafeInteger;
  if (input.manual_authority !== undefined) {
    const manual = resolveManualAuthority(input.manual_authority);
    if (manual.services !== input.services) throw new TypeError("manual accounting authority belongs to another production session");
    taskBytes = manual.retained_task_bytes;
    revision = parseSafeInteger((manual.head ?? manual.state?.value)?.revision ?? 1);
  } else {
    const state = input.services.state;
    if (state === undefined) throw new TypeError("normal retained accounting requires current state");
    const read = input.services.dependencies.read_retained_task_bytes;
    if (read === undefined) throw new TypeError("normal retained accounting loader is unavailable");
    taskBytes = await read();
    revision = state.value.revision;
  }
  const capability = Object.freeze({}) as RetainedTaskAccounting;
  retainedAccounting.set(capability, Object.freeze({ task_bytes: taskBytes, measured_at_revision: revision }));
  return capability;
}

/** Normal-mode adapter for the existing authenticated retained-byte loader. */
export function createRetainedTaskAccountingFromBytes(
  services: ProductionServices,
  taskBytes: SafeInteger,
  measuredAtRevision: SafeInteger,
): RetainedTaskAccounting {
  if (services.state === undefined || services.state.value.revision !== measuredAtRevision) {
    throw new TypeError("normal retained accounting revision does not bind current state");
  }
  const capability = Object.freeze({}) as RetainedTaskAccounting;
  retainedAccounting.set(capability, Object.freeze({ task_bytes: taskBytes, measured_at_revision: measuredAtRevision }));
  return capability;
}

export function resolveRetainedTaskAccounting(accounting: RetainedTaskAccounting): Readonly<{
  task_bytes: SafeInteger;
  measured_at_revision: SafeInteger;
}> {
  const facts = retainedAccounting.get(accounting as object);
  if (facts === undefined) throw new TypeError("retained task accounting capability is invalid");
  return facts;
}

declare const installedManualResultBrand: unique symbol;
/** Opaque proof that immutable snapshot bytes and all projections were installed together. */
export type InstalledManualResult = Readonly<{ readonly [installedManualResultBrand]: true }>;
export type InstalledManualResultFacts = Readonly<{
  authority: ManualAuthority;
  reference: PreparedStateResult["reference"];
  manifest: CanonicalDocument<ResultManifestV1>;
  projections: ResultManifestV1["projections"];
}>;
const installedManualResults = new WeakMap<object, InstalledManualResultFacts>();

export type InstallManualRetainedResultInput = Readonly<{
  services: ProductionServices;
  authority: ManualAuthority;
  prepared: PreparedStateResult;
}>;

export type RemintManualRetainedResultInput = Readonly<{
  services: ProductionServices;
  authority: ManualAuthority;
  reference: TaskStateV1["authoritative_results"][number];
}>;

/** Installs immutable bytes first, then collision-safe projections, and only then mints authority. */
export async function installManualRetainedResult(
  input: InstallManualRetainedResultInput,
): Promise<ProjectResult<InstalledManualResult>> {
  const manual = resolveManualAuthority(input.authority);
  if (manual.services !== input.services) throw new TypeError("manual result authority belongs to another production session");
  if (input.prepared.reference.result_digest !== input.prepared.prepared.result_digest ||
      input.prepared.manifest_target.repositoryRelative !== input.prepared.reference.manifest_path) {
    throw new TypeError("manual result preparation does not bind its retained reference");
  }
  try {
    await ensureResultDirectory(input.services.authority, input.prepared.prepared.result_digest);
    for (const payload of input.prepared.prepared.payloads) {
      await ensurePayloadParent(
        input.services.authority,
        input.prepared.prepared.result_digest,
        payload.target.absolute,
      );
    }
  } catch {
    return fail(createProjectError("SNAPSHOT_INVALID", {
      snapshot_digest: input.prepared.prepared.manifest.value.snapshot_digest,
      issue_code: "immutable-install-disagreement",
    }));
  }
  const installed = await installSnapshot(
    input.services.dependencies.atomic,
    input.prepared.prepared,
    input.prepared.manifest_target,
    input.services.runner.location.worktreeRoot as ResolvedTaskPath,
  );
  if (!installed.ok) return installed;
  const writer = input.services.dependencies.projection_writer;
  if (writer === undefined) throw new TypeError("manual result projection writer is unavailable");
  for (const entry of input.prepared.projection_plan.entries) {
    await ensureTaskProjectionParent(input.services.authority, entry.target.absolute as ResolvedTaskPath);
  }
  const projected = await applyProjectionPlan(writer, input.prepared.projection_plan);
  if (projected.outcome !== "applied") {
    return fail(createProjectError("SNAPSHOT_INVALID", {
      snapshot_digest: input.prepared.prepared.manifest.value.snapshot_digest,
      issue_code: `projection-${projected.outcome}`,
    }));
  }
  const capability = Object.freeze({}) as InstalledManualResult;
  installedManualResults.set(capability, Object.freeze({
    authority: input.authority,
    reference: input.prepared.reference,
    manifest: input.prepared.prepared.manifest,
    projections: input.prepared.prepared.manifest.value.projections,
  }));
  return ok(capability);
}

/** Revalidates an already-authoritative immutable generation and its projections before reminting. */
export async function remintManualRetainedResult(
  input: RemintManualRetainedResultInput,
): Promise<ProjectResult<InstalledManualResult>> {
  const manual = resolveManualAuthority(input.authority);
  if (manual.services !== input.services) throw new TypeError("manual result authority belongs to another production session");
  const retained = await readRetainedResult(input.services.runner, input.services.authority, input.reference);
  if (!retained.ok) return retained;
  const writer = input.services.dependencies.projection_writer;
  if (writer === undefined) throw new TypeError("manual result projection writer is unavailable");
  for (const entry of retained.value.projection_plan.entries) {
    await ensureTaskProjectionParent(input.services.authority, entry.target.absolute as ResolvedTaskPath);
  }
  const projected = await applyProjectionPlan(writer, retained.value.projection_plan);
  if (projected.outcome !== "applied") {
    return fail(createProjectError("SNAPSHOT_INVALID", {
      snapshot_digest: retained.value.prepared.manifest.value.snapshot_digest,
      issue_code: `projection-${projected.outcome}`,
    }));
  }
  const capability = Object.freeze({}) as InstalledManualResult;
  installedManualResults.set(capability, Object.freeze({
    authority: input.authority,
    reference: input.reference,
    manifest: retained.value.prepared.manifest,
    projections: retained.value.prepared.manifest.value.projections,
  }));
  return ok(capability);
}

export function resolveInstalledManualResult(
  result: InstalledManualResult,
  authority: ManualAuthority,
): InstalledManualResultFacts {
  const facts = installedManualResults.get(result as object);
  if (facts === undefined || facts.authority !== authority) throw new TypeError("installed manual result capability is invalid or foreign");
  return facts;
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
        "decision",
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
