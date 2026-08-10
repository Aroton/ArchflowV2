import { canonicalJsonDigest, parseCanonicalDocument } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { parseIntentReceipt } from "../../contracts/durable-intent.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parsePathSafeId, parseSafeId, type Sha256Digest } from "../../contracts/evidence.js";
import { computeGateContextDigest } from "../../contracts/fingerprints.js";
import { validateProjectResultStructure, type ParsedToolCall, type ToolSuccess } from "../../contracts/mcp-tools.js";
import type { PlainJsonValue } from "../../contracts/plain-json.js";
import { createDispatchCoordinator } from "../../dispatch/coordinator.js";
import { classifyTaskPath, openResolved, resolveTaskPath, type ResolvedPath } from "../../repository/paths.js";
import { parseTaskPathClaim } from "../../contracts/path-claims.js";
import { runAdjudication, type AdjudicationGateRequest } from "../../review/adjudication.js";
import { selectAdjudicationGates } from "../../review/adjudication.js";
import type { AdjudicationUpstreamInput } from "../../review/envelopes.js";
import { assessCurrentEvidence, requireApprovedUpstreamDigests, waiverInForce } from "../../review/fixed-point.js";
import { detectTaskLocalConstitutionEdit, resolvePinnedConstitution } from "../../state/constitution.js";
import { loadCurrentReviewSet, loadRetainedEvidence, prepareEvidenceResult } from "../../state/evidence-results.js";
import { loadAuthenticatedGateApproval, openDurableGate, runDurableGate, type AuthenticatedGateApproval } from "../../state/gates.js";
import { identifyTransactionRequest } from "../../state/request.js";
import {
  loadCurrentProduceSubject,
  loadProduceUpstreamSubject,
  readProduceProjection,
  renderProduceReviewMaterial,
  resolveReviewExclusions,
  resolveProduceUpstreamBinding,
} from "../../state/produce-subject.js";
import { mapHandlerErrors } from "./errors.js";
import { resolvePreDispatchReplay } from "./replay.js";
import { openHandlerSession } from "./session.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });
const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

export type AdjudicationReplayFrame = Readonly<{
  next: "adjudication-gate" | "complete";
  gate?: AdjudicationGateRequest;
}>;

/** Gate-only replay driver: it has deliberately no dispatch dependency. */
export async function resumeAdjudicationReplay<T>(input: Readonly<{
  outcome: T;
  load_frame: () => Promise<ProjectResult<AdjudicationReplayFrame>>;
  resolve_gate: (gate: AdjudicationGateRequest) => Promise<ProjectResult<unknown>>;
}>): Promise<ProjectResult<T>> {
  for (;;) {
    const frame = await input.load_frame();
    if (!frame.ok) return frame;
    if (frame.value.next === "complete") return ok(input.outcome);
    if (frame.value.gate === undefined) throw new TypeError("adjudication replay gate frame is incomplete");
    const resolved = await input.resolve_gate(frame.value.gate);
    if (!resolved.ok) return resolved;
  }
}

function stableId(prefix: string, seed: PlainJsonValue): ReturnType<typeof parseSafeId> {
  return parseSafeId(`${prefix}-${canonicalJsonDigest(seed).slice(0, 32)}`);
}

