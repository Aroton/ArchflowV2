import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalDocument,
  canonicalJsonBytes,
  canonicalJsonDigest,
  gitBlobOid,
  parseCanonicalDocument,
  sha256Bytes,
} from "../../src/contracts/canonical.js";
import type { AdjudicationEvidence } from "../../src/contracts/adjudication.js";
import type { ConfigV1 } from "../../src/contracts/config.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type {
  AuthoritativeResultRef,
  TaskStateV1,
} from "../../src/contracts/durable-state.js";
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
  type ParsedToolCall,
} from "../../src/contracts/mcp-tools.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import type { ReviewEvidence } from "../../src/contracts/review.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import type { CurrentReviewSet } from "../../src/contracts/trust.js";
import { validateTriage, type TriageCandidate } from "../../src/contracts/triage.js";
import {
  createGitRunner,
  preflightGit,
  type GitEnvironment,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import {
  discoverWorktree,
  type RootBoundGitRunner,
} from "../../src/repository/identity.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import {
  runAdjudication,
  type RunAdjudicationDependencies,
  type RunAdjudicationInput,
} from "../../src/review/adjudication.js";
import { runCounterReview } from "../../src/review/counter-review.js";
import {
  assessCurrentEvidence,
  type EvidenceAssessment,
} from "../../src/review/fixed-point.js";
import { createAtomicWriter, createProjectionWriter } from "../../src/state/atomic.js";
import {
  createInternalTransactionAuthority,
  type TransactionAuthority,
} from "../../src/state/authority.js";
import {
  loadCurrentReviewSet,
  loadRetainedEvidence,
  prepareEvidenceResult,
  type EvidenceResultValue,
  type PreparedEvidenceResult,
} from "../../src/state/evidence-results.js";
import { createTaskLock } from "../../src/state/lock.js";
import { readIntentReceipt, readTaskState } from "../../src/state/read.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";
import { identifyTransactionRequest } from "../../src/state/request.js";
import { deriveDeclaredSnapshotDigest } from "../../src/state/snapshots.js";
import {
  prepareResultInstallation,
  runStateTransaction,
  type TransactionDependencies,
} from "../../src/state/transaction.js";
import { planStateTransition } from "../../src/state/transitions.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

const task = parseTaskSlug("fixed-point-task");
const constitution = await resolvedConstitutionFixture({
  "00-retired.md": `---
id: retired
version: 1
status: deprecated
---
retired rule
`,
});
const phase = encodePhaseInstance({
  kind: "phase-impl",
  phase: parsePositiveSafePhaseNumber(14),
});
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
  operation: parseSafeCode("fixed-point-proof"),
  attempt: parseSafeInteger(1),
};
const cleanScanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1",
    outcome: "clean",
    detector_set_id: parseSafeId("fixed-point-test"),
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};
const rubric = {
  schema_version: "1",
  kind: "implementation",
  mode: "adversarial",
  criteria: [{
    id: "correctness",
    text: "The artifact must satisfy the phase design.",
    blocking: true,
  }],
} as const;
const rubricDigest = canonicalJsonDigest(rubric);
const config: ConfigV1 = {
  schema_version: "1",
  roles: {
    "counter-reviewer": { model: "gpt-fixture", effort: "high" },
    adjudicator: { model: "gpt-fixture", effort: "high" },
  },
};

type Harness = Readonly<{
  root: string;
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
}>;
type StateCall = Extract<ParsedToolCall, { name: "archflow_state" }>;

function fingerprintSubject(version: number): InputFingerprintSubject {
  return {
    schema_version: "1",
    workflow_digest: canonicalJsonDigest({ workflow: 1 }),
    config_digest: canonicalJsonDigest(config as never),
    constitution_digest: constitution.digest,
    artifact_identities: [{
      path: parseRepositoryPathClaim(
        `.archflow/tasks/${task}/phases/phase-14-output.md`,
      ),
      mode: "100644",
      oid: `${String(version + 1).repeat(40)}` as never,
    }],
    upstream_identities: [],
    rubric_digest: rubricDigest,
    phase_instance: phase,
    declared_inputs: [],
  };
}

function initialState(
  authority: TransactionAuthority,
  fingerprint: Sha256Digest,
): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: authority.repository_identity_digest,
    revision: parseSafeInteger(7),
    phase_instance: phase,
    step: "produce",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    input_fingerprint: fingerprint,
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

