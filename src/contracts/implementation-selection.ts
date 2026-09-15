import { z } from "zod";
import { assertPlainJson } from "./plain-json.js";

export const IMPLEMENTATION_DIFFICULTIES = ["routine", "bounded-reasoning", "hard", "exceptional"] as const;
export type ImplementationDifficulty = (typeof IMPLEMENTATION_DIFFICULTIES)[number];
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const nonBlank = z.string().min(1).regex(/\S/u);
const score = z.number().finite().min(0).max(100);
const uniqueIds = z.array(identifier).refine(values => new Set(values).size === values.length, "entries must not repeat");

export const difficultyThresholdsSchema = z.object({
  routine: score,
  "bounded-reasoning": score,
  hard: score,
  exceptional: score,
}).strict().refine(value => IMPLEMENTATION_DIFFICULTIES.every((key, index) =>
  index === 0 || value[key] >= value[IMPLEMENTATION_DIFFICULTIES[index - 1]!]), "difficulty thresholds must not decrease");

export const implementationConfigSchema = z.object({
  enabled_profiles: uniqueIds.optional(),
  cost_priority: uniqueIds.min(1).optional(),
  minimum_score: score.optional(),
  difficulty_thresholds: difficultyThresholdsSchema.optional(),
}).strict();

export type ImplementationSettings = {
  readonly enabled_profiles: readonly string[];
  readonly cost_priority: readonly string[];
  readonly minimum_score: number;
  readonly difficulty_thresholds: Readonly<Record<ImplementationDifficulty, number>>;
};
export const DEFAULT_IMPLEMENTATION_SETTINGS: ImplementationSettings = Object.freeze({
  enabled_profiles: Object.freeze([
    "glm-5-3-flash", "glm-5-3-max", "gemini-3-8-flash-high", "gpt-5-6-sol-high",
    "gpt-5-6-sol-xhigh", "gpt-6-astra-low", "gpt-6-astra-high",
  ]),
  cost_priority: Object.freeze(["zai", "google", "gpt", "claude", "muse"]),
  minimum_score: 19,
  difficulty_thresholds: Object.freeze({ routine: 19, "bounded-reasoning": 30, hard: 40, exceptional: 50 }),
});
export const implementationSettingsSchema = implementationConfigSchema.required();

export type BenchmarkProfile = {
  readonly profile_id: string;
  readonly model: string;
  readonly effort?: string;
  readonly cost_group: string;
  readonly score: number;
  readonly qualifier?: string;
};
export const benchmarkProfileSchema = z.object({
  profile_id: identifier, model: identifier, effort: identifier.optional(), cost_group: identifier,
  score, qualifier: nonBlank.optional(),
}).strict();
export type ImplementationCatalog = {
  readonly schema_version: "1";
  readonly benchmark: string;
  readonly source: string;
  readonly captured_on: string;
  readonly profiles: readonly BenchmarkProfile[];
};
export const implementationCatalogSchema = z.object({
  schema_version: z.literal("1"), benchmark: nonBlank, source: nonBlank,
  captured_on: z.iso.date(),
  profiles: z.array(benchmarkProfileSchema).min(1).refine(profiles =>
    new Set(profiles.map(profile => profile.profile_id)).size === profiles.length, "profile IDs must not repeat"),
}).strict();

export type ImplementationSelectionInput =
  | { readonly status: "ready"; readonly catalog: ImplementationCatalog; readonly settings: ImplementationSettings }
  | { readonly status: "unavailable"; readonly explanation: string };
export const implementationSelectionInputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), catalog: implementationCatalogSchema, settings: implementationSettingsSchema }).strict(),
  z.object({ status: z.literal("unavailable"), explanation: nonBlank }).strict(),
]).superRefine((input, context) => {
  if (input.status !== "ready") return;
  for (const id of input.settings.enabled_profiles) {
    const profile = input.catalog.profiles.find(entry => entry.profile_id === id);
    if (profile === undefined) context.addIssue({ code: "custom", message: `Unknown implementation profile: ${id}` });
    else if (!input.settings.cost_priority.includes(profile.cost_group)) {
      context.addIssue({ code: "custom", message: `Missing cost priority for ${profile.cost_group}` });
    }
  }
});

