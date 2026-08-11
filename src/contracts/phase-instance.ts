import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";

declare const positiveSafePhaseBrand: unique symbol;
declare const phaseInstanceIdBrand: unique symbol;

export type PositiveSafePhaseNumber = number & { readonly [positiveSafePhaseBrand]: true };
export type PhaseInstanceId = string & { readonly [phaseInstanceIdBrand]: true };

export type PhaseInstance =
  | { readonly kind: "prd" }
  | { readonly kind: "design" }
  | { readonly kind: "phase-design"; readonly phase: PositiveSafePhaseNumber }
  | { readonly kind: "phase-impl"; readonly phase: PositiveSafePhaseNumber };

export function parsePositiveSafePhaseNumber(value: unknown): PositiveSafePhaseNumber {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("phase number must be a positive safe integer");
  }
  return value as PositiveSafePhaseNumber;
}

export function encodePhaseInstance(value: PhaseInstance): PhaseInstanceId {
  switch (value.kind) {
    case "prd":
    case "design":
      return value.kind as PhaseInstanceId;
    case "phase-design":
    case "phase-impl": {
      const phase = parsePositiveSafePhaseNumber(value.phase);
      return `${value.kind}-${phase}` as PhaseInstanceId;
    }
  }
}

const ITERATED_PHASE = /^(phase-design|phase-impl)-([1-9][0-9]*)$/u;

export function decodePhaseInstance(value: unknown): PhaseInstance {
  if (value === "prd" || value === "design") return { kind: value };
  if (typeof value !== "string") throw new TypeError("phase instance must be a canonical string");
  const match = ITERATED_PHASE.exec(value);
  if (match === null) throw new TypeError("phase instance must use a canonical phase encoding");
  const phase = parsePositiveSafePhaseNumber(Number(match[2]));
  return match[1] === "phase-design" ? { kind: "phase-design", phase } : { kind: "phase-impl", phase };
}

/**
 * The shared authority for the phase-instance *string*. The `.regex()` carries
 * `primitives.schema.json#/$defs/phaseInstanceId` verbatim, so a generated schema emits the same
 * `pattern`. The refine delegates to `decodePhaseInstance` rather than copying `ITERATED_PHASE`
 * and stays strictly stronger than the pattern, which alone admits phase numbers above
 * `Number.MAX_SAFE_INTEGER` that this schema rejects.
 */
export const phaseInstanceIdV1Schema = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u).refine((value) => {
  try {
    decodePhaseInstance(value);
    return true;
  } catch {
    return false;
  }
}) as unknown as z.ZodType<PhaseInstanceId>;

/** Throws, per the contract-layer convention. */
export function parsePhaseInstanceId(value: unknown): PhaseInstanceId {
  assertPlainJson(value, "phase instance id");
  return phaseInstanceIdV1Schema.parse(value);
}
