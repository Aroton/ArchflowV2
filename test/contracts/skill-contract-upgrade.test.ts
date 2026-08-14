import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "../../src/contracts/tool-names.js";
import { LOCAL_COMMANDS } from "../../src/local/commands.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillPath = resolve(root, "skills/archflow-upgrade/SKILL.md");
const source = readFileSync(skillPath, "utf8");

describe("upgrade skill contract", () => {
  it("uses the frozen portable skill shape", () => {
    const lines = source.split("\n");
    expect(lines.slice(0, 6)).toEqual([
      "---",
      "name: archflow-upgrade",
      "description: Adopt a legacy in-flight ArchFlow task into a distinct canonical task and resume it through one reviewed migration gate.",
      "---",
      "",
      "# Upgrade an In-Flight Legacy Task",
    ]);
    expect(source).not.toMatch(/^\d+[.)]\s/mu);
    expect(source).not.toContain("```");
    expect(source).not.toContain("Claude Code");
    expect(source).not.toContain("Codex");
  });

  it("names only shipped helper commands and MCP tools", () => {
    const commands = [...source.matchAll(/\barchflow-local\s+([a-z][a-z-]*)/gu)]
      .map((match) => match[1]!);
    const tools = [...source.matchAll(/\barchflow_[a-z_]+\b/gu)]
      .map((match) => match[0]);
    for (const command of commands) expect(LOCAL_COMMANDS).toContain(command);
    for (const tool of tools) expect(TOOL_NAMES).toContain(tool);
    for (const command of [...source.matchAll(/`(archflow-local [^`]+)`/gu)]) {
      expect(command[1]).toContain("--task <task>");
    }
  });

  it("pins preview, atomic adoption, single-gate review, and in-flight resume semantics", () => {
    for (const required of [
      "Keep the source unchanged",
      "same Git worktree",
      "distinct canonical destination",
      "operation `preview`",
      "without writing",
      "operation `stage`",
      "must not create `.archflow/tasks/<task>/config.yaml`",
      "atomically publishes one destination",
      "`config.yaml`, `state.json`, `prd.md`, and `design.md`",
      "every mapped prior phase design",
      "one `migration-audit` gate instead of separate PRD and design approval gates",
      "fresh human approval for the exact imported document bytes",
      "phase N has a mapped design and no implementation log",
      "use `exclude` only for the exact legacy-relative path",
      "unresolved task-local constitution edit",
      "secretlint reports selected legacy content",
    ]) expect(source).toContain(required);
  });

  it("pins the standard server-outage ladder", () => {
    expect(source).toContain("If an MCP workflow tool is unavailable");
    expect(source).toContain("`archflow-local manual-status --task <task>`");
    expect(source).toContain("record nothing offline");
    expect(source).toContain("reinstall");
    expect(source).toContain("./install.sh");
  });

  it("enumerates upgrade only on the non-workflow surfaces", () => {
    for (const path of ["install.sh", "CLAUDE.md", "AGENTS.md", "README.md", "test/contracts/skill-contract-canonical.test.ts"]) {
      expect(readFileSync(resolve(root, path), "utf8"), path).toContain("archflow-upgrade");
    }
    for (const path of [
      "assets/workflow.yaml",
      "src/contracts/schemas/v1/workflow.schema.json",
      "src/contracts/workflow.ts",
    ]) expect(readFileSync(resolve(root, path), "utf8"), path).not.toContain("archflow-upgrade");

    const canonicalContract = readFileSync(resolve(root, "test/contracts/skill-contract-canonical.test.ts"), "utf8");
    const normalPhaseSkills = /const normalPhaseSkills = \[([\s\S]*?)\] as const;/u.exec(canonicalContract)?.[1];
    expect(normalPhaseSkills).toBeDefined();
    expect(normalPhaseSkills).not.toContain("archflow-upgrade");
    expect(readFileSync(resolve(root, "CLAUDE.md"))).toEqual(readFileSync(resolve(root, "AGENTS.md")));
  });

  it("ships the representative legacy fixture without inventing a phase 3 log", () => {
    const fixture = resolve(root, "test/fixtures/legacy");
    for (const relative of [
      "prd.md",
      "architecture.md",
      "phases/phase-1-foundation.md",
      "phases/phase-1-foundation-log.md",
      "phases/phase-2-mapping.md",
      "phases/phase-2-mapping-log.md",
      "phases/phase-3-unlogged-review.md",
      "reviews/phase-3-design-counter-review.md",
      "reviews/phase-3-impl-counter-review.md",
      "reviews/review-findings.md",
    ]) expect(existsSync(resolve(fixture, relative)), relative).toBe(true);
    expect(existsSync(resolve(fixture, "phases/phase-3-unlogged-review-log.md"))).toBe(false);
  });
});
