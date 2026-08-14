import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clean: vi.fn(async () => ({
    schema_version: "1" as const,
    ok: true as const,
    value: {
      removed_files: 2,
      removed_bytes: 21,
      retained_files: 1,
      retained_bytes: 8,
      cleanup_pending: false,
    },
  })),
}));

vi.mock("../../src/state/production.js", () => ({
  createProductionServices: vi.fn(async () => ({
    schema_version: "1",
    ok: true,
    value: {
      authority: { workspace_root: "/repository/.archflow/runtime/tasks/local-clean", state: {} },
      dependencies: {
        lock: { runExclusive: async (_root: string, work: () => Promise<unknown>) => work() },
        read_state: async () => ({ kind: "canonical", document: { value: { terminal: undefined } } }),
      },
      state: { value: { terminal: undefined } },
    },
  })),
}));

vi.mock("../../src/state/workspace-cleanup.js", () => ({
  cleanTaskWorkspace: mocks.clean,
  cleanTerminalTaskWorkspace: vi.fn(),
}));

import { INPUT_FREE_COMMANDS, LOCAL_COMMAND_CONTRACTS, runLocalCommand } from "../../src/local/commands.js";

describe("archflow-local clean", () => {
  it("is an input-free task command", () => {
    expect(LOCAL_COMMAND_CONTRACTS.clean).toEqual({ payload: null, task: "required" });
    expect(INPUT_FREE_COMMANDS.has("clean")).toBe(true);
  });

  it("returns workspace cleanup accounting without a payload or maintenance record", async () => {
    const result = await runLocalCommand({
      command: "clean",
      working_directory: "/repository",
      task_id: "local-clean",
    });

    expect(result).toEqual({
      schema_version: "1",
      ok: true,
      value: {
        removed_files: 2,
        removed_bytes: 21,
        retained_files: 1,
        retained_bytes: 8,
        cleanup_pending: false,
      },
    });
    expect(mocks.clean).toHaveBeenCalledOnce();
  });
});
