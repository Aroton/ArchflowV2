/**
 * The experiment binding and the recoverable test-local checkpoint journal: atomic
 * pending-plus-rename updates, resume promotion and discard rules, and leftover-`running`
 * interruption on resume.
 */

import { lstat, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRawAdjudicationV2Schema, type AdjudicationRuleSlotV1 } from "../../../src/contracts/adjudication.js";
import { canonicalJsonBytes, canonicalJsonDigest, parseCanonicalDocument, parseGitOid, sha256Bytes, type GitOid } from "../../../src/contracts/canonical.js";
import type { Sha256Digest } from "../../../src/contracts/evidence.js";
import { assertPlainJson, type PlainJsonValue } from "../../../src/contracts/plain-json.js";
import { reviewReportOutputSchema, type ReviewFeedbackOutput } from "../../../src/contracts/review.js";
import type { DispatchRoute } from "../../../src/dispatch/routing.js";
import type { BaselineInstructions } from "./baseline.js";
import {
  CHECKPOINT_FILENAME,
  CONSTITUTION_RULE_SLOTS,
  EXPERIMENT_VERSION,
  GROUP_PLAN,
  PENDING_FILENAME,
  REVIEW_EFFICIENCY_ROUTE,
  type CaseId,
  type EfficiencyRole,
  type EfficiencyVariant,
  type GroupPlanEntry,
} from "./plan.js";
import type { StreamToolCall, UsageFields } from "./stream.js";

// ---------------------------------------------------------------------------
// Experiment binding and recoverable checkpoint journal
// ---------------------------------------------------------------------------

export type EfficiencyBinding = Readonly<{
  experiment_version: typeof EXPERIMENT_VERSION;
  source_commit: GitOid;
  baseline_instructions_digest: Sha256Digest;
  baseline_provenance: Readonly<{
    source_commit: string;
    envelopes_blob: string;
    simple_review_blob: string;
  }>;
  requested_route: DispatchRoute;
  rubric_digests: Readonly<{ design: Sha256Digest; phase_impl: Sha256Digest }>;
  constitution_slots_digest: Sha256Digest;
  output_schema_digests: Readonly<{ review: Sha256Digest; adjudication: Sha256Digest }>;
  cases: readonly Readonly<{
    case_id: CaseId;
    input_digest: Sha256Digest;
    artifact_digest: Sha256Digest;
    roles: readonly EfficiencyRole[];
  }>[];
  group_plan: readonly GroupPlanEntry[];
}>;

export type AttemptStatus = "running" | "succeeded" | "failed" | "interrupted";

export type EfficiencyAttempt = Readonly<{
  index: number;
  status: AttemptStatus;
  started_at: string;
  elapsed_ms?: number;
  failure?: Readonly<{ code: string; message: string; transient: boolean; parameters?: PlainJsonValue }>;
  envelope_digest?: Sha256Digest;
  extracted_output_digest?: Sha256Digest;
  invocation_fingerprint?: Sha256Digest;
  accepted_model?: string;
  usage?: UsageFields;
  usage_raw?: PlainJsonValue;
  tool_calls?: readonly StreamToolCall[];
  /** The CLI's own schema-emission mechanism; never part of investigation totals. */
  structured_output_calls?: readonly StreamToolCall[];
  outcome?: ReviewFeedbackOutput["outcome"];
  feedback?: string;
  judgments?: PlainJsonValue;
  cli_version?: string;
  managed_policy_present?: boolean;
}>;

export type EfficiencyRoleRecord = Readonly<{
  role: EfficiencyRole;
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: EfficiencyAttempt[];
}>;

export type EfficiencyGroupRecord = Readonly<{
  order: number;
  group_id: string;
  case_id: CaseId;
  variant: EfficiencyVariant;
  status: "pending" | "running" | "completed";
  started_at?: string;
  finished_at?: string;
  wall_time_ms?: number;
  roles: EfficiencyRoleRecord[];
}>;

export type PreflightRecord = Readonly<{
  status: "running" | "succeeded" | "failed" | "interrupted";
  started_at: string;
  finished_at?: string;
  cli_version?: string;
  managed_policy_present?: boolean;
  managed_policy_paths?: readonly string[];
  failure?: Readonly<{ code: string; message: string }>;
}>;

export type EfficiencyCheckpoint = Readonly<{
  schema_version: "1";
  experiment: EfficiencyBinding;
  generation: number;
  prior_digest: Sha256Digest;
  preflight_runs: PreflightRecord[];
  groups: EfficiencyGroupRecord[];
}>;

/** Digest of the empty byte string: the chain root for generation 1. */
export const INITIAL_CHECKPOINT_DIGEST = sha256Bytes(new Uint8Array(0));

/** Deeply mutable view of a checkpoint draft inside a journal update closure. */
export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends PlainJsonValue
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

export function checkpointDocumentDigest(checkpoint: EfficiencyCheckpoint): Sha256Digest {
  return canonicalJsonDigest(checkpoint);
}

