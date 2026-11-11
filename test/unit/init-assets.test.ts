import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

/** Asset basenames the mocked filesystem reports as absent, to prove init never needs them. */
const absentAssets = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const hide = (path: unknown): void => {
    if (typeof path === "string" && path.includes("/assets/") && absentAssets.has(basename(path))) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
  };
  return {
    ...actual,
    access: async (path: Parameters<typeof actual.access>[0], mode?: number) => {
      hide(path);
      return actual.access(path, mode);
    },
    readFile: (async (path: Parameters<typeof actual.readFile>[0], options?: Parameters<typeof actual.readFile>[1]) => {
      hide(path);
      return actual.readFile(path, options);
    }) as typeof actual.readFile,
  };
});

import { assetRoot, scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { parseConfigYaml } from "../../src/contracts/config.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  absentAssets.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "archflow-init-assets-"));
  roots.push(root);
  return root;
}

const customRule = (id = "billing", version = 1) =>
  `---\nid: ${id}\nversion: ${version}\nstatus: active\nreview_trigger: Invoice totals change.\n---\nPreserve agreed pricing.\n`;

function filesUnder(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

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
    write(root, ".archflow/config.yaml", "keep this until preflight succeeds\n");
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
    expect(readFileSync(join(root, ".archflow/config.yaml"), "utf8")).toBe("keep this until preflight succeeds\n");
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

  it("scaffolds exactly config.yaml, the constitution, and .archflow/.gitignore with shipped bytes", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitattributes"), "* text=auto");

    const first = await scaffoldRepositoryAssets({ working_directory: root });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const shippedConstitution = filesUnder(fileURLToPath(new URL("../../assets/", import.meta.url)), "constitution")
      .map((path) => `.archflow/${path}`);
    expect(filesUnder(root, ".archflow")).toEqual(
      [".archflow/.gitignore", ".archflow/config.yaml", ...shippedConstitution].sort(),
    );
    expect(readdirSync(root).sort()).toEqual([".archflow", ".gitattributes"]);
    expect([...first.value.created].sort()).toEqual(filesUnder(root, ".archflow"));
    expect(first.value.runtime_gitignore).toBe("created");
    expect(readFileSync(join(root, ".archflow", "config.yaml"))).toEqual(
      readFileSync(new URL("../../assets/config.template.yaml", import.meta.url)),
    );
    for (const path of ["00-process.md", "10-architecture.md", "25-database.md", "35-plan-changes.md", "45-public-contracts.md"] as const) {
      expect(readFileSync(join(root, ".archflow", "constitution", "default", path))).toEqual(
        readFileSync(new URL(`../../assets/constitution/default/${path}`, import.meta.url)),
      );
    }
    expect(readFileSync(join(root, ".archflow", ".gitignore"), "utf8")).toBe("/runtime/\n");
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe("* text=auto");

    const second = await scaffoldRepositoryAssets({ working_directory: root });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.created).toEqual([]);
    expect(second.value.unchanged).toHaveLength(first.value.created.length - 1);
    expect(second.value.preserved_custom).toEqual([".archflow/constitution/custom/README.md"]);
    expect(second.value.runtime_gitignore).toBe("already-present");
  });

  it("resolves the asset root and scaffolds without workflow.yaml or hazards.yaml in the assets", async () => {
    absentAssets.add("workflow.yaml");
    absentAssets.add("hazards.yaml");
    const root = repository();

    await expect(assetRoot()).resolves.toMatch(/assets\/$/u);
    const result = await scaffoldRepositoryAssets({ working_directory: root });

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, ".archflow", "config.yaml"))).toBe(true);
  });

  it("names every searched directory and refuses without a retry when the installed assets are missing", async () => {
    absentAssets.add("config.template.yaml");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const root = repository();

    await expect(assetRoot()).rejects.toThrow(/^installed ArchFlow assets are missing: looked in \/.+\/assets\/, \/.+\/assets\/$/u);
    const result = await scaffoldRepositoryAssets({ working_directory: root });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", retryable: false, diagnostic: { parameters: { issue_code: "installed-assets-missing" } } },
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^installed ArchFlow assets are missing: looked in .+\. Reinstall ArchFlow to restore them\.\n$/u));
    expect(existsSync(join(root, ".archflow"))).toBe(false);
  });

  it("leaves legacy workflow files from earlier inits in place", async () => {
    const root = repository();
    write(root, ".archflow/workflow.yaml", "human edit\n");
    write(root, ".archflow/hazards.yaml", "hazards: []\n");

    const result = await scaffoldRepositoryAssets({ working_directory: root });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, ".archflow/workflow.yaml"), "utf8")).toBe("human edit\n");
    expect(readFileSync(join(root, ".archflow/hazards.yaml"), "utf8")).toBe("hazards: []\n");
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

    // Only phase-design and phase-impl subjects ever match a review; prd and design are legacy values
    // an older repository config may still carry, so the comparison is over the rules that apply.
    const applied = (config: typeof template) => ({
      subjects: config.approval_rules?.subjects.filter((subject) => subject === "phase-design" || subject === "phase-impl"),
      content: config.approval_rules?.content,
    });
    expect(applied(repositoryConfig)).toEqual(applied(template));
    expect(template.approval_rules).toEqual({
      subjects: [],
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
    const readme = join(root, ".archflow", "constitution", "README.md");
    mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
    writeFileSync(readme, "human edit\n");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await scaffoldRepositoryAssets({ working_directory: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.diagnostic.parameters).toEqual({ issue_code: "scaffold-diverged" });
    expect(stderr).toHaveBeenCalledWith(
      "ArchFlow scaffold differs at .archflow/constitution/README.md. Review or delete that file, or re-run archflow-local init --force to overwrite every diverged scaffold file.\n",
    );
    expect(readFileSync(readme, "utf8")).toBe("human edit\n");
    expect(() => readFileSync(join(root, ".archflow", "config.yaml"))).toThrow();
  });

  it("overwrites every diverged asset under force, creates the rest, and reports each set", async () => {
    const root = repository();
    mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
    const gitignore = join(root, ".archflow", ".gitignore");
    const readme = join(root, ".archflow", "constitution", "README.md");
    writeFileSync(gitignore, "human edit\n");
    writeFileSync(readme, "stale template\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await scaffoldRepositoryAssets({ working_directory: root, force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stderr).not.toHaveBeenCalled();
    expect(result.value.overwritten).toEqual([".archflow/.gitignore", ".archflow/constitution/README.md"]);
    expect(result.value.unchanged).toEqual([]);
    expect(result.value.created).toContain(".archflow/config.yaml");
    const shipped = await assetRoot();
    expect(readFileSync(gitignore)).toEqual(readFileSync(join(shipped, "archflow.gitignore")));
    expect(readFileSync(readme)).toEqual(readFileSync(join(shipped, "constitution", "README.md")));

    const again = await scaffoldRepositoryAssets({ working_directory: root, force: true });
    expect(again.ok && again.value.overwritten).toEqual([]);
    expect(again.ok && again.value.created).toEqual([]);
  });

  it("refuses a pre-existing live config instead of adopting new template defaults", async () => {
    const root = repository();
    const liveConfig = join(root, ".archflow", "config.yaml");
    const existing = "schema_version: \"1\"\nroles: {}\n";
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
    expect(existsSync(join(root, ".archflow", "constitution"))).toBe(false);
  });
});
