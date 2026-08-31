import type { RawEffortReviewV1 } from "../contracts/effort-review.js";

export const IMPLEMENTATION_EFFORT_POLICY_ID = "implementation-effort-v1" as const;

export const IMPLEMENTATION_PROFILE_IDS = [
  "gemini-3-7-flash-max",
  "glm-5-3-flash-max",
  "gpt-5-6-sol-medium",
  "gpt-5-6-sol-xhigh",
] as const;

export type ImplementationProfileIdV1 = (typeof IMPLEMENTATION_PROFILE_IDS)[number];

export type ImplementationProfileV1 = {
  readonly profile_id: ImplementationProfileIdV1;
  readonly model: "gemini-3.7-flash" | "glm-5.3-flash" | "gpt-5.6-sol";
  readonly effort: "medium" | "xhigh" | "max";
};

export type ComponentEffortProfileV1 = {
  readonly component_id: string;
  readonly total: number;
  readonly profile: ImplementationProfileV1;
  readonly caveats: readonly EffortCaveatV1[];
};

export const EFFORT_CAVEAT_CODES = [
  "long-loop-unknown-conservative-glm",
  "short-component-unknown-conservative-glm",
] as const;

export type EffortCaveatV1 = {
  readonly code: (typeof EFFORT_CAVEAT_CODES)[number];
  readonly message: string;
};

export type EffortBlockerV1 =
  | {
      readonly kind: "specification-gap";
      readonly component_id: string;
      readonly answer_kind: "number" | "priority-order";
      readonly question: string;
    }
  | {
      readonly kind: "undifferentiated-decomposition";
      readonly rationale: string;
      readonly missing_boundaries: readonly string[];
    };

export type DerivedImplementationEffortV1 =
  | {
      readonly status: "blocked";
      readonly component_profiles: readonly ComponentEffortProfileV1[];
      readonly blockers: readonly EffortBlockerV1[];
    }
  | {
      readonly status: "ready";
      readonly component_profiles: readonly ComponentEffortProfileV1[];
      readonly blockers: readonly [];
      readonly phase_profile: ImplementationProfileV1;
      readonly determining_component_ids: readonly string[];
    };

const PROFILES: Readonly<Record<ImplementationProfileIdV1, ImplementationProfileV1>> = Object.freeze({
  "gemini-3-7-flash-max": Object.freeze({ profile_id: "gemini-3-7-flash-max", model: "gemini-3.7-flash", effort: "max" }),
  "glm-5-3-flash-max": Object.freeze({ profile_id: "glm-5-3-flash-max", model: "glm-5.3-flash", effort: "max" }),
  "gpt-5-6-sol-medium": Object.freeze({ profile_id: "gpt-5-6-sol-medium", model: "gpt-5.6-sol", effort: "medium" }),
  "gpt-5-6-sol-xhigh": Object.freeze({ profile_id: "gpt-5-6-sol-xhigh", model: "gpt-5.6-sol", effort: "xhigh" }),
});

const PROFILE_RANK: Readonly<Record<ImplementationProfileIdV1, number>> = Object.freeze({
  "gemini-3-7-flash-max": 0,
  "glm-5-3-flash-max": 1,
  "gpt-5-6-sol-medium": 2,
  "gpt-5-6-sol-xhigh": 3,
});

function profileFor(judgment: RawEffortReviewV1["components"][number], total: number): Readonly<{
  profile: ImplementationProfileV1;
  caveats: readonly EffortCaveatV1[];
}> {
  if (total <= 2) return { profile: PROFILES["gemini-3-7-flash-max"], caveats: [] };
  if (total <= 5) {
    if (judgment.axes.E.score >= 2 || judgment.long_tool_loop.value === "yes") {
      return { profile: PROFILES["glm-5-3-flash-max"], caveats: [] };
    }
    if (judgment.long_tool_loop.value === "unknown") {
      return {
        profile: PROFILES["glm-5-3-flash-max"],
        caveats: [{
          code: "long-loop-unknown-conservative-glm",
          message: "Long-loop behavior is unknown, so the conservative GLM profile applies.",
        }],
      };
    }
    return { profile: PROFILES["gemini-3-7-flash-max"], caveats: [] };
  }
  if (total <= 7) {
    if (judgment.axes.B.score <= 1 && judgment.short_component.value === "yes") {
      return { profile: PROFILES["gemini-3-7-flash-max"], caveats: [] };
    }
    if (judgment.axes.B.score <= 1 && judgment.short_component.value === "unknown") {
      return {
        profile: PROFILES["glm-5-3-flash-max"],
        caveats: [{
          code: "short-component-unknown-conservative-glm",
          message: "Short-component suitability is unknown, so the conservative GLM profile applies.",
        }],
      };
    }
    return { profile: PROFILES["glm-5-3-flash-max"], caveats: [] };
  }
  if (total <= 11) return { profile: PROFILES["gpt-5-6-sol-medium"], caveats: [] };
  return { profile: PROFILES["gpt-5-6-sol-xhigh"], caveats: [] };
}

/**
 * The sole implementation-recommendation policy. Its input is already schema-validated raw
 * reviewer output; it derives every total, blocker, conditional fallback, and phase maximum.
 */
export function deriveImplementationEffortV1(raw: RawEffortReviewV1): DerivedImplementationEffortV1 {
  const blockers: EffortBlockerV1[] = [];
  if (raw.decomposition.status === "undifferentiated") {
    blockers.push({
      kind: "undifferentiated-decomposition",
      rationale: raw.decomposition.rationale,
      missing_boundaries: raw.decomposition.missing_boundaries,
    });
  }

  const componentProfiles: ComponentEffortProfileV1[] = [];
  for (const judgment of raw.components) {
    if (judgment.axes.D.score >= 2) {
      blockers.push({
        kind: "specification-gap",
        component_id: judgment.component_id,
        answer_kind: judgment.blocker!.answer_kind,
        question: judgment.blocker!.question,
      });
      continue;
    }
    const total = Object.values(judgment.axes).reduce((sum, axis) => sum + axis.score, 0);
    const selected = profileFor(judgment, total);
    componentProfiles.push({
      component_id: judgment.component_id,
      total,
      profile: selected.profile,
      caveats: selected.caveats,
    });
  }

  if (blockers.length > 0) {
    return Object.freeze({
      status: "blocked",
      component_profiles: Object.freeze(componentProfiles),
      blockers: Object.freeze(blockers),
    });
  }

  const maximumRank = Math.max(...componentProfiles.map((component) => PROFILE_RANK[component.profile.profile_id]));
  const determining = componentProfiles
    .filter((component) => PROFILE_RANK[component.profile.profile_id] === maximumRank)
    .map((component) => component.component_id);
  return Object.freeze({
    status: "ready",
    component_profiles: Object.freeze(componentProfiles),
    blockers: Object.freeze([]) as readonly [],
    phase_profile: componentProfiles.find((component) => PROFILE_RANK[component.profile.profile_id] === maximumRank)!.profile,
    determining_component_ids: Object.freeze(determining),
  });
}
