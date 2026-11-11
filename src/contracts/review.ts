import { z } from "zod";

export const MODEL_FAMILIES = ["claude", "codex", "gemini"] as const;
export const ADAPTER_IDS = ["claude-cli", "codex-cli", "antigravity-cli"] as const;
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export type AdapterId = (typeof ADAPTER_IDS)[number];

export type RuleVersionRef = {
  readonly rule_id: string;
  readonly rule_version: number;
};

export const ROUTE_SOURCE_PROVENANCES = ["configured", "invocation-declared"] as const;

/** Raw configured route facts displaced by a per-call route; dispatchability is not implied. */
export type DisplacedRouteRecord = {
  readonly source: "configured";
  readonly model: string;
  readonly effort: (typeof EFFORT_VALUES)[number];
  readonly provider?: string;
};

/** Truthful source of the route that produced freshly server-attested evidence. */
export type RouteSourceRecord = {
  readonly provenance: (typeof ROUTE_SOURCE_PROVENANCES)[number];
  readonly displaced?: DisplacedRouteRecord;
};

/** Plain object root for every CLI host. Blank or unstructured output is not signoff. */
export const reviewReportOutputSchema = z.object({
  outcome: z.enum(["issues_found", "no_issues_found"]),
  feedback: z.string().min(1).regex(/\S/u),
}).strict();
