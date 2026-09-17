/**
 * Claude verbose stream-json observation: event grammar, tool-use deduplication and
 * signature accounting, and per-field terminal usage normalization.
 */

import { canonicalJsonBytes, sha256Bytes } from "../../../src/contracts/canonical.js";
import type { Sha256Digest } from "../../../src/contracts/evidence.js";
import { assertPlainJson, type PlainJsonValue } from "../../../src/contracts/plain-json.js";

// ---------------------------------------------------------------------------
// Claude stream parsing, tool activity, and usage
// ---------------------------------------------------------------------------

export const OBSERVED_TOOLS = ["Read", "Grep", "Glob"] as const;
export type ObservedTool = (typeof OBSERVED_TOOLS)[number];

/**
 * The CLI's own emission mechanism in stream-json mode: with a pinned output schema the model
 * produces its final answer by "calling" this synthetic tool. It is mechanism bookkeeping,
 * recorded separately from repository investigation and never counted as tool activity.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

export type StreamToolCall = Readonly<{
  tool_use_id: string;
  name: ObservedTool | typeof STRUCTURED_OUTPUT_TOOL;
  input: PlainJsonValue;
  signature: Sha256Digest;
  repeated: boolean;
  result_error?: boolean;
}>;

export type ParsedClaudeStream = Readonly<{
  terminal: Readonly<Record<string, PlainJsonValue>>;
  /** Repository investigation activity only; the structured-output mechanism is separate. */
  toolCalls: readonly StreamToolCall[];
  structuredOutputCalls: readonly StreamToolCall[];
  /**
   * The model the stream reports as serving the turn. Unlike the `--output-format json`
   * wrapper, the stream-json terminal carries no top-level `model`; it is reported by the
   * init event and by each assistant message (the synthetic error voice reports
   * `<synthetic>` and is skipped).
   */
  model: string | undefined;
}>;

/**
 * Parses one verbose stream-json child channel. Every nonblank line must be a plain JSON event;
 * malformed or truncated JSON, a terminal count other than one `type:"result"` event, or any
 * event after the terminal result invalidates the attempt. Assistant tool-use blocks are
 * deduplicated by tool-use id (identical replay counts once; reuse with different bytes is
 * invalid); investigation blocks are restricted to the read-only tool set and the CLI's own
 * `StructuredOutput` emission, and all blocks are carried with their result-error status.
 */
export function parseClaudeStream(stdout: Uint8Array): ParsedClaudeStream {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new TypeError("stream stdout is not valid UTF-8");
  }
  const terminals: Readonly<Record<string, PlainJsonValue>>[] = [];
  let initModel: string | undefined;
  let lastAssistantModel: string | undefined;
  let terminalSeen = false;
  const byId = new Map<string, Readonly<{ canonical: string; name: ObservedTool | typeof STRUCTURED_OUTPUT_TOOL; input: PlainJsonValue; signature: Sha256Digest }>>();
  const ordered: { tool_use_id: string; name: ObservedTool | typeof STRUCTURED_OUTPUT_TOOL; input: PlainJsonValue; signature: Sha256Digest }[] = [];
  const resultErrors = new Map<string, boolean>();
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    if (terminalSeen) throw new TypeError("stream events follow the terminal result event");
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new TypeError("stream line is malformed or truncated JSON");
    }
    assertPlainJson(event, "stream event");
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("stream event must be an object");
    }
    const record = event as Readonly<Record<string, PlainJsonValue>>;
    if (record.type === "assistant") {
      collectToolUse(record, byId, ordered);
      const message = record.message;
      if (message !== null && typeof message === "object" && !Array.isArray(message)) {
        const model = (message as Readonly<Record<string, PlainJsonValue>>).model;
        if (typeof model === "string" && model !== "" && model !== "<synthetic>") {
          lastAssistantModel = model;
        }
      }
    } else if (record.type === "system") {
      const model = record.model;
      if (typeof model === "string" && model !== "") initModel = model;
    } else if (record.type === "user") {
      collectToolResults(record, resultErrors);
    } else if (record.type === "result") {
      terminalSeen = true;
      terminals.push(record);
    }
  }
  if (!terminalSeen || terminals.length !== 1) {
    throw new TypeError("stream must contain exactly one terminal result event");
  }
  const seenSignatures = new Set<string>();
  const finalize = (call: { tool_use_id: string; name: ObservedTool | typeof STRUCTURED_OUTPUT_TOOL; input: PlainJsonValue; signature: Sha256Digest }): StreamToolCall => {
    const repeated = seenSignatures.has(call.signature);
    seenSignatures.add(call.signature);
    const result_error = resultErrors.get(call.tool_use_id);
    return Object.freeze({
      tool_use_id: call.tool_use_id,
      name: call.name,
      input: call.input,
      signature: call.signature,
      repeated,
      ...(result_error === undefined ? {} : { result_error }),
    });
  };
  const toolCalls = ordered.filter((call) => call.name !== STRUCTURED_OUTPUT_TOOL).map(finalize);
  const structuredOutputCalls = ordered.filter((call) => call.name === STRUCTURED_OUTPUT_TOOL).map(finalize);
  return Object.freeze({
    terminal: terminals[0]!,
    toolCalls: Object.freeze(toolCalls),
    structuredOutputCalls: Object.freeze(structuredOutputCalls),
    model: lastAssistantModel ?? initModel,
  });
}

