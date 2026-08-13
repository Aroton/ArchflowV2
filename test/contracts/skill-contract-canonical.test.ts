import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_DEFINITIONS } from "../../src/contracts/errors.js";
import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { TOOL_NAMES } from "../../src/contracts/tool-names.js";
import { LOCAL_COMMANDS } from "../../src/local/commands.js";
import { classifyTaskPath } from "../../src/repository/paths.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillNames = [
  "archflow-init",
  "archflow-upgrade",
  "archflow-explore",
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
  "archflow-status",
] as const;
const normalPhaseSkills = [
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
  "archflow-status",
] as const;
const productionRubricSkills = [
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
] as const;
function skill(name: typeof skillNames[number]): string {
  return readFileSync(resolve(root, "skills", name, "SKILL.md"), "utf8");
}

function frontmatter(source: string): Readonly<Record<string, string>> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (match?.[1] === undefined) throw new TypeError("skill frontmatter is missing");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const separator = line.indexOf(":");
    if (separator < 1) throw new TypeError("skill frontmatter line is invalid");
    return [line.slice(0, separator), line.slice(separator + 1).trim()];
  }));
}

describe("canonical skill contracts", () => {
  it("names only shipped local commands, MCP tools, and project errors", () => {
    const source = skillNames.map(skill).join("\n");
    const commands = [...source.matchAll(/\barchflow-local\s+([a-z][a-z-]*)/gu)].map((match) => match[1]!);
    const tools = [...source.matchAll(/\barchflow_[a-z_]+\b/gu)].map((match) => match[0]);
    const namedErrors = [...source.matchAll(/\b[A-Z][A-Z_]+\b/gu)]
      .map((match) => match[0])
      .filter((name) => name.includes("_") && name !== "SKILL");

    expect([...new Set(commands)].sort()).toEqual(expect.arrayContaining([...new Set(commands)]));
    for (const command of commands) expect(LOCAL_COMMANDS).toContain(command);
    for (const tool of tools) expect(TOOL_NAMES).toContain(tool);
    for (const error of namedErrors) expect(PROJECT_ERROR_DEFINITIONS).toHaveProperty(error);
  });

  it("keeps exact frontmatter, server-owned review policy, and dual-client hand-offs", () => {
    for (const name of skillNames) {
      const fields = frontmatter(skill(name));
      expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
      expect(fields.name).toBe(name);
      expect(fields.description).not.toBe("");
    }
    for (const name of normalPhaseSkills) {
      const source = skill(name);
      expect(source).toContain("Claude:");
      expect(source).toContain("Codex:");
    }
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain("full status");
      expect(source).toContain("`review_policy`");
      expect(source).toContain("`review_policy.rubric`");
      expect(source).toContain("`resources`");
      expect(source).toContain("{role,path,access}");
      expect(source).toContain('`{"kind":"counter-review"}`');
      expect(source).toContain("`archflow-local decide --task <task>`");
      expect(source).not.toContain("## Stable rubric");
      expect(source).not.toContain('"criteria":[');
      expect(source).not.toContain('"kind":"counter-review","rubric"');
      expect(source).not.toContain('kind: "interface"');
    }
  });

  it("keeps workflow paths status-owned while preserving ordinary repository exploration", () => {
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain("select");
      expect(source).toContain("by role");
      expect(source).toContain("returned paths");
      expect(source.toLowerCase()).toContain("ordinary repository exploration");
    }
  });

  it("rejects envelope gaps and keeps non-material findings out of human approval", () => {
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain("`unverifiable-`");
      expect(source).toContain("`envelope-gap: `");
      expect(source).toContain("not a backlog-triage meeting");
      expect(source).toContain("rejected non-material");
    }
  });

  it("keeps human gates conversational and machine bindings diagnostic-only", () => {
    const all = skillNames.map(skill).join("\n");
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain("conversational");
      expect(source).toContain("ask one direct question");
      expect(source).toContain("diagnostic");
      expect(source).toContain("audit detail");
      expect(source).toContain("there is no optional");
    }
    expect(skill("archflow-status")).toContain("Do not expose the gate ID");
    expect(skill("archflow-init")).toContain("Do not relay raw output");
    expect(all).not.toContain("archflow-local gate-counter");
    expect(all).not.toContain("SUPPLEMENTAL_REVIEW_REQUIRED");
    expect(all).not.toContain("supplemental_outcome");
  });

  it("classifies human revisions and restarts significant review cycles", () => {
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain("A **simple** revision");
      expect(source).toContain("approval of the final bytes");
      expect(source).toContain("A **significant** revision");
      expect(source).toContain("resets the attempt count to 1");
      expect(source).toContain("automatically runs a fresh opposite-client counter-review plus constitution review");
      expect(source).toContain("override it in either direction");
    }
  });

  it("uses one bounded PRD author check before the independent review", () => {
    const source = skill("archflow-prd");
    expect(source).toContain("perform one bounded author check");
    expect(source).not.toContain("spawn a fresh review sub-agent");
    expect(source).toContain("Do not spawn an additional generative reviewer");
  });

  it("persists PRD clarification dialogue in the pinned ask record", () => {
    const source = skill("archflow-prd");
    expect(source).toContain("## Clarifications");
    expect(source).toContain("### Question 1");
    expect(source).toContain("### Answer 1");
    expect(source).toContain("before presenting it to the user");
    expect(source).toContain("An unanswered question remains in the resource");
    expect(source).toContain("re-enter `produce` before appending");

    expect(source).toContain("`user-ask` resource");
    expect(source).toContain("judges ask fidelity against this entire pinned record");
  });

  it("takes each phase rubric from full status and never authors durable review policy", () => {
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain("server selects that same policy for the durable counter-review");
      expect(source).toContain("never copy a rubric from skill text or author one");
    }
  });

  it("makes every producer execute and verify the server-derived phase hand-off", () => {
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain('next_action.code: "advance-phase"');
      expect(source).toContain('`"complete-task"`');
      expect(source).toContain('`{"kind":"advance"}`');
      expect(source).toContain("call `archflow_state` with the returned `staged.reference`");
      expect(source).toContain("Re-run status");
      expect(source).toContain("do not return until durable status");
    }
  });

  it("limits destination-skill hand-off recovery to the exact server-derived target", () => {
    for (const name of ["archflow-design", "archflow-phase-design", "archflow-phase-impl"] as const) {
      const source = skill(name);
      expect(source).toContain("immediate predecessor hand-off");
      expect(source).toContain("`target_phase_instance`");
      expect(source).toContain("`skill_args`");
      expect(source).toContain("otherwise refuse the wrong phase");
    }
  });

  it("renders pending hand-offs from the exact server-derived destination command", () => {
    const source = skill("archflow-status");
    expect(source).toContain("exact server-derived destination command");
    expect(source).toContain("`next_action.skill`");
    expect(source).toContain("`next_action.skill_args`");
    expect(source.toLowerCase()).toContain("never substitute the current phase's skill");
  });

  it("admits every canonical task document path used by the skills", () => {
    const admitted = [
      "prd.md",
      "design.md",
      "phases/1/design.md",
      "phases/1/impl-notes.md",
    ];
    for (const path of admitted) {
      expect(classifyTaskPath(parseTaskSlug("example"), parseTaskPathClaim(path))).toEqual({
        schema_version: "1",
        ok: true,
        value: "document",
      });
    }
    expect(classifyTaskPath(parseTaskSlug("example"), parseTaskPathClaim("ask.md"))).toEqual({
      schema_version: "1",
      ok: true,
      value: "task-ask",
    });
  });

  it("pins the finite and intentionally open-ended design phase-plan grammar", () => {
    const source = skill("archflow-design");
    expect(source).toContain("`### Phase N: Name`");
    expect(source).toContain("`<!-- archflow:phase-plan:open-ended -->`");
    expect(source).toContain("alternate dashes, tables, skipped numbers");
    expect(source).toContain("Design artifact approval fails closed");
  });

  it("keeps the client instruction files byte-identical", () => {
    expect(readFileSync(resolve(root, "CLAUDE.md")))
      .toEqual(readFileSync(resolve(root, "AGENTS.md")));
  });
});
