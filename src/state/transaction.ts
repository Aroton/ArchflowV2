import { isDeepStrictEqual } from "node:util";
import { isAbsolute, relative } from "node:path";

import {
  canonicalDocument,
  canonicalJsonDigest,
  sha256Bytes,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import {
  createCommittedIntentSubject,
  createPreparedIntentSubject,
  validateDurableSemantics,
} from "../contracts/durable.js";
import {
  intentOutcomeDigest,
  intentReceiptDigest,
  parseIntentReceipt,
  type IntentReceiptV1,
} from "../contracts/durable-intent.js";
import type { AuthoritativeResultRef, LastTransition, TaskStateV1 } from "../contracts/durable-state.js";
import { parseResultManifest, type ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger, type SafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../contracts/fingerprints.js";
import {
  assertAuthenticParsedToolCall,
  correlateProjectResult,
  validateProjectResultStructure,
  type ParsedToolCall,
  type RequestIdentifiedToolCall,
  type ResultExpectation,
  type StructurallyValidProjectResult,
  type ToolSuccess,
} from "../contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import type { ToolName } from "../contracts/tool-names.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import type { GitEnvironment } from "../repository/git.js";
import { verifyRepositoryIdentity, type RootBoundGitRunner } from "../repository/identity.js";
import {
  parseWorkspacePathClaim,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  type ResolvedPath,
  type ResolvedTaskPath,
  type ResolvedWorkspacePath,
} from "../repository/paths.js";
import { AtomicReplaceError, type AtomicWriter, type ProjectionWriter } from "./atomic.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import type { InputFingerprintResolver } from "./fingerprint.js";
import { identifyTransactionRequest } from "./request.js";
import {
  IntentLayoutError,
  ResultLayoutError,
  ensureIntentDirectory,
  ensurePayloadParent,
  ensureResultDirectory,
  ensureTaskProjectionParent,
  ensureWorkspaceProjectionParent,
} from "./layout.js";
import type {
  ConfigReadResult,
  ReceiptReadResult,
  StateReadResult,
} from "./read.js";
import { TaskLockError, type TaskLock } from "./lock.js";
import {
  applyProjectionPlan,
  installSnapshot,
  prepareSnapshot,
  RESULT_BYTE_CAP,
  TASK_BYTE_CAP,
  type PreparedSnapshot,
  type ProjectionPlan,
} from "./snapshots.js";
import { cleanTaskWorkspace, cleanTerminalTaskWorkspace } from "./workspace-cleanup.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;

export type TransactionDependencies = Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  atomic: AtomicWriter;
  lock: TaskLock;
  resolve_input_fingerprint: InputFingerprintResolver;
  read_state: (path: ResolvedPath) => Promise<StateReadResult>;
  read_config: (path: ResolvedPath) => Promise<ConfigReadResult>;
  read_receipt: (path: ResolvedWorkspacePath) => Promise<ReceiptReadResult>;
  projection_writer?: ProjectionWriter;
  /** Returns retained bytes excluding `reference`, when supplied, so replay never double-counts its generation. */
  read_retained_task_bytes?: (reference?: AuthoritativeResultRef) => Promise<SafeInteger>;
  load_retained_result?: (reference: AuthoritativeResultRef) => Promise<ProjectResult<RetainedResultInstallation>>;
}>;

export type NextStateDraft = Omit<TaskStateV1, "revision" | "last_transition"> & {
  readonly revision?: never;
  readonly last_transition?: never;
};

export type PreparedTransaction<K extends ToolName> = Readonly<{
  expectation: ResultExpectation<K>;
  result: StructurallyValidProjectResult<K>;
  next_state: NextStateDraft;
}>;

export type ResultInstallationPlan = Readonly<{
  reference: AuthoritativeResultRef;
  prepared: PreparedSnapshot;
  manifest_target: ResolvedPath;
  projection_plan: ProjectionPlan;
  worktree_root: ResolvedTaskPath;
}>;

export type RetainedResultInstallation = Readonly<Omit<ResultInstallationPlan, "reference">>;

export type InternalResultInstallation = Readonly<{ readonly kind: "archflow-result-installation" }>;

export type PreparedResultTransaction<K extends ToolName> = PreparedTransaction<K> & Readonly<{
  result_installation: InternalResultInstallation;
  /**
   * archflow_counter_review's second installation: the constitution-review evidence committed in
   * the same transaction as the rubric review, so the two results are durable together or not at
   * all. Absent for every other tool and when the pinned constitution has no active rules.
   */
  constitution_installation?: InternalResultInstallation;
}>;

type ResultInstallationFacts = Readonly<{
  plan: ResultInstallationPlan;
}>;

const resultInstallations = new WeakMap<object, ResultInstallationFacts>();
const consumedResultInstallations = new WeakSet<object>();

function materializeResultInstallation(plan: ResultInstallationPlan): ResultInstallationFacts {
  const reference = structuredClone(ownDataField(plan, "reference", "result installation plan")) as AuthoritativeResultRef;
  const prepared = structuredClone(ownDataField(plan, "prepared", "result installation plan")) as PreparedSnapshot;
  const manifestTarget = structuredClone(ownDataField(plan, "manifest_target", "result installation plan")) as ResolvedPath;
  const projectionPlan = structuredClone(ownDataField(plan, "projection_plan", "result installation plan")) as ProjectionPlan;
  const worktreeRoot = ownDataField(plan, "worktree_root", "result installation plan");
  assertPlainJson(reference, "result installation reference");
  assertPlainJson(manifestTarget, "result installation manifest target");
  if (typeof worktreeRoot !== "string") throw new TypeError("result installation worktree root must be a string");
  if (reference.result_digest !== prepared.result_digest || prepared.manifest.digest !== prepared.result_digest) {
    throw new TypeError("result installation reference does not bind the prepared snapshot");
  }
  if (manifestTarget.path_class !== "authority-result") {
    throw new TypeError("result installation reference does not bind the manifest target");
  }
  const canonical = canonicalDocument(prepared.manifest.value);
  if (canonical.digest !== prepared.manifest.digest || !Buffer.from(canonical.bytes).equals(Buffer.from(prepared.manifest.bytes))) {
    throw new TypeError("prepared snapshot manifest document disagrees");
  }
  parseResultManifest(prepared.manifest.value);
  if (!validateDurableSemantics({ result_manifest: prepared.manifest }).ok) {
    throw new TypeError("prepared snapshot manifest semantics are invalid");
  }
  return Object.freeze({ plan: Object.freeze({
    reference, prepared, manifest_target: manifestTarget, projection_plan: projectionPlan,
    worktree_root: worktreeRoot as ResolvedTaskPath,
  }) });
}

/** Mints a one-shot internal capability after staging exact immutable and projection bytes outside the task lock. */
export function prepareResultInstallation(plan: ResultInstallationPlan): InternalResultInstallation {
  const facts = materializeResultInstallation(plan);
  const capability = Object.freeze({ kind: "archflow-result-installation" as const });
  resultInstallations.set(capability, facts);
  return capability;
}

export type TransactionRequest<K extends ToolName = ToolName> = Readonly<{
  call: Extract<ParsedToolCall, { readonly name: K }>;
  authority: TransactionAuthority;
}>;

export type TransactionOutcome<K extends ToolName> = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  outcome: ToolSuccess<K>;
  replayed: boolean;
}>;

