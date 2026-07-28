import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = parseRepositoryRoot(process.argv.slice(2));
const sourceRoot = resolve(repositoryRoot, "src");
const adapterPath = "src/mcp/sdk-adapter.ts";
const packagePrefix = "@modelcontextprotocol/";
const publicRoots = new Set([
  "@modelcontextprotocol/core",
  "@modelcontextprotocol/server"
]);
const failures = [];

function parseRepositoryRoot(args) {
  if (args.length === 0) return defaultRepositoryRoot;
  if (args.length !== 2 || args[0] !== "--root") {
    throw new Error("usage: node scripts/check-phase-4-mcp-boundary.mjs [--root <repository-root>]");
  }
  return resolve(args[1]);
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

function inspectSource(path, content) {
  const repositoryPath = relative(repositoryRoot, path).replaceAll("\\", "/");
  const staticImports = [];
  const staticImportPattern = /(?:^|\n)\s*import\s+(?!["'])[^;]+?\s+from\s+["'](@modelcontextprotocol\/[^"']*)["']\s*;/gu;
  for (const match of content.matchAll(staticImportPattern)) {
    staticImports.push({ start: match.index, end: match.index + match[0].length, specifier: match[1] });
  }

  const referencePattern = /["'](@modelcontextprotocol\/[^"']*)["']/gu;
  for (const match of content.matchAll(referencePattern)) {
    const declaration = staticImports.find(({ start, end }) => match.index >= start && match.index < end);
    const specifier = match[1];
    if (repositoryPath !== adapterPath) {
      failures.push(`${repositoryPath} imports MCP SDK package ${specifier}; only ${adapterPath} may import the SDK`);
    } else if (declaration === undefined) {
      failures.push(`${adapterPath} may use only declared static imports from MCP public roots`);
    } else if (!publicRoots.has(specifier)) {
      failures.push(`${adapterPath} imports non-public or unapproved MCP path ${specifier}`);
    }
  }

  if (content.includes(packagePrefix) && !referencePattern.test(content)) {
    failures.push(`${repositoryPath} contains an MCP SDK reference outside a recognized string-literal import`);
  }
}

let sourceFiles;
try {
  sourceFiles = await collectTypeScriptFiles(sourceRoot);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  failures.push("src must exist so the Phase 4 production boundary can be checked");
  sourceFiles = [];
}

for (const path of sourceFiles.sort()) {
  inspectSource(path, await readFile(path, "utf8"));
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Phase 4 MCP boundary passed for ${sourceFiles.length} production TypeScript files; SDK imports are isolated to ${adapterPath}.`);
}
