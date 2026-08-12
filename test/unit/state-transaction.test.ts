import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, gitBlobOid, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../../src/contracts/canonical.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ResultManifestV1, TriageArtifactV1 } from "../../src/contracts/durable-result-manifest.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { AuthoritativeResultRef, TaskStateV1 } from "../../src/contracts/durable-state.js";
import {
  parsePathSafeId,
  parseSafeCode,
  parseSafeId,
  parseSafeInteger,
  parseSha256Digest,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import {
  createInternalResultExpectation,
  parseToolCall,
  validateProjectResultStructure,
  type ParsedToolCall,
  type RequestIdentifiedToolCall,
} from "../../src/contracts/mcp-tools.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type GitEnvironment, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import type {
  ResolvedPath,
  ResolvedTaskPath,
  ResolvedTaskWorkspacePath,
  ResolvedWorkspacePath,
  WorkspacePathClaim,
} from "../../src/repository/paths.js";
import { AtomicReplaceError, createProjectionWriter, type AtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { identifyTransactionRequest } from "../../src/state/request.js";
import { TaskLockError } from "../../src/state/lock.js";
import { deriveDeclaredSnapshotDigest, TASK_BYTE_CAP, type PreparedSnapshot, type ProjectionPlan } from "../../src/state/snapshots.js";
import {
  assertAuthenticTransactionOutcome,
  resultProjectionTargetIsContained,
  runStateTransaction,
  prepareResultInstallation,
  type PreparedTransaction,
  type TransactionDependencies,
  type TransactionRequest,
} from "../../src/state/transaction.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const TASK = parseTaskSlug("task-1");
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(9) });
const CONTEXT: RepositoryOperationContext = {
  task_id: TASK,
  phase_instance: PHASE,
  operation: parseSafeCode("state-transaction-test"),
  attempt: parseSafeInteger(2),
};
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const D = (character: string) => parseSha256Digest(character.repeat(64));

const SUBJECT = {
  schema_version: "1",
  workflow_digest: D("5"),
  config_digest: D("4"),
  constitution_digest: D("6"),
  artifact_identities: [],
  upstream_identities: [],
  rubric_digest: D("7"),
  phase_instance: PHASE,
  declared_inputs: [],
} as unknown as InputFingerprintSubject;
const FINGERPRINT = computeInputFingerprint(SUBJECT);

type StateCall = Extract<ParsedToolCall, { readonly name: "archflow_state" }>;

type Harness = {
  readonly root: string;
  readonly runner: RootBoundGitRunner;
  readonly environment: GitEnvironment;
  readonly authority: TransactionAuthority;
  dependencies: TransactionDependencies;
  readonly events: string[];
  readonly counts: { prepare: number; config: number; fingerprint: number; receipt: number };
  state: CanonicalDocument<TaskStateV1>;
  receipt?: CanonicalDocument<IntentReceiptV1>;
  replaceFault: "before" | "after" | undefined;
  createFault: "before" | "after" | undefined;
};

function baseState(authority: TransactionAuthority): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: TASK,
    repository_identity_digest: authority.repository_identity_digest,
    revision: parseSafeInteger(7),
    phase_instance: PHASE,
    step: "produce",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: FINGERPRINT,
    initialization_digest: D("3"),
    config_digest: D("4"),
    workflow_digest: D("5"),
    constitution_digest: D("6"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
}

async function harness(): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-state-transaction-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env: GIT_ENV });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: GIT_ENV });
  mkdirSync(join(root, ".archflow", "tasks", TASK), { recursive: true });
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), CONTEXT);
  if (!discovered.ok) throw new Error("worktree discovery failed");
  const environment = await preflightGit(discovered.value, CONTEXT);
  if (!environment.ok) throw new Error("git preflight failed");
  const authorityResult = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: TASK,
    context: CONTEXT,
  });
  if (!authorityResult.ok) throw new Error("authority creation failed");

  const events: string[] = [];
  const counts = { prepare: 0, config: 0, fingerprint: 0, receipt: 0 };
  const value = {
    root,
    runner: discovered.value,
    environment: environment.value,
    authority: authorityResult.value,
    state: canonicalDocument(baseState(authorityResult.value)),
    receipt: undefined,
    replaceFault: undefined,
    createFault: undefined,
    events,
    counts,
  } as unknown as Harness;

  const atomic: AtomicWriter = {
    createExclusive: async (path, bytes) => {
      if (path.path_class !== "workspace-intent") {
        events.push(path.path_class === "authority-result" ? "authority-result" : "workspace-result-payload");
        mkdirSync(dirname(path.absolute), { recursive: true });
        if (existsSync(path.absolute)) return "exists";
        writeFileSync(path.absolute, bytes);
        return "created";
      }
      events.push("receipt-create");
      if (value.createFault === "before") {
        throw new AtomicReplaceError({ operation: "create-exclusive", target_may_have_changed: false, collision: false });
      }
      if (value.receipt !== undefined) return "exists";
      value.receipt = parseCanonicalDocument<IntentReceiptV1>(bytes);
      if (value.createFault === "after") {
        throw new AtomicReplaceError({ operation: "create-exclusive", target_may_have_changed: true, collision: false });
      }
      return "created";
    },
    replace: async (_path, bytes) => {
      events.push("state-replace");
      if (value.replaceFault === "before") {
        throw new AtomicReplaceError({ operation: "replace", target_may_have_changed: false, collision: false });
      }
      value.state = parseCanonicalDocument<TaskStateV1>(bytes);
      if (value.replaceFault === "after") {
        throw new AtomicReplaceError({ operation: "replace", target_may_have_changed: true, collision: false });
      }
    },
    removeGateInterface: async () => undefined,
  };
  value.dependencies = {
    runner: value.runner,
    environment: value.environment,
    atomic,
    lock: { runExclusive: async <T>(_root: ResolvedTaskWorkspacePath, work: () => Promise<T>) => { events.push("lock"); return work(); } },
    resolve_input_fingerprint: async () => {
      counts.fingerprint += 1;
      events.push("fingerprint");
      return { schema_version: "1", ok: true, value: structuredClone(SUBJECT) };
    },
    read_state: async () => ({ kind: "canonical", document: value.state }),
    read_config: async () => {
      counts.config += 1;
      events.push("config");
      return { kind: "valid", snapshot: { bytes: new Uint8Array(), digest: D("4") } };
    },
    read_receipt: async () => {
      counts.receipt += 1;
      return value.receipt === undefined ? { kind: "missing" } : { kind: "canonical", document: value.receipt };
    },
    projection_writer: {
      replaceRegular: async () => undefined,
      replaceSymlink: async () => undefined,
      remove: async () => undefined,
    },
    read_retained_task_bytes: async () => parseSafeInteger(0),
  };
  return value;
}