const authenticTransactionOutcomes = new WeakSet<object>();

/** Trust-boundary assertion for consumers deriving authority from a completed kernel transaction. */
export function assertAuthenticTransactionOutcome(
  value: TransactionOutcome<ToolName>,
): asserts value is TransactionOutcome<ToolName> {
  if (value === null || typeof value !== "object" || !authenticTransactionOutcomes.has(value)) {
    throw new TypeError("transaction outcome was not minted by the state transaction kernel");
  }
}

type Identified<K extends ToolName> = ReturnType<typeof identifyTransactionRequest<K>>;

type PlannedCommit<K extends ToolName> = Readonly<{
  receipt: CanonicalDocument<IntentReceiptV1>;
  final: CanonicalDocument<TaskStateV1>;
  outcome: ToolSuccess<K>;
  result_installation?: ResultInstallationFacts;
  constitution_installation?: ResultInstallationFacts;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

function issue(code: "CONTRACT_INVALID" | "CONFIG_INVALID", issue_code: string): ProjectResult<never> {
  return code === "CONTRACT_INVALID"
    ? fail(createProjectError("CONTRACT_INVALID", { issue_code }))
    : fail(createProjectError("CONFIG_INVALID", { issue_code }));
}

function stateIssue(state: TaskStateV1, issue_code: string): ProjectResult<never> {
  return fail(createProjectError("STATE_INVALID", { phase_instance: state.phase_instance, issue_code }));
}

function taskIssue(task_id: TaskStateV1["task_id"], issue_code: string): ProjectResult<never> {
  return fail(createProjectError("TASK_INVALID", { task_id, issue_code }));
}

function io(authority: TransactionAuthority, operation: string): ProjectResult<never> {
  return fail(createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }));
}

const PERMANENT_PROJECTION_ISSUES: Readonly<Record<string, string>> = Object.freeze({
  ENOENT: "projection-parent-missing",
  ENOTDIR: "projection-parent-not-directory",
  EACCES: "projection-target-access-denied",
  EPERM: "projection-target-access-denied",
});

/**
 * Classifies a projection-parent or projection-write failure without leaking
 * filesystem paths: permanent conditions become non-retryable TASK_INVALID
 * issue codes, everything else stays retryable IO_ERROR. Returns undefined for
 * errors that are not filesystem outcomes so the caller can rethrow them.
 */
function projectionWriteFailure(
  error: unknown,
  authority: TransactionAuthority,
  task_id: TaskStateV1["task_id"],
): ProjectResult<never> | undefined {
  if (error instanceof ResultLayoutError && error.stage === "verify") {
    return taskIssue(task_id, "projection-parent-not-directory");
  }
  if (error instanceof ResultLayoutError || error instanceof AtomicReplaceError) {
    const issue = error.errno === undefined ? undefined : PERMANENT_PROJECTION_ISSUES[error.errno];
    return issue === undefined ? io(authority, "result-projection-apply") : taskIssue(task_id, issue);
  }
  return undefined;
}

function mismatch(expected_digest: Sha256Digest, observed_digest: Sha256Digest): ProjectResult<never> {
  return fail(createProjectError("INTENT_MISMATCH", { expected_digest, observed_digest }));
}

function fingerprintMismatch(expected_digest: Sha256Digest, observed_digest: Sha256Digest): ProjectResult<never> {
  return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", { expected_digest, observed_digest }));
}

function operationFor(call: ParsedToolCall): IntentReceiptV1["operation"] {
  switch (call.name) {
    case "archflow_state": {
      const artifact = call.input.artifact;
      if (artifact === undefined) return "record-state-boundary" as IntentReceiptV1["operation"];
      switch (artifact.artifact_kind) {
        case "task-initialization": return "adopt-task-initialization" as IntentReceiptV1["operation"];
        case "legacy-import-initialization": return "adopt-legacy-import-initialization" as IntentReceiptV1["operation"];
        case "document": return "record-document-artifact" as IntentReceiptV1["operation"];
        case "implementation-output": return "record-implementation-output" as IntentReceiptV1["operation"];
        case "triage": return "record-triage" as IntentReceiptV1["operation"];
      }
    }
    case "archflow_counter_review": return "counter-review" as IntentReceiptV1["operation"];
    case "archflow_gate": return "gate" as IntentReceiptV1["operation"];
    case "archflow_waiver": return "waiver" as IntentReceiptV1["operation"];
    default: {
      const exhaustive: never = call;
      throw new TypeError(`unknown transaction tool ${String(exhaustive)}`);
    }
  }
}

function requirePath(path: ResolvedPath, expected: ResolvedPath["path_class"], label: string): void {
  if (path.path_class !== expected) throw new TypeError(`${label} has the wrong resolved path class`);
}

