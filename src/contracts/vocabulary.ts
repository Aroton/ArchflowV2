export const PHASE_IDS = ["explore", "prd", "design", "phase-design", "phase-impl"] as const;
// "adjudicate" is an evidence-slot key only, not a reachable state-machine position: the
// constitution review runs inside archflow_counter_review and its evidence is retained under
// this step name, but no workflow pipeline contains it and no transition may target it.
export const PIPELINE_STEPS = ["produce", "counter_review", "triage", "adjudicate"] as const;
export const GATE_POLICIES = ["never", "always", "on_trigger"] as const;
export const ITERATION_POLICIES = ["per_phase"] as const;

export type PhaseId = (typeof PHASE_IDS)[number];
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type GatePolicy = (typeof GATE_POLICIES)[number];
export type IterationPolicy = (typeof ITERATION_POLICIES)[number];
