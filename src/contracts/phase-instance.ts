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

/** The `primitives.schema.json#/$defs/positiveSafePhaseNumber` authority. */
export const positiveSafePhaseNumberV1Schema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) as unknown as z.ZodType<PositiveSafePhaseNumber>;

/**
 * The `phase-instance.schema.json` document root: the decoded object form of a phase instance.
 * Runtime code constructs and decodes these through the functions below; the schema exists so the
 * published document is generated from the same vocabulary.
 */
export const phaseInstanceV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prd") }).strict(),
  z.object({ kind: z.literal("design") }).strict(),
  z.object({ kind: z.literal("phase-design"), phase: positiveSafePhaseNumberV1Schema }).strict(),
  z.object({ kind: z.literal("phase-impl"), phase: positiveSafePhaseNumberV1Schema }).strict(),
]) as unknown as z.ZodType<PhaseInstance>;

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
 * The canonical fixed-workflow successor for one phase instance. The final representable
 * implementation phase has no successor: incrementing it would leave the positive-safe-integer
 * contract, so callers must handle `undefined` rather than manufacturing an invalid phase ID.
 */
export function nextPhaseInstance(instance: PhaseInstanceId): PhaseInstanceId | undefined {
  const decoded = decodePhaseInstance(instance);
  switch (decoded.kind) {
    case "prd":
      return encodePhaseInstance({ kind: "design" });
    case "design":
      return encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(1) });
    case "phase-design":
      return encodePhaseInstance({ kind: "phase-impl", phase: decoded.phase });
    case "phase-impl":
      return decoded.phase === Number.MAX_SAFE_INTEGER
        ? undefined
        : encodePhaseInstance({
            kind: "phase-design",
            phase: parsePositiveSafePhaseNumber(decoded.phase + 1),
          });
  }
}

/** Whether an instance is a planning stage that may be selected as a restart target. */
export function isPlanningPhaseInstance(instance: PhaseInstanceId): boolean {
  return decodePhaseInstance(instance).kind !== "phase-impl";
}

/** A restart target must be a planning stage strictly earlier than current durable work. */
export function isEarlierPlanningPhase(
  target: PhaseInstanceId,
  current: PhaseInstanceId,
): boolean {
  return isPlanningPhaseInstance(target) && comparePhaseInstances(target, current) < 0;
}

/**
 * Compares phase instances in the canonical workflow order:
 * `prd < design < phase-design-1 < phase-impl-1 < phase-design-2 < ...`.
 */
export function comparePhaseInstances(left: PhaseInstanceId, right: PhaseInstanceId): number {
  const a = decodePhaseInstance(left);
  const b = decodePhaseInstance(right);
  if (a.kind === "prd") return b.kind === "prd" ? 0 : -1;
  if (b.kind === "prd") return 1;
  if (a.kind === "design") return b.kind === "design" ? 0 : -1;
  if (b.kind === "design") return 1;
  if (a.phase !== b.phase) return a.phase - b.phase;
  if (a.kind === b.kind) return 0;
  return a.kind === "phase-design" ? -1 : 1;
}

/** True only when `target` is an earlier planning boundary, never an implementation phase. */
export function isStrictlyEarlierPlanningPhase(
  target: PhaseInstanceId,
  current: PhaseInstanceId,
): boolean {
  return decodePhaseInstance(target).kind !== "phase-impl" && comparePhaseInstances(target, current) < 0;
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
  if (typeof value === "string") {
    try {
      decodePhaseInstance(value);
      return value as PhaseInstanceId;
    } catch {
      // drop through to strict Zod validation
    }
  }
  assertPlainJson(value, "phase instance id");
  return phaseInstanceIdV1Schema.parse(value);
}

