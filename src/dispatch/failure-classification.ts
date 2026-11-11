import { DISPATCH_FAILURE_CODES, type DispatchFailureCodeV1 } from "../contracts/dispatch-failure.js";
import { parseProjectError, type ProjectError } from "../contracts/errors.js";

const supportedCodes = new Set<string>(DISPATCH_FAILURE_CODES);

const SAFE_MESSAGES: Readonly<Record<DispatchFailureCodeV1, string>> = Object.freeze({
  CONFIG_INVALID: "The selected reviewer route configuration is invalid.",
  CONFIG_MODEL_UNSUPPORTED: "The selected reviewer model is not supported by the dispatcher.",
  CLI_MISSING: "The required reviewer CLI is not installed or is not available on PATH.",
  AUTH_UNAVAILABLE: "The required reviewer authentication is unavailable.",
  TIMEOUT: "The reviewer timed out before producing a usable result.",
  RATE_LIMITED: "The reviewer service rate limit prevented this dispatch.",
  UNSUPPORTED_MODEL: "The reviewer service does not support the selected model.",
  CLI_VERSION_UNSUPPORTED: "The installed reviewer CLI version is not supported.",
  MODEL_OUTPUT_INVALID: "The reviewer returned unusable structured output. Inspect the output validation failure before retrying.",
  PROCESS_FAILED: "The reviewer process failed before producing a usable result.",
  REPOSITORY_VIEW_UNAVAILABLE: "A required read-only repository snapshot is unavailable. Repair repository access and resume the unchanged review.",
});

// Only server-defined issue codes select these messages. Never copy exception text, unknown
// issue codes, or model output into a reported failure.
const OUTPUT_FAILURE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["antigravity-wrapper-invalid", "The Antigravity CLI response did not contain a valid final result wrapper."],
  ["structured-output-missing", "The reviewer CLI response was missing structured_output."],
  ["structured-output-invalid", "The reviewer CLI structured_output was not a valid plain JSON value."],
]);

function carriedProjectError(error: unknown): ProjectError | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "project_error");
  if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
  try {
    return parseProjectError(descriptor.value);
  } catch {
    return undefined;
  }
}

/** A dispatch failure's public code and safe message, or `undefined` for an unclassified error. */
export function classifiedDispatchFailure(error: unknown): Readonly<{
  code: DispatchFailureCodeV1;
  message: string;
  repository_name?: string;
}> | undefined {
  const projectError = carriedProjectError(error);
  if (projectError === undefined || !supportedCodes.has(projectError.code)) return undefined;
  const code = projectError.code as DispatchFailureCodeV1;
  if (projectError.code === "PROCESS_FAILED" && projectError.diagnostic.parameters.exit_class === "transient-transport") {
    return { code, message: "The reviewer service was temporarily unavailable or its connection was interrupted." };
  }
  if (projectError.code === "RATE_LIMITED" && projectError.diagnostic.parameters.reason === "session-limit") {
    return { code, message: "The reviewer service session limit was reached. Wait for the session allowance to reset or explicitly choose another reviewer route." };
  }
  if (projectError.code === "TIMEOUT" && projectError.diagnostic.parameters.origin === "cli") {
    return { code, message: `The Antigravity CLI print timeout expired after ${String(projectError.diagnostic.parameters.limit_ms / 1000)} seconds and returned partial output. No completed review was accepted.` };
  }
  const repositoryName = code === "REPOSITORY_VIEW_UNAVAILABLE"
    ? (projectError.diagnostic.parameters as Readonly<Record<string, unknown>>).repository_name
    : undefined;
  const astraMax = code === "CONFIG_INVALID" &&
    (projectError.diagnostic.parameters as Readonly<Record<string, unknown>>).issue_code === "astra-max-disallowed";
  const issueCode = (projectError.diagnostic.parameters as Readonly<Record<string, unknown>>).issue_code;
  const outputMessage = code === "MODEL_OUTPUT_INVALID" && typeof issueCode === "string"
    ? OUTPUT_FAILURE_MESSAGES.get(issueCode)
    : undefined;
  return Object.freeze({ code, message: astraMax
    ? "GPT-6 Astra max effort is disabled. Choose low or high effort."
    : outputMessage ?? SAFE_MESSAGES[code], ...(typeof repositoryName === "string" ? { repository_name: repositoryName } : {}) });
}

/** Retry only positively classified transient failures. Generic process, IO, schema, auth,
 * cancellation and integrity errors are deliberately not inferred to be temporary.
 */
export function isTransientDispatchFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "project_error");
  if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
  try {
    const parsed = parseProjectError(descriptor.value);
    return parsed.code === "RATE_LIMITED" || parsed.code === "TIMEOUT" || parsed.code === "REPOSITORY_VIEW_UNAVAILABLE" ||
      (parsed.code === "PROCESS_FAILED" && parsed.diagnostic.parameters.exit_class === "transient-transport");
  } catch { return false; }
}
