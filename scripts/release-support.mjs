import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import {
  dirname,
  basename,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIST_TRANSACTION = Object.freeze({
  marker: ".archflow-dist-transaction.json",
  markerTemporary: ".archflow-dist-transaction.tmp",
  promotion: ".archflow-dist-promotion",
  backup: ".archflow-dist-backup",
});

export const RELEASE_FILES = Object.freeze([
  "archflow-local.mjs",
  "legal/THIRD_PARTY_NOTICES.md",
  "manifest.json",
  "metafile.json",
]);

export const RELEASE_BUILD_PROFILE = Object.freeze({
  entries: Object.freeze([
    Object.freeze({ id: "local-cli", role: "local-cli", entryPoint: "src/local/main.ts", output: "archflow-local.mjs", handlerAuthority: "local-cli-handler" }),
  ]),
  platform: "node",
  loader: { ".yaml": "text" },
  format: "esm",
  target: "node24",
  bundle: true,
  splitting: false,
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner:
    'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  tsconfigRaw: Object.freeze({ compilerOptions: Object.freeze({}) }),
});

const PROOF_INPUTS = Object.freeze([
  "package.json",
  "scripts/smoke-release-bundle.mjs",
  "scripts/test-release-integrity.mjs",
  "test/integration/release-bundle-review.test.ts",
  "test/integration/release-offline.test.ts",
]);

const REQUIRED_CONTROLS = Object.freeze([
  ".gitattributes",
  "package-lock.json",
  "package.json",
  "scripts/build-release.mjs",
  "scripts/check-release.mjs",
  "scripts/release-support.mjs",
  "scripts/reproduce-release.mjs",
  "scripts/smoke-release-bundle.mjs",
  "scripts/test-release-integrity.mjs",
  "scripts/write-tracked-release.mjs",
  "src/contracts/schemas/v1/release-manifest.schema.json",
  "src/contracts/versions.ts",
  "test/contracts/release-contracts.test.ts",
  "test/integration/release-bundle-review.test.ts",
  "test/integration/release-offline.test.ts",
]);

// The files the installed bundle reads at runtime, beside dist/ in the install root, plus every
// file under assets/constitution/. Review input YAML is inlined into the bundle by the ".yaml" text
// loader, and assets/rubrics/README.md documents the rubrics for maintainers, so neither ships.
const RUNTIME_ASSET_FILES = Object.freeze([
  "assets/archflow.gitignore",
  "assets/config.template.yaml",
  "assets/rubrics/implementation.yaml",
  "assets/rubrics/simple-plan.yaml",
]);
const RUNTIME_ASSET_DIRECTORIES = Object.freeze(["assets/constitution"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function ordinal(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const BUILTIN_IMPORTS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function assertExpectedExternalImport(path) {
  invariant(BUILTIN_IMPORTS.has(path), `unexpected external release import: ${path}`);
}

function buildEntries() {
  return RELEASE_BUILD_PROFILE.entries.map((entry) => ({
    id: entry.id,
    role: entry.role,
    entry_point: entry.entryPoint,
    output_path: entry.output,
    handler_authority: entry.handlerAuthority,
  }));
}

function resolveMetafileOutput(metafile, outputPath) {
  return metafile.outputs[outputPath] ?? metafile.outputs[`dist/${outputPath}`];
}

function deriveExternalImports(output) {
  const imports = [...new Set(output.imports.map((record) => record.path))].sort(ordinal);
  for (const path of imports) assertExpectedExternalImport(path);
  return imports;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort(ordinal);
    const sorted = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      sorted[key] = sortCanonical(value[key]);
    }
    return sorted;
  }
  invariant(value !== undefined, "canonical JSON cannot contain undefined");
  invariant(
    typeof value !== "number" || Number.isFinite(value),
    "canonical JSON cannot contain a non-finite number",
  );
  return value;
}

export function canonicalJsonBytes(value) {
  return encoder.encode(`${JSON.stringify(sortCanonical(value), null, 2)}\n`);
}

export function canonicalDocument(value) {
  const bytes = canonicalJsonBytes(value);
  return Object.freeze({ bytes, value: Object.freeze(value), digest: sha256(bytes) });
}

export function parseCanonicalDocument(bytes, description = "JSON document") {
  invariant(bytes instanceof Uint8Array, `${description} must be bytes`);
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`${description} is not valid UTF-8 JSON: ${error.message}`);
  }
  const expected = canonicalJsonBytes(value);
  invariant(
    Buffer.from(bytes).equals(Buffer.from(expected)),
    `${description} is not canonical JSON`,
  );
  return Object.freeze({ bytes, value: Object.freeze(value), digest: sha256(bytes) });
}

export function assertPortablePath(value, description = "path") {
  invariant(typeof value === "string" && value.length > 0, `${description} must be non-empty`);
  invariant(!value.includes("\\"), `${description} must use forward slashes`);
  invariant(!value.startsWith("/") && !value.startsWith("//"), `${description} must be relative`);
  invariant(!/^[A-Za-z]:/.test(value), `${description} must not be drive-qualified`);
  const segments = value.split("/");
  invariant(
    segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    `${description} contains an unsafe segment`,
  );
  return value;
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function assertNoSymlinkTraversal(path, { allowMissingLeaf = false } = {}) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  invariant(absolute !== root, "filesystem roots are not valid release roots");
  const segments = relative(root, absolute).split(sep);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index]);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && index === segments.length - 1) return;
      throw error;
    }
    invariant(!info.isSymbolicLink(), `symlink traversal is forbidden: ${cursor}`);
    if (index < segments.length - 1) invariant(info.isDirectory(), `non-directory ancestor: ${cursor}`);
  }
}

