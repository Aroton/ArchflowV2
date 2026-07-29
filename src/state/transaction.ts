import { isDeepStrictEqual } from "node:util";
import { isAbsolute, relative } from "node:path";

import {
  canonicalDocument,
  canonicalJsonDigest,
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
import type { CommittedIntentRef, TaskStateV1 } from "../contracts/durable-state.js";
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
import type { GitEnvironment } from "../repository/git.js";
import { verifyRepositoryIdentity, type RootBoundGitRunner } from "../repository/identity.js";
import { resolveTaskPath, type ResolvedPath } from "../repository/paths.js";
import { AtomicReplaceError, type AtomicWriter } from "./atomic.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import type { InputFingerprintResolver } from "./fingerprint.js";
import { identifyTransactionRequest } from "./request.js";
import { IntentLayoutError, ensureIntentDirectory } from "./layout.js";
import type {
  ConfigReadResult,
  ReceiptReadResult,
  StateReadResult,
} from "./read.js";
import { TaskLockError, type TaskLock } from "./lock.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;

export type TransactionDependencies = Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  atomic: AtomicWriter;
  lock: TaskLock;
  resolve_input_fingerprint: InputFingerprintResolver;
  read_state: (path: ResolvedPath) => Promise<StateReadResult>;
  read_config: (path: ResolvedPath) => Promise<ConfigReadResult>;
  read_receipt: (path: ResolvedPath) => Promise<ReceiptReadResult>;
}>;

export type NextStateDraft = Omit<TaskStateV1, "revision" | "committed_intent"> & {
  readonly revision?: never;
  readonly committed_intent?: never;
};

export type PreparedTransaction<K extends ToolName> = Readonly<{
  expectation: ResultExpectation<K>;
  result: StructurallyValidProjectResult<K>;
  next_state: NextStateDraft;
}>;

export type TransactionRequest<K extends ToolName = ToolName> = Readonly<{
  call: Extract<ParsedToolCall, { readonly name: K }>;
  authority: TransactionAuthority;
}>;

export type TransactionOutcome<K extends ToolName> = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  outcome: ToolSuccess<K>;
  replayed: boolean;
}>;

type Identified<K extends ToolName> = ReturnType<typeof identifyTransactionRequest<K>>;

