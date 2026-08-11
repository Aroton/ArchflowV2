import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseGitOid, parseGitTreeMode } from "../../src/contracts/canonical.js";
import { parseSafeId, parseSha256Digest } from "../../src/contracts/evidence.js";
import {
  computeInputFingerprint,
  computePinnedConstitutionDigest,
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

type StateOperationFields = { readonly phase_instance: typeof phaseInstance; readonly step: "produce"; readonly status: "succeeded" | "failed" };
const requestSubject = (operationFields: StateOperationFields): RequestDigestSubject => ({
  schema_version: "1",
  tool: "archflow_state",
  repository_identity_digest: digest("e"),
  task_identity_digest: digest("f"),
  operation: "record-state-boundary",
  operation_fields: operationFields,
  input_fingerprint: computeInputFingerprint(subject),
});

const requestCommon = {
  schema_version: "1",
  repository_identity_digest: digest("e"),
  task_identity_digest: digest("f"),
  input_fingerprint: computeInputFingerprint(subject),
} as const;
const requestRubric = { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "paths", text: "Check paths", blocking: true }] } as const;
const requestEvidence = {
  set_digest: digest("8"),
  slots: [
    { role: "counter-review", evidence_digest: digest("6"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
  ],
} as const;
const requestOrigin = {
  origin_gate_id: "gate-1",
  origin_decision_digest: digest("1"),
  origin_context_digest: digest("2"),
  task_id: "task-1",
  phase_instance: phaseInstance,
  subject_digest: digest("3"),
  current_evidence_set_digest: digest("4"),
  rule: { rule_id: "Rule:1", rule_version: 1 },
  scope: { operation: "review-trigger", boundary: "subject" },
} as const;
const requestSubjects = {
  archflow_state: { ...requestCommon, tool: "archflow_state", operation: "record-state-boundary", operation_fields: { phase_instance: phaseInstance, step: "produce", status: "succeeded" } },
  archflow_counter_review: { ...requestCommon, tool: "archflow_counter_review", operation: "counter-review", operation_fields: { artifact_path: "phases/9/result.md", rubric: requestRubric } },
  archflow_adjudicate: { ...requestCommon, tool: "archflow_adjudicate", operation: "adjudicate", operation_fields: { artifact_path: "phases/9/result.md", upstream_paths: ["prd.md", "architecture.md"] } },
  archflow_gate: { ...requestCommon, tool: "archflow_gate", operation: "gate", operation_fields: { phase_instance: phaseInstance, summary: "Approve implementation", subject_digest: digest("7"), current_evidence: requestEvidence, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } } },
  archflow_gate_supersedes: { ...requestCommon, tool: "archflow_gate", operation: "gate", operation_fields: { phase_instance: phaseInstance, summary: "Approve implementation", subject_digest: digest("7"), current_evidence: requestEvidence, supersedes: { superseded_gate_id: "gate-0", accepted_triage_digest: digest("9"), old_subject_digest: digest("a") }, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } } },
  archflow_waiver: { ...requestCommon, tool: "archflow_waiver", operation: "waiver", operation_fields: { origin: requestOrigin, rationale: "A bounded exception is required" } },
} as unknown as Readonly<Record<string, RequestDigestSubject>>;

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

describe("computePinnedConstitutionDigest", () => {
  it("sorts commit-tree entries, rejects duplicate paths, and binds blob identities", () => {
    const files = [
      { path: claim(".archflow/constitution/20-review.md"), oid: oid("2") },
      { path: claim(".archflow/constitution/10-base.md"), oid: oid("1") },
    ] as const;
    const expected = computePinnedConstitutionDigest(files);
    expect(computePinnedConstitutionDigest([...files].reverse())).toBe(expected);
    expect(computePinnedConstitutionDigest([{ ...files[0]!, oid: oid("3") }, files[1]!])).not.toBe(expected);
    expect(() => computePinnedConstitutionDigest([files[0]!, files[0]!])).toThrow(/set: duplicate/u);
  });
});