function ownDataField(value: unknown, field: string, label: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${label} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${label}.${field} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function materializeFingerprint(value: InputFingerprintSubject): InputFingerprintSubject {
  assertPlainJson(value, "input fingerprint subject");
  return structuredClone(value);
}

function materializeDraft(value: unknown): NextStateDraft {
  assertPlainJson(value, "next state draft");
  if (Object.hasOwn(value as object, "revision") || Object.hasOwn(value as object, "last_transition")) {
    throw new TypeError("next state draft cannot carry revision or last_transition");
  }
  return structuredClone(value as PlainJsonValue) as NextStateDraft;
}

function assertPreserved(current: TaskStateV1, next: NextStateDraft): void {
  if (
    next.task_id !== current.task_id ||
    next.repository_identity_digest !== current.repository_identity_digest ||
    next.initialization_digest !== current.initialization_digest ||
    next.config_digest !== current.config_digest ||
    next.workflow_digest !== current.workflow_digest ||
    next.constitution_digest !== current.constitution_digest ||
    next.policy_base_commit !== current.policy_base_commit
  ) {
    throw new TypeError("next state draft changed a transaction-substrate identity or pin");
  }
  if (
    !isDeepStrictEqual(next.open_gate, current.open_gate) ||
    !isDeepStrictEqual(next.approvals, current.approvals) ||
    !isDeepStrictEqual(next.waivers, current.waivers)
  ) {
    throw new TypeError("next state draft changed gate authority");
  }
}

function outcomeResult<K extends ToolName>(
  state: CanonicalDocument<TaskStateV1>,
  outcome: ToolSuccess<K>,
  replayed: boolean,
): ProjectResult<TransactionOutcome<K>> {
  const value = Object.freeze({ state, outcome, replayed });
  authenticTransactionOutcomes.add(value);
  return ok(value);
}

async function resolveIntentTarget<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
): Promise<ProjectResult<ResolvedWorkspacePath>> {
  const claim = parseWorkspacePathClaim(`transient/intents/${request.call.input.intent_id}.json`);
  const resolved = await resolveTaskWorkspacePath({
    runner: dependencies.runner,
    taskId: request.authority.task_id,
    claim,
    expectedClass: "workspace-intent",
    context: request.authority.context,
  });
  if (!resolved.ok) return resolved;
  if (resolved.value.path_class !== "workspace-intent") throw new TypeError("intent target has the wrong resolved path class");
  const expectedClaim = `.archflow/runtime/tasks/${request.authority.task_id}/${claim}`;
  if (resolved.value.repositoryRelative !== expectedClaim) throw new TypeError("intent target claim mismatch");
  const rel = relative(request.authority.workspace_root, resolved.value.absolute);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new TypeError("intent target is not contained by the authenticated task root");
  }
  return resolved;
}

function stateReadFailure(result: Exclude<StateReadResult, { readonly kind: "canonical" }>): ProjectResult<never> {
  return issue("CONTRACT_INVALID", result.kind === "missing"
    ? "task-state-missing"
    : result.kind === "unreadable"
      ? "task-state-unreadable"
      : "task-state-noncanonical");
}

function receiptShellFailure(
  current: TaskStateV1,
  claimed: boolean,
  result: Exclude<ReceiptReadResult, { readonly kind: "canonical" }>,
  authority: TransactionAuthority,
): ProjectResult<never> | undefined {
  if (result.kind === "unreadable") return io(authority, "intent-receipt-read");
  if (result.kind === "missing") {
    return claimed ? stateIssue(current, "intent-receipt-missing") : undefined;
  }
  return claimed
    ? stateIssue(current, "intent-receipt-noncanonical")
    : issue("CONTRACT_INVALID", "intent-receipt-noncanonical");
}

async function liveIdentification<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  current: CanonicalDocument<TaskStateV1>,
): Promise<ProjectResult<Identified<K>>> {
  const config = await dependencies.read_config(request.authority.config);
  if (config.kind !== "valid") {
    return config.kind === "invalid"
      ? issue("CONFIG_INVALID", "task-config-invalid")
      : io(request.authority, "task-config-read");
  }
  if (config.snapshot.digest !== current.value.config_digest) {
    return fail(createProjectError("PINNED_CONFIG_MISMATCH", {
      expected_digest: current.value.config_digest,
      observed_digest: config.snapshot.digest,
    }));
  }
  const resolved = await dependencies.resolve_input_fingerprint({
    runner: dependencies.runner,
    authority: request.authority,
    state: current,
    call: request.call,
    live_config: config.snapshot,
    context: request.authority.context,
  });
  if (!resolved.ok) return resolved;
  const subject = materializeFingerprint(resolved.value);
  const inputFingerprint = computeInputFingerprint(subject);
  if (inputFingerprint !== request.call.input.input_fingerprint) {
    return fingerprintMismatch(inputFingerprint, request.call.input.input_fingerprint);
  }
  return ok(identifyTransactionRequest(request.call, request.authority, inputFingerprint));
}

function identifyFromReceipt<K extends ToolName>(
  request: TransactionRequest<K>,
  receipt: IntentReceiptV1,
): ProjectResult<Identified<K>> {
  if (receipt.input_fingerprint !== request.call.input.input_fingerprint) {
    return fingerprintMismatch(receipt.input_fingerprint, request.call.input.input_fingerprint);
  }
  return ok(identifyTransactionRequest(request.call, request.authority, receipt.input_fingerprint));
}

function validateReceiptIdentity<K extends ToolName>(
  request: TransactionRequest<K>,
  receipt: IntentReceiptV1,
): ProjectResult<void> {
  if (receipt.intent_id !== request.call.input.intent_id) {
    return taskIssue(receipt.task_id, "intent-receipt-intent-mismatch");
  }
  if (receipt.tool !== request.call.name) return taskIssue(receipt.task_id, "intent-receipt-tool-mismatch");
  if (receipt.operation !== operationFor(request.call)) {
    return taskIssue(receipt.task_id, "intent-receipt-operation-mismatch");
  }
  if (receipt.task_id !== request.authority.task_id) {
    return taskIssue(receipt.task_id, "intent-receipt-task-mismatch");
  }
  if (receipt.repository_identity_digest !== request.authority.repository_identity_digest) {
    return taskIssue(receipt.task_id, "intent-receipt-repository-mismatch");
  }
  if (receipt.prepared_state.input_fingerprint !== receipt.input_fingerprint) {
    return taskIssue(receipt.task_id, "intent-receipt-input-fingerprint-mismatch");
  }
  return ok(undefined);
}

function validateReceiptLocally(receiptDocument: CanonicalDocument<IntentReceiptV1>): ProjectResult<void> {
  const receipt = receiptDocument.value;
  if (intentReceiptDigest(receipt) !== receiptDocument.digest) {
    return taskIssue(receipt.task_id, "intent-receipt-self-digest-mismatch");
  }
  if (intentOutcomeDigest(receipt.outcome) !== receipt.outcome_digest) {
    return taskIssue(receipt.task_id, "intent-receipt-outcome-digest-mismatch");
  }
  if (canonicalJsonDigest(receipt.prepared_state) !== receipt.prepared_state_digest) {
    return taskIssue(receipt.task_id, "intent-receipt-prepared-state-digest-mismatch");
  }
  if (receipt.prior_revision === Number.MAX_SAFE_INTEGER || receipt.resulting_revision !== receipt.prior_revision + 1) {
    return taskIssue(receipt.task_id, "intent-receipt-revision-not-successor");
  }
  if (receipt.prepared_state.revision !== receipt.resulting_revision) {
    return taskIssue(receipt.task_id, "intent-receipt-prepared-state-revision-mismatch");
  }
  if (receipt.prepared_state.last_transition !== undefined) {
    return taskIssue(receipt.task_id, "intent-receipt-prepared-state-last-transition-present");
  }
  return ok(undefined);
}

