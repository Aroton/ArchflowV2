import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = parseRepositoryRoot(process.argv.slice(2));
const sourceRoot = resolve(repositoryRoot, "src");
const prohibitedFragment = "@modelcontextprotocol/";
const prohibitedPaths = Object.freeze([
  "src/main.ts",
  "src/mcp/sdk-adapter.ts",
  "src/mcp/index.ts",
  "dist"
]);
const failures = [];

function parseRepositoryRoot(args) {
  if (args.length === 0) return defaultRepositoryRoot;
  if (args.length !== 2 || args[0] !== "--root") {
    throw new Error("usage: node scripts/check-phase-3-mcp-boundary.mjs [--root <repository-root>]");
  }
  return resolve(args[1]);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await collectTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(path);
    }
  }
  return paths;
}

let sourceFiles;
try {
  sourceFiles = await collectTypeScriptFiles(sourceRoot);
} catch (error) {
  if (error?.code === "ENOENT") {
    failures.push("src must exist so the Phase 3 production boundary can be checked");
    sourceFiles = [];
  } else {
    throw error;
  }
}

for (const path of sourceFiles.sort()) {
  const content = await readFile(path, "utf8");
  if (content.includes(prohibitedFragment)) {
    failures.push(`${relative(repositoryRoot, path)} contains prohibited ${prohibitedFragment}`);
  }
}

for (const path of prohibitedPaths) {
  if (await exists(resolve(repositoryRoot, path))) {
    failures.push(`${path} must not exist before its owning phase`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Phase 3 MCP boundary passed for ${sourceFiles.length} production TypeScript files.`);
}
