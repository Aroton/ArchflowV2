import { constants } from "node:fs";
import { access, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import { planConstitutionScaffold, type ConstitutionMigration } from "./constitution.js";

const ARCHFLOW_GITATTRIBUTES_LINE = ".archflow/** -text merge=binary";
const ASSETS = Object.freeze([
  ["archflow.gitignore", ".archflow/.gitignore"],
  ["workflow.yaml", ".archflow/workflow.yaml"],
  ["hazards.yaml", ".archflow/hazards.yaml"],
  ["constitution/README.md", ".archflow/constitution/README.md"],
  ["constitution/custom/README.md", ".archflow/constitution/custom/README.md"],
  ["constitution/default/00-process.md", ".archflow/constitution/default/00-process.md"],
  ["constitution/default/10-architecture.md", ".archflow/constitution/default/10-architecture.md"],
  ["constitution/default/15-dependencies.md", ".archflow/constitution/default/15-dependencies.md"],
  ["constitution/default/20-data.md", ".archflow/constitution/default/20-data.md"],
  ["constitution/default/25-database.md", ".archflow/constitution/default/25-database.md"],
  ["constitution/default/30-product.md", ".archflow/constitution/default/30-product.md"],
  ["constitution/default/35-plan-changes.md", ".archflow/constitution/default/35-plan-changes.md"],
  ["constitution/default/45-public-contracts.md", ".archflow/constitution/default/45-public-contracts.md"],
  ["constitution/default/40-authentication.md", ".archflow/constitution/default/40-authentication.md"],
  ["constitution/default/50-cryptography.md", ".archflow/constitution/default/50-cryptography.md"],
  ["constitution/default/60-control-plane.md", ".archflow/constitution/default/60-control-plane.md"],
  ["config.template.yaml", ".archflow/config.yaml"],
] as const);

export type AssetScaffoldReport = {
  readonly schema_version: "1";
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  /** Diverged assets replaced with the shipped bytes; only ever non-empty under `force`. */
  readonly overwritten: readonly string[];
  readonly preserved_custom: readonly string[];
  readonly constitution_migration: ConstitutionMigration;
  readonly policy_notice: string;
  readonly gitattributes_updated: boolean;
  readonly runtime_gitignore: "created" | "already-present";
};

export type ScaffoldRepositoryAssetsInput = {
  readonly working_directory: string;
  /** Overwrite diverged scaffold files with the shipped template instead of refusing. */
  readonly force?: boolean;
};

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function ioFailure(): ProjectResult<never> {
  return fail(createProjectError("IO_ERROR", {
    operation: "scaffold-repository-assets",
    attempt: 1,
  }));
}

/** Resolves the installed bundle's asset directory (source-tree sibling layout in tests). */
export async function assetRoot(): Promise<string> {
  // In the install root, `dist/archflow-local.mjs` and `assets/` are siblings. The second candidate
  // is the source-tree layout used by the test suite and disappears from the shipped bundle.
  const candidates = [
    fileURLToPath(new URL("../assets/", import.meta.url)),
    fileURLToPath(new URL("../../assets/", import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "workflow.yaml"), constants.R_OK);
      return candidate;
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
    }
  }
  throw Object.assign(new Error("installed ArchFlow assets are missing"), { code: "ENOENT" });
}

