import { describe, expect, it } from "vitest";

import type { Sha256Digest } from "../../src/contracts/evidence.js";
import { milestoneRecoveryId, semanticMilestoneRecoveryId } from "../../src/state/milestone-recovery.js";

const D = (char: string) => char.repeat(64) as Sha256Digest;

describe("milestone-recovery ID derivation", () => {
  it("derives semantic recovery ID from semantic intent", () => {
    const semanticIntent = `afop-${"a".repeat(64)}-recover-milestone-authority`;
    const derived = semanticMilestoneRecoveryId(semanticIntent);
    expect(derived).toBe(`milestone-recovery-${"a".repeat(32)}`);
  });

  it("returns undefined for non-semantic recovery intent", () => {
    expect(semanticMilestoneRecoveryId("custom-recovery-intent")).toBeUndefined();
    expect(semanticMilestoneRecoveryId(`afop-${"a".repeat(64)}-reopen`)).toBeUndefined();
  });

  it("derives recovery ID from semantic intent or fallback request digest", () => {
    const requestDigest = D("b");
    const semanticIntent = `afop-${"a".repeat(64)}-recover-milestone-authority`;

    // Semantic intent takes precedence
    expect(milestoneRecoveryId(requestDigest, semanticIntent)).toBe(
      `milestone-recovery-${"a".repeat(32)}`,
    );

    // Non-semantic intent falls back to request digest slice
    expect(milestoneRecoveryId(requestDigest, "custom-intent")).toBe(
      `milestone-recovery-${"b".repeat(32)}`,
    );

    // Undefined intent falls back to request digest slice
    expect(milestoneRecoveryId(requestDigest)).toBe(
      `milestone-recovery-${"b".repeat(32)}`,
    );
  });
});
