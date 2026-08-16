import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { expectedProduceUpstreamBindings, loadProduceUpstreamSubject, produceOwnedTaskDocumentPaths, produceProjectionSetDigest, produceUpstreamBindingsForSubject, readProduceProjection, readProduceProjectionSet, renderProduceReviewMaterial, resolveProduceUpstreamBinding, type CurrentProduceSubject } from "../../src/state/produce-subject.js";
import type { TransactionAuthority } from "../../src/state/authority.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

afterAll(cleanupTemporaryRepositories);

describe("retained produce review material", () => {
  it("authenticates the implementation log and sends co-produced plan bytes in review material", async () => {
    const repository = createTempRepository({ label: "implementation-review-log" });
    const taskId = parseTaskSlug("demo");
    const artifactPath = parseTaskPathClaim("phases/1/impl-notes.md");
    const bytes = new TextEncoder().encode("Implementation notes\n");
    const phaseDesignPath = parseTaskPathClaim("phases/1/design.md");
    const phaseDesignBytes = new TextEncoder().encode("# Revised phase design\n");
    repository.write(`.archflow/tasks/${taskId}/${artifactPath}`, Buffer.from(bytes));
    repository.write(`.archflow/tasks/${taskId}/${phaseDesignPath}`, Buffer.from(phaseDesignBytes));
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
      outputs: [...fixture.outputs, {
        ...fixture.outputs[0]!,
        path: parseRepositoryPathClaim(`.archflow/tasks/${taskId}/${phaseDesignPath}`),
      }],
      parent_documents: [
        { document_path: artifactPath, content_digest: sha256Bytes(bytes), role: "impl-notes" as const },
        { document_path: phaseDesignPath, content_digest: sha256Bytes(phaseDesignBytes), role: "phase-design" as const },
      ],
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
    const reviewSet = await readProduceProjectionSet(discovered.value, authority, subject, artifactPath);
    expect(reviewSet).toMatchObject({
      ok: true,
      value: [
        { path: artifactPath, digest: sha256Bytes(bytes) },
        { path: phaseDesignPath, digest: sha256Bytes(phaseDesignBytes) },
      ],
    });
    if (!reviewSet.ok) return;
    expect(JSON.parse(renderProduceReviewMaterial(subject, reviewSet.value[0]!, reviewSet.value)))
      .toMatchObject({
        co_produced_documents: [{
          path: phaseDesignPath,
          content_digest: sha256Bytes(phaseDesignBytes),
          content: new TextDecoder().decode(phaseDesignBytes),
        }],
      });

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

  it("bundles every co-produced document and removes those paths from standalone upstreams", () => {
    const primary = new TextEncoder().encode("# Phase 17\n");
    const design = new TextEncoder().encode("# Architecture\n");
    const artifact: DocumentArtifactV1 = {
      schema_version: "1", artifact_kind: "document", task_id: parseTaskSlug("demo"),
      phase_instance: encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(17) }), step: "produce",
      document_path: parseTaskPathClaim("phases/17/design.md"), path_class: "document",
      byte_count: parseSafeInteger(primary.byteLength), content_digest: sha256Bytes(primary), declared_inputs: [],
      input_fingerprint: parseSha256Digest("1".repeat(64)), snapshot_digest: parseSha256Digest("2".repeat(64)),
      projection_target: ".archflow/tasks/demo/phases/17/design.md" as never,
      additional_documents: [{
        document_path: parseTaskPathClaim("design.md"), byte_count: parseSafeInteger(design.byteLength), content_digest: sha256Bytes(design),
        projection_target: ".archflow/tasks/demo/design.md" as never,
      }],
    };
    const subject = { artifact_digest: canonicalJsonDigest(artifact), artifact } as CurrentProduceSubject;
    const projections = [
      { path: parseTaskPathClaim("phases/17/design.md"), bytes: primary, digest: sha256Bytes(primary) },
      { path: parseTaskPathClaim("design.md"), bytes: design, digest: sha256Bytes(design) },
    ];

    expect(renderProduceReviewMaterial(subject, projections[0]!, projections)).toBe(
      "## Document: phases/17/design.md\n\n# Phase 17\n\n\n## Document: design.md\n\n# Architecture\n",
    );
    expect(produceProjectionSetDigest(projections)).not.toBe(projections[0]!.digest);
    expect(produceUpstreamBindingsForSubject({ phase_instance: "phase-design-17" } as TaskStateV1, artifact))
      .toEqual([{ phase_instance: "prd", path: "prd.md", artifact_kind: "prd" }]);
  });

  it("treats implementation-declared governing-document edits as co-produced", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const phaseDesignPath = parseRepositoryPathClaim(".archflow/tasks/demo/phases/2/design.md");
    const artifact = {
      ...fixture,
      task_id: parseTaskSlug("demo"),
      phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(2) }),
      outputs: [{ ...fixture.outputs[0]!, path: phaseDesignPath }],
    } as ImplementationOutputV1;
    const current = {
      task_id: parseTaskSlug("demo"),
      phase_instance: artifact.phase_instance,
    } as TaskStateV1;

    expect(produceUpstreamBindingsForSubject(current, artifact)).toEqual([
      { phase_instance: "design", path: "design.md", artifact_kind: "design" },
    ]);
    expect(produceUpstreamBindingsForSubject(current, { ...artifact, outputs: fixture.outputs })).toEqual([
      { phase_instance: "phase-design-2", path: "phases/2/design.md", artifact_kind: "phase-design" },
      { phase_instance: "design", path: "design.md", artifact_kind: "design" },
    ]);
  });

  it("resolves a governing path to its newest approved compound owner", async () => {
    const taskId = parseTaskSlug("demo");
    const designBytes = new TextEncoder().encode("# Architecture\n");
    const standalone: DocumentArtifactV1 = {
      schema_version: "1", artifact_kind: "document", task_id: taskId, phase_instance: encodePhaseInstance({ kind: "design" }),
      step: "produce", document_path: parseTaskPathClaim("design.md"), path_class: "document",
      byte_count: parseSafeInteger(designBytes.byteLength), content_digest: sha256Bytes(designBytes),
      declared_inputs: [], input_fingerprint: parseSha256Digest("1".repeat(64)),
      snapshot_digest: parseSha256Digest("2".repeat(64)), projection_target: ".archflow/tasks/demo/design.md" as never,
    };
    const phaseBytes = new TextEncoder().encode("# Phase 2\n");
    const compound: DocumentArtifactV1 = {
      ...standalone,
      phase_instance: encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(2) }),
      document_path: parseTaskPathClaim("phases/2/design.md"), byte_count: parseSafeInteger(phaseBytes.byteLength),
      content_digest: sha256Bytes(phaseBytes), projection_target: ".archflow/tasks/demo/phases/2/design.md" as never,
      additional_documents: [{
        document_path: parseTaskPathClaim("design.md"), byte_count: parseSafeInteger(designBytes.byteLength),
        content_digest: sha256Bytes(designBytes), projection_target: ".archflow/tasks/demo/design.md" as never,
      }],
    };
    const oldDigest = canonicalJsonDigest(standalone);
    const newDigest = canonicalJsonDigest(compound);
    const oldRef = { phase_instance: "design", step: "produce", result_id: "old", result_digest: "3".repeat(64), input_fingerprint: "1".repeat(64) } as TaskStateV1["authoritative_results"][number];
    const newRef = { phase_instance: "phase-design-2", step: "produce", result_id: "new", result_digest: "4".repeat(64), input_fingerprint: "1".repeat(64) } as TaskStateV1["authoritative_results"][number];
    const retained = (artifact: DocumentArtifactV1, measured_at_revision: number) => ({
      prepared: { manifest: { value: {
        source_artifact: artifact, artifact_digest: canonicalJsonDigest(artifact),
        accounting: { measured_at_revision }, projections: [], outputs: [],
      } } },
    });
    const state = {
      task_id: taskId, phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(2) }), authoritative_results: [newRef, oldRef],
      approvals: [
        { gate_kind: "design-approval", subject_digest: oldDigest },
        { gate_kind: "design-approval", subject_digest: newDigest },
      ],
    } as unknown as TaskStateV1;
    const loaded = await loadProduceUpstreamSubject({
      runner: {} as never,
      load_retained_result: async (reference) => ({
        schema_version: "1", ok: true,
        value: (reference.result_id === newRef.result_id ? retained(compound, 9) : retained(standalone, 4)) as never,
      }),
    }, {} as TransactionAuthority, state, {
      phase_instance: encodePhaseInstance({ kind: "design" }), path: parseTaskPathClaim("design.md"), artifact_kind: "design",
    });

    expect(loaded).toMatchObject({ ok: true, value: { artifact_digest: newDigest, artifact: { phase_instance: "phase-design-2" } } });
  });

  it("does not reintroduce a co-produced phase design through a sibling binding's compound owner", async () => {
    const repository = createTempRepository({ label: "co-produced-upstream-owner" });
    const taskId = parseTaskSlug("demo");
    const phasePath = parseTaskPathClaim("phases/2/design.md");
    const designPath = parseTaskPathClaim("design.md");
    const prdPath = parseTaskPathClaim("prd.md");
    const approvedPhaseBytes = new TextEncoder().encode("# Approved Phase 2\n");
    const amendedPhaseBytes = new TextEncoder().encode("# Amended Phase 2\n");
    const designBytes = new TextEncoder().encode("# Architecture\n");
    const prdBytes = new TextEncoder().encode("# Requirements\n");
    repository.write(`.archflow/tasks/${taskId}/${phasePath}`, Buffer.from(amendedPhaseBytes));
    repository.write(`.archflow/tasks/${taskId}/${designPath}`, Buffer.from(designBytes));
    repository.write(`.archflow/tasks/${taskId}/${prdPath}`, Buffer.from(prdBytes));
    repository.commitAll("amended implementation subject");
    const context = {
      task_id: taskId,
      phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(2) }),
      operation: parseSafeCode("co-produced-upstream-owner"),
      attempt: parseSafeInteger(1),
    } as const;
    const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), context);
    if (!discovered.ok) throw discovered.error;
    const authority = { task_id: taskId, context } as unknown as TransactionAuthority;
    const compound: DocumentArtifactV1 = {
      schema_version: "1", artifact_kind: "document", task_id: taskId,
      phase_instance: encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(2) }),
      step: "produce", document_path: phasePath, path_class: "document",
      byte_count: parseSafeInteger(approvedPhaseBytes.byteLength), content_digest: sha256Bytes(approvedPhaseBytes),
      declared_inputs: [], input_fingerprint: parseSha256Digest("1".repeat(64)),
      snapshot_digest: parseSha256Digest("2".repeat(64)),
      projection_target: `.archflow/tasks/${taskId}/${phasePath}` as never,
      additional_documents: [{
        document_path: designPath, byte_count: parseSafeInteger(designBytes.byteLength),
        content_digest: sha256Bytes(designBytes), projection_target: `.archflow/tasks/${taskId}/${designPath}` as never,
      }, {
        document_path: prdPath, byte_count: parseSafeInteger(prdBytes.byteLength),
        content_digest: sha256Bytes(prdBytes), projection_target: `.archflow/tasks/${taskId}/${prdPath}` as never,
      }],
    };
    const compoundDigest = canonicalJsonDigest(compound);
    const compoundRef = {
      phase_instance: "phase-design-2", step: "produce", result_id: "compound",
      result_digest: "3".repeat(64), input_fingerprint: "1".repeat(64),
    } as TaskStateV1["authoritative_results"][number];
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const implementation = {
      ...fixture,
      task_id: taskId,
      phase_instance: context.phase_instance,
      outputs: [{
        ...fixture.outputs[0]!,
        path: parseRepositoryPathClaim(`.archflow/tasks/${taskId}/${phasePath}`),
      }],
    } as ImplementationOutputV1;
    const state = {
      task_id: taskId, phase_instance: context.phase_instance,
      authoritative_results: [compoundRef],
      approvals: [{ gate_kind: "design-approval", subject_digest: compoundDigest }],
    } as unknown as TaskStateV1;
    const loaded = await loadProduceUpstreamSubject({
      runner: discovered.value,
      load_retained_result: async () => ({
        schema_version: "1", ok: true,
        value: { prepared: { manifest: { value: {
          source_artifact: compound, artifact_digest: compoundDigest,
          accounting: { measured_at_revision: 9 }, projections: [], outputs: [],
        } } } } as never,
      }),
    }, authority, state, {
      phase_instance: encodePhaseInstance({ kind: "design" }),
      path: designPath,
      artifact_kind: "design",
    });
    if (!loaded.ok) throw loaded.error;

    expect(produceUpstreamBindingsForSubject(state, implementation)).toEqual([
      { phase_instance: "design", path: designPath, artifact_kind: "design" },
    ]);
    expect(await readProduceProjectionSet(discovered.value, authority, loaded.value, designPath))
      .toMatchObject({
        ok: false,
        error: { diagnostic: { parameters: { issue_code: "produce-projection-not-current" } } },
      });
    expect(await readProduceProjectionSet(
      discovered.value,
      authority,
      loaded.value,
      designPath,
      produceOwnedTaskDocumentPaths(implementation),
    )).toMatchObject({
      ok: true,
      value: [
        { path: designPath, digest: sha256Bytes(designBytes) },
        { path: prdPath, digest: sha256Bytes(prdBytes) },
      ],
    });
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
      path: parseTaskPathClaim("phases/1/impl-notes.md"),
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
