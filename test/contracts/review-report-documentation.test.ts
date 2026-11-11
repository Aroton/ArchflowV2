import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DISPATCH_FAILURE_CODES } from "../../src/contracts/dispatch-failure.js";
import { simpleReviewInputSchema } from "../../src/contracts/simple-review.js";
import { LOCAL_COMMANDS } from "../../src/local/commands.js";

const root = new URL("../../", import.meta.url);
const page = (path: string) => readFileSync(new URL(path, root), "utf8");

// The maintained set: every caps-named page under docs/, except the point-in-time evidence directories.
const CAPS_PAGES = readdirSync(new URL("docs/", root), { recursive: true, encoding: "utf8" })
  .filter((entry) => /^(?!(?:validation|research)\/)(?:.*\/)?[A-Z][A-Z-]*\.md$/u.test(entry))
  .map((entry) => `docs/${entry}`)
  .sort();

const SURVIVING_PAGES = ["docs/cli/COMMANDS.md", "docs/review/COUNTER-REVIEW.md", "docs/mcp/DISPATCH.md", "docs/workflow/SKILLS.md"];

describe("review documentation", () => {
  it("documents the review payload, result and failure codes the code accepts and returns", () => {
    const commands = page("docs/cli/COMMANDS.md");
    for (const field of Object.keys(simpleReviewInputSchema.shape)) expect(commands, `payload field ${field}`).toContain(`\`${field}\``);
    for (const code of DISPATCH_FAILURE_CODES) expect(commands, `failure code ${code}`).toContain(`\`${code}\``);
    for (const code of ["INPUT_INVALID", "BASELINE_CHANGED", "POLICY_CHANGED", "INPUT_TOO_LARGE", "CONFIG_INVALID", "SUBJECT_CHANGED", "REVIEW_INCOMPLETE", "CANCELLED", "REVIEW_FAILED", "DISPATCH_FAILED"]) {
      expect(commands, `error code ${code}`).toContain(`\`${code}\``);
    }
    for (const term of ["human_review_reasons", "failures", "reports", "issues_found", "no_issues_found", "policy_digest", "subject_digest"]) {
      expect(commands, term).toContain(term);
    }
    for (const command of LOCAL_COMMANDS) expect(commands).toContain(`archflow-local ${command}`);
  });

  it("describes report interpretation and independent policy authority", () => {
    const review = page("docs/review/COUNTER-REVIEW.md");
    expect(review).toContain("no_issues_found");
    expect(review).toContain("working AI");
    expect(review).toContain("cannot bypass constitution checks");
    expect(review).toContain("approval_rules");
    expect(review).toContain("never trigger an approval rule");
    expect(review).not.toContain("declared or changed path");
    expect(review).toContain("review_trigger");
    expect(review).toContain("SUBJECT_CHANGED");
    expect(review).toContain("certifies that review coverage completed");
  });

  it("stamps every caps-named page and covers only paths that exist", () => {
    expect(CAPS_PAGES.length).toBeGreaterThanOrEqual(SURVIVING_PAGES.length);
    for (const path of SURVIVING_PAGES) expect(CAPS_PAGES, path).toContain(path);
    for (const path of CAPS_PAGES) {
      const text = page(path);
      const stamp = /\*\*Explored:\*\* \d{4}-\d{2}-\d{2} · \*\*Commit:\*\* `[0-9a-f]{7}` · \*\*Covers:\*\* (.+)/u.exec(text);
      expect(stamp, `${path} stamp`).not.toBeNull();
      const covered = [...stamp![1]!.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
      expect(covered.length, `${path} covers`).toBeGreaterThan(0);
      for (const entry of covered) expect(existsSync(new URL(entry, root)), `${path} covers ${entry}`).toBe(true);
    }
  });

  it("describes no removed command, tool, skill or state file", () => {
    const removed = /archflow_(?:status|apply|review)\b|\bstate\.json\b|workflow\.yaml|hazards\.yaml|\.archflow\/tasks|automation-status|manual-status|archflow-(?:prd|design|phase-design|phase-impl|status|upgrade|simple)\b/u;
    // COMMANDS may state, once, that review still rejects `paths` under that directory.
    const allowedTasksStatement = "nothing under `.git` or `.archflow/tasks` (a path there is rejected as `INPUT_INVALID`)";
    for (const path of SURVIVING_PAGES) expect(page(path).replaceAll(allowedTasksStatement, ""), path).not.toMatch(removed);
    for (const path of ["docs/INTEGRATION.md", "docs/mcp/SERVER.md", "docs/workflow/LIFECYCLE.md", "docs/state/DURABLE-STATE.md", "docs/contracts/AUTOMATION.md", "docs/contracts/CONTRACTS.md"]) {
      expect(existsSync(new URL(path, root)), path).toBe(false);
    }
  });
});
