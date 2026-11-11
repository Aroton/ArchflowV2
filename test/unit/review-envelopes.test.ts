import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { Sha256Digest } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import {
  MULTI_REPOSITORY_VIEW_NOTE,
  sealDispatchInput,
  type MultiRepositoryWorkspaceBinding,
} from "../../src/review/envelopes.js";
import { prepareReviewInputs } from "../../src/review/inputs.js";

const digest = (character: string) => character.repeat(64) as Sha256Digest;

const workspace = (): MultiRepositoryWorkspaceBinding => ({
  kind: "read-only-multi-repository-view",
  note: MULTI_REPOSITORY_VIEW_NOTE,
  repositories: [
    { name: "primary", path: "primary", repository_identity_digest: digest("1"), commit: "0123456789abcdef0123456789abcdef01234567" as never },
  ],
});

/** The shape `runSimpleReview` seals for a standalone implementation-stage reviewer. */
const common = () => ({
  subject: { stage: "implementation", subject_digest: digest("a") },
  ask: "Reject path traversal in the upload handler.",
  plan: "Normalize the path and refuse anything outside the upload root.",
  paths: ["src/upload.ts"],
  verification: "npm test",
  workspace: workspace(),
  scope: "This is a standalone simple task, not an initialized ArchFlow workflow.",
});
const reviewInput = () => ({
  ...common(),
  assignment: { reviewer_id: "counter-reviewer-1", focus: "general", criterion_ids: ["correctness"] },
  rubric: { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [
    { id: "correctness", text: "Concrete correctness", blocking: true },
  ] },
});
const adjudicationInput = () => ({
  ...common(),
  rules: [{ slot: "rule-1", text: "Never write outside the upload root.", enforced_by: [] }],
});

const json = (bytes: Uint8Array): Record<string, PlainJsonValue> =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, PlainJsonValue>;

const OTHER_DIGEST_KINDS = [
  "gate-identity",
  "gate-context",
  "waiver-context",
  "open-gate-frozen-state",
  "projection-generation",
  "maintenance-reachability",
  "declared-output-snapshot",
  "implementation-diff",
  "declared-index-identity",
  "declared-worktree-identity",
] as const;

describe("sealed dispatch input", () => {
  it("is canonical and deterministic, with the digest over the child-visible bytes", () => {
    const first = sealDispatchInput("review", reviewInput());
    const second = sealDispatchInput("review", structuredClone(reviewInput()));

    expect(first.bytes).toEqual(second.bytes);
    expect(first.result_kind).toBe("review");
    expect(first.digest).toBe(second.digest);
    expect(first.byte_count).toBe(first.bytes.byteLength);
    const visible = json(first.bytes);
    expect(visible).toMatchObject({ subject: reviewInput().subject, ask: reviewInput().ask, workspace: workspace() });
    expect(visible).toHaveProperty("response_schema");
    expect(visible).toHaveProperty("rendered_inputs");
    expect(first.digest).toBe(canonicalJsonDigest({ ...visible, digest_kind: "dispatch-envelope" }));
    expect(() => prepareReviewInputs(first)).not.toThrow();
  });

  it("binds the subject, assignment, and workspace into the digest", () => {
    const base = sealDispatchInput("review", reviewInput()).digest;
    const input = reviewInput();
    expect(sealDispatchInput("review", { ...input, subject: { ...input.subject, subject_digest: digest("b") } }).digest).not.toBe(base);
    expect(sealDispatchInput("review", { ...input, assignment: { ...input.assignment, reviewer_id: "counter-reviewer-2" } }).digest).not.toBe(base);
    const moved = { ...workspace(), repositories: [{ ...workspace().repositories[0]!, commit: "1123456789abcdef0123456789abcdef01234567" as never }] };
    expect(sealDispatchInput("review", { ...input, workspace: moved }).digest).not.toBe(base);
    expect(MULTI_REPOSITORY_VIEW_NOTE).toContain("declared outputs and their current post-change behavior");
    expect(MULTI_REPOSITORY_VIEW_NOTE).toContain("supporting evidence only");
  });

  it("domain-separates review and constitution inputs from each other and every other digest kind", () => {
    const review = sealDispatchInput("review", reviewInput());
    const adjudication = sealDispatchInput("adjudication", adjudicationInput());
    const reviewVisible = json(review.bytes);
    const adjudicationVisible = json(adjudication.bytes);

    expect(adjudication.result_kind).toBe("adjudication");
    expect(adjudication.digest).toBe(canonicalJsonDigest({ ...adjudicationVisible, digest_kind: "adjudication-envelope" }));
    expect(adjudicationVisible.rules).toEqual(adjudicationInput().rules);
    expect(reviewVisible).not.toHaveProperty("rules");
    for (const digest_kind of [...OTHER_DIGEST_KINDS, "adjudication-envelope"] as const) {
      expect(review.digest).not.toBe(canonicalJsonDigest({ ...reviewVisible, digest_kind }));
    }
    for (const digest_kind of [...OTHER_DIGEST_KINDS, "dispatch-envelope"] as const) {
      expect(adjudication.digest).not.toBe(canonicalJsonDigest({ ...adjudicationVisible, digest_kind }));
    }
  });

  it("validates caller-owned JSON before cloning so getters cannot split observation", () => {
    let reads = 0;
    const hostile = reviewInput() as unknown as Record<string, unknown>;
    Object.defineProperty(hostile.subject as object, "subject_digest", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? digest("a") : digest("b");
      },
    });

    expect(() => sealDispatchInput("review", hostile)).toThrow(/accessor properties/u);
    expect(reads).toBe(0);
  });
});
