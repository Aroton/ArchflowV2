import { z } from "zod";

import type { PhaseDesignComponentManifestV1 } from "./component-manifest.js";
import { phaseDesignComponentManifestV1Schema } from "./component-manifest.js";
import { gitOidV1Schema } from "./canonical.js";
import { REPOSITORY_NAME_MESSAGE, REPOSITORY_NAME_PATTERN } from "./config.js";
import type { HazardRegistryInputV1 } from "./hazard-registry.js";
import {
  hazardRegistryEntryV1Schema,
  hazardRegistryInputV1Schema,
} from "./hazard-registry.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import {
  createTaskSlugV1Schema,
  safeIdV1Schema,
  safeIntegerV1Schema,
  sha256DigestV1Schema,
  taskSlugV1Schema,
} from "./evidence.js";
import { phaseInstanceIdV1Schema, type PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
import {
  type AdapterId,
  type ModelFamily,
  type ReviewedRepositoryV1,
  type RouteOverrideRecord,
  type RouteSourceRecord,
} from "./review.js";
import {
  EFFORT_CAVEAT_CODES,
  DEFAULT_IMPLEMENTATION_PROFILE,
  IMPLEMENTATION_EFFORT_POLICY_ID,
  IMPLEMENTATION_PROFILES,
  IMPLEMENTATION_PROFILE_IDS,
  deriveImplementationEffortV1,
  type DerivedImplementationEffortV1,
  type EffortBlockerV1,
  type ImplementationProfileV1,
} from "../review/effort-policy.js";

export { IMPLEMENTATION_EFFORT_POLICY_ID } from "../review/effort-policy.js";

export const EFFORT_AXIS_IDS = ["A", "B", "C", "D", "E"] as const;
export const EFFORT_CLASSIFICATIONS = ["yes", "no", "unknown"] as const;
export const EFFORT_DECOMPOSITION_STATUSES = ["adequate", "undifferentiated"] as const;
export const EFFORT_REVIEW_INSTRUCTIONS =
  "Assess each implementation component independently. First decide whether the manifest decomposition is adequate; use undifferentiated and name every missing implementation boundary when one component merges independently scoreable scope, mechanisms, paths, or verification boundaries. Score every component from 0 through 3 on all five axes: A derivation depth (0 transcription, 1 known pattern with local adaptation, 2 approach given but mechanism missing, 3 derive from constraints); B verifier weakness (0 compiler, 1 deterministic unit tests, 2 reproducible simulation, 3 timing/nondeterministic/tail metric); C state space (0 pure or straight-line I/O, 1 sequential error paths, 2 shared state or async without timers, 3 timers/cancellation/partial failure/cross-component invariants); D specification gaps (0 numeric thresholds and priorities given, 1 minor obvious defaults, 2 one material unstated decision, 3 conflicting goals without priority); E codebase hazard (0 new module, 1 stable clear interfaces, 2 registry hazard, 3 unsafe/manual lifetime/open correctness defect). E must meet the captured floor when one exists. Classify long_tool_loop and short_component as yes, no, or unknown with a rationale. Every D score of 2 or 3 must include one blocker whose answer_kind is number or priority-order and whose question is concrete; lower D scores must omit it. Return judgments and classifications only: never author totals, profiles, routes, phase aggregation, actions, or authority." as const;

export type EffortAxisJudgmentV1 = {
  readonly score: 0 | 1 | 2 | 3;
  readonly rationale: string;
};

export type EffortClassificationV1 = {
  readonly value: (typeof EFFORT_CLASSIFICATIONS)[number];
  readonly rationale: string;
};

export type ComponentEffortJudgmentV1 = {
  readonly component_id: string;
  readonly axes: Readonly<Record<(typeof EFFORT_AXIS_IDS)[number], EffortAxisJudgmentV1>>;
  readonly long_tool_loop: EffortClassificationV1;
  readonly short_component: EffortClassificationV1;
  readonly blocker?: { readonly answer_kind: "number" | "priority-order"; readonly question: string };
};

export type RawEffortReviewV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly step: "effort_review";
  readonly role: "effort-reviewer";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly component_manifest_digest: Sha256Digest;
  readonly hazard_registry_digest: Sha256Digest;
  readonly policy_id: typeof IMPLEMENTATION_EFFORT_POLICY_ID;
  readonly decomposition:
    | { readonly status: "adequate"; readonly rationale: string }
    | { readonly status: "undifferentiated"; readonly rationale: string; readonly missing_boundaries: readonly string[] };
  readonly components: readonly ComponentEffortJudgmentV1[];
};

