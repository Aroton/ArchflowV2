import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  sha256DigestV1Schema,
  taskSlugV1Schema,
  type Sha256Digest,
  type TaskSlug,
} from "../contracts/evidence.js";
import {
  repositoryPathClaimV1Schema,
  type RepositoryPathClaim,
} from "../contracts/path-claims.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import {
  phaseInstanceIdV1Schema,
  type PhaseInstanceId,
} from "../contracts/phase-instance.js";

export type LegacyUpgradeStageDescriptorV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly import_digest: Sha256Digest;
  readonly preview_digest: Sha256Digest;
  readonly manifest_path: RepositoryPathClaim;
  readonly resume_phase: PhaseInstanceId;
};

const legacyUpgradeStageDescriptorV1Schema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  import_digest: sha256DigestV1Schema,
  preview_digest: sha256DigestV1Schema,
  manifest_path: repositoryPathClaimV1Schema,
  resume_phase: phaseInstanceIdV1Schema,
}).strict() as unknown as z.ZodType<LegacyUpgradeStageDescriptorV1>;

export function parseLegacyUpgradeStageDescriptor(value: unknown): LegacyUpgradeStageDescriptorV1 {
  assertPlainJson(value, "legacy upgrade stage descriptor");
  return legacyUpgradeStageDescriptorV1Schema.parse(structuredClone(value));
}

export type LegacyUpgradeStageInspection =
  | { readonly kind: "absent" }
  | {
      readonly kind: "current";
      readonly digests: readonly string[];
      readonly descriptor: LegacyUpgradeStageDescriptorV1;
    }
  | {
      readonly kind: "restart-required";
      readonly digests: readonly string[];
      readonly valid_descriptor_count: number;
    };

const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function expectedManifestPath(taskId: TaskSlug, digest: string): string {
  return `.archflow/runtime/tasks/${taskId}/cache/imports/${digest}/manifest.json`;
}

/**
 * Reads the disposable import-stage cache once for both status and adoption. Only the exact strict
 * descriptor emitted by current staging is reusable; every old, malformed, or ambiguous shape is
 * retained for explicit restart instead of being promoted to producer authority.
 */
export async function inspectLegacyUpgradeStage(
  importsRoot: string,
  taskId: TaskSlug,
): Promise<LegacyUpgradeStageInspection> {
  let digests: string[];
  try {
    digests = (await readdir(importsRoot)).filter((entry) => /^[a-f0-9]{64}$/u.test(entry)).sort(ordinal);
  } catch {
    return Object.freeze({ kind: "absent" as const });
  }
  if (digests.length === 0) return Object.freeze({ kind: "absent" as const });

  const matches: LegacyUpgradeStageDescriptorV1[] = [];
  for (const digest of digests) {
    try {
      const descriptor = parseLegacyUpgradeStageDescriptor(
        JSON.parse(await readFile(join(importsRoot, digest, "stage.json"), "utf8")),
      );
      if (
        descriptor.task_id === taskId &&
        descriptor.import_digest === digest &&
        descriptor.manifest_path === expectedManifestPath(taskId, digest)
      ) {
        matches.push(descriptor);
      }
    } catch {
      // A malformed or pre-fix descriptor is visible staging, but cannot be current authority.
    }
  }

  if (digests.length === 1 && matches.length === 1) {
    return Object.freeze({
      kind: "current" as const,
      digests: Object.freeze([...digests]),
      descriptor: matches[0]!,
    });
  }
  return Object.freeze({
    kind: "restart-required" as const,
    digests: Object.freeze([...digests]),
    valid_descriptor_count: matches.length,
  });
}