function replayOutcome<K extends ToolName>(
  request: TransactionRequest<K>,
  receipt: IntentReceiptV1,
): ProjectResult<ToolSuccess<K>> {
  try {
    const validated = validateProjectResultStructure(request.call, {
      schema_version: "1",
      ok: true,
      value: receipt.outcome,
    });
    if (!validated.ok || validated.value.revision !== receipt.resulting_revision) {
      return taskIssue(receipt.task_id, "intent-receipt-reference-result-mismatch");
    }
    return ok(validated.value);
  } catch {
    return taskIssue(receipt.task_id, "intent-receipt-reference-result-mismatch");
  }
}

function replayLastTransition<K extends ToolName>(
  request: TransactionRequest<K>,
  current: CanonicalDocument<TaskStateV1>,
  transition: LastTransition,
): ProjectResult<TransactionOutcome<K>> {
  if (transition.tool !== request.call.name || transition.operation !== operationFor(request.call)) {
    return taskIssue(current.value.task_id, "last-transition-operation-mismatch");
  }
  if (transition.input_fingerprint !== request.call.input.input_fingerprint) {
    return fingerprintMismatch(transition.input_fingerprint, request.call.input.input_fingerprint);
  }
  const identified = identifyTransactionRequest(request.call, request.authority, transition.input_fingerprint);
  if (identified.request_digest !== transition.request_digest) {
    return mismatch(transition.request_digest, identified.request_digest);
  }
  if (
    transition.resulting_revision !== current.value.revision ||
    transition.prior_revision + 1 !== transition.resulting_revision ||
    intentOutcomeDigest(transition.outcome) !== transition.outcome_digest
  ) return stateIssue(current.value, "last-transition-invalid");
  try {
    const validated = validateProjectResultStructure(request.call, {
      schema_version: "1",
      ok: true,
      value: transition.outcome,
    });
    if (!validated.ok || validated.value.revision !== transition.resulting_revision) {
      return stateIssue(current.value, "last-transition-result-mismatch");
    }
    return outcomeResult(current, validated.value, true);
  } catch {
    return stateIssue(current.value, "last-transition-result-mismatch");
  }
}

function lastTransition(receipt: IntentReceiptV1): LastTransition {
  return {
    schema_version: "1",
    tool: receipt.tool,
    operation: receipt.operation,
    intent_id: receipt.intent_id,
    request_digest: receipt.request_digest,
    input_fingerprint: receipt.input_fingerprint,
    result_id: receipt.result_id,
    outcome: receipt.outcome,
    outcome_digest: receipt.outcome_digest,
    prior_revision: receipt.prior_revision,
    resulting_revision: receipt.resulting_revision,
  };
}

function committedState(
  receiptDocument: CanonicalDocument<IntentReceiptV1>,
): CanonicalDocument<TaskStateV1> {
  const receipt = receiptDocument.value;
  return canonicalDocument({ ...receipt.prepared_state, last_transition: lastTransition(receipt) });
}

function validatePreparedAndCommitted(
  current: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>,
  final: CanonicalDocument<TaskStateV1>,
): ProjectResult<void> {
  const prepared = validateDurableSemantics(createPreparedIntentSubject(current, receipt));
  if (!prepared.ok) return prepared;
  return validateDurableSemantics(createCommittedIntentSubject(final, receipt));
}

function consumeInstallationCapability(value: object, slot: string): ResultInstallationFacts {
  const capability = ownDataField(value, slot, "prepared transaction");
  if (capability === null || typeof capability !== "object") throw new TypeError(`${slot} capability is invalid`);
  const facts = resultInstallations.get(capability);
  if (facts === undefined || consumedResultInstallations.has(capability)) {
    throw new TypeError(`${slot} capability is unauthenticated or already consumed`);
  }
  consumedResultInstallations.add(capability);
  return facts;
}

function materializePlan<K extends ToolName>(value: unknown): PreparedTransaction<K> & {
  result_installation?: ResultInstallationFacts;
  constitution_installation?: ResultInstallationFacts;
} {
  if (value === null || typeof value !== "object") throw new TypeError("prepared transaction must be an object");
  const hasInstallation = Object.hasOwn(value, "result_installation");
  const hasConstitution = Object.hasOwn(value, "constitution_installation");
  if (hasConstitution && !hasInstallation) {
    throw new TypeError("a constitution installation requires a primary result installation");
  }
  const expected = ["expectation", "next_state", "result"];
  if (hasConstitution) expected.push("constitution_installation");
  if (hasInstallation) expected.push("result_installation");
  expected.sort();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || !isDeepStrictEqual((keys as string[]).sort(), expected)) {
    throw new TypeError("prepared transaction has unexpected or missing slots");
  }
  const expectation = ownDataField(value, "expectation", "prepared transaction") as ResultExpectation<K>;
  const result = ownDataField(value, "result", "prepared transaction") as StructurallyValidProjectResult<K>;
  const nextState = materializeDraft(ownDataField(value, "next_state", "prepared transaction"));
  if (!hasInstallation) return { expectation, result, next_state: nextState };
  const facts = consumeInstallationCapability(value, "result_installation");
  if (!hasConstitution) return { expectation, result, next_state: nextState, result_installation: facts };
  const constitutionFacts = consumeInstallationCapability(value, "constitution_installation");
  return {
    expectation,
    result,
    next_state: nextState,
    result_installation: facts,
    constitution_installation: constitutionFacts,
  };
}

function expectedInstallationSource(
  call: ParsedToolCall,
  source: ReturnType<typeof parseResultManifest>["source_artifact"],
): PipelineStep {
  if (call.name === "archflow_state") {
    const step = call.input.step;
    const matches =
      (step === "produce" &&
        (source.artifact_kind === "document" || source.artifact_kind === "implementation-output")) ||
      (step === "triage" && source.artifact_kind === "triage");
    if (!matches) throw new TypeError("result source kind is not legal for the archflow_state step");
    if (source.artifact_kind === "triage") {
      if (call.input.artifact === undefined) {
        throw new TypeError("evidence result installation requires an archflow_state artifact");
      }
      if (canonicalJsonDigest(call.input.artifact) !== canonicalJsonDigest(source)) {
        throw new TypeError("evidence result installation source does not match the archflow_state artifact");
      }
    }
    return step;
  }
  if (
    call.name === "archflow_counter_review" &&
    source.artifact_kind === "review-evidence" &&
    source.evidence.role === "counter-review" &&
    source.evidence.step === "counter_review"
  ) return "counter_review";
  throw new TypeError("result installation tool and source kind do not match");
}