async function canonicalExistingDirectory(path, description) {
  invariant(typeof path === "string" && isAbsolute(path), `${description} must be absolute`);
  const absolute = resolve(path);
  await assertNoSymlinkTraversal(absolute);
  const info = await lstat(absolute);
  invariant(info.isDirectory(), `${description} must be a directory`);
  return realpath(absolute);
}

async function prepareEmptyRoot(path, description, otherRoots) {
  invariant(typeof path === "string" && isAbsolute(path), `${description} must be absolute`);
  const absolute = resolve(path);
  await assertNoSymlinkTraversal(dirname(absolute));
  let exists = true;
  try {
    const info = await lstat(absolute);
    invariant(!info.isSymbolicLink() && info.isDirectory(), `${description} must be a directory`);
    invariant((await readdir(absolute)).length === 0, `${description} must be empty`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (!exists) await mkdir(absolute);
  const canonical = await realpath(absolute);
  invariant(canonical !== parse(canonical).root, `${description} cannot be a filesystem root`);
  for (const [otherName, otherRoot] of otherRoots) {
    invariant(
      canonical !== otherRoot && !isInside(canonical, otherRoot) && !isInside(otherRoot, canonical),
      `${description} overlaps ${otherName}`,
    );
  }
  return canonical;
}

async function canonicalDedicatedRootCandidate(path, description) {
  invariant(typeof path === "string" && isAbsolute(path), `${description} must be absolute`);
  const absolute = resolve(path);
  invariant(absolute !== parse(absolute).root, `${description} cannot be a filesystem root`);
  await assertNoSymlinkTraversal(dirname(absolute));
  try {
    const info = await lstat(absolute);
    invariant(!info.isSymbolicLink() && info.isDirectory(), `${description} must be a directory`);
    invariant((await readdir(absolute)).length === 0, `${description} must be empty`);
    return realpath(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolve(await realpath(dirname(absolute)), basename(absolute));
  }
}

function assertRootsPairwiseNonOverlapping(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const [leftName, leftRoot] = roots[left];
      const [rightName, rightRoot] = roots[right];
      invariant(
        leftRoot !== rightRoot && !isInside(leftRoot, rightRoot) && !isInside(rightRoot, leftRoot),
        `${leftName} overlaps ${rightName}`,
      );
    }
  }
}

async function readRegularFile(root, portablePath, description = portablePath) {
  assertPortablePath(portablePath, description);
  const absolute = resolve(root, ...portablePath.split("/"));
  invariant(isInside(root, absolute), `${description} escapes its root`);
  await assertNoSymlinkTraversal(absolute);
  const info = await lstat(absolute);
  invariant(info.isFile(), `${description} must be a regular file`);
  return readFile(absolute);
}

async function walkRegularFiles(root, prefix = "") {
  const directory = prefix ? resolve(root, ...prefix.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => ordinal(a.name, b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    invariant(!entry.isSymbolicLink(), `symlinks are forbidden in release trees: ${path}`);
    if (entry.isDirectory()) files.push(...(await walkRegularFiles(root, path)));
    else {
      invariant(entry.isFile(), `non-regular file in release tree: ${path}`);
      files.push(path);
    }
  }
  return files;
}

async function fileRecord(root, path) {
  const bytes = await readRegularFile(root, path);
  return Object.freeze({ path, size: bytes.byteLength, digest: sha256(bytes) });
}

async function collectRuntimeAssetPaths(repositoryRoot) {
  const paths = [...RUNTIME_ASSET_FILES];
  for (const directory of RUNTIME_ASSET_DIRECTORIES) {
    for (const path of await walkRegularFiles(resolve(repositoryRoot, directory))) paths.push(`${directory}/${path}`);
  }
  return paths.sort(ordinal);
}

async function collectDeclaredPaths(repositoryRoot) {
  const schemas = (await readdir(resolve(repositoryRoot, "src/contracts/schemas/v1")))
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => `src/contracts/schemas/v1/${name}`);
  return [...schemas, ...(await collectRuntimeAssetPaths(repositoryRoot))].sort(ordinal);
}

async function collectLegalSourcePaths(repositoryRoot) {
  const paths = ["THIRD_PARTY_NOTICES.md"];
  const root = resolve(repositoryRoot, "release/legal/upstream");
  try {
    for (const path of await walkRegularFiles(root)) paths.push(`release/legal/upstream/${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return paths;
}

function packageIdentity(inputPath) {
  const match = inputPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/);
  return match ? { packageName: match[1], packagePath: match[2] } : undefined;
}

async function readPackageVersion(repositoryRoot, packageName) {
  const bytes = await readRegularFile(repositoryRoot, `node_modules/${packageName}/package.json`);
  const value = JSON.parse(decoder.decode(bytes));
  invariant(value.name === packageName && typeof value.version === "string", `invalid package identity: ${packageName}`);
  return value.version;
}

async function collectDependencyProvenance(repositoryRoot, contributing) {
  const records = new Map();
  const packageNames = new Set();
  for (const path of contributing) {
    const identity = packageIdentity(path);
    if (identity) packageNames.add(identity.packageName);
  }
  for (const packageName of packageNames) {
    const packageRoot = `node_modules/${packageName}`;
    const version = await readPackageVersion(repositoryRoot, packageName);
    const packageEntries = new Set(await readdir(resolve(repositoryRoot, packageRoot)));
    for (const packagePath of ["package.json", "LICENSE", "LICENSE.md", "license.md", "LICENSE.txt", "LICENSE.BSD", "NOTICE"]) {
      // Case-insensitive lookups must not invent paths that fail on Linux.
      if (!packageEntries.has(packagePath)) continue;
      const bytes = await readRegularFile(repositoryRoot, `${packageRoot}/${packagePath}`);
      records.set(`${packageName}:${packagePath}`, {
        package_name: packageName,
        package_version: version,
        package_relative_path: packagePath,
        size: bytes.byteLength,
        digest: sha256(bytes),
        purpose: packagePath === "package.json" ? "package-manifest" : packagePath === "NOTICE" ? "notice" : "license",
      });
    }
  }
  return [...records.values()].sort((a, b) =>
    ordinal(`${a.package_name}/${a.package_relative_path}`, `${b.package_name}/${b.package_relative_path}`),
  );
}

async function loadSchemaValidators(repositoryRoot) {
  const schemaDirectory = resolve(repositoryRoot, "src/contracts/schemas/v1");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({
    keyword: "x-archflow-sorted-unique",
    schemaType: "boolean",
    metaSchema: { const: true },
    type: "array",
    errors: false,
    validate: (_enabled, data) => data.every((value, index) => index === 0 || data[index - 1] < value),
  });
  ajv.addKeyword({
    keyword: "x-archflow-unique-by",
    schemaType: ["string", "array"],
    metaSchema: {
      oneOf: [
        { type: "string", minLength: 1 },
        { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
      ],
    },
    type: "array",
    errors: false,
    validate: (properties, data) => {
      const names = typeof properties === "string" ? [properties] : properties;
      const values = data.map((item) => names.map((name) => item?.[name]));
      return values.every((value, index) => values.slice(0, index).every((prior) => !isDeepStrictEqual(prior, value)));
    },
  });
  const manifestSchema = JSON.parse(await readFile(resolve(schemaDirectory, "release-manifest.schema.json"), "utf8"));
  ajv.addSchema(manifestSchema);
  return {
    manifest: ajv.getSchema(manifestSchema.$id) ?? ajv.compile(manifestSchema),
  };
}

function schemaAssert(validator, value, description) {
  invariant(validator(value), `${description} schema validation failed: ${JSON.stringify(validator.errors)}`);
}

function recordPaths(records) {
  return records.map((record) => record.path);
}

function assertSortedUnique(values, description) {
  const sorted = [...values].sort(ordinal);
  invariant(new Set(values).size === values.length, `${description} contains duplicates`);
  invariant(values.every((value, index) => value === sorted[index]), `${description} is not sorted`);
}

async function assertRecords(repositoryRoot, records, description) {
  assertSortedUnique(recordPaths(records), description);
  for (const record of records) {
    assertPortablePath(record.path, `${description} path`);
    const bytes = await readRegularFile(repositoryRoot, record.path);
    invariant(record.size === bytes.byteLength && record.digest === sha256(bytes), `${description} record is stale: ${record.path}`);
  }
}

async function verifyDependencyRecords(repositoryRoot, records) {
  const keys = records.map((record) => `${record.package_name}@${record.package_version}/${record.package_relative_path}`);
  assertSortedUnique(keys, "dependency provenance inputs");
  const versions = new Map();
  for (const record of records) {
    assertPortablePath(record.package_relative_path, "dependency package path");
    invariant(typeof record.package_name === "string" && !record.package_name.includes(".."), "invalid package name");
    let version = versions.get(record.package_name);
    if (!version) {
      version = await readPackageVersion(repositoryRoot, record.package_name);
      versions.set(record.package_name, version);
    }
    invariant(version === record.package_version, `dependency version mismatch: ${record.package_name}`);
    const bytes = await readRegularFile(
      repositoryRoot,
      `node_modules/${record.package_name}/${record.package_relative_path}`,
      "dependency provenance input",
    );
    invariant(bytes.byteLength === record.size && sha256(bytes) === record.digest, `stale dependency input: ${record.package_name}/${record.package_relative_path}`);
  }
}

async function expectedControls(repositoryRoot, bundleInputs) {
  return createControlRecords(repositoryRoot, bundleInputs);
}

function assertEqualPathSet(actual, expected, description) {
  assertSortedUnique(actual, description);
  invariant(
    actual.length === expected.length && actual.every((path, index) => path === expected[index]),
    `${description} is not the exact required set`,
  );
}

async function validateNoticeContents(repositoryRoot, payloadRoot, actualFiles) {
  const sourceNotice = await readRegularFile(repositoryRoot, "THIRD_PARTY_NOTICES.md");
  const payloadNotice = await readRegularFile(payloadRoot, "legal/THIRD_PARTY_NOTICES.md");
  invariant(Buffer.from(sourceNotice).equals(Buffer.from(payloadNotice)), "third-party notice differs from repository source");

  const sourcePaths = (await collectLegalSourcePaths(repositoryRoot))
    .filter((path) => path.startsWith("release/legal/upstream/"));
  const payloadPaths = actualFiles.filter((path) => path.startsWith("legal/upstream/"));
  assertEqualPathSet(
    payloadPaths,
    sourcePaths.map((path) => path.slice("release/".length)),
    "retained upstream license payloads",
  );
  for (const sourcePath of sourcePaths) {
    const payloadPath = sourcePath.slice("release/".length);
    const sourceBytes = await readRegularFile(repositoryRoot, sourcePath);
    const payloadBytes = await readRegularFile(payloadRoot, payloadPath);
    invariant(Buffer.from(sourceBytes).equals(Buffer.from(payloadBytes)), `retained upstream license differs: ${sourcePath}`);
  }
}

function manifestField(manifest, ...names) {
  for (const name of names) if (manifest[name] !== undefined) return manifest[name];
  return undefined;
}

export async function validateReleaseSemantics({ repositoryRoot, payloadRoot, manifest }) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  const payload = await canonicalExistingDirectory(payloadRoot, "payload root");
  const trackedPayload = resolve(repository, "dist");
  invariant(
    payload === trackedPayload
      || (repository !== payload && !isInside(repository, payload) && !isInside(payload, repository)),
    "payload root must be the fixed repository dist or outside the repository",
  );
  const validators = await loadSchemaValidators(repository);
  schemaAssert(validators.manifest, manifest.value, "release manifest");

  const bundleInputs = manifestField(manifest.value, "bundle_inputs");
  const controls = manifestField(manifest.value, "release_control_inputs");
  const runtimeAssets = manifestField(manifest.value, "runtime_assets");
  const dependencyInputs = manifestField(manifest.value, "dependency_provenance_inputs");
  const contributing = manifestField(manifest.value, "contributing_inputs");
  const artifacts = manifestField(manifest.value, "artifacts", "generated_artifacts");
  invariant(Array.isArray(bundleInputs) && Array.isArray(controls) && Array.isArray(runtimeAssets) && Array.isArray(dependencyInputs), "manifest input collections are required");
  invariant(Array.isArray(contributing) && Array.isArray(artifacts), "manifest closure collections are required");
  assertSortedUnique(bundleInputs.map((record) => record.key), "bundle inputs");
  for (const record of bundleInputs) {
    assertPortablePath(record.key, "bundle input key");
    const path = record.origin.kind === "repository"
      ? record.origin.path
      : `node_modules/${record.origin.package_name}/${record.origin.package_relative_path}`;
    invariant(record.key === path, `bundle input key does not identify its physical origin: ${record.key}`);
    const bytes = await readRegularFile(repository, path);
    invariant(bytes.byteLength === record.size && sha256(bytes) === record.digest, `stale bundle input: ${record.key}`);
  }
  await assertRecords(repository, controls, "release controls");
  const exactControls = await expectedControls(repository, bundleInputs);
  assertEqualPathSet(recordPaths(controls), recordPaths(exactControls), "release controls");
  await assertRecords(repository, runtimeAssets, "runtime assets");
  assertEqualPathSet(recordPaths(runtimeAssets), await collectRuntimeAssetPaths(repository), "runtime assets");
  await verifyDependencyRecords(repository, dependencyInputs);
  const owners = [
    ...bundleInputs.filter((record) => record.origin.kind === "repository").map((record) => ({ path: record.origin.path })),
    ...controls,
  ];
  invariant(new Set(recordPaths(owners)).size === owners.length, "repository inputs have duplicate ownership");
  const ownerPaths = new Set(recordPaths(owners));
  assertEqualPathSet(manifest.value.proof_inputs, [...PROOF_INPUTS], "proof inputs");
  for (const path of manifest.value.proof_inputs) invariant(ownerPaths.has(path), `unresolved proof input: ${path}`);
  const declared = manifest.value.declared_content;
  const expectedDeclared = await collectDeclaredPaths(repository);
  assertEqualPathSet(declared.schemas, expectedDeclared.filter((path) => path.startsWith("src/contracts/schemas/v1/")), "declared schemas");
  assertEqualPathSet(declared.constitution, expectedDeclared.filter((path) => path.startsWith("assets/constitution/")), "declared constitution");
  for (const path of [...declared.schemas, ...declared.constitution]) invariant(ownerPaths.has(path), `unresolved declared content: ${path}`);
  assertSortedUnique(contributing, "contributing inputs");
  invariant(contributing.every((path) => bundleInputs.some((record) => record.key === path)), "contributing input is not scanned");
  invariant(
    contributing.length === bundleInputs.filter((record) => record.bytes_in_output > 0).length
      && contributing.every((path) => bundleInputs.find((record) => record.key === path).bytes_in_output > 0),
    "contributing inputs do not equal positive-byte bundle inputs",
  );

  const actualFiles = await walkRegularFiles(payload);
  const artifactPaths = recordPaths(artifacts);
  assertSortedUnique(artifactPaths, "artifacts");
  invariant(actualFiles.length === artifactPaths.length && actualFiles.every((path, index) => path === artifactPaths[index]), "payload closure does not match manifest artifacts");
  for (const artifact of artifacts) {
    if (artifact.path === "manifest.json") {
      invariant(artifact.role === "manifest" && artifact.size === undefined && artifact.digest === undefined, "manifest self-entry is invalid");
      continue;
    }
    const bytes = await readRegularFile(payload, artifact.path);
    invariant(bytes.byteLength === artifact.size && sha256(bytes) === artifact.digest, `stale payload artifact: ${artifact.path}`);
  }
  const bundleBytes = await readRegularFile(payload, "archflow-local.mjs");
  invariant(sha256(bundleBytes) === manifest.value.bundle_digest, "bundle digest mismatch");
  const metafileDocument = parseCanonicalDocument(await readRegularFile(payload, "metafile.json"), "release metafile");
  const metafileInputs = metafileDocument.value.inputs;
  const metafileOutputs = metafileDocument.value.outputs;
  invariant(metafileInputs && metafileOutputs && Object.keys(metafileOutputs).length === RELEASE_BUILD_PROFILE.entries.length, "release metafile output count differs");
  assertEqualPathSet(Object.keys(metafileInputs).sort(ordinal), bundleInputs.map((record) => record.key), "metafile inputs");
  for (const record of bundleInputs) {
    invariant(metafileInputs[record.key]?.bytes === record.size, `metafile scanned size differs: ${record.key}`);
    const contributedBytes = RELEASE_BUILD_PROFILE.entries.reduce((total, entry) => total + (resolveMetafileOutput(metafileDocument.value, entry.output)?.inputs[record.key]?.bytesInOutput ?? 0), 0);
    invariant(contributedBytes === record.bytes_in_output, `metafile byte contribution differs: ${record.key}`);
  }
  const expectedProvenance = [];
  for (const entry of RELEASE_BUILD_PROFILE.entries) {
    const outputMeta = resolveMetafileOutput(metafileDocument.value, entry.output);
    invariant(outputMeta?.entryPoint === entry.entryPoint, `release metafile entry/output differs: ${entry.id}`);
    const outputBytes = await readRegularFile(payload, entry.output);
    expectedProvenance.push({
      id: entry.id,
      entry_point: entry.entryPoint,
      output_path: entry.output,
      output_digest: sha256(outputBytes),
      contributing_inputs: Object.entries(outputMeta.inputs).filter(([, record]) => record.bytesInOutput > 0).map(([path]) => path).sort(ordinal),
      allowed_imports: deriveExternalImports(outputMeta),
    });
  }
  invariant(isDeepStrictEqual(manifest.value.entry_provenance, expectedProvenance), "per-entry release provenance differs from metafile and output bytes");
  const derivedDependencyInputs = await collectDependencyProvenance(repository, contributing);
  invariant(isDeepStrictEqual(dependencyInputs, derivedDependencyInputs), "dependency provenance inputs are not the exact derived closure");

  const dependencyInventoryDigest = sha256(canonicalJsonBytes({
    bundle_inputs: bundleInputs.filter((record) => record.origin.kind === "dependency"),
    dependency_provenance_inputs: dependencyInputs,
  }));
  invariant(dependencyInventoryDigest === manifest.value.dependency_inventory_digest, "dependency inventory digest mismatch");
  invariant(isDeepStrictEqual(manifest.value.build_entries, buildEntries()), "release has unexpected build entries");
  await validateNoticeContents(repository, payload, actualFiles);

  const summary = Object.freeze({
    payloadRoot: payload,
    files: Object.freeze(await Promise.all(actualFiles.map((path) => fileRecord(payload, path)))),
    bundleDigest: sha256(bundleBytes),
    dependencyInventoryDigest,
    manifest,
  });
  return Object.freeze({ stageRoot: payload, summary });
}

async function readPayloadDocuments(payloadRoot) {
  return {
    manifest: parseCanonicalDocument(await readRegularFile(payloadRoot, "manifest.json"), "release manifest"),
  };
}

function normalizedMetafile(metafile) {
  return sortCanonical(metafile);
}

async function buildRecords(repositoryRoot, metafile) {
  const outputs = RELEASE_BUILD_PROFILE.entries.map((entry) => {
    const output = resolveMetafileOutput(metafile, entry.output);
    invariant(output?.entryPoint === entry.entryPoint, `esbuild metafile has no stable output for ${entry.id}`);
    return output;
  });
  invariant(Object.keys(metafile.outputs).length === outputs.length, "release build emitted unexpected outputs");
  const inputs = [];
  for (const path of Object.keys(metafile.inputs).sort(ordinal)) {
    assertPortablePath(path, "esbuild input path");
    const bytes = await readRegularFile(repositoryRoot, path);
    const identity = packageIdentity(path);
    const bytesInOutput = outputs.reduce((total, output) => total + (output.inputs[path]?.bytesInOutput ?? 0), 0);
    const origin = identity
      ? {
          kind: "dependency",
          package_name: identity.packageName,
          package_version: await readPackageVersion(repositoryRoot, identity.packageName),
          package_relative_path: identity.packagePath,
        }
      : { kind: "repository", path };
    inputs.push({
      key: path,
      origin,
      size: bytes.byteLength,
      digest: sha256(bytes),
      bytes_in_output: bytesInOutput,
    });
  }
  const contributing = inputs.filter((record) => record.bytes_in_output > 0).map((record) => record.key).sort(ordinal);
  return { bundleInputs: inputs, contributing };
}

async function createControlRecords(repositoryRoot, bundleInputs) {
  const bundled = new Set(bundleInputs.filter((record) => record.origin.kind === "repository").map((record) => record.origin.path));
  const candidates = new Set([
    ...REQUIRED_CONTROLS,
    ...(await collectDeclaredPaths(repositoryRoot)),
    ...(await collectLegalSourcePaths(repositoryRoot)),
  ]);
  const records = [];
  for (const path of [...candidates].sort(ordinal)) {
    if (bundled.has(path)) continue;
    records.push(await fileRecord(repositoryRoot, path));
  }
  return records;
}

async function createRuntimeAssetRecords(repositoryRoot) {
  return Promise.all((await collectRuntimeAssetPaths(repositoryRoot)).map((path) => fileRecord(repositoryRoot, path)));
}

async function copyLegal(repositoryRoot, files) {
  files.set("legal/THIRD_PARTY_NOTICES.md", await readRegularFile(repositoryRoot, "THIRD_PARTY_NOTICES.md"));
  const upstreamRoot = resolve(repositoryRoot, "release/legal/upstream");
  try {
    for (const path of await walkRegularFiles(upstreamRoot)) {
      files.set(`legal/upstream/${path}`, await readRegularFile(upstreamRoot, path));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function materializeFiles(stageRoot, files) {
  for (const [path, bytes] of [...files].sort(([a], [b]) => ordinal(a, b))) {
    assertPortablePath(path);
    const target = resolve(stageRoot, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "wx");
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }
}

async function pathKind(path) {
  try {
    const info = await lstat(path);
    invariant(!info.isSymbolicLink(), `release transaction path is a symlink: ${path}`);
    return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function removeTransactionPath(path, expectedKind) {
  const kind = await pathKind(path);
  if (kind === "missing") return;
  invariant(kind === expectedKind, `release transaction path has unexpected kind: ${path}`);
  await rm(path, expectedKind === "directory" ? { recursive: true } : undefined);
}

export async function recoverTrackedRelease(repositoryRoot) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  const tracked = resolve(repository, "dist");
  const marker = resolve(repository, DIST_TRANSACTION.marker);
  const markerTemporary = resolve(repository, DIST_TRANSACTION.markerTemporary);
  const promotion = resolve(repository, DIST_TRANSACTION.promotion);
  const backup = resolve(repository, DIST_TRANSACTION.backup);
  const markerKind = await pathKind(marker);
  if (markerKind === "missing") {
    invariant(await pathKind(backup) === "missing", "orphan tracked-release backup requires manual recovery");
    await removeTransactionPath(promotion, "directory");
    await removeTransactionPath(markerTemporary, "file");
    await syncDirectory(repository);
    return;
  }
  invariant(markerKind === "file", "tracked-release transaction marker must be a regular file");
  const transaction = parseCanonicalDocument(await readFile(marker), "tracked-release transaction marker").value;
  invariant(
    transaction.schema_version === "1"
      && typeof transaction.had_dist === "boolean"
      && /^[0-9a-f]{64}$/.test(transaction.candidate_manifest_digest)
      && Object.keys(transaction).sort(ordinal).join(",") === "candidate_manifest_digest,had_dist,schema_version",
    "tracked-release transaction marker is invalid",
  );
  const trackedKind = await pathKind(tracked);
  const backupKind = await pathKind(backup);
  const promotionKind = await pathKind(promotion);
  invariant(["missing", "directory"].includes(trackedKind), "tracked dist has an unsafe kind");
  invariant(["missing", "directory"].includes(backupKind), "tracked-release backup has an unsafe kind");
  invariant(["missing", "directory"].includes(promotionKind), "tracked-release promotion has an unsafe kind");

  if (transaction.had_dist && trackedKind === "missing") {
    invariant(backupKind === "directory", "tracked dist and recoverable backup are both absent");
    await rename(backup, tracked);
  } else if (transaction.had_dist && backupKind === "directory") {
    await removeTransactionPath(backup, "directory");
  }
  await removeTransactionPath(promotion, "directory");
  await removeTransactionPath(markerTemporary, "file");
  await removeTransactionPath(marker, "file");
  await syncDirectory(repository);
}

async function writeTransactionMarker(repository, value) {
  const temporary = resolve(repository, DIST_TRANSACTION.markerTemporary);
  const marker = resolve(repository, DIST_TRANSACTION.marker);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(canonicalJsonBytes(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, marker);
  await syncDirectory(repository);
}

function injectReleaseFault(step) {
  if (process.env.ARCHFLOW_RELEASE_FAULT_AFTER !== step) return;
  const error = new Error(`injected tracked-release crash after ${step}`);
  error.releaseCrash = true;
  throw error;
}

export async function buildReleasePayload({ repositoryRoot, stageRoot }) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  await recoverTrackedRelease(repository);
  const stage = await prepareEmptyRoot(stageRoot, "stage root", [["repository root", repository]]);
  const result = await build({
    absWorkingDir: repository,
    entryPoints: Object.fromEntries(RELEASE_BUILD_PROFILE.entries.map((entry) => [entry.output.replace(/\.mjs$/u, ""), entry.entryPoint])),
    outdir: ".",
    outExtension: { ".js": ".mjs" },
    write: false,
    metafile: true,
    bundle: true,
    platform: RELEASE_BUILD_PROFILE.platform,
    loader: RELEASE_BUILD_PROFILE.loader,
    format: RELEASE_BUILD_PROFILE.format,
    target: RELEASE_BUILD_PROFILE.target,
    splitting: RELEASE_BUILD_PROFILE.splitting,
    minify: RELEASE_BUILD_PROFILE.minify,
    sourcemap: RELEASE_BUILD_PROFILE.sourcemap,
    legalComments: RELEASE_BUILD_PROFILE.legalComments,
    plugins: [],
    banner: { js: RELEASE_BUILD_PROFILE.banner },
    tsconfigRaw: RELEASE_BUILD_PROFILE.tsconfigRaw,
  });
  invariant(result.outputFiles.length === RELEASE_BUILD_PROFILE.entries.length, "release build emitted an unexpected file count");
  const outputFiles = new Map(result.outputFiles.map((file) => [basename(file.path), file.contents]));
  const entryProvenance = [];
  for (const entry of RELEASE_BUILD_PROFILE.entries) {
    const output = outputFiles.get(entry.output);
    const outputMeta = resolveMetafileOutput(result.metafile, entry.output);
    invariant(output && outputMeta?.entryPoint === entry.entryPoint, `release output has an unstable logical path: ${entry.id}`);
    entryProvenance.push({
      id: entry.id,
      entry_point: entry.entryPoint,
      output_path: entry.output,
      output_digest: sha256(output),
      contributing_inputs: Object.entries(outputMeta.inputs).filter(([, record]) => record.bytesInOutput > 0).map(([path]) => path).sort(ordinal),
      allowed_imports: deriveExternalImports(outputMeta),
    });
  }

  const { bundleInputs, contributing } = await buildRecords(repository, result.metafile);
  const controls = await createControlRecords(repository, bundleInputs);
  const runtimeAssets = await createRuntimeAssetRecords(repository);
  const dependencyInputs = await collectDependencyProvenance(repository, contributing);
  const dependencyInventoryDigest = sha256(canonicalJsonBytes({
    bundle_inputs: bundleInputs.filter((record) => record.origin.kind === "dependency"),
    dependency_provenance_inputs: dependencyInputs,
  }));
  const metafileBytes = canonicalJsonBytes(normalizedMetafile(result.metafile));
  const files = new Map([...outputFiles, ["metafile.json", metafileBytes]]);
  await copyLegal(repository, files);
  const artifactRole = (path) => path.endsWith(".mjs") ? "executable"
    : path === "metafile.json" ? "metafile"
    : path === "legal/THIRD_PARTY_NOTICES.md" ? "legal-notice"
    : "upstream-legal";
  const artifacts = [...files].map(([path, bytes]) => ({ path, role: artifactRole(path), size: bytes.byteLength, digest: sha256(bytes) }))
    .sort((a, b) => ordinal(a.path, b.path));
  artifacts.push({ path: "manifest.json", role: "manifest" });
  artifacts.sort((a, b) => ordinal(a.path, b.path));
  const declaredPaths = await collectDeclaredPaths(repository);
  const manifestValue = {
    schema_version: "1",
    bundle_digest: entryProvenance.find((entry) => entry.id === "local-cli").output_digest,
    dependency_inventory_digest: dependencyInventoryDigest,
    bundle_inputs: bundleInputs,
    contributing_inputs: contributing,
    release_control_inputs: controls,
    runtime_assets: runtimeAssets,
    dependency_provenance_inputs: dependencyInputs,
    declared_content: {
      schemas: declaredPaths.filter((path) => path.startsWith("src/contracts/schemas/v1/")),
      constitution: declaredPaths.filter((path) => path.startsWith("assets/constitution/")),
    },
    proof_inputs: [...PROOF_INPUTS],
    build_entries: buildEntries(),
    entry_provenance: entryProvenance,
    artifacts,
  };
  const manifest = canonicalDocument(manifestValue);
  files.set("manifest.json", manifest.bytes);
  await materializeFiles(stage, files);
  const stageDocuments = await readPayloadDocuments(stage);
  const validated = await validateReleaseSemantics({ repositoryRoot: repository, payloadRoot: stage, ...stageDocuments });
  return validated.summary;
}

export async function checkReleasePayload({ repositoryRoot, payloadRoot, comparisonRoot }) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  await recoverTrackedRelease(repository);
  const payload = await canonicalExistingDirectory(payloadRoot, "payload root");
  const stage = await validateReleaseSemantics({ repositoryRoot: repository, payloadRoot: payload, ...(await readPayloadDocuments(payload)) });
  if (comparisonRoot === undefined) return stage.summary;
  const comparison = await canonicalExistingDirectory(comparisonRoot, "comparison root");
  invariant(comparison !== payload && !isInside(comparison, payload) && !isInside(payload, comparison), "payload roots overlap");
  const reproduced = await validateReleaseSemantics({ repositoryRoot: repository, payloadRoot: comparison, ...(await readPayloadDocuments(comparison)) });
  const comparedFiles = await comparePayloads(stage.summary, reproduced.summary);
  return reproductionProof(stage.summary, reproduced.summary, comparedFiles);
}

async function comparePayloads(candidate, reproduced) {
  const left = new Map(candidate.files.map((record) => [record.path, record]));
  const right = new Map(reproduced.files.map((record) => [record.path, record]));
  invariant(left.size === right.size, "release payload file counts differ");
  const compared = [...left.keys()].sort(ordinal);
  for (const path of compared) {
    const a = left.get(path);
    const b = right.get(path);
    invariant(b && a.size === b.size && a.digest === b.digest, `release payload differs: ${path}`);
  }
  return Object.freeze(compared);
}

function reproductionProof(candidate, reproduced, comparedFiles) {
  const proofInputsDigest = sha256(canonicalJsonBytes(candidate.manifest.value.proof_inputs));
  return Object.freeze({ candidate, reproduced, comparedFiles, proofInputsDigest });
}

export async function materializeReleaseSourceRoot({ repositoryRoot, stage, materializationRoot }) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  invariant(stage?.summary?.manifest?.value, "a validated release stage is required");
  const root = await prepareEmptyRoot(materializationRoot, "materialization root", [
    ["repository root", repository],
    ["candidate stage", stage.stageRoot],
  ]);
  const controls = stage.summary.manifest.value.release_control_inputs;
  const repositoryInputs = stage.summary.manifest.value.bundle_inputs
    .filter((record) => record.origin.kind === "repository")
    .map((record) => ({ path: record.origin.path, size: record.size, digest: record.digest }));
  const allowlist = [...repositoryInputs, ...controls];
  invariant(!allowlist.some((record) => record.path.startsWith("node_modules/")), "materialization cannot copy node_modules");
  for (const record of allowlist) {
    const bytes = await readRegularFile(repository, record.path);
    invariant(bytes.byteLength === record.size && sha256(bytes) === record.digest, `stale materialization input: ${record.path}`);
    const target = resolve(root, ...record.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "wx");
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  }
}

export async function reproduceReleasePayload({ repositoryRoot, stage, materializationRoot, comparisonRoot }) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  invariant(stage?.stageRoot && stage?.summary, "a validated release stage is required");
  const candidate = await canonicalExistingDirectory(stage.stageRoot, "candidate stage root");
  const materializationCandidate = await canonicalDedicatedRootCandidate(materializationRoot, "materialization root");
  const comparisonCandidate = await canonicalDedicatedRootCandidate(comparisonRoot, "comparison root");
  assertRootsPairwiseNonOverlapping([
    ["repository root", repository],
    ["candidate stage root", candidate],
    ["materialization root", materializationCandidate],
    ["comparison root", comparisonCandidate],
  ]);
  await materializeReleaseSourceRoot({ repositoryRoot: repository, stage, materializationRoot });
  const materialization = await canonicalExistingDirectory(materializationRoot, "materialization root");
  await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: materialization,
    env: { PATH: process.env.PATH, HOME: resolve(materialization, ".home"), npm_config_cache: resolve(materialization, ".npm-cache") },
    maxBuffer: 16 * 1024 * 1024,
  });
  await verifyDependencyRecords(materialization, stage.summary.manifest.value.dependency_provenance_inputs);
  const reproduced = await buildReleasePayload({ repositoryRoot: materialization, stageRoot: comparisonCandidate });
  const refreshed = await validateReleaseSemantics({
    repositoryRoot: repository,
    payloadRoot: candidate,
    ...(await readPayloadDocuments(candidate)),
  });
  await comparePayloads(stage.summary, refreshed.summary);
  const comparedFiles = await comparePayloads(refreshed.summary, reproduced);
  return reproductionProof(refreshed.summary, reproduced, comparedFiles);
}

export async function reproduceCurrentRelease({ repositoryRoot }) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  const workRoot = await mkdtemp(resolve(tmpdir(), "archflow-release-reproduce-"));
  try {
    const candidateRoot = resolve(workRoot, "candidate");
    await buildReleasePayload({ repositoryRoot: repository, stageRoot: candidateRoot });
    const candidate = await validateReleaseSemantics({
      repositoryRoot: repository,
      payloadRoot: candidateRoot,
      ...(await readPayloadDocuments(candidateRoot)),
    });
    return await reproduceReleasePayload({
      repositoryRoot: repository,
      stage: candidate,
      materializationRoot: resolve(workRoot, "source"),
      comparisonRoot: resolve(workRoot, "comparison"),
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export async function writeTrackedReleasePayload({ repositoryRoot, candidateStageRoot }) {
  const repository = await canonicalExistingDirectory(repositoryRoot, "repository root");
  await recoverTrackedRelease(repository);
  const candidateRoot = await canonicalExistingDirectory(candidateStageRoot, "candidate stage root");
  invariant(
    candidateRoot !== repository
      && !isInside(repository, candidateRoot)
      && !isInside(candidateRoot, repository),
    "candidate stage root must be outside the repository",
  );
  const candidate = await validateReleaseSemantics({ repositoryRoot: repository, payloadRoot: candidateRoot, ...(await readPayloadDocuments(candidateRoot)) });
  const workRoot = await mkdtemp(resolve(tmpdir(), "archflow-release-write-"));
  try {
    const proof = await reproduceReleasePayload({
      repositoryRoot: repository,
      stage: candidate,
      materializationRoot: resolve(workRoot, "source"),
      comparisonRoot: resolve(workRoot, "comparison"),
    });
    const tracked = resolve(repository, "dist");
    await assertNoSymlinkTraversal(dirname(tracked));
    const promotion = resolve(repository, DIST_TRANSACTION.promotion);
    const backup = resolve(repository, DIST_TRANSACTION.backup);
    let trackedExists = false;
    try {
      await assertNoSymlinkTraversal(tracked);
      const trackedInfo = await lstat(tracked);
      invariant(trackedInfo.isDirectory(), "tracked dist target must be a regular directory");
      await walkRegularFiles(tracked);
      trackedExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const transient of [promotion, backup, resolve(repository, DIST_TRANSACTION.marker), resolve(repository, DIST_TRANSACTION.markerTemporary)]) {
      try { await access(transient); throw new Error(`release promotion target already exists: ${transient}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await mkdir(promotion);
    try {
      const candidateFiles = new Map(candidate.summary.files.map((file) => [file.path, file]));
      for (const path of proof.comparedFiles) {
        const source = resolve(candidateRoot, ...path.split("/"));
        const target = resolve(promotion, ...path.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { errorOnExist: true, force: false, preserveTimestamps: false });
        const copied = await readFile(target);
        const expected = candidateFiles.get(path);
        invariant(
          expected && copied.byteLength === expected.size && sha256(copied) === expected.digest,
          `promotion copy differs from validated candidate: ${path}`,
        );
      }
      assertEqualPathSet(await walkRegularFiles(promotion), proof.comparedFiles, "promotion closure");
      await writeTransactionMarker(repository, {
        schema_version: "1",
        had_dist: trackedExists,
        candidate_manifest_digest: candidate.summary.manifest.digest,
      });
      injectReleaseFault("marker-written");
      if (trackedExists) {
        await rename(tracked, backup);
        await syncDirectory(repository);
        injectReleaseFault("backup-renamed");
      }
      await rename(promotion, tracked);
      await syncDirectory(repository);
      injectReleaseFault("promotion-renamed");
    } catch (error) {
      if (!error.releaseCrash) await recoverTrackedRelease(repository);
      throw error;
    }
    await recoverTrackedRelease(repository);
    return proof;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export function jsonSummary(value) {
  if (value?.manifest?.bytes) {
    return {
      payload_root: value.payloadRoot,
      files: value.files,
      bundle_digest: value.bundleDigest,
      dependency_inventory_digest: value.dependencyInventoryDigest,
      manifest_digest: value.manifest.digest,
    };
  }
  if (value?.candidate && value?.reproduced) {
    return {
      candidate: jsonSummary(value.candidate),
      reproduced: jsonSummary(value.reproduced),
      compared_files: value.comparedFiles,
      proof_inputs_digest: value.proofInputsDigest,
    };
  }
  return value;
}

export function writeCanonicalSummary(value) {
  process.stdout.write(canonicalJsonBytes(jsonSummary(value)));
}

export function runCli(main) {
  Promise.resolve().then(main).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.usage ? 2 : 1;
  });
}

export function parseCli(arguments_, specification) {
  const usageError = () => {
    const error = new Error(`usage: ${specification.usage}`);
    error.usage = true;
    return error;
  };
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!Object.hasOwn(specification, flag) || value === undefined || value.startsWith("--")) {
      throw usageError();
    }
    if (parsed[specification[flag]] !== undefined) throw usageError();
    parsed[specification[flag]] = resolve(value);
  }
  for (const field of specification.required) {
    if (!parsed[field]) {
      throw usageError();
    }
  }
  return parsed;
}
