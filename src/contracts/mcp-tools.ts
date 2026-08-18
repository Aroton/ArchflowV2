import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CONSTITUTION_RESULTS, DRIFT_RESULTS, type ConstitutionResult, type DriftResult } from "./adjudication.js";
import { documentArtifactV1Schema } from "./durable-document.js";
import { implementationOutputV1Schema } from "./durable-implementation-output.js";
import { legacyImportInitializationV1Schema } from "./durable-legacy-import.js";
import type { TriageArtifactV1 } from "./durable-result-manifest.js";
import { taskInitializationV1Schema } from "./durable-task-initialization.js";
import type { DurableArtifact } from "./durable.js";
import { HUMAN_REVISION_CLASSIFICATIONS, type HumanRevisionClassification, type HumanRevisionOverride } from "./durable-state.js";
import { parseProjectError, type ProjectResult } from "./errors.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type Sha256Digest, type TaskSlug } from "./evidence.js";
import { GATE_KINDS, gateDecisionEnvelopeV1Schema, humanDecisionProvenanceV1Schema, parseBaselineObservationRef, parseGateContext, parseGateDecisionEnvelope, validateGateDecision, type GateContext, type GateDecisionEnvelope, type GateKind, type HumanDecisionProvenance, type RuleVersionRef, type WaiverOriginRef, type WaiverScope } from "./gates.js";
import type { GateEvidenceByKind } from "./durable-gate.js";
import { assertPlainJson } from "./plain-json.js";
import { decodePhaseInstance, type PhaseInstanceId } from "./phase-instance.js";
import { repositoryPathClaimV1Schema, taskPathClaimV1Schema, type RepositoryPathClaim, type TaskPathClaim } from "./path-claims.js";
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
const phase = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u).refine((v) => { try { decodePhaseInstance(v); return true; } catch { return false; } }) as unknown as z.ZodType<PhaseInstanceId>;
const rule = z.object({ rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const scope = z.object({ operation: z.enum(["review-trigger", "adjudication-failure"]), boundary: z.enum(["subject", "phase", "task"]) }).strict();
// A parentless clone: the shared instance is registered as `gate-decision-record#/$defs/provenance`,
// which the advertised catalogue's document set does not carry, so the waiver success must emit the
// union body (two gate-decision refs) rather than a cross-document reference to it.
const provenance = humanDecisionProvenanceV1Schema.clone(humanDecisionProvenanceV1Schema.def) as z.ZodType<HumanDecisionProvenance>;
const common = { schema_version: z.literal("1"), task_id: taskSlugV1Schema, intent_id: pathSafeIdV1Schema, expected_revision: safeInteger, input_fingerprint: digest } as const;

export type CommonToolInput = { readonly schema_version: "1"; readonly task_id: TaskSlug; readonly intent_id: PathSafeId; readonly expected_revision: number; readonly input_fingerprint: Sha256Digest };
export type HumanRevisionDeclaration = {
  readonly classification: HumanRevisionClassification;
  readonly rationale: string;
  readonly user_override?: HumanRevisionOverride;
};
export type PlanningRestartDeclaration = { readonly reason: string };
export type StateInput = CommonToolInput & { readonly phase_instance: PhaseInstanceId; readonly step: "produce" | "counter_review" | "triage"; readonly status: "running" | "succeeded" | "failed"; readonly artifact?: DurableArtifact; readonly human_revision?: HumanRevisionDeclaration; readonly planning_restart?: PlanningRestartDeclaration };
// Every success value optionally echoes the request_digest the server recorded for the call, so
// a client can compare one string against its envelope output to prove the arguments arrived
// untranscribed. Optional in the contract because receipts recorded before the echo existed must
// keep replaying byte-identically; live handlers always emit it.
export interface StateSuccess { readonly path: TaskPathClaim; readonly revision: number; readonly status: StateInput["status"]; readonly request_digest?: Sha256Digest }
export interface CounterReviewInput extends CommonToolInput { readonly artifact_path: TaskPathClaim }
/**
 * The server decides whether the constitution review runs: it is evaluated as a second
 * server-dispatched review inside the same archflow_counter_review call whenever the pinned
 * constitution has active rules, and reported "not-run" explicitly when it has none.
 */
export type CounterReviewConstitutionOutcome =
  | Readonly<{ status: "evaluated"; path: RepositoryPathClaim; constitution: ConstitutionResult; drift: DriftResult; triggers: readonly RuleVersionRef[] }>
  | Readonly<{ status: "not-run"; reason: "no-active-constitution-rules" }>;
export interface CounterReviewSuccess { readonly path: RepositoryPathClaim; readonly verdict: "pass" | "advisory" | "fail"; readonly blocking_count: number; readonly constitution: CounterReviewConstitutionOutcome; readonly revision: number; readonly request_digest?: Sha256Digest }
export type HumanGateChoice = { readonly choice: string; readonly reason: string };
export type GateInput = { readonly [K in GateKind]: CommonToolInput & { readonly phase_instance: PhaseInstanceId; readonly summary: string; readonly subject_digest: Sha256Digest; readonly current_evidence: GateEvidenceByKind<K>; readonly kind: K; readonly context: GateContext<K>; readonly preview_digest: Sha256Digest; readonly decision: HumanGateChoice } }[GateKind];
export type GateSuccess = { readonly [K in GateKind]: { readonly kind: K; readonly decision: GateDecisionEnvelope<K>; readonly notes: string; readonly revision: number; readonly request_digest?: Sha256Digest } }[GateKind];
export type WaiverInput = CommonToolInput & { readonly origin: WaiverOriginRef; readonly rationale: string; readonly preview_digest: Sha256Digest; readonly decision: HumanGateChoice };
export interface WaiverDecisionBinding { readonly origin_gate_id: PathSafeId; readonly waiver_gate_id: PathSafeId; readonly task_id: TaskSlug; readonly rule_id: string; readonly rule_version: number; readonly subject_digest: Sha256Digest; readonly current_evidence_set_digest: Sha256Digest; readonly scope: WaiverScope; readonly human_provenance: HumanDecisionProvenance }
export type WaiverSuccess = (WaiverDecisionBinding & { readonly granted: true; readonly expires: "task-complete"; readonly notes: string; readonly revision: number; readonly request_digest?: Sha256Digest }) | (WaiverDecisionBinding & { readonly granted: false; readonly notes: string; readonly revision: number; readonly request_digest?: Sha256Digest });
export interface ToolContract<Input, Success> { readonly input: Input; readonly success: Success }
export interface ToolContractMap { readonly archflow_state: ToolContract<StateInput, StateSuccess>; readonly archflow_counter_review: ToolContract<CounterReviewInput, CounterReviewSuccess>; readonly archflow_gate: ToolContract<GateInput, GateSuccess>; readonly archflow_waiver: ToolContract<WaiverInput, WaiverSuccess> }
type Exact = ToolContractMap extends Record<ToolName, ToolContract<unknown, unknown>> ? Exclude<keyof ToolContractMap, ToolName> extends never ? true : never : never;
const exact: Exact = true; void exact;
export type ToolInput<K extends ToolName> = ToolContractMap[K]["input"];
export type ToolSuccess<K extends ToolName> = ToolContractMap[K]["success"];
export type ResultIdentityPayload<K extends ToolName = ToolName> = { readonly [P in K]: Readonly<{ schema_version: "1"; tool: P; task_id: TaskSlug; intent_id: PathSafeId; input_fingerprint: Sha256Digest; request_digest: Sha256Digest; result_id: string; resulting_revision: number; success: ToolSuccess<P> }> }[K];
export interface ToolDefinition<K extends ToolName> { readonly name: K; readonly input_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${K}/input`; readonly result_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${K}/result` }
const def = <K extends ToolName>(name: K): ToolDefinition<K> => Object.freeze({ name, input_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/input`, result_schema_id: `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/result` });
export const TOOL_DEFINITIONS = Object.freeze({ archflow_state: def("archflow_state"), archflow_counter_review: def("archflow_counter_review"), archflow_gate: def("archflow_gate"), archflow_waiver: def("archflow_waiver") }) satisfies { readonly [K in keyof ToolContractMap]: ToolDefinition<K> };

const durableArtifact = z.union([
  taskInitializationV1Schema,
  legacyImportInitializationV1Schema,
  documentArtifactV1Schema,
  implementationOutputV1Schema,
  z.object({
    schema_version: z.literal("1"),
    artifact_kind: z.literal("triage"),
    evidence: triageCandidateSchema,
  }).strict() as z.ZodType<TriageArtifactV1>,
]) as unknown as z.ZodType<DurableArtifact>;
const humanRevisionDeclarationSchema = z.object({
  classification: z.enum(HUMAN_REVISION_CLASSIFICATIONS),
  rationale: text,
  user_override: z.object({
    agent_classification: z.enum(HUMAN_REVISION_CLASSIFICATIONS),
    rationale: text,
  }).strict().optional(),
}).strict().superRefine((revision, context) => {
  if (revision.user_override?.agent_classification === revision.classification) {
    context.addIssue({ code: "custom", path: ["user_override", "agent_classification"], message: "an override must change the classification" });
  }
});
export const planningRestartDeclarationSchema = z.object({ reason: text }).strict();
export const stateInputSchema = z.object({ ...common, phase_instance: phase, step: z.enum(["produce", "counter_review", "triage"]), status: z.enum(["running", "succeeded", "failed"]), artifact: durableArtifact.optional(), human_revision: humanRevisionDeclarationSchema.optional(), planning_restart: planningRestartDeclarationSchema.optional() }).strict().superRefine((input, context) => {
  if (input.human_revision !== undefined && (input.step !== "produce" || input.status !== "succeeded")) {
    context.addIssue({ code: "custom", path: ["human_revision"], message: "human_revision is allowed only on a succeeded produce result" });
  }
  if (input.planning_restart !== undefined &&
      (input.step !== "produce" || input.status !== "running" || input.artifact !== undefined || input.human_revision !== undefined)) {
    context.addIssue({ code: "custom", path: ["planning_restart"], message: "planning_restart is allowed only on an artifact-free produce-running transition" });
  }
});
/**
 * The staged-request reference arm shared by every tool input union. It is structurally disjoint
 * from every full-payload arm: strictness rejects any full payload (extra fields), and every full
 * payload requires `expected_revision`/`input_fingerprint`, which the reference lacks — so
 * classification between the arms is never ambiguous. The server resolves the reference to the
 * staged file `build-request` wrote and refuses on any digest disagreement.
 */
const stagedReferenceInput = z.object({ schema_version: z.literal("1"), task_id: taskSlugV1Schema, intent_id: pathSafeIdV1Schema, request_digest: digest }).strict();
export type StagedRequestReference = Readonly<{ schema_version: "1"; task_id: TaskSlug; intent_id: PathSafeId; request_digest: Sha256Digest }>;
export function parseStagedRequestReference(value: unknown): StagedRequestReference {
  assertPlainJson(value, "staged request reference");
  return deepFreeze(stagedReferenceInput.parse(structuredClone(value))) as StagedRequestReference;
}
export const counterReviewInputSchema = z.object({ ...common, artifact_path: taskPathClaimV1Schema }).strict();
const humanGateChoiceSchema = z.object({ choice: text, reason: text }).strict();
export const gateInputSchema = z.object({ ...common, phase_instance: phase, summary: text, subject_digest: digest, current_evidence: z.unknown(), kind: z.enum(GATE_KINDS), context: z.unknown(), preview_digest: digest, decision: humanGateChoiceSchema }).strict().superRefine((input, context) => {
  try { parseGateContext(input.kind, input.context); } catch (error) { context.addIssue({ code: "custom", path: ["context"], message: error instanceof Error ? error.message : "invalid gate context" }); }
  try {
    // Baseline adoption opens pre-review: its evidence is the drift observation, not a review set.
    if (input.kind === "baseline-adoption") parseBaselineObservationRef(input.current_evidence);
    else parseCurrentEvidenceSetRef(input.current_evidence);
  } catch (error) { context.addIssue({ code: "custom", path: ["current_evidence"], message: error instanceof Error ? error.message : "invalid current evidence" }); }
});
const waiverOrigin = z.object({ origin_gate_id: pathSafeIdV1Schema, origin_decision_digest: digest, origin_context_digest: digest, task_id: taskSlugV1Schema, phase_instance: phase, subject_digest: digest, current_evidence_set_digest: digest, rule, scope }).strict();
export const waiverInputSchema = z.object({ ...common, origin: waiverOrigin, rationale: text, preview_digest: digest, decision: humanGateChoiceSchema }).strict().superRefine((input, context) => {
  if (input.task_id !== input.origin.task_id) context.addIssue({ code: "custom", path: ["task_id"], message: "waiver task_id must match origin task_id" });
});

function inputFor<K extends ToolName>(name: K, value: unknown): ToolInput<K> {
  const parsed = name === "archflow_state" ? stateInputSchema.parse(value) : name === "archflow_counter_review" ? counterReviewInputSchema.parse(value) : name === "archflow_waiver" ? waiverInputSchema.parse(value) : gateInputSchema.parse(value);
  if (name === "archflow_gate") { const v = parsed as z.infer<typeof gateInputSchema>; return { ...v, current_evidence: v.kind === "baseline-adoption" ? parseBaselineObservationRef(v.current_evidence) : parseCurrentEvidenceSetRef(v.current_evidence) } as ToolInput<K>; }
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
export type ClassifiedToolCallInput<K extends ToolName> =
  | Readonly<{ kind: "call"; call: Extract<ParsedToolCall, { name: K }> }>
  | Readonly<{ kind: "staged-reference"; tool: K; reference: StagedRequestReference }>;
/**
 * The union entry for every tool input: a full payload parses to an authentic call, and the
 * staged-request reference arm is returned for the server to rehydrate from durable staging.
 */
export function classifyToolCallInput<K extends ToolName>(name: K, value: unknown): ClassifiedToolCallInput<K> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new TypeError("unknown tool");
  assertPlainJson(value, `${name} input`);
  const reference = stagedReferenceInput.safeParse(structuredClone(value));
  if (reference.success) {
    return Object.freeze({ kind: "staged-reference", tool: name, reference: deepFreeze(reference.data) as StagedRequestReference });
  }
  return Object.freeze({ kind: "call", call: parseToolCall(name, value) });
}
export type RequestIdentifiedToolCall<K extends ToolName = ToolName> = ParsedToolCall<K> & { readonly request_digest: Sha256Digest };
export function bindParsedToolCallRequest<K extends ToolName>(call: Extract<ParsedToolCall, { name: K }>, requestDigest: Sha256Digest): Extract<RequestIdentifiedToolCall, { name: K }> { if (!parsedCalls.has(call)) throw new TypeError("an authentic parsed tool call is required"); digest.parse(requestDigest); requestDigests.set(call, requestDigest); return call as Extract<RequestIdentifiedToolCall, { name: K }>; }

export const toolSuccessSchemas = {
  archflow_state: z.object({ path: taskPathClaimV1Schema, revision: safeInteger, status: z.enum(["running", "succeeded", "failed"]), request_digest: digest.optional() }).strict(),
  archflow_counter_review: z.object({
    path: repositoryPathClaimV1Schema,
    verdict: z.enum(["pass", "advisory", "fail"]),
    blocking_count: safeInteger,
    constitution: z.union([
      z.object({ status: z.literal("evaluated"), path: repositoryPathClaimV1Schema, constitution: z.enum(CONSTITUTION_RESULTS), drift: z.enum(DRIFT_RESULTS), triggers: z.array(rule) }).strict(),
      z.object({ status: z.literal("not-run"), reason: z.literal("no-active-constitution-rules") }).strict(),
    ]),
    revision: safeInteger,
    request_digest: digest.optional(),
  }).strict(),
  archflow_gate: z.object({ kind: z.enum(GATE_KINDS), decision: gateDecisionEnvelopeV1Schema, notes: text, revision: safeInteger, request_digest: digest.optional() }).strict(),
  archflow_waiver: z.union([z.object({ origin_gate_id: pathSafeIdV1Schema, waiver_gate_id: pathSafeIdV1Schema, task_id: taskSlugV1Schema, rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), subject_digest: digest, current_evidence_set_digest: digest, scope, human_provenance: provenance, granted: z.literal(true), expires: z.literal("task-complete"), notes: text, revision: safeInteger, request_digest: digest.optional() }).strict(), z.object({ origin_gate_id: pathSafeIdV1Schema, waiver_gate_id: pathSafeIdV1Schema, task_id: taskSlugV1Schema, rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), subject_digest: digest, current_evidence_set_digest: digest, scope, human_provenance: provenance, granted: z.literal(false), notes: text, revision: safeInteger, request_digest: digest.optional() }).strict()])
} as const;
/**
 * The shared `mcp-tools.schema.json` leaf `$defs` the generator emits, keyed by committed def
 * name. The advertised catalogue in `src/mcp/tools.ts` reaches `integer` and `durableArtifact`
 * by pointer and the gate-input emission references the rest, so every name here is pinned.
 * Registering these local instances keeps each use site a `#/$defs/<name>` reference instead of
 * an inline copy, mirroring the def layout the hand-written document established.
 */
export const mcpToolsSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  digest,
  id: safeId,
  text,
  integer: safeInteger,
  phase,
  durableArtifact,
  rule,
  scope,
  stagedReference: stagedReferenceInput,
});
function successFor<K extends ToolName>(call: Extract<ParsedToolCall, { name: K }>, value: unknown): ToolSuccess<K> {
  const parsed = toolSuccessSchemas[call.name].parse(value) as ToolSuccess<K>;
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
export const resultExpectationDataSchema = z.object({ schema_version: z.literal("1"), tool: z.enum(TOOL_NAMES), task_id: taskSlugV1Schema, intent_id: pathSafeIdV1Schema, input_fingerprint: digest, request_digest: digest, result_id: safeId, resulting_revision: safeInteger, success: z.unknown() }).strict().superRefine((expectation, context) => {
  const success = toolSuccessSchemas[expectation.tool].safeParse(expectation.success);
  if (!success.success) { context.addIssue({ code: "custom", path: ["success"], message: `invalid ${expectation.tool} success value` }); return; }
  if (expectation.resulting_revision !== success.data.revision) context.addIssue({ code: "custom", path: ["resulting_revision"], message: "expectation resulting revision must equal success revision" });
});
export function createInternalResultExpectation<K extends ToolName>(value: ResultIdentityPayload<K>): ResultExpectation<K> { assertPlainJson(value, "result expectation"); const base = resultExpectationDataSchema.parse(value); const success = toolSuccessSchemas[base.tool].parse(base.success) as ToolSuccess<K>; const expectation = Object.assign({}, base, { success }) as unknown as ResultExpectation<K>; Object.defineProperty(expectation, resultExpectationBrand, { value: value.tool, enumerable: false, writable: false, configurable: false }); Object.freeze(expectation); resultExpectations.add(expectation); return expectation; }
export function correlateProjectResult<K extends ToolName>(call: Extract<RequestIdentifiedToolCall, { name: K }>, expectation: NoInfer<ResultExpectation<K>>, result: NoInfer<StructurallyValidProjectResult<K>>): ProjectResult<ToolSuccess<K>> { const requestDigest = requestDigests.get(call); if (requestDigest === undefined || !parsedCalls.has(call) || !resultExpectations.has(expectation) || !structuralResults.has(result)) throw new TypeError("authentic request/result identities are required"); if (expectation[resultExpectationBrand] !== call.name || result[structuralResultBrand] !== call.name || expectation.tool !== call.name) throw new TypeError("result correlation tool mismatch"); if (expectation.request_digest !== requestDigest || expectation.task_id !== call.input.task_id || expectation.intent_id !== call.input.intent_id || expectation.input_fingerprint !== call.input.input_fingerprint) throw new TypeError("expectation invocation mismatch"); if (result.ok && (expectation.resulting_revision !== result.value.revision || !isDeepStrictEqual(expectation.success, result.value))) throw new TypeError("result expectation mismatch"); return result; }
