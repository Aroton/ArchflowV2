import { sha256Bytes } from "../contracts/canonical.js";
import type { GateDecisionRecordV1 } from "../contracts/durable-gate.js";
import type { RuleSettlementV1, TaskStateV1 } from "../contracts/durable-state.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { TaskSlug } from "../contracts/evidence.js";
import { issue, ok, type GateLifecycleDependencies } from "./gate-core.js";

export function plannedFinalPhaseFromDesign(bytes: Uint8Array): number | null {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("approved design is not UTF-8");
  }
  const openEndedMarker = "<!-- archflow:phase-plan:open-ended -->";
  const lines = source.split(/\r?\n/u);
  const exactMarkers = lines.filter((line) => line === openEndedMarker);
  const markerLikeLines = lines.filter((line) => /archflow:phase-plan:/u.test(line));
  const exactHeading = /^### Phase ([1-9][0-9]*): \S(?:.*\S)?$/u;
  const exactHeadings = lines.filter((line) => exactHeading.test(line));
  // A phase-number heading at another level/indentation or a Markdown table whose header names
  // Phase is recognizable phase-plan syntax. It must not silently disappear merely because it
  // does not match the authoritative grammar.
  const phasePlanLikeLines = lines.filter((line) =>
    /^\s*#{1,6}\s+Phase\s+[0-9]+(?:\s|:|[-\u2013\u2014]|$)/u.test(line) ||
    /^\s*\|\s*Phase\s*\|/iu.test(line)
  );
  if (
    exactMarkers.length === 1 &&
    markerLikeLines.length === 1 &&
    phasePlanLikeLines.length === 0
  ) return null;
  if (
    markerLikeLines.length !== 0 ||
    exactHeadings.length === 0 ||
    phasePlanLikeLines.length !== exactHeadings.length
  ) {
    throw new TypeError("approved design requires an exact phase plan or the open-ended marker");
  }
  const phases = exactHeadings.map((heading) => Number(exactHeading.exec(heading)![1]));
  if (phases.some((phase) => !Number.isSafeInteger(phase)) ||
      phases.some((phase, index) => phase !== index + 1)) {
    throw new TypeError("approved design phase headings are not consecutive from phase 1");
  }
  return phases.length;
}

/** Derives the approved design phase bound only to retained design bytes and the archived decision. */
export async function loadApprovedDesignFinalPhase(
  dependencies: GateLifecycleDependencies,
  current: TaskStateV1,
  record: GateDecisionRecordV1,
): Promise<ProjectResult<number | null | undefined>> {
  if (
    record.outcome !== "decided" ||
    (record.kind !== "artifact-approval" && record.kind !== "design-approval") ||
    record.phase_instance !== "design" ||
    record.envelope.payload.decision !== "approve"
  ) return ok(undefined);
  const reference = current.authoritative_results.find((entry) =>
    entry.phase_instance === "design" && entry.step === "produce");
  if (reference === undefined || dependencies.load_retained_result === undefined) {
    return issue("STATE_INVALID", current, "approved-design-result-missing");
  }
  const retained = await dependencies.load_retained_result(reference);
  if (!retained.ok) return retained;
  const manifest = retained.value.prepared.manifest.value;
  const artifact = manifest.source_artifact;
  if (
    artifact.artifact_kind !== "document" ||
    artifact.phase_instance !== "design" ||
    artifact.step !== "produce" ||
    artifact.document_path !== "design.md" ||
    manifest.artifact_digest !== record.subject_digest
  ) return issue("STATE_INVALID", current, "approved-design-authority-mismatch");
  const payload = retained.value.prepared.payloads.find((candidate) =>
    candidate.path === artifact.projection_target);
  if (payload === undefined || sha256Bytes(payload.bytes) !== artifact.content_digest) {
    return issue("STATE_INVALID", current, "approved-design-authority-mismatch");
  }
  try {
    return ok(plannedFinalPhaseFromDesign(payload.bytes));
  } catch {
    return issue("STATE_INVALID", current, "approved-design-phase-count-invalid");
  }
}