async function readUtf8(path: ResolvedPath): Promise<string> {
  const handle = await openResolved(path.absolute, 0);
  const bytes = new Uint8Array(await handle.readFile().finally(() => handle.close()));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function handleAdjudicate(
  call: Extract<ParsedToolCall, { name: "archflow_adjudicate" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_adjudicate">>> {
  return mapHandlerErrors<"archflow_adjudicate">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const { services } = session.value;
    const state = services.state;
    if (state === undefined) return fail(createProjectError("STATE_MISSING", { phase_instance: "prd" }));

    const replay = await resolvePreDispatchReplay(services.dependencies, services.authority, call);

    const currentReviews = await loadCurrentReviewSet(
      { read_state: services.dependencies.read_state, load_retained_result: services.dependencies.load_retained_result! },
      services.authority,
      state.value.phase_instance,
    );
    if (!currentReviews.ok) return currentReviews;
    const constitution = await resolvePinnedConstitution(
      services.runner, state.value.policy_base_commit, services.authority.context,
    );
    if (!constitution.ok) return constitution;

    const produce = await loadCurrentProduceSubject(services.dependencies, state.value);
    if (!produce.ok) return produce;
    const projection = await readProduceProjection(
      services.runner, services.authority, produce.value, call.input.artifact_path,
    );
    if (!projection.ok) return projection;
    const exclusions = await resolveReviewExclusions(
      services.runner, produce.value, services.authority.context,
    );
    let artifact: string;
    try { artifact = renderProduceReviewMaterial(produce.value, projection.value, exclusions); }
    catch {
      return fail(createProjectError("CONTRACT_INVALID", { tool: call.name, issue_code: "artifact-not-utf8" }));
    }
    const subjectDigest = produce.value.artifact_digest;
    if (subjectDigest !== currentReviews.value.subject_digest) {
      return fail(createProjectError("STATE_INVALID", {
        phase_instance: state.value.phase_instance, issue_code: "adjudication-subject-not-current",
      }));
    }

    const deriveUpstreams = async (
      durable: typeof state.value,
      paths: typeof call.input.upstream_paths,
    ): Promise<ProjectResult<readonly AdjudicationUpstreamInput[]>> => {
      const derived: AdjudicationUpstreamInput[] = [];
      for (const path of paths) {
        const classified = classifyTaskPath(services.authority.task_id, path);
        if (!classified.ok) return classified;
        const binding = classified.value === "document"
          ? resolveProduceUpstreamBinding(durable, path)
          : undefined;
        if (binding === undefined) {
          return fail(createProjectError("STATE_INVALID", {
            phase_instance: durable.phase_instance, issue_code: "adjudication-upstream-path-mismatch",
          }));
        }
        const upstream = await loadProduceUpstreamSubject(services.dependencies, durable, binding);
        if (!upstream.ok) return upstream;
        const projection = await readProduceProjection(
          services.runner, services.authority, upstream.value, path,
        );
        if (!projection.ok) return projection;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(projection.value.bytes);
        } catch {
          return fail(createProjectError("CONTRACT_INVALID", {
            tool: call.name, issue_code: "adjudication-upstream-not-utf8",
          }));
        }
        const upstreamDigest = upstream.value.artifact_digest;
        let approved = false;
        for (const approval of [...durable.approvals]
          .filter((candidate) => candidate.gate_kind === "artifact-approval" && candidate.subject_digest === upstreamDigest)
          .sort((left, right) => right.resolved_at_revision - left.resolved_at_revision)) {
          const authenticated = await loadAuthenticatedGateApproval(
            services.dependencies, services.authority, approval,
          );
          if (!authenticated.ok) return authenticated;
          if (
            authenticated.value.request.kind === "artifact-approval" &&
            authenticated.value.request.context.artifact_kind === binding.artifact_kind
          ) {
            approved = true;
            break;
          }
        }
        if (!approved) {
          return fail(createProjectError("STATE_INVALID", {
            phase_instance: durable.phase_instance, issue_code: "upstream-approval-missing",
          }));
        }
        derived.push(Object.freeze({ upstream_digest: upstreamDigest, artifact: text }));
      }
      derived.sort((left, right) => left.upstream_digest.localeCompare(right.upstream_digest));
      return ok(Object.freeze(derived));
    };
    const upstreams = await deriveUpstreams(state.value, call.input.upstream_paths);
    if (!upstreams.ok) return upstreams;
    const approvedUpstreamDigests = requireApprovedUpstreamDigests(
      state.value.approvals,
      upstreams.value.map((item) => item.upstream_digest),
    );
    const resultId = stableId("adjudication-result", call.input.intent_id);
    const coordinator = createDispatchCoordinator({
      authority: services.authority, dependencies: services.dependencies, host: session.value.host,
      repository_root: services.runner.location.worktreeRoot, phase_instance: state.value.phase_instance,
      signal: context.signal, cancellation_source: "client", allow_claude_dispatch: true,
    });
    let preDispatchGateId: string | undefined;
    const openGate = async (request: AdjudicationGateRequest): Promise<ProjectResult<unknown>> => {
      const current = await services.dependencies.read_state(services.authority.state);
      if (current.kind !== "canonical") {
        return fail(createProjectError("STATE_INVALID", { phase_instance: state.value.phase_instance, issue_code: "adjudication-gate-state-invalid" }));
      }
      const gateIntent = stableId("adjudication-gate", {
        schema_version: "1", task_identity_digest: services.authority.task_identity_digest,
        adjudication_intent: call.input.intent_id,
        kind: request.kind, subject_digest: request.subject_digest, context: request.context,
      });
      const requestDigest = canonicalJsonDigest({
        schema_version: "1", operation: "adjudication-gate", intent_id: gateIntent,
        task_identity_digest: services.authority.task_identity_digest, kind: request.kind,
        subject_digest: request.subject_digest, context: request.context,
      });
      const common = {
        authority: services.authority, expected_revision: current.document.value.revision,
        intent_id: parsePathSafeId(gateIntent), request_digest: requestDigest,
        input_fingerprint: current.document.value.input_fingerprint,
        phase_instance: current.document.value.phase_instance,
        summary: `Resolve ${request.kind} before adjudication can advance`,
        subject_digest: request.subject_digest, kind: request.kind, context: request.context,
      } as const;
      if (request.kind === "constitution-edit") {
        const opened = await openDurableGate(services.dependencies, {
          ...common, current_evidence: currentReviews.value.current_evidence_set,
        });
        if (opened.ok) preDispatchGateId = opened.value.gate_id;
        return opened;
      }
      const refreshed = await loadCurrentReviewSet(
        { read_state: services.dependencies.read_state, load_retained_result: services.dependencies.load_retained_result! },
        services.authority, current.document.value.phase_instance,
      );
      if (!refreshed.ok) return refreshed;
      return runDurableGate(services.dependencies, {
        ...common, current_evidence: refreshed.value.current_evidence_set, signal: context.signal,
      });
    };

    const loadRetiredOutcome = async (): Promise<ProjectResult<ToolSuccess<"archflow_adjudicate"> | undefined>> => {
      const current = await services.dependencies.read_state(services.authority.state);
      if (current.kind !== "canonical") return ok(undefined);
      const reference = current.document.value.authoritative_results.find((item) =>
        item.phase_instance === current.document.value.phase_instance && item.step === "adjudicate" &&
        item.input_fingerprint === call.input.input_fingerprint);
      if (reference === undefined) return ok(undefined);
      const target = await resolveTaskPath({
        runner: services.runner, taskId: services.authority.task_id,
        claim: parseTaskPathClaim(`intents/${call.input.intent_id}.json`), expectedClass: "intent",
        context: services.authority.context,
      });
      if (!target.ok) return target;
      try {
        const handle = await openResolved(target.value.absolute, 0);
        const receiptDocument = parseCanonicalDocument(
          new Uint8Array(await handle.readFile().finally(() => handle.close())),
          "retired adjudication receipt",
        );
        const receipt = parseIntentReceipt(receiptDocument.value);
        const identified = identifyTransactionRequest(call, services.authority, reference.input_fingerprint);
        const retained = await services.dependencies.load_retained_result!(reference);
        if (!retained.ok) return retained;
        if (
          receipt.tool !== "archflow_adjudicate" || receipt.intent_id !== call.input.intent_id ||
          receipt.task_id !== services.authority.task_id ||
          receipt.repository_identity_digest !== services.authority.repository_identity_digest ||
          receipt.input_fingerprint !== reference.input_fingerprint || receipt.request_digest !== identified.request_digest ||
          receipt.result_id !== reference.result_id ||
          retained.value.prepared.manifest.value.result_id !== reference.result_id ||
          retained.value.prepared.manifest.value.source_artifact.artifact_kind !== "adjudication-evidence"
        ) return fail(createProjectError("STATE_INVALID", {
          phase_instance: current.document.value.phase_instance, issue_code: "retired-adjudication-outcome-invalid",
        }));
        const structured = validateProjectResultStructure(call, {
          schema_version: "1", ok: true, value: receipt.outcome,
        });
        return structured.ok ? ok(structured.value) : structured;
      } catch {
        return ok(undefined);
      }
    };

    let authenticatedOutcome: ToolSuccess<"archflow_adjudicate"> | undefined;
    if (replay.ok) authenticatedOutcome = replay.value;
    else {
      const retired = await loadRetiredOutcome();
      if (!retired.ok) return retired;
      if (retired.value === undefined) return replay;
      authenticatedOutcome = retired.value;
    }
    if (authenticatedOutcome !== undefined) {
      // Recompute the fixed point from retained authority before returning a replay. This closes
      // both result-commit/gate-publication and gate-resolution/reconnect crash windows.
      return resumeAdjudicationReplay({
        outcome: authenticatedOutcome,
        load_frame: async () => {
        const current = await services.dependencies.read_state(services.authority.state);
        if (current.kind !== "canonical") return fail(createProjectError("STATE_INVALID", {
          phase_instance: state.value.phase_instance, issue_code: "adjudication-replay-state-invalid",
        }));
        const retained = await loadRetainedEvidence(
          { load_retained_result: services.dependencies.load_retained_result! },
          current.document.value,
          current.document.value.phase_instance,
        );
        if (!retained.ok) return retained;
        const adjudicationSource = retained.value.get("adjudicate")?.manifest.source_artifact;
        if (adjudicationSource?.artifact_kind !== "adjudication-evidence") {
          return fail(createProjectError("STATE_INVALID", {
            phase_instance: current.document.value.phase_instance, issue_code: "retired-adjudication-evidence-missing",
          }));
        }
        const approvals: AuthenticatedGateApproval[] = [];
        for (const approval of current.document.value.approvals) {
          const loaded = await loadAuthenticatedGateApproval(services.dependencies, services.authority, approval);
          if (!loaded.ok) return loaded;
          approvals.push(loaded.value);
        }
        const assessment = assessCurrentEvidence(current.document.value, retained.value, {
          subject_digest: adjudicationSource.evidence.subject_digest,
          input_fingerprint: adjudicationSource.evidence.input_fingerprint,
          constitution: constitution.value,
          approved_upstream_digests: approvedUpstreamDigests,
          authenticated_gate_approvals: Object.freeze(approvals),
          ...(session.value.config.max_attempts === undefined ? {} : { max_attempts: session.value.config.max_attempts }),
        });
        if (assessment.next !== "adjudication-gate") return ok(Object.freeze({ next: "complete" as const }));
        const candidates = selectAdjudicationGates(constitution.value.rules, adjudicationSource.evidence);
        const next = candidates.find((candidate) => {
          const contextDigest = computeGateContextDigest(candidate.kind, candidate.context);
          const approved = approvals.some((item) =>
            item.approval.gate_kind === candidate.kind && item.approval.subject_digest === candidate.subject_digest &&
            item.request.context_digest === contextDigest);
          if (approved) return false;
          const candidateContext = candidate.context;
          if (
            (candidate.kind === "review-trigger" || candidate.kind === "adjudication-failure") &&
            "eligible_waiver_rules" in candidateContext && "waiver_scope" in candidateContext &&
            candidateContext.eligible_waiver_rules.length > 0 &&
            candidateContext.eligible_waiver_rules.every((rule) =>
              waiverInForce(current.document.value, rule, candidate.subject_digest, candidateContext.waiver_scope) !== undefined)
          ) return false;
          return true;
        });
        if (next === undefined) return fail(createProjectError("STATE_INVALID", {
          phase_instance: current.document.value.phase_instance, issue_code: "adjudication-gate-derivation-invalid",
        }));
        return ok(Object.freeze({ next: "adjudication-gate" as const, gate: next }));
        },
        resolve_gate: openGate,
      });
    }
    const result = await runAdjudication({
      transaction: services.dependencies,
      dispatch: coordinator,
      prepare_evidence: async (evidence, measuredAtRevision) => prepareEvidenceResult({
        authority: services.authority, runner: services.runner, result_id: resultId,
        retained_task_bytes: await services.dependencies.read_retained_task_bytes!(),
        measured_at_revision: measuredAtRevision, scanner: services.dependencies.gate_secret_scanner!,
        value: { kind: "adjudication", evidence },
      }),
      detect_constitution_edit: () => detectTaskLocalConstitutionEdit(
        services.runner, state.value.policy_base_commit, state.value.constitution_digest, services.authority.context,
      ),
      derive_approved_upstreams: deriveUpstreams,
      load_current_review_set: (authority, phase) => loadCurrentReviewSet(
        { read_state: services.dependencies.read_state, load_retained_result: services.dependencies.load_retained_result! },
        authority, phase,
      ),
      load_constitution: (commit) => resolvePinnedConstitution(services.runner, commit, services.authority.context),
      open_gate: openGate,
    }, {
      authority: services.authority, call, config: session.value.config,
      phase_kind: session.value.phase_kind, producer_family: session.value.producer_family,
      envelope: {
        artifact,
        rules: Object.freeze([...constitution.value.rules.values()]
          .filter((rule) => rule.status === "active")
          .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version)
          .map((rule) => Object.freeze({ id: rule.id, version: rule.version, text: rule.text,
            ...(rule.review_trigger === undefined ? {} : { review_trigger: rule.review_trigger }),
            enforced_by: Object.freeze([...(rule.enforced_by ?? [])]),
          }))),
        source_evidence_set_digest: currentReviews.value.current_evidence_set.set_digest,
        subject: {
          task_id: services.authority.task_id, phase_instance: state.value.phase_instance,
          role: "adjudication", step: "adjudicate", subject_digest: subjectDigest,
          input_fingerprint: call.input.input_fingerprint,
          pinned_constitution_digest: constitution.value.digest,
          approved_upstream_digests: approvedUpstreamDigests,
          source_evidence_set_digest: currentReviews.value.current_evidence_set.set_digest,
          invocation_id: stableId("adjudication-invocation", context.invocation_id), result_id: resultId,
        },
      },
    });
    if (!result.ok) return result;
    if (result.value.transaction === undefined) {
      return fail(createProjectError("GATE_ACTIVE", {
        gate_id: preDispatchGateId ?? parsePathSafeId(call.input.intent_id), gate_kind: "constitution-edit",
      }));
    }
    return ok(result.value.transaction.outcome);
  });
}
