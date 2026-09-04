import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const maintainedPages = [
  "docs/OVERVIEW.md",
  "docs/workflow/SKILLS.md",
  "docs/workflow/LIFECYCLE.md",
  "docs/review/COUNTER-REVIEW.md",
  "docs/mcp/DISPATCH.md",
  "docs/cli/COMMANDS.md",
  "docs/TESTING.md",
  "docs/contracts/CONTRACTS.md",
  "docs/contracts/AUTOMATION.md",
  "docs/mcp/SERVER.md",
  "docs/state/DURABLE-STATE.md",
] as const;
const expectedCommit = (path: typeof maintainedPages[number]): string =>
  path === "docs/TESTING.md" ? "e427a19" : "1d71fee";
const acceptancePath = "docs/validation/review-taxonomy-acceptance.md";

function page(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("review taxonomy documentation", () => {
  it("pins every maintained page to the explored implementation baseline", () => {
    for (const path of maintainedPages) {
      const source = page(path);
      const stamp = source.split("\n")[2];
      expect(stamp, `${path} has its exploration stamp`).toMatch(
        /^\*\*Explored:\*\* 2026-09-03 · \*\*Commit:\*\* `[0-9a-f]{7}` · \*\*Covers:\*\* .+$/u,
      );
      expect(stamp).toContain(`\`${expectedCommit(path)}\``);
    }
  });

  it("documents falsifier-first producer ownership and the editorial cohort split", () => {
    const overview = page("docs/OVERVIEW.md");
    const skills = page("docs/workflow/SKILLS.md");
    expect(overview).toContain("Triage is producer-owned and falsifier-first");
    expect(overview).toContain("accepted: material change");
    expect(overview).toContain("PRD/design only, one hop");
    expect(skills).toContain("Findings are claims, not edit instructions");
    expect(skills).toContain("runs each feasible returned `falsifier`");
    expect(skills).toContain("PRD and task design may use `accepted-editorial`");
    expect(skills).toContain("Phase design and phase implementation cannot use that disposition");
  });

  it("uses active V3 claim and verdict vocabulary while naming native archives", () => {
    const lifecycle = page("docs/workflow/LIFECYCLE.md");
    const review = page("docs/review/COUNTER-REVIEW.md");
    const dispatch = page("docs/mcp/DISPATCH.md");
    const activePages = `${lifecycle}\n${review}\n${dispatch}`;
    expect(activePages).toContain("`defect`, `risk`, `gap`, or `preference`");
    expect(activePages).toContain("`pass`, `advisory`, or `review-raised`");
    expect(activePages).not.toContain("`risk`, `gap`, `complexity`");
    expect(activePages).not.toContain("JSON verdict + findings");
    expect(activePages).not.toContain("A `fail` verdict is a successful");
    expect(review).toContain("Archived Review V1 and V2 evidence");
    expect(dispatch).toContain("Review V1/V2 remains readable");
  });

  it("keeps Automation V2 exception arrays observational and post-selection", () => {
    for (const path of ["docs/cli/COMMANDS.md", "docs/contracts/AUTOMATION.md"]) {
      const source = page(path);
      expect(source).toContain("`validation_overrides`");
      expect(source).toContain("`review_push_throughs`");
      expect(source.toLowerCase()).toContain("after");
      expect(source.toLowerCase()).toMatch(/cannot (?:turn|select|change)|neither array selects/u);
    }
  });

  it("documents the local test signal without claiming a real-host benchmark", () => {
    const testing = page("docs/TESTING.md");
    const acceptance = page(acceptancePath);
    expect(testing).toContain("test/unit/triage-benchmark.test.ts");
    expect(testing).toContain("credential-free, in-process regression signal");
    expect(testing).toContain("test/real-host/review-benchmark.test.ts");
    expect(acceptance).toContain("**Command:** `npm run check:deep`");
    const results = [...acceptance.matchAll(/^\*\*Result:\*\* (PENDING|PASS|FAIL|SKIPPED)(?: .*)?$/gmu)];
    expect(results).toHaveLength(7);
    expect(acceptance).toContain("were **not run**");
    expect(acceptance).toContain("neither changes benchmark thresholds nor claims provider-backed review quality");
  });
});
