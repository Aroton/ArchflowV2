import { constants as fsConstants } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { canonicalDocument, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../contracts/canonical.js";
import {
  parseGateDecisionRecord,
  type ActiveGateV1,
  type GateDecisionRecordV1,
  type GateRequestV1,
  type WaiverGateContext,
} from "../contracts/durable-gate.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { openGateFrozenStateDigest } from "../contracts/durable.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import {
  parseGateDecisionEnvelope,
  validateGateDecision,
  type GateDecisionEnvelope,
  type GateKind,
  type HumanDecisionProvenance,
  type WaiverOriginRef,
  type WaiverScope,
} from "../contracts/gates.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import {
  gateDecisionClaim,
  gateRequestClaim,
  openResolved,
  parseWorkspacePathClaim,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  type ResolvedPath,
  type ResolvedWorkspacePath,
} from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import type { TransactionDependencies } from "./transaction.js";
import { projectionGenerationDigest } from "./snapshots.js";
import type { SecretScanner } from "../contracts/secret-scan.js";

export const DECISIONS: Readonly<Record<GateKind, readonly string[]>> = Object.freeze({
  "artifact-approval": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "design-approval": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "constitution-review": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "material-drift": ["amend-upstream", "revise-current", "reject", "cancel"],
  "attempts-exhausted": ["retry-once", "revise", "abort", "push-through-review", "cancel"],
  "validation-override": ["grant-validation-override", "deny-validation-override", "cancel"],
  "constitution-edit": ["revert-edit", "start-base-amendment", "abort", "cancel"],
  "commit-authorization": ["authorize-commit", "revise", "abort", "waiver-requested", "cancel"],
  "restore-collision": ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"],
  "baseline-adoption": ["adopt-current-bytes", "restore-recorded-bytes", "adopt-committed-deletions", "abort", "cancel"],
  "migration-audit": ["accept-import-audit", "revise", "abort", "cancel"],
});

export function deepFreezeGateJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreezeGateJson(nested);
    Object.freeze(value);
  }
  return value;
}

export type GateReentryFingerprintResolver = (
  input: Readonly<{
    authority: TransactionAuthority;
    request: GateRequestV1;
    current: CanonicalDocument<TaskStateV1>;
    target_phase_instance?: TaskStateV1["phase_instance"];
    /** The recorded fingerprint a replay validation compares against; landing computations omit it. */
    expected_input_fingerprint?: Sha256Digest;
  }>,
) => Promise<ProjectResult<Sha256Digest>>;

export type GateLifecycleDependencies = Readonly<TransactionDependencies & {
  gate_secret_scanner?: SecretScanner;
  resolve_gate_reentry_fingerprint?: GateReentryFingerprintResolver;
}>;
export type GateApprovalLoaderDependencies = Pick<
  GateLifecycleDependencies,
  "runner" | "environment" | "read_state"
>;
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
  waiver_origin_gate_id?: PathSafeId;
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
  effect: "advance" | "retry" | "redirect-waiver" | "redirect-upstream" | "validation-resume" | "non-advancing";
  replayed: boolean;
}>;

/** Fresh attempts-exhausted requests advertise push-through only when exact eligibility exists. */
export function decisionsForGate(
  kind: GateKind,
  context: GateRequestV1["context"],
): readonly string[] {
  if (kind === "attempts-exhausted" &&
      !("review_push_through" in context) &&
      (context as Record<string, unknown>).review_push_through === undefined) {
    return Object.freeze(["retry-once", "revise", "abort", "cancel"]);
  }
  return DECISIONS[kind];
}

export const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
export const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });
export const issue = (code: "CONTRACT_INVALID" | "STATE_INVALID", state: TaskStateV1 | undefined, issueCode: string): ProjectResult<never> =>
  fail(code === "STATE_INVALID"
    ? createProjectError(code, { phase_instance: state!.phase_instance, issue_code: issueCode })
    : createProjectError(code, { issue_code: issueCode }));
export const io = (authority: TransactionAuthority, operation: string): ProjectResult<never> =>
  fail(createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }));

