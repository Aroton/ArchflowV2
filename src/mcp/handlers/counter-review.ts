import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJsonDigest, sha256Bytes } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, describeValidationIssues, type ProjectError, type ProjectResult } from "../../contracts/errors.js";
import {
  parseSafeId,
  parseSafeInteger,
  type SafeId,
  type SafeInteger,
  type Sha256Digest,
} from "../../contracts/evidence.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import type { TaskPathClaim } from "../../contracts/path-claims.js";
import type { PlainJsonValue } from "../../contracts/plain-json.js";
import type { GitOid } from "../../contracts/canonical.js";
import {
  extractPhaseDesignComponentManifest,
  phaseDesignComponentManifestDigest,
  type PhaseDesignComponentManifestV1,
} from "../../contracts/component-manifest.js";
import type { TaskStateV1 } from "../../contracts/durable-state.js";
import { EFFORT_REVIEW_INSTRUCTIONS, IMPLEMENTATION_EFFORT_POLICY_ID, type EffortEnvelopeV1 } from "../../contracts/effort-review.js";
import {
  captureHazardRegistryInput,
  type HazardRegistryInputV1,
} from "../../contracts/hazard-registry.js";
import { decodePhaseInstance } from "../../contracts/phase-instance.js";
import { createDispatchCoordinator } from "../../dispatch/coordinator.js";
import {
  projectRepositoryWorkspaceBinding,
  projectReviewedRepositories,
  shareRepositoryViewWorkspace,
  type DispatchRepositoryViewPlan,
} from "../../dispatch/workspace.js";
import { createDispatchFailureObserver } from "../../dispatch/failure-observation.js";
import { createRetainedChildOutputStore } from "../../dispatch/retained-child-output.js";
import { readHeadCommit } from "../../repository/git.js";
import type { RootBoundGitRunner } from "../../repository/identity.js";
import { unavailableRepositoryView, type RepositorySet } from "../../repository/repository-set.js";
import { rulesForEnvelope } from "../../review/adjudication.js";
import { runCounterReview, type ConstitutionReviewPlan, type EffortReviewPlan } from "../../review/counter-review.js";
import { loadCanonicalRubricForPhaseKind } from "../../review/rubrics.js";
import {
  REVIEW_ENVELOPE_BYTE_CAP,
  ReviewEnvelopeError,
  type AdjudicationUpstreamInput,
} from "../../review/envelopes.js";
import { requireApprovedUpstreamDigests } from "../../review/fixed-point.js";
import { assembleReviewContext, loadPriorTriageRecord } from "../../review/pinned-context.js";
import { authenticateRuleAcceptancePolicy, resolvePinnedConstitution } from "../../state/constitution.js";
import {
  prepareEvidenceResult,
  type EvidenceResultValue,
  type PreparedEvidenceResult,
} from "../../state/evidence-results.js";
import { loadAuthenticatedGateApproval } from "../../state/gates.js";
import {
  acceptedNoWaitSettlement,
  authenticatedApprovalIsEligibleAfterLatestRestart,
} from "../../state/restart-authority.js";
import {
  loadCurrentProduceSubject,
  loadProduceUpstreamSubject,
  produceOwnedTaskDocumentPaths,
  produceProjectionSetDigest,
  produceUpstreamBindingsForSubject,
  readProduceProjection,
  readProduceProjectionSet,
  renderProduceReviewMaterial,
  type CurrentProduceSubject,
  type ProduceProjection,
} from "../../state/produce-subject.js";
import type { ProductionServices } from "../../state/production.js";
import type { ProjectionPlan } from "../../state/snapshots.js";
import type { RetainedResultInstallation } from "../../state/transaction.js";
import { mapHandlerErrors } from "./errors.js";
import { resolvePreDispatchReplay } from "./replay.js";
import { openHandlerSession } from "./session.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });
const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

/** Keeps a bounded actionable parser diagnostic at the public contract boundary. */
export function effortInputContractError(
  issueCode: "phase-design-component-manifest-invalid" | "hazard-registry-invalid-or-unreadable",
  error: unknown,
): ProjectError {
  const issues = describeValidationIssues(error);
  return createProjectError("CONTRACT_INVALID", {
    tool: "archflow_counter_review",
    issue_code: issueCode,
    ...(issues === undefined ? {} : { issues }),
  });
}

function dispatchId(prefix: string, value: string): ReturnType<typeof parseSafeId> {
  return parseSafeId(`${prefix}-${sha256Bytes(new TextEncoder().encode(value)).slice(0, 32)}`);
}

