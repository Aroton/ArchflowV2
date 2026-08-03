import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { expectedProduceUpstreamBindings, renderProduceReviewMaterial, resolveProduceUpstreamBinding, type CurrentProduceSubject } from "../../src/state/produce-subject.js";

describe("Phase 17 retained produce review material", () => {
  it("maps only the current phase's exact canonical upstream document paths", () => {
    const state = { phase_instance: "phase-impl-17" } as TaskStateV1;
    expect(expectedProduceUpstreamBindings(state)).toEqual([
      { phase_instance: "phase-design-17", path: "phases/17/design.md", artifact_kind: "phase-design" },
      { phase_instance: "design", path: "design.md", artifact_kind: "design" },
    ]);
    expect(resolveProduceUpstreamBinding(state, parseTaskPathClaim("phases/17/design.md")))
      .toEqual({ phase_instance: "phase-design-17", path: "phases/17/design.md", artifact_kind: "phase-design" });
    expect(resolveProduceUpstreamBinding(state, parseTaskPathClaim("phases/18/design.md"))).toBeUndefined();
    expect(resolveProduceUpstreamBinding(state, parseTaskPathClaim("prd.md"))).toBeUndefined();
    expect(resolveProduceUpstreamBinding(state, parseTaskPathClaim("phases/17/impl-notes.md"))).toBeUndefined();
  });

  it("sends authenticated implementation-output metadata and retained before/after bytes", () => {
    const artifact = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const subject = {
      artifact_digest: canonicalJsonDigest(artifact),
      artifact,
      retained: {
        projection_plan: {
          entries: [{
            path: artifact.outputs[0]!.path,
            desired: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("new code\n") },
            rollback: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("old code\n") },
          }],
        },
      },
    } as unknown as CurrentProduceSubject;

    const rendered = JSON.parse(renderProduceReviewMaterial(subject, {
      bytes: new TextEncoder().encode("implementation notes\n"),
      digest: canonicalJsonDigest({ projection: true }),
    })) as Record<string, unknown>;

    expect(rendered).toMatchObject({
      subject_kind: "retained-implementation-output",
      artifact_digest: subject.artifact_digest,
      implementation_output: { artifact_kind: "implementation-output", diff_digest: artifact.diff_digest },
      changes: [{
        path: artifact.outputs[0]!.path,
        before: { state: "present", encoding: "utf8", content: "old code\n" },
        after: { state: "present", encoding: "utf8", content: "new code\n" },
      }],
    });
  });
});
