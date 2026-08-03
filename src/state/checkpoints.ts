import { isDeepStrictEqual } from "node:util";

import { canonicalDocument, type CanonicalDocument } from "../contracts/canonical.js";
import {
  chainAnchor,
  selectGreatestValidChain,
  type ManualCheckpointImportV1,
} from "../contracts/durable-checkpoint.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type {
  ParsedToolCall,
  ResultExpectation,
  StructurallyValidProjectResult,
} from "../contracts/mcp-tools.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import type { NextStateDraft, PreparedTransaction } from "./transaction.js";
import {
  reduceAuthenticatedManualChain,
  type AuthenticatedManualImportEvidence,
} from "./manual-import.js";

const authenticAdoptionPlans = new WeakMap<object, Sha256Digest>();

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const invalid = (phase: TaskStateV1["phase_instance"], issue_code: string): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", { phase_instance: phase, issue_code }),
  });

function ownField(value: unknown, field: string): unknown {
  if (value === null || typeof value !== "object") throw new TypeError("checkpoint adoption input must be an object");
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`checkpoint adoption input.${field} must be an own enumerable data property`);
  }
  return descriptor.value;
}

/** Transaction-kernel authenticity check. Only objects returned by this module's planner pass. */
export function assertInternalCheckpointAdoptionPlan(value: object): void {
  const registered = authenticAdoptionPlans.get(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "next_state");
  if (
    registered === undefined ||
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    canonicalDocument(descriptor.value as NextStateDraft).digest !== registered
  ) {
    throw new TypeError("checkpoint adoption requires an authentic planner-minted preparation");
  }
}

export type CheckpointAdoptionPlanInput = Readonly<{
  current: CanonicalDocument<TaskStateV1>;
  call: Extract<ParsedToolCall, { readonly name: "archflow_state" }>;
  expectation: ResultExpectation<"archflow_state">;
  result: StructurallyValidProjectResult<"archflow_state">;
  evidence?: AuthenticatedManualImportEvidence;
}>;

/**
 * Validates the complete caller-supplied import and produces the one state successor that names
 * its exact head. Checkpoints remain caller-owned evidence; this planner never resolves or writes
 * checkpoint paths.
 */
export function planCheckpointAdoption(
  value: CheckpointAdoptionPlanInput,
): ProjectResult<PreparedTransaction<"archflow_state">> {
  const keys = Object.keys(value).sort();
  if (!isDeepStrictEqual(keys, ["call", "current", "expectation", "result"]) &&
      !isDeepStrictEqual(keys, ["call", "current", "evidence", "expectation", "result"])) {
    throw new TypeError("checkpoint adoption input has unexpected or missing fields");
  }
  const currentDocument = ownField(value, "current") as CanonicalDocument<TaskStateV1>;
  const call = ownField(value, "call") as CheckpointAdoptionPlanInput["call"];
  const expectation = ownField(value, "expectation") as ResultExpectation<"archflow_state">;
  const result = ownField(value, "result") as StructurallyValidProjectResult<"archflow_state">;
  const evidence = keys.includes("evidence")
    ? ownField(value, "evidence") as AuthenticatedManualImportEvidence
    : undefined;
  const artifactValue = call.input.artifact;
  if (artifactValue?.artifact_kind !== "manual-checkpoint-import") {
    throw new TypeError("checkpoint adoption requires a manual-checkpoint-import artifact");
  }
  assertPlainJson(artifactValue, "manual checkpoint import");
  const artifact = structuredClone(artifactValue) as ManualCheckpointImportV1;
  if (artifact.import_mode === "initial") {
    return invalid(currentDocument.value.phase_instance, "checkpoint-initial-import-requires-missing-state");
  }
  if (evidence === undefined) {
    return invalid(currentDocument.value.phase_instance, "manual-import-evidence-required");
  }

  const artifactDocument = canonicalDocument(artifact);
  const semantics = validateDurableSemantics({ state: currentDocument, artifact: artifactDocument });
  if (!semantics.ok) return semantics;

  const selected = selectGreatestValidChain(chainAnchor(artifact), artifact.chain);
  if (selected.kind !== "chain") {
    return invalid(currentDocument.value.phase_instance, `checkpoint-chain-${selected.outcome}`);
  }
  if (selected.chain.length !== artifact.chain.length || !isDeepStrictEqual(selected.chain, artifact.chain)) {
    return invalid(currentDocument.value.phase_instance, "checkpoint-chain-not-exact");
  }
  const head = selected.chain.at(-1);
  if (head === undefined) return invalid(currentDocument.value.phase_instance, "checkpoint-chain-empty");
  if (
    call.input.phase_instance !== head.phase_instance ||
    call.input.step !== head.step ||
    call.input.status !== head.status ||
    call.input.input_fingerprint !== head.input_fingerprint
  ) {
    return invalid(currentDocument.value.phase_instance, "checkpoint-chain-head-request-mismatch");
  }

  const reduced = reduceAuthenticatedManualChain({ artifact, evidence, current: currentDocument.value });
  if (!reduced.ok) return reduced;
  const next = reduced.value.next_state;

  const prepared: PreparedTransaction<"archflow_state"> = Object.freeze({
    expectation,
    result,
    next_state: Object.freeze(next),
  });
  authenticAdoptionPlans.set(prepared, canonicalDocument(next).digest);
  return ok(prepared);
}