/** Derives the phase bound from the exact retained design subject selected by rule authority. */
export async function loadAutonomousDesignFinalPhase(
  dependencies: GateLifecycleDependencies,
  current: TaskStateV1,
  subjectDigest: RuleSettlementV1["subject_digest"],
): Promise<ProjectResult<number | null>> {
  if (current.phase_instance !== "design") {
    return issue("STATE_INVALID", current, "autonomous-design-phase-count-wrong-position");
  }
  const reference = current.authoritative_results.find((entry) =>
    entry.phase_instance === "design" && entry.step === "produce");
  if (reference === undefined || dependencies.load_retained_result === undefined) {
    return issue("STATE_INVALID", current, "autonomous-design-result-missing");
  }
  const retained = await dependencies.load_retained_result(reference);
  if (!retained.ok) return retained;
  const manifest = retained.value.prepared.manifest.value;
  const artifact = manifest.source_artifact;
  if (artifact.artifact_kind !== "document" || artifact.phase_instance !== "design" ||
      artifact.step !== "produce" || artifact.document_path !== "design.md" ||
      manifest.artifact_digest !== subjectDigest) {
    return issue("STATE_INVALID", current, "autonomous-design-authority-mismatch");
  }
  const payload = retained.value.prepared.payloads.find((candidate) => candidate.path === artifact.projection_target);
  if (payload === undefined || sha256Bytes(payload.bytes) !== artifact.content_digest) {
    return issue("STATE_INVALID", current, "autonomous-design-authority-mismatch");
  }
  try {
    return ok(plannedFinalPhaseFromDesign(payload.bytes));
  } catch {
    return issue("STATE_INVALID", current, "autonomous-design-phase-count-invalid");
  }
}

/**
 * Re-derives the planned final phase from a prepared produce result's retained payloads,
 * but only when this produce actually recorded the task design document. Phase-boundary
 * revisions change the phase plan through phase-design compound projections and
 * implementation governing-document outputs long after the design position's own approval
 * settled its bound; deriving from the bytes this very transaction records keeps the bound
 * from going stale without waiting for another design-position approval. Returns undefined
 * when the design document is not among the payloads, so the caller leaves the stored bound
 * untouched; a null result (open-ended marker) clears it. A recorded design whose phase plan
 * does not conform throws — failing the produce closed rather than silently keeping a stale
 * bound — but only while a stored bound exists to go stale. A task with no stored bound
 * (fresh, legacy-imported, or restarted to the design position) preserves the absent bound:
 * legacy imports legitimately record designs without the ArchFlow phase-plan grammar, their
 * approval path never derives the bound, and the design-approval gate already enforces
 * phase-plan conformance at approval.
 */
export function plannedFinalPhaseFromRecordedPayloads(
  taskId: TaskSlug,
  payloads: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
  storedPlannedFinalPhase: number | null | undefined,
): number | null | undefined {
  const designPath = `.archflow/tasks/${taskId}/design.md`;
  const recorded = payloads.find((payload) => payload.path === designPath);
  // Fresh design bytes are not approved authority. Only an already human-approved bound may be
  // refreshed by a later governing-document produce; the design-approval decision is the writer
  // that establishes the first bound.
  if (recorded === undefined || storedPlannedFinalPhase === undefined) return undefined;
  return plannedFinalPhaseFromDesign(recorded.bytes);
}

/**
 * A produce at a numbered phase may not record a design whose phase plan ends below that
 * phase: completion is an equality test, so a lower bound can never fire and the workflow
 * would wedge offering a nonexistent successor phase — the same wedge class the produce-time
 * re-derivation exists to remove. PRD and design positions carry no phase number, so any
 * conforming plan is acceptable there. The honest resolution for a genuinely shrunken plan is
 * a backward planning restart, which this refusal directs the producer toward (mirroring the
 * migration-audit refusal of a resume phase beyond the plan).
 */
export function derivedFinalPhaseBelowCurrentPhase(
  derived: number,
  phaseInstance: TaskStateV1["phase_instance"],
): boolean {
  const decoded = decodePhaseInstance(phaseInstance);
  return (decoded.kind === "phase-impl" || decoded.kind === "phase-design") &&
    derived < Number(decoded.phase);
}
