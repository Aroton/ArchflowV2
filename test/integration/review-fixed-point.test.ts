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
import { deriveNextAction } from "../../src/state/next-action.js";
import {
  parsePathSafeId,
  parseSafeCode,
  parseSafeId,
  parseSafeInteger,
  parseTaskSlug,
  type Sha256Digest,
} from "../../src/contracts/evidence.js";
import {
  EFFORT_SELECTOR_INSTRUCTIONS,
  IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
  type EffortEnvelopeV2,
} from "../../src/contracts/effort-review.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
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
import type { HostIdentity } from "../../src/contracts/hosts.js";
import type { ReviewEvidence, ModelFamily } from "../../src/contracts/review.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import type { CurrentEvidenceSetRef, CurrentReviewSet } from "../../src/contracts/trust.js";
import { validateTriage, type TriageCandidate } from "../../src/contracts/triage.js";
import {
  createGitRunner,
  preflightGit,
  resolveCommit,
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
import { DispatchRoutingError, type DispatchRoute } from "../../src/dispatch/routing.js";
import {
  retainedChildOutputKey,
  type RetainedChildOutputBinding,
  type RetainedChildOutputStore,
} from "../../src/dispatch/retained-child-output.js";
import { createProjectError } from "../../src/contracts/errors.js";
import { loadPriorTriageRecord, priorTriageEvidence } from "../../src/review/pinned-context.js";
import { policyReviewFacts, rulesForEnvelope, ruleSlotsForEnvelope, selectPolicyReviewGates } from "../../src/review/adjudication.js";
import {
  runCounterReview,
  type ConstitutionReviewPlan,
  type EffortReviewPlan,
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
  retainedReviewEnvelopeDigest,
  type EvidenceResultValue,
  type PreparedEvidenceResult,
} from "../../src/state/evidence-results.js";
import {
  loadAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "../../src/state/gate-approvals.js";
import { openDurableGate } from "../../src/state/gates.js";
import { ordinaryApprovalFacts } from "../helpers/ordinary-approval.js";
import { resolveInterfaceGateDecision } from "../helpers/resolve-interface-gate.js";
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
  kind: "design",
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
  }, {
    id: "verification-evidence",
    text: "Verification evidence must support the implementation.",
    blocking: true,
  }, {
    id: "test-quality",
    text: "Tests must provide distinct economical regression protection.",
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

function fingerprintSubject(version: number, phaseInstance = phase): InputFingerprintSubject {
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
    phase_instance: phaseInstance,
    declared_inputs: [],
  };
}

function initialState(
  authority: TransactionAuthority,
  fingerprint: Sha256Digest,
  phaseInstance = phase,
): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: authority.repository_identity_digest,
    revision: parseSafeInteger(7),
    phase_instance: phaseInstance,
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

async function fixture(phaseInstance = phase): Promise<Harness> {
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
    context: { ...context, phase_instance: phaseInstance },
  });
  if (!authority.ok) throw new Error("authority creation failed");
  const subject = fingerprintSubject(0, phaseInstance);
  await writeFile(
    authority.value.state.absolute,
    canonicalDocument(initialState(
      authority.value,
      computeInputFingerprint(subject),
      phaseInstance,
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
  finding: "accepted" | "blocker" | "clean" | "multiple",
  producerFamily: ModelFamily = "claude",
  assignment: Readonly<{
    focus: "general" | "tests";
    criterion_ids: readonly string[];
    expected_upstream_digests?: readonly Sha256Digest[];
  }> = { focus: "general", criterion_ids: ["correctness"] },
) {
  const genericFindings = finding === "clean"
    ? []
    : finding === "multiple"
      ? [
          {
            finding_id: `${role}-accepted`,
            claim_type: "preference" as const,
            confidence: "certain" as const,
            falsifier: "Inspect the fixture evidence and verify whether the finding is present.",
            summary: "accepted finding",
            evidence: "fixture evidence",
            suggested_resolution: "rewrite the artifact",
          },
          {
            finding_id: `${role}-escalated`,
            claim_type: "defect" as const,
            confidence: "certain" as const,
            falsifier: "Inspect the fixture evidence and verify whether the finding is present.",
            summary: "escalated finding",
            evidence: "fixture evidence",
            suggested_resolution: "human decision required",
          },
        ]
      : [{
          finding_id: `${role}-${finding}`,
          claim_type: finding === "blocker" ? "defect" as const : "preference" as const,
          confidence: "certain" as const,
          falsifier: "Inspect the fixture evidence and verify whether the finding is present.",
          summary: `${finding} finding`,
          evidence: "fixture evidence",
          suggested_resolution: "rewrite the artifact",
        }];
  const findings = assignment.criterion_ids.length === 0
    ? []
    : assignment.focus === "general"
    ? genericFindings.map((item) => ({ ...item, criterion_id: assignment.criterion_ids[0] ?? "substantive-correctness" }))
    : genericFindings.map((item) => ({
      finding_id: item.finding_id,
      criterion_id: assignment.criterion_ids[0] ?? "test-quality",
      claim_type: item.claim_type,
      confidence: item.confidence,
      falsifier: item.falsifier,
      required_behavior_or_risk_boundary: item.summary,
      coverage_or_oracle_problem: item.evidence,
      consequence: "The required behavior could regress without detection.",
      proposed_verification_change: item.suggested_resolution,
    }));
  return {
    schema_version: "3" as const,
    task_id: task,
    phase_instance: phase,
    step: "counter_review" as const,
    role,
    subject_digest: subject,
    input_fingerprint: fingerprint,
    rubric_digest: rubricDigest,
    producer_family: producerFamily,
    findings,
    ...(assignment.focus !== "general" || assignment.expected_upstream_digests === undefined
      ? {}
      : { upstream_alignment: assignment.expected_upstream_digests.map((upstream_digest) => ({
        upstream_digest, drift: "aligned" as const, affected_claim_ids: [], rationale: "Fixture alignment is clean.",
      })) }),
  };
}

type TriageMode = "accepted" | "rejected" | "editorial" | "escalated" | "deferred" | "mixed-accepted-escalated";

function triageCandidate(
  current: CurrentReviewSet,
  mode: TriageMode,
): TriageCandidate {
  const dispositions = current.reviews.flatMap((review) =>
    review.evidence.findings.map((finding, index) => {
      if (mode === "mixed-accepted-escalated") {
        if (index === 0) {
          return {
            review_evidence_digest: review.evidence_digest,
            finding_id: finding.finding_id,
            disposition: "accepted" as const,
            rationale: "rewrite required",
            revision_intent: "rewrite" as const,
          };
        }
        return {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "escalated-human" as const,
          rationale: "human escalation required",
        };
      }
      if (mode === "escalated") {
        return {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "escalated-human" as const,
          rationale: "human escalation required",
        };
      }
      if (mode === "deferred") {
        return {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "deferred" as const,
          rationale: "deferring non-material finding",
          evidence: "fixture evidence demonstrating no material consequence",
        };
      }
      if (mode === "accepted") {
        return {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "accepted" as const,
          rationale: "rewrite required",
          revision_intent: "rewrite" as const,
        };
      }
      if (mode === "editorial") {
        return {
          review_evidence_digest: review.evidence_digest,
          finding_id: finding.finding_id,
          disposition: "accepted-editorial" as const,
          rationale: "wording only",
          revision_intent: "polish the wording without changing meaning" as const,
        };
      }
      return {
        review_evidence_digest: review.evidence_digest,
        finding_id: finding.finding_id,
        disposition: "rejected" as const,
        rationale: "not applicable",
        evidence: "fixture rejection evidence",
      };
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
    accepted_count: dispositions.filter((d) => d.disposition === "accepted").length,
    rejected_count: dispositions.filter((d) => d.disposition === "rejected").length,
    accepted_editorial_count: dispositions.filter((d) => d.disposition === "accepted-editorial").length,
    escalated_human_count: dispositions.filter((d) => d.disposition === "escalated-human").length,
    deferred_count: dispositions.filter((d) => d.disposition === "deferred").length,
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
          phase_instance: document.value.phase_instance,
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
    rule_slots: ruleSlotsForEnvelope(constitution.rules),
    invocation_id: parseSafeId(`adjudication-invocation-v${version}`),
    result_id: parseSafeId(resultId),
    workspace: {
      kind: "read-only-repository-checkout",
      commit: "0123456789abcdef0123456789abcdef01234567" as never,
      note: REPOSITORY_VIEW_NOTE,
    },
    dispatch: async (_route, envelope) => {
      const parsed = JSON.parse(new TextDecoder().decode(envelope.bytes)) as {
        rules: readonly { slot: string }[];
      };
      return {
        cli_version: "fixture-1",
        extracted_output_bytes: canonicalJsonBytes({
          schema_version: "2",
          judgments: Object.fromEntries(parsed.rules.map((rule) => [rule.slot, {
            compliance: "pass",
            rationale: "Checked the retained subject.",
            trigger: "not-matched",
            trigger_evidence: "No review trigger matched.",
          }])),
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
  finding: "accepted" | "blocker" | "clean" | "multiple",
  override?: Readonly<{ declaration: unknown; routes: DispatchRoute[]; config?: ConfigV1 }>,
  dispatchAlreadySerialized = false,
  host: HostIdentity = "claude",
) {
  const producerFamily = host === "antigravity" ? "gemini" : host === "codex" ? "codex" : "claude";
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
    ...(override?.declaration === undefined ? {} : { route_override: override.declaration }),
  });
  const result = await runCounterReview({
    transaction: dependencies,
    reobserve_projection_digest: async () => ({
      schema_version: "1",
      ok: true,
      value: subject,
    }),
    dispatch: async (route, envelope) => {
      override?.routes.push(route);
      const child = JSON.parse(new TextDecoder().decode(envelope.bytes)) as { assignment?: Parameters<typeof reviewOutput>[5] };
      return {
        cli_version: "fixture-1",
        extracted_output_bytes: canonicalJsonBytes(
          reviewOutput("counter-review", subject, fingerprint, finding, producerFamily, child.assignment),
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
      ? {
        serialize_dispatch: async <T>(operation: () => Promise<T>) => operation(),
        serialize_dispatch_all: async <T>(ops: readonly (() => Promise<T>)[]) => Promise.all(ops.map((op) => op())),
      }
      : {}),
  }, {
    authority: h.authority,
    call,
    config: override?.config ?? config,
    phase_kind: "phase-impl",
    producer_family: producerFamily,
    host,
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
        producer_family: producerFamily,
        invocation_id: `counter-invocation-v${version}`,
        result_id: resultId,
      },
    },
    projection_digest: subject,
    approved_upstream_digests: [],
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
  authenticatedApprovals?: readonly AuthenticatedGateApproval[],
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
    approved_upstream_digests: [],
    ...(editorialPredecessor === undefined
      ? {}
      : { editorial_predecessor: editorialPredecessor }),
    ...(authenticatedApprovals === undefined
      ? {}
      : { authenticated_gate_approvals: authenticatedApprovals }),
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
      { adapter: "codex-cli", family: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
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
      { adapter: "codex-cli", family: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
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
        triggers: [],
      },
      alignment: { status: "evaluated", drift: "aligned", upstream_count: 0 },
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
    const envelopeDigest = retainedReviewEnvelopeDigest(loaded.value);
    if (envelopeDigest === undefined) throw new Error("fixture counter evidence is not server-attested");
    const adjudicationFor = (
      subject: Sha256Digest,
      fingerprint: Sha256Digest,
    ): AdjudicationEvidence => {
      const source = loaded.value.get("adjudicate")?.manifest.source_artifact;
      if (source?.artifact_kind !== "adjudication-evidence" || source.evidence.schema_version !== "2") {
        throw new Error("fixture requires fresh V2 adjudication");
      }
      return Object.freeze({ ...source.evidence, subject_digest: subject, input_fingerprint: fingerprint });
    };
    const withAdjudication = async (
      resultId: string,
      evidence: AdjudicationEvidence,
    ) => {
      const prepared = await prepareEvidence(h, resultId, {
        kind: "adjudication",
        evidence: Object.freeze({ ...evidence, result_id: resultId }) as AdjudicationEvidence,
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
        approved_upstream_digests: [],
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

  it("dispatches multiple reviewers in parallel for antigravity producer and merges findings and blockers", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const routes: DispatchRoute[] = [];

    const multiReviewConfig: ConfigV1 = {
      schema_version: "1",
      roles: {
        "counter-reviewer": { model: "gpt-5.6-sol", effort: "high" },
        "test-reviewer": { model: "gpt-5.6-luna", effort: "max" },
        adjudicator: { model: "gemini-3.7-flash-high", effort: "high" },
      },
      producers: {
        antigravity: {
          "counter-reviewers": [
            { model: "gpt-5.6-sol", effort: "high" },
            { model: "claude-fable-5", effort: "medium" },
          ],
          adjudicator: { model: "gemini-3.7-flash-high", effort: "high" },
        },
      },
    };

    const merged = await commitCounter(
      h,
      h.dependencies,
      0,
      subject,
      fingerprint,
      "blocker",
      { declaration: undefined, routes, config: multiReviewConfig },
      false,
      "antigravity",
    );

    // Both general reviewers, the test specialist, and the constitution adjudicator ran.
    expect(routes).toEqual([
      { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "high" },
      { adapter: "claude-cli", family: "claude", model: "claude-fable-5", effort: "medium" },
      { adapter: "codex-cli", family: "codex", model: "gpt-5.6-luna", effort: "max" },
      { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" },
    ]);

    expect(merged.evidence.schema_version).toBe("3");
    if (merged.evidence.schema_version !== "3") return;
    expect(merged.evidence.verdict).toBe("review-raised");
    expect(merged.evidence.total_findings).toBe(3);
    expect(merged.evidence.findings).toHaveLength(3);
    expect(merged.evidence.assurance).toBe("server-attested");
    if (merged.evidence.assurance !== "server-attested") return;
    expect(merged.evidence.reviewer_runs).toMatchObject([
      { reviewer_id: "general-1", focus: "general", routing_role: "counter-reviewer", criterion_ids: ["correctness"] },
      { reviewer_id: "general-2", focus: "general", routing_role: "counter-reviewer", criterion_ids: ["correctness"] },
      { reviewer_id: "test", focus: "tests", routing_role: "test-reviewer", criterion_ids: ["verification-evidence", "test-quality"] },
    ]);
    expect(merged.evidence.reviewer_runs?.flatMap((run) => run.finding_ids))
      .toEqual(merged.evidence.findings.map((finding) => finding.finding_id));
  });
});

/**
 * A review round whose children can fail one at a time, backed by an in-memory retained-output
 * store, so a retry of the same round can be observed re-dispatching only what failed.
 */
describe("partial review round retry", () => {
  const SOL = "gpt-5.6-sol";
  const FABLE = "gpt-5.6-fable";
  const LUNA = "gpt-5.6-luna";
  const ADJUDICATOR = "gpt-fixture";
  const multiReviewConfig: ConfigV1 = {
    schema_version: "1",
    roles: {
      "counter-reviewer": { model: SOL, effort: "high" },
      adjudicator: { model: ADJUDICATOR, effort: "high" },
    },
    producers: {
      claude: {
        "counter-reviewers": [
          { model: SOL, effort: "high" },
          { model: FABLE, effort: "high" },
        ],
        adjudicator: { model: ADJUDICATOR, effort: "high" },
      },
    },
  };
  const specialistReviewConfig: ConfigV1 = {
    schema_version: "1",
    roles: {
      "counter-reviewer": { model: SOL, effort: "high" },
      "test-reviewer": { model: LUNA, effort: "max" },
      adjudicator: { model: ADJUDICATOR, effort: "high" },
    },
  };

  type RoundBehaviour = Readonly<{
    /** A reviewer that returns a clean pass instead of the fixture blocker. */
    clean_reviewer?: string;
    /** A reviewer that returns a non-blocking finding instead of the fixture blocker. */
    advisory_reviewer?: string;
    fail_reviewer?: string;
    invalid_reviewer?: string;
    fail_adjudicator?: boolean;
    invalid_adjudicator?: boolean;
    /** Milliseconds each named child waits before answering, to order how children finish. */
    delay?: Readonly<Record<string, number>>;
    declaration?: unknown;
  }>;

  function memoryStore() {
    const records = new Map<string, { binding: RetainedChildOutputBinding; cli_version: string; extracted_output_bytes: Uint8Array }>();
    const store: RetainedChildOutputStore = {
      read: async (binding) => {
        const record = records.get(retainedChildOutputKey(binding));
        return record === undefined ? undefined : { cli_version: record.cli_version, extracted_output_bytes: record.extracted_output_bytes };
      },
      write: async (binding, result) => {
        records.set(retainedChildOutputKey(binding), { binding, ...result });
      },
      discard: async (digest) => {
        for (const [key, record] of records) if (record.binding.envelope_digest === digest) records.delete(key);
      },
    };
    return { store, records };
  }

  const outage = (route: DispatchRoute) => new DispatchRoutingError(createProjectError("PROCESS_FAILED", {
    adapter: route.adapter, exit_class: "simulated-outage",
  }));

  it("settles ordinary review with the default profile when effort selection fails", async () => {
    const designPhase = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(14) });
    const h = await fixture(designPhase);
    const subject = canonicalJsonDigest({ artifact: "effort-round" });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0, designPhase));
    const { store, records } = memoryStore();
    await enterStep(h, h.dependencies, "effort-counter-running", "counter_review", fingerprint);
    const runningState = await durableState(h.authority);
    const repositories = Object.freeze([Object.freeze({
      name: "primary" as const,
      repository_identity_digest: "a".repeat(64) as Sha256Digest,
      commit: "b".repeat(40) as never,
    })]);
    const designRubric = Object.freeze({
      ...rubric,
      criteria: Object.freeze([...rubric.criteria, Object.freeze({
        id: "test-strategy", text: "The phase design must define economical verification.", blocking: true,
      })]),
    });
    const designRubricDigest = canonicalJsonDigest(designRubric);
    const registry = { schema_version: "1" as const, hazards: [] };
    const effortEnvelope: EffortEnvelopeV2 = {
      schema_version: "2",
      instructions: EFFORT_SELECTOR_INSTRUCTIONS,
      artifact: "# Phase design\n",
      task_id: task,
      phase_instance: designPhase,
      attempt: runningState.attempt,
      subject_digest: subject,
      input_fingerprint: fingerprint,
      invocation_id: "effort-invocation",
      result_id: "effort-result",
      policy_id: IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
      hazard_registry: {
        schema_version: "1", state: "absent",
        registry_digest: canonicalJsonDigest({ schema_version: "1", state: "absent", registry }),
        hazards: [],
      },
      repositories,
    };
    const call = parseToolCall("archflow_counter_review", {
      schema_version: "1",
      task_id: task,
      intent_id: "effort-counter-intent",
      expected_revision: runningState.revision,
      input_fingerprint: fingerprint,
      artifact_path: parseTaskPathClaim("phases/phase-14-output.md"),
    });
    const effort: EffortReviewPlan = { envelope: effortEnvelope };
    const attempt = async () => {
      const models: string[] = [];
      const result = await runCounterReview({
        transaction: h.dependencies,
        retained_outputs: store,
        reobserve_projection_digest: async () => ({ schema_version: "1", ok: true, value: subject }),
        dispatch: async (route, envelope) => {
          models.push(route.model);
          if (route.model === LUNA && envelope.result_kind === "effort-review") throw outage(route);
          const child = JSON.parse(new TextDecoder().decode(envelope.bytes)) as { assignment?: Parameters<typeof reviewOutput>[5] };
          return {
            cli_version: "fixture-1",
            extracted_output_bytes: canonicalJsonBytes({
              ...reviewOutput("counter-review", subject, fingerprint, "clean", "claude", child.assignment),
              phase_instance: designPhase,
              rubric_digest: designRubricDigest,
            }),
          };
        },
        prepare_evidence: async (evidence, measuredAtRevision) => {
          if (evidence.assurance !== "server-attested") throw new Error("expected server-attested evidence");
          const prepared = await prepareEvidenceResult({
            authority: h.authority,
            runner: h.runner,
            result_id: parseSafeId(evidence.result_id),
            retained_task_bytes: await h.dependencies.read_retained_task_bytes!(),
            measured_at_revision: measuredAtRevision,
            scanner: cleanScanner,
            value: { kind: "review", evidence },
          });
          if (prepared.ok) {
            for (const payload of prepared.value.prepared.payloads) await mkdir(dirname(payload.target.absolute), { recursive: true });
            await mkdir(dirname(prepared.value.manifest_target.absolute), { recursive: true });
          }
          return prepared;
        },
        serialize_dispatch: async <T>(operation: () => Promise<T>) => operation(),
        serialize_dispatch_all: async <T>(ops: readonly (() => Promise<T>)[]) => Promise.all(ops.map((op) => op())),
      }, {
        authority: h.authority,
        call,
        config: multiReviewConfig,
        phase_kind: "phase-design",
        producer_family: "claude",
        host: "claude",
        measured_at_revision: runningState.revision,
        repositories,
        envelope: {
          artifact: "# Phase design\n",
          rubric: designRubric,
          context: [],
          subject: {
            task_id: task,
            phase_instance: designPhase,
            role: "counter-review",
            step: "counter_review",
            subject_digest: subject,
            input_fingerprint: fingerprint,
            rubric_digest: designRubricDigest,
            producer_family: "claude",
            invocation_id: "counter-invocation",
            result_id: "counter-result",
          },
        },
        projection_digest: subject,
        approved_upstream_digests: [],
        effort,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.evidence.assurance).toBe("server-attested");
      if (result.value.evidence.assurance !== "server-attested") throw new Error("expected server-attested evidence");
      expect(result.value.evidence.effort_review).toMatchObject({
        schema_version: "2",
        profile: { model: "gpt-5.6-sol", effort: "medium" },
        source: { kind: "default" },
      });
      return models.sort();
    };

    expect(await attempt()).toEqual([FABLE, LUNA, LUNA, SOL].sort());
    expect([...records.values()]).toHaveLength(0);
    expect((await durableState(h.authority)).revision).toBe(runningState.revision + 1);
  });

  async function round(
    h: Harness,
    store: RetainedChildOutputStore,
    subject: Sha256Digest,
    fingerprint: Sha256Digest,
    behaviour: RoundBehaviour,
    enter: boolean,
    options: Readonly<{
      dependencies?: TransactionDependencies;
      version?: number;
      remediation?: boolean;
      config?: ConfigV1;
      invocation_routes?: Record<string, unknown>;
      observed_failures?: string[];
      observed_models?: string[];
      phase_kind?: "prd" | "phase-impl";
    }> = {},
  ) {
    const dependencies = options.dependencies ?? h.dependencies;
    const version = options.version ?? 0;
    if (enter) await enterStep(h, dependencies, `counter-running-v${version}`, "counter_review", fingerprint);
    const runningState = await durableState(h.authority);
    // A remediation round carries the structured prior-triage record and its pinned rendering,
    // exactly as the handler derives them from durable state.
    const priorTriage = options.remediation === true
      ? await loadPriorTriageRecord(dependencies, runningState)
      : undefined;
    if (priorTriage !== undefined && !priorTriage.ok) throw new Error(priorTriage.error.code);
    const priorContext = priorTriage?.value === undefined
      ? []
      : await priorTriageEvidence(dependencies, runningState, priorTriage.value);
    if (!Array.isArray(priorContext) && !priorContext.ok) throw new Error(priorContext.error.code);
    const context = Array.isArray(priorContext) ? priorContext : priorContext.value;
    const routes: DispatchRoute[] = [];
    const envelopes = new Map<string, unknown>();
    const digests = new Map<string, string>();
    const settle = async (model: string) => {
      const wait = behaviour.delay?.[model];
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    };
    const call = parseToolCall("archflow_counter_review", {
      schema_version: "1",
      task_id: task,
      intent_id: `counter-intent-v${version}`,
      expected_revision: runningState.revision,
      input_fingerprint: fingerprint,
      artifact_path: parseTaskPathClaim("phases/phase-14-output.md"),
      ...(options.invocation_routes === undefined ? {} : { invocation_routes: options.invocation_routes }),
      ...(behaviour.declaration === undefined ? {} : { route_override: behaviour.declaration }),
    });
    const plan = constitutionPlan(h, dependencies, version);
    const result = await runCounterReview({
      transaction: dependencies,
      reobserve_projection_digest: async () => ({ schema_version: "1", ok: true, value: subject }),
      retained_outputs: store,
      dispatch: async (route, envelope) => {
        routes.push(route);
        options.observed_models?.push(route.model);
        envelopes.set(route.model, JSON.parse(new TextDecoder().decode(envelope.bytes)));
        digests.set(route.model, envelope.digest);
        await settle(route.model);
        if (behaviour.fail_reviewer === route.model) throw outage(route);
        if (behaviour.invalid_reviewer === route.model) {
          return { cli_version: "fixture-1", extracted_output_bytes: new TextEncoder().encode('{"schema_version":"1"}') };
        }
        const child = JSON.parse(new TextDecoder().decode(envelope.bytes)) as { assignment?: Parameters<typeof reviewOutput>[5] };
        const requestedFinding = child.assignment?.focus === "tests" && (options.config ?? multiReviewConfig) !== specialistReviewConfig
          ? "clean"
          : behaviour.clean_reviewer === route.model
            ? "clean"
            : behaviour.advisory_reviewer === route.model ? "accepted" : "blocker";
        return {
          cli_version: "fixture-1",
          extracted_output_bytes: canonicalJsonBytes(reviewOutput(
            "counter-review", subject, fingerprint,
            requestedFinding,
            "claude",
            child.assignment,
          )),
        };
      },
      prepare_evidence: async (evidence, measuredAtRevision) => {
        const prepared = await prepareEvidenceResult({
          authority: h.authority,
          runner: h.runner,
          result_id: parseSafeId(`counter-v${version}`),
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
      serialize_dispatch: async <T>(operation: () => Promise<T>) => operation(),
      serialize_dispatch_all: async <T>(ops: readonly (() => Promise<T>)[]) => Promise.all(ops.map((op) => op())),
      observe_failure: async (role) => { options.observed_failures?.push(role); },
    }, {
      authority: h.authority,
      call,
      config: options.config ?? multiReviewConfig,
      phase_kind: options.phase_kind ?? "phase-impl",
      producer_family: "claude",
      host: "claude",
      measured_at_revision: runningState.revision,
      repositories: Object.freeze([Object.freeze({
        name: "primary",
        repository_identity_digest: "a".repeat(64) as Sha256Digest,
        commit: "b".repeat(40) as never,
      })]),
      envelope: {
        artifact: `artifact-v${version}`,
        rubric,
        context,
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
          result_id: `counter-v${version}`,
        },
      },
      projection_digest: subject,
      ...(options.phase_kind === "prd" ? {} : { approved_upstream_digests: [] }),
      ...(priorTriage?.value === undefined ? {} : { prior_triage: priorTriage.value }),
      constitution: {
        ...plan,
        dispatch: async (route, envelope, schema) => {
          routes.push(route);
          await settle(route.model);
          if (behaviour.fail_adjudicator === true) throw outage(route);
          if (behaviour.invalid_adjudicator === true) {
            return { cli_version: "fixture-1", extracted_output_bytes: new TextEncoder().encode('{"schema_version":"1"}') };
          }
          return plan.dispatch(route, envelope, schema);
        },
      },
    });
    return { result, models: routes.map((route) => route.model).sort(), envelopes, digests };
  }

  /** Triages the current review set with one disposition per finding, chosen by finding id. */
  async function commitTriageDecisions(
    h: Harness,
    dependencies: TransactionDependencies,
    version: number,
    decide: (findingId: string) => TriageMode,
  ) {
    const fingerprint = (await durableState(h.authority)).input_fingerprint;
    await enterStep(h, dependencies, `triage-running-v${version}`, "triage", fingerprint);
    const current = await reconstruct(h, dependencies);
    const dispositions = current.reviews.flatMap((review) => review.evidence.findings.map((finding) => {
      const base = { review_evidence_digest: review.evidence_digest, finding_id: finding.finding_id };
      const mode = decide(finding.finding_id);
      return mode === "accepted"
        ? { ...base, disposition: "accepted" as const, rationale: "rewrite required", revision_intent: "rewrite" }
        : mode === "editorial"
          ? { ...base, disposition: "accepted-editorial" as const, rationale: "wording only", revision_intent: "polish" }
          : { ...base, disposition: "rejected" as const, rationale: "not applicable", evidence: "fixture rejection evidence" };
    }));
    const candidate: TriageCandidate = {
      schema_version: "1",
      task_id: task,
      phase_instance: phase,
      step: "triage",
      subject_digest: current.subject_digest,
      input_fingerprint: current.input_fingerprint,
      current_evidence_set_digest: current.current_evidence_set.set_digest,
      source_evidence_digests: current.reviews.map((review) => review.evidence_digest),
      dispositions,
      accepted_count: dispositions.filter((d) => d.disposition === "accepted").length,
      rejected_count: dispositions.filter((d) => d.disposition === "rejected").length,
      accepted_editorial_count: dispositions.filter((d) => d.disposition === "accepted-editorial").length,
      escalated_human_count: 0,
      deferred_count: 0,
    };
    validateTriage(current, candidate);
    const prepared = await prepareEvidence(h, `triage-v${version}`, { kind: "triage", current_reviews: current, evidence: candidate });
    await commitStateEvidence(h, dependencies, `triage-intent-v${version}`, prepared, {
      schema_version: "1", artifact_kind: "triage", evidence: candidate,
    });
  }

  it("dispatches only the reviewer that raised findings in a remediation round, with its own prior-triage record", async () => {
    const h = await fixture();
    const { store } = memoryStore();
    const subjects = [canonicalJsonDigest({ artifact: 0 }), canonicalJsonDigest({ artifact: 1 }), canonicalJsonDigest({ artifact: 2 })] as const;
    const fingerprints = [computeInputFingerprint(fingerprintSubject(0)), computeInputFingerprint(fingerprintSubject(1)), computeInputFingerprint(fingerprintSubject(2))] as const;

    // Round 1: a full review; sol passes cleanly, fable raises a blocker carrying its tag.
    const first = await round(h, store, subjects[0], fingerprints[0], { clean_reviewer: SOL }, true);
    expect(first.models).toEqual([SOL, FABLE, LUNA, ADJUDICATOR].sort());
    expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
    if (!first.result.ok) return;
    expect(first.result.value.evidence.findings.map((finding) => finding.finding_id))
      .toEqual(["general-2-counter-review-blocker"]);

    // The producer accepts fable's finding, then revises.
    await commitTriageDecisions(h, h.dependencies, 0, () => "accepted");
    const dependencies = await rewrite(h, h.dependencies, 1);

    // Round 2: only fable is asked to confirm its fix; sol, which raised nothing, is not
    // re-dispatched. The constitution child still runs against the revised bytes.
    const second = await round(h, store, subjects[1], fingerprints[1], {}, true, { dependencies, version: 1, remediation: true });
    expect(second.models).toEqual([SOL, FABLE, ADJUDICATOR].sort());
    expect(second.result.ok, JSON.stringify(second.result)).toBe(true);
    if (!second.result.ok) return;

    const fableEnvelope = second.envelopes.get(FABLE) as {
      instructions: { prior_triage?: string };
      context: { kind: string; status: string; content?: string }[];
    };
    expect(fableEnvelope.instructions.prior_triage).toMatch(/remediation review, not a new full review/u);
    const priorEntry = fableEnvelope.context.find((entry) => entry.kind === "prior-triage");
    expect(priorEntry?.status).toBe("pinned");
    const rendered = JSON.parse(priorEntry!.content!) as { dispositions: { finding_id: string; disposition: string }[] };
    expect(rendered.dispositions).toEqual([
      expect.objectContaining({ finding_id: "general-2-counter-review-blocker", disposition: "accepted" }),
    ]);

    // Fable's tag is stable even though it ran alone, so round 3 can still attribute its findings.
    expect(second.result.value.evidence.findings.map((finding) => finding.finding_id)).toEqual(["general-2-counter-review-blocker"]);
    const review = second.result.value.evidence;
    expect(review.assurance).toBe("server-attested");
    if (review.assurance !== "server-attested") return;
    expect(second.result.value.constitution_evidence?.source_review_envelope_digest).toBe(review.envelope_input_digest);

    // Round 3 receives only round 2's latest accepted disposition. The cumulative ledger remains
    // durable, but it is not fanned into the child prompt.
    await commitTriageDecisions(h, dependencies, 1, () => "accepted");
    const dependenciesV2 = await rewrite(h, dependencies, 2);
    const third = await round(h, store, subjects[2], fingerprints[2], {}, true, {
      dependencies: dependenciesV2, version: 2, remediation: true,
    });
    expect(third.models).toEqual([SOL, FABLE, ADJUDICATOR].sort());
    const latest = priorRecord(third.envelopes.get(FABLE));
    expect(latest.dispositions).toHaveLength(1);
    expect(latest.dispositions).toEqual([
      expect.objectContaining({ finding_id: "general-2-counter-review-blocker", disposition: "accepted", attempt: 3 }),
    ]);
  });

  it("does not reopen an ownerless primary rubric during PRD remediation", async () => {
    const h = await fixture();
    const { store } = memoryStore();
    const subjects = [canonicalJsonDigest({ prd: 0 }), canonicalJsonDigest({ prd: 1 })] as const;
    const fingerprints = [computeInputFingerprint(fingerprintSubject(0)), computeInputFingerprint(fingerprintSubject(1))] as const;

    const first = await round(h, store, subjects[0], fingerprints[0], { clean_reviewer: SOL }, true, {
      phase_kind: "prd",
    });
    expect(first.models).toEqual([SOL, FABLE, ADJUDICATOR].sort());
    expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
    if (!first.result.ok) return;
    expect(first.result.value.evidence.findings.map((finding) => finding.finding_id))
      .toEqual(["general-2-counter-review-blocker"]);

    await commitTriageDecisions(h, h.dependencies, 0, () => "accepted");
    const dependencies = await rewrite(h, h.dependencies, 1);
    const second = await round(h, store, subjects[1], fingerprints[1], {}, true, {
      dependencies, version: 1, remediation: true, phase_kind: "prd",
    });

    expect(second.result.ok, JSON.stringify(second.result)).toBe(true);
    expect(second.models).toEqual([FABLE, ADJUDICATOR].sort());
    expect(second.envelopes.has(SOL)).toBe(false);
    expect(second.envelopes.get(FABLE)).toMatchObject({
      assignment: { reviewer_id: "general-2", focus: "general", criterion_ids: ["correctness"] },
    });
  });

  it("dispatches only the test specialist to confirm its finding in remediation", async () => {
    const h = await fixture();
    const { store } = memoryStore();
    const subjects = [canonicalJsonDigest({ specialist: 0 }), canonicalJsonDigest({ specialist: 1 })] as const;
    const fingerprints = [computeInputFingerprint(fingerprintSubject(0)), computeInputFingerprint(fingerprintSubject(1))] as const;

    const first = await round(h, store, subjects[0], fingerprints[0], { clean_reviewer: SOL }, true, {
      config: specialistReviewConfig,
    });
    expect(first.models).toEqual([SOL, LUNA, ADJUDICATOR].sort());
    expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
    if (!first.result.ok) return;
    expect(first.result.value.evidence.findings.map((finding) => finding.finding_id))
      .toEqual(["test-counter-review-blocker"]);

    await commitTriageDecisions(h, h.dependencies, 0, () => "accepted");
    const dependencies = await rewrite(h, h.dependencies, 1);
    const second = await round(h, store, subjects[1], fingerprints[1], {}, true, {
      dependencies, version: 1, remediation: true, config: specialistReviewConfig,
    });
    expect(second.models).toEqual([SOL, LUNA, ADJUDICATOR].sort());
    const specialistEnvelope = second.envelopes.get(LUNA) as {
      assignment: { reviewer_id: string; focus: string; criterion_ids: string[] };
      context: { kind: string; content?: string }[];
    };
    expect(specialistEnvelope.assignment).toEqual({
      reviewer_id: "test", focus: "tests", criterion_ids: ["verification-evidence"],
    });
    const prior = specialistEnvelope.context.find((entry) => entry.kind === "prior-triage");
    expect(prior?.content).toContain("test-counter-review-blocker");
  });

  it("keeps a stable test owner across route reconfiguration and still dispatches primary alignment", async () => {
    const h = await fixture();
    const { store } = memoryStore();
    const subjects = [canonicalJsonDigest({ reconfigured: 0 }), canonicalJsonDigest({ reconfigured: 1 })] as const;
    const fingerprints = [computeInputFingerprint(fingerprintSubject(0)), computeInputFingerprint(fingerprintSubject(1))] as const;
    const first = await round(h, store, subjects[0], fingerprints[0], { clean_reviewer: SOL }, true, {
      config: specialistReviewConfig,
    });
    expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
    if (!first.result.ok) return;
    await commitTriageDecisions(h, h.dependencies, 0, () => "accepted");
    const dependencies = await rewrite(h, h.dependencies, 1);

    const second = await round(h, store, subjects[1], fingerprints[1], {}, true, {
      dependencies, version: 1, remediation: true, config: multiReviewConfig,
    });
    expect(second.models).toEqual([SOL, LUNA, ADJUDICATOR].sort());
    expect(second.envelopes.has(FABLE)).toBe(false);
    const envelope = second.envelopes.get(SOL) as {
      assignment: { focus: string; criterion_ids: string[]; expected_upstream_digests: string[] };
      context: { kind: string; content?: string }[];
    };
    expect(envelope.assignment.focus).toBe("general");
    expect(envelope.assignment.criterion_ids).toEqual([]);
    expect(envelope.assignment.expected_upstream_digests).toEqual([]);
    const testEnvelope = second.envelopes.get(LUNA) as { context: { kind: string; content?: string }[] };
    expect(testEnvelope.context.find((entry) => entry.kind === "prior-triage")?.content)
      .toContain("test-counter-review-blocker");
  });

  it("records invocation and one-dispatch override provenance independently for the test reviewer", async () => {
    const invokedModel = "gpt-5.6-luna-invoked";
    const invokedHarness = await fixture();
    const invoked = await round(
      invokedHarness,
      memoryStore().store,
      canonicalJsonDigest({ invoked: true }),
      computeInputFingerprint(fingerprintSubject(0)),
      {},
      true,
      {
        config: specialistReviewConfig,
        invocation_routes: { "test-reviewer": { model: invokedModel, effort: "xhigh" } },
      },
    );
    expect(invoked.result.ok, JSON.stringify(invoked.result)).toBe(true);
    if (!invoked.result.ok || invoked.result.value.evidence.assurance !== "server-attested") return;
    expect(invoked.result.value.evidence.reviewer_runs?.find((run) => run.focus === "tests")).toMatchObject({
      reviewer_id: "test", model: invokedModel, effort: "xhigh",
      criterion_ids: ["verification-evidence", "test-quality"],
      route_source: {
        provenance: "invocation-declared",
        displaced: { source: "configured", model: LUNA, effort: "max" },
      },
    });

    const overrideModel = "gpt-5.6-luna-override";
    const overrideHarness = await fixture();
    const overridden = await round(
      overrideHarness,
      memoryStore().store,
      canonicalJsonDigest({ overridden: true }),
      computeInputFingerprint(fingerprintSubject(0)),
      {
        declaration: {
          reason: "the configured test reviewer is temporarily unavailable",
          "test-reviewer": { model: overrideModel, effort: "xhigh" },
        },
      },
      true,
      { config: specialistReviewConfig },
    );
    expect(overridden.result.ok, JSON.stringify(overridden.result)).toBe(true);
    if (!overridden.result.ok || overridden.result.value.evidence.assurance !== "server-attested") return;
    expect(overridden.result.value.evidence.reviewer_runs?.find((run) => run.focus === "tests")).toMatchObject({
      reviewer_id: "test", model: overrideModel,
      route_source: { provenance: "route-override" },
      route_override: { reason: "the configured test reviewer is temporarily unavailable", pinned_model: LUNA, pinned_effort: "max" },
    });
  });

  it("attributes a specialist dispatch failure to test-reviewer", async () => {
    const h = await fixture();
    const failures: string[] = [];
    await expect(round(
      h,
      memoryStore().store,
      canonicalJsonDigest({ specialist_failure: true }),
      computeInputFingerprint(fingerprintSubject(0)),
      { fail_reviewer: LUNA },
      true,
      { config: specialistReviewConfig, observed_failures: failures },
    )).rejects.toBeInstanceOf(DispatchRoutingError);
    expect(failures).toEqual(["test-reviewer"]);
  });

  it("fails an invalid specialist route before launching any review child", async () => {
    const h = await fixture();
    const failures: string[] = [];
    const models: string[] = [];
    const invalidConfig: ConfigV1 = {
      ...specialistReviewConfig,
      roles: {
        ...specialistReviewConfig.roles,
        "test-reviewer": { model: "not a safe model" as never, effort: "max" },
      },
    };
    await expect(round(
      h,
      memoryStore().store,
      canonicalJsonDigest({ invalid_specialist: true }),
      computeInputFingerprint(fingerprintSubject(0)),
      {},
      true,
      { config: invalidConfig, observed_failures: failures, observed_models: models },
    )).rejects.toBeInstanceOf(DispatchRoutingError);
    expect(failures).toEqual(["test-reviewer"]);
    expect(models).toEqual([]);
  });

  it("binds specialist output validation failure to test-reviewer, preserves general scope, and retains valid siblings", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ specialist_validation_failure: true });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const failures: string[] = [];
    const { store, records } = memoryStore();

    const first = await round(h, store, subject, fingerprint, { invalid_reviewer: LUNA }, true, {
      config: specialistReviewConfig,
      observed_failures: failures,
    });
    expect(first.result.ok).toBe(false);
    if (first.result.ok) return;
    expect(first.result.error).toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      diagnostic: { parameters: { issue_code: "review-schema-invalid" } },
    });
    expect(failures).toEqual([]);
    expect(first.envelopes.get(LUNA)).toMatchObject({
      assignment: {
        reviewer_id: "test", focus: "tests",
        criterion_ids: ["verification-evidence", "test-quality"],
      },
    });
    expect(first.envelopes.get(SOL)).toMatchObject({
      assignment: { reviewer_id: "general", focus: "general", criterion_ids: ["correctness"] },
    });
    expect([...records.values()].map((record) => record.binding.role).sort())
      .toEqual(["adjudicator", "counter-reviewer"]);

    const retried = await round(h, store, subject, fingerprint, {}, false, {
      config: specialistReviewConfig,
    });
    expect(retried.models).toEqual([LUNA]);
    expect(retried.result.ok, JSON.stringify(retried.result)).toBe(true);
  });

  it("selects identical policy gates from archived adjudication drift and fresh Review V3 alignment", () => {
    const subjectDigest = canonicalJsonDigest({ policy_parity: "subject" });
    const inputFingerprint = canonicalJsonDigest({ policy_parity: "input" });
    const reviewEnvelope = canonicalJsonDigest({ policy_parity: "review-envelope" });
    const upstreamDigest = canonicalJsonDigest({ policy_parity: "upstream" });
    const ruleFinding = {
      rule_id: "task-isolation", rule_version: 1,
      compliance: "pass" as const, rationale: "The task remains isolated.",
      trigger: "not-matched" as const, trigger_evidence: "No cross-task access exists.",
    };
    const driftFinding = {
      upstream_digest: upstreamDigest, drift: "material" as const,
      affected_claim_ids: ["approved-claim"], rationale: "The approved claim changed materially.",
    };
    const archivedReview = {
      schema_version: "2", assurance: "server-attested",
      subject_digest: subjectDigest, input_fingerprint: inputFingerprint,
      envelope_input_digest: reviewEnvelope,
    } as unknown as ReviewEvidence;
    const archivedAdjudication = {
      schema_version: "1", assurance: "server-attested",
      subject_digest: subjectDigest, input_fingerprint: inputFingerprint,
      source_review_envelope_digest: reviewEnvelope,
      rule_findings: [ruleFinding], drift_findings: [driftFinding],
      constitution: "pass", drift: "material",
      matched_rule_versions: [], uncertain_rule_versions: [],
    } as unknown as AdjudicationEvidence;
    const freshReview = {
      schema_version: "3", assurance: "server-attested",
      subject_digest: subjectDigest, input_fingerprint: inputFingerprint,
      envelope_input_digest: reviewEnvelope,
      upstream_alignment: [driftFinding],
    } as unknown as ReviewEvidence;
    const freshAdjudication = {
      schema_version: "2", assurance: "server-attested",
      subject_digest: subjectDigest, input_fingerprint: inputFingerprint,
      source_review_envelope_digest: reviewEnvelope,
      rule_findings: [ruleFinding], constitution: "pass",
      matched_rule_versions: [], uncertain_rule_versions: [],
    } as unknown as AdjudicationEvidence;

    const archived = selectPolicyReviewGates(
      constitution.rules,
      policyReviewFacts(archivedReview, archivedAdjudication, true),
    );
    const fresh = selectPolicyReviewGates(
      constitution.rules,
      policyReviewFacts(freshReview, freshAdjudication, true),
    );
    expect(fresh).toEqual(archived);
    expect(fresh.map((gate) => gate.kind)).toEqual(["material-drift"]);
  });

  /** Runs a full two-reviewer round, triages it as decided, revises, and returns the remediation round. */
  async function remediationAfter(
    h: Harness,
    decide: (findingId: string) => TriageMode,
    firstRound: RoundBehaviour = {},
  ) {
    const { store } = memoryStore();
    const first = await round(h, store, canonicalJsonDigest({ artifact: 0 }), computeInputFingerprint(fingerprintSubject(0)), firstRound, true);
    expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
    await commitTriageDecisions(h, h.dependencies, 0, decide);
    const dependencies = await rewrite(h, h.dependencies, 1);
    const second = await round(
      h, store, canonicalJsonDigest({ artifact: 1 }), computeInputFingerprint(fingerprintSubject(1)), {}, true,
      { dependencies, version: 1, remediation: true },
    );
    expect(second.result.ok, JSON.stringify(second.result)).toBe(true);
    return second;
  }

  const priorRecord = (envelope: unknown) => {
    const entry = (envelope as { context: { kind: string; status: string; content?: string }[] }).context
      .find((candidate) => candidate.kind === "prior-triage");
    expect(entry?.status).toBe("pinned");
    return JSON.parse(entry!.content!) as { coverage: string; dispositions: { finding_id: string; disposition: string }[] };
  };

  it("dispatches only owners of accepted findings; rejected findings are closed", async () => {
    const h = await fixture();
    const second = await remediationAfter(h, (findingId) => findingId.startsWith("general-2-") ? "accepted" : "rejected");
    expect(second.models).toEqual([SOL, FABLE, ADJUDICATOR].sort());
    expect(priorRecord(second.envelopes.get(FABLE)).dispositions)
      .toEqual([expect.objectContaining({ finding_id: "general-2-counter-review-blocker", disposition: "accepted" })]);
    if (!second.result.ok) return;
    const review = second.result.value.evidence;
    if (review.assurance !== "server-attested") throw new Error("expected server-attested review");
    expect(review.envelope_input_digest).toBe(second.digests.get(SOL));
    expect(second.result.value.constitution_evidence?.source_review_envelope_digest).toBe(second.digests.get(SOL));
  });

  it("leaves out a reviewer whose only findings were accepted editorially", async () => {
    const h = await fixture();
    // Only a non-blocking finding may be accepted editorially, so sol raises an advisory one.
    const second = await remediationAfter(h, (findingId) =>
      findingId.startsWith("general-2-") ? "accepted" : findingId.startsWith("general-1-") ? "editorial" : "rejected",
    { advisory_reviewer: SOL });
    expect(second.models).toEqual([SOL, FABLE, ADJUDICATOR].sort());
  });

  it("keeps exact V3 stable owners instead of transferring them by finding prose", async () => {
    const h = await fixture();
    // Round 1 ran under a one-reviewer override, so its finding id carries no reviewer tag.
    const second = await remediationAfter(h, () => "accepted", {
      declaration: { reason: "fable CLI outage; reviewing on sol alone for this dispatch", "counter-reviewer": { model: SOL, effort: "high" } },
    });
    expect(second.models).toEqual([SOL, ADJUDICATOR].sort());
    const record = priorRecord(second.envelopes.get(SOL));
    expect(record.coverage).toMatch(/latest accepted findings/u);
    expect(record.dispositions).toEqual([expect.objectContaining({ finding_id: "general-counter-review-blocker", disposition: "accepted" })]);
    expect(second.envelopes.has(FABLE)).toBe(false);
  });

  it("keeps both reviewer outputs when the constitution child fails and retries only that child", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store, records } = memoryStore();

    await expect(round(h, store, subject, fingerprint, { fail_adjudicator: true }, true))
      .rejects.toSatisfy((error: unknown) => error instanceof DispatchRoutingError && error.project_error.code === "PROCESS_FAILED");
    expect([...records.values()].map((record) => record.binding.role).sort()).toEqual(["counter-reviewer", "counter-reviewer", "test-reviewer"]);

    const retried = await round(h, store, subject, fingerprint, {}, false);
    expect(retried.models).toEqual([ADJUDICATOR]);
    expect(retried.result.ok, JSON.stringify(retried.result)).toBe(true);
    if (!retried.result.ok) return;
    expect(retried.result.value.evidence.findings.map((finding) => finding.finding_id)).toEqual([
      "general-1-counter-review-blocker",
      "general-2-counter-review-blocker",
    ]);
    const review = retried.result.value.evidence;
    expect(review.schema_version).toBe("3");
    if (review.schema_version !== "3") return;
    expect(review.total_findings).toBe(2);
    expect(review.assurance).toBe("server-attested");
    if (review.assurance !== "server-attested") return;
    expect(retried.result.value.constitution_evidence?.source_review_envelope_digest).toBe(review.envelope_input_digest);
    // The committed round no longer needs its retained outputs.
    expect(records.size).toBe(0);
  });

  it("keeps the passing reviewer and the constitution result when one reviewer fails, and retries only that reviewer", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store, records } = memoryStore();

    const first = round(h, store, subject, fingerprint, { fail_reviewer: FABLE }, true);
    await expect(first).rejects.toBeInstanceOf(DispatchRoutingError);
    expect([...records.values()].map((record) => record.binding.role).sort()).toEqual(["adjudicator", "counter-reviewer", "test-reviewer"]);

    const retried = await round(h, store, subject, fingerprint, {}, false);
    expect(retried.models).toEqual([FABLE]);
    expect(retried.result.ok, JSON.stringify(retried.result)).toBe(true);
    if (!retried.result.ok) return;
    // Reused sol plus fresh fable merge in config order, and the reused constitution result still
    // binds to the round the reused review answered.
    expect(retried.result.value.evidence.findings.map((finding) => finding.finding_id))
      .toEqual(["general-1-counter-review-blocker", "general-2-counter-review-blocker"]);
    const review = retried.result.value.evidence;
    if (review.assurance !== "server-attested") throw new Error("expected server-attested review");
    expect(retried.result.value.constitution_evidence?.source_review_envelope_digest).toBe(review.envelope_input_digest);
    expect(records.size).toBe(0);
  });

  it("reports invalid constitution output as MODEL_OUTPUT_INVALID and retains both reviewer outputs", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store, records } = memoryStore();

    const first = await round(h, store, subject, fingerprint, { invalid_adjudicator: true }, true);
    expect(first.result.ok).toBe(false);
    if (first.result.ok) return;
    expect(first.result.error.code).toBe("MODEL_OUTPUT_INVALID");
    expect(first.result.error.diagnostic.parameters).toMatchObject({ issue_code: "adjudication-rule-slot-coverage" });
    expect([...records.values()].map((record) => record.binding.role)).toEqual(["counter-reviewer", "counter-reviewer", "test-reviewer"]);

    const retried = await round(h, store, subject, fingerprint, {}, false);
    expect(retried.models).toEqual([ADJUDICATOR]);
    expect(retried.result.ok, JSON.stringify(retried.result)).toBe(true);
    expect(records.size).toBe(0);
  });

  it("waits for a slow sibling before surfacing a failure, so its output is retained", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store, records } = memoryStore();

    // The constitution child fails at once; fable answers 30ms later. A fail-fast round would
    // reject before fable's output existed.
    await expect(round(h, store, subject, fingerprint, { fail_adjudicator: true, delay: { [FABLE]: 30 } }, true))
      .rejects.toBeInstanceOf(DispatchRoutingError);
    expect([...records.values()].map((record) => record.binding.selection.route.model).sort()).toEqual([FABLE, LUNA, SOL].sort());
    const retried = await round(h, store, subject, fingerprint, {}, false);
    expect(retried.models).toEqual([ADJUDICATOR]);
    expect(retried.result.ok, JSON.stringify(retried.result)).toBe(true);
  });

  it("surfaces the first failure to finish, matching the failure observation slot", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store, records } = memoryStore();

    // sol (first in config order) dies slowly with an outage; fable returns invalid output at once.
    const first = await round(h, store, subject, fingerprint, { fail_reviewer: SOL, delay: { [SOL]: 30 }, invalid_reviewer: FABLE }, true);
    expect(first.result.ok).toBe(false);
    if (first.result.ok) return;
    expect(first.result.error.code).toBe("MODEL_OUTPUT_INVALID");
    expect([...records.values()].map((record) => record.binding.role).sort()).toEqual(["adjudicator", "test-reviewer"]);
  });

  it("re-dispatches a child whose retained output no longer validates", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store, records } = memoryStore();

    await expect(round(h, store, subject, fingerprint, { fail_adjudicator: true }, true)).rejects.toBeInstanceOf(DispatchRoutingError);
    // Corrupt sol's retained output into a review of a different subject: it still parses, but
    // re-minting under this round's binding rejects it, so sol is dispatched again.
    for (const record of records.values()) {
      if (record.binding.selection.route.model === SOL) {
        record.extracted_output_bytes = canonicalJsonBytes(reviewOutput("counter-review", canonicalJsonDigest({ artifact: 99 }), fingerprint, "clean"));
      }
    }
    const retried = await round(h, store, subject, fingerprint, {}, false);
    expect(retried.models).toEqual([SOL, ADJUDICATOR].sort());
    expect(retried.result.ok, JSON.stringify(retried.result)).toBe(true);
  });

  it("reports invalid reviewer output as MODEL_OUTPUT_INVALID and still retains the valid siblings", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store, records } = memoryStore();

    const first = await round(h, store, subject, fingerprint, { invalid_reviewer: FABLE }, true);
    expect(first.result.ok).toBe(false);
    if (first.result.ok) return;
    expect(first.result.error.code).toBe("MODEL_OUTPUT_INVALID");
    expect(first.result.error.diagnostic.parameters).toMatchObject({ adapter: "codex-cli", issue_code: "review-schema-invalid" });
    expect([...records.values()].map((record) => record.binding.role).sort()).toEqual(["adjudicator", "counter-reviewer", "test-reviewer"]);

    const retried = await round(h, store, subject, fingerprint, {}, false);
    expect(retried.models).toEqual([FABLE]);
    expect(retried.result.ok, JSON.stringify(retried.result)).toBe(true);
    if (!retried.result.ok) return;
    expect(retried.result.value.evidence.findings).toHaveLength(2);
    expect(records.size).toBe(0);
  });

  it("reuses retained siblings under a route override for the failed role", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store } = memoryStore();

    await expect(round(h, store, subject, fingerprint, { fail_adjudicator: true }, true)).rejects.toBeInstanceOf(DispatchRoutingError);

    // Substituting the adjudicator route changes nothing about the retained reviewer outputs.
    const substituted = "gpt-fixture-substitute";
    const overridden = await round(h, store, subject, fingerprint, {
      declaration: { reason: "adjudicator CLI outage; substituting for this dispatch", adjudicator: { model: substituted, effort: "high" } },
    }, false);
    expect(overridden.models).toEqual([substituted]);
    expect(overridden.result.ok, JSON.stringify(overridden.result)).toBe(true);
    if (!overridden.result.ok) return;
    const constitutionEvidence = overridden.result.value.constitution_evidence;
    expect(constitutionEvidence?.assurance).toBe("server-attested");
    if (constitutionEvidence?.assurance !== "server-attested") return;
    expect(constitutionEvidence.model).toBe(substituted);
    expect(constitutionEvidence.route_override).toMatchObject({ pinned_model: ADJUDICATOR });
    expect(overridden.result.value.evidence.findings).toHaveLength(2);
  });

  it("does not reuse a reviewer output whose route was selected under different provenance", async () => {
    const h = await fixture();
    const subject = canonicalJsonDigest({ artifact: 0 });
    const fingerprint = computeInputFingerprint(fingerprintSubject(0));
    const { store } = memoryStore();

    await expect(round(h, store, subject, fingerprint, { fail_adjudicator: true }, true)).rejects.toBeInstanceOf(DispatchRoutingError);

    // The override names the same sol route, but as a substitution: the retained configured-route
    // output must not be presented as an override-route review, so sol is dispatched again.
    const overridden = await round(h, store, subject, fingerprint, {
      declaration: { reason: "reviewing on a single reviewer for this dispatch", "counter-reviewer": { model: SOL, effort: "high" } },
    }, false);
    expect(overridden.models).toEqual([SOL, ADJUDICATOR].sort());
    expect(overridden.result.ok, JSON.stringify(overridden.result)).toBe(true);
    if (!overridden.result.ok) return;
    const review = overridden.result.value.evidence;
    expect(review.findings).toHaveLength(1);
    expect(review.assurance).toBe("server-attested");
    if (review.assurance !== "server-attested") return;
    expect(review.route_override).toMatchObject({ pinned_model: SOL });
  });
});

