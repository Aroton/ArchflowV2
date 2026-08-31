import { constants } from "node:fs";
import { access, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";

const ARCHFLOW_GITATTRIBUTES_LINE = ".archflow/** -text merge=binary";
const ASSETS = Object.freeze([
  ["archflow.gitignore", ".archflow/.gitignore"],
  ["workflow.yaml", ".archflow/workflow.yaml"],
  ["hazards.yaml", ".archflow/hazards.yaml"],
  ["constitution/README.md", ".archflow/constitution/README.md"],
  ["constitution/00-process.md", ".archflow/constitution/00-process.md"],
  ["constitution/10-architecture.md", ".archflow/constitution/10-architecture.md"],
  ["constitution/15-dependencies.md", ".archflow/constitution/15-dependencies.md"],
  ["constitution/20-data.md", ".archflow/constitution/20-data.md"],
  ["constitution/30-product.md", ".archflow/constitution/30-product.md"],
  ["constitution/40-authentication.md", ".archflow/constitution/40-authentication.md"],
  ["constitution/50-cryptography.md", ".archflow/constitution/50-cryptography.md"],
  ["constitution/60-control-plane.md", ".archflow/constitution/60-control-plane.md"],
  ["config.template.yaml", ".archflow/config.yaml"],
] as const);

export type AssetScaffoldReport = {
  readonly schema_version: "1";
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  /** Diverged assets replaced with the shipped bytes; only ever non-empty under `force`. */
  readonly overwritten: readonly string[];
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
 * `force` is set, in which case every diverged asset is replaced with the shipped template.
 */
export async function scaffoldRepositoryAssets(
  input: ScaffoldRepositoryAssetsInput,
): Promise<ProjectResult<AssetScaffoldReport>> {
  try {
    const sourceRoot = await assetRoot();
    const sources = await Promise.all(ASSETS.map(async ([source, destination]) =>
      Object.freeze({ source: new Uint8Array(await readFile(join(sourceRoot, source))), destination })));
    const created: string[] = [];
    const unchanged: string[] = [];
    const overwritten: string[] = [];

    // Inspect every destination before writing any of them. A divergent scaffold is a refusal
    // unless forced, while an identical existing asset is already the desired state.
    for (const asset of sources) {
      const destination = join(input.working_directory, asset.destination);
      try {
        const existing = new Uint8Array(await readFile(destination));
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

    for (const asset of sources) {
      if (unchanged.includes(asset.destination)) continue;
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

    const gitattributesUpdated = await appendGitAttributes(input.working_directory);
    return ok(Object.freeze({
      schema_version: "1",
      created: Object.freeze(created),
      unchanged: Object.freeze(unchanged),
      overwritten: Object.freeze(overwritten),
      gitattributes_updated: gitattributesUpdated,
      runtime_gitignore: created.includes(".archflow/.gitignore") ? "created" : "already-present",
    }));
  } catch {
    return ioFailure();
  }
}
