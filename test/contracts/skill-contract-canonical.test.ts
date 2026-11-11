import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_DEFINITIONS } from "../../src/contracts/errors.js";
import { LOCAL_COMMANDS } from "../../src/local/commands.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillNames = [
  "archflow-init",
  "archflow-explore",
  "archflow-constitution",
  "archflow-run",
] as const;
function skill(name: typeof skillNames[number]): string {
  return readFileSync(resolve(root, "skills", name, "SKILL.md"), "utf8");
}

/**
 * The allow-lists are the global enforcement: any skill naming a retired tool or a retired helper
 * command fails the contract, no cohort carve-outs.
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
  it("names only shipped local commands and project errors, and no MCP tool", () => {
    for (const name of skillNames) {
      const source = skill(name);
      const commands = [...source.matchAll(/\barchflow-local\s+([a-z][a-z-]*)/gu)].map((match) => match[1]!);
      const namedErrors = [...source.matchAll(/\b[A-Z][A-Z_]+\b/gu)]
        .map((match) => match[0])
        .filter((error) => error.includes("_") && error !== "SKILL");
      for (const command of commands) expect(LOCAL_COMMANDS, `${name} names ${command}`).toContain(command);
      expect(source, `${name} names an MCP tool`).not.toMatch(/\barchflow_[a-z_]+\b/u);
      for (const error of namedErrors) expect(PROJECT_ERROR_DEFINITIONS, `${name} names ${error}`).toHaveProperty(error);
    }
  });

  it("names no retired tool or helper choreography in any skill", () => {
    for (const name of skillNames) {
      const source = skill(name);
      for (const banned of retiredHelperChoreography) {
        expect(source, `${name} names ${banned}`).not.toContain(banned);
      }
      expect(source, `${name} names a retired MCP tool`).not.toMatch(/\barchflow_[a-z_]+\b/u);
    }
  });

  it("keeps exact frontmatter on every skill", () => {
    for (const name of skillNames) {
      const fields = frontmatter(skill(name));
      expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
      expect(fields.name).toBe(name);
      expect(fields.description).not.toBe("");
    }
  });

  it("keeps constitution maintenance within repository policy and preserves evolution", () => {
    const source = skill("archflow-constitution");
    expect(source).toContain("`.archflow/constitution/`");
    expect(source).toContain("increment");
    expect(source).toContain("never delete an ID");
    expect(source).toContain("takes effect for the next review that reads the repository");
    expect(source).toContain("never claim it changed a review that already ran");
    expect(source).not.toContain("archflow_");
  });

  it("completes requested maintenance without repeat approval while preserving real boundaries", () => {
    const explore = skill("archflow-explore");
    expect(explore).toContain("invocation authorizes routine page updates and their commit");
    expect(explore).not.toContain("stop for confirmation");
    expect(explore).not.toContain("until the user explicitly approves");
    expect(explore).toContain("preserve unrelated");
    const init = skill("archflow-init");
    expect(init).toContain("without another approval");
    expect(init).toContain("only when the human chooses it");
    expect(init).toContain("host's human approval/trust boundary");
    const constitution = skill("archflow-constitution");
    expect(constitution).toContain("scoped edits and their commit without another approval");
    expect(constitution).toContain("An explanation or inspection request authorizes no edits");
    expect(constitution).toContain("Preserve custom rules and triggers");
  });

  it("keeps init output relayed conversationally and drops retired review vocabulary", () => {
    const all = skillNames.map(skill).join("\n");
    expect(skill("archflow-init")).toContain("Do not relay raw output");
    expect(all).not.toContain("archflow-local gate-counter");
    expect(all).not.toContain("SUPPLEMENTAL_REVIEW_REQUIRED");
    expect(all).not.toContain("supplemental_outcome");
  });

  it("keeps the client instruction files byte-identical", () => {
    expect(readFileSync(resolve(root, "CLAUDE.md")))
      .toEqual(readFileSync(resolve(root, "AGENTS.md")));
  });
});
