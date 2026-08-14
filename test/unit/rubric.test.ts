import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { PlainJsonError } from "../../src/contracts/plain-json.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/foundation/rubric/${name}`, import.meta.url), "utf8")) as unknown;

describe("RubricV1", () => {
  it("accepts stable structured criteria", async () => {
    expect(parseRubricV1(await fixture("valid.json")).criteria).toHaveLength(2);
  });

  it("rejects invalid modes, unknown fields, and duplicate IDs", async () => {
    const invalidMode = await fixture("invalid-mode.json");
    expect(() => parseRubricV1(invalidMode)).toThrow();
    expect(() => parseRubricV1({ schema_version: "1", kind: "artifact", mode: "self_review", criteria: [{ id: "a", text: "A", blocking: true }], verdict: "pass" })).toThrow();
    expect(() => parseRubricV1({ schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "same", text: "A", blocking: true }, { id: "same", text: "B", blocking: false }] })).toThrow(/Duplicate criterion id/);
  });

  it("plain-JSON preflights the direct unknown boundary without invoking getters", async () => {
    const valid = await fixture("valid.json") as Record<string, unknown>;
    expect(() => parseRubricV1(Object.create(valid))).toThrow(PlainJsonError);

    let getterCalls = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, "criteria", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return valid.criteria;
      }
    });
    expect(() => parseRubricV1(accessor)).toThrow(PlainJsonError);
    expect(getterCalls).toBe(0);

    const dangerous = structuredClone(valid);
    Object.defineProperty(dangerous, "__proto__", { enumerable: true, value: "forbidden" });
    expect(() => parseRubricV1(dangerous)).toThrow(PlainJsonError);
    expect(() => parseRubricV1({ ...structuredClone(valid), unsupported: Number.NaN })).toThrow(PlainJsonError);
  });
});
