import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseGitOid, parseGitTreeMode } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeId, parseSha256Digest } from "../../src/contracts/evidence.js";
import {
  EXCLUDED_REQUEST_DIGEST_FIELDS,
  computeInputFingerprint,
  computePinnedConfigDigest,
  computeRequestDigest,
  verifyPinnedConfig,
  type DeclaredInputRef,
  type GitIdentityRef,
  type InputFingerprintSubject,
  type RequestDigestSubject,
} from "../../src/contracts/fingerprints.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { PlainJsonObject } from "../../src/contracts/plain-json.js";

const digest = (seed: string): ReturnType<typeof parseSha256Digest> => parseSha256Digest(seed.repeat(64).slice(0, 64));
const oid = (seed: string): ReturnType<typeof parseGitOid> => parseGitOid(seed.repeat(40).slice(0, 40));
const claim = (value: string): ReturnType<typeof parseRepositoryPathClaim> => parseRepositoryPathClaim(value);
const blob = parseGitTreeMode("100644");
const phaseInstance = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(6) });

const identity = (path: string, seed: string): GitIdentityRef => ({ path: claim(path), mode: blob, oid: oid(seed) });
const declaredInput = (id: string, seed: string): DeclaredInputRef => ({ input_id: parseSafeId(id), digest: digest(seed) });

const artifacts: readonly GitIdentityRef[] = [
  identity(".archflow/tasks/demo/prd.md", "1"),
  identity(".archflow/tasks/demo/design.md", "2"),
  identity("src/index.ts", "3"),
];
const upstream: readonly GitIdentityRef[] = [
  identity(".archflow/workflow.yaml", "4"),
  identity(".archflow/constitution/core.md", "5"),
];
const declaredInputs: readonly DeclaredInputRef[] = [
  declaredInput("rubric", "6"),
  declaredInput("Input:2", "7"),
  declaredInput("input-3", "8"),
];

const subject: InputFingerprintSubject = {
  schema_version: "1",
  workflow_digest: digest("a"),
  config_digest: digest("b"),
  constitution_digest: digest("c"),
  artifact_identities: artifacts,
  upstream_identities: upstream,
  rubric_digest: digest("d"),
  phase_instance: phaseInstance,
  declared_inputs: declaredInputs,
};

/** A rotation is a permutation that never leaves the input in its original order. */
const rotate = <T,>(items: readonly T[]): readonly T[] => [...items.slice(1), items[0]!];

const requestSubject = (operationFields: PlainJsonObject): RequestDigestSubject => ({
  schema_version: "1",
  tool: "archflow_state",
  repository_identity_digest: digest("e"),
  task_identity_digest: digest("f"),
  operation: parseSafeCode("record-phase-result"),
  operation_fields: operationFields,
  input_fingerprint: computeInputFingerprint(subject),
});

const configUrl = new URL("../fixtures/contracts/fingerprints/config.yaml", import.meta.url);
const reorderedConfigUrl = new URL("../fixtures/contracts/fingerprints/config-reordered.yaml", import.meta.url);

describe("computeInputFingerprint", () => {
  it("is invariant under permutation of all three set-valued collections", () => {
    const expected = computeInputFingerprint(subject);
    expect(computeInputFingerprint({ ...subject, artifact_identities: rotate(artifacts) })).toBe(expected);
    expect(computeInputFingerprint({ ...subject, upstream_identities: rotate(upstream) })).toBe(expected);
    expect(computeInputFingerprint({ ...subject, declared_inputs: rotate(declaredInputs) })).toBe(expected);
    expect(computeInputFingerprint({
      ...subject,
      artifact_identities: [...artifacts].reverse(),
      upstream_identities: [...upstream].reverse(),
      declared_inputs: [...declaredInputs].reverse(),
    })).toBe(expected);
  });

  it("still distinguishes different logical contents", () => {
    const expected = computeInputFingerprint(subject);
    expect(computeInputFingerprint({ ...subject, rubric_digest: digest("9") })).not.toBe(expected);
    expect(computeInputFingerprint({
      ...subject,
      artifact_identities: [...artifacts.slice(0, 2), identity("src/index.ts", "9")],
    })).not.toBe(expected);
  });

  it("throws on a repeated path or input_id rather than deduplicating", () => {
    expect(() => computeInputFingerprint({
      ...subject,
      artifact_identities: [...artifacts, identity("src/index.ts", "9")],
    })).toThrow(/artifact_identities is a set/u);
    expect(() => computeInputFingerprint({
      ...subject,
      upstream_identities: [...upstream, identity(".archflow/workflow.yaml", "9")],
    })).toThrow(/upstream_identities is a set/u);
    expect(() => computeInputFingerprint({
      ...subject,
      declared_inputs: [...declaredInputs, declaredInput("rubric", "9")],
    })).toThrow(/declared_inputs is a set/u);
  });
});

