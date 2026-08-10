import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { PROJECT_ERROR_DEFINITIONS } from "../../src/contracts/errors.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { TOOL_NAMES } from "../../src/contracts/tool-names.js";
import { LOCAL_COMMANDS } from "../../src/local/commands.js";
import { classifyTaskPath } from "../../src/repository/paths.js";
import { buildReviewEnvelope } from "../../src/review/envelopes.js";

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
const architectureSubstantiveCalibration = "Report a blocking defect only when it requires producer action, and cite the artifact statement and the pinned or repository evidence it contradicts. The violation must follow from artifact text, pinned evidence, or repository evidence at the pinned commit, never from assumed codebase behavior. A sound artifact is expected to yield zero blocking findings.";
const substantiveCalibration = {
  "archflow-prd": "Report a blocking defect only when it requires producer action, and cite the specific artifact statement it contradicts or stated requirement it leaves unmet; citation is necessary but not sufficient. The violation must follow from the artifact's own text, pinned envelope evidence, or repository evidence at the pinned commit, without assuming behavior the artifact does not specify. A sound artifact is expected to yield zero blocking findings; that is successful review, not under-performance.",
  "archflow-design": architectureSubstantiveCalibration,
  "archflow-phase-design": architectureSubstantiveCalibration,
  "archflow-phase-impl": "Report a blocking defect only when it requires producer action, citing the changed bytes and the pinned phase design statement or evidence it violates. The violation must follow from pinned material or repository evidence at the pinned commit, never from assumed behavior of unpinned code. A sound implementation is expected to yield zero blocking findings.",
} as const;
const advisoryCalibration = {
  "archflow-prd": "Use non-blocking findings for completeness suggestions, debatable readings, and observations. Do not inflate them into blockers merely to report them.",
  "archflow-design": "Use non-blocking findings for completeness suggestions, debatable readings, and observations. Do not inflate them into blockers.",
  "archflow-phase-design": "Use non-blocking findings for completeness suggestions, debatable readings, and observations. Do not inflate them into blockers.",
  "archflow-phase-impl": "Use non-blocking findings for completeness suggestions, debatable readings, and observations. Do not inflate them into blockers.",
} as const;
const phasePlanSoundnessCalibration = "Each phase is independently verifiable, ordered by dependency, and scoped so its completion is observable. A well-scoped phase is also reviewable in one sealed pass — typically around 10-15 files of hand-written change; a phase expected to exceed that typically warrants splitting at design time or marking which of its outputs are generated rather than hand-written.";
const taskSpecificCriteria = {
  "archflow-prd": ["ask-fidelity", "proportionality", "testable-requirements", "stated-assumptions"],
  "archflow-design": ["upstream-coverage", "interface-reality", "evidence-completeness", "proportionality", "phase-plan-soundness"],
  "archflow-phase-design": ["upstream-coverage", "interface-reality", "evidence-completeness", "proportionality", "phase-plan-soundness"],
  "archflow-phase-impl": ["design-conformance", "interface-fidelity", "verification-evidence", "simplicity", "duplication", "dead-code", "error-handling"],
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
        text: substantiveCalibration[name],
        blocking: true,
      });
      expect(criteria.get("advisory-observations")).toEqual({
        id: "advisory-observations",
        text: advisoryCalibration[name],
        blocking: false,
      });
      expect(criteria.get("unverifiable-claims")?.blocking).toBe(false);
      expect(criteria.get("unverifiable-claims")?.text).toContain("non-blocking finding");
      expect(criteria.get("unverifiable-claims")?.text).toContain("finding_id beginning unverifiable-");
      expect(criteria.get("unverifiable-claims")?.text).toContain("read-only repository checkout");
      if (name === "archflow-design" || name === "archflow-phase-design") {
        expect(criteria.get("phase-plan-soundness")).toEqual({
          id: "phase-plan-soundness",
          text: phasePlanSoundnessCalibration,
          blocking: true,
        });
      }
      expect([...criteria.keys()]).toEqual(expect.arrayContaining([...taskSpecificCriteria[name]]));
    }
  });

  it("routes envelope-gap findings through rejection and the human gate in every rubric skill", () => {
    for (const name of productionRubricSkills) {
      const source = skill(name);
      expect(source).toContain("`unverifiable-`");
      expect(source).toContain("`envelope-gap: `");
      expect(source).toContain("Envelope gaps");
      expect(source).toContain("never accept one");
    }
  });

  it("keeps the architecture rubric shared and its envelope re-projection digest-stable", () => {
    const literal = (name: typeof productionRubricSkills[number]): PlainJsonValue => {
      const block = /```json\n([^\n]+)\n```/u.exec(skill(name));
      return JSON.parse(block![1]!) as PlainJsonValue;
    };
    expect(canonicalJsonDigest(literal("archflow-design")))
      .toBe(canonicalJsonDigest(literal("archflow-phase-design")));

    for (const name of productionRubricSkills) {
      const rubric = literal(name);
      const rubricDigest = canonicalJsonDigest(rubric);
      const envelope = buildReviewEnvelope({
        artifact: "# Subject\n",
        rubric: parseRubricV1(rubric),
        context: [],
        subject: {
          task_id: parseTaskSlug("example"),
          phase_instance: parsePhaseInstanceId("prd"),
          role: "counter-review",
          step: "counter_review",
          subject_digest: parseSha256Digest("a".repeat(64)),
          input_fingerprint: parseSha256Digest("b".repeat(64)),
          rubric_digest: rubricDigest,
          producer_family: "claude",
          invocation_id: "invocation-1",
          result_id: "result-1",
        },
      });
      const visible = JSON.parse(new TextDecoder().decode(envelope.bytes)) as { rubric: PlainJsonValue };
      expect(canonicalJsonDigest(visible.rubric)).toBe(rubricDigest);
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
