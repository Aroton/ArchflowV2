/**
 * The staged observation document: immutable observation payload with its canonical
 * digest, per-field aggregates that never sum concurrent wall time, the separately bound
 * human assessment, the conclusion contract, and the stage/output path rules.
 */

import { lstat, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalJsonBytes, canonicalJsonDigest, type GitOid } from "../../../src/contracts/canonical.js";
import type { Sha256Digest } from "../../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../../src/contracts/plain-json.js";
import type { EfficiencyAttempt, EfficiencyCheckpoint, EfficiencyGroupRecord, EfficiencyJournal } from "./checkpoint.js";
import {
  CASE_ORACLE_CONTRACT,
  PLANNED_TURNS,
  REVIEW_EFFICIENCY_OUTPUT_ENV,
  REVIEW_EFFICIENCY_STAGE_ENV,
  type CaseId,
  type EfficiencyRole,
  type EfficiencyVariant,
} from "./plan.js";
import { aggregateUsage, repeatedSignatureCount, type UsageFields } from "./stream.js";

export type ReviewEfficiencyOutcome = Readonly<
  | { status: "completed"; output: string }
  | { status: "inconclusive"; reason: string; output?: string }
>;

// ---------------------------------------------------------------------------
// Observation document, aggregates, and conclusion contract
// ---------------------------------------------------------------------------

export type VariantAggregate = Readonly<{
  attempt_total: number;
  succeeded_total: number;
  failed_or_interrupted_total: number;
  tool_call_total: number;
  repeated_tool_signature_total: number;
}> & UsageFields;

export type ObservationAggregates = Readonly<{
  per_variant: Readonly<Record<EfficiencyVariant, VariantAggregate>>;
  per_variant_role: Readonly<Record<EfficiencyVariant, Readonly<Partial<Record<EfficiencyRole, VariantAggregate>>>>>;
}>;

/**
 * Aggregate role usage separately from concurrent wall time. Every attempt of a bucket —
 * succeeded, failed, or interrupted — contributes; each usage field is aggregated once across
 * all of the bucket's attempts and becomes unavailable unless every attempt exposes it, so a
 * measured subset is never presented as a bucket total. Concurrent wall time is never added
 * across roles; prompt size, report size, and elapsed time remain secondary observations and
 * never become token or billing claims.
 */
export function computeAggregates(groups: readonly EfficiencyGroupRecord[]): ObservationAggregates {
  const attemptsByBucket = new Map<string, EfficiencyAttempt[]>();
  const add = (bucket: string, attempts: readonly EfficiencyAttempt[]): void => {
    const existing = attemptsByBucket.get(bucket);
    attemptsByBucket.set(bucket, existing === undefined ? [...attempts] : [...existing, ...attempts]);
  };
  for (const group of groups) {
    add(group.variant, group.roles.flatMap((role) => role.attempts));
    for (const role of group.roles) {
      add(`${group.variant}/${role.role}`, role.attempts);
    }
  }
  const aggregate = (bucket: string): VariantAggregate => {
    const attempts = attemptsByBucket.get(bucket) ?? [];
    const succeeded = attempts.filter((attempt) => attempt.status === "succeeded");
    const toolCalls = attempts.flatMap((attempt) => attempt.tool_calls ?? []);
    return {
      attempt_total: attempts.length,
      succeeded_total: succeeded.length,
      failed_or_interrupted_total: attempts.length - succeeded.length,
      tool_call_total: toolCalls.length,
      repeated_tool_signature_total: repeatedSignatureCount(toolCalls),
      ...aggregateUsage(attempts.map((attempt) => attempt.usage ?? {})),
    };
  };
  return Object.freeze({
    per_variant: Object.freeze({
      old: Object.freeze(aggregate("old")),
      new: Object.freeze(aggregate("new")),
    }),
    per_variant_role: Object.freeze({
      old: Object.freeze(mapValues("old")),
      new: Object.freeze(mapValues("new")),
    }),
  });

  function mapValues(variant: EfficiencyVariant): Partial<Record<EfficiencyRole, VariantAggregate>> {
    const out: Partial<Record<EfficiencyRole, VariantAggregate>> = {};
    for (const role of ["general", "test", "constitution"] as const) {
      if (attemptsByBucket.has(`${variant}/${role}`)) out[role] = Object.freeze(aggregate(`${variant}/${role}`));
    }
    return out;
  }
}

