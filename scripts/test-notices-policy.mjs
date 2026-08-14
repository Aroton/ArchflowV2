import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "archflow-notices-policy-"));
const retainedPath = "notices/typescript-7.0.2-NOTICE.txt";

function runCheck(installedRoot = `${repositoryRoot}/node_modules`) {
  return spawnSync(
    process.execPath,
    [
      `${repositoryRoot}/scripts/check-notices.mjs`,
      "--lock",
      `${repositoryRoot}/package-lock.json`,
      "--inventory",
      `${repositoryRoot}/THIRD_PARTY_NOTICES.md`,
      "--notice-root",
      temporaryRoot,
      "--installed-root",
      installedRoot
    ],
    { encoding: "utf8" }
  );
}

try {
  await cp(`${repositoryRoot}/notices`, `${temporaryRoot}/notices`, { recursive: true });
  assert.equal(runCheck().status, 0, "copied retained notices should pass policy");

  await writeFile(`${temporaryRoot}/${retainedPath}`, "changed notice\n");
  const changed = runCheck();
  assert.notEqual(changed.status, 0, "changed retained notice must fail policy");
  assert.match(changed.stderr, /retained NOTICE digest mismatch/u);

  await cp(`${repositoryRoot}/${retainedPath}`, `${temporaryRoot}/${retainedPath}`);
  await unlink(`${temporaryRoot}/${retainedPath}`);
  const missing = runCheck();
  assert.notEqual(missing.status, 0, "missing retained notice must fail policy");
  assert.match(missing.stderr, /missing retained NOTICE asset/u);

  await cp(`${repositoryRoot}/${retainedPath}`, `${temporaryRoot}/${retainedPath}`);
  const syntheticInstalledRoot = `${temporaryRoot}/installed`;
  await mkdir(`${syntheticInstalledRoot}/ajv`, { recursive: true });
  await writeFile(`${syntheticInstalledRoot}/ajv/NOTICE.txt`, "unexpected unmapped notice\n");
  const unmapped = runCheck(syntheticInstalledRoot);
  assert.notEqual(unmapped.status, 0, "unexpected package notice must fail policy");
  assert.match(unmapped.stderr, /no retained standalone notice mapping/u);

  console.log("Notice policy mutation checks rejected changed, missing, and unmapped notice content.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
