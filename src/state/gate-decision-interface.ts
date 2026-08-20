import { isDeepStrictEqual } from "node:util";

import { parseActiveGate, type ActiveGateV1, type GateRequestV1 } from "../contracts/durable-gate.js";
import type { PathSafeId, Sha256Digest } from "../contracts/evidence.js";
import { validateGateDecision, type GateContext } from "../contracts/gates.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import {
  deepFreezeGateJson,
  waiverContext,
} from "./gate-core.js";

const TEMPLATE_REASON = "Record the human decision reason.";
const TEMPLATE_RATIONALE = "Record the human decision rationale.";

function decisionTemplateBase(active: ActiveGateV1): Readonly<{
  schema_version: "1";
  gate_id: PathSafeId;
  task_id: GateRequestV1["task_id"];
  phase_instance: GateRequestV1["phase_instance"];
  subject_digest: Sha256Digest;
  context_digest: Sha256Digest;
}> {
  return {
    schema_version: "1",
    gate_id: active.gate_id,
    task_id: active.task_id,
    phase_instance: active.phase_instance,
    subject_digest: active.subject_digest,
    context_digest: active.context_digest,
  };
}

/**
 * Enumerates the complete human-facing decision shapes for the request projected in gate.json.
 * The caller adds human provenance only after the human chooses one of these templates.
 */
export function buildGateDecisionTemplates(active: ActiveGateV1): readonly PlainJsonValue[] {
  const request = parseActiveGate(structuredClone(active));
  const base = decisionTemplateBase(request);
  const cancellation = { ...base, cancelled: true, reason: TEMPLATE_REASON } as const;
  const waiver = waiverContext(request.context);
  if (waiver !== undefined) {
    return deepFreezeGateJson([
      {
        ...base,
        granted: true,
        scope: structuredClone(waiver.origin.scope),
        origin: structuredClone(waiver.origin),
        notes: TEMPLATE_REASON,
      },
      {
        ...base,
        granted: false,
        scope: structuredClone(waiver.origin.scope),
        origin: structuredClone(waiver.origin),
        notes: TEMPLATE_REASON,
      },
      cancellation,
    ] satisfies PlainJsonValue[]);
  }

  const templates: PlainJsonValue[] = [];
  for (const decision of request.allowed_decisions) {
    if (decision === "cancel") {
      templates.push(cancellation);
      continue;
    }
    // A baseline adoption offers only the decisions its context can satisfy: bytes choices need
    // live drifted files, the deletion choice needs committed deletions. Offering an inapplicable
    // choice would archive a decision that can never settle.
    if (request.kind === "baseline-adoption" &&
        ((decision === "adopt-current-bytes" || decision === "restore-recorded-bytes") && request.context.drifted_projections.length === 0 ||
         decision === "adopt-committed-deletions" && (request.context.deleted_projections?.length ?? 0) === 0)) {
      continue;
    }

    const context = request.context as GateRequestV1["context"];
    const payloads: PlainJsonValue[] = [];
    if (decision === "waiver-requested") {
      // One template per waivable (rule, axis) pair: waiving a rule's compliance and waiving its
      // review trigger are different requests, and the human must be shown both.
      const eligible = (context as GateContext<"constitution-review"> | GateContext<"design-approval">).eligible_waivers;
      for (const item of eligible) {
        payloads.push({
          decision,
          reason: TEMPLATE_REASON,
          rule: structuredClone(item.rule),
          operation: item.scope.operation,
          rationale: TEMPLATE_RATIONALE,
        });
      }
    } else if (request.kind === "restore-collision" && decision === "adopt-as-new-generation") {
      if (request.context.adoption_candidate !== undefined) {
        payloads.push({
          decision,
          reason: TEMPLATE_REASON,
          adoption_authority: structuredClone(request.context.adoption_candidate),
          rationale: TEMPLATE_RATIONALE,
        });
      }
    } else {
      payloads.push({ decision, reason: TEMPLATE_REASON });
    }

    for (const payload of payloads) {
      validateGateDecision(request.kind, request.context as never, payload as never);
      templates.push({ ...base, kind: request.kind, payload });
    }
  }
  return deepFreezeGateJson(templates);
}

