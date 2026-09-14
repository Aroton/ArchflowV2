import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { createProjectError } from "../../src/contracts/errors.js";
import {
  parseSafeCode,
  parseSafeInteger,
  parseSha256Digest,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { classifiedDispatchFailure, readCurrentDispatchFailure, writeDispatchFailureObservation } from "../../src/dispatch/failure-observation.js";
import { DispatchRoutingError } from "../../src/dispatch/routing.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter, createProjectionWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { createTaskLock } from "../../src/state/lock.js";
import { createDispatchRecovery, readDispatchRecovery, isTransientDispatchFailure } from "../../src/dispatch/recovery.js";
import { readFileSync } from "node:fs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "archflow-dispatch-failure-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnvironment });
  writeFileSync(join(root, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, env: gitEnvironment });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env: gitEnvironment });
  mkdirSync(join(root, ".archflow"));
  const taskId = parseTaskSlug("dispatch-failure");
  const phase = parsePhaseInstanceId("phase-impl-2");
  const context = {
    task_id: taskId,
    phase_instance: phase,
    operation: parseSafeCode("dispatch-failure-test"),
    attempt: parseSafeInteger(1),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw discovered.error;
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw environment.error;
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value, environment: environment.value, task_id: taskId, context,
  });
  if (!authority.ok) throw authority.error;
  const dependencies = {
    runner: discovered.value,
    environment: environment.value,
    projection_writer: createProjectionWriter(),
    atomic: createAtomicWriter(),
    lock: createTaskLock(),
    read_state: async () => ({ kind: "canonical", document: canonicalDocument(state) }),
  } as unknown as TransactionDependencies;
  const state = {
    schema_version: "1",
    task_id: taskId,
    revision: parseSafeInteger(17),
    phase_instance: phase,
    step: "counter_review",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: parseSha256Digest("a".repeat(64)),
    authoritative_results: [],
  } as unknown as TaskStateV1;
  mkdirSync(join(authority.value.task_root, "authority"), { recursive: true });
  mkdirSync(join(authority.value.workspace_root, "transient"), { recursive: true });
  return { authority: authority.value, dependencies, state };
}


const selected = { raw_route: { model: "gpt-5.6-sol", effort: "medium" }, source: { provenance: "configured" } } as const;
const limited = () => new DispatchRoutingError(createProjectError("RATE_LIMITED", { adapter: "codex-cli", attempt: 1 }));