export type BenchmarkRecommendation =
  | { readonly status: "ready"; readonly model: string; readonly effort?: string; readonly rationale: string }
  | { readonly status: "unavailable"; readonly reason: "selection-unavailable"; readonly explanation: string };
export const benchmarkRecommendationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), model: identifier, effort: identifier.optional(), rationale: nonBlank }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.literal("selection-unavailable"), explanation: nonBlank }).strict(),
]);

/** A pure selection: model names and benchmark scores never enter the reviewer's judgment. */
export function selectImplementationModel(
  value: ImplementationSelectionInput,
  difficulty: ImplementationDifficulty,
  reasoning: string,
  fallback = false,
): BenchmarkRecommendation {
  assertPlainJson(value, "implementation selection input");
  const input = implementationSelectionInputSchema.parse(structuredClone(value)) as ImplementationSelectionInput;
  const unavailable = (explanation: string): BenchmarkRecommendation => ({ status: "unavailable", reason: "selection-unavailable", explanation });
  if (input.status === "unavailable") return unavailable(input.explanation);
  const { catalog, settings } = input;
  const enabled = settings.enabled_profiles.map(id => catalog.profiles.find(profile => profile.profile_id === id)!)
    .filter(profile => profile.score >= settings.minimum_score);
  if (enabled.length === 0) return unavailable(`No enabled implementation profile meets the ${settings.minimum_score}% minimum score.`);
  const threshold = Math.max(settings.minimum_score, settings.difficulty_thresholds[difficulty]);
  const qualified = enabled.filter(profile => profile.score >= threshold);
  const compareCost = (a: BenchmarkProfile, b: BenchmarkProfile): number =>
    settings.cost_priority.indexOf(a.cost_group) - settings.cost_priority.indexOf(b.cost_group) ||
    settings.enabled_profiles.indexOf(a.profile_id) - settings.enabled_profiles.indexOf(b.profile_id);
  const selected = qualified.length > 0
    ? qualified.sort(compareCost)[0]!
    : enabled.sort((a, b) => b.score - a.score || compareCost(a, b))[0]!;
  const explanation = qualified.length > 0
    ? "Cheapest eligible cost group; configured profile order breaks ties within the group."
    : `No enabled profile meets the threshold; the best available score is ${Number((threshold - selected.score).toFixed(1))} percentage points short.`;
  return {
    status: "ready", model: selected.model,
    ...(selected.effort === undefined ? {} : { effort: selected.effort }),
    rationale: `${fallback ? "Difficulty assessment failed; using the bounded-reasoning fallback. " : ""}${reasoning} Difficulty: ${difficulty}; required score: ${threshold}%. ${catalog.benchmark}: ${selected.score}%${selected.qualifier === undefined ? "" : ` (${selected.qualifier})`}. ${explanation}`,
  };
}

/** Read-only public catalog for launch configuration; never workflow authority. */
export const implementationProfilesSchema = z.object({
  schema_version: z.literal("1"), task_id: identifier,
  profiles: z.array(z.object({
    profile_id: identifier, model: identifier, effort: identifier.optional(), enabled: z.boolean(),
  }).strict()),
}).strict();
export type ImplementationProfiles = z.infer<typeof implementationProfilesSchema>;

export function projectImplementationProfiles(taskId: string, input: Extract<ImplementationSelectionInput, { status: "ready" }>): ImplementationProfiles {
  return implementationProfilesSchema.parse({
    schema_version: "1", task_id: taskId,
    profiles: input.catalog.profiles.map(profile => ({
      profile_id: profile.profile_id, model: profile.model,
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      enabled: input.settings.enabled_profiles.includes(profile.profile_id),
    })),
  });
}
