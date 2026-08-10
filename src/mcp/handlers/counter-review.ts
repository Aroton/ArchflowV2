import { canonicalJsonDigest, sha256Bytes } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parseSafeId } from "../../contracts/evidence.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import type { PlainJsonValue } from "../../contracts/plain-json.js";
import type { GitOid } from "../../contracts/canonical.js";
import { createDispatchCoordinator } from "../../dispatch/coordinator.js";
import { readHeadCommit } from "../../repository/git.js";
import type { RootBoundGitRunner } from "../../repository/identity.js";
import { runCounterReview } from "../../review/counter-review.js";
import {
  REPOSITORY_VIEW_NOTE,
  REVIEW_ENVELOPE_BYTE_CAP,
  ReviewEnvelopeError,
} from "../../review/envelopes.js";
import { assembleReviewContext } from "../../review/pinned-context.js";
import { prepareEvidenceResult } from "../../state/evidence-results.js";
import {
  loadCurrentProduceSubject,
  readProduceProjection,
  renderProduceReviewMaterial,
  resolveReviewExclusions,
  reviewChangeEntries,
  type CurrentProduceSubject,
  type ReviewExclusionReason,
} from "../../state/produce-subject.js";
import { mapHandlerErrors } from "./errors.js";
import { resolvePreDispatchReplay } from "./replay.js";
import { openHandlerSession } from "./session.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function dispatchId(prefix: string, value: string): ReturnType<typeof parseSafeId> {
  return parseSafeId(`${prefix}-${sha256Bytes(new TextEncoder().encode(value)).slice(0, 32)}`);
}

/**
 * Translates a residual byte-cap failure — after cap relief exhausted every droppable context
 * entry — into `ENVELOPE_OVERFLOW` naming the largest change-set contributors, so the producer
 * knows to split the phase or mark generated content `linguist-generated` rather than guess at a
 * bare byte count. Returns `undefined` (caller rethrows) for any other failure, or when no
 * change entry can be named — the parameter schema requires at least one path.
 */
export function envelopeOverflowError(
  error: unknown,
  subject: CurrentProduceSubject,
  exclusions: ReadonlyMap<string, ReviewExclusionReason>,
): ReturnType<typeof createProjectError> | undefined {
  if (!(error instanceof ReviewEnvelopeError)) return undefined;
  const parameters: Readonly<Record<string, unknown>> = error.project_error.diagnostic.parameters;
  if (parameters.issue_code !== "envelope-byte-cap") return undefined;
  const encoder = new TextEncoder();
  const offending = reviewChangeEntries(subject, exclusions)
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
 * subjects use the artifact's attested `base_commit`: the reviewer sees the pre-change tree, and
 * the changes themselves travel in the envelope's change entries.
 */
export async function resolveRepositoryViewCommit(
  runner: RootBoundGitRunner,
  artifact: CurrentProduceSubject["artifact"],
): Promise<GitOid> {
  return artifact.artifact_kind === "implementation-output"
    ? artifact.base_commit
    : readHeadCommit(runner);
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
    const exclusions = await resolveReviewExclusions(
      services.runner, produce.value, services.authority.context,
    );
    let artifact: string;
    try {
      artifact = renderProduceReviewMaterial(produce.value, projection.value, exclusions);
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", {
        tool: call.name,
        issue_code: "artifact-not-utf8",
      }));
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
    const repositoryViewCommit = await resolveRepositoryViewCommit(
      services.runner, produce.value.artifact,
    );
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
      repository_view_commit: repositoryViewCommit,
    });
    const retainedBytes = services.dependencies.read_retained_task_bytes;
    if (retainedBytes === undefined) throw new TypeError("retained byte accounting is unavailable");
    const result = await runCounterReview({
      transaction: services.dependencies,
      dispatch: coordinator,
      prepare_evidence: async (evidence, measuredAtRevision) => prepareEvidenceResult({
        authority: services.authority,
        runner: services.runner,
        result_id: resultId,
        retained_task_bytes: await retainedBytes(),
        measured_at_revision: measuredAtRevision,
        scanner: services.dependencies.gate_secret_scanner!,
        value: { kind: "review", evidence },
      }),
      reobserve_projection_digest: async () => {
        const current = await services.dependencies.read_state(services.authority.state);
        if (current.kind !== "canonical") return fail(createProjectError("STATE_INVALID", {
          phase_instance: state.value.phase_instance, issue_code: "counter-review-state-not-current",
        }));
        const retained = await loadCurrentProduceSubject(services.dependencies, current.document.value);
        if (!retained.ok) return retained;
        if (retained.value.artifact_digest !== produce.value.artifact_digest) return fail(createProjectError("STATE_INVALID", {
          phase_instance: state.value.phase_instance, issue_code: "counter-review-subject-not-current",
        }));
        const observed = await readProduceProjection(
          services.runner, services.authority, retained.value, call.input.artifact_path,
        );
        return observed.ok
          ? Object.freeze({ schema_version: "1" as const, ok: true as const, value: observed.value.digest })
          : observed;
      },
    }, {
      authority: services.authority,
      call,
      config: session.value.config,
      phase_kind: session.value.phase_kind,
      producer_family: session.value.producer_family,
      measured_at_revision: session.value.measured_at_revision,
      envelope: {
        artifact,
        rubric: call.input.rubric,
        context: context_entries.value,
        workspace: {
          kind: "read-only-repository-checkout",
          commit: repositoryViewCommit,
          note: REPOSITORY_VIEW_NOTE,
        },
        subject: {
          task_id: services.authority.task_id,
          phase_instance: state.value.phase_instance,
          role: "counter-review",
          step: "counter_review",
          subject_digest: produce.value.artifact_digest,
          input_fingerprint: call.input.input_fingerprint,
          rubric_digest: canonicalJsonDigest(call.input.rubric as unknown as PlainJsonValue),
          producer_family: session.value.producer_family,
          invocation_id: dispatchId("invocation", context.invocation_id),
          result_id: resultId,
        },
      },
      projection_digest: projection.value.digest,
    }).catch((error: unknown) => {
      const overflow = envelopeOverflowError(error, produce.value, exclusions);
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
