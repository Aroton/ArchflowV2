import { readFile } from "node:fs/promises";

const expectedRuntime = Object.freeze({
  "@modelcontextprotocol/server": "2.0.0",
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  yaml: "2.9.0",
  zod: "4.4.3"
});
const expectedDevelopment = Object.freeze({
  "@types/node": "24.13.3",
  esbuild: "0.28.1",
  typescript: "7.0.2",
  vite: "7.3.6",
  vitest: "4.1.10"
});
const approvedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT"
]);
const prohibitedLaterPhasePackages = new Set([
  "@anthropic-ai/sandbox-runtime",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/express",
  "@modelcontextprotocol/hono",
  "@modelcontextprotocol/node",
  "execa",
  "proper-lockfile",
  "write-file-atomic"
]);

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const failures = [];

function compareDirect(actual, expected, label) {
  const actualEntries = Object.entries(actual ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const expectedEntries = Object.entries(expected).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    failures.push(`${label} must contain exactly ${JSON.stringify(expected)}`);
  }
  for (const [name, version] of actualEntries) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
      failures.push(`${label} dependency ${name} is not an exact version: ${version}`);
    }
  }
}

if (packageJson.private !== true || packageJson.type !== "module") {
  failures.push("package.json must describe a private ESM package");
}
if (packageJson.engines?.node !== ">=24.15.0") {
  failures.push("package.json must keep Node 24.15.0 as the functional runtime floor");
}
compareDirect(packageJson.dependencies, expectedRuntime, "runtime");
compareDirect(packageJson.devDependencies, expectedDevelopment, "development");
for (const field of ["optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
  if (packageJson[field] !== undefined) {
    failures.push(`package.json must not declare direct packages through ${field}`);
  }
}

if (lock.lockfileVersion !== 3 || lock.requires !== true) {
  failures.push("package-lock.json must be an npm lockfileVersion 3 exact lock");
}
const root = lock.packages?.[""];
if (root?.engines?.node !== ">=24.15.0") {
  failures.push("lockfile root must keep Node 24.15.0 as the functional runtime floor");
}
compareDirect(root?.dependencies, expectedRuntime, "lockfile root runtime");
compareDirect(root?.devDependencies, expectedDevelopment, "lockfile root development");
for (const field of ["optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
  if (root?.[field] !== undefined) {
    failures.push(`lockfile root must not declare direct packages through ${field}`);
  }
}

function packageNameFromPath(path, metadata) {
  if (metadata.name) return metadata.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index === -1 ? "" : path.slice(index + marker.length);
}

const expectedMcpRoots = Object.freeze({
  "node_modules/@modelcontextprotocol/core": Object.freeze({
    name: "@modelcontextprotocol/core",
    version: "2.0.0",
    license: "MIT"
  }),
  "node_modules/@modelcontextprotocol/server": Object.freeze({
    name: "@modelcontextprotocol/server",
    version: "2.0.0",
    license: "MIT"
  })
});
const expectedMcpRootsByName = new Map(Object.values(expectedMcpRoots).map((root) => [root.name, root]));
for (const [path, expected] of Object.entries(expectedMcpRoots)) {
  const metadata = lock.packages?.[path];
  const actual = metadata === undefined
    ? undefined
    : {
        name: packageNameFromPath(path, metadata),
        version: metadata.version,
        license: metadata.license
      };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${path} must resolve exactly to ${expected.name}@${expected.version} with ${expected.license}`);
  }
}
const lockedServer = lock.packages?.["node_modules/@modelcontextprotocol/server"];
if (lockedServer?.dependencies?.["@modelcontextprotocol/core"] !== "2.0.0") {
  failures.push("the exact MCP server root must lock exact @modelcontextprotocol/core@2.0.0");
}

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (path === "") continue;
  const name = packageNameFromPath(path, metadata);
  if (!name || !metadata.version || !metadata.integrity || !metadata.resolved) {
    failures.push(`incomplete exact-lock metadata at ${path}`);
    continue;
  }
  if (name === "lightningcss" || name.startsWith("lightningcss-")) {
    failures.push(`prohibited Lightning CSS package resolved: ${name}@${metadata.version}`);
  }
  if (prohibitedLaterPhasePackages.has(name)) {
    failures.push(`later-phase package resolved early: ${name}@${metadata.version}`);
  }
  if (name.startsWith("@modelcontextprotocol/")) {
    const expected = expectedMcpRootsByName.get(name);
    if (expected === undefined) {
      failures.push(`unreviewed MCP package resolved: ${name}@${metadata.version}`);
    } else if (metadata.version !== expected.version || metadata.license !== expected.license) {
      failures.push(`MCP package identity drift: ${name}@${metadata.version} with ${String(metadata.license)}`);
    }
  }
  if (!approvedLicenses.has(metadata.license)) {
    failures.push(`unreviewed or non-permissive license ${String(metadata.license)} at ${name}@${metadata.version}`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Dependency policy passed for ${Object.keys(lock.packages).length - 1} locked package entries.`);
}
