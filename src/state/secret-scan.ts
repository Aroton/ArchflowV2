import { extname } from "node:path";

import { lintSource } from "@secretlint/core";
import { rules as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";
import type { SecretLintCoreConfigRule } from "@secretlint/types";

import { canonicalJsonDigest } from "../contracts/canonical.js";
import { parseSafeCode, parseSafeId, parseSafeInteger } from "../contracts/evidence.js";
import type { PathClass, RepositoryPathClaim } from "../contracts/path-claims.js";
import type {
  SecretScanCandidate,
  SecretScanResult,
  SecretScanner,
  SecretFinding,
} from "../contracts/secret-scan.js";

const FILTER_RULE = "@secretlint/secretlint-rule-filter-comments";
const RULE_PREFIX = "@secretlint/secretlint-rule-";
const RULE_ID = /^@secretlint\/secretlint-rule-(?<suffix>[a-z0-9][a-z0-9-]*)$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const enabledCreators = recommendedRules.filter((creator) => creator.meta.id !== FILTER_RULE);
const enabledRuleIds = Object.freeze(enabledCreators.map((creator) => creator.meta.id).sort());

if (new Set(enabledRuleIds).size !== enabledRuleIds.length ||
    enabledRuleIds.some((id) => !RULE_ID.test(id))) {
  throw new TypeError("Secretlint preset exported duplicate or unsupported public rule identifiers");
}

/** Public for adapter tests; filter-comments is intentionally absent. */
export const SECRETLINT_ENABLED_RULE_IDS: readonly string[] = enabledRuleIds;

export const SECRETLINT_DETECTOR_SET_ID = parseSafeId(`secretlint:v1:${canonicalJsonDigest({
  schema_version: "1",
  core: "@secretlint/core@13.0.4",
  preset: "@secretlint/secretlint-rule-preset-recommend@13.0.4",
  enabled_rule_ids: enabledRuleIds,
  omitted_rule_id: FILTER_RULE,
  id_map_version: "1",
  byte_transform_version: "utf8-or-latin1-v1",
})}`);

export type ByteSecretScanCandidate = Readonly<{
  virtual_path: RepositoryPathClaim;
  path_class: PathClass;
  bytes: Uint8Array;
}>;

/** Strict UTF-8 when possible; otherwise a byte-for-code-unit Latin-1 view with no replacement. */
export function secretScanText(bytes: Uint8Array): string {
  const materialized = new Uint8Array(bytes);
  try {
    return utf8.decode(materialized);
  } catch {
    let text = "";
    for (const byte of materialized) text += String.fromCharCode(byte);
    return text;
  }
}

/** Materializes caller-owned bytes once before adapting to the stable public scanner contract. */
export function secretScanCandidateFromBytes(candidate: ByteSecretScanCandidate): SecretScanCandidate {
  return Object.freeze({
    virtual_path: candidate.virtual_path,
    path_class: candidate.path_class,
    content: secretScanText(candidate.bytes),
  });
}

function mappedDetectorId(upstreamId: string): ReturnType<typeof parseSafeId> {
  const match = RULE_ID.exec(upstreamId);
  if (match?.groups?.["suffix"] === undefined || !upstreamId.startsWith(RULE_PREFIX)) {
    throw new TypeError("Secretlint returned an unknown rule identifier");
  }
  return parseSafeId(`secretlint:${match.groups["suffix"]}`);
}

function sourceExtension(path: RepositoryPathClaim): string {
  const extension = extname(path).toLowerCase();
  return extension === ".p12" ? "" : extension;
}

const configRules: SecretLintCoreConfigRule[] = enabledCreators.map((creator) => ({
  id: creator.meta.id,
  rule: creator,
}));

export function createSecretlintScanner(): SecretScanner {
  const scan = async (suppliedCandidates: readonly SecretScanCandidate[]): Promise<SecretScanResult> => {
      const candidates = suppliedCandidates.map((candidate: SecretScanCandidate) => Object.freeze({
        virtual_path: candidate.virtual_path,
        path_class: candidate.path_class,
        content: String(candidate.content),
      }));
      const seen = new Set<string>();
      const findings: SecretFinding[] = [];
      try {
        for (const candidate of candidates.sort((left, right) => ordinal(left.virtual_path, right.virtual_path))) {
          if (seen.has(candidate.virtual_path)) throw new TypeError("duplicate secret-scan candidate path");
          seen.add(candidate.virtual_path);
          const extension = sourceExtension(candidate.virtual_path);
          const result = await lintSource({
            source: {
              content: candidate.content,
              contentType: "unknown",
              filePath: `/__archflow_secret_scan__/candidate${extension}`,
              ...(extension === "" ? {} : { ext: extension }),
            },
            options: {
              noPhysicFilePath: true,
              maskSecrets: true,
              config: { rules: configRules },
            },
          });
          for (const message of result.messages) {
            if (message.type !== "message") continue;
            // Construct a fresh object. Never spread or retain message/data/source/content.
            findings.push(Object.freeze({
              detector_id: mappedDetectorId(message.ruleId),
              path_class: candidate.path_class,
              virtual_path: candidate.virtual_path,
              line: parseSafeInteger(message.loc.start.line),
              column: parseSafeInteger(message.loc.start.column + 1),
            }));
          }
        }
      } catch {
        return Object.freeze({
          schema_version: "1" as const,
          outcome: "unavailable" as const,
          reason: parseSafeCode("secretlint-unavailable"),
        });
      }
      if (findings.length > 0) {
        findings.sort((left, right) =>
          ordinal(left.virtual_path, right.virtual_path) ||
          left.line - right.line || left.column - right.column ||
          ordinal(left.detector_id, right.detector_id));
        return Object.freeze({
          schema_version: "1" as const,
          outcome: "detected" as const,
          detector_set_id: SECRETLINT_DETECTOR_SET_ID,
          findings: Object.freeze(findings),
        });
      }
      return Object.freeze({
        schema_version: "1" as const,
        outcome: "clean" as const,
        detector_set_id: SECRETLINT_DETECTOR_SET_ID,
        scanned_paths: Object.freeze([...seen].sort()) as readonly RepositoryPathClaim[],
      });
  };
  return Object.freeze({
    scan,
  });
}