describe("computeRequestDigest", () => {
  it("pins stable golden digests for every closed selector and both gate shapes", () => {
    expect(Object.fromEntries(Object.entries(requestSubjects).map(([name, value]) => [name, computeRequestDigest(value)]))).toEqual({
      archflow_state: "9e18ce122452f01f99faa4f2b1f2c99364c580049e1cd5296bd295d37b0f7217",
      archflow_counter_review: "42b856af8a42fa8e3070048c88bab5beecfa1c0987a743328f7b180b671988b2",
      archflow_adjudicate: "f736d8b058537377d8030b67dea2fb03ea6085f7a545d4f855b351e8abb89be5",
      archflow_gate: "2ad726edb2b970f1066e49ddb7c60518fe15c41b28d254fc51df9a30ea2af399",
      archflow_gate_supersedes: "123fe3b33c3ef1250316af54ee1085f7d55153823527607b21a90ddf2fb06255",
      archflow_waiver: "c1baf879238bc647da60c3ec7cf8655c844d986a79e25306388450a1260e3f38",
    });
  });

  it("changes for every selected semantic field", () => {
    const mutations: Readonly<Record<string, readonly RequestDigestSubject[]>> = {
      archflow_state: [
        { ...requestSubjects.archflow_state!, operation_fields: { phase_instance: "phase-impl-7", step: "produce", status: "succeeded" } },
        { ...requestSubjects.archflow_state!, operation_fields: { phase_instance: phaseInstance, step: "triage", status: "succeeded" } },
        { ...requestSubjects.archflow_state!, operation_fields: { phase_instance: phaseInstance, step: "produce", status: "failed" } },
      ] as unknown as RequestDigestSubject[],
      archflow_counter_review: [
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/other.md", rubric: requestRubric } },
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/result.md", rubric: { ...requestRubric, criteria: [{ ...requestRubric.criteria[0]!, text: "Check receipts" }] } } },
      ] as unknown as RequestDigestSubject[],
      archflow_adjudicate: [
        { ...requestSubjects.archflow_adjudicate!, operation_fields: { artifact_path: "phases/9/other.md", upstream_paths: ["prd.md", "architecture.md"] } },
        { ...requestSubjects.archflow_adjudicate!, operation_fields: { artifact_path: "phases/9/result.md", upstream_paths: ["architecture.md", "prd.md"] } },
      ] as unknown as RequestDigestSubject[],
      archflow_gate: [
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, phase_instance: "phase-impl-7" } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, summary: "Revise implementation" } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, subject_digest: digest("0") } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, current_evidence: { ...requestEvidence, set_digest: digest("0") } } },
        requestSubjects.archflow_gate_supersedes!,
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, kind: "commit-authorization" } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, context: { artifact_kind: "phase-design" } } },
      ] as unknown as RequestDigestSubject[],
      archflow_waiver: [
        { ...requestSubjects.archflow_waiver!, operation_fields: { origin: { ...requestOrigin, origin_context_digest: digest("0") }, rationale: "A bounded exception is required" } },
        { ...requestSubjects.archflow_waiver!, operation_fields: { origin: requestOrigin, rationale: "A different exception is required" } },
      ] as unknown as RequestDigestSubject[],
    };
    for (const [name, variants] of Object.entries(mutations)) {
      const baseline = computeRequestDigest(requestSubjects[name]!);
      for (const variant of variants) expect(computeRequestDigest(variant), name).not.toBe(baseline);
    }
  });

  it("binds artifact kind and recomputed digest under each pinned state operation", () => {
    const cases = [
      ["adopt-task-initialization", "task-initialization"],
      ["adopt-legacy-import-initialization", "legacy-import-initialization"],
      ["record-document-artifact", "document"],
      ["record-implementation-output", "implementation-output"],
      ["adopt-manual-checkpoint-import", "manual-checkpoint-import"],
      ["record-triage", "triage"],
    ] as const;
    for (const [operation, artifact_kind] of cases) {
      const candidate = {
        ...requestCommon,
        tool: "archflow_state",
        operation,
        operation_fields: {
          phase_instance: phaseInstance,
          step: "produce",
          status: "succeeded",
          artifact_kind,
          artifact_digest: digest("1"),
        },
      } as RequestDigestSubject;
      const baseline = computeRequestDigest(candidate);
      expect(computeRequestDigest({ ...candidate, operation_fields: { ...candidate.operation_fields, artifact_digest: digest("2") } } as unknown as RequestDigestSubject)).not.toBe(baseline);
      const wrongKind = artifact_kind === "document" ? "task-initialization" : "document";
      expect(() => computeRequestDigest({ ...candidate, operation_fields: { ...candidate.operation_fields, artifact_kind: wrongKind } } as RequestDigestSubject)).toThrow(/operation/u);
    }
  });

  it("rejects wrong operation literals and fields outside every closed selector", () => {
    for (const [name, value] of Object.entries(requestSubjects)) {
      expect(() => computeRequestDigest({ ...value, operation: "wrong" } as unknown as RequestDigestSubject), name).toThrow(/invalid/u);
      expect(() => computeRequestDigest({ ...value, operation_fields: { ...value.operation_fields, excluded_transport_field: "x" } } as unknown as RequestDigestSubject), name).toThrow(/contain exactly/u);
    }
  });

  it("excludes volatile request state: two requests differing only there share one digest", () => {
    // The volatile fields live on the request envelope, never inside the closed digest field list.
    const first = {
      intent_id: "intent-1",
      expected_revision: 7,
      timestamp: "2026-07-28T00:00:00.000Z",
      attempt: 1,
      connection_id: "connection-1",
      operation_fields: { phase_instance: phaseInstance, step: "produce", status: "succeeded" } satisfies StateOperationFields,
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
    const digestA = computeRequestDigest(requestSubject({ status: "succeeded", step: "produce", phase_instance: phaseInstance }));
    const digestB = computeRequestDigest(requestSubject({ phase_instance: phaseInstance, step: "produce", status: "succeeded" }));
    expect(digestA).toBe(digestB);
    expect(computeRequestDigest(requestSubject({ phase_instance: phaseInstance, step: "produce", status: "failed" }))).not.toBe(digestA);
  });

  it("rejects every field outside the closed tool selector", () => {
    const valid = { phase_instance: phaseInstance, step: "produce", status: "succeeded" } as const;
    for (const field of ["intent_id", "expected_revision", "timestamp", "attempt", "connection_id", "retry_reason"]) {
      expect(() => computeRequestDigest(requestSubject({ ...valid, [field]: "x" } as StateOperationFields)))
        .toThrow(/contain exactly/u);
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
    const smuggler = withGetter(requestSubject({ phase_instance: phaseInstance, step: "produce", status: "succeeded" }), "operation_fields", [
      { phase_instance: phaseInstance, step: "produce", status: "succeeded" },
      { phase_instance: phaseInstance, step: "produce", status: "failed" },
    ]);
    expect(() => computeRequestDigest(smuggler)).toThrow(/accessor properties are not JSON values/u);
  });

  it("rejects a getter nested inside operation_fields", () => {
    const fields = withGetter({ phase_instance: phaseInstance, step: "produce", status: "succeeded" } as const, "status", ["succeeded", "failed"]);
    expect(() => computeRequestDigest(requestSubject(fields)))
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

    const request = requestSubject({ phase_instance: phaseInstance, step: "produce", status: "succeeded" });
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
