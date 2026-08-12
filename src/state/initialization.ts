import { isAbsolute, relative } from "node:path";

import {
  canonicalDocument,
  canonicalJsonDigest,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import { validateDurableSemantics, type DurableArtifact } from "../contracts/durable.js";
import {
  intentOutcomeDigest,
  intentReceiptDigest,
  parseIntentReceipt,
  type IntentReceiptV1,
} from "../contracts/durable-intent.js";
import type { LastTransition, TaskStateV1 } from "../contracts/durable-state.js";
import type { LegacyImportInitializationV1 } from "../contracts/durable-legacy-import.js";
import type { TaskInitializationV1 } from "../contracts/durable-task-initialization.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, type Sha256Digest } from "../contracts/evidence.js";
import { computeInputFingerprint } from "../contracts/fingerprints.js";
import {
  assertAuthenticParsedToolCall,
  createInternalResultExpectation,
  type RequestIdentifiedToolCall,
  validateProjectResultStructure,
  type ParsedToolCall,
  type ToolSuccess,
} from "../contracts/mcp-tools.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import {
  classifyTaskPath,
  initializationAuthorityClaim,
  openResolved,
  parseWorkspacePathClaim,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  type ResolvedPath,
  type ResolvedWorkspacePath,
} from "../repository/paths.js";
import { AtomicReplaceError } from "./atomic.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import { identifyTransactionRequest } from "./request.js";
import { IntentLayoutError, ensureAuthorityDirectory, ensureIntentDirectory } from "./layout.js";
import { TaskLockError } from "./lock.js";
import type { TransactionDependencies, TransactionOutcome, TransactionRequest } from "./transaction.js";
import { cleanTaskWorkspace } from "./workspace-cleanup.js";

type InitializationArtifact = TaskInitializationV1 | LegacyImportInitializationV1;
type StateCall = Extract<ParsedToolCall, { readonly name: "archflow_state" }>;

export type StateInitializationIdentification = Readonly<{
  call: Extract<RequestIdentifiedToolCall, { readonly name: "archflow_state" }>;
  input_fingerprint: Sha256Digest;
  request_digest: Sha256Digest;
  prepared_state: CanonicalDocument<TaskStateV1>;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });
const contract = (issue_code: string): ProjectResult<never> => fail(createProjectError("CONTRACT_INVALID", { issue_code }));
const io = (request: TransactionRequest<"archflow_state">, operation: string): ProjectResult<never> =>
  fail(createProjectError("IO_ERROR", { operation, attempt: request.authority.context.attempt }));

function initializationFor(artifact: DurableArtifact): InitializationArtifact | undefined {
  if (artifact.artifact_kind === "task-initialization" || artifact.artifact_kind === "legacy-import-initialization") {
    return artifact;
  }
  return undefined;
}

function operationFor(artifact: DurableArtifact): IntentReceiptV1["operation"] {
  if (artifact.artifact_kind === "task-initialization") return "adopt-task-initialization" as IntentReceiptV1["operation"];
  if (artifact.artifact_kind === "legacy-import-initialization") return "adopt-legacy-import-initialization" as IntentReceiptV1["operation"];
  throw new TypeError("revision-0 initialization received a non-initialization artifact");
}

function phaseForLegacyDestination(
  taskId: string,
  destinationPath: string,
): PhaseInstanceId | undefined {
  const prefix = `.archflow/tasks/${taskId}/`;
  if (!destinationPath.startsWith(prefix)) return undefined;
  const relativePath = destinationPath.slice(prefix.length);
  if (relativePath === "prd.md" || relativePath === "design.md") {
    return relativePath === "prd.md" ? "prd" as PhaseInstanceId : "design" as PhaseInstanceId;
  }
  const document = /^phases\/([1-9][0-9]*)\/(design|impl-notes)\.md$/u.exec(relativePath);
  if (document !== null) {
    const phase = Number(document[1]);
    if (!Number.isSafeInteger(phase)) return undefined;
    return `${document[2] === "design" ? "phase-design" : "phase-impl"}-${phase}` as PhaseInstanceId;
  }
  const review = /^reviews\/(prd|design|phase-design-[1-9][0-9]*|phase-impl-[1-9][0-9]*)\.(?:self|counter|triage|adjudication)\.md$/u.exec(relativePath) ??
    /^reviews\/(prd|design|phase-design-[1-9][0-9]*|phase-impl-[1-9][0-9]*)\.gate-counter\.[a-z0-9][a-z0-9-]*\.md$/u.exec(relativePath);
  if (review === null) return undefined;
  try {
    decodePhaseInstance(review[1]);
    return review[1] as PhaseInstanceId;
  } catch {
    return undefined;
  }
}