/** The exact server-owned input sent to the fixed effort-review child. */
export type EffortEnvelopeV1 = {
  readonly schema_version: "1";
  readonly instructions: typeof EFFORT_REVIEW_INSTRUCTIONS;
  readonly artifact: string;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly attempt: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly invocation_id: string;
  readonly result_id: string;
  readonly policy_id: typeof IMPLEMENTATION_EFFORT_POLICY_ID;
  readonly component_manifest_digest: Sha256Digest;
  readonly component_manifest: PhaseDesignComponentManifestV1;
  readonly hazard_registry: HazardRegistryInputV1;
  readonly repositories: readonly ReviewedRepositoryV1[];
};

export type EffortReviewerProvenanceV1 = {
  readonly adapter: AdapterId;
  readonly cli_version: string;
  readonly model_family: ModelFamily;
  readonly model: string;
  readonly effort: (typeof EFFORT_VALUES_LOCAL)[number];
  readonly invocation_id: string;
  readonly result_id: string;
  readonly envelope_input_digest: Sha256Digest;
  readonly observed_output_digest: Sha256Digest;
  readonly provider?: string;
  readonly route_source: EffortRouteSourceRecordV1;
  readonly route_override?: RouteOverrideRecord;
  readonly repositories: readonly ReviewedRepositoryV1[];
};

export type EffortRouteSourceRecordV1 = RouteSourceRecord;

/** Exact-subject, server-derived evidence. Provenance and recommendation are intentionally peers. */
export type EffortAssessmentV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly attempt: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly component_manifest_digest: Sha256Digest;
  readonly hazard_registry_digest: Sha256Digest;
  readonly policy_id: typeof IMPLEMENTATION_EFFORT_POLICY_ID;
  readonly decomposition: RawEffortReviewV1["decomposition"];
  readonly judgments: readonly ComponentEffortJudgmentV1[];
  readonly reviewer: EffortReviewerProvenanceV1;
  readonly recommendation: DerivedImplementationEffortV1;
};

