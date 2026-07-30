import { constants as fsConstants } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { canonicalDocument, canonicalJsonDigest, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../contracts/canonical.js";
import {
  parseActiveGate,
  parseGateDecisionRecord,
  parseGateRequest,
  type ActiveGateV1,
  type GateDecisionRecordV1,
  type GateRequestV1,
  type SupplementalLedger,
  type WaiverGateContext,
} from "../contracts/durable-gate.js";
import type { ApprovalRef, CommittedIntentRef, TaskStateV1, WaiverRef } from "../contracts/durable-state.js";
import { intentOutcomeDigest, intentReceiptDigest, parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import { createCommittedIntentSubject, createPreparedIntentSubject, openGateFrozenStateDigest, validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseSafeId, parseSafeInteger, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { computeGateContextDigest, computeGateId } from "../contracts/fingerprints.js";
import {
  gateDecisionEffect,
  parseGateDecisionEnvelope,
  validateGateDecision,
  type GateDecisionEnvelope,
  type GateKind,
  type HumanDecisionProvenance,
  type WaiverOriginRef,
  type WaiverScope,
} from "../contracts/gates.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { parseSupplementalReviewOutcome, type GateSupersessionRef, type SupplementalReviewOutcome } from "../contracts/supplemental.js";
import { gateCounterReviewClaim, gateDecisionClaim, gateRequestClaim, openResolved, resolveTaskPath, type ResolvedPath } from "../repository/paths.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { waitForGateInterface } from "./gate-wait.js";
import { ensureDecisionDirectory, ensureIntentDirectory } from "./layout.js";
import { TaskLockError } from "./lock.js";
import type { TransactionDependencies } from "./transaction.js";
import { applyProjectionPlan, captureProjectionTarget, prepareProjectionPlan, projectionGenerationDigest, type ProjectionSource } from "./snapshots.js";
import type { SecretScanner } from "../contracts/secret-scan.js";

const DECISIONS: Readonly<Record<GateKind, readonly string[]>> = Object.freeze({
  "artifact-approval": ["approve", "revise", "reject", "cancel"],
  "review-trigger": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "material-drift": ["amend-upstream", "revise-current", "reject", "cancel"],
  "adjudication-failure": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "attempts-exhausted": ["retry-once", "revise", "abort", "cancel"],
  "constitution-edit": ["revert-edit", "start-base-amendment", "abort", "cancel"],
  "commit-authorization": ["authorize-commit", "revise", "abort", "cancel"],
  "restore-collision": ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"],
  "migration-audit": ["accept-import-audit", "revise", "abort", "cancel"],
});

export type GateLifecycleDependencies = Readonly<TransactionDependencies & { gate_secret_scanner?: SecretScanner }>;
export type GateOpenInput = Readonly<{
  authority: TransactionAuthority;
  expected_revision: number;
  intent_id: PathSafeId;
  request_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
  phase_instance: GateRequestV1["phase_instance"];
  summary: string;
  subject_digest: Sha256Digest;
  current_evidence: GateRequestV1["current_evidence"];
  kind: GateKind;
  context: GateRequestV1["context"];
  supersedes?: GateSupersessionRef;
  waiver_origin_gate_id?: PathSafeId;
  supplemental_outcome?: SupplementalReviewOutcome;
}>;
export type GateOpenResult = Readonly<{
  gate_id: PathSafeId;
  state: CanonicalDocument<TaskStateV1>;
  request: CanonicalDocument<GateRequestV1>;
  replay?: CanonicalDocument<GateDecisionRecordV1>;
}>;
export type GateResolution = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  record: CanonicalDocument<GateDecisionRecordV1>;
  effect: "advance" | "retry" | "redirect-waiver" | "redirect-upstream" | "non-advancing";
  replayed: boolean;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });
const issue = (code: "CONTRACT_INVALID" | "STATE_INVALID", state: TaskStateV1 | undefined, issueCode: string): ProjectResult<never> =>
  fail(code === "STATE_INVALID"
    ? createProjectError(code, { phase_instance: state!.phase_instance, issue_code: issueCode })
    : createProjectError(code, { issue_code: issueCode }));
const io = (authority: TransactionAuthority, operation: string): ProjectResult<never> =>
  fail(createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }));

async function resolvePath(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  claim: ReturnType<typeof gateRequestClaim> | ReturnType<typeof gateDecisionClaim> | "gate.json" | "gate.decision",
  expectedClass: "decision" | "gate-interface",
): Promise<ProjectResult<ResolvedPath>> {
  const resolved = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: typeof claim === "string" ? claim as never : claim,
    expectedClass,
    context: authority.context,
  });
  return resolved;
}

