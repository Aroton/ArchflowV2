import type { DispatchCoordinatorResult } from "../dispatch/coordinator.js";
import { reportInternalError } from "../mcp/diagnostics.js";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJsonBytes, sha256Bytes } from "../contracts/canonical.js";
import { createRawAdjudicationV2Schema } from "../contracts/adjudication.js";
import type { InvocationContext } from "../contracts/contexts.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { reviewReportOutputSchema } from "../contracts/review.js";
import { parseSimpleReviewInput, parseSimpleReviewResult, type SimpleReviewInput, type SimpleReviewResult } from "../contracts/simple-review.js";
import { createReviewDispatcher } from "../dispatch/coordinator.js";
import { serializeDispatchAll } from "../dispatch/cli.js";
import { classifiedDispatchFailure } from "../dispatch/failure-observation.js";
import { isTransientDispatchFailure } from "../dispatch/recovery.js";
import { selectDispatchRouteCandidates, validateSelectedDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import { projectRepositoryWorkspaceBinding, shareRepositoryViewWorkspace } from "../dispatch/workspace.js";
import { approvalRuleMatchSummary, evaluateApprovalRules } from "../state/approval-rules.js";
import { sealDispatchInput, type DispatchEnvelope } from "./envelopes.js";
import { loadCanonicalRubricForPhaseKind, reviewAssignment } from "./rubrics.js";
import { captureSimpleContext, SimpleReviewError } from "./simple-context.js";

export type SimpleReviewDependencies = {
  dispatch?: (route: DispatchRoute, envelope: DispatchEnvelope, schema: PlainJsonValue) => Promise<DispatchCoordinatorResult>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};
const failure = (code: string, message: string): SimpleReviewResult => ({ schema_version: "1", ok: false, error: { code, message, retryable: false } });
function jsonSchema(schema: { toJSONSchema: (options: { target: "draft-2020-12" }) => unknown }): PlainJsonValue {
  // Zod attaches a non-enumerable Standard Schema helper to its own schema output.
  const value: unknown = JSON.parse(JSON.stringify(schema.toJSONSchema({ target: "draft-2020-12" })));
  assertPlainJson(value);
  return structuredClone(value);
}
const envelope = sealDispatchInput;

/** One stateless pass. Reports describe inspected bytes, never authorization or a workflow transition. */
export async function runSimpleReview(raw: SimpleReviewInput, context: InvocationContext, dependencies: SimpleReviewDependencies = {}): Promise<SimpleReviewResult> {
  let dispose: (() => Promise<void>) | undefined;
  try {
    const input = parseSimpleReviewInput(raw);
    context.signal.throwIfAborted();
    const captured = await captureSimpleContext(context.connection.startup_repository_candidate.working_directory, input, context.signal);
    const { policy } = captured;
    const host = context.connection.initialization_candidates.host;
    const phaseKind = input.stage === "plan" ? "phase-design" : "phase-impl";
    const rubricResult = await loadCanonicalRubricForPhaseKind(phaseKind);
    if (!rubricResult.ok) return failure("CONFIG_INVALID", "The installed review rubric is missing or invalid.");
    const rubric = { ...rubricResult.value.rubric, criteria: rubricResult.value.rubric.criteria.filter((criterion) =>
      input.stage !== "plan" || criterion.id !== "phase-plan-soundness") };
    const roles: Array<"counter-reviewer" | "test-reviewer" | "adjudicator"> = ["counter-reviewer", "test-reviewer"];
    if (policy.rules.length > 0) roles.push("adjudicator");
    const selected = roles.flatMap((role) => {
      const routes = selectDispatchRouteCandidates(policy.config, phaseKind, role, input.review_routes?.[role], undefined, host);
      if (routes.length === 0) throw new SimpleReviewError("CONFIG_INVALID", `No route is configured for ${role}.`);
      return routes.map((candidate, index) => ({ role, reviewer_id: `${role}-${index + 1}`, route: validateSelectedDispatchRoute(candidate).route }));
    });
    const shared = shareRepositoryViewWorkspace(captured.views, captured.root);
    dispose = shared.dispose;
    const dispatch = dependencies.dispatch ?? createReviewDispatcher({ host, repository_root: captured.root,
      signal: context.signal, cancellation_source: "client", shared_workspace: shared });
    const workspace = projectRepositoryWorkspaceBinding(captured.views);
    const value: NonNullable<SimpleReviewResult["value"]> = {
      stage: input.stage, subject_digest: captured.subject_digest, policy_digest: policy.policy_digest,
      config_digest: policy.config_digest, constitution_digest: policy.constitution_digest,
      reports: [], constitution: { status: policy.rules.length === 0 ? "not-applicable" : "failed", judgments: [] },
      human_review_reasons: [], failures: [],
    };
    const approval = evaluateApprovalRules(policy.config, phaseKind, input.paths);
    if (approval.wait) value.human_review_reasons.push(approvalRuleMatchSummary(approval.match));
    const slots = policy.rules.map((rule, index) => ({ slot: `rule-${index + 1}`, rule_id: rule.id, rule_version: rule.version }));
    const constitutionSchema = slots.length === 0 ? undefined : createRawAdjudicationV2Schema(slots);
    const common = {
      subject: { stage: input.stage, subject_digest: captured.subject_digest },
      ask: input.ask, plan: input.plan, paths: input.paths, verification: input.verification ?? "Plan review: assess the proposed verification strategy.",
      workspace,
      scope: "This is a standalone simple task, not an initialized ArchFlow workflow. The primary repository view contains the current work; baseline is the same repository at the starting commit. Inspect declared paths as the subject, with other files only as context. Existing unrelated changes are not findings. There are no task documents, phases, durable gates, or implementation-agent recommendations. The invoking session owns plan review, fixes, explicit human decisions, and execution; do not invent missing workflow records. Custom policy remains applicable; report any conflict rather than silently exempting it. Review once; no follow-up reviewer pass will certify subsequent fixes.",
    };
    // Settle every sibling before disposing shared context, and retain successful siblings on failure.
    const outcomes = await serializeDispatchAll(selected.map((selection) => async () => {
      const { role, reviewer_id, route } = selection;
      try {
        const assignment = role === "adjudicator" ? undefined : reviewAssignment(reviewer_id,
          role === "test-reviewer" ? "tests" : "general", phaseKind, rubric);
        const request = role === "adjudicator"
          ? envelope("adjudication", { ...common,
            instructions: "Judge each assigned active constitution rule against this subject. Return schema_version 2 and exactly one judgment per rule slot. For rules without review_trigger, trigger must be not-matched. Triggers require direct evidence, not workflow machinery absent by design. Explain compliance, rationale, trigger, and trigger_evidence; do not author approvals or rule identities.",
            rules: policy.rules.map((rule, index) => ({ slot: slots[index]!.slot, text: rule.text,
              ...(rule.review_trigger === undefined ? {} : { review_trigger: rule.review_trigger }), enforced_by: [...(rule.enforced_by ?? [])] })),
          })
          : envelope("review", { ...common, assignment: assignment!, rubric,
             });
        const schema = role === "adjudicator" ? constitutionSchema! : reviewReportOutputSchema;
        let returned;
        for (let attempt = 0; ; attempt++) {
          context.signal.throwIfAborted();
          try { returned = await dispatch(route, request, jsonSchema(schema)); break; }
          catch (error) {
            if (attempt >= 2 || !isTransientDispatchFailure(error) || context.signal.aborted) throw error;
            const ms = attempt === 0 ? 1000 : 4000;
            await (dependencies.wait?.(ms, context.signal) ?? delay(ms, undefined, { signal: context.signal }));
          }
        }
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(returned.extracted_output_bytes)); }
        catch { throw new SimpleReviewError("MODEL_OUTPUT_INVALID", "Reviewer returned invalid JSON."); }
        const usage = returned.usage === undefined ? {} : { usage: returned.usage };
        if (role === "adjudicator") {
          const result = constitutionSchema!.safeParse(parsed);
          if (!result.success) throw new SimpleReviewError("MODEL_OUTPUT_INVALID", "Constitution review did not cover every assigned rule with valid judgments.");
          const judgments = slots.map((slot, index) => {
            const judgment = result.data.judgments[slot.slot]!;
            if (policy.rules[index]!.review_trigger === undefined && judgment.trigger !== "not-matched") {
              throw new SimpleReviewError("MODEL_OUTPUT_INVALID", "Constitution review invented a trigger for a rule without one.");
            }
            return { rule_id: slot.rule_id, rule_version: slot.rule_version, ...judgment };
          });
          return { selection, judgments, report: { role, reviewer_id, route, ...usage, report: judgments.map((entry) => `${entry.rule_id}: ${entry.compliance}. ${entry.rationale}`).join("\n") } };
        }
        const result = reviewReportOutputSchema.strict().safeParse(parsed);
        if (!result.success) throw new SimpleReviewError("MODEL_OUTPUT_INVALID", "Reviewer must return an explicit outcome and nonblank feedback.");
        return { selection, report: { role, reviewer_id, route, ...result.data, ...usage } };
      } catch (error) {
        if (!(error instanceof SimpleReviewError) && classifiedDispatchFailure(error) === undefined) reportInternalError(context.invocation_id, error);
        return { selection, error };
      }
    }));
    for (const outcome of outcomes) {
      const { selection } = outcome;
      if ("error" in outcome) {
        const classified = classifiedDispatchFailure(outcome.error);
        value.failures.push({ ...selection,
          code: outcome.error instanceof SimpleReviewError ? outcome.error.code : classified?.code ?? "DISPATCH_FAILED",
          message: outcome.error instanceof SimpleReviewError ? outcome.error.message : classified?.message ?? "Reviewer dispatch failed or was cancelled. Repair it before requesting a fresh review.",
        });
      } else {
        value.reports.push(outcome.report);
        if (outcome.judgments !== undefined) {
          value.constitution = { status: "complete", judgments: outcome.judgments };
          for (const judgment of outcome.judgments) if (judgment.trigger !== "not-matched") {
            value.human_review_reasons.push(`${judgment.rule_id}: ${judgment.trigger}. ${judgment.trigger_evidence}`);
          }
        }
      }
    }
    await captured.assertCurrent();
    const ok = value.failures.length === 0;
    return parseSimpleReviewResult({ schema_version: "1", ok, value,
      ...(ok ? {} : { error: { code: "REVIEW_INCOMPLETE", message: "Some required reviews failed; available reports do not supply complete coverage.", retryable: false } }) });
  } catch (error) {
    const classified = classifiedDispatchFailure(error);
    return failure(error instanceof SimpleReviewError ? error.code : context.signal.aborted ? "CANCELLED" : classified?.code ?? "REVIEW_FAILED",
      error instanceof SimpleReviewError ? error.message : classified?.message ?? "Unable to prepare or validate the simple review. Check repository access, paths, configuration, and constitution.");
  } finally { await dispose?.(); }
}