export function buildExperimentBinding(input: Readonly<{
  sourceCommit: GitOid;
  baseline: BaselineInstructions;
  rubricDigests: Readonly<{ design: Sha256Digest; phase_impl: Sha256Digest }>;
  caseInputs: readonly Readonly<{ case_id: CaseId; input_digest: Sha256Digest; artifact_digest: Sha256Digest; roles: readonly EfficiencyRole[] }>[];
}>): EfficiencyBinding {
  // The JSON round-trip strips zod's non-enumerable `~standard` hook, exactly as the
  // production dispatcher does before the generated schema is treated as a JSON value.
  const reviewSchema = JSON.parse(JSON.stringify(reviewReportOutputSchema.toJSONSchema({ target: "draft-2020-12" }))) as PlainJsonValue;
  const adjudicationSchema = JSON.parse(JSON.stringify(createRawAdjudicationV2Schema(CONSTITUTION_RULE_SLOTS)
    .toJSONSchema({ target: "draft-2020-12" }))) as PlainJsonValue;
  return Object.freeze({
    experiment_version: EXPERIMENT_VERSION,
    source_commit: input.sourceCommit,
    baseline_instructions_digest: canonicalJsonDigest(input.baseline),
    baseline_provenance: Object.freeze({
      source_commit: input.baseline.provenance.source_commit,
      envelopes_blob: input.baseline.provenance.envelopes_blob,
      simple_review_blob: input.baseline.provenance.simple_review_blob,
    }),
    requested_route: REVIEW_EFFICIENCY_ROUTE,
    rubric_digests: Object.freeze(input.rubricDigests),
    constitution_slots_digest: canonicalJsonDigest(CONSTITUTION_RULE_SLOTS),
    output_schema_digests: Object.freeze({
      review: canonicalJsonDigest(reviewSchema),
      adjudication: canonicalJsonDigest(adjudicationSchema),
    }),
    cases: Object.freeze(input.caseInputs.map((entry) => Object.freeze({ ...entry }))),
    group_plan: GROUP_PLAN,
  });
}

export function freshCheckpoint(binding: EfficiencyBinding): EfficiencyCheckpoint {
  return Object.freeze({
    schema_version: "1",
    experiment: binding,
    generation: 1,
    prior_digest: INITIAL_CHECKPOINT_DIGEST,
    preflight_runs: [],
    groups: GROUP_PLAN.map((entry) => Object.freeze({
      order: entry.order,
      group_id: entry.group_id,
      case_id: entry.case_id,
      variant: entry.variant,
      status: "pending" as const,
      roles: entry.roles.map((role) => ({
        role,
        status: "pending" as const,
        attempts: [] as EfficiencyAttempt[],
      })),
    })),
  });
}

export type StageLayout = Readonly<{ mode: "fresh" | "resume" | "resume-pending" }>;

/**
 * Stage layout contract: the stage is an existing non-symlink directory directly under the OS
 * temporary directory; a fresh run is empty, and a resume may contain only the canonical
 * checkpoint plus at most one interrupted pending file. Anything else fails closed.
 */
export async function validateStageLayout(stage: string, output: string): Promise<StageLayout> {
  const stageLstat = await lstat(stage);
  if (stageLstat.isSymbolicLink()) throw new TypeError(`efficiency stage must not be a symlink: ${stage}`);
  if (!stageLstat.isDirectory()) throw new TypeError(`efficiency stage is not a directory: ${stage}`);
  const realStage = await realpath(stage);
  const realTmp = await realpath(tmpdir());
  if (!realStage.startsWith(realTmp.endsWith("/") ? realTmp : `${realTmp}/`)) {
    throw new TypeError(`efficiency stage must be located under the temporary directory ${realTmp}`);
  }
  const entries = await readdir(realStage);
  const allowed = new Set([CHECKPOINT_FILENAME, PENDING_FILENAME]);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new TypeError(`efficiency stage contains unexpected entries: ${entries.join(", ")}`);
  }
  let outputExists = false;
  try {
    await lstat(output);
    outputExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (outputExists) throw new TypeError(`efficiency output already exists: ${output}`);
  const hasCheckpoint = entries.includes(CHECKPOINT_FILENAME);
  const hasPending = entries.includes(PENDING_FILENAME);
  if (!hasCheckpoint) {
    if (entries.length !== 0) {
      throw new TypeError("efficiency stage has a pending file without a canonical checkpoint");
    }
    return { mode: "fresh" };
  }
  return { mode: hasPending ? "resume-pending" : "resume" };
}

/**
 * Loads a fresh or resumed checkpoint. On resume the experiment binding must match exactly; a
 * pending file is promoted only when its generation and prior digest extend the canonical
 * checkpoint, and otherwise discarded only while the canonical checkpoint stays valid. Leftover
 * `running` records become `interrupted` so an interrupted provider call is never erased.
 */
