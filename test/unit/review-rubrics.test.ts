import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { ProjectResult } from "../../src/contracts/errors.js";
import { loadCanonicalRubricForSimpleStage, loadRubricFile, reviewAssignment, type CanonicalRubric, type CanonicalRubricId } from "../../src/review/rubrics.js";
import { loadTestRubric } from "../helpers/rubrics.js";

// Digests pinned to the reviewed rubric policy in assets/rubrics/. Regenerate
// deliberately, never casually: a changed digest is changed review policy for every
// installed bundle.
const PINNED_RUBRIC_DIGESTS = Object.freeze({
  "simple-plan-v1": "0b2ec7c28cf7e32fb6c06ab16b86b5d887f35fb0da70120243cc0bc62447ff1b",
  "implementation-v1": "32cee8a8cf22ea05a7916d4ca55c6cd79a1aab11e8ef423b71a3e39bd9cfee33",
} satisfies Record<CanonicalRubricId, string>);

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const MINIMAL_RUBRIC = `rubric_id: simple-plan-v1
schema_version: "1"
kind: artifact
mode: adversarial
criteria:
  - id: substantive-correctness
    text: "Report a material defect only."
    blocking: true
`;

async function loadFromTmp(
  bytes: string,
  file = "rubrics/simple-plan.yaml",
  expected_id: CanonicalRubricId = "simple-plan-v1",
): Promise<ProjectResult<CanonicalRubric>> {
  const root = await mkdtemp(join(tmpdir(), "archflow-rubrics-"));
  roots.push(root);
  await mkdir(join(root, "rubrics"), { recursive: true });
  await writeFile(join(root, file), bytes);
  return loadRubricFile({ root, file, expected_id });
}

function expectRubricFailure(result: ProjectResult<CanonicalRubric>): {
  issue_code: string;
  issues?: readonly string[];
} {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the rubric load to fail");
  expect(result.error.code).toBe("CONFIG_INVALID");
  return result.error.diagnostic.parameters as { issue_code: string; issues?: readonly string[] };
}

describe("canonical counter-review rubrics", () => {
  it("loads a distinct immutable versioned rubric for each review stage", async () => {
    const plan = await loadTestRubric("phase-design");
    const implementation = await loadTestRubric("phase-impl");

    expect(plan.rubric_id).toBe("simple-plan-v1");
    expect(plan.rubric_digest).not.toBe(implementation.rubric_digest);
    expect(implementation.rubric_id).toBe("implementation-v1");
    expect(plan.rubric.kind).toBe("artifact");
    expect(implementation.rubric.kind).toBe("implementation");

    for (const selected of [plan, implementation]) {
      expect(selected.rubric_digest).toBe(canonicalJsonDigest(selected.rubric as never));
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.rubric)).toBe(true);
      expect(Object.isFrozen(selected.rubric.criteria)).toBe(true);
      expect(selected.rubric.criteria.every(Object.isFrozen)).toBe(true);
    }
  });

  it("reproduces the pinned consequential-review policy digests", async () => {
    expect((await loadTestRubric("phase-design")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["simple-plan-v1"]);
    expect((await loadTestRubric("phase-impl")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["implementation-v1"]);
  });

  it("selects the standalone plan rubric and the implementation rubric by stage", async () => {
    const plan = await loadCanonicalRubricForSimpleStage("plan");
    const implementation = await loadCanonicalRubricForSimpleStage("implementation");
    if (!plan.ok) throw plan.error;
    if (!implementation.ok) throw implementation.error;
    expect(plan.value.rubric_id).toBe("simple-plan-v1");
    expect(plan.value.rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["simple-plan-v1"]);
    expect(implementation.value).toEqual(await loadTestRubric("phase-impl"));

    const general = reviewAssignment("general", "general", "phase-design", plan.value.rubric);
    const tests = reviewAssignment("tests", "tests", "phase-design", plan.value.rubric);
    expect(tests.criterion_ids).toEqual(["test-strategy"]);
    expect(general.criterion_ids).not.toContain("test-strategy");
    expect(general.criterion_ids).toContain("decision-readiness");
    expect(general.criterion_ids).not.toContain("predecessor-guarantees");
    expect(new Set([...general.criterion_ids, ...tests.criterion_ids])).toEqual(
      new Set(plan.value.rubric.criteria.map((criterion) => criterion.id)),
    );
  });

  it("pins the shape of the quality, shortcut, and confidence criteria", async () => {
    const implementation = await loadTestRubric("phase-impl");
    const byId = new Map(implementation.rubric.criteria.map((criterion) => [criterion.id, criterion]));
    expect(byId.get("test-quality")?.blocking).toBe(true);
    expect(byId.get("anti-shortcut")?.blocking).toBe(true);
    for (const rubric of [await loadTestRubric("phase-design"), implementation]) {
      const last = rubric.rubric.criteria[rubric.rubric.criteria.length - 1];
      expect(last?.id).toBe("advisory-observations");
      const confidence = rubric.rubric.criteria.find((criterion) => criterion.id === "reviewer-confidence");
      expect(confidence?.blocking).toBe(false);
    }
  });

  it("keeps legacy finding vocabulary out of criterion prose while retaining parser policy keys", async () => {
    for (const selected of [await loadTestRubric("phase-design"), await loadTestRubric("phase-impl")]) {
      expect(selected.rubric.criteria.every((criterion) => typeof criterion.blocking === "boolean")).toBe(true);
      const prose = selected.rubric.criteria.map((criterion) => criterion.text).join("\n");
      expect(prose).not.toMatch(/\b(?:severity|critical|major|minor|blocker|blocking)\b/iu);
    }
  });

  it("keeps remediation policy in the fixed instruction and implementation findings on declared outputs", async () => {
    for (const rubric of [await loadTestRubric("phase-design"), await loadTestRubric("phase-impl")]) {
      const text = rubric.rubric.criteria.map((criterion) => criterion.text).join("\n");
      expect(text).not.toMatch(/prior-triage|challenge a prior disposition|accepted revision intent/iu);
    }
    const implementation = await loadTestRubric("phase-impl");
    const substantive = implementation.rubric.criteria.find((criterion) => criterion.id === "substantive-correctness")?.text ?? "";
    expect(substantive).toContain("declared implementation outputs");
    expect(substantive).toContain("introduced, exposed, or materially worsened");
    expect(substantive).toContain("pre-existing unrelated defects");
  });

  it("partitions test review without duplicating criteria", async () => {
    const plan = await loadTestRubric("phase-design");
    const implementation = await loadTestRubric("phase-impl");
    const planGeneral = reviewAssignment("general", "general", "phase-design", plan.rubric);
    const planTests = reviewAssignment("test", "tests", "phase-design", plan.rubric);
    const implementationGeneral = reviewAssignment("general", "general", "phase-impl", implementation.rubric);
    const implementationTests = reviewAssignment("test", "tests", "phase-impl", implementation.rubric);

    expect(planTests.criterion_ids).toEqual(["test-strategy"]);
    expect(planGeneral.criterion_ids).toContain("decision-readiness");
    expect(planGeneral.criterion_ids).toContain("interface-reality");
    expect(implementationTests.criterion_ids).toEqual(["verification-evidence", "test-quality"]);
    for (const [rubric, general, tests] of [
      [plan.rubric, planGeneral, planTests],
      [implementation.rubric, implementationGeneral, implementationTests],
    ] as const) {
      expect(new Set([...general.criterion_ids, ...tests.criterion_ids])).toEqual(
        new Set(rubric.criteria.map((criterion) => criterion.id)),
      );
      expect(general.criterion_ids.some((id) => tests.criterion_ids.includes(id))).toBe(false);
    }
  });

  it("refuses an assignment whose focus has no criteria in the rubric", async () => {
    const plan = await loadTestRubric("phase-design");
    const testsOnly = { ...plan.rubric, criteria: plan.rubric.criteria.filter((criterion) => criterion.id === "test-strategy") };
    expect(reviewAssignment("test", "tests", "phase-design", testsOnly).criterion_ids).toEqual(["test-strategy"]);
    expect(() => reviewAssignment("general", "general", "phase-design", testsOnly)).toThrow(/not applicable/iu);
  });

  it("asks the test reviewer for economical distinct coverage, not raw test volume", async () => {
    const plan = await loadTestRubric("phase-design");
    const implementation = await loadTestRubric("phase-impl");
    const policy = [
      plan.rubric.criteria.find((criterion) => criterion.id === "test-strategy")?.text,
      implementation.rubric.criteria.find((criterion) => criterion.id === "test-quality")?.text,
    ].join("\n");
    expect(policy).toMatch(/distinct regression protection/iu);
    expect(policy).toMatch(/duplicate/iu);
    expect(policy).toMatch(/cheap/iu);
    expect(policy).toMatch(/expensive.*fixture/iu);
    expect(policy).toMatch(/raw coverage/iu);
  });

});

