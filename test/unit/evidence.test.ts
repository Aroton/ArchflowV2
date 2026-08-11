import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";

import { pathSafeIdV1Schema, taskSlugV1Schema } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim, parseRepositoryPathClaim, toRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../helpers/json-schema.js";
import { classifyRepositoryPath, classifyTaskPath } from "../../src/repository/paths.js";
import {
  parsePathSafeId,
  parseSafeCode,
  parseSafeId,
  parseTaskSlug,
  parseSafeInteger,
  parseSafeVersion,
  parseSha256Digest,
  type PathSafeId,
  type ReferencedEvidence,
  type SafeCode,
  type SafeId,
  type SafeInteger,
  type SafeVersion,
  type Sha256Digest,
  type TaskSlug
} from "../../src/contracts/index.js";

describe("shared evidence primitives", () => {
  it("accepts only canonical lowercase SHA-256 syntax", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(parseSha256Digest(digest)).toBe(digest);
    for (const invalid of [
      digest.toUpperCase(),
      `sha256:${digest}`,
      ` ${digest}`,
      `${digest} `,
      digest.slice(1),
      `${digest}0`,
      "０".repeat(64)
    ]) expect(() => parseSha256Digest(invalid)).toThrow();
  });

  it("enforces the bounded identifier, code, version, and integer vocabularies", () => {
    expect(parseSafeId(`a${"-".repeat(127)}`)).toHaveLength(128);
    expect(parseSafeCode(`a${"_".repeat(63)}`)).toHaveLength(64);
    expect(parseSafeVersion(`1${".".repeat(63)}`)).toHaveLength(64);
    expect(parseSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);

    for (const invalid of ["", "-leading", `a${".".repeat(128)}`, "é"]) expect(() => parseSafeId(invalid)).toThrow();
    for (const invalid of ["", "UPPER", "-leading", `a${"_".repeat(64)}`]) expect(() => parseSafeCode(invalid)).toThrow();
    for (const invalid of ["", "v_1", `1${".".repeat(64)}`, "é"]) expect(() => parseSafeVersion(invalid)).toThrow();
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) expect(() => parseSafeInteger(invalid)).toThrow();
  });

  it("separates the path-safe identifier and task slug vocabularies from safeId", () => {
    expect(parsePathSafeId(`a${"-".repeat(127)}`)).toHaveLength(128);
    expect(parsePathSafeId("Intent-1.retry")).toBe("Intent-1.retry");
    expect(parseTaskSlug("mcp-integration")).toBe("mcp-integration");
    expect(parseTaskSlug(`a${"-".repeat(63)}`)).toHaveLength(64);

    // safeId permits both of these; the narrower vocabularies exist to close exactly that gap.
    expect(parseSafeId("retry:3")).toBe("retry:3");
    expect(parseSafeId("My_Task")).toBe("My_Task");
    for (const invalid of ["", "retry:3", "-leading", `a${"-".repeat(128)}`, "é"]) {
      expect(() => parsePathSafeId(invalid)).toThrow();
    }
    for (const invalid of ["", "My_Task", "Task-1", "task:1", "-leading", `a${"-".repeat(64)}`]) {
      expect(() => parseTaskSlug(invalid)).toThrow();
    }
  });

  it("keeps identities and evidence references opaque at compile time", () => {
    expectTypeOf<Sha256Digest>().toMatchTypeOf<string>();
    expectTypeOf<SafeId>().toMatchTypeOf<string>();
    expectTypeOf<SafeCode>().toMatchTypeOf<string>();
    expectTypeOf<SafeVersion>().toMatchTypeOf<string>();
    expectTypeOf<SafeInteger>().toMatchTypeOf<number>();
    expectTypeOf<PathSafeId>().toMatchTypeOf<string>();
    expectTypeOf<TaskSlug>().toMatchTypeOf<string>();
    // @ts-expect-error unparsed strings cannot mint a digest brand
    const untrustedDigest: Sha256Digest = "0".repeat(64);
    // @ts-expect-error a safeId is not narrow enough to be a path-safe identifier
    const widened: PathSafeId = parseSafeId("retry:3");
    // @ts-expect-error a plain string cannot mint a task slug
    const untrustedSlug: TaskSlug = "mcp-integration";
    expect(widened).toBe("retry:3");
    expect(untrustedSlug).toBe("mcp-integration");
    const reference: ReferencedEvidence<{ readonly value: string }> = {
      evidence_digest: parseSha256Digest("0".repeat(64)),
      evidence: { value: "payload" }
    };
    expect(reference.evidence.value).toBe("payload");
    expect(untrustedDigest).toHaveLength(64);
  });

  it("runs recursive plain-JSON preflight before primitive parsing", () => {
    expect(() => parseSha256Digest(new String("0".repeat(64)))).toThrow(/plain prototype/iu);
  });
});

