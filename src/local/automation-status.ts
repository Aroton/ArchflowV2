import {
  createAutomationStatus,
  createAutomationStatusV2,
  type AutomationHumanBoundaryV1,
  type AutomationHumanBoundaryV2,
  type AutomationPositionedBlockedCategoryV1,
  type AutomationSkillV1,
  type AutomationStatusV1,
  type AutomationStatusV2,
  type AutomationStatusWithoutIdV1,
  type AutomationStatusWithoutIdV2,
} from "../contracts/automation-status.js";
import { canonicalJsonDigest } from "../contracts/canonical.js";
import { parseTaskSlug } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type {
  SemanticActionKindV1,
  SemanticStatusSnapshotV1,
  WorkflowPositionV1,
  WorkflowViewV1,
} from "../contracts/semantic-workflow.js";
import type { NextAction, NextActionCode } from "../state/next-action.js";
import type { TaskStatusV1 } from "../state/status.js";

type SkillDescriptor = Readonly<{
  skill: AutomationSkillV1;
  skill_args: readonly string[];
}>;

function ownerFor(position: WorkflowPositionV1, legacyImport: boolean): SkillDescriptor {
  switch (position.kind) {
    case "prd": return Object.freeze({ skill: "archflow-prd", skill_args: Object.freeze([]) });
    case "design": return Object.freeze({
      skill: legacyImport ? "archflow-upgrade" : "archflow-design",
      skill_args: Object.freeze([]),
    });
    case "phase-design": return Object.freeze({ skill: "archflow-phase-design", skill_args: Object.freeze([String(position.phase)]) });
    case "phase-impl": return Object.freeze({ skill: "archflow-phase-impl", skill_args: Object.freeze([String(position.phase)]) });
  }
}

function parseLaunchSkill(skill: string | undefined): AutomationSkillV1 {
  switch (skill) {
    case "archflow-upgrade":
    case "archflow-prd":
    case "archflow-design":
    case "archflow-phase-design":
    case "archflow-phase-impl":
      return skill;
    case undefined:
      throw new TypeError("start-next-skill is missing its authenticated successor skill");
    default:
      throw new TypeError(`unsupported authenticated successor skill: ${skill}`);
  }
}

function markerStatus(value: SemanticStatusSnapshotV1["archived_decision"]): string | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "status");
  return descriptor?.enumerable === true && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function blockedCategory(snapshot: SemanticStatusSnapshotV1, status: TaskStatusV1): AutomationPositionedBlockedCategoryV1 {
  if (markerStatus(snapshot.pending_waiver_origin) === "invalid") return "waiver-origin-invalid";
  if (markerStatus(snapshot.revision_checkpoint) === "invalid") return "revision-checkpoint-invalid";
  if (markerStatus(snapshot.archived_decision) === "invalid") return "archived-decision-invalid";

  const action = status.next_action;
  switch (action.code) {
    case "resume-exact-intent": return "resume-exact-intent";
    case "inspect-retained-receipt": return "inspect-retained-receipt";
    case "create-fresh-intent": return "create-fresh-intent";
    case "resolve-current-authority": return "resolve-current-authority";
    case "resolve-open-gate":
      return status.open_gate?.presentation === undefined ? "presentation-unavailable" : "inspect-state";
    case "commit-artifacts":
      return missingCommitFacts(action, false) ? "commit-facts-unavailable" : "inspect-state";
    case "commit-phase":
      return missingCommitFacts(action, true) ? "commit-facts-unavailable" : "inspect-state";
    case "initialize-repository":
    case "create-task":
    case "open-gate":
    case "run-step":
    case "refresh-milestone-baseline":
    case "recover-milestone-authority":
    case "recover-approval-trigger-authority":
    case "refresh-stale-baseline":
    case "advance-phase":
    case "complete-task":
    case "task-complete":
    case "inspect-state":
      return "inspect-state";
    default:
      return assertNeverActionCode(action.code);
  }
}

function missingCommitFacts(action: NextAction, implementation: boolean): boolean {
  return (implementation ? action.commit_paths === undefined : action.commit_path === undefined) ||
    action.commit_message === undefined || action.commit_target_ref === undefined || action.commit_baseline === undefined;
}

function assertNeverActionCode(code: never): never {
  throw new TypeError(`unmapped automation status action code: ${String(code)}`);
}

