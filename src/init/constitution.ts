import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONSTITUTION_RULE_NAME, parseConstitutionRuleFiles } from "../contracts/constitution.js";

export type ConstitutionMigration = Readonly<{
  replaced: readonly string[];
  moved: readonly Readonly<{ from: string; to: string }>[];
}>;

type ScaffoldAsset = Readonly<{ source: Uint8Array; destination: string }>;
const ROOT = ".archflow/constitution/";

/** Preflight the complete effective policy before any scaffold bytes are written. */
export async function planConstitutionScaffold(
  workingDirectory: string,
  assets: readonly ScaffoldAsset[],
  force: boolean,
): Promise<Readonly<{
  migration: ConstitutionMigration;
  additional_assets: readonly ScaffoldAsset[];
  preserved_custom: readonly string[];
}>> {
  const existing = new Map<string, Uint8Array>();
  for (const layer of ["", "default/", "custom/"]) {
    let entries;
    try {
      entries = await readdir(join(workingDirectory, ROOT, layer), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!CONSTITUTION_RULE_NAME.test(entry.name)) continue;
      const path = `${ROOT}${layer}${entry.name}`;
      if (!entry.isFile()) throw new Error(`${path}: constitution rules must be regular files`);
      existing.set(path, new Uint8Array(await readFile(join(workingDirectory, path))));
    }
  }
  const flat = [...existing.keys()].filter((path) => !path.slice(ROOT.length).includes("/")).sort();
  if (flat.length > 0 && !force) {
    throw new Error("Flat constitution rules require explicit migration: archflow-local init --force refreshes known shipped rules and moves additional rules to custom/. It also resets other scaffold files, including .archflow/config.yaml.");
  }
  const shippedNames = new Set(assets
    .filter((asset) => asset.destination.startsWith(`${ROOT}default/`))
    .map((asset) => asset.destination.slice(`${ROOT}default/`.length)));
  const candidate = new Map(existing);
  const replaced: string[] = [];
  const moved: { from: string; to: string }[] = [];
  const additionalAssets: ScaffoldAsset[] = [];
  for (const from of flat) {
    const name = from.slice(ROOT.length);
    if (shippedNames.has(name)) {
      replaced.push(from);
    } else {
      const to = `${ROOT}custom/${name}`;
      const source = existing.get(from)!;
      const destination = existing.get(to);
      // Identical destinations allow retry after a partial copy; conflicting bytes never win.
      if (destination !== undefined && !Buffer.from(destination).equals(source)) {
        throw new Error(`Constitution migration conflicts at ${to}; preserve or reconcile the custom file before retrying`);
      }
      candidate.set(to, source);
      additionalAssets.push({ source, destination: to });
      moved.push({ from, to });
    }
    candidate.delete(from);
  }
  for (const asset of assets) {
    if (asset.destination.startsWith(`${ROOT}default/`)) {
      candidate.set(asset.destination, asset.source);
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  parseConstitutionRuleFiles(Object.fromEntries(
    [...candidate].map(([path, bytes]) => [path, decoder.decode(bytes)]),
  ));
  return {
    migration: { replaced, moved },
    additional_assets: additionalAssets,
    preserved_custom: [...existing.keys()].filter((path) => path.startsWith(`${ROOT}custom/`)).sort(),
  };
}
