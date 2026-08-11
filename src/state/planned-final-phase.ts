import { sha256Bytes } from "../contracts/canonical.js";
import type { GateDecisionRecordV1 } from "../contracts/durable-gate.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ProjectResult } from "../contracts/errors.js";
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
    record.kind !== "artifact-approval" ||
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
