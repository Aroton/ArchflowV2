import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId } from "../contracts/evidence.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { buildDocumentArtifact, type DocumentArtifactInput } from "../state/document-artifact.js";
import { buildImplementationOutput, type ImplementationOutputInput } from "../state/implementation-manifest.js";
import {
  phaseDocumentDefaults,
  phaseImplParentDocumentDefaults,
} from "../state/phase-documents.js";
import type { ProductionServices } from "../state/production.js";
import { legalRunStepStatus } from "../state/transitions.js";
import { computeCallEnvelope, type CallEnvelope } from "./envelope.js";

const fail = <T = never>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

const PAYLOAD_SHAPE =
  '{"intent_id":<fresh id>,"document"?:{"document_path"?:<path>,"declared_inputs"?:[...]},"implementation"?:<implementation output input without input_fingerprint>}';

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object; expected ${PAYLOAD_SHAPE}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Composes the complete terminal produce request from durable state plus the caller's intent:
 * it derives the phase, revision, and canonical document defaults, builds the artifact through
 * the same builders the standalone commands use, and resolves the whole request through the
 * call envelope. The result is exactly an envelope output — `request.input` is the finished
 * tool call, with no digest for the caller to transcribe.
 */
export async function runBuildRequest(
  services: ProductionServices,
  value: PlainJsonValue,
): Promise<ProjectResult<CallEnvelope>> {
  assertPlainJson(value, "build-request input");
  const snapshot = record(structuredClone(value), "build-request input");
  if (services.state === undefined) {
    return fail(createProjectError("STATE_MISSING", {
      phase_instance: services.authority.context.phase_instance,
    }));
  }
  const state = services.state.value;
  const intentId = parsePathSafeId(String(snapshot.intent_id ?? ""));

  // The composer records exactly one thing: the terminal produce result. Any state without
  // that legal move gets the same fail-closed answer the server would give, with the safe
  // next action attached, instead of a request that will bounce.
  if (legalRunStepStatus(state, "produce") !== "succeeded") {
    return fail(createProjectError("TRANSITION_INVALID", {
      phase_instance: state.phase_instance,
      from: `${state.step}-${state.status}`,
      to: "produce-succeeded",
    }));
  }

  const phaseKind = decodePhaseInstance(state.phase_instance).kind;
  if (snapshot.document !== undefined && snapshot.implementation !== undefined) {
    throw new TypeError(`build-request accepts document facts or implementation facts, never both; expected ${PAYLOAD_SHAPE}`);
  }

  let artifact: PlainJsonValue;
  if (phaseKind === "phase-impl") {
    if (snapshot.document !== undefined) {
      throw new TypeError("phase-impl produces an implementation output; supply implementation facts, not document facts");
    }
    const implementation = record(
      snapshot.implementation,
      "build-request implementation facts (required for phase-impl)",
    );
    const built = await buildImplementationOutput(
      services.dependencies,
      services.authority,
      services.state,
      {
        ...implementation,
        phase_instance: state.phase_instance,
        step: "produce",
        parent_documents: implementation.parent_documents ??
          phaseImplParentDocumentDefaults(state.phase_instance),
        declared_inputs: implementation.declared_inputs ?? [],
        input_fingerprint: state.input_fingerprint,
      } as unknown as ImplementationOutputInput,
    );
    if (!built.ok) return built;
    artifact = built.value as unknown as PlainJsonValue;
  } else {
    if (snapshot.implementation !== undefined) {
      throw new TypeError(`${phaseKind} produces a document; supply document facts, not implementation facts`);
    }
    const defaults = phaseDocumentDefaults(services.authority.task_id, state.phase_instance);
    if (defaults === undefined) throw new TypeError(`${phaseKind} has no canonical document defaults`);
    const document = snapshot.document === undefined
      ? {}
      : record(snapshot.document, "build-request document facts");
    const built = await buildDocumentArtifact(services.runner, services.authority, {
      phase_instance: state.phase_instance,
      step: "produce",
      document_path: document.document_path ?? defaults.document_path,
      declared_inputs: document.declared_inputs ?? defaults.declared_inputs,
      input_fingerprint: state.input_fingerprint,
    } as unknown as DocumentArtifactInput);
    if (!built.ok) return built;
    artifact = built.value as unknown as PlainJsonValue;
  }

  return computeCallEnvelope(services, {
    tool: "archflow_state",
    input: {
      schema_version: "1",
      task_id: services.authority.task_id,
      intent_id: intentId,
      expected_revision: state.revision,
      input_fingerprint: state.input_fingerprint,
      phase_instance: state.phase_instance,
      step: "produce",
      status: "succeeded",
      artifact,
    },
  });
}
