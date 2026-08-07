import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkerPath = resolve(repositoryRoot, "scripts/check-mcp-sdk-boundary.mjs");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "archflow-mcp-sdk-boundary-"));
const adapterPath = resolve(temporaryRoot, "src/mcp/sdk-adapter.ts");
const probePath = resolve(temporaryRoot, "src/nested/probe.ts");

function runCheck() {
  return spawnSync(process.execPath, [checkerPath, "--root", temporaryRoot], { encoding: "utf8" });
}

function assertRejected(label, expected) {
  const result = runCheck();
  assert.notEqual(result.status, 0, `${label} must fail the MCP SDK boundary`);
  assert.match(result.stderr, expected);
}

async function assertOutsideAdapterRejected(label, source) {
  await writeFile(probePath, source);
  assertRejected(label, /only src\/mcp\/sdk-adapter\.ts may import the SDK/u);
  await writeFile(probePath, "export const clean = true;\n");
}

try {
  await mkdir(resolve(temporaryRoot, "src/mcp"), { recursive: true });
  await mkdir(resolve(temporaryRoot, "src/nested"), { recursive: true });
  await writeFile(
    adapterPath,
    'import { Server, type Transport } from "@modelcontextprotocol/server";\n' +
      'import type { RequestId } from "@modelcontextprotocol/core";\n' +
      "export const publicImports = [Server, null as Transport | RequestId | null];\n"
  );
  await writeFile(probePath, "export const clean = true;\n");
  const cleanResult = runCheck();
  assert.equal(
    cleanResult.status,
    0,
    `public static adapter imports and SDK-free production source must pass:\n${cleanResult.stderr}`
  );

  await assertOutsideAdapterRejected(
    "static import",
    'import { Server } from "@modelcontextprotocol/server";\n'
  );
  await assertOutsideAdapterRejected(
    "type import",
    'import type { RequestId } from "@modelcontextprotocol/core";\n'
  );
  await assertOutsideAdapterRejected(
    "side-effect import",
    'import "@modelcontextprotocol/server";\n'
  );
  await assertOutsideAdapterRejected(
    "dynamic import",
    'const sdk = await import("@modelcontextprotocol/server");\n'
  );
  await assertOutsideAdapterRejected(
    "re-export",
    'export * from "@modelcontextprotocol/server";\n'
  );

  await writeFile(adapterPath, 'import "@modelcontextprotocol/server";\n');
  assertRejected("adapter side-effect import", /only declared static imports/u);
  await writeFile(adapterPath, 'const sdk = await import("@modelcontextprotocol/server");\n');
  assertRejected("adapter dynamic import", /only declared static imports/u);
  await writeFile(adapterPath, 'export * from "@modelcontextprotocol/server";\n');
  assertRejected("adapter re-export", /only declared static imports/u);
  await writeFile(adapterPath, 'import { Server } from "@modelcontextprotocol/server/dist/index.mjs";\n');
  assertRejected("adapter private import", /non-public or unapproved MCP path/u);

  console.log("MCP SDK boundary mutation checks rejected static, type, side-effect, dynamic, re-export, and private-path violations.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
