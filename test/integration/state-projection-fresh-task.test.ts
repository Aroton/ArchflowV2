/**
 * Regression boundary: the first review install on a fresh task. Nothing has
 * created `reviews/` (or any other projection parent) when the first
 * review-evidence result is installed, so the transaction itself must
 * materialize the projection parents. Before this coverage existed, the
 * happy-path first self-review install failed with an opaque INTERNAL_ERROR.
 */
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalDocument,
  canonicalJsonBytes,
  canonicalJsonDigest,
} from "../../src/contracts/canonical.js";
import type { ConfigV1 } from "../../src/contracts/config.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import {
  parseSafeCode,
  parseSafeId,
  parseSafeInteger,
  parseTaskSlug,
  type Sha256Digest,
} from "../../src/contracts/evidence.js";
import {
  computeInputFingerprint,
  type InputFingerprintSubject,
} from "../../src/contracts/fingerprints.js";
import {
  createInternalResultExpectation,
  parseToolCall,
  validateProjectResultStructure,
} from "../../src/contracts/mcp-tools.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import type { ReviewEvidence } from "../../src/contracts/review.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import {
  createGitRunner,
  preflightGit,
  type GitEnvironment,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import type { ResolvedTaskPath } from "../../src/repository/paths.js";
import { createAtomicWriter, createProjectionWriter } from "../../src/state/atomic.js";
import {
  createInternalTransactionAuthority,
  type TransactionAuthority,
} from "../../src/state/authority.js";
import {
  prepareEvidenceResult,
  type PreparedEvidenceResult,
} from "../../src/state/evidence-results.js";
import { createTaskLock } from "../../src/state/lock.js";
import { readIntentReceipt, readTaskState } from "../../src/state/read.js";
import { identifyTransactionRequest } from "../../src/state/request.js";
import {
  prepareResultInstallation,
  runStateTransaction,
  type TransactionDependencies,
} from "../../src/state/transaction.js";
import { planStateTransition } from "../../src/state/transitions.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const task = parseTaskSlug("fresh-review-task");
const constitution = await resolvedConstitutionFixture({
  "00-baseline.md": `---
id: baseline
version: 1
status: active
---
baseline rule
`,
});
const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(3) });
const gitEnvironment = {
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
  operation: parseSafeCode("fresh-projection-proof"),
  attempt: parseSafeInteger(1),
};
const cleanScanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1",
    outcome: "clean",
    detector_set_id: parseSafeId("fresh-projection-test"),
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};
const rubric = {
  schema_version: "1",
  kind: "implementation",
  mode: "adversarial",
  criteria: [{ id: "correctness", text: "The artifact must satisfy the phase design.", blocking: true }],
} as const;
const config: ConfigV1 = {
  schema_version: "1",
  roles: {
    "counter-reviewer": { model: "gpt-fixture", effort: "high" },
    adjudicator: { model: "gpt-fixture", effort: "high" },
  },
};
const SUBJECT: InputFingerprintSubject = {
  schema_version: "1",
  workflow_digest: canonicalJsonDigest({ workflow: 1 }),
  config_digest: canonicalJsonDigest(config as never),
  constitution_digest: constitution.digest,
  artifact_identities: [{
    path: parseRepositoryPathClaim(`.archflow/tasks/${task}/phases/phase-3-output.md`),
    mode: "100644",
    oid: "1".repeat(40) as never,
  }],
  upstream_identities: [],
  rubric_digest: canonicalJsonDigest(rubric),
  phase_instance: phase,
  declared_inputs: [],
};
const FINGERPRINT = computeInputFingerprint(SUBJECT);

type Harness = Readonly<{
  root: string;
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
}>;

function initialState(authority: TransactionAuthority): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: authority.repository_identity_digest,
    revision: parseSafeInteger(7),
    phase_instance: phase,
    step: "produce",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    input_fingerprint: FINGERPRINT,
    initialization_digest: canonicalJsonDigest({ initialization: 1 }),
    config_digest: canonicalJsonDigest(config as never),
    workflow_digest: canonicalJsonDigest({ workflow: 1 }),
    constitution_digest: constitution.digest,
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
}

async function fixture(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "archflow-fresh-projection-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnvironment });
  await writeFile(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root, env: gitEnvironment });
  execFileSync("git", ["commit", "-qm", "root"], { cwd: root, env: gitEnvironment });
  await mkdir(join(root, ".archflow", "tasks", task), { recursive: true });
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error("worktree discovery failed");
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error("git preflight failed");
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: task,
    context,
  });
  if (!authority.ok) throw new Error("authority creation failed");
  await writeFile(authority.value.state.absolute, canonicalDocument(initialState(authority.value)).bytes);
  const dependencies: TransactionDependencies = {
    runner: discovered.value,
    environment: environment.value,
    atomic: createAtomicWriter(),
    lock: createTaskLock(),
    projection_writer: createProjectionWriter(),
    resolve_input_fingerprint: async () => ({
      schema_version: "1",
      ok: true,
      value: structuredClone(SUBJECT),
    }),
    read_state: readTaskState,
    read_config: async () => ({
      kind: "valid",
      snapshot: {
        bytes: canonicalJsonBytes(config as never),
        digest: canonicalJsonDigest(config as never),
      },
    }),
    read_receipt: readIntentReceipt,
    read_retained_task_bytes: async () => parseSafeInteger(0),
  };
  return { root, runner: discovered.value, environment: environment.value, authority: authority.value, dependencies };
}

async function durableState(authority: TransactionAuthority): Promise<TaskStateV1> {
  const read = await readTaskState(authority.state);
  if (read.kind !== "canonical") throw new Error("canonical state missing");
  return read.document.value;
}

