import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("release output root safety", () => {
  it("rejects the repository itself before staging any release bytes", () => {
    const result = spawnSync(process.execPath, [
      resolve(repositoryRoot, "scripts/build-release.mjs"),
      "--output",
      repositoryRoot,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/stage root must be empty|stage root must not overlap repository root/u);
  });
});
