import { z } from "zod";

import { canonicalJsonDigest } from "./canonical.js";
import { repositoryNameV1Schema, type RepositoryName } from "./config.js";
import { sha256DigestV1Schema, type Sha256Digest } from "./evidence.js";
import type { PhaseDesignComponentManifestV1 } from "./component-manifest.js";
import { repositoryPathClaimV1Schema, type RepositoryPathClaim } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";

export type HazardRegistryEntryV1 = {
  readonly repository: "primary" | RepositoryName;
  readonly path: RepositoryPathClaim;
  readonly score: 0 | 1 | 2 | 3;
  readonly reason: string;
};

export type HazardRegistryV1 = {
  readonly schema_version: "1";
  readonly hazards: readonly HazardRegistryEntryV1[];
};

export type ComponentHazardInputV1 = {
  readonly component_id: string;
  readonly matches: readonly HazardRegistryEntryV1[];
  readonly e_floor: 0 | 1 | 2 | 3 | "unmatched";
};

export type HazardRegistryInputV1 = {
  readonly schema_version: "1";
  readonly state: "absent" | "present";
  readonly registry_digest: Sha256Digest;
  readonly hazards: readonly HazardRegistryEntryV1[];
  readonly components: readonly ComponentHazardInputV1[];
};

const repositoryName = z.union([z.literal("primary"), repositoryNameV1Schema]);
export const hazardRegistryEntryV1Schema = z.object({
  repository: repositoryName,
  path: repositoryPathClaimV1Schema,
  score: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  reason: z.string().min(1).regex(/\S/u, "reason must contain a non-whitespace character"),
}).strict();
export const hazardRegistryV1Schema = z.object({
  schema_version: z.literal("1"),
  hazards: z.array(hazardRegistryEntryV1Schema),
}).strict() as z.ZodType<HazardRegistryV1>;
export const componentHazardInputV1Schema = z.object({
  component_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  matches: z.array(hazardRegistryEntryV1Schema),
  e_floor: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal("unmatched")]),
}).strict() as z.ZodType<ComponentHazardInputV1>;
export const hazardRegistryInputV1Schema = z.object({
  schema_version: z.literal("1"),
  state: z.enum(["absent", "present"]),
  registry_digest: sha256DigestV1Schema,
  hazards: z.array(hazardRegistryEntryV1Schema),
  components: z.array(componentHazardInputV1Schema),
}).strict() as unknown as z.ZodType<HazardRegistryInputV1>;

const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const entryKey = (entry: HazardRegistryEntryV1): readonly [string, string, number, string] =>
  [entry.repository, entry.path, entry.score, entry.reason];
function compareEntries(left: HazardRegistryEntryV1, right: HazardRegistryEntryV1): number {
  const a = entryKey(left);
  const b = entryKey(right);
  return ordinal(a[0], b[0]) || ordinal(a[1], b[1]) || a[2] - b[2] || ordinal(a[3], b[3]);
}

export function parseHazardRegistryV1(
  value: unknown,
  resolvedRepositoryNames: readonly ("primary" | RepositoryName)[],
): HazardRegistryV1 {
  assertPlainJson(value, "hazard registry");
  const parsed = hazardRegistryV1Schema.parse(structuredClone(value));
  const known = new Set<string>(resolvedRepositoryNames);
  if (!known.has("primary")) throw new TypeError("resolved repository set must contain primary");
  for (const entry of parsed.hazards) {
    if (!known.has(entry.repository)) throw new TypeError(`hazard registry names unknown repository ${entry.repository}`);
  }
  for (let index = 1; index < parsed.hazards.length; index += 1) {
    if (compareEntries(parsed.hazards[index - 1]!, parsed.hazards[index]!) >= 0) {
      throw new TypeError("hazard registry entries must be ordinal-sorted with no duplicates");
    }
  }
  return structuredClone(parsed);
}

export function parseHazardRegistryYaml(
  source: string,
  resolvedRepositoryNames: readonly ("primary" | RepositoryName)[],
): HazardRegistryV1 {
  return parseHazardRegistryV1(parseSingleYamlDocument(source, ".archflow/hazards.yaml"), resolvedRepositoryNames);
}

/** Segment-aware symmetric overlap: equality or either path being the other's descendant. */
export function hazardPathOverlaps(left: RepositoryPathClaim, right: RepositoryPathClaim): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function matchHazardsToComponents(
  registry: HazardRegistryV1,
  manifest: PhaseDesignComponentManifestV1,
): readonly ComponentHazardInputV1[] {
  return Object.freeze(manifest.components.map((component) => {
    const matches = registry.hazards.filter((entry) => component.repositories.some((repository) =>
      repository.name === entry.repository && repository.paths.some((path) => hazardPathOverlaps(path, entry.path))));
    const floor = matches.length === 0
      ? "unmatched" as const
      : Math.max(...matches.map((entry) => entry.score)) as 0 | 1 | 2 | 3;
    return Object.freeze({ component_id: component.id, matches: Object.freeze(matches), e_floor: floor });
  }));
}

export function createHazardRegistryInput(
  state: "absent" | "present",
  registry: HazardRegistryV1,
  manifest: PhaseDesignComponentManifestV1,
): HazardRegistryInputV1 {
  return Object.freeze({
    schema_version: "1",
    state,
    registry_digest: canonicalJsonDigest({ schema_version: "1", state, registry }),
    hazards: Object.freeze([...registry.hazards]),
    components: matchHazardsToComponents(registry, manifest),
  });
}

/** Captures one caller-supplied read; `undefined` is the only absent spelling. */
export async function captureHazardRegistryInput(
  readRegistry: () => Promise<Uint8Array | undefined>,
  resolvedRepositoryNames: readonly ("primary" | RepositoryName)[],
  manifest: PhaseDesignComponentManifestV1,
): Promise<HazardRegistryInputV1> {
  const bytes = await readRegistry();
  if (bytes === undefined) {
    return createHazardRegistryInput("absent", { schema_version: "1", hazards: [] }, manifest);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const registry = parseHazardRegistryYaml(source, resolvedRepositoryNames);
  return createHazardRegistryInput("present", registry, manifest);
}

export type HazardRegistryDriftV1 =
  | "registry-created"
  | "registry-removed"
  | "registry-changed";

/**
 * Compares a one-read live input with the sealed digest. The manifest makes the absent input
 * reproducible, so created/removed remain distinguishable without retaining duplicate registry
 * bytes in durable state.
 */
export function compareHazardRegistryInput(
  sealedDigest: Sha256Digest,
  live: HazardRegistryInputV1,
  manifest: PhaseDesignComponentManifestV1,
): HazardRegistryDriftV1 | undefined {
  if (live.registry_digest === sealedDigest) return undefined;
  const absentDigest = createHazardRegistryInput(
    "absent",
    { schema_version: "1", hazards: [] },
    manifest,
  ).registry_digest;
  if (sealedDigest === absentDigest && live.state === "present") return "registry-created";
  if (sealedDigest !== absentDigest && live.state === "absent") return "registry-removed";
  return "registry-changed";
}
