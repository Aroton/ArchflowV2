import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ renameHostConfig: false, temporaryMode: undefined as number | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (source: string, target: string) => {
      if (fault.renameHostConfig && target.endsWith("/.codex/config.toml")) {
        fault.temporaryMode = (await actual.stat(source)).mode & 0o777;
        throw Object.assign(new Error("injected pre-rename fault"), { code: "EIO" });
      }
      await actual.rename(source, target);
    },
  };
});

import { registerCodexProject } from "../../src/init/registration.js";

const roots: string[] = [];

afterEach(() => {
  fault.renameHostConfig = false;
  fault.temporaryMode = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("crash-safe host registration", () => {
  it("leaves the prior host configuration intact when replacement fails before rename", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-registration-fault-"));
    roots.push(root);
    const path = join(root, ".codex", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    const prior = "# user-owned configuration\nmodel = \"gpt-test\"\n";
    writeFileSync(path, prior);

    fault.renameHostConfig = true;
    const originalUmask = process.umask(0o002);
    let result: Awaited<ReturnType<typeof registerCodexProject>>;
    try {
      result = await registerCodexProject({ working_directory: root });
    } finally {
      process.umask(originalUmask);
    }

    expect(result).toMatchObject({ ok: false, error: { code: "IO_ERROR" } });
    expect(fault.temporaryMode).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe(prior);
    expect(readdirSync(dirname(path))).toEqual(["config.toml"]);
  });
});
