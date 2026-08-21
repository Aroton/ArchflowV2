import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import {
  createTaskWorkspace,
  supportedRuleAcceptanceConstitutionV2Bytes,
} from "../helpers/task-workspace.js";

const CODEX_PRODUCER_CONFIG = new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer:
    model: claude-opus-5
    effort: high
  adjudicator:
    model: claude-opus-5
    effort: high
`);

describe("task-workspace config seam", () => {
  it("commits and pins the complete replacement config bytes", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "codex-producer-workspace",
      label: "codex-producer",
      configBytes: CODEX_PRODUCER_CONFIG,
    });
    try {
      const scaffoldConfig = readFileSync(join(workspace.root, ".archflow", "config.yaml"));
      const taskConfig = readFileSync(join(
        workspace.root, ".archflow", "tasks", workspace.taskId, "config.yaml",
      ));
      const committedConfig = execFileSync(
        "git",
        ["show", `${workspace.initialization.policy_base_commit}:.archflow/config.yaml`],
        { cwd: workspace.root },
      );

      expect(scaffoldConfig).toEqual(Buffer.from(CODEX_PRODUCER_CONFIG));
      expect(taskConfig).toEqual(Buffer.from(CODEX_PRODUCER_CONFIG));
      expect(committedConfig).toEqual(Buffer.from(CODEX_PRODUCER_CONFIG));
      expect(workspace.initialization.config_digest).toBe(sha256Bytes(CODEX_PRODUCER_CONFIG));
    } finally {
      workspace.dispose();
    }
  });

  it("commits constitution overrides before initialization pins the policy base", async () => {
    const constitutionBytes = supportedRuleAcceptanceConstitutionV2Bytes();
    const workspace = await createTaskWorkspace({
      taskId: "v2-policy-workspace",
      label: "v2-policy",
      constitutionBytes,
    });
    try {
      for (const [filename, bytes] of Object.entries(constitutionBytes)) {
        const relative = `.archflow/constitution/${filename}`;
        expect(readFileSync(join(workspace.root, relative))).toEqual(Buffer.from(bytes));
        expect(execFileSync(
          "git",
          ["show", `${workspace.initialization.policy_base_commit}:${relative}`],
          { cwd: workspace.root },
        )).toEqual(Buffer.from(bytes));
      }
      expect(execFileSync(
        "git",
        ["rev-parse", `${workspace.initialization.policy_base_commit}^`],
        { cwd: workspace.root, encoding: "utf8" },
      ).trim()).toBe(execFileSync(
        "git",
        ["rev-list", "--max-parents=0", "HEAD"],
        { cwd: workspace.root, encoding: "utf8" },
      ).trim());
    } finally {
      workspace.dispose();
    }
  });
});