async function retainedResult(
  root: string,
  reference: AuthoritativeResultRef,
) {
  const manifestTarget = {
    absolute: join(root, reference.manifest_path) as ResolvedTaskPath,
    repositoryRelative: reference.manifest_path,
    path_class: "result-manifest",
  } as const satisfies ResolvedPath;
  const manifest = parseCanonicalDocument<ResultManifestV1>(
    await readFile(manifestTarget.absolute),
  );
  const payloads = await Promise.all(manifest.value.outputs
    .filter((output) => output.storage === "raw-payload")
    .map(async (output) => {
      const target = {
        absolute: join(
          root,
          `.archflow/tasks/${task}/results/sha256/${reference.result_digest}/payload/${output.path}`,
        ) as ResolvedTaskPath,
        repositoryRelative: parseRepositoryPathClaim(
          `.archflow/tasks/${task}/results/sha256/${reference.result_digest}/payload/${output.path}`,
        ),
        path_class: "result-payload",
      } as const satisfies ResolvedPath;
      return {
        path: output.path,
        target,
        bytes: new Uint8Array(await readFile(target.absolute)),
      };
    }));
  return {
    schema_version: "1" as const,
    ok: true as const,
    value: {
      prepared: { manifest, result_digest: manifest.digest, payloads },
      manifest_target: manifestTarget,
      projection_plan: {
        entries: [] as const,
        collisions: [] as const,
        collision_choices: [
          "discard-and-restore",
          "adopt-as-new-generation",
          "abort",
        ] as const,
      },
      worktree_root: root as ResolvedTaskPath,
    },
  };
}

async function createDependencies(
  root: string,
  runner: RootBoundGitRunner,
  environment: GitEnvironment,
  authority: TransactionAuthority,
  subject: InputFingerprintSubject,
): Promise<TransactionDependencies> {
  return {
    runner,
    environment,
    atomic: createAtomicWriter(),
    lock: createTaskLock(),
    projection_writer: createProjectionWriter(),
    resolve_input_fingerprint: async () => ({
      schema_version: "1",
      ok: true,
      value: structuredClone(subject),
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
    read_retained_task_bytes: async (excluded) => {
      const read = await readTaskState(authority.state);
      if (read.kind !== "canonical") return parseSafeInteger(0);
      let bytes = 0;
      for (const reference of read.document.value.authoritative_results) {
        if (reference.result_digest === excluded?.result_digest) continue;
        const loaded = await retainedResult(root, reference);
        bytes += loaded.value.prepared.manifest.value.accounting.result_bytes;
      }
      return parseSafeInteger(bytes);
    },
    load_retained_result: (reference) => retainedResult(root, reference),
  };
}

async function fixture(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "archflow-fixed-point-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: root,
    env: gitEnvironment,
  });
  await writeFile(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root, env: gitEnvironment });
  execFileSync("git", ["commit", "-qm", "root"], {
    cwd: root,
    env: gitEnvironment,
  });
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
  const subject = fingerprintSubject(0);
  await writeFile(
    authority.value.state.absolute,
    canonicalDocument(initialState(
      authority.value,
      computeInputFingerprint(subject),
    )).bytes,
  );
  return {
    root,
    runner: discovered.value,
    environment: environment.value,
    authority: authority.value,
    dependencies: await createDependencies(
      root,
      discovered.value,
      environment.value,
      authority.value,
      subject,
    ),
  };
}

async function durableState(authority: TransactionAuthority): Promise<TaskStateV1> {
  const read = await readTaskState(authority.state);
  if (read.kind !== "canonical") throw new Error("canonical state missing");
  return read.document.value;
}

function reviewOutput(
  role: "self-review" | "counter-review",
  subject: Sha256Digest,
  fingerprint: Sha256Digest,
  finding: "accepted" | "blocker" | "clean",
) {
  const findings = finding === "clean"
    ? []
    : [{
        finding_id: `${role}-${finding}`,
        severity: finding === "blocker" ? "blocker" as const : "major" as const,
        blocking: finding === "blocker",
        summary: `${finding} finding`,
        evidence: "fixture evidence",
        suggested_resolution: "rewrite the artifact",
      }];
  return {
    schema_version: "1" as const,
    task_id: task,
    phase_instance: phase,
    step: role === "self-review" ? "self_review" as const : "counter_review" as const,
    role,
    subject_digest: subject,
    input_fingerprint: fingerprint,
    rubric_digest: rubricDigest,
    producer_family: "claude" as const,
    findings,
    matched_rule_versions: [],
    verdict: finding === "clean"
      ? "pass" as const
      : finding === "blocker" ? "fail" as const : "advisory" as const,
    blocking_count: finding === "blocker" ? 1 : 0,
  };
}

