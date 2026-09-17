import type { ProjectError } from "../contracts/errors.js";
import type { SemanticErrorSummaryV1, WorkflowRecoveryV1, WorkflowViewV1 } from "../contracts/semantic-workflow.js";

type Failure = ProjectError | { readonly code: string; readonly message: string };

/** Public recovery is a supported next step, not a dump of internal diagnostic bindings. */
export function workflowFailure(error: Failure, view?: WorkflowViewV1): SemanticErrorSummaryV1 {
  const code = error.code;
  const parameters = "diagnostic" in error ? error.diagnostic.parameters : undefined;
  const issues = parameters !== undefined && "issues" in parameters ? parameters.issues : undefined;
  const issue = parameters !== undefined && "issue_code" in parameters ? parameters.issue_code : undefined;
  let message = "message" in error ? error.message : (Array.isArray(issues) ? issues.join("; ") : undefined) ??
    `${code.replaceAll("_", " ").toLowerCase()}${issue === undefined ? "" : `: ${issue}`}.`;
  if (!("message" in error) && !Array.isArray(issues) && parameters !== undefined) {
    if ("model" in parameters) message += ` Model: ${parameters.model}.`;
    if ("adapter" in parameters) message += ` Reviewer CLI: ${parameters.adapter}.`;
    if ("repository_name" in parameters) message += ` Repository: ${parameters.repository_name}.`;
    if ("from" in parameters && "to" in parameters) message += ` Requested transition: ${parameters.from} to ${parameters.to}.`;
  }
  let recovery: WorkflowRecoveryV1;
  switch (code) {
    case "CONTRACT_INVALID":
    case "SEMANTIC_SUBMISSION_MISMATCH":
      recovery = { kind: "correct-input", instruction: "Correct the named submission fields and resubmit through the current offer. Omit submission when expected_submission is none." };
      break;
    case "SEMANTIC_OFFER_STALE":
    case "STATE_CONFLICT":
    case "INPUT_FINGERPRINT_MISMATCH":
    case "INTENT_NOT_CURRENT":
    case "TRANSITION_INVALID":
    case "GATE_ACTIVE":
    case "GATE_CANCELLED":
      recovery = { kind: "refresh-status", instruction: "Call archflow_status with the same task and invocation, then follow its current action. Do not reuse the rejected offer." };
      break;
    case "IO_ERROR":
    case "CANCELLED":
    case "TIMEOUT":
    case "MODEL_OUTPUT_INVALID":
      recovery = { kind: "retry", instruction: "Retry the identical call, preserving its offer, invocation, and submission so the server can resume any recorded substeps." };
      break;
    case "RATE_LIMITED":
      recovery = { kind: "wait", instruction: "Wait for the provider limit to clear, then retry the identical call. Preserve the invocation, offer, and submission." };
      break;
    case "CONFIG_INVALID":
      recovery = { kind: "repair", instruction: "Repair the named task config field or configured repository, then call archflow_status with the same invocation. Do not change recorded repository identity to bypass a mismatch." };
      break;
    case "CONFIG_MODEL_UNSUPPORTED":
    case "UNSUPPORTED_MODEL":
    case "CLI_MISSING":
    case "CLI_VERSION_UNSUPPORTED":
    case "AUTH_UNAVAILABLE":
    case "REPOSITORY_VIEW_UNAVAILABLE":
      recovery = { kind: "repair", instruction: "Repair the reported reviewer route, CLI/authentication, or repository access, then read archflow_status. Follow any returned human recovery boundary before retrying review." };
      break;
    case "SNAPSHOT_LIMIT":
    case "ENVELOPE_OVERFLOW":
      if (parameters !== undefined && "offending_paths" in parameters) message = `${code === "SNAPSHOT_LIMIT" ? "Retained work" : "Review input"} exceeds its byte limit (${parameters.current_bytes}/${parameters.byte_cap}): ${parameters.offending_paths.join(", ")}.`;
      recovery = { kind: "repair", instruction: "Reduce the named oversized inputs or optional verification transcript. Changed code or verification claims require the normal revision and submission path; then follow fresh status." };
      break;
    case "GATE_DECISION_INVALID":
      recovery = { kind: "human", instruction: "Read fresh status and present its authenticated choices. Submit only the explicit human choice; do not replace a decision already recorded." };
      break;
    case "UNSUPPORTED_HOST":
      recovery = { kind: "repair", instruction: "Reconnect through a supported Claude, Codex, or Antigravity MCP host. A generic read-only status call may omit invocation; producing actions require an authenticated host." };
      break;
    case "REPOSITORY_NOT_FOUND":
    case "REPOSITORY_MISMATCH":
      recovery = { kind: "repair", instruction: "Reconnect the server in the task's original repository/worktree, then request status for the same task." };
      break;
    case "SECRET_DETECTED":
      recovery = { kind: "repair", instruction: "Remove the detected secret from the declared work and verification inputs, then resubmit through the current work offer. Do not include the secret in messages." };
      break;
    default:
      recovery = { kind: "operator", instruction: "Request archflow_status with detail: diagnostic for this task. If it cannot authenticate a recovery action, report this error for operator repair; do not edit state, receipts, or approval archives." };
  }
  if (view?.condition === "awaiting-human") {
    recovery = { kind: "human", instruction: view.next_action.instruction };
  } else if (view?.condition === "blocked" && recovery.kind !== "correct-input") {
    recovery = { kind: "operator", instruction: view.next_action.instruction };
  }
  return Object.freeze({ code, message: message.slice(0, 4096), retryable: recovery.kind === "retry" || recovery.kind === "wait", recovery });
}