async function readCanonical<T extends PlainJsonValue>(
  path: ResolvedPath,
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
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ENOENT" ? "missing" : "invalid";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function exactFileDigest(path: ResolvedPath): Promise<Sha256Digest | undefined> {
  let handle;
  try {
    handle = await openResolved(path.absolute, fsConstants.O_RDONLY);
    if (!(await handle.stat()).isFile()) return undefined;
    return sha256Bytes(new Uint8Array(await handle.readFile()));
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

function supplementalGate(outcome: SupplementalReviewOutcome): Readonly<{ prior_gate_id: PathSafeId; task_id: GateRequestV1["task_id"]; phase_instance: string; subject_digest: Sha256Digest; input_fingerprint: Sha256Digest }> {
  return (outcome.action === "decline" ? outcome.gate : outcome.review) as Readonly<{ prior_gate_id: PathSafeId; task_id: GateRequestV1["task_id"]; phase_instance: string; subject_digest: Sha256Digest; input_fingerprint: Sha256Digest }>;
}

function stateWithOpen(state: TaskStateV1, request: Pick<GateRequestV1, "gate_id" | "kind" | "subject_digest" | "context_digest" | "context">): CanonicalDocument<TaskStateV1> {
  const { committed_intent: _committed, open_gate: _open, ...base } = state;
  const revision = parseSafeInteger(state.revision + 1);
  const frozenStateDigest = openGateFrozenStateDigest({ ...base, revision } as TaskStateV1);
  return canonicalDocument({
    ...base,
    revision,
    open_gate: {
      gate_id: request.gate_id,
      gate_kind: request.kind,
      subject_digest: request.subject_digest,
      context_digest: request.context_digest,
      frozen_state_digest: frozenStateDigest,
      ...(request.context !== null && typeof request.context === "object" && "origin" in request.context
        ? { waiver_origin_gate_id: (request.context as WaiverGateContext).origin.origin_gate_id }
        : {}),
      opened_at_revision: revision,
    },
  } as TaskStateV1);
}

function activeProjection(request: GateRequestV1): ActiveGateV1 {
  const waiver = waiverContext(request.context);
  return {
    ...structuredClone(request),
    status: "awaiting-human",
    decision_template: {
      schema_version: "1", gate_id: request.gate_id, task_id: request.task_id,
      phase_instance: request.phase_instance, kind: request.kind,
      subject_digest: request.subject_digest, context_digest: request.context_digest,
      required_fields: waiver === undefined
        ? ["payload", "human_provenance"]
        : ["granted", "scope", "origin", "notes", "human_provenance"],
      cancellation_fields: ["cancelled", "reason", "human_provenance"],
    },
    supplemental: [],
  } as unknown as ActiveGateV1;
}

function waiverContext(value: GateRequestV1["context"]): WaiverGateContext | undefined {
  return value !== null && typeof value === "object" && "origin" in value ? value as WaiverGateContext : undefined;
}

function desiredGenerationDigest(desired: Readonly<{ state: "absent" }> | Readonly<{ state: "present"; file_type: "regular" | "symlink"; mode: "100644" | "100755" | "120000"; bytes: Uint8Array }>): Sha256Digest {
  return projectionGenerationDigest(desired.state === "absent" ? desired : {
    state: "present", file_type: desired.file_type, mode: desired.mode,
    size_bytes: desired.bytes.byteLength, content_digest: sha256Bytes(desired.bytes),
  });
}

function bindEnvelope(request: GateRequestV1, envelope: GateDecisionEnvelope): void {
  if (
    envelope.gate_id !== request.gate_id || envelope.task_id !== request.task_id ||
    envelope.phase_instance !== request.phase_instance || envelope.kind !== request.kind ||
    envelope.subject_digest !== request.subject_digest || envelope.context_digest !== request.context_digest
  ) throw new TypeError("gate decision does not bind archived request");
  if (request.context !== null && typeof request.context === "object" && "origin" in request.context) {
    throw new TypeError("waiver gate requires a waiver decision");
  }
  validateGateDecision(request.kind, request.context as never, envelope.payload as never);
}

type WaiverInterface = Readonly<{
  schema_version: "1"; gate_id: PathSafeId; task_id: GateRequestV1["task_id"];
  phase_instance: GateRequestV1["phase_instance"]; subject_digest: Sha256Digest;
  context_digest: Sha256Digest; granted: boolean; scope: WaiverScope; origin: WaiverOriginRef;
  notes: string; human_provenance: HumanDecisionProvenance;
}>;
type CancelInterface = Readonly<{
  schema_version: "1"; gate_id: PathSafeId; task_id: GateRequestV1["task_id"];
  phase_instance: GateRequestV1["phase_instance"]; subject_digest: Sha256Digest;
  context_digest: Sha256Digest; cancelled: true; reason: string; human_provenance: HumanDecisionProvenance;
}>;

function parseInterface(value: unknown, request: GateRequestV1, supplemental: SupplementalLedger = []): GateDecisionRecordV1 {
  assertPlainJson(value, "gate decision interface");
  if (value !== null && typeof value === "object" && "cancelled" in value) {
    const candidate = value as unknown as CancelInterface;
    if (candidate.cancelled !== true || candidate.gate_id !== request.gate_id || candidate.task_id !== request.task_id || candidate.phase_instance !== request.phase_instance || candidate.subject_digest !== request.subject_digest || candidate.context_digest !== request.context_digest) throw new TypeError("cancellation does not bind request");
    return parseGateDecisionRecord({ schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance, kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest, supplemental, outcome: "cancelled", reason: candidate.reason, human_provenance: candidate.human_provenance });
  }
  if (request.context !== null && typeof request.context === "object" && "origin" in request.context) {
    const candidate = value as unknown as WaiverInterface;
    const context = request.context as WaiverGateContext;
    if (candidate.gate_id !== request.gate_id || candidate.task_id !== request.task_id || candidate.phase_instance !== request.phase_instance || candidate.subject_digest !== request.subject_digest || candidate.context_digest !== request.context_digest || !isDeepStrictEqual(candidate.origin, context.origin) || !isDeepStrictEqual(candidate.scope, context.origin.scope)) throw new TypeError("waiver decision does not bind origin");
    return parseGateDecisionRecord({ schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance, kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest, supplemental, outcome: "waiver-decided", granted: candidate.granted, scope: candidate.scope, origin: candidate.origin, notes: candidate.notes, human_provenance: candidate.human_provenance });
  }
  const envelope = parseGateDecisionEnvelope(value);
  bindEnvelope(request, envelope);
  return parseGateDecisionRecord({ schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance, kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest, supplemental, outcome: "decided", envelope });
}

async function stateOrFailure(dependencies: GateLifecycleDependencies, authority: TransactionAuthority): Promise<ProjectResult<CanonicalDocument<TaskStateV1>>> {
  const read = await dependencies.read_state(authority.state);
  return read.kind === "canonical" ? ok(read.document) : read.kind === "unreadable" ? io(authority, "gate-state-read") : issue("CONTRACT_INVALID", undefined, `gate-state-${read.kind}`);
}

async function validateLiveGateState(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  inputFingerprint: Sha256Digest,
): Promise<ProjectResult<void>> {
  const identity = verifyRepositoryIdentity(current.value.repository_identity_digest, authority.repository_identity);
  if (!identity.ok) return identity;
  if (!validateDurableSemantics({ state: current }).ok) return issue("STATE_INVALID", current.value, "gate-state-semantics-invalid");
  const config = await dependencies.read_config(authority.config);
  if (config.kind !== "valid") return config.kind === "invalid" ? issue("CONTRACT_INVALID", undefined, "task-config-invalid") : io(authority, "gate-config-read");
  if (config.snapshot.digest !== current.value.config_digest) return fail(createProjectError("PINNED_CONFIG_MISMATCH", { expected_digest: current.value.config_digest, observed_digest: config.snapshot.digest }));
  if (inputFingerprint !== current.value.input_fingerprint) return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", { expected_digest: current.value.input_fingerprint, observed_digest: inputFingerprint }));
  return ok(undefined);
}

async function authenticateWaiverOrigin(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  context: WaiverGateContext,
): Promise<ProjectResult<void>> {
  const requestPath = await resolvePath(dependencies, authority, gateRequestClaim(context.origin.origin_gate_id), "decision");
  const decisionPath = await resolvePath(dependencies, authority, gateDecisionClaim(context.origin.origin_gate_id), "decision");
  if (!requestPath.ok) return requestPath;
  if (!decisionPath.ok) return decisionPath;
  const request = await readCanonical(requestPath.value, "waiver origin request", parseGateRequest);
  const decision = await readCanonical(decisionPath.value, "waiver origin decision", parseGateDecisionRecord);
  if (request === "missing" || request === "invalid" || decision === "missing" || decision === "invalid") return issue("CONTRACT_INVALID", undefined, "waiver-origin-archive-invalid");
  if (!validateDurableSemantics({ gate_request: request, gate_decision: decision }).ok || decision.digest !== context.origin.origin_decision_digest || decision.value.outcome !== "decided" || decision.value.envelope.payload.decision !== "waiver-requested") return issue("CONTRACT_INVALID", undefined, "waiver-origin-decision-invalid");
  const payload = decision.value.envelope.payload as Extract<typeof decision.value.envelope.payload, { decision: "waiver-requested" }>;
  const requestContext = request.value.context;
  if (!("waiver_scope" in requestContext) || request.value.gate_id !== context.origin.origin_gate_id || request.value.context_digest !== context.origin.origin_context_digest || request.value.task_id !== context.origin.task_id || request.value.phase_instance !== context.origin.phase_instance || request.value.subject_digest !== context.origin.subject_digest || request.value.current_evidence.set_digest !== context.origin.current_evidence_set_digest || !isDeepStrictEqual(payload.rule, context.origin.rule) || !isDeepStrictEqual(requestContext.waiver_scope, context.origin.scope)) return issue("CONTRACT_INVALID", undefined, "waiver-origin-binding-invalid");
  return ok(undefined);
}

async function cleanupResolvedInterfaces(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
): Promise<ProjectResult<void>> {
  try {
    return await dependencies.lock.runExclusive(authority.task_root, async () => {
      const gateJson = await resolvePath(dependencies, authority, "gate.json", "gate-interface");
      if (!gateJson.ok) return gateJson;
      const active = await readCanonical(gateJson.value, "active gate", parseActiveGate);
      if (active !== "missing" && active !== "invalid" && active.value.gate_id === request.gate_id && active.value.task_id === request.task_id && active.value.phase_instance === request.phase_instance && active.value.subject_digest === request.subject_digest && active.value.context_digest === request.context_digest) {
        await dependencies.atomic.removeGateInterface(gateJson.value);
      }
      const decision = await resolvePath(dependencies, authority, "gate.decision", "gate-interface");
      if (!decision.ok) return decision;
      const projected = await readCanonical(decision.value, "gate decision interface", (value) => value as PlainJsonValue);
      if (projected !== "missing" && projected !== "invalid") {
        try {
          const bound = parseInterface(projected.value, request, record.supplemental);
          if (canonicalJsonDigest(bound) === canonicalJsonDigest(record)) await dependencies.atomic.removeGateInterface(decision.value);
        } catch { /* never remove an interface whose gate identity cannot be authenticated */ }
      }
      return ok(undefined);
    });
  } catch (error) { return error instanceof TaskLockError ? io(authority, `gate-cleanup-lock-${error.stage}`) : io(authority, "gate-cleanup"); }
}

async function currentSupplementalLedger(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  request: GateRequestV1,
  inputFingerprint: Sha256Digest,
  callerOutcome?: SupplementalReviewOutcome,
): Promise<SupplementalLedger | undefined> {
  const target = await resolvePath(dependencies, authority, "gate.json", "gate-interface");
  if (!target.ok) return undefined;
  const active = await readCanonical(target.value, "active gate", parseActiveGate);
  if (active === "missing" || active === "invalid") return Object.freeze([]);
  const derived: SupplementalLedger[number][] = [];
  for (const entry of active.value.supplemental) {
    if (callerOutcome === undefined || !isDeepStrictEqual(entry, callerOutcome)) continue;
    const binding = supplementalGate(entry);
    if (binding.prior_gate_id !== request.gate_id || binding.task_id !== request.task_id || binding.phase_instance !== request.phase_instance || binding.subject_digest !== request.subject_digest || binding.input_fingerprint !== inputFingerprint) continue;
    if (entry.action === "decline") {
      derived.push(entry);
      continue;
    }
    const review = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim: gateCounterReviewClaim(request.phase_instance, request.gate_id), expectedClass: "review", context: authority.context });
    if (!review.ok) return undefined;
    if (await exactFileDigest(review.value) === entry.review.evidence_slot.evidence_digest) derived.push(entry);
  }
  return Object.freeze(derived);
}

