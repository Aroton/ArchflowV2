import { describe, expect, it } from "vitest";

import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import { buildGatePreview, previewHasChoice } from "../../src/state/gate-preview.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const evidence = currentEvidenceSetRef([{
    role: "counter-review" as const,
    evidence_digest: D("b"),
    assurance: "server-attested" as const,
    producer_family: "claude" as const,
    reviewer_family: "codex" as const,
    independence: "opposite-family" as const,
}]);

describe("gate preview", () => {
  it("binds the human presentation and exact implementation commit facts", () => {
    const preview = buildGatePreview({
      task_id: parseTaskSlug("preview-task"),
      revision: parseSafeInteger(9),
      phase_instance: parsePhaseInstanceId("phase-impl-2"),
      summary: "Phase two is reviewed and ready.",
      subject_digest: D("c"),
      current_evidence: evidence,
      kind: "commit-authorization",
      context: {
        target_ref: "refs/heads/main",
        baseline_commit: "1".repeat(40) as never,
        commit_message: "ArchFlow: Implement preview-task phase 2",
        paths: [parseRepositoryPathClaim("added.txt"), parseRepositoryPathClaim("old.txt")],
        diff_digest: D("d"),
        current_artifact_digests: [D("e")],
        parent_document_digests: [D("f")],
      },
    });

    expect(preview.presentation.options.map((option) => option.token)).toEqual([
      "authorize-commit", "request-changes", "stop-work", "cancel",
    ]);
    expect(preview.preview.commit).toEqual({
      target_ref: "refs/heads/main",
      baseline_commit: "1".repeat(40),
      message: "ArchFlow: Implement preview-task phase 2",
      paths: ["added.txt", "old.txt"],
      diff_digest: D("d"),
    });
    expect(previewHasChoice(preview, { choice: "authorize-commit", reason: "Reviewed." })).toBe(true);
    expect(previewHasChoice(preview, { choice: "unknown", reason: "Reviewed." })).toBe(false);
  });

  it("changes digest when preview freshness or judgment context changes", () => {
    const base = {
      task_id: parseTaskSlug("preview-task"),
      revision: parseSafeInteger(9),
      phase_instance: parsePhaseInstanceId("prd"),
      summary: "Requirements are ready.",
      subject_digest: D("c"),
      current_evidence: evidence,
      kind: "artifact-approval" as const,
      context: { artifact_kind: "prd" as const },
    };
    const first = buildGatePreview(base);
    expect(buildGatePreview({ ...base, revision: parseSafeInteger(10) }).preview_digest).not.toBe(first.preview_digest);
    expect(buildGatePreview({ ...base, summary: "A different summary." }).preview_digest).not.toBe(first.preview_digest);
    expect(buildGatePreview({ ...base, subject_digest: D("0") }).preview_digest).not.toBe(first.preview_digest);
  });
});