function selfReview(
  subject: Sha256Digest,
  fingerprint: Sha256Digest,
  finding: "accepted" | "blocker" | "clean",
): ReviewEvidence {
  return {
    ...reviewOutput("self-review", subject, fingerprint, finding),
    assurance: "agent-declared",
    model_family: "claude",
    model: "claude-fixture",
    effort: "high",
  };
}

function triageCandidate(
  current: CurrentReviewSet,
  accepted: boolean,
): TriageCandidate {
  const dispositions = current.reviews.flatMap((review) =>
    review.evidence.findings.map((finding) => accepted
      ? {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "accepted" as const,
          rationale: "rewrite required",
          revision_intent: "rewrite" as const,
        }
      : {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "rejected" as const,
          rationale: "not applicable",
          evidence: "fixture rejection evidence",
        }));
  return {
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "triage",
    subject_digest: current.subject_digest,
    input_fingerprint: current.input_fingerprint,
    current_evidence_set_digest: current.current_evidence_set.set_digest,
    source_evidence_digests: current.reviews.map((review) => review.evidence_digest),
    dispositions,
    accepted_count: accepted ? dispositions.length : 0,
    rejected_count: accepted ? 0 : dispositions.length,
  };
}

async function prepareEvidence(
  h: Harness,
  resultId: string,
  value: EvidenceResultValue,
): Promise<PreparedEvidenceResult> {
  const current = await durableState(h.authority);
  const prepared = await prepareEvidenceResult({
    authority: h.authority,
    runner: h.runner,
    result_id: parseSafeId(resultId),
    retained_task_bytes: await h.dependencies.read_retained_task_bytes!(),
    measured_at_revision: current.revision,
    scanner: cleanScanner,
    value,
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  for (const payload of prepared.value.prepared.payloads) {
    await mkdir(dirname(payload.target.absolute), { recursive: true });
  }
  await mkdir(dirname(prepared.value.manifest_target.absolute), { recursive: true });
  for (const entry of prepared.value.projection_plan.entries) {
    await mkdir(dirname(entry.target.absolute), { recursive: true });
  }
  return prepared.value;
}

async function commitStateEvidence(
  h: Harness,
  dependencies: TransactionDependencies,
  intentId: string,
  prepared: PreparedEvidenceResult,
  artifact: NonNullable<StateCall["input"]["artifact"]>,
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
    artifact,
  });
  const identified = identifyTransactionRequest(
    call,
    h.authority,
    prepared.reference.input_fingerprint,
  );
  const installation = prepareResultInstallation({
    reference: prepared.reference,
    prepared: prepared.prepared,
    manifest_target: prepared.manifest_target,
    projection_plan: prepared.projection_plan,
    worktree_root: h.root as ResolvedTaskPath,
  });
  const result = await runStateTransaction(
    dependencies,
    { authority: h.authority, call },
    async (stateDocument, identifiedCall) => {
      const revision = parseSafeInteger(stateDocument.value.revision + 1);
      const success = {
        path: parseTaskPathClaim("state.json"),
        revision,
        status: "succeeded" as const,
      };
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
        artifact,
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
          result: validateProjectResultStructure(identifiedCall, {
            schema_version: "1",
            ok: true,
            value: success,
          }),
          next_state: next.value,
          result_installation: installation,
        },
      };
    },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

async function enterStep(
  h: Harness,
  dependencies: TransactionDependencies,
  intentId: string,
  step: TaskStateV1["step"],
  fingerprint: Sha256Digest,
) {
  const state = await durableState(h.authority);
  const call = parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: task,
    intent_id: intentId,
    expected_revision: state.revision,
    input_fingerprint: fingerprint,
    phase_instance: phase,
    step,
    status: "running",
  });
  const identified = identifyTransactionRequest(call, h.authority, fingerprint);
  const result = await runStateTransaction(
    dependencies,
    { authority: h.authority, call },
    async (document, identifiedCall) => {
      const revision = parseSafeInteger(document.value.revision + 1);
      const success = {
        path: parseTaskPathClaim("state.json"),
        revision,
        status: "running" as const,
      };
      const next = planStateTransition({
        current: document.value,
        target: {
          phase_instance: phase,
          step,
          status: "running",
          attempt: step === "produce"
            ? parseSafeInteger(document.value.attempt + 1)
            : document.value.attempt,
          input_fingerprint: fingerprint,
        },
        recomputed_input_fingerprint: fingerprint,
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
            input_fingerprint: fingerprint,
            request_digest: identified.request_digest,
            result_id: call.input.intent_id,
            resulting_revision: revision,
            success,
          }),
          result: validateProjectResultStructure(identifiedCall, {
            schema_version: "1",
            ok: true,
            value: success,
          }),
          next_state: next.value,
        },
      };
    },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

