import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADVERTISED_TOOL_NAMES } from "../../src/contracts/tool-names.js";
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

  it("names only shipped helper commands and advertised MCP tools", () => {
    const commands = [...source.matchAll(/\barchflow-local\s+([a-z][a-z-]*)/gu)]
      .map((match) => match[1]!);
    const tools = [...source.matchAll(/\barchflow_[a-z_]+\b/gu)]
      .map((match) => match[0]);
    expect(commands).toEqual(expect.arrayContaining(["upgrade", "manual-status"]));
    for (const command of commands) {
      expect(LOCAL_COMMANDS, `archflow-local ${command}`).toContain(command);
    }
    for (const tool of tools) expect(ADVERTISED_TOOL_NAMES, `upgrade skill names ${tool}`).toContain(tool);
    for (const command of [...source.matchAll(/`(archflow-local [^`]+)`/gu)]) {
      expect(command[1]).toContain("--task <task>");
    }
  });

  it("names no other local command than the upgrade adapter and the degraded classifier", () => {
    // `manual-status` is the read-only degraded classifier. Every other retained local
    // command is a diagnostic or bounded-recovery path, so the upgrade skill's only local
    // mutation surface is `archflow-local upgrade` itself — adoption cannot become a
    // second workflow frontend.
    const commands = [...new Set(
      [...source.matchAll(/\barchflow-local\s+([a-z][a-z-]*)/gu)].map((match) => match[1]!),
    )];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(["upgrade", "manual-status"], `names ${command}`).toContain(command);
    }
  });

  it("names no retired tool or helper choreography", () => {
    const retired = [
      "`archflow_state`",
      "`archflow_counter_review`",
      "`archflow_gate`",
      "`archflow_waiver`",
      "archflow_state",
      "archflow_counter_review",
      "archflow_gate",
      "archflow_waiver",
      "build-request",
      "archflow-local envelope",
      "archflow-local decide",
      "gate-preview",
      "archflow-local commit",
      "archflow-local status",
      "staged.reference",
    ];
    for (const banned of retired) {
      expect(source, `upgrade skill names ${banned}`).not.toContain(banned);
    }
  });

  it("pins the local staging adapter with approved-preview binding and blocking findings", () => {
    for (const required of [
      "Keep the source unchanged",
      "same Git worktree",
      "distinct canonical destination",
      "operation `preview`",
      "without writing",
      "operation `stage`",
      "`approved_preview_digest` set to the preview digest",
      "must not create `.archflow/tasks/<task>/config.yaml`",
      "operation `discard-stage`",
      "use `exclude` only for the exact legacy-relative path",
      "unresolved task-local constitution edit",
      "secretlint reports selected legacy content",
    ]) expect(source).toContain(required);
  });

  it("pins local atomic adoption before any MCP call", () => {
    for (const required of [
      "input-free `archflow-local upgrade adopt --task <task>`",
      "atomically publishes one destination",
      "`config.yaml`, `state.json`, `prd.md`, and `design.md`",
      "every mapped prior phase design",
      "every mapped implementation log",
      "Adoption is retry-safe",
      "replays without duplicating effects",
      "fail closed",
      "No MCP call exists before this point",
      "adoption itself approves nothing",
    ]) expect(source).toContain(required);
  });

  it("pins the semantic review and migration-audit choreography", () => {
    for (const required of [
      '{"schema_version":"1","task_id":"<task>","invocation":{"skill":"archflow-design","intent":"resume"}}',
      "`archflow_apply`",
      '{"kind":"work-result","outcome":"succeeded"}',
      "without changing its bytes",
      "exactly one disposition per returned finding",
      "`envelope-gap: `",
      "one `migration-audit` gate instead of separate PRD and design approval gates",
      '{"kind":"gate-summary","summary":<summary>}',
      "ask one direct question",
      '{"kind":"decision","choice":<selected presentation option token>,"reason":<human reason>}',
      "archives that decision and settles it in separate substeps",
      "no-submission `revise`",
      "A **simple** revision",
      "A **significant** revision",
      "requires approval of the final bytes",
      "resets the attempt count to 1",
      "fresh counter-review plus constitution review",
      "override the classification in either direction",
    ]) expect(source).toContain(required);
  });

  it("pins import-commit authority, client-side commit, and the resume derivation", () => {
    for (const required of [
      "fresh human approval for the exact imported document bytes",
      "import-commit authority",
      "`commit.paths`",
      ":(top,literal)<path>",
      "`commit.message`",
      "Do not ask for a second commit confirmation.",
      "create the commit yourself",
      "Never push automatically",
      "read-only `archflow_status`",
      "observes the commit proof",
      "phase N has a mapped design and no implementation log",
      "`archflow-phase-impl <task> N`",
      "`archflow-phase-design <task> N`",
      "`state.json` plus authenticated gate authority remains the source of truth",
    ]) expect(source).toContain(required);
  });

  it("pins the standard server-outage ladder with upgrade staging classifications", () => {
    expect(source).toContain("If an MCP workflow tool is unavailable");
    expect(source).toContain("`archflow-local manual-status --task <task>`");
    expect(source).toContain("`upgrade-staged`");
    expect(source).toContain("`upgrade-restart-required`");
    expect(source).toContain("Record nothing offline");
    expect(source).toContain("never require the server");
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
