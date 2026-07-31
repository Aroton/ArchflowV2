import { isAbsolute, relative } from "node:path";

import {
  canonicalDocument,
  canonicalJsonDigest,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import { checkpointSelfDigest, selectGreatestValidChain, chainAnchor, type InitialImportV1 } from "../contracts/durable-checkpoint.js";
import {
  createCommittedIntentSubject,
  validateDurableSemantics,
  type DurableArtifact,
} from "../contracts/durable.js";
import {
  intentOutcomeDigest,
  intentReceiptDigest,
  parseIntentReceipt,
  type IntentReceiptV1,
} from "../contracts/durable-intent.js";
import type { CommittedIntentRef, TaskStateV1 } from "../contracts/durable-state.js";
import type { LegacyImportInitializationV1 } from "../contracts/durable-legacy-import.js";
import type { TaskInitializationV1 } from "../contracts/durable-task-initialization.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode } from "../contracts/evidence.js";
import { computeInputFingerprint } from "../contracts/fingerprints.js";
import {
  assertAuthenticParsedToolCall,
  createInternalResultExpectation,
  validateProjectResultStructure,
  type ParsedToolCall,
  type ToolSuccess,
} from "../contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import { resolveTaskPath, type ResolvedPath } from "../repository/paths.js";
import { AtomicReplaceError } from "./atomic.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import { identifyTransactionRequest } from "./request.js";
import { IntentLayoutError, ensureIntentDirectory } from "./layout.js";
import { TaskLockError } from "./lock.js";
import type { TransactionDependencies, TransactionOutcome, TransactionRequest } from "./transaction.js";
import { planStateTransition } from "./transitions.js";

type InitializationArtifact = TaskInitializationV1 | LegacyImportInitializationV1;
type StateCall = Extract<ParsedToolCall, { readonly name: "archflow_state" }>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });
const contract = (issue_code: string): ProjectResult<never> => fail(createProjectError("CONTRACT_INVALID", { issue_code }));
const io = (request: TransactionRequest<"archflow_state">, operation: string): ProjectResult<never> =>
  fail(createProjectError("IO_ERROR", { operation, attempt: request.authority.context.attempt }));

function initializationFor(artifact: DurableArtifact): InitializationArtifact | undefined {
  if (artifact.artifact_kind === "task-initialization" || artifact.artifact_kind === "legacy-import-initialization") {
    return artifact;
  }
  if (artifact.artifact_kind !== "manual-checkpoint-import" || artifact.import_mode !== "initial") return undefined;
  const first = artifact.chain[0];
  return first !== undefined && "initialization" in first ? first.initialization : undefined;
}

function operationFor(artifact: DurableArtifact): IntentReceiptV1["operation"] {
  if (artifact.artifact_kind === "task-initialization") return "adopt-task-initialization" as IntentReceiptV1["operation"];
  if (artifact.artifact_kind === "legacy-import-initialization") return "adopt-legacy-import-initialization" as IntentReceiptV1["operation"];
  if (artifact.artifact_kind === "manual-checkpoint-import") return "adopt-manual-checkpoint-import" as IntentReceiptV1["operation"];
  throw new TypeError("revision-0 initialization received a non-initialization artifact");
}

