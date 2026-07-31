import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createJsonSchemaValidator } from "../../src/contracts/validators.js";

const digest = (character: string): string => character.repeat(64);

const loadSchema = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;

const loadReleaseEvidence = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL(`../../release/evidence/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

const evidenceValidator = async (definition: string) => {
  const legalSchema = await loadSchema("release-legal-review");
  return createJsonSchemaValidator(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:archflow:test:${definition}`,
      $ref: `urn:archflow:schema:v1:release-legal-review#/$defs/${definition}`,
    },
    [legalSchema],
  );
};

const createManifest = (): Record<string, unknown> => ({
  schema_version: "1",
  bundle_digest: digest("a"),
  dependency_inventory_digest: digest("b"),
  bundle_inputs: [
    {
      key: "node_modules/example/prebundle.mjs",
      origin: {
        kind: "dependency",
        package_name: "example",
        package_version: "1.2.3",
        package_relative_path: "prebundle.mjs",
      },
      size: 120,
      digest: digest("c"),
      bytes_in_output: 80,
    },
    {
      key: "src/main.ts",
      origin: { kind: "repository", path: "src/main.ts" },
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
  contributing_inputs: ["node_modules/example/prebundle.mjs", "src/local/main.ts"],
  release_control_inputs: [
    { path: "package-lock.json", size: 10, digest: digest("e") },
    { path: "package.json", size: 20, digest: digest("f") },
  ],
  runtime_assets: [
    { path: "assets/config.template.yaml", size: 10, digest: digest("7") },
    { path: "assets/workflow.yaml", size: 20, digest: digest("8") },
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
      package_relative_path: "prebundle.mjs.map",
      purpose: "source-map",
      size: 50,
      digest: digest("2"),
    },
  ],
  adjacent_map_expectations: [
    {
      input_key: "node_modules/example/prebundle.mjs",
      expectation: "present",
      map: {
        package_name: "example",
        package_version: "1.2.3",
        package_relative_path: "prebundle.mjs.map",
        digest: digest("2"),
      },
      reviewed_first_party_roots: ["example/src"],
      recognized_third_party_components: ["fast-uri@3.1.0"],
    },
  ],
  proof_inputs: ["package.json", "test/integration/release-offline.test.ts"],
  declared_content: {
    schemas: ["src/contracts/schemas/v1/release-manifest.schema.json"],
    workflow: "assets/workflow.yaml",
    constitution: [
      "assets/constitution/00-process.md",
      "assets/constitution/README.md",
    ],
  },
  build_entries: [
    {
      id: "mcp-stdio",
      role: "mcp-stdio",
      entry_point: "src/main.ts",
      output_path: "archflow-mcp.mjs",
      handler_authority: "mcp-tool-handler",
    },
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
      id: "mcp-stdio",
      entry_point: "src/main.ts",
      output_path: "archflow-mcp.mjs",
      output_digest: digest("a"),
      contributing_inputs: ["node_modules/example/prebundle.mjs"],
      allowed_imports: ["node:crypto"],
    },
    {
      id: "local-cli",
      entry_point: "src/local/main.ts",
      output_path: "archflow-local.mjs",
      output_digest: digest("b"),
      contributing_inputs: ["src/local/main.ts"],
      allowed_imports: ["node:fs"],
    },
  ],
  launch_profile: {
    node_major: 24,
    executable: "process.execPath",
    argv: ["--require", "hostile-runtime-guard.cjs", "archflow-mcp.mjs"],
    environment_keys: ["HOME", "LANG", "LC_ALL", "NPM_CONFIG_CACHE", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"],
    removed_environment_keys: ["NODE_OPTIONS", "NODE_PATH"],
    cwd_class: "copied-payload",
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe", guard_fd: 3 },
    guard_path: "test/fixtures/release/hostile-runtime-guard.cjs",
    canary_paths: ["ambient/node_modules/archflow-release-canary/index.js", "repository-canary/SECRET"],
    fixture_digests: [
      { path: "test/fixtures/mcp/runtime/adversarial-bytes.json", digest: digest("1") },
      { path: "test/fixtures/mcp/runtime/calls.json", digest: digest("2") },
      { path: "test/fixtures/mcp/runtime/initialize.json", digest: digest("3") },
    ],
    allowed_imports: ["node:buffer", "node:crypto", "node:module", "node:process", "node:util"],
  },
  legal_review: {
    source_path: "release/legal-review.json",
    payload_path: "legal/review.json",
    digest: digest("4"),
  },
  artifacts: [
    { path: "archflow-local.mjs", role: "executable", size: 180, digest: digest("b") },
    { path: "archflow-mcp.mjs", role: "executable", size: 200, digest: digest("a") },
    { path: "legal/review.json", role: "legal-review", size: 60, digest: digest("4") },
    { path: "manifest.json", role: "manifest" },
    { path: "metafile.json", role: "metafile", size: 90, digest: digest("5") },
  ],
});

const createLegalReview = (): Record<string, unknown> => ({
  schema_version: "1",
  project_license_status: "missing",
  distribution_status: "unresolved",
  inventory_method: "conservative-mapped-component-inventory",
  limitations: [
    "AJV JSON sources may be absent from source-map source content.",
    "Mapped components do not prove exact physical-byte attribution.",
  ],
  current_components: [
    {
      component_id: "fast-uri-embedded",
      package_name: "fast-uri",
      package_version: "3.1.0",
      provenance_kind: "embedded",
      source_root: "fast-uri/lib",
      license_expression: "BSD-3-Clause",
      legal_source: {
        source_path: "release/legal/upstream/fast-uri-3.1.0/LICENSE",
        payload_path: "legal/upstream/fast-uri-3.1.0/LICENSE",
        digest: digest("9"),
      },
      package_identity: {
        authority: "npm-registry-artifact",
        tarball_url: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.0.tgz",
        integrity: "sha512-aGVsbG8=",
      },
      provenance_inputs: [
        {
          package_name: "@modelcontextprotocol/server",
          package_version: "2.0.0",
          package_relative_path: "dist/cjs/server/index.js.map",
        },
      ],
      source_map_expected: true,
    },
  ],
  dependency_gate_decisions: [
    {
      id: "fast-uri-3-1-0-local-risk",
      decision_digest: digest("6"),
      status: "accepted",
      scope: {
        deployment: "local-only",
        operators: "user-owned-agents",
        production: false,
        handler_authority: "inert-no-handler",
        invalidated_by: [
          "bundle-change",
          "dependency-change",
          "entry-change",
          "handler-authority-change",
        ],
      },
      package_name: "fast-uri",
      package_version: "3.1.0",
      advisories: [
        { id: "GHSA-4c8g-83qw-93j6", severity: "high", affected_version: "3.1.0", safe_version: "3.1.3" },
        { id: "GHSA-q3j6-qgpj-74h6", severity: "high", affected_version: "3.1.0", safe_version: "3.1.1" },
        { id: "GHSA-v2hh-gcrm-f6hx", severity: "high", affected_version: "3.1.0", safe_version: "3.1.4" },
        { id: "GHSA-v39h-62p7-jpjc", severity: "high", affected_version: "3.1.0", safe_version: "3.1.2" },
      ],
      bundle_digest: digest("a"),
      entry_bindings: [
        { id: "mcp-stdio", role: "mcp-stdio", handler_authority: "mcp-tool-handler" },
        { id: "local-cli", role: "local-cli", handler_authority: "local-cli-handler" },
      ],
      dependency_inventory_digest: digest("b"),
      advisory_snapshot: { path: "release/evidence/advisory-snapshot.json", digest: digest("7") },
      patched_artifact_availability: { path: "release/evidence/patched-artifact-availability.json", digest: digest("8") },
      reachability_evidence: { path: "release/evidence/focused-inert-reachability.json", digest: digest("9") },
      user_acceptance: { path: "release/evidence/user-risk-acceptance.json", digest: digest("0") },
    },
  ],
  amendments: [],
  supersessions: [],
  upstream_legal_sources: [
    {
      component_id: "fast-uri-embedded",
      source_path: "release/legal/upstream/fast-uri/LICENSE",
      payload_path: "legal/upstream/fast-uri/LICENSE",
      digest: digest("9"),
      package_identity: {
        authority: "npm-registry-artifact",
        tarball_url: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.0.tgz",
        integrity: "sha512-aGVsbG8=",
      },
    },
  ],
});

describe("release manifest structural authority", () => {
  it("accepts closed physical-input, proof, launch, and artifact records", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    expect(validator.assert(createManifest())).toEqual(expect.any(Object));
  });

  it("retains scanned zero-byte inputs without treating them as contributors", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    const manifest = createManifest();
    expect(validator.assert(manifest)).toEqual(expect.any(Object));
    expect(manifest.contributing_inputs).toEqual(["node_modules/example/prebundle.mjs", "src/local/main.ts"]);
  });

  it("rejects unknown nested data, non-portable paths, malformed digests, and duplicate authorities", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    const unknown = structuredClone(createManifest());
    (unknown.launch_profile as Record<string, unknown>).ambient_environment = true;
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

  it("closes adjacent-map evidence and pins every structural launch identity", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-manifest"));
    const absent = createManifest();
    absent.adjacent_map_expectations = [{
      input_key: "node_modules/example/prebundle.mjs",
      expectation: "expected-absent",
      rationale: "The reviewed package artifact ships no adjacent map for this prebundle.",
    }];
    expect(validator.assert(absent)).toEqual(expect.any(Object));

    const unreviewed = structuredClone(createManifest());
    delete ((unreviewed.adjacent_map_expectations as Array<Record<string, unknown>>)[0]!.map as Record<string, unknown>).digest;
    expect(() => validator.assert(unreviewed)).toThrow(/required/iu);

    const substitutedGuard = structuredClone(createManifest());
    (substitutedGuard.launch_profile as Record<string, unknown>).guard_path = "test/fixtures/release/other.cjs";
    expect(() => validator.assert(substitutedGuard)).toThrow(/constant/iu);

    const duplicateFixture = structuredClone(createManifest());
    const fixtures = (duplicateFixture.launch_profile as Record<string, unknown>).fixture_digests as Array<Record<string, unknown>>;
    fixtures[1]!.path = fixtures[0]!.path;
    expect(() => validator.assert(duplicateFixture)).toThrow(/constant|x-archflow-unique-by/iu);
  });
});