/** Compile-time exhaustiveness check for every public action that resumes the current owner. */
function assertContinuationAction(kind: SemanticActionKindV1): void {
  switch (kind) {
    case "initialize-task":
    case "begin-work":
    case "submit-work":
    case "review":
    case "triage":
    case "revise":
    case "reopen":
    case "open-waiver":
    case "decide":
    case "refresh-milestone-baseline":
    case "recover-milestone-authority":
    case "refresh-stale-baseline":
    case "commit":
    case "finish-task":
      return;
    case "start-next-skill":
    case "inspect":
    case "none":
      throw new TypeError(`semantic action ${kind} cannot be projected as current-skill continuation`);
    default:
      return assertNeverSemanticAction(kind);
  }
}

function assertNeverSemanticAction(kind: never): never {
  throw new TypeError(`unmapped public semantic action: ${String(kind)}`);
}

function presentationBoundary(view: WorkflowViewV1): AutomationHumanBoundaryV1 {
  const presentation = view.presentation;
  if (presentation === undefined) throw new TypeError("awaiting-human semantic status is missing its presentation");
  return Object.freeze({
    source: "presentation",
    class: presentation.class,
    headline: view.headline,
    summary: presentation.summary,
    question: presentation.question,
    reasons: Object.freeze(presentation.reasons.map((reason) => Object.freeze({
      class: reason.class,
      text: reason.text,
    }))),
  });
}

function dispatchFailureBoundary(view: WorkflowViewV1): AutomationHumanBoundaryV1 {
  const failure = view.dispatch_failure;
  if (failure === undefined) throw new TypeError("dispatch failure boundary requires failure facts");
  // Automation status v1 cannot add a new failed_role enum value without breaking strict
  // consumers. Preserve `adjudicator` as the temporary structured surrogate for effort review,
  // while every human-facing field states the real role and fixed policy route truthfully.
  const role = failure.role === "counter-reviewer" || failure.role === "test-reviewer"
    ? failure.role
    : "adjudicator";
  const humanRole = failure.role === "effort-reviewer" ? "effort reviewer" : failure.role;
  const effortSuffix = failure.role === "effort-reviewer" && failure.route !== undefined
    ? ` The configured route is ${failure.route.model} at ${failure.route.effort} effort.`
    : "";
  return Object.freeze({
    source: "dispatch-failure",
    class: "exception",
    headline: failure.role === "effort-reviewer"
      ? "Effort review route needs human attention"
      : "Reviewer route needs human attention",
    summary: `${failure.message}${effortSuffix}`,
    question: `Return to the owning skill to repair the ${humanRole} route or authorize a one-dispatch substitute reviewer.`,
    reasons: Object.freeze([{ class: "exception" as const, text: `${humanRole} dispatch failed: ${failure.message}${effortSuffix}` }]),
    failed_role: role,
    failure_code: failure.code,
  });
}

/**
 * Pure controller projection from the authenticated semantic snapshot and its no-invocation view.
 * It consumes no offer and exposes no decision token.
 */
