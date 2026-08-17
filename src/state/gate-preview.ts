import { canonicalJsonDigest } from "../contracts/canonical.js";
import { parseGateRequest, type GateRequestV1, type WaiverGateContext } from "../contracts/durable-gate.js";
import { parseSafeInteger, type Sha256Digest, type TaskSlug } from "../contracts/evidence.js";
import { computeGateContextDigest } from "../contracts/fingerprints.js";
import type { GateContext, GateKind } from "../contracts/gates.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import { activeProjection, DECISIONS } from "./gate-core.js";
import { buildHumanGatePresentation, type HumanGatePresentation } from "./gate-decision-interface.js";

export type GateDecisionChoice = Readonly<{ choice: string; reason: string }>;

export type GatePreviewCommit = Readonly<{
  target_ref: string;
  baseline_commit: string;
  message: string;
  paths: readonly string[];
  diff_digest?: Sha256Digest;
}>;

export type GatePreviewSubject = Readonly<{
  schema_version: "1";
  task_id: TaskSlug;
  revision: number;
  phase_instance: PhaseInstanceId;
  summary: string;
  subject_digest: Sha256Digest;
  current_evidence: CurrentEvidenceSetRef;
  kind: GateKind;
  context: GateRequestV1["context"];
  options: HumanGatePresentation["options"];
  commit?: GatePreviewCommit;
}>;

export type GatePreview = Readonly<{
  preview_digest: Sha256Digest;
  preview: GatePreviewSubject;
  presentation: HumanGatePresentation;
}>;

export type ProspectiveGate = Readonly<{
  task_id: TaskSlug;
  revision: number;
  phase_instance: PhaseInstanceId;
  summary: string;
  subject_digest: Sha256Digest;
  current_evidence: CurrentEvidenceSetRef;
  kind: GateKind;
  context: GateRequestV1["context"];
}>;

const ZERO_DIGEST = "0".repeat(64) as Sha256Digest;

function commitFor(input: ProspectiveGate): GatePreviewCommit | undefined {
  if (input.kind === "commit-authorization" && !("origin" in input.context)) {
    const context = input.context as GateContext<"commit-authorization">;
    return Object.freeze({
      target_ref: context.target_ref,
      baseline_commit: context.baseline_commit,
      message: context.commit_message,
      paths: Object.freeze([...context.paths]),
      diff_digest: context.diff_digest,
    });
  }
  if (input.kind === "design-approval" && !("origin" in input.context)) {
    const context = input.context as GateContext<"design-approval">;
    return Object.freeze({
      target_ref: context.target_ref,
      baseline_commit: context.baseline_commit,
      message: context.commit_message,
      paths: Object.freeze([`.archflow/tasks/${input.task_id}`]),
    });
  }
  if (input.kind === "migration-audit" && !("origin" in input.context)) {
    const context = input.context as GateContext<"migration-audit">;
    if (context.target_ref !== undefined && context.baseline_commit !== undefined && context.commit_message !== undefined) {
      return Object.freeze({
        target_ref: context.target_ref,
        baseline_commit: context.baseline_commit,
        message: context.commit_message,
        paths: Object.freeze([`.archflow/tasks/${input.task_id}`]),
      });
    }
  }
  return undefined;
}

/** Builds the exact human preview whose digest a later bounded decision call must echo. */
export function buildGatePreview(input: ProspectiveGate): GatePreview {
  const waiver = "origin" in input.context;
  const request = parseGateRequest({
    schema_version: "1",
    gate_id: "preview-gate",
    intent_id: "preview-intent",
    request_digest: ZERO_DIGEST,
    task_id: input.task_id,
    phase_instance: input.phase_instance,
    summary: input.summary,
    subject_digest: input.subject_digest,
    context_digest: waiver
      ? computeGateContextDigest("waiver", input.context as WaiverGateContext)
      : computeGateContextDigest(input.kind, input.context as never),
    current_evidence: input.current_evidence,
    kind: input.kind,
    context: input.context,
    allowed_decisions: waiver ? ["grant", "deny", "cancel"] : DECISIONS[input.kind],
    opened_at_revision: parseSafeInteger(input.revision + 1),
  });
  const presentation = buildHumanGatePresentation(activeProjection(request));
  const commit = commitFor(input);
  const preview: GatePreviewSubject = Object.freeze({
    schema_version: "1",
    task_id: input.task_id,
    revision: input.revision,
    phase_instance: input.phase_instance,
    summary: input.summary,
    subject_digest: input.subject_digest,
    current_evidence: input.current_evidence,
    kind: input.kind,
    context: structuredClone(input.context),
    options: presentation.options,
    ...(commit === undefined ? {} : { commit }),
  });
  const previewDigest = canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "gate-preview",
    preview: preview as unknown as PlainJsonValue,
  });
  return Object.freeze({ preview_digest: previewDigest, preview, presentation });
}

export function previewHasChoice(preview: GatePreview, decision: GateDecisionChoice): boolean {
  return preview.presentation.options.some((option) => option.token === decision.choice) &&
    decision.reason.trim() !== "";
}
