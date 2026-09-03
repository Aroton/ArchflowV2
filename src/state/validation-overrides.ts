import { isDeepStrictEqual } from "node:util";

import {
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  type ArchivedGateDecisionRecordV1,
  type ArchivedGateRequestV1,
} from "../contracts/durable-gate.js";
import type { TaskStateV1, ValidationOverrideRecordV1 } from "../contracts/durable-state.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import type { ProjectResult } from "../contracts/errors.js";
import {
  validationOverrideSubjectDigest,
  type GateContext,
  type GateDecisionEnvelope,
  type ValidationOverrideRequestRefV1,
} from "../contracts/gates.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { gateDecisionClaim, gateRequestClaim } from "../repository/paths.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import {
  deepFreezeGateJson,
  issue,
  ok,
  readCanonical,
  resolvePath,
  stateOrFailure,
  type GateApprovalLoaderDependencies,
} from "./gate-core.js";

const authenticatedValidationOverrides = new WeakSet<object>();
const authenticatedValidationOverrideBrand: unique symbol = Symbol("AuthenticatedValidationOverride");

type ValidationOverrideRequest = ArchivedGateRequestV1 & Readonly<{
  kind: "validation-override";
  context: GateContext<"validation-override">;
  current_evidence: ValidationOverrideRequestRefV1;
}>;
type ValidationOverrideDecision = ArchivedGateDecisionRecordV1 & Readonly<{
  kind: "validation-override";
  outcome: "decided";
  envelope: Extract<GateDecisionEnvelope, { readonly kind: "validation-override" }>;
}>;

/** A validation exception reloaded from its durable state record and immutable gate archive. */
export type AuthenticatedValidationOverride = Readonly<{
  record: ValidationOverrideRecordV1;
  request: ValidationOverrideRequest;
  decision: ValidationOverrideDecision;
}> & { readonly [authenticatedValidationOverrideBrand]: true };

