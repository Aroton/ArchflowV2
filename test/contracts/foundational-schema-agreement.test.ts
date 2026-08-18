import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { configV1Schema } from "../../src/contracts/config.js";
import { constitutionRuleV1Schema } from "../../src/contracts/constitution.js";
import { rubricV1Schema } from "../../src/contracts/rubric.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../helpers/json-schema.js";
import { workflowV1Schema } from "../../src/contracts/workflow.js";

const schema = async (name: string) => JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

describe("normative foundational JSON Schemas agree with Zod mirrors", () => {
  it("compiles phase-instance references and enforces the canonical object contract", async () => {
    const validator = createJsonSchemaValidator(
      await schema("phase-instance"),
      [await schema("primitives")]
    );
    const valid = [
      { kind: "prd" },
      { kind: "design" },
      { kind: "phase-design", phase: 1 },
      { kind: "phase-impl", phase: Number.MAX_SAFE_INTEGER },
    ];
    for (const value of valid) expect(validator.assert(value)).toBe(value);
    for (const invalid of [
      { kind: "explore" },
      { kind: "phase-design", phase: 0 },
      { kind: "phase-impl", phase: Number.MAX_SAFE_INTEGER + 1 },
      { kind: "phase-impl", phase: 1, extra: true },
    ]) expect(() => validator.assert(invalid)).toThrow();
  });

  it("agrees for workflow valid and mutated cases", async () => {
    const validator = createJsonSchemaValidator(await schema("workflow"));
    const valid = JSON.parse(JSON.stringify((await import("../../src/contracts/workflow.js")).WORKFLOW_V1)) as unknown;
    expect(assertZodAgreement(valid, validator, workflowV1Schema)).toEqual(valid);
    const invalid = structuredClone(valid) as { phases: Array<{ gate: string }> };
    invalid.phases[1]!.gate = "on_trigger";
    expect(() => assertZodAgreement(invalid, validator, workflowV1Schema)).toThrow(/schema validation failed|must be equal/);
  });

  it("agrees for routing boundaries", async () => {
    const validator = createJsonSchemaValidator(await schema("config"));
    const valid = { schema_version: "1", roles: { "counter-reviewer": { model: "example", effort: "high" } }, overrides: { design: { adjudicator: { model: "other", effort: "xhigh" } } } };
    expect(assertZodAgreement(valid, validator, configV1Schema)).toEqual(valid);
    expect(assertZodAgreement({ ...valid, max_attempts: 5 }, validator, configV1Schema)).toEqual({ ...valid, max_attempts: 5 });
    // The retired producer role is accepted on read; only its shape stays enforced.
    const retired = { ...valid, roles: { ...valid.roles, producer: { model: "example", effort: "high" } } };
    expect(assertZodAgreement(retired, validator, configV1Schema)).toEqual(retired);
    for (const invalid of [
      { ...valid, repository: "/tmp/repo" },
      { ...valid, roles: { producer: { model: "x", effort: "high", family: "codex" } } },
      { ...valid, roles: { producer: { model: "   ", effort: "high" } } },
      { ...valid, roles: { prodcer: { model: "x", effort: "high" } } },
      { ...valid, overrides: { unknown: {} } },
      { ...valid, max_attempts: 0 },
      { ...valid, max_attempts: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(() => assertZodAgreement(invalid, validator, configV1Schema)).toThrow(/schema validation failed|additional properties/);
  });

  it("agrees for rubric and constitution rule shapes", async () => {
    const rubricValidator = createJsonSchemaValidator(await schema("rubric"));
    const rubric = { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "correctness", text: "Behavior matches the approved design.", blocking: true }] };
    expect(assertZodAgreement(rubric, rubricValidator, rubricV1Schema)).toEqual(rubric);
    expect(() => assertZodAgreement({ ...rubric, mode: "friendly" }, rubricValidator, rubricV1Schema)).toThrow();
    expect(() => assertZodAgreement({ ...rubric, criteria: [{ id: "correctness", text: "   ", blocking: true }] }, rubricValidator, rubricV1Schema)).toThrow();
    // x-archflow-unique-by retired from the generated rubric document; criterion-id uniqueness
    // now lives in the rubric schema's superRefine, so Ajv accepts what Zod still rejects.
    const duplicateIdWithDifferentBodies = {
      ...rubric,
      criteria: [
        { id: "correctness", text: "First formulation.", blocking: true },
        { id: "correctness", text: "Different formulation.", blocking: false }
      ]
    };
    const duplicateBefore = structuredClone(duplicateIdWithDifferentBodies);
    expect(rubricValidator.validate(duplicateIdWithDifferentBodies)).toBe(true);
    expect(rubricV1Schema.safeParse(duplicateIdWithDifferentBodies).success).toBe(false);
    expect(duplicateIdWithDifferentBodies).toEqual(duplicateBefore);

    const constitutionValidator = createJsonSchemaValidator(await schema("constitution-rule"));
    const rule = { id: "stable-rule", version: 1, status: "active", text: "Preserve this invariant." };
    expect(assertZodAgreement(rule, constitutionValidator, constitutionRuleV1Schema)).toEqual(rule);
    expect(() => assertZodAgreement({ ...rule, version: 0 }, constitutionValidator, constitutionRuleV1Schema)).toThrow();
  });
});
