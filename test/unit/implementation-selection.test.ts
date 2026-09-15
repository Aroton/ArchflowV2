import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENTATION_SETTINGS, IMPLEMENTATION_DIFFICULTIES, implementationConfigSchema,
  implementationSelectionInputSchema, selectImplementationModel,
  type ImplementationSelectionInput, type ImplementationSettings,
} from "../../src/contracts/implementation-selection.js";
import {
  EFFORT_SELECTOR_INSTRUCTIONS, IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
  createDefaultEffortSelectionV3, createEffortSelectionV3, effortEvidenceSchema,
  parseEffortEnvelopeV3, rawEffortSelectionV3Schema, type EffortReviewerProvenanceV1,
} from "../../src/contracts/effort-review.js";
import { implementationRecommendationFromAssessment, implementationRecommendationV1Schema } from "../../src/contracts/semantic-workflow.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { loadImplementationSelectionInput } from "../../src/review/implementation-models.js";

const captured = await loadImplementationSelectionInput(undefined);
if (captured.status !== "ready") throw new Error(captured.explanation);
const baseline = captured;
const configured = (settings: Partial<ImplementationSettings>): ImplementationSelectionInput => ({
  ...baseline, settings: { ...baseline.settings, ...settings },
});
const decide = (settings: Partial<ImplementationSettings>, difficulty: (typeof IMPLEMENTATION_DIFFICULTIES)[number] = "routine") =>
  selectImplementationModel(configured(settings), difficulty, "Reviewed design supplies the steps.");

function envelope(selection_input = captured) {
  return parseEffortEnvelopeV3({
    schema_version: "3", task_id: "selection-test", phase_instance: "phase-design-1", attempt: 1,
    subject_digest: "a".repeat(64), input_fingerprint: "b".repeat(64), invocation_id: "effort-test", result_id: "effort-result",
    artifact: "# Phase design", instructions: EFFORT_SELECTOR_INSTRUCTIONS, policy_id: IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
    hazard_registry: { schema_version: "1", state: "absent", registry_digest: "c".repeat(64), hazards: [] },
    repositories: [{ name: "primary", repository_identity_digest: "d".repeat(64), commit: "e".repeat(40) }],
    selection_input,
  });
}
const input = envelope();
const reviewer = {
  adapter: "codex-cli", cli_version: "fixture", model_family: "codex", model: "gpt-5.6-luna", effort: "xhigh",
  invocation_id: input.invocation_id, result_id: input.result_id,
  envelope_input_digest: "1".repeat(64), observed_output_digest: "2".repeat(64),
  route_source: { provenance: "configured" }, repositories: input.repositories,
} as unknown as EffortReviewerProvenanceV1;
const assessment = (difficulty = "routine") => ({
  schema_version: "3", task_id: input.task_id, phase_instance: input.phase_instance, step: "effort_review", role: "effort-reviewer",
  subject_digest: input.subject_digest, input_fingerprint: input.input_fingerprint, policy_id: input.policy_id,
  difficulty, rationale: "The reviewed design supplies every operation and validation step.",
});