export async function openDurableGate(
  dependencies: GateLifecycleDependencies,
  input: GateOpenInput,
): Promise<ProjectResult<GateOpenResult>> {
  assertInternalTransactionAuthority(input.authority, { runner: dependencies.runner, environment: dependencies.environment });
  try {
    return await dependencies.lock.runExclusive(input.authority.task_root, async () => {
      const stateResult = await stateOrFailure(dependencies, input.authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(dependencies, input.authority, current, input.input_fingerprint);
      if (!live.ok) return live;
      const gateId = computeGateId({ task_identity_digest: input.authority.task_identity_digest, intent_id: input.intent_id, request_digest: input.request_digest });
      await ensureDecisionDirectory(input.authority, gateId);
      const requestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(gateId), "decision");
      const decisionPath = await resolvePath(dependencies, input.authority, gateDecisionClaim(gateId), "decision");
      if (!requestPath.ok) return requestPath;
      if (!decisionPath.ok) return decisionPath;
      const archived = await readCanonical(decisionPath.value, "gate decision record", parseGateDecisionRecord);
      const requestRead = await readCanonical(requestPath.value, "gate request", parseGateRequest);
      if (archived !== "missing") {
        if (archived === "invalid" || requestRead === "missing" || requestRead === "invalid") return issue("STATE_INVALID", current.value, "gate-archive-invalid");
        if (!validateDurableSemantics({ gate_request: requestRead, gate_decision: archived }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
        if (current.value.open_gate?.gate_id === gateId) {
          return ok({ gate_id: gateId, state: current, request: requestRead, replay: archived });
        }
        if (current.value.committed_intent?.intent_id === input.intent_id) {
          const receiptTarget = await resolveTaskPath({ runner: dependencies.runner, taskId: input.authority.task_id, claim: parseTaskPathClaim(`intents/${input.intent_id}.json`), expectedClass: "intent", context: input.authority.context });
          if (!receiptTarget.ok) return receiptTarget;
          const receipt = await dependencies.read_receipt(receiptTarget.value);
          const expectedTool = archived.value.outcome === "waiver-decided" ? "archflow_waiver" : "archflow_gate";
          const expectedOperation = archived.value.outcome === "waiver-decided" ? "waiver" : "gate";
          const expectedOutcome = earnsReceipt(archived.value) ? receiptOutcome(archived.value, current.value.revision) : undefined;
          if (receipt.kind !== "canonical" || expectedOutcome === undefined || receipt.document.digest !== current.value.committed_intent.receipt_digest || receipt.document.value.tool !== expectedTool || receipt.document.value.operation !== expectedOperation || receipt.document.value.request_digest !== requestRead.value.request_digest || String(receipt.document.value.result_id) !== String(archived.value.gate_id) || !isDeepStrictEqual(receipt.document.value.outcome, expectedOutcome) || receipt.document.value.outcome_digest !== intentOutcomeDigest(expectedOutcome) || !validateDurableSemantics(createCommittedIntentSubject(current, receipt.document)).ok) {
            return issue("STATE_INVALID", current.value, "gate-replay-receipt-invalid");
          }
          return ok({ gate_id: gateId, state: current, request: requestRead, replay: archived });
        }
        if (archived.value.outcome === "cancelled" && requestRead.value.intent_id === input.intent_id && requestRead.value.request_digest === input.request_digest) return ok({ gate_id: gateId, state: current, request: requestRead, replay: archived });
        return fail(createProjectError("INTENT_NOT_CURRENT", { intent_id: input.intent_id, receipt_revision: requestRead.value.opened_at_revision, current_revision: current.value.revision }));
      }
      if (current.value.open_gate !== undefined) {
        const activeRequestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(current.value.open_gate.gate_id), "decision");
        if (!activeRequestPath.ok) return activeRequestPath;
        const activeRequest = await readCanonical(activeRequestPath.value, "active gate request", parseGateRequest);
        if (activeRequest === "missing" || activeRequest === "invalid") return issue("STATE_INVALID", current.value, "active-gate-request-invalid");
        if (activeRequest.value.intent_id === input.intent_id && activeRequest.value.request_digest !== input.request_digest) {
          return fail(createProjectError("INTENT_MISMATCH", { expected_digest: activeRequest.value.request_digest, observed_digest: input.request_digest }));
        }
        if (current.value.open_gate.gate_id !== gateId) return fail(createProjectError("GATE_ACTIVE", { gate_id: current.value.open_gate.gate_id, gate_kind: current.value.open_gate.gate_kind }));
        const gateJson = await resolvePath(dependencies, input.authority, "gate.json", "gate-interface"); if (!gateJson.ok) return gateJson;
        const projected = await readCanonical(gateJson.value, "active gate", parseActiveGate);
        let active = projected === "missing" || projected === "invalid"
          ? parseActiveGate(activeProjection(activeRequest.value))
          : projected.value;
        if (projected === "missing" || projected === "invalid") {
          await dependencies.atomic.replace(gateJson.value, canonicalDocument(active).bytes);
        }
        if (input.supplemental_outcome !== undefined) {
          const supplemental = parseSupplementalReviewOutcome(input.supplemental_outcome);
          const binding = supplementalGate(supplemental);
          if (binding.prior_gate_id !== gateId || binding.task_id !== input.authority.task_id || binding.phase_instance !== input.phase_instance || binding.subject_digest !== input.subject_digest || binding.input_fingerprint !== input.input_fingerprint) return issue("CONTRACT_INVALID", undefined, "supplemental-gate-binding-invalid");
          if (supplemental.action !== "decline") {
            const resolvedReview = await resolveTaskPath({ runner: dependencies.runner, taskId: input.authority.task_id, claim: gateCounterReviewClaim(input.phase_instance, gateId), expectedClass: "review", context: input.authority.context });
            if (!resolvedReview.ok) return resolvedReview;
            if (await exactFileDigest(resolvedReview.value) !== supplemental.review.evidence_slot.evidence_digest) return fail(createProjectError("SUPPLEMENTAL_REVIEW_REQUIRED", { gate_id: gateId, evidence_digest: supplemental.review.evidence_slot.evidence_digest }));
          }
          if (supplemental.action === "supersede") {
            const ledger = await currentSupplementalLedger(dependencies, input.authority, activeRequest.value, input.input_fingerprint, supplemental);
            if (ledger === undefined) return issue("STATE_INVALID", current.value, "supplemental-ledger-invalid");
            const record = parseGateDecisionRecord({ schema_version: "1", gate_id: gateId, task_id: input.authority.task_id, phase_instance: input.phase_instance, kind: input.kind, subject_digest: input.subject_digest, context_digest: activeRequest.value.context_digest, supplemental: ledger, outcome: "superseded", supersession: { superseded_gate_id: gateId, accepted_triage_digest: supplemental.accepted_triage_digest, old_subject_digest: supplemental.old_subject_digest } });
            const document = canonicalDocument(record);
            const archivePath = await resolvePath(dependencies, input.authority, gateDecisionClaim(gateId), "decision"); if (!archivePath.ok) return archivePath;
            if (await dependencies.atomic.createExclusive(archivePath.value, document.bytes) !== "created") return issue("STATE_INVALID", current.value, "gate-supersession-race");
            const final = nextStateForRecord(current.value, record, document.digest);
            await dependencies.atomic.replace(input.authority.state, final.bytes);
            await dependencies.atomic.removeGateInterface(gateJson.value);
            return ok({ gate_id: gateId, state: final, request: activeRequest, replay: document });
          }
          const ledger = active.supplemental.some((entry) => isDeepStrictEqual(entry, supplemental))
            ? active.supplemental
            : [...active.supplemental, supplemental];
          active = parseActiveGate({ ...active, supplemental: ledger });
          await dependencies.atomic.replace(gateJson.value, canonicalDocument(active).bytes);
        }
        return ok({ gate_id: gateId, state: current, request: activeRequest });
      }
      if (current.value.revision !== input.expected_revision) return fail(createProjectError("STATE_CONFLICT", { expected_revision: input.expected_revision, observed_revision: current.value.revision }));
      if (input.kind === "commit-authorization") {
        const reference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === input.phase_instance && item.step === "produce");
        if (reference === undefined || dependencies.load_retained_result === undefined) return issue("STATE_INVALID", current.value, "commit-authorization-result-missing");
        const retained = await dependencies.load_retained_result(reference);
        if (!retained.ok) return retained;
        const manifest = retained.value.prepared.manifest.value;
        const artifact = manifest.source_artifact;
        const context = input.context as Extract<GateRequestV1, { kind: "commit-authorization" }>["context"];
        if (
          artifact.artifact_kind !== "implementation-output" || artifact.diff_digest !== context.diff_digest ||
          !isDeepStrictEqual(context.current_artifact_digests, [manifest.artifact_digest]) ||
          !isDeepStrictEqual(context.parent_document_digests, artifact.parent_documents.map((item) => item.content_digest).sort())
        ) return issue("STATE_INVALID", current.value, "commit-authorization-manifest-mismatch");
      }
      if (input.kind === "restore-collision") {
        const reference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === input.phase_instance && item.step === "produce");
        if (reference === undefined || dependencies.load_retained_result === undefined) return issue("STATE_INVALID", current.value, "restore-result-missing");
        const retained = await dependencies.load_retained_result(reference); if (!retained.ok) return retained;
        const context = input.context as Extract<GateRequestV1, { kind: "restore-collision" }>["context"];
        const repositoryPath = `.archflow/tasks/${input.authority.task_id}/${context.path}`;
        const entry = retained.value.projection_plan.entries.find((item) => item.path === repositoryPath);
        if (entry === undefined || desiredGenerationDigest(entry.desired) !== context.recorded_generation_digest) return issue("STATE_INVALID", current.value, "restore-recorded-generation-mismatch");
        if (projectionGenerationDigest((await captureProjectionTarget(entry.target)).observation) !== context.current_generation_digest) return issue("STATE_INVALID", current.value, "restore-current-generation-stale");
        if (entry.rename_pair !== undefined) {
          const peer = retained.value.projection_plan.entries.find((item) => item.path === entry.rename_pair!.peer_path && item.rename_pair?.peer_path === entry.path);
          if (peer === undefined || !isDeepStrictEqual((await captureProjectionTarget(peer.target)).observation, peer.observed_before)) return issue("STATE_INVALID", current.value, "restore-rename-peer-changed");
        }
        const changed = input.input_fingerprint !== reference.input_fingerprint;
        if ((!changed && context.adoption_candidate !== undefined) || (context.adoption_candidate !== undefined && (context.adoption_candidate.changed_input_fingerprint !== input.input_fingerprint || context.adoption_candidate.proposed_generation_digest !== context.current_generation_digest))) return issue("CONTRACT_INVALID", undefined, "restore-adoption-candidate-invalid");
      }
      const waiver = waiverContext(input.context);
      if (waiver !== undefined && input.waiver_origin_gate_id !== undefined && input.waiver_origin_gate_id !== waiver.origin.origin_gate_id) return issue("CONTRACT_INVALID", undefined, "waiver-origin-gate-mismatch");
      if (waiver !== undefined) {
        const origin = await authenticateWaiverOrigin(dependencies, input.authority, waiver);
        if (!origin.ok) return origin;
      }
      const contextDigest = waiver === undefined
        ? computeGateContextDigest(input.kind, input.context as never)
        : computeGateContextDigest("waiver", waiver);
      const openState = stateWithOpen(current.value, { gate_id: gateId, kind: input.kind, subject_digest: input.subject_digest, context_digest: contextDigest, context: input.context } as Pick<GateRequestV1, "gate_id" | "kind" | "subject_digest" | "context_digest" | "context">);
      let request = parseGateRequest({
        schema_version: "1", gate_id: gateId, intent_id: input.intent_id, request_digest: input.request_digest,
        task_id: input.authority.task_id, phase_instance: input.phase_instance, summary: input.summary,
        subject_digest: input.subject_digest, context_digest: contextDigest, current_evidence: input.current_evidence,
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        kind: input.kind, context: input.context, allowed_decisions: waiver === undefined ? DECISIONS[input.kind] : ["grant", "deny", "cancel"], opened_at_revision: current.value.revision + 1,
      });
      let requestDocument = canonicalDocument(request);
      const created = await dependencies.atomic.createExclusive(requestPath.value, requestDocument.bytes);
      if (created === "exists") {
        const existing = await readCanonical(requestPath.value, "gate request", parseGateRequest);
        if (existing === "missing" || existing === "invalid" || existing.value.gate_id !== gateId || existing.value.intent_id !== input.intent_id || existing.value.request_digest !== input.request_digest) return issue("STATE_INVALID", current.value, "gate-request-collision");
        request = existing.value;
        requestDocument = existing;
      }
      // A crash may leave a human-authored interface before state names the gate. Preserve it only
      // when it binds this exact immutable request; an unrelated stale interface is safe to remove.
      const pendingInterface = await resolvePath(dependencies, input.authority, "gate.decision", "gate-interface");
      if (!pendingInterface.ok) return pendingInterface;
      const pending = await readCanonical(pendingInterface.value, "gate decision interface", (value) => value as PlainJsonValue);
      if (pending !== "missing") {
        let bound = false;
        if (pending !== "invalid") {
          try { parseInterface(pending.value, request); bound = true; } catch { /* stale interface */ }
        }
        if (!bound) await dependencies.atomic.removeGateInterface(pendingInterface.value);
      }
      const gateJson = await resolvePath(dependencies, input.authority, "gate.json", "gate-interface");
      if (!gateJson.ok) return gateJson;
      await dependencies.atomic.replace(gateJson.value, canonicalDocument(parseActiveGate(activeProjection(request))).bytes);
      await dependencies.atomic.replace(input.authority.state, openState.bytes);
      return ok({ gate_id: gateId, state: openState, request: requestDocument });
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(input.authority, `gate-lock-${error.stage}`) : io(input.authority, "gate-open");
  }
}

function nextStateForRecord(state: TaskStateV1, record: GateDecisionRecordV1, digest: Sha256Digest): CanonicalDocument<TaskStateV1> {
  const revision = parseSafeInteger(state.revision + 1);
  const approvals = [...state.approvals];
  const waivers = [...state.waivers];
  if (record.outcome === "decided" && gateDecisionEffect(record.envelope.payload) === "advance") {
    approvals.push({ gate_id: record.gate_id, gate_kind: record.kind, subject_digest: record.subject_digest, decision_digest: digest, resolved_at_revision: revision } as ApprovalRef);
    approvals.sort((a, b) => a.gate_id.localeCompare(b.gate_id));
  }
  if (record.outcome === "waiver-decided") {
    waivers.push({ gate_id: record.gate_id, rule_id: record.origin.rule.rule_id, rule_version: record.origin.rule.rule_version, subject_digest: record.origin.subject_digest, scope: record.scope, granted: record.granted, expires: "task-complete", granted_at_revision: revision } as WaiverRef);
    waivers.sort((a, b) => a.gate_id.localeCompare(b.gate_id));
  }
  const { open_gate: _open, committed_intent: _intent, ...base } = state;
  return canonicalDocument({ ...base, revision, approvals, waivers } as TaskStateV1);
}

function earnsReceipt(record: GateDecisionRecordV1): boolean {
  return record.outcome === "decided"
    ? gateDecisionEffect(record.envelope.payload) === "advance"
    : record.outcome === "waiver-decided" && record.granted;
}

function receiptOutcome(record: GateDecisionRecordV1, revision: number): PlainJsonValue {
  if (record.outcome === "decided") return {
    kind: record.kind, decision: record.envelope, notes: record.envelope.payload.reason, revision,
  } as PlainJsonValue;
  if (record.outcome === "waiver-decided") return {
    origin_gate_id: record.origin.origin_gate_id, waiver_gate_id: record.gate_id, task_id: record.task_id,
    rule_id: record.origin.rule.rule_id, rule_version: record.origin.rule.rule_version,
    subject_digest: record.origin.subject_digest, current_evidence_set_digest: record.origin.current_evidence_set_digest,
    scope: record.scope, human_provenance: record.human_provenance, granted: record.granted,
    ...(record.granted ? { expires: "task-complete" } : {}), notes: record.notes, revision,
  } as PlainJsonValue;
  throw new TypeError("non-success gate record has no receipt outcome");
}

async function installReceipt(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
  predecessor: CanonicalDocument<TaskStateV1>,
  prepared: CanonicalDocument<TaskStateV1>,
  inputFingerprint: Sha256Digest,
): Promise<ProjectResult<Readonly<{ receipt: CanonicalDocument<IntentReceiptV1>; final: CanonicalDocument<TaskStateV1> }>>> {
  await ensureIntentDirectory(authority);
  const target = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim: parseTaskPathClaim(`intents/${request.intent_id}.json`), expectedClass: "intent", context: authority.context });
  if (!target.ok) return target;
  const outcome = receiptOutcome(record, prepared.value.revision);
  const receipt = canonicalDocument(parseIntentReceipt({
    schema_version: "1", intent_id: request.intent_id, task_id: request.task_id,
    repository_identity_digest: authority.repository_identity_digest,
    tool: record.outcome === "waiver-decided" ? "archflow_waiver" : "archflow_gate",
    operation: parseSafeCode(record.outcome === "waiver-decided" ? "waiver" : "gate"),
    request_digest: request.request_digest, input_fingerprint: inputFingerprint,
    prior_revision: parseSafeInteger(prepared.value.revision - 1), resulting_revision: prepared.value.revision,
    result_id: parseSafeId(record.gate_id), outcome_digest: intentOutcomeDigest(outcome), outcome,
    prepared_state_digest: prepared.digest, prepared_state: prepared.value,
  }));
  if (!validateDurableSemantics(createPreparedIntentSubject(predecessor, receipt)).ok) {
    return issue("STATE_INVALID", predecessor.value, "gate-receipt-prepared-invalid");
  }
  const created = await dependencies.atomic.createExclusive(target.value, receipt.bytes);
  if (created === "exists") {
    const existing = await dependencies.read_receipt(target.value);
    if (existing.kind !== "canonical" || existing.document.digest !== receipt.digest) {
      return issue("STATE_INVALID", prepared.value, "gate-receipt-collision");
    }
  }
  const reference: CommittedIntentRef = {
    intent_id: request.intent_id, request_digest: request.request_digest, receipt_digest: intentReceiptDigest(receipt.value),
    outcome_digest: receipt.value.outcome_digest, prior_revision: receipt.value.prior_revision,
    resulting_revision: receipt.value.resulting_revision, result_id: receipt.value.result_id,
  };
  const final = canonicalDocument({ ...prepared.value, committed_intent: reference });
  if (!validateDurableSemantics(createCommittedIntentSubject(final, receipt)).ok) {
    return issue("STATE_INVALID", predecessor.value, "gate-receipt-committed-invalid");
  }
  return ok({ receipt, final });
}

