import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOCAL_COMMANDS } from "../../src/local/commands.js";

/**
 * The server-outage contract: when the MCP server is unavailable the skills stop, report the
 * read-only classified position, and wait — there is no offline recording path. The retired manual
 * workflow (manual-next, manual-handoff, checkpoint files) must not resurface in any skill, and
 * archflow-status must drive read-only archflow_status as its primary path, keep manual-status as
 * its only fallback helper, and document the classification modes with wait guidance.
 *
 * The one route-only exception: when the server is reachable and only the configured reviewer
 * route is unavailable, the reviewing skills ask the human for a substitute route and reason and
 * carry them as a review-dispatch submission that parameterizes — never skips — the automatic
 * counter-review for that dispatch.
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

  it("substitutes a reviewer route only through a human-authorized review-dispatch submission", () => {
    const reviewingSkills = [
      "archflow-prd",
      "archflow-design",
      "archflow-phase-design",
      "archflow-phase-impl",
    ];
    for (const name of reviewingSkills) {
      const skill = source(name);
      expect(skill, `${name} carries the review-dispatch submission shape`)
        .toContain('`{"kind":"review-dispatch","route_override"');
      expect(skill, `${name} scopes the failure to a reachable server and a route-only outage`)
        .toContain("both workflow tools answer but a counter-review dispatch fails because the configured reviewer route itself is unavailable");
      expect(skill, `${name} asks for the substitute route fields and the human reason`)
        .toContain("(`model`, `effort`, optionally `provider`)");
      expect(skill, `${name} requires the human reason and records it on the evidence`)
        .toContain("The reason is required, carries the human's words, and is recorded on the review evidence");
      expect(skill, `${name} never skips or replaces the automatic counter-review`)
        .toContain("never skips or replaces it");
      expect(skill, `${name} keeps the substitution the single routing exception`)
        .toContain("the single human-authorized exception to never supplying routing");
      expect(skill, `${name} keeps the degraded stop path distinct from a route outage`)
        .toContain("it is not degraded operation");
    }
  });

  it("archflow-status drives the read-only semantic status with manual-status as its fallback", () => {
    const status = source("archflow-status");
    expect(status).toContain('`{"schema_version":"1","task_id":"<task>"}`');
    expect(status).toContain("`archflow_status`");
    expect(status).toContain("no invocation");
    expect(status).toContain("no mutation offer");
    expect(status).toContain("archflow-local manual-status --task <task>");
  });

  it("archflow-status checks a no-durable-state projection for a staged legacy import before recommending initialization", () => {
    const status = source("archflow-status");
    expect(status).toContain("initialization-ready projection");
    expect(status).toContain("`initialize-task`");
    expect(status).toContain("only the helper can classify it");
    expect(status).toContain("`upgrade-staged` or `upgrade-restart-required`");
    expect(status).toContain("that classification is the authority");
    expect(status).toContain("the initialization-ready projection stands");
  });

  it("archflow-status never applies and never names archflow_apply as a call it makes", () => {
    const status = source("archflow-status");
    expect(status).toContain("never calls `archflow_apply`");
    expect(status.split("`archflow_apply`").length - 1).toBe(1);
  });

  it("archflow-status documents durable and upgrade-staging classification modes with wait guidance", () => {
    const status = source("archflow-status");
    expect(status).toContain("`normal`, `degraded`, `repair-required`, `upgrade-staged`, or `upgrade-restart-required`");
    expect(status).toContain("workflow must wait for the server");
    expect(status).toContain("there is no offline recording");
    expect(status).toContain("Do not reconstruct a status while both server and helper are unavailable");
  });

  it("archflow-status names no retired low-level tool or helper choreography", () => {
    const status = source("archflow-status");
    const retired = [
      "`archflow_state`",
      "`archflow_counter_review`",
      "`archflow_gate`",
      "`archflow_waiver`",
      "build-request",
      "archflow-local envelope",
      "archflow-local decide",
      "gate-preview",
      "archflow-local commit",
      "archflow-local status",
    ];
    for (const banned of retired) {
      expect(status, `archflow-status names ${banned}`).not.toContain(banned);
    }
  });
});
