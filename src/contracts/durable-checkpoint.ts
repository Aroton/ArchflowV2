import { z } from "zod";

import { canonicalJsonDigest } from "./canonical.js";
import type {
  ApprovalRef,
  AuthoritativeResultRef,
  OpenGateRef,
  StepStatus,
  WaiverRef,
} from "./durable-state.js";
import { STEP_STATUSES, TERMINAL_STATES } from "./durable-state.js";
import type { LegacyImportInitializationV1 } from "./durable-legacy-import.js";
import { legacyImportInitializationV1Schema } from "./durable-legacy-import.js";
import type { TaskInitializationV1 } from "./durable-task-initialization.js";
import { taskInitializationV1Schema } from "./durable-task-initialization.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import {
  pathSafeIdV1Schema,
  safeIdV1Schema,
  sha256DigestV1Schema,
  taskSlugV1Schema,
} from "./evidence.js";
import { GATE_KINDS } from "./gates.js";
import type { WaiverScope } from "./gates.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import { repositoryPathClaimV1Schema } from "./path-claims.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { phaseInstanceIdV1Schema } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
import type { CurrentEvidenceSetRef } from "./trust.js";
import { currentEvidenceSetRefSchema } from "./trust.js";
import type { PipelineStep } from "./vocabulary.js";
import { PIPELINE_STEPS } from "./vocabulary.js";
import { hasUniqueObjectPropertyValues, isSortedUniqueBy, tupleKey } from "./validators.js";

export type PredecessorLink = {
  readonly revision: SafeInteger;
  readonly checkpoint_digest: Sha256Digest;
};

export type StateAnchor = {
  readonly anchor_kind: "state";
  readonly state_revision: SafeInteger;
  readonly state_digest: Sha256Digest;
};

declare const continuationCheckpointRevisionBrand: unique symbol;
/** A checkpoint revision proven by the checkpoint parser to be at least 2. */
export type ContinuationCheckpointRevision = SafeInteger & {
  readonly [continuationCheckpointRevisionBrand]: true;
};

export type ProjectionDigestRef = {
  readonly path: RepositoryPathClaim;
  readonly content_digest: Sha256Digest;
};

export type EvidenceChainEntry = {
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly current_evidence: CurrentEvidenceSetRef;
};

export type InitialManualCheckpointV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly revision: 1;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly status: StepStatus;
  readonly attempt: SafeInteger;
  readonly input_fingerprint: Sha256Digest;
  readonly assurance: "degraded";
  readonly initialization_digest: Sha256Digest;
  readonly initialization: TaskInitializationV1 | LegacyImportInitializationV1;
  readonly authoritative_results: readonly AuthoritativeResultRef[];
  readonly projections: readonly ProjectionDigestRef[];
  readonly evidence_chain: readonly EvidenceChainEntry[];
  readonly approvals: readonly ApprovalRef[];
  readonly waivers: readonly WaiverRef[];
  readonly open_gate?: OpenGateRef;
  readonly terminal?: "complete" | "abandoned";
};

export type ContinuationManualCheckpointV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly revision: ContinuationCheckpointRevision;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly status: StepStatus;
  readonly attempt: SafeInteger;
  readonly input_fingerprint: Sha256Digest;
  readonly assurance: "degraded";
  readonly initialization_digest: Sha256Digest;
  readonly predecessor: PredecessorLink;
  readonly authoritative_results: readonly AuthoritativeResultRef[];
  readonly projections: readonly ProjectionDigestRef[];
  readonly evidence_chain: readonly EvidenceChainEntry[];
  readonly approvals: readonly ApprovalRef[];
  readonly waivers: readonly WaiverRef[];
  readonly open_gate?: OpenGateRef;
  readonly terminal?: "complete" | "abandoned";
};

