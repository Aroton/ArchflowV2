import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { ProductionServices } from "../../src/state/production.js";
import { composeRequest } from "../../src/state/request-composition.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

describe("editorial gate composition", () => {
  it("binds trigger authority from predecessor rule settlement when an editorial predecessor exists", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-editorial-gate-")));
    roots.push(root);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
    mkdirSync(join(root, ".archflow", "tasks", "task-1", "phases", "2"), { recursive: true });
    writeFileSync(join(root, ".gitattributes"), ".archflow/** -text merge=binary\n");
    writeFileSync(join(root, ".archflow", "tasks", "task-1", "prd.md"), "prd input\n");
    writeFileSync(join(root, ".archflow", "tasks", "task-1", "design.md"), "design input\n");
    writeFileSync(join(root, ".archflow", "tasks", "task-1", "phases", "2", "design.md"), "# Phase 2 Design\n\nEditorial content.\n");
    execFileSync("git", ["add", "--", ".gitattributes", ".archflow"], { cwd: root, env });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root, env });

    const taskId = parseTaskSlug("task-1");
    const phase = parsePhaseInstanceId("phase-design-2");
    const context: RepositoryOperationContext = {
      task_id: taskId,
      phase_instance: phase,
      operation: "gate-compose-test" as RepositoryOperationContext["operation"],
      attempt: parseSafeInteger(2),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw discovered.error;
    const preflight = await preflightGit(discovered.value, context);
    if (!preflight.ok) throw preflight.error;
    const authority = await createInternalTransactionAuthority({
      runner: discovered.value,
      environment: preflight.value,
      task_id: taskId,
      context,
    });
    if (!authority.ok) throw authority.error;

    const designContent = "# Phase 2 Design\n\nEditorial content.\n";
    const designBytes = new TextEncoder().encode(designContent);
    const editorialDigest = sha256Bytes(designBytes);
    const predecessorDigest = parseSha256Digest("a".repeat(64));
    const configDigest = parseSha256Digest("c".repeat(64));
    const resultDigest = parseSha256Digest("d".repeat(64));
    const triageDigest = parseSha256Digest("e".repeat(64));

    const counterResultDigest = parseSha256Digest("9".repeat(64));
    const counterEvidence = {
      schema_version: "1",
      task_id: taskId,
      phase_instance: phase,
      step: "counter_review",
      role: "counter-review",
      subject_digest: predecessorDigest,
      input_fingerprint: "0".repeat(64),
      rubric_digest: "9".repeat(64),
      producer_family: "claude",
      findings: [],
      matched_rule_versions: [],
      verdict: "pass",
      blocking_count: 0,
      assurance: "server-attested",
      adapter: "codex-cli",
      cli_version: "1.0.0",
      model_family: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      invocation_id: "invocation-1",
      envelope_input_digest: parseSha256Digest("a".repeat(64)),
      observed_output_digest: parseSha256Digest("b".repeat(64)),
      result_id: "result-1",
    };
    const counterEvidenceDigest = canonicalJsonDigest(counterEvidence);
    const counterSource = {
      schema_version: "1",
      artifact_kind: "review-evidence",
      evidence: counterEvidence,
    };
    const counterManifest = {
      schema_version: "1",
      task_id: taskId,
      repository_identity_digest: parseSha256Digest("f".repeat(64)),
      result_id: "counter-res" as any,
      phase_instance: phase,
      step: "counter_review",
      artifact_digest: counterEvidenceDigest,
      source_artifact: counterSource,
      input_fingerprint: "0".repeat(64),
      snapshot_digest: parseSha256Digest("4".repeat(64)),
      outputs: [],
      projections: [],
      accounting: {
        schema_version: "1",
        result_bytes: 0 as never,
        task_bytes: 0 as never,
        result_byte_cap: 26_214_400 as never,
        task_byte_cap: 262_144_000 as never,
        counted_entries: [],
        measured_at_revision: 8 as never,
      },
      secret_scan: {
        schema_version: "1",
        outcome: "clean",
        detector_set_id: "default" as any,
        scanned_paths: [],
      },
    };

    const documentArtifact = {
      schema_version: "1",
      task_id: taskId,
      phase_instance: phase,
      step: "produce",
      artifact_kind: "document",
      document_path: "phases/2/design.md",
      declared_inputs: [],
      input_fingerprint: "1".repeat(64),
      editorial_predecessor: {
        subject_digest: predecessorDigest,
        input_fingerprint: "0".repeat(64),
        triage_result_digest: triageDigest,
      },
    };
    const artifactDigest = canonicalJsonDigest(documentArtifact);

    const produceManifest = {
      schema_version: "1",
      task_id: taskId,
      repository_identity_digest: parseSha256Digest("f".repeat(64)),
      result_id: "produce-res" as any,
      phase_instance: phase,
      step: "produce",
      artifact_digest: artifactDigest,
      source_artifact: documentArtifact,
      input_fingerprint: "1".repeat(64),
      snapshot_digest: parseSha256Digest("4".repeat(64)),
      outputs: [
        {
          path: ".archflow/tasks/task-1/phases/2/design.md",
          path_class: "document",
          operation: "write",
          content_digest: editorialDigest,
        },
      ],
      projections: [
        {
          path: ".archflow/tasks/task-1/phases/2/design.md",
          content_digest: editorialDigest,
        },
      ],
      accounting: {
        schema_version: "1",
        result_bytes: 100 as never,
        task_bytes: 100 as never,
        result_byte_cap: 26_214_400 as never,
        task_byte_cap: 262_144_000 as never,
        counted_entries: [],
        measured_at_revision: 10 as never,
      },
      secret_scan: {
        schema_version: "1",
        outcome: "clean",
        detector_set_id: "default" as any,
        scanned_paths: [],
      },
    };

    const counterDoc = canonicalDocument(counterManifest);
    const produceDoc = canonicalDocument(produceManifest);

    const state = {
      schema_version: "1",
      task_id: taskId,
      phase_instance: phase,
      step: "produce",
      status: "succeeded",
      attempt: parseSafeInteger(2),
      revision: parseSafeInteger(10),
      input_fingerprint: "1".repeat(64),
      policy_base_commit: "2".repeat(40),
      constitution_digest: "3".repeat(64),
      authoritative_results: [
        {
          schema_version: "1",
          phase_instance: phase,
          step: "counter_review",
          result_id: "counter-res" as any,
          result_digest: counterDoc.digest,
          input_fingerprint: "0".repeat(64),
          recorded_at_revision: parseSafeInteger(8),
          retained_bytes: parseSafeInteger(100),
        },
        {
          schema_version: "1",
          phase_instance: phase,
          step: "produce",
          result_id: "produce-res" as any,
          result_digest: produceDoc.digest,
          input_fingerprint: "1".repeat(64),
          recorded_at_revision: parseSafeInteger(10),
          retained_bytes: parseSafeInteger(100),
        },
      ],
      rule_settlements: [
        {
          schema_version: "1",
          task_id: taskId,
          phase_instance: phase,
          subject_digest: predecessorDigest,
          config_digest: configDigest,
          settled_at_revision: parseSafeInteger(8),
          conclusion: {
            wait: true,
            match: {
              kind: "subject",
              subject: "phase-design",
            },
          },
        },
      ],
      approvals: [],
    };

    const services: ProductionServices = {
      state: { value: state } as unknown as any,
      authority: authority.value,
      runner: discovered.value,
      environment: preflight.value,
      dependencies: {
        runner: discovered.value,
        environment: preflight.value,
        read_config: async () => ({
          kind: "valid",
          snapshot: { bytes: new TextEncoder().encode("schema_version: '1'\nroles: {}\n") },
        }),
        load_retained_manifest: async (reference: any) => {
          const doc = reference.step === "counter_review" ? counterDoc : produceDoc;
          return {
            ok: true,
            value: {
              schema_version: "1",
              content_address: `ca-${reference.step}`,
              manifest: doc,
              manifest_target: {
                absolute: `/repo/.archflow/tasks/task-1/authority/results/${doc.digest}.json`,
                relative: `.archflow/tasks/task-1/authority/results/${doc.digest}.json`,
                path_class: "authority-result",
              } as any,
            },
          };
        },
        read_state: async () => ({
          ok: true,
          value: {
            schema_version: "1",
            content_address: "ca-state",
            value: state,
          },
        }),
      },
    } as unknown as ProductionServices;

    const composed = await composeRequest(services, {
      intent_id: "gate-summary-test",
      kind: "gate",
      summary: "Human design approval for phase 2",
    });

    expect(composed.ok).toBe(true);
    if (!composed.ok) throw new Error(JSON.stringify(composed));
    expect(composed.value.envelope.request.tool).toBe("archflow_gate");
    const input = composed.value.envelope.request.input as Record<string, unknown>;
    expect(input.kind).toBe("design-approval");
    expect(input.subject_digest).toBe(artifactDigest);
    expect(input.context).toMatchObject({
      approval_trigger: {
        kind: "rule-settlement",
        settlement: {
          subject_digest: predecessorDigest,
          config_digest: configDigest,
          settled_at_revision: parseSafeInteger(8),
        },
      },
    });
  });

  it("dynamically evaluates approval rule trigger when rule_settlements is empty in state.json", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "editorial-empty-settlements-test-")));
    roots.push(root);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
    mkdirSync(join(root, ".archflow", "tasks", "task-1", "phases", "2"), { recursive: true });
    writeFileSync(join(root, ".gitattributes"), ".archflow/** -text merge=binary\n");
    writeFileSync(join(root, ".archflow", "tasks", "task-1", "prd.md"), "prd input\n");
    writeFileSync(join(root, ".archflow", "tasks", "task-1", "design.md"), "design input\n");
    writeFileSync(join(root, ".archflow", "tasks", "task-1", "phases", "2", "design.md"), "# Phase 2 Design\n\nEditorial content.\n");
    execFileSync("git", ["add", "--", ".gitattributes", ".archflow"], { cwd: root, env });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root, env });

    const taskId = parseTaskSlug("task-1");
    const phase = parsePhaseInstanceId("phase-design-2");
    const context: RepositoryOperationContext = {
      task_id: taskId,
      phase_instance: phase,
      operation: "gate-compose-test" as RepositoryOperationContext["operation"],
      attempt: parseSafeInteger(2),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw discovered.error;
    const preflight = await preflightGit(discovered.value, context);
    if (!preflight.ok) throw preflight.error;
    const headCommit = (await discovered.value.runText({ argv: ["rev-parse", "HEAD"], operation: parseSafeCode("test") })).trim();
    const authority = await createInternalTransactionAuthority({
      runner: discovered.value,
      environment: preflight.value,
      task_id: taskId,
      context,
    });
    if (!authority.ok) throw authority.error;

    const designContent = "# Phase 2 Design\n\nEditorial content.\n";
    const designBytes = new TextEncoder().encode(designContent);
    const editorialDigest = sha256Bytes(designBytes);
    const predecessorDigest = parseSha256Digest("a".repeat(64));
    const triageDigest = parseSha256Digest("e".repeat(64));

    const counterEvidence = {
      schema_version: "1",
      task_id: taskId,
      phase_instance: phase,
      step: "counter_review",
      role: "counter-review",
      subject_digest: predecessorDigest,
      input_fingerprint: "0".repeat(64),
      rubric_digest: "9".repeat(64),
      producer_family: "claude",
      findings: [],
      matched_rule_versions: [],
      verdict: "pass",
      blocking_count: 0,
      assurance: "server-attested",
      adapter: "codex-cli",
      cli_version: "1.0.0",
      model_family: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      invocation_id: "invocation-1",
      envelope_input_digest: parseSha256Digest("a".repeat(64)),
      observed_output_digest: parseSha256Digest("b".repeat(64)),
      result_id: "result-1",
    };
    const counterEvidenceDigest = canonicalJsonDigest(counterEvidence);
    const counterSource = {
      schema_version: "1",
      artifact_kind: "review-evidence",
      evidence: counterEvidence,
    };
    const counterManifest = {
      schema_version: "1",
      task_id: taskId,
      repository_identity_digest: parseSha256Digest("f".repeat(64)),
      result_id: "counter-res" as any,
      phase_instance: phase,
      step: "counter_review",
      artifact_digest: counterEvidenceDigest,
      source_artifact: counterSource,
      input_fingerprint: "0".repeat(64),
      snapshot_digest: parseSha256Digest("4".repeat(64)),
      outputs: [],
      projections: [],
      accounting: {
        schema_version: "1",
        result_bytes: 0 as never,
        task_bytes: 0 as never,
        result_byte_cap: 26_214_400 as never,
        task_byte_cap: 262_144_000 as never,
        counted_entries: [],
        measured_at_revision: 8 as never,
      },
      secret_scan: {
        schema_version: "1",
        outcome: "clean",
        detector_set_id: "default" as any,
        scanned_paths: [],
      },
    };

    const documentArtifact = {
      schema_version: "1",
      task_id: taskId,
      phase_instance: phase,
      step: "produce",
      artifact_kind: "document",
      document_path: "phases/2/design.md",
      declared_inputs: [],
      input_fingerprint: "1".repeat(64),
      editorial_predecessor: {
        subject_digest: predecessorDigest,
        input_fingerprint: "0".repeat(64),
        triage_result_digest: triageDigest,
      },
    };
    const artifactDigest = canonicalJsonDigest(documentArtifact);

    const produceManifest = {
      schema_version: "1",
      task_id: taskId,
      repository_identity_digest: parseSha256Digest("f".repeat(64)),
      result_id: "produce-res" as any,
      phase_instance: phase,
      step: "produce",
      artifact_digest: artifactDigest,
      source_artifact: documentArtifact,
      input_fingerprint: "1".repeat(64),
      snapshot_digest: parseSha256Digest("4".repeat(64)),
      outputs: [
        {
          path: ".archflow/tasks/task-1/phases/2/design.md",
          path_class: "document",
          operation: "write",
          content_digest: editorialDigest,
        },
      ],
      projections: [
        {
          path: ".archflow/tasks/task-1/phases/2/design.md",
          content_digest: editorialDigest,
        },
      ],
      accounting: {
        schema_version: "1",
        result_bytes: 100 as never,
        task_bytes: 100 as never,
        result_byte_cap: 26_214_400 as never,
        task_byte_cap: 262_144_000 as never,
        counted_entries: [],
        measured_at_revision: 10 as never,
      },
      secret_scan: {
        schema_version: "1",
        outcome: "clean",
        detector_set_id: "default" as any,
        scanned_paths: [],
      },
    };

    const counterDoc = canonicalDocument(counterManifest);
    const produceDoc = canonicalDocument(produceManifest);

    // State has NO rule settlements at all (rule_settlements is empty)
    const state = {
      schema_version: "1",
      task_id: taskId,
      phase_instance: phase,
      step: "produce",
      status: "succeeded",
      attempt: parseSafeInteger(2),
      revision: parseSafeInteger(10),
      input_fingerprint: "1".repeat(64),
      policy_base_commit: headCommit,
      constitution_digest: "3".repeat(64),
      authoritative_results: [
        {
          schema_version: "1",
          phase_instance: phase,
          step: "counter_review",
          result_id: "counter-res" as any,
          result_digest: counterDoc.digest,
          input_fingerprint: "0".repeat(64),
          recorded_at_revision: parseSafeInteger(8),
          retained_bytes: parseSafeInteger(100),
        },
        {
          schema_version: "1",
          phase_instance: phase,
          step: "produce",
          result_id: "produce-res" as any,
          result_digest: produceDoc.digest,
          input_fingerprint: "1".repeat(64),
          recorded_at_revision: parseSafeInteger(10),
          retained_bytes: parseSafeInteger(100),
        },
      ],
      rule_settlements: [],
      approvals: [],
    };

    const configBytes = new TextEncoder().encode("schema_version: '1'\nroles: {}\n");
    const configDigest = sha256Bytes(configBytes);

    const services = {
      state: { value: state } as unknown as any,
      authority: authority.value,
      runner: discovered.value,
      environment: preflight.value,
      dependencies: {
        runner: discovered.value,
        environment: preflight.value,
        read_config: async () => ({
          kind: "valid",
          snapshot: { bytes: configBytes, digest: configDigest, parsed: { schema_version: "1", roles: {} } },
        }),
        load_retained_manifest: async (reference: any) => {
          const doc = reference.step === "counter_review" ? counterDoc : produceDoc;
          return {
            ok: true,
            value: {
              schema_version: "1",
              content_address: `ca-${reference.step}`,
              manifest: doc,
              manifest_target: {
                absolute: `/repo/.archflow/tasks/task-1/authority/results/${doc.digest}.json`,
                relative: `.archflow/tasks/task-1/authority/results/${doc.digest}.json`,
                path_class: "authority-result",
              } as any,
            },
          };
        },
        read_state: async () => ({
          ok: true,
          value: {
            schema_version: "1",
            content_address: "ca-state",
            value: state,
          },
        }),
      },
    } as unknown as ProductionServices;

    const composed = await composeRequest(services, {
      intent_id: "gate-summary-test-fallback",
      kind: "gate",
      summary: "Human design approval for phase 2",
    });

    expect(composed.ok).toBe(true);
    if (!composed.ok) throw new Error(JSON.stringify(composed));
    expect(composed.value.envelope.request.tool).toBe("archflow_gate");
    const input = composed.value.envelope.request.input as Record<string, unknown>;
    expect(input.kind).toBe("design-approval");
    expect(input.subject_digest).toBe(artifactDigest);
    expect(input.context).toMatchObject({
      approval_trigger: {
        kind: "rule-settlement",
        settlement: {
          subject_digest: artifactDigest,
          config_digest: configDigest,
          settled_at_revision: parseSafeInteger(10),
        },
      },
    });
  });
});