export async function loadEfficiencyCheckpoint(
  stage: string,
  binding: EfficiencyBinding,
  layout: StageLayout,
): Promise<EfficiencyCheckpoint> {
  if (layout.mode === "fresh") return freshCheckpoint(binding);
  const canonicalPath = join(stage, CHECKPOINT_FILENAME);
  const canonicalBytes = new Uint8Array(await readFile(canonicalPath));
  let canonical = parseCheckpointBytes(canonicalBytes, "canonical checkpoint");
  const pendingPath = join(stage, PENDING_FILENAME);
  let pendingBytes: Uint8Array | undefined;
  try {
    pendingBytes = new Uint8Array(await readFile(pendingPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pendingBytes !== undefined) {
    let pending: EfficiencyCheckpoint | undefined;
    try {
      pending = parseCheckpointBytes(pendingBytes, "pending checkpoint");
    } catch {
      pending = undefined;
    }
    const extendsCanonical = pending !== undefined &&
      pending.generation === canonical.generation + 1 &&
      pending.prior_digest === canonicalJsonDigest(canonical);
    if (extendsCanonical && pending !== undefined) {
      await rename(pendingPath, canonicalPath);
      canonical = pending;
    } else {
      await unlink(pendingPath);
    }
  }
  // Compared by canonical digest: the stored copy is canonically key-sorted on disk while the
  // live binding object keeps its construction order, so a string comparison would always fail.
  if (canonicalJsonDigest(canonical.experiment as unknown as PlainJsonValue) !== canonicalJsonDigest(binding as unknown as PlainJsonValue)) {
    throw new TypeError("efficiency checkpoint was created for a different experiment binding");
  }
  return interruptLeftovers(canonical);
}

function parseCheckpointBytes(bytes: Uint8Array, label: string): EfficiencyCheckpoint {
  const parsed = parseCanonicalDocument(bytes, label);
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const checkpoint = value as unknown as EfficiencyCheckpoint;
  if (checkpoint.schema_version !== "1" || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1) {
    throw new TypeError(`${label} is not an efficiency checkpoint`);
  }
  return checkpoint;
}

function interruptLeftovers(checkpoint: EfficiencyCheckpoint): EfficiencyCheckpoint {
  let changed = false;
  const preflight_runs = checkpoint.preflight_runs.map((run) => {
    if (run.status !== "running") return run;
    changed = true;
    return { ...run, status: "interrupted" as const };
  });
  const groups = checkpoint.groups.map((entry) => {
    const roles = entry.roles.map((role) => {
      // Per-role decision: the shared flag must never widen which roles recovery rewrites, or a
      // recovered sibling would demote a retained terminal failure to pending.
      const hasRunningAttempt = role.attempts.some((attempt) => attempt.status === "running");
      if (!hasRunningAttempt && role.status !== "running") return role;
      changed = true;
      const attempts = role.attempts.map((attempt) =>
        attempt.status === "running"
          ? ({ ...attempt, status: "interrupted" as const } as EfficiencyAttempt)
          : attempt);
      // Recovery honors retained evidence: a finalized nontransient failure stays terminal and a
      // completed last attempt keeps the role succeeded; everything else continues as pending.
      if (attempts.some((attempt) =>
        attempt.status === "failed" && attempt.failure !== undefined && !attempt.failure.transient)) {
        return { ...role, status: "failed" as const, attempts };
      }
      const terminal = attempts.length > 0 && attempts[attempts.length - 1]!.status === "succeeded";
      return { ...role, status: terminal ? ("succeeded" as const) : ("pending" as const), attempts };
    });
    if (entry.status === "running") changed = true;
    return { ...entry, status: entry.status === "running" ? ("pending" as const) : entry.status, roles };
  });
  if (!changed) return checkpoint;
  return {
    ...checkpoint,
    generation: checkpoint.generation + 1,
    prior_digest: checkpointDocumentDigest(checkpoint),
    preflight_runs,
    groups,
  };
}

/**
 * Serializes checkpoint updates through one in-process mutex. Every update writes and syncs a
 * canonical pending file with `wx`, then renames it over the canonical checkpoint, so an
 * interrupted write leaves at most one recoverable pending file and never a torn canonical one.
 */
export class EfficiencyJournal {
  readonly #stage: string;
  #checkpoint: EfficiencyCheckpoint;
  #queue: Promise<void> = Promise.resolve();

  constructor(stage: string, checkpoint: EfficiencyCheckpoint) {
    this.#stage = stage;
    this.#checkpoint = checkpoint;
  }

  get value(): EfficiencyCheckpoint {
    return this.#checkpoint;
  }

  update(mutate: (checkpoint: DeepMutable<EfficiencyCheckpoint>) => void): Promise<void> {
    const operation = this.#queue.then(async () => {
      const draft = JSON.parse(JSON.stringify(this.#checkpoint)) as DeepMutable<EfficiencyCheckpoint>;
      mutate(draft);
      draft.generation = this.#checkpoint.generation + 1;
      draft.prior_digest = checkpointDocumentDigest(this.#checkpoint);
      const bytes = canonicalJsonBytes(draft as unknown as PlainJsonValue);
      parseCheckpointBytes(bytes, "checkpoint draft");
      const pendingPath = join(this.#stage, PENDING_FILENAME);
      const handle = await openPending(pendingPath);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(pendingPath, join(this.#stage, CHECKPOINT_FILENAME));
      this.#checkpoint = draft as unknown as EfficiencyCheckpoint;
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

async function openPending(path: string) {
  return open(path, "wx", 0o600);
}