export type StateAnchoredManualCheckpointV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly revision: ContinuationCheckpointRevision;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly status: StepStatus;
  readonly attempt: SafeInteger;
  readonly input_fingerprint: Sha256Digest;
  readonly assurance: "degraded";
  readonly initialization_digest: Sha256Digest;
  readonly state_anchor: StateAnchor;
  readonly authoritative_results: readonly AuthoritativeResultRef[];
  readonly projections: readonly ProjectionDigestRef[];
  readonly evidence_chain: readonly EvidenceChainEntry[];
  readonly approvals: readonly ApprovalRef[];
  readonly waivers: readonly WaiverRef[];
  readonly open_gate?: OpenGateRef;
  readonly terminal?: "complete" | "abandoned";
};

export type ManualCheckpointV1 = InitialManualCheckpointV1 | StateAnchoredManualCheckpointV1 | ContinuationManualCheckpointV1;

export type InitialImportV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "manual-checkpoint-import";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly import_mode: "initial";
  readonly chain: readonly ManualCheckpointV1[];
};

export type ContinuationImportV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "manual-checkpoint-import";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly import_mode: "continuation";
  readonly chain: readonly ManualCheckpointV1[];
  readonly predecessor: PredecessorLink;
  readonly expected_state_revision: SafeInteger;
  readonly expected_state_digest: Sha256Digest;
};

export type StateAnchoredImportV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "manual-checkpoint-import";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly import_mode: "state-anchored";
  readonly chain: readonly ManualCheckpointV1[];
  readonly state_anchor: StateAnchor;
};

export type ManualCheckpointImportV1 = InitialImportV1 | StateAnchoredImportV1 | ContinuationImportV1;

const digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;
const positiveSafeInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) as unknown as z.ZodType<SafeInteger>;
const waiverScopeV1Schema = z.object({
  operation: z.enum(["review-trigger", "adjudication-failure"]),
  boundary: z.enum(["subject", "phase", "task"]),
}).strict() as unknown as z.ZodType<WaiverScope>;

export const authoritativeResultRefV1Schema = z.object({
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  result_digest: digest,
  result_id: safeIdV1Schema,
  input_fingerprint: digest,
  manifest_path: repositoryPathClaimV1Schema,
}).strict() as unknown as z.ZodType<AuthoritativeResultRef>;

export const approvalRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  gate_kind: z.enum(GATE_KINDS),
  subject_digest: digest,
  decision_digest: digest,
  resolved_at_revision: positiveSafeInteger,
}).strict() as unknown as z.ZodType<ApprovalRef>;

export const waiverRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  rule_id: safeIdV1Schema,
  rule_version: positiveSafeInteger,
  subject_digest: digest,
  scope: waiverScopeV1Schema,
  granted: z.boolean(),
  expires: z.literal("task-complete"),
  granted_at_revision: positiveSafeInteger,
}).strict() as unknown as z.ZodType<WaiverRef>;

export const openGateRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  gate_kind: z.enum(GATE_KINDS),
  subject_digest: digest,
  context_digest: digest,
  frozen_state_digest: digest,
  waiver_origin_gate_id: pathSafeIdV1Schema.optional(),
  opened_at_revision: positiveSafeInteger,
}).strict() as unknown as z.ZodType<OpenGateRef>;

export const predecessorLinkV1Schema = z.object({
  revision: positiveSafeInteger,
  checkpoint_digest: digest,
}).strict() as unknown as z.ZodType<PredecessorLink>;

export const stateAnchorV1Schema = z.object({
  anchor_kind: z.literal("state"),
  state_revision: positiveSafeInteger,
  state_digest: digest,
}).strict() as unknown as z.ZodType<StateAnchor>;

export const projectionDigestRefV1Schema = z.object({
  path: repositoryPathClaimV1Schema,
  content_digest: digest,
}).strict() as unknown as z.ZodType<ProjectionDigestRef>;

export const evidenceChainEntryV1Schema = z.object({
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  subject_digest: digest,
  input_fingerprint: digest,
  current_evidence: currentEvidenceSetRefSchema,
}).strict() as unknown as z.ZodType<EvidenceChainEntry>;