export type DispositionSlot = Readonly<{
  case_id: CaseId;
  variant: EfficiencyVariant;
  role: EfficiencyRole;
  order: number;
}>;

export type DispositionRecord = DispositionSlot & Readonly<{
  defect_detected: "detected" | "missed" | "not-applicable" | "inconclusive" | null;
  unsupported_material_blocker: boolean | null;
  legacy_auth_scope_leak: boolean | null;
  follow_up_resolution_confirmed: boolean | "not-applicable" | null;
  rationale: string | null;
}>;

export function dispositionSlots(checkpoint: EfficiencyCheckpoint): readonly DispositionSlot[] {
  return Object.freeze(checkpoint.groups.flatMap((group) =>
    group.roles.map((role) => Object.freeze({
      case_id: group.case_id,
      variant: group.variant,
      role: role.role,
      order: group.order,
    }))));
}

export type EfficiencyObservationDocument = {
  schema_version: "1";
  observation_digest: Sha256Digest;
  observation_payload: PlainJsonValue;
  human_assessment: {
    observation_digest: Sha256Digest;
    dispositions: DispositionRecord[];
    repeated_investigation: string | null;
    final_assessment: "supported" | "mixed" | "inconclusive" | null;
    final_assessment_reason?: string;
  };
};

/** Builds the two-part staged document: the immutable observation and the pending human assessment. */
export function buildObservationDocument(checkpoint: EfficiencyCheckpoint): EfficiencyObservationDocument {
  const binding = checkpoint.experiment;
  const observation = {
    schema_version: "1",
    experiment_version: binding.experiment_version,
    source_commit: binding.source_commit,
    baseline: {
      provenance: binding.baseline_provenance,
      instructions_digest: binding.baseline_instructions_digest,
    },
    route: { requested: binding.requested_route },
    policy_digests: {
      rubric_digests: binding.rubric_digests,
      constitution_slots_digest: binding.constitution_slots_digest,
      output_schema_digests: binding.output_schema_digests,
    },
    cases: binding.cases,
    plan: { group_plan: binding.group_plan, planned_turns: PLANNED_TURNS },
    preflight_runs: checkpoint.preflight_runs,
    groups: checkpoint.groups,
    aggregates: computeAggregates(checkpoint.groups),
  };
  const observationDigest = canonicalJsonDigest(observation as unknown as PlainJsonValue);
  return {
    schema_version: "1",
    observation_digest: observationDigest,
    observation_payload: observation as unknown as PlainJsonValue,
    human_assessment: {
      observation_digest: observationDigest,
      dispositions: dispositionSlots(checkpoint).map((slot) => ({
        ...slot,
        defect_detected: null,
        unsupported_material_blocker: null,
        legacy_auth_scope_leak: null,
        follow_up_resolution_confirmed: null,
        rationale: null,
      })),
      repeated_investigation: null,
      final_assessment: null,
    },
  };
}

/** The harness fills only the measurement-loss conclusion; supported/mixed remain human judgments. */
export function fillInconclusiveAssessment(
  document: EfficiencyObservationDocument,
  reason: string,
): EfficiencyObservationDocument {
  return {
    ...document,
    human_assessment: {
      ...document.human_assessment,
      final_assessment: "inconclusive",
      final_assessment_reason: reason,
    },
  };
}

/**
 * Conclusion contract. Digest binding and disposition coverage are always enforced; the
 * decision rule's mechanical consequences are enforced per assessment:
 * - inconclusive must name the unavailable fields or failures;
 * - supported and mixed require fully decided dispositions;
 * - supported additionally requires no missed seeded or follow-up defect, no unsupported
 *   blocker, no scope leak, confirmed follow-up resolutions, complete role coverage, and
 *   available paired usage. The coherence judgment over the aggregates stays human.
 */