async function commitDesignProduce(
  h: Harness,
  version: number,
  designText: string = "# Design\n\n### Phase 1: Foundation\n### Phase 2: Core\n### Phase 3: Integration\n",
): Promise<{ subject: Sha256Digest; fingerprint: Sha256Digest }> {
  const currentState = await durableState(h.authority);
  const fingerprint = computeInputFingerprint(fingerprintSubject(version));
  const bytes = new TextEncoder().encode(designText);
  const outputPath = parseRepositoryPathClaim(`.archflow/tasks/${task}/design.md`);
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
    document_path: parseTaskPathClaim("design.md"),
    path_class: "document",
    byte_count: byteCount,
    content_digest: contentDigest,
    declared_inputs: [],
    input_fingerprint: fingerprint,
    snapshot_digest: snapshotDigest,
    projection_target: outputPath,
  };
  const artifactDigest = canonicalJsonDigest(artifact);
  const resultId = parseSafeId(`produce-design-v${version}`);
  const manifestValue: ResultManifestV1 = {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: h.authority.repository_identity_digest,
    result_id: resultId,
    phase_instance: phase,
    step: "produce",
    artifact_digest: artifactDigest,
    source_artifact: artifact,
    input_fingerprint: fingerprint,
    snapshot_digest: snapshotDigest,
    outputs: [output],
    projections,
    accounting: {
      schema_version: "1",
      result_bytes: byteCount,
      task_bytes: byteCount,
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: [{
        path: outputPath,
        storage: "raw-payload",
        stored_bytes: byteCount,
      }],
      measured_at_revision: currentState.revision,
    },
    secret_scan: {
      schema_version: "1",
      outcome: "clean",
      detector_set_id: parseSafeId("fixed-point-test"),
      scanned_paths: [outputPath],
    },
  };
  const manifestDoc = canonicalDocument(manifestValue);
  const manifestPath = join(h.root, `.archflow/tasks/${task}/authority/results/${manifestDoc.digest}.json`);
  const payloadPath = join(h.root, `.archflow/runtime/tasks/${task}/cache/results/${manifestDoc.digest}/payload/${outputPath}`);
  const projectedPath = join(h.root, outputPath);

  await mkdir(dirname(manifestPath), { recursive: true });
  await mkdir(dirname(payloadPath), { recursive: true });
  await mkdir(dirname(projectedPath), { recursive: true });

  await writeFile(manifestPath, manifestDoc.bytes);
  await writeFile(payloadPath, bytes);
  await writeFile(projectedPath, bytes);

  const produceRef: AuthoritativeResultRef = {
    phase_instance: phase,
    step: "produce",
    result_digest: manifestDoc.digest,
    result_id: resultId,
    input_fingerprint: fingerprint,
  };

  const updatedState: TaskStateV1 = {
    ...currentState,
    input_fingerprint: fingerprint,
    authoritative_results: [
      ...currentState.authoritative_results.filter((r) => r.step !== "produce"),
      produceRef,
    ],
  };
  await writeFile(h.authority.state.absolute, canonicalDocument(updatedState).bytes);
  return { subject: artifactDigest, fingerprint };
}

