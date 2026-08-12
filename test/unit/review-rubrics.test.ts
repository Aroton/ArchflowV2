import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { canonicalRubricForPhaseKind } from "../../src/review/rubrics.js";

describe("canonical counter-review rubrics", () => {
  it("selects one immutable versioned rubric per workflow artifact family", () => {
    const prd = canonicalRubricForPhaseKind("prd");
    const design = canonicalRubricForPhaseKind("design");
    const phaseDesign = canonicalRubricForPhaseKind("phase-design");
    const implementation = canonicalRubricForPhaseKind("phase-impl");

    expect(prd.rubric_id).toBe("prd-v1");
    expect(design.rubric_id).toBe("design-v1");
    expect(phaseDesign).toBe(design);
    expect(implementation.rubric_id).toBe("implementation-v1");
    expect(prd.rubric.kind).toBe("artifact");
    expect(design.rubric.kind).toBe("artifact");
    expect(implementation.rubric.kind).toBe("implementation");

    for (const selected of [prd, design, implementation]) {
      expect(selected.rubric_digest).toBe(canonicalJsonDigest(selected.rubric as never));
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.rubric)).toBe(true);
      expect(Object.isFrozen(selected.rubric.criteria)).toBe(true);
      expect(selected.rubric.criteria.every(Object.isFrozen)).toBe(true);
    }
  });
});
