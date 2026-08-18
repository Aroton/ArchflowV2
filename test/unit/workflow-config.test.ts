import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { parseConfigV1, parseConfigYaml } from "../../src/contracts/config.js";
import { PlainJsonError } from "../../src/contracts/plain-json.js";
import { parseWorkflowV1, parseWorkflowYaml, WORKFLOW_V1 } from "../../src/contracts/workflow.js";

const fixture = (path: string) => readFile(new URL(`../fixtures/foundation/${path}`, import.meta.url), "utf8");

function expectPreflightedBoundary(
  parser: (value: unknown) => unknown,
  valid: Record<string, unknown>,
  accessorKey: string
): void {
  expect(() => parser(Object.create(valid))).toThrow(PlainJsonError);

  let getterCalls = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, accessorKey, {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return valid[accessorKey];
    }
  });
  expect(() => parser(accessor)).toThrow(PlainJsonError);
  expect(getterCalls).toBe(0);

  const dangerous = structuredClone(valid);
  Object.defineProperty(dangerous, "constructor", { enumerable: true, value: "forbidden" });
  expect(() => parser(dangerous)).toThrow(PlainJsonError);
  expect(() => parser({ ...structuredClone(valid), unsupported: 1n })).toThrow(PlainJsonError);
}

describe("fixed workflow", () => {
  it("accepts the shipped graph and keeps Explore graph-only", async () => {
    const workflow = parseWorkflowYaml(await readFile(new URL("../../assets/workflow.yaml", import.meta.url), "utf8"));
    expect(workflow.phases.map(({ id }) => id)).toEqual(["explore", "prd", "design", "phase-design", "phase-impl"]);
    expect(workflow.phases[0]).toMatchObject({ pipeline: ["produce"], gate: "never", optional: true });
  });

  it("rejects graph mutations", async () => {
    const source = await fixture("workflow/invalid-mutated-gate.yaml");
    expect(() => parseWorkflowYaml(source)).toThrow(/fixed ArchFlow v1 graph/);
  });

  it("plain-JSON preflights the direct unknown boundary without invoking getters", () => {
    expectPreflightedBoundary(parseWorkflowV1, structuredClone(WORKFLOW_V1) as unknown as Record<string, unknown>, "phases");
  });
});

describe("model routing configuration", () => {
  it("accepts only role and phase model/effort selection", async () => {
    const config = parseConfigYaml(await fixture("config/valid.yaml"));
    expect(config.overrides?.design?.["counter-reviewer"]?.effort).toBe("xhigh");
  });

  it("accepts the retired producer role on read and rejects unknown roles still", () => {
    // Configs pinned before the producer role was removed round-trip unchanged; the key is
    // accepted and ignored because the producer is the connected host, never a config role.
    const retired = parseConfigYaml('schema_version: "1"\nroles:\n  producer:\n    model: gpt-example\n    effort: high\n  counter-reviewer:\n    model: claude-example\n    effort: high\n');
    expect(retired.roles.producer).toMatchObject({ model: "gpt-example", effort: "high" });
    expect(() => parseConfigYaml(JSON.stringify({
      schema_version: "1", roles: { prodcer: { model: "example", effort: "high" } },
    }))).toThrow();
  });

  it("rejects repository and model-family authority", async () => {
    const source = await fixture("config/invalid-authority.yaml");
    expect(() => parseConfigYaml(source)).toThrow();
  });

  it("rejects task, host, unknown role, and unknown phase keys", () => {
    const route = { model: "example", effort: "high" };
    for (const invalid of [
      { schema_version: "1", task: "other", roles: {} },
      { schema_version: "1", host: "codex", roles: {} },
      { schema_version: "1", roles: { reviewer: route } },
      { schema_version: "1", roles: {}, overrides: { release: { "counter-reviewer": route } } },
    ]) expect(() => parseConfigYaml(JSON.stringify(invalid))).toThrow();
  });

  it("plain-JSON preflights the direct unknown boundary without invoking getters", () => {
    expectPreflightedBoundary(parseConfigV1, { schema_version: "1", roles: {} }, "schema_version");
  });
});
