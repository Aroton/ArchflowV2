import { z } from "zod";

const count = z.number().int().nonnegative().safe().optional();
/** CLI-reported measurements, not billing authority or workflow approval. Missing is unknown. */
export const dispatchUsageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
  thinking_tokens: count,
  num_turns: count,
  duration_ms: count,
  duration_api_ms: count,
  total_cost_usd: z.number().finite().nonnegative().optional(),
}).strict();

export type DispatchUsage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly thinking_tokens?: number;
  readonly num_turns?: number;
  readonly duration_ms?: number;
  readonly duration_api_ms?: number;
  readonly total_cost_usd?: number;
};
