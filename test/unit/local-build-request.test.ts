import { describe, expect, it } from "vitest";

import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { includeChangedImplementationDocuments } from "../../src/state/request-composition.js";

describe("implementation request document capture", () => {
  it("adds a changed phase design to outputs, rollback, and retained parent documents", () => {
    const phaseDesign = parseRepositoryPathClaim(".archflow/tasks/demo/phases/2/design.md");
    const source = parseRepositoryPathClaim("src/index.ts");
    const captured = includeChangedImplementationDocuments({
      task_id: parseTaskSlug("demo"),
      phase_instance: parsePhaseInstanceId("phase-impl-2"),
      changed_paths: [phaseDesign],
      outputs: [source],
      restore_targets: [source],
      parent_documents: [{ document_path: "prd.md", role: "prd" }],
    });

    expect(captured.outputs).toEqual([phaseDesign, source]);
    expect(captured.restore_targets).toEqual([phaseDesign, source]);
    expect(captured.parent_documents).toEqual([
      { document_path: "phases/2/design.md", role: "phase-design" },
      { document_path: "prd.md", role: "prd" },
    ]);
  });

  it("leaves unchanged governing documents pinned as upstreams instead of claiming them", () => {
    const source = parseRepositoryPathClaim("src/index.ts");
    const captured = includeChangedImplementationDocuments({
      task_id: parseTaskSlug("demo"),
      phase_instance: parsePhaseInstanceId("phase-impl-2"),
      changed_paths: ["unrelated.md"],
      outputs: [source],
      restore_targets: [source],
      parent_documents: [{ document_path: "prd.md", role: "prd" }],
    });

    expect(captured).toEqual({
      outputs: [source],
      restore_targets: [source],
      parent_documents: [{ document_path: "prd.md", role: "prd" }],
    });
  });
});