function documentResultFixture(h: Harness, bytes: Uint8Array): Readonly<{
  prepared: PreparedSnapshot;
  manifestPath: ReturnType<typeof parseRepositoryPathClaim>;
  manifestTarget: ResolvedPath;
}> {
  const outputPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/phase-9-output.md`);
  const contentDigest = sha256Bytes(bytes);
  const byteCount = parseSafeInteger(bytes.byteLength);
  const output = {
    path: outputPath, path_class: "document" as const, operation: "add" as const,
    storage: "raw-payload" as const, payload_bytes: byteCount, payload_digest: contentDigest,
    file_type: "regular" as const, after: { oid: gitBlobOid(bytes), mode: "100644" as const, size_bytes: byteCount },
  };
  const projections = [{ path: outputPath, content_digest: contentDigest }];
  const snapshotDigest = deriveDeclaredSnapshotDigest([output], projections);
  const source: DocumentArtifactV1 = {
    schema_version: "1", artifact_kind: "document", task_id: TASK, phase_instance: PHASE, step: "produce",
    document_path: parseTaskPathClaim("phases/phase-9-output.md"), path_class: "document",
    byte_count: byteCount, content_digest: contentDigest, declared_inputs: [], input_fingerprint: FINGERPRINT,
    snapshot_digest: snapshotDigest, projection_target: outputPath,
  };
  const manifestValue: ResultManifestV1 = {
    schema_version: "1", task_id: TASK, repository_identity_digest: h.authority.repository_identity_digest,
    result_id: parseSafeId("state:8"), phase_instance: PHASE, step: "produce",
    artifact_digest: canonicalJsonDigest(source), source_artifact: source, input_fingerprint: FINGERPRINT,
    snapshot_digest: snapshotDigest, outputs: [output], projections,
    accounting: {
      schema_version: "1", result_bytes: byteCount, task_bytes: byteCount,
      result_byte_cap: 26_214_400, task_byte_cap: 262_144_000,
      counted_entries: [{ path: outputPath, storage: "raw-payload", stored_bytes: byteCount }],
      measured_at_revision: parseSafeInteger(7),
    },
    secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"), scanned_paths: [outputPath] },
  };
  const manifest = canonicalDocument(manifestValue);
  const manifestPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/authority/results/${manifest.digest}.json`);
  const payloadRelative = `cache/results/${manifest.digest}/payload/${outputPath}` as WorkspacePathClaim;
  const payloadPath = parseRepositoryPathClaim(`.archflow/runtime/tasks/${TASK}/${payloadRelative}`);
  return {
    prepared: { manifest, result_digest: manifest.digest, payloads: [{
      path: outputPath, bytes,
      target: {
        absolute: join(h.root, payloadPath) as ResolvedTaskWorkspacePath,
        repositoryRelative: payloadPath,
        workspaceRelative: payloadRelative,
        path_class: "workspace-result-payload",
      },
    }] },
    manifestPath,
    manifestTarget: { absolute: join(h.root, manifestPath) as ResolvedTaskPath, repositoryRelative: manifestPath, path_class: "authority-result" },
  };
}

type ResultFixture = ReturnType<typeof documentResultFixture>;

