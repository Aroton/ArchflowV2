import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PhaseDesignComponentManifestV1 } from "../../src/contracts/component-manifest.js";
import {
  captureHazardRegistryInput,
  hazardPathOverlaps,
  parseHazardRegistryYaml,
} from "../../src/contracts/hazard-registry.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const readRegistry = (root: string) => async (): Promise<Uint8Array | undefined> => {
  try {
    return new Uint8Array(await readFile(join(root, ".archflow", "hazards.yaml")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const manifest: PhaseDesignComponentManifestV1 = {
  schema_version: "1",
  components: [{
    id: "api-change",
    name: "API change",
    scope: "Change API.",
    mechanism: "Reuse router.",
    repositories: [{ name: "primary", paths: [parseRepositoryPathClaim("src/api")] }],
    verification: "Run tests.",
  }],
};

describe("hazard registry", () => {
  it("matches only equal or segment-descendant paths and derives the maximum E floor", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-hazards-"));
    roots.push(root);
    await mkdir(join(root, ".archflow"));
    await writeFile(join(root, ".archflow", "hazards.yaml"), `schema_version: "1"
hazards:
  - repository: primary
    path: src
    score: 1
    reason: Shared source risk.
  - repository: primary
    path: src/api/auth.ts
    score: 3
    reason: Authentication boundary.
  - repository: primary
    path: src/apishadow
    score: 2
    reason: Similar prefix only.
`);

    const input = await captureHazardRegistryInput(readRegistry(root), ["primary"], manifest);
    expect(input.state).toBe("present");
    expect(input.components[0]?.matches.map((entry) => entry.path)).toEqual(["src", "src/api/auth.ts"]);
    expect(input.components[0]?.e_floor).toBe(3);
    expect(hazardPathOverlaps(parseRepositoryPathClaim("src/api"), parseRepositoryPathClaim("src/apishadow"))).toBe(false);
  });

  it("distinguishes an absent registry from an existing empty registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-hazards-"));
    roots.push(root);
    const absent = await captureHazardRegistryInput(readRegistry(root), ["primary"], manifest);
    expect(absent.state).toBe("absent");
    expect(absent.components[0]?.e_floor).toBe("unmatched");
    await mkdir(join(root, ".archflow"));
    await writeFile(join(root, ".archflow", "hazards.yaml"), "schema_version: \"1\"\nhazards: []\n");
    const present = await captureHazardRegistryInput(readRegistry(root), ["primary"], manifest);
    expect(present.state).toBe("present");
    expect(present.registry_digest).not.toBe(absent.registry_digest);
  });

  it("reads the registry exactly once and propagates unreadable input", async () => {
    let reads = 0;
    await expect(captureHazardRegistryInput(async () => {
      reads += 1;
      throw new Error("registry unreadable");
    }, ["primary"], manifest)).rejects.toThrow(/registry unreadable/u);
    expect(reads).toBe(1);
  });

  it("rejects invalid, unknown, duplicate, and unsorted entries", () => {
    expect(() => parseHazardRegistryYaml("schema_version: \"1\"\nhazards: nope\n", ["primary"])).toThrow();
    const entry = "  - repository: missing\n    path: src\n    score: 1\n    reason: Risk.\n";
    expect(() => parseHazardRegistryYaml(`schema_version: "1"\nhazards:\n${entry}`, ["primary"]))
      .toThrow(/unknown repository/u);
    const unsorted = `schema_version: "1"
hazards:
  - repository: primary
    path: z
    score: 1
    reason: Z.
  - repository: primary
    path: a
    score: 1
    reason: A.
`;
    expect(() => parseHazardRegistryYaml(unsorted, ["primary"])).toThrow(/ordinal-sorted/u);
  });
});