export type HumanGateDecisionOption = Readonly<{
  /** A short server-issued selector. The user never needs to copy a gate id or digest. */
  token: string;
  label: string;
  consequence: string;
}>;

export type HumanGatePresentation = Readonly<{
  title: string;
  /** The summary stored with the durable gate request, not a reconstruction from protocol data. */
  summary: string;
  /** Self-contained review context so the human never has to inspect an internal artifact. */
  details?: readonly string[];
  question: string;
  options: readonly HumanGateDecisionOption[];
}>;

type PresentedDecision =
  | "approve"
  | "revise"
  | "reject"
  | "waiver-requested"
  | "amend-upstream"
  | "revise-current"
  | "retry-once"
  | "abort"
  | "revert-edit"
  | "start-base-amendment"
  | "authorize-commit"
  | "discard-and-restore"
  | "adopt-as-new-generation"
  | "adopt-current-bytes"
  | "restore-recorded-bytes"
  | "adopt-committed-deletions"
  | "accept-import-audit"
  | "cancel"
  | "waiver-grant"
  | "waiver-deny";

type PresentationBinding = Readonly<{
  token: string;
  decision: PresentedDecision;
  template: PlainJsonValue;
  option: HumanGateDecisionOption;
}>;

const PRESENTATION_COPY = Object.freeze({
  "artifact-approval": Object.freeze({
    title: "Review the finished work",
    question: "Does this work meet your expectations, or would you like it changed?",
  }),
  "design-approval": Object.freeze({
    title: "Review and approve the design",
    question: "Should ArchFlow approve this design, commit its recoverable milestone, and continue?",
  }),
  "constitution-review": Object.freeze({
    title: "Review the policy findings",
    question: "How would you like to handle the policy review?",
  }),
  "material-drift": Object.freeze({
    title: "Choose how to handle a material change",
    question: "Should the earlier plan change, should the current work change, or should this version stop?",
  }),
  "attempts-exhausted": Object.freeze({
    title: "Automated review needs your direction",
    question: "The review did not converge within its normal attempts. What would you like to do next?",
  }),
  "constitution-edit": Object.freeze({
    title: "Review a project policy change",
    question: "Should the policy edit be undone, moved into the project baseline, or abandoned?",
  }),
  "commit-authorization": Object.freeze({
    title: "Authorize the commit",
    question: "Do you authorize committing the reviewed changes, or should they be revised first?",
  }),
  "restore-collision": Object.freeze({
    title: "Resolve a workspace conflict",
    question: "Should ArchFlow restore the saved version, keep the current version, or stop?",
  }),
  "baseline-adoption": Object.freeze({
    title: "Decide what to do with changed files",
    question: "These files changed after ArchFlow recorded their reviewed bytes (for example by later commits or a merge), or were deleted by an already-committed change. Keep the current state as the new baseline, restore the recorded versions, or stop?",
  }),
  "migration-audit": Object.freeze({
    title: "Review the imported task",
    question: "Is the imported task accurate enough to accept, or should it be revised?",
  }),
} as const satisfies Readonly<Record<ActiveGateV1["kind"], Readonly<{ title: string; question: string }>>>);

