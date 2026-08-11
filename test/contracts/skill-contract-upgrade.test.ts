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
      "description: Stage a legacy ArchFlow task into a distinct canonical task and guide its explicit migration audit.",
      "---",
      "",
      "# Upgrade a Legacy Task",
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

  it("pins staging, rerun, audit, and resume semantics", () => {
    for (const required of [
      "Keep the legacy source unchanged",
      "require the source and destination to share one Git repository",
      "distinct canonical destination",
      "Seed `.archflow/tasks/<task>/prd.md` from the staged draft",
      "Seed `.archflow/tasks/<task>/design.md` from the staged draft",
      "never approval evidence",
      "phase plan that covers the derived resume phase",
      "revise the canonical design before asking the human to approve it",
      "Open the `migration-audit` gate only while durable status is at the approved `design` result",
      "The accepted gate leaves the cursor at `design`; the next ordinary `archflow_state` produce call performs the jump",
      "one past the highest mapped implementation log",
      "Use `exclude` as the explicit lever",
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
