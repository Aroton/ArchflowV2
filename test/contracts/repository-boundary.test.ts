/**
 * Phase 6, verification step 13 — the boundary and registry invariants that are *structural* rather
 * than behavioural, and so have no natural home in any module's own suite.
 *
 * Two of the step's invariants are deliberately **not** repeated here because they already have
 * dedicated owners: the `SCHEMA_IDS`/`SCHEMA_FILES` bijection, plus each `$id` compiling against all
 * others, is `test/contracts/schema-registry.test.ts`; the 52-project-code and 56-row error counts
 * are `test/unit/errors.test.ts` and `test/contracts/gate-error-schema-agreement.test.ts`.
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

  it("has exactly one src/repository barrel", () => {
    const barrels = sourceFiles(join(repositoryRoot, "src", "repository")).filter((file) =>
      file.endsWith("index.ts")
    );
    expect(barrels).toHaveLength(1);
    expect(barrels[0]).toBe(join(repositoryRoot, "src", "repository", "index.ts"));
  });

  it("keeps gate-contract's changed_path_class a single const, not the widened enum", () => {
    const schema = JSON.parse(readFileSync(
      join(repositoryRoot, "src", "contracts", "schemas", "v1", "gate-contract.schema.json"),
      "utf8"
    )) as { $defs: Record<string, { properties: Record<string, { const?: unknown; enum?: unknown }> }> };
    const changed = schema.$defs["constitutionEditContext"]!.properties["changed_path_class"]!;
    expect(changed.const).toBe("task-branch-constitution");
    expect(changed.enum).toBeUndefined();
  });

  it("exports the durable intent contract without exposing internal state filesystem capabilities", () => {
    const indexPath = join(repositoryRoot, "src", "contracts", "index.ts");
    const source = readFileSync(indexPath, "utf8");
    const stateTargets = [...source.matchAll(IMPORT_SPECIFIER)]
      .map((match) => match.groups?.["target"] ?? "")
      .filter((target) => /(?:^|\/)state(?:\/|$)/u.test(target));

    expect(source).toContain('export * from "./durable-intent.js";');
    expect(stateTargets).toEqual([]);
    for (const internalCapability of [
      "AtomicWriter",
      "AtomicReplaceError",
      "createAtomicWriter",
      "TaskLock",
      "TaskLockError",
      "createTaskLock",
      "TransactionAuthority",
      "createInternalTransactionAuthority",
      "InputFingerprintResolver",
      "createInternalInputFingerprintResolver",
      "runStateTransaction",
    ]) {
      expect(source).not.toContain(internalCapability);
    }
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
    dependencies: Readonly<Record<string, string>>;
    engines: Readonly<{ node: string }>;
    scripts: Readonly<Record<string, string>>;
  }>;

  it("admits only the exact runtime baseline and Node 24 engine line", () => {
    expect(manifest.dependencies).toEqual({
      "@modelcontextprotocol/server": "2.0.0",
      "@secretlint/core": "13.0.4",
      // Direct because src/state/secret-scan.ts releases the profiler timeline `@secretlint/core`
      // leaves behind; it is core's own transitive dependency, pinned to the same version.
      "@secretlint/profiler": "13.0.4",
      "@secretlint/secretlint-rule-preset-recommend": "13.0.4",
      "write-file-atomic": "8.0.0",
      yaml: "2.9.0",
      zod: "4.4.3",
    });
    expect(manifest.engines.node).toBe("^24.15.0");
    for (const prohibited of [
      "@anthropic-ai/sandbox-runtime",
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
      "bench:review",
      "build:temp",
      "check",
      "check:deep",
      "check:mcp-sdk-boundary",
      "check:notices",
      "check:release",
      "check:schemas",
      "generate:schemas",
      "probe:mcp-sdk-compatibility",
      "release:check",
      "release:mutations",
      "release:reproduce",
      "release:smoke",
      "release:stage",
      "release:write",
      "test",
      "test:contracts",
      "test:crash",
      "test:extended",
      "test:integration",
      "test:mcp-sdk-boundary-policy",
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
      "test:crash",
      "test:notices-policy",
      "test:mcp-sdk-boundary-policy",
      "check:release",
      "test:real-host",
      "bench:review",
    ]) {
      expect(manifest.scripts["check"], excluded).not.toContain(excluded);
    }
    for (const included of [
      "check:schemas",
      "test:extended",
      "test:integration",
      "test:crash",
      "test:notices-policy",
      "test:mcp-sdk-boundary-policy",
      "check:release",
    ]) {
      expect(manifest.scripts["check:deep"], included).toContain(included);
    }
    expect(manifest.scripts["check:deep"]).not.toContain("test:real-host");
    expect(manifest.scripts["check:deep"]).not.toContain("bench:review");
  });
});
