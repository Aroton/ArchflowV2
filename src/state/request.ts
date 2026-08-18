import { canonicalJsonDigest } from "../contracts/canonical.js";
import { computeRequestDigest, type RequestDigestSubject, type StateArtifactOperation } from "../contracts/fingerprints.js";
import {
  bindParsedToolCallRequest,
  type ParsedToolCall,
  type RequestIdentifiedToolCall,
} from "../contracts/mcp-tools.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { ToolName } from "../contracts/tool-names.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";

function subjectFor(call: ParsedToolCall, authority: TransactionAuthority, inputFingerprint: Sha256Digest): RequestDigestSubject {
  const common = {
    schema_version: "1" as const,
    repository_identity_digest: authority.repository_identity_digest,
    task_identity_digest: authority.task_identity_digest,
    input_fingerprint: inputFingerprint,
  };
  switch (call.name) {
    case "archflow_state":
      if (call.input.artifact === undefined) {
        if (call.input.planning_restart !== undefined) {
          return {
            ...common,
            tool: call.name,
            operation: "restart-planning",
            operation_fields: {
              phase_instance: call.input.phase_instance,
              step: call.input.step,
              status: call.input.status,
              planning_restart: call.input.planning_restart,
            },
          };
        }
        return { ...common, tool: call.name, operation: "record-state-boundary", operation_fields: { phase_instance: call.input.phase_instance, step: call.input.step, status: call.input.status } };
      }
      return {
        ...common,
        tool: call.name,
        operation: ({
          "task-initialization": "adopt-task-initialization",
          "legacy-import-initialization": "adopt-legacy-import-initialization",
          document: "record-document-artifact",
          "implementation-output": "record-implementation-output",
          triage: "record-triage",
        } satisfies Readonly<Record<typeof call.input.artifact.artifact_kind, StateArtifactOperation>>)[call.input.artifact.artifact_kind],
        operation_fields: {
          phase_instance: call.input.phase_instance,
          step: call.input.step,
          status: call.input.status,
          artifact_kind: call.input.artifact.artifact_kind,
          artifact_digest: canonicalJsonDigest(call.input.artifact),
          ...(call.input.human_revision === undefined ? {} : { human_revision: call.input.human_revision }),
        },
      };
    case "archflow_counter_review":
      // Every operation-specific field must be projected here or it never reaches the digest: the
      // selector's key list is checked against the tool input at compile time, but nothing checks
      // this builder, and an omitted optional field fails silently. The key stays absent rather
      // than present-and-undefined because `materialize` rejects an undefined member outright.
      return { ...common, tool: call.name, operation: "counter-review", operation_fields: {
        artifact_path: call.input.artifact_path,
        ...(call.input.route_override === undefined ? {} : { route_override: call.input.route_override }),
      } };
    case "archflow_gate": {
      const operation_fields: Extract<RequestDigestSubject, { readonly tool: "archflow_gate" }>["operation_fields"] = {
        phase_instance: call.input.phase_instance,
        summary: call.input.summary,
        subject_digest: call.input.subject_digest,
        current_evidence: call.input.current_evidence,
        kind: call.input.kind,
        context: call.input.context,
        preview_digest: call.input.preview_digest,
        decision: call.input.decision,
      };
      return { ...common, tool: call.name, operation: "gate", operation_fields };
    }
    case "archflow_waiver":
      return { ...common, tool: call.name, operation: "waiver", operation_fields: {
        origin: call.input.origin,
        rationale: call.input.rationale,
        preview_digest: call.input.preview_digest,
        decision: call.input.decision,
      } };
    default: {
      const exhaustive: never = call;
      throw new TypeError(`unknown tool ${String((exhaustive as { name?: unknown }).name)}`);
    }
  }
}

export function identifyTransactionRequest<K extends ToolName>(
  call: Extract<ParsedToolCall, { readonly name: K }>,
  authority: TransactionAuthority,
  recomputedInputFingerprint: Sha256Digest,
): Readonly<{
  call: Extract<RequestIdentifiedToolCall, { readonly name: K }>;
  request_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
}> {
  assertInternalTransactionAuthority(authority);
  if (call.input.task_id !== authority.task_id) throw new TypeError("request task_id must match transaction authority");
  const requestDigest = computeRequestDigest(subjectFor(call, authority, recomputedInputFingerprint));
  return Object.freeze({
    call: bindParsedToolCallRequest(call, requestDigest),
    request_digest: requestDigest,
    input_fingerprint: recomputedInputFingerprint,
  });
}
