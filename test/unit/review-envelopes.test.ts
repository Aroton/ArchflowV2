import { describe, expect, expectTypeOf, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  REVIEW_ENVELOPE_BYTE_CAP,
  ReviewEnvelopeError,
  buildReviewEnvelope,
  type DispatchSubject,
  type ReviewEnvelopeInput,
} from "../../src/review/envelopes.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));

const subject = (): DispatchSubject => ({
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: parsePhaseInstanceId("phase-impl-13"),
  role: "counter-review",
  step: "counter_review",
  subject_digest: digest("a"),
  input_fingerprint: digest("b"),
  rubric_digest: digest("c"),
  producer_family: "claude",
  invocation_id: "invocation-13",
  result_id: "result-13",
});

const input = (): ReviewEnvelopeInput => ({
  artifact: "# Phase 13\n\nEnvelope contract.\n",
  rubric: {
    schema_version: "1",
    kind: "implementation",
    mode: "adversarial",
    criteria: [{ id: "contract-match", text: "Match the approved contract.", blocking: true }],
  },
  subject: subject(),
});

const json = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

describe("review dispatch envelopes", () => {
  it("is canonical and deterministic with a child-visible schema version", () => {
    const first = buildReviewEnvelope(input());
    const second = buildReviewEnvelope(structuredClone(input()));
    const text = new TextDecoder().decode(first.bytes);

    expect(first.bytes).toEqual(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(first.byte_count).toBe(first.bytes.byteLength);
    expect(text).toMatch(/^\{\n  "schema_version": "1",/u);
    expect(json(first.bytes)).toMatchObject({ schema_version: "1", artifact: input().artifact });
    const visible = json(first.bytes);
    expect(first.digest).toBe(canonicalJsonDigest({
      schema_version: "1",
      digest_kind: "dispatch-envelope",
      artifact: visible.artifact as string,
      rubric: visible.rubric as never,
      subject: visible.subject as never,
    }));
  });

  it("returns the exact contract failure above the one MiB pre-spawn cap", () => {
    let thrown: unknown;
    try {
      buildReviewEnvelope({ ...input(), artifact: "x".repeat(REVIEW_ENVELOPE_BYTE_CAP) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewEnvelopeError);
    expect((thrown as ReviewEnvelopeError).project_error).toMatchObject({
      code: "CONTRACT_INVALID",
      diagnostic: { parameters: { issue_code: "envelope-byte-cap" } },
      next_action: "correct-contract",
    });
  });

  it.each(["Invocation:1", "result_1", "1-result", "result--one"])(
    "rejects provenance ID %j outside the evidence vocabulary",
    (candidate) => {
      const base = input();
      expect(() => buildReviewEnvelope({
        ...base,
        subject: { ...base.subject, invocation_id: candidate },
      })).toThrow(/identifier vocabulary/u);
    },
  );

  it("domain-separates dispatch-envelope from all ten existing digest kinds", () => {
    const built = buildReviewEnvelope(input());
    const visible = json(built.bytes);
    const kinds = [
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

    for (const digest_kind of kinds) {
      expect(built.digest).not.toBe(canonicalJsonDigest({
        schema_version: "1",
        digest_kind,
        artifact: visible.artifact as string,
        rubric: visible.rubric as never,
        subject: visible.subject as never,
      }));
    }
  });

  it("validates caller-owned JSON before cloning so getters cannot split observation", () => {
    let reads = 0;
    const hostile = input() as unknown as Record<string, unknown>;
    Object.defineProperty(hostile.subject as object, "result_id", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? "result-one" : "result-two";
      },
    });

    expect(() => buildReviewEnvelope(hostile as unknown as ReviewEnvelopeInput)).toThrow(/accessor properties/u);
    expect(reads).toBe(0);
  });

  it("keeps contamination fields out of the representable and accepted shapes", () => {
    expectTypeOf<keyof ReviewEnvelopeInput>().toEqualTypeOf<"artifact" | "rubric" | "subject">();
    expectTypeOf<keyof DispatchSubject>().toEqualTypeOf<
      | "task_id"
      | "phase_instance"
      | "role"
      | "step"
      | "subject_digest"
      | "input_fingerprint"
      | "rubric_digest"
      | "producer_family"
      | "invocation_id"
      | "result_id"
    >();

    expect(() => buildReviewEnvelope({ ...input(), prior_findings: [] } as unknown as ReviewEnvelopeInput))
      .toThrow(/must contain exactly/u);
    const base = input();
    expect(() => buildReviewEnvelope({
      ...base,
      subject: { ...base.subject, gate_id: "gate-1" } as unknown as DispatchSubject,
    })).toThrow(/must contain exactly/u);
  });
});