function targetIsInside(root: string, target: ResolvedPath | ResolvedWorkspacePath): boolean {
  const rel = relative(root, target.absolute);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** Selects the authenticated containment boundary for a prepared result projection. */
export function resultProjectionTargetIsContained(
  artifactKind: ResultManifestV1["source_artifact"]["artifact_kind"],
  taskRoot: string,
  worktreeRoot: string,
  target: ResolvedPath | ResolvedWorkspacePath,
): boolean {
  return targetIsInside(
    artifactKind === "implementation-output" ? worktreeRoot : taskRoot,
    target,
  );
}

function validateInstallationFacts<K extends ToolName>(
  request: TransactionRequest<K>,
  current: CanonicalDocument<TaskStateV1>,
  identified: Identified<K>,
  nextState: NextStateDraft,
  facts: ResultInstallationPlan,
  expectedStep: PipelineStep,
  authenticatedWorktreeRoot: string,
): ProjectResult<void> {
  const manifest = facts.prepared.manifest.value;
  const reference = facts.reference;
  const nextReference = nextState.authoritative_results.find((entry) =>
    entry.phase_instance === reference.phase_instance && entry.step === reference.step);
  if (!isDeepStrictEqual(nextReference, reference)) {
    throw new TypeError("result installation reference does not match the prepared transaction");
  }
  if (reference.input_fingerprint !== identified.input_fingerprint) {
    return fingerprintMismatch(identified.input_fingerprint, reference.input_fingerprint);
  }
  if (
    manifest.task_id !== request.authority.task_id ||
    manifest.task_id !== current.value.task_id
  ) return taskIssue(request.authority.task_id, "result-installation-task-mismatch");
  if (
    manifest.repository_identity_digest !== request.authority.repository_identity_digest ||
    manifest.repository_identity_digest !== current.value.repository_identity_digest
  ) return stateIssue(current.value, "result-installation-repository-mismatch");
  if (
    manifest.phase_instance !== nextState.phase_instance ||
    manifest.step !== expectedStep ||
    manifest.input_fingerprint !== identified.input_fingerprint
  ) return stateIssue(current.value, "result-installation-state-mismatch");
  const expectedManifestPath =
    `.archflow/tasks/${request.authority.task_id}/authority/results/${facts.prepared.result_digest}.json`;
  if (
    facts.worktree_root !== authenticatedWorktreeRoot ||
    facts.manifest_target.repositoryRelative !== expectedManifestPath ||
    !targetIsInside(request.authority.task_root, facts.manifest_target)
  ) return issue("CONTRACT_INVALID", "result-installation-target-mismatch");
  const payloadRoot =
    `.archflow/runtime/tasks/${request.authority.task_id}/cache/results/${facts.prepared.result_digest}/payload/`;
  if (facts.prepared.payloads.some((payload) =>
    !payload.target.repositoryRelative.startsWith(payloadRoot) ||
    !targetIsInside(request.authority.workspace_root, payload.target)
  )) return issue("CONTRACT_INVALID", "result-installation-payload-target-mismatch");
  const outputs = new Map(manifest.outputs.map((output) => [output.path, output.path_class]));
  const evidenceProjection = manifest.source_artifact.artifact_kind === "review-evidence" ||
    manifest.source_artifact.artifact_kind === "triage" ||
    manifest.source_artifact.artifact_kind === "adjudication-evidence";
  if (
    outputs.size !== manifest.outputs.length ||
    facts.projection_plan.entries.some((entry) =>
      (evidenceProjection
        ? entry.target.path_class !== "workspace-review"
        : outputs.get(entry.path) !== entry.target.path_class) ||
      entry.target.repositoryRelative !== entry.path ||
      ("workspaceRelative" in entry.target
        ? !targetIsInside(request.authority.workspace_root, entry.target)
        : !resultProjectionTargetIsContained(
            manifest.source_artifact.artifact_kind,
            request.authority.task_root,
            authenticatedWorktreeRoot,
            entry.target,
          )))
  ) return issue("CONTRACT_INVALID", "result-installation-projection-target-mismatch");
  return ok(undefined);
}

function validateResultInstallationBinding<K extends ToolName>(
  request: TransactionRequest<K>,
  current: CanonicalDocument<TaskStateV1>,
  identified: Identified<K>,
  plan: PreparedTransaction<K> & {
    result_installation?: ResultInstallationFacts;
    constitution_installation?: ResultInstallationFacts;
  },
  authenticatedWorktreeRoot: string,
): ProjectResult<void> {
  const installation = plan.result_installation;
  if (installation === undefined) {
    if (plan.constitution_installation !== undefined) {
      throw new TypeError("a constitution installation requires a primary result installation");
    }
    return ok(undefined);
  }
  const facts = installation.plan;
  const expectedStep = expectedInstallationSource(request.call, facts.prepared.manifest.value.source_artifact);
  if (plan.next_state.status !== "succeeded" || plan.next_state.step !== expectedStep) {
    throw new TypeError("result installation is permitted only at its successful evidence boundary");
  }
  if (facts.reference.result_id !== plan.expectation.result_id) {
    throw new TypeError("result installation reference does not match the prepared transaction");
  }
  const primary = validateInstallationFacts(
    request, current, identified, plan.next_state, facts, expectedStep, authenticatedWorktreeRoot,
  );
  if (!primary.ok) return primary;
  const constitution = plan.constitution_installation;
  if (constitution === undefined) return ok(undefined);
  // The constitution-review evidence rides the counter-review transaction: its manifest is an
  // adjudication-evidence source retained under the "adjudicate" slot while the transaction's
  // state target remains counter_review-succeeded.
  const constitutionFacts = constitution.plan;
  if (
    request.call.name !== "archflow_counter_review" ||
    expectedStep !== "counter_review" ||
    constitutionFacts.prepared.manifest.value.source_artifact.artifact_kind !== "adjudication-evidence" ||
    constitutionFacts.reference.step !== "adjudicate"
  ) {
    throw new TypeError("constitution installation is permitted only inside a counter-review transaction");
  }
  return validateInstallationFacts(
    request, current, identified, plan.next_state, constitutionFacts, "adjudicate", authenticatedWorktreeRoot,
  );
}

function buildPlan<K extends ToolName>(
  request: TransactionRequest<K>,
  current: CanonicalDocument<TaskStateV1>,
  identified: Identified<K>,
  preparedValue: unknown,
  authenticatedWorktreeRoot: string,
): ProjectResult<PlannedCommit<K>> {
  const resultingRevision = parseSafeInteger(current.value.revision + 1);
  const plan = materializePlan<K>(preparedValue);
  const correlated = correlateProjectResult(identified.call, plan.expectation, plan.result);
  if (!correlated.ok) return correlated;
  if (plan.expectation.resulting_revision !== resultingRevision || correlated.value.revision !== resultingRevision) {
    throw new TypeError("prepared transaction revision is not the immediate successor");
  }
  assertPreserved(current.value, plan.next_state);
  const installation = validateResultInstallationBinding(
    request, current, identified, plan, authenticatedWorktreeRoot,
  );
  if (!installation.ok) return installation;
  const preparedState: TaskStateV1 = { ...plan.next_state, revision: resultingRevision };
  const outcome = structuredClone(correlated.value as unknown as PlainJsonValue) as unknown as ToolSuccess<K>;
  const receiptValue = parseIntentReceipt({
    schema_version: "1",
    intent_id: request.call.input.intent_id,
    task_id: request.authority.task_id,
    repository_identity_digest: request.authority.repository_identity_digest,
    tool: request.call.name,
    operation: operationFor(request.call),
    request_digest: identified.request_digest,
    input_fingerprint: identified.input_fingerprint,
    prior_revision: current.value.revision,
    resulting_revision: resultingRevision,
    result_id: plan.expectation.result_id,
    outcome_digest: intentOutcomeDigest(outcome as unknown as PlainJsonValue),
    outcome: outcome as unknown as PlainJsonValue,
    prepared_state_digest: canonicalJsonDigest(preparedState),
    prepared_state: preparedState,
  });
  const receipt = canonicalDocument(receiptValue);
  if (receipt.bytes.byteLength > MAX_RECEIPT_BYTES) throw new TypeError("intent receipt exceeds the 1 MiB limit");
  const final = committedState(receipt);
  const semantics = validatePreparedAndCommitted(current, receipt, final);
  if (!semantics.ok) return semantics;
  return ok(Object.freeze({ receipt, final, outcome,
    ...(plan.result_installation === undefined ? {} : { result_installation: plan.result_installation }),
    ...(plan.constitution_installation === undefined ? {} : { constitution_installation: plan.constitution_installation }) }));
}

async function authenticateCommitted<K extends ToolName>(
  request: TransactionRequest<K>,
  current: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  const semantics = validateDurableSemantics(createCommittedIntentSubject(current, receipt));
  if (!semantics.ok) return semantics;
  const identified = identifyFromReceipt(request, receipt.value);
  if (!identified.ok) return identified;
  if (identified.value.request_digest !== receipt.value.request_digest) {
    return mismatch(receipt.value.request_digest, identified.value.request_digest);
  }
  const outcome = replayOutcome(request, receipt.value);
  if (!outcome.ok) return outcome;
  return outcomeResult(current, outcome.value, true);
}

async function arbitrate<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  intentPath: ResolvedWorkspacePath,
  predecessor: CanonicalDocument<TaskStateV1>,
  plan: PlannedCommit<K>,
  operation: "intent-receipt-create" | "task-state-replace" | "task-lock-release",
  unchangedFailure?: ProjectResult<TransactionOutcome<K>>,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  const stateRead = await dependencies.read_state(request.authority.state);
  if (stateRead.kind === "canonical") {
    if (stateRead.document.digest === plan.final.digest) {
      const committed = validateDurableSemantics({ state: stateRead.document });
      if (!committed.ok) return committed;
      await cleanupCommittedWorkspace(dependencies, request.authority, stateRead.document.value);
      return outcomeResult(stateRead.document, plan.outcome, false);
    }
    if (stateRead.document.digest === predecessor.digest) {
      return unchangedFailure ?? io(request.authority, operation);
    }
    return fail(createProjectError("RECONCILIATION_REQUIRED", {
      recorded_digest: plan.final.digest,
      observed_digest: stateRead.document.digest,
    }));
  }
  if (stateRead.kind === "missing") return issue("CONTRACT_INVALID", "transaction-outcome-ambiguous");
  return stateIssue(predecessor.value, "transaction-outcome-ambiguous");
}

