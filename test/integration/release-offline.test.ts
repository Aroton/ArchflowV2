import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 120_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

// Every case stages its own payload from the working tree, so the suite never depends on whether
// the tracked dist/ has been regenerated yet (`npm run check:release` covers dist/ itself).
describe("offline release payload", () => {
  it("stages a single-entry payload that validates and runs init from an install-shaped copy", async () => {
    const staged = expectSuccess(runScript("scripts/build-release.mjs", ["--output", firstStage]));
    const checked = expectSuccess(runScript("scripts/check-release.mjs", ["--payload", firstStage]));
    const smoked = expectSuccess(runScript("scripts/smoke-release-bundle.mjs", ["--payload", firstStage]));

    expect(checked.bundle_digest).toBe(staged.bundle_digest);
    expect((staged.files as Array<{ path: string }>).map((file) => file.path)).toEqual([
      "archflow-local.mjs",
      "legal/THIRD_PARTY_NOTICES.md",
      "legal/upstream/installed-yaml-2.9.0/LICENSE",
      "legal/upstream/installed-zod-4.4.3/LICENSE",
      "manifest.json",
      "metafile.json",
    ]);
    const manifest = JSON.parse(await readFile(resolve(firstStage, "manifest.json"), "utf8")) as {
      build_entries: unknown[];
      entry_provenance: Array<{ id: string; output_path: string }>;
      bundle_digest: string;
      runtime_assets: Array<{ path: string }>;
      dependency_provenance_inputs: Array<{ package_name: string }>;
    };
    expect(manifest.build_entries).toEqual([{
      id: "local-cli",
      role: "local-cli",
      entry_point: "src/local/main.ts",
      output_path: "archflow-local.mjs",
      handler_authority: "local-cli-handler",
    }]);
    expect(manifest.entry_provenance.map((entry) => [entry.id, entry.output_path])).toEqual([["local-cli", "archflow-local.mjs"]]);
    expect(manifest).not.toHaveProperty("launch_profile");
    expect(manifest).not.toHaveProperty("adjacent_map_expectations");
    expect(new Set(manifest.dependency_provenance_inputs.map((record) => record.package_name))).toEqual(new Set(["yaml", "zod"]));
    const runtimeAssets = manifest.runtime_assets.map((record) => record.path);
    expect(runtimeAssets.filter((path) => !path.startsWith("assets/constitution/"))).toEqual([
      "assets/archflow.gitignore",
      "assets/config.template.yaml",
      "assets/rubrics/implementation.yaml",
      "assets/rubrics/simple-plan.yaml",
    ]);
    expect(runtimeAssets).toEqual(expect.arrayContaining(["assets/constitution/README.md", "assets/constitution/custom/README.md"]));
    expect(runtimeAssets).not.toContain("assets/review-inputs.yaml");
    expect(runtimeAssets).not.toContain("assets/rubrics/README.md");
    expect(smoked).toMatchObject({ bundles: ["archflow-local.mjs"], commands: ["help", "init"], runtime_assets: runtimeAssets.length });
  }, TEST_TIMEOUT_MS);

  it("reproduces byte-identical payloads in independent roots", () => {
    expectSuccess(runScript("scripts/build-release.mjs", ["--output", secondStage]));
    const proof = expectSuccess(runScript("scripts/check-release.mjs", [
      "--payload", firstStage,
      "--compare", secondStage,
    ]));

    expect(proof).toHaveProperty("compared_files");
    expect(proof).toHaveProperty("proof_inputs_digest");
  }, TEST_TIMEOUT_MS);

  it("rejects unsafe roots and manifest-bound proof drift", () => {
    const overlapping = runScript("scripts/build-release.mjs", ["--output", repositoryRoot]);
    expect(overlapping.status).toBe(1);
    expect(overlapping.stdout).toBe("");

    const mutations = expectSuccess(runScript("scripts/test-release-integrity.mjs", ["--payload", firstStage]));
    expect(mutations).toMatchObject({ status: "passed" });
    expect(mutations.mutations).toEqual(expect.arrayContaining([
      "path",
      "proof-input",
      "provenance",
      "runtime-asset",
      "second-entry",
      "symlink-root",
      "write-target",
    ]));
  }, TEST_TIMEOUT_MS);
});
