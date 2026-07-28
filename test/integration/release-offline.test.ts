import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 120_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const trackedPayload = resolve(repositoryRoot, "dist");
let temporaryRoot = "";
let firstStage = "";
let secondStage = "";

function runScript(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, [resolve(repositoryRoot, script), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    timeout: TEST_TIMEOUT_MS,
  });
}

function expectSuccess(result: ReturnType<typeof runScript>): Record<string, unknown> {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(resolve(tmpdir(), "archflow-release-integration-"));
  firstStage = resolve(temporaryRoot, "stage-a");
  secondStage = resolve(temporaryRoot, "stage-b");
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (temporaryRoot !== "") await rm(temporaryRoot, { force: true, recursive: true });
});

describe("offline release payload", () => {
  it("validates and starts the tracked payload from a guarded hostile copy", () => {
    const checked = expectSuccess(runScript("scripts/check-release.mjs", ["--payload", trackedPayload]));
    const smoked = expectSuccess(runScript("scripts/smoke-release-bundle.mjs", ["--payload", trackedPayload]));

    expect(checked).toHaveProperty("bundle_digest");
    expect(smoked).toMatchObject({
      bundle: "archflow-mcp.mjs",
      fixture_sequences: ["initialize-and-calls", "malformed-json", "partial-json", "invalid-utf8"],
      modes: ["exact-copy", "guarded-copy"],
      module_canary_control: "resolved-via-NODE_PATH",
      network_oracle_bytes: 0,
    });
    expect(smoked.guarded_transcript_bytes).toEqual(expect.any(Number));
    expect(smoked.guarded_transcript_bytes).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("reproduces byte-identical payloads in independent roots", () => {
    expectSuccess(runScript("scripts/build-release.mjs", ["--output", firstStage]));
    expectSuccess(runScript("scripts/build-release.mjs", ["--output", secondStage]));
    const proof = expectSuccess(runScript("scripts/check-release.mjs", [
      "--payload", firstStage,
      "--compare", secondStage,
    ]));

    expect(proof).toHaveProperty("compared_files");
    expect(proof).toHaveProperty("proof_inputs_digest");
    expect(proof).toHaveProperty("launch_profile_digest");
  }, TEST_TIMEOUT_MS);

  it("rejects unsafe roots and manifest-bound proof drift", () => {
    const overlapping = runScript("scripts/build-release.mjs", ["--output", repositoryRoot]);
    expect(overlapping.status).toBe(1);
    expect(overlapping.stdout).toBe("");

    const mutations = expectSuccess(runScript("scripts/test-release-integrity.mjs", []));
    expect(mutations).toMatchObject({ status: "passed" });
    expect(mutations.mutations).toEqual(expect.arrayContaining([
      "path",
      "proof-input",
      "provenance",
      "symlink-root",
      "write-target",
    ]));
  }, TEST_TIMEOUT_MS);
});
