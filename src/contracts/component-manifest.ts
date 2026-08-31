import { z } from "zod";

import { canonicalJsonDigest } from "./canonical.js";
import { repositoryNameV1Schema, type RepositoryName } from "./config.js";
import type { Sha256Digest } from "./evidence.js";
import { repositoryPathClaimV1Schema, type RepositoryPathClaim } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";

export type PhaseDesignComponentRepositoryV1 = {
  readonly name: "primary" | RepositoryName;
  readonly paths: readonly RepositoryPathClaim[];
};

export type PhaseDesignComponentV1 = {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly mechanism: string;
  readonly repositories: readonly PhaseDesignComponentRepositoryV1[];
  readonly verification: string;
};

export type PhaseDesignComponentManifestV1 = {
  readonly schema_version: "1";
  readonly components: readonly PhaseDesignComponentV1[];
};

const componentIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "component id must be kebab-case");
const nonblank = z.string().min(1).regex(/\S/u, "must contain a non-whitespace character");
const repositoryName = z.union([z.literal("primary"), repositoryNameV1Schema]);
const componentRepositorySchema = z.object({
  name: repositoryName,
  paths: z.array(repositoryPathClaimV1Schema).min(1),
}).strict();
const componentSchema = z.object({
  id: componentIdSchema,
  name: nonblank,
  scope: nonblank,
  mechanism: nonblank,
  repositories: z.array(componentRepositorySchema).min(1),
  verification: nonblank,
}).strict();
export const phaseDesignComponentManifestV1Schema = z.object({
  schema_version: z.literal("1"),
  components: z.array(componentSchema).min(1),
}).strict() as z.ZodType<PhaseDesignComponentManifestV1>;

const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function requireSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (ordinal(values[index - 1]!, values[index]!) >= 0) {
      throw new TypeError(`${label} must be ordinal-sorted with no duplicates`);
    }
  }
}

function requireRepositoryOrder(
  repositories: readonly PhaseDesignComponentRepositoryV1[],
  knownRepositories: ReadonlySet<string>,
  label: string,
): void {
  const names = repositories.map((repository) => repository.name);
  if (names[0] !== "primary") throw new TypeError(`${label} must place primary first`);
  requireSortedUnique(names.slice(1), `${label} secondary repositories`);
  if (new Set(names).size !== names.length) throw new TypeError(`${label} repository names must not repeat`);
  for (const repository of repositories) {
    if (!knownRepositories.has(repository.name)) {
      throw new TypeError(`${label} names unknown repository ${repository.name}`);
    }
    requireSortedUnique(repository.paths, `${label} ${repository.name} paths`);
  }
}

/** Validates and materializes an already extracted component manifest exactly once. */
export function parsePhaseDesignComponentManifestV1(
  value: unknown,
  resolvedRepositoryNames: readonly ("primary" | RepositoryName)[],
): PhaseDesignComponentManifestV1 {
  assertPlainJson(value, "phase design component manifest");
  const materialized = structuredClone(value);
  const parsed = phaseDesignComponentManifestV1Schema.parse(materialized);
  const componentIds = parsed.components.map((component) => component.id);
  if (new Set(componentIds).size !== componentIds.length) throw new TypeError("component ids must not repeat");
  const known = new Set<string>(resolvedRepositoryNames);
  if (!known.has("primary")) throw new TypeError("resolved repository set must contain primary");
  for (const component of parsed.components) {
    requireRepositoryOrder(component.repositories, known, `component ${component.id} repositories`);
  }
  return structuredClone(parsed);
}

const SECTION = "## Implementation Components";
const OPEN = "```archflow-components-v1";
const CLOSE = "```";
const MAX_MANIFEST_SCAN_LINES = 20_000;

/** Extracts exactly one fenced component document using a bounded, line-oriented scan. */
export function extractPhaseDesignComponentManifest(
  markdown: string,
  resolvedRepositoryNames: readonly ("primary" | RepositoryName)[],
): PhaseDesignComponentManifestV1 {
  if (typeof markdown !== "string") throw new TypeError("phase design must be a string");
  const lines = markdown.split(/\r?\n/u);
  if (lines.length > MAX_MANIFEST_SCAN_LINES) throw new TypeError("phase design exceeds the component manifest scan bound");
  const sections = lines.flatMap((line, index) => line === SECTION ? [index] : []);
  if (sections.length !== 1) throw new TypeError(`phase design must contain exactly one ${SECTION} section`);
  const nextH2 = lines.findIndex((line, index) => index > sections[0]! && /^##\s/u.test(line));
  const end = nextH2 === -1 ? lines.length : nextH2;
  const openings = lines.flatMap((line, index) => line === OPEN ? [index] : []);
  if (openings.length !== 1) throw new TypeError(`phase design ${SECTION} section must contain exactly one ${OPEN} fence`);
  if (openings[0]! <= sections[0]! || openings[0]! >= end) {
    throw new TypeError(`phase design ${SECTION} section must contain the ${OPEN} fence`);
  }
  const close = lines.findIndex((line, index) => index > openings[0]! && index < end && line === CLOSE);
  if (close === -1) throw new TypeError("phase design component manifest fence is unclosed");
  const yaml = lines.slice(openings[0]! + 1, close).join("\n");
  return parsePhaseDesignComponentManifestV1(
    parseSingleYamlDocument(yaml, "phase design component manifest"),
    resolvedRepositoryNames,
  );
}

export function phaseDesignComponentManifestDigest(manifest: PhaseDesignComponentManifestV1): Sha256Digest {
  return canonicalJsonDigest(manifest);
}