const nonblank = z.string().min(1).regex(/\S/u, "must contain a non-whitespace character");
const componentId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const ADAPTER_IDS_LOCAL = ["claude-cli", "codex-cli", "antigravity-cli"] as const;
const MODEL_FAMILIES_LOCAL = ["claude", "codex", "gemini"] as const;
const EFFORT_VALUES_LOCAL = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const routeOverrideRecordSchema = z.object({
  reason: nonblank,
  pinned_model: nonblank.optional(),
  pinned_effort: z.enum(EFFORT_VALUES_LOCAL).optional(),
  pinned_provider: nonblank.optional(),
}).strict();
const displacedEffortRouteRecordSchema = z.object({
  source: z.enum(["configured", "invocation-declared"]),
  model: nonblank,
  effort: z.enum(EFFORT_VALUES_LOCAL),
  provider: nonblank.optional(),
}).strict();
const effortRouteSourceRecordSchema = z.discriminatedUnion("provenance", [
  z.object({ provenance: z.literal("configured") }).strict(),
  z.object({ provenance: z.literal("invocation-declared") }).strict(),
  z.object({ provenance: z.literal("route-override"), displaced: displacedEffortRouteRecordSchema }).strict(),
]);
const repositoryName = z.union([
  z.literal("primary"),
  z.string().regex(REPOSITORY_NAME_PATTERN, REPOSITORY_NAME_MESSAGE),
]);
const reviewedRepositorySchema = z.object({
  name: repositoryName,
  repository_identity_digest: sha256DigestV1Schema,
  commit: gitOidV1Schema,
}).strict();
const reviewedRepositoriesV1Schema = z.array(reviewedRepositorySchema).min(1).superRefine((repositories, context) => {
  const names = repositories.map((repository) => repository.name);
  if (names[0] !== "primary") context.addIssue({ code: "custom", message: "reviewed repositories must begin with primary" });
  if (new Set(names).size !== names.length || names.some((name, index) => index > 1 && names[index - 1]! >= name)) {
    context.addIssue({ code: "custom", message: "reviewed repositories must contain unique names sorted after primary" });
  }
});
const score = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const effortAxisJudgmentV1Schema = z.object({ score, rationale: nonblank }).strict();
export const effortClassificationV1Schema = z.object({
  value: z.enum(EFFORT_CLASSIFICATIONS),
  rationale: nonblank,
}).strict();
const axes = z.object({
  A: effortAxisJudgmentV1Schema,
  B: effortAxisJudgmentV1Schema,
  C: effortAxisJudgmentV1Schema,
  D: effortAxisJudgmentV1Schema,
  E: effortAxisJudgmentV1Schema,
}).strict();
export const componentEffortJudgmentV1Schema = z.object({
  component_id: componentId,
  axes,
  long_tool_loop: effortClassificationV1Schema,
  short_component: effortClassificationV1Schema,
  blocker: z.object({ answer_kind: z.enum(["number", "priority-order"]), question: nonblank }).strict().optional(),
}).strict().superRefine((judgment, context) => {
  const required = judgment.axes.D.score >= 2;
  if (required !== (judgment.blocker !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["blocker"],
      message: required
        ? "D scores of 2 or 3 require a number-or-priority blocker"
        : "blocker is permitted only for D scores of 2 or 3",
    });
  }
});
const decomposition = z.discriminatedUnion("status", [
  z.object({ status: z.literal("adequate"), rationale: nonblank }).strict(),
  z.object({ status: z.literal("undifferentiated"), rationale: nonblank, missing_boundaries: z.array(nonblank).min(1) }).strict(),
]);

const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const taskSlug = createTaskSlugV1Schema();
const phaseInstance = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u);

/**
 * The generated `effort-review.schema.json` `$defs` layout. The def names are load-bearing:
 * `projectCliOutputSchema` rewrites `taskSlug` (lookahead simplification) by name before handing
 * the document to a child host, and the document must stay self-contained because hosts cannot
 * resolve cross-document references.
 */
export const effortDocumentDefs = {
  taskSlug,
  phaseInstance,
  digest,
} as const;

export const rawEffortReviewV1Schema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlug,
  phase_instance: phaseInstance.refine((value) => value.startsWith("phase-design-"), "effort review is phase-design-only") as unknown as z.ZodType<PhaseInstanceId>,
  step: z.literal("effort_review"),
  role: z.literal("effort-reviewer"),
  subject_digest: digest,
  input_fingerprint: digest,
  component_manifest_digest: digest,
  hazard_registry_digest: digest,
  policy_id: z.literal(IMPLEMENTATION_EFFORT_POLICY_ID),
  decomposition,
  components: z.array(componentEffortJudgmentV1Schema).min(1),
}).strict().superRefine((review, context) => {
  const ids = review.components.map((component) => component.component_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["components"], message: "component judgments must have unique ids" });
  }
});

export const effortEnvelopeV1Schema = z.object({
  schema_version: z.literal("1"),
  instructions: z.literal(EFFORT_REVIEW_INSTRUCTIONS),
  artifact: z.string(),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema.refine((value) => value.startsWith("phase-design-"), "effort review is phase-design-only"),
  attempt: safeIntegerV1Schema.refine((value) => value >= 1, "attempt must be at least 1"),
  subject_digest: sha256DigestV1Schema,
  input_fingerprint: sha256DigestV1Schema,
  invocation_id: safeIdV1Schema,
  result_id: safeIdV1Schema,
  policy_id: z.literal(IMPLEMENTATION_EFFORT_POLICY_ID),
  component_manifest_digest: sha256DigestV1Schema,
  component_manifest: phaseDesignComponentManifestV1Schema,
  hazard_registry: hazardRegistryInputV1Schema,
  repositories: reviewedRepositoriesV1Schema,
}).strict() as unknown as z.ZodType<EffortEnvelopeV1>;

