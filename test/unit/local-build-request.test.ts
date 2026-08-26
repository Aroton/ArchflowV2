import { describe, expect, it } from "vitest";

import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { ProductionServices } from "../../src/state/production.js";
import { composeRequest, includeChangedImplementationDocuments } from "../../src/state/request-composition.js";

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

describe("implementation repository sections", () => {
  /** Enough of a phase-impl produce position to reach repository-section validation; no Git. */
  const servicesWith = (configYaml: string): ProductionServices => ({
    state: { value: { phase_instance: "phase-impl-1", step: "produce", status: "running" } },
    authority: { config: "config.yaml", context: { phase_instance: "phase-impl-1" } },
    dependencies: {
      read_config: async () => ({ kind: "valid", snapshot: { bytes: new TextEncoder().encode(configYaml) } }),
    },
  }) as unknown as ProductionServices;
  const request = (name: string) => ({
    intent_id: "implementation-sections",
    implementation: {
      outputs: ["src/index.ts"],
      restore_targets: [],
      repositories: [{ name, base_commit: "a".repeat(40), outputs: ["lib/a.ts"], restore_targets: [] }],
    },
  });

  it("rejects a section for a repository the task config never declared, naming it", async () => {
    await expect(composeRequest(servicesWith('schema_version: "1"\nroles: {}\n'), request("apis")))
      .rejects.toThrow(/implementation repository apis is not configured/u);
  });

  it("rejects a section for a context-only repository, naming it", async () => {
    const config = 'schema_version: "1"\nroles: {}\nrepositories:\n  apis:\n    path: ../apis\n';
    await expect(composeRequest(servicesWith(config), request("apis")))
      .rejects.toThrow(/implementation repository apis is context-only, not writable/u);
  });
});