describe("durable dispatch recovery", () => {
  it("preserves the specific adjudicator output failure through recovery and diagnostic reads", async () => {
    const context = await fixture();
    const route = { raw_route: { model: "gemini-3.8-flash-high", effort: "high" }, source: { provenance: "configured" } } as const;
    const error = new DispatchRoutingError(createProjectError("MODEL_OUTPUT_INVALID", {
      adapter: "antigravity-cli", attempt: 1, issue_code: "structured-output-missing",
    }));
    const expectedMessage = "The reviewer CLI response was missing structured_output.";
    let calls = 0;
    await expect(createDispatchRecovery(context).run("adjudicator", route, async () => { calls++; throw error; })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(await readDispatchRecovery(context)).toMatchObject({
      role: "adjudicator", code: "MODEL_OUTPUT_INVALID", message: expectedMessage,
      recovery: { status: "repair-required" },
    });
    await writeDispatchFailureObservation({
      ...context, phase_instance: context.state.phase_instance, attempt: context.state.attempt,
      observed_at_revision: context.state.revision,
    }, { role: "adjudicator", selected: route, error });
    expect(await readCurrentDispatchFailure(context.dependencies, context.authority, context.state))
      .toMatchObject({ message: expectedMessage });
    // Losing the disposable projection does not lose the message retained in durable recovery.
    rmSync(join(context.authority.workspace_root, "diagnostics"), { recursive: true, force: true });
    expect(await readDispatchRecovery({ ...context })).toMatchObject({ message: expectedMessage });
  });

  it("retries two transient failures on the same route and clears the boundary after success", async () => {
    const context = await fixture();
    let calls = 0;
    const observations: unknown[] = [];
    const recovery = createDispatchRecovery({ ...context, wait: async () => { observations.push(await readDispatchRecovery(context)); } });
    const result = await recovery.run("counter-reviewer", selected, async () => {
      calls++;
      if (calls < 3) throw limited();
      return "valid-result";
    });
    expect(result).toBe("valid-result");
    expect(calls).toBe(3);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ code: "RATE_LIMITED", recovery: { status: "retrying", dispatches: 1, maximum_dispatches: 3 } });
    expect(await readDispatchRecovery(context)).toBeNull();
  });
  it("retains exhaustion across producer restarts and loss of ignored diagnostics", async () => {
    const context = await fixture();
    let calls = 0;
    const run = () => { calls++; return Promise.reject(limited()); };
    await expect(createDispatchRecovery({ ...context, wait: async () => {} }).run("counter-reviewer", selected, run)).rejects.toThrow();
    expect(calls).toBe(3);
    const journal = readFileSync(join(context.authority.task_root, "authority/dispatch-recovery.json"), "utf8");
    rmSync(join(context.authority.workspace_root, "diagnostics"), { recursive: true, force: true });
    await expect(createDispatchRecovery({ ...context, wait: async () => {} }).run("counter-reviewer", selected, run)).rejects.toThrow(/exhausted/);
    expect(calls).toBe(3);
    expect(await readDispatchRecovery(context)).toMatchObject({ code: "RATE_LIMITED", recovery: { status: "exhausted", dispatches: 3 } });
    const before = readFileSync(join(context.authority.task_root, "authority/dispatch-recovery.json"), "utf8");
    await readDispatchRecovery(context);
    expect(readFileSync(join(context.authority.task_root, "authority/dispatch-recovery.json"), "utf8")).toBe(before);
    expect(journal).toContain("RATE_LIMITED");
  });
  it("never treats authentication, cancellation, generic process errors, or invalid output as transient", async () => {
    const context = await fixture();
    let calls = 0;
    const error = new DispatchRoutingError(createProjectError("AUTH_UNAVAILABLE", { adapter: "codex-cli" }));
    await expect(createDispatchRecovery(context).run("counter-reviewer", selected, async () => { calls++; throw error; })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(await readDispatchRecovery(context)).toMatchObject({ code: "AUTH_UNAVAILABLE", recovery: { status: "repair-required" } });
    expect(isTransientDispatchFailure(new Error("timeout in arbitrary prose"))).toBe(false);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("CANCELLED", { source: "client", attempt: 1 })))).toBe(false);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("PROCESS_FAILED", { adapter: "codex-cli", exit_class: "exit-1" })))).toBe(false);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("MODEL_OUTPUT_INVALID", { adapter: "codex-cli", attempt: 1, issue_code: "invalid" })))).toBe(false);
  });
  it("surfaces corrupt durable recovery state rather than forgetting the stop", async () => {
    const context = await fixture();
    writeFileSync(join(context.authority.task_root, "authority/dispatch-recovery.json"), "broken");
    expect(await readDispatchRecovery(context)).toMatchObject({ code: "RECOVERY_STATE_INVALID", recovery: { status: "repair-required" } });
    let called = false;
    await expect(createDispatchRecovery(context).run("counter-reviewer", selected, async () => { called = true; })).rejects.toThrow();
    expect(called).toBe(false);
  });
  it("permits an explicit one-dispatch authorization without resetting sibling failures", async () => {
    const context = await fixture();
    await expect(createDispatchRecovery({ ...context, wait: async () => {} }).run("counter-reviewer", selected, async () => { throw limited(); })).rejects.toThrow();
    const recovery = createDispatchRecovery({ ...context, retry_authorization: "human-authorized-intent" });
    expect(await recovery.run("counter-reviewer", selected, async () => "repaired")).toBe("repaired");
    expect(await readDispatchRecovery(context)).toBeNull();
  });
});
