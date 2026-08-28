import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { DispatchProcessError } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";
import { REAL_HOST_TEST_TIMEOUT_MS, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);
const encoder = new TextEncoder();
const PHASE = parsePhaseInstanceId("prd");
const ENVELOPE: DispatchEnvelope = Object.freeze({
  result_kind: "review",
  bytes: encoder.encode("{}\n"),
  digest: "e".repeat(64) as DispatchEnvelope["digest"],
  byte_count: 3,
});

async function attemptRecord(workspace: TaskWorkspace): Promise<Record<string, unknown>> {
  const directory = join(workspace.root, ".archflow", "runtime", "tasks", workspace.taskId, "diagnostics", "attempts", "prd");
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(directory, names[0]!), "utf8")) as Record<string, unknown>;
}

describe.skipIf(!REAL_HOSTS_AVAILABLE)("real-host failure classes", () => {
  it("classifies a real Codex invalid-model rejection as UNSUPPORTED_MODEL", async () => {
    const workspace = await createTaskWorkspace({ taskId: "real-failure-model", label: "real-failure-model" });
    const route: DispatchRoute = {
      adapter: "codex-cli",
      family: "codex",
      model: "gpt-model-does-not-exist",
      effort: "xhigh",
    };
    try {
      const dispatch = createDispatchCoordinator({
        authority: workspace.services.authority,
        dependencies: workspace.services.dependencies,
        host: "claude",
        repository_root: workspace.root,
        phase_instance: PHASE,
        signal: new AbortController().signal,
        cancellation_source: "client",
      });
      await expect(dispatch(route, ENVELOPE, reviewSchema as PlainJsonValue)).rejects.toSatisfy((error: unknown) =>
        error instanceof CliAdapterError && error.project_error.code === "UNSUPPORTED_MODEL");
      expect(await attemptRecord(workspace)).toMatchObject({
        adapter: "codex-cli",
        model: route.model,
        status: "failed",
        failure_code: "UNSUPPORTED_MODEL",
        cli_version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
      });
    } finally {
      workspace.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);

  it("classifies an aborted real dispatch path as CANCELLED", async () => {
    const workspace = await createTaskWorkspace({ taskId: "real-failure-cancel", label: "real-failure-cancel" });
    const controller = new AbortController();
    const route: DispatchRoute = {
      adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "xhigh",
    };
    try {
      const dispatch = createDispatchCoordinator({
        authority: workspace.services.authority,
        dependencies: workspace.services.dependencies,
        host: "claude",
        repository_root: workspace.root,
        phase_instance: PHASE,
        signal: controller.signal,
        cancellation_source: "client",
      });
      const pending = dispatch(route, ENVELOPE, reviewSchema as PlainJsonValue);
      setTimeout(() => controller.abort(), 1).unref();
      await expect(pending).rejects.toSatisfy((error: unknown) =>
        error instanceof DispatchProcessError && error.project_error.code === "CANCELLED");
      expect(await attemptRecord(workspace)).toMatchObject({
        adapter: "codex-cli",
        status: "failed",
        failure_code: "CANCELLED",
        cancellation_source: "client",
      });
    } finally {
      workspace.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);

  // Real TIMEOUT would intentionally spend the full 300 s dispatch budget; OUTPUT_OVERFLOW would
  // buy an enormous generation; RATE_LIMITED would consume quota to exhaustion; and logged-out
  // AUTH_UNAVAILABLE would require clobbering the developer's own credentials. Those destructive
  // or disproportionate cases remain covered by the existing fake-host fault suites only.
});
