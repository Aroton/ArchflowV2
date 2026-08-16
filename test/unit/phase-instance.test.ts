import { describe, expect, expectTypeOf, it } from "vitest";
import {
  decodePhaseInstance,
  comparePhaseInstances,
  encodePhaseInstance,
  isEarlierPlanningPhase,
  parsePositiveSafePhaseNumber,
  nextPhaseInstance,
  type PhaseInstance,
  type PhaseInstanceId,
  type PositiveSafePhaseNumber
} from "../../src/contracts/index.js";

describe("phase instance codec", () => {
  it("round-trips every canonical shape", () => {
    const phase = parsePositiveSafePhaseNumber(42);
    const values: readonly PhaseInstance[] = [
      { kind: "prd" },
      { kind: "design" },
      { kind: "phase-design", phase },
      { kind: "phase-impl", phase }
    ];
    expect(values.map(encodePhaseInstance)).toEqual(["prd", "design", "phase-design-42", "phase-impl-42"]);
    for (const value of values) expect(decodePhaseInstance(encodePhaseInstance(value))).toEqual(value);
  });

  it.each([1, 2, Number.MAX_SAFE_INTEGER])("accepts positive safe phase number %s", (value) => {
    expect(parsePositiveSafePhaseNumber(value)).toBe(value);
  });

  it("maps every fixed-workflow phase to its canonical successor", () => {
    expect(nextPhaseInstance(encodePhaseInstance({ kind: "prd" }))).toBe("design");
    expect(nextPhaseInstance(encodePhaseInstance({ kind: "design" }))).toBe("phase-design-1");
    expect(nextPhaseInstance(encodePhaseInstance({
      kind: "phase-design", phase: parsePositiveSafePhaseNumber(7)
    }))).toBe("phase-impl-7");
    expect(nextPhaseInstance(encodePhaseInstance({
      kind: "phase-impl", phase: parsePositiveSafePhaseNumber(7)
    }))).toBe("phase-design-8");
  });

  it("orders restart targets across fixed and iterated planning stages", () => {
    const values = ["prd", "design", "phase-design-1", "phase-impl-1", "phase-design-2", "phase-impl-2"]
      .map((value) => value as PhaseInstanceId);
    for (let index = 1; index < values.length; index += 1) {
      expect(comparePhaseInstances(values[index - 1]!, values[index]!)).toBeLessThan(0);
    }
    expect(isEarlierPlanningPhase("prd" as PhaseInstanceId, "phase-design-2" as PhaseInstanceId)).toBe(true);
    expect(isEarlierPlanningPhase("phase-design-2" as PhaseInstanceId, "phase-impl-2" as PhaseInstanceId)).toBe(true);
    expect(isEarlierPlanningPhase("phase-impl-1" as PhaseInstanceId, "phase-design-2" as PhaseInstanceId)).toBe(false);
    expect(isEarlierPlanningPhase("phase-design-2" as PhaseInstanceId, "phase-design-2" as PhaseInstanceId)).toBe(false);
  });

  it("returns no successor instead of overflowing the phase-number contract", () => {
    expect(nextPhaseInstance(encodePhaseInstance({
      kind: "phase-impl", phase: parsePositiveSafePhaseNumber(Number.MAX_SAFE_INTEGER)
    }))).toBeUndefined();
  });

  it("decodes the parent contract's canonical hyphenated examples directly", () => {
    expect(decodePhaseInstance("phase-design-1")).toEqual({
      kind: "phase-design",
      phase: parsePositiveSafePhaseNumber(1)
    });
    expect(decodePhaseInstance(`phase-impl-${Number.MAX_SAFE_INTEGER}`)).toEqual({
      kind: "phase-impl",
      phase: parsePositiveSafePhaseNumber(Number.MAX_SAFE_INTEGER)
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null])(
    "rejects invalid phase number %s",
    (value) => expect(() => parsePositiveSafePhaseNumber(value)).toThrow(/positive safe integer/iu)
  );

  it.each([
    "explore",
    "phase-design",
    "phase-impl",
    "phase-design:1",
    "phase-impl:1",
    "phase-design_1",
    "phase-design:0",
    "phase-design:01",
    "phase-design:+1",
    "phase-design:-1",
    "phase-design:1.0",
    "phase-design:1e0",
    "phase-design:1_0",
    "phase-design:9007199254740992",
    "phase-design:%31",
    "phase-design:١",
    " phase-design:1",
    "phase-design-0",
    "phase-design-01",
    "phase-design-+1",
    "phase-design--1",
    "phase-design-1.0",
    "phase-design-1e0",
    "phase-design-1_0",
    "phase-design-9007199254740992",
    "phase-design-%31",
    "phase-design-١",
    " phase-design-1",
    "phase-impl-1/../../x"
  ])("rejects non-canonical alias %s", (value) => {
    expect(() => decodePhaseInstance(value)).toThrow();
  });

  it("keeps brands opaque at compile time", () => {
    expectTypeOf<PositiveSafePhaseNumber>().toMatchTypeOf<number>();
    expectTypeOf<PhaseInstanceId>().toMatchTypeOf<string>();
    // @ts-expect-error plain numbers cannot mint the phase-number brand
    const invalidPhase: PositiveSafePhaseNumber = 1;
    // @ts-expect-error plain strings cannot mint the phase-instance ID brand
    const invalidId: PhaseInstanceId = "prd";
    expect(invalidPhase).toBe(1);
    expect(invalidId).toBe("prd");
  });
});
