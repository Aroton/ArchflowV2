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
import { LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast";

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
  "archflow-mcp.mjs",
  "legal/THIRD_PARTY_NOTICES.md",
  "legal/review.json",
  "manifest.json",
  "metafile.json",
]);

export const RELEASE_BUILD_PROFILE = Object.freeze({
  entry: "src/main.ts",
  output: "archflow-mcp.mjs",
  platform: "node",
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
  allowedImports: Object.freeze([
    "node:buffer",
    "node:crypto",
    "node:module",
    "node:process",
    "node:util",
  ]),
});

const PROOF_INPUTS = Object.freeze([
  ".github/workflows/ci.yml",
  "package.json",
  "scripts/smoke-release-bundle.mjs",
  "scripts/test-release-integrity.mjs",
  "test/fixtures/mcp/runtime/adversarial-bytes.json",
  "test/fixtures/mcp/runtime/calls.json",
  "test/fixtures/mcp/runtime/initialize.json",
  "test/fixtures/release/hostile-runtime-guard.cjs",
  "test/integration/mcp-stdio.test.ts",
  "test/integration/release-offline.test.ts",
]);
const LAUNCH_FIXTURES = Object.freeze([
  "test/fixtures/mcp/runtime/adversarial-bytes.json",
  "test/fixtures/mcp/runtime/calls.json",
  "test/fixtures/mcp/runtime/initialize.json",
]);

const REQUIRED_CONTROLS = Object.freeze([
  ".gitattributes",
  ".github/workflows/ci.yml",
  "package-lock.json",
  "package.json",
  "scripts/build-release.mjs",
  "scripts/check-release.mjs",
  "scripts/release-support.mjs",
  "scripts/reproduce-release.mjs",
  "scripts/smoke-release-bundle.mjs",
  "scripts/test-release-integrity.mjs",
  "scripts/write-tracked-release.mjs",
  "src/contracts/schemas/v1/release-legal-review.schema.json",
  "src/contracts/schemas/v1/release-manifest.schema.json",
  "src/contracts/versions.ts",
  "test/contracts/release-contracts.test.ts",
  "test/contracts/schema-registry.test.ts",
  "test/fixtures/mcp/runtime/adversarial-bytes.json",
  "test/fixtures/mcp/runtime/calls.json",
  "test/fixtures/mcp/runtime/initialize.json",
  "test/fixtures/release/hostile-runtime-guard.cjs",
  "test/integration/mcp-stdio.test.ts",
  "test/integration/release-offline.test.ts",
]);

const DECLARED_ASSETS = Object.freeze([
  "assets/constitution/00-process.md",
  "assets/constitution/10-architecture.md",
  "assets/constitution/20-data.md",
  "assets/constitution/30-product.md",
  "assets/constitution/README.md",
  "assets/workflow.yaml",
]);

const KNOWN_EMBEDDED = new Map([
  ["ajv", "8.18.0"],
  ["ajv-formats", "3.0.1"],
  ["content-type", "1.0.5"],
  ["fast-deep-equal", "3.1.3"],
  ["fast-uri", "3.1.0"],
  ["json-schema-traverse", "1.0.0"],
]);
const KNOWN_EMBEDDED_IDENTITIES = new Map([
  ["ajv@8.18.0", ["https://registry.npmjs.org/ajv/-/ajv-8.18.0.tgz", "sha512-PlXPeEWMXMZ7sPYOHqmDyCJzcfNrUr3fGNKtezX14ykXOEIvyK81d+qydx89KY5O71FKMPaQ2vBfBFI5NHR63A==", "a05350a88e318e4f5f2c2a1ff1e2e88daa4dd38e6e78b71cccae422bdc762cc3"]],
  ["ajv-formats@3.0.1", ["https://registry.npmjs.org/ajv-formats/-/ajv-formats-3.0.1.tgz", "sha512-8iUql50EUR+uUcdRQ3HDqa6EVyo3docL8g5WJ3FNcWmu62IbkGUue/pEyLBW8VGKKucTPgqeks4fIU1DA4yowQ==", "9df3bb69929a3b650ed73b3bfa1756725aaff0ac296461605753547004eafeaf"]],
  ["content-type@1.0.5", ["https://registry.npmjs.org/content-type/-/content-type-1.0.5.tgz", "sha512-nTjqfcBFEipKdXCv4YDQWCfmcLZKm81ldF0pAopTvyrFGVbcR6P/VAAd5G7N+0tTr8QqiU0tFadD6FK4NtJwOA==", "257aed98914108e91a337912727b6a802eef218248507f74b76faffaff517a38"]],
  ["fast-deep-equal@3.1.3", ["https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz", "sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==", "7bf9b2de73a6b356761c948d0e9eeb4be6c1270bd04c79cd489c1e400ffdfc1a"]],
  ["fast-uri@3.1.0", ["https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.0.tgz", "sha512-iPeeDKJSWf4IEOasVVrknXpaBV0IApz/gp7S2bb7Z4Lljbl2MGJRqInZiUrQwV16cpzw/D3S5j5Julj/gT52AA==", "185ef4f377743572c2bf0931f741fae52401268cbe70c880b74063799814083e"]],
  ["json-schema-traverse@1.0.0", ["https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz", "sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==", "7bf9b2de73a6b356761c948d0e9eeb4be6c1270bd04c79cd489c1e400ffdfc1a"]],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertReleaseLoaderPolicy(source) {
  invariant(typeof source === "string", "release loader policy requires JavaScript source");
  invariant(source.startsWith(RELEASE_BUILD_PROFILE.banner), "release bundle is missing the exact createRequire banner");
  const remainder = source.slice(RELEASE_BUILD_PROFILE.banner.length);
  const scanner = createScanner(true, LanguageVariant.Standard, remainder);
  const forbidden = [];
  let previous = SyntaxKind.Unknown;
  let previousText = "";
  let previousEnd = -1;
  const templateBraces = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token === SyntaxKind.SlashToken && (
      previous === SyntaxKind.Unknown
      || ["=", "(", "[", "{", ",", ":", ";", "return", "=>", "case", "throw", "else", "do", "typeof", "void", "delete", "in", "of", "!", "&&", "||", "??", "?"].includes(previousText)
    )) token = scanner.reScanSlashToken();
    const tokenEnd = scanner.getTokenEnd();
    invariant(tokenEnd > previousEnd, `release loader scanner made no progress at byte ${scanner.getTokenStart()}`);
    previousEnd = tokenEnd;
    const text = scanner.getTokenText();
    if (token === SyntaxKind.OpenParenToken && previous === SyntaxKind.ImportKeyword) forbidden.push("dynamic import");
    if (text === "require" || text.startsWith("__require") || text === "createRequire" || text === "getBuiltinModule") {
      forbidden.push(text);
    }
    if (token === SyntaxKind.TemplateHead) templateBraces.push(0);
    else if (templateBraces.length > 0 && token === SyntaxKind.OpenBraceToken) {
      templateBraces[templateBraces.length - 1] += 1;
    } else if (templateBraces.length > 0 && token === SyntaxKind.CloseBraceToken) {
      const index = templateBraces.length - 1;
      if (templateBraces[index] > 0) templateBraces[index] -= 1;
      else {
        const templateToken = scanner.reScanTemplateToken(false);
        invariant(scanner.getTokenEnd() > previousEnd, `release loader template scanner made no progress at byte ${scanner.getTokenStart()}`);
        previousEnd = scanner.getTokenEnd();
        if (templateToken === SyntaxKind.TemplateTail) templateBraces.pop();
        previous = templateToken;
        previousText = scanner.getTokenText();
        continue;
      }
    }
    previous = token;
    previousText = text;
  }
  invariant(forbidden.length === 0, `residual runtime loader is forbidden: ${[...new Set(forbidden)].join(", ")}`);
}

