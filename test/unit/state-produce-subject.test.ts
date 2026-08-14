import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { expectedProduceUpstreamBindings, readProduceProjection, renderProduceReviewMaterial, resolveProduceUpstreamBinding, type CurrentProduceSubject } from "../../src/state/produce-subject.js";
import type { TransactionAuthority } from "../../src/state/authority.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

afterAll(cleanupTemporaryRepositories);

describe("retained produce review material", () => {
  it("authenticates implementation notes through the retained parent-document binding", async () => {
    const repository = createTempRepository({ label: "implementation-review-log" });
    const taskId = parseTaskSlug("demo");
    const artifactPath = parseTaskPathClaim("phases/1/impl-notes.md");
    const bytes = new TextEncoder().encode("Implementation notes\n");
    repository.write(`.archflow/tasks/${taskId}/${artifactPath}`, Buffer.from(bytes));
    repository.write("src/index.ts", "export {};\n");
    repository.commitAll("fixture");
    const context = {
      task_id: taskId,
      phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(1) }),
      operation: parseSafeCode("read-implementation-review-log"),
      attempt: parseSafeInteger(1),
    } as const;
    const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), context);
    if (!discovered.ok) throw discovered.error;
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const artifact = {
      ...fixture,
      parent_documents: [{
        document_path: artifactPath,
        content_digest: sha256Bytes(bytes),
        role: "impl-notes" as const,
      }],
    } as ImplementationOutputV1;
    const subject = {
      artifact_digest: canonicalJsonDigest(artifact),
      artifact,
      retained: {
        prepared: { manifest: { value: {
          projections: [{ path: "src/index.ts", content_digest: sha256Bytes(new TextEncoder().encode("export {};\n")) }],
        } } },
      },
    } as unknown as CurrentProduceSubject;
    const authority = { task_id: taskId, context } as unknown as TransactionAuthority;

    const current = await readProduceProjection(discovered.value, authority, subject, artifactPath);
    expect(current).toMatchObject({ ok: true, value: { digest: sha256Bytes(bytes) } });

    writeFileSync(join(repository.path, ".archflow", "tasks", taskId, artifactPath), "changed notes\n");
    const stale = await readProduceProjection(discovered.value, authority, subject, artifactPath);
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "produce-projection-not-current" } } },
    });
  });

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

  it("sends compact authenticated implementation metadata while source bytes stay in the workspace", () => {
    const artifact = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const largeAfterImage = new TextEncoder().encode(`large-source-sentinel\n${"x".repeat(1_400_000)}`);
    const subject = {
      artifact_digest: canonicalJsonDigest(artifact),
      artifact,
      retained: {
        projection_plan: {
          entries: [{
            path: artifact.outputs[0]!.path,
            desired: { state: "present", file_type: "regular", mode: "100644", bytes: largeAfterImage },
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
    });
    expect(rendered).not.toHaveProperty("changes");
    expect(new TextEncoder().encode(JSON.stringify(rendered)).byteLength).toBeLessThan(100_000);
    expect(JSON.stringify(rendered)).not.toContain("large-source-sentinel");
    expect(JSON.stringify(rendered)).not.toContain("old code");
  });
});
