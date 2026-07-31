import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CONSTITUTION_RESULTS, DRIFT_RESULTS, type ConstitutionResult, type DriftResult } from "./adjudication.js";
import { manualCheckpointImportV1Schema } from "./durable-checkpoint.js";
import { documentArtifactV1Schema } from "./durable-document.js";
import { implementationOutputV1Schema } from "./durable-implementation-output.js";
import { legacyImportInitializationV1Schema } from "./durable-legacy-import.js";
import type { ReviewEvidenceArtifactV1, TriageArtifactV1 } from "./durable-result-manifest.js";
import { taskInitializationV1Schema } from "./durable-task-initialization.js";
import type { DurableArtifact } from "./durable.js";
import { parseProjectError, type ProjectResult } from "./errors.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type Sha256Digest, type TaskSlug } from "./evidence.js";
import { GATE_KINDS, humanDecisionProvenanceV1Schema, parseGateContext, parseGateDecisionEnvelope, validateGateDecision, type GateContext, type GateDecisionEnvelope, type GateKind, type HumanDecisionProvenance, type RuleVersionRef, type WaiverOriginRef, type WaiverScope } from "./gates.js";
import { assertPlainJson } from "./plain-json.js";
import { decodePhaseInstance, type PhaseInstanceId } from "./phase-instance.js";
import { taskPathClaimV1Schema, type TaskPathClaim } from "./path-claims.js";
import { rubricV1Schema, type RubricV1 } from "./rubric.js";
import { reviewEvidenceSchema } from "./review.js";
import { parseSupplementalReviewOutcome, type GateSupersessionRef, type SupplementalReviewOutcome } from "./supplemental.js";
import { TOOL_NAMES, type ToolName } from "./tool-names.js";
import { parseCurrentEvidenceSetRef, type CurrentEvidenceSetRef } from "./trust.js";
import { triageCandidateSchema } from "./triage.js";

