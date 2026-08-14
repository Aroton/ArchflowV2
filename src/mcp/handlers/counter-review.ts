import { canonicalJsonDigest, sha256Bytes } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import {
  parseSafeId,
  parseSafeInteger,
  type SafeId,
  type SafeInteger,
} from "../../contracts/evidence.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import type { TaskPathClaim } from "../../contracts/path-claims.js";
import type { PlainJsonValue } from "../../contracts/plain-json.js";
import type { GitOid } from "../../contracts/canonical.js";
import type { TaskStateV1 } from "../../contracts/durable-state.js";
import { decodePhaseInstance } from "../../contracts/phase-instance.js";
import { createDispatchCoordinator } from "../../dispatch/coordinator.js";
import { readHeadCommit } from "../../repository/git.js";
import type { RootBoundGitRunner } from "../../repository/identity.js";
import { rulesForEnvelope } from "../../review/adjudication.js";
import { runCounterReview, type ConstitutionReviewPlan } from "../../review/counter-review.js";
import { canonicalRubricForPhaseKind } from "../../review/rubrics.js";
import {
  PRODUCED_REPOSITORY_VIEW_NOTE,
  REPOSITORY_VIEW_NOTE,
  REVIEW_ENVELOPE_BYTE_CAP,
  ReviewEnvelopeError,
  type AdjudicationUpstreamInput,
} from "../../review/envelopes.js";
import { requireApprovedUpstreamDigests } from "../../review/fixed-point.js";
import { assembleReviewContext } from "../../review/pinned-context.js";
import { resolvePinnedConstitution } from "../../state/constitution.js";
import {
  prepareEvidenceResult,
  type EvidenceResultValue,
  type PreparedEvidenceResult,
} from "../../state/evidence-results.js";
import { loadAuthenticatedGateApproval } from "../../state/gates.js";
import {
  expectedProduceUpstreamBindings,
  loadCurrentProduceSubject,
  loadProduceUpstreamSubject,
  readProduceProjection,
  renderProduceReviewMaterial,
  type CurrentProduceSubject,
  type ProduceProjection,
} from "../../state/produce-subject.js";
import type { ProductionServices } from "../../state/production.js";
import { mapHandlerErrors } from "./errors.js";
import { resolvePreDispatchReplay } from "./replay.js";
import { openHandlerSession } from "./session.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });
const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

function dispatchId(prefix: string, value: string): ReturnType<typeof parseSafeId> {
  return parseSafeId(`${prefix}-${sha256Bytes(new TextEncoder().encode(value)).slice(0, 32)}`);
}

function stableId(prefix: string, seed: PlainJsonValue): ReturnType<typeof parseSafeId> {
  return parseSafeId(`${prefix}-${canonicalJsonDigest(seed).slice(0, 32)}`);
}

/**
 * Translates a residual byte-cap failure — after cap relief exhausted every droppable context
 * entry — into `ENVELOPE_OVERFLOW` naming the largest compact output declarations. Source bodies
 * live in the sealed repository view and cannot cause this failure. Returns `undefined` (caller
 * rethrows) for any other failure, or when no output path can be named — the parameter schema
 * requires at least one path.
 */
export function envelopeOverflowError(
  error: unknown,
  subject: CurrentProduceSubject,
): ReturnType<typeof createProjectError> | undefined {
  if (!(error instanceof ReviewEnvelopeError)) return undefined;
  const parameters: Readonly<Record<string, unknown>> = error.project_error.diagnostic.parameters;
  if (parameters.issue_code !== "envelope-byte-cap") return undefined;
  if (subject.artifact.artifact_kind !== "implementation-output") return undefined;
  const encoder = new TextEncoder();
  const offending = subject.artifact.outputs
    .map((entry) => ({ path: entry.path, byte_count: encoder.encode(JSON.stringify(entry)).byteLength }))
    .sort((left, right) => right.byte_count - left.byte_count)
    .slice(0, 5)
    .map((contributor) => contributor.path)
    .sort((left, right) => left.localeCompare(right));
  if (offending.length === 0) return undefined;
  return createProjectError("ENVELOPE_OVERFLOW", {
    offending_paths: offending,
    current_bytes: error.envelope_byte_count ?? 0,
    byte_cap: REVIEW_ENVELOPE_BYTE_CAP,
  });
}

