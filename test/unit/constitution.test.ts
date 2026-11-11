import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { parseConstitutionRuleFiles, parseConstitutionRuleMarkdown, type ConstitutionRuleV1 } from "../../src/contracts/constitution.js";
import { parseConstitutionRuleV1 } from "../../src/contracts/constitution.js";
import { PlainJsonError } from "../../src/contracts/plain-json.js";

const rule = (overrides: Partial<ConstitutionRuleV1> = {}): ConstitutionRuleV1 => ({ id: "stable-rule", version: 1, status: "active", text: "Preserve the invariant.", ...overrides });

describe("constitution Markdown", () => {
  it("loads every shipped numbered policy with unique IDs", async () => {
    const directory = new URL("../../assets/constitution/default/", import.meta.url);
    const paths = (await readdir(directory)).filter((path) => /^\d\d-.*\.md$/u.test(path));
    const files = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(new URL(path, directory), "utf8")] as const)));
    const registry = parseConstitutionRuleFiles(files);
    expect([...registry.keys()]).toEqual(["explicit-human-authority", "approved-design-before-code", "prefer-established-libraries", "task-and-evidence-isolation", "human-approval-for-database-behavior", "honest-human-centered-outcomes", "human-approval-for-material-plan-changes", "human-approval-for-access-control", "human-approval-for-public-contracts", "human-approval-for-crypto-and-secrets", "human-approval-for-workflow-control-plane"]);
  });

  it("ships review triggers on the intentional human-boundary seed rules", async () => {
    const directory = new URL("../../assets/constitution/default/", import.meta.url);
    const paths = (await readdir(directory)).filter((path) => /^\d\d-.*\.md$/u.test(path));
    const files = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(new URL(path, directory), "utf8")] as const)));
    const triggered = [...parseConstitutionRuleFiles(files).entries()]
      .filter(([, parsed]) => parsed.review_trigger !== undefined)
      .map(([id]) => id)
      .sort();
    expect(triggered).toEqual([
      "human-approval-for-database-behavior",
      "human-approval-for-material-plan-changes",
    ]);
  });

  it("ships the human-boundary rules at their current versions without blanket triggers", async () => {
    const directory = new URL("../../assets/constitution/default/", import.meta.url);
    for (const path of ["40-authentication.md", "45-public-contracts.md", "50-cryptography.md", "60-control-plane.md"]) {
      const current = parseConstitutionRuleMarkdown(await readFile(new URL(path, directory), "utf8"), path);
      expect(current).toMatchObject({ version: 3, status: "active" });
      expect(current.review_trigger).toBeUndefined();
    }
  });

  it("describes shipped rules in the run model without removed workflow mechanics", async () => {
    const directory = new URL("../../assets/constitution/default/", import.meta.url);
    const paths = (await readdir(directory)).filter((path) => /^\d\d-.*\.md$/u.test(path));
    for (const path of paths) {
      const source = await readFile(new URL(path, directory), "utf8");
      expect(source, path).not.toMatch(/workflow\.yaml|phase|PRD|\bgates?\b|pinned|authenticated before-and-after/iu);
    }
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