export function validateEfficiencyDocument(document: EfficiencyObservationDocument): void {
  if (document.schema_version !== "1") throw new TypeError("observation document must be schema_version 1");
  const digest = canonicalJsonDigest(document.observation_payload);
  if (digest !== document.observation_digest) {
    throw new TypeError("observation digest does not bind the observation payload");
  }
  if (document.human_assessment.observation_digest !== document.observation_digest) {
    throw new TypeError("human assessment does not bind the observation digest");
  }
  const payload = document.observation_payload as Readonly<Record<string, PlainJsonValue>>;
  const plan = payload.plan as Readonly<Record<string, PlainJsonValue>> | undefined;
  if (plan === undefined || !Array.isArray(plan.group_plan)) throw new TypeError("observation payload lacks the group plan");
  const expected = new Set(plan.group_plan.flatMap((entry) => {
    const record = entry as Readonly<Record<string, PlainJsonValue>>;
    return (record.roles as readonly EfficiencyRole[]).map((role) => slotKey(record.case_id as CaseId, record.variant as EfficiencyVariant, role));
  }));
  const seen = new Set<string>();
  for (const disposition of document.human_assessment.dispositions) {
    const key = slotKey(disposition.case_id, disposition.variant, disposition.role);
    if (seen.has(key)) throw new TypeError(`duplicate disposition for ${key}`);
    seen.add(key);
  }
  for (const key of expected) {
    if (!seen.has(key)) throw new TypeError(`missing disposition for ${key}`);
  }
  if (seen.size !== expected.size) throw new TypeError("dispositions do not cover exactly the planned slots");
  const final = document.human_assessment.final_assessment;
  if (final !== null && final !== "supported" && final !== "mixed" && final !== "inconclusive") {
    throw new TypeError(`final assessment ${String(final)} is outside the conclusion vocabulary`);
  }
  if (final === "inconclusive") {
    const reason = document.human_assessment.final_assessment_reason;
    if (reason === undefined || reason.trim() === "") {
      throw new TypeError("an inconclusive assessment must name the unavailable fields or failures");
    }
  }
  if (final === "supported" || final === "mixed") {
    for (const disposition of document.human_assessment.dispositions) {
      if (disposition.defect_detected === null || disposition.unsupported_material_blocker === null ||
          disposition.legacy_auth_scope_leak === null || disposition.follow_up_resolution_confirmed === null ||
          disposition.rationale === null) {
        throw new TypeError(`a ${String(final)} assessment requires fully decided dispositions (${slotKey(disposition.case_id, disposition.variant, disposition.role)})`);
      }
    }
  }
  if (final === "supported") {
    for (const disposition of document.human_assessment.dispositions) {
      const oracle = CASE_ORACLE_CONTRACT.find((entry) => entry.case_id === disposition.case_id)!;
      const qualityApplies = oracle.kind !== "control" || disposition.defect_detected === "not-applicable";
      if (oracle.kind !== "control" && disposition.defect_detected !== "detected") {
        throw new TypeError(`a supported assessment cannot miss a known defect (${slotKey(disposition.case_id, disposition.variant, disposition.role)})`);
      }
      if (!qualityApplies) throw new TypeError(`control case defect detection must be not-applicable (${slotKey(disposition.case_id, disposition.variant, disposition.role)})`);
      if (disposition.unsupported_material_blocker) {
        throw new TypeError(`a supported assessment cannot carry an unsupported blocker (${slotKey(disposition.case_id, disposition.variant, disposition.role)})`);
      }
      if (disposition.legacy_auth_scope_leak) {
        throw new TypeError(`a supported assessment cannot leak legacy-auth into scope (${slotKey(disposition.case_id, disposition.variant, disposition.role)})`);
      }
      if (oracle.kind === "follow-up" && disposition.role !== "constitution" && disposition.follow_up_resolution_confirmed !== true) {
        throw new TypeError(`a supported assessment must confirm follow-up resolution (${slotKey(disposition.case_id, disposition.variant, disposition.role)})`);
      }
    }
    const groups = payload.groups as readonly EfficiencyGroupRecord[];
    for (const group of groups) {
      for (const role of group.roles) {
        if (role.status !== "succeeded") {
          throw new TypeError(`a supported assessment requires complete role coverage (${group.case_id}/${group.variant}/${role.role})`);
        }
        for (const attempt of role.attempts) {
          if (attempt.status === "succeeded" &&
              (attempt.usage?.input_tokens === undefined || attempt.usage?.output_tokens === undefined)) {
            throw new TypeError(`a supported assessment requires available paired usage (${group.case_id}/${group.variant}/${role.role})`);
          }
        }
      }
    }
  }
}