function copiedResultBytes(prepared: PreparedSnapshot): number {
  const payloads = new Map(prepared.payloads.map((payload) => [payload.path, payload]));
  if (payloads.size !== prepared.payloads.length) throw new TypeError("prepared snapshot has duplicate payload paths");
  let bytes = 0;
  for (const output of prepared.manifest.value.outputs) {
    if (output.storage !== "raw-payload") continue;
    const payload = payloads.get(output.path);
    if (
      payload === undefined || payload.target.path_class !== "workspace-result-payload" ||
      payload.bytes.byteLength !== output.payload_bytes || sha256Bytes(payload.bytes) !== output.payload_digest
    ) throw new TypeError("prepared snapshot payload facts disagree");
    bytes += payload.bytes.byteLength;
    payloads.delete(output.path);
  }
  if (payloads.size !== 0 || bytes !== prepared.manifest.value.accounting.result_bytes) {
    throw new TypeError("prepared snapshot accounting disagrees");
  }
  return bytes;
}

async function installResultFacts(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  facts: ResultInstallationFacts,
  replay: boolean,
): Promise<ProjectResult<void>> {
  if (dependencies.read_retained_task_bytes === undefined || dependencies.projection_writer === undefined) {
    return stateIssue(current.value, "result-installation-unavailable");
  }
  if (facts.plan.worktree_root !== dependencies.runner.location.worktreeRoot) {
    throw new TypeError("result installation worktree root is not the authenticated repository root");
  }
  const resultBytes = copiedResultBytes(facts.plan.prepared);
  const retainedBytes = parseSafeInteger(
    await dependencies.read_retained_task_bytes(replay ? facts.plan.reference : undefined),
  );
  if (resultBytes > RESULT_BYTE_CAP) {
    return fail(createProjectError("SNAPSHOT_LIMIT", {
      limit_scope: "result", offending_paths: facts.plan.prepared.payloads.map((item) => item.path).sort(),
      current_bytes: resultBytes, byte_cap: RESULT_BYTE_CAP,
    }));
  }
  const taskBytes = retainedBytes + resultBytes;
  if (taskBytes > TASK_BYTE_CAP) {
    return fail(createProjectError("SNAPSHOT_LIMIT", {
      limit_scope: "task", offending_paths: facts.plan.prepared.payloads.map((item) => item.path).sort(),
      current_bytes: taskBytes, byte_cap: TASK_BYTE_CAP,
    }));
  }
  if (!replay && facts.plan.prepared.manifest.value.accounting.task_bytes !== taskBytes) {
    throw new TypeError("prepared snapshot creation-time accounting is stale");
  }
  const creationRetainedBytes = replay
    ? parseSafeInteger(facts.plan.prepared.manifest.value.accounting.task_bytes - resultBytes)
    : retainedBytes;
  const revalidated = prepareSnapshot({
    manifest: facts.plan.prepared.manifest.value,
    payloads: facts.plan.prepared.payloads,
    retained_task_bytes: creationRetainedBytes,
    validate_manifest: parseResultManifest,
  });
  if (!revalidated.ok) return revalidated;
  try {
    await ensureResultDirectory(authority, revalidated.value.result_digest);
    for (const payload of revalidated.value.payloads) {
      if (payload.target.path_class !== "workspace-result-payload") {
        throw new TypeError("result payload target has the wrong storage class");
      }
      await ensurePayloadParent(
        authority,
        revalidated.value.result_digest,
        payload.target.absolute,
      );
    }
  } catch {
    return fail(createProjectError("SNAPSHOT_INVALID", {
      snapshot_digest: revalidated.value.manifest.value.snapshot_digest,
      issue_code: "immutable-install-disagreement",
    }));
  }
  const installed = await installSnapshot(
    dependencies.atomic,
    revalidated.value,
    facts.plan.manifest_target,
    facts.plan.worktree_root,
  );
  if (!installed.ok) return installed;
  let projected;
  try {
    for (const entry of facts.plan.projection_plan.entries) {
      if ("workspaceRelative" in entry.target) {
        await ensureWorkspaceProjectionParent(authority, entry.target.absolute);
      } else {
        await ensureTaskProjectionParent(authority, entry.target.absolute);
      }
    }
    projected = await applyProjectionPlan(dependencies.projection_writer, facts.plan.projection_plan);
  } catch (error) {
    const classified = projectionWriteFailure(error, authority, current.value.task_id);
    if (classified === undefined) throw error;
    return classified;
  }
  if (projected.outcome !== "applied") {
    return fail(createProjectError("SNAPSHOT_INVALID", {
      snapshot_digest: facts.plan.prepared.manifest.value.snapshot_digest,
      issue_code: `projection-${projected.outcome}`,
    }));
  }
  return ok(undefined);
}

