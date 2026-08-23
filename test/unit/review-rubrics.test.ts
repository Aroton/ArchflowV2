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
    expect(design.rubric_id).toBe("design-v2");
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

  it("reviews design phase sizing structurally and only for material consequences", () => {
    const design = canonicalRubricForPhaseKind("design");
    const phaseDesign = canonicalRubricForPhaseKind("phase-design");
    const phasePlan = design.rubric.criteria.find((criterion) =>
      criterion.id === "phase-plan-soundness"
    );

    expect(phaseDesign).toBe(design);
    expect(phasePlan?.blocking).toBe(true);

    const policy = phasePlan?.text ?? "";
    expect(policy).toMatch(/architecture design.*split-and-merge sizing attempt/iu);
    expect(policy).toMatch(/coherent repository-ready outcome/iu);
    expect(policy).toMatch(/valid completion state/iu);
    expect(policy).toMatch(/predecessors or stable inputs/iu);
    expect(policy).toMatch(/meaningful verification story/iu);
    expect(policy).toMatch(/splitting bundled independently implementable or verifiable outcomes/iu);
    expect(policy).toMatch(/merging scaffolding, file-, type-, or layer-only fragments/iu);
    expect(policy).toMatch(/retained unusually broad or small phase/iu);
    expect(policy).toMatch(/atomicity.*repository-validity.*inseparable-verification.*stable-interface.*risk-reduction value/iu);
    expect(policy).toMatch(/genuinely open-ended plan/iu);
    expect(policy).toMatch(/why responsible boundaries cannot yet be named/iu);
    expect(policy).toMatch(/what information will enable decomposition/iu);
    expect(policy).toMatch(/marker merely to avoid the sizing attempt/iu);
    expect(policy).toMatch(/numbered phase design.*bounded fit check/iu);
    expect(policy).toMatch(/preserve a sound approved boundary/iu);
    expect(policy).toMatch(/material split or merge.*writable parent.*returned authority/iu);
    expect(policy).toMatch(/materially harm implementation, verification, review, delivery, or create an important risk/iu);
    expect(policy).toContain(
      "Phase count, layer count, file count, diff size, and reviewer preference are not dispositive"
    );
    expect(policy).toMatch(/concrete consequence/iu);
    expect(policy).not.toMatch(/\d/u);
    expect(policy).not.toMatch(/hand-written files/iu);
    expect(policy).not.toMatch(/(?:file|diff|layer|phase)[ -]?(?:count|size)? (?:limit|threshold|maximum)/iu);
  });
});