type PlannedCommit<K extends ToolName> = Readonly<{
  receipt: CanonicalDocument<IntentReceiptV1>;
  final: CanonicalDocument<TaskStateV1>;
  outcome: ToolSuccess<K>;
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

function mismatch(expected_digest: Sha256Digest, observed_digest: Sha256Digest): ProjectResult<never> {
  return fail(createProjectError("INTENT_MISMATCH", { expected_digest, observed_digest }));
}

function fingerprintMismatch(expected_digest: Sha256Digest, observed_digest: Sha256Digest): ProjectResult<never> {
  return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", { expected_digest, observed_digest }));
}

function operationFor(tool: ToolName): IntentReceiptV1["operation"] {
  switch (tool) {
    case "archflow_state": return "record-state-boundary" as IntentReceiptV1["operation"];
    case "archflow_counter_review": return "counter-review" as IntentReceiptV1["operation"];
    case "archflow_adjudicate": return "adjudicate" as IntentReceiptV1["operation"];
    case "archflow_gate": return "gate" as IntentReceiptV1["operation"];
    case "archflow_waiver": return "waiver" as IntentReceiptV1["operation"];
    default: {
      const exhaustive: never = tool;
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
  if (Object.hasOwn(value as object, "revision") || Object.hasOwn(value as object, "committed_intent")) {
    throw new TypeError("next state draft cannot carry revision or committed_intent");
  }
  return structuredClone(value as PlainJsonValue) as NextStateDraft;
}

function sameCheckpoint(left: TaskStateV1["adopted_checkpoint"], right: TaskStateV1["adopted_checkpoint"]): boolean {
  return isDeepStrictEqual(left, right);
}

function assertPreserved(current: TaskStateV1, next: NextStateDraft): void {
  if (
    next.task_id !== current.task_id ||
    next.repository_identity_digest !== current.repository_identity_digest ||
    next.initialization_digest !== current.initialization_digest ||
    next.config_digest !== current.config_digest ||
    next.workflow_digest !== current.workflow_digest ||
    next.constitution_digest !== current.constitution_digest ||
    next.policy_base_commit !== current.policy_base_commit ||
    !sameCheckpoint(next.adopted_checkpoint, current.adopted_checkpoint)
  ) {
    throw new TypeError("next state draft changed a transaction-substrate identity or pin");
  }
}

function outcomeResult<K extends ToolName>(
  state: CanonicalDocument<TaskStateV1>,
  outcome: ToolSuccess<K>,
  replayed: boolean,
): ProjectResult<TransactionOutcome<K>> {
  return ok(Object.freeze({ state, outcome, replayed }));
}

async function resolveIntentTarget<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
): Promise<ProjectResult<ResolvedPath>> {
  const claim = parseTaskPathClaim(`intents/${request.call.input.intent_id}.json`);
  const resolved = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: request.authority.task_id,
    claim,
    expectedClass: "intent",
    context: request.authority.context,
  });
  if (!resolved.ok) return resolved;
  requirePath(resolved.value, "intent", "intent target");
  const expectedClaim = `.archflow/tasks/${request.authority.task_id}/${claim}`;
  if (resolved.value.repositoryRelative !== expectedClaim) throw new TypeError("intent target claim mismatch");
  const rel = relative(request.authority.task_root, resolved.value.absolute);
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
  if (receipt.operation !== operationFor(request.call.name)) {
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
  if (receipt.prepared_state.committed_intent !== undefined) {
    return taskIssue(receipt.task_id, "intent-receipt-prepared-state-committed-intent-present");
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

function committedState(
  receiptDocument: CanonicalDocument<IntentReceiptV1>,
): CanonicalDocument<TaskStateV1> {
  const receipt = receiptDocument.value;
  const reference: CommittedIntentRef = {
    intent_id: receipt.intent_id,
    request_digest: receipt.request_digest,
    receipt_digest: receiptDocument.digest,
    outcome_digest: receipt.outcome_digest,
    prior_revision: receipt.prior_revision,
    resulting_revision: receipt.resulting_revision,
    result_id: receipt.result_id,
  };
  return canonicalDocument({ ...receipt.prepared_state, committed_intent: reference });
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

function materializePlan<K extends ToolName>(value: unknown): PreparedTransaction<K> {
  if (value === null || typeof value !== "object") throw new TypeError("prepared transaction must be an object");
  const expected = ["expectation", "next_state", "result"];
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || !isDeepStrictEqual((keys as string[]).sort(), expected)) {
    throw new TypeError("prepared transaction has unexpected or missing slots");
  }
  const expectation = ownDataField(value, "expectation", "prepared transaction") as ResultExpectation<K>;
  const result = ownDataField(value, "result", "prepared transaction") as StructurallyValidProjectResult<K>;
  const nextState = materializeDraft(ownDataField(value, "next_state", "prepared transaction"));
  return { expectation, result, next_state: nextState };
}

function buildPlan<K extends ToolName>(
  request: TransactionRequest<K>,
  current: CanonicalDocument<TaskStateV1>,
  identified: Identified<K>,
  preparedValue: unknown,
): ProjectResult<PlannedCommit<K>> {
  const resultingRevision = parseSafeInteger(current.value.revision + 1);
  const plan = materializePlan<K>(preparedValue);
  const correlated = correlateProjectResult(identified.call, plan.expectation, plan.result);
  if (!correlated.ok) return correlated;
  if (plan.expectation.resulting_revision !== resultingRevision || correlated.value.revision !== resultingRevision) {
    throw new TypeError("prepared transaction revision is not the immediate successor");
  }
  assertPreserved(current.value, plan.next_state);
  const preparedState: TaskStateV1 = { ...plan.next_state, revision: resultingRevision };
  const outcome = structuredClone(correlated.value as unknown as PlainJsonValue) as unknown as ToolSuccess<K>;
  const receiptValue = parseIntentReceipt({
    schema_version: "1",
    intent_id: request.call.input.intent_id,
    task_id: request.authority.task_id,
    repository_identity_digest: request.authority.repository_identity_digest,
    tool: request.call.name,
    operation: operationFor(request.call.name),
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
  return ok(Object.freeze({ receipt, final, outcome }));
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
  intentPath: ResolvedPath,
  predecessor: CanonicalDocument<TaskStateV1>,
  plan: PlannedCommit<K>,
  operation: "intent-receipt-create" | "task-state-replace" | "task-lock-release",
  unchangedFailure?: ProjectResult<TransactionOutcome<K>>,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  const stateRead = await dependencies.read_state(request.authority.state);
  if (stateRead.kind === "canonical") {
    const receiptRead = await dependencies.read_receipt(intentPath);
    if (stateRead.document.digest === plan.final.digest) {
      if (receiptRead.kind !== "canonical") {
        if (receiptRead.kind === "unreadable") return io(request.authority, "intent-receipt-read");
        return stateIssue(stateRead.document.value, receiptRead.kind === "missing"
          ? "intent-receipt-missing"
          : "intent-receipt-noncanonical");
      }
      const committed = validateDurableSemantics(createCommittedIntentSubject(stateRead.document, receiptRead.document));
      if (!committed.ok) return committed;
      if (receiptRead.document.digest !== plan.receipt.digest) {
        return stateIssue(stateRead.document.value, "intent-receipt-reference-digest-mismatch");
      }
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

async function installPlan<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  intentPath: ResolvedPath,
  current: CanonicalDocument<TaskStateV1>,
  plan: PlannedCommit<K>,
  receiptAlreadyExists: boolean,
): Promise<ProjectResult<TransactionOutcome<K>>> {
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
  return outcomeResult(observed.document, plan.outcome, false);
}

async function handleExisting<K extends ToolName>(
  dependencies: TransactionDependencies,
  request: TransactionRequest<K>,
  intentPath: ResolvedPath,
  current: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>,
  onPlan: (plan: PlannedCommit<K>) => void,
): Promise<ProjectResult<TransactionOutcome<K>>> {
  const local = validateReceiptLocally(receipt);
  if (!local.ok) return local;
  const identity = validateReceiptIdentity(request, receipt.value);
  if (!identity.ok) return identity;

  const claimed = current.value.committed_intent?.intent_id === request.call.input.intent_id;
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
  intentPath: ResolvedPath,
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
  const claimed = current.value.committed_intent?.intent_id === request.call.input.intent_id;
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
  const plan = buildPlan(request, current, identified.value, ownDataField(prepared, "value", "prepare result"));
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

  let completed: ProjectResult<TransactionOutcome<K>> | undefined;
  let arbitrationFacts: Readonly<{
    current: CanonicalDocument<TaskStateV1>;
    plan: PlannedCommit<K>;
  }> | undefined;
  try {
    return await dependencies.lock.runExclusive(request.authority.task_root, async () => {
      completed = await executeLocked(dependencies, request, intent.value, prepare, (current, plan) => {
        arbitrationFacts = Object.freeze({ current, plan });
      });
      return completed;
    });
  } catch (error) {
    if (!(error instanceof TaskLockError)) throw error;
    if (error.stage === "acquire") return io(request.authority, "task-lock-acquire");
    if (completed === undefined && error.cause !== undefined) throw error.cause;
    if (completed?.ok) return completed;
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
