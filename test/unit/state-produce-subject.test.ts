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
import { changedCoProducedDocumentPaths, expectedProduceUpstreamBindings, loadProduceUpstreamSubject, produceOwnedTaskDocumentPaths, produceProjectionPins, produceProjectionSetDigest, produceUpstreamBindingsForSubject, readProduceProjection, readProduceProjectionSet, renderProduceReviewMaterial, resolveProduceUpstreamBinding, type CurrentProduceSubject } from "../../src/state/produce-subject.js";
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
    const manifestValue = (artifact: DocumentArtifactV1, measured_at_revision: number) => ({
      source_artifact: artifact, artifact_digest: canonicalJsonDigest(artifact),
      accounting: { measured_at_revision }, projections: [], outputs: [],
    });
    const retainedManifest = (artifact: DocumentArtifactV1, measured_at_revision: number) => ({
      manifest: { value: manifestValue(artifact, measured_at_revision) },
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
      load_retained_manifest: async (reference) => ({
        schema_version: "1", ok: true,
        value: (reference.result_id === newRef.result_id
          ? retainedManifest(compound, 9)
          : retainedManifest(standalone, 4)) as never,
      }),
    }, {} as TransactionAuthority, state, {
      phase_instance: encodePhaseInstance({ kind: "design" }), path: parseTaskPathClaim("design.md"), artifact_kind: "design",
    });

    expect(loaded).toMatchObject({ ok: true, value: { artifact_digest: newDigest, artifact: { phase_instance: "phase-design-2" } } });
  });

  it("reports co-produced documents whose bytes differ from the newest earlier retained projection", async () => {
    const taskId = parseTaskSlug("demo");
    const oldDesign = new TextEncoder().encode("# Architecture\n");
    const newDesign = new TextEncoder().encode("# Architecture, revised\n");
    const prd = new TextEncoder().encode("# PRD\n");
    const phase = new TextEncoder().encode("# Phase 3\n");
    const document = (path: string, bytes: Uint8Array) => ({
      document_path: parseTaskPathClaim(path), byte_count: parseSafeInteger(bytes.byteLength),
      content_digest: sha256Bytes(bytes), projection_target: `.archflow/tasks/demo/${path}` as never,
    });
    const artifact: DocumentArtifactV1 = {
      schema_version: "1", artifact_kind: "document", task_id: taskId,
      phase_instance: encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(3) }),
      step: "produce", ...document("phases/3/design.md", phase), path_class: "document",
      declared_inputs: [], input_fingerprint: parseSha256Digest("1".repeat(64)),
      snapshot_digest: parseSha256Digest("2".repeat(64)),
      additional_documents: [document("design.md", newDesign), document("prd.md", prd)],
    };
    const reference = (phaseInstance: string, id: string) => ({
      phase_instance: phaseInstance, step: "produce", result_id: id, result_digest: "4".repeat(64), input_fingerprint: "1".repeat(64),
    }) as TaskStateV1["authoritative_results"][number];
    // Newest first once reversed: the current phase's own earlier attempt (ignored), an
    // implementation that rewrote design.md (the newest earlier projection), the design itself.
    const projections: Record<string, readonly { path: string; content_digest: string }[]> = {
      "self-attempt": [{ path: ".archflow/tasks/demo/phases/3/design.md", content_digest: sha256Bytes(phase) }, { path: ".archflow/tasks/demo/design.md", content_digest: sha256Bytes(newDesign) }],
      "impl-2": [{ path: ".archflow/tasks/demo/design.md", content_digest: sha256Bytes(oldDesign) }, { path: "src/index.ts", content_digest: "5".repeat(64) }],
      "design": [{ path: ".archflow/tasks/demo/design.md", content_digest: sha256Bytes(oldDesign) }],
    };
    const state = {
      task_id: taskId, phase_instance: artifact.phase_instance,
      authoritative_results: [reference("design", "design"), reference("phase-impl-2", "impl-2"), reference("phase-design-3", "self-attempt")],
    } as unknown as TaskStateV1;
    const dependencies = {
      load_retained_manifest: async (ref: TaskStateV1["authoritative_results"][number]) => ({
        schema_version: "1" as const, ok: true as const,
        value: { manifest: { value: { projections: projections[ref.result_id as string] } } } as never,
      }),
    };
    const subject = { artifact_digest: canonicalJsonDigest(artifact), artifact } as CurrentProduceSubject;

    // design.md differs from the implementation's rewrite; prd.md has no earlier projection at all.
    await expect(changedCoProducedDocumentPaths(dependencies, state, subject))
      .resolves.toMatchObject({ ok: true, value: [".archflow/tasks/demo/design.md"] });

    // Same bytes as the newest earlier projection: unchanged.
    const unchanged = { ...artifact, additional_documents: [document("design.md", oldDesign), document("prd.md", prd)] };
    await expect(changedCoProducedDocumentPaths(dependencies, state, { ...subject, artifact: unchanged }))
      .resolves.toMatchObject({ ok: true, value: [] });

    // Implementation outputs already list the task documents they changed.
    const implementation = { artifact: { artifact_kind: "implementation-output", outputs: [] } } as unknown as CurrentProduceSubject;
    await expect(changedCoProducedDocumentPaths(dependencies, state, implementation))
      .resolves.toMatchObject({ ok: true, value: [] });
  });

  it("refuses settlement-only retained manifest ownership before and after a restart", async () => {
    const taskId = parseTaskSlug("demo");
    const designBytes = new TextEncoder().encode("# Architecture\n");
    const design: DocumentArtifactV1 = {
      schema_version: "1", artifact_kind: "document", task_id: taskId, phase_instance: encodePhaseInstance({ kind: "design" }),
      step: "produce", document_path: parseTaskPathClaim("design.md"), path_class: "document",
      byte_count: parseSafeInteger(designBytes.byteLength), content_digest: sha256Bytes(designBytes),
      declared_inputs: [], input_fingerprint: parseSha256Digest("1".repeat(64)),
      snapshot_digest: parseSha256Digest("2".repeat(64)), projection_target: ".archflow/tasks/demo/design.md" as never,
    };
    const digest = canonicalJsonDigest(design);
    const reference = { phase_instance: "design", step: "produce", result_id: "design-result", result_digest: "4".repeat(64), input_fingerprint: "1".repeat(64) } as TaskStateV1["authoritative_results"][number];
    const retainedManifest = {
      manifest: { value: {
        source_artifact: design, artifact_digest: digest,
        accounting: { measured_at_revision: parseSafeInteger(4) }, projections: [], outputs: [],
      } },
    };
    const dependencies = {
      runner: {} as never,
      load_retained_manifest: async () => ({ schema_version: "1" as const, ok: true as const, value: retainedManifest as never }),
    };
    const binding = {
      phase_instance: encodePhaseInstance({ kind: "design" }), path: parseTaskPathClaim("design.md"), artifact_kind: "design" as const,
    };
    const receipt = {
      task_id: taskId, phase_instance: encodePhaseInstance({ kind: "design" }), step: "triage" as const,
      subject_digest: digest, conclusion: { wait: false, match: null } as const,
      config_digest: parseSha256Digest("7".repeat(64)), settled_at_revision: parseSafeInteger(4),
    };

    // A wait:false settlement is evaluation evidence only and cannot own an upstream path.
    const owned = await loadProduceUpstreamSubject(
      dependencies, {} as TransactionAuthority,
      { task_id: taskId, phase_instance: "phase-impl-2", authoritative_results: [reference], approvals: [], rule_settlements: [receipt] } as unknown as TaskStateV1,
      binding,
    );
    expect(owned).toMatchObject({ ok: false, error: { diagnostic: { parameters: { issue_code: "upstream-approval-missing" } } } });

    const waiting = await loadProduceUpstreamSubject(
      dependencies, {} as TransactionAuthority,
      {
        task_id: taskId, phase_instance: "phase-impl-2", authoritative_results: [reference], approvals: [],
        rule_settlements: [{
          ...receipt,
          conclusion: { wait: true, match: { kind: "subject", subject: "design" } },
        }],
      } as unknown as TaskStateV1,
      binding,
    );
    expect(waiting).toMatchObject({ ok: false, error: { diagnostic: { parameters: { issue_code: "upstream-approval-missing" } } } });

    // A restart does not change that trust boundary.
    const superseded = await loadProduceUpstreamSubject(
      dependencies, {} as TransactionAuthority,
      {
        task_id: taskId, phase_instance: "phase-impl-2", authoritative_results: [reference], approvals: [],
        rule_settlements: [receipt],
        restart_history: [{
          restart_id: "restart-1", source_phase_instance: "phase-impl-2",
          target_phase_instance: encodePhaseInstance({ kind: "design" }), reason: "reconsider",
          restarted_at_revision: parseSafeInteger(6), superseded_results: [], cleared_waivers: [],
          human_provenance: {} as never,
        } as never],
      } as unknown as TaskStateV1,
      binding,
    );
    expect(superseded).toMatchObject({ ok: false, error: { diagnostic: { parameters: { issue_code: "upstream-approval-missing" } } } });
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
      load_retained_manifest: async () => ({
        schema_version: "1", ok: true,
        value: { manifest: { value: {
          source_artifact: compound, artifact_digest: compoundDigest,
          accounting: { measured_at_revision: 9 }, projections: [], outputs: [],
        } } } as never,
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
  it("pins exactly the documents a dispatch re-reads, never the declared repository outputs", () => {
    const taskId = parseTaskSlug("pin-task");
    const notesPath = parseTaskPathClaim("phases/1/impl-notes.md");
    const phaseDesignPath = parseTaskPathClaim("phases/1/design.md");
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url),
      "utf8",
    )) as ImplementationOutputV1;
    const implementation = {
      ...fixture,
      task_id: taskId,
      outputs: [
        { ...fixture.outputs[0]!, path: parseRepositoryPathClaim("src/index.ts") },
        { ...fixture.outputs[0]!, path: parseRepositoryPathClaim(`.archflow/tasks/${taskId}/${notesPath}`) },
      ],
      parent_documents: [
        { document_path: notesPath, content_digest: parseSha256Digest("a".repeat(64)), role: "impl-notes" as const },
        // Governing documents the result did not co-produce stay upstream pins, not subject pins.
        { document_path: phaseDesignPath, content_digest: parseSha256Digest("b".repeat(64)), role: "phase-design" as const },
      ],
    } as ImplementationOutputV1;
    expect(produceProjectionPins(implementation)).toEqual([
      { path: notesPath, content_digest: parseSha256Digest("a".repeat(64)) },
    ]);

    const documentBytes = new TextEncoder().encode("# Design\n");
    const prdBytes = new TextEncoder().encode("# PRD\n");
    const designPath = parseTaskPathClaim("design.md");
    const prdPath = parseTaskPathClaim("prd.md");
    const compound: DocumentArtifactV1 = {
      schema_version: "1", artifact_kind: "document", task_id: taskId,
      phase_instance: encodePhaseInstance({ kind: "design" }),
      step: "produce", document_path: designPath, path_class: "document",
      byte_count: parseSafeInteger(documentBytes.byteLength), content_digest: sha256Bytes(documentBytes),
      declared_inputs: [], input_fingerprint: parseSha256Digest("1".repeat(64)),
      snapshot_digest: parseSha256Digest("2".repeat(64)),
      projection_target: `.archflow/tasks/${taskId}/${designPath}` as never,
      additional_documents: [{
        document_path: prdPath, byte_count: parseSafeInteger(prdBytes.byteLength),
        content_digest: sha256Bytes(prdBytes), projection_target: `.archflow/tasks/${taskId}/${prdPath}` as never,
      }],
    };
    expect(produceProjectionPins(compound)).toEqual([
      { path: designPath, content_digest: sha256Bytes(documentBytes) },
      { path: prdPath, content_digest: sha256Bytes(prdBytes) },
    ]);
  });
});