async function validateLiveInitialization(
  dependencies: TransactionDependencies,
  request: TransactionRequest<"archflow_state">,
  initialization: InitializationArtifact,
): Promise<ProjectResult<void>> {
  const taskRoot = `.archflow/tasks/${request.authority.task_id}`;
  const expectedPaths = {
    task_root: taskRoot,
    config: request.authority.config.repositoryRelative,
    state: request.authority.state.repositoryRelative,
    workflow: ".archflow/workflow.yaml",
    constitution_root: ".archflow/constitution",
  };
  if (
    initialization.canonical_paths.task_root !== expectedPaths.task_root ||
    initialization.canonical_paths.config !== expectedPaths.config ||
    initialization.canonical_paths.state !== expectedPaths.state ||
    initialization.canonical_paths.workflow !== expectedPaths.workflow ||
    initialization.canonical_paths.constitution_root !== expectedPaths.constitution_root
  ) return contract("initialization-canonical-paths-mismatch");

  const commits = initialization.artifact_kind === "task-initialization"
    ? [initialization.code_baseline_commit, initialization.policy_base_commit]
    : [initialization.import_baseline_commit, initialization.code_baseline_commit, initialization.policy_base_commit];
  for (const oid of new Set(commits)) {
    try {
      const observed = await dependencies.runner.run({
        argv: ["rev-parse", "--verify", "--quiet", `${oid}^{commit}`],
        operation: parseSafeCode("validate-initialization-commit"),
        expectedAbsence: [{ code: 1, stderrIncludes: "" }],
      });
      if (observed.absent) return contract("initialization-commit-missing");
      const resolved = new TextDecoder("utf-8", { fatal: true }).decode(observed.stdout).trim();
      if (resolved !== oid) return contract("initialization-commit-mismatch");
    } catch {
      return io(request, "validate-initialization-commit");
    }
  }
  // A legacy source identity names another repository. Phase 10 has no authenticated source
  // runner or staged-payload enumerator, so this boundary validates only the destination identity
  // plus the three commit objects resolvable in the authenticated current repository.
  return ok(undefined);
}

function initialState(call: StateCall, artifact: DurableArtifact): ProjectResult<TaskStateV1> {
  const initialization = initializationFor(artifact);
  if (initialization === undefined) return contract("initialization-artifact-required");
  let head: InitialImportV1["chain"][number] | undefined;
  if (artifact.artifact_kind === "manual-checkpoint-import") {
    if (artifact.import_mode !== "initial") return contract("initialization-import-mode-invalid");
    const selected = selectGreatestValidChain(chainAnchor(artifact), artifact.chain);
    if (selected.kind !== "chain" || selected.chain.length !== artifact.chain.length) {
      return contract(selected.kind === "stop" ? `initialization-chain-${selected.outcome}` : "initialization-chain-not-exact");
    }
    head = selected.chain.at(-1);
    if (head === undefined) return contract("initialization-chain-empty");
    if (
      head.phase_instance !== call.input.phase_instance ||
      head.step !== call.input.step ||
      head.status !== call.input.status ||
      head.input_fingerprint !== call.input.input_fingerprint
    ) return contract("initialization-chain-head-request-mismatch");

    const first = selected.chain[0];
    if (first === undefined || !("initialization" in first)) return contract("initialization-chain-head-invalid");
    let cursor: TaskStateV1 = {
      schema_version: "1",
      task_id: initialization.task_id,
      repository_identity_digest: initialization.repository_identity_digest,
      revision: 1 as TaskStateV1["revision"],
      phase_instance: first.phase_instance,
      step: first.step,
      status: first.status,
      attempt: first.attempt,
      input_fingerprint: first.input_fingerprint,
      initialization_digest: first.initialization_digest,
      config_digest: initialization.config_digest,
      workflow_digest: initialization.workflow_digest,
      constitution_digest: initialization.constitution_digest,
      policy_base_commit: initialization.policy_base_commit,
      authoritative_results: structuredClone(first.authoritative_results),
      approvals: structuredClone(first.approvals),
      waivers: structuredClone(first.waivers),
      ...(first.open_gate === undefined ? {} : { open_gate: structuredClone(first.open_gate) }),
      ...(first.terminal === undefined ? {} : { terminal: first.terminal }),
    };
    for (const checkpoint of selected.chain.slice(1)) {
      const resultReference = checkpoint.status === "succeeded"
        ? checkpoint.authoritative_results.find((reference) =>
            reference.phase_instance === checkpoint.phase_instance &&
            reference.step === checkpoint.step &&
            reference.input_fingerprint === checkpoint.input_fingerprint)
        : undefined;
      const transition = planStateTransition({
        current: cursor,
        target: {
          phase_instance: checkpoint.phase_instance,
          step: checkpoint.step,
          status: checkpoint.status,
          attempt: checkpoint.attempt,
          input_fingerprint: checkpoint.input_fingerprint,
        },
        recomputed_input_fingerprint: checkpoint.input_fingerprint,
        artifact,
        ...(resultReference === undefined ? {} : { result_reference: resultReference }),
      });
      if (!transition.ok) return transition;
      cursor = { ...transition.value, revision: cursor.revision };
    }
  }

  const source = head;
  const state: TaskStateV1 = {
    schema_version: "1",
    task_id: initialization.task_id,
    repository_identity_digest: initialization.repository_identity_digest,
    revision: 1 as TaskStateV1["revision"],
    phase_instance: source?.phase_instance ?? call.input.phase_instance,
    step: source?.step ?? call.input.step,
    status: source?.status ?? call.input.status,
    attempt: source?.attempt ?? (1 as TaskStateV1["attempt"]),
    input_fingerprint: source?.input_fingerprint ?? call.input.input_fingerprint,
    initialization_digest: canonicalJsonDigest(initialization),
    config_digest: initialization.config_digest,
    workflow_digest: initialization.workflow_digest,
    constitution_digest: initialization.constitution_digest,
    policy_base_commit: initialization.policy_base_commit,
    authoritative_results: structuredClone(source?.authoritative_results ?? []),
    approvals: structuredClone(source?.approvals ?? []),
    waivers: structuredClone(source?.waivers ?? []),
    ...(source === undefined ? {} : {
      adopted_checkpoint: { revision: source.revision as TaskStateV1["revision"], checkpoint_digest: checkpointSelfDigest(source) },
    }),
    ...(source?.open_gate === undefined ? {} : { open_gate: structuredClone(source.open_gate) }),
    ...(source?.terminal === undefined ? {} : { terminal: source.terminal }),
  };
  return ok(state);
}