async function commitSelf(
  h: Harness,
  dependencies: TransactionDependencies,
  version: number,
  evidence: ReviewEvidence,
) {
  await enterStep(
    h,
    dependencies,
    `self-running-v${version}`,
    "self_review",
    evidence.input_fingerprint,
  );
  const prepared = await prepareEvidence(h, `self-v${version}`, {
    kind: "review",
    evidence,
  });
  await commitStateEvidence(h, dependencies, `self-intent-v${version}`, prepared, {
    schema_version: "1",
    artifact_kind: "review-evidence",
    evidence,
  });
}

async function reconstruct(
  h: Harness,
  dependencies: TransactionDependencies,
): Promise<CurrentReviewSet> {
  const loaded = await loadCurrentReviewSet({
    read_state: readTaskState,
    load_retained_result: dependencies.load_retained_result!,
  }, h.authority, phase);
  if (!loaded.ok) throw new Error(loaded.error.code);
  return loaded.value;
}

async function commitTriage(
  h: Harness,
  dependencies: TransactionDependencies,
  version: number,
  accepted: boolean,
) {
  const fingerprint = (await durableState(h.authority)).input_fingerprint;
  await enterStep(
    h,
    dependencies,
    `triage-running-v${version}`,
    "triage",
    fingerprint,
  );
  const current = await reconstruct(h, dependencies);
  const candidate = triageCandidate(current, accepted);
  validateTriage(current, candidate);
  const prepared = await prepareEvidence(h, `triage-v${version}`, {
    kind: "triage",
    current_reviews: current,
    evidence: candidate,
  });
  await commitStateEvidence(h, dependencies, `triage-intent-v${version}`, prepared, {
    schema_version: "1",
    artifact_kind: "triage",
    evidence: candidate,
  });
}

async function commitCounter(
  h: Harness,
  dependencies: TransactionDependencies,
  version: number,
  subject: Sha256Digest,
  fingerprint: Sha256Digest,
  finding: "accepted" | "blocker" | "clean",
) {
  await enterStep(
    h,
    dependencies,
    `counter-running-v${version}`,
    "counter_review",
    fingerprint,
  );
  const runningState = await durableState(h.authority);
  const resultId = `counter-v${version}`;
  const call = parseToolCall("archflow_counter_review", {
    schema_version: "1",
    task_id: task,
    intent_id: `counter-intent-v${version}`,
    expected_revision: runningState.revision,
    input_fingerprint: fingerprint,
    artifact_path: parseTaskPathClaim("phases/phase-14-output.md"),
    rubric,
  });
  const result = await runCounterReview({
    transaction: dependencies,
    reobserve_projection_digest: async () => ({
      schema_version: "1",
      ok: true,
      value: subject,
    }),
    dispatch: async () => ({
      cli_version: "fixture-1",
      extracted_output_bytes: canonicalJsonBytes(
        reviewOutput("counter-review", subject, fingerprint, finding),
      ),
    }),
    prepare_evidence: async (evidence, measuredAtRevision) => {
      const prepared = await prepareEvidenceResult({
        authority: h.authority,
        runner: h.runner,
        result_id: parseSafeId(resultId),
        retained_task_bytes: await dependencies.read_retained_task_bytes!(),
        measured_at_revision: measuredAtRevision,
        scanner: cleanScanner,
        value: { kind: "review", evidence },
      });
      if (prepared.ok) {
        for (const payload of prepared.value.prepared.payloads) {
          await mkdir(dirname(payload.target.absolute), { recursive: true });
        }
        await mkdir(dirname(prepared.value.manifest_target.absolute), { recursive: true });
        for (const entry of prepared.value.projection_plan.entries) {
          await mkdir(dirname(entry.target.absolute), { recursive: true });
        }
      }
      return prepared;
    },
  }, {
    authority: h.authority,
    call,
    config,
    phase_kind: "phase-impl",
    producer_family: "claude",
    measured_at_revision: runningState.revision,
    envelope: {
      artifact: `artifact-v${version}`,
      rubric,
      subject: {
        task_id: task,
        phase_instance: phase,
        role: "counter-review",
        step: "counter_review",
        subject_digest: subject,
        input_fingerprint: fingerprint,
        rubric_digest: rubricDigest,
        producer_family: "claude",
        invocation_id: `counter-invocation-v${version}`,
        result_id: resultId,
      },
    },
    projection_digest: subject,
  });
  if (!result.ok) throw new Error(result.error.code);
}

