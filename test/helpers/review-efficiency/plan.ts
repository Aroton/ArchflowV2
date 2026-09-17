/**
 * Fixed experiment plan: the frozen cases, the balanced twelve-group variant order, the
 * hidden quality oracles, the one permitted route, and the derived real-host test timeout.
 */

import type { AdjudicationRuleSlotV1 } from "../../../src/contracts/adjudication.js";
import { MAX_DISPATCHES } from "../../../src/dispatch/recovery.js";
import { routeFromConfiguredRoute, type DispatchRoute } from "../../../src/dispatch/routing.js";

// ---------------------------------------------------------------------------
// Constants and plan
// ---------------------------------------------------------------------------

export const REVIEW_EFFICIENCY_OPT_IN_ENV = "ARCHFLOW_REVIEW_EFFICIENCY";
export const REVIEW_EFFICIENCY_STAGE_ENV = "ARCHFLOW_REVIEW_EFFICIENCY_STAGE";
export const REVIEW_EFFICIENCY_OUTPUT_ENV = "ARCHFLOW_REVIEW_EFFICIENCY_OUTPUT";
export const CHECKPOINT_FILENAME = "checkpoint.json";
export const PENDING_FILENAME = "checkpoint.pending";
export const EXPERIMENT_VERSION = "1";

/** Mirrors the production per-role dispatch bound and its 1s/4s transient backoff. */
export const MAX_ROLE_ATTEMPTS = MAX_DISPATCHES;
export const TRANSIENT_BACKOFF_MS = [1_000, 4_000] as const;

/**
 * Outer real-host test timeout derived from the actual execution bounds: Claude preflight's two
 * sequential child processes, every group's three-attempt transient budget plus backoff, and a
 * fixed allowance for fixture setup, checkpoint writes, parsing, and final composition. Sibling
 * roles are concurrent, so their process bounds are not added within a group.
 */
export const REVIEW_EFFICIENCY_TEST_TIMEOUT_MS =
  2 * 900_000 + 12 * (MAX_DISPATCHES * 900_000 + 5_000) + 300_000;

/** The fixed experimental route. Every run records the CLI's actually accepted model. */
export const REVIEW_EFFICIENCY_ROUTE: DispatchRoute = routeFromConfiguredRoute({
  model: "claude-opus-5",
  effort: "high",
});

export const CASE_IDS = [
  "document-control",
  "document-defect",
  "implementation-control",
  "unchanged-caller-defect",
  "localized-correction",
  "correction-regression",
] as const;
export type CaseId = (typeof CASE_IDS)[number];
export type EfficiencyVariant = "old" | "new";
export type EfficiencyRole = "general" | "test" | "constitution";

export const DOCUMENT_CASES: readonly CaseId[] = ["document-control", "document-defect"];
export const IMPLEMENTATION_CASES: readonly CaseId[] = [
  "implementation-control",
  "unchanged-caller-defect",
  "localized-correction",
  "correction-regression",
];

export function rolesForCase(caseId: CaseId): readonly EfficiencyRole[] {
  return DOCUMENT_CASES.includes(caseId) ? ["general"] : ["general", "test", "constitution"];
}

export type GroupPlanEntry = Readonly<{
  order: number;
  group_id: string;
  pass: "a" | "b";
  case_id: CaseId;
  variant: EfficiencyVariant;
  roles: readonly EfficiencyRole[];
}>;

/**
 * The twelve variant groups in the fixed balanced order. Pass A reviews half the cases with the
 * old instructions and half with the new; Pass B mirrors it, so neither method is uniformly
 * first. This reduces a simple old-first cache/order bias without eliminating provider variance.
 */
export const GROUP_PLAN: readonly GroupPlanEntry[] = Object.freeze([
  group(1, "a", "document-control", "old"),
  group(2, "a", "document-defect", "new"),
  group(3, "a", "implementation-control", "old"),
  group(4, "a", "unchanged-caller-defect", "new"),
  group(5, "a", "localized-correction", "old"),
  group(6, "a", "correction-regression", "new"),
  group(7, "b", "document-control", "new"),
  group(8, "b", "document-defect", "old"),
  group(9, "b", "implementation-control", "new"),
  group(10, "b", "unchanged-caller-defect", "old"),
  group(11, "b", "localized-correction", "new"),
  group(12, "b", "correction-regression", "old"),
]);

function group(order: number, pass: "a" | "b", caseId: CaseId, variant: EfficiencyVariant): GroupPlanEntry {
  return Object.freeze({
    order,
    group_id: `g${String(order)}`,
    pass,
    case_id: caseId,
    variant,
    roles: rolesForCase(caseId),
  });
}

/** Planned fresh-session model turns: 2 document × 1 role + 4 implementation × 3 roles, × 2 variants. */
export const PLANNED_TURNS = GROUP_PLAN.reduce((total, entry) => total + entry.roles.length, 0);

/**
 * The hidden quality oracle per case. Scoring notes for the human assessment; never dispatched.
 */
export const CASE_ORACLE_CONTRACT: readonly Readonly<{
  case_id: CaseId;
  kind: "control" | "seeded" | "follow-up";
  expectation: string;
  scope_probe?: string;
}>[] = Object.freeze([
  Object.freeze({
    case_id: "document-control",
    kind: "control",
    expectation: "No unsupported material blocker in the offline schema bundle.",
  }),
  Object.freeze({
    case_id: "document-defect",
    kind: "seeded",
    expectation: "Detect the mandatory startup download that contradicts air-gapped operation.",
  }),
  Object.freeze({
    case_id: "implementation-control",
    kind: "control",
    expectation: "No unsupported material blocker for the equivalent template-string change.",
  }),
  Object.freeze({
    case_id: "unchanged-caller-defect",
    kind: "seeded",
    expectation: "Detect the reachable summary(value).toUpperCase() consumer failure.",
    scope_probe: "Do not report unrelated legacy-auth.js as this change's defect.",
  }),
  Object.freeze({
    case_id: "localized-correction",
    kind: "follow-up",
    expectation: "Confirm the prior concern is resolved without an unrelated audit.",
  }),
  Object.freeze({
    case_id: "correction-regression",
    kind: "follow-up",
    expectation: "Detect the newly introduced zero-value regression.",
  }),
]);

/** The same two rules the real-host scope probe uses: consumer compatibility and declared-output scope. */
export const CONSTITUTION_RULES = Object.freeze([
  Object.freeze({
    slot: "scope-b",
    text: "A declared output must preserve the behavior required by its unchanged direct consumers.",
    review_trigger: "A declared output breaks an unchanged direct consumer.",
    enforced_by: ["repository-view-inspection"],
  }),
  Object.freeze({
    slot: "scope-a",
    text: "Judge only declared outputs and do not treat unrelated pre-existing defects as this phase's work.",
    enforced_by: ["declared-output-review-scope"],
  }),
]);

export const CONSTITUTION_RULE_SLOTS: readonly AdjudicationRuleSlotV1[] = Object.freeze([
  Object.freeze({ slot: "scope-b", rule_id: "consumer-compatibility", rule_version: 1 }),
  Object.freeze({ slot: "scope-a", rule_id: "declared-output-scope", rule_version: 1 }),
]);
