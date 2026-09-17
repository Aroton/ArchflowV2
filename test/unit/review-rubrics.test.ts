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
// installed bundle, and it fails in-flight tasks' input fingerprints closed.
const PINNED_RUBRIC_DIGESTS = Object.freeze({
  "prd-v1": "43dc1ff7850fce99d8c5ac5062be8efc556b08bb28aa898715aaab3bb5a6b4a8",
  "design-v3": "27cb3d9345561641644709cdf327484b70024c272ba4b92676db5dd81a54cc06",
  "phase-design-v1": "28e7e3dc604e3047b5cca3dc4b46c14c66f153346119f3a9fdfdeaed7b4a5880",
  "simple-plan-v1": "0b2ec7c28cf7e32fb6c06ab16b86b5d887f35fb0da70120243cc0bc62447ff1b",
  "implementation-v1": "32cee8a8cf22ea05a7916d4ca55c6cd79a1aab11e8ef423b71a3e39bd9cfee33",
} satisfies Record<CanonicalRubricId, string>);

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const MINIMAL_PRD = `rubric_id: prd-v1
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
  file = "rubrics/prd.yaml",
  expected_id: CanonicalRubricId = "prd-v1",
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
  it("loads a distinct immutable versioned rubric for each workflow artifact stage", async () => {
    const prd = await loadTestRubric("prd");
    const design = await loadTestRubric("design");
    const phaseDesign = await loadTestRubric("phase-design");
    const implementation = await loadTestRubric("phase-impl");

    expect(prd.rubric_id).toBe("prd-v1");
    expect(design.rubric_id).toBe("design-v3");
    expect(phaseDesign.rubric_id).toBe("phase-design-v1");
    expect(phaseDesign.rubric_digest).not.toBe(design.rubric_digest);
    expect(implementation.rubric_id).toBe("implementation-v1");
    expect(prd.rubric.kind).toBe("artifact");
    expect(design.rubric.kind).toBe("artifact");
    expect(implementation.rubric.kind).toBe("implementation");

    for (const selected of [prd, design, phaseDesign, implementation]) {
      expect(selected.rubric_digest).toBe(canonicalJsonDigest(selected.rubric as never));
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.rubric)).toBe(true);
      expect(Object.isFrozen(selected.rubric.criteria)).toBe(true);
      expect(selected.rubric.criteria.every(Object.isFrozen)).toBe(true);
    }
  });

  it("reproduces the pinned consequential-review policy digests", async () => {
    expect((await loadTestRubric("prd")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["prd-v1"]);
    expect((await loadTestRubric("design")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["design-v3"]);
    expect((await loadTestRubric("phase-design")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["phase-design-v1"]);
    expect((await loadTestRubric("phase-impl")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["implementation-v1"]);
  });

  it("selects a dedicated standalone plan rubric and shares implementation policy with workflow review", async () => {
    const plan = await loadCanonicalRubricForSimpleStage("plan");
    const implementation = await loadCanonicalRubricForSimpleStage("implementation");
    if (!plan.ok) throw plan.error;
    if (!implementation.ok) throw implementation.error;
    expect(plan.value.rubric_id).toBe("simple-plan-v1");
    expect(plan.value.rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["simple-plan-v1"]);
    expect(plan.value.rubric_digest).not.toBe((await loadTestRubric("phase-design")).rubric_digest);
    expect(implementation.value).toEqual(await loadTestRubric("phase-impl"));

    const general = reviewAssignment("general", "general", "phase-design", plan.value.rubric, false);
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
    for (const rubric of [await loadTestRubric("prd"), await loadTestRubric("design"), await loadTestRubric("phase-design"), implementation]) {
      const last = rubric.rubric.criteria[rubric.rubric.criteria.length - 1];
      expect(last?.id).toBe("advisory-observations");
      const confidence = rubric.rubric.criteria.find((criterion) => criterion.id === "reviewer-confidence");
      expect(confidence?.blocking).toBe(false);
    }
  });

  it("keeps legacy finding vocabulary out of criterion prose while retaining parser policy keys", async () => {
    for (const selected of [await loadTestRubric("prd"), await loadTestRubric("design"), await loadTestRubric("phase-design"), await loadTestRubric("phase-impl")]) {
      expect(selected.rubric.criteria.every((criterion) => typeof criterion.blocking === "boolean")).toBe(true);
      const prose = selected.rubric.criteria.map((criterion) => criterion.text).join("\n");
      expect(prose).not.toMatch(/\b(?:severity|critical|major|minor|blocker|blocking)\b/iu);
    }
  });

  it("keeps remediation policy in the fixed instruction and implementation findings on declared outputs", async () => {
    for (const rubric of [await loadTestRubric("prd"), await loadTestRubric("design"), await loadTestRubric("phase-design"), await loadTestRubric("phase-impl")]) {
      const text = rubric.rubric.criteria.map((criterion) => criterion.text).join("\n");
      expect(text).not.toMatch(/prior-triage|challenge a prior disposition|accepted revision intent/iu);
    }
    const implementation = await loadTestRubric("phase-impl");
    const substantive = implementation.rubric.criteria.find((criterion) => criterion.id === "substantive-correctness")?.text ?? "";
    expect(substantive).toContain("declared implementation outputs");
    expect(substantive).toContain("introduced, exposed, or materially worsened");
    expect(substantive).toContain("pre-existing unrelated defects");
  });

  it("partitions test review without duplicating criteria or widening general scope when the specialist is unavailable", async () => {
    const design = await loadTestRubric("phase-design");
    const implementation = await loadTestRubric("phase-impl");
    const designGeneral = reviewAssignment("general", "general", "phase-design", design.rubric, true);
    const designTests = reviewAssignment("test", "tests", "phase-design", design.rubric, true);
    const implementationGeneral = reviewAssignment("general", "general", "phase-impl", implementation.rubric, true);
    const implementationTests = reviewAssignment("test", "tests", "phase-impl", implementation.rubric, true);

    expect(designTests.criterion_ids).toEqual(["test-strategy"]);
    expect(designGeneral.criterion_ids).toContain("implementation-readiness");
    expect(designGeneral.criterion_ids).toContain("predecessor-guarantees");
    expect(designGeneral.criterion_ids).not.toContain("phase-plan-soundness");
    expect(implementationTests.criterion_ids).toEqual(["verification-evidence", "test-quality"]);
    for (const [rubric, general, tests] of [
      [design.rubric, designGeneral, designTests],
      [implementation.rubric, implementationGeneral, implementationTests],
    ] as const) {
      expect(new Set([...general.criterion_ids, ...tests.criterion_ids])).toEqual(
        new Set(rubric.criteria.map((criterion) => criterion.id)),
      );
      expect(general.criterion_ids.some((id) => tests.criterion_ids.includes(id))).toBe(false);
    }
    expect(reviewAssignment("general", "general", "phase-impl", implementation.rubric, false).criterion_ids)
      .toEqual(implementationGeneral.criterion_ids);
    expect(reviewAssignment("general", "general", "phase-design", design.rubric, false).criterion_ids)
      .toEqual(designGeneral.criterion_ids);
  });

  it("constructs explicit alignment-only and legacy-confirmation-only assignments", async () => {
    const implementation = await loadTestRubric("phase-impl");
    expect(reviewAssignment("general", "general", "phase-impl", implementation.rubric, {
      criterion_ids: [],
      expected_upstream_digests: [],
    })).toEqual({
      reviewer_id: "general",
      focus: "general",
      criterion_ids: [],
      expected_upstream_digests: [],
    });
    expect(reviewAssignment("test", "tests", "phase-impl", implementation.rubric, {
      criterion_ids: [],
      legacy_confirmations: [{ finding_id: "archived-finding", criterion_ids: ["test-quality"] }],
    })).toEqual({
      reviewer_id: "test",
      focus: "tests",
      criterion_ids: [],
      legacy_confirmations: [{ finding_id: "archived-finding", criterion_ids: ["test-quality"] }],
    });
    expect(() => reviewAssignment("general", "general", "phase-impl", implementation.rubric, {
      criterion_ids: [],
    })).toThrow(/present responsibility/iu);
  });

  it("asks the test reviewer for economical distinct coverage, not raw test volume", async () => {
    const design = await loadTestRubric("phase-design");
    const implementation = await loadTestRubric("phase-impl");
    const policy = [
      design.rubric.criteria.find((criterion) => criterion.id === "test-strategy")?.text,
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
    const result = await loadRubricFile({ root, file: "rubrics/prd.yaml", expected_id: "prd-v1" });
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-missing");
    expect(parameters.issues?.join("\n")).toContain("rubrics/prd.yaml");
  });

  it("refuses invalid YAML, surfacing the parser message", async () => {
    const result = await loadFromTmp("rubric_id: prd-v1\ncriteria: [unclosed\n");
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
    const result = await loadFromTmp(MINIMAL_PRD.replace("rubric_id: prd-v1", "rubric_id: design-v3"));
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-invalid");
    expect(parameters.issues?.join("\n")).toContain("rubric_id");
  });

  it("rejects duplicate criterion ids", async () => {
    const duplicated = MINIMAL_PRD.replace(
      "    blocking: true\n",
      "    blocking: true\n  - id: substantive-correctness\n    text: \"Another.\"\n    blocking: false\n",
    );
    const result = await loadFromTmp(duplicated);
    const parameters = expectRubricFailure(result);
    expect(parameters.issue_code).toBe("rubric-file-invalid");
    expect(parameters.issues?.join("\n")).toContain("Duplicate criterion id");
  });

  it("rejects blank criterion text", async () => {
    const result = await loadFromTmp(MINIMAL_PRD.replace("Report a material defect only.", "   "));
    expect(expectRubricFailure(result).issue_code).toBe("rubric-file-invalid");
  });

  it("rejects unknown top-level keys", async () => {
    const result = await loadFromTmp(`${MINIMAL_PRD}extra: true\n`);
    expect(expectRubricFailure(result).issue_code).toBe("rubric-file-invalid");
  });

  it("rejects an unquoted schema_version, which YAML would parse as a number", async () => {
    const result = await loadFromTmp(MINIMAL_PRD.replace('schema_version: "1"', "schema_version: 1"));
    expect(expectRubricFailure(result).issue_code).toBe("rubric-file-invalid");
  });
});
