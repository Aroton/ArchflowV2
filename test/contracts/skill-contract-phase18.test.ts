import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOCAL_COMMANDS } from "../../src/local/commands.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowSkills = [
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
  "archflow-status",
] as const;

const source = (name: string): string =>
  readFileSync(resolve(root, "skills", name, "SKILL.md"), "utf8");
const manualWorkflowSource = (): string =>
  readFileSync(resolve(root, "src/local/manual-workflow.ts"), "utf8");

describe("Phase 18 degraded-workflow skill contracts", () => {
  it("publishes only the three approved manual helper operations", () => {
    expect(LOCAL_COMMANDS).toContain("manual-status");
    expect(LOCAL_COMMANDS).toContain("manual-next");
    expect(LOCAL_COMMANDS).toContain("manual-handoff");
  });

  it("routes every workflow skill through helper-classified authority", () => {
    for (const name of workflowSkills) {
      const skill = source(name);
      expect(skill).toContain("archflow-local manual-status --task <task>");
      expect(skill).toContain("reinstall with `./install.sh`");
      expect(skill).not.toContain("infer progress from the highest checkpoint");
    }
    for (const name of workflowSkills.slice(0, 4)) {
      expect(source(name)).toContain("archflow-local manual-next --task <task>");
    }
  });

  it("preserves explicit gate, commit, and writer boundaries", () => {
    const implementation = source("archflow-phase-impl");
    expect(implementation).toContain("Prepared but uncheckpointed output is not success");
    expect(implementation).toContain("archflow-local manual-handoff --task <task>");
    expect(implementation).toContain("The skill never merges, pushes, chooses a successor");

    const status = source("archflow-status");
    expect(status).toContain("`normal`, `degraded`, or `repair-required`");
    expect(status).toContain("a merely highest-numbered checkpoint");
    expect(status).toContain("complete returned `task_status`");
    expect(status).toContain("do not claim normal-state configuration, reconciliation, evidence, or gate projections unless the result contains them");
    expect(manualWorkflowSource()).toContain("task_status?: TaskStatusV1");
    expect(manualWorkflowSource()).toContain("taskStatus = normal.value");
    expect(manualWorkflowSource()).toContain("task_status: taskStatus");
    expect(manualWorkflowSource()).toContain('"manual-fallback-tool-invalid"');
    expect(status).toContain("Do not reconstruct a status while both server and helper are unavailable");
  });
});
