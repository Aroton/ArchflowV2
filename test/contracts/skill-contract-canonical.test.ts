import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_DEFINITIONS } from "../../src/contracts/errors.js";
import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
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
const substantiveCalibration = "Report a blocking defect only when it requires producer action, and cite the specific artifact statement it contradicts or stated requirement it leaves unmet; citation is necessary but not sufficient. The violation must follow from the artifact's own text without assuming implementation behavior, ordering, or environment it does not specify. A contradiction that depends on such an assumption, or a debatable reading of whether stated text satisfies a criterion, is not blocking. Missing handling is a defect only for a condition the artifact claims to cover or a stated requirement demands. Local edge-case handling belongs to the implementer. A sound artifact is expected to yield zero blocking findings; that is successful review, not under-performance.";
const advisoryCalibration = "Use non-blocking findings for completeness suggestions, debatable readings, and observations, including handling for conditions outside the artifact's stated scope. Do not inflate them into blockers merely to report them.";
const taskSpecificCriteria = {
  "archflow-prd": ["brief-fitness", "completeness", "testable-requirements", "stated-assumptions"],
  "archflow-design": ["prd-consistency", "requirement-coverage", "assumption-risk", "phase-sizing"],
  "archflow-phase-design": ["chunk-seams", "scope-budget", "design-conformance", "integration-risk"],
  "archflow-phase-impl": ["simplicity", "duplication", "design-conformance", "dead-code", "error-handling", "justified-abstraction"],
} as const;

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

  it("keeps exact frontmatter, literal rubrics, and host-neutral normal phase skills", () => {
    for (const name of skillNames) {
      const fields = frontmatter(skill(name));
      expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
      expect(fields.name).toBe(name);
      expect(fields.description).not.toBe("");
    }
    for (const name of normalPhaseSkills) {
      const source = skill(name);
      expect(source).not.toContain("Codex");
      expect(source).not.toContain("Claude Code");
    }
    for (const name of productionRubricSkills) {
      const blocks = [...skill(name).matchAll(/```json\n([^\n]+)\n```/gu)];
      expect(blocks).toHaveLength(1);
      expect(() => parseRubricV1(JSON.parse(blocks[0]![1]!))).not.toThrow();
    }
  });

  it("calibrates every production rubric while retaining its task-specific criteria", () => {
    for (const name of productionRubricSkills) {
      const block = /```json\n([^\n]+)\n```/u.exec(skill(name));
      expect(block?.[1]).toBeDefined();
      const rubric = parseRubricV1(JSON.parse(block![1]!));
      const criteria = new Map(rubric.criteria.map((criterion) => [criterion.id, criterion]));

      expect(criteria.get("substantive-correctness")).toEqual({
        id: "substantive-correctness",
        text: substantiveCalibration,
        blocking: true,
      });
      expect(criteria.get("advisory-observations")).toEqual({
        id: "advisory-observations",
        text: advisoryCalibration,
        blocking: false,
      });
      expect([...criteria.keys()]).toEqual(expect.arrayContaining([...taskSpecificCriteria[name]]));
    }
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
