import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createJsonSchemaValidator } from "../helpers/json-schema.js";

const digest = (character: string): string => character.repeat(64);

const loadSchema = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;

const createManifest = (): Record<string, unknown> => ({
  schema_version: "1",
  bundle_digest: digest("a"),
  dependency_inventory_digest: digest("b"),
  bundle_inputs: [
    {
      key: "node_modules/example/index.js",
      origin: {
        kind: "dependency",
        package_name: "example",
        package_version: "1.2.3",
        package_relative_path: "index.js",
      },
      size: 120,
      digest: digest("c"),
      bytes_in_output: 80,
    },
    {
      key: "src/local/unused.ts",
      origin: { kind: "repository", path: "src/local/unused.ts" },
      size: 40,
      digest: digest("d"),
      bytes_in_output: 0,
    },
    {
      key: "src/local/main.ts",
      origin: { kind: "repository", path: "src/local/main.ts" },
      size: 42,
      digest: digest("e"),
      bytes_in_output: 42,
    },
  ],
  contributing_inputs: ["node_modules/example/index.js", "src/local/main.ts"],
  release_control_inputs: [
    { path: "package-lock.json", size: 10, digest: digest("e") },
    { path: "package.json", size: 20, digest: digest("f") },
  ],
  runtime_assets: [
    { path: "assets/archflow.gitignore", size: 7, digest: digest("6") },
    { path: "assets/config.template.yaml", size: 10, digest: digest("7") },
    { path: "assets/rubrics/simple-plan.yaml", size: 20, digest: digest("8") },
  ],
  dependency_provenance_inputs: [
    {
      package_name: "example",
      package_version: "1.2.3",
      package_relative_path: "package.json",
      purpose: "package-manifest",
      size: 30,
      digest: digest("1"),
    },
    {
      package_name: "example",
      package_version: "1.2.3",
      package_relative_path: "LICENSE",
      purpose: "license",
      size: 50,
      digest: digest("2"),
    },
  ],
  proof_inputs: ["package.json", "test/integration/release-offline.test.ts"],
  declared_content: {
    schemas: ["src/contracts/schemas/v1/release-manifest.schema.json"],
    constitution: [
      "assets/constitution/README.md",
      "assets/constitution/default/00-process.md",
    ],
  },
  build_entries: [
    {
      id: "local-cli",
      role: "local-cli",
      entry_point: "src/local/main.ts",
      output_path: "archflow-local.mjs",
      handler_authority: "local-cli-handler",
    },
  ],
  entry_provenance: [
    {
      id: "local-cli",
      entry_point: "src/local/main.ts",
      output_path: "archflow-local.mjs",
      output_digest: digest("a"),
      contributing_inputs: ["node_modules/example/index.js", "src/local/main.ts"],
      allowed_imports: ["node:fs"],
    },
  ],
  artifacts: [
    { path: "archflow-local.mjs", role: "executable", size: 180, digest: digest("a") },
    { path: "legal/THIRD_PARTY_NOTICES.md", role: "legal-notice", size: 60, digest: digest("4") },
    { path: "manifest.json", role: "manifest" },
    { path: "metafile.json", role: "metafile", size: 90, digest: digest("5") },
  ],
});

describe("release manifest structural authority", () => {
  it("accepts closed physical-input, proof, entry, and artifact records", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    expect(validator.assert(createManifest())).toEqual(expect.any(Object));
  });

  it("retains scanned zero-byte inputs without treating them as contributors", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    const manifest = createManifest();
    expect(validator.assert(manifest)).toEqual(expect.any(Object));
    expect(manifest.contributing_inputs).toEqual(["node_modules/example/index.js", "src/local/main.ts"]);
  });

  it("rejects unknown nested data, non-portable paths, malformed digests, and duplicate authorities", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    const unknown = structuredClone(createManifest());
    (unknown.declared_content as Record<string, unknown>).workflow = "assets/workflow.yaml";
    expect(() => validator.assert(unknown)).toThrow(/additional properties/iu);

    const escaped = structuredClone(createManifest());
    (escaped.release_control_inputs as Array<Record<string, unknown>>)[0]!.path = "../package-lock.json";
    expect(() => validator.assert(escaped)).toThrow(/pattern/iu);

    const badDigest = structuredClone(createManifest());
    badDigest.bundle_digest = "ABC";
    expect(() => validator.assert(badDigest)).toThrow(/pattern/iu);

    const duplicate = structuredClone(createManifest());
    (duplicate.release_control_inputs as unknown[]).push(
      structuredClone((duplicate.release_control_inputs as unknown[])[0]),
    );
    expect(() => validator.assert(duplicate)).toThrow(/x-archflow-unique-by/iu);

    const duplicateRuntimeAsset = structuredClone(createManifest());
    (duplicateRuntimeAsset.runtime_assets as unknown[]).push(
      structuredClone((duplicateRuntimeAsset.runtime_assets as unknown[])[0]),
    );
    expect(() => validator.assert(duplicateRuntimeAsset)).toThrow(/x-archflow-unique-by/iu);
  });

  it("enumerates the manifest without requiring an impossible self-digest", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    const manifest = createManifest();
    const self = (manifest.artifacts as Array<Record<string, unknown>>).find(
      (artifact) => artifact.role === "manifest",
    );
    expect(self).toEqual({ path: "manifest.json", role: "manifest" });

    const circular = structuredClone(manifest);
    const circularSelf = (circular.artifacts as Array<Record<string, unknown>>).find(
      (artifact) => artifact.role === "manifest",
    )!;
    circularSelf.digest = digest("0");
    expect(() => validator.assert(circular)).toThrow(/oneOf|additional properties/iu);
  });

  it("admits exactly one local-cli build entry and no retired launch or source-map evidence", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));

    const secondEntry = structuredClone(createManifest());
    (secondEntry.build_entries as Array<Record<string, unknown>>).push({
      id: "mcp-stdio",
      role: "local-cli",
      entry_point: "src/main.ts",
      output_path: "archflow-mcp.mjs",
      handler_authority: "local-cli-handler",
    });
    expect(() => validator.assert(secondEntry)).toThrow(/maxItems|must NOT have more than 1 item/iu);

    const secondProvenance = structuredClone(createManifest());
    (secondProvenance.entry_provenance as unknown[]).push({
      ...(secondProvenance.entry_provenance as Array<Record<string, unknown>>)[0],
      id: "mcp-stdio",
    });
    expect(() => validator.assert(secondProvenance)).toThrow(/maxItems|must NOT have more than 1 item/iu);

    const mcpRole = structuredClone(createManifest());
    const entry = (mcpRole.build_entries as Array<Record<string, unknown>>)[0]!;
    entry.role = "mcp-stdio";
    entry.handler_authority = "mcp-tool-handler";
    expect(() => validator.assert(mcpRole)).toThrow(/constant/iu);

    for (const retired of ["launch_profile", "adjacent_map_expectations"]) {
      const manifest = structuredClone(createManifest());
      manifest[retired] = retired === "launch_profile" ? { node_major: 24 } : [];
      expect(() => validator.assert(manifest), retired).toThrow(/additional properties/iu);
    }

    const sourceMap = structuredClone(createManifest());
    (sourceMap.dependency_provenance_inputs as Array<Record<string, unknown>>)[1]!.purpose = "source-map";
    expect(() => validator.assert(sourceMap)).toThrow(/allowed values/iu);
  });
});
