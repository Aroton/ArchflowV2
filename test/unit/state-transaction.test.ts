import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, parseCanonicalDocument, type CanonicalDocument } from "../../src/contracts/canonical.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import {
  parsePathSafeId,
  parseSafeCode,
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
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type GitEnvironment, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import type { ResolvedTaskPath } from "../../src/repository/paths.js";
import { AtomicReplaceError, type AtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { identifyTransactionRequest } from "../../src/state/request.js";
import { TaskLockError } from "../../src/state/lock.js";
import {
  runStateTransaction,
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
    createExclusive: async (_path, bytes) => {
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
  };
  value.dependencies = {
    runner: value.runner,
    environment: value.environment,
    atomic,
    lock: { runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>) => { events.push("lock"); return work(); } },
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
  };
  return value;
}

function call(expected_revision: number, status: "running" | "succeeded" | "failed" = "succeeded", intent = "intent-1"): StateCall {
  return parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: TASK,
    intent_id: intent,
    expected_revision,
    input_fingerprint: FINGERPRINT,
    phase_instance: PHASE,
    step: "produce",
    status,
  });
}

function request(authority: TransactionAuthority, parsed: StateCall): TransactionRequest<"archflow_state"> {
  return { authority, call: parsed };
}

function nextState(current: TaskStateV1, status: TaskStateV1["status"]): PreparedTransaction<"archflow_state">["next_state"] {
  const { revision: _revision, committed_intent: _committed, ...draft } = current;
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

describe("mature state transaction kernel", () => {
  it("writes one receipt before state and returns the authenticated committed state", async () => {
    const h = await harness();
    const parsed = call(7);
    const result = await runStateTransaction(h.dependencies, request(h.authority, parsed), preparer(h, parsed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replayed).toBe(false);
    expect(result.value.state.value.revision).toBe(8);
    expect(result.value.state.value.committed_intent?.receipt_digest).toBe(h.receipt?.digest);
    expect(h.events).toEqual(["lock", "config", "fingerprint", "prepare", "receipt-create", "state-replace"]);
    expect(h.counts.prepare).toBe(1);
  });

  it("runs CAS before receipt/config and requires refreshed CAS for exact replay", async () => {
    const h = await harness();
    const original = call(7);
    const first = await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original));
    expect(first.ok).toBe(true);
    const configAfterCommit = h.counts.config;

    const stale = await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original));
    expect(stale.ok ? undefined : stale.error.code).toBe("STATE_CONFLICT");
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
    expect(result.value.state.value.committed_intent?.receipt_digest).toBe(h.receipt?.digest);
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
        runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>): Promise<T> => {
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

  it("classifies exact retired reuse separately from changed reuse", async () => {
    const h = await harness();
    const original = call(7);
    expect((await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original))).ok).toBe(true);
    const committed = h.state.value.committed_intent;
    if (committed === undefined) throw new Error("missing committed fixture");
    h.state = canonicalDocument({
      ...h.state.value,
      revision: parseSafeInteger(9),
      committed_intent: { ...committed, intent_id: "another-intent" as typeof committed.intent_id },
    });

    const exact = call(9);
    const retired = await runStateTransaction(h.dependencies, request(h.authority, exact), preparer(h, exact));
    expect(retired.ok ? undefined : retired.error).toMatchObject({
      code: "INTENT_NOT_CURRENT",
      retryable: false,
      next_action: "inspect-current-state",
      diagnostic: { parameters: { intent_id: "intent-1", receipt_revision: 8, current_revision: 9 } },
    });

    const changed = call(9, "failed");
    const mismatch = await runStateTransaction(h.dependencies, request(h.authority, changed), preparer(h, changed));
    expect(mismatch.ok ? undefined : mismatch.error.code).toBe("INTENT_MISMATCH");
  });

  it("reports state-claimed receipt substitution before caller fingerprint/request mismatch", async () => {
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
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "STATE_INVALID",
      diagnostic: { parameters: { issue_code: "intent-receipt-request-mismatch" } },
    });
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
    "classifies a state-claimed %s receipt as STATE_INVALID",
    async (kind) => {
      const h = await harness();
      const original = call(7);
      expect((await runStateTransaction(h.dependencies, request(h.authority, original), preparer(h, original))).ok).toBe(true);
      h.dependencies = { ...h.dependencies, read_receipt: async () => ({ kind }) };
      const refreshed = call(8);
      const result = await runStateTransaction(h.dependencies, request(h.authority, refreshed), preparer(h, refreshed));
      expect(result.ok ? undefined : result.error).toMatchObject({
        code: "STATE_INVALID",
        diagnostic: { parameters: { issue_code: `intent-receipt-${kind}` } },
      });
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
    const approvals = Array.from({ length: 6_000 }, (_, index) => ({
      gate_id: parsePathSafeId(`gate-${String(index).padStart(6, "0")}`),
      gate_kind: "artifact-approval" as const,
      subject_digest: D("1"),
      decision_digest: D("2"),
      resolved_at_revision: parseSafeInteger(7),
    }));

    await expect(runStateTransaction(h.dependencies, request(h.authority, parsed), async (current, identified) => {
      const prepared = await base(current, identified);
      if (!prepared.ok) return prepared;
      return { ...prepared, value: { ...prepared.value, next_state: { ...prepared.value.next_state, approvals } } };
    })).rejects.toThrow(/exceeds the 1 MiB limit/u);
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
        runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>): Promise<T> => {
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
        runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>): Promise<T> => {
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
