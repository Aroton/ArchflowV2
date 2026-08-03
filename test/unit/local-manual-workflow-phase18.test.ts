import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { checkpointSelfDigest, parseManualCheckpoint, parseManualCheckpointImport, type ManualCheckpointImportV1 } from "../../src/contracts/durable-checkpoint.js";
import { parseGateDecisionRecord, parseGateRequest } from "../../src/contracts/durable-gate.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import { openGateFrozenStateDigest } from "../../src/contracts/durable.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { inspectManualHandoff } from "../../src/repository/handoff.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import {
  advanceManualGate,
  assertAuthenticatedGateApproval,
  loadAuthenticatedManualGateFacts,
  resolveAuthenticatedManualGateFacts,
  type AuthenticatedManualGateFacts,
  type GateLifecycleDependencies,
} from "../../src/state/gates.js";
import { createTaskLock } from "../../src/state/lock.js";
import { loadManualImportEvidence, reduceAuthenticatedManualChain } from "../../src/state/manual-import.js";
import { buildNextManualCheckpoint, deriveFinalManualProjections, projectCurrentManualState, requiresManualFinalPhaseCompletion } from "../../src/state/manual-checkpoints.js";
import { loadManualAuthority, type ManualAuthorityFacts } from "../../src/local/manual-workflow.js";
import { planStateTransition } from "../../src/state/transitions.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "../../src/state/read.js";
import { manualCheckpointHeadIsPending } from "../../src/state/status.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const TASK = parseTaskSlug("task-1");
const PHASE = "phase-impl-2" as TaskStateV1["phase_instance"];
const D = (value: string) => parseSha256Digest(value.repeat(64));
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

async function authorityFor(root: string) {
  const context: RepositoryOperationContext = {
    task_id: TASK, phase_instance: PHASE, operation: parseSafeCode("phase18-manual-test"), attempt: parseSafeInteger(1),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error("repository discovery failed");
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error("Git preflight failed");
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value, environment: environment.value, task_id: TASK, context,
  });
  if (!authority.ok) throw new Error("transaction authority failed");
  return { runner: discovered.value, environment: environment.value, authority: authority.value };
}

function taskState(repositoryIdentityDigest: ReturnType<typeof D>, policyCommit: ReturnType<typeof parseGitOid>): TaskStateV1 {
  return {
    schema_version: "1", task_id: TASK, repository_identity_digest: repositoryIdentityDigest,
    revision: parseSafeInteger(4), phase_instance: PHASE, step: "produce", status: "running", attempt: parseSafeInteger(1),
    input_fingerprint: D("2"), initialization_digest: D("3"), config_digest: D("4"), workflow_digest: D("5"),
    constitution_digest: D("6"), policy_base_commit: policyCommit, authoritative_results: [], approvals: [], waivers: [],
  };
}

