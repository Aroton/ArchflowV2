import { describe, expect, it } from "vitest";
import { parseRawAdjudicationV2 } from "../../src/contracts/adjudication.js";
import { antigravityOutputDiagnostics, readAntigravityOutput } from "../../src/dispatch/antigravity-output.js";
import { CliAdapterError, selectCliAdapter } from "../../src/dispatch/cli.js";
import { classifiedDispatchFailure } from "../../src/dispatch/failure-observation.js";
import type { DispatchChildResult } from "../../src/dispatch/process.js";
import { capacityError, judgmentSlots, nativeStream, recoveredCapacityEvents, syntheticJudgments, type NativeEvent } from "../helpers/antigravity-output.js";

const adapter = selectCliAdapter("claude", {
  adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high",
});
const child = (events = recoveredCapacityEvents()): DispatchChildResult => ({
  exit_code: 0, signal: null, stdout: nativeStream(events), stderr: Buffer.alloc(0),
});

describe("Antigravity completed output after capacity errors", () => {
  it("recovers only terminal structured bytes and preserves strict judgment validation", () => {
    const result = child();
    expect(adapter.classifyFailure(result)).toBeUndefined();
    const output: unknown = JSON.parse(Buffer.from(adapter.parseOutput(result)).toString("utf8"));
    expect(parseRawAdjudicationV2(output, judgmentSlots)).toEqual(syntheticJudgments());
    expect(readAntigravityOutput(result.stdout)).toMatchObject({
      recovered_capacity_error: true, last_error_step_index: 1, completed_finish_step_index: 3,
    });
  });

  const failures: [string, (events: NativeEvent[]) => void][] = [
    ["missing finish", events => { events.splice(3, 1); }],
    ["unfinished finish", events => { events[3]!.step_update!.state = "ACTIVE"; }],
    ["error after finish", events => { events.splice(4, 0, { event: "step_update", step_update: {
      conversation_id: "synthetic-conversation", step_index: 4, state: "DONE", step_type: "error_message",
    } }); }],
    ["unknown terminal error", events => { events[4]!.result!.error = "Unexpected internal failure"; }],
    ["cancelled terminal status", events => { events[4]!.result!.status = "CANCELLED"; }],
    ["in-progress terminal status", events => { events[4]!.result!.status = "RUNNING"; }],
    ["missing terminal error", events => { delete events[4]!.result!.error; }],
    ["missing structured output", events => { delete events[4]!.result!.structured_output; }],
    ["null structured output", events => { events[4]!.result!.structured_output = null; }],
    ["unrelated conversation", events => { events[3]!.step_update!.conversation_id = "another-conversation"; }],
    ["multiple turns", events => { events[4]!.result!.num_turns = 2; }],
    ["missing error history", events => { events.splice(1, 1); }],
    ["fatal stream event", events => { events.splice(2, 0, { event: "error" }); }],
    ["event after terminal result", events => { events.push({ ...events[0]! }); }],
  ];
  it.each(failures)("rejects %s despite a completed-looking payload", (_label, change) => {
    const events = recoveredCapacityEvents();
    change(events);
    const result = child(events);
    expect(adapter.classifyFailure(result)).toBeDefined();
    expect(() => adapter.parseOutput(result)).toThrow();
  });

  it.each([
    { exit_code: 1 },
    { exit_code: null, signal: "SIGTERM" as const },
    { stderr: Buffer.from("[agy] print timeout after 15m0s with turn in progress; returning partial output\n") },
  ])("rejects process failures and CLI timeouts: %j", override => {
    const result = { ...child(), ...override };
    expect(adapter.classifyFailure(result)).toBeDefined();
    expect(() => adapter.parseOutput(result)).toThrow();
  });

  it("does not infer recovery from bare wrappers or damaged streams", () => {
    const events = recoveredCapacityEvents();
    for (const stdout of [Buffer.from(JSON.stringify(events[4]!.result)), Buffer.concat([Buffer.from("broken\n"), nativeStream(events)])]) {
      expect(adapter.classifyFailure({ ...child(), stdout })).toBeDefined();
    }
  });

  it("leaves invalid or incomplete judgments for the normative validator to reject", () => {
    const events = recoveredCapacityEvents();
    const invalid = syntheticJudgments();
    delete invalid.judgments["slot-10"];
    events[4]!.result!.structured_output = invalid;
    const extracted = JSON.parse(Buffer.from(adapter.parseOutput(child(events))).toString("utf8")) as unknown;
    expect(() => parseRawAdjudicationV2(extracted, judgmentSlots)).toThrow();
  });

  it("classifies unrecovered native capacity errors for the existing retry policy", () => {
    const events = recoveredCapacityEvents();
    events.splice(2, 2);
    const failure = adapter.classifyFailure(child(events));
    expect(failure).toMatchObject({
      code: "PROCESS_FAILED", diagnostic: { parameters: { exit_class: "transient-transport" } },
    });
    expect(classifiedDispatchFailure(new CliAdapterError(failure!))).toEqual({
      code: "PROCESS_FAILED", message: "The reviewer service was temporarily unavailable or its connection was interrupted.",
    });
  });

  it("preserves terminal error details when schema metadata fills the stdout tail", () => {
    const result = child();
    expect(result.stdout.subarray(-4096).toString()).not.toContain(capacityError);
    expect(antigravityOutputDiagnostics(result.stdout)).toEqual({
      terminal_status: "ERROR", error_message: capacityError, has_structured_output: true,
      last_error_step_index: 1, completed_finish_step_index: 3,
    });
    const events = recoveredCapacityEvents();
    events[4]!.result!.error = "x".repeat(10_000);
    expect(String(antigravityOutputDiagnostics(nativeStream(events)).error_message)).toHaveLength(4096);
  });
});
