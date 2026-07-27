import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const lockPath = resolve(options.lock ?? `${repositoryRoot}/package-lock.json`);
const inventoryPath = resolve(options.inventory ?? `${repositoryRoot}/THIRD_PARTY_NOTICES.md`);
const noticeRoot = resolve(options.noticeRoot ?? repositoryRoot);
const installedRoot = resolve(options.installedRoot ?? `${repositoryRoot}/node_modules`);

const lock = JSON.parse(await readFile(lockPath, "utf8"));
const inventory = await readFile(inventoryPath, "utf8");
const failures = [];

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--lock") parsed.lock = value;
    else if (flag === "--inventory") parsed.inventory = value;
    else if (flag === "--notice-root") parsed.noticeRoot = value;
    else if (flag === "--installed-root") parsed.installedRoot = value;
    else throw new Error(`unknown option ${flag}`);
  }
  return parsed;
}

function packageNameFromPath(path, metadata) {
  if (metadata.name) return metadata.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index === -1 ? "" : path.slice(index + marker.length);
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isNoticeFilename(filename) {
  return /^(?:notice|third[-_ ]?party)(?:\.|$)/iu.test(filename);
}

const lockedPackages = new Map();
const expectedSpdx = new Set();
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (path === "") continue;
  const name = packageNameFromPath(path, metadata);
  const identity = `${name}@${metadata.version}`;
  lockedPackages.set(identity, { path, name, metadata });
  expectedSpdx.add(`${identity} | ${metadata.license}`);
}

const recordedSpdx = new Set(
  [...inventory.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)].map((match) => `${match[1]} | ${match[2]}`)
);
for (const entry of [...expectedSpdx].filter((value) => !recordedSpdx.has(value)).sort()) {
  failures.push(`missing SPDX inventory entry: ${entry}`);
}
for (const entry of [...recordedSpdx].filter((value) => !expectedSpdx.has(value)).sort()) {
  failures.push(`stale SPDX inventory entry: ${entry}`);
}

const retainedMappings = new Map();
for (const match of inventory.matchAll(
  /^\| `([^`]+)` \| `([a-f0-9]{64})` \| `([^`]+)` \| `([a-f0-9]{64})` \|$/gm
)) {
  retainedMappings.set(match[1], {
    sourceDigest: match[2],
    retainedPath: match[3],
    retainedDigest: match[4]
  });
}

const reviewedTypeScriptPackages = new Set(
  [...lockedPackages.keys()].filter(
    (identity) => identity === "typescript@7.0.2" || /^@typescript\/typescript-[^@]+@7\.0\.2$/u.test(identity)
  )
);
for (const identity of reviewedTypeScriptPackages) {
  if (!retainedMappings.has(identity)) failures.push(`missing retained NOTICE mapping: ${identity}`);
}
for (const identity of retainedMappings.keys()) {
  if (!lockedPackages.has(identity)) failures.push(`retained NOTICE mapping is not in the lock: ${identity}`);
}

const verifiedAssets = new Set();
for (const [identity, mapping] of retainedMappings) {
  const assetKey = `${mapping.retainedPath}|${mapping.retainedDigest}`;
  if (!verifiedAssets.has(assetKey)) {
    let content;
    try {
      content = await readFile(resolve(noticeRoot, mapping.retainedPath));
    } catch {
      failures.push(`missing retained NOTICE asset: ${mapping.retainedPath}`);
      continue;
    }
    const actualDigest = digest(content);
    if (actualDigest !== mapping.retainedDigest) {
      failures.push(`retained NOTICE digest mismatch for ${mapping.retainedPath}: ${actualDigest}`);
    }
    verifiedAssets.add(assetKey);
  }

  const locked = lockedPackages.get(identity);
  if (locked === undefined) continue;
  const packageDirectory = resolve(installedRoot, locked.path.replace(/^node_modules\//u, ""));
  try {
    await access(packageDirectory, constants.R_OK);
  } catch {
    continue;
  }
  const noticeFiles = (await readdir(packageDirectory)).filter(isNoticeFilename);
  if (noticeFiles.length === 0) {
    failures.push(`installed package is missing its reviewed NOTICE: ${identity}`);
    continue;
  }
  for (const filename of noticeFiles) {
    const installedDigest = digest(await readFile(resolve(packageDirectory, filename)));
    if (installedDigest !== mapping.sourceDigest) {
      failures.push(`installed NOTICE digest mismatch for ${identity}/${filename}: ${installedDigest}`);
    }
  }
}

try {
  await access(installedRoot, constants.R_OK);
  for (const [identity, locked] of lockedPackages) {
    const packageDirectory = resolve(installedRoot, locked.path.replace(/^node_modules\//u, ""));
    let entries;
    try {
      entries = await readdir(packageDirectory);
    } catch {
      continue;
    }
    const noticeFiles = entries.filter(isNoticeFilename);
    if (noticeFiles.length > 0 && !retainedMappings.has(identity)) {
      failures.push(`installed package has an unreviewed standalone notice: ${identity} (${noticeFiles.join(", ")})`);
    }
  }
} catch {
  failures.push(`cannot inventory installed dependencies at ${installedRoot}; run npm ci first`);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Notices passed for ${expectedSpdx.size} locked SPDX entries and ${retainedMappings.size} reviewed package NOTICE mappings.`
  );
}