function validateLegacyMapping(initialization: LegacyImportInitializationV1): ProjectResult<void> {
  const staged = new Set(initialization.staged_payload_refs.map((entry) => entry.legacy_path));
  const prefix = `.archflow/tasks/${initialization.task_id}/`;
  for (const entry of initialization.mapping) {
    if (!entry.destination_path.startsWith(prefix)) {
      const classified = classifyTaskPath(
        initialization.task_id,
        parseTaskPathClaim(`.archflow/tasks/${initialization.task_id}/${entry.destination_path}`),
      );
      if (!classified.ok) return classified;
      throw new TypeError("task-prefixed destination unexpectedly classified as task-relative");
    }
    const claim = parseTaskPathClaim(entry.destination_path.slice(prefix.length));
    const classified = classifyTaskPath(initialization.task_id, claim);
    if (!classified.ok) return classified;
    if (!staged.has(entry.legacy_path)) return contract("legacy-mapping-payload-missing");
    if (phaseForLegacyDestination(initialization.task_id, entry.destination_path) !== entry.phase_instance) {
      return contract("legacy-mapping-phase-mismatch");
    }
  }
  return ok(undefined);
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

function initialState(
  call: StateCall,
  artifact: DurableArtifact,
): ProjectResult<TaskStateV1> {
  const initialization = initializationFor(artifact);
  if (initialization === undefined) return contract("initialization-artifact-required");

  // Task and legacy-import initialization always enter the workflow at its first phase's
  // pipeline head (WORKFLOW_V1.phases: "prd" / "produce"); any other combination would write
  // a bogus revision-1 state that no later transition could have produced.
  if (call.input.phase_instance !== "prd" || call.input.step !== "produce" || call.input.status !== "running") {
    return contract("initialization-entry-point-mismatch");
  }

  const state: TaskStateV1 = {
    schema_version: "1",
    task_id: initialization.task_id,
    repository_identity_digest: initialization.repository_identity_digest,
    revision: 1 as TaskStateV1["revision"],
    phase_instance: call.input.phase_instance,
    step: call.input.step,
    status: call.input.status,
    attempt: 1 as TaskStateV1["attempt"],
    input_fingerprint: call.input.input_fingerprint,
    initialization_digest: canonicalJsonDigest(initialization),
    config_digest: initialization.config_digest,
    workflow_digest: initialization.workflow_digest,
    constitution_digest: initialization.constitution_digest,
    policy_base_commit: initialization.policy_base_commit,
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
  return ok(state);
}

/**
 * Identifies the revision-0 state request without writing the receipt or task state. The local
 * envelope command and the committing initialization path deliberately share this derivation so
 * their fingerprint and request digest cannot drift.
 */
export async function identifyStateInitialization(
  dependencies: TransactionDependencies,
  request: TransactionRequest<"archflow_state">,
): Promise<ProjectResult<StateInitializationIdentification>> {
  assertInternalTransactionAuthority(request.authority, { runner: dependencies.runner, environment: dependencies.environment });
  assertAuthenticParsedToolCall(request.call);
  const artifactValue = request.call.input.artifact;
  if (request.call.input.expected_revision !== 0 || artifactValue === undefined) {
    return contract("revision-zero-initialization-required");
  }
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
  if (initialization.artifact_kind === "legacy-import-initialization") {
    const mapping = validateLegacyMapping(initialization);
    if (!mapping.ok) return mapping;
  }
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
  const identified = identifyTransactionRequest(request.call, request.authority, inputFingerprint);
  return ok(Object.freeze({
    call: identified.call,
    input_fingerprint: inputFingerprint,
    request_digest: identified.request_digest,
    prepared_state: preparedState,
  }));
}

async function intentTarget(
  dependencies: TransactionDependencies,
  request: TransactionRequest<"archflow_state">,
): Promise<ProjectResult<ResolvedWorkspacePath>> {
  const claim = parseWorkspacePathClaim(`transient/intents/${request.call.input.intent_id}.json`);
  const result = await resolveTaskWorkspacePath({
    runner: dependencies.runner,
    taskId: request.authority.task_id,
    claim,
    expectedClass: "workspace-intent",
    context: request.authority.context,
  });
  if (!result.ok) return result;
  const rel = relative(request.authority.workspace_root, result.value.absolute);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new TypeError("initialization intent target escaped the task root");
  }
  return result;
}

function committed(receipt: CanonicalDocument<IntentReceiptV1>): CanonicalDocument<TaskStateV1> {
  const value = receipt.value;
  const reference: LastTransition = {
    schema_version: "1",
    tool: value.tool,
    operation: value.operation,
    intent_id: value.intent_id,
    request_digest: value.request_digest,
    input_fingerprint: value.input_fingerprint,
    result_id: value.result_id,
    outcome: value.outcome,
    outcome_digest: value.outcome_digest,
    prior_revision: value.prior_revision,
    resulting_revision: value.resulting_revision,
  };
  return canonicalDocument({ ...value.prepared_state, last_transition: reference });
}

async function executeLocked(
  dependencies: TransactionDependencies,
  request: TransactionRequest<"archflow_state">,
  path: ResolvedWorkspacePath,
): Promise<ProjectResult<TransactionOutcome<"archflow_state">>> {
  const stateRead = await dependencies.read_state(request.authority.state);
  if (stateRead.kind === "canonical") {
    const repository = verifyRepositoryIdentity(stateRead.document.value.repository_identity_digest, request.authority.repository_identity);
    if (!repository.ok) return repository;
    if (
      stateRead.document.value.revision === 1 &&
      stateRead.document.value.last_transition?.intent_id === request.call.input.intent_id
    ) {
      const transition = stateRead.document.value.last_transition;
      const artifact = request.call.input.artifact;
      if (
        transition.tool !== "archflow_state" || artifact === undefined ||
        transition.operation !== operationFor(artifact) ||
        transition.input_fingerprint !== request.call.input.input_fingerprint ||
        transition.outcome_digest !== intentOutcomeDigest(transition.outcome)
      ) return contract("initialization-last-transition-mismatch");
      const identified = identifyTransactionRequest(request.call, request.authority, transition.input_fingerprint);
      if (identified.request_digest !== transition.request_digest) {
        return fail(createProjectError("INTENT_MISMATCH", {
          expected_digest: transition.request_digest,
          observed_digest: identified.request_digest,
        }));
      }
      const outcome = validateProjectResultStructure(request.call, { schema_version: "1", ok: true, value: transition.outcome });
      if (!outcome.ok) return outcome;
      return ok(Object.freeze({ state: stateRead.document, outcome: outcome.value, replayed: true }));
    }
    return fail(createProjectError("STATE_CONFLICT", { expected_revision: 0, observed_revision: stateRead.document.value.revision }));
  }
  if (stateRead.kind !== "missing") return contract(stateRead.kind === "unreadable" ? "task-state-unreadable" : "task-state-noncanonical");

  const identification = await identifyStateInitialization(dependencies, request);
  if (!identification.ok) return identification;
  const preparedState = identification.value.prepared_state;
  const inputFingerprint = identification.value.input_fingerprint;
  if (inputFingerprint !== request.call.input.input_fingerprint) {
    return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", {
      expected_digest: inputFingerprint,
      observed_digest: request.call.input.input_fingerprint,
    }));
  }
  const identified = identification.value;

  const artifact = structuredClone(request.call.input.artifact!) as DurableArtifact;
  const artifactDocument = canonicalDocument(artifact);
  const initializationTarget = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: request.authority.task_id,
    claim: initializationAuthorityClaim(),
    expectedClass: "authority-initialization",
    context: request.authority.context,
  });
  if (!initializationTarget.ok) return initializationTarget;

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
    await ensureAuthorityDirectory(request.authority);
    await ensureIntentDirectory(request.authority);
    const installedInitialization = await dependencies.atomic.createExclusive(
      initializationTarget.value,
      artifactDocument.bytes,
    );
    if (installedInitialization === "exists") {
      let handle;
      try {
        handle = await openResolved(initializationTarget.value.absolute, 0);
        const existingBytes = new Uint8Array(await handle.readFile());
        if (!Buffer.from(existingBytes).equals(Buffer.from(artifactDocument.bytes))) {
          return contract("initialization-authority-disagreement");
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
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
  await cleanTaskWorkspace(dependencies, request.authority, observed.document.value).catch(() => undefined);
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
  try {
    await ensureIntentDirectory(request.authority);
  } catch (error) {
    if (error instanceof IntentLayoutError) return io(request, "intent-receipt-create");
    throw error;
  }
  let completed: ProjectResult<TransactionOutcome<"archflow_state">> | undefined;
  try {
    return await dependencies.lock.runExclusive(request.authority.workspace_root, async () => {
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