const checkpointObject = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  repository_identity_digest: digest,
  revision: positiveSafeInteger,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  status: z.enum(STEP_STATUSES),
  attempt: positiveSafeInteger,
  input_fingerprint: digest,
  assurance: z.literal("degraded"),
  initialization_digest: digest,
  initialization: z.union([taskInitializationV1Schema, legacyImportInitializationV1Schema]).optional(),
  predecessor: predecessorLinkV1Schema.optional(),
  state_anchor: stateAnchorV1Schema.optional(),
  authoritative_results: z.array(authoritativeResultRefV1Schema)
    .refine(
      (items) => isSortedUniqueBy(items, tupleKey(["phase_instance", "step"])),
      "authoritative_results must be sorted by phase_instance and step with no duplicates"
    ),
  projections: z.array(projectionDigestRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("path")), "projections must be sorted by path with no duplicates"),
  evidence_chain: z.array(evidenceChainEntryV1Schema)
    .refine(
      (items) => isSortedUniqueBy(items, tupleKey(["phase_instance", "step"])),
      "evidence_chain must be sorted by phase_instance and step with no duplicates"
    ),
  approvals: z.array(approvalRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("gate_id")), "approvals must be sorted by gate_id with no duplicates"),
  waivers: z.array(waiverRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("gate_id")), "waivers must be sorted by gate_id with no duplicates"),
  open_gate: openGateRefV1Schema.optional(),
  terminal: z.enum(TERMINAL_STATES).optional(),
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.revision === 1) {
    if (checkpoint.initialization === undefined) {
      context.addIssue({ code: "custom", path: ["initialization"], message: "revision 1 requires initialization" });
    }
    if (checkpoint.predecessor !== undefined) {
      context.addIssue({ code: "custom", path: ["predecessor"], message: "revision 1 forbids predecessor" });
    }
    if (checkpoint.state_anchor !== undefined) {
      context.addIssue({ code: "custom", path: ["state_anchor"], message: "revision 1 forbids state_anchor" });
    }
  } else {
    if ((checkpoint.predecessor === undefined) === (checkpoint.state_anchor === undefined)) {
      context.addIssue({ code: "custom", path: ["predecessor"], message: "revision 2 or later requires exactly one predecessor or state_anchor" });
    }
    if (checkpoint.initialization !== undefined) {
      context.addIssue({ code: "custom", path: ["initialization"], message: "revision 2 or later forbids initialization" });
    }
  }
});

export const manualCheckpointV1Schema = checkpointObject as unknown as z.ZodType<ManualCheckpointV1>;

const checkpointChainSchema = z.array(manualCheckpointV1Schema).min(1).refine(
  (items) => hasUniqueObjectPropertyValues("revision", items),
  "chain revisions must be unique"
);

const checkpointImportObject = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("manual-checkpoint-import"),
  task_id: taskSlugV1Schema,
  repository_identity_digest: digest,
  import_mode: z.enum(["initial", "state-anchored", "continuation"]),
  chain: checkpointChainSchema,
  predecessor: predecessorLinkV1Schema.optional(),
  state_anchor: stateAnchorV1Schema.optional(),
  expected_state_revision: positiveSafeInteger.optional(),
  expected_state_digest: digest.optional(),
}).strict().superRefine((wrapper, context) => {
  const continuationFields = ["predecessor", "expected_state_revision", "expected_state_digest"] as const;
  if (wrapper.import_mode === "initial") {
    for (const field of [...continuationFields, "state_anchor"] as const) {
      if (wrapper[field] !== undefined) {
        context.addIssue({ code: "custom", path: [field], message: `initial import forbids ${field}` });
      }
    }
  } else if (wrapper.import_mode === "state-anchored") {
    if (wrapper.state_anchor === undefined) {
      context.addIssue({ code: "custom", path: ["state_anchor"], message: "state-anchored import requires state_anchor" });
    }
    for (const field of continuationFields) {
      if (wrapper[field] !== undefined) {
        context.addIssue({ code: "custom", path: [field], message: `state-anchored import forbids ${field}` });
      }
    }
  } else {
    if (wrapper.state_anchor !== undefined) {
      context.addIssue({ code: "custom", path: ["state_anchor"], message: "continuation import forbids state_anchor" });
    }
    for (const field of continuationFields) {
      if (wrapper[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: `continuation import requires ${field}` });
      }
    }
  }
});

