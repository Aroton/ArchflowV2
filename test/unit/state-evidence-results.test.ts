import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { DegradedAdjudication } from "../../src/contracts/adjudication.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import {
  parseSafeCode,
  parseSafeId,
  parseSafeInteger,
  parseSha256Digest,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import type { AgentDeclaredReview, DegradedReview, ReviewEvidence } from "../../src/contracts/review.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import {
  createTestAuthorityLink,
  createTestCurrentReviewSetAuthority,
  createTestVerifiedReferencedEvidence,
} from "../../src/contracts/internal/test-capabilities.js";
import { authorityQualifier, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import {
  createGitRunner,
  preflightGit,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import {
  loadRetainedEvidence,
  prepareEvidenceResult,
} from "../../src/state/evidence-results.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const task = parseTaskSlug("evidence-task");
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 14 as never });
const digest = (character: string) => parseSha256Digest(character.repeat(64));
const environment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const context: RepositoryOperationContext = {
  task_id: task,
  phase_instance: phase,
  operation: parseSafeCode("evidence-result-test"),
  attempt: parseSafeInteger(1),
};
const cleanScanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1",
    outcome: "clean",
    detector_set_id: parseSafeId("test"),
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "archflow-evidence-result-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: environment });
  await writeFile(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root, env: environment });
  execFileSync("git", ["commit", "-qm", "root"], { cwd: root, env: environment });
  await mkdir(join(root, ".archflow", "tasks", task), { recursive: true });
  const runner = createGitRunner({ cwd: root });
  const discovered = await discoverWorktree(runner, context);
  if (!discovered.ok) throw new Error("worktree discovery failed");
  const git = await preflightGit(discovered.value, context);
  if (!git.ok) throw new Error("git preflight failed");
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: git.value,
    task_id: task,
    context,
  });
  if (!authority.ok) throw new Error("authority creation failed");
  return { runner: discovered.value, authority: authority.value };
}

function selfReview(): AgentDeclaredReview {
  return {
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "self_review",
    role: "self-review",
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    rubric_digest: digest("c"),
    producer_family: "claude",
    findings: [],
    matched_rule_versions: [],
    verdict: "pass",
    blocking_count: 0,
    assurance: "agent-declared",
    model_family: "claude",
    model: "claude",
    effort: "high",
  };
}

function counterReview(): DegradedReview {
  return {
    ...selfReview(),
    step: "counter_review",
    role: "counter-review",
    assurance: "degraded",
    model_family: "codex",
    model: "manual",
    effort: "unknown",
    reason: "manual fallback",
  };
}

function qualifyReview(evidence: ReviewEvidence): QualifiedReviewEvidence {
  const evidenceDigest = canonicalJsonDigest(evidence);
  const verified = createTestVerifiedReferencedEvidence("review", {
    evidence_digest: evidenceDigest,
    evidence,
  } as never);
  const authority = evidence.assurance === "agent-declared"
    ? { kind: "agent-declared", result_id: "test", result_digest: digest("8"), state_revision: 1 } as const
    : { kind: "degraded", checkpoint_digest: digest("8"), checkpoint_revision: 1 } as const;
  return authorityQualifier.qualifyReview(createTestAuthorityLink({
    schema_version: "1",
    evidence_kind: "review",
    assurance: evidence.assurance,
    role: evidence.role,
    task_id: evidence.task_id,
    phase_instance: phase,
    subject_digest: evidence.subject_digest,
    input_fingerprint: evidence.input_fingerprint,
    evidence_digest: evidenceDigest,
    authority,
  } as never) as never, verified as never);
}

function stateWithResults(
  authority: Awaited<ReturnType<typeof fixture>>["authority"],
  authoritativeResults: TaskStateV1["authoritative_results"],
): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: authority.repository_identity_digest,
    revision: parseSafeInteger(7),
    phase_instance: phase,
    step: "self_review",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    input_fingerprint: digest("b"),
    initialization_digest: digest("1"),
    config_digest: digest("2"),
    workflow_digest: digest("3"),
    constitution_digest: digest("4"),
    policy_base_commit: "1234567890abcdef1234567890abcdef12345678" as TaskStateV1["policy_base_commit"],
    authoritative_results: authoritativeResults,
    approvals: [],
    waivers: [],
  };
}

