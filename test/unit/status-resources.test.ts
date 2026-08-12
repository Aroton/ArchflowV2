import { describe, expect, it } from "vitest";

import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { phaseStatusResources } from "../../src/state/phase-documents.js";

const TASK = parseTaskSlug("resource-task");

describe("status phase resources", () => {
  it("projects the canonical PRD and design files", () => {
    expect(phaseStatusResources(TASK, parsePhaseInstanceId("prd"))).toEqual([
      { role: "current-artifact", path: ".archflow/tasks/resource-task/prd.md", access: "write" },
      { role: "user-ask", path: ".archflow/tasks/resource-task/ask.md", access: "read-write" },
    ]);
    expect(phaseStatusResources(TASK, parsePhaseInstanceId("design"))).toEqual([
      { role: "current-artifact", path: ".archflow/tasks/resource-task/design.md", access: "write" },
      { role: "prd", path: ".archflow/tasks/resource-task/prd.md", access: "read-write" },
    ]);
  });

  it("adds prior implementation notes only after phase one", () => {
    const first = phaseStatusResources(TASK, parsePhaseInstanceId("phase-design-1"));
    expect(first).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "prior-implementation-notes" }),
    ]));
    expect(phaseStatusResources(TASK, parsePhaseInstanceId("phase-design-3"))).toEqual([
      { role: "current-artifact", path: ".archflow/tasks/resource-task/phases/3/design.md", access: "write" },
      { role: "prd", path: ".archflow/tasks/resource-task/prd.md", access: "read-write" },
      { role: "task-design", path: ".archflow/tasks/resource-task/design.md", access: "read-write" },
      { role: "prior-implementation-notes", path: ".archflow/tasks/resource-task/phases/2/impl-notes.md", access: "read" },
    ]);
  });

  it("projects implementation inputs and the ignored verification write target", () => {
    expect(phaseStatusResources(TASK, parsePhaseInstanceId("phase-impl-2"))).toEqual([
      { role: "current-artifact", path: ".archflow/tasks/resource-task/phases/2/impl-notes.md", access: "write" },
      { role: "prd", path: ".archflow/tasks/resource-task/prd.md", access: "read-write" },
      { role: "task-design", path: ".archflow/tasks/resource-task/design.md", access: "read-write" },
      { role: "phase-design", path: ".archflow/tasks/resource-task/phases/2/design.md", access: "read-write" },
      { role: "prior-implementation-notes", path: ".archflow/tasks/resource-task/phases/1/impl-notes.md", access: "read" },
      { role: "verification-transcript", path: ".archflow/runtime/tasks/resource-task/cache/phases/2/verification.txt", access: "write" },
    ]);
  });
});