export const manualCheckpointImportV1Schema = checkpointImportObject as unknown as z.ZodType<ManualCheckpointImportV1>;

export function parseManualCheckpoint(value: unknown): ManualCheckpointV1 {
  assertPlainJson(value, "manual checkpoint");
  return manualCheckpointV1Schema.parse(value);
}

export function parseManualCheckpointImport(value: unknown): ManualCheckpointImportV1 {
  assertPlainJson(value, "manual checkpoint import");
  return manualCheckpointImportV1Schema.parse(value);
}

export function checkpointSelfDigest(checkpoint: ManualCheckpointV1): Sha256Digest {
  return canonicalJsonDigest(checkpoint);
}

export const CHECKPOINT_BREAK_CODES = [
  "import-checkpoint-revision-not-successor",
  "import-chain-gap",
  "import-predecessor-digest-mismatch",
  "import-chain-head-not-revision-one",
  "import-head-predecessor-revision-mismatch",
  "import-head-predecessor-digest-mismatch",
] as const;
export type CheckpointBreakCode = (typeof CHECKPOINT_BREAK_CODES)[number];

export type InitialChainAnchor = {
  readonly mode: "initial";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
};

export type ContinuationChainAnchor = {
  readonly mode: "continuation";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly predecessor: PredecessorLink;
};

export type StateChainAnchor = {
  readonly mode: "state";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly state_anchor: StateAnchor;
};

export type ChainAnchor = InitialChainAnchor | StateChainAnchor | ContinuationChainAnchor;

/** Derives the checkpoint-chain anchor carried by an import wrapper. */
export function chainAnchor(wrapper: ManualCheckpointImportV1): ChainAnchor {
  if (wrapper.import_mode === "continuation") {
    return {
      mode: "continuation",
      task_id: wrapper.task_id,
      repository_identity_digest: wrapper.repository_identity_digest,
      predecessor: wrapper.predecessor,
    };
  }
  if (wrapper.import_mode === "state-anchored") {
    return {
      mode: "state",
      task_id: wrapper.task_id,
      repository_identity_digest: wrapper.repository_identity_digest,
      state_anchor: wrapper.state_anchor,
    };
  }
  return {
    mode: "initial",
    task_id: wrapper.task_id,
    repository_identity_digest: wrapper.repository_identity_digest,
  };
}

/** Returns a break when a continuation checkpoint's predecessor revision is not its immediate predecessor. */
export function checkpointSelfBreak(
  checkpoint: ManualCheckpointV1
): "import-checkpoint-revision-not-successor" | undefined {
  if ("predecessor" in checkpoint && checkpoint.revision !== checkpoint.predecessor.revision + 1) {
    return "import-checkpoint-revision-not-successor";
  }
  if ("state_anchor" in checkpoint && checkpoint.revision !== checkpoint.state_anchor.state_revision + 1) {
    return "import-checkpoint-revision-not-successor";
  }
  return undefined;
}

/** Checks revision before digest when deciding whether one checkpoint succeeds another. */
export function checkpointLinkBreak(
  previous: ManualCheckpointV1,
  next: ManualCheckpointV1
): "import-chain-gap" | "import-predecessor-digest-mismatch" | undefined {
  if (next.revision !== previous.revision + 1) return "import-chain-gap";
  if (!("predecessor" in next)) return "import-chain-gap";
  if (next.predecessor.checkpoint_digest !== checkpointSelfDigest(previous)) {
    return "import-predecessor-digest-mismatch";
  }
  return undefined;
}