const OPTION_COPY = Object.freeze({
  approve: Object.freeze({ token: "approve", label: "Approve and continue", consequence: "Accept this review result and continue the workflow." }),
  revise: Object.freeze({ token: "request-changes", label: "Request changes", consequence: "Return the work for revision. Significant changes will receive a fresh independent review." }),
  reject: Object.freeze({ token: "reject", label: "Reject this version", consequence: "Do not approve this version; the workflow will not advance." }),
  "amend-upstream": Object.freeze({ token: "update-earlier-work", label: "Update the earlier work", consequence: "Return to the affected earlier artifact and bring the plan back in line with reality." }),
  "revise-current": Object.freeze({ token: "change-current-work", label: "Change the current work", consequence: "Keep the earlier plan and revise the current artifact to match it." }),
  "retry-once": Object.freeze({ token: "try-review-again", label: "Try the review once more", consequence: "Allow one more automated review attempt without changing the work first." }),
  abort: Object.freeze({ token: "stop-work", label: "Stop this work", consequence: "End this workflow path without approval." }),
  "revert-edit": Object.freeze({ token: "undo-policy-change", label: "Undo the policy edit", consequence: "Restore the policy version this task originally reviewed against." }),
  "start-base-amendment": Object.freeze({ token: "update-project-policy", label: "Update the project policy", consequence: "Move the policy change into the project baseline before continuing this task." }),
  "authorize-commit": Object.freeze({ token: "authorize-commit", label: "Authorize the commit", consequence: "Permit ArchFlow to commit the exact reviewed changes; this is the final human confirmation." }),
  "discard-and-restore": Object.freeze({ token: "restore-saved-version", label: "Restore the saved version", consequence: "Discard the conflicting workspace copy and reconstruct it from durable authority." }),
  "adopt-as-new-generation": Object.freeze({ token: "keep-current-version", label: "Keep the current version", consequence: "Treat the current workspace copy as a new generation of the artifact." }),
  "adopt-current-bytes": Object.freeze({ token: "keep-current-versions", label: "Keep the current versions", consequence: "Record the current file versions as the reviewed baseline without re-reviewing them. Nothing is lost, and the next implementation phase still reviews everything it touches." }),
  "adopt-committed-deletions": Object.freeze({ token: "keep-the-deletions", label: "Keep the deletions", consequence: "Accept the committed deletions as the reviewed baseline. These files were already removed by an authorized commit; ArchFlow's records stop claiming them, and nothing is restored." }),
  "restore-recorded-bytes": Object.freeze({ token: "restore-recorded-versions", label: "Restore the recorded versions", consequence: "Discard the current versions of these files and rewrite the recorded ones. The discarded changes stay in git history." }),
  "accept-import-audit": Object.freeze({ token: "accept-import", label: "Accept the import", consequence: "Confirm that the imported task faithfully represents the legacy source and continue." }),
  cancel: Object.freeze({ token: "cancel", label: "Cancel this decision", consequence: "Close this decision without approving anything; the workflow will remain stopped here." }),
  "waiver-grant": Object.freeze({ token: "grant-exception", label: "Grant the exception", consequence: "Allow the narrowly scoped policy exception recorded in this request." }),
  "waiver-deny": Object.freeze({ token: "deny-exception", label: "Deny the exception", consequence: "Keep the policy requirement in force and do not advance under this exception." }),
} as const satisfies Readonly<Record<Exclude<PresentedDecision, "waiver-requested">, HumanGateDecisionOption>>);

/** Extracts the meaningful decision from a bound template, including its nested payload. */
export function gateDecisionTemplateName(template: PlainJsonValue): PresentedDecision | "unknown" {
  if (template === null || typeof template !== "object" || Array.isArray(template)) return "unknown";
  const value = template as Record<string, PlainJsonValue>;
  if (value.cancelled === true) return "cancel";
  if (typeof value.granted === "boolean") return value.granted ? "waiver-grant" : "waiver-deny";
  const payload = value.payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const decision = (payload as Record<string, PlainJsonValue>).decision;
    if (typeof decision === "string") return decision as PresentedDecision;
  }
  return "unknown";
}

function waiverOption(template: PlainJsonValue, index: number): HumanGateDecisionOption {
  const payload = (template as { payload: { rule: { rule_id: string }; operation: string } }).payload;
  const axis = payload.operation === "review-trigger" ? "additional review" : "policy finding";
  return Object.freeze({
    token: `request-exception-${index}`,
    label: `Request an exception for ${payload.rule.rule_id}`,
    consequence: `Ask for a narrowly scoped exception to this rule's ${axis}. A separate human decision will grant or deny it.`,
  });
}