const effortProfileV1Schema = z.discriminatedUnion("profile_id", [
  z.object({ profile_id: z.literal("gemini-3-7-flash-max"), model: z.literal("gemini-3.7-flash"), effort: z.literal("max") }).strict(),
  z.object({ profile_id: z.literal("glm-5-3-flash-max"), model: z.literal("glm-5.3-flash"), effort: z.literal("max") }).strict(),
  z.object({ profile_id: z.literal("gpt-5-6-sol-medium"), model: z.literal("gpt-5.6-sol"), effort: z.literal("medium") }).strict(),
  z.object({ profile_id: z.literal("gpt-5-6-sol-xhigh"), model: z.literal("gpt-5.6-sol"), effort: z.literal("xhigh") }).strict(),
]) as unknown as z.ZodType<ImplementationProfileV1>;
const caveat = z.object({ code: z.enum(EFFORT_CAVEAT_CODES), message: nonblank }).strict();
const componentProfile = z.object({
  component_id: componentId,
  total: z.number().int().min(0).max(15),
  profile: effortProfileV1Schema,
  caveats: z.array(caveat),
}).strict();
const blocker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("specification-gap"), component_id: componentId, answer_kind: z.enum(["number", "priority-order"]), question: nonblank }).strict(),
  z.object({ kind: z.literal("undifferentiated-decomposition"), rationale: nonblank, missing_boundaries: z.array(nonblank).min(1) }).strict(),
]) as unknown as z.ZodType<EffortBlockerV1>;
const recommendation = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("blocked"),
    component_profiles: z.array(componentProfile),
    blockers: z.array(blocker).min(1),
  }).strict(),
  z.object({
    status: z.literal("ready"),
    component_profiles: z.array(componentProfile).min(1),
    blockers: z.array(blocker).max(0),
    phase_profile: effortProfileV1Schema,
    determining_component_ids: z.array(componentId).min(1),
  }).strict(),
]) as unknown as z.ZodType<DerivedImplementationEffortV1>;

export const effortReviewerProvenanceV1Schema = z.object({
  adapter: z.enum(ADAPTER_IDS_LOCAL),
  cli_version: nonblank,
  model_family: z.enum(MODEL_FAMILIES_LOCAL),
  model: nonblank,
  effort: z.enum(EFFORT_VALUES_LOCAL),
  invocation_id: safeIdV1Schema,
  result_id: safeIdV1Schema,
  envelope_input_digest: sha256DigestV1Schema,
  observed_output_digest: sha256DigestV1Schema,
  provider: nonblank.optional(),
  route_source: effortRouteSourceRecordSchema,
  route_override: routeOverrideRecordSchema.optional(),
  repositories: reviewedRepositoriesV1Schema,
}).strict();

export const effortAssessmentV1Schema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema.refine((value) => value.startsWith("phase-design-"), "effort review is phase-design-only"),
  attempt: safeIntegerV1Schema.refine((value) => value >= 1, "attempt must be at least 1"),
  subject_digest: sha256DigestV1Schema,
  input_fingerprint: sha256DigestV1Schema,
  component_manifest_digest: sha256DigestV1Schema,
  hazard_registry_digest: sha256DigestV1Schema,
  policy_id: z.literal(IMPLEMENTATION_EFFORT_POLICY_ID),
  decomposition,
  judgments: z.array(componentEffortJudgmentV1Schema).min(1),
  reviewer: effortReviewerProvenanceV1Schema,
  recommendation,
}).strict() as unknown as z.ZodType<EffortAssessmentV1>;

export function parseEffortEnvelopeV1(value: unknown): EffortEnvelopeV1 {
  assertPlainJson(value, "effort envelope");
  return effortEnvelopeV1Schema.parse(structuredClone(value));
}