async function intentTarget(
  dependencies: TransactionDependencies,
  request: TransactionRequest<"archflow_state">,
): Promise<ProjectResult<ResolvedPath>> {
  const claim = parseTaskPathClaim(`intents/${request.call.input.intent_id}.json`);
  const result = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: request.authority.task_id,
    claim,
    expectedClass: "intent",
    context: request.authority.context,
  });
  if (!result.ok) return result;
  const rel = relative(request.authority.task_root, result.value.absolute);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new TypeError("initialization intent target escaped the task root");
  }
  return result;
}

function committed(receipt: CanonicalDocument<IntentReceiptV1>): CanonicalDocument<TaskStateV1> {
  const value = receipt.value;
  const reference: CommittedIntentRef = {
    intent_id: value.intent_id,
    request_digest: value.request_digest,
    receipt_digest: receipt.digest,
    outcome_digest: value.outcome_digest,
    prior_revision: value.prior_revision,
    resulting_revision: value.resulting_revision,
    result_id: value.result_id,
  };
  return canonicalDocument({ ...value.prepared_state, committed_intent: reference });
}

function replay(
  request: TransactionRequest<"archflow_state">,
  state: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>,
): ProjectResult<TransactionOutcome<"archflow_state">> {
  const semantic = validateDurableSemantics(createCommittedIntentSubject(state, receipt));
  if (!semantic.ok) return semantic;
  const artifact = request.call.input.artifact;
  if (
    receipt.value.tool !== "archflow_state" ||
    receipt.value.intent_id !== request.call.input.intent_id ||
    receipt.value.task_id !== request.authority.task_id ||
    receipt.value.repository_identity_digest !== request.authority.repository_identity_digest ||
    receipt.value.prior_revision !== 0 ||
    receipt.value.resulting_revision !== 1
  ) return contract("initialization-receipt-identity-mismatch");
  if (artifact === undefined || receipt.value.operation !== operationFor(artifact)) return contract("initialization-receipt-operation-mismatch");
  if (receipt.value.input_fingerprint !== request.call.input.input_fingerprint) {
    return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", {
      expected_digest: receipt.value.input_fingerprint,
      observed_digest: request.call.input.input_fingerprint,
    }));
  }
  const identified = identifyTransactionRequest(request.call, request.authority, receipt.value.input_fingerprint);
  if (identified.request_digest !== receipt.value.request_digest) {
    return fail(createProjectError("INTENT_MISMATCH", {
      expected_digest: receipt.value.request_digest,
      observed_digest: identified.request_digest,
    }));
  }
  const outcome = validateProjectResultStructure(request.call, { schema_version: "1", ok: true, value: receipt.value.outcome });
  if (!outcome.ok) return outcome;
  return ok(Object.freeze({ state, outcome: outcome.value, replayed: true }));
}