/**
 * Chooses the commit for the reviewer's read-only repository checkout. Document subjects use the
 * current HEAD — the same authority the mechanical evidence pins read from. Implementation-output
 * subjects use the artifact's attested `base_commit`; retained after-images are applied to that
 * baseline by the dispatch workspace.
 */
export async function resolveRepositoryViewCommit(
  runner: RootBoundGitRunner,
  artifact: CurrentProduceSubject["artifact"],
): Promise<GitOid> {
  return artifact.artifact_kind === "implementation-output"
    ? artifact.base_commit
    : readHeadCommit(runner);
}

/**
 * Derives the phase's exact workflow upstreams entirely from durable authority — the caller
 * declares nothing. Each upstream must be the retained produce artifact for its canonical path
 * and must hold a durable artifact-approval for its exact current digest.
 */
async function deriveApprovedUpstreams(
  services: ProductionServices,
  toolName: "archflow_counter_review",
  durable: TaskStateV1,
): Promise<ProjectResult<readonly AdjudicationUpstreamInput[]>> {
  const derived: AdjudicationUpstreamInput[] = [];
  for (const binding of expectedProduceUpstreamBindings(durable)) {
    const upstream = await loadProduceUpstreamSubject(services.dependencies, durable, binding);
    if (!upstream.ok) return upstream;
    const upstreamProjection = await readProduceProjection(
      services.runner, services.authority, upstream.value, binding.path,
    );
    if (!upstreamProjection.ok) return upstreamProjection;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(upstreamProjection.value.bytes);
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", {
        tool: toolName, issue_code: "adjudication-upstream-not-utf8",
      }));
    }
    const upstreamDigest = upstream.value.artifact_digest;
    let approved = false;
    for (const approval of [...durable.approvals]
      .filter((candidate) =>
        (candidate.gate_kind === "artifact-approval" || candidate.gate_kind === "design-approval") &&
        candidate.subject_digest === upstreamDigest)
      .sort((left, right) => right.resolved_at_revision - left.resolved_at_revision)) {
      const authenticated = await loadAuthenticatedGateApproval(
        services.dependencies, services.authority, approval,
      );
      if (!authenticated.ok) return authenticated;
      const request = authenticated.value.request;
      if ((request.kind === "artifact-approval" || request.kind === "design-approval") &&
          request.context.artifact_kind === binding.artifact_kind) {
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
}

/**
 * Prepares one dispatched review's evidence result. Both the rubric review and the constitution
 * review flow through here so their sibling results are measured against the same pre-commit
 * retained-byte base and the install-time staleness check re-derives the same value for each.
 */
async function prepareDispatchEvidence(
  services: ProductionServices,
  retainedBytes: NonNullable<ProductionServices["dependencies"]["read_retained_task_bytes"]>,
  resultId: SafeId,
  value: EvidenceResultValue,
  measuredAtRevision: SafeInteger,
): Promise<ProjectResult<PreparedEvidenceResult>> {
  return prepareEvidenceResult({
    authority: services.authority,
    runner: services.runner,
    result_id: resultId,
    retained_task_bytes: await retainedBytes(),
    measured_at_revision: measuredAtRevision,
    scanner: services.dependencies.gate_secret_scanner!,
    value,
  });
}

/**
 * Re-authenticates the reviewed subject after dispatch returns: durable state must still be
 * canonical, must still retain the same produce artifact, and the projection must re-read
 * cleanly. Returns the freshly observed projection digest for comparison against the
 * pre-dispatch pin.
 */
async function reobserveProjectionDigest(
  services: ProductionServices,
  phaseInstance: TaskStateV1["phase_instance"],
  expectedArtifactDigest: CurrentProduceSubject["artifact_digest"],
  artifactPath: TaskPathClaim,
): Promise<ProjectResult<ProduceProjection["digest"]>> {
  const current = await services.dependencies.read_state(services.authority.state);
  if (current.kind !== "canonical") return fail(createProjectError("STATE_INVALID", {
    phase_instance: phaseInstance, issue_code: "counter-review-state-not-current",
  }));
  const retained = await loadCurrentProduceSubject(services.dependencies, current.document.value);
  if (!retained.ok) return retained;
  if (retained.value.artifact_digest !== expectedArtifactDigest) return fail(createProjectError("STATE_INVALID", {
    phase_instance: phaseInstance, issue_code: "counter-review-subject-not-current",
  }));
  const observed = await readProduceProjection(
    services.runner, services.authority, retained.value, artifactPath,
  );
  return observed.ok
    ? Object.freeze({ schema_version: "1" as const, ok: true as const, value: observed.value.digest })
    : observed;
}

export async function handleCounterReview(
  call: Extract<ParsedToolCall, { name: "archflow_counter_review" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_counter_review">>> {
  return mapHandlerErrors<"archflow_counter_review">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const { services } = session.value;
    const state = services.state;
    if (state === undefined) {
      return fail(createProjectError("STATE_MISSING", { phase_instance: "prd" }));
    }
    const replay = await resolvePreDispatchReplay(
      services.dependencies,
      services.authority,
      call,
    );
    if (!replay.ok) return replay;
    if (replay.value !== undefined) {
      return Object.freeze({ schema_version: "1", ok: true, value: replay.value });
    }

    const produce = await loadCurrentProduceSubject(services.dependencies, state.value);
    if (!produce.ok) return produce;
    const projection = await readProduceProjection(
      services.runner, services.authority, produce.value, call.input.artifact_path,
    );
    if (!projection.ok) return projection;
    let artifact: string;
    try {
      artifact = renderProduceReviewMaterial(produce.value, projection.value);
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", {
        tool: call.name,
        issue_code: "artifact-not-utf8",
      }));
    }

    // The server, not the caller, decides whether the constitution review runs: it resolves the
    // pinned constitution itself and dispatches the second review exactly when active rules exist.
    const constitution = await resolvePinnedConstitution(
      services.runner, state.value.policy_base_commit, services.authority.context,
    );
    if (!constitution.ok) return constitution;
    const activeRules = [...constitution.value.rules.values()]
      .some((rule) => rule.status === "active");
    const repositoryViewCommit = await resolveRepositoryViewCommit(
      services.runner, produce.value.artifact,
    );
    const repositoryView = Object.freeze({
      base_commit: repositoryViewCommit,
      ...(produce.value.artifact.artifact_kind === "implementation-output"
        ? { projection_plan: produce.value.retained.projection_plan }
        : {}),
    });
    const workspaceBinding = produce.value.artifact.artifact_kind === "implementation-output"
      ? Object.freeze({
          kind: "read-only-produced-repository-snapshot" as const,
          base_commit: repositoryViewCommit,
          snapshot_digest: produce.value.artifact.snapshot_digest,
          note: PRODUCED_REPOSITORY_VIEW_NOTE,
        })
      : Object.freeze({
          kind: "read-only-repository-checkout" as const,
          commit: repositoryViewCommit,
          note: REPOSITORY_VIEW_NOTE,
        });

    const retainedBytes = services.dependencies.read_retained_task_bytes;
    if (retainedBytes === undefined) throw new TypeError("retained byte accounting is unavailable");
    const canonicalRubric = canonicalRubricForPhaseKind(
      decodePhaseInstance(state.value.phase_instance).kind,
    );

    let constitutionPlan: ConstitutionReviewPlan | undefined;
    if (activeRules) {
      const upstreams = await deriveApprovedUpstreams(services, call.name, state.value);
      if (!upstreams.ok) return upstreams;
      const approvedUpstreamDigests = requireApprovedUpstreamDigests(
        state.value.approvals,
        upstreams.value.map((item) => item.upstream_digest),
      );
      const constitutionResultId = stableId("adjudication-result", call.input.intent_id);
      const constitutionCoordinator = createDispatchCoordinator({
        authority: services.authority, dependencies: services.dependencies, host: session.value.host,
        repository_root: services.runner.location.worktreeRoot, phase_instance: state.value.phase_instance,
        signal: context.signal, cancellation_source: "client", allow_claude_dispatch: true,
        repository_view: repositoryView,
      });
      constitutionPlan = Object.freeze({
        registry: constitution.value.rules,
        pinned_constitution_digest: constitution.value.digest,
        rules: rulesForEnvelope(constitution.value.rules),
        approved_upstreams: upstreams.value,
        approved_upstream_digests: approvedUpstreamDigests,
        invocation_id: stableId("adjudication-invocation", context.invocation_id),
        result_id: constitutionResultId,
        workspace: workspaceBinding,
        dispatch: constitutionCoordinator,
        prepare_evidence: (evidence, measuredAtRevision) => prepareDispatchEvidence(
          services, retainedBytes, constitutionResultId, { kind: "adjudication", evidence }, measuredAtRevision,
        ),
      });
    }

    const context_entries = await assembleReviewContext({
      runner: services.runner,
      authority: services.authority,
      dependencies: services.dependencies,
      state: state.value,
      subject: produce.value,
      projection_bytes: projection.value.bytes,
    });
    if (!context_entries.ok) return context_entries;

    const resultId = dispatchId("result", call.input.intent_id);
    const coordinator = createDispatchCoordinator({
      authority: services.authority,
      dependencies: services.dependencies,
      host: session.value.host,
      repository_root: services.runner.location.worktreeRoot,
      phase_instance: state.value.phase_instance,
      signal: context.signal,
      cancellation_source: "client",
      // Both producer directions are implemented; release authorization remains a separate gate.
      allow_claude_dispatch: true,
      repository_view: repositoryView,
    });
    const result = await runCounterReview({
      transaction: services.dependencies,
      dispatch: coordinator,
      prepare_evidence: (evidence, measuredAtRevision) => prepareDispatchEvidence(
        services, retainedBytes, resultId, { kind: "review", evidence }, measuredAtRevision,
      ),
      reobserve_projection_digest: () => reobserveProjectionDigest(
        services, state.value.phase_instance, produce.value.artifact_digest, call.input.artifact_path,
      ),
    }, {
      authority: services.authority,
      call,
      config: session.value.config,
      phase_kind: session.value.phase_kind,
      producer_family: session.value.producer_family,
      measured_at_revision: session.value.measured_at_revision,
      envelope: {
        artifact,
        rubric: canonicalRubric.rubric,
        context: context_entries.value,
        workspace: workspaceBinding,
        subject: {
          task_id: services.authority.task_id,
          phase_instance: state.value.phase_instance,
          role: "counter-review",
          step: "counter_review",
          subject_digest: produce.value.artifact_digest,
          input_fingerprint: call.input.input_fingerprint,
          rubric_digest: canonicalRubric.rubric_digest,
          producer_family: session.value.producer_family,
          invocation_id: dispatchId("invocation", context.invocation_id),
          result_id: resultId,
        },
      },
      projection_digest: projection.value.digest,
      ...(constitutionPlan === undefined ? {} : { constitution: constitutionPlan }),
    }).catch((error: unknown) => {
      const overflow = envelopeOverflowError(error, produce.value);
      if (overflow !== undefined) return fail<never>(overflow);
      throw error;
    });
    if (!result.ok) return result;
    return Object.freeze({
      schema_version: "1",
      ok: true,
      value: result.value.transaction.outcome,
    });
  });
}