async function recordAuthenticatedApproval(
  h: Harness,
  gateId: string,
  kind: "commit-authorization" | "design-approval" | "artifact-approval" = "design-approval",
  subjectDigest: Sha256Digest = canonicalJsonDigest({}),
  currentEvidence: CurrentEvidenceSetRef = { set_digest: canonicalJsonDigest({}), slots: [] as never },
): Promise<AuthenticatedGateApproval> {
  const currentState = await durableState(h.authority);
  const symbolicRef = await h.dependencies.runner.runText({
    argv: ["symbolic-ref", "--quiet", "HEAD"],
    operation: parseSafeCode("git-design-approval-target"),
    expectedAbsence: [{ code: 1, stderrIncludes: "" }],
  });
  const headCommit = await resolveCommit(h.dependencies.runner, "HEAD");
  const targetRef = symbolicRef === "" ? "HEAD" : symbolicRef;
  const baselineCommit = headCommit;

  const context = kind === "commit-authorization"
    ? {
        target_ref: targetRef,
        baseline_commit: baselineCommit,
        commit_message: "Authorize commit",
        paths: ["tracked.txt"],
        diff_digest: subjectDigest,
        current_artifact_digests: [subjectDigest],
        parent_document_digests: [],
        ...ordinaryApprovalFacts("phase-impl", subjectDigest),
      }
    : {
        artifact_kind: "design" as const,
        ...ordinaryApprovalFacts("design", subjectDigest),
        target_ref: targetRef,
        baseline_commit: baselineCommit,
        commit_message: "Design approved",
      };
  const contextDigest = computeGateContextDigest(kind, context as never);
  const gateInput = {
    authority: h.authority,
    expected_revision: currentState.revision,
    intent_id: parsePathSafeId(`intent-${gateId}`),
    request_digest: sha256Bytes(new TextEncoder().encode(`request-${gateId}`)),
    input_fingerprint: currentState.input_fingerprint,
    phase_instance: phase,
    summary: `Authorize ${kind}`,
    subject_digest: subjectDigest,
    current_evidence: currentEvidence,
    kind,
    context: context as never,
  };
  const opened = await openDurableGate(h.dependencies, gateInput);
  if (!opened.ok) throw new Error(`openDurableGate failed: ${JSON.stringify(opened.error)}`);

  const decisionPayload = kind === "commit-authorization"
    ? { decision: "authorize-commit" as const, reason: "Reviewed in fixture" }
    : { decision: "approve" as const, reason: "Reviewed in fixture" };

  await mkdir(join(h.authority.workspace_root, "cache", "gates"), { recursive: true });
  await writeFile(join(h.authority.workspace_root, "cache", "gates", "gate.decision"), canonicalDocument({
    schema_version: "1",
    gate_id: opened.value.gate_id,
    task_id: task,
    phase_instance: phase,
    kind,
    subject_digest: subjectDigest,
    context_digest: contextDigest,
    human_provenance: {
      schema_version: "1",
      actor_class: "human",
      assurance: "declared-local-trace",
      channel: "archflow-local",
      decision_event_id: `decision-${gateId}`,
      helper_invocation_id: `helper-${gateId}`,
      recorded_at: "2026-08-03T12:00:00.000Z",
    },
    payload: decisionPayload,
  }).bytes);

  const resolved = await resolveInterfaceGateDecision(h.dependencies, h.authority, opened.value.gate_id);
  if (!resolved.ok) throw new Error(`resolveInterfaceGateDecision failed: ${JSON.stringify(resolved)}`);

  const stateAfter = await durableState(h.authority);
  const approvalRef = stateAfter.approvals.find((a) => a.gate_id === opened.value.gate_id);
  if (approvalRef === undefined) throw new Error("approval not found in state");

  const loaded = await loadAuthenticatedGateApproval(h.dependencies, h.authority, approvalRef);
  if (!loaded.ok) throw new Error(`loadAuthenticatedGateApproval failed: ${JSON.stringify(loaded)}`);
  return loaded.value;
}

