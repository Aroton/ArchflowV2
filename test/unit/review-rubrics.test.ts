import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { ProjectResult } from "../../src/contracts/errors.js";
import { loadRubricFile, type CanonicalRubric, type CanonicalRubricId } from "../../src/review/rubrics.js";
import { loadTestRubric } from "../helpers/rubrics.js";

// Digests pinned to the reviewed rubric policy in assets/rubrics/. Regenerate
// deliberately, never casually: a changed digest is changed review policy for every
// installed bundle, and it fails in-flight tasks' input fingerprints closed.
const PINNED_RUBRIC_DIGESTS = Object.freeze({
  "prd-v1": "1910f0f56ebd54503658d4e5e0f1c44dcb23cc35be2ba1dabbb43f2fc866be56",
  "design-v2": "8fdc6e87839a23da3a5e5bd8619fbb036c8d6ea520b0cb70b13c5279ef725086",
  "implementation-v1": "defdbbd4913048a21cbd5267f19e325eed04005d72c8f06fdf7be38581da926c",
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
  it("loads one immutable versioned rubric per workflow artifact family", async () => {
    const prd = await loadTestRubric("prd");
    const design = await loadTestRubric("design");
    const phaseDesign = await loadTestRubric("phase-design");
    const implementation = await loadTestRubric("phase-impl");

    expect(prd.rubric_id).toBe("prd-v1");
    expect(design.rubric_id).toBe("design-v2");
    // design and phase-design select the same file, so the same exact bytes.
    expect(phaseDesign.rubric_id).toBe(design.rubric_id);
    expect(phaseDesign.rubric_digest).toBe(design.rubric_digest);
    expect(implementation.rubric_id).toBe("implementation-v1");
    expect(prd.rubric.kind).toBe("artifact");
    expect(design.rubric.kind).toBe("artifact");
    expect(implementation.rubric.kind).toBe("implementation");

    for (const selected of [prd, design, implementation]) {
      expect(selected.rubric_digest).toBe(canonicalJsonDigest(selected.rubric as never));
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.rubric)).toBe(true);
      expect(Object.isFrozen(selected.rubric.criteria)).toBe(true);
      expect(selected.rubric.criteria.every(Object.isFrozen)).toBe(true);
    }
  });

  it("reproduces the digests pinned when the rubrics moved from code to config files", async () => {
    expect((await loadTestRubric("prd")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["prd-v1"]);
    expect((await loadTestRubric("design")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["design-v2"]);
    expect((await loadTestRubric("phase-design")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["design-v2"]);
    expect((await loadTestRubric("phase-impl")).rubric_digest).toBe(PINNED_RUBRIC_DIGESTS["implementation-v1"]);
  });

  it("pins the shape of the quality, shortcut, and confidence criteria", async () => {
    const implementation = await loadTestRubric("phase-impl");
    const byId = new Map(implementation.rubric.criteria.map((criterion) => [criterion.id, criterion]));
    expect(byId.get("test-quality")?.blocking).toBe(true);
    expect(byId.get("anti-shortcut")?.blocking).toBe(true);
    for (const rubric of [await loadTestRubric("prd"), await loadTestRubric("design"), implementation]) {
      const last = rubric.rubric.criteria[rubric.rubric.criteria.length - 1];
      expect(last?.id).toBe("advisory-observations");
      const confidence = rubric.rubric.criteria.find((criterion) => criterion.id === "reviewer-confidence");
      expect(confidence?.blocking).toBe(false);
      expect(confidence?.text).toContain("escalate-");
    }
  });

  it("reviews design phase sizing structurally and only for material consequences", async () => {
    const design = await loadTestRubric("design");
    const phaseDesign = await loadTestRubric("phase-design");
    const phasePlan = design.rubric.criteria.find((criterion) =>
      criterion.id === "phase-plan-soundness"
    );

    expect(phaseDesign.rubric_digest).toBe(design.rubric_digest);
    expect(phasePlan?.blocking).toBe(true);

    const policy = phasePlan?.text ?? "";
    expect(policy).toMatch(/architecture design.*split-and-merge sizing attempt/iu);
    expect(policy).toMatch(/coherent repository-ready outcome/iu);
    expect(policy).toMatch(/valid completion state/iu);
    expect(policy).toMatch(/predecessors or stable inputs/iu);
    expect(policy).toMatch(/meaningful verification story/iu);
    expect(policy).toMatch(/splitting bundled independently implementable or verifiable outcomes/iu);
    expect(policy).toMatch(/merging scaffolding, file-, type-, or layer-only fragments/iu);
    expect(policy).toMatch(/retained unusually broad or small phase/iu);
    expect(policy).toMatch(/atomicity.*repository-validity.*inseparable-verification.*stable-interface.*risk-reduction value/iu);
    expect(policy).toMatch(/genuinely open-ended plan/iu);
    expect(policy).toMatch(/why responsible boundaries cannot yet be named/iu);
    expect(policy).toMatch(/what information will enable decomposition/iu);
    expect(policy).toMatch(/marker merely to avoid the sizing attempt/iu);
    expect(policy).toMatch(/numbered phase design.*bounded fit check/iu);
    expect(policy).toMatch(/preserve a sound approved boundary/iu);
    expect(policy).toMatch(/material split or merge.*writable parent.*returned authority/iu);
    expect(policy).toMatch(/materially harm implementation, verification, review, delivery, or create an important risk/iu);
    expect(policy).toContain(
      "Phase count, layer count, file count, diff size, and reviewer preference are not dispositive"
    );
    expect(policy).toMatch(/concrete consequence/iu);
    expect(policy).not.toMatch(/\d/u);
    expect(policy).not.toMatch(/hand-written files/iu);
    expect(policy).not.toMatch(/(?:file|diff|layer|phase)[ -]?(?:count|size)? (?:limit|threshold|maximum)/iu);
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
    const result = await loadFromTmp(MINIMAL_PRD.replace("rubric_id: prd-v1", "rubric_id: design-v2"));
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
