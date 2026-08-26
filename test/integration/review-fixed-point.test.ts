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
import type { ConfigV1, TaskConfigSnapshot } from "../../src/contracts/config.js";
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
import { REPOSITORY_VIEW_NOTE } from "../../src/review/envelopes.js";
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
import { serializeDispatch } from "../../src/dispatch/cli.js";
import {
  parseWorkspacePathClaim,
  type ResolvedPath,
  type ResolvedTaskPath,
  type ResolvedTaskWorkspacePath,
  type ResolvedWorkspacePath,
} from "../../src/repository/paths.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { rulesForEnvelope } from "../../src/review/adjudication.js";
import {
  runCounterReview,
  type ConstitutionReviewPlan,
} from "../../src/review/counter-review.js";
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
  deriveCurrentEvidenceSet,
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
// One active rule (no enforcement declarations) so every counter-review call carries the merged
// constitution review, plus one retired rule proving deprecated entries never demand coverage.
const constitution = await resolvedConstitutionFixture({
  "00-retired.md": `---
id: retired
version: 1
status: deprecated
---
retired rule
`,
  "10-isolation.md": `---
id: task-isolation
version: 1
status: active
review_trigger: A task reads or mutates another task's files.
---
Tasks are isolated from one another.
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
  const manifestRepositoryPath = parseRepositoryPathClaim(
    `.archflow/tasks/${task}/authority/results/${reference.result_digest}.json`,
  );
  const manifestTarget = {
    absolute: join(root, manifestRepositoryPath) as ResolvedTaskPath,
    repositoryRelative: manifestRepositoryPath,
    path_class: "authority-result",
  } as const satisfies ResolvedPath;
  const manifest = parseCanonicalDocument<ResultManifestV1>(
    await readFile(manifestTarget.absolute),
  );
  const payloads = await Promise.all(manifest.value.outputs
    .filter((output) => output.storage === "raw-payload")
    .map(async (output) => {
      const workspaceRelative = parseWorkspacePathClaim(
        `cache/results/${reference.result_digest}/payload/${output.path}`,
      );
      const target = {
        absolute: join(root, `.archflow/runtime/tasks/${task}/${workspaceRelative}`) as ResolvedTaskWorkspacePath,
        workspaceRelative,
        repositoryRelative: parseRepositoryPathClaim(`.archflow/runtime/tasks/${task}/${workspaceRelative}`),
        path_class: "workspace-result-payload",
      } as const satisfies ResolvedWorkspacePath;
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
      value: { subject: structuredClone(subject), fingerprint: computeInputFingerprint(subject) },
    }),
    read_state: readTaskState,
    read_config: async () => ({
      kind: "valid",
      snapshot: {
        bytes: canonicalJsonBytes(config as never),
        digest: canonicalJsonDigest(config as never),
        parsed: structuredClone(config) as TaskConfigSnapshot,
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
    load_retained_manifest: async (reference) => {
      const loaded = await retainedResult(root, reference);
      return {
        schema_version: "1",
        ok: true,
        value: {
          manifest: loaded.value.prepared.manifest,
          manifest_target: loaded.value.manifest_target,
        },
      };
    },
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
  role: "counter-review",
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
    step: "counter_review" as const,
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

type TriageMode = "accepted" | "rejected" | "editorial";

function triageCandidate(
  current: CurrentReviewSet,
  mode: TriageMode,
): TriageCandidate {
  const dispositions = current.reviews.flatMap((review) =>
    review.evidence.findings.map((finding) => mode === "accepted"
      ? {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "accepted" as const,
          rationale: "rewrite required",
          revision_intent: "rewrite" as const,
        }
      : mode === "editorial"
        ? {
            review_evidence_digest: review.evidence_digest,
            finding_id: finding.finding_id,
            disposition: "accepted-editorial" as const,
            rationale: "wording only",
            revision_intent: "polish the wording without changing meaning" as const,
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
    accepted_count: mode === "accepted" ? dispositions.length : 0,
    rejected_count: mode === "rejected" ? dispositions.length : 0,
    accepted_editorial_count: mode === "editorial" ? dispositions.length : 0,
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

async function reconstruct(
  h: Harness,
  dependencies: TransactionDependencies,
): Promise<CurrentReviewSet> {
  const loaded = await loadCurrentReviewSet({
    read_state: readTaskState,
    load_retained_manifest: dependencies.load_retained_manifest!,
  }, h.authority, phase);
  if (!loaded.ok) throw new Error(loaded.error.code);
  return loaded.value;
}

async function commitTriage(
  h: Harness,
  dependencies: TransactionDependencies,
  version: number,
  mode: TriageMode,
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
  const candidate = triageCandidate(current, mode);
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

/**
 * Builds the fixture stand-in for the second, adjudicating child dispatch: it answers with a
 * clean pass over exactly the sealed envelope it received, covering every active rule.
 */
function constitutionPlan(
  h: Harness,
  dependencies: TransactionDependencies,
  version: number,
): ConstitutionReviewPlan {
  const resultId = `adjudication-v${version}`;
  return {
    registry: constitution.rules,
    pinned_constitution_digest: constitution.digest,
    rules: rulesForEnvelope(constitution.rules),
    approved_upstreams: [],
    approved_upstream_digests: [],
    invocation_id: parseSafeId(`adjudication-invocation-v${version}`),
    result_id: parseSafeId(resultId),
    workspace: {
      kind: "read-only-repository-checkout",
      commit: "0123456789abcdef0123456789abcdef01234567" as never,
      note: REPOSITORY_VIEW_NOTE,
    },
    dispatch: async (_route, envelope) => {
      const parsed = JSON.parse(new TextDecoder().decode(envelope.bytes)) as {
        subject: Record<string, unknown>;
        rules: readonly { id: string; version: number }[];
      };
      return {
        cli_version: "fixture-1",
        extracted_output_bytes: canonicalJsonBytes({
          schema_version: "1",
          task_id: task,
          phase_instance: phase,
          step: "adjudicate",
          subject_digest: parsed.subject.subject_digest,
          input_fingerprint: parsed.subject.input_fingerprint,
          pinned_constitution_digest: parsed.subject.pinned_constitution_digest,
          approved_upstream_digests: [],
          source_evidence_set_digest: parsed.subject.source_evidence_set_digest,
          rule_findings: parsed.rules.map((rule) => ({
            rule_id: rule.id,
            rule_version: rule.version,
            compliance: "pass",
            rationale: "Checked the retained subject.",
            trigger: "not-matched",
            trigger_evidence: "No review trigger matched.",
          })),
          drift_findings: [],
        } as never),
      };
    },
    // The third parameter (the sibling review's just-prepared bytes) is deliberately unused:
    // this harness reads retained bytes from durable state at both preparation and install
    // time, so creation-time accounting must be computed against the same authority the
    // install-time check re-reads, or the two measurements could never agree.
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
      }
      return prepared;
    },
  };
}

async function commitCounter(
  h: Harness,
  dependencies: TransactionDependencies,
  version: number,
  subject: Sha256Digest,
  fingerprint: Sha256Digest,
  finding: "accepted" | "blocker" | "clean",
  override?: Readonly<{ declaration: unknown; routes: DispatchRoute[]; config?: ConfigV1 }>,
  dispatchAlreadySerialized = false,
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
    ...(override === undefined ? {} : { route_override: override.declaration }),
  });
  const result = await runCounterReview({
    transaction: dependencies,
    reobserve_projection_digest: async () => ({
      schema_version: "1",
      ok: true,
      value: subject,
    }),
    dispatch: async (route) => {
      override?.routes.push(route);
      return {
        cli_version: "fixture-1",
        extracted_output_bytes: canonicalJsonBytes(
          reviewOutput("counter-review", subject, fingerprint, finding),
        ),
      };
    },
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
      }
      return prepared;
    },
    ...(dispatchAlreadySerialized
      ? { serialize_dispatch: async <T>(operation: () => Promise<T>) => operation() }
      : {}),
  }, {
    authority: h.authority,
    call,
    config: override?.config ?? config,
    phase_kind: "phase-impl",
    producer_family: "claude",
    measured_at_revision: runningState.revision,
    repositories: Object.freeze([Object.freeze({
      name: "primary",
      repository_identity_digest: "a".repeat(64) as Sha256Digest,
      commit: "b".repeat(40) as never,
    })]),
    envelope: {
      artifact: `artifact-v${version}`,
      rubric,
      context: [],
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
    // The pinned constitution has an active rule, so every counter-review call carries the
    // second, adjudicating dispatch and installs both evidence results in the one transaction.
    constitution: ((plan) => override === undefined ? plan : {
      ...plan,
      dispatch: (route: DispatchRoute, envelope: Parameters<typeof plan.dispatch>[1], schema: Parameters<typeof plan.dispatch>[2]) => {
        override.routes.push(route);
        return plan.dispatch(route, envelope, schema);
      },
    })(constitutionPlan(h, dependencies, version)),
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
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
    `.archflow/tasks/${task}/authority/results/${manifest.digest}.json`,
  );
  const payloadWorkspacePath = parseWorkspacePathClaim(
    `cache/results/${manifest.digest}/payload/${outputPath}`,
  );
  const payloadPath = parseRepositoryPathClaim(`.archflow/runtime/tasks/${task}/${payloadWorkspacePath}`);
  const reference: AuthoritativeResultRef = {
    phase_instance: phase,
    step: "produce",
    result_digest: manifest.digest,
    result_id: resultId,
    input_fingerprint: fingerprint,
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
          absolute: join(h.root, payloadPath) as ResolvedTaskWorkspacePath,
          workspaceRelative: payloadWorkspacePath,
          repositoryRelative: payloadPath,
          path_class: "workspace-result-payload",
        },
      }],
    },
    manifest_target: {
      absolute: join(h.root, manifestPath) as ResolvedTaskPath,
      repositoryRelative: manifestPath,
      path_class: "authority-result",
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
  editorialPredecessor?: Readonly<{
    subject_digest: Sha256Digest;
    input_fingerprint: Sha256Digest;
  }>,
): Promise<EvidenceAssessment> {
  const state = await durableState(h.authority);
  const loaded = await loadRetainedEvidence({
    load_retained_manifest: dependencies.load_retained_manifest!,
  }, structuredClone(state), phase);
  if (!loaded.ok) throw new Error(loaded.error.code);
  return assessCurrentEvidence(state, loaded.value, {
    subject_digest: subject,
    input_fingerprint: fingerprint,
    constitution,
    ...(editorialPredecessor === undefined
      ? {}
      : { editorial_predecessor: editorialPredecessor }),
  });
}

describe("counter-review route override", () => {
  it("dispatches the substitute route per role and records the displaced pin on the evidence", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const routes: DispatchRoute[] = [];

    // Only the reviewer is substituted; the adjudicator keeps the pinned codex route, so a
    // partial override must not quietly reroute the role the human did not name.
    const merged = await commitCounter(h, h.dependencies, 0, subject, fingerprint, "clean", {
      declaration: {
        reason: "codex CLI auth outage; reviewing on claude for this dispatch",
        "counter-reviewer": { model: "claude-opus-4-6", effort: "max" },
      },
      routes,
    });

    expect(routes).toEqual([
      { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" },
      { adapter: "codex-cli", family: "codex", model: "gpt-fixture", effort: "high" },
    ]);

    const evidence = merged.evidence;
    if (evidence.assurance !== "server-attested") throw new Error("expected server-attested review");
    expect(evidence.model).toBe("claude-opus-4-6");
    expect(evidence.model_family).toBe("claude");
    expect(evidence.route_override).toEqual({
      reason: "codex CLI auth outage; reviewing on claude for this dispatch",
      pinned_model: "gpt-fixture",
      pinned_effort: "high",
    });
    // The adjudicator ran on its pin, so its evidence carries no deviation to report.
    const constitutionEvidence = merged.constitution_evidence;
    if (constitutionEvidence?.assurance !== "server-attested") throw new Error("expected server-attested adjudication");
    expect(constitutionEvidence.model).toBe("gpt-fixture");
    expect(constitutionEvidence.route_override).toBeUndefined();

    // The override substitutes a route for one dispatch and leaves the pin itself alone; the byte
    // pin's own enforcement is covered in test/unit/config-pinning.test.ts.
    expect(config.roles).toEqual({
      "counter-reviewer": { model: "gpt-fixture", effort: "high" },
      adjudicator: { model: "gpt-fixture", effort: "high" },
    });
  });


  it("substitutes the adjudicator alone and supplies a role the config never pinned", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const routes: DispatchRoute[] = [];

    // The config pins a reviewer but no adjudicator — schema-legal, since both roles are optional.
    // Resolving the pin before reading the override used to throw `route-missing` here, stranding
    // the task on a "repair-config" action against a file that cannot be repaired in-task.
    const merged = await commitCounter(h, h.dependencies, 0, subject, fingerprint, "clean", {
      declaration: {
        reason: "no adjudicator was ever configured for this task",
        adjudicator: { model: "claude-opus-4-6", effort: "high" },
      },
      routes,
      config: { schema_version: "1", roles: { "counter-reviewer": { model: "gpt-fixture", effort: "high" } } },
    });

    expect(routes).toEqual([
      { adapter: "codex-cli", family: "codex", model: "gpt-fixture", effort: "high" },
      { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" },
    ]);

    const review = merged.evidence;
    if (review.assurance !== "server-attested") throw new Error("expected server-attested review");
    expect(review.model).toBe("gpt-fixture");
    expect(review.route_override).toBeUndefined();

    // Nothing was displaced, so the record carries the reason alone rather than inventing a pin.
    const adjudication = merged.constitution_evidence;
    if (adjudication?.assurance !== "server-attested") throw new Error("expected server-attested adjudication");
    expect(adjudication.model).toBe("claude-opus-4-6");
    expect(adjudication.route_override).toEqual({ reason: "no adjudicator was ever configured for this task" });
  });
});

describe("durable review fixed point", () => {
  it("completes review dispatches when the semantic action already owns the outer FIFO", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: "semantic-outer-fifo" });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));

    const result = await serializeDispatch(() => commitCounter(
      h,
      h.dependencies,
      0,
      subject,
      fingerprint,
      "clean",
      undefined,
      true,
    ));

    expect(result.transaction.outcome).toMatchObject({
      verdict: "pass",
      constitution: { status: "evaluated", constitution: "pass" },
    });
    expect((await durableState(h.authority)).authoritative_results
      .map((reference) => reference.step).sort()).toEqual([
        "adjudicate",
        "counter_review",
      ]);
  });

  it("restarts twice and advances only after the final clean merged review", async () => {
    const h = await fixture();
    let dependencies = h.dependencies;
    const subjects = [0, 1, 2].map((version) =>
      canonicalJsonDigest({ artifact: version }));
    const fingerprints = [0, 1, 2].map((version) =>
      computeInputFingerprint(fingerprintSubject(version)));

    const merged = await commitCounter(h, dependencies, 0,
      subjects[0]!, fingerprints[0]!, "accepted");
    // One call, one transaction, two evidence results: the merged success reports the
    // evaluated constitution and durable state holds both references immediately.
    expect(merged.transaction.outcome).toMatchObject({
      verdict: "advisory",
      constitution: {
        status: "evaluated",
        constitution: "pass",
        drift: "aligned",
        triggers: [],
      },
    });
    expect(merged.constitution_evidence?.constitution).toBe("pass");
    expect((await durableState(h.authority)).authoritative_results
      .filter((reference) => reference.input_fingerprint === fingerprints[0])
      .map((reference) => reference.step).sort()).toEqual([
        "adjudicate",
        "counter_review",
      ]);
    await commitTriage(h, dependencies, 0, "accepted");
    expect(await assessment(h, dependencies, subjects[0]!, fingerprints[0]!))
      .toMatchObject({ reentry_required: true, next: "produce" });

    dependencies = await rewrite(h, dependencies, 1);
    expect(await assessment(h, dependencies, subjects[1]!, fingerprints[1]!))
      .toMatchObject({
        current: [],
        stale: ["counter_review", "triage", "adjudicate"],
        next: "counter_review",
      });

    await commitCounter(h, dependencies, 1,
      subjects[1]!, fingerprints[1]!, "blocker");
    expect(await assessment(h, dependencies, subjects[1]!, fingerprints[1]!))
      .toMatchObject({ blocker_remains: false, next: "triage" });
    expect((await assessment(h, dependencies, subjects[1]!, fingerprints[1]!)).next)
      .not.toBe("advance");
    await commitTriage(h, dependencies, 1, "accepted");
    expect(await assessment(h, dependencies, subjects[1]!, fingerprints[1]!))
      .toMatchObject({ reentry_required: true, next: "produce" });
    // The retained constitution evidence is the one installed with this round's review.
    expect((await durableState(h.authority)).authoritative_results
      .filter((reference) => reference.step === "adjudicate")
      .map((reference) => reference.input_fingerprint)).toEqual([fingerprints[1]]);

    dependencies = await rewrite(h, dependencies, 2);
    await commitCounter(h, dependencies, 2,
      subjects[2]!, fingerprints[2]!, "clean");
    await commitTriage(h, dependencies, 2, "rejected");
    // No separate adjudication step remains: the clean constitution evidence arrived with the
    // review, so the completed triage closes the loop at "advance".
    expect(await assessment(h, dependencies, subjects[2]!, fingerprints[2]!))
      .toMatchObject({ blocker_remains: false, next: "advance" });

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
        current: ["counter_review", "triage", "adjudicate"],
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
        "triage",
      ]);
  });
});

describe("editorial revision fixed point", () => {
  it("keeps evidence current for exactly the declared one-hop predecessor", async () => {
    const h = await fixture();
    const dependencies = h.dependencies;
    const predecessorSubject = canonicalJsonDigest({ artifact: "editorial-0" });
    const predecessorFingerprint = computeInputFingerprint(fingerprintSubject(0));
    const revisedSubject = canonicalJsonDigest({ artifact: "editorial-1" });
    const revisedFingerprint = computeInputFingerprint(fingerprintSubject(1));

    // A non-blocking finding, triaged as editorial only: not a re-entry, and the durable
    // attempt is untouched. The next act is the produce revision.
    await commitCounter(h, dependencies, 0,
      predecessorSubject, predecessorFingerprint, "accepted");
    await commitTriage(h, dependencies, 0, "editorial");
    expect((await durableState(h.authority)).attempt).toBe(1);
    expect(await assessment(h, dependencies, predecessorSubject, predecessorFingerprint))
      .toMatchObject({
        current: ["counter_review", "triage", "adjudicate"],
        editorial_revision_required: true,
        reentry_required: false,
        exhausted: false,
        next: "produce",
      });
    expect((await durableState(h.authority)).attempt).toBe(1);

    // The revised subject inherits currency only through the declared predecessor pair, and it
    // inherits ALL of it — reviews, triage, and the constitution evidence dispatched with the
    // review. Nothing is re-run after an editorial revision; the loop closes at "advance".
    expect(await assessment(h, dependencies, revisedSubject, revisedFingerprint, {
      subject_digest: predecessorSubject,
      input_fingerprint: predecessorFingerprint,
    })).toMatchObject({
      current: ["counter_review", "triage", "adjudicate"],
      stale: [],
      editorial_revision_required: false,
      reentry_required: false,
      next: "advance",
    });
    // Without the declaration nothing is current.
    expect(await assessment(h, dependencies, revisedSubject, revisedFingerprint))
      .toMatchObject({ current: [], next: "counter_review" });
    // A second editorial revision on top of the first does NOT inherit currency: the evidence
    // is bound to the original bytes, two hops from this subject. One hop, no chaining.
    const secondRevision = canonicalJsonDigest({ artifact: "editorial-2" });
    expect(await assessment(
      h, dependencies,
      secondRevision, computeInputFingerprint(fingerprintSubject(2)),
      { subject_digest: revisedSubject, input_fingerprint: revisedFingerprint },
    )).toMatchObject({ current: [], next: "counter_review" });

    // Constitution-evidence currency follows the same one-hop rule as the reviews it was
    // dispatched with: predecessor-bound counts, revised-bound counts, anything else is stale —
    // and a stale constitution slot beside current reviews demands the produce re-entry
    // recovery path rather than any direct re-adjudication (the step no longer exists).
    const state = await durableState(h.authority);
    const loaded = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(state), phase);
    if (!loaded.ok) throw new Error(loaded.error.code);
    const setDigest = deriveCurrentEvidenceSet(loaded.value)
      .current_evidence_set.set_digest;
    const adjudicationFor = (
      subject: Sha256Digest,
      fingerprint: Sha256Digest,
    ): AdjudicationEvidence => ({
      schema_version: "1",
      task_id: task,
      phase_instance: phase,
      step: "adjudicate",
      subject_digest: subject,
      input_fingerprint: fingerprint,
      pinned_constitution_digest: constitution.digest,
      approved_upstream_digests: [],
      source_evidence_set_digest: setDigest,
      rule_findings: [],
      drift_findings: [],
      constitution: "pass",
      drift: "aligned",
      matched_rule_versions: [],
      uncertain_rule_versions: [],
      assurance: "degraded",
      model_family: "unknown",
      model: "manual",
      effort: "unknown",
      reason: "manual fallback",
    } as AdjudicationEvidence);
    const withAdjudication = async (
      resultId: string,
      evidence: AdjudicationEvidence,
    ) => {
      const prepared = await prepareEvidence(h, resultId, {
        kind: "adjudication",
        evidence,
      });
      const retained = new Map(loaded.value);
      retained.set("adjudicate", Object.freeze({
        reference: prepared.reference,
        manifest: prepared.prepared.manifest.value,
      }));
      return assessCurrentEvidence(state, retained, {
        subject_digest: revisedSubject,
        input_fingerprint: revisedFingerprint,
        constitution,
        editorial_predecessor: {
          subject_digest: predecessorSubject,
          input_fingerprint: predecessorFingerprint,
        },
      });
    };
    expect(await withAdjudication(
      "adjudication-predecessor-bound",
      adjudicationFor(predecessorSubject, predecessorFingerprint),
    )).toMatchObject({
      current: ["counter_review", "triage", "adjudicate"],
      reentry_required: false,
      next: "advance",
    });
    expect(await withAdjudication(
      "adjudication-revised-bound",
      adjudicationFor(revisedSubject, revisedFingerprint),
    )).toMatchObject({
      current: ["counter_review", "triage", "adjudicate"],
      blocker_remains: false,
      reentry_required: false,
      editorial_revision_required: false,
      next: "advance",
    });
    // Two hops back is stale. With active rules and current reviews, the stale constitution
    // slot is reachable only through repair or upstream re-approval, and the answer is the
    // backward-to-produce recovery door — never a bigger evidence window.
    expect(await withAdjudication(
      "adjudication-unrelated-bound",
      adjudicationFor(secondRevision, computeInputFingerprint(fingerprintSubject(2))),
    )).toMatchObject({
      current: ["counter_review", "triage"],
      stale: ["adjudicate"],
      reentry_required: true,
      next: "produce",
    });
  });
});