function stableId(prefix: string, seed: PlainJsonValue): ReturnType<typeof parseSafeId> {
  return parseSafeId(`${prefix}-${canonicalJsonDigest(seed).slice(0, 32)}`);
}

/** Reads the live-worktree registry once; only ENOENT has the explicit absent meaning. */
async function readHazardRegistryBytes(
  primaryRoot: string,
): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(join(primaryRoot, ".archflow", "hazards.yaml")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
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
  const taskPrefix = `.archflow/tasks/${subject.artifact.task_id}/`;
  const coProduced = subject.artifact.outputs.filter((entry) => entry.path.startsWith(taskPrefix));
  const candidates = coProduced.length === 0 ? subject.artifact.outputs : coProduced;
  const offending = candidates
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
  subject: CurrentProduceSubject,
): Promise<ProjectResult<Readonly<{
  inputs: readonly AdjudicationUpstreamInput[];
  authorities: readonly Readonly<{
    subject_digest: AdjudicationUpstreamInput["upstream_digest"];
    producer_phase: TaskStateV1["phase_instance"];
  }>[];
}>>> {
  const resolvedConstitution = await resolvePinnedConstitution(
    services.runner, durable.policy_base_commit, services.authority.context,
  );
  if (!resolvedConstitution.ok) return resolvedConstitution;
  const settlementPolicy = authenticateRuleAcceptancePolicy(durable, resolvedConstitution.value);
  const derived: AdjudicationUpstreamInput[] = [];
  const authorities: Array<Readonly<{
    subject_digest: AdjudicationUpstreamInput["upstream_digest"];
    producer_phase: TaskStateV1["phase_instance"];
  }>> = [];
  const seenOwners = new Set<string>();
  const coProducedPaths = produceOwnedTaskDocumentPaths(subject.artifact);
  for (const binding of produceUpstreamBindingsForSubject(durable, subject.artifact)) {
    const upstream = await loadProduceUpstreamSubject(services.dependencies, services.authority, durable, binding);
    if (!upstream.ok) return upstream;
    if (seenOwners.has(upstream.value.artifact_digest)) continue;
    const upstreamProjections = await readProduceProjectionSet(
      services.runner, services.authority, upstream.value, binding.path, coProducedPaths,
    );
    if (!upstreamProjections.ok) return upstreamProjections;
    let text: string;
    try {
      text = "imported_projection" in upstream.value
        ? new TextDecoder("utf-8", { fatal: true }).decode(upstreamProjections.value[0]!.bytes)
        : renderProduceReviewMaterial(
          upstream.value,
          upstreamProjections.value.find((projection) => projection.path === binding.path)!,
          upstreamProjections.value,
        );
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", {
        tool: toolName, issue_code: "adjudication-upstream-not-utf8",
      }));
    }
    const upstreamDigest = upstream.value.artifact_digest;
    let approved = "imported_projection" in upstream.value && durable.phase_instance === "design";
    if ("imported_projection" in upstream.value && !approved) {
      const repositoryPath = `.archflow/tasks/${durable.task_id}/${binding.path}`;
      const importedContentDigest = upstream.value.imported_projection.content_digest;
      for (const approval of durable.approvals.filter((candidate) => candidate.gate_kind === "migration-audit")) {
        const authenticated = await loadAuthenticatedGateApproval(services.dependencies, services.authority, approval);
        if (!authenticated.ok) return authenticated;
        if (!authenticatedApprovalIsEligibleAfterLatestRestart(durable, authenticated.value)) continue;
        if (
          authenticated.value.request.kind === "migration-audit" &&
          authenticated.value.decision.envelope.payload.decision === "accept-import-audit" &&
          authenticated.value.request.context.imported_documents?.some((document) =>
            document.path === repositoryPath && document.content_digest === importedContentDigest)
        ) {
          approved = true;
          break;
        }
      }
    }
    for (const approval of [...durable.approvals]
      .filter((candidate) =>
        (candidate.gate_kind === "artifact-approval" || candidate.gate_kind === "design-approval") &&
        candidate.subject_digest === upstreamDigest)
      .sort((left, right) => right.resolved_at_revision - left.resolved_at_revision)) {
      const authenticated = await loadAuthenticatedGateApproval(
        services.dependencies, services.authority, approval,
      );
      if (!authenticated.ok) return authenticated;
      if (!authenticatedApprovalIsEligibleAfterLatestRestart(
        durable, authenticated.value, upstream.value.artifact.phase_instance,
      )) continue;
      const request = authenticated.value.request;
      const ownerKind = decodePhaseInstance(upstream.value.artifact.phase_instance).kind;
      if ((request.kind === "artifact-approval" || request.kind === "design-approval") &&
          request.context.artifact_kind === ownerKind) {
        approved = true;
        break;
      }
    }
    if (!approved && settlementPolicy !== undefined && "reference" in upstream.value) {
      approved = acceptedNoWaitSettlement(
        settlementPolicy,
        durable,
        upstreamDigest,
        upstream.value.artifact.phase_instance,
      ) !== undefined;
    }
    if (!approved) {
      return fail(createProjectError("STATE_INVALID", {
        phase_instance: durable.phase_instance, issue_code: "upstream-approval-missing",
      }));
    }
    seenOwners.add(upstreamDigest);
    derived.push(Object.freeze({ upstream_digest: upstreamDigest, artifact: text }));
    authorities.push(Object.freeze({
      subject_digest: upstreamDigest,
      producer_phase: upstream.value.artifact.phase_instance,
    }));
  }
  derived.sort((left, right) => left.upstream_digest.localeCompare(right.upstream_digest));
  authorities.sort((left, right) => left.subject_digest.localeCompare(right.subject_digest));
  return ok(Object.freeze({
    inputs: Object.freeze(derived),
    authorities: Object.freeze(authorities),
  }));
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
  const observed = await readProduceProjectionSet(
    services.runner, services.authority, retained.value, artifactPath,
  );
  return observed.ok
    ? Object.freeze({ schema_version: "1" as const, ok: true as const, value: produceProjectionSetDigest(observed.value) })
    : observed;
}