export function assertAuthenticatedValidationOverride(value: AuthenticatedValidationOverride): void {
  if (!authenticatedValidationOverrides.has(value)) {
    throw new TypeError("an authenticated validation override is required");
  }
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Reloads one grant without trusting caller-supplied state JSON. Missing, denied, cancelled,
 * malformed, foreign, or mismatched archives never mint the branded authority.
 */
export async function loadAuthenticatedValidationOverride(
  dependencies: GateApprovalLoaderDependencies,
  authority: TransactionAuthority,
  record: ValidationOverrideRecordV1,
): Promise<ProjectResult<AuthenticatedValidationOverride>> {
  assertInternalTransactionAuthority(authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  assertPlainJson(record, "validation override record");
  const claimed = structuredClone(record);
  const current = await stateOrFailure(dependencies, authority);
  if (!current.ok) return current;
  const state = current.value.value;
  if (
    state.task_id !== authority.task_id ||
    !verifyRepositoryIdentity(state.repository_identity_digest, authority.repository_identity).ok
  ) return issue("STATE_INVALID", state, "validation-override-state-authority-mismatch");
  const durable = (state.validation_overrides ?? []).find((entry) => entry.gate_id === claimed.gate_id);
  if (durable === undefined || !isDeepStrictEqual(durable, claimed)) {
    return issue("STATE_INVALID", state, "validation-override-not-current");
  }

  const requestPath = await resolvePath(
    dependencies, authority, gateRequestClaim(claimed.gate_id), "authority-decision",
  );
  const decisionPath = await resolvePath(
    dependencies, authority, gateDecisionClaim(claimed.gate_id), "authority-decision",
  );
  if (!requestPath.ok) return requestPath;
  if (!decisionPath.ok) return decisionPath;
  const request = await readCanonical(requestPath.value, "validation override request", parseArchivedGateRequest);
  const decision = await readCanonical(
    decisionPath.value, "validation override decision", parseArchivedGateDecisionRecord,
  );
  if (request === "missing") {
    return issue("STATE_INVALID", state, "validation-override-request-unavailable");
  }
  if (decision === "missing") {
    return issue("STATE_INVALID", state, "validation-override-decision-unavailable");
  }
  if (request === "invalid" || decision === "invalid") {
    return issue("STATE_INVALID", state, "validation-override-archive-invalid");
  }
  if (
    decision.digest !== claimed.decision_digest ||
    !validateDurableSemantics({ gate_request: request, gate_decision: decision }).ok ||
    request.value.kind !== "validation-override" ||
    decision.value.kind !== "validation-override" || decision.value.outcome !== "decided" ||
    decision.value.envelope.payload.decision !== "grant-validation-override"
  ) return issue("STATE_INVALID", state, "validation-override-binding-invalid");

  const requestValue = request.value as ValidationOverrideRequest;
  const decisionValue = decision.value as ValidationOverrideDecision;
  const context = requestValue.context;
  const evidence = requestValue.current_evidence;
  const provenance = decisionValue.envelope.human_provenance;
  const ordinalValidations = [...context.displaced_validations].sort(ordinal);
  const subjectDigest = validationOverrideSubjectDigest({
    task_id: requestValue.task_id,
    phase_instance: requestValue.phase_instance,
    input_fingerprint: context.input_fingerprint,
    governing_phase_design_digest: context.governing_phase_design_digest,
    displaced_validations: context.displaced_validations,
  });
  if (
    requestValue.task_id !== authority.task_id || requestValue.gate_id !== claimed.gate_id ||
    requestValue.phase_instance !== claimed.phase_instance ||
    requestValue.subject_digest !== claimed.subject_digest || subjectDigest !== claimed.subject_digest ||
    context.input_fingerprint !== claimed.input_fingerprint ||
    context.governing_phase_design_digest !== claimed.governing_phase_design_digest ||
    !isDeepStrictEqual(ordinalValidations, claimed.displaced_validations) ||
    evidence.task_id !== authority.task_id || evidence.phase_instance !== claimed.phase_instance ||
    evidence.input_fingerprint !== claimed.input_fingerprint ||
    evidence.governing_phase_design_digest !== claimed.governing_phase_design_digest ||
    evidence.request_revision !== context.request_revision ||
    evidence.validation_request_subject_digest !== claimed.subject_digest ||
    decisionValue.task_id !== authority.task_id || decisionValue.gate_id !== claimed.gate_id ||
    decisionValue.phase_instance !== claimed.phase_instance ||
    decisionValue.subject_digest !== claimed.subject_digest ||
    decisionValue.context_digest !== requestValue.context_digest ||
    decisionValue.envelope.payload.reason !== claimed.human_reason ||
    provenance.actor_class !== "human" || provenance.channel !== "connected-host" ||
    provenance.recorded_at !== claimed.decided_at ||
    requestValue.opened_at_revision !== context.request_revision + 1 ||
    claimed.granted_at_revision !== requestValue.opened_at_revision + 1
  ) return issue("STATE_INVALID", state, "validation-override-binding-invalid");

  const authenticated = {
    record: deepFreezeGateJson(structuredClone(durable)),
    request: deepFreezeGateJson(structuredClone(requestValue)),
    decision: deepFreezeGateJson(structuredClone(decisionValue)),
  } as unknown as AuthenticatedValidationOverride;
  Object.defineProperty(authenticated, authenticatedValidationOverrideBrand, {
    value: true, enumerable: false, writable: false, configurable: false,
  });
  Object.freeze(authenticated);
  authenticatedValidationOverrides.add(authenticated);
  return ok(authenticated);
}

/** Whether a loaded grant still governs the exact implementation input and phase design. */
export function authenticatedValidationOverrideIsCurrent(
  override: AuthenticatedValidationOverride,
  state: Pick<TaskStateV1, "phase_instance" | "input_fingerprint">,
  governingPhaseDesignDigest: ValidationOverrideRecordV1["governing_phase_design_digest"],
): boolean {
  assertAuthenticatedValidationOverride(override);
  return override.record.phase_instance === state.phase_instance &&
    override.record.input_fingerprint === state.input_fingerprint &&
    override.record.governing_phase_design_digest === governingPhaseDesignDigest;
}
