import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkerPath = `${repositoryRoot}/scripts/check-phase-3-mcp-boundary.mjs`;
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "archflow-phase-3-mcp-boundary-"));
const probePath = `${temporaryRoot}/src/nested/probe.ts`;

function runCheck() {
  return spawnSync(process.execPath, [checkerPath, "--root", temporaryRoot], { encoding: "utf8" });
}

async function assertSourceMutationRejected(label, source) {
  await writeFile(probePath, source);
  const result = runCheck();
  assert.notEqual(result.status, 0, `${label} must fail the Phase 3 MCP boundary`);
  assert.match(result.stderr, /src\/nested\/probe\.ts contains prohibited @modelcontextprotocol\//u);
  await unlink(probePath);
}

async function assertPrematurePathRejected(path, kind = "file") {
  const absolutePath = `${temporaryRoot}/${path}`;
  if (kind === "directory") {
    await mkdir(absolutePath, { recursive: true });
  } else {
    await mkdir(resolve(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, "export {};\n");
  }
  const result = runCheck();
  assert.notEqual(result.status, 0, `${path} must fail the Phase 3 MCP boundary`);
  assert.match(result.stderr, new RegExp(`${path.replaceAll(".", "\\.")} must not exist before its owning phase`, "u"));
  await rm(absolutePath, { recursive: true, force: true });
}

try {
  await mkdir(`${temporaryRoot}/src/nested`, { recursive: true });
  await writeFile(`${temporaryRoot}/src/nested/clean.ts`, "export const clean = true;\n");
  assert.equal(runCheck().status, 0, "clean production source must pass the Phase 3 MCP boundary");

  await assertSourceMutationRejected(
    "aliased static import",
    'import { Server as ProtocolServer } from "@modelcontextprotocol/server";\n'
  );
  await assertSourceMutationRejected(
    "type import",
    'import type { RequestId } from "@modelcontextprotocol/core";\n'
  );
  await assertSourceMutationRejected(
    "side-effect import",
    'import "@modelcontextprotocol/server";\n'
  );
  await assertSourceMutationRejected(
    "dynamic import",
    'const sdk = await import("@modelcontextprotocol/server");\n'
  );
  await assertSourceMutationRejected(
    "re-export",
    'export * from "@modelcontextprotocol/server";\n'
  );

  await assertPrematurePathRejected("src/main.ts");
  await assertPrematurePathRejected("src/mcp/sdk-adapter.ts");
  await assertPrematurePathRejected("src/mcp/index.ts");
  await assertPrematurePathRejected("dist", "directory");

  console.log(
    "Phase 3 MCP boundary mutation checks rejected all SDK reference forms and premature runtime/release paths."
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