const parsedToolInputBrand: unique symbol = Symbol("ParsedToolInput");
const structuralResultBrand: unique symbol = Symbol("StructurallyValidProjectResult");
export const resultExpectationBrand: unique symbol = Symbol("ResultExpectation");
const parsedCalls = new WeakSet<object>();
const structuralResults = new WeakSet<object>();
const resultExpectations = new WeakSet<object>();
const requestDigests = new WeakMap<object, Sha256Digest>();
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const text = z.string().min(1).max(4096).regex(/\S/u);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const phase = z.string().refine((v) => { try { decodePhaseInstance(v); return true; } catch { return false; } }) as unknown as z.ZodType<PhaseInstanceId>;
const rule = z.object({ rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const scope = z.object({ operation: z.enum(["review-trigger", "adjudication-failure"]), boundary: z.enum(["subject", "phase", "task"]) }).strict();
const provenance = humanDecisionProvenanceV1Schema as z.ZodType<HumanDecisionProvenance>;
const common = { schema_version: z.literal("1"), task_id: taskSlugV1Schema, intent_id: pathSafeIdV1Schema, expected_revision: safeInteger, input_fingerprint: digest } as const;

export type CommonToolInput = { readonly schema_version: "1"; readonly task_id: TaskSlug; readonly intent_id: PathSafeId; readonly expected_revision: number; readonly input_fingerprint: Sha256Digest };
export type StateInput = CommonToolInput & { readonly phase_instance: PhaseInstanceId; readonly step: "produce" | "self_review" | "counter_review" | "triage" | "adjudicate"; readonly status: "running" | "succeeded" | "failed"; readonly artifact?: DurableArtifact };
export interface StateSuccess { readonly path: TaskPathClaim; readonly revision: number; readonly status: StateInput["status"] }
export interface CounterReviewInput extends CommonToolInput { readonly artifact_path: TaskPathClaim; readonly rubric: RubricV1 }
export interface CounterReviewSuccess { readonly path: TaskPathClaim; readonly verdict: "pass" | "advisory" | "fail"; readonly blocking_count: number; readonly revision: number }
export interface AdjudicateInput extends CommonToolInput { readonly artifact_path: TaskPathClaim; readonly upstream_paths: readonly TaskPathClaim[] }
export interface AdjudicateSuccess { readonly path: TaskPathClaim; readonly constitution: ConstitutionResult; readonly drift: DriftResult; readonly triggers: readonly RuleVersionRef[]; readonly revision: number }
export type GateInput = { readonly [K in GateKind]: CommonToolInput & { readonly phase_instance: PhaseInstanceId; readonly summary: string; readonly subject_digest: Sha256Digest; readonly current_evidence: CurrentEvidenceSetRef; readonly supersedes?: GateSupersessionRef; readonly supplemental_outcome?: SupplementalReviewOutcome; readonly kind: K; readonly context: GateContext<K> } }[GateKind];
export type GateSuccess = { readonly [K in GateKind]: { readonly kind: K; readonly decision: GateDecisionEnvelope<K>; readonly notes: string; readonly revision: number } }[GateKind];
export interface WaiverInput extends CommonToolInput { readonly origin: WaiverOriginRef; readonly rationale: string }
export interface WaiverDecisionBinding { readonly origin_gate_id: PathSafeId; readonly waiver_gate_id: PathSafeId; readonly task_id: TaskSlug; readonly rule_id: string; readonly rule_version: number; readonly subject_digest: Sha256Digest; readonly current_evidence_set_digest: Sha256Digest; readonly scope: WaiverScope; readonly human_provenance: HumanDecisionProvenance }
export type WaiverSuccess = (WaiverDecisionBinding & { readonly granted: true; readonly expires: "task-complete"; readonly notes: string; readonly revision: number }) | (WaiverDecisionBinding & { readonly granted: false; readonly notes: string; readonly revision: number });
export interface ToolContract<Input, Success> { readonly input: Input; readonly success: Success }
export interface ToolContractMap { readonly archflow_state: ToolContract<StateInput, StateSuccess>; readonly archflow_counter_review: ToolContract<CounterReviewInput, CounterReviewSuccess>; readonly archflow_adjudicate: ToolContract<AdjudicateInput, AdjudicateSuccess>; readonly archflow_gate: ToolContract<GateInput, GateSuccess>; readonly archflow_waiver: ToolContract<WaiverInput, WaiverSuccess> }
type Exact = ToolContractMap extends Record<ToolName, ToolContract<unknown, unknown>> ? Exclude<keyof ToolContractMap, ToolName> extends never ? true : never : never;
const exact: Exact = true; void exact;
export type ToolInput<K extends ToolName> = ToolContractMap[K]["input"];
export type ToolSuccess<K extends ToolName> = ToolContractMap[K]["success"];
export type ResultIdentityPayload<K extends ToolName = ToolName> = { readonly [P in K]: Readonly<{ schema_version: "1"; tool: P; task_id: TaskSlug; intent_id: PathSafeId; input_fingerprint: Sha256Digest; request_digest: Sha256Digest; result_id: string; resulting_revision: number; success: ToolSuccess<P> }> }[K];
export interface ToolDefinition<K extends ToolName> { readonly name: K; readonly input_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${K}/input`; readonly result_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${K}/result` }
const def = <K extends ToolName>(name: K): ToolDefinition<K> => Object.freeze({ name, input_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/input`, result_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/result` });
export const TOOL_DEFINITIONS = Object.freeze({ archflow_state: def("archflow_state"), archflow_counter_review: def("archflow_counter_review"), archflow_adjudicate: def("archflow_adjudicate"), archflow_gate: def("archflow_gate"), archflow_waiver: def("archflow_waiver") }) satisfies { readonly [K in keyof ToolContractMap]: ToolDefinition<K> };

const durableArtifact = z.union([
  taskInitializationV1Schema,
  legacyImportInitializationV1Schema,
  documentArtifactV1Schema,
  implementationOutputV1Schema,
  manualCheckpointImportV1Schema,
  z.object({
    schema_version: z.literal("1"),
    artifact_kind: z.literal("review-evidence"),
    evidence: reviewEvidenceSchema,
  }).strict() as z.ZodType<ReviewEvidenceArtifactV1>,
  z.object({
    schema_version: z.literal("1"),
    artifact_kind: z.literal("triage"),
    evidence: triageCandidateSchema,
  }).strict() as z.ZodType<TriageArtifactV1>,
]) as unknown as z.ZodType<DurableArtifact>;
const stateInput = z.object({ ...common, phase_instance: phase, step: z.enum(["produce", "self_review", "counter_review", "triage", "adjudicate"]), status: z.enum(["running", "succeeded", "failed"]), artifact: durableArtifact.optional() }).strict();
const counterInput = z.object({ ...common, artifact_path: taskPathClaimV1Schema, rubric: rubricV1Schema }).strict();
const adjudicateInput = z.object({ ...common, artifact_path: taskPathClaimV1Schema, upstream_paths: z.array(taskPathClaimV1Schema) }).strict();
const supersedes = z.object({ superseded_gate_id: pathSafeIdV1Schema, accepted_triage_digest: digest, old_subject_digest: digest }).strict();
const gateInput = z.object({ ...common, phase_instance: phase, summary: text, subject_digest: digest, current_evidence: z.unknown(), supersedes: supersedes.optional(), supplemental_outcome: z.unknown().optional(), kind: z.enum(GATE_KINDS), context: z.unknown() }).strict();
const waiverOrigin = z.object({ origin_gate_id: pathSafeIdV1Schema, origin_decision_digest: digest, origin_context_digest: digest, task_id: taskSlugV1Schema, phase_instance: phase, subject_digest: digest, current_evidence_set_digest: digest, rule, scope }).strict();
const waiverInput = z.object({ ...common, origin: waiverOrigin, rationale: text }).strict();

function inputFor<K extends ToolName>(name: K, value: unknown): ToolInput<K> {
  const parsed = name === "archflow_state" ? stateInput.parse(value) : name === "archflow_counter_review" ? counterInput.parse(value) : name === "archflow_adjudicate" ? adjudicateInput.parse(value) : name === "archflow_waiver" ? waiverInput.parse(value) : gateInput.parse(value);
  if (name === "archflow_gate") { const v = parsed as z.infer<typeof gateInput>; parseGateContext(v.kind, v.context); return { ...v, current_evidence: parseCurrentEvidenceSetRef(v.current_evidence), ...(v.supplemental_outcome === undefined ? {} : { supplemental_outcome: parseSupplementalReviewOutcome(v.supplemental_outcome) }) } as ToolInput<K>; }
  if (name === "archflow_waiver") { const v = parsed as z.infer<typeof waiverInput>; if (v.task_id !== v.origin.task_id) throw new TypeError("waiver task_id must match origin task_id"); }
  return parsed as ToolInput<K>;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
export type ParsedToolInput<K extends keyof ToolContractMap> = ToolInput<K> & { readonly [parsedToolInputBrand]: K };
export type ParsedToolCall<K extends ToolName = ToolName> = { readonly [P in K]: Readonly<{ name: P; input: ParsedToolInput<P> }> }[K];
/** Internal authenticity assertion for state/repository kernels; deliberately absent from the public barrel. */
export function assertAuthenticParsedToolCall(value: unknown): asserts value is ParsedToolCall {
  if (value === null || typeof value !== "object" || !parsedCalls.has(value)) {
    throw new TypeError("an authentic parsed tool call is required");
  }
}
export function parseToolCall<K extends ToolName>(name: K, value: unknown): Extract<ParsedToolCall, { name: K }> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new TypeError("unknown tool");
  assertPlainJson(value, `${name} input`);
  const parsed = inputFor(name, structuredClone(value));
  assertPlainJson(parsed, `${name} parsed input`);
  const input = structuredClone(parsed) as ToolInput<K> & { [parsedToolInputBrand]?: K };
  for (const nested of Object.values(input)) deepFreeze(nested);
  Object.defineProperty(input, parsedToolInputBrand, { value: name, enumerable: false, writable: false, configurable: false });
  Object.freeze(input);
  const call = Object.freeze({ name, input }) as unknown as Extract<ParsedToolCall, { name: K }>;
  parsedCalls.add(call);
  return call;
}
export type RequestIdentifiedToolCall<K extends ToolName = ToolName> = ParsedToolCall<K> & { readonly request_digest: Sha256Digest };
export function bindParsedToolCallRequest<K extends ToolName>(call: Extract<ParsedToolCall, { name: K }>, requestDigest: Sha256Digest): Extract<RequestIdentifiedToolCall, { name: K }> { if (!parsedCalls.has(call)) throw new TypeError("an authentic parsed tool call is required"); digest.parse(requestDigest); requestDigests.set(call, requestDigest); return call as Extract<RequestIdentifiedToolCall, { name: K }>; }

const successSchemas = {
  archflow_state: z.object({ path: taskPathClaimV1Schema, revision: safeInteger, status: z.enum(["running", "succeeded", "failed"]) }).strict(),
  archflow_counter_review: z.object({ path: taskPathClaimV1Schema, verdict: z.enum(["pass", "advisory", "fail"]), blocking_count: safeInteger, revision: safeInteger }).strict(),
  archflow_adjudicate: z.object({ path: taskPathClaimV1Schema, constitution: z.enum(CONSTITUTION_RESULTS), drift: z.enum(DRIFT_RESULTS), triggers: z.array(rule), revision: safeInteger }).strict(),
  archflow_gate: z.object({ kind: z.enum(GATE_KINDS), decision: z.unknown(), notes: text, revision: safeInteger }).strict(),
  archflow_waiver: z.union([z.object({ origin_gate_id: pathSafeIdV1Schema, waiver_gate_id: pathSafeIdV1Schema, task_id: taskSlugV1Schema, rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), subject_digest: digest, current_evidence_set_digest: digest, scope, human_provenance: provenance, granted: z.literal(true), expires: z.literal("task-complete"), notes: text, revision: safeInteger }).strict(), z.object({ origin_gate_id: pathSafeIdV1Schema, waiver_gate_id: pathSafeIdV1Schema, task_id: taskSlugV1Schema, rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), subject_digest: digest, current_evidence_set_digest: digest, scope, human_provenance: provenance, granted: z.literal(false), notes: text, revision: safeInteger }).strict()])
} as const;
function successFor<K extends ToolName>(call: Extract<ParsedToolCall, { name: K }>, value: unknown): ToolSuccess<K> {
  const parsed = successSchemas[call.name].parse(value) as ToolSuccess<K>;
  if (call.name === "archflow_state" && (parsed as StateSuccess).status !== (call.input as ParsedToolInput<"archflow_state">).status) throw new TypeError("state status mismatch");
  if (call.name === "archflow_gate") {
    const input = call.input as ParsedToolInput<"archflow_gate">;
    const result = parsed as GateSuccess;
    const decision = parseGateDecisionEnvelope(result.decision);
    if (result.kind !== input.kind || decision.kind !== input.kind || decision.task_id !== input.task_id || decision.phase_instance !== input.phase_instance || decision.subject_digest !== input.subject_digest || result.notes !== decision.payload.reason) throw new TypeError("gate result mismatch");
    validateGateDecision(input.kind, input.context, decision.payload);
  }
  if (call.name === "archflow_waiver") { const input = call.input as ParsedToolInput<"archflow_waiver">; const result = parsed as WaiverSuccess; if (result.origin_gate_id !== input.origin.origin_gate_id || result.task_id !== input.task_id || result.rule_id !== input.origin.rule.rule_id || result.rule_version !== input.origin.rule.rule_version || result.subject_digest !== input.origin.subject_digest || result.current_evidence_set_digest !== input.origin.current_evidence_set_digest || !isDeepStrictEqual(result.scope, input.origin.scope)) throw new TypeError("waiver result mismatch"); }
  return parsed;
}
export type StructurallyValidProjectResult<K extends ToolName> = ProjectResult<ToolSuccess<K>> & { readonly [structuralResultBrand]: K };
function projectFailureForTool<K extends ToolName>(
  name: K,
  value: unknown,
  label: string
): Extract<ProjectResult<ToolSuccess<K>>, { readonly ok: false }> {
  assertPlainJson(value, label);
  const failure = z.object({ schema_version: z.literal("1"), ok: z.literal(false), error: z.unknown() }).strict().parse(value);
  const error = parseProjectError(failure.error);
  const parameters = error.diagnostic.parameters;
  if (Object.hasOwn(parameters, "tool") && Reflect.get(parameters, "tool") !== name) {
    throw new TypeError("project failure tool mismatch");
  }
  return { schema_version: "1", ok: false, error };
}
export function validateProjectResultStructure<K extends ToolName>(call: Extract<ParsedToolCall, { name: K }>, value: unknown): StructurallyValidProjectResult<K> { if (!parsedCalls.has(call)) throw new TypeError("an authentic parsed tool call is required"); assertPlainJson(value, `${call.name} result`); const base = z.object({ schema_version: z.literal("1"), ok: z.boolean() }).passthrough().parse(value); const result: ProjectResult<ToolSuccess<K>> = base.ok ? (() => { const e = z.object({ schema_version: z.literal("1"), ok: z.literal(true), value: z.unknown() }).strict().parse(value); return { ...e, value: successFor(call, e.value) }; })() : projectFailureForTool(call.name, value, `${call.name} result`); const branded = Object.freeze({ ...result, [structuralResultBrand]: call.name }) as StructurallyValidProjectResult<K>; structuralResults.add(branded); return branded; }
export function validateProjectFailureStructure<K extends ToolName>(name: K, value: unknown): StructurallyValidProjectResult<K> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new TypeError("unknown tool");
  const failure = projectFailureForTool(name, value, `${name} failure result`);
  const error = structuredClone(failure.error) as typeof failure.error;
  const freeze = (candidate: unknown): void => {
    if (candidate !== null && typeof candidate === "object") {
      for (const nested of Object.values(candidate)) freeze(nested);
      Object.freeze(candidate);
    }
  };
  freeze(error);
  const branded = Object.freeze({ schema_version: "1", ok: false, error, [structuralResultBrand]: name }) as StructurallyValidProjectResult<K>;
  structuralResults.add(branded);
  return branded;
}
export type ResultExpectationDataByTool = { readonly [P in ToolName]: ResultIdentityPayload<P> };
export type ResultExpectation<K extends ToolName> = ResultExpectationDataByTool[K] & { readonly [resultExpectationBrand]: K };
export function createInternalResultExpectation<K extends ToolName>(value: ResultIdentityPayload<K>): ResultExpectation<K> { assertPlainJson(value, "result expectation"); const base = z.object({ schema_version: z.literal("1"), tool: z.enum(TOOL_NAMES), task_id: taskSlugV1Schema, intent_id: pathSafeIdV1Schema, input_fingerprint: digest, request_digest: digest, result_id: safeId, resulting_revision: safeInteger, success: z.unknown() }).strict().parse(value); const success = successSchemas[base.tool].parse(base.success) as ToolSuccess<K>; if (base.resulting_revision !== success.revision) throw new TypeError("expectation resulting revision must equal success revision"); const expectation = Object.assign({}, base, { success }) as unknown as ResultExpectation<K>; Object.defineProperty(expectation, resultExpectationBrand, { value: value.tool, enumerable: false, writable: false, configurable: false }); Object.freeze(expectation); resultExpectations.add(expectation); return expectation; }
export function correlateProjectResult<K extends ToolName>(call: Extract<RequestIdentifiedToolCall, { name: K }>, expectation: NoInfer<ResultExpectation<K>>, result: NoInfer<StructurallyValidProjectResult<K>>): ProjectResult<ToolSuccess<K>> { const requestDigest = requestDigests.get(call); if (requestDigest === undefined || !parsedCalls.has(call) || !resultExpectations.has(expectation) || !structuralResults.has(result)) throw new TypeError("authentic request/result identities are required"); if (expectation[resultExpectationBrand] !== call.name || result[structuralResultBrand] !== call.name || expectation.tool !== call.name) throw new TypeError("result correlation tool mismatch"); if (expectation.request_digest !== requestDigest || expectation.task_id !== call.input.task_id || expectation.intent_id !== call.input.intent_id || expectation.input_fingerprint !== call.input.input_fingerprint) throw new TypeError("expectation invocation mismatch"); if (result.ok && (expectation.resulting_revision !== result.value.revision || !isDeepStrictEqual(expectation.success, result.value))) throw new TypeError("result expectation mismatch"); return result; }