function ordinal(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(ordinal)
        .map((key) => [key, sortCanonical(value[key])]),
    );
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

async function collectDeclaredPaths(repositoryRoot) {
  const schemas = (await readdir(resolve(repositoryRoot, "src/contracts/schemas/v1")))
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => `src/contracts/schemas/v1/${name}`);
  return [...schemas, ...DECLARED_ASSETS].sort(ordinal);
}

async function collectLegalSourcePaths(repositoryRoot) {
  const paths = ["release/legal-review.json"];
  const root = resolve(repositoryRoot, "release/legal/upstream");
  try {
    for (const path of await walkRegularFiles(root)) paths.push(`release/legal/upstream/${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return paths;
}

async function collectEvidencePaths(repositoryRoot) {
  const root = resolve(repositoryRoot, "release/evidence");
  try {
    return (await walkRegularFiles(root)).map((path) => `release/evidence/${path}`).sort(ordinal);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function deriveLaunchProfile(repositoryRoot) {
  return {
    node_major: 24,
    executable: "process.execPath",
    argv: ["--require", "hostile-runtime-guard.cjs", "archflow-mcp.mjs"],
    environment_keys: ["HOME", "LANG", "LC_ALL", "NPM_CONFIG_CACHE", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"],
    removed_environment_keys: ["NODE_OPTIONS", "NODE_PATH"],
    cwd_class: "copied-payload",
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe", guard_fd: 3 },
    guard_path: "test/fixtures/release/hostile-runtime-guard.cjs",
    canary_paths: ["ambient/node_modules/archflow-release-canary/index.js", "repository-canary/SECRET"],
    fixture_digests: await Promise.all(LAUNCH_FIXTURES.map(async (path) => ({
      path,
      digest: sha256(await readRegularFile(repositoryRoot, path)),
    }))),
    allowed_imports: [...RELEASE_BUILD_PROFILE.allowedImports],
  };
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

async function collectDependencyProvenance(repositoryRoot, metafile, contributing) {
  const records = new Map();
  const embedded = new Map();
  const expectations = [];
  const packageNames = new Set();
  for (const path of contributing) {
    const identity = packageIdentity(path);
    if (!identity) continue;
    packageNames.add(identity.packageName);
    if (!path.endsWith(".mjs")) continue;
    const mapPath = `${path}.map`;
    let mapBytes;
    try {
      mapBytes = await readRegularFile(repositoryRoot, mapPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        invariant(
          path === "node_modules/@modelcontextprotocol/server/dist/chunk-Br0eD_fh.mjs",
          `missing adjacent source map has no reviewed expected-absent disposition: ${path}`,
        );
        expectations.push({
          input_key: path,
          expectation: "expected-absent",
          rationale: "The reviewed SDK bridge chunk has no published adjacent source map in @modelcontextprotocol/server@2.0.0.",
        });
        continue;
      }
      throw error;
    }
    const mapIdentity = packageIdentity(mapPath);
    const version = await readPackageVersion(repositoryRoot, mapIdentity.packageName);
    records.set(`${mapIdentity.packageName}:${mapIdentity.packagePath}`, {
      package_name: mapIdentity.packageName,
      package_version: version,
      package_relative_path: mapIdentity.packagePath,
      size: mapBytes.byteLength,
      digest: sha256(mapBytes),
          purpose: "source-map",
    });
    const sourceMap = JSON.parse(decoder.decode(mapBytes));
    const reviewedRoots = new Set();
    const recognizedComponents = new Set();
    for (const source of sourceMap.sources ?? []) {
      const match = source.match(/\.pnpm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
      if (match) {
        const name = match[3];
        const versionWithoutPeer = match[2].split("_")[0];
        invariant(KNOWN_EMBEDDED.get(name) === versionWithoutPeer, `unknown mapped component: ${name}@${versionWithoutPeer}`);
        embedded.set(name, versionWithoutPeer);
        recognizedComponents.add(`${name}@${versionWithoutPeer}`);
        continue;
      }
      const firstParty = source.match(/^((?:\.\.\/)+(?:core-internal\/)?src)\//);
      invariant(firstParty, `unreviewed source-map source path: ${source}`);
      reviewedRoots.add(firstParty[1]);
    }
    expectations.push({
      input_key: path,
      expectation: "present",
      map: {
        package_name: mapIdentity.packageName,
        package_version: version,
        package_relative_path: mapIdentity.packagePath,
        digest: sha256(mapBytes),
      },
      reviewed_first_party_roots: [...reviewedRoots].sort(ordinal),
      recognized_third_party_components: [...recognizedComponents].sort(ordinal),
    });
  }
  for (const [name, version] of KNOWN_EMBEDDED) {
    invariant(embedded.get(name) === version, `missing mapped component: ${name}@${version}`);
  }
  for (const packageName of packageNames) {
    const packageRoot = `node_modules/${packageName}`;
    const version = await readPackageVersion(repositoryRoot, packageName);
    for (const packagePath of ["package.json", "LICENSE", "NOTICE"]) {
      try {
        const bytes = await readRegularFile(repositoryRoot, `${packageRoot}/${packagePath}`);
        records.set(`${packageName}:${packagePath}`, {
          package_name: packageName,
          package_version: version,
          package_relative_path: packagePath,
          size: bytes.byteLength,
          digest: sha256(bytes),
          purpose: packagePath === "package.json" ? "package-manifest" : packagePath === "NOTICE" ? "notice" : "license",
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return {
    records: [...records.values()].sort((a, b) =>
      ordinal(`${a.package_name}/${a.package_relative_path}`, `${b.package_name}/${b.package_relative_path}`),
    ),
    expectations: expectations.sort((a, b) => ordinal(a.input_key, b.input_key)),
    embedded,
  };
}

function legalProjection(review) {
  const components = review.current_components ?? [];
  const lines = [
    "# Third-Party Notices",
    "",
    "This generated inventory accompanies the offline ArchFlow MCP payload.",
    "It does not grant a license to ArchFlow itself.",
    "",
  ];
  for (const component of components) {
    const name = component.package_name;
    const version = component.package_version;
    const license = component.license_expression;
    lines.push(`- ${name}@${version} — ${license}`);
  }
  lines.push("", "See legal/upstream/ for retained applicable upstream license and notice texts.", "");
  return encoder.encode(lines.join("\n"));
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
  const legalSchema = JSON.parse(await readFile(resolve(schemaDirectory, "release-legal-review.schema.json"), "utf8"));
  ajv.addSchema(manifestSchema);
  ajv.addSchema(legalSchema);
  return {
    manifest: ajv.getSchema(manifestSchema.$id) ?? ajv.compile(manifestSchema),
    legal: ajv.getSchema(legalSchema.$id) ?? ajv.compile(legalSchema),
    evidence: {
      "advisory-snapshot": ajv.getSchema(`${legalSchema.$id}#/$defs/advisory_snapshot_record`),
      "patched-artifact-availability": ajv.getSchema(`${legalSchema.$id}#/$defs/artifact_availability_record`),
      "focused-inert-reachability": ajv.getSchema(`${legalSchema.$id}#/$defs/reachability_record`),
      "user-risk-acceptance": ajv.getSchema(`${legalSchema.$id}#/$defs/user_acceptance_record`),
    },
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

async function validateLegalCorrelation(repositoryRoot, manifestValue, legalValue, ownerPaths, validators) {
  invariant(legalValue.project_license_status === "missing" && legalValue.distribution_status === "unresolved", "release must retain unresolved project licensing status");
  const limitationText = legalValue.limitations.join("\n").toLowerCase();
  invariant(limitationText.includes("exact") && limitationText.includes("ajv") && limitationText.includes("json"), "legal limitations must retain attribution and empty-AJV-JSON limitations");

  const componentIds = legalValue.current_components.map((component) => component.component_id);
  assertSortedUnique(componentIds, "current components");
  assertSortedUnique(legalValue.limitations, "legal limitations");
  const decisionIds = legalValue.dependency_gate_decisions.map((decision) => decision.id);
  assertSortedUnique(decisionIds, "dependency gate decisions");
  const amendmentIds = legalValue.amendments.map((amendment) => amendment.id);
  assertSortedUnique(amendmentIds, "decision amendments");
  const supersessionIds = legalValue.supersessions.map((supersession) => supersession.id);
  assertSortedUnique(supersessionIds, "decision supersessions");
  const decisionsById = new Map(legalValue.dependency_gate_decisions.map((decision) => [decision.id, decision]));
  for (const amendment of legalValue.amendments) {
    invariant(decisionIds.includes(amendment.decision_id), `amendment references an unknown decision: ${amendment.id}`);
    invariant(decisionsById.get(amendment.decision_id).decision_digest === amendment.prior_decision_digest, `amendment prior decision digest differs: ${amendment.id}`);
  }
  for (const supersession of legalValue.supersessions) {
    invariant(decisionIds.includes(supersession.superseded_decision_id), `supersession references an unknown prior decision: ${supersession.id}`);
    invariant(decisionIds.includes(supersession.replacement_decision_id), `supersession references an unknown replacement: ${supersession.id}`);
    invariant(supersession.superseded_decision_id !== supersession.replacement_decision_id, `supersession is self-referential: ${supersession.id}`);
    invariant(decisionsById.get(supersession.superseded_decision_id).decision_digest === supersession.superseded_decision_digest, `superseded decision digest differs: ${supersession.id}`);
    invariant(decisionsById.get(supersession.replacement_decision_id).decision_digest === supersession.replacement_decision_digest, `replacement decision digest differs: ${supersession.id}`);
  }
  const replacementByPrior = new Map();
  for (const supersession of legalValue.supersessions) {
    invariant(!replacementByPrior.has(supersession.superseded_decision_id), `conflicting supersessions for: ${supersession.superseded_decision_id}`);
    replacementByPrior.set(supersession.superseded_decision_id, supersession.replacement_decision_id);
  }
  for (const start of replacementByPrior.keys()) {
    const visited = new Set();
    let cursor = start;
    while (replacementByPrior.has(cursor)) {
      invariant(!visited.has(cursor), `cyclic supersession graph at: ${cursor}`);
      visited.add(cursor);
      cursor = replacementByPrior.get(cursor);
    }
  }

  const provenance = new Set(manifestValue.dependency_provenance_inputs.map((record) =>
    `${record.package_name}@${record.package_version}/${record.package_relative_path}`,
  ));
  const embedded = new Map();
  for (const component of legalValue.current_components) {
    if (component.provenance_kind === "embedded") embedded.set(component.package_name, component.package_version);
    for (const reference of component.provenance_inputs) {
      invariant(
        provenance.has(`${reference.package_name}@${reference.package_version}/${reference.package_relative_path}`),
        `component has unresolved provenance: ${component.component_id}`,
      );
    }
  }
  for (const [name, version] of KNOWN_EMBEDDED) invariant(embedded.get(name) === version, `legal inventory omits embedded ${name}@${version}`);

  const installedKeys = [...new Set(manifestValue.bundle_inputs
    .filter((record) => record.origin.kind === "dependency" && record.bytes_in_output > 0)
    .map((record) => `${record.origin.package_name}@${record.origin.package_version}`))].sort(ordinal);
  const mappedKeys = [...new Set(manifestValue.adjacent_map_expectations.flatMap((expectation) =>
    expectation.expectation === "present" ? expectation.recognized_third_party_components : [],
  ))].sort(ordinal);
  const actualInstalled = legalValue.current_components.filter((component) => component.provenance_kind === "installed")
    .map((component) => `${component.package_name}@${component.package_version}`).sort(ordinal);
  const actualEmbedded = legalValue.current_components.filter((component) => component.provenance_kind === "embedded")
    .map((component) => `${component.package_name}@${component.package_version}`).sort(ordinal);
  invariant(isDeepStrictEqual(actualInstalled, installedKeys), "installed legal component closure differs from contributing packages");
  invariant(isDeepStrictEqual(actualEmbedded, mappedKeys), "embedded legal component closure differs from mapped packages");

  const lock = JSON.parse(await readFile(resolve(repositoryRoot, "package-lock.json"), "utf8"));
  const upstreamByComponent = new Map(legalValue.upstream_legal_sources.map((source) => [source.component_id, source]));
  for (const component of legalValue.current_components) {
    const key = `${component.package_name}@${component.package_version}`;
    const upstream = upstreamByComponent.get(component.component_id);
    invariant(upstream && isDeepStrictEqual(component.legal_source, {
      source_path: upstream.source_path,
      payload_path: upstream.payload_path,
      digest: upstream.digest,
    }), `component legal source is not the unique retained source: ${component.component_id}`);
    invariant(isDeepStrictEqual(component.package_identity, upstream.package_identity), `component/upstream package identity differs: ${component.component_id}`);
    let expectedIdentity;
    if (component.provenance_kind === "installed") {
      const locked = lock.packages?.[`node_modules/${component.package_name}`];
      invariant(locked?.version === component.package_version, `installed component is absent from package-lock: ${key}`);
      expectedIdentity = { authority: "package-lock", tarball_url: locked.resolved, integrity: locked.integrity };
      const installedLicense = manifestValue.dependency_provenance_inputs.find((record) =>
        record.package_name === component.package_name
          && record.package_version === component.package_version
          && record.purpose === "license",
      );
      invariant(installedLicense?.digest === component.legal_source.digest, `installed legal source differs from installed package bytes: ${key}`);
    } else {
      const identity = KNOWN_EMBEDDED_IDENTITIES.get(key);
      invariant(identity, `embedded package has no immutable reviewed registry identity: ${key}`);
      expectedIdentity = { authority: "npm-registry-artifact", tarball_url: identity[0], integrity: identity[1] };
      invariant(component.legal_source.digest === identity[2], `embedded legal source differs from reviewed registry artifact bytes: ${key}`);
    }
    invariant(isDeepStrictEqual(component.package_identity, expectedIdentity), `package identity differs from immutable authority: ${key}`);
    const expectedProvenance = component.provenance_kind === "installed"
      ? manifestValue.dependency_provenance_inputs.filter((record) => record.package_name === component.package_name && record.package_version === component.package_version)
        .map(({ package_name, package_version, package_relative_path }) => ({ package_name, package_version, package_relative_path }))
      : manifestValue.adjacent_map_expectations.filter((expectation) => expectation.expectation === "present" && expectation.recognized_third_party_components.includes(key))
        .map((expectation) => ({
          package_name: expectation.map.package_name,
          package_version: expectation.map.package_version,
          package_relative_path: expectation.map.package_relative_path,
        }));
    expectedProvenance.sort((a, b) => ordinal(`${a.package_name}/${a.package_relative_path}`, `${b.package_name}/${b.package_relative_path}`));
    invariant(isDeepStrictEqual(component.provenance_inputs, expectedProvenance), `component provenance is not the exact derived closure: ${component.component_id}`);
    invariant(component.source_map_expected === (component.provenance_kind === "embedded" || expectedProvenance.some((record) => record.package_relative_path.endsWith(".map"))), `component source-map expectation differs: ${component.component_id}`);
  }
  invariant(
    upstreamByComponent.size === legalValue.current_components.length
      && legalValue.upstream_legal_sources.length === legalValue.current_components.length,
    "component-to-upstream legal mapping is not one-to-one",
  );

  const upstreamSourcePaths = [];
  const upstreamPayloadPaths = [];
  for (const source of legalValue.upstream_legal_sources) {
    invariant(componentIds.includes(source.component_id), `upstream legal source references an unknown component: ${source.source_path}`);
    invariant(source.source_path.startsWith("release/legal/upstream/"), "upstream source is outside retained legal root");
    invariant(source.payload_path.startsWith("legal/upstream/"), "upstream payload is outside legal closure");
    invariant(source.payload_path === source.source_path.slice("release/".length), "upstream source/output mapping differs");
    const sourceBytes = await readRegularFile(repositoryRoot, source.source_path);
    invariant(sha256(sourceBytes) === source.digest, `stale upstream legal source: ${source.source_path}`);
    upstreamSourcePaths.push(source.source_path);
    upstreamPayloadPaths.push(source.payload_path);
  }
  const actualUpstream = (await collectLegalSourcePaths(repositoryRoot)).filter((path) => path !== "release/legal-review.json");
  assertEqualPathSet(upstreamSourcePaths, actualUpstream, "upstream legal sources");
  assertSortedUnique(upstreamPayloadPaths, "upstream legal payloads");

  const entryBindings = manifestValue.build_entries.map(({ id, role, handler_authority }) => ({ id, role, handler_authority }));
  const resolveEvidence = async (binding, expectedPath, recordType) => {
    invariant(binding.path === expectedPath, `risk evidence path differs: ${recordType}`);
    invariant(ownerPaths.has(binding.path), `risk evidence is outside release controls: ${binding.path}`);
    const document = parseCanonicalDocument(await readRegularFile(repositoryRoot, binding.path), `risk evidence ${recordType}`);
    invariant(document.digest === binding.digest, `risk evidence digest differs: ${binding.path}`);
    const validator = validators.evidence[recordType];
    invariant(validator, `missing evidence schema validator: ${recordType}`);
    schemaAssert(validator, document.value, `risk evidence ${recordType}`);
    return document.value;
  };
  for (const decision of legalValue.dependency_gate_decisions) {
    invariant(componentIds.some((id) => id.startsWith(`${decision.package_name.replace(/^@/, "").replaceAll("/", "-")}-`) || legalValue.current_components.some((component) => component.package_name === decision.package_name && component.package_version === decision.package_version)), `risk decision references an uninventoried component: ${decision.id}`);
    assertSortedUnique(decision.advisories.map((advisory) => advisory.id), `risk decision advisories: ${decision.id}`);
    invariant(decision.bundle_digest === manifestValue.bundle_digest, `risk decision bundle binding is stale: ${decision.id}`);
    invariant(decision.dependency_inventory_digest === manifestValue.dependency_inventory_digest, `risk decision inventory binding is stale: ${decision.id}`);
    invariant(Buffer.from(canonicalJsonBytes(decision.entry_bindings)).equals(Buffer.from(canonicalJsonBytes(entryBindings))), `risk decision entry binding is stale: ${decision.id}`);
    invariant(decision.scope.handler_authority === "inert-no-handler", `risk decision handler scope expanded: ${decision.id}`);
    const invalidators = ["bundle-change", "dependency-change", "entry-change", "handler-authority-change"];
    invariant(JSON.stringify(decision.scope.invalidated_by) === JSON.stringify(invalidators), `risk decision invalidators are incomplete: ${decision.id}`);
    const withoutDigest = { ...decision };
    delete withoutDigest.decision_digest;
    invariant(decision.decision_digest === sha256(canonicalJsonBytes(withoutDigest)), `risk decision digest is stale: ${decision.id}`);
    const advisorySnapshot = await resolveEvidence(decision.advisory_snapshot, "release/evidence/advisory-snapshot.json", "advisory-snapshot");
    const availability = await resolveEvidence(decision.patched_artifact_availability, "release/evidence/patched-artifact-availability.json", "patched-artifact-availability");
    const reachability = await resolveEvidence(decision.reachability_evidence, "release/evidence/focused-inert-reachability.json", "focused-inert-reachability");
    const acceptance = await resolveEvidence(decision.user_acceptance, "release/evidence/user-risk-acceptance.json", "user-risk-acceptance");
    const snapshotAdvisories = advisorySnapshot.advisories.map(({ source_url: _sourceUrl, ...advisory }) => advisory);
    invariant(isDeepStrictEqual(snapshotAdvisories, decision.advisories), `advisory snapshot differs from decision: ${decision.id}`);
    invariant(advisorySnapshot.package_name === decision.package_name && advisorySnapshot.package_version === decision.package_version, `advisory snapshot package differs: ${decision.id}`);
    invariant(availability.embedded_package === decision.package_name && availability.embedded_version === decision.package_version && availability.compatible_patched_artifact_available === false, `patched-artifact evidence differs: ${decision.id}`);
    invariant(reachability.bundle_digest === decision.bundle_digest && isDeepStrictEqual(reachability.entry_bindings, decision.entry_bindings), `reachability evidence binding differs: ${decision.id}`);
    invariant(acceptance.package_name === decision.package_name && acceptance.package_version === decision.package_version, `user acceptance package differs: ${decision.id}`);
    invariant(isDeepStrictEqual(acceptance.advisory_ids, decision.advisories.map((advisory) => advisory.id)), `user acceptance advisories differ: ${decision.id}`);
    invariant(isDeepStrictEqual(acceptance.scope, decision.scope), `user acceptance scope differs: ${decision.id}`);
  }
  for (const record of [...legalValue.amendments, ...legalValue.supersessions]) {
    const binding = record.evidence;
    invariant(ownerPaths.has(binding.path), `history evidence is outside release controls: ${binding.path}`);
    const document = parseCanonicalDocument(await readRegularFile(repositoryRoot, binding.path), `history evidence ${record.id}`);
    invariant(document.digest === binding.digest, `history evidence digest differs: ${record.id}`);
    const digestField = "amendment_digest" in record ? "amendment_digest" : "supersession_digest";
    const withoutDigest = { ...record };
    delete withoutDigest[digestField];
    invariant(record[digestField] === sha256(canonicalJsonBytes(withoutDigest)), `history record digest differs: ${record.id}`);
  }
  const fastUri = legalValue.dependency_gate_decisions.find((decision) => decision.package_name === "fast-uri" && decision.package_version === "3.1.0");
  invariant(fastUri, "accepted fast-uri prototype risk decision is absent");
  const advisories = fastUri.advisories.map((advisory) => advisory.id).sort();
  invariant(JSON.stringify(advisories) === JSON.stringify([
    "GHSA-4c8g-83qw-93j6",
    "GHSA-q3j6-qgpj-74h6",
    "GHSA-v2hh-gcrm-f6hx",
    "GHSA-v39h-62p7-jpjc",
  ]), "fast-uri decision does not bind all four advisories");
  invariant(ownerPaths.has("release/legal-review.json"), "legal review source is outside release controls");
}

function manifestField(manifest, ...names) {
  for (const name of names) if (manifest[name] !== undefined) return manifest[name];
  return undefined;
}

export async function validateReleaseSemantics({ repositoryRoot, payloadRoot, manifest, legalReview }) {
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
  schemaAssert(validators.legal, legalReview.value, "release legal review");

  const bundleInputs = manifestField(manifest.value, "bundle_inputs");
  const controls = manifestField(manifest.value, "release_control_inputs");
  const dependencyInputs = manifestField(manifest.value, "dependency_provenance_inputs");
  const contributing = manifestField(manifest.value, "contributing_inputs");
  const artifacts = manifestField(manifest.value, "artifacts", "generated_artifacts");
  invariant(Array.isArray(bundleInputs) && Array.isArray(controls) && Array.isArray(dependencyInputs), "manifest input collections are required");
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
  invariant(declared.workflow === "assets/workflow.yaml", "declared workflow differs");
  assertEqualPathSet(declared.constitution, expectedDeclared.filter((path) => path.startsWith("assets/constitution/")), "declared constitution");
  for (const path of [...declared.schemas, declared.workflow, ...declared.constitution]) invariant(ownerPaths.has(path), `unresolved declared content: ${path}`);
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
  const legalBytes = await readRegularFile(payload, "legal/review.json");
  invariant(Buffer.from(legalBytes).equals(Buffer.from(legalReview.bytes)), "payload legal review differs from canonical document");
  const sourceLegal = await readRegularFile(repository, "release/legal-review.json");
  invariant(Buffer.from(sourceLegal).equals(Buffer.from(legalReview.bytes)), "release legal source differs from payload");
  const bundleBytes = await readRegularFile(payload, "archflow-mcp.mjs");
  invariant(sha256(bundleBytes) === manifest.value.bundle_digest, "bundle digest mismatch");
  assertReleaseLoaderPolicy(decoder.decode(bundleBytes));
  const metafileDocument = parseCanonicalDocument(await readRegularFile(payload, "metafile.json"), "release metafile");
  const metafileInputs = metafileDocument.value.inputs;
  const metafileOutputs = metafileDocument.value.outputs;
  invariant(metafileInputs && metafileOutputs && Object.keys(metafileOutputs).length === 1, "release metafile must describe one output");
  const metafileOutput = metafileOutputs[RELEASE_BUILD_PROFILE.output];
  invariant(metafileOutput?.entryPoint === RELEASE_BUILD_PROFILE.entry, "release metafile entry/output differs");
  assertEqualPathSet(Object.keys(metafileInputs).sort(ordinal), bundleInputs.map((record) => record.key), "metafile inputs");
  for (const record of bundleInputs) {
    invariant(metafileInputs[record.key]?.bytes === record.size, `metafile scanned size differs: ${record.key}`);
    invariant((metafileOutput.inputs[record.key]?.bytesInOutput ?? 0) === record.bytes_in_output, `metafile byte contribution differs: ${record.key}`);
  }
  const actualImports = [...new Set(metafileOutput.imports.map((record) => record.path))].sort(ordinal);
  invariant(actualImports.every((path) => RELEASE_BUILD_PROFILE.allowedImports.includes(path) && path !== "node:module"), "metafile contains a forbidden import");
  const derivedDependency = await collectDependencyProvenance(repository, metafileDocument.value, contributing);
  invariant(isDeepStrictEqual(dependencyInputs, derivedDependency.records), "dependency provenance inputs are not the exact derived closure");
  invariant(isDeepStrictEqual(manifest.value.adjacent_map_expectations, derivedDependency.expectations), "adjacent source-map expectations differ from derived evidence");

  const dependencyInventoryDigest = sha256(canonicalJsonBytes({
    adjacent_map_expectations: manifest.value.adjacent_map_expectations,
    bundle_inputs: bundleInputs.filter((record) => record.origin.kind === "dependency"),
    dependency_provenance_inputs: dependencyInputs,
    current_components: legalReview.value.current_components,
  }));
  invariant(dependencyInventoryDigest === manifest.value.dependency_inventory_digest, "dependency inventory digest mismatch");
  invariant(legalReview.value.dependency_inventory_digest === undefined || legalReview.value.dependency_inventory_digest === dependencyInventoryDigest, "legal dependency inventory digest mismatch");
  const expectedEntry = { id: "mcp-stdio", role: "mcp-stdio", entry_point: "src/main.ts", output_path: "archflow-mcp.mjs", handler_authority: "inert-no-handler" };
  invariant(manifest.value.build_entries.length === 1 && Buffer.from(canonicalJsonBytes(manifest.value.build_entries[0])).equals(Buffer.from(canonicalJsonBytes(expectedEntry))), "release has an unexpected build entry");
  invariant(isDeepStrictEqual(manifest.value.launch_profile, await deriveLaunchProfile(repository)), "release launch profile differs from derived proof inputs");
  invariant(manifest.value.legal_review.digest === legalReview.digest, "manifest legal review binding is stale");
  await validateLegalCorrelation(repository, manifest.value, legalReview.value, ownerPaths, validators);

  const expectedLegalPayloads = new Set(legalReview.value.upstream_legal_sources.map((source) => source.payload_path));
  const actualLegalPayloads = actualFiles.filter((path) => path.startsWith("legal/upstream/"));
  assertEqualPathSet(actualLegalPayloads, [...expectedLegalPayloads].sort(ordinal), "payload upstream legal closure");
  for (const source of legalReview.value.upstream_legal_sources) {
    const sourceBytes = await readRegularFile(repository, source.source_path);
    const payloadBytes = await readRegularFile(payload, source.payload_path);
    invariant(Buffer.from(sourceBytes).equals(Buffer.from(payloadBytes)), `upstream legal source/output bytes differ: ${source.source_path}`);
  }
  const expectedNotice = legalProjection(legalReview.value);
  const actualNotice = await readRegularFile(payload, "legal/THIRD_PARTY_NOTICES.md");
  invariant(Buffer.from(expectedNotice).equals(Buffer.from(actualNotice)), "generated third-party notice differs from canonical projection");

  const summary = Object.freeze({
    payloadRoot: payload,
    files: Object.freeze(await Promise.all(actualFiles.map((path) => fileRecord(payload, path)))),
    bundleDigest: sha256(bundleBytes),
    dependencyInventoryDigest,
    manifest,
    legalReview,
  });
  return Object.freeze({ stageRoot: payload, summary });
}

async function readPayloadDocuments(payloadRoot) {
  return {
    manifest: parseCanonicalDocument(await readRegularFile(payloadRoot, "manifest.json"), "release manifest"),
    legalReview: parseCanonicalDocument(await readRegularFile(payloadRoot, "legal/review.json"), "release legal review"),
  };
}

function normalizedMetafile(metafile) {
  return sortCanonical(metafile);
}

async function buildRecords(repositoryRoot, metafile) {
  const soleOutput = metafile.outputs[RELEASE_BUILD_PROFILE.output] ?? metafile.outputs[`dist/${RELEASE_BUILD_PROFILE.output}`];
  invariant(soleOutput, "esbuild metafile has no sole release output");
  invariant(Object.keys(metafile.outputs).length === 1, "release build must have exactly one output");
  const inputs = [];
  for (const path of Object.keys(metafile.inputs).sort(ordinal)) {
    assertPortablePath(path, "esbuild input path");
    const bytes = await readRegularFile(repositoryRoot, path);
    const identity = packageIdentity(path);
    const bytesInOutput = soleOutput.inputs[path]?.bytesInOutput ?? 0;
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
  const contributing = Object.entries(soleOutput.inputs)
    .filter(([, record]) => record.bytesInOutput > 0)
    .map(([path]) => path)
    .sort(ordinal);
  return { bundleInputs: inputs, contributing };
}

async function createControlRecords(repositoryRoot, bundleInputs) {
  const bundled = new Set(bundleInputs.filter((record) => record.origin.kind === "repository").map((record) => record.origin.path));
  const candidates = new Set([
    ...REQUIRED_CONTROLS,
    ...(await collectDeclaredPaths(repositoryRoot)),
    ...(await collectLegalSourcePaths(repositoryRoot)),
    ...(await collectEvidencePaths(repositoryRoot)),
  ]);
  const records = [];
  for (const path of [...candidates].sort(ordinal)) {
    if (bundled.has(path)) continue;
    records.push(await fileRecord(repositoryRoot, path));
  }
  return records;
}

async function copyLegal(repositoryRoot, files) {
  files.set("legal/review.json", await readRegularFile(repositoryRoot, "release/legal-review.json"));
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
    entryPoints: [RELEASE_BUILD_PROFILE.entry],
    outfile: RELEASE_BUILD_PROFILE.output,
    write: false,
    metafile: true,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    splitting: false,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    plugins: [],
    banner: { js: RELEASE_BUILD_PROFILE.banner },
    tsconfigRaw: RELEASE_BUILD_PROFILE.tsconfigRaw,
  });
  invariant(result.outputFiles.length === 1, "release build emitted an unexpected file");
  const output = result.outputFiles[0].contents;
  const outputMeta = result.metafile.outputs[RELEASE_BUILD_PROFILE.output];
  invariant(outputMeta, "release output has an unstable logical path");
  const imports = new Set(outputMeta.imports.map((record) => record.path));
  imports.add("node:module");
  for (const path of imports) invariant(RELEASE_BUILD_PROFILE.allowedImports.includes(path), `forbidden release import: ${path}`);
  const source = decoder.decode(output);
  assertReleaseLoaderPolicy(source);

  const { bundleInputs, contributing } = await buildRecords(repository, result.metafile);
  const controls = await createControlRecords(repository, bundleInputs);
  const dependency = await collectDependencyProvenance(repository, result.metafile, contributing);
  const dependencyInputs = dependency.records;
  const legalBytes = await readRegularFile(repository, "release/legal-review.json");
  const legalReview = parseCanonicalDocument(legalBytes, "release legal review source");
  const dependencyInventoryDigest = sha256(canonicalJsonBytes({
    adjacent_map_expectations: dependency.expectations,
    bundle_inputs: bundleInputs.filter((record) => record.origin.kind === "dependency"),
    dependency_provenance_inputs: dependencyInputs,
    current_components: legalReview.value.current_components,
  }));
  const metafileBytes = canonicalJsonBytes(normalizedMetafile(result.metafile));
  const files = new Map([
    ["archflow-mcp.mjs", output],
    ["metafile.json", metafileBytes],
  ]);
  await copyLegal(repository, files);
  files.set("legal/THIRD_PARTY_NOTICES.md", legalProjection(legalReview.value));
  const artifactRole = (path) => path === "archflow-mcp.mjs" ? "executable"
    : path === "metafile.json" ? "metafile"
    : path === "legal/review.json" ? "legal-review"
    : path === "legal/THIRD_PARTY_NOTICES.md" ? "legal-notice"
    : "upstream-legal";
  const artifacts = [...files].map(([path, bytes]) => ({ path, role: artifactRole(path), size: bytes.byteLength, digest: sha256(bytes) }))
    .sort((a, b) => ordinal(a.path, b.path));
  artifacts.push({ path: "manifest.json", role: "manifest" });
  artifacts.sort((a, b) => ordinal(a.path, b.path));
  const declaredPaths = await collectDeclaredPaths(repository);
  const manifestValue = {
    schema_version: "1",
    bundle_digest: sha256(output),
    dependency_inventory_digest: dependencyInventoryDigest,
    bundle_inputs: bundleInputs,
    contributing_inputs: contributing,
    release_control_inputs: controls,
    dependency_provenance_inputs: dependencyInputs,
    adjacent_map_expectations: dependency.expectations,
    declared_content: {
      schemas: declaredPaths.filter((path) => path.startsWith("src/contracts/schemas/v1/")),
      workflow: "assets/workflow.yaml",
      constitution: declaredPaths.filter((path) => path.startsWith("assets/constitution/")),
    },
    proof_inputs: [...PROOF_INPUTS],
    build_entries: [{ id: "mcp-stdio", role: "mcp-stdio", entry_point: "src/main.ts", output_path: "archflow-mcp.mjs", handler_authority: "inert-no-handler" }],
    launch_profile: await deriveLaunchProfile(repository),
    legal_review: { source_path: "release/legal-review.json", payload_path: "legal/review.json", digest: legalReview.digest },
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
  const launchProfileDigest = sha256(canonicalJsonBytes(candidate.manifest.value.launch_profile ?? {}));
  return Object.freeze({ candidate, reproduced, comparedFiles, proofInputsDigest, launchProfileDigest });
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

async function readHeadFile(repositoryRoot, path) {
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${path}`], { cwd: repositoryRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return new Uint8Array(stdout);
  } catch (error) {
    if (error.code === 128 || error.stderr?.toString().includes("does not exist")) return undefined;
    throw error;
  }
}

async function verifyHeadLegalBaseline(repositoryRoot, candidateLegal) {
  const listed = (await execFileAsync("git", ["ls-tree", "-r", "--name-only", "HEAD", "release", "dist/legal"], { cwd: repositoryRoot })).stdout
    .trim().split("\n").filter(Boolean).sort(ordinal);
  const releasePaths = listed.filter((path) => path === "release/legal-review.json" || path.startsWith("release/legal/upstream/"));
  const distPaths = listed.filter((path) => path.startsWith("dist/legal/"));
  const source = releasePaths.includes("release/legal-review.json") ? await readHeadFile(repositoryRoot, "release/legal-review.json") : undefined;
  const output = distPaths.includes("dist/legal/review.json") ? await readHeadFile(repositoryRoot, "dist/legal/review.json") : undefined;
  if (!source && !output) {
    invariant(releasePaths.length === 0 && distPaths.length === 0, "HEAD contains orphan legal artifacts without review baseline");
    return;
  }
  invariant(source && output, "HEAD legal source/output baseline is inconsistent");
  invariant(Buffer.from(source).equals(Buffer.from(output)), "HEAD legal source/output bytes differ");
  const prior = parseCanonicalDocument(source, "HEAD legal review").value;
  for (const collection of ["dependency_gate_decisions", "amendments", "supersessions"]) {
    const priorRecords = new Map((prior[collection] ?? []).map((record) => [record.id, canonicalJsonBytes(record)]));
    const currentRecords = new Map((candidateLegal.value[collection] ?? []).map((record) => [record.id, canonicalJsonBytes(record)]));
    for (const [id, bytes] of priorRecords) {
      const current = currentRecords.get(id);
      invariant(current && Buffer.from(current).equals(Buffer.from(bytes)), `HEAD ${collection} record changed or disappeared: ${id}`);
    }
  }
  const sourceUpstream = releasePaths.filter((path) => path.startsWith("release/legal/upstream/"));
  const distUpstream = distPaths.filter((path) => path.startsWith("dist/legal/upstream/"));
  for (const path of sourceUpstream) {
    const counterpart = `dist/${path.slice("release/".length)}`;
    invariant(distUpstream.includes(counterpart), `HEAD upstream counterpart missing: ${counterpart}`);
    invariant(Buffer.from(await readHeadFile(repositoryRoot, path)).equals(Buffer.from(await readHeadFile(repositoryRoot, counterpart))), `HEAD upstream counterpart differs: ${path}`);
  }
  invariant(sourceUpstream.length === distUpstream.length, "HEAD has orphan dist upstream legal artifacts");
  const exactDistLegal = [
    "dist/legal/THIRD_PARTY_NOTICES.md",
    "dist/legal/review.json",
    ...sourceUpstream.map((path) => `dist/${path.slice("release/".length)}`),
  ].sort(ordinal);
  invariant(isDeepStrictEqual(distPaths, exactDistLegal), "HEAD dist legal closure has missing or extra artifacts");
  const priorNotice = await readHeadFile(repositoryRoot, "dist/legal/THIRD_PARTY_NOTICES.md");
  invariant(Buffer.from(priorNotice).equals(Buffer.from(legalProjection(prior))), "HEAD generated notice differs from its review source");
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
  await verifyHeadLegalBaseline(repository, candidate.summary.legalReview);
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
      legal_review_digest: value.legalReview.digest,
    };
  }
  if (value?.candidate && value?.reproduced) {
    return {
      candidate: jsonSummary(value.candidate),
      reproduced: jsonSummary(value.reproduced),
      compared_files: value.comparedFiles,
      proof_inputs_digest: value.proofInputsDigest,
      launch_profile_digest: value.launchProfileDigest,
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