function selfReview(subject: Sha256Digest): ReviewEvidence {
  return {
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "self_review",
    role: "self-review",
    subject_digest: subject,
    input_fingerprint: FINGERPRINT,
    rubric_digest: canonicalJsonDigest(rubric),
    producer_family: "claude",
    findings: [],
    matched_rule_versions: [],
    verdict: "pass",
    blocking_count: 0,
    assurance: "agent-declared",
    model_family: "claude",
    model: "claude-fixture",
    effort: "high",
  };
}

async function enterSelfReview(h: Harness, intentId: string): Promise<void> {
  const state = await durableState(h.authority);
  const call = parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: task,
    intent_id: intentId,
    expected_revision: state.revision,
    input_fingerprint: FINGERPRINT,
    phase_instance: phase,
    step: "self_review",
    status: "running",
  });
  const identified = identifyTransactionRequest(call, h.authority, FINGERPRINT);
  const result = await runStateTransaction(h.dependencies, { authority: h.authority, call }, async (document, identifiedCall) => {
    const revision = parseSafeInteger(document.value.revision + 1);
    const success = { path: parseTaskPathClaim("state.json"), revision, status: "running" as const };
    const next = planStateTransition({
      current: document.value,
      target: {
        phase_instance: phase,
        step: "self_review",
        status: "running",
        attempt: document.value.attempt,
        input_fingerprint: FINGERPRINT,
      },
      recomputed_input_fingerprint: FINGERPRINT,
    });
    if (!next.ok) return next;
    return {
      schema_version: "1" as const,
      ok: true as const,
      value: {
        expectation: createInternalResultExpectation({
          schema_version: "1",
          tool: "archflow_state",
          task_id: task,
          intent_id: call.input.intent_id,
          input_fingerprint: FINGERPRINT,
          request_digest: identified.request_digest,
          result_id: `state:${String(revision)}`,
          resulting_revision: revision,
          success,
        }),
        result: validateProjectResultStructure(identifiedCall, { schema_version: "1", ok: true, value: success }),
        next_state: next.value,
      },
    };
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

async function commitSelfReview(
  h: Harness,
  intentId: string,
  prepared: PreparedEvidenceResult,
  evidence: ReviewEvidence,
) {
  const current = await durableState(h.authority);
  const call = parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: task,
    intent_id: intentId,
    expected_revision: current.revision,
    input_fingerprint: prepared.reference.input_fingerprint,
    phase_instance: phase,
    step: prepared.reference.step,
    status: "succeeded",
    artifact: { schema_version: "1", artifact_kind: "review-evidence", evidence },
  });
  const identified = identifyTransactionRequest(call, h.authority, prepared.reference.input_fingerprint);
  const installation = prepareResultInstallation({
    reference: prepared.reference,
    prepared: prepared.prepared,
    manifest_target: prepared.manifest_target,
    projection_plan: prepared.projection_plan,
    worktree_root: h.root as ResolvedTaskPath,
  });
  return runStateTransaction(h.dependencies, { authority: h.authority, call }, async (stateDocument, identifiedCall) => {
    const revision = parseSafeInteger(stateDocument.value.revision + 1);
    const success = { path: parseTaskPathClaim("state.json"), revision, status: "succeeded" as const };
    const next = planStateTransition({
      current: stateDocument.value,
      target: {
        phase_instance: phase,
        step: prepared.reference.step,
        status: "succeeded",
        attempt: stateDocument.value.attempt,
        input_fingerprint: prepared.reference.input_fingerprint,
      },
      recomputed_input_fingerprint: prepared.reference.input_fingerprint,
      artifact: { schema_version: "1", artifact_kind: "review-evidence", evidence },
      result_reference: prepared.reference,
    });
    if (!next.ok) return next;
    return {
      schema_version: "1" as const,
      ok: true as const,
      value: {
        expectation: createInternalResultExpectation({
          schema_version: "1",
          tool: "archflow_state",
          task_id: task,
          intent_id: call.input.intent_id,
          input_fingerprint: prepared.reference.input_fingerprint,
          request_digest: identified.request_digest,
          result_id: prepared.reference.result_id,
          resulting_revision: revision,
          success,
        }),
        result: validateProjectResultStructure(identifiedCall, { schema_version: "1", ok: true, value: success }),
        next_state: next.value,
        result_installation: installation,
      },
    };
  });
}

describe("first review install on a fresh task", () => {
  it("installs the first review projection without any pre-created directories", async () => {
    const h = await fixture();
    await expect(lstat(join(h.authority.task_root, "reviews"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(h.authority.task_root, "results"))).rejects.toMatchObject({ code: "ENOENT" });

    await enterSelfReview(h, "self-running-1");
    const evidence = selfReview(canonicalJsonDigest({ artifact: 0 }));
    const state = await durableState(h.authority);
    const prepared = await prepareEvidenceResult({
      authority: h.authority,
      runner: h.runner,
      result_id: parseSafeId("self-v1"),
      retained_task_bytes: await h.dependencies.read_retained_task_bytes!(),
      measured_at_revision: state.revision,
      scanner: cleanScanner,
      value: { kind: "review", evidence },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const entry = prepared.value.projection_plan.entries[0]!;
    expect(entry.target.path_class).toBe("review");

    const result = await commitSelfReview(h, "self-intent-1", prepared.value, evidence);
    expect(result).toMatchObject({ ok: true });

    expect((await lstat(join(h.authority.task_root, "reviews"))).isDirectory()).toBe(true);
    const desired = entry.desired;
    if (desired.state !== "present" || desired.file_type !== "regular") throw new Error("expected a regular projection");
    expect(await readFile(entry.target.absolute)).toEqual(Buffer.from(desired.bytes));
  });
});
