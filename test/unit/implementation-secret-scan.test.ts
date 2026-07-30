import { describe, expect, it } from "vitest";

import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import {
  createSecretlintScanner,
  SECRETLINT_ENABLED_RULE_IDS,
  secretScanCandidateFromBytes,
  secretScanText,
} from "../../src/state/secret-scan.js";

describe("Secretlint adapter", () => {
  it("uses strict UTF-8 and falls back to a lossless Latin-1 code-unit view", () => {
    expect(secretScanText(Uint8Array.from([0x68, 0xc3, 0xa9]))).toBe("hé");
    expect([...secretScanText(Uint8Array.from([0xff, 0x00]))].map((value) => value.charCodeAt(0)))
      .toEqual([255, 0]);
  });

  it("registers flat public rules without the comment filter", () => {
    expect(SECRETLINT_ENABLED_RULE_IDS).not.toContain("@secretlint/secretlint-rule-filter-comments");
    expect(new Set(SECRETLINT_ENABLED_RULE_IDS).size).toBe(SECRETLINT_ENABLED_RULE_IDS.length);
  });

  it("returns only safe mapped finding facts and does not honor source directives", async () => {
    const path = parseRepositoryPathClaim("src/config.ts");
    const token = "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';";
    for (const content of [
      `// secretlint-disable\n${token}\n`,
      `// secretlint-disable-next-line\n${token}\n`,
      `// secretlint-disable-next-line @secretlint/secretlint-rule-github\n${token}\n`,
    ]) {
      const result = await createSecretlintScanner().scan([
        secretScanCandidateFromBytes({
          virtual_path: path,
          path_class: "repository-source",
          bytes: new TextEncoder().encode(content),
        }),
      ]);
      expect(result.outcome).toBe("detected");
      if (result.outcome !== "detected") continue;
      expect(result.findings.some((finding) => finding.detector_id === "secretlint:github")).toBe(true);
      for (const finding of result.findings) {
        expect(Object.keys(finding).sort()).toEqual([
          "column", "detector_id", "line", "path_class", "virtual_path",
        ]);
        expect(JSON.stringify(finding)).not.toContain("ghp_");
      }
    }
  });

  it("scans p12-labelled bytes without exposing a physical repository path", async () => {
    const result = await createSecretlintScanner().scan([
      secretScanCandidateFromBytes({
        virtual_path: parseRepositoryPathClaim("credentials/client.p12"),
        path_class: "repository-source",
        bytes: Uint8Array.from([0xff, 0x00, 0x01]),
      }),
    ]);
    expect(result.outcome).toBe("clean");
  });
});