type RepositoryHeadPin = Readonly<{ name: string; commit: GitOid }>;

/**
 * A declared secondary the session could not open or observe is, to the review caller, a missing
 * read-only view rather than a configuration fault: the declaration may be correct and the
 * repository merely absent right now, so the failure is retryable and names the member. Applied
 * wherever the handler opens its session — before dispatch and at the post-dispatch recheck — so
 * the same loss is reported the same way whenever it happens.
 */
function asRepositoryViewFailure<T>(result: ProjectResult<T>): ProjectResult<T> {
  if (result.ok) return result;
  const unavailable = unavailableRepositoryView(result.error);
  return unavailable === undefined
    ? result
    : fail(createProjectError("REPOSITORY_VIEW_UNAVAILABLE", { repository_name: unavailable.repository_name }));
}

/**
 * Read-only freshness check for the secondary sections a retained implementation result was
 * produced against: each section's member must still be present, writable, the same repository,
 * and at the base commit the result was built on. The full retained-result installation (payload
 * bytes and a fresh secret scan) was already loaded before dispatch and is not re-run here.
 */
function secondarySectionsAreCurrent(
  artifact: CurrentProduceSubject["artifact"],
  repositorySet: RepositorySet,
): boolean {
  if (artifact.artifact_kind !== "implementation-output") return true;
  const members = new Map(repositorySet.members.map((member) => [member.name, member]));
  return (artifact.secondary_repositories ?? []).every((section) => {
    const member = members.get(section.repository);
    return member !== undefined && member.mode === "writable" &&
      member.identity.digest === section.repository_identity_digest && member.head === section.base_commit;
  });
}

/**
 * Reopens the authenticated handler session after every dispatched child has returned, then
 * checks the location-free repository-set identity and every member whose review view was pinned
 * to live HEAD. This extends the existing retained-artifact/projection proof without creating a
 * second membership authority in the dispatch path.
 */