function presentationBindings(active: ActiveGateV1): readonly PresentationBinding[] {
  let waiverIndex = 0;
  return Object.freeze(buildGateDecisionTemplates(active).flatMap((template): PresentationBinding[] => {
    const decision = gateDecisionTemplateName(template);
    if (decision === "unknown") return [];
    const option = active.kind === "design-approval" && decision === "approve"
      ? Object.freeze({
          token: "approve",
          label: "Approve, commit, and continue",
          consequence: "Approve the exact reviewed design and policy context, authorize its recoverable task-local commit, and continue the workflow.",
        })
      : decision === "waiver-requested"
      ? waiverOption(template, ++waiverIndex)
      : OPTION_COPY[decision];
    return [Object.freeze({ token: option.token, decision, template, option })];
  }));
}

/** Renders the live gate as a conversational human decision without exposing binding material. */
export function buildHumanGatePresentation(
  active: ActiveGateV1,
  contentTriggerDetails?: readonly string[],
): HumanGatePresentation {
  const request = parseActiveGate(structuredClone(active));
  if (contentTriggerDetails !== undefined && request.kind !== "commit-authorization") {
    throw new TypeError("internal invariant: content-trigger details require a commit-authorization gate");
  }
  const waiver = waiverContext(request.context);
  const copy = waiver === undefined
    ? PRESENTATION_COPY[request.kind]
    : Object.freeze({
        title: "Decide a policy exception",
        question: "Should this narrowly scoped policy exception be granted?",
      });
  return Object.freeze({
    title: copy.title,
    summary: request.summary,
    ...(request.kind === "design-approval" ? {
      details: Object.freeze(request.context.policy_findings.flatMap((finding) => {
        const lines: string[] = [];
        if (finding.compliance !== "pass") {
          lines.push(`${finding.rule_id}: policy compliance is ${finding.compliance}. ${finding.rationale}`);
        }
        if (finding.trigger !== "not-matched") {
          lines.push(`${finding.rule_id}: review trigger is ${finding.trigger}. ${finding.trigger_evidence}`);
        }
        return lines;
      })),
    } : {}),
    ...(request.kind === "baseline-adoption" ? {
      details: Object.freeze([
        ...(request.context.drifted_projections.length === 0 ? [] : [
          `${request.context.drifted_projections.length} file${request.context.drifted_projections.length === 1 ? "" : "s"} changed, including:`,
          ...request.context.drifted_projections.slice(0, 10).map((drifted) => drifted.path),
          ...(request.context.drifted_projections.length > 10 ? [`… and ${request.context.drifted_projections.length - 10} more`] : []),
        ]),
        ...((request.context.deleted_projections ?? []).length === 0 ? [] : [
          `${request.context.deleted_projections!.length} file${request.context.deleted_projections!.length === 1 ? "" : "s"} deleted by an already-committed change:`,
          ...request.context.deleted_projections!.slice(0, 10).map((deleted) => deleted.path),
          ...(request.context.deleted_projections!.length > 10 ? [`… and ${request.context.deleted_projections!.length - 10} more`] : []),
        ]),
      ]),
    } : {}),
    ...(request.kind === "commit-authorization" && contentTriggerDetails !== undefined ? {
      details: Object.freeze([...contentTriggerDetails]),
    } : {}),
    question: `${copy.question} Choose an option and briefly explain why.`,
    options: Object.freeze(presentationBindings(request).map((binding) => binding.option)),
  });
}

export type GateDecisionChoice = Readonly<{
  choice: string;
  reason: string;
  rationale?: string;
  rule?: PlainJsonValue;
  operation?: string;
}>;