export function parseRawEffortReviewV1(value: unknown): RawEffortReviewV1 {
  assertPlainJson(value, "raw effort review");
  return rawEffortReviewV1Schema.parse(structuredClone(value)) as unknown as RawEffortReviewV1;
}

export type EffortReviewExpectedBindingsV1 = Pick<EffortEnvelopeV1,
  "task_id" | "phase_instance" | "subject_digest" | "input_fingerprint" |
  "component_manifest_digest" | "component_manifest" | "hazard_registry" | "policy_id">;

/** Cross-checks every output binding, exact component coverage/order, and the captured E floors. */
export function deriveBoundImplementationEffortV1(
  value: unknown,
  expected: EffortReviewExpectedBindingsV1,
): Readonly<{ raw: RawEffortReviewV1; recommendation: DerivedImplementationEffortV1 }> {
  const raw = parseRawEffortReviewV1(value);
  for (const key of [
    "task_id", "phase_instance", "subject_digest", "input_fingerprint",
    "component_manifest_digest", "policy_id",
  ] as const) {
    if (raw[key] !== expected[key]) throw new TypeError(`effort review ${key} does not match its envelope`);
  }
  if (raw.hazard_registry_digest !== expected.hazard_registry.registry_digest) {
    throw new TypeError("effort review hazard_registry_digest does not match its envelope");
  }
  const expectedIds = expected.component_manifest.components.map((component) => component.id);
  const observedIds = raw.components.map((component) => component.component_id);
  if (expectedIds.length !== observedIds.length || expectedIds.some((id, index) => observedIds[index] !== id)) {
    throw new TypeError("effort review components must exactly match manifest component order");
  }
  const hazards = new Map(expected.hazard_registry.components.map((component) => [component.component_id, component]));
  for (const judgment of raw.components) {
    const hazard = hazards.get(judgment.component_id);
    if (hazard === undefined) throw new TypeError(`effort review component ${judgment.component_id} has no captured hazard input`);
    if (hazard.e_floor !== "unmatched" && judgment.axes.E.score < hazard.e_floor) {
      throw new TypeError(`effort review component ${judgment.component_id} scores E below the captured hazard floor`);
    }
  }
  return Object.freeze({ raw, recommendation: deriveImplementationEffortV1(raw) });
}

export function parseEffortAssessmentV1(value: unknown): EffortAssessmentV1 {
  assertPlainJson(value, "effort assessment");
  const parsed = effortAssessmentV1Schema.parse(structuredClone(value));
  const raw = {
    schema_version: "1",
    task_id: parsed.task_id,
    phase_instance: parsed.phase_instance,
    step: "effort_review",
    role: "effort-reviewer",
    subject_digest: parsed.subject_digest,
    input_fingerprint: parsed.input_fingerprint,
    component_manifest_digest: parsed.component_manifest_digest,
    hazard_registry_digest: parsed.hazard_registry_digest,
    policy_id: parsed.policy_id,
    decomposition: parsed.decomposition,
    components: parsed.judgments,
  } as unknown as RawEffortReviewV1;
  const derived = deriveImplementationEffortV1(raw);
  if (JSON.stringify(parsed.recommendation) !== JSON.stringify(derived)) {
    throw new TypeError("effort assessment recommendation does not match server policy");
  }
  return parsed;
}