describe("rubric files fail closed", () => {
  it("refuses a missing rubric file, naming it", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-rubrics-"));
    roots.push(root);
    const result = await loadRubricFile({ root, file: "rubrics/simple-plan.yaml", expected_id: "simple-plan-v1" });
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-missing");
    expect(parameters.issues?.join("\n")).toContain("rubrics/simple-plan.yaml");
  });

  it("refuses invalid YAML, surfacing the parser message", async () => {
    const result = await loadFromTmp("rubric_id: simple-plan-v1\ncriteria: [unclosed\n");
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-invalid");
  });

  it("refuses a document that is not a YAML mapping", async () => {
    const result = await loadFromTmp("just a bare scalar\n");
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-invalid");
    expect(parameters.issues?.join("\n")).toContain("mapping");
  });

  it("refuses a rubric_id that does not match the selected rubric", async () => {
    const result = await loadFromTmp(MINIMAL_RUBRIC.replace("rubric_id: simple-plan-v1", "rubric_id: implementation-v1"));
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-invalid");
    expect(parameters.issues?.join("\n")).toContain("rubric_id");
  });

  it("rejects duplicate criterion ids", async () => {
    const duplicated = MINIMAL_RUBRIC.replace(
      "    blocking: true\n",
      "    blocking: true\n  - id: substantive-correctness\n    text: \"Another.\"\n    blocking: false\n",
    );
    const result = await loadFromTmp(duplicated);
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-invalid");
    expect(parameters.issues?.join("\n")).toContain("Duplicate criterion id");
  });

  it("rejects blank criterion text", async () => {
    const result = await loadFromTmp(MINIMAL_RUBRIC.replace("Report a material defect only.", "   "));
    expect(expectRubricFailure(result).issue_code).toBe("rubric-file-invalid");
  });

  it("rejects unknown top-level keys", async () => {
    const result = await loadFromTmp(`${MINIMAL_RUBRIC}extra: true\n`);
    expect(expectRubricFailure(result).issue_code).toBe("rubric-file-invalid");
  });

  it("rejects an unquoted schema_version, which YAML would parse as a number", async () => {
    const result = await loadFromTmp(MINIMAL_RUBRIC.replace('schema_version: "1"', "schema_version: 1"));
    expect(expectRubricFailure(result).issue_code).toBe("rubric-file-invalid");
  });
});