async function rewrite(
  h: Harness,
  dependencies: TransactionDependencies,
  version: number,
): Promise<TransactionDependencies> {
  const subject = fingerprintSubject(version);
  const fingerprint = computeInputFingerprint(subject);
  const restarted = await createDependencies(
    h.root,
    h.runner,
    h.environment,
    h.authority,
    subject,
  );
  await enterStep(
    h,
    restarted,
    `rewrite-running-v${version}`,
    "produce",
    fingerprint,
  );
  const state = await durableState(h.authority);
  const bytes = new TextEncoder().encode(`artifact-v${version}\n`);
  const outputPath = parseRepositoryPathClaim(
    `.archflow/tasks/${task}/phases/phase-14-output.md`,
  );
  const byteCount = parseSafeInteger(bytes.byteLength);
  const contentDigest = sha256Bytes(bytes);
  const output = {
    path: outputPath,
    path_class: "document" as const,
    operation: "add" as const,
    storage: "raw-payload" as const,
    payload_bytes: byteCount,
    payload_digest: contentDigest,
    file_type: "regular" as const,
    after: { oid: gitBlobOid(bytes), mode: "100644" as const, size_bytes: byteCount },
  };
  const projections = [{ path: outputPath, content_digest: contentDigest }];
  const snapshotDigest = deriveDeclaredSnapshotDigest([output], projections);
  const artifact: DocumentArtifactV1 = {
    schema_version: "1",
    artifact_kind: "document",
    task_id: task,
    phase_instance: phase,
    step: "produce",
    document_path: parseTaskPathClaim("phases/phase-14-output.md"),
    path_class: "document",
    byte_count: byteCount,
    content_digest: contentDigest,
    declared_inputs: [],
    input_fingerprint: fingerprint,
    snapshot_digest: snapshotDigest,
    projection_target: outputPath,
  };
  const resultId = parseSafeId(`rewrite-v${version}`);
  const retainedBytes = await restarted.read_retained_task_bytes!();
  const manifestValue: ResultManifestV1 = {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: h.authority.repository_identity_digest,
    result_id: resultId,
    phase_instance: phase,
    step: "produce",
    artifact_digest: canonicalJsonDigest(artifact),
    source_artifact: artifact,
    input_fingerprint: fingerprint,
    snapshot_digest: snapshotDigest,
    outputs: [output],
    projections,
    accounting: {
      schema_version: "1",
      result_bytes: byteCount,
      task_bytes: parseSafeInteger(retainedBytes + byteCount),
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: [{
        path: outputPath,
        storage: "raw-payload",
        stored_bytes: byteCount,
      }],
      measured_at_revision: state.revision,
    },
    secret_scan: {
      schema_version: "1",
      outcome: "clean",
      detector_set_id: parseSafeId("fixed-point-test"),
      scanned_paths: [outputPath],
    },
  };
  const manifest = canonicalDocument(manifestValue);
  const manifestPath = parseRepositoryPathClaim(
    `.archflow/tasks/${task}/results/sha256/${manifest.digest}/manifest.json`,
  );
  const payloadPath = parseRepositoryPathClaim(
    `.archflow/tasks/${task}/results/sha256/${manifest.digest}/payload/${outputPath}`,
  );
  const reference: AuthoritativeResultRef = {
    phase_instance: phase,
    step: "produce",
    result_digest: manifest.digest,
    result_id: resultId,
    input_fingerprint: fingerprint,
    manifest_path: manifestPath,
  };
  const installation = prepareResultInstallation({
    reference,
    prepared: {
      manifest,
      result_digest: manifest.digest,
      payloads: [{
        path: outputPath,
        bytes,
        target: {
          absolute: join(h.root, payloadPath) as ResolvedTaskPath,
          repositoryRelative: payloadPath,
          path_class: "result-payload",
        },
      }],
    },
    manifest_target: {
      absolute: join(h.root, manifestPath) as ResolvedTaskPath,
      repositoryRelative: manifestPath,
      path_class: "result-manifest",
    },
    projection_plan: {
      entries: [],
      collisions: [],
      collision_choices: [
        "discard-and-restore",
        "adopt-as-new-generation",
        "abort",
      ],
    },
    worktree_root: h.root as ResolvedTaskPath,
  });
  await mkdir(dirname(join(h.root, payloadPath)), { recursive: true });
  await mkdir(dirname(join(h.root, manifestPath)), { recursive: true });
  const call = parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: task,
    intent_id: `rewrite-intent-v${version}`,
    expected_revision: state.revision,
    input_fingerprint: fingerprint,
    phase_instance: phase,
    step: "produce",
    status: "succeeded",
    artifact,
  });
  const identified = identifyTransactionRequest(call, h.authority, fingerprint);
  const result = await runStateTransaction(
    restarted,
    { authority: h.authority, call },
    async (document, identifiedCall) => {
      const revision = parseSafeInteger(document.value.revision + 1);
      const success = {
        path: parseTaskPathClaim("state.json"),
        revision,
        status: "succeeded" as const,
      };
      const next = planStateTransition({
        current: document.value,
        target: {
          phase_instance: phase,
          step: "produce",
          status: "succeeded",
          attempt: document.value.attempt,
          input_fingerprint: fingerprint,
        },
        recomputed_input_fingerprint: fingerprint,
        artifact,
        result_reference: reference,
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
            input_fingerprint: fingerprint,
            request_digest: identified.request_digest,
            result_id: reference.result_id,
            resulting_revision: revision,
            success,
          }),
          result: validateProjectResultStructure(identifiedCall, {
            schema_version: "1",
            ok: true,
            value: success,
          }),
          next_state: next.value,
          result_installation: installation,
        },
      };
    },
  );
  if (!result.ok) throw new Error(result.error.code);
  return restarted;
}

