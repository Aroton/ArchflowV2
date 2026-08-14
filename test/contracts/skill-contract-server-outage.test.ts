import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOCAL_COMMANDS } from "../../src/local/commands.js";

/**
 * The server-outage contract: when the MCP server is unavailable the skills stop, report the
 * read-only classified position, and wait — there is no offline recording path. The retired manual
 * workflow (manual-next, manual-handoff, checkpoint files) must not resurface in any skill, and
 * archflow-status must keep documenting the three classification modes with wait guidance.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillNames = readdirSync(resolve(root, "skills"));
const source = (name: string): string =>
  readFileSync(resolve(root, "skills", name, "SKILL.md"), "utf8");

describe("server-outage skill contracts", () => {
  it("publishes manual-status as the only manual helper command", () => {
    expect(LOCAL_COMMANDS).toContain("manual-status");
    expect(LOCAL_COMMANDS).not.toContain("manual-next");
    expect(LOCAL_COMMANDS).not.toContain("manual-handoff");
    expect(LOCAL_COMMANDS).not.toContain("checkpoint");
    expect(LOCAL_COMMANDS).not.toContain("import");
  });

  it("no skill mentions a retired manual workflow command", () => {
    expect(skillNames.length).toBeGreaterThanOrEqual(8);
    for (const name of skillNames) {
      const skill = source(name);
      expect(skill, `${name} mentions manual-next`).not.toContain("manual-next");
      expect(skill, `${name} mentions manual-handoff`).not.toContain("manual-handoff");
      expect(skill, `${name} names checkpoint as a command`).not.toMatch(/archflow-local checkpoint\b/u);
      expect(skill, `${name} mentions checkpoints`).not.toMatch(/\bcheckpoint/iu);
    }
  });

  it("archflow-status documents durable and upgrade-staging classification modes with wait guidance", () => {
    const status = source("archflow-status");
    expect(status).toContain("`normal`, `degraded`, `repair-required`, `upgrade-staged`, or `upgrade-restart-required`");
    expect(status).toContain("workflow must wait for the server");
    expect(status).toContain("there is no offline recording");
    expect(status).toContain("archflow-local manual-status --task <task>");
    expect(status).toContain("Do not reconstruct a status while both server and helper are unavailable");
  });
});
