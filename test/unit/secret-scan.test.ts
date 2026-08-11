import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { rawGitPath } from "../../src/contracts/path-claims.js";
import {
  parseSecretScanResult,
  secretScanResultV1Schema,
  type SecretScanCandidate,
  type SecretScanResult,
  type SecretScanner,
} from "../../src/contracts/secret-scan.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../helpers/json-schema.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

const validator = async () =>
  createJsonSchemaValidator<SecretScanResult>(await schema("secret-scan-result"), [
    await schema("primitives"),
    await schema("path-claim"),
  ]);

const clean = {
  schema_version: "1",
  outcome: "clean",
  detector_set_id: "preset-recommend",
  scanned_paths: [".archflow/tasks/demo/state.json", "src/index.ts"],
};
const detected = {
  schema_version: "1",
  outcome: "detected",
  detector_set_id: "preset-recommend",
  findings: [
    { detector_id: "github-token", path_class: "result-payload", virtual_path: ".archflow/tasks/demo/state.json", line: 1, column: 1 },
    { detector_id: "aws-key", path_class: "repository-source", virtual_path: "src/index.ts", line: 42, column: 7 },
  ],
};
const unavailable = { schema_version: "1", outcome: "unavailable", reason: "scanner-not-installed" };

describe("secret scan result contract", () => {
  it("round-trips all three outcomes through the parser", () => {
    for (const value of [clean, detected, unavailable]) {
      expect(parseSecretScanResult(structuredClone(value))).toEqual(value);
    }
  });

  it("agrees with the JSON Schema across all three outcomes", async () => {
    const jsonValidator = await validator();
    for (const value of [clean, detected, unavailable]) {
      expect(assertZodAgreement(value, jsonValidator, secretScanResultV1Schema)).toBe(value);
    }
  });

  it("agrees with the JSON Schema on rejections, including 0-based positions", async () => {
    const jsonValidator = await validator();
    const finding = detected.findings[0]!;
    for (const invalid of [
      { ...detected, findings: [{ ...finding, line: 0 }] },
      { ...detected, findings: [{ ...finding, column: 0 }] },
      { ...detected, findings: [{ ...finding, line: -1 }] },
      // A finding may never carry matched text, surrounding context, or a redacted excerpt.
      { ...detected, findings: [{ ...finding, message: "found GitHub Token: ghp_16C7e" }] },
      { ...clean, outcome: "unknown" },
      { ...clean, extra: true },
      { ...unavailable, reason: "Scanner-Not-Installed" },
      { schema_version: "1", outcome: "unavailable" },
      { ...clean, scanned_paths: ["../escape"] },
      { ...detected, findings: [{ ...finding, virtual_path: "file.txt:stream" }] },
      { ...detected, findings: [{ ...finding, path_class: "not-a-class" }] },
    ]) {
      expect(() => assertZodAgreement(invalid, jsonValidator, secretScanResultV1Schema)).toThrow();
      expect(() => parseSecretScanResult(invalid)).toThrow();
    }
  });

  it("keeps `unavailable` a persistable result state rather than a call failure", () => {
    const scanner: SecretScanner = { scan: async () => Promise.resolve(parseSecretScanResult(unavailable)) };
    expect(scanner.scan).toBeTypeOf("function");
    const result = parseSecretScanResult(unavailable);
    expect(result.outcome).toBe("unavailable");
  });

  it("does not accept a RawGitPath where a claim is required", () => {
    const raw = rawGitPath("conflicted:name");
    const candidate: SecretScanCandidate = {
      // @ts-expect-error a RawGitPath carries no lexical guarantee and may never be a virtual_path
      virtual_path: raw,
      path_class: "repository-source",
      content: "",
    };
    expect(candidate.path_class).toBe("repository-source");
  });
});
