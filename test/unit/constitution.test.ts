import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { parseConstitutionRuleFiles, parseConstitutionRuleMarkdown, validateConstitutionEvolution, type ConstitutionRuleV1 } from "../../src/contracts/constitution.js";
import { parseConstitutionRuleV1 } from "../../src/contracts/constitution.js";
import { PlainJsonError } from "../../src/contracts/plain-json.js";
import { SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3 } from "../../src/state/constitution.js";

const rule = (overrides: Partial<ConstitutionRuleV1> = {}): ConstitutionRuleV1 => ({ id: "stable-rule", version: 1, status: "active", text: "Preserve the invariant.", ...overrides });

describe("constitution Markdown", () => {
  it("loads every shipped numbered policy with unique IDs", async () => {
    const directory = new URL("../../assets/constitution/", import.meta.url);
    const paths = (await readdir(directory)).filter((path) => /^\d\d-.*\.md$/u.test(path));
    const files = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(new URL(path, directory), "utf8")] as const)));
    const registry = parseConstitutionRuleFiles(files);
    expect([...registry.keys()]).toEqual(["explicit-human-authority", "approved-design-before-code", "task-and-evidence-isolation", "honest-human-centered-outcomes"]);
  });

  it("ships no review trigger by default so a human constitution gate is a repository choice", async () => {
    const directory = new URL("../../assets/constitution/", import.meta.url);
    const paths = (await readdir(directory)).filter((path) => /^\d\d-.*\.md$/u.test(path));
    const files = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(new URL(path, directory), "utf8")] as const)));
    for (const parsed of parseConstitutionRuleFiles(files).values()) {
      expect(parsed.review_trigger).toBeUndefined();
    }
  });

  it("ships byte-identical live and seed rules for the exact supported v3 profile", async () => {
    const seedDirectory = new URL("../../assets/constitution/", import.meta.url);
    const liveDirectory = new URL("../../.archflow/constitution/", import.meta.url);
    const selectedFiles = ["00-process.md", "10-architecture.md"] as const;
    const sources: Record<string, string> = {};

    for (const path of selectedFiles) {
      const seed = await readFile(new URL(path, seedDirectory), "utf8");
      const live = await readFile(new URL(path, liveDirectory), "utf8");
      expect(live).toBe(seed);
      sources[path] = seed;
    }

    const registry = parseConstitutionRuleFiles(sources);
    const normalized = SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3.map(({ id }) => {
      const parsed = registry.get(id);
      expect(parsed).toBeDefined();
      return {
        ...parsed!,
        review_trigger: parsed!.review_trigger ?? "",
        enforced_by: [...new Set(parsed!.enforced_by ?? [])].sort(),
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
    expect(normalized).toEqual(SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3);
  });

  it("parses deterministic frontmatter and prose", async () => {
    const source = await readFile(new URL("../fixtures/foundation/constitution/valid.md", import.meta.url), "utf8");
    expect(parseConstitutionRuleMarkdown(source, "valid.md")).toMatchObject({ id: "stable-rule", version: 1, text: "Preserve the invariant at every boundary." });
  });

  it("rejects invalid metadata and duplicate IDs across files", async () => {
    const invalid = await readFile(new URL("../fixtures/foundation/constitution/invalid-frontmatter.md", import.meta.url), "utf8");
    expect(() => parseConstitutionRuleMarkdown(invalid, "invalid.md")).toThrow();
    const valid = await readFile(new URL("../fixtures/foundation/constitution/valid.md", import.meta.url), "utf8");
    expect(() => parseConstitutionRuleFiles({ "a.md": valid, "b.md": valid })).toThrow(/Duplicate constitution rule id/);
  });

  it("plain-JSON preflights the direct unknown boundary without invoking getters", () => {
    const valid = rule() as unknown as Record<string, unknown>;
    expect(() => parseConstitutionRuleV1(Object.create(valid))).toThrow(PlainJsonError);

    let getterCalls = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, "id", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return valid.id;
      }
    });
    expect(() => parseConstitutionRuleV1(accessor)).toThrow(PlainJsonError);
    expect(getterCalls).toBe(0);

    const dangerous = structuredClone(valid);
    Object.defineProperty(dangerous, "prototype", { enumerable: true, value: "forbidden" });
    expect(() => parseConstitutionRuleV1(dangerous)).toThrow(PlainJsonError);
    expect(() => parseConstitutionRuleV1({ ...structuredClone(valid), unsupported: undefined })).toThrow(PlainJsonError);
  });
});

describe("constitution evolution", () => {
  const prior = new Map([["stable-rule", rule()]]);

  it("permits append, versioned edit, and versioned deprecation", () => {
    expect(validateConstitutionEvolution(prior, [rule(), rule({ id: "new-rule", text: "New invariant." })]).size).toBe(2);
    expect(validateConstitutionEvolution(prior, [rule({ version: 2, text: "Clarified invariant." })]).get("stable-rule")?.version).toBe(2);
    expect(validateConstitutionEvolution(prior, [rule({ version: 2, status: "deprecated" })]).get("stable-rule")?.status).toBe("deprecated");
  });

  it("rejects deletion, ID reuse, reactivation, and version errors", () => {
    expect(() => validateConstitutionEvolution(prior, [])).toThrow(/cannot be deleted/);
    expect(() => validateConstitutionEvolution(prior, [rule({ id: "replacement" })])).toThrow(/cannot be deleted/);
    expect(() => validateConstitutionEvolution(prior, [rule({ text: "Changed." })])).toThrow(/increment/);
    expect(() => validateConstitutionEvolution(prior, [rule({ version: 2 })])).toThrow(/retain/);
    const deprecated = new Map([["stable-rule", rule({ version: 2, status: "deprecated" })]]);
    expect(() => validateConstitutionEvolution(deprecated, [rule({ version: 3, status: "active" })])).toThrow(/reactivated/);
  });
});