async function assessment(
  h: Harness,
  dependencies: TransactionDependencies,
  subject: Sha256Digest,
  fingerprint: Sha256Digest,
): Promise<EvidenceAssessment> {
  const state = await durableState(h.authority);
  const loaded = await loadRetainedEvidence({
    load_retained_result: dependencies.load_retained_result!,
  }, structuredClone(state), phase);
  if (!loaded.ok) throw new Error(loaded.error.code);
  return assessCurrentEvidence(state, loaded.value, {
    subject_digest: subject,
    input_fingerprint: fingerprint,
    constitution,
  });
}

async function commitAdjudication(
  h: Harness,
  dependencies: TransactionDependencies,
  subject: Sha256Digest,
  fingerprint: Sha256Digest,
  current: CurrentReviewSet,
) {
  await enterStep(
    h,
    dependencies,
    "adjudication-running-v2",
    "adjudicate",
    fingerprint,
  );
  const state = await durableState(h.authority);
  const resultId = "adjudication-v2";
  const call = parseToolCall("archflow_adjudicate", {
    schema_version: "1",
    task_id: task,
    intent_id: "adjudication-intent-v2",
    expected_revision: state.revision,
    input_fingerprint: fingerprint,
    artifact_path: parseTaskPathClaim("phases/phase-14-output.md"),
    upstream_paths: [],
  });
  const output = {
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "adjudicate",
    subject_digest: subject,
    input_fingerprint: fingerprint,
    pinned_constitution_digest: state.constitution_digest,
    approved_upstream_digests: [],
    source_evidence_set_digest: current.current_evidence_set.set_digest,
    rule_findings: [],
    drift_findings: [],
    constitution: "pass",
    drift: "aligned",
    matched_rule_versions: [],
    uncertain_rule_versions: [],
  } satisfies Omit<AdjudicationEvidence,
    "assurance" | "adapter" | "cli_version" | "model_family" | "model" |
    "effort" | "invocation_id" | "envelope_input_digest" |
    "observed_output_digest" | "result_id">;
  const serviceDependencies: RunAdjudicationDependencies = {
    transaction: dependencies,
    load_constitution: async (policyBaseCommit) => {
      expect(policyBaseCommit).toBe(state.policy_base_commit);
      return { schema_version: "1", ok: true, value: constitution };
    },
    load_current_review_set: async (authority, phaseInstance) =>
      loadCurrentReviewSet({
        read_state: dependencies.read_state,
        load_retained_result: dependencies.load_retained_result!,
      }, authority, phaseInstance),
    dispatch: async () => ({
      cli_version: "fixture-1",
      extracted_output_bytes: canonicalJsonBytes(output),
    }),
    prepare_evidence: async (evidence, measuredAtRevision) => {
      const prepared = await prepareEvidenceResult({
        authority: h.authority,
        runner: h.runner,
        result_id: parseSafeId(resultId),
        retained_task_bytes: await dependencies.read_retained_task_bytes!(),
        measured_at_revision: measuredAtRevision,
        scanner: cleanScanner,
        value: { kind: "adjudication", evidence },
      });
      if (prepared.ok) {
        for (const payload of prepared.value.prepared.payloads) {
          await mkdir(dirname(payload.target.absolute), { recursive: true });
        }
        await mkdir(dirname(prepared.value.manifest_target.absolute), { recursive: true });
        for (const entry of prepared.value.projection_plan.entries) {
          await mkdir(dirname(entry.target.absolute), { recursive: true });
        }
      }
      return prepared;
    },
    detect_constitution_edit: async () => ({
      schema_version: "1",
      ok: true,
      value: undefined,
    }),
    derive_approved_upstreams: async () => ({
      schema_version: "1",
      ok: true,
      value: [],
    }),
    open_gate: async () => {
      throw new Error("clean adjudication must not open a gate");
    },
  };
  const serviceInput: RunAdjudicationInput = {
    authority: h.authority,
    call,
    config,
    phase_kind: "phase-impl",
    producer_family: "claude",
    envelope: {
      artifact: "artifact-v2",
      rules: [],
      source_evidence_set_digest: current.current_evidence_set.set_digest,
      subject: {
        task_id: task,
        phase_instance: phase,
        role: "adjudication",
        step: "adjudicate",
        subject_digest: subject,
        input_fingerprint: fingerprint,
        pinned_constitution_digest: state.constitution_digest,
        approved_upstream_digests: [],
        source_evidence_set_digest: current.current_evidence_set.set_digest,
        invocation_id: "adjudication-invocation-v2",
        result_id: resultId,
      },
    },
  };
  const forgedSetDigest = "9".repeat(64) as Sha256Digest;
  await expect(runAdjudication({
    ...serviceDependencies,
    load_constitution: async () => ({
      schema_version: "1",
      ok: true,
      value: { ...constitution },
    }),
  }, serviceInput)).rejects.toThrow(/authentic resolved constitution/u);
  await expect(runAdjudication(serviceDependencies, {
    ...serviceInput,
    envelope: {
      ...serviceInput.envelope,
      rules: [{
        id: "invented",
        version: 1,
        text: "not pinned",
        enforced_by: [],
      }],
    },
  })).rejects.toThrow(/constitution is not durably pinned/u);
  await expect(runAdjudication(serviceDependencies, {
    ...serviceInput,
    envelope: {
      ...serviceInput.envelope,
      subject: {
        ...serviceInput.envelope.subject,
        pinned_constitution_digest: forgedSetDigest,
      },
    },
  })).rejects.toThrow(/constitution is not durably pinned/u);
  await expect(runAdjudication(serviceDependencies, {
    ...serviceInput,
    envelope: {
      ...serviceInput.envelope,
      source_evidence_set_digest: forgedSetDigest,
      subject: {
        ...serviceInput.envelope.subject,
        source_evidence_set_digest: forgedSetDigest,
      },
    },
  })).rejects.toThrow(/source review set is not durably current/u);

  const malformed = await runAdjudication({
    ...serviceDependencies,
    dispatch: async () => ({
      cli_version: "fixture-1",
      extracted_output_bytes: canonicalJsonBytes({
        schema_version: "1",
        malformed: true,
      }),
    }),
  }, serviceInput);
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) {
    expect(malformed.error.code).toBe("MODEL_OUTPUT_INVALID");
    expect(malformed.error.diagnostic.parameters).toMatchObject({
      adapter: "codex-cli",
      attempt: 1,
      issue_code: "adjudication-output-invalid",
    });
  }
  expect((await durableState(h.authority)).revision).toBe(state.revision);

  const missingApprovalDigest = "8".repeat(64) as Sha256Digest;
  const missingApproval = await runAdjudication({
    ...serviceDependencies,
    derive_approved_upstreams: async () => ({
      schema_version: "1",
      ok: true,
      value: [{
        upstream_digest: missingApprovalDigest,
        artifact: "unapproved upstream",
      }],
    }),
    dispatch: async () => {
      throw new Error("an unapproved upstream must stop before dispatch");
    },
  }, {
    ...serviceInput,
    envelope: {
      ...serviceInput.envelope,
      subject: {
        ...serviceInput.envelope.subject,
        approved_upstream_digests: [missingApprovalDigest],
      },
    },
  });
  expect(missingApproval.ok).toBe(false);
  if (!missingApproval.ok) {
    expect(missingApproval.error.code).toBe("STATE_INVALID");
    expect(missingApproval.error.diagnostic.parameters).toMatchObject({
      issue_code: "upstream-approval-missing",
    });
  }
  expect((await durableState(h.authority)).revision).toBe(state.revision);

  const result = await runAdjudication(serviceDependencies, serviceInput);
  if (!result.ok) throw new Error(result.error.code);
  expect(result.value.gate).toBeUndefined();
}