async function appendGitAttributes(workingDirectory: string): Promise<boolean> {
  const path = join(workingDirectory, ".gitattributes");
  let current: Uint8Array;
  try {
    current = new Uint8Array(await readFile(path));
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(`${ARCHFLOW_GITATTRIBUTES_LINE}\n`);
    } finally {
      await handle.close();
    }
    return true;
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(current);
  if (text.split(/\r?\n/u).includes(ARCHFLOW_GITATTRIBUTES_LINE)) return false;
  const prefix = current.byteLength === 0 || text.endsWith("\n") ? "" : "\n";
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${prefix}${ARCHFLOW_GITATTRIBUTES_LINE}\n`);
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Scaffolds the repository-owned policy assets. Existing bytes are never overwritten unless
 * `force` is set, in which case shipped defaults and other scaffold assets are refreshed.
 * Custom policy is preserved, and legacy flat rules migrate only on an explicit forced refresh.
 */
export async function scaffoldRepositoryAssets(
  input: ScaffoldRepositoryAssetsInput,
): Promise<ProjectResult<AssetScaffoldReport>> {
  try {
    const sourceRoot = await assetRoot();
    const sources = await Promise.all(ASSETS.map(async ([source, destination]) =>
      Object.freeze({ source: new Uint8Array(await readFile(join(sourceRoot, source))), destination })));
    let constitution;
    try {
      constitution = await planConstitutionScaffold(input.working_directory, sources, input.force === true);
    } catch (error) {
      process.stderr.write(`ArchFlow constitution preflight failed: ${error instanceof Error ? error.message : "unreadable rules"}\n`);
      return fail(createProjectError("CONFIG_INVALID", { issue_code: "constitution-scaffold-invalid" }));
    }
    const plannedAssets = [...sources, ...constitution.additional_assets];
    const created: string[] = [];
    const unchanged: string[] = [];
    const overwritten: string[] = [];
    const preservedCustom = [...constitution.preserved_custom];

    // Inspect every destination before writing any of them. A divergent scaffold is a refusal
    // unless forced, while an identical existing asset is already the desired state.
    for (const asset of plannedAssets) {
      const destination = join(input.working_directory, asset.destination);
      try {
        const existing = new Uint8Array(await readFile(destination));
        if (asset.destination === ".archflow/constitution/custom/README.md") {
          preservedCustom.push(asset.destination);
          continue;
        }
        if (Buffer.from(existing).equals(Buffer.from(asset.source))) {
          unchanged.push(asset.destination);
        } else if (input.force === true) {
          overwritten.push(asset.destination);
        } else {
          process.stderr.write(
            `ArchFlow scaffold differs at ${asset.destination}. Review or delete that file, or re-run archflow-local init --force to overwrite every diverged scaffold file.\n`,
          );
          return fail(createProjectError("CONFIG_INVALID", { issue_code: "scaffold-diverged" }));
        }
      } catch (error) {
        if (!errno(error, "ENOENT")) throw error;
      }
    }

    for (const asset of plannedAssets) {
      if (unchanged.includes(asset.destination) || preservedCustom.includes(asset.destination)) continue;
      const destination = join(input.working_directory, asset.destination);
      const replacing = overwritten.includes(asset.destination);
      await mkdir(dirname(destination), { recursive: true });
      const handle = await open(destination, replacing ? "w" : "wx");
      try {
        await handle.writeFile(asset.source);
      } finally {
        await handle.close();
      }
      if (!replacing) created.push(asset.destination);
    }

    // Remove flat sources only after every destination exists. A retry can finish a partial
    // migration without overwriting a custom destination with different bytes.
    for (const path of [...constitution.migration.replaced, ...constitution.migration.moved.map(({ from }) => from)]) {
      await unlink(join(input.working_directory, path));
    }

    const gitattributesUpdated = await appendGitAttributes(input.working_directory);
    return ok(Object.freeze({
      schema_version: "1",
      created: Object.freeze(created),
      unchanged: Object.freeze(unchanged),
      overwritten: Object.freeze(overwritten),
      preserved_custom: Object.freeze(preservedCustom.sort()),
      constitution_migration: constitution.migration,
      policy_notice: "Defaults come from the running bundle. Commit repository policy changes before starting affected tasks. Existing tasks keep their pinned policy, task-local config, and pending approvals. init --force also refreshes other scaffold files, including .archflow/config.yaml; custom/ is preserved.",
      gitattributes_updated: gitattributesUpdated,
      runtime_gitignore: created.includes(".archflow/.gitignore") ? "created" : "already-present",
    }));
  } catch {
    return ioFailure();
  }
}
