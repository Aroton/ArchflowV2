/** Synthetic fixtures matching agy 1.2.3's observed stream; no production review content. */
export const capacityError = "API error (attempt 2): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server";
export const judgmentSlots = Array.from({ length: 10 }, (_, index) => ({
  slot: `slot-${index + 1}`, rule_id: `rule-${String(index + 1).padStart(2, "0")}`, rule_version: 1,
}));
export const syntheticJudgments = () => ({
  schema_version: "2",
  judgments: Object.fromEntries(judgmentSlots.map(({ slot }) => [slot, {
    compliance: "pass", rationale: "Synthetic evidence.", trigger: "not-matched", trigger_evidence: "No trigger.",
  }])),
});

export type NativeEvent = {
  event: string;
  step_update?: { conversation_id: string; step_index: number; state: string; step_type: string };
  result?: Record<string, unknown>;
};

export function recoveredCapacityEvents(): NativeEvent[] {
  const conversationId = "synthetic-conversation";
  return [
    ...["user_input", "error_message", "agent_response", "finish"].map((step_type, step_index) => ({
      event: "step_update", step_update: { conversation_id: conversationId, step_index, state: "DONE", step_type },
    })),
    { event: "result", result: {
      conversation_id: conversationId, status: "ERROR", error: capacityError, num_turns: 1,
      structured_output: syntheticJudgments(), json_schema: { description: "schema metadata ".repeat(600) },
    } },
  ];
}

export const nativeStream = (events: NativeEvent[]): Buffer =>
  Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");
