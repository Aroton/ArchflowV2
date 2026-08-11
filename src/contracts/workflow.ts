import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";
import { GATE_POLICIES, ITERATION_POLICIES, PHASE_IDS, PIPELINE_STEPS } from "./vocabulary.js";

export { GATE_POLICIES, ITERATION_POLICIES, PHASE_IDS, PIPELINE_STEPS } from "./vocabulary.js";
export type { GatePolicy, IterationPolicy, PhaseId, PipelineStep } from "./vocabulary.js";

const phaseSchema = z.object({
  id: z.enum(PHASE_IDS),
  skill: z.string().min(1),
  requires: z.array(z.enum(PHASE_IDS)).min(1).optional(),
  iterates: z.enum(ITERATION_POLICIES).optional(),
  pipeline: z.array(z.enum(PIPELINE_STEPS)).min(1),
  gate: z.enum(GATE_POLICIES),
  optional: z.boolean().optional(),
}).strict();

export const workflowV1Schema = z.object({ phases: z.array(phaseSchema) }).strict().superRefine((workflow, context) => {
  if (!sameJson(workflow, WORKFLOW_V1)) context.addIssue({ code: "custom", message: "Workflow must match the fixed ArchFlow v1 graph exactly" });
});

export type WorkflowV1 = z.infer<typeof workflowV1Schema>;

export const WORKFLOW_V1: WorkflowV1 = {
  phases: [
    { id: "explore", skill: "archflow-explore", pipeline: ["produce"], gate: "never", optional: true },
    { id: "prd", skill: "archflow-prd", pipeline: ["produce", "counter_review", "triage", "adjudicate"], gate: "always" },
    { id: "design", skill: "archflow-design", requires: ["prd"], pipeline: ["produce", "counter_review", "triage", "adjudicate"], gate: "always" },
    { id: "phase-design", skill: "archflow-phase-design", requires: ["design"], iterates: "per_phase", pipeline: ["produce", "counter_review", "triage", "adjudicate"], gate: "on_trigger" },
    { id: "phase-impl", skill: "archflow-phase-impl", requires: ["phase-design"], iterates: "per_phase", pipeline: ["produce", "counter_review", "triage", "adjudicate"], gate: "on_trigger" },
  ],
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseWorkflowV1(value: unknown): WorkflowV1 {
  assertPlainJson(value, "workflow");
  return workflowV1Schema.parse(value);
}

export function parseWorkflowYaml(source: string, label = "workflow.yaml"): WorkflowV1 {
  return parseWorkflowV1(parseSingleYamlDocument(source, label));
}
