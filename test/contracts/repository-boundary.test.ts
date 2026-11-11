/**
 * Boundary and package invariants that are *structural* rather than behavioural, and so have no
 * natural home in any module's own suite.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+"(?<target>[^"]+)"/gu;

describe("the contracts / repository directional boundary", () => {
  it("has no src/contracts import of src/repository", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(repositoryRoot, "src", "contracts"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const target = match.groups?.["target"] ?? "";
        if (/(?:^|\/)repository\//u.test(target)) offenders.push(`${file} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The fast project is the ordinary local/CI surface. Expensive projects remain independently
 * selectable and `check:deep` composes the local deep tiers without ever opting into real hosts.
 */
describe("package.json dependencies and scripts", () => {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8")
  ) as Readonly<{
    name: string;
    dependencies: Readonly<Record<string, string>>;
    engines: Readonly<{ node: string }>;
    scripts: Readonly<Record<string, string>>;
  }>;

  it("admits only the exact runtime baseline and Node 24 engine line", () => {
    expect(manifest.name).toBe("archflow");
    expect(manifest.dependencies).toEqual({
      yaml: "2.9.0",
      zod: "4.4.3",
    });
    expect(manifest.engines.node).toBe("^24.15.0");
    for (const prohibited of [
      "@anthropic-ai/sandbox-runtime",
      "@modelcontextprotocol/server",
      "@modelcontextprotocol/client",
      "@modelcontextprotocol/express",
      "@modelcontextprotocol/hono",
      "@modelcontextprotocol/node",
      "execa",
      "proper-lockfile",
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(prohibited);
    }
  });

  it("keeps expensive projects outside the fast check and runs the ordinary suite exactly once", () => {
    expect(Object.keys(manifest.scripts).sort()).toEqual([
      "check",
      "check:deep",
      "check:notices",
      "check:release",
      "check:schemas",
      "generate:schemas",
      "release:check",
      "release:mutations",
      "release:reproduce",
      "release:smoke",
      "release:stage",
      "release:write",
      "test",
      "test:contracts",
      "test:extended",
      "test:integration",
      "test:notices-policy",
      "test:real-host",
      "test:unit",
      "typecheck",
    ]);
    expect(manifest.scripts["test"]).toBe("vitest run --project fast");
    expect(manifest.scripts["check"]?.split("npm test").length).toBe(2);
    for (const excluded of [
      "check:schemas",
      "test:extended",
      "test:integration",
      "test:notices-policy",
      "check:release",
      "test:real-host",
    ]) {
      expect(manifest.scripts["check"], excluded).not.toContain(excluded);
    }
    for (const included of [
      "check:schemas",
      "test:extended",
      "test:integration",
      "test:notices-policy",
      "check:release",
    ]) {
      expect(manifest.scripts["check:deep"], included).toContain(included);
    }
    expect(manifest.scripts["check:deep"]).not.toContain("test:real-host");
  });
});
