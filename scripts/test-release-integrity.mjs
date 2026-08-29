import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trackedPayload = resolve(repositoryRoot, "dist");

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortCanonical(value), null, 2);
}

function findProperty(value, name) {
  if (value === null || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, name)) return value[name];
  for (const child of Object.values(value)) {
    const found = findProperty(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findPathRecord(value) {
  if (value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && typeof value.path === "string") return value;
  for (const child of Object.values(value)) {
    const found = findPathRecord(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function expectFailure(label, operation) {
  let failed = false;
  try {
    await operation();
  } catch {
    failed = true;
  }
  assert.equal(failed, true, `${label} mutation unexpectedly validated`);
}

async function mutatePayload(temporaryRoot, label, mutation, checkReleasePayload) {
  const root = resolve(temporaryRoot, label);
  await cp(trackedPayload, root, { recursive: true, verbatimSymlinks: true });
  await mutation(root);
  await expectFailure(label, () => checkReleasePayload({ repositoryRoot, payloadRoot: root }));
}

async function main() {
  const support = await import(pathToFileURL(resolve(repositoryRoot, "scripts/release-support.mjs")));
  assert.equal(typeof support.checkReleasePayload, "function", "release support must export checkReleasePayload");
  assert.equal(typeof support.buildReleasePayload, "function", "release support must export buildReleasePayload");
  await support.checkReleasePayload({ repositoryRoot, payloadRoot: trackedPayload });

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "archflow-release-mutations-"));
  try {
    const mutationTasks = [
      async () => {
        await mutatePayload(temporaryRoot, "schema", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.unrecognized_release_authority = true;
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "schema";
      },
      async () => {
        await mutatePayload(temporaryRoot, "graph", async (root) => {
          const path = resolve(root, "metafile.json");
          const metafile = JSON.parse(await readFile(path, "utf8"));
          metafile.inputs["src/forged-release-input.ts"] = { bytes: 1, imports: [] };
          await writeFile(path, `${canonicalJson(metafile)}\n`);
        }, support.checkReleasePayload);
        return "graph";
      },
      async () => {
        await mutatePayload(temporaryRoot, "provenance", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          const records = findProperty(manifest, "dependency_provenance_inputs");
          assert.ok(Array.isArray(records) && records.length > 0, "manifest has no dependency provenance records");
          records[0].digest = "0".repeat(64);
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "provenance";
      },
      async () => {
        await mutatePayload(temporaryRoot, "path", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          const record = findPathRecord(manifest);
          assert.ok(record, "manifest has no path-bearing record");
          record.path = "../release-escape";
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "path";
      },
      async () => {
        await mutatePayload(temporaryRoot, "normalization", async (root) => {
          const path = resolve(root, "manifest.json");
          const bytes = await readFile(path);
          await writeFile(path, Buffer.from(bytes.toString("utf8").replace(/\n/gu, "\r\n")));
        }, support.checkReleasePayload);
        return "normalization";
      },
      async () => {
        await mutatePayload(temporaryRoot, "proof-input", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          const inputs = findProperty(manifest, "proof_inputs");
          assert.ok(Array.isArray(inputs) && inputs.length > 0, "manifest has no proof inputs");
          inputs.pop();
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "proof-input";
      },
      async () => {
        await mutatePayload(temporaryRoot, "bundle-origin-alias", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          const repositoryInputs = manifest.bundle_inputs.filter((record) => record.origin.kind === "repository");
          assert.ok(repositoryInputs.length >= 2);
          repositoryInputs[0].origin.path = repositoryInputs[1].origin.path;
          repositoryInputs[0].size = repositoryInputs[1].size;
          repositoryInputs[0].digest = repositoryInputs[1].digest;
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "bundle-origin-alias";
      },
      async () => {
        await mutatePayload(temporaryRoot, "metafile-size", async (root) => {
          const manifestPath = resolve(root, "manifest.json");
          const metafilePath = resolve(root, "metafile.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
          const key = Object.keys(metafile.inputs)[0];
          metafile.inputs[key].bytes += 1;
          const metafileBytes = Buffer.from(`${canonicalJson(metafile)}\n`);
          await writeFile(metafilePath, metafileBytes);
          const artifact = manifest.artifacts.find((record) => record.path === "metafile.json");
          artifact.size = metafileBytes.length;
          artifact.digest = support.sha256(metafileBytes);
          await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "metafile-size";
      },
      async () => {
        await mutatePayload(temporaryRoot, "adjacent-map-expectation", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.adjacent_map_expectations.pop();
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "adjacent-map-expectation";
      },
      async () => {
        await mutatePayload(temporaryRoot, "launch-profile", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.launch_profile.fixture_digests[0].digest = "0".repeat(64);
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "launch-profile";
      },
      async () => {
        await mutatePayload(temporaryRoot, "upstream-license", async (root) => {
          const manifestPath = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          const licenseArtifact = manifest.artifacts.find((record) => record.role === "upstream-legal");
          const outputPath = resolve(root, licenseArtifact.path);
          const bytes = Buffer.concat([await readFile(outputPath), Buffer.from("substitution")]);
          await writeFile(outputPath, bytes);
          licenseArtifact.size = bytes.length;
          licenseArtifact.digest = support.sha256(bytes);
          await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "upstream-license";
      },
      async () => {
        await mutatePayload(temporaryRoot, "third-party-notice", async (root) => {
          const manifestPath = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          const noticeArtifact = manifest.artifacts.find((record) => record.role === "legal-notice");
          const outputPath = resolve(root, noticeArtifact.path);
          const bytes = Buffer.from("forged notice\n");
          await writeFile(outputPath, bytes);
          noticeArtifact.size = bytes.length;
          noticeArtifact.digest = support.sha256(bytes);
          await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "third-party-notice";
      },
      async () => {
        const nonEmptyStage = resolve(temporaryRoot, "non-empty-stage");
        await mkdir(nonEmptyStage);
        await writeFile(resolve(nonEmptyStage, "external-target-canary"), "must remain unchanged\n");
        await expectFailure("pre-existing write target", () => support.buildReleasePayload({
          repositoryRoot,
          stageRoot: nonEmptyStage,
        }));
        assert.equal(await readFile(resolve(nonEmptyStage, "external-target-canary"), "utf8"), "must remain unchanged\n");
        return "write-target";
      },
      async () => {
        const realStage = resolve(temporaryRoot, "real-stage");
        const symlinkStage = resolve(temporaryRoot, "symlink-stage");
        await mkdir(realStage);
        await symlink(realStage, symlinkStage, "dir");
        await expectFailure("symlink write root", () => support.buildReleasePayload({
          repositoryRoot,
          stageRoot: symlinkStage,
        }));
        return "symlink-root";
      },
      async () => {
        await mutatePayload(temporaryRoot, "local-entry-provenance", async (root) => {
          const path = resolve(root, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          const local = manifest.entry_provenance.find((entry) => entry.id === "local-cli");
          assert.ok(local, "manifest has no local-cli provenance");
          local.output_digest = "0".repeat(64);
          await writeFile(path, `${canonicalJson(manifest)}\n`);
        }, support.checkReleasePayload);
        return "local-entry-provenance";
      },
      async () => {
        const rootStagePath = resolve(temporaryRoot, "overlap-stage");
        const rootStageSummary = await support.buildReleasePayload({ repositoryRoot, stageRoot: rootStagePath });
        await expectFailure("nested comparison", () => support.reproduceReleasePayload({
          repositoryRoot,
          stage: { stageRoot: rootStagePath, summary: rootStageSummary },
          materializationRoot: resolve(temporaryRoot, "overlap-source"),
          comparisonRoot: resolve(rootStagePath, "nested-comparison"),
        }));
        return "nested-comparison";
      },
      async () => {
        const recoveryRoot = resolve(temporaryRoot, "transaction-recovery");
        await mkdir(resolve(recoveryRoot, ".archflow-dist-backup"), { recursive: true });
        await mkdir(resolve(recoveryRoot, ".archflow-dist-promotion"), { recursive: true });
        await writeFile(resolve(recoveryRoot, ".archflow-dist-backup/old"), "old\n");
        await writeFile(resolve(recoveryRoot, ".archflow-dist-promotion/new"), "new\n");
        await writeFile(resolve(recoveryRoot, ".archflow-dist-transaction.json"), `${canonicalJson({
          candidate_manifest_digest: "a".repeat(64),
          had_dist: true,
          schema_version: "1",
        })}\n`);
        await support.recoverTrackedRelease(recoveryRoot);
        assert.equal(await readFile(resolve(recoveryRoot, "dist/old"), "utf8"), "old\n");
        await mkdir(resolve(recoveryRoot, ".archflow-dist-backup"));
        await writeFile(resolve(recoveryRoot, ".archflow-dist-backup/old"), "old\n");
        await mkdir(resolve(recoveryRoot, ".archflow-dist-promotion"));
        await writeFile(resolve(recoveryRoot, ".archflow-dist-promotion/uninstalled"), "new\n");
        await rename(resolve(recoveryRoot, "dist"), resolve(recoveryRoot, "retained-old"));
        await mkdir(resolve(recoveryRoot, "dist"));
        await writeFile(resolve(recoveryRoot, "dist/new"), "new\n");
        await writeFile(resolve(recoveryRoot, ".archflow-dist-transaction.json"), `${canonicalJson({
          candidate_manifest_digest: "b".repeat(64),
          had_dist: true,
          schema_version: "1",
        })}\n`);
        await support.recoverTrackedRelease(recoveryRoot);
        assert.equal(await readFile(resolve(recoveryRoot, "dist/new"), "utf8"), "new\n");
        return "transaction-recovery";
      },
    ];

    const passed = await Promise.all(mutationTasks.map((task) => task()));
    process.stdout.write(`${canonicalJson({ mutations: passed, status: "passed" })}\n`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