export function resolvePath(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  authority: TransactionAuthority,
  claim: "gate.json" | "gate.decision",
  expectedClass: "workspace-gate-interface",
): Promise<ProjectResult<ResolvedWorkspacePath>>;
export function resolvePath(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  authority: TransactionAuthority,
  claim: ReturnType<typeof gateRequestClaim> | ReturnType<typeof gateDecisionClaim>,
  expectedClass: "authority-decision",
): Promise<ProjectResult<ResolvedPath>>;
export async function resolvePath(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  authority: TransactionAuthority,
  claim: ReturnType<typeof gateRequestClaim> | ReturnType<typeof gateDecisionClaim> | "gate.json" | "gate.decision",
  expectedClass: "authority-decision" | "workspace-gate-interface",
): Promise<ProjectResult<ResolvedPath | ResolvedWorkspacePath>> {
  if (expectedClass === "workspace-gate-interface") {
    return resolveTaskWorkspacePath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parseWorkspacePathClaim(`cache/gates/${claim as "gate.json" | "gate.decision"}`),
      expectedClass: "workspace-gate-interface",
      context: authority.context,
    });
  }
  return resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: claim as ReturnType<typeof gateRequestClaim> | ReturnType<typeof gateDecisionClaim>,
    expectedClass: "authority-decision",
    context: authority.context,
  });
}

export async function readCanonical<T extends PlainJsonValue>(
  path: ResolvedPath | ResolvedWorkspacePath,
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

export function stateWithOpen(state: TaskStateV1, request: Pick<GateRequestV1, "gate_id" | "kind" | "subject_digest" | "context_digest" | "context">): CanonicalDocument<TaskStateV1> {
  const { last_transition: _transition, open_gate: _open, ...base } = state;
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

export function activeProjection(request: GateRequestV1): ActiveGateV1 {
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
  } as unknown as ActiveGateV1;
}

export function waiverContext(value: GateRequestV1["context"]): WaiverGateContext | undefined {
  return value !== null && typeof value === "object" && "origin" in value ? value as WaiverGateContext : undefined;
}

export function desiredGenerationDigest(desired: Readonly<{ state: "absent" }> | Readonly<{ state: "present"; file_type: "regular" | "symlink"; mode: "100644" | "100755" | "120000"; bytes: Uint8Array }>): Sha256Digest {
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

export function parseInterface(value: unknown, request: GateRequestV1): GateDecisionRecordV1 {
  assertPlainJson(value, "gate decision interface");
  if (value !== null && typeof value === "object" && "cancelled" in value) {
    const candidate = value as unknown as CancelInterface;
    if (candidate.cancelled !== true || candidate.gate_id !== request.gate_id || candidate.task_id !== request.task_id || candidate.phase_instance !== request.phase_instance || candidate.subject_digest !== request.subject_digest || candidate.context_digest !== request.context_digest) throw new TypeError("cancellation does not bind request");
    return parseGateDecisionRecord({ schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance, kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest, outcome: "cancelled", reason: candidate.reason, human_provenance: candidate.human_provenance });
  }
  if (request.context !== null && typeof request.context === "object" && "origin" in request.context) {
    const candidate = value as unknown as WaiverInterface;
    const context = request.context as WaiverGateContext;
    if (candidate.gate_id !== request.gate_id || candidate.task_id !== request.task_id || candidate.phase_instance !== request.phase_instance || candidate.subject_digest !== request.subject_digest || candidate.context_digest !== request.context_digest || !isDeepStrictEqual(candidate.origin, context.origin) || !isDeepStrictEqual(candidate.scope, context.origin.scope)) throw new TypeError("waiver decision does not bind origin");
    return parseGateDecisionRecord({ schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance, kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest, outcome: "waiver-decided", granted: candidate.granted, scope: candidate.scope, origin: candidate.origin, notes: candidate.notes, human_provenance: candidate.human_provenance });
  }
  const envelope = parseGateDecisionEnvelope(value);
  bindEnvelope(request, envelope);
  return parseGateDecisionRecord({ schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance, kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest, outcome: "decided", envelope });
}

export async function stateOrFailure(
  dependencies: Pick<GateLifecycleDependencies, "read_state">,
  authority: TransactionAuthority,
): Promise<ProjectResult<CanonicalDocument<TaskStateV1>>> {
  const read = await dependencies.read_state(authority.state);
  return read.kind === "canonical" ? ok(read.document) : read.kind === "unreadable" ? io(authority, "gate-state-read") : issue("CONTRACT_INVALID", undefined, `gate-state-${read.kind}`);
}