function triageResultFixture(h: Harness, source: TriageArtifactV1): ResultFixture {
  const snapshotDigest = deriveDeclaredSnapshotDigest([], []);
  const manifestValue: ResultManifestV1 = {
    schema_version: "1", task_id: TASK, repository_identity_digest: h.authority.repository_identity_digest,
    result_id: parseSafeId("state:8"), phase_instance: PHASE, step: "triage",
    artifact_digest: canonicalJsonDigest(source.evidence), source_artifact: source,
    input_fingerprint: FINGERPRINT, snapshot_digest: snapshotDigest, outputs: [], projections: [],
    accounting: {
      schema_version: "1", result_bytes: parseSafeInteger(0), task_bytes: parseSafeInteger(0),
      result_byte_cap: 26_214_400, task_byte_cap: 262_144_000,
      counted_entries: [],
      measured_at_revision: parseSafeInteger(7),
    },
    secret_scan: {
      schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"),
      scanned_paths: [],
    },
  };
  const manifest = canonicalDocument(manifestValue);
  const manifestPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/authority/results/${manifest.digest}.json`);
  return {
    prepared: {
      manifest,
      result_digest: manifest.digest,
      payloads: [],
    },
    manifestPath,
    manifestTarget: {
      absolute: join(h.root, manifestPath) as ResolvedTaskPath,
      repositoryRelative: manifestPath,
      path_class: "authority-result",
    },
  };
}

function remanifest(
  h: Harness,
  fixture: ResultFixture,
  transform: (value: ResultManifestV1) => ResultManifestV1,
): ResultFixture {
  const manifest = canonicalDocument(transform(structuredClone(fixture.prepared.manifest.value)));
  const manifestPath = parseRepositoryPathClaim(
    `.archflow/tasks/${TASK}/authority/results/${manifest.digest}.json`,
  );
  const payloads = fixture.prepared.payloads.map((payload) => {
    const payloadRelative = `cache/results/${manifest.digest}/payload/${payload.path}` as WorkspacePathClaim;
    const payloadPath = parseRepositoryPathClaim(`.archflow/runtime/tasks/${TASK}/${payloadRelative}`);
    return {
      ...payload,
      target: {
        absolute: join(h.root, payloadPath) as ResolvedTaskWorkspacePath,
        repositoryRelative: payloadPath,
        workspaceRelative: payloadRelative,
        path_class: "workspace-result-payload" as const,
      },
    };
  });
  return {
    prepared: { manifest, result_digest: manifest.digest, payloads },
    manifestPath,
    manifestTarget: {
      absolute: join(h.root, manifestPath) as ResolvedTaskPath,
      repositoryRelative: manifestPath,
      path_class: "authority-result",
    },
  };
}

const triageArtifact = (): TriageArtifactV1 => ({
  schema_version: "1",
  artifact_kind: "triage",
  evidence: {
    schema_version: "1",
    task_id: TASK,
    phase_instance: PHASE,
    step: "triage",
    subject_digest: D("1"),
    input_fingerprint: FINGERPRINT,
    current_evidence_set_digest: D("2"),
    source_evidence_digests: [D("8")],
    dispositions: [],
    accepted_count: 0,
    rejected_count: 0,
  },
});

function call(expected_revision: number, status: "running" | "succeeded" | "failed" = "succeeded", intent = "intent-1", withArtifact = false): StateCall {
  return parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: TASK,
    intent_id: intent,
    expected_revision,
    input_fingerprint: FINGERPRINT,
    phase_instance: PHASE,
    step: "produce",
    status,
    ...(withArtifact ? { artifact: {
      schema_version: "1", artifact_kind: "document", task_id: TASK,
      phase_instance: PHASE, step: "produce", document_path: "phases/phase-9-output.md",
      path_class: "document", byte_count: 1, content_digest: D("a"), declared_inputs: [],
      input_fingerprint: FINGERPRINT, snapshot_digest: D("b"),
      projection_target: `.archflow/tasks/${TASK}/phases/phase-9-output.md`,
    } } : {}),
  });
}

function triageCall(expected_revision: number, artifact?: TriageArtifactV1): StateCall {
  return parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: TASK,
    intent_id: "triage-intent",
    expected_revision,
    input_fingerprint: FINGERPRINT,
    phase_instance: PHASE,
    step: "triage",
    status: "succeeded",
    ...(artifact === undefined ? {} : { artifact }),
  });
}

function request(authority: TransactionAuthority, parsed: StateCall): TransactionRequest<"archflow_state"> {
  return { authority, call: parsed };
}

function nextState(current: TaskStateV1, status: TaskStateV1["status"]): PreparedTransaction<"archflow_state">["next_state"] {
  const { revision: _revision, last_transition: _lastTransition, ...draft } = current;
  return { ...draft, status };
}

function preparer(h: Harness, parsed: StateCall) {
  const digest = identifyTransactionRequest(parsed, h.authority, FINGERPRINT).request_digest;
  return async (
    current: CanonicalDocument<TaskStateV1>,
    identified: Extract<RequestIdentifiedToolCall, { readonly name: "archflow_state" }>,
  ) => {
    h.counts.prepare += 1;
    h.events.push("prepare");
    expect(identified).toBe(parsed);
    const revision = parseSafeInteger(current.value.revision + 1);
    const success = { path: parseTaskPathClaim("state.json"), revision, status: parsed.input.status };
    const expectation = createInternalResultExpectation({
      schema_version: "1",
      tool: "archflow_state",
      task_id: TASK,
      intent_id: parsed.input.intent_id,
      input_fingerprint: FINGERPRINT,
      request_digest: digest,
      result_id: `state:${String(revision)}`,
      resulting_revision: revision,
      success,
    });
    const result = validateProjectResultStructure(parsed, { schema_version: "1", ok: true, value: success });
    return {
      schema_version: "1" as const,
      ok: true as const,
      value: { expectation, result, next_state: nextState(current.value, parsed.input.status) },
    };
  };
}

type InstallationOverrides = Readonly<{
  reference?: AuthoritativeResultRef;
  next_state?: PreparedTransaction<"archflow_state">["next_state"];
  manifest_target?: ResolvedPath;
  projection_plan?: ProjectionPlan;
  worktree_root?: ResolvedTaskPath;
}>;

async function runInstallation(
  h: Harness,
  parsed: StateCall,
  retained: ResultFixture,
  overrides: InstallationOverrides = {},
) {
  const base = preparer(h, parsed);
  return runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
    const prepared = await base(current, identified);
    if (!prepared.ok) return prepared;
    const reference = overrides.reference ?? {
      phase_instance: retained.prepared.manifest.value.phase_instance,
      step: retained.prepared.manifest.value.step,
      result_digest: retained.prepared.result_digest,
      result_id: parseSafeId("state:8"),
      input_fingerprint: FINGERPRINT,
    };
    const capability = prepareResultInstallation({
      reference,
      prepared: retained.prepared,
      manifest_target: overrides.manifest_target ?? retained.manifestTarget,
      projection_plan: overrides.projection_plan ??
        { entries: [], collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"] },
      worktree_root: overrides.worktree_root ?? h.runner.location.worktreeRoot as ResolvedTaskPath,
    });
    return {
      ...prepared,
      value: {
        ...prepared.value,
        next_state: overrides.next_state ?? {
          ...prepared.value.next_state,
          step: reference.step,
          authoritative_results: [reference],
        },
        result_installation: capability,
      },
    };
  });
}

describe("mature state transaction kernel", () => {
  it("contains implementation projections to the worktree without weakening task-owned projections", async () => {
    const h = await harness();
    const repositoryTarget: ResolvedPath = {
      absolute: join(h.root, "tracked.txt") as ResolvedTaskPath,
      repositoryRelative: parseRepositoryPathClaim("tracked.txt"),
      path_class: "repository-source",
    };
    const outsideTarget: ResolvedPath = {
      absolute: join(h.root, "..", "outside.txt") as ResolvedTaskPath,
      repositoryRelative: parseRepositoryPathClaim("tracked.txt"),
      path_class: "repository-source",
    };
    expect(resultProjectionTargetIsContained(
      "implementation-output", h.authority.task_root, h.root, repositoryTarget,
    )).toBe(true);
    expect(resultProjectionTargetIsContained(
      "implementation-output", h.authority.task_root, h.root, outsideTarget,
    )).toBe(false);
    expect(resultProjectionTargetIsContained(
      "document", h.authority.task_root, h.root, repositoryTarget,
    )).toBe(false);
  });

  it("writes one receipt before state and returns the authenticated committed state", async () => {
    const h = await harness();
    const parsed = call(7);
    const result = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replayed).toBe(false);
    expect(result.value.state.value.revision).toBe(8);
    expect(result.value.state.value.last_transition).toMatchObject({
      intent_id: parsed.input.intent_id,
      request_digest: identifyTransactionRequest(parsed, h.authority, FINGERPRINT).request_digest,
      prior_revision: 7,
      resulting_revision: 8,
    });
    expect(() => assertAuthenticTransactionOutcome(result.value)).not.toThrow();
    expect(() => assertAuthenticTransactionOutcome({
      ...result.value,
    })).toThrow(/not minted/u);
    expect(h.events).toEqual(["lock", "config", "fingerprint", "prepare", "receipt-create", "state-replace"]);
    expect(h.counts.prepare).toBe(1);
  });

  it("authenticates and installs a one-shot result capability before receipt and state", async () => {
    const h = await harness();
    const parsed = call(7, "succeeded", "intent-1", true);
    const base = preparer(h, parsed);
    const result = await runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const prepared = await base(current, identified);
      if (!prepared.ok) return prepared;
      const bytes = new TextEncoder().encode("retained");
      const retained = documentResultFixture(h, bytes);
      const reference = {
        phase_instance: current.value.phase_instance,
        step: current.value.step,
        result_digest: retained.prepared.result_digest,
        result_id: parseSafeId("state:8"),
        input_fingerprint: FINGERPRINT,
      };
      const capability = prepareResultInstallation({
        reference,
        prepared: retained.prepared,
        manifest_target: retained.manifestTarget,
        projection_plan: { entries: [], collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"] },
        worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
      });
      return {
        ...prepared,
        value: {
          ...prepared.value,
          next_state: { ...prepared.value.next_state, authoritative_results: [reference] },
          result_installation: capability,
        },
      };
    });
    expect(result.ok).toBe(true);
    expect(h.events).toEqual(["lock", "config", "fingerprint", "prepare", "workspace-result-payload", "authority-result", "receipt-create", "state-replace"]);
    expect(h.state.value.authoritative_results).toHaveLength(1);
  });

  it("requires an evidence installation to carry the exact archflow_state artifact", async () => {
    const missing = await harness();
    missing.state = canonicalDocument({ ...missing.state.value, step: "triage", status: "running" });
    const source = triageArtifact();
    await expect(runInstallation(
      missing,
      triageCall(7),
      triageResultFixture(missing, source),
    )).rejects.toThrow(/requires an archflow_state artifact/u);
    expect(missing.events).not.toContain("receipt-create");

    const changed = await harness();
    changed.state = canonicalDocument({ ...changed.state.value, step: "triage", status: "running" });
    await expect(runInstallation(
      changed,
      triageCall(7, {
        ...source,
        evidence: { ...source.evidence, current_evidence_set_digest: D("9") },
      }),
      triageResultFixture(changed, source),
    )).rejects.toThrow(/source does not match the archflow_state artifact/u);
    expect(changed.events).not.toContain("receipt-create");
  });

  it("accepts an evidence installation only when the request and retained source are identical", async () => {
    const h = await harness();
    h.state = canonicalDocument({ ...h.state.value, step: "triage", status: "running" });
    const source = triageArtifact();
    const result = await runInstallation(h, triageCall(7, source), triageResultFixture(h, source));
    expect(result.ok).toBe(true);
    expect(h.receipt?.value.operation).toBe("record-triage");
    expect(h.state.value.authoritative_results).toHaveLength(1);
  });

  it("throws each result-installation programmer-invariant violation before writing", async () => {
    const wrongTool = await harness();
    wrongTool.state = canonicalDocument({ ...wrongTool.state.value, step: "counter_review", status: "running" });
    const counterCall = parseToolCall("archflow_counter_review", {
      schema_version: "1",
      task_id: TASK,
      intent_id: "wrong-tool",
      expected_revision: 7,
      input_fingerprint: FINGERPRINT,
      artifact_path: "phases/phase-9-output.md",
      rubric: {
        schema_version: "1",
        kind: "implementation",
        mode: "adversarial",
        criteria: [{ id: "binding", text: "Check exact binding", blocking: true }],
      },
    });
    const wrongToolFixture = documentResultFixture(wrongTool, new TextEncoder().encode("retained"));
    await expect(runStateTransaction(
      wrongTool.dependencies,
      { authority: wrongTool.authority, call: counterCall },
      async (current, identified) => {
        const revision = parseSafeInteger(current.value.revision + 1);
        const success = {
          path: parseRepositoryPathClaim(`.archflow/runtime/tasks/${TASK}/cache/reviews/${PHASE}.counter.md`),
          verdict: "pass" as const,
          blocking_count: 0,
          constitution: { status: "not-run" as const, reason: "no-active-constitution-rules" as const },
          revision,
        };
        const { revision: _revision, last_transition: _lastTransition, ...draft } = current.value;
        const reference = {
          phase_instance: PHASE,
          step: "produce" as const,
          result_digest: wrongToolFixture.prepared.result_digest,
          result_id: parseSafeId("state:8"),
          input_fingerprint: FINGERPRINT,
        };
        return {
          schema_version: "1" as const,
          ok: true as const,
          value: {
            expectation: createInternalResultExpectation({
              schema_version: "1",
              tool: "archflow_counter_review",
              task_id: TASK,
              intent_id: counterCall.input.intent_id,
              input_fingerprint: FINGERPRINT,
              request_digest: identifyTransactionRequest(counterCall, wrongTool.authority, FINGERPRINT).request_digest,
              result_id: "state:8",
              resulting_revision: revision,
              success,
            }),
            result: validateProjectResultStructure(identified, {
              schema_version: "1",
              ok: true,
              value: success,
            }),
            next_state: { ...draft, status: "succeeded", authoritative_results: [reference] },
            result_installation: prepareResultInstallation({
              reference,
              prepared: wrongToolFixture.prepared,
              manifest_target: wrongToolFixture.manifestTarget,
              projection_plan: {
                entries: [],
                collisions: [],
                collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
              },
              worktree_root: wrongTool.runner.location.worktreeRoot as ResolvedTaskPath,
            }),
          },
        };
      },
    )).rejects.toThrow(/tool and source kind do not match/u);

    const wrongSource = await harness();
    wrongSource.state = canonicalDocument({ ...wrongSource.state.value, step: "triage", status: "running" });
    await expect(runInstallation(
      wrongSource,
      triageCall(7, triageArtifact()),
      documentResultFixture(wrongSource, new TextEncoder().encode("retained")),
    )).rejects.toThrow(/source kind is not legal/u);

    const wrongBoundary = await harness();
    wrongBoundary.state = canonicalDocument({ ...wrongBoundary.state.value, step: "triage", status: "running" });
    const boundarySource = triageArtifact();
    const boundaryFixture = triageResultFixture(wrongBoundary, boundarySource);
    const { revision: _boundaryRevision, last_transition: _boundaryTransition, ...boundaryDraft } =
      wrongBoundary.state.value;
    await expect(runInstallation(
      wrongBoundary,
      triageCall(7, boundarySource),
      boundaryFixture,
      { next_state: { ...boundaryDraft, status: "running", authoritative_results: [{
        phase_instance: PHASE,
        step: "triage",
        result_digest: boundaryFixture.prepared.result_digest,
        result_id: parseSafeId("state:8"),
        input_fingerprint: FINGERPRINT,
      }] } },
    )).rejects.toThrow(/only at its successful evidence boundary/u);

    const wrongReference = await harness();
    wrongReference.state = canonicalDocument({ ...wrongReference.state.value, step: "triage", status: "running" });
    const referenceSource = triageArtifact();
    const referenceFixture = triageResultFixture(wrongReference, referenceSource);
    const { revision: _revision, last_transition: _lastTransition, ...referenceDraft } = wrongReference.state.value;
    await expect(runInstallation(
      wrongReference,
      triageCall(7, referenceSource),
      referenceFixture,
      { next_state: { ...referenceDraft, status: "succeeded", authoritative_results: [] } },
    )).rejects.toThrow(/reference does not match the prepared transaction/u);

    for (const h of [wrongTool, wrongSource, wrongBoundary, wrongReference]) {
      expect(h.events).not.toContain("receipt-create");
    }
  });

  it("classifies every result-installation caller-data binding mismatch before writing", async () => {
    const cases: readonly Readonly<{
      label: string;
      expectedCode: string;
      issueCode: string;
      arrange: (h: Harness) => Readonly<{ fixture: ResultFixture; overrides?: InstallationOverrides }>;
    }>[] = [
      {
        label: "task",
        expectedCode: "TASK_INVALID",
        issueCode: "result-installation-task-mismatch",
        arrange: (h) => ({
          fixture: remanifest(h, documentResultFixture(h, new Uint8Array([1])), (value) => {
            if (value.source_artifact.artifact_kind !== "document") throw new TypeError("expected document");
            const source = { ...value.source_artifact, task_id: parseTaskSlug("task-2") };
            return { ...value, task_id: source.task_id, artifact_digest: canonicalJsonDigest(source), source_artifact: source };
          }),
        }),
      },
      {
        label: "repository",
        expectedCode: "STATE_INVALID",
        issueCode: "result-installation-repository-mismatch",
        arrange: (h) => ({
          fixture: remanifest(h, documentResultFixture(h, new Uint8Array([1])), (value) => ({
            ...value,
            repository_identity_digest: D("9"),
          })),
        }),
      },
      {
        label: "state",
        expectedCode: "STATE_INVALID",
        issueCode: "result-installation-state-mismatch",
        arrange: (h) => ({
          fixture: remanifest(h, documentResultFixture(h, new Uint8Array([1])), (value) => {
            if (value.source_artifact.artifact_kind !== "document") throw new TypeError("expected document");
            const otherPhase = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(9) });
            const source = { ...value.source_artifact, phase_instance: otherPhase };
            return {
              ...value,
              phase_instance: otherPhase,
              artifact_digest: canonicalJsonDigest(source),
              source_artifact: source,
            };
          }),
        }),
      },
      {
        label: "manifest target",
        expectedCode: "CONTRACT_INVALID",
        issueCode: "result-installation-target-mismatch",
        arrange: (h) => ({
          fixture: documentResultFixture(h, new Uint8Array([1])),
          overrides: { worktree_root: join(h.root, "other-worktree") as ResolvedTaskPath },
        }),
      },
      {
        label: "payload target",
        expectedCode: "CONTRACT_INVALID",
        issueCode: "result-installation-payload-target-mismatch",
        arrange: (h) => {
          const original = documentResultFixture(h, new Uint8Array([1]));
          const wrongRelative = `cache/results/${"9".repeat(64)}/payload/unexpected` as WorkspacePathClaim;
          const wrongPath = parseRepositoryPathClaim(`.archflow/runtime/tasks/${TASK}/${wrongRelative}`);
          return {
            fixture: {
              ...original,
              prepared: {
                ...original.prepared,
                payloads: original.prepared.payloads.map((payload) => ({
                  ...payload,
                  target: {
                    absolute: join(h.root, wrongPath) as ResolvedTaskWorkspacePath,
                    repositoryRelative: wrongPath,
                    workspaceRelative: wrongRelative,
                    path_class: "workspace-result-payload" as const,
                  },
                })),
              },
            },
          };
        },
      },
      {
        label: "projection target",
        expectedCode: "CONTRACT_INVALID",
        issueCode: "result-installation-projection-target-mismatch",
        arrange: (h) => {
          const fixture = documentResultFixture(h, new Uint8Array([1]));
          const output = fixture.prepared.manifest.value.outputs[0]!;
          return {
            fixture,
            overrides: {
              projection_plan: {
                entries: [{
                  path: output.path,
                  target: {
                    absolute: join(h.root, output.path) as ResolvedTaskPath,
                    repositoryRelative: output.path,
                    path_class: "repository-source",
                  },
                  observed_before: { state: "absent" },
                  desired: { state: "absent" },
                  disposition: "already-correct",
                }],
                collisions: [],
                collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
              },
            },
          };
        },
      },
    ];

    for (const testCase of cases) {
      const h = await harness();
      const { fixture, overrides } = testCase.arrange(h);
      const result = await runInstallation(
        h,
        call(7, "succeeded", `intent-${testCase.label.replaceAll(" ", "-")}`, true),
        fixture,
        overrides,
      );
      expect(result.ok, testCase.label).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, testCase.label).toBe(testCase.expectedCode);
      expect(result.error.diagnostic.parameters, testCase.label).toMatchObject({ issue_code: testCase.issueCode });
      expect(h.events, testCase.label).not.toContain("receipt-create");
    }
  });

  it("rejects an installation capability whose reference does not bind its manifest bytes or target", async () => {
    const h = await harness();
    const retained = documentResultFixture(h, new TextEncoder().encode("retained"));
    const reference = {
      phase_instance: PHASE, step: "produce" as const, result_digest: D("9"), result_id: parseSafeId("result-1"),
      input_fingerprint: FINGERPRINT,
    };
    expect(() => prepareResultInstallation({
      reference,
      prepared: retained.prepared,
      manifest_target: retained.manifestTarget,
      projection_plan: { entries: [], collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"] },
      worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
    })).toThrow(/does not bind the prepared snapshot/u);
  });

  it("rechecks the live task cap under the lock before writing any result bytes", async () => {
    const h = await harness();
    h.dependencies = { ...h.dependencies, read_retained_task_bytes: async () => parseSafeInteger(TASK_BYTE_CAP) };
    const parsed = call(7, "succeeded", "intent-1", true);
    const base = preparer(h, parsed);
    const result = await runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const transaction = await base(current, identified);
      if (!transaction.ok) return transaction;
      const bytes = new Uint8Array([1]);
      const retained = documentResultFixture(h, bytes);
      const reference = {
        phase_instance: PHASE, step: current.value.step, result_digest: retained.prepared.result_digest,
        result_id: parseSafeId("state:8"), input_fingerprint: FINGERPRINT,
      };
      const capability = prepareResultInstallation({
        reference,
        prepared: retained.prepared,
        manifest_target: retained.manifestTarget,
        projection_plan: { entries: [], collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"] },
        worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
      });
      return { ...transaction, value: { ...transaction.value,
        next_state: { ...transaction.value.next_state, authoritative_results: [reference] }, result_installation: capability } };
    });
    expect(result.ok ? undefined : result.error.code).toBe("SNAPSHOT_LIMIT");
    expect(h.events).not.toContain("workspace-result-payload");
    expect(h.events).not.toContain("authority-result");
    expect(h.events).not.toContain("receipt-create");
  });

  it("receipt-only resume reloads retained facts and restores projection bytes without preparation", async () => {
    const h = await harness();
    h.dependencies = { ...h.dependencies, projection_writer: createProjectionWriter() };
    h.replaceFault = "before";
    const parsed = call(7, "succeeded", "intent-1", true);
    const base = preparer(h, parsed);
    const desired = new TextEncoder().encode("restored\n");
    const targetPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/phase-9-output.md`);
    const target: ResolvedPath = { absolute: join(h.root, targetPath) as ResolvedTaskPath, repositoryRelative: targetPath, path_class: "document" };
    mkdirSync(dirname(target.absolute), { recursive: true });
    const projection = (): ProjectionPlan => ({
      entries: [{ path: targetPath, target, observed_before: { state: "absent" },
        desired: { state: "present", file_type: "regular", mode: "100644", bytes: desired }, disposition: "restore-ready" }],
      collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    });
    const snapshot = documentResultFixture(h, desired);
    const reference = { phase_instance: PHASE, step: "produce" as const, result_digest: snapshot.prepared.result_digest,
      result_id: parseSafeId("state:8"), input_fingerprint: FINGERPRINT };
    const retained = {
      prepared: snapshot.prepared,
      manifest_target: snapshot.manifestTarget,
      projection_plan: projection(), worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
    };
    const first = await runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const transaction = await base(current, identified);
      if (!transaction.ok) return transaction;
      return { ...transaction, value: { ...transaction.value,
        next_state: { ...transaction.value.next_state, authoritative_results: [reference] },
        result_installation: prepareResultInstallation({ reference, ...retained }),
      } };
    });
    expect(first.ok).toBe(false);
    expect(readFileSync(target.absolute)).toEqual(Buffer.from(desired));
    unlinkSync(target.absolute);
    h.replaceFault = undefined;
    let loads = 0;
    h.dependencies = { ...h.dependencies, load_retained_result: async (observed) => {
      loads += 1;
      expect(observed).toEqual(reference);
      return { schema_version: "1", ok: true, value: { ...retained, projection_plan: projection() } };
    } };
    const resumed = await runStateTransaction(h.dependencies, request(h.authority, parsed), async () => {
      throw new Error("receipt-only resume must not prepare");
    });
    expect(resumed.ok).toBe(true);
    expect(loads).toBe(1);
    expect(readFileSync(target.absolute)).toEqual(Buffer.from(desired));
  });

  async function projectionWriteResult(h: Harness, thrown: AtomicReplaceError) {
    h.dependencies = { ...h.dependencies, projection_writer: {
      replaceRegular: async () => { throw thrown; },
      replaceSymlink: async () => undefined,
      remove: async () => undefined,
    } };
    const parsed = call(7, "succeeded", "intent-1", true);
    const base = preparer(h, parsed);
    const desired = new TextEncoder().encode("projected\n");
    const targetPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/phases/phase-9-output.md`);
    const target: ResolvedPath = { absolute: join(h.root, targetPath) as ResolvedTaskPath, repositoryRelative: targetPath, path_class: "document" };
    const snapshot = documentResultFixture(h, desired);
    const reference = { phase_instance: PHASE, step: "produce" as const, result_digest: snapshot.prepared.result_digest,
      result_id: parseSafeId("state:8"), input_fingerprint: FINGERPRINT };
    return runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const transaction = await base(current, identified);
      if (!transaction.ok) return transaction;
      return { ...transaction, value: { ...transaction.value,
        next_state: { ...transaction.value.next_state, authoritative_results: [reference] },
        result_installation: prepareResultInstallation({
          reference,
          prepared: snapshot.prepared,
          manifest_target: snapshot.manifestTarget,
          projection_plan: {
            entries: [{ path: targetPath, target, observed_before: { state: "absent" },
              desired: { state: "present", file_type: "regular", mode: "100644", bytes: desired }, disposition: "restore-ready" }],
            collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
          },
          worktree_root: h.runner.location.worktreeRoot as ResolvedTaskPath,
        }),
      } };
    });
  }

  it("classifies a permanent projection write failure as non-retryable task damage", async () => {
    const h = await harness();
    const result = await projectionWriteResult(h, new AtomicReplaceError({
      operation: "replace", target_may_have_changed: false, collision: false, errno: "EACCES",
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_INVALID");
    expect(result.error.retryable).toBe(false);
    expect(result.error.diagnostic.parameters).toMatchObject({ issue_code: "projection-target-access-denied" });
  });

  it("keeps unclassifiable projection write failures retryable", async () => {
    for (const errno of ["EIO", undefined] as const) {
      const h = await harness();
      const result = await projectionWriteResult(h, new AtomicReplaceError({
        operation: "replace", target_may_have_changed: false, collision: false, errno,
      }));
      expect(result.ok, String(errno)).toBe(false);
      if (result.ok) return;
      expect(result.error.code, String(errno)).toBe("IO_ERROR");
      expect(result.error.retryable, String(errno)).toBe(true);
    }
  });

  it("replays the last transition with either its prior or resulting revision", async () => {
    const h = await harness();
    const original = call(7);
    const first = await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original));
    expect(first.ok).toBe(true);
    const configAfterCommit = h.counts.config;

    const stale = await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original));
    expect(stale).toMatchObject({ ok: true, value: { replayed: true, outcome: { revision: 8 } } });
    expect(h.counts.config).toBe(configAfterCommit);

    const refreshed = call(8);
    const replay = await runStateTransaction(h.dependencies, request(h.authority, refreshed), preparer(h, refreshed));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.outcome.revision).toBe(8);
    expect(h.counts.prepare).toBe(1);
    expect(h.counts.config).toBe(configAfterCommit);
  });

  it("rejects stale CAS and invalid state before creating the intent layout", async () => {
    const stale = await harness();
    const staleCall = call(6);
    const staleResult = await runStateTransaction(stale.dependencies, request(stale.authority, staleCall), preparer(stale, staleCall));
    expect(staleResult.ok ? undefined : staleResult.error.code).toBe("STATE_CONFLICT");
    expect(existsSync(join(stale.authority.task_root, "intents"))).toBe(false);

    const invalid = await harness();
    invalid.state = { ...invalid.state, digest: D("9") };
    const currentCall = call(7);
    const invalidResult = await runStateTransaction(invalid.dependencies, request(invalid.authority, currentCall), preparer(invalid, currentCall));
    expect(invalidResult.ok ? undefined : invalidResult.error).toMatchObject({
      code: "STATE_INVALID",
      diagnostic: { parameters: { issue_code: "document-digest-mismatch" } },
    });
    expect(invalid.counts.receipt).toBe(0);
    expect(existsSync(join(invalid.authority.task_root, "intents"))).toBe(false);
  });

  it("leaves and resumes an exact write-ahead receipt without rerunning preparation", async () => {
    const h = await harness();
    h.replaceFault = "before";
    const parsed = call(7);
    const interrupted = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(interrupted.ok ? undefined : interrupted.error).toMatchObject({
      code: "IO_ERROR",
      diagnostic: { parameters: { operation: "task-state-replace", attempt: 2 } },
    });
    expect(h.receipt).toBeDefined();
    expect(h.state.value.revision).toBe(7);
    expect(h.counts.prepare).toBe(1);

    h.replaceFault = undefined;
    const resumed = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.replayed).toBe(false);
    expect(h.state.value.revision).toBe(8);
    expect(h.counts.prepare).toBe(1);
  });

  it("arbitrates an after-rename replacement error to success from durable facts", async () => {
    const h = await harness();
    h.replaceFault = "after";
    const parsed = call(7);
    const result = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.value.revision).toBe(8);
    expect(result.value.state.value.last_transition).toMatchObject({
      intent_id: parsed.input.intent_id,
      prior_revision: 7,
      resulting_revision: 8,
    });
  });

  it("rereads durable authority after an ambiguous release even when the callback reread failed", async () => {
    const h = await harness();
    const originalReadState = h.dependencies.read_state;
    let stateReads = 0;
    h.dependencies = {
      ...h.dependencies,
      read_state: async (path) => {
        stateReads += 1;
        if (stateReads === 2) return { kind: "noncanonical" };
        return originalReadState(path);
      },
      lock: {
        runExclusive: async <T>(_root: ResolvedTaskWorkspacePath, work: () => Promise<T>): Promise<T> => {
          await work();
          throw new TaskLockError("release");
        },
      },
    };
    const parsed = call(7);
    const result = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.value.revision).toBe(8);
    expect(stateReads).toBe(3);
  });

  it("totally classifies exclusive-create collision rereads", async () => {
    const h = await harness();
    const originalAtomic = h.dependencies.atomic;
    let receiptReads = 0;
    h.dependencies = {
      ...h.dependencies,
      atomic: { ...originalAtomic, createExclusive: async () => "exists" },
      read_receipt: async () => {
        receiptReads += 1;
        return receiptReads === 1 ? { kind: "missing" } : { kind: "noncanonical" };
      },
    };
    const parsed = call(7);
    const result = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "CONTRACT_INVALID",
      diagnostic: { parameters: { issue_code: "intent-receipt-noncanonical" } },
    });
    expect(h.events).not.toContain("state-replace");
  });

  it("classifies exact last-transition replay separately from changed reuse", async () => {
    const h = await harness();
    const original = call(7);
    expect((await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original))).ok).toBe(true);
    const exact = call(8);
    const replay = await runStateTransaction(h.dependencies, request(h.authority, exact), preparer(h, exact));
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, outcome: { revision: 8 } } });

    const changed = call(8, "failed");
    const mismatch = await runStateTransaction(h.dependencies, request(h.authority, changed), preparer(h, changed));
    expect(mismatch.ok ? undefined : mismatch.error.code).toBe("INTENT_MISMATCH");
  });

  it("replays committed state without consulting a substituted crash receipt", async () => {
    const h = await harness();
    const original = call(7);
    expect((await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original))).ok).toBe(true);
    if (h.receipt === undefined) throw new Error("missing receipt fixture");
    const changedPrepared = { ...h.receipt.value.prepared_state, input_fingerprint: D("9") };
    h.receipt = canonicalDocument({
      ...h.receipt.value,
      input_fingerprint: D("9"),
      request_digest: D("8"),
      prepared_state: changedPrepared,
      prepared_state_digest: canonicalDocument(changedPrepared).digest,
    });
    const refreshed = call(8);
    const result = await runStateTransaction(h.dependencies, request(h.authority, refreshed), preparer(h, refreshed));
    expect(result).toMatchObject({ ok: true, value: { replayed: true, outcome: { revision: 8 } } });
  });

  it("reports receipt-local rank 4b before foreign identity", async () => {
    const h = await harness();
    h.replaceFault = "before";
    const original = call(7);
    await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original));
    if (h.receipt === undefined) throw new Error("missing receipt fixture");
    h.replaceFault = undefined;
    h.receipt = canonicalDocument({
      ...h.receipt.value,
      task_id: parseTaskSlug("foreign-task"),
      outcome: { changed: true },
    });
    const result = await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original));
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "TASK_INVALID",
      diagnostic: { parameters: { task_id: "foreign-task", issue_code: "intent-receipt-outcome-digest-mismatch" } },
    });
  });

  it("pins future-revision, tool-mismatch, and operation-mismatch receipt rows", async () => {
    const future = await harness();
    future.replaceFault = "before";
    const futureCall = call(7);
    await runStateTransaction(future.dependencies, request(future.authority, futureCall), preparer(future, futureCall));
    if (future.receipt === undefined) throw new Error("missing receipt fixture");
    future.replaceFault = undefined;
    const futurePrepared = { ...future.receipt.value.prepared_state, revision: parseSafeInteger(9) };
    future.receipt = canonicalDocument({
      ...future.receipt.value,
      prior_revision: parseSafeInteger(8),
      resulting_revision: parseSafeInteger(9),
      prepared_state: futurePrepared,
      prepared_state_digest: canonicalDocument(futurePrepared).digest,
    });
    const futureResult = await runStateTransaction(
      future.dependencies,
      request(future.authority, futureCall),
      preparer(future, futureCall),
    );
    expect(futureResult.ok ? undefined : futureResult.error).toMatchObject({
      code: "TASK_INVALID",
      diagnostic: { parameters: { issue_code: "intent-receipt-future-revision" } },
    });

    const wrongTool = await harness();
    wrongTool.replaceFault = "before";
    const toolCall = call(7);
    await runStateTransaction(wrongTool.dependencies, request(wrongTool.authority, toolCall), preparer(wrongTool, toolCall));
    if (wrongTool.receipt === undefined) throw new Error("missing receipt fixture");
    wrongTool.replaceFault = undefined;
    wrongTool.receipt = canonicalDocument({ ...wrongTool.receipt.value, tool: "archflow_gate" });
    const toolResult = await runStateTransaction(
      wrongTool.dependencies,
      request(wrongTool.authority, toolCall),
      preparer(wrongTool, toolCall),
    );
    expect(toolResult.ok ? undefined : toolResult.error).toMatchObject({
      code: "TASK_INVALID",
      diagnostic: { parameters: { issue_code: "intent-receipt-tool-mismatch" } },
    });

    const wrongOperation = await harness();
    wrongOperation.replaceFault = "before";
    const operationCall = call(7);
    await runStateTransaction(
      wrongOperation.dependencies,
      request(wrongOperation.authority, operationCall),
      preparer(wrongOperation, operationCall),
    );
    if (wrongOperation.receipt === undefined) throw new Error("missing receipt fixture");
    wrongOperation.replaceFault = undefined;
    wrongOperation.receipt = canonicalDocument({
      ...wrongOperation.receipt.value,
      operation: parseSafeCode("wrong-operation"),
    });
    const operationResult = await runStateTransaction(
      wrongOperation.dependencies,
      request(wrongOperation.authority, operationCall),
      preparer(wrongOperation, operationCall),
    );
    expect(operationResult.ok ? undefined : operationResult.error).toMatchObject({
      code: "TASK_INVALID",
      diagnostic: { parameters: { issue_code: "intent-receipt-operation-mismatch" } },
    });
  });

  it.each(["missing", "noncanonical"] as const)(
    "replays from state when the temporary receipt is %s",
    async (kind) => {
      const h = await harness();
      const original = call(7);
      expect((await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original))).ok).toBe(true);
      h.dependencies = { ...h.dependencies, read_receipt: async () => ({ kind }) };
      const refreshed = call(8);
      const result = await runStateTransaction(h.dependencies, request(h.authority, refreshed), preparer(h, refreshed));
      expect(result).toMatchObject({ ok: true, value: { replayed: true, outcome: { revision: 8 } } });
    },
  );

  it("pins state/config/fingerprint precedence and never prepares rejected requests", async () => {
    const h = await harness();
    const parsed = call(6);
    h.dependencies = { ...h.dependencies, read_receipt: async () => ({ kind: "unreadable" }) };
    const conflict = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(conflict.ok ? undefined : conflict.error.code).toBe("STATE_CONFLICT");
    expect(h.counts.config).toBe(0);
    expect(h.counts.prepare).toBe(0);

    const h2 = await harness();
    h2.dependencies = { ...h2.dependencies, read_config: async () => ({ kind: "valid", snapshot: { bytes: new Uint8Array(), digest: D("9") } }) };
    const current = call(7);
    const drift = await runStateTransaction(h2.dependencies, request(h2.authority, current), preparer(h2, current));
    expect(drift.ok ? undefined : drift.error.code).toBe("PINNED_CONFIG_MISMATCH");
    expect(h2.counts.fingerprint).toBe(0);
    expect(h2.counts.prepare).toBe(0);
  });

  it("rejects malformed plans and preserved-pin changes before either write", async () => {
    const h = await harness();
    const parsed = call(7);
    const base = preparer(h, parsed);
    await expect(runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const prepared = await base(current, identified);
      if (!prepared.ok) return prepared;
      return {
        ...prepared,
        value: {
          ...prepared.value,
          next_state: { ...prepared.value.next_state, config_digest: D("9") },
        },
      };
    })).rejects.toThrow(/identity or pin/u);
    expect(h.events).not.toContain("receipt-create");
    expect(h.events).not.toContain("state-replace");

    const h2 = await harness();
    const parsed2 = call(7);
    const accessor = preparer(h2, parsed2);
    await expect(runStateTransaction(h2.dependencies, request(h2.authority, parsed2), async (current, identified) => {
      const prepared = await accessor(current, identified);
      if (!prepared.ok) return prepared;
      const shell = { expectation: prepared.value.expectation, result: prepared.value.result };
      Object.defineProperty(shell, "next_state", { enumerable: true, get: () => prepared.value.next_state });
      return { ...prepared, value: shell as never };
    })).rejects.toThrow(/data property|plain JSON/u);
    expect(h2.events).not.toContain("receipt-create");

    const h3 = await harness();
    const parsed3 = call(7);
    const nonEnumerable = preparer(h3, parsed3);
    await expect(runStateTransaction(h3.dependencies, request(h3.authority, parsed3), async (current, identified) => {
      const prepared = await nonEnumerable(current, identified);
      if (!prepared.ok) return prepared;
      const shell = { expectation: prepared.value.expectation, result: prepared.value.result };
      Object.defineProperty(shell, "next_state", { enumerable: false, value: prepared.value.next_state });
      return { ...prepared, value: shell as never };
    })).rejects.toThrow(/enumerable data property/u);
    expect(h3.events).not.toContain("receipt-create");

    const h4 = await harness();
    const parsed4 = call(7);
    const symbolExtra = preparer(h4, parsed4);
    await expect(runStateTransaction(h4.dependencies, request(h4.authority, parsed4), async (current, identified) => {
      const prepared = await symbolExtra(current, identified);
      if (!prepared.ok) return prepared;
      return { ...prepared, value: { ...prepared.value, [Symbol("extra")]: true } as never };
    })).rejects.toThrow(/unexpected or missing slots/u);
    expect(h4.events).not.toContain("receipt-create");
  });

  it("rejects the safe-integer ceiling at the pre-prepare boundary", async () => {
    const h = await harness();
    h.state = canonicalDocument({ ...h.state.value, revision: parseSafeInteger(Number.MAX_SAFE_INTEGER) });
    const parsed = call(Number.MAX_SAFE_INTEGER);

    await expect(runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed)))
      .rejects.toThrow(/cannot advance beyond the safe-integer range/u);
    expect(h.counts.prepare).toBe(0);
    expect(h.counts.config).toBe(0);
    expect(h.events).not.toContain("receipt-create");
    expect(h.events).not.toContain("state-replace");
  });

  it("rejects a receipt over 1 MiB before either durable write", async () => {
    const h = await harness();
    const parsed = call(7);
    const base = preparer(h, parsed);
    const authoritativeResults = Array.from({ length: 6_000 }, (_, index) => ({
      phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(index + 1) }),
      step: "produce" as const,
      result_digest: D("1"),
      result_id: parseSafeId(`result-${String(index).padStart(6, "0")}`),
      input_fingerprint: D("2"),
    })).sort((left, right) => left.phase_instance.localeCompare(right.phase_instance));

    await expect(runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const prepared = await base(current, identified);
      if (!prepared.ok) return prepared;
      return { ...prepared, value: { ...prepared.value, next_state: { ...prepared.value.next_state, authoritative_results: authoritativeResults } } };
    })).rejects.toThrow(/exceeds the 1 MiB limit/u);
    expect(h.events).not.toContain("receipt-create");
    expect(h.events).not.toContain("state-replace");
  });

  it.each([
    ["open_gate", {
      gate_id: parsePathSafeId("gate-1"), gate_kind: "artifact-approval" as const,
      subject_digest: D("1"), context_digest: D("2"), opened_at_revision: parseSafeInteger(7),
    }],
    ["approvals", [{
      gate_id: parsePathSafeId("gate-1"), gate_kind: "artifact-approval" as const,
      subject_digest: D("1"), decision_digest: D("2"), resolved_at_revision: parseSafeInteger(7),
    }]],
    ["waivers", [{
      gate_id: parsePathSafeId("gate-1"), rule_id: parseSafeId("Rule:1"), rule_version: parseSafeInteger(1),
      subject_digest: D("1"), scope: { operation: "review-trigger" as const, boundary: "subject" as const },
      granted: true, expires: "task-complete" as const, granted_at_revision: parseSafeInteger(7),
    }]],
  ] as const)("rejects an unauthenticated %s change", async (field, changed) => {
    const h = await harness();
    const parsed = call(7);
    const base = preparer(h, parsed);
    await expect(runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const prepared = await base(current, identified);
      if (!prepared.ok) return prepared;
      return {
        ...prepared,
        value: { ...prepared.value, next_state: { ...prepared.value.next_state, [field]: changed } },
      } as typeof prepared;
    })).rejects.toThrow(/changed gate authority/u);
    expect(h.events).not.toContain("receipt-create");
    expect(h.events).not.toContain("state-replace");
  });

  it("preserves callback and completed-operation errors across release double faults", async () => {
    const programmer = await harness();
    const programmerCall = call(7);
    const failure = new Error("prepare programmer failure");
    programmer.dependencies = {
      ...programmer.dependencies,
      lock: {
        runExclusive: async <T>(_root: ResolvedTaskWorkspacePath, work: () => Promise<T>): Promise<T> => {
          try {
            return await work();
          } catch (error) {
            throw new TaskLockError("release", error);
          }
        },
      },
    };
    await expect(runStateTransaction(
      programmer.dependencies,
      request(programmer.authority, programmerCall),
      async () => { throw failure; },
    )).rejects.toBe(failure);

    const operation = await harness();
    operation.replaceFault = "before";
    operation.dependencies = {
      ...operation.dependencies,
      lock: {
        runExclusive: async <T>(_root: ResolvedTaskWorkspacePath, work: () => Promise<T>): Promise<T> => {
          await work();
          throw new TaskLockError("release");
        },
      },
    };
    const operationCall = call(7);
    const result = await runStateTransaction(
      operation.dependencies,
      request(operation.authority, operationCall),
      preparer(operation, operationCall),
    );
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "IO_ERROR",
      diagnostic: { parameters: { operation: "task-state-replace" } },
    });
  });

  it("requires the authentic authority/dependency pair before lock or I/O", async () => {
    const h = await harness();
    const parsed = call(7);
    await expect(runStateTransaction(
      { ...h.dependencies, environment: { ...h.environment } },
      request(h.authority, parsed),
      preparer(h, parsed),
    )).rejects.toThrow(/dependencies do not match/u);
    expect(h.events).toEqual([]);

    const h2 = await harness();
    const authentic = call(7);
    await expect(runStateTransaction(
      h2.dependencies,
      request(h2.authority, { ...authentic } as StateCall),
      preparer(h2, authentic),
    )).rejects.toThrow(/authentic parsed tool call/u);
    expect(h2.events).toEqual([]);
    expect(existsSync(join(h2.authority.task_root, "intents"))).toBe(false);
  });
});
