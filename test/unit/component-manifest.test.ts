import { describe, expect, it } from "vitest";

import {
  extractPhaseDesignComponentManifest,
  phaseDesignComponentManifestDigest,
} from "../../src/contracts/component-manifest.js";

const document = (body: string): string => `# Phase\n\n## Implementation Components\n\n\`\`\`archflow-components-v1\n${body}\n\`\`\`\n`;
const valid = `schema_version: "1"
components:
  - id: api-change
    name: API change
    scope: Change one endpoint.
    mechanism: Reuse the router.
    repositories:
      - name: primary
        paths:
          - src/api.ts
      - name: web
        paths:
          - src/client.ts
    verification: Run the focused test.`;

describe("phase design component manifests", () => {
  it("extracts one exact fence and returns a stable canonical digest", () => {
    const parsed = extractPhaseDesignComponentManifest(document(valid), ["primary", "web"]);
    expect(parsed.components[0]?.id).toBe("api-change");
    expect(phaseDesignComponentManifestDigest(parsed)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["missing section", `# Phase\n\n\`\`\`archflow-components-v1\n${valid}\n\`\`\`\n`],
    ["duplicate section", `${document(valid)}\n${document(valid)}`],
    ["unclosed fence", document(valid).replace(/```\n$/u, "")],
  ])("rejects %s", (_label, source) => {
    expect(() => extractPhaseDesignComponentManifest(source, ["primary", "web"])).toThrow();
  });

  it("rejects IDs, paths, repositories, and ordering that are not exact", () => {
    expect(() => extractPhaseDesignComponentManifest(document(valid.replace("api-change", "API_change")), ["primary", "web"]))
      .toThrow(/kebab-case/u);
    expect(() => extractPhaseDesignComponentManifest(document(valid.replace("src/api.ts", "../api.ts")), ["primary", "web"]))
      .toThrow();
    expect(() => extractPhaseDesignComponentManifest(document(valid.replace("name: web", "name: missing")), ["primary", "web"]))
      .toThrow(/unknown repository/u);
    expect(() => extractPhaseDesignComponentManifest(document(valid.replace("          - src/client.ts", "          - z.ts\n          - a.ts")), ["primary", "web"]))
      .toThrow(/ordinal-sorted/u);
    expect(() => extractPhaseDesignComponentManifest(document(valid.replace(
      "    verification: Run the focused test.",
      `    verification: Run the focused test.\n  - id: api-change\n    name: Duplicate\n    scope: Duplicate.\n    mechanism: Duplicate.\n    repositories:\n      - name: primary\n        paths:\n          - src/other.ts\n    verification: Duplicate.`,
    )), ["primary", "web"])).toThrow(/must not repeat/u);
  });
});
