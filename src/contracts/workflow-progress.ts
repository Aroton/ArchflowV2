import { z } from "zod";
import { dispatchRecoveryProgressV1Schema, type DispatchRecoveryProgressV1 } from "./dispatch-failure.js";

/** Read-only explanation of activity and responsibility; never a mutation or approval token. */
export type WorkflowProgressV1 = {
  readonly step: "produce" | "counter_review" | "triage" | "adjudicate";
  readonly step_status: "running" | "succeeded" | "failed";
  readonly review_rounds_completed: number;
  readonly review_round_limit: number;
  readonly boundary: "none" | "configured-approval" | "exception" | "step-transition" | "complete" | "abandoned";
  readonly reason: string;
  readonly dispatch_recovery?: DispatchRecoveryProgressV1;
};
export const workflowProgressV1Schema = z.object({
  step: z.enum(["produce", "counter_review", "triage", "adjudicate"]),
  step_status: z.enum(["running", "succeeded", "failed"]),
  review_rounds_completed: z.number().int().nonnegative().safe(),
  review_round_limit: z.number().int().positive().safe(),
  boundary: z.enum(["none", "configured-approval", "exception", "step-transition", "complete", "abandoned"]),
  reason: z.string().min(1),
  dispatch_recovery: dispatchRecoveryProgressV1Schema.optional(),
}).strict() as z.ZodType<WorkflowProgressV1>;