function slotKey(caseId: CaseId, variant: EfficiencyVariant, role: EfficiencyRole): string {
  return `${caseId}/${variant}/${role}`;
}

// ---------------------------------------------------------------------------
// Stage/output validation and staged writes
// ---------------------------------------------------------------------------

/**
 * Explicit absolute stage and output paths: the stage must already exist as a non-symlink
 * directory under the OS temporary directory, and the output must be a nonexistent direct child
 * of the stage. Content layout (fresh vs. resumable) is validated separately.
 */
export async function validateEfficiencyStageAndOutput(
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ stage: string; output: string }> {
  const stageEnv = env[REVIEW_EFFICIENCY_STAGE_ENV];
  const outputEnv = env[REVIEW_EFFICIENCY_OUTPUT_ENV];
  if (stageEnv === undefined || stageEnv.trim() === "" || !isAbsolute(stageEnv)) {
    throw new TypeError(`${REVIEW_EFFICIENCY_STAGE_ENV} must be an explicit absolute path`);
  }
  if (outputEnv === undefined || outputEnv.trim() === "" || !isAbsolute(outputEnv)) {
    throw new TypeError(`${REVIEW_EFFICIENCY_OUTPUT_ENV} must be an explicit absolute path`);
  }
  if (stageEnv.includes("..") || resolve(stageEnv) !== stageEnv) {
    throw new TypeError(`${REVIEW_EFFICIENCY_STAGE_ENV} must not contain path traversal`);
  }
  if (outputEnv.includes("..") || resolve(outputEnv) !== outputEnv) {
    throw new TypeError(`${REVIEW_EFFICIENCY_OUTPUT_ENV} must not contain path traversal`);
  }
  const stageEntry = await lstat(stageEnv).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new TypeError(`${REVIEW_EFFICIENCY_STAGE_ENV} does not exist: ${stageEnv}`);
    throw error;
  });
  if (stageEntry.isSymbolicLink()) throw new TypeError(`${REVIEW_EFFICIENCY_STAGE_ENV} must not be a symlink`);
  if (!stageEntry.isDirectory()) throw new TypeError(`${REVIEW_EFFICIENCY_STAGE_ENV} is not a directory: ${stageEnv}`);
  const realStage = await realpath(stageEnv);
  const realTmp = await realpath(tmpdir());
  if (!realStage.startsWith(realTmp.endsWith("/") ? realTmp : `${realTmp}/`)) {
    throw new TypeError(`${REVIEW_EFFICIENCY_STAGE_ENV} must be located under the temporary directory ${realTmp}`);
  }
  if (dirname(outputEnv) !== stageEnv) {
    throw new TypeError(`${REVIEW_EFFICIENCY_OUTPUT_ENV} must be a direct child of ${REVIEW_EFFICIENCY_STAGE_ENV}`);
  }
  try {
    await lstat(outputEnv);
    throw new TypeError(`${REVIEW_EFFICIENCY_OUTPUT_ENV} already exists: ${outputEnv}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { stage: realStage, output: resolve(outputEnv) };
}

export async function writeStagedOutput(output: string, document: EfficiencyObservationDocument): Promise<void> {
  await writeFile(output, canonicalJsonBytes(document as unknown as PlainJsonValue), { flag: "wx", mode: 0o644 });
}

export async function writeInconclusive(
  journal: EfficiencyJournal,
  output: string,
  reason: string,
): Promise<ReviewEfficiencyOutcome> {
  const document = fillInconclusiveAssessment(buildObservationDocument(journal.value), reason);
  await writeStagedOutput(output, document);
  return { status: "inconclusive", reason, output };
}