describe("the ID vocabularies are usable as single path components", () => {
  const primitiveDefs = async (): Promise<Record<string, object>> => {
    const schema = JSON.parse(
      await readFile(new URL("../../src/contracts/schemas/v1/primitives.schema.json", import.meta.url), "utf8")
    ) as { $defs: Record<string, object> };
    return schema.$defs;
  };

  // Every value here parsed before the tightening but could never be composed into a path claim:
  // Win32 reserves the device names with any extension, and strips trailing dots.
  it.each([
    ["taskSlug", ["con", "task.", "nul", "com1", "lpt9", "aux", "prn.json"], ["mcp-integration", "conx", "com0", "lpt0", "a.b"]],
    ["pathSafeId", ["CON", "gate.", "PRN.txt", "con", "com1", "lpt9", "NUL.json"], ["Intent-1.retry", "CONS", "PRN1", "a".repeat(128)]]
  ] as const)("rejects %s values the path-claim authority rejects, in both Zod and Ajv", async (definition, rejected, accepted) => {
    const zodSchema = definition === "taskSlug" ? taskSlugV1Schema : pathSafeIdV1Schema;
    const validator = createJsonSchemaValidator<string>({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...(await primitiveDefs())[definition]
    });
    for (const value of rejected) {
      expect(validator.validate(value)).toBe(false);
      expect(zodSchema.safeParse(value).success).toBe(false);
      expect(() => assertZodAgreement<string>(value, validator, zodSchema)).toThrow(/schema validation failed/u);
    }
    for (const value of accepted) {
      expect(assertZodAgreement<string>(value, validator, zodSchema)).toBe(value);
    }
  });

  /**
   * The producibility criterion, proven rather than asserted: every `src/repository/paths.ts`
   * template that embeds a `PathSafeId`, a `TaskSlug`, or a phase instance must compose to a claim
   * that parses *and* classifies, for every identifier the parsers accept.
   */
  it("composes every ID-bearing path template from any accepted identifier", () => {
    const phaseNumbers = [1, 42].map((value) => parsePositiveSafePhaseNumber(value));
    const phaseInstances = [
      encodePhaseInstance({ kind: "prd" }),
      encodePhaseInstance({ kind: "design" }),
      ...phaseNumbers.flatMap((phase) => [
        encodePhaseInstance({ kind: "phase-design", phase }),
        encodePhaseInstance({ kind: "phase-impl", phase })
      ])
    ];

    for (const rawSlug of ["a", "0", "mcp-integration", "conx", "com0", "lpt0", "a.b", "0".repeat(64)]) {
      const taskId = parseTaskSlug(rawSlug);
      for (const rawId of ["a", "0", "Intent-1.retry", "conx", "aux1", "com0", "lpt0", "PRN1", "a.b.c", "z".repeat(128)]) {
        const id = parsePathSafeId(rawId);

        const claims: readonly (readonly [string, string])[] = [
          ...phaseNumbers.flatMap((phase) => [
            ["document", `phases/${String(phase)}/design.md`] as const,
            ["document", `phases/${String(phase)}/impl-notes.md`] as const
          ]),
          ...phaseInstances.flatMap((instance) => [
            ["review", `reviews/${instance}.counter.md`] as const,
            ["review", `reviews/${instance}.triage.md`] as const,
            ["review", `reviews/${instance}.adjudication.md`] as const,
            ["review", `reviews/${instance}.gate-counter.${id}.md`] as const,
            ["attempt", `attempts/${instance}/${id}.json`] as const
          ]),
          ["decision", `decisions/${id}/request.json`],
          ["decision", `decisions/${id}/decision.json`],
          ["intent", `intents/${id}.json`],
          ["maintenance-record", `maintenance/${id}.json`],
          ["task-config", "config.yaml"]
        ];

        for (const [expectedClass, template] of claims) {
          const claim = parseTaskPathClaim(template);
          expect(classifyTaskPath(taskId, claim)).toMatchObject({ ok: true, value: expectedClass });
          // The task claim must also survive re-framing under `.archflow/tasks/<task-id>/`.
          expect(String(toRepositoryPathClaim(taskId, claim))).toBe(`.archflow/tasks/${taskId}/${template}`);
        }

        const constitution = parseRepositoryPathClaim(`.archflow/constitution/${id}.md`);
        expect(classifyRepositoryPath(constitution)).toMatchObject({ ok: true, value: "shared-constitution" });
      }
    }
  });
});