describe("evidence result preparation", () => {
  it("separates canonical evidence identity from rendered projection identity", async () => {
    const h = await fixture();
    const evidence = selfReview();
    const prepared = await prepareEvidenceResult({
      authority: h.authority,
      runner: h.runner,
      result_id: parseSafeId("self-result"),
      retained_task_bytes: parseSafeInteger(0),
      measured_at_revision: parseSafeInteger(7),
      scanner: cleanScanner,
      value: { kind: "review", evidence },
    });
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        evidence_digest: canonicalJsonDigest(evidence),
        reference: {
          phase_instance: phase,
          step: "self_review",
          result_id: "self-result",
        },
        prepared: {
          manifest: {
            value: {
              artifact_digest: canonicalJsonDigest(evidence),
              outputs: [{
                path_class: "review",
                operation: "add",
                storage: "raw-payload",
                file_type: "regular",
                after: { mode: "100644" },
              }],
            },
          },
        },
      },
    });
    if (!prepared.ok) return;
    const payload = prepared.value.prepared.payloads[0];
    expect(payload).toBeDefined();
    expect(prepared.value.rendered_digest).toBe(sha256Bytes(payload!.bytes));
    expect(prepared.value.rendered_digest).not.toBe(prepared.value.evidence_digest);
    expect(prepared.value.projection_plan.entries).toHaveLength(1);
    expect(prepared.value.projection_plan.entries[0]?.path).toBe(
      `.archflow/tasks/${task}/reviews/${phase}.self.md`,
    );
  });

  it("uses the exact canonical projection claim for all four evidence steps", async () => {
    const h = await fixture();
    const self = selfReview();
    const counter = counterReview();
    const selfDigest = canonicalJsonDigest(self);
    const counterDigest = canonicalJsonDigest(counter);
    const slots = [
      {
        role: "self-review",
        evidence_digest: selfDigest,
        assurance: "agent-declared",
        producer_family: "claude",
        reviewer_family: "claude",
        independence: "same-family-self",
      },
      {
        role: "counter-review",
        evidence_digest: counterDigest,
        assurance: "degraded",
        producer_family: "claude",
        reviewer_family: "codex",
        independence: "opposite-family",
      },
    ] as const;
    const current = authorityQualifier.currentReviews(
      createTestCurrentReviewSetAuthority({
        task_id: task,
        phase_instance: phase,
        subject_digest: digest("a"),
        input_fingerprint: digest("b"),
        slots,
      }),
      [qualifyReview(self), qualifyReview(counter)],
    );
    const triage = {
      schema_version: "1",
      task_id: task,
      phase_instance: phase,
      step: "triage",
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      current_evidence_set_digest: current.current_evidence_set.set_digest,
      source_evidence_digests: [selfDigest, counterDigest],
      dispositions: [],
      accepted_count: 0,
      rejected_count: 0,
    } as const;
    const rawAdjudication = JSON.parse(await readFile(
      new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url),
      "utf8",
    )) as Record<string, unknown>;
    const adjudication = {
      ...rawAdjudication,
      task_id: task,
      phase_instance: phase,
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      assurance: "degraded",
      model_family: "unknown",
      model: "manual",
      effort: "unknown",
      reason: "manual fallback",
    } as unknown as DegradedAdjudication;
    const values = [
      { value: { kind: "review" as const, evidence: self }, suffix: ".self.md" },
      { value: { kind: "review" as const, evidence: counter }, suffix: ".counter.md" },
      { value: { kind: "triage" as const, current_reviews: current, evidence: triage }, suffix: ".triage.md" },
      { value: { kind: "adjudication" as const, evidence: adjudication }, suffix: ".adjudication.md" },
    ];
    for (const [index, item] of values.entries()) {
      const prepared = await prepareEvidenceResult({
        authority: h.authority,
        runner: h.runner,
        result_id: parseSafeId(`evidence-${index}`),
        retained_task_bytes: parseSafeInteger(0),
        measured_at_revision: parseSafeInteger(7),
        scanner: cleanScanner,
        value: item.value,
      });
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) continue;
      expect(prepared.value.projection_plan.entries[0]?.path).toBe(
        `.archflow/tasks/${task}/reviews/${phase}${item.suffix}`,
      );
    }
  });

  it("reloads only exact phase evidence and rejects a step/source-kind mismatch", async () => {
    const h = await fixture();
    const prepared = await prepareEvidenceResult({
      authority: h.authority,
      runner: h.runner,
      result_id: parseSafeId("self-result"),
      retained_task_bytes: parseSafeInteger(0),
      measured_at_revision: parseSafeInteger(7),
      scanner: cleanScanner,
      value: { kind: "review", evidence: selfReview() },
    });
    if (!prepared.ok) throw new Error("evidence preparation failed");
    const state = stateWithResults(h.authority, [prepared.value.reference]);
    const loaded = await loadRetainedEvidence({
      load_retained_result: async () => ({
        schema_version: "1",
        ok: true,
        value: {
          prepared: prepared.value.prepared,
          manifest_target: prepared.value.manifest_target,
          projection_plan: prepared.value.projection_plan,
          worktree_root: h.runner.location.worktreeRoot as never,
        },
      }),
    }, state, phase);
    expect(loaded).toMatchObject({
      ok: true,
      value: new Map([[
        "self_review",
        { reference: { result_id: "self-result" }, manifest: { step: "self_review" } },
      ]]),
    });

    const wrongReference = {
      ...prepared.value.reference,
      step: "counter_review" as const,
    };
    await expect(loadRetainedEvidence({
      load_retained_result: async () => ({
        schema_version: "1",
        ok: true,
        value: {
          prepared: prepared.value.prepared,
          manifest_target: prepared.value.manifest_target,
          projection_plan: prepared.value.projection_plan,
          worktree_root: h.runner.location.worktreeRoot as never,
        },
      }),
    }, stateWithResults(h.authority, [wrongReference]), phase)).rejects.toThrow(/correlation/);
  });
});
