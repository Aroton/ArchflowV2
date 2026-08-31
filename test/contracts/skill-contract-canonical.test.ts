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

/**
 * With the catalogue at exactly the two semantic names, the allow-lists are the global
 * enforcement: any skill naming a retired tool or a retired helper command fails the
 * contract, no cohort carve-outs. Every workflow — normal lifecycle, status reporting,
 * and legacy adoption — runs through `archflow_status`/`archflow_apply` plus the retained
 * local adapters, so the pinned vocabulary below is exhaustive, not per-cohort.
 */
const retiredHelperChoreography = [
  "archflow-local build-request",
  "archflow-local envelope",
  "archflow-local decide",
  "archflow-local gate-preview",
  "archflow-local commit",
  "archflow-local status",
  "staged.reference",
] as const;

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
  it("advertises exactly the two semantic workflow tools", () => {
    expect([...ADVERTISED_TOOL_NAMES]).toEqual(["archflow_status", "archflow_apply"]);
  });

  it("names only shipped local commands, MCP tools, and project errors", () => {
    for (const name of skillNames) {
      const source = skill(name);
      const commands = [...source.matchAll(/\barchflow-local\s+([a-z][a-z-]*)/gu)].map((match) => match[1]!);
      const tools = [...source.matchAll(/\barchflow_[a-z_]+\b/gu)].map((match) => match[0]);
      const namedErrors = [...source.matchAll(/\b[A-Z][A-Z_]+\b/gu)]
        .map((match) => match[0])
        .filter((error) => error.includes("_") && error !== "SKILL");
      for (const command of commands) expect(LOCAL_COMMANDS, `${name} names ${command}`).toContain(command);
      for (const tool of tools) expect(ADVERTISED_TOOL_NAMES, `${name} names ${tool}`).toContain(tool);
      for (const error of namedErrors) expect(PROJECT_ERROR_DEFINITIONS, `${name} names ${error}`).toHaveProperty(error);
    }
  });

  it("names no retired tool or helper choreography in any skill", () => {
    for (const name of skillNames) {
      const source = skill(name);
      for (const banned of retiredHelperChoreography) {
        expect(source, `${name} names ${banned}`).not.toContain(banned);
      }
      const tools = [...source.matchAll(/\barchflow_[a-z_]+\b/gu)].map((match) => match[0]);
      for (const tool of tools) expect(ADVERTISED_TOOL_NAMES, `${name} names retired tool ${tool}`).toContain(tool);
    }
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
    expect(skill("archflow-status")).toMatch(/gate IDs?.*diagnostic-only/u);
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

  it("uses one bounded author check and no extra generative reviewer for every producer", () => {
    for (const name of producerSkills) {
      const source = skill(name);
      expect(source.toLowerCase()).toContain("perform one bounded author check");
      expect(source).toContain("`review_context.rubric` verbatim");
      expect(source).toContain("returned active rules");
      expect(source).toContain("server-dispatched review is the only independent review");
      expect(source).not.toContain("spawn a fresh review sub-agent");
      expect(source).not.toContain("fresh same-side draft review");
      expect(source).toMatch(/Do not spawn an (?:additional|extra) generative reviewer/u);
    }
  });

  it("requires phase designs to author one stable implementation-component manifest", () => {
    const source = skill("archflow-phase-design");
    expect(source).toContain("## Implementation Components");
    expect(source).toContain("archflow-components-v1");
    expect(source).toContain("independently scoreable");
    expect(source).toContain("primary` first");
    expect(source).toContain("ordinal-sorted secondaries");
    expect(source).toContain("normalized literal `paths`");
    expect(source).toContain("Never infer it");
  });

  it("keeps review triage on the submitted subject instead of the whole repository", () => {
    for (const name of producerSkills) {
      const source = skill(name);
      expect(source).toContain("review subject");
      expect(source).toMatch(/repository snapshots.*evidence/u);
      expect(source).toMatch(/pre-existing defects?/u);
      expect(source).toContain("introduced, exposed, or materially worsened");
    }
    const implementation = skill("archflow-phase-impl");
    expect(implementation).toContain("declared add, modify, delete, and rename outputs");
    expect(implementation).toContain("current post-change behavior");
    expect(implementation).toContain("this is not a general code review");
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
      expect(source).toContain("author durable review policy");
      expect(source).toContain("server-dispatched review is the only independent review");
    }
  });

  it("normalizes optional review routes once and preserves the exact invocation", () => {
    for (const name of producerSkills) {
      const source = skill(name);
      expect(source).toContain("--counter-reviewer <model>:<effort>[@<provider>]");
      expect(source).toContain("--adjudicator <model>:<effort>[@<provider>]");
      expect(source).toContain("order-independent");
      expect(source).toContain("at most once");
      expect(source).toContain("split once at the first `:`");
      expect(source).toContain("split the remainder once at the first `@`");
      expect(source).toContain("`invocation.review_routes`");
      expect(source).toContain("An omitted role independently uses its live phase/base configured route");
      expect(source).toContain("repeat it identically on every status/apply call in this run");
      expect(source).toContain("significant-revision reviews");
      expect(source).toMatch(/Never add, drop, or change (?:normalized )?routes between status and apply/u);
    }
    for (const name of ["archflow-phase-design", "archflow-phase-impl"] as const) {
      expect(skill(name)).toContain("--test-reviewer <model>:<effort>[@<provider>]");
    }
    for (const name of ["archflow-prd", "archflow-design"] as const) {
      expect(skill(name)).not.toContain("--test-reviewer <model>:<effort>[@<provider>]");
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
    expect(source).not.toContain("requires_human_confirmation");
    expect(source).toContain("execute only its authenticated commit facts");
    expect(source).toContain("never invent or request a second human confirmation");
    expect(source).toContain("`commit.paths`");
    expect(source).toContain(":(top,literal)<path>");
    expect(source).toContain("create the commit yourself");
    expect(source).toContain("read-only `archflow_status`");
    expect(source).toContain("observes the commit proof");
    expect(source).toContain("`finish-task`");
    expect(source).toContain("never apply a `start-next-skill` offer");
    expect(source).toContain("never start successor work");
  });

  it("follows returned gates and autonomous actions without inventing either", () => {
    for (const name of semanticDocumentSkills) {
      const source = skill(name);
      expect(source).toContain("Only when");
      expect(source).toContain("Every returned `presentation` requires explicit human judgment");
      expect(source).toContain("When a `presentation` is returned, stop");
      expect(source).toContain("If no presentation is returned, do not stop for a human decision; follow the fresh server-returned action directly.");
      expect(source).toMatch(/Never synthesize a gate/u);
    }
    const implementation = skill("archflow-phase-impl");
    expect(implementation).toContain("Only when the current offer expects `gate-summary`");
    expect(implementation).toContain("Never synthesize a commit-authorization gate");
    expect(implementation).toContain("When a `presentation` is returned, stop");
    expect(implementation).toContain("If no presentation is returned, do not stop for a human decision; follow the fresh server-returned action directly.");
    expect(implementation).toContain("execute only its authenticated commit facts");
  });

  it("presents the authenticated classified reason envelope consistently", () => {
    for (const name of [...semanticDocumentSkills, "archflow-phase-impl", "archflow-status"] as const) {
      const source = skill(name);
      expect(source).toContain("`presentation.reasons`");
      expect(source).toContain('`presentation.class:"exception"`');
    }
    for (const name of [...semanticDocumentSkills, "archflow-phase-impl"] as const) {
      expect(skill(name)).toMatch(/authenticated archived (?:request bindings|facts|request)/u);
    }
    expect(skill("archflow-status")).toContain("exceptional reason dominates the aggregate class");
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
    expect(skill("archflow-prd")).toContain('{"skill":"archflow-prd","intent":"resume",<optional review_routes>}');
    expect(skill("archflow-design")).toContain('{"skill":"archflow-design","intent":"resume",<optional review_routes>}');
    expect(skill("archflow-phase-design")).toContain('{"skill":"archflow-phase-design","phase":<phase-number>,"intent":"resume",<optional review_routes>}');
    expect(skill("archflow-phase-impl")).toContain('{"skill":"archflow-phase-impl","phase":<phase-number>,"intent":"resume",<optional review_routes>}');
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
    expect(skill("archflow-phase-design")).toContain("compound production result");
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

  it("renders authenticated implementation advice without changing workflow action authority", () => {
    for (const name of ["archflow-phase-design", "archflow-phase-impl", "archflow-status"] as const) {
      const source = skill(name);
      expect(source).toContain("`implementation_recommendation`");
      expect(source).toContain("For `ready`");
      expect(source).toContain("For `blocked`");
      expect(source).toContain("For `unavailable`");
      expect(source).toContain("determining components");
      expect(source).toContain("A-E judgments");
      expect(source).toContain("actual implementation route is not recorded");
      expect(source).toContain("substituted effort-review route conspicuous");
      expect(source).toContain("`next_action`");
    }
    expect(skill("archflow-phase-design")).toContain("Every changed phase-design subject");
    expect(skill("archflow-phase-design")).toContain("predecessor evidence can never supply");
    expect(skill("archflow-phase-design")).toContain("`effort-reviewer`");
    expect(skill("archflow-phase-impl")).toContain("before reading implementation inputs or writing code");
    expect(skill("archflow-phase-impl")).toContain("Model selection happens outside ArchFlow");
    expect(skill("archflow-status")).toContain("Never parse Markdown or raw task state for advice");
  });

  it("keeps the status skill a read-only semantic consumer", () => {
    const source = skill("archflow-status");
    expect(source).toContain("read-only `archflow_status`");
    expect(source).toContain("no invocation");
    expect(source).toContain("no mutation offer");
    expect(source).toContain("never calls `archflow_apply`");
    expect(source).not.toContain("requires_human_confirmation");
    expect(source).toContain("no second human confirmation remains");
    expect(source).toContain("`archflow-local manual-status --task <task>`");
  });

  it("pins the upgrade skill's local adapter plus semantic choreography", () => {
    const source = skill("archflow-upgrade");
    expect(source).toContain("input-free `archflow-local upgrade adopt --task <task>`");
    expect(source).toContain("`approved_preview_digest`");
    expect(source).toContain("operation `discard-stage`");
    expect(source).toContain("No MCP call exists before this point");
    expect(source).toContain('{"skill":"archflow-design","intent":"resume"}');
    expect(source).toContain("`archflow_apply`");
    expect(source).toContain('{"kind":"work-result","outcome":"succeeded"}');
    expect(source).toContain('{"kind":"gate-summary","summary":<summary>}');
    expect(source).toContain('{"kind":"decision","choice":<selected presentation option token>,"reason":<human reason>}');
    expect(source).toContain("one unconditional `migration-audit` gate instead of separate ordinary PRD and design approval gates");
    expect(source).toContain("no-submission `revise`");
    expect(source).toContain("`commit.paths`");
    expect(source).toContain("create the commit yourself");
    expect(source).toContain("read-only `archflow_status`");
    expect(source).toContain("observes the commit proof");
    expect(source).toContain("phase N has a mapped design and no implementation log");
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

  it("makes finite phase plans expose coherent repository-ready increments", () => {
    const source = skill("archflow-design");
    expect(source).toContain("one coherent repository-ready increment");
    expect(source).toContain("one primary behavioral or enabling outcome");
    expect(source).toContain("valid completion state");
    expect(source).toContain("approved predecessors or stable inputs");
    expect(source).toContain("one understandable verification story");
    expect(source).toContain("**split check**");
    expect(source).toContain("**merge check**");
    expect(source).toMatch(/unusually broad phase only with a concrete/u);
    expect(source).toMatch(/unusually small phase only when/u);
    expect(source).toContain("Phase count, layer count, file count, diff size, and numeric thresholds are not sizing evidence");
  });

  it("requires open-ended rationale and one bounded numbered-phase fit check", () => {
    const taskDesign = skill("archflow-design");
    expect(taskDesign).toContain("why responsible phase boundaries cannot yet be named");
    expect(taskDesign).toContain("what information will make decomposition possible");

    const phaseDesign = skill("archflow-phase-design");
    expect(phaseDesign).toContain("perform one bounded fit check");
    expect(phaseDesign).toContain("Preserve a sound approved boundary");
    expect(phaseDesign).toContain("phase-worthy increment");
    expect(phaseDesign).toContain("returned writable task-design or PRD parent");
    expect(phaseDesign).toContain("existing compound production result");
    expect(phaseDesign).toContain("revised final bound would be below the current phase");
    expect(phaseDesign).toContain("explicit human request to reopen task design");
    expect(phaseDesign).toContain("server-returned authority");
  });

  it("keeps the client instruction files byte-identical", () => {
    expect(readFileSync(resolve(root, "CLAUDE.md")))
      .toEqual(readFileSync(resolve(root, "AGENTS.md")));
  });
});