function contentBlocks(event: Readonly<Record<string, PlainJsonValue>>): readonly PlainJsonValue[] {
  const message = event.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return [];
  const content = (message as Readonly<Record<string, PlainJsonValue>>).content;
  return Array.isArray(content) ? content : [];
}

function collectToolUse(
  event: Readonly<Record<string, PlainJsonValue>>,
  byId: Map<string, Readonly<{ canonical: string; name: ObservedTool | typeof STRUCTURED_OUTPUT_TOOL; input: PlainJsonValue; signature: Sha256Digest }>>,
  ordered: { tool_use_id: string; name: ObservedTool | typeof STRUCTURED_OUTPUT_TOOL; input: PlainJsonValue; signature: Sha256Digest }[],
): void {
  for (const block of contentBlocks(event)) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Readonly<Record<string, PlainJsonValue>>;
    if (record.type !== "tool_use") continue;
    const { id, input } = record;
    if (typeof id !== "string" || id === "") throw new TypeError("tool_use block carries no tool-use id");
    if (input === undefined) throw new TypeError("tool_use block carries no input");
    const name = record.name;
    if (name !== "Read" && name !== "Grep" && name !== "Glob" && name !== STRUCTURED_OUTPUT_TOOL) {
      throw new TypeError(`unknown tool ${JSON.stringify(name)} in a read-only child stream`);
    }
    const toolName = name as ObservedTool | typeof STRUCTURED_OUTPUT_TOOL;
    const canonical = new TextDecoder().decode(canonicalJsonBytes({ name: toolName, input }));
    const existing = byId.get(id);
    if (existing !== undefined) {
      // An identical replay of one id is counted once; reuse with different bytes is invalid.
      if (existing.canonical !== canonical) {
        throw new TypeError(`tool-use id ${id} was reused with different bytes`);
      }
      continue;
    }
    const signature = sha256Bytes(new TextEncoder().encode(canonical));
    const entry = Object.freeze({ canonical, name: toolName, input, signature });
    byId.set(id, entry);
    ordered.push({ tool_use_id: id, name: toolName, input, signature });
  }
}

function collectToolResults(
  event: Readonly<Record<string, PlainJsonValue>>,
  resultErrors: Map<string, boolean>,
): void {
  for (const block of contentBlocks(event)) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Readonly<Record<string, PlainJsonValue>>;
    if (record.type !== "tool_result" || typeof record.tool_use_id !== "string") continue;
    resultErrors.set(record.tool_use_id, record.is_error === true);
  }
}

export type UsageFields = Readonly<{
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}>;

const USAGE_FIELD_NAMES = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * Normalized per-field terminal usage. The terminal result's raw usage object is preserved
 * verbatim for the observation; an absent or non-conforming field is unavailable, never zero.
 * Intermediate usage events are never read: the terminal usage is already cumulative.
 */
export function usageFromTerminal(terminal: Readonly<Record<string, PlainJsonValue>>): Readonly<{
  usage: UsageFields;
  usage_raw: PlainJsonValue | undefined;
}> {
  const raw = terminal.usage;
  const usage: Record<string, number> = {};
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Readonly<Record<string, PlainJsonValue>>;
    for (const field of USAGE_FIELD_NAMES) {
      const value = record[field];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        usage[field] = value;
      }
    }
  }
  return Object.freeze({ usage: Object.freeze(usage), usage_raw: raw });
}

/**
 * Aggregates each field independently and only when every contributing attempt exposes it; one
 * unavailable contributor makes the aggregate unavailable rather than silently partial.
 */
export function aggregateUsage(fields: readonly UsageFields[]): UsageFields {
  const aggregated: Record<string, number> = {};
  for (const field of USAGE_FIELD_NAMES) {
    let total = 0;
    let complete = fields.length > 0;
    for (const entry of fields) {
      const value = entry[field];
      if (value === undefined) {
        complete = false;
        break;
      }
      total += value;
    }
    if (complete) aggregated[field] = total;
  }
  return Object.freeze(aggregated);
}

export function repeatedSignatureCount(toolCalls: readonly StreamToolCall[]): number {
  return toolCalls.filter((call) => call.repeated).length;
}
