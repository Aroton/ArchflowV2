import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { DIFF_CONTEXT_LINES } from "../../src/review/line-diff.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { EMBED_WHOLE_BYTE_CEILING, expectedProduceUpstreamBindings, readProduceProjection, renderProduceReviewMaterial, resolveProduceUpstreamBinding, resolveReviewExclusions, reviewChangeEntries, type CurrentProduceSubject } from "../../src/state/produce-subject.js";
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
    }, new Map())) as Record<string, unknown>;

    expect(rendered).toMatchObject({
      subject_kind: "retained-implementation-output",
      artifact_digest: subject.artifact_digest,
      implementation_output: { artifact_kind: "implementation-output", diff_digest: artifact.diff_digest },
      changes: [{
        path: artifact.outputs[0]!.path,
        rendering: "embedded",
        before: {
          state: "present",
          encoding: "utf8",
          content: "old code\n",
          content_digest: sha256Bytes(new TextEncoder().encode("old code\n")),
          byte_count: 9,
        },
        after: {
          state: "present",
          encoding: "utf8",
          content: "new code\n",
          content_digest: sha256Bytes(new TextEncoder().encode("new code\n")),
          byte_count: 9,
        },
      }],
    });
    const entries = (rendered as { changes: Record<string, unknown>[] }).changes;
    expect(entries[0]).not.toHaveProperty("reason");
  });

  it("renders an excluded path digest-only, declaring the reason and withholding content", () => {
    const artifact = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const lockBytes = new TextEncoder().encode("enormous lockfile churn\n");
    const subject = {
      artifact_digest: canonicalJsonDigest(artifact),
      artifact,
      retained: {
        projection_plan: {
          entries: [{
            path: "package-lock.json",
            desired: { state: "present", file_type: "regular", mode: "100644", bytes: lockBytes },
            rollback: { state: "absent" },
          }],
        },
      },
    } as unknown as CurrentProduceSubject;

    const entries = reviewChangeEntries(subject, new Map([["package-lock.json", "excluded-basename"]]));

    expect(entries).toEqual([{
      path: "package-lock.json",
      rendering: "digest-only",
      reason: "excluded-basename",
      after: {
        state: "present",
        content_digest: sha256Bytes(lockBytes),
        byte_count: lockBytes.byteLength,
      },
      before: { state: "absent" },
    }]);
    expect(entries[0]!.after).not.toHaveProperty("content");
  });

  it("renders an over-ceiling text file as a wide-context unified diff with verifiable side digests", () => {
    const artifact = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const beforeLines = Array.from({ length: 7000 }, (_, index) => `line ${index}\n`);
    const afterLines = [...beforeLines];
    afterLines[3500] = "changed line\n";
    const beforeBytes = new TextEncoder().encode(beforeLines.join(""));
    const afterBytes = new TextEncoder().encode(afterLines.join(""));
    expect(beforeBytes.byteLength).toBeGreaterThan(EMBED_WHOLE_BYTE_CEILING);
    const subject = {
      artifact_digest: canonicalJsonDigest(artifact),
      artifact,
      retained: {
        projection_plan: {
          entries: [{
            path: "src/big.ts",
            desired: { state: "present", file_type: "regular", mode: "100644", bytes: afterBytes },
            rollback: { state: "present", file_type: "regular", mode: "100644", bytes: beforeBytes },
          }],
        },
      },
    } as unknown as CurrentProduceSubject;

    const entries = reviewChangeEntries(subject, new Map());

    expect(entries[0]).toMatchObject({
      path: "src/big.ts",
      rendering: "unified-diff",
      reason: "exceeds-embed-ceiling",
      after: { state: "present", content_digest: sha256Bytes(afterBytes), byte_count: afterBytes.byteLength },
      before: { state: "present", content_digest: sha256Bytes(beforeBytes), byte_count: beforeBytes.byteLength },
      diff: { format: "unified", context_lines: DIFF_CONTEXT_LINES },
    });
    expect(entries[0]!.after).not.toHaveProperty("content");
    expect(entries[0]!.diff!.content).toContain("+changed line\n");
    expect(entries[0]!.diff!.content).toContain("-line 3500\n");
    expect(entries[0]!.diff!.content.match(/^@@/gm)).toHaveLength(1);
  });

  it("keeps one oversized side sufficient to trigger the diff tier, and small binaries embedded", () => {
    const artifact = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const bigText = new TextEncoder().encode("line\n".repeat(8000));
    const smallText = new TextEncoder().encode("small\n");
    const smallBinary = new Uint8Array([0xff, 0x00, 0x01]);
    const bigBinary = new Uint8Array(EMBED_WHOLE_BYTE_CEILING + 1).fill(0xff);
    const subject = {
      artifact_digest: canonicalJsonDigest(artifact),
      artifact,
      retained: {
        projection_plan: {
          entries: [
            {
              path: "src/shrunk.ts",
              desired: { state: "present", file_type: "regular", mode: "100644", bytes: smallText },
              rollback: { state: "present", file_type: "regular", mode: "100644", bytes: bigText },
            },
            {
              path: "assets/icon.bin",
              desired: { state: "present", file_type: "regular", mode: "100644", bytes: smallBinary },
            },
            {
              path: "assets/blob.bin",
              desired: { state: "present", file_type: "regular", mode: "100644", bytes: bigBinary },
            },
          ],
        },
      },
    } as unknown as CurrentProduceSubject;

    const entries = reviewChangeEntries(subject, new Map());

    expect(entries[0]).toMatchObject({ rendering: "unified-diff", reason: "exceeds-embed-ceiling" });
    expect(entries[1]).toMatchObject({
      rendering: "embedded",
      after: { state: "present", encoding: "base64", content: Buffer.from(smallBinary).toString("base64") },
    });
    expect(entries[1]).not.toHaveProperty("reason");
    expect(entries[2]).toMatchObject({
      rendering: "digest-only",
      reason: "binary-content",
      after: { state: "present", content_digest: sha256Bytes(bigBinary), byte_count: bigBinary.byteLength },
    });
    expect(entries[2]!.after).not.toHaveProperty("content");
  });

  it("resolves exclusions from lockfile basenames plus linguist-generated attributes, degrading to basenames when the attribute check fails", async () => {
    const artifact = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const entry = (path: string) => ({
      path,
      desired: { state: "present", file_type: "regular", mode: "100644", bytes: new Uint8Array([1]) },
    });
    const subject = {
      artifact_digest: canonicalJsonDigest(artifact),
      artifact,
      retained: {
        projection_plan: {
          entries: [entry("deep/package-lock.json"), entry("dist/bundle.mjs"), entry("src/app.ts")],
        },
      },
    } as unknown as CurrentProduceSubject;
    const context = {
      task_id: parseTaskSlug("mcp-integration"),
      phase_instance: "phase-impl-1",
      operation: parseSafeCode("test"),
      attempt: parseSafeInteger(1),
    } as unknown as Parameters<typeof resolveReviewExclusions>[2];

    const requested: string[][] = [];
    const runner = {
      runNulFields: (spec: { argv: readonly string[] }) => {
        requested.push([...spec.argv]);
        return Promise.resolve([
          "dist/bundle.mjs", "linguist-generated", "set",
          "src/app.ts", "linguist-generated", "unspecified",
        ]);
      },
    } as unknown as Parameters<typeof resolveReviewExclusions>[0];

    const exclusions = await resolveReviewExclusions(runner, subject, context);
    expect(exclusions).toEqual(new Map([
      ["deep/package-lock.json", "excluded-basename"],
      ["dist/bundle.mjs", "generated-attribute"],
    ]));
    expect(requested[0]).toEqual([
      "check-attr", "-z", "linguist-generated", "--", "dist/bundle.mjs", "src/app.ts",
    ]);

    const failingRunner = {
      runNulFields: () => Promise.resolve(["wrong", "cardinality"]),
    } as unknown as Parameters<typeof resolveReviewExclusions>[0];
    const degraded = await resolveReviewExclusions(failingRunner, subject, context);
    expect(degraded).toEqual(new Map([["deep/package-lock.json", "excluded-basename"]]));
  });
});
