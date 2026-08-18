import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_DEFINITIONS } from "../../src/contracts/errors.js";
import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { ADVERTISED_TOOL_NAMES } from "../../src/contracts/tool-names.js";
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
  "archflow-constitution",
] as const;
const normalPhaseSkills = [
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
  "archflow-status",
] as const;
const producerSkills = [
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
] as const;
const semanticDocumentSkills = [
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
] as const;
const semanticProducerSkills = [
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
    for (const tool of tools) expect(ADVERTISED_TOOL_NAMES).toContain(tool);
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
    for (const name of semanticProducerSkills) {
      const source = skill(name);
      expect(source).toContain("`review_context.rubric`");
      expect(source).toContain("`resources`");
      expect(source).toContain("{role,path,access}");
      expect(source).toContain("`archflow_status`");
      expect(source).toContain("`archflow_apply`");
      expect(source).not.toContain("## Stable rubric");
      expect(source).not.toContain('"criteria":[');
    }
  });

  it("keeps constitution configuration documentation-only and preserves policy evolution", () => {
    const source = skill("archflow-constitution");
    expect(source).toContain("`.archflow/constitution/`");
    expect(source).toContain("increment");
    expect(source).toContain("never delete an ID");
    expect(source.toLowerCase()).toContain("never claim that an existing task adopted the new rule");
    expect(source).not.toContain("archflow-local");
    expect(source).not.toContain("archflow_");
  });

  it("keeps workflow paths status-owned while preserving ordinary repository exploration", () => {
    for (const name of producerSkills) {
      const source = skill(name);
      expect(source).toContain("select");
      expect(source).toContain("by role");
      expect(source).toContain("returned paths");
      expect(source.toLowerCase()).toContain("ordinary repository exploration");
    }
  });

  it("rejects envelope gaps and keeps non-material findings out of human approval", () => {
    for (const name of producerSkills) {
      const source = skill(name);
      expect(source).toContain("`unverifiable-`");
      expect(source).toContain("`envelope-gap: `");
      expect(source).toContain("not a backlog-triage meeting");
      expect(source).toContain("rejected non-material");
    }
  });

  it("keeps human gates conversational and machine bindings diagnostic-only", () => {
    const all = skillNames.map(skill).join("\n");
    for (const name of producerSkills) {
      const source = skill(name);
      expect(source).toContain("conversational");
      expect(source.toLowerCase()).toContain("ask one direct question");
      expect(source).toContain("diagnostic");
      expect(source).toContain("audit detail");
      expect(source.toLowerCase()).toContain("there is no optional");
    }
    expect(skill("archflow-status")).toContain("Do not expose the gate ID");
    expect(skill("archflow-init")).toContain("Do not relay raw output");
    expect(all).not.toContain("archflow-local gate-counter");
    expect(all).not.toContain("SUPPLEMENTAL_REVIEW_REQUIRED");
    expect(all).not.toContain("supplemental_outcome");
  });

  it("classifies human revisions and restarts significant review cycles", () => {
    for (const name of producerSkills) {
      const source = skill(name);
      expect(source).toMatch(/[Aa] \*\*simple\*\* revision/u);
      expect(source).toContain("approval of the final bytes");
      expect(source).toMatch(/[Aa] \*\*significant\*\* revision/u);
      expect(source).toContain("resets the attempt count to 1");
      expect(source).toMatch(/automatically runs a fresh (?:opposite-client )?counter-review plus constitution review/u);
      expect(source).toMatch(/override(?: it)? in either direction/u);
    }
  });

  it("uses one bounded PRD author check before the independent review", () => {
    const source = skill("archflow-prd");
    expect(source.toLowerCase()).toContain("perform one bounded author check");
    expect(source).not.toContain("spawn a fresh review sub-agent");
    expect(source).toMatch(/Do not spawn an (?:additional|extra) generative reviewer/u);
  });

  it("persists PRD clarification dialogue in the pinned ask record", () => {
    const source = skill("archflow-prd");
    expect(source).toContain("## Clarifications");
    expect(source).toContain("### Question 1");
    expect(source).toContain("### Answer 1");
    expect(source).toContain("before presenting it");
    expect(source).toMatch(/An unanswered question remains(?: in the resource)?/u);
    expect(source).toContain("returned `user-ask`");
    expect(source).toContain("ask fidelity");
  });

  it("takes review context from semantic status for every producer skill", () => {
    for (const name of semanticProducerSkills) {
      const source = skill(name);
      expect(source).toContain("`review_context.rubric`");
      expect(source).toContain("active rules");
      expect(source).toMatch(/never (?:author durable review policy|an authored rubric)/u);
      expect(source).not.toContain("archflow-local build-request");
      expect(source).not.toContain("archflow-local envelope");
      expect(source).not.toContain("staged.reference");
      expect(source).not.toContain("`archflow_state`");
      expect(source).not.toContain("`archflow_counter_review`");
      expect(source).not.toContain("`archflow_gate`");
      expect(source).not.toContain("`archflow_waiver`");
      expect(source).not.toContain("archflow-local decide");
      expect(source).not.toContain("archflow-local commit");
    }
  });

  it("keeps the implementation producer on semantic commit observation and successor boundaries", () => {
    const source = skill("archflow-phase-impl");
    expect(source).toContain('`{"kind":"work-result","outcome":"succeeded","implementation":{...}}`');
    expect(source).toContain("`base_commit`");
    expect(source).toContain("`outputs`");
    expect(source).toContain("`restore_targets`");
    expect(source).toContain("`declared_inputs`");
    expect(source).toContain("never author those values");
    expect(source).toContain("`verification-transcript`");
    expect(source).toContain("digest-checked transcript");
    expect(source).toContain('`{"kind":"gate-summary","summary":<summary>}`');
    expect(source).toContain("selected presentation option token");
    expect(source).toContain("separate no-submission `open-waiver`");
    expect(source).toContain("`requires_human_confirmation: true`");
    expect(source).toContain("`commit.paths`");
    expect(source).toContain(":(top,literal)<path>");
    expect(source).toContain("create the commit yourself");
    expect(source).toContain("read-only `archflow_status`");
    expect(source).toContain("observes the commit proof");
    expect(source).toContain("`finish-task`");
    expect(source).toContain("never apply a `start-next-skill` offer");
    expect(source).toContain("never start successor work");
  });

  it("makes document skills observe and report semantic successors without starting them", () => {
    for (const name of semanticDocumentSkills) {
      const source = skill(name);
      expect(source).toContain("`start-next-skill`");
      expect(source).toContain("fresh status");
      expect(source).toMatch(/never start|do not start|without starting/u);
      expect(source).toContain("Claude:");
      expect(source).toContain("Codex:");
    }
  });

  it("pins document entry, reopen, semantic submission, revision, gate, waiver, and Git ownership", () => {
    expect(skill("archflow-prd")).toContain('{"skill":"archflow-prd","intent":"resume"}');
    expect(skill("archflow-design")).toContain('{"skill":"archflow-design","intent":"resume"}');
    expect(skill("archflow-phase-design")).toContain('{"skill":"archflow-phase-design","phase":<phase-number>,"intent":"resume"}');
    expect(skill("archflow-phase-impl")).toContain('{"skill":"archflow-phase-impl","phase":<phase-number>,"intent":"resume"}');
    for (const name of semanticDocumentSkills) {
      const source = skill(name);
      expect(source).toContain('`intent:"reopen"`');
      expect(source).toContain('exact `intent:"resume"` invocation above');
      expect(source).toContain("one-shot reopen invocation does not own production");
      expect(source).toContain('`"action":{"offer":<next_action.offer>}`');
      expect(source).toContain("omit `submission` for `none`");
      expect(source).toMatch(/`\{"kind":"reopening-request","request":<(?:exact request|the human's exact request)>\}`/u);
      expect(source).toContain('`{"kind":"work-result","outcome":"succeeded"}`');
      expect(source).toContain("separate no-submission `revise`");
      expect(source).toContain('`{"kind":"gate-summary","summary":<summary>}`');
      expect(source).toContain("nonblocking presentation");
      expect(source).toContain("selected presentation option token");
      expect(source).toContain("separate no-submission `open-waiver`");
    }
    expect(skill("archflow-prd")).toContain('`{"kind":"task-ask","text":<the user\'s exact original ask>}`');
    for (const name of ["archflow-design", "archflow-phase-design"] as const) {
      const source = skill(name);
      expect(source).toContain("`start-next-skill` with `next_action.offer`");
      expect(source).toContain("names a successor without an offer");
      expect(source).toContain("completed invocation does not own the hand-off");
      expect(source).toContain("returned `commit` facts");
      expect(source).toContain(":(top,literal)<path>");
      expect(source).toContain("`commit.paths`");
      expect(source).toContain("read-only `archflow_status`");
    }
    expect(skill("archflow-phase-design")).toContain("compound parent update");
  });

  it("limits destination-skill hand-off recovery to the exact semantic offer", () => {
    const source = skill("archflow-phase-impl");
    expect(source).toContain("`start-next-skill` with `next_action.offer`");
    expect(source).toContain("this exact invocation");
    expect(source).toContain("names a successor without an offer");
    expect(source).toContain("completed invocation does not own the hand-off");
    expect(source).toContain("require the position to be `phase-impl` with the requested phase");
    expect(source).toContain("report a different phase or an inspection result rather than bypassing it");
    expect(source).toContain("no reopen");
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
