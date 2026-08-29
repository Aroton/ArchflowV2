export type PlainJsonPrimitive = string | number | boolean | null;
export type PlainJsonValue = PlainJsonPrimitive | readonly PlainJsonValue[] | PlainJsonObject;
export interface PlainJsonObject {
  readonly [key: string]: PlainJsonValue;
}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class PlainJsonError extends TypeError {
  public constructor(message: string, public readonly path: string) {
    super(`${message} at ${path}`);
    this.name = "PlainJsonError";
  }
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function fail(message: string, path: string): never {
  throw new PlainJsonError(message, path);
}

function assertDescriptorStable(
  object: object,
  key: PropertyKey,
  before: PropertyDescriptor,
  path: string
): void {
  const after = Object.getOwnPropertyDescriptor(object, key);
  if (
    after === undefined ||
    after.configurable !== before.configurable ||
    after.enumerable !== before.enumerable ||
    after.writable !== before.writable ||
    after.value !== before.value ||
    after.get !== before.get ||
    after.set !== before.set
  ) {
    fail("value mutated while it was being inspected", path);
  }
}

function inspect(value: unknown, path: string, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite numbers are not JSON values", path);
    return;
  }
  if (typeof value !== "object") fail(`unsupported ${typeof value} value`, path);

  const object = value as object;
  if (ancestors.has(object)) fail("cyclic references are not JSON values", path);

  const isArray = Array.isArray(object);
  const prototype = Object.getPrototypeOf(object);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    fail("objects must have a plain prototype", path);
  }

  const keys = Reflect.ownKeys(object);
  if (keys.some((key) => typeof key === "symbol")) fail("symbol keys are not JSON object keys", path);

  ancestors.add(object);
  try {
    if (isArray) {
      const array = object as unknown[];
      const len = array.length;
      for (const key of keys) {
        if (typeof key !== "string") fail("arrays may only contain indexed elements", path);
        if (key === "length") continue;
        const num = Number(key);
        if (!/^(?:0|[1-9]\d*)$/u.test(key) || num >= len) {
          fail("arrays may only contain indexed elements", path);
        }
      }
      for (let index = 0; index < len; index += 1) {
        const indexStr = String(index);
        if (!Object.prototype.hasOwnProperty.call(array, index)) fail("sparse array holes are not JSON values", `${path}[${index}]`);
        const descriptor = Object.getOwnPropertyDescriptor(array, indexStr);
        if (descriptor === undefined || !("value" in descriptor)) fail("accessor properties are not JSON values", `${path}[${indexStr}]`);
        inspect(descriptor.value, `${path}[${indexStr}]`, ancestors);
        assertDescriptorStable(array, indexStr, descriptor, `${path}[${indexStr}]`);
      }
    } else {
      for (const key of keys as string[]) {
        const propertyPath = childPath(path, key);
        if (DANGEROUS_KEYS.has(key)) fail(`dangerous own key ${JSON.stringify(key)} is forbidden`, propertyPath);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor === undefined || !("value" in descriptor)) fail("accessor properties are not JSON values", propertyPath);
        if (!descriptor.enumerable) fail("non-enumerable properties are not JSON values", propertyPath);
        inspect(descriptor.value, propertyPath, ancestors);
        assertDescriptorStable(object, key, descriptor, propertyPath);
      }
    }
    const afterKeys = Reflect.ownKeys(object);
    if (keys.length !== afterKeys.length || keys.some((key, index) => key !== afterKeys[index])) {
      fail("value mutated while it was being inspected", path);
    }
  } finally {
    ancestors.delete(object);
  }
}

export function assertPlainJson(value: unknown, label = "value"): asserts value is PlainJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite numbers are not JSON values", label);
    return;
  }
  inspect(value, label, new WeakSet());
}

export function isPlainJsonValue(value: unknown): value is PlainJsonValue {
  try {
    assertPlainJson(value);
    return true;
  } catch {
    return false;
  }
}

export function parsePlainJson(value: unknown, label = "value"): PlainJsonValue {
  assertPlainJson(value, label);
  return value;
}
