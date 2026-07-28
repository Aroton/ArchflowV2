/**
 * Phase 6, verification step 13 — the boundary and registry invariants that are *structural* rather
 * than behavioural, and so have no natural home in any module's own suite.
 *
 * Two of the step's invariants are deliberately **not** repeated here because they already have
 * dedicated owners: the `SCHEMA_IDS`/`SCHEMA_FILES` bijection, plus each `$id` compiling against all
 * others, is `test/contracts/schema-registry.test.ts`; the 52-project-code and 56-row error counts
 * are `test/unit/errors.test.ts` and `test/contracts/gate-error-supplemental-exhaustive.test.ts`.
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
    const schema = readFileSync(
      join(repositoryRoot, "src", "contracts", "schemas", "v1", "gate-contract.schema.json"),
      "utf8"
    );
    expect(schema).toContain('"changed_path_class": { "const": "task-branch-constitution" }');
  });
});

/**
 * `package.json` is deliberately untouched by this phase: the Vitest include pattern already covers
 * every test file under `test/`, so bare `npm test` — the fourth step of `npm run check` and of CI —
 * picks the integration suite up automatically, and adding a `test:repository` script wired into
 * `check` would run the phase's most expensive suite twice. These two lists are the pre-phase state,
 * pinned so that "unchanged" is enforced rather than asserted in prose.
 */
describe("package.json dependencies and scripts", () => {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8")
  ) as Readonly<{
    dependencies: Readonly<Record<string, string>>;
    scripts: Readonly<Record<string, string>>;
  }>;

  it("adds no runtime dependency", () => {
    expect(manifest.dependencies).toEqual({
      "@modelcontextprotocol/server": "2.0.0",
      ajv: "8.20.0",
      "ajv-formats": "3.0.1",
      yaml: "2.9.0",
      zod: "4.4.3",
    });
  });

  it("adds no script, and leaves `check` running the test suite exactly once", () => {
    expect(Object.keys(manifest.scripts).sort()).toEqual([
      "build:temp",
      "check",
      "check:dependencies",
      "check:notices",
      "check:phase4-mcp-boundary",
      "check:release",
      "probe:phase4-mcp-compatibility",
      "release:check",
      "release:mutations",
      "release:reproduce",
      "release:smoke",
      "release:stage",
      "release:write",
      "test",
      "test:contracts",
      "test:mcp-runtime",
      "test:notices-policy",
      "test:phase4-mcp-boundary-policy",
      "test:unit",
      "typecheck",
    ]);
    expect(manifest.scripts["check"]?.split("npm test").length).toBe(2);
  });
});