/** Post-commit cleanup never changes the already-authenticated outcome. */
async function cleanupCommittedWorkspace(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  committed: TaskStateV1,
): Promise<void> {
  try {
    await cleanTaskWorkspace(dependencies, authority, committed);
  } catch {
    // Cleanup debt is derived and reported by status; authority is already committed.
  }
}

async function installPlan<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  intentPath: ResolvedWorkspacePath,
  current: CanonicalDocument<TaskStateV1>,
  plan: PlannedCommit<K>,
  receiptAlreadyExists: boolean,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  const resumesResult = plan.receipt.value.operation === "record-document-artifact" ||
    plan.receipt.value.operation === "record-implementation-output" ||
    plan.receipt.value.operation === "record-triage" ||
    plan.receipt.value.operation === "counter-review";
  if (receiptAlreadyExists && resumesResult) {
    // A counter-review receipt may have installed a second, constitution-review result in the
    // same commit; both were part of this receipt's prepared state, so both resume here. The
    // fingerprint match selects exactly the references this request round installed.
    const references = plan.final.value.authoritative_results.filter((entry) =>
      entry.result_id === plan.receipt.value.result_id ||
      (plan.receipt.value.operation === "counter-review" &&
        entry.step === "adjudicate" &&
        entry.phase_instance === plan.final.value.phase_instance &&
        entry.input_fingerprint === plan.receipt.value.input_fingerprint));
    for (const reference of references) {
      if (dependencies.load_retained_result === undefined) return stateIssue(current.value, "result-resume-unavailable");
      const loaded = await dependencies.load_retained_result(reference);
      if (!loaded.ok) return loaded;
      const resumed = await installResultFacts(dependencies, request.authority, current, materializeResultInstallation({
        reference,
        prepared: loaded.value.prepared,
        manifest_target: loaded.value.manifest_target,
        projection_plan: loaded.value.projection_plan,
        worktree_root: loaded.value.worktree_root,
      }), true);
      if (!resumed.ok) return resumed;
    }
  } else {
    if (plan.result_installation !== undefined) {
      const installed = await installResultFacts(dependencies, request.authority, current, plan.result_installation, false);
      if (!installed.ok) return installed;
    }
    if (plan.constitution_installation !== undefined) {
      const installed = await installResultFacts(dependencies, request.authority, current, plan.constitution_installation, false);
      if (!installed.ok) return installed;
    }
  }
  try {
    await ensureIntentDirectory(request.authority);
  } catch (error) {
    if (error instanceof IntentLayoutError) return io(request.authority, "intent-receipt-create");
    throw error;
  }
  if (!receiptAlreadyExists) {
    try {
      const created = await dependencies.atomic.createExclusive(intentPath, plan.receipt.bytes);
      if (created === "exists") {
        const collision = await dependencies.read_receipt(intentPath);
        if (collision.kind !== "canonical") {
          if (collision.kind === "unreadable") return io(request.authority, "intent-receipt-read");
          return issue("CONTRACT_INVALID", collision.kind === "missing"
            ? "intent-receipt-missing"
            : "intent-receipt-noncanonical");
        }
        if (collision.document.digest !== plan.receipt.digest) {
          return handleExisting(dependencies, request, intentPath, current, collision.document, () => undefined);
        }
      }
    } catch (error) {
      if (!(error instanceof AtomicReplaceError)) throw error;
      if (error.target_may_have_changed) {
        return arbitrate(dependencies, request, intentPath, current, plan, "intent-receipt-create");
      }
      return io(request.authority, "intent-receipt-create");
    }
  }

  try {
    await dependencies.atomic.replace(request.authority.state, plan.final.bytes);
  } catch (error) {
    if (!(error instanceof AtomicReplaceError)) throw error;
    if (error.target_may_have_changed) {
      return arbitrate(dependencies, request, intentPath, current, plan, "task-state-replace");
    }
    return io(request.authority, "task-state-replace");
  }

  const observed = await dependencies.read_state(request.authority.state);
  if (observed.kind !== "canonical") {
    return observed.kind === "missing"
      ? issue("CONTRACT_INVALID", "transaction-outcome-ambiguous")
      : stateIssue(current.value, "transaction-outcome-ambiguous");
  }
  const committed = validateDurableSemantics(createCommittedIntentSubject(observed.document, plan.receipt));
  if (!committed.ok) return committed;
  await cleanupCommittedWorkspace(dependencies, request.authority, observed.document.value);
  return outcomeResult(observed.document, plan.outcome, false);
}