function choiceRecord(value: PlainJsonValue): Record<string, PlainJsonValue> {
  assertPlainJson(value, "gate decision choice");
  const materialized = structuredClone(value);
  if (materialized === null || Array.isArray(materialized) || typeof materialized !== "object") {
    throw new TypeError("gate decision choice must be a JSON object");
  }
  const record = materialized as Record<string, PlainJsonValue>;
  const allowed = new Set(["choice", "reason", "rationale", "rule", "operation"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("gate decision choice contains unsupported fields");
  }
  if (typeof record.choice !== "string" || record.choice.trim() === "") {
    throw new TypeError("gate decision choice.choice must be a non-empty string");
  }
  if (typeof record.reason !== "string" || record.reason.trim() === "") {
    throw new TypeError("gate decision choice.reason must be a non-empty string");
  }
  return record;
}

/**
 * Binds the human's small judgment-only input to the live server-owned gate template.
 * Gate ids, digests, scopes, origins, and adoption authority never need to be copied by a caller.
 */
export function selectGateDecisionTemplate(active: ActiveGateV1, value: PlainJsonValue): PlainJsonValue {
  const choice = choiceRecord(value);
  const selectedBinding = presentationBindings(active).find((binding) => binding.token === choice.choice);
  const presentedDecision = selectedBinding?.decision;
  const decision = presentedDecision === "waiver-grant"
    ? "grant"
    : presentedDecision === "waiver-deny"
      ? "deny"
      : presentedDecision ?? choice.choice as string;
  const reason = choice.reason as string;
  const templates = buildGateDecisionTemplates(active);

  if (decision === "cancel") {
    if (choice.rationale !== undefined || choice.rule !== undefined || choice.operation !== undefined) {
      throw new TypeError("cancel accepts only choice and reason");
    }
    const template = templates.find((candidate) => "cancelled" in (candidate as object));
    if (template === undefined) throw new TypeError("cancel is not allowed for the active gate");
    return { ...(template as Record<string, PlainJsonValue>), reason };
  }

  const waiver = waiverContext(active.context);
  if (waiver !== undefined) {
    if (!(["grant", "deny"] as const).includes(decision as "grant" | "deny")) {
      throw new TypeError("choice is not allowed for the active waiver gate");
    }
    if (choice.rationale !== undefined || choice.rule !== undefined || choice.operation !== undefined) {
      throw new TypeError("waiver decisions accept only choice and reason");
    }
    const granted = decision === "grant";
    const template = templates.find((candidate) => (candidate as { granted?: boolean }).granted === granted);
    if (template === undefined) throw new TypeError("choice is not allowed for the active waiver gate");
    return { ...(template as Record<string, PlainJsonValue>), notes: reason };
  }

  let template: PlainJsonValue | undefined;
  if (decision === "waiver-requested") {
    if (selectedBinding !== undefined) {
      if (choice.rule !== undefined || choice.operation !== undefined) {
        throw new TypeError("a server-issued waiver option does not accept rule or operation selectors");
      }
      template = selectedBinding.template;
    } else {
      if (choice.rule === undefined || typeof choice.operation !== "string" || choice.operation.trim() === "") {
        throw new TypeError("waiver-requested requires rule and operation selectors");
      }
      template = templates.find((candidate) => {
        const payload = (candidate as { payload?: Record<string, PlainJsonValue> }).payload;
        return payload?.decision === decision && payload.operation === choice.operation && isDeepStrictEqual(payload.rule, choice.rule);
      });
    }
  } else {
    if (choice.rule !== undefined || choice.operation !== undefined) {
      throw new TypeError("rule and operation apply only to waiver-requested");
    }
    if (decision !== "adopt-as-new-generation" && choice.rationale !== undefined) {
      throw new TypeError("rationale is not accepted for this decision");
    }
    template = selectedBinding?.template ?? templates.find((candidate) =>
      (candidate as { payload?: { decision?: string } }).payload?.decision === decision,
    );
  }
  if (template === undefined) throw new TypeError("choice is not allowed for the active gate");
  const payload = (template as { payload: Record<string, PlainJsonValue> }).payload;
  return {
    ...(template as Record<string, PlainJsonValue>),
    payload: {
      ...payload,
      reason,
      ...((decision === "waiver-requested" || decision === "adopt-as-new-generation")
        ? { rationale: choice.rationale ?? reason }
        : {}),
    },
  };
}