/** Server-side mint: cross-checks child output before combining provenance and policy output. */
export function createEffortAssessmentV1(
  value: unknown,
  envelope: EffortEnvelopeV1,
  reviewer: EffortReviewerProvenanceV1,
): EffortAssessmentV1 {
  if (reviewer.invocation_id !== envelope.invocation_id || reviewer.result_id !== envelope.result_id) {
    throw new TypeError("effort reviewer provenance does not match envelope result identity");
  }
  if (reviewer.repositories.length !== envelope.repositories.length || reviewer.repositories.some((repository, index) => {
    const expected = envelope.repositories[index];
    return expected === undefined || repository.name !== expected.name ||
      repository.repository_identity_digest !== expected.repository_identity_digest || repository.commit !== expected.commit;
  })) {
    throw new TypeError("effort reviewer repository provenance does not match envelope repositories");
  }
  const derived = deriveBoundImplementationEffortV1(value, envelope);
  return parseEffortAssessmentV1({
    schema_version: "1",
    task_id: envelope.task_id,
    phase_instance: envelope.phase_instance,
    attempt: envelope.attempt,
    subject_digest: envelope.subject_digest,
    input_fingerprint: envelope.input_fingerprint,
    component_manifest_digest: envelope.component_manifest_digest,
    hazard_registry_digest: envelope.hazard_registry.registry_digest,
    policy_id: envelope.policy_id,
    decomposition: derived.raw.decomposition,
    judgments: derived.raw.components,
    reviewer,
    recommendation: derived.recommendation,
  });
}

export const IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID = "implementation-agent-selector-v2" as const;

export const EFFORT_SELECTOR_INSTRUCTIONS =
  "Select exactly one implementation profile for the phase design. Silently infer independently scoreable implementation components and score each 0-3 on A derivation depth, B verifier weakness, C state space, D specification uncertainty, and E codebase hazard; use the supplied hazard registry as repository context and include D in the sum without blocking. For each component: totals 0-2 select gemini-3-7-flash-max; totals 3-5 select glm-5-3-flash-max when E is at least 2 or a long tool loop is yes or unknown, otherwise gemini-3-7-flash-max; totals 6-7 select gemini-3-7-flash-max only when B is at most 1 and the component is confidently short, otherwise glm-5-3-flash-max; totals 8-11 select gpt-5-6-sol-medium; totals 12-15 select gpt-5-6-sol-xhigh. Return the highest-ranked selected profile across all components in that same order. Specification uncertainty and coarse decomposition affect private scoring only: never critique the plan, report an issue, ask a question, return a blocker, or suggest a revision. Return only the bound profile identifier; do not return components, scores, totals, rationales, classifications, findings, or analysis." as const;

export type RawEffortSelectionV2 = {
  readonly schema_version: "2";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly step: "effort_review";
  readonly role: "effort-reviewer";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly policy_id: typeof IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID;
  readonly profile_id: (typeof IMPLEMENTATION_PROFILE_IDS)[number];
};

export type EffortEnvelopeV2 = {
  readonly schema_version: "2";
  readonly instructions: typeof EFFORT_SELECTOR_INSTRUCTIONS;
  readonly artifact: string;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly attempt: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly invocation_id: string;
  readonly result_id: string;
  readonly policy_id: typeof IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID;
  readonly hazard_registry: Omit<HazardRegistryInputV1, "components">;
  readonly repositories: readonly ReviewedRepositoryV1[];
};

export type EffortSelectionV2 = {
  readonly schema_version: "2";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly attempt: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly policy_id: typeof IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID;
  readonly profile: ImplementationProfileV1;
  readonly source:
    | { readonly kind: "reviewer"; readonly reviewer: EffortReviewerProvenanceV1 }
    | { readonly kind: "default" };
};

export type EffortEvidence = EffortAssessmentV1 | EffortSelectionV2;

const selectorHazardInputSchema = z.object({
  schema_version: z.literal("1"),
  state: z.enum(["absent", "present"]),
  registry_digest: sha256DigestV1Schema,
  hazards: z.array(hazardRegistryEntryV1Schema),
}).strict();

export const rawEffortSelectionV2Schema = z.object({
  schema_version: z.literal("2"),
  task_id: taskSlug,
  phase_instance: phaseInstance.refine((value) => value.startsWith("phase-design-"), "effort selection is phase-design-only") as unknown as z.ZodType<PhaseInstanceId>,
  step: z.literal("effort_review"),
  role: z.literal("effort-reviewer"),
  subject_digest: digest,
  input_fingerprint: digest,
  policy_id: z.literal(IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID),
  profile_id: z.enum(IMPLEMENTATION_PROFILE_IDS),
}).strict() as unknown as z.ZodType<RawEffortSelectionV2>;

