import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
describe("review report documentation", () => {
  it("describes report interpretation and independent policy authority", () => {
    const review = page("docs/review/COUNTER-REVIEW.md");
    expect(review).toContain("Review V4");
    expect(review).toContain("working AI");
    expect(review).toContain("partial_review_reports");
    expect(review).toContain("previous_review_reports");
    expect(review).toContain("cannot bypass constitution checks");
    expect(review).toContain("Archived Review V1–V3");
    expect(review).toContain("no additional interpretation-model call");
  });
  it("keeps maintained pages stamped without treating a historical commit as a contract", () => {
    for (const path of ["docs/review/COUNTER-REVIEW.md", "docs/workflow/LIFECYCLE.md", "docs/contracts/CONTRACTS.md"]) {
      expect(page(path)).toMatch(/\*\*Explored:\*\* \d{4}-\d{2}-\d{2} · \*\*Commit:\*\* `[0-9a-f]{7}` · \*\*Covers:\*\*/u);
    }
  });
});
