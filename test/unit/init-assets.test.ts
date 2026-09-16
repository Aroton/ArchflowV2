import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assetRoot, scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { parseConfigYaml } from "../../src/contracts/config.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "archflow-init-assets-"));
  roots.push(root);
  return root;
}

const customRule = (id = "billing", version = 1) =>
  `---\nid: ${id}\nversion: ${version}\nstatus: active\nreview_trigger: Invoice totals change.\n---\nPreserve agreed pricing.\n`;

function write(root: string, path: string, source: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), source);
}

describe("repository asset scaffolding", () => {
  it("preserves custom overrides and notes while force refreshes defaults and repository config", async () => {
    const root = repository();
    expect((await scaffoldRepositoryAssets({ working_directory: root })).ok).toBe(true);
    const override = ".archflow/constitution/custom/90-public-contracts.md";
    const source = customRule("human-approval-for-public-contracts", 3);
    write(root, override, source);
    write(root, ".archflow/constitution/custom/README.md", "My notes\n");
    write(root, ".archflow/constitution/default/45-public-contracts.md", "outdated default\n");
    write(root, ".archflow/config.yaml", "outdated config\n");
    write(root, ".archflow/tasks/existing/config.yaml", "existing task config\n");
    write(root, ".archflow/tasks/existing/state.json", "existing task state\n");

    const result = await scaffoldRepositoryAssets({ working_directory: root, force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overwritten).toContain(".archflow/constitution/default/45-public-contracts.md");
    expect(result.value.overwritten).toContain(".archflow/config.yaml");
    expect(result.value.preserved_custom).toEqual([override, ".archflow/constitution/custom/README.md"]);
    expect(readFileSync(join(root, override), "utf8")).toBe(source);
    expect(readFileSync(join(root, ".archflow/constitution/custom/README.md"), "utf8")).toBe("My notes\n");
    expect(readFileSync(join(root, ".archflow/tasks/existing/config.yaml"), "utf8")).toBe("existing task config\n");
    expect(readFileSync(join(root, ".archflow/tasks/existing/state.json"), "utf8")).toBe("existing task state\n");
    const refreshed = readFileSync(join(root, ".archflow/constitution/default/45-public-contracts.md"), "utf8");
    expect(refreshed).not.toContain("review_trigger:");
  });

  it("requires explicit flat migration, refreshes shipped filenames, and preserves additional rules", async () => {
    const root = repository();
    const oldDefault = ".archflow/constitution/45-public-contracts.md";
    const oldCustom = ".archflow/constitution/70-billing.md";
    write(root, oldDefault, customRule("human-approval-for-public-contracts"));
    write(root, oldCustom, customRule());
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect((await scaffoldRepositoryAssets({ working_directory: root })).ok).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("explicit migration"));
    expect(existsSync(join(root, ".archflow/config.yaml"))).toBe(false);
    expect(existsSync(join(root, oldDefault))).toBe(true);

    const result = await scaffoldRepositoryAssets({ working_directory: root, force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.constitution_migration).toEqual({
      replaced: [oldDefault], moved: [{ from: oldCustom, to: ".archflow/constitution/custom/70-billing.md" }],
    });
    expect(existsSync(join(root, oldDefault))).toBe(false);
    expect(existsSync(join(root, oldCustom))).toBe(false);
    expect(readFileSync(join(root, ".archflow/constitution/custom/70-billing.md"), "utf8")).toBe(customRule());
    expect(readFileSync(join(root, ".archflow/constitution/default/45-public-contracts.md"), "utf8")).not.toContain("review_trigger:");
    expect((await scaffoldRepositoryAssets({ working_directory: root, force: true })).ok).toBe(true);
  });

  it.each(["conflicting destination", "duplicate ID", "invalid rule"])("preflights %s before replacing any scaffold", async (failure) => {
    const root = repository();
    write(root, ".archflow/workflow.yaml", "keep this until preflight succeeds\n");
    write(root, ".archflow/constitution/70-billing.md", customRule());
    if (failure === "conflicting destination") {
      write(root, ".archflow/constitution/custom/70-billing.md", customRule("different"));
    } else if (failure === "duplicate ID") {
      write(root, ".archflow/constitution/custom/80-billing.md", customRule());
    } else {
      write(root, ".archflow/constitution/custom/80-invalid.md", "invalid rule\n");
    }
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect((await scaffoldRepositoryAssets({ working_directory: root, force: true })).ok).toBe(false);
    expect(readFileSync(join(root, ".archflow/workflow.yaml"), "utf8")).toBe("keep this until preflight succeeds\n");
    expect(existsSync(join(root, ".archflow/constitution/70-billing.md"))).toBe(true);
    expect(existsSync(join(root, ".archflow/constitution/default"))).toBe(false);
  });

  it("resumes migration when a custom rule was already copied without overwriting it", async () => {
    const root = repository();
    write(root, ".archflow/constitution/70-billing.md", customRule());
    write(root, ".archflow/constitution/custom/70-billing.md", customRule());
    expect((await scaffoldRepositoryAssets({ working_directory: root, force: true })).ok).toBe(true);
    expect(existsSync(join(root, ".archflow/constitution/70-billing.md"))).toBe(false);
    expect(readFileSync(join(root, ".archflow/constitution/custom/70-billing.md"), "utf8")).toBe(customRule());
  });

  it("writes exact shipped bytes and appends the attributes rule once", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitattributes"), "* text=auto");

    const first = await scaffoldRepositoryAssets({ working_directory: root });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.created).toHaveLength(17);
    expect(first.value.runtime_gitignore).toBe("created");
    expect(first.value.gitattributes_updated).toBe(true);
    expect(readFileSync(join(root, ".archflow", "workflow.yaml"))).toEqual(
      readFileSync(new URL("../../assets/workflow.yaml", import.meta.url)),
    );
    expect(readFileSync(join(root, ".archflow", "config.yaml"))).toEqual(
      readFileSync(new URL("../../assets/config.template.yaml", import.meta.url)),
    );
    expect(readFileSync(join(root, ".archflow", "hazards.yaml"))).toEqual(
      readFileSync(new URL("../../assets/hazards.yaml", import.meta.url)),
    );
    for (const path of ["00-process.md", "10-architecture.md", "25-database.md", "35-plan-changes.md", "45-public-contracts.md"] as const) {
      expect(readFileSync(join(root, ".archflow", "constitution", "default", path))).toEqual(
        readFileSync(new URL(`../../assets/constitution/default/${path}`, import.meta.url)),
      );
    }
    expect(readFileSync(join(root, ".archflow", ".gitignore"), "utf8")).toBe("/runtime/\n");
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(
      "* text=auto\n.archflow/** -text merge=binary\n",
    );

    const second = await scaffoldRepositoryAssets({ working_directory: root });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.created).toEqual([]);
    expect(second.value.unchanged).toHaveLength(16);
    expect(second.value.runtime_gitignore).toBe("already-present");
    expect(second.value.gitattributes_updated).toBe(false);
    expect(readFileSync(join(root, ".gitattributes"), "utf8").match(/\.archflow\/\*\* -text merge=binary/gu)).toHaveLength(1);
  });

  it("keeps repository and scaffold approval defaults equivalent", () => {
    const template = parseConfigYaml(
      readFileSync(new URL("../../assets/config.template.yaml", import.meta.url), "utf8"),
      "config.template.yaml",
    );
    const repositoryConfig = parseConfigYaml(
      readFileSync(new URL("../../.archflow/config.yaml", import.meta.url), "utf8"),
      ".archflow/config.yaml",
    );

    expect(repositoryConfig.approval_rules).toEqual(template.approval_rules);
    expect(repositoryConfig.approval_rules).toEqual({
      subjects: ["prd", "design"],
      content: [
        { paths: ["**/*.sql"] },
      ],
    });
  });

  it("never reads or edits the repository root gitignore", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitignore"), "human-owned-root-rule\n");

    const result = await scaffoldRepositoryAssets({ working_directory: root });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("human-owned-root-rule\n");
    expect(readFileSync(join(root, ".archflow", ".gitignore"), "utf8")).toBe("/runtime/\n");
  });

  it("refuses a divergent asset without overwriting it or creating other assets", async () => {
    const root = repository();
    const workflow = join(root, ".archflow", "workflow.yaml");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, ".archflow"), { recursive: true });
    writeFileSync(workflow, "human edit\n");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await scaffoldRepositoryAssets({ working_directory: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.diagnostic.parameters).toEqual({ issue_code: "scaffold-diverged" });
    expect(stderr).toHaveBeenCalledWith(
      "ArchFlow scaffold differs at .archflow/workflow.yaml. Review or delete that file, or re-run archflow-local init --force to overwrite every diverged scaffold file.\n",
    );
    expect(readFileSync(workflow, "utf8")).toBe("human edit\n");
    expect(() => readFileSync(join(root, ".archflow", "config.yaml"))).toThrow();
  });

  it("overwrites every diverged asset under force, creates the rest, and reports each set", async () => {
    const root = repository();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
    const workflow = join(root, ".archflow", "workflow.yaml");
    const readme = join(root, ".archflow", "constitution", "README.md");
    writeFileSync(workflow, "human edit\n");
    writeFileSync(readme, "stale template\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await scaffoldRepositoryAssets({ working_directory: root, force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stderr).not.toHaveBeenCalled();
    expect(result.value.overwritten).toEqual([".archflow/workflow.yaml", ".archflow/constitution/README.md"]);
    expect(result.value.unchanged).toEqual([]);
    expect(result.value.created).toContain(".archflow/config.yaml");
    const shipped = await assetRoot();
    expect(readFileSync(workflow)).toEqual(readFileSync(join(shipped, "workflow.yaml")));
    expect(readFileSync(readme)).toEqual(readFileSync(join(shipped, "constitution", "README.md")));

    const again = await scaffoldRepositoryAssets({ working_directory: root, force: true });
    expect(again.ok && again.value.overwritten).toEqual([]);
    expect(again.ok && again.value.created).toEqual([]);
  });

  it("refuses a pre-existing live config instead of adopting new template defaults", async () => {
    const root = repository();
    const liveConfig = join(root, ".archflow", "config.yaml");
    const existing = "schema_version: \"1\"\nroles: {}\n";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, ".archflow"), { recursive: true });
    writeFileSync(liveConfig, existing);

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await scaffoldRepositoryAssets({ working_directory: root });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.diagnostic.parameters).toEqual({ issue_code: "scaffold-diverged" });
    expect(stderr).toHaveBeenCalledWith(
      "ArchFlow scaffold differs at .archflow/config.yaml. Review or delete that file, or re-run archflow-local init --force to overwrite every diverged scaffold file.\n",
    );
    expect(readFileSync(liveConfig, "utf8")).toBe(existing);
    expect(() => readFileSync(join(root, ".archflow", "workflow.yaml"))).toThrow();
  });
});
