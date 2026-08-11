import { canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import { createCommittedIntentSubject, createPreparedIntentSubject, validateDurableSemantics } from "../contracts/durable.js";
import { intentOutcomeDigest, intentReceiptDigest, parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ActiveGateV1, GateRequestV1 } from "../contracts/durable-gate.js";
import { parsePathSafeId, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { assertPlainJson } from "../contracts/plain-json.js";

export type ActiveAuthorityHeads = Readonly<{
  gate?: Readonly<{ gate_id: PathSafeId; subject_digest: Sha256Digest; context_digest: Sha256Digest }>;
}>;

/** Produces the gate reconciliation head only from the mutable projection and its immutable request. */
export function activeGateHead(
  active: ActiveGateV1,
  request: GateRequestV1,
): NonNullable<ActiveAuthorityHeads["gate"]> {
  if (
    active.gate_id !== request.gate_id || active.task_id !== request.task_id ||
    active.phase_instance !== request.phase_instance || active.kind !== request.kind ||
    active.subject_digest !== request.subject_digest || active.context_digest !== request.context_digest
  ) throw new TypeError("active gate projection does not bind its archived request");
  return Object.freeze({
    gate_id: parsePathSafeId(request.gate_id),
    subject_digest: request.subject_digest,
    context_digest: request.context_digest,
  });
}

export type ReconciliationIntent = Readonly<{
  request_digest: Sha256Digest;
  receipt?: CanonicalDocument<IntentReceiptV1>;
}>;

export type ReconciliationInput = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  recorded_projections: readonly ProjectionDigestRef[];
  current_projections: readonly ProjectionDigestRef[];
  active_heads: ActiveAuthorityHeads;
  intent?: ReconciliationIntent;
  /** Discovery-only blockers consumed by status; they do not alter reconciliation classification. */
  blocking_reasons?: readonly string[];
}>;

export type ReconciliationFinding =
  | Readonly<{ kind: "projection-mismatch"; path: ProjectionDigestRef["path"]; recorded_digest: Sha256Digest; observed_digest?: Sha256Digest; next_action: "restore-or-record-new-transition" }>
  | Readonly<{ kind: "receipt-only"; request_digest: Sha256Digest; receipt_digest: Sha256Digest; next_action: "resume-exact-intent" }>
  | Readonly<{ kind: "receipt-invalid"; receipt_digest: Sha256Digest; next_action: "inspect-retained-receipt" }>
  | Readonly<{ kind: "intent-mismatch"; requested_digest: Sha256Digest; receipt_request_digest: Sha256Digest; next_action: "create-fresh-intent" }>
  | Readonly<{ kind: "active-gate-mismatch"; head?: ActiveAuthorityHeads["gate"]; next_action: "resolve-current-authority" }>;

export type ReconciliationResult = Readonly<{
  classification: "consistent" | "reconciliation-required";
  findings: readonly ReconciliationFinding[];
}>;

function materialize(input: ReconciliationInput): ReconciliationInput {
  const stateValue = ownData(input.state, "value", "reconciliation state");
  const stateDigest = ownData(input.state, "digest", "reconciliation state");
  assertPlainJson(stateValue, "reconciliation state value");
  assertPlainJson({
    recorded_projections: input.recorded_projections,
    current_projections: input.current_projections,
    active_heads: input.active_heads,
    ...(input.blocking_reasons === undefined ? {} : { blocking_reasons: input.blocking_reasons }),
  }, "reconciliation working set");
  let intent: ReconciliationIntent | undefined;
  if (input.intent !== undefined) {
    assertPlainJson({ request_digest: input.intent.request_digest }, "reconciliation intent");
    if (input.intent.receipt === undefined) {
      intent = { request_digest: input.intent.request_digest };
    } else {
      const receiptValue = ownData(input.intent.receipt, "value", "reconciliation receipt");
      const receiptDigest = ownData(input.intent.receipt, "digest", "reconciliation receipt");
      assertPlainJson(receiptValue, "reconciliation receipt value");
      intent = {
        request_digest: input.intent.request_digest,
        receipt: { bytes: input.intent.receipt.bytes, value: structuredClone(receiptValue) as IntentReceiptV1, digest: receiptDigest as Sha256Digest },
      };
    }
  }
  return {
    state: { bytes: input.state.bytes, value: structuredClone(stateValue) as TaskStateV1, digest: stateDigest as Sha256Digest },
    recorded_projections: structuredClone(input.recorded_projections),
    current_projections: structuredClone(input.current_projections),
    active_heads: structuredClone(input.active_heads),
    ...(intent === undefined ? {} : { intent }),
    ...(input.blocking_reasons === undefined
      ? {}
      : { blocking_reasons: Object.freeze([...input.blocking_reasons]) }),
  };
}

function ownData(value: object, field: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${label}.${field} must be an own enumerable data property`);
  }
  return descriptor.value;
}

/** Classifies only the supplied current working set. It performs no discovery or promotion. */
export function reconcileCurrentAuthority(value: ReconciliationInput): ReconciliationResult {
  const input = materialize(value);
  const findings: ReconciliationFinding[] = [];
  const observed = new Map(input.current_projections.map((projection) => [projection.path, projection.content_digest]));
  for (const recorded of input.recorded_projections) {
    const digest = observed.get(recorded.path);
    if (digest !== recorded.content_digest) {
      findings.push(Object.freeze({
        kind: "projection-mismatch",
        path: recorded.path,
        recorded_digest: recorded.content_digest,
        ...(digest === undefined ? {} : { observed_digest: digest }),
        next_action: "restore-or-record-new-transition",
      }));
    }
  }

  const receipt = input.intent?.receipt;
  if (receipt !== undefined) {
    const isCommitted = input.state.value.committed_intent?.receipt_digest === receipt.digest;
    let valid = false;
    try {
      const parsed = parseIntentReceipt(receipt.value);
      valid = receipt.digest === canonicalJsonDigest(parsed) &&
        receipt.digest === intentReceiptDigest(parsed) &&
        parsed.prepared_state_digest === canonicalJsonDigest(parsed.prepared_state) &&
        parsed.outcome_digest === intentOutcomeDigest(parsed.outcome) &&
        validateDurableSemantics(isCommitted
          ? createCommittedIntentSubject(input.state, receipt)
          : createPreparedIntentSubject(input.state, receipt)).ok;
    } catch {
      valid = false;
    }
    if (!valid) {
      findings.push(Object.freeze({
        kind: "receipt-invalid",
        receipt_digest: receipt.digest,
        next_action: "inspect-retained-receipt",
      }));
    } else if (receipt.value.request_digest !== input.intent!.request_digest) {
      findings.push(Object.freeze({
        kind: "intent-mismatch",
        requested_digest: input.intent!.request_digest,
        receipt_request_digest: receipt.value.request_digest,
        next_action: "create-fresh-intent",
      }));
    } else if (!isCommitted) {
      findings.push(Object.freeze({
        kind: "receipt-only",
        request_digest: receipt.value.request_digest,
        receipt_digest: receipt.digest,
        next_action: "resume-exact-intent",
      }));
    }
  }

  const heads = input.active_heads;
  const state = input.state.value;
  const gateMatches = heads.gate === undefined
    ? state.open_gate === undefined
    : state.open_gate?.gate_id === heads.gate.gate_id &&
      state.open_gate.subject_digest === heads.gate.subject_digest &&
      state.open_gate.context_digest === heads.gate.context_digest;
  if (!gateMatches) {
    findings.push(Object.freeze({ kind: "active-gate-mismatch", ...(heads.gate === undefined ? {} : { head: heads.gate }), next_action: "resolve-current-authority" }));
  }
  return Object.freeze({
    classification: findings.length === 0 ? "consistent" : "reconciliation-required",
    findings: Object.freeze(findings),
  });
}
