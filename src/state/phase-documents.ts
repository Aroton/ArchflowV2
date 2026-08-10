import type { TaskSlug } from "../contracts/evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";

export type PhaseReviewPaths = Readonly<{
  artifact_path: string;
  upstream_paths: readonly string[];
}>;

/** Canonical review-subject paths per phase kind, as published by the phase skills. */
export function phaseReviewPaths(phaseInstance: PhaseInstanceId): PhaseReviewPaths {
  const phase = decodePhaseInstance(phaseInstance);
  switch (phase.kind) {
    case "prd": return { artifact_path: "prd.md", upstream_paths: [] };
    case "design": return { artifact_path: "design.md", upstream_paths: ["prd.md"] };
    case "phase-design": return {
      artifact_path: `phases/${phase.phase}/design.md`,
      upstream_paths: ["design.md", "prd.md"],
    };
    case "phase-impl": return {
      artifact_path: `phases/${phase.phase}/impl-notes.md`,
      upstream_paths: [`phases/${phase.phase}/design.md`, "design.md"],
    };
  }
}

export type PhaseDocumentDefaults = Readonly<{
  document_path: string;
  declared_inputs: readonly Readonly<{ input_id: string; path: string }>[];
}>;

/**
 * Canonical produce-document defaults per phase kind: the drafted document and the declared
 * inputs its counter-review is sealed against. These are the same defaults the phase skills
 * publish, held here once so templates, the build-request composer, and prose can never
 * disagree. phase-impl produces an implementation output, not a document, so it has none.
 */
export function phaseDocumentDefaults(
  taskId: TaskSlug,
  phaseInstance: PhaseInstanceId,
): PhaseDocumentDefaults | undefined {
  const phase = decodePhaseInstance(phaseInstance);
  const task = (path: string) => `.archflow/tasks/${taskId}/${path}`;
  switch (phase.kind) {
    case "prd": return {
      document_path: "prd.md",
      declared_inputs: [{ input_id: "user-ask", path: task("ask.md") }],
    };
    case "design": return {
      document_path: "design.md",
      declared_inputs: [{ input_id: "prd", path: task("prd.md") }],
    };
    case "phase-design": return {
      document_path: `phases/${phase.phase}/design.md`,
      declared_inputs: [
        { input_id: "design", path: task("design.md") },
        { input_id: "prd", path: task("prd.md") },
      ],
    };
    case "phase-impl": return undefined;
  }
}

export type PhaseImplParentDocument = Readonly<{
  document_path: string;
  role: "prd" | "design" | "phase-design" | "impl-notes";
}>;

/** Canonical parent documents an implementation output binds, as published by archflow-phase-impl. */
export function phaseImplParentDocumentDefaults(
  phaseInstance: PhaseInstanceId,
): readonly PhaseImplParentDocument[] | undefined {
  const phase = decodePhaseInstance(phaseInstance);
  if (phase.kind !== "phase-impl") return undefined;
  return [
    { document_path: `phases/${phase.phase}/design.md`, role: "phase-design" },
    { document_path: "design.md", role: "design" },
    { document_path: "prd.md", role: "prd" },
    { document_path: `phases/${phase.phase}/impl-notes.md`, role: "impl-notes" },
  ];
}