export const effortEnvelopeV2Schema = z.object({
  schema_version: z.literal("2"),
  instructions: z.literal(EFFORT_SELECTOR_INSTRUCTIONS),
  artifact: z.string(),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema.refine((value) => value.startsWith("phase-design-"), "effort selection is phase-design-only"),
  attempt: safeIntegerV1Schema.refine((value) => value >= 1, "attempt must be at least 1"),
  subject_digest: sha256DigestV1Schema,
  input_fingerprint: sha256DigestV1Schema,
  invocation_id: safeIdV1Schema,
  result_id: safeIdV1Schema,
  policy_id: z.literal(IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID),
  hazard_registry: selectorHazardInputSchema,
  repositories: reviewedRepositoriesV1Schema,
}).strict() as unknown as z.ZodType<EffortEnvelopeV2>;

export const effortSelectionV2Schema = z.object({
  schema_version: z.literal("2"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema.refine((value) => value.startsWith("phase-design-"), "effort selection is phase-design-only"),
  attempt: safeIntegerV1Schema.refine((value) => value >= 1, "attempt must be at least 1"),
  subject_digest: sha256DigestV1Schema,
  input_fingerprint: sha256DigestV1Schema,
  policy_id: z.literal(IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID),
  profile: effortProfileV1Schema,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("reviewer"), reviewer: effortReviewerProvenanceV1Schema }).strict(),
    z.object({ kind: z.literal("default") }).strict(),
  ]),
}).strict() as unknown as z.ZodType<EffortSelectionV2>;

export const effortEvidenceSchema = z.union([
  effortAssessmentV1Schema,
  effortSelectionV2Schema,
]) as unknown as z.ZodType<EffortEvidence>;

export function parseEffortEnvelopeV2(value: unknown): EffortEnvelopeV2 {
  assertPlainJson(value, "effort selector envelope");
  return effortEnvelopeV2Schema.parse(structuredClone(value));
}

function selectionCommon(envelope: EffortEnvelopeV2) {
  return {
    schema_version: "2" as const,
    task_id: envelope.task_id,
    phase_instance: envelope.phase_instance,
    attempt: envelope.attempt,
    subject_digest: envelope.subject_digest,
    input_fingerprint: envelope.input_fingerprint,
    policy_id: envelope.policy_id,
  };
}

export function createEffortSelectionV2(
  value: unknown,
  envelope: EffortEnvelopeV2,
  reviewer: EffortReviewerProvenanceV1,
): EffortSelectionV2 {
  assertPlainJson(value, "raw effort selection");
  const raw = rawEffortSelectionV2Schema.parse(structuredClone(value));
  for (const key of ["task_id", "phase_instance", "subject_digest", "input_fingerprint", "policy_id"] as const) {
    if (raw[key] !== envelope[key]) throw new TypeError(`effort selection ${key} does not match its envelope`);
  }
  if (reviewer.invocation_id !== envelope.invocation_id || reviewer.result_id !== envelope.result_id) {
    throw new TypeError("effort selector provenance does not match envelope result identity");
  }
  if (reviewer.repositories.length !== envelope.repositories.length || reviewer.repositories.some((repository, index) => {
    const expected = envelope.repositories[index];
    return expected === undefined || repository.name !== expected.name ||
      repository.repository_identity_digest !== expected.repository_identity_digest || repository.commit !== expected.commit;
  })) {
    throw new TypeError("effort selector repository provenance does not match envelope repositories");
  }
  return effortSelectionV2Schema.parse({
    ...selectionCommon(envelope),
    profile: IMPLEMENTATION_PROFILES[raw.profile_id],
    source: { kind: "reviewer", reviewer },
  });
}

export function createDefaultEffortSelectionV2(envelope: EffortEnvelopeV2): EffortSelectionV2 {
  return effortSelectionV2Schema.parse({
    ...selectionCommon(envelope),
    profile: DEFAULT_IMPLEMENTATION_PROFILE,
    source: { kind: "default" },
  });
}
