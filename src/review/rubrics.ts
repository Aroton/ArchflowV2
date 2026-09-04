import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJsonDigest } from "../contracts/canonical.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import {
  createProjectError,
  describeValidationIssues,
  type ProjectResult,
} from "../contracts/errors.js";
import { parseRubricV1, type RubricV1 } from "../contracts/rubric.js";
import type { ReviewAssignmentV1, ReviewFocus } from "./envelopes.js";
import { parseSingleYamlDocument } from "../contracts/yaml.js";
import { assetRoot } from "../init/assets.js";

export type CounterReviewPhaseKind = "prd" | "design" | "phase-design" | "phase-impl";
export type CanonicalRubricId = "prd-v1" | "design-v3" | "implementation-v1";

export type CanonicalRubric = Readonly<{
  rubric_id: CanonicalRubricId;
  rubric_digest: Sha256Digest;
  rubric: RubricV1;
}>;

const TEST_CRITERIA: Readonly<Partial<Record<CounterReviewPhaseKind, readonly string[]>>> = Object.freeze({
  "phase-design": Object.freeze(["test-strategy"]),
  "phase-impl": Object.freeze(["verification-evidence", "test-quality"]),
});

export function reviewCriterionIds(
  phaseKind: CounterReviewPhaseKind,
  rubric: RubricV1,
  focus: ReviewFocus,
  _specialistActive?: boolean,
): readonly string[] {
  const all = rubric.criteria.map((criterion) => criterion.id);
  const tests = TEST_CRITERIA[phaseKind] ?? [];
  if (focus === "tests") return Object.freeze(all.filter((criterion) => tests.includes(criterion)));
  // Scope is a property of the phase and rubric, never of route availability. Otherwise an
  // unavailable specialist silently widens the general review and changes the same assignment's
  // meaning across retries.
  return Object.freeze(all.filter((criterion) => !tests.includes(criterion)));
}

export type ReviewAssignmentOptions = Readonly<{
  /** Override the ordinary criterion channel, primarily for bounded remediation subsets. */
  criterion_ids?: readonly string[];
  /** Presence, including `[]`, assigns approved-upstream alignment to the primary general run. */
  expected_upstream_digests?: NonNullable<ReviewAssignmentV1["expected_upstream_digests"]>;
  /** Exact criterion-less archive occurrences assigned for bounded confirmation. */
  legacy_confirmations?: NonNullable<ReviewAssignmentV1["legacy_confirmations"]>;
}>;

export function reviewAssignment(
  reviewerId: string,
  focus: ReviewFocus,
  phaseKind: CounterReviewPhaseKind,
  rubric: RubricV1,
  legacySpecialistActiveOrOptions?: boolean | ReviewAssignmentOptions,
): ReviewAssignmentV1 {
  const options = typeof legacySpecialistActiveOrOptions === "boolean"
    ? undefined
    : legacySpecialistActiveOrOptions;
  if (options?.legacy_confirmations !== undefined && options.legacy_confirmations.length === 0) {
    throw new TypeError("legacy_confirmations must be non-empty when present");
  }
  const criterionIds = Object.freeze([...(options?.criterion_ids ?? reviewCriterionIds(phaseKind, rubric, focus))]);
  if (criterionIds.length === 0 && options?.expected_upstream_digests === undefined &&
      options?.legacy_confirmations === undefined) {
    throw new TypeError(`review focus ${focus} is not applicable to ${phaseKind} without a present responsibility`);
  }
  return Object.freeze({
    reviewer_id: reviewerId,
    focus,
    criterion_ids: criterionIds,
    ...(options?.expected_upstream_digests === undefined
      ? {}
      : { expected_upstream_digests: Object.freeze([...options.expected_upstream_digests]) }),
    ...(options?.legacy_confirmations === undefined
      ? {}
      : { legacy_confirmations: Object.freeze(options.legacy_confirmations.map((confirmation) => Object.freeze({
        finding_id: confirmation.finding_id,
        criterion_ids: Object.freeze([...confirmation.criterion_ids]),
      }))) }),
  });
}