describe("durable review fixed point", () => {
  it("restarts twice and advances only after the final clean adjudication", async () => {
    const h = await fixture();
    let dependencies = h.dependencies;
    const subjects = [0, 1, 2].map((version) =>
      canonicalJsonDigest({ artifact: version }));
    const fingerprints = [0, 1, 2].map((version) =>
      computeInputFingerprint(fingerprintSubject(version)));

    await commitSelf(h, dependencies, 0,
      selfReview(subjects[0]!, fingerprints[0]!, "accepted"));
    await commitCounter(h, dependencies, 0,
      subjects[0]!, fingerprints[0]!, "clean");
    await commitTriage(h, dependencies, 0, true);
    expect(await assessment(h, dependencies, subjects[0]!, fingerprints[0]!))
      .toMatchObject({ reentry_required: true, next: "produce" });
    expect((await durableState(h.authority)).authoritative_results
      .some((reference) => reference.step === "adjudicate")).toBe(false);

    dependencies = await rewrite(h, dependencies, 1);
    expect(await assessment(h, dependencies, subjects[1]!, fingerprints[1]!))
      .toMatchObject({
        current: [],
        stale: ["self_review", "counter_review", "triage"],
        next: "self_review",
      });

    await commitSelf(h, dependencies, 1,
      selfReview(subjects[1]!, fingerprints[1]!, "accepted"));
    await commitCounter(h, dependencies, 1,
      subjects[1]!, fingerprints[1]!, "blocker");
    expect(await assessment(h, dependencies, subjects[1]!, fingerprints[1]!))
      .toMatchObject({ blocker_remains: false, next: "triage" });
    expect((await assessment(h, dependencies, subjects[1]!, fingerprints[1]!)).next)
      .not.toBe("advance");
    await commitTriage(h, dependencies, 1, true);
    expect(await assessment(h, dependencies, subjects[1]!, fingerprints[1]!))
      .toMatchObject({ reentry_required: true, next: "produce" });
    expect((await durableState(h.authority)).authoritative_results
      .some((reference) => reference.step === "adjudicate")).toBe(false);

    dependencies = await rewrite(h, dependencies, 2);
    await commitSelf(h, dependencies, 2,
      selfReview(subjects[2]!, fingerprints[2]!, "clean"));
    await commitCounter(h, dependencies, 2,
      subjects[2]!, fingerprints[2]!, "clean");
    const finalReviews = await reconstruct(h, dependencies);
    await commitTriage(h, dependencies, 2, false);
    expect(await assessment(h, dependencies, subjects[2]!, fingerprints[2]!))
      .toMatchObject({ blocker_remains: false, next: "adjudicate" });
    await commitAdjudication(
      h,
      dependencies,
      subjects[2]!,
      fingerprints[2]!,
      finalReviews,
    );

    // Simulate a process restart: rebuild all dependencies and derive authority only
    // from canonical state plus retained manifests on disk.
    dependencies = await createDependencies(
      h.root,
      h.runner,
      h.environment,
      h.authority,
      fingerprintSubject(2),
    );
    const restartedReviews = await reconstruct(h, dependencies);
    expect(restartedReviews.subject_digest).toBe(subjects[2]);
    expect(await assessment(h, dependencies, subjects[2]!, fingerprints[2]!))
      .toMatchObject({
        current: ["self_review", "counter_review", "triage", "adjudicate"],
        stale: [],
        blocker_remains: false,
        reentry_required: false,
        next: "advance",
      });
    expect((await durableState(h.authority)).authoritative_results
      .map((reference) => reference.step).sort()).toEqual([
        "adjudicate",
        "counter_review",
        "produce",
        "self_review",
        "triage",
      ]);
  });
});
