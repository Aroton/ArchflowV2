import { isDeepStrictEqual } from "node:util";

export class ContractValidationError extends TypeError {
  public constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export function hasUniqueObjectPropertyValues(properties: string | readonly string[], data: unknown[]): boolean {
  const propertyNames = typeof properties === "string" ? [properties] : properties;
  const seen: unknown[][] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const values: unknown[] = [];
    for (const property of propertyNames) {
      const descriptor = Object.getOwnPropertyDescriptor(item, property);
      if (descriptor === undefined) {
        values.push(undefined);
        continue;
      }
      if (!descriptor.enumerable || !("value" in descriptor)) return false;
      values.push(descriptor.value);
    }
    if (seen.some((candidate) => isDeepStrictEqual(candidate, values))) return false;
    seen.push(values);
  }
  return true;
}

/**
 * The module's one ordering predicate. Every set rule — every Zod `.refine()` that enforces
 * ordering in the runtime authority — calls this, so "the same function" is literally true and the
 * rules cannot drift between shapes. Strict increase implies uniqueness, so a sorted-unique rule
 * subsumes a bare uniqueness rule for the shapes that use it. The default `key` is `String`, which
 * means an array of objects compares `"[object Object]" < "[object Object]"` and is rejected at
 * length >= 2; callers that need object ordering supply `tupleKey`.
 */
export function isSortedUniqueBy(items: unknown, key: (value: unknown) => string = String): boolean {
  if (!Array.isArray(items)) return false;
  if (items.length <= 1) return true;
  let prevKey = key(items[0]);
  for (let i = 1; i < items.length; i++) {
    const currentKey = key(items[i]);
    if (prevKey >= currentKey) return false;
    prevKey = currentKey;
  }
  return true;
}

/**
 * Builds the ordering key for a multi-property set. Each property is read with
 * `Object.getOwnPropertyDescriptor` plus `"value" in descriptor` — the shipped form at
 * `hasUniqueObjectPropertyValues` above — so an accessor property yields `undefined` instead of
 * invoking a getter, which a naive `item[property]` would do.
 *
 * Components are `String()`-coerced and joined with `U+0000`. That join is injective here: every ID
 * primitive and `path-claim.schema.json` reject the whole `U+0000`-`U+001F` range, and because
 * `U+0000` sorts below every admitted character the joined comparison is exactly componentwise
 * ordinal comparison. A `":"`-joined key is deliberately not used — `SafeId` admits `":"`, so that
 * key can collide across a component boundary.
 */
const tupleKeyCache = new Map<string, (value: unknown) => string>();

export function tupleKey(properties: string | readonly string[]): (value: unknown) => string {
  const cacheKey = typeof properties === "string" ? properties : properties.join("\u0000");
  const cached = tupleKeyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const propertyNames = typeof properties === "string" ? [properties] : [...properties];
  let fn: (value: unknown) => string;
  if (propertyNames.length === 1) {
    const prop = propertyNames[0]!;
    fn = (value: unknown): string => {
      if (typeof value !== "object" || value === null) return String(value);
      const descriptor = Object.getOwnPropertyDescriptor(value, prop);
      return String(descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined);
    };
  } else {
    fn = (value: unknown): string => {
      if (typeof value !== "object" || value === null) return String(value);
      return propertyNames.map((property) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        return String(descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined);
      }).join("\u0000");
    };
  }
  tupleKeyCache.set(cacheKey, fn);
  return fn;
}