const PHASE_KIND_RUBRIC_FILES: Readonly<Record<CounterReviewPhaseKind, Readonly<{
  file: string;
  rubric_id: CanonicalRubricId;
}>>> = Object.freeze({
  prd: Object.freeze({ file: "rubrics/prd.yaml", rubric_id: "prd-v1" }),
  design: Object.freeze({ file: "rubrics/design.yaml", rubric_id: "design-v3" }),
  "phase-design": Object.freeze({ file: "rubrics/design.yaml", rubric_id: "design-v3" }),
  "phase-impl": Object.freeze({ file: "rubrics/implementation.yaml", rubric_id: "implementation-v1" }),
});

function canonicalRubric(rubricId: CanonicalRubricId, rubric: RubricV1): CanonicalRubric {
  const frozen = Object.freeze({
    ...rubric,
    criteria: Object.freeze(rubric.criteria.map((criterion) => Object.freeze({ ...criterion }))),
  });
  return Object.freeze({
    rubric_id: rubricId,
    rubric_digest: canonicalJsonDigest(frozen),
    rubric: frozen,
  });
}

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

const rubricFailure = (
  issueCode: "rubric-file-missing" | "rubric-file-invalid",
  issues: readonly string[],
): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("CONFIG_INVALID", { issue_code: issueCode, issues: issues.slice(0, 5) }),
  });

/**
 * Loads and strictly parses one rubric file from a root directory. The file's
 * `rubric_id` is cross-checked and excluded before validation, so the digest
 * covers exactly `schema_version`, `kind`, `mode`, and the ordered criteria.
 * Exported for tests; production callers use {@link loadCanonicalRubricForPhaseKind}.
 */
export async function loadRubricFile(input: Readonly<{
  root: string;
  file: string;
  expected_id: CanonicalRubricId;
}>): Promise<ProjectResult<CanonicalRubric>> {
  const label = `assets/${input.file}`;
  let document: unknown;
  try {
    const bytes = await readFile(join(input.root, input.file));
    document = parseSingleYamlDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), label);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return rubricFailure("rubric-file-invalid", [error.message]);
    }
    return rubricFailure("rubric-file-missing", [
      `${label}: the rubric file is missing or unreadable (${error instanceof Error ? error.message : "unknown error"}); reinstall the ArchFlow bundle`,
    ]);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return rubricFailure("rubric-file-invalid", [`${label}: the rubric file must be a YAML mapping`]);
  }
  const record = document as Readonly<Record<string, unknown>>;
  if (record.rubric_id !== input.expected_id) {
    return rubricFailure("rubric-file-invalid", [
      `${label}: rubric_id ${JSON.stringify(record.rubric_id)} does not match this file's rubric ${input.expected_id}`,
    ]);
  }
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "rubric_id"));
  try {
    return ok(canonicalRubric(input.expected_id, parseRubricV1(fields)));
  } catch (error) {
    const issues = describeValidationIssues(error);
    return rubricFailure(
      "rubric-file-invalid",
      issues === undefined ? [`${label}: rubric rejected`] : issues.map((issue) => `${label}: ${issue}`),
    );
  }
}

/**
 * Loads the server-owned rubric file for one durable phase kind, fresh on every
 * call so an installed bundle edit takes effect on the next review without a
 * restart. Missing or invalid files fail closed; nothing is cached.
 */
export async function loadCanonicalRubricForPhaseKind(
  phaseKind: CounterReviewPhaseKind,
): Promise<ProjectResult<CanonicalRubric>> {
  const expected = PHASE_KIND_RUBRIC_FILES[phaseKind];
  let root: string;
  try {
    root = await assetRoot();
  } catch (error) {
    return rubricFailure("rubric-file-missing", [
      `assets/rubrics: installed ArchFlow assets are missing (${error instanceof Error ? error.message : "unknown error"})`,
    ]);
  }
  return loadRubricFile({ root, file: expected.file, expected_id: expected.rubric_id });
}
