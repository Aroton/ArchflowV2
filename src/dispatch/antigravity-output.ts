import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";

type JsonObject = Readonly<Record<string, PlainJsonValue>>;
const object = (value: PlainJsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Native capacity errors, not arbitrary mentions of a 503 in reviewer prose. */
export const isAntigravityCapacityError = (message: string): boolean =>
  /^(?:API error \(attempt [1-9]\d*\): )?UNAVAILABLE \(code 503\): No capacity available for model gemini-[A-Za-z0-9._-]+ on the server$/u.test(message.trim());

export type AntigravityOutput = Readonly<{
  wrapper?: JsonObject;
  error_message?: string;
  last_error_step_index?: number;
  completed_finish_step_index?: number;
  recovered_capacity_error: boolean;
}>;

/**
 * agy 1.2.3's JSON builder can retain LastStepError after a later successful finish.
 * A terminal wrapper alone cannot prove recovery: require the native DONE finish after
 * the error, in the same single-turn stream. Intermediate response text is never output.
 */
export function readAntigravityOutput(stdout: Uint8Array): AntigravityOutput {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout); }
  catch { return { recovered_capacity_error: false }; }
  let wrapper: JsonObject | undefined;
  let coherent = true;
  let results = 0;
  const steps = new Map<number, JsonObject>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: PlainJsonValue;
    try {
      const parsed: unknown = JSON.parse(line);
      assertPlainJson(parsed, "Antigravity event");
      value = parsed;
    } catch { coherent = false; continue; }
    if (!object(value)) { coherent = false; continue; }
    if (results !== 0) coherent = false;
    if (value.event === undefined) {
      // Preserve the old single-object output format, without stream recovery authority.
      wrapper = value;
      coherent = false;
    } else if (value.event === "result") {
      results++;
      wrapper = object(value.result) ? value.result : undefined;
    } else if (value.event === "error") {
      coherent = false;
    } else if (value.event === "step_update") {
      const step = value.step_update;
      if (!object(step) || typeof step.step_index !== "number" ||
          !Number.isSafeInteger(step.step_index) || step.step_index < 0) {
        coherent = false;
        continue;
      }
      const prior = steps.get(step.step_index);
      if (prior !== undefined && (prior.conversation_id !== step.conversation_id || prior.step_type !== step.step_type)) {
        coherent = false;
      }
      steps.set(step.step_index, step);
    }
  }
  const failed = wrapper?.status === "ERROR" || wrapper?.is_error === true || wrapper?.type === "error";
  const errorMessage = failed
    ? typeof wrapper?.error === "string" ? wrapper.error
      : typeof wrapper?.result === "string" ? wrapper.result : undefined
    : undefined;
  let lastError: number | undefined;
  let finish: number | undefined;
  let lastStep = -1;
  for (const [index, step] of steps) {
    lastStep = Math.max(lastStep, index);
    if (typeof step.conversation_id !== "string" || step.conversation_id === "" ||
        step.conversation_id !== wrapper?.conversation_id || step.state !== "DONE") coherent = false;
    if (step.step_type === "error_message") lastError = Math.max(lastError ?? -1, index);
    if (step.step_type === "finish" && step.state === "DONE") finish = Math.max(finish ?? -1, index);
  }
  return {
    ...(wrapper === undefined ? {} : { wrapper }),
    ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
    ...(lastError === undefined ? {} : { last_error_step_index: lastError }),
    ...(finish === undefined ? {} : { completed_finish_step_index: finish }),
    recovered_capacity_error: coherent && results === 1 && wrapper?.num_turns === 1 &&
      wrapper.status === "ERROR" && errorMessage !== undefined && isAntigravityCapacityError(errorMessage) &&
      object(wrapper.structured_output) && lastError !== undefined && finish !== undefined &&
      finish > lastError && finish === lastStep,
  };
}

/** Bounded private diagnostics; schema metadata cannot displace the actual error. */
export function antigravityOutputDiagnostics(stdout: Uint8Array): JsonObject {
  const output = readAntigravityOutput(stdout);
  const bounded = (value: string): string => Buffer.from(value).subarray(0, 4096).toString("utf8");
  return {
    ...(typeof output.wrapper?.status === "string" ? { terminal_status: bounded(output.wrapper.status) } : {}),
    ...(output.error_message === undefined ? {} : { error_message: bounded(output.error_message) }),
    has_structured_output: output.wrapper?.structured_output !== undefined,
    ...(output.last_error_step_index === undefined ? {} : { last_error_step_index: output.last_error_step_index }),
    ...(output.completed_finish_step_index === undefined ? {} : { completed_finish_step_index: output.completed_finish_step_index }),
  };
}