describe("release legal-review structural authority", () => {
  it("records all four accepted advisories and digest-bound inert reachability scope", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-legal-review"));
    const review = createLegalReview();
    expect(validator.assert(review)).toEqual(expect.any(Object));
    const [decision] = review.dependency_gate_decisions as Array<Record<string, unknown>>;
    expect(decision!.advisories).toHaveLength(4);
    expect(decision!.scope).toMatchObject({
      deployment: "local-only",
      operators: "user-owned-agents",
      production: false,
      handler_authority: "inert-no-handler",
    });
  });

  it("requires the fields used by cross-document semantic correlation", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-legal-review"));
    for (const field of [
      "bundle_digest",
      "entry_bindings",
      "dependency_inventory_digest",
      "advisory_snapshot",
      "patched_artifact_availability",
      "reachability_evidence",
      "user_acceptance",
    ]) {
      const review = createLegalReview();
      delete (review.dependency_gate_decisions as Array<Record<string, unknown>>)[0]![field];
      expect(() => validator.assert(review), field).toThrow(/required/iu);
    }
  });

  it("fails closed on production scope, handler expansion, unknown fields, and unscoped provenance", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-legal-review"));
    const production = createLegalReview();
    const productionScope = ((production.dependency_gate_decisions as Array<Record<string, unknown>>)[0]!.scope) as Record<string, unknown>;
    productionScope.production = true;
    expect(() => validator.assert(production)).toThrow(/constant/iu);

    const expanded = createLegalReview();
    const expandedScope = ((expanded.dependency_gate_decisions as Array<Record<string, unknown>>)[0]!.scope) as Record<string, unknown>;
    expandedScope.handler_authority = "local-cli-handler";
    expect(() => validator.assert(expanded)).toThrow(/allowed values/iu);

    const unknown = createLegalReview();
    (unknown.current_components as Array<Record<string, unknown>>)[0]!.exact_physical_bytes = true;
    expect(() => validator.assert(unknown)).toThrow(/additional properties/iu);

    const unscoped = createLegalReview();
    delete ((unscoped.current_components as Array<Record<string, unknown>>)[0]!.provenance_inputs as Array<Record<string, unknown>>)[0]!.package_version;
    expect(() => validator.assert(unscoped)).toThrow(/required/iu);
  });

  it("requires immutable component identity, exact legal mapping, and append-only record evidence", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("release-legal-review"));
    const missingIdentity = createLegalReview();
    delete (missingIdentity.current_components as Array<Record<string, unknown>>)[0]!.package_identity;
    expect(() => validator.assert(missingIdentity)).toThrow(/required/iu);

    const missingMapping = createLegalReview();
    delete (missingMapping.upstream_legal_sources as Array<Record<string, unknown>>)[0]!.package_identity;
    expect(() => validator.assert(missingMapping)).toThrow(/required/iu);

    const incompleteAmendment = createLegalReview();
    incompleteAmendment.amendments = [{ id: "amend-one", decision_id: "fast-uri-3-1-0-local-risk", reason: "Correction." }];
    expect(() => validator.assert(incompleteAmendment)).toThrow(/required/iu);

    const incompleteSupersession = createLegalReview();
    incompleteSupersession.supersessions = [{ id: "replace-one", superseded_decision_id: "fast-uri-3-1-0-local-risk", replacement_decision_id: "replacement", reason: "Replacement." }];
    expect(() => validator.assert(incompleteSupersession)).toThrow(/required/iu);
  });
});

describe("release risk evidence structural authority", () => {
  for (const [filename, definition] of [
    ["advisory-snapshot", "advisory_snapshot_record"],
    ["patched-artifact-availability", "artifact_availability_record"],
    ["focused-inert-reachability", "reachability_record"],
    ["user-risk-acceptance", "user_acceptance_record"],
  ] as const) {
    it(`validates the closed canonical ${filename} record`, async () => {
      const validator = await evidenceValidator(definition);
      const evidence = await loadReleaseEvidence(filename);
      expect(validator.assert(evidence)).toEqual(expect.any(Object));
      expect(() => validator.assert({ ...evidence, unreviewed: true })).toThrow(/additional properties/iu);
    });
  }
});