export async function resolveDurableGate(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  gateId: PathSafeId,
  inputFingerprint?: Sha256Digest,
  supplementalOutcome?: SupplementalReviewOutcome,
): Promise<ProjectResult<GateResolution>> {
  assertInternalTransactionAuthority(authority, { runner: dependencies.runner, environment: dependencies.environment });
  try {
    return await dependencies.lock.runExclusive(authority.task_root, async () => {
      const stateResult = await stateOrFailure(dependencies, authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(dependencies, authority, current, inputFingerprint ?? current.value.input_fingerprint);
      if (!live.ok) return live;
      const requestPath = await resolvePath(dependencies, authority, gateRequestClaim(gateId), "decision");
      const archivePath = await resolvePath(dependencies, authority, gateDecisionClaim(gateId), "decision");
      if (!requestPath.ok) return requestPath;
      if (!archivePath.ok) return archivePath;
      const request = await readCanonical(requestPath.value, "gate request", parseGateRequest);
      if (request === "missing" || request === "invalid") return issue("STATE_INVALID", current.value, "gate-request-invalid");
      const archived = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
      if (archived !== "missing") {
        if (archived === "invalid") return issue("STATE_INVALID", current.value, "gate-decision-record-invalid");
        if (!validateDurableSemantics({ gate_request: request, gate_decision: archived }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
        const effect = archived.value.outcome === "decided" ? gateDecisionEffect(archived.value.envelope.payload) : "non-advancing";
        if (current.value.open_gate?.gate_id !== gateId) return ok({ state: current, record: archived, effect, replayed: true });
        const prepared = nextStateForRecord(current.value, archived.value, archived.digest);
        // A closure-before-receipt crash resumes through the same ordering. The archived request
        // carries no fingerprint field, so only non-success closures can be resumed here; success
        // receipt recovery is driven by runDurableGate, which supplies the authenticated fingerprint.
        if (earnsReceipt(archived.value)) return issue("STATE_INVALID", current.value, "gate-success-receipt-resume-required");
        await dependencies.atomic.replace(authority.state, prepared.bytes);
        const gateJson = await resolvePath(dependencies, authority, "gate.json", "gate-interface");
        if (gateJson.ok) await dependencies.atomic.removeGateInterface(gateJson.value);
        const decisionInterface = await resolvePath(dependencies, authority, "gate.decision", "gate-interface");
        if (decisionInterface.ok) {
          const projected = await readCanonical(decisionInterface.value, "gate decision interface", (value) => value as PlainJsonValue);
          if (projected !== "missing" && projected !== "invalid") {
            try {
              const bound = parseInterface(projected.value, request.value, archived.value.supplemental);
              if (canonicalJsonDigest(bound) === archived.digest) await dependencies.atomic.removeGateInterface(decisionInterface.value);
            } catch { /* leave an unbound interface untouched */ }
          }
        }
        if (archived.value.outcome === "cancelled") return fail(createProjectError("GATE_CANCELLED", { gate_id: gateId, gate_kind: archived.value.kind }));
        return ok({ state: prepared, record: archived, effect, replayed: true });
      }
      if (current.value.open_gate?.gate_id !== gateId) return fail(createProjectError("GATE_ACTIVE", { gate_id: current.value.open_gate?.gate_id ?? gateId, gate_kind: current.value.open_gate?.gate_kind ?? request.value.kind }));
      const interfacePath = await resolvePath(dependencies, authority, "gate.decision", "gate-interface");
      if (!interfacePath.ok) return interfacePath;
      const raw = await readCanonical(interfacePath.value, "gate decision interface", (value) => value as PlainJsonValue);
      if (raw === "missing" || raw === "invalid") return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: raw === "missing" ? "decision-missing" : "decision-noncanonical" }));
      let record: GateDecisionRecordV1;
      const ledger = await currentSupplementalLedger(dependencies, authority, request.value, inputFingerprint ?? current.value.input_fingerprint, supplementalOutcome);
      if (ledger === undefined) return issue("STATE_INVALID", current.value, "active-gate-interface-invalid");
      try { record = parseInterface(raw.value, request.value, ledger); }
      catch { return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: "decision-binding-invalid" })); }
      const document = canonicalDocument(record);
      if (!validateDurableSemantics({ gate_request: request, gate_decision: document }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
      const created = await dependencies.atomic.createExclusive(archivePath.value, document.bytes);
      if (created !== "created") return issue("STATE_INVALID", current.value, "gate-resolution-race");
      const effect = record.outcome === "decided" ? gateDecisionEffect(record.envelope.payload) : "non-advancing";
      const final = nextStateForRecord(current.value, record, document.digest);
      if (earnsReceipt(record)) return issue("STATE_INVALID", current.value, "gate-success-requires-run-service");
      await dependencies.atomic.replace(authority.state, final.bytes);
      const gateJson = await resolvePath(dependencies, authority, "gate.json", "gate-interface");
      if (gateJson.ok) await dependencies.atomic.removeGateInterface(gateJson.value);
      await dependencies.atomic.removeGateInterface(interfacePath.value);
      if (record.outcome === "cancelled") return fail(createProjectError("GATE_CANCELLED", { gate_id: gateId, gate_kind: record.kind }));
      return ok({ state: final, record: document, effect, replayed: false });
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(authority, `gate-lock-${error.stage}`) : io(authority, "gate-resolve");
  }
}

export async function runDurableGate(
  dependencies: GateLifecycleDependencies,
  input: GateOpenInput & Readonly<{ signal: AbortSignal }>,
): Promise<ProjectResult<GateResolution | GateOpenResult>> {
  const opened = await openDurableGate(dependencies, input);
  if (!opened.ok) return opened;
  if (opened.value.replay !== undefined) {
    if (opened.value.state.value.open_gate?.gate_id !== opened.value.gate_id) {
      const effect = opened.value.replay.value.outcome === "decided" ? gateDecisionEffect(opened.value.replay.value.envelope.payload) : "non-advancing";
      const cleaned = await cleanupResolvedInterfaces(dependencies, input.authority, opened.value.request.value, opened.value.replay.value);
      if (!cleaned.ok) return cleaned;
      if (opened.value.replay.value.outcome === "cancelled") return fail(createProjectError("GATE_CANCELLED", { gate_id: opened.value.gate_id, gate_kind: opened.value.replay.value.kind }));
      return ok({ state: opened.value.state, record: opened.value.replay, effect, replayed: true });
    }
    return earnsReceipt(opened.value.replay.value)
      ? resolveAdvancingGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint, input.supplemental_outcome)
      : resolveDurableGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint, input.supplemental_outcome);
  }
  const decision = await resolvePath(dependencies, input.authority, "gate.decision", "gate-interface");
  if (!decision.ok) return decision;
  const review = await resolveTaskPath({ runner: dependencies.runner, taskId: input.authority.task_id, claim: gateCounterReviewClaim(input.phase_instance, opened.value.gate_id), expectedClass: "review", context: input.authority.context });
  if (!review.ok) return review;
  const authenticatedLedger = await currentSupplementalLedger(dependencies, input.authority, opened.value.request.value, input.input_fingerprint, input.supplemental_outcome);
  if (authenticatedLedger === undefined) return issue("STATE_INVALID", opened.value.state.value, "supplemental-ledger-invalid");
  const recorded = authenticatedLedger.flatMap((entry) => entry.action === "decline" ? [] : [entry.review.evidence_slot.evidence_digest]);
  const wait = await waitForGateInterface({ decision_path: decision.value, supplemental: { path: review.value, recorded_evidence_digests: recorded }, signal: input.signal });
  if (wait.kind === "aborted") return fail(createProjectError("CANCELLED", { source: "client", attempt: input.authority.context.attempt }));
  if (wait.kind === "supplemental") return fail(createProjectError("SUPPLEMENTAL_REVIEW_REQUIRED", { gate_id: opened.value.gate_id, evidence_digest: wait.evidence_digest }));
  // Resolve inline so advancing decisions can write archive -> receipt -> state while the
  // authenticated request fingerprint is still available. The lower-level resolver deliberately
  // refuses to manufacture success receipts without it.
  const resolved = await resolveDurableGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint, input.supplemental_outcome);
  if (resolved.ok || resolved.error.code !== "STATE_INVALID") return resolved;
  return resolveAdvancingGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint, input.supplemental_outcome);
}