async function reobserveDispatchSubject(
  call: Extract<ParsedToolCall, { name: "archflow_counter_review" }>,
  context: InvocationContext,
  phaseInstance: TaskStateV1["phase_instance"],
  expectedArtifactDigest: CurrentProduceSubject["artifact_digest"],
  artifactPath: TaskPathClaim,
  expectedRepositorySetDigest: Sha256Digest,
  headPins: readonly RepositoryHeadPin[],
): Promise<ProjectResult<ProduceProjection["digest"]>> {
  const fresh = asRepositoryViewFailure(await openHandlerSession(call, context));
  if (!fresh.ok) return fresh;
  if (fresh.value.repository_set.digest !== expectedRepositorySetDigest) {
    return fail(createProjectError("STATE_INVALID", {
      phase_instance: phaseInstance, issue_code: "counter-review-subject-not-current",
    }));
  }
  const currentMembers = new Map(fresh.value.repository_set.members.map((member) => [member.name, member]));
  if (headPins.some((pin) => currentMembers.get(pin.name)?.head !== pin.commit)) {
    return fail(createProjectError("STATE_INVALID", {
      phase_instance: phaseInstance, issue_code: "counter-review-subject-not-current",
    }));
  }
  const current = await fresh.value.services.dependencies.read_state(fresh.value.services.authority.state);
  if (current.kind !== "canonical") return fail(createProjectError("STATE_INVALID", {
    phase_instance: phaseInstance, issue_code: "counter-review-state-not-current",
  }));
  const produce = await loadCurrentProduceSubject(fresh.value.services.dependencies, current.document.value);
  if (!produce.ok) return produce;
  if (!secondarySectionsAreCurrent(produce.value.artifact, fresh.value.repository_set)) {
    return fail(createProjectError("STATE_INVALID", {
      phase_instance: phaseInstance, issue_code: "counter-review-subject-not-current",
    }));
  }
  return reobserveProjectionDigest(
    fresh.value.services, phaseInstance, expectedArtifactDigest, artifactPath,
  );
}