describe("review fixed-point lifecycles", () => {
  it("mixed accepted-plus-escalated lifecycle: presents human gate first, then advances through attempt-N+1 produce into counter-review upon approval", async () => {
    const h = await fixture();
    const dependencies = h.dependencies;
    const { subject, fingerprint } = await commitDesignProduce(h, 0);

    await commitCounter(h, dependencies, 0, subject, fingerprint, "multiple");
    await commitTriage(h, dependencies, 0, "mixed-accepted-escalated");

    const triageAssessment = await assessment(h, dependencies, subject, fingerprint);
    expect(triageAssessment.escalated_human_findings).toBe(true);
    expect(triageAssessment.every_finding_dispositioned).toBe(true);
    expect(triageAssessment.next).toBe("advance");

    const state = await durableState(h.authority);
    const loaded = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(state), phase);
    if (!loaded.ok) throw new Error(loaded.error.code);
    const currentEvidence = deriveCurrentEvidenceSet(loaded.value).current_evidence_set;

    const approval = await recordAuthenticatedApproval(
      h, "approval-1", "design-approval", subject, currentEvidence,
    );

    const afterApproval = await assessment(h, dependencies, subject, fingerprint, undefined, [approval]);
    expect(afterApproval.reentry_required).toBe(true);
    expect(afterApproval.next).toBe("produce");
  });

  it("byte-identical re-production lifecycle: proceeds to counter-review rather than re-triggering produce", async () => {
    const h = await fixture();
    const dependencies = h.dependencies;
    const { subject, fingerprint } = await commitDesignProduce(h, 0);

    await commitCounter(h, dependencies, 0, subject, fingerprint, "accepted");
    await commitTriage(h, dependencies, 0, "escalated");

    const state = await durableState(h.authority);
    const loaded = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(state), phase);
    if (!loaded.ok) throw new Error(loaded.error.code);
    const currentEvidence = deriveCurrentEvidenceSet(loaded.value).current_evidence_set;

    const approval = await recordAuthenticatedApproval(
      h, "approval-byte-identical", "design-approval", subject, currentEvidence,
    );

    // Fresh produce in attempt 2 with identical subject bytes drops prior attempt review evidence
    const currentState = await durableState(h.authority);
    const stateAttempt2: TaskStateV1 = {
      ...currentState,
      attempt: parseSafeInteger(2),
      step: "produce",
      status: "succeeded",
      authoritative_results: currentState.authoritative_results.filter((r) => r.step === "produce"),
    };
    await writeFile(h.authority.state.absolute, canonicalDocument(stateAttempt2).bytes);

    const loaded2 = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(stateAttempt2), phase);
    if (!loaded2.ok) throw new Error(loaded2.error.code);

    const check = assessCurrentEvidence(stateAttempt2, loaded2.value, {
      subject_digest: subject,
      input_fingerprint: fingerprint,
      constitution,
      approved_upstream_digests: [],
      authenticated_gate_approvals: [approval],
    });
    expect(check.current).not.toContain("counter_review");
    expect(check.next).toBe("counter_review");
  });

  it("constitution-plus-escalation lifecycle: single ordinary approval satisfies folded gate without second gate", async () => {
    const h = await fixture();
    const dependencies = h.dependencies;
    const { subject, fingerprint } = await commitDesignProduce(h, 0);

    await commitCounter(h, dependencies, 0, subject, fingerprint, "accepted");
    await commitTriage(h, dependencies, 0, "escalated");

    const state = await durableState(h.authority);
    const loaded = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(state), phase);
    if (!loaded.ok) throw new Error(loaded.error.code);

    const envelopeDigest = retainedReviewEnvelopeDigest(loaded.value);
    if (envelopeDigest === undefined) throw new Error("review envelope missing");

    const failingAdjudication: AdjudicationEvidence = {
      schema_version: "2",
      task_id: task,
      phase_instance: phase,
      step: "adjudicate",
      subject_digest: subject,
      input_fingerprint: fingerprint,
      pinned_constitution_digest: constitution.digest,
      source_review_envelope_digest: envelopeDigest,
      rule_findings: [{
        rule_id: "task-isolation",
        rule_version: 1,
        compliance: "fail",
        rationale: "failing rule in fixture",
        trigger: "matched",
        trigger_evidence: "trigger evidence",
      }],
      constitution: "fail",
      matched_rule_versions: [{ rule_id: "task-isolation", rule_version: 1 }],
      uncertain_rule_versions: [],
      assurance: "server-attested",
      adapter: "codex-cli",
      cli_version: "1.0.0",
      invocation_id: parseSafeId("inv-adj-1"),
      envelope_input_digest: envelopeDigest,
      observed_output_digest: canonicalJsonDigest({}),
      result_id: parseSafeId("adjudication-failing"),
      model_family: "codex",
      model: "gpt-5.4",
      effort: "high",
      route_source: { provenance: "configured" },
      repositories: [{ name: "primary", repository_identity_digest: "a".repeat(64) as Sha256Digest, commit: "b".repeat(40) as never }],
    };

    const preparedAdj = await prepareEvidence(h, "adjudication-failing", {
      kind: "adjudication",
      evidence: failingAdjudication,
    });
    const retainedWithAdj = new Map(loaded.value);
    retainedWithAdj.set("adjudicate", Object.freeze({
      reference: preparedAdj.reference,
      manifest: preparedAdj.prepared.manifest.value,
    }));

    const foldedCheck = assessCurrentEvidence(state, retainedWithAdj, {
      subject_digest: subject,
      input_fingerprint: fingerprint,
      constitution,
      approved_upstream_digests: [],
    });
    expect(foldedCheck.adjudication_gate_pending).toBe(true);
    expect(foldedCheck.escalated_human_findings).toBe(true);
    expect(foldedCheck.next).toBe("adjudication-gate");

    const currentEvidence = deriveCurrentEvidenceSet(retainedWithAdj).current_evidence_set;
    const approval = await recordAuthenticatedApproval(
      h, "approval-const-esc", "design-approval", subject, currentEvidence,
    );
    const resolvedCheck = assessCurrentEvidence(state, retainedWithAdj, {
      subject_digest: subject,
      input_fingerprint: fingerprint,
      constitution,
      approved_upstream_digests: [],
      authenticated_gate_approvals: [approval],
    });
    expect(resolvedCheck.adjudication_gate_pending).toBe(false);
    expect(resolvedCheck.reentry_required).toBe(false);
    expect(resolvedCheck.next).toBe("advance");
  });

  it("unsettled escalations: assesses escalated findings and deriveNextAction routes to human gate", async () => {
    const h = await fixture();
    const dependencies = h.dependencies;
    const { subject, fingerprint } = await commitDesignProduce(h, 0);

    await commitCounter(h, dependencies, 0, subject, fingerprint, "accepted");
    await commitTriage(h, dependencies, 0, "escalated");

    const assessed = await assessment(h, dependencies, subject, fingerprint);
    expect(assessed.escalated_human_findings).toBe(true);
    expect(assessed.next).toBe("advance");

    const state = await durableState(h.authority);
    const loaded = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(state), phase);
    if (!loaded.ok) throw new Error(loaded.error.code);
    const evidenceSet = deriveCurrentEvidenceSet(loaded.value);

    // Verify deriveNextAction routes to the human gate when escalated findings exist
    const action = deriveNextAction({
      repository_initialized: true,
      config_verified: true,
      state,
      subject_digest: subject,
      assessment: assessed,
      escalated_human_findings: true,
      current_evidence_set_digest: evidenceSet.current_evidence_set.set_digest,
    });
    expect(action.code).toBe("open-gate");
    if (action.code === "open-gate") {
      expect(action.gate_kind).toBe("design-approval");
      expect(action.detail).toMatch(/human escalation requires an explicit decision/u);
    }
  });

  it("post-settlement full produce re-entry: approving an escalation when accepted findings coexist routes to produce re-entry", async () => {
    const h = await fixture();
    const dependencies = h.dependencies;
    const { subject, fingerprint } = await commitDesignProduce(h, 0);

    await commitCounter(h, dependencies, 0, subject, fingerprint, "multiple");
    await commitTriage(h, dependencies, 0, "mixed-accepted-escalated");

    const state = await durableState(h.authority);
    const loaded = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(state), phase);
    if (!loaded.ok) throw new Error(loaded.error.code);
    const currentEvidence = deriveCurrentEvidenceSet(loaded.value).current_evidence_set;

    const approval = await recordAuthenticatedApproval(
      h, "approval-post-settle", "design-approval", subject, currentEvidence,
    );

    const assessed = await assessment(h, dependencies, subject, fingerprint, undefined, [approval]);
    expect(assessed.reentry_required).toBe(true);
    expect(assessed.next).toBe("produce");
  });

  it("multi-attempt settlement persistence: settled escalations remain historical and do not reopen the gate in attempt N+1", async () => {
    const h = await fixture();
    const dependencies = h.dependencies;
    const { subject, fingerprint } = await commitDesignProduce(h, 0);

    await commitCounter(h, dependencies, 0, subject, fingerprint, "accepted");
    await commitTriage(h, dependencies, 0, "escalated");

    const state1 = await durableState(h.authority);
    const loaded1 = await loadRetainedEvidence({
      load_retained_manifest: dependencies.load_retained_manifest!,
    }, structuredClone(state1), phase);
    if (!loaded1.ok) throw new Error(loaded1.error.code);
    const currentEvidence1 = deriveCurrentEvidenceSet(loaded1.value).current_evidence_set;

    const approval = await recordAuthenticatedApproval(
      h, "approval-persist", "design-approval", subject, currentEvidence1,
    );

    // Attempt 2 enters produce, clears prior-attempt review results, and runs clean
    const currentState = await durableState(h.authority);
    const stateAttempt2: TaskStateV1 = {
      ...currentState,
      attempt: parseSafeInteger(2),
      step: "produce",
      status: "succeeded",
      authoritative_results: currentState.authoritative_results.filter((r) => r.step === "produce"),
    };
    await writeFile(h.authority.state.absolute, canonicalDocument(stateAttempt2).bytes);

    await commitCounter(h, dependencies, 1, subject, fingerprint, "clean");
    await commitTriage(h, dependencies, 1, "rejected");

    const assessed2 = await assessment(h, dependencies, subject, fingerprint, undefined, [approval]);
    expect(assessed2.escalated_human_findings).toBeUndefined();
    expect(assessed2.reentry_required).toBe(false);
    expect(assessed2.next).toBe("advance");
  });
});