describe("benchmark implementation selection", () => {
  it("records all screenshot scores and exact benchmark qualifications", () => {
    expect(Object.fromEntries(baseline.catalog.profiles.map(p => [p.profile_id, p.score]))).toEqual({
      "gpt-6-astra-high": 54, "claude-fable-5-1-high": 52, "claude-opus-5-xhigh": 46.5,
      "claude-opus-5-high": 46, "claude-fable-5-1-medium": 44.9, "gpt-6-astra-low": 41.9,
      "glm-5-3-max": 41.9, "muse-spark-1-3-max": 33.3, "glm-5-3-flash": 32.8,
      "gpt-5-6-sol-xhigh": 24.7, "gpt-5-6-sol-high": 20.7, "gemini-3-8-flash-high": 19.7,
    });
    expect(baseline.catalog.profiles.find(p => p.profile_id === "glm-5-3-flash")).not.toHaveProperty("effort");
    expect(baseline.catalog.profiles.filter(p => p.qualifier).map(p => p.qualifier)).toEqual(["with fallback", "with fallback"]);
  });

  it("keeps the template defaults and complete comment catalog aligned", async () => {
    const template = await readFile(new URL("../../assets/config.template.yaml", import.meta.url), "utf8");
    expect(parseConfigYaml(template).implementation).toEqual(DEFAULT_IMPLEMENTATION_SETTINGS);
    for (const profile of baseline.catalog.profiles) expect(template).toContain(`#   - ${profile.profile_id} #`);
  });

  it("chooses GLM Flash, GLM Flash, GLM max, and Astra high with default subscriptions", () => {
    expect(IMPLEMENTATION_DIFFICULTIES.map(difficulty => decide({}, difficulty))).toMatchObject([
      { model: "glm-5.3-flash" }, { model: "glm-5.3-flash" },
      { model: "glm-5.3", effort: "max" }, { model: "gpt-6-astra", effort: "high" },
    ]);
  });

  it("uses Gemini without GLM and honors opting into Muse", () => {
    expect(decide({ enabled_profiles: baseline.settings.enabled_profiles.filter(id => !id.startsWith("glm")) }))
      .toMatchObject({ model: "gemini-3.8-flash-high", effort: "high" });
    expect(decide({ enabled_profiles: ["muse-spark-1-3-max"] }))
      .toMatchObject({ model: "muse-spark-1.3", effort: "max" });
  });

  it("honors reordered costs and within-group profile preference without chasing extra points", () => {
    expect(decide({ cost_priority: ["google", "muse", "zai", "gpt", "claude"] })).toMatchObject({ model: "gemini-3.8-flash-high" });
    expect(decide({ enabled_profiles: ["gpt-5-6-sol-high", "gpt-5-6-sol-xhigh"] })).toMatchObject({ effort: "high" });
    expect(decide({ enabled_profiles: ["gpt-5-6-sol-xhigh", "gpt-5-6-sol-high"] })).toMatchObject({ effort: "xhigh" });
  });

  it("uses inclusive thresholds and never crosses the hard minimum", () => {
    expect(decide({ minimum_score: 19.7, enabled_profiles: ["gemini-3-8-flash-high"] })).toMatchObject({ status: "ready" });
    expect(decide({ minimum_score: 19.8, enabled_profiles: ["gemini-3-8-flash-high"] })).toMatchObject({ status: "unavailable" });
    const thresholds = { routine: 32.8, "bounded-reasoning": 40, hard: 45, exceptional: 50 };
    expect(decide({ difficulty_thresholds: thresholds })).toMatchObject({ model: "glm-5.3-flash" });
    expect(decide({ difficulty_thresholds: { ...thresholds, routine: 32.9 } })).toMatchObject({ model: "glm-5.3", effort: "max" });
  });

  it("uses the best enabled score on shortfall, with cost ordering only for equal scores", () => {
    const advice = decide({ enabled_profiles: ["gemini-3-8-flash-high", "muse-spark-1-3-max"] }, "hard");
    expect(advice).toMatchObject({ model: "muse-spark-1.3", rationale: expect.stringContaining("6.7 percentage points short") });
    expect(decide({ enabled_profiles: ["gpt-6-astra-low", "glm-5-3-max"] }, "exceptional")).toMatchObject({ model: "glm-5.3" });
    expect(decide({ enabled_profiles: [] })).toMatchObject({ status: "unavailable" });
  });

  it("supports added catalog models and unspecified effort without code changes", () => {
    const extra = { profile_id: "new-model", model: "new-model", cost_group: "muse", score: 35 };
    const value: ImplementationSelectionInput = { ...baseline,
      catalog: { ...baseline.catalog, profiles: [...baseline.catalog.profiles, extra] },
      settings: { ...baseline.settings, enabled_profiles: [extra.profile_id] },
    };
    const advice = selectImplementationModel(value, "routine", "Specified operations.");
    expect(advice).toMatchObject({ model: "new-model" });
    expect(advice).not.toHaveProperty("effort");
    expect(implementationRecommendationV1Schema.parse(advice)).toEqual(advice);
    expect(decide({ enabled_profiles: ["glm-5-3-flash"] })).not.toHaveProperty("effort");
    expect(decide({ enabled_profiles: ["claude-fable-5-1-high"] })).toMatchObject({ rationale: expect.stringContaining("with fallback") });
  });

  it("rejects invalid data rather than substituting unconfigured models", async () => {
    for (const config of [{ minimum_score: 101 }, { minimum_score: -1 }, { enabled_profiles: ["x", "x"] }, { cost_priority: [] },
      { difficulty_thresholds: { routine: 40, "bounded-reasoning": 30, hard: 40, exceptional: 50 } }]) {
      expect(() => implementationConfigSchema.parse(config)).toThrow();
    }
    expect(() => implementationSelectionInputSchema.parse(configured({ enabled_profiles: ["unknown-model"] }))).toThrow(/Unknown/);
    expect(await loadImplementationSelectionInput({ enabled_profiles: ["unknown-model"] })).toMatchObject({ status: "unavailable" });
    expect(await loadImplementationSelectionInput({ cost_priority: ["gpt"] })).toMatchObject({ status: "unavailable" });
    expect(await loadImplementationSelectionInput(undefined, "/nonexistent-implementation-catalog")).toMatchObject({ status: "unavailable" });
  });

  it("reads catalog edits for future assessments without reinterpreting an earlier result", async () => {
    const root = await mkdtemp(join(tmpdir(), "implementation-catalog-"));
    try {
      const path = join(root, "implementation-models.yaml");
      await writeFile(path, JSON.stringify(baseline.catalog));
      const first = await loadImplementationSelectionInput(undefined, root);
      const earlier = createEffortSelectionV3(assessment(), envelope(first), reviewer);
      const changed = { ...baseline.catalog, profiles: baseline.catalog.profiles.map(profile =>
        profile.cost_group === "zai" ? { ...profile, score: 18 } : profile) };
      await writeFile(path, JSON.stringify(changed));
      const next = await loadImplementationSelectionInput(undefined, root);
      expect(createEffortSelectionV3(assessment(), envelope(next), reviewer).recommendation).toMatchObject({ model: "gemini-3.8-flash-high" });
      expect(implementationRecommendationFromAssessment(earlier, 1)).toMatchObject({ model: "glm-5.3-flash" });
      await writeFile(path, "profiles: [broken");
      expect(await loadImplementationSelectionInput(undefined, root)).toMatchObject({ status: "unavailable" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects accessor-backed caller input before reading it repeatedly", () => {
    let reads = 0;
    const value = { ...baseline, get settings() { reads++; return baseline.settings; } };
    expect(() => selectImplementationModel(value, "routine", "Specified steps.")).toThrow();
    expect(reads).toBe(0);
  });
});

describe("captured difficulty evidence", () => {
  it("binds difficulty to the subject and preserves immutable advice across later settings changes", () => {
    const evidence = createEffortSelectionV3(assessment(), input, reviewer);
    expect(effortEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(implementationRecommendationFromAssessment(evidence, 1)).toMatchObject({ model: "glm-5.3-flash" });
    const changed = envelope(configured({ enabled_profiles: ["gemini-3-8-flash-high"] }));
    expect(createEffortSelectionV3(assessment(), changed, reviewer).recommendation).toMatchObject({ model: "gemini-3.8-flash-high" });
    expect(implementationRecommendationFromAssessment(evidence, 1)).toEqual(evidence.recommendation);
    expect(() => createEffortSelectionV3({ ...assessment(), subject_digest: "f".repeat(64) }, input, reviewer)).toThrow(/subject_digest/);
    expect(() => effortEvidenceSchema.parse({ ...evidence, recommendation: { ...evidence.recommendation, model: "gpt-6-astra" } })).toThrow();
    expect(effortEvidenceSchema.safeParse({ ...evidence, selection_input: configured({ enabled_profiles: ["unknown-model"] }) }).success).toBe(false);
  });

  it("uses bounded reasoning on failure and still respects enabled profiles and unavailable data", () => {
    expect(createDefaultEffortSelectionV3(input)).toMatchObject({ difficulty: "bounded-reasoning", source: { kind: "default" },
      recommendation: { model: "glm-5.3-flash", rationale: expect.stringContaining("fallback") } });
    expect(createDefaultEffortSelectionV3(envelope(configured({ enabled_profiles: ["gemini-3-8-flash-high"] })))).toMatchObject({
      recommendation: { model: "gemini-3.8-flash-high", rationale: expect.stringContaining("short") },
    });
    expect(createDefaultEffortSelectionV3(envelope({ status: "unavailable", explanation: "Catalog missing." }))).toMatchObject({
      recommendation: { status: "unavailable", explanation: "Catalog missing." },
    });
  });

  it("requires an explanation and refuses model choices in fresh reviewer output", () => {
    const { rationale: _rationale, ...missing } = assessment();
    expect(() => rawEffortSelectionV3Schema.parse(missing)).toThrow();
    for (const extra of [{ profile_id: "gpt-6-astra-high" }, { model: "gpt-6-astra" }, { file_count: 100 }]) {
      expect(() => rawEffortSelectionV3Schema.parse({ ...assessment(), ...extra })).toThrow();
    }
  });
});