async function resolveAdvancingGate(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  gateId: PathSafeId,
  inputFingerprint: Sha256Digest,
  supplementalOutcome?: SupplementalReviewOutcome,
): Promise<ProjectResult<GateResolution>> {
  try {
    return await dependencies.lock.runExclusive(authority.task_root, async () => {
      const stateResult = await stateOrFailure(dependencies, authority); if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(dependencies, authority, current, inputFingerprint);
      if (!live.ok) return live;
      const requestPath = await resolvePath(dependencies, authority, gateRequestClaim(gateId), "decision");
      const archivePath = await resolvePath(dependencies, authority, gateDecisionClaim(gateId), "decision");
      const interfacePath = await resolvePath(dependencies, authority, "gate.decision", "gate-interface");
      if (!requestPath.ok) return requestPath; if (!archivePath.ok) return archivePath; if (!interfacePath.ok) return interfacePath;
      const request = await readCanonical(requestPath.value, "gate request", parseGateRequest);
      if (request === "missing" || request === "invalid") return issue("STATE_INVALID", current.value, "gate-request-invalid");
      let archived = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
      if (archived === "invalid") return issue("STATE_INVALID", current.value, "gate-decision-record-invalid");
      if (archived !== "missing" && !validateDurableSemantics({ gate_request: request, gate_decision: archived }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
      if (archived === "missing") {
        const raw = await readCanonical(interfacePath.value, "gate decision interface", (value) => value as PlainJsonValue);
        if (raw === "missing" || raw === "invalid") return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: "decision-invalid" }));
        let record: GateDecisionRecordV1;
        const ledger = await currentSupplementalLedger(dependencies, authority, request.value, inputFingerprint, supplementalOutcome);
        if (ledger === undefined) return issue("STATE_INVALID", current.value, "active-gate-interface-invalid");
        try { record = parseInterface(raw.value, request.value, ledger); } catch { return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: "decision-binding-invalid" })); }
        const document = canonicalDocument(record);
        if (!earnsReceipt(record)) return issue("STATE_INVALID", current.value, "gate-resolution-routing-invalid");
        if (await dependencies.atomic.createExclusive(archivePath.value, document.bytes) !== "created") return issue("STATE_INVALID", current.value, "gate-resolution-race");
        archived = document;
      }
      if (current.value.open_gate?.gate_id !== gateId) {
        const effect = archived.value.outcome === "decided" ? gateDecisionEffect(archived.value.envelope.payload) : "advance";
        return ok({ state: current, record: archived, effect, replayed: true });
      }
      if (archived.value.outcome === "decided" && archived.value.kind === "restore-collision" && archived.value.envelope.payload.decision === "discard-and-restore") {
        const reference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === request.value.phase_instance && item.step === "produce");
        if (reference === undefined || dependencies.load_retained_result === undefined || dependencies.projection_writer === undefined || dependencies.gate_secret_scanner === undefined) return issue("STATE_INVALID", current.value, "restore-result-missing");
        const retained = await dependencies.load_retained_result(reference); if (!retained.ok) return retained;
        const context = request.value.context as Extract<GateRequestV1, { kind: "restore-collision" }>["context"];
        const repositoryPath = `.archflow/tasks/${authority.task_id}/${context.path}`;
        const original = retained.value.projection_plan.entries.find((entry) => entry.path === repositoryPath);
        if (original === undefined || original.git_tracked === undefined) return issue("STATE_INVALID", current.value, "restore-gated-path-missing");
        const selected = [original];
        if (original.rename_pair !== undefined) {
          const peer = retained.value.projection_plan.entries.find((entry) => entry.path === original.rename_pair!.peer_path && entry.rename_pair?.peer_path === original.path);
          if (peer === undefined || peer.git_tracked === undefined) return issue("STATE_INVALID", current.value, "restore-rename-peer-missing");
          selected.push(peer);
        }
        const captures = new Map<string, Awaited<ReturnType<typeof captureProjectionTarget>>>();
        for (const entry of selected) {
          const captured = await captureProjectionTarget(entry.target);
          captures.set(entry.path, captured);
        }
        const alreadyApplied = selected.every((entry) => projectionGenerationDigest(captures.get(entry.path)!.observation) === desiredGenerationDigest(entry.desired));
        const originalGeneration = projectionGenerationDigest(captures.get(original.path)!.observation);
        if (originalGeneration !== context.current_generation_digest && originalGeneration !== desiredGenerationDigest(original.desired)) return issue("STATE_INVALID", current.value, "restore-current-generation-stale");
        if (selected.slice(1).some((entry) => {
          const observation = captures.get(entry.path)!.observation;
          return !isDeepStrictEqual(observation, entry.observed_before) && projectionGenerationDigest(observation) !== desiredGenerationDigest(entry.desired);
        })) return issue("STATE_INVALID", current.value, "restore-rename-peer-changed");
        if (!alreadyApplied) {
          const pending = selected.filter((entry) => projectionGenerationDigest(captures.get(entry.path)!.observation) !== desiredGenerationDigest(entry.desired));
          const ordered = [...pending].sort((left, right) =>
            left.rename_pair?.role === "source" ? -1 : right.rename_pair?.role === "source" ? 1 : 0
          );
          const sources: ProjectionSource[] = ordered.map((entry) => {
            const captured = captures.get(entry.path)!;
            return Object.freeze({
              path: entry.path, target: entry.target, desired: entry.desired,
              authenticated_before: captured.observation, rollback: captured.rollback,
              git_tracked: entry.git_tracked!,
            });
          });
          const plan = await prepareProjectionPlan(sources, dependencies.gate_secret_scanner, retained.value.worktree_root); if (!plan.ok) return plan;
          if (plan.value.collisions.length !== 0) return issue("STATE_INVALID", current.value, "restore-replan-collision");
          const applied = await applyProjectionPlan(dependencies.projection_writer, plan.value);
          if (applied.outcome !== "applied") return issue("STATE_INVALID", current.value, `restore-${applied.outcome}`);
        }
      }
      const prepared = nextStateForRecord(current.value, archived.value, archived.digest);
      const installed = await installReceipt(dependencies, authority, request.value, archived.value, current, prepared, inputFingerprint);
      if (!installed.ok) return installed;
      await dependencies.atomic.replace(authority.state, installed.value.final.bytes);
      const gateJson = await resolvePath(dependencies, authority, "gate.json", "gate-interface");
      if (gateJson.ok) await dependencies.atomic.removeGateInterface(gateJson.value);
      await dependencies.atomic.removeGateInterface(interfacePath.value);
      return ok({ state: installed.value.final, record: archived, effect: "advance", replayed: false });
    });
  } catch (error) { return error instanceof TaskLockError ? io(authority, `gate-lock-${error.stage}`) : io(authority, "gate-resolve-advance"); }
}