export function projectAutomationStatus(
  snapshot: SemanticStatusSnapshotV1,
  view: WorkflowViewV1,
): AutomationStatusV1 {
  if (snapshot.state === undefined || snapshot.state_document_digest === undefined) {
    throw new TypeError("readable automation projection requires canonical durable state identity");
  }
  if (view.position === undefined) throw new TypeError("readable automation projection requires a workflow position");
  if (view.task_id !== snapshot.state.task_id) throw new TypeError("automation view and snapshot task identities differ");
  if (view.next_action.offer !== undefined) throw new TypeError("automation projection requires a no-invocation semantic view");

  const task_id = parseTaskSlug(view.task_id);
  const common = {
    schema_version: "1" as const,
    task_id,
    state_revision: snapshot.state.revision,
    position: view.position,
  };
  const owner = ownerFor(view.position, snapshot.legacy_import_initialization === true);
  let document: AutomationStatusWithoutIdV1;

  if (view.dispatch_failure !== undefined) {
    const boundary = dispatchFailureBoundary(view);
    document = {
      ...common,
      condition: "awaiting-human",
      next_action: {
        actor: "human", kind: "respond-in-session", task_id,
        skill: owner.skill, skill_args: owner.skill_args, instruction: boundary.question,
      },
      human_boundary: boundary,
    };
  } else {
    switch (view.condition) {
      case "awaiting-client":
        assertContinuationAction(view.next_action.kind);
        document = {
          ...common,
          condition: "awaiting-client",
          next_action: {
            actor: "skill", kind: "continue-skill", task_id,
            skill: owner.skill, skill_args: owner.skill_args, instruction: view.next_action.instruction,
          },
        };
        break;
      case "awaiting-human": {
        if (view.next_action.kind !== "decide") {
          throw new TypeError(`awaiting-human semantic action must be decide, received ${view.next_action.kind}`);
        }
        const boundary = presentationBoundary(view);
        document = {
          ...common,
          condition: "awaiting-human",
          next_action: {
            actor: "human", kind: "respond-in-session", task_id,
            skill: owner.skill, skill_args: owner.skill_args, instruction: boundary.question,
          },
          human_boundary: boundary,
        };
        break;
      }
      case "ready":
        if (view.next_action.kind === "start-next-skill") {
          document = {
            ...common,
            condition: "ready",
            next_action: {
              actor: "orchestrator", kind: "launch-skill", task_id,
              skill: parseLaunchSkill(view.next_action.skill),
              skill_args: Object.freeze([...(view.next_action.skill_args ?? [])]),
              instruction: view.next_action.instruction,
            },
          };
        } else {
          assertContinuationAction(view.next_action.kind);
          document = {
            ...common,
            condition: "awaiting-client",
            next_action: {
              actor: "skill", kind: "continue-skill", task_id,
              skill: owner.skill, skill_args: owner.skill_args, instruction: view.next_action.instruction,
            },
          };
        }
        break;
      case "blocked": {
        if (view.next_action.kind !== "inspect") {
          throw new TypeError(`blocked semantic action must be inspect, received ${view.next_action.kind}`);
        }
        const status = snapshot.status as unknown as TaskStatusV1;
        const category = blockedCategory(snapshot, status);
        const reasons = status.blocking_reasons.length === 0
          ? Object.freeze([category])
          : Object.freeze([...status.blocking_reasons]);
        document = {
          ...common,
          condition: "blocked",
          next_action: { actor: "operator", kind: "repair", instruction: view.next_action.instruction },
          blocked: { category, reasons },
        };
        break;
      }
      case "complete":
        if (view.next_action.kind !== "none") {
          throw new TypeError(`complete semantic action must be none, received ${view.next_action.kind}`);
        }
        document = {
          ...common,
          condition: "complete",
          next_action: { actor: "none", kind: "none", instruction: view.next_action.instruction },
        };
        break;
      default:
        return assertNeverCondition(view.condition);
    }
  }

  return createAutomationStatus(document, {
    kind: "readable",
    repository_identity_digest: snapshot.repository_identity_digest,
    state_document_digest: snapshot.state_document_digest,
    live_config_digest: snapshot.live_config_digest ?? null,
    semantic_snapshot_digest: canonicalJsonDigest(snapshot as unknown as PlainJsonValue),
  });
}

/**
 * V2 preserves the v1 action projection and adds authenticated recommendation advice. The
 * recommendation is copied only after the action has been selected, so it cannot influence who
 * acts or which workflow operation is next.
 */
export function projectAutomationStatusV2(
  snapshot: SemanticStatusSnapshotV1,
  view: WorkflowViewV1,
): AutomationStatusV2 {
  const v1 = projectAutomationStatus(snapshot, view);
  const { observation_id: _observationId, schema_version: _schemaVersion, ...v1Document } = v1;
  let document = {
    ...v1Document,
    schema_version: "2" as const,
    implementation_recommendation: view.implementation_recommendation,
    ...(view.validation_overrides === undefined ? {} : {
      validation_overrides: view.validation_overrides,
    }),
    ...(view.review_push_throughs === undefined ? {} : {
      review_push_throughs: view.review_push_throughs,
    }),
  } as AutomationStatusWithoutIdV2;

  if (view.dispatch_failure?.role === "effort-reviewer" && document.condition === "awaiting-human") {
    document = {
      ...document,
      human_boundary: {
        ...document.human_boundary,
        failed_role: "effort-reviewer",
      } as AutomationHumanBoundaryV2,
    };
  }

  return createAutomationStatusV2(document, {
    kind: "readable",
    repository_identity_digest: snapshot.repository_identity_digest,
    state_document_digest: snapshot.state_document_digest as NonNullable<SemanticStatusSnapshotV1["state_document_digest"]>,
    live_config_digest: snapshot.live_config_digest ?? null,
    semantic_snapshot_digest: canonicalJsonDigest(snapshot as unknown as PlainJsonValue),
  });
}

function assertNeverCondition(condition: never): never {
  throw new TypeError(`unmapped semantic workflow condition: ${String(condition)}`);
}