describe("Phase 18 manual recovery trust boundaries", () => {
  it("projects initial, state-anchored, and adopted continuation authority in one checkpoint revision space", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/manual-checkpoint-import.valid.json", import.meta.url), "utf8",
    )) as ManualCheckpointImportV1;
    const initial = fixture.chain[0]!;
    if (!("initialization" in initial)) throw new Error("manual fixture lacks initialization");
    const common = {
      services: {} as never,
      initialization_digest: initial.initialization_digest,
      chain: [], retained_manifests: [], retained_task_bytes: parseSafeInteger(0),
      planned_final_phase: parseSafeInteger(2),
    };
    const initialProjection = projectCurrentManualState({
      ...common, kind: "initial", initialization: initial.initialization, chain: [canonicalDocument(initial)], head: initial,
    } satisfies ManualAuthorityFacts);
    expect(initialProjection).toMatchObject({ revision: initial.revision, planned_final_phase: 2 });
    expect(initialProjection).not.toHaveProperty("adopted_checkpoint");
    expect(initialProjection).not.toHaveProperty("committed_intent");

    const state = taskState(initial.repository_identity_digest, initial.initialization.policy_base_commit);
    const anchoredProjection = projectCurrentManualState({
      ...common, kind: "state-anchored", state: canonicalDocument(state),
    } satisfies ManualAuthorityFacts);
    expect(anchoredProjection).toMatchObject({ revision: state.revision, planned_final_phase: 2 });

    const adoptedState = {
      ...state, revision: parseSafeInteger(6),
      adopted_checkpoint: { revision: parseSafeInteger(3), checkpoint_digest: D("1") },
    } satisfies TaskStateV1;
    const continuationProjection = projectCurrentManualState({
      ...common, kind: "continuation", state: canonicalDocument(adoptedState),
      predecessor: adoptedState.adopted_checkpoint,
    } satisfies ManualAuthorityFacts);
    expect(continuationProjection).toMatchObject({ revision: 3, planned_final_phase: 2 });
    expect(continuationProjection).not.toHaveProperty("adopted_checkpoint");
    expect(continuationProjection).not.toHaveProperty("committed_intent");

    const authorities = [
      { facts: { ...common, kind: "initial" as const, initialization: initial.initialization,
        chain: [canonicalDocument(initial)], head: initial }, current: initialProjection },
      { facts: { ...common, kind: "state-anchored" as const, state: canonicalDocument(state) }, current: anchoredProjection },
      { facts: { ...common, kind: "continuation" as const, state: canonicalDocument(adoptedState),
        predecessor: adoptedState.adopted_checkpoint }, current: continuationProjection },
    ];
    for (const { facts, current } of authorities) {
      const openedRevision = parseSafeInteger(current.revision + 1);
      const openGate = {
        gate_id: parsePathSafeId(`shape-${openedRevision}`), gate_kind: "artifact-approval" as const,
        subject_digest: D("7"), context_digest: D("8"), opened_at_revision: openedRevision,
        frozen_state_digest: openGateFrozenStateDigest({ ...current, revision: openedRevision }),
      };
      const openHead = {
        ...initial, revision: openedRevision, phase_instance: current.phase_instance, step: current.step,
        status: current.status, attempt: current.attempt, input_fingerprint: current.input_fingerprint,
        authoritative_results: current.authoritative_results, approvals: current.approvals, waivers: current.waivers,
        open_gate: openGate,
      } as ManualCheckpointImportV1["chain"][number];
      const opened = projectCurrentManualState({ ...facts, kind: "continuation", head: openHead } as ManualAuthorityFacts);
      const { open_gate: _openedGate, ...openedShell } = opened;
      expect(opened).toMatchObject({ revision: openedRevision, planned_final_phase: 2, open_gate: { opened_at_revision: openedRevision } });
      expect(openGate.frozen_state_digest).toBe(openGateFrozenStateDigest(openedShell as TaskStateV1));
      const { open_gate: _removed, ...resolvedHead } = openHead;
      const resolved = projectCurrentManualState({
        ...facts, kind: "continuation", head: {
          ...resolvedHead, revision: parseSafeInteger(openedRevision + 1),
        },
      } as ManualAuthorityFacts);
      expect(resolved).toMatchObject({ revision: openedRevision + 1, planned_final_phase: 2 });
      expect(resolved).not.toHaveProperty("open_gate");
    }
  });

  it("compares continuation heads in adopted-checkpoint revision space", () => {
    expect(manualCheckpointHeadIsPending({
      revision: parseSafeInteger(6),
      adopted_checkpoint: { revision: parseSafeInteger(3), checkpoint_digest: D("1") },
    }, 4)).toBe(true);
    expect(manualCheckpointHeadIsPending({ revision: parseSafeInteger(6) }, 4)).toBe(false);
  });

  it("rejects fabricated manual gate facts", () => {
    expect(() => resolveAuthenticatedManualGateFacts({ gate_ids: [] } as unknown as AuthenticatedManualGateFacts))
      .toThrow(/authenticated manual gate facts/u);
  });

  it("completes a chain-only planned final phase and rejects advancing beyond it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-phase18-chain-final-"))); roots.push(root);
    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(root, "root.txt"), "root\n");
    git(root, "add", "root.txt"); git(root, "commit", "-q", "-m", "root");
    const services = await authorityFor(root);
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/manual-checkpoint-import.valid.json", import.meta.url), "utf8",
    )) as ManualCheckpointImportV1;
    const fixtureInitial = fixture.chain[0]!;
    if (!("initialization" in fixtureInitial)) throw new Error("manual fixture lacks initialization");
    const subject = D("7");
    const gateId = parsePathSafeId("chain-final-commit");
    const context = {
      target_ref: git(root, "symbolic-ref", "HEAD"), diff_digest: D("8"), current_artifact_digests: [subject], parent_document_digests: [D("d")],
    } as const;
    const contextDigest = computeGateContextDigest("commit-authorization", context);
    const request = parseGateRequest({
      schema_version: "1", gate_id: gateId, intent_id: "chain-final-intent", request_digest: D("9"),
      task_id: TASK, phase_instance: PHASE, kind: "commit-authorization", summary: "Authorize final commit",
      subject_digest: subject, context_digest: contextDigest, context,
      current_evidence: { set_digest: D("a"), slots: [
        { role: "self-review", evidence_digest: D("b"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
        { role: "counter-review", evidence_digest: D("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
      ] },
      allowed_decisions: ["authorize-commit", "revise", "abort", "cancel"], opened_at_revision: 1,
    });
    const decision = parseGateDecisionRecord({
      schema_version: "1", gate_id: gateId, task_id: TASK, phase_instance: PHASE,
      kind: "commit-authorization", subject_digest: subject, context_digest: contextDigest,
      supplemental: [], outcome: "decided", envelope: {
        schema_version: "1", gate_id: gateId, task_id: TASK, phase_instance: PHASE,
        kind: "commit-authorization", subject_digest: subject, context_digest: contextDigest,
        human_provenance: {
          schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
          decision_event_id: "chain-final-decision", helper_invocation_id: "chain-final-helper", recorded_at: "2026-08-03T12:00:00.000Z",
        },
        payload: { decision: "authorize-commit", reason: "Final implementation committed" },
      },
    });
    const initialization = {
      ...fixtureInitial.initialization, task_id: TASK,
      repository_identity_digest: services.authority.repository_identity_digest,
      code_baseline_commit: parseGitOid(git(root, "rev-parse", "HEAD")),
      policy_base_commit: parseGitOid(git(root, "rev-parse", "HEAD")),
    };
    const head = parseManualCheckpoint({
      ...fixtureInitial, task_id: TASK, repository_identity_digest: services.authority.repository_identity_digest,
      initialization, initialization_digest: canonicalJsonDigest(initialization), revision: 1,
      phase_instance: PHASE, step: "adjudicate", status: "succeeded", attempt: 1,
      approvals: [{ gate_id: gateId, gate_kind: "commit-authorization", subject_digest: subject,
        decision_digest: canonicalDocument(decision).digest, resolved_at_revision: 1 }],
      authoritative_results: [], projections: [], evidence_chain: [], waivers: [],
    });
    const current = projectCurrentManualState({
      services: {} as never, kind: "continuation", initialization,
      initialization_digest: head.initialization_digest, chain: [canonicalDocument(head)], head,
      predecessor: { revision: parseSafeInteger(head.revision), checkpoint_digest: checkpointSelfDigest(head) },
      retained_manifests: [], retained_task_bytes: parseSafeInteger(0), planned_final_phase: parseSafeInteger(2),
    });
    const archive = join(services.authority.task_root, "decisions", gateId);
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "request.json"), canonicalDocument(request).bytes);
    writeFileSync(join(archive, "decision.json"), canonicalDocument(decision).bytes);
    const dependencies = {
      runner: services.runner, environment: services.environment,
    } as GateLifecycleDependencies;
    const binding = {};
    const loaded = await loadAuthenticatedManualGateFacts({
      dependencies, transaction_authority: services.authority, authority_binding: binding, state: current, gate_ids: [gateId],
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const authenticated = resolveAuthenticatedManualGateFacts(loaded.value, binding).authenticated_gate_approvals[0]!;
    expect(planStateTransition({
      current, target: { phase_instance: current.phase_instance, step: current.step, status: current.status,
        attempt: current.attempt, input_fingerprint: current.input_fingerprint },
      recomputed_input_fingerprint: current.input_fingerprint, completion_subject_digest: subject,
      authenticated_gate_approvals: [authenticated], commit_observed: true,
    })).toMatchObject({ ok: true, value: { terminal: "complete" } });
    expect(requiresManualFinalPhaseCompletion(current, "phase-design-3" as TaskStateV1["phase_instance"])).toBe(true);

    const headCommit = parseGitOid(git(root, "rev-parse", "HEAD"));
    const treeEntry = git(root, "ls-tree", "HEAD", "root.txt").split(/\s+/u);
    const implementationArtifact = {
      schema_version: "1", artifact_kind: "implementation-output", task_id: TASK, phase_instance: PHASE,
      step: "produce", base_commit: headCommit, index_identity_digest: D("1"), worktree_identity_digest: D("2"),
      outputs: [{ path: "root.txt", path_class: "repository-source", operation: "modify", storage: "git-object",
        file_type: "regular", before: { oid: treeEntry[2], mode: "100644", size_bytes: 5 },
        after: { oid: treeEntry[2], mode: "100644", size_bytes: 5 } }],
      parent_documents: [{ document_path: "design.md", content_digest: D("d"), role: "design" }],
      diff_digest: D("8"), snapshot_digest: D("3"), restore_targets: ["root.txt"], accounting: {
        schema_version: "1", result_bytes: 0, task_bytes: 0, result_byte_cap: 26214400, task_byte_cap: 262144000,
        counted_entries: [{ path: "root.txt", storage: "git-object", stored_bytes: 0 }], measured_at_revision: 1,
      }, secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: "archflow.default:v1", scanned_paths: ["root.txt"] },
      undeclared_changes: { scanned: true, undeclared_paths: [], unrepresentable_count: 0 }, declared_inputs: [],
      input_fingerprint: head.input_fingerprint,
    } as const;
    const implementationManifest = canonicalDocument({
      schema_version: "1", task_id: TASK, repository_identity_digest: services.authority.repository_identity_digest,
      result_id: "chain-implementation", phase_instance: PHASE, step: "produce", artifact_digest: subject,
      source_artifact: implementationArtifact, input_fingerprint: head.input_fingerprint, snapshot_digest: D("3"),
      outputs: implementationArtifact.outputs, projections: [], accounting: implementationArtifact.accounting,
      secret_scan: implementationArtifact.secret_scan,
    } as never);
    const designBytes = new TextEncoder().encode("### Phase 1: First\n### Phase 2: Final\n");
    const designSubject = D("e");
    const designArtifact = {
      schema_version: "1", artifact_kind: "document", task_id: TASK, phase_instance: "design", step: "produce",
      document_path: "design.md", projection_target: `.archflow/tasks/${TASK}/design.md`,
      content_digest: sha256Bytes(designBytes), byte_count: designBytes.byteLength, snapshot_digest: D("4"),
      declared_inputs: [], input_fingerprint: head.input_fingerprint, accounting: implementationArtifact.accounting,
      secret_scan: implementationArtifact.secret_scan,
    } as const;
    const designManifest = canonicalDocument({
      schema_version: "1", task_id: TASK, repository_identity_digest: services.authority.repository_identity_digest,
      result_id: "chain-design", phase_instance: "design", step: "produce", artifact_digest: designSubject,
      source_artifact: designArtifact, input_fingerprint: head.input_fingerprint, snapshot_digest: D("4"), outputs: [],
      projections: [], accounting: implementationArtifact.accounting, secret_scan: implementationArtifact.secret_scan,
    } as never);
    const oldProjectionManifest = canonicalDocument<ResultManifestV1>({
      ...(implementationManifest.value as unknown as ResultManifestV1), result_id: parseSafeId("old-generation"),
      projections: [{ path: "root.txt" as never, content_digest: D("1") }],
    });
    const newProjectionManifest = canonicalDocument<ResultManifestV1>({
      ...(implementationManifest.value as unknown as ResultManifestV1), result_id: parseSafeId("new-generation"),
      projections: [{ path: "root.txt" as never, content_digest: D("2") }],
    });
    const oldReference: TaskStateV1["authoritative_results"][number] = {
      phase_instance: PHASE, step: "produce" as const, result_digest: oldProjectionManifest.digest,
      result_id: parseSafeId("old-generation"), input_fingerprint: head.input_fingerprint,
      manifest_path: `.archflow/tasks/${TASK}/results/sha256/${oldProjectionManifest.digest}/manifest.json` as never,
    };
    const newReference: TaskStateV1["authoritative_results"][number] = {
      ...oldReference, result_digest: newProjectionManifest.digest, result_id: parseSafeId("new-generation"),
      manifest_path: `.archflow/tasks/${TASK}/results/sha256/${newProjectionManifest.digest}/manifest.json` as never,
    };
    const installedNew = { authority: {} as never, reference: newReference, manifest: newProjectionManifest,
      projections: newProjectionManifest.value.projections };
    expect(deriveFinalManualProjections({
      references: [newReference], retained_manifests: [oldProjectionManifest], installed_results: [installedNew],
    })).toEqual({ outcome: "ok", projections: [{ path: "root.txt", content_digest: D("2") }] });
    const unrelatedConflictReference = { ...oldReference, phase_instance: "design" as TaskStateV1["phase_instance"] };
    expect(deriveFinalManualProjections({
      references: [newReference, unrelatedConflictReference], retained_manifests: [oldProjectionManifest],
      installed_results: [installedNew],
    })).toEqual({ outcome: "path-conflict" });
    const designGateId = parsePathSafeId("chain-design-approval");
    const designContext = { artifact_kind: "design" } as const;
    const designContextDigest = computeGateContextDigest("artifact-approval", designContext);
    const designRequest = parseGateRequest({
      schema_version: "1", gate_id: designGateId, intent_id: "chain-design-intent", request_digest: D("f"),
      task_id: TASK, phase_instance: "design", kind: "artifact-approval", summary: "Approve design",
      subject_digest: designSubject, context_digest: designContextDigest, context: designContext,
      current_evidence: request.current_evidence, allowed_decisions: ["approve", "revise", "reject", "cancel"], opened_at_revision: 1,
    });
    const designDecision = parseGateDecisionRecord({
      schema_version: "1", gate_id: designGateId, task_id: TASK, phase_instance: "design", kind: "artifact-approval",
      subject_digest: designSubject, context_digest: designContextDigest, supplemental: [], outcome: "decided", envelope: {
        schema_version: "1", gate_id: designGateId, task_id: TASK, phase_instance: "design", kind: "artifact-approval",
        subject_digest: designSubject, context_digest: designContextDigest,
        human_provenance: (decision as Extract<typeof decision, { outcome: "decided" }>).envelope.human_provenance,
        payload: { decision: "approve", reason: "Approved phase plan" },
      },
    });
    const reference = (phase_instance: TaskStateV1["phase_instance"], result_id: string, manifest: typeof designManifest) => ({
      phase_instance, step: "produce", result_digest: manifest.digest, result_id,
      input_fingerprint: head.input_fingerprint,
      manifest_path: `.archflow/tasks/${TASK}/results/sha256/${manifest.digest}/manifest.json`,
    });
    const designReference = reference("design" as TaskStateV1["phase_instance"], "chain-design", designManifest);
    const implementationReference = reference(PHASE, "chain-implementation", implementationManifest as typeof designManifest);
    const builderHead = parseManualCheckpoint({
      ...head, authoritative_results: [designReference, implementationReference], approvals: [
        { gate_id: designGateId, gate_kind: "artifact-approval", subject_digest: designSubject,
          decision_digest: canonicalDocument(designDecision).digest, resolved_at_revision: 1 },
        { gate_id: gateId, gate_kind: "commit-authorization", subject_digest: subject,
          decision_digest: canonicalDocument(decision).digest, resolved_at_revision: 1 },
      ],
    });
    const designArchive = join(services.authority.task_root, "decisions", designGateId);
    mkdirSync(designArchive, { recursive: true });
    writeFileSync(join(designArchive, "request.json"), canonicalDocument(designRequest).bytes);
    writeFileSync(join(designArchive, "decision.json"), canonicalDocument(designDecision).bytes);
    const checkpointDirectory = join(services.authority.task_root, "manual", "checkpoints");
    mkdirSync(checkpointDirectory, { recursive: true });
    const checkpoint = canonicalDocument(builderHead);
    writeFileSync(join(checkpointDirectory, `1-${checkpoint.digest}.json`), checkpoint.bytes);
    const loader = async (candidate: { result_digest: string; manifest_path: string }) => {
      const manifest = candidate.result_digest === designManifest.digest ? designManifest : implementationManifest;
      return { schema_version: "1" as const, ok: true as const, value: {
        prepared: { manifest, result_digest: manifest.digest,
          payloads: manifest === designManifest ? [{ path: designArtifact.projection_target, bytes: designBytes, target: {} }] : [] },
        manifest_target: { repositoryRelative: candidate.manifest_path }, projection_plan: { entries: [], collisions: [], collision_choices: [] },
      } };
    };
    const production = {
      runner: services.runner, environment: services.environment, authority: services.authority,
      dependencies: {
        runner: services.runner, environment: services.environment, load_retained_result: loader,
        read_config: async () => ({ kind: "valid" as const, snapshot: {
          bytes: new Uint8Array(), digest: initialization.config_digest,
        } }),
        resolve_input_fingerprint: async () => ({ schema_version: "1" as const, ok: true as const, value: {
          schema_version: "1", workflow_digest: initialization.workflow_digest, config_digest: initialization.config_digest,
          constitution_digest: initialization.constitution_digest, artifact_identities: [], upstream_identities: [],
          rubric_digest: D("6"), phase_instance: "phase-design-3", declared_inputs: [],
        } }),
      },
    } as never;
    const loadedAuthority = await loadManualAuthority({ services: production, initialization });
    expect(loadedAuthority.ok).toBe(true);
    if (!loadedAuthority.ok) return;
    await expect(buildNextManualCheckpoint({
      authority: loadedAuthority.value, milestone: { kind: "terminal", terminal: "complete" }, results: [],
    })).resolves.toMatchObject({ ok: true, value: { terminal: "complete" } });
    await expect(buildNextManualCheckpoint({
      authority: loadedAuthority.value,
      milestone: { kind: "step", phase_instance: "phase-design-3" as TaskStateV1["phase_instance"], step: "produce", status: "running" }, results: [],
    })).resolves.toMatchObject({ ok: false, error: { code: "STATE_INVALID",
      diagnostic: { parameters: { issue_code: "manual-final-phase-must-complete" } } } });
  });

  it("reloads an exactly bound archived gate pair before minting approval authority", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-phase18-gate-"))); roots.push(root);
    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(root, "root.txt"), "root\n");
    git(root, "add", "root.txt"); git(root, "commit", "-q", "-m", "root");
    const services = await authorityFor(root);
    const state = taskState(services.authority.repository_identity_digest, parseGitOid(git(root, "rev-parse", "HEAD")));
    const gateId = parsePathSafeId("phase18-gate");
    const gateContext = { artifact_kind: "phase-implementation" } as const;
    const contextDigest = computeGateContextDigest("artifact-approval", gateContext);
    const common = {
      gate_id: gateId, task_id: TASK, phase_instance: PHASE, kind: "artifact-approval" as const,
      subject_digest: D("7"), context_digest: contextDigest,
    };
    const request = parseGateRequest({
      schema_version: "1", ...common, intent_id: "phase18-intent", request_digest: D("8"), summary: "Approve phase",
      current_evidence: { set_digest: D("9"), slots: [
        { role: "self-review", evidence_digest: D("a"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
        { role: "counter-review", evidence_digest: D("b"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
      ] }, context: gateContext,
      allowed_decisions: ["approve", "revise", "reject", "cancel"], opened_at_revision: 4,
    });
    const decision = parseGateDecisionRecord({
      schema_version: "1", ...common, supplemental: [], outcome: "decided",
      envelope: {
        schema_version: "1", ...common,
        human_provenance: {
          schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
          decision_event_id: "phase18-decision", helper_invocation_id: "phase18-helper", recorded_at: "2026-08-03T12:00:00.000Z",
        },
        payload: { decision: "approve", reason: "Reviewed" },
      },
    });
    const decisionRoot = join(services.authority.task_root, "decisions", gateId);
    mkdirSync(decisionRoot, { recursive: true });
    writeFileSync(join(decisionRoot, "request.json"), canonicalDocument(request).bytes);
    writeFileSync(join(decisionRoot, "decision.json"), canonicalDocument(decision).bytes);
    const dependencies = {
      runner: services.runner, environment: services.environment, atomic: createAtomicWriter(), lock: createTaskLock(),
      read_state: readTaskState, read_config: readTaskConfig, read_receipt: readIntentReceipt,
      resolve_input_fingerprint: async () => ({ schema_version: "1" as const, ok: true as const, value: {} as never }),
    } satisfies GateLifecycleDependencies;
    const binding = {};
    await expect(advanceManualGate({
      dependencies, transaction_authority: services.authority, manual_authority: binding, state,
      action: { kind: "publish", request } as never,
      resolve_publish_material: () => ({ schema_version: "1", ok: true, value: {
        subject_digest: request.subject_digest, current_evidence: request.current_evidence,
      } }),
    })).resolves.toMatchObject({ ok: false, error: { code: "STATE_INVALID",
      diagnostic: { parameters: { issue_code: "manual-gate-publish-action-invalid" } } } });
    await expect(advanceManualGate({
      dependencies, transaction_authority: services.authority, manual_authority: binding, state,
      action: { kind: "publish", selector: {
        kind: "gate", gate_kind: "commit-authorization", summary: "Authorize commit",
        context: {
          target_ref: "refs/heads/forged", diff_digest: D("0"),
          current_artifact_digests: [D("0")], parent_document_digests: [D("0")],
        },
      } } as never,
      resolve_publish_material: () => ({ schema_version: "1", ok: true, value: {
        subject_digest: request.subject_digest, current_evidence: request.current_evidence,
      } }),
    })).resolves.toMatchObject({ ok: false, error: { code: "STATE_INVALID",
      diagnostic: { parameters: { issue_code: "manual-gate-publish-selector-invalid" } } } });
    const loaded = await loadAuthenticatedManualGateFacts({
      dependencies, transaction_authority: services.authority, authority_binding: binding, state, gate_ids: [gateId],
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const resolved = resolveAuthenticatedManualGateFacts(loaded.value, binding);
    expect(resolved.pairs).toEqual([{ request, decision }]);
    expect(resolved.approvals).toMatchObject([{ gate_id: gateId, decision_digest: canonicalDocument(decision).digest }]);
    expect(resolved.authenticated_gate_approvals).toHaveLength(1);
    expect(() => assertAuthenticatedGateApproval(resolved.authenticated_gate_approvals[0]!)).not.toThrow();
    expect(() => resolveAuthenticatedManualGateFacts(loaded.value, {})).toThrow(/authenticated manual gate facts/u);

    writeFileSync(join(decisionRoot, "decision.json"), canonicalDocument({ ...decision, subject_digest: D("0") }).bytes);
    await expect(loadAuthenticatedManualGateFacts({
      dependencies, transaction_authority: services.authority, authority_binding: binding, state, gate_ids: [gateId],
    })).resolves.toMatchObject({ ok: false, error: { code: "STATE_INVALID" } });
  });

  it("returns clean handoff guidance without creating a handoff record", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-phase18-handoff-"))); roots.push(root);
    const upstream = join(root, "upstream");
    const clone = join(root, "clone");
    git(root, "-c", "init.defaultBranch=main", "init", "-q", upstream);
    writeFileSync(join(upstream, "root.txt"), "root\n");
    git(upstream, "add", "root.txt"); git(upstream, "commit", "-q", "-m", "root");
    git(upstream, "config", "receive.denyCurrentBranch", "updateInstead");
    git(root, "clone", "-q", upstream, clone);
    const services = await authorityFor(clone);
    const state = taskState(services.authority.repository_identity_digest, parseGitOid(git(clone, "rev-parse", "HEAD")));
    const statePath = join(clone, ".archflow", "tasks", TASK, "state.json");
    mkdirSync(join(clone, ".archflow", "tasks", TASK), { recursive: true });
    const document = canonicalDocument(state);
    writeFileSync(statePath, document.bytes);
    git(clone, "add", ".archflow/tasks/task-1/state.json"); git(clone, "commit", "-q", "-m", "checkpoint"); git(clone, "push", "-q");
    const head = parseGitOid(git(clone, "rev-parse", "HEAD"));
    const selected = {};
    const result = await inspectManualHandoff({
      dependencies: { runner: services.runner }, transaction_authority: services.authority,
      selected_authority: selected, expected_head: head,
      resolve_selected_authority: (candidate) => {
        if (candidate !== selected) throw new TypeError("foreign authority");
        return {
          kind: "normal", path: parseRepositoryPathClaim(".archflow/tasks/task-1/state.json"), document,
        };
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "ready", mode: "normal", head_oid: head,
        protocol: ["commit-authenticated-authority", "push-selected-branch", "clean-pull-in-next-writer", "rerun-manual-status-before-mutation"],
      },
    });
    if (result.ok) expect(result.value).not.toHaveProperty("record");
  });

  it.each(["cancelled", "retry"] as const)("imports an authenticated closed %s gate milestone", async (variant) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `archflow-phase18-${variant}-`))); roots.push(root);
    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(root, "root.txt"), "root\n");
    git(root, "add", "root.txt"); git(root, "commit", "-q", "-m", "root");
    const services = await authorityFor(root);
    const repositoryDigest = services.authority.repository_identity_digest;
    const head = parseGitOid(git(root, "rev-parse", "HEAD"));
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/contracts/durable/manual-checkpoint-import.valid.json", import.meta.url), "utf8",
    )) as ManualCheckpointImportV1;
    const fixtureInitial = fixture.chain[0]!;
    if (!("initialization" in fixtureInitial)) throw new Error("initial checkpoint fixture is missing initialization");
    const initialization = {
      ...fixtureInitial.initialization,
      task_id: TASK,
      repository_identity_digest: repositoryDigest,
      code_baseline_commit: head,
      policy_base_commit: head,
      canonical_paths: {
        task_root: ".archflow/tasks/task-1", config: ".archflow/tasks/task-1/config.yaml",
        state: ".archflow/tasks/task-1/state.json", workflow: ".archflow/workflow.yaml",
        constitution_root: ".archflow/constitution",
      },
    };
    const initializationDigest = canonicalJsonDigest(initialization);
    const initial = parseManualCheckpoint({
      ...fixtureInitial, task_id: TASK, repository_identity_digest: repositoryDigest,
      phase_instance: PHASE, step: "adjudicate", status: "succeeded", attempt: 1,
      initialization, initialization_digest: initializationDigest,
      authoritative_results: [], projections: [], evidence_chain: [], approvals: [], waivers: [],
    });
    const gateId = parsePathSafeId(`phase18-${variant}`);
    const gateContext = { artifact_kind: "phase-implementation" } as const;
    const contextDigest = computeGateContextDigest("artifact-approval", gateContext);
    const frozenState = {
      schema_version: "1" as const, task_id: TASK, repository_identity_digest: repositoryDigest,
      revision: parseSafeInteger(2), phase_instance: PHASE, step: "adjudicate" as const, status: "succeeded" as const,
      attempt: parseSafeInteger(1), input_fingerprint: initial.input_fingerprint,
      initialization_digest: initializationDigest, config_digest: initialization.config_digest,
      workflow_digest: initialization.workflow_digest, constitution_digest: initialization.constitution_digest,
      policy_base_commit: initialization.policy_base_commit, authoritative_results: [], approvals: [], waivers: [],
    } satisfies TaskStateV1;
    if (!("initialization" in initial)) throw new Error("derived initial checkpoint lost initialization");
    const { initialization: _embeddedInitialization, ...continuationBase } = initial;
    const open = parseManualCheckpoint({
      ...continuationBase, revision: 2,
      predecessor: { revision: 1, checkpoint_digest: checkpointSelfDigest(initial) },
      open_gate: {
        gate_id: gateId, gate_kind: "artifact-approval", subject_digest: D("7"), context_digest: contextDigest,
        frozen_state_digest: openGateFrozenStateDigest(frozenState), opened_at_revision: parseSafeInteger(2),
      },
    });
    const { open_gate: _closedGate, ...closedBase } = open;
    const closed = parseManualCheckpoint({
      ...closedBase, revision: 3, predecessor: { revision: 2, checkpoint_digest: checkpointSelfDigest(open) },
      ...(variant === "retry" ? { step: "produce", status: "running", attempt: 2, input_fingerprint: D("d") } : {}),
    });
    const common = {
      gate_id: gateId, task_id: TASK, phase_instance: PHASE, kind: "artifact-approval" as const,
      subject_digest: D("7"), context_digest: contextDigest,
    };
    const request = parseGateRequest({
      schema_version: "1", ...common, intent_id: `phase18-${variant}-intent`, request_digest: D("8"), summary: "Resolve gate",
      current_evidence: { set_digest: D("9"), slots: [
        { role: "self-review", evidence_digest: D("a"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
        { role: "counter-review", evidence_digest: D("b"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
      ] }, context: gateContext, allowed_decisions: ["approve", "revise", "reject", "cancel"], opened_at_revision: 2,
    });
    const decision = parseGateDecisionRecord(variant === "cancelled" ? {
      schema_version: "1", ...common, supplemental: [], outcome: "cancelled", reason: "Stopped",
      human_provenance: {
        schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
        decision_event_id: "phase18-cancel", helper_invocation_id: "phase18-helper", recorded_at: "2026-08-03T12:00:00.000Z",
      },
    } : {
      schema_version: "1", ...common, supplemental: [], outcome: "decided",
      envelope: {
        schema_version: "1", ...common,
        human_provenance: {
          schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
          decision_event_id: "phase18-retry", helper_invocation_id: "phase18-helper", recorded_at: "2026-08-03T12:00:00.000Z",
        },
        payload: { decision: "revise", reason: "Retry production" },
      },
    });
    const archive = join(services.authority.task_root, "decisions", gateId);
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "request.json"), canonicalDocument(request).bytes);
    writeFileSync(join(archive, "decision.json"), canonicalDocument(decision).bytes);
    const artifact = parseManualCheckpointImport({
      schema_version: "1", artifact_kind: "manual-checkpoint-import", task_id: TASK,
      repository_identity_digest: repositoryDigest, import_mode: "initial", chain: [initial, open, closed],
    });
    const dependencies = {
      runner: services.runner, environment: services.environment,
      load_retained_result: async () => ({ schema_version: "1" as const, ok: false as const,
        error: { schema_version: "1", code: "STATE_INVALID" } as never }),
    } as unknown as GateLifecycleDependencies;
    const evidence = await loadManualImportEvidence({
      dependencies: dependencies as never, authority: services.authority, artifact,
    });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    const reduced = reduceAuthenticatedManualChain({ artifact, evidence: evidence.value });
    expect(reduced).toMatchObject({ ok: true, value: { head: { revision: 3 }, next_state: {
      step: variant === "retry" ? "produce" : "adjudicate",
      status: variant === "retry" ? "running" : "succeeded",
    } } });
  });
});