async function executeLocked(
  dependencies: TransactionDependencies,
  request: TransactionRequest<"archflow_state">,
  path: ResolvedPath,
): Promise<ProjectResult<TransactionOutcome<"archflow_state">>> {
  const stateRead = await dependencies.read_state(request.authority.state);
  if (stateRead.kind === "canonical") {
    const repository = verifyRepositoryIdentity(stateRead.document.value.repository_identity_digest, request.authority.repository_identity);
    if (!repository.ok) return repository;
    const receiptRead = await dependencies.read_receipt(path);
    if (
      stateRead.document.value.revision === 1 &&
      stateRead.document.value.committed_intent?.intent_id === request.call.input.intent_id &&
      receiptRead.kind === "canonical"
    ) return replay(request, stateRead.document, receiptRead.document);
    return fail(createProjectError("STATE_CONFLICT", { expected_revision: 0, observed_revision: stateRead.document.value.revision }));
  }
  if (stateRead.kind !== "missing") return contract(stateRead.kind === "unreadable" ? "task-state-unreadable" : "task-state-noncanonical");

  const artifactValue = request.call.input.artifact;
  if (request.call.input.expected_revision !== 0 || artifactValue === undefined) return contract("revision-zero-initialization-required");
  assertPlainJson(artifactValue, "initialization artifact");
  const artifact = structuredClone(artifactValue) as DurableArtifact;
  const initialization = initializationFor(artifact);
  if (initialization === undefined) return contract("initialization-artifact-required");
  if (initialization.task_id !== request.authority.task_id) return contract("initialization-task-mismatch");
  const repository = verifyRepositoryIdentity(initialization.repository_identity_digest, request.authority.repository_identity);
  if (!repository.ok) return repository;
  const liveInitialization = await validateLiveInitialization(dependencies, request, initialization);
  if (!liveInitialization.ok) return liveInitialization;

  const artifactDocument = canonicalDocument(artifact);
  const artifactSemantics = validateDurableSemantics({ artifact: artifactDocument });
  if (!artifactSemantics.ok) return artifactSemantics;
  const stateResult = initialState(request.call, artifact);
  if (!stateResult.ok) return stateResult;
  const preparedState = canonicalDocument(stateResult.value);
  const initializationSemantics = validateDurableSemantics({
    state: preparedState,
    artifact: canonicalDocument(initialization),
  });
  if (!initializationSemantics.ok) return initializationSemantics;

  const config = await dependencies.read_config(request.authority.config);
  if (config.kind !== "valid") return config.kind === "invalid" ? contract("task-config-invalid") : io(request, "task-config-read");
  if (config.snapshot.digest !== initialization.config_digest) {
    return fail(createProjectError("PINNED_CONFIG_MISMATCH", {
      expected_digest: initialization.config_digest,
      observed_digest: config.snapshot.digest,
    }));
  }
  const fingerprint = await dependencies.resolve_input_fingerprint({
    runner: dependencies.runner,
    authority: request.authority,
    state: preparedState,
    call: request.call,
    live_config: config.snapshot,
    context: request.authority.context,
  });
  if (!fingerprint.ok) return fingerprint;
  assertPlainJson(fingerprint.value, "initialization fingerprint subject");
  const inputFingerprint = computeInputFingerprint(structuredClone(fingerprint.value));
  if (inputFingerprint !== request.call.input.input_fingerprint) {
    return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", {
      expected_digest: inputFingerprint,
      observed_digest: request.call.input.input_fingerprint,
    }));
  }
  const identified = identifyTransactionRequest(request.call, request.authority, inputFingerprint);

  const success = { path: parseTaskPathClaim("state.json"), revision: 1, status: request.call.input.status };
  const expectation = createInternalResultExpectation({
    schema_version: "1",
    tool: "archflow_state",
    task_id: request.authority.task_id,
    intent_id: request.call.input.intent_id,
    input_fingerprint: inputFingerprint,
    request_digest: identified.request_digest,
    result_id: request.call.input.intent_id,
    resulting_revision: 1,
    success,
  });
  const result = validateProjectResultStructure(request.call, { schema_version: "1", ok: true, value: success });
  if (!result.ok) return result;
  const outcome = structuredClone(result.value as unknown as PlainJsonValue) as unknown as ToolSuccess<"archflow_state">;
  const receipt = canonicalDocument(parseIntentReceipt({
    schema_version: "1",
    intent_id: request.call.input.intent_id,
    task_id: request.authority.task_id,
    repository_identity_digest: request.authority.repository_identity_digest,
    tool: "archflow_state",
    operation: operationFor(artifact),
    request_digest: expectation.request_digest,
    input_fingerprint: inputFingerprint,
    prior_revision: 0,
    resulting_revision: 1,
    result_id: expectation.result_id,
    outcome_digest: intentOutcomeDigest(outcome as unknown as PlainJsonValue),
    outcome: outcome as unknown as PlainJsonValue,
    prepared_state_digest: preparedState.digest,
    prepared_state: preparedState.value,
  }));
  if (intentReceiptDigest(receipt.value) !== receipt.digest) throw new TypeError("initialization receipt digest mismatch");
  const final = committed(receipt);
  const existing = await dependencies.read_receipt(path);
  if (existing.kind === "canonical") {
    if (existing.document.digest !== receipt.digest) {
      return fail(createProjectError("INTENT_MISMATCH", { expected_digest: existing.document.digest, observed_digest: receipt.digest }));
    }
  } else if (existing.kind !== "missing") {
    return existing.kind === "unreadable" ? io(request, "intent-receipt-read") : contract("intent-receipt-noncanonical");
  }

  try {
    await ensureIntentDirectory(request.authority);
    if (existing.kind === "missing") {
      const created = await dependencies.atomic.createExclusive(path, receipt.bytes);
      if (created === "exists") {
        const collision = await dependencies.read_receipt(path);
        if (collision.kind !== "canonical" || collision.document.digest !== receipt.digest) {
          return contract("intent-receipt-collision");
        }
      }
    }
    await dependencies.atomic.replace(request.authority.state, final.bytes);
  } catch (error) {
    if (error instanceof IntentLayoutError) return io(request, "intent-receipt-create");
    if (!(error instanceof AtomicReplaceError)) throw error;
    const observed = await dependencies.read_state(request.authority.state);
    if (observed.kind === "canonical" && observed.document.digest === final.digest) {
      return ok(Object.freeze({ state: observed.document, outcome, replayed: false }));
    }
    if (observed.kind === "missing") return io(request, error.operation === "replace" ? "task-state-replace" : "intent-receipt-create");
    return contract("transaction-outcome-ambiguous");
  }
  const observed = await dependencies.read_state(request.authority.state);
  if (observed.kind !== "canonical" || observed.document.digest !== final.digest) return contract("transaction-outcome-ambiguous");
  return ok(Object.freeze({ state: observed.document, outcome, replayed: false }));
}

/** Runs the only state-absent transaction, committing revision 1 exactly once. */
export async function runStateInitialization(
  dependencies: TransactionDependencies,
  request: TransactionRequest<"archflow_state">,
): Promise<ProjectResult<TransactionOutcome<"archflow_state">>> {
  assertInternalTransactionAuthority(request.authority, { runner: dependencies.runner, environment: dependencies.environment });
  assertAuthenticParsedToolCall(request.call);
  const path = await intentTarget(dependencies, request);
  if (!path.ok) return path;
  let completed: ProjectResult<TransactionOutcome<"archflow_state">> | undefined;
  try {
    return await dependencies.lock.runExclusive(request.authority.task_root, async () => {
      completed = await executeLocked(dependencies, request, path.value);
      return completed;
    });
  } catch (error) {
    if (!(error instanceof TaskLockError)) throw error;
    if (error.stage === "acquire") return io(request, "task-lock-acquire");
    if (completed !== undefined) return completed;
    if (error.cause !== undefined) throw error.cause;
    return io(request, "task-lock-release");
  }
}
