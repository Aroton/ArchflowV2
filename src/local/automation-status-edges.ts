import { canonicalJsonDigest } from "../contracts/canonical.js";
import {
  createAutomationStatusV3,
  type AutomationStatusV3,
  type AutomationStatusWithoutIdV3,
} from "../contracts/automation-status.js";
import type { Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { DurableStateReadability } from "../state/status.js";
import type { StagedUpgradeStatus } from "./status-classification.js";

type UnreadableState = Extract<DurableStateReadability, { readability: "unreadable" }>;
type EdgeAuthority = Readonly<{
  repository_identity_digest: Sha256Digest;
  live_config_digest: Sha256Digest | null;
}>;

const NOT_APPLICABLE_RECOMMENDATION = Object.freeze({
  status: "unavailable" as const,
  reason: "not-applicable" as const,
  explanation: "Implementation recommendation is not applicable without readable phase-design workflow authority.",
});

function identityDigest(value: PlainJsonValue): ReturnType<typeof canonicalJsonDigest> {
  return canonicalJsonDigest(value);
}

/** A task with no state and no import stage belongs to the PRD producer. */
export function newTaskAutomationStatusV3(taskId: TaskSlug, authority: EdgeAuthority): AutomationStatusV3 {
  const document: AutomationStatusWithoutIdV3 = Object.freeze({
    schema_version: "3",
    progress: null,
    task_id: taskId,
    state_revision: null,
    position: Object.freeze({ kind: "prd" }),
    implementation_recommendation: NOT_APPLICABLE_RECOMMENDATION,
    condition: "awaiting-client",
    next_action: Object.freeze({
      actor: "skill",
      kind: "continue-skill",
      skill: "archflow-prd",
      task_id: taskId,
      skill_args: Object.freeze([]),
      instruction: "Continue the PRD workflow in its owning interactive session.",
    }),
  });
  return createAutomationStatusV3(document, Object.freeze({ kind: "absent", ...authority }));
}

/** Import staging is operator-owned and never fabricates current producer authority. */
export function stagedTaskAutomationStatusV3(
  taskId: TaskSlug,
  staged: StagedUpgradeStatus,
  authority: EdgeAuthority,
): AutomationStatusV3 {
  const current = staged.mode === "upgrade-staged";
  const category = current ? "legacy-upgrade-staged" : "legacy-upgrade-restart-required";
  const instruction = current
    ? "Resolve the authenticated legacy import stage in an interactive upgrade session before continuing."
    : "Discard the incompatible legacy import staging and restart upgrade preview in an interactive session.";
  const document: AutomationStatusWithoutIdV3 = Object.freeze({
    schema_version: "3",
    progress: null,
    task_id: taskId,
    state_revision: null,
    position: null,
    implementation_recommendation: NOT_APPLICABLE_RECOMMENDATION,
    condition: "blocked",
    next_action: Object.freeze({ actor: "operator", kind: "repair", instruction }),
    blocked: Object.freeze({ category, reasons: Object.freeze([staged.next_action.detail]) }),
  });
  const facts = Object.freeze({
    schema_version: "1",
    identity_kind: "legacy-upgrade-stage-classification",
    task_id: taskId,
    mode: staged.mode,
    input: staged.next_action.input ?? null,
  }) as unknown as PlainJsonValue;
  return createAutomationStatusV3(document, Object.freeze({
    kind: "staged",
    ...authority,
    classification: current ? "current" : "restart-required",
    identity_digest: identityDigest(facts),
  }));
}

/** Unreadable state is valid blocked observation, but its guessed position remains private. */
export function unreadableTaskAutomationStatusV3(taskId: TaskSlug, unreadable: UnreadableState): AutomationStatusV3 {
  if (unreadable.details.reason === "status-authority-invalid") {
    throw new TypeError("repository authority failure cannot be projected as workflow status");
  }
  if (unreadable.repository_identity_digest === undefined || unreadable.live_config_digest === undefined) {
    throw new TypeError("unreadable state classification is missing repository or config identity");
  }
  const document: AutomationStatusWithoutIdV3 = Object.freeze({
    schema_version: "3",
    progress: null,
    task_id: taskId,
    state_revision: null,
    position: null,
    implementation_recommendation: NOT_APPLICABLE_RECOMMENDATION,
    condition: "blocked",
    next_action: Object.freeze({
      actor: "operator",
      kind: "repair",
      instruction: "Repair or restore canonical durable task state before continuing.",
    }),
    blocked: Object.freeze({
      category: "state-unreadable",
      reasons: Object.freeze(["Durable task state exists but is not readable canonical authority."]),
    }),
  });
  const facts = Object.freeze({
    schema_version: "1",
    identity_kind: "unreadable-state-classification",
    task_id: taskId,
    details: unreadable.details,
  }) as unknown as PlainJsonValue;
  return createAutomationStatusV3(document, Object.freeze({
    kind: "unreadable",
    repository_identity_digest: unreadable.repository_identity_digest,
    live_config_digest: unreadable.live_config_digest,
    classification: unreadable.details.reason === "state-noncanonical" ? "noncanonical" : "invalid",
    identity_digest: identityDigest(facts),
  }));
}