/** No-clobber primitive used by the offline helper for canonical manual gate files. */
export async function createManualGateFile<T extends GateRequestV1 | GateDecisionRecordV1>(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  kind: "request" | "decision",
  value: T,
): Promise<ProjectResult<CanonicalDocument<T>>> {
  assertInternalTransactionAuthority(authority, { runner: dependencies.runner, environment: dependencies.environment });
  const parsed = (kind === "request" ? parseGateRequest(value) : parseGateDecisionRecord(value)) as T;
  await ensureDecisionDirectory(authority, parsed.gate_id);
  const target = await resolvePath(dependencies, authority, kind === "request" ? gateRequestClaim(parsed.gate_id) : gateDecisionClaim(parsed.gate_id), "decision");
  if (!target.ok) return target;
  const document = canonicalDocument(parsed);
  return await dependencies.atomic.createExclusive(target.value, document.bytes) === "created"
    ? ok(document)
    : issue("CONTRACT_INVALID", undefined, `manual-gate-${kind}-exists`);
}

export type ImportedGateAuthority = Readonly<{ approvals: readonly ApprovalRef[]; waivers: readonly WaiverRef[] }>;

/** Derives checkpoint-ready authority only from complete, request-bound manual pairs and no live gate. */
export function importGateDecisions(
  state: TaskStateV1,
  pairs: readonly Readonly<{ request: GateRequestV1; decision: GateDecisionRecordV1 } >[],
): ImportedGateAuthority {
  if (state.open_gate !== undefined) throw new TypeError("manual gate import requires no live gate");
  const approvals = [...state.approvals];
  const waivers = [...state.waivers];
  const present = new Set([...approvals, ...waivers].map((entry) => entry.gate_id));
  for (const pair of pairs) {
    const request = parseGateRequest(pair.request);
    const decision = parseGateDecisionRecord(pair.decision);
    if (request.task_id !== state.task_id) throw new TypeError("manual gate pair is foreign to current task");
    if (present.has(request.gate_id)) continue;
    if (request.gate_id !== decision.gate_id || request.task_id !== decision.task_id || request.phase_instance !== decision.phase_instance || request.kind !== decision.kind || request.subject_digest !== decision.subject_digest || request.context_digest !== decision.context_digest) throw new TypeError("manual gate pair does not bind");
    const digest = canonicalJsonDigest(decision);
    const revision = state.revision + 1;
    if (decision.outcome === "decided") {
      bindEnvelope(request, decision.envelope);
      if (gateDecisionEffect(decision.envelope.payload) === "advance") approvals.push({ gate_id: decision.gate_id, gate_kind: decision.kind, subject_digest: decision.subject_digest, decision_digest: digest, resolved_at_revision: revision } as ApprovalRef);
    } else if (decision.outcome === "waiver-decided") {
      const context = request.context as WaiverGateContext;
      if (!("origin" in context) || !isDeepStrictEqual(context.origin, decision.origin) || !isDeepStrictEqual(context.origin.scope, decision.scope)) throw new TypeError("manual waiver pair does not bind");
      waivers.push({ gate_id: decision.gate_id, rule_id: decision.origin.rule.rule_id, rule_version: decision.origin.rule.rule_version, subject_digest: decision.origin.subject_digest, scope: decision.scope, granted: decision.granted, expires: "task-complete", granted_at_revision: revision } as WaiverRef);
    }
    present.add(request.gate_id);
  }
  approvals.sort((a, b) => a.gate_id.localeCompare(b.gate_id));
  waivers.sort((a, b) => a.gate_id.localeCompare(b.gate_id));
  return Object.freeze({ approvals: Object.freeze(approvals), waivers: Object.freeze(waivers) });
}