/** Checks a candidate against an initial or continuation anchor, with revision before digest. */
export function chainHeadBreak(
  anchor: ChainAnchor,
  first: ManualCheckpointV1
):
  | "import-chain-head-not-revision-one"
  | "import-head-predecessor-revision-mismatch"
  | "import-head-predecessor-digest-mismatch"
  | undefined {
  if (anchor.mode === "initial") {
    return first.revision === 1 ? undefined : "import-chain-head-not-revision-one";
  }
  if (anchor.mode === "state") {
    if (!("state_anchor" in first) || first.state_anchor.state_revision !== anchor.state_anchor.state_revision) {
      return "import-head-predecessor-revision-mismatch";
    }
    if (first.state_anchor.state_digest !== anchor.state_anchor.state_digest) {
      return "import-head-predecessor-digest-mismatch";
    }
    return undefined;
  }
  if (!("predecessor" in first) || first.predecessor.revision !== anchor.predecessor.revision) {
    return "import-head-predecessor-revision-mismatch";
  }
  if (first.predecessor.checkpoint_digest !== anchor.predecessor.checkpoint_digest) {
    return "import-head-predecessor-digest-mismatch";
  }
  return undefined;
}

export const CHAIN_SELECTION_OUTCOMES = ["gap", "fork", "foreign-candidate"] as const;
export type ChainSelectionOutcome = (typeof CHAIN_SELECTION_OUTCOMES)[number];
export type ChainSelection =
  | { readonly kind: "chain"; readonly chain: readonly ManualCheckpointV1[] }
  | { readonly kind: "stop"; readonly outcome: ChainSelectionOutcome };

/** Selects the unique greatest linked chain from an unordered candidate collection. */
export function selectGreatestValidChain(
  anchor: ChainAnchor,
  candidates: readonly ManualCheckpointV1[]
): ChainSelection {
  if (
    candidates.some(
      (candidate) =>
        candidate.task_id !== anchor.task_id ||
        candidate.repository_identity_digest !== anchor.repository_identity_digest
    )
  ) {
    return { kind: "stop", outcome: "foreign-candidate" };
  }

  const expectedHeadRevision = anchor.mode === "initial"
    ? 1
    : anchor.mode === "state"
      ? anchor.state_anchor.state_revision + 1
      : anchor.predecessor.revision + 1;
  const heads = candidates.filter(
    (candidate) => checkpointSelfBreak(candidate) === undefined && chainHeadBreak(anchor, candidate) === undefined
  );
  if (
    anchor.mode === "initial" &&
    heads.some(
      (head) =>
        "initialization" in head &&
        (head.initialization.task_id !== anchor.task_id ||
          head.initialization.repository_identity_digest !== anchor.repository_identity_digest)
    )
  ) {
    return { kind: "stop", outcome: "foreign-candidate" };
  }
  if (heads.length >= 2) return { kind: "stop", outcome: "fork" };

  const chain: ManualCheckpointV1[] = [];
  const consumed = new Set<ManualCheckpointV1>();
  const head = heads[0];
  if (head !== undefined) {
    chain.push(head);
    consumed.add(head);
    const initializationDigest = head.initialization_digest;
    let tail = head;
    while (true) {
      const linked = candidates.filter(
        (candidate) =>
          !consumed.has(candidate) &&
          checkpointSelfBreak(candidate) === undefined &&
          checkpointLinkBreak(tail, candidate) === undefined
      );
      if (linked.length >= 2) return { kind: "stop", outcome: "fork" };
      const next = linked[0];
      if (next === undefined) break;
      if (next.initialization_digest !== initializationDigest) {
        return { kind: "stop", outcome: "foreign-candidate" };
      }
      chain.push(next);
      consumed.add(next);
      tail = next;
    }
  }

  if (candidates.some((candidate) => !consumed.has(candidate) && candidate.revision >= expectedHeadRevision)) {
    return { kind: "stop", outcome: "gap" };
  }
  return { kind: "chain", chain };
}