describe("computeRequestDigest", () => {
  it("excludes volatile request state: two requests differing only there share one digest", () => {
    // The volatile fields live on the request envelope, never inside the closed digest field list.
    const first = {
      intent_id: "intent-1",
      expected_revision: 7,
      timestamp: "2026-07-28T00:00:00.000Z",
      attempt: 1,
      connection_id: "connection-1",
      operation_fields: { phase_instance: phaseInstance, verdict: "pass" } satisfies PlainJsonObject,
    };
    const retry = {
      ...first,
      // A retry after SUPPLEMENTAL_REVIEW_REQUIRED refreshes exactly these and nothing else.
      expected_revision: 9,
      timestamp: "2026-07-28T00:05:00.000Z",
      attempt: 4,
      connection_id: "connection-2",
    };
    expect(computeRequestDigest(requestSubject(retry.operation_fields)))
      .toBe(computeRequestDigest(requestSubject(first.operation_fields)));
  });

  it("is stable under operation_fields key order and sensitive to semantic fields", () => {
    const digestA = computeRequestDigest(requestSubject({ verdict: "pass", phase_instance: phaseInstance }));
    const digestB = computeRequestDigest(requestSubject({ phase_instance: phaseInstance, verdict: "pass" }));
    expect(digestA).toBe(digestB);
    expect(computeRequestDigest(requestSubject({ phase_instance: phaseInstance, verdict: "fail" }))).not.toBe(digestA);
  });

  it("asserts rather than filters every excluded field name, at any depth", () => {
    expect(EXCLUDED_REQUEST_DIGEST_FIELDS).toEqual(expect.arrayContaining([
      "intent_id", "expected_revision", "timestamp", "attempt", "connection_id",
    ]));
    for (const field of EXCLUDED_REQUEST_DIGEST_FIELDS) {
      expect(() => computeRequestDigest(requestSubject({ [field]: "x" }))).toThrow(/excluded request-digest field/u);
      expect(() => computeRequestDigest(requestSubject({ nested: { [field]: "x" } }))).toThrow(/excluded request-digest field/u);
      expect(() => computeRequestDigest(requestSubject({ items: [{ [field]: "x" }] }))).toThrow(/excluded request-digest field/u);
    }
  });
});

/**
 * A property that answers differently on each read — the shape an attacker needs to show a safe
 * value to a check and a different value to the hash. The digest functions must never observe the
 * second answer, because they must never read the caller's object twice.
 */
const togglingGetter = (values: readonly unknown[]): (() => unknown) => {
  let reads = 0;
  return () => values[Math.min(reads++, values.length - 1)];
};

const withGetter = <T extends object>(source: T, key: keyof T & string, values: readonly unknown[]): T => {
  const clone = { ...source } as T;
  Object.defineProperty(clone, key, { enumerable: true, configurable: true, get: togglingGetter(values) });
  return clone;
};

describe("split-observation defence", () => {
  it("rejects a getter-backed operation_fields instead of digesting a smuggled excluded field", () => {
    const smuggler = withGetter(requestSubject({ verdict: "pass" }), "operation_fields", [
      { safe: 1 },
      { intent_id: "smuggled" },
    ]);
    expect(() => computeRequestDigest(smuggler)).toThrow(/accessor properties are not JSON values/u);
  });

  it("rejects a getter nested inside operation_fields", () => {
    const fields = withGetter({ nested: { safe: 1 } }, "nested", [{ safe: 1 }, { intent_id: "smuggled" }]);
    expect(() => computeRequestDigest(requestSubject(fields as PlainJsonObject)))
      .toThrow(/accessor properties are not JSON values/u);
  });

  it("rejects a getter-backed entry inside artifact_identities and declared_inputs", () => {
    expect(() => computeInputFingerprint({
      ...subject,
      artifact_identities: [
        withGetter(artifacts[0]!, "path", [claim("src/first.ts"), claim("src/second.ts")]),
        ...artifacts.slice(1),
      ],
    })).toThrow(/accessor properties are not JSON values/u);

    expect(() => computeInputFingerprint({
      ...subject,
      declared_inputs: [
        withGetter(declaredInputs[0]!, "digest", [digest("1"), digest("2")]),
        ...declaredInputs.slice(1),
      ],
    })).toThrow(/accessor properties are not JSON values/u);
  });

  it("returns the identical digest when the same subject object is hashed repeatedly", () => {
    const fingerprints = [computeInputFingerprint(subject), computeInputFingerprint(subject), computeInputFingerprint(subject)];
    expect(new Set(fingerprints).size).toBe(1);

    const request = requestSubject({ phase_instance: phaseInstance, verdict: "pass" });
    const digests = [computeRequestDigest(request), computeRequestDigest(request), computeRequestDigest(request)];
    expect(new Set(digests).size).toBe(1);
  });
});

describe("pinned config digest", () => {
  it("accepts the exact pinned bytes", async () => {
    const bytes = new Uint8Array(await readFile(configUrl));
    const pinned = computePinnedConfigDigest(bytes);
    const result = verifyPinnedConfig(pinned, bytes);
    expect(result).toEqual({ schema_version: "1", ok: true, value: pinned });
  });

  it("rejects a one-byte change, a trailing newline, and a key reordering with no config content", async () => {
    const bytes = new Uint8Array(await readFile(configUrl));
    const pinned = computePinnedConfigDigest(bytes);

    const oneByte = Uint8Array.from(bytes);
    oneByte[oneByte.length - 2] = oneByte[oneByte.length - 2]! ^ 0x20;
    const extraNewline = Uint8Array.from([...bytes, 0x0a]);
    const reordered = new Uint8Array(await readFile(reorderedConfigUrl));

    for (const observedBytes of [oneByte, extraNewline, reordered]) {
      const result = verifyPinnedConfig(pinned, observedBytes);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("PINNED_CONFIG_MISMATCH");
      expect(result.error.diagnostic.parameters).toEqual({
        expected_digest: pinned,
        observed_digest: computePinnedConfigDigest(observedBytes),
      });
      const serialized = JSON.stringify(result);
      for (const secret of ["claude-opus-5", "gpt-5-codex", "producer", "counter-reviewer", "effort"]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});
