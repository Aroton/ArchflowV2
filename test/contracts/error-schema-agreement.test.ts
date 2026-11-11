import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import projectErrorSchema from "../../src/contracts/schemas/v1/project-error.schema.json" with { type: "json" };
import { PROJECT_ERROR_DEFINITIONS, createProjectError, parseProjectError, type ProjectError, type ProjectErrorCode } from "../../src/contracts/errors.js";

const D = "a".repeat(64);
const projectValidator = createJsonSchemaValidator(projectErrorSchema);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/** One valid serialized value per registered code; the mapped type keeps the table exhaustive. */
const samples: { readonly [K in ProjectErrorCode]: Extract<ProjectError, { code: K }> } = {
  CONTRACT_INVALID: createProjectError("CONTRACT_INVALID", { issue_code: "local-command-invalid", issues: ["review requires --producer"] }),
  CONFIG_INVALID: createProjectError("CONFIG_INVALID", { issue_code: "config-schema-invalid" }),
  CONFIG_MODEL_UNSUPPORTED: createProjectError("CONFIG_MODEL_UNSUPPORTED", { model: "example-model" }),
  CONFIG_FAMILY_UNSUPPORTED: createProjectError("CONFIG_FAMILY_UNSUPPORTED", { family: "example-family" }),
  REPOSITORY_NOT_FOUND: createProjectError("REPOSITORY_NOT_FOUND", { repository_candidate_digest: D }),
  REPOSITORY_VIEW_UNAVAILABLE: createProjectError("REPOSITORY_VIEW_UNAVAILABLE", { repository_name: "primary" }),
  UNSUPPORTED_HOST: createProjectError("UNSUPPORTED_HOST", { host: "unknown" }),
  UNSUPPORTED_MODEL: createProjectError("UNSUPPORTED_MODEL", { model: "example-model" }),
  FAMILY_MISMATCH: createProjectError("FAMILY_MISMATCH", { expected_family: "codex", observed_family: "claude" }),
  CLI_VERSION_UNSUPPORTED: createProjectError("CLI_VERSION_UNSUPPORTED", { adapter: "codex-cli", version: "0.1.0" }),
  AUTH_UNAVAILABLE: createProjectError("AUTH_UNAVAILABLE", { adapter: "claude-cli" }),
  CLI_MISSING: createProjectError("CLI_MISSING", { adapter: "antigravity-cli" }),
  RATE_LIMITED: createProjectError("RATE_LIMITED", { adapter: "claude-cli", attempt: 1, reason: "session-limit" }),
  TIMEOUT: createProjectError("TIMEOUT", { adapter: "antigravity-cli", attempt: 1, limit_ms: 900_000, origin: "cli" }),
  CANCELLED: createProjectError("CANCELLED", { source: "client", attempt: 1 }),
  MODEL_OUTPUT_INVALID: createProjectError("MODEL_OUTPUT_INVALID", { adapter: "codex-cli", attempt: 1, issue_code: "structured-output-missing" }),
  IO_ERROR: createProjectError("IO_ERROR", { operation: "spawn", attempt: 1 }),
  OUTPUT_OVERFLOW: createProjectError("OUTPUT_OVERFLOW", { adapter: "codex-cli", byte_count: 2, byte_cap: 1 }),
  PROCESS_FAILED: createProjectError("PROCESS_FAILED", { adapter: "codex-cli", exit_class: "transient-transport" }),
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("error JSON Schema authority", () => {
  it("agrees with the exhaustive serialized error registry on every code", () => {
    expect(Object.keys(samples)).toEqual(Object.keys(PROJECT_ERROR_DEFINITIONS));
    for (const sample of Object.values(samples)) {
      expect(projectValidator.validate(sample), `${sample.code}: ${JSON.stringify(projectValidator.validate.errors)}`).toBe(true);
      expect(parseProjectError(sample)).toBe(sample);
      for (const forged of [
        { ...sample, owner: "protocol" },
        { ...sample, retryable: !sample.retryable },
        { ...sample, next_action: "stop-and-inspect" },
        { ...sample, diagnostic: { ...sample.diagnostic, parameters: { ...sample.diagnostic.parameters, raw_exception: "secret" } } },
      ]) {
        expect(projectValidator.validate(forged), sample.code).toBe(false);
        expect(() => parseProjectError(forged), sample.code).toThrow();
      }
    }
  });

  it("publishes exactly one variant per registered code and rejects any other code", () => {
    const published = (projectErrorSchema.anyOf as readonly { readonly $ref: string }[]).map((entry) => entry.$ref.replace("#/$defs/E_", ""));
    expect(published).toEqual(Object.keys(PROJECT_ERROR_DEFINITIONS));
    const unregistered = { ...samples.CANCELLED, code: "NOT_A_CODE", diagnostic: { ...samples.CANCELLED.diagnostic, template_id: "NOT_A_CODE" } };
    expect(projectValidator.validate(unregistered)).toBe(false);
    expect(() => parseProjectError(unregistered)).toThrow();
  });

  it("registers exactly the codes that surviving source constructs", () => {
    const constructed = new Set<string>();
    for (const file of sourceFiles(sourceRoot)) {
      const calls = [...readFileSync(file, "utf8").matchAll(/\bcreateProjectError\(\s*(?:"(?<code>[A-Z_]+)")?/gu)];
      for (const call of calls) {
        const code = call.groups?.["code"];
        // A computed code would escape this scan, so every caller must name a literal.
        if (code === undefined) throw new TypeError(`${file} constructs a project error from a non-literal code`);
        constructed.add(code);
      }
    }
    expect([...constructed].sort()).toEqual(Object.keys(PROJECT_ERROR_DEFINITIONS).sort());
  });

  it("publishes the bounded optional CONFIG_INVALID issue list", () => {
    const error = createProjectError("CONFIG_INVALID", {
      issue_code: "config-schema-invalid",
      issues: ["repositories.apis.path: invalid declaration"],
    });
    expect(projectValidator.validate(error), JSON.stringify(projectValidator.validate.errors)).toBe(true);
    expect(projectValidator.validate({
      ...error,
      diagnostic: {
        ...error.diagnostic,
        parameters: { ...error.diagnostic.parameters, issues: Array.from({ length: 6 }, () => "invalid") },
      },
    })).toBe(false);
  });
});
