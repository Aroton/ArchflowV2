import { describe, expect, it } from "vitest";

import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { derivedFinalPhaseBelowCurrentPhase, plannedFinalPhaseFromRecordedPayloads } from "../../src/state/planned-final-phase.js";

const TASK = parseTaskSlug("planned-phase-task");
const encoder = new TextEncoder();
const designPath = `.archflow/tasks/${TASK}/design.md`;
const fourPhaseDesign = encoder.encode(
  "# Task design\n\n### Phase 1: First\n\n### Phase 2: Second\n\n### Phase 3: Third\n\n### Phase 4: Fourth\n",
);
const openEndedDesign = encoder.encode(
  "# Task design\n\n<!-- archflow:phase-plan:open-ended -->\n",
);

describe("plannedFinalPhaseFromRecordedPayloads", () => {
  it("re-derives the bound from a recorded design document", () => {
    expect(plannedFinalPhaseFromRecordedPayloads(TASK, [
      { path: `.archflow/tasks/${TASK}/prd.md`, bytes: encoder.encode("# PRD\n") },
      { path: designPath, bytes: fourPhaseDesign },
    ], 10)).toBe(4);
  });

  it("clears the bound when the recorded design is open-ended", () => {
    expect(plannedFinalPhaseFromRecordedPayloads(TASK, [
      { path: designPath, bytes: openEndedDesign },
    ], 4)).toBeNull();
  });

  it("leaves the stored bound untouched when no design document was recorded", () => {
    expect(plannedFinalPhaseFromRecordedPayloads(TASK, [
      { path: `.archflow/tasks/${TASK}/phases/2/design.md`, bytes: fourPhaseDesign },
    ], 4)).toBeUndefined();
  });

  it("rejects a nonconforming recorded design while a stored bound exists to go stale", () => {
    const nonconforming = encoder.encode("## Phase 1: wrong heading level\n### Phase 2: Second\n");
    expect(() => plannedFinalPhaseFromRecordedPayloads(TASK, [
      { path: designPath, bytes: nonconforming },
    ], 4)).toThrow(TypeError);
    expect(() => plannedFinalPhaseFromRecordedPayloads(TASK, [
      { path: designPath, bytes: nonconforming },
    ], null)).toThrow(TypeError);
  });

  it("preserves an absent bound when a nonconforming design has no stored bound to protect", () => {
    // Legacy imports record designs without the ArchFlow phase-plan grammar; their approval
    // path never derives the bound, so the produce must not reject the bytes.
    const nonconforming = encoder.encode("# Legacy architecture\n\nPhase 1 landed.\n");
    expect(plannedFinalPhaseFromRecordedPayloads(TASK, [
      { path: designPath, bytes: nonconforming },
    ], undefined)).toBeUndefined();
  });
});

describe("derivedFinalPhaseBelowCurrentPhase", () => {
  const threePhaseDesign = encoder.encode(
    "# Task design\n\n### Phase 1: First\n\n### Phase 2: Second\n\n### Phase 3: Third\n",
  );

  it("flags a derived bound below the producing numbered phase", () => {
    // A produce at phase 4 that records a three-phase design can never satisfy completion's
    // equality test; the handler must refuse it closed instead of wedging the workflow.
    const derived = plannedFinalPhaseFromRecordedPayloads(TASK, [
      { path: designPath, bytes: threePhaseDesign },
    ], 4);
    expect(derived).toBe(3);
    expect(derivedFinalPhaseBelowCurrentPhase(3, encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(4) }))).toBe(true);
  });

  it("accepts a derived bound at or above the producing phase", () => {
    expect(derivedFinalPhaseBelowCurrentPhase(4, encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(4) }))).toBe(false);
    expect(derivedFinalPhaseBelowCurrentPhase(10, encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(4) }))).toBe(false);
  });

  it("accepts any conforming bound at unnumbered positions", () => {
    // PRD and design positions carry no phase number, so a shrunken plan there is handled by
    // design-approval, not by the produce-time refusal.
    expect(derivedFinalPhaseBelowCurrentPhase(1, encodePhaseInstance({ kind: "design" }))).toBe(false);
    expect(derivedFinalPhaseBelowCurrentPhase(1, encodePhaseInstance({ kind: "prd" }))).toBe(false);
  });
});