async function handleExisting<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  intentPath: ResolvedWorkspacePath,
  current: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>,
  onPlan: (plan: PlannedCommit<K>) => void,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  const local = validateReceiptLocally(receipt);
  if (!local.ok) return local;
  const identity = validateReceiptIdentity(request, receipt.value);
  if (!identity.ok) return identity;

  const claimed = current.value.last_transition?.intent_id === request.call.input.intent_id;
  if (claimed) return authenticateCommitted(request, current, receipt);

  if (receipt.value.prior_revision > current.value.revision) {
    return taskIssue(receipt.value.task_id, "intent-receipt-future-revision");
  }

  const identified = receipt.value.resulting_revision <= current.value.revision
    ? identifyFromReceipt(request, receipt.value)
    : await liveIdentification(dependencies, request, current);
  if (!identified.ok) return identified;
  if (identified.value.request_digest !== receipt.value.request_digest) {
    return mismatch(receipt.value.request_digest, identified.value.request_digest);
  }

  if (receipt.value.resulting_revision <= current.value.revision) {
    return fail(createProjectError("INTENT_NOT_CURRENT", {
      intent_id: receipt.value.intent_id,
      receipt_revision: receipt.value.resulting_revision,
      current_revision: current.value.revision,
    }));
  }

  // Local successor arithmetic plus the future/retired branches above prove that the only
  // remaining receipt is the immediate successor of `current`.
  const final = committedState(receipt);
  const semantics = validatePreparedAndCommitted(current, receipt, final);
  if (!semantics.ok) return semantics;
  const outcome = replayOutcome(request, receipt.value);
  if (!outcome.ok) return outcome;
  const plan = Object.freeze({ receipt, final, outcome: outcome.value });
  onPlan(plan);
  return installPlan(
    dependencies,
    request,
    intentPath,
    current,
    plan,
    true,
  );
}

async function executeLocked<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  intentPath: ResolvedWorkspacePath,
  prepare: (
    current: CanonicalDocument<TaskStateV1>,
    call: Extract<RequestIdentifiedToolCall, { readonly name: K }>,
  ) => Promise<ProjectResult<PreparedTransaction<K>>>,
  onPlan: (current: CanonicalDocument<TaskStateV1>, plan: PlannedCommit<K>) => void,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  const stateRead = await dependencies.read_state(request.authority.state);
  if (stateRead.kind !== "canonical") return stateReadFailure(stateRead);
  const current = stateRead.document;
  const stateSemantics = validateDurableSemantics({ state: current });
  if (!stateSemantics.ok) return stateSemantics;
  const repository = verifyRepositoryIdentity(current.value.repository_identity_digest, request.authority.repository_identity);
  if (!repository.ok) return repository;
  const last = current.value.last_transition;
  if (last?.intent_id === request.call.input.intent_id) {
    if (
      request.call.input.expected_revision !== current.value.revision &&
      request.call.input.expected_revision !== last.prior_revision
    ) {
      return fail(createProjectError("STATE_CONFLICT", {
        expected_revision: request.call.input.expected_revision,
        observed_revision: current.value.revision,
      }));
    }
    return replayLastTransition(request, current, last);
  }
  if (request.call.input.expected_revision !== current.value.revision) {
    return fail(createProjectError("STATE_CONFLICT", {
      expected_revision: request.call.input.expected_revision,
      observed_revision: current.value.revision,
    }));
  }

  const receiptRead = await dependencies.read_receipt(intentPath);
  if (receiptRead.kind === "canonical") {
    return handleExisting(dependencies, request, intentPath, current, receiptRead.document, (plan) => onPlan(current, plan));
  }
  const claimed = false;
  const shellFailure = receiptShellFailure(current.value, claimed, receiptRead, request.authority);
  if (shellFailure !== undefined) return shellFailure;

  if (current.value.revision === Number.MAX_SAFE_INTEGER) {
    // The persistence schema legitimately admits the safe-integer ceiling, but a caller asking
    // this advancing kernel to prepare its successor violates the kernel boundary. Reject before
    // preparation rather than allowing callback code to construct an unrepresentable revision.
    throw new TypeError("state revision cannot advance beyond the safe-integer range");
  }
  const identified = await liveIdentification(dependencies, request, current);
  if (!identified.ok) return identified;
  const prepared = await prepare(current, identified.value.call);
  if (!prepared.ok) return prepared;
  const plan = buildPlan(
    request,
    current,
    identified.value,
    ownDataField(prepared, "value", "prepare result"),
    dependencies.runner.location.worktreeRoot,
  );
  if (!plan.ok) return plan;
  onPlan(current, plan.value);
  return installPlan(dependencies, request, intentPath, current, plan.value, false);
}

export async function runStateTransaction<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  prepare: (
    current: CanonicalDocument<TaskStateV1>,
    call: Extract<RequestIdentifiedToolCall, { readonly name: K }>,
  ) => Promise<ProjectResult<PreparedTransaction<K>>>,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  assertInternalTransactionAuthority(request.authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  assertAuthenticParsedToolCall(request.call);
  requirePath(request.authority.state, "task-state", "authority state");
  requirePath(request.authority.config, "task-config", "authority config");
  const intent = await resolveIntentTarget(dependencies, request);
  if (!intent.ok) return intent;
  try {
    await ensureIntentDirectory(request.authority);
  } catch (error) {
    if (error instanceof IntentLayoutError) return io(request.authority, "intent-receipt-create");
    throw error;
  }

  let completed: ProjectResult<TransactionOutcome<K>> | undefined;
  let arbitrationFacts: Readonly<{
    current: CanonicalDocument<TaskStateV1>;
    plan: PlannedCommit<K>;
  }> | undefined;
  const finalize = async (result: ProjectResult<TransactionOutcome<K>>): Promise<ProjectResult<TransactionOutcome<K>>> => {
    if (result.ok && result.value.state.value.terminal !== undefined) {
      await cleanTerminalTaskWorkspace(dependencies, request.authority).catch(() => undefined);
    }
    return result;
  };
  try {
    const result = await dependencies.lock.runExclusive(request.authority.workspace_root, async () => {
      completed = await executeLocked(dependencies, request, intent.value, prepare, (current, plan) => {
        arbitrationFacts = Object.freeze({ current, plan });
      });
      return completed;
    });
    return finalize(result);
  } catch (error) {
    if (!(error instanceof TaskLockError)) throw error;
    if (error.stage === "acquire") return io(request.authority, "task-lock-acquire");
    if (completed === undefined && error.cause !== undefined) throw error.cause;
    if (completed?.ok) return finalize(completed);
    if (arbitrationFacts !== undefined) {
      return arbitrate(
        dependencies,
        request,
        intent.value,
        arbitrationFacts.current,
        arbitrationFacts.plan,
        "task-lock-release",
        completed,
      );
    }
    return io(request.authority, "task-lock-release");
  }
}
