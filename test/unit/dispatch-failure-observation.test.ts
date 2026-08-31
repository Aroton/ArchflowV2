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
import { createProjectionWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";

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
  } as TransactionDependencies;
  const state = {
    schema_version: "1",
    task_id: taskId,
    revision: parseSafeInteger(17),
    phase_instance: phase,
    step: "counter_review",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: parseSha256Digest("a".repeat(64)),
  } as TaskStateV1;
  return { authority: authority.value, dependencies, state };
}

describe("dispatch-failure observation", () => {
  it("classifies only the bounded outage set without carrying raw exception text", () => {
    const classified = classifiedDispatchFailure(new DispatchRoutingError(
      createProjectError("AUTH_UNAVAILABLE", { adapter: "claude-cli" }),
    ));
    expect(classified).toEqual({
      code: "AUTH_UNAVAILABLE",
      message: "The required reviewer authentication is unavailable.",
    });
    expect(classifiedDispatchFailure(new DispatchRoutingError(
      createProjectError("MODEL_OUTPUT_INVALID", { adapter: "claude-cli", attempt: 1, issue_code: "secret-tail" }),
    ))).toBeUndefined();
    expect(classifiedDispatchFailure(new Error("raw child stderr"))).toBeUndefined();
  });

  it("keeps the first observation of a revision, replaces it on a later revision, and reads only the exact running revision", async () => {
    const { authority, dependencies, state } = await fixture();
    const observerContext = {
      authority,
      dependencies,
      phase_instance: state.phase_instance,
      attempt: state.attempt,
      observed_at_revision: state.revision,
    } as const;
    await writeDispatchFailureObservation(observerContext, { role: "counter-reviewer", selected: {
      raw_route: { model: "other-model", effort: "high", provider: "zai" },
      source: { provenance: "invocation-declared" },
    }, error: new DispatchRoutingError(
      createProjectError("CONFIG_MODEL_UNSUPPORTED", { model: "other-model" }),
    ) });
    await writeDispatchFailureObservation(observerContext, { role: "adjudicator", selected: {
      raw_route: { model: "claude-fable-5", effort: "xhigh" },
      source: { provenance: "configured" },
    }, error: new DispatchRoutingError(
      createProjectError("PROCESS_FAILED", { adapter: "claude-cli", exit_class: "nonzero" }),
    ) });

    // Siblings of one round run to completion independently and more than one may fail; the
    // first classified failure to finish is kept and a later sibling must not overwrite it.
    await expect(readCurrentDispatchFailure(dependencies, authority, state)).resolves.toMatchObject({
      task_id: "dispatch-failure",
      phase_instance: "phase-impl-2",
      attempt: 1,
      observed_at_revision: 17,
      role: "counter-reviewer",
      code: "CONFIG_MODEL_UNSUPPORTED",
      route: { model: "other-model", effort: "high", provider: "zai", source: "invocation-declared" },
    });
    await expect(readCurrentDispatchFailure(dependencies, authority, {
      ...state, revision: parseSafeInteger(18),
    })).resolves.toBeUndefined();

    // A retry runs at a later revision and its failure replaces the stale slot.
    await writeDispatchFailureObservation({ ...observerContext, observed_at_revision: parseSafeInteger(18) }, {
      role: "adjudicator",
      selected: {
        raw_route: { model: "claude-fable-5", effort: "xhigh" },
        source: { provenance: "configured" },
      },
      error: new DispatchRoutingError(
        createProjectError("PROCESS_FAILED", { adapter: "claude-cli", exit_class: "nonzero" }),
      ),
    });
    await expect(readCurrentDispatchFailure(dependencies, authority, {
      ...state, revision: parseSafeInteger(18),
    })).resolves.toMatchObject({
      observed_at_revision: 18,
      role: "adjudicator",
      code: "PROCESS_FAILED",
      route: { model: "claude-fable-5", effort: "xhigh", source: "configured" },
    });
    await expect(readCurrentDispatchFailure(dependencies, authority, state)).resolves.toBeUndefined();
    await expect(readCurrentDispatchFailure(dependencies, authority, {
      ...state, status: "succeeded",
    })).resolves.toBeUndefined();
  });

  it("records the effort specialist under its distinct failure role and selected Luna route", async () => {
    const { authority, dependencies, state } = await fixture();
    await writeDispatchFailureObservation({
      authority,
      dependencies,
      phase_instance: state.phase_instance,
      attempt: state.attempt,
      observed_at_revision: state.revision,
    }, {
      role: "effort-reviewer",
      selected: {
        raw_route: { model: "gpt-5.6-luna", effort: "xhigh" },
        source: { provenance: "configured" },
      },
      error: new DispatchRoutingError(createProjectError("AUTH_UNAVAILABLE", { adapter: "codex-cli" })),
    });
    await expect(readCurrentDispatchFailure(dependencies, authority, state)).resolves.toMatchObject({
      role: "effort-reviewer",
      route: { model: "gpt-5.6-luna", effort: "xhigh", source: "configured" },
    });
  });
});