export async function handleCounterReview(
  call: Extract<ParsedToolCall, { name: "archflow_counter_review" }>,
  context: InvocationContext,
  dispatchAlreadySerialized = false,
): Promise<ProjectResult<ToolSuccess<"archflow_counter_review">>> {
  return mapHandlerErrors<"archflow_counter_review">(context.invocation_id, async () => {
    const session = asRepositoryViewFailure(await openHandlerSession(call, context));
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
    const projections = await readProduceProjectionSet(
      services.runner, services.authority, produce.value, call.input.artifact_path,
    );
    if (!projections.ok) return projections;
    let artifact: string;
    try {
      artifact = renderProduceReviewMaterial(produce.value, projection.value, projections.value);
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", {
        tool: call.name,
        issue_code: "artifact-not-utf8",
      }));
    }

    // Effort inputs are phase-design-only and are validated before any route selection or child
    // launch. The registry is deliberately captured once from the authenticated primary live
    // worktree; the post-dispatch freshness proof does not read this non-authoritative input again.
    let phaseDesignArtifact: string | undefined;
    let componentManifest: PhaseDesignComponentManifestV1 | undefined;
    let hazardRegistry: HazardRegistryInputV1 | undefined;
    if (session.value.phase_kind === "phase-design") {
      try {
        phaseDesignArtifact = new TextDecoder("utf-8", { fatal: true }).decode(projection.value.bytes);
        const repositoryNames = session.value.repository_set.members.map((member) => member.name);
        componentManifest = extractPhaseDesignComponentManifest(phaseDesignArtifact, repositoryNames);
      } catch (error) {
        return fail(effortInputContractError("phase-design-component-manifest-invalid", error));
      }
      try {
        const repositoryNames = session.value.repository_set.members.map((member) => member.name);
        hazardRegistry = await captureHazardRegistryInput(
          () => readHazardRegistryBytes(services.runner.location.worktreeRoot),
          repositoryNames,
          componentManifest!,
        );
      } catch (error) {
        return fail(effortInputContractError("hazard-registry-invalid-or-unreadable", error));
      }
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
    // Review dispatch is the only consumer of the retained projection plan, so it is also the only
    // path that reloads the full installation — payload bytes, before-images, and the secret scan.
    // The subject itself carries a manifest, which is all every other reader needs.
    let projectionPlan: ProjectionPlan | undefined;
    let secondaryProjectionPlans: RetainedResultInstallation["secondary_projection_plans"];
    if (produce.value.artifact.artifact_kind === "implementation-output") {
      const loadRetained = services.dependencies.load_retained_result;
      if (loadRetained === undefined) throw new TypeError("retained result loading is unavailable");
      const retained = await loadRetained(produce.value.reference);
      if (!retained.ok) return retained;
      projectionPlan = retained.value.projection_plan;
      secondaryProjectionPlans = retained.value.secondary_projection_plans;
    }
    const secondaryPlans = new Map((secondaryProjectionPlans ?? []).map((entry) => [entry.repository, entry]));
    for (const member of session.value.repository_set.members.slice(1)) {
      const retained = secondaryPlans.get(member.name as never);
      if (retained !== undefined &&
          (retained.repository_identity_digest !== member.identity.digest || retained.base_commit !== member.head)) {
        return fail(createProjectError("STATE_INVALID", {
          phase_instance: state.value.phase_instance,
          issue_code: "counter-review-subject-not-current",
        }));
      }
    }
    const repositoryViews: DispatchRepositoryViewPlan = Object.freeze(
      session.value.repository_set.members.map((member, index) => Object.freeze({
        name: member.name,
        member_kind: index === 0 ? "primary" as const : "secondary" as const,
        repository_root: member.binding.runner.location.worktreeRoot,
        repository_identity_digest: member.identity.digest,
        commit: index === 0 ? repositoryViewCommit : member.head,
        ...(index === 0 && projectionPlan !== undefined ? {
          projection_plan: projectionPlan,
          snapshot_digest: produce.value.artifact.snapshot_digest,
        } : index === 0 ? {} : (() => {
          const retained = secondaryPlans.get(member.name as never);
          if (retained === undefined) return {};
          return { projection_plan: retained.projection_plan, snapshot_digest: retained.snapshot_digest };
        })()),
      })),
    );
    const headPins: readonly RepositoryHeadPin[] = Object.freeze(
      repositoryViews
        .filter((member) => member.projection_plan === undefined)
        .map((member) => Object.freeze({ name: member.name, commit: member.commit })),
    );
    const reviewedRepositories = projectReviewedRepositories(repositoryViews);
    const workspaceBinding = projectRepositoryWorkspaceBinding(repositoryViews);
    let effortPlan: EffortReviewPlan | undefined;
    if (phaseDesignArtifact !== undefined && componentManifest !== undefined && hazardRegistry !== undefined) {
      const effortResultId = stableId("effort-result", call.input.intent_id);
      const effortEnvelope: EffortEnvelopeV1 = Object.freeze({
        schema_version: "1",
        artifact: phaseDesignArtifact,
        instructions: EFFORT_REVIEW_INSTRUCTIONS,
        task_id: services.authority.task_id,
        phase_instance: state.value.phase_instance,
        attempt: state.value.attempt,
        subject_digest: produce.value.artifact_digest,
        input_fingerprint: call.input.input_fingerprint,
        invocation_id: stableId("effort-invocation", call.input.intent_id),
        result_id: effortResultId,
        policy_id: IMPLEMENTATION_EFFORT_POLICY_ID,
        component_manifest_digest: phaseDesignComponentManifestDigest(componentManifest),
        component_manifest: componentManifest,
        hazard_registry: hazardRegistry,
        repositories: reviewedRepositories,
      });
      effortPlan = Object.freeze({ envelope: effortEnvelope });
    }
    // The rubric and constitution children receive byte-identical repository views, so one
    // materialization serves both; the handle is disposed after runCounterReview settles.
    const sharedWorkspace = shareRepositoryViewWorkspace(
      repositoryViews,
      services.runner.location.worktreeRoot,
    );

    const retainedBytes = services.dependencies.read_retained_task_bytes;
    if (retainedBytes === undefined) throw new TypeError("retained byte accounting is unavailable");
    const loadedRubric = await loadCanonicalRubricForPhaseKind(
      decodePhaseInstance(state.value.phase_instance).kind,
    );
    if (!loadedRubric.ok) return loadedRubric;
    const canonicalRubric = loadedRubric.value;

    let constitutionPlan: ConstitutionReviewPlan | undefined;
    if (activeRules) {
      const upstreams = await deriveApprovedUpstreams(services, call.name, state.value, produce.value);
      if (!upstreams.ok) return upstreams;
      // `deriveApprovedUpstreams` has already authenticated every human/import/settlement arm with
      // its exact producer phase. Do not collapse that proof and re-scan digest-only approvals.
      const approvedUpstreamDigests = requireApprovedUpstreamDigests(
        upstreams.value.authorities,
      );
      const constitutionResultId = stableId("adjudication-result", call.input.intent_id);
      const constitutionCoordinator = createDispatchCoordinator({
        authority: services.authority, dependencies: services.dependencies, host: session.value.host,
        repository_root: services.runner.location.worktreeRoot, phase_instance: state.value.phase_instance,
        signal: context.signal, cancellation_source: "client",
        shared_workspace: sharedWorkspace,
      });
      constitutionPlan = Object.freeze({
        registry: constitution.value.rules,
        pinned_constitution_digest: constitution.value.digest,
        rules: rulesForEnvelope(constitution.value.rules),
        approved_upstreams: upstreams.value.inputs,
        approved_upstream_digests: approvedUpstreamDigests,
        invocation_id: stableId("adjudication-invocation", call.input.intent_id),
        result_id: constitutionResultId,
        workspace: workspaceBinding,
        dispatch: constitutionCoordinator,
        prepare_evidence: (evidence, measuredAtRevision) => prepareDispatchEvidence(
          services, retainedBytes, constitutionResultId, { kind: "adjudication", evidence }, measuredAtRevision,
        ),
      });
    }

    const priorTriage = await loadPriorTriageRecord(services.dependencies, state.value);
    if (!priorTriage.ok) return priorTriage;
    const context_entries = await assembleReviewContext({
      runner: services.runner,
      authority: services.authority,
      dependencies: services.dependencies,
      state: state.value,
      subject: produce.value,
      projection_bytes: projection.value.bytes,
      ...(projectionPlan === undefined ? {} : { projection_plan: projectionPlan }),
      ...(priorTriage.value === undefined ? {} : { prior_triage: priorTriage.value }),
    });
    if (!context_entries.ok) return context_entries;

    // Every id the children see — review invocation and result, adjudication invocation and
    // result — derives from the round's intent rather than the MCP call, so a retry of the same
    // round re-seals byte-identical envelopes and its retained child outputs stay bound to them.
    const resultId = dispatchId("result", call.input.intent_id);
    const coordinator = createDispatchCoordinator({
      authority: services.authority,
      dependencies: services.dependencies,
      host: session.value.host,
      repository_root: services.runner.location.worktreeRoot,
      phase_instance: state.value.phase_instance,
      signal: context.signal,
      cancellation_source: "client",
      shared_workspace: sharedWorkspace,
    });
    const retainedOutputs = createRetainedChildOutputStore({
      authority: services.authority,
      dependencies: services.dependencies,
      phase_instance: state.value.phase_instance,
      attempt: state.value.attempt,
    });
    const result = await runCounterReview({
      transaction: services.dependencies,
      dispatch: coordinator,
      observe_failure: createDispatchFailureObserver({
        authority: services.authority,
        dependencies: services.dependencies,
        phase_instance: state.value.phase_instance,
        attempt: state.value.attempt,
        observed_at_revision: state.value.revision,
      }),
      ...(retainedOutputs === undefined ? {} : { retained_outputs: retainedOutputs }),
      ...(dispatchAlreadySerialized ? {
        serialize_dispatch: async <T>(operation: () => Promise<T>) => operation(),
        serialize_dispatch_all: async <T>(ops: readonly (() => Promise<T>)[]) =>
          Promise.all(ops.map((op) => op())),
      } : {}),
      prepare_evidence: (evidence, measuredAtRevision) => prepareDispatchEvidence(
        services, retainedBytes, resultId, { kind: "review", evidence }, measuredAtRevision,
      ),
      reobserve_projection_digest: () => reobserveDispatchSubject(
        call,
        context,
        state.value.phase_instance,
        produce.value.artifact_digest,
        call.input.artifact_path,
        session.value.repository_set.digest,
        headPins,
      ),
    }, {
      authority: services.authority,
      call,
      config: session.value.config,
      phase_kind: session.value.phase_kind,
      producer_family: session.value.producer_family,
      host: session.value.host,
      measured_at_revision: session.value.measured_at_revision,
      repositories: reviewedRepositories,
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
          invocation_id: dispatchId("invocation", call.input.intent_id),
          result_id: resultId,
        },
      },
      projection_digest: produceProjectionSetDigest(projections.value),
      ...(priorTriage.value === undefined ? {} : { prior_triage: priorTriage.value }),
      ...(constitutionPlan === undefined ? {} : { constitution: constitutionPlan }),
      ...(effortPlan === undefined ? {} : { effort: effortPlan }),
    }).catch((error: unknown) => {
      const overflow = envelopeOverflowError(error, produce.value);
      if (overflow !== undefined) return fail<never>(overflow);
      throw error;
    }).finally(() => sharedWorkspace.dispose());
    if (!result.ok) return result;
    return Object.freeze({
      schema_version: "1",
      ok: true,
      value: result.value.transaction.outcome,
    });
  });
}

/** Semantic review owns the outer FIFO across replay, dispatch, and commit, so inner dispatch is direct. */
export function handleCounterReviewWithinDispatch(
  call: Extract<ParsedToolCall, { name: "archflow_counter_review" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_counter_review">>> {
  return handleCounterReview(call, context, true);
}
