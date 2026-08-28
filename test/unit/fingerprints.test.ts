import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, parseGitTreeMode, sha256Bytes, type CanonicalDocument } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  computeInputFingerprint,
  baselineAdoptionDriftDigest,
  computePinnedConstitutionDigest,
  computePinnedConfigDigest,
  computeRequestDigest,
  type DeclaredInputRef,
  type GitIdentityRef,
  type InputFingerprintSubject,
  type RequestDigestSubject,
} from "../../src/contracts/fingerprints.js";
import { parseToolCall, type ParsedToolCall } from "../../src/contracts/mcp-tools.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import type { RootBoundGitRunner } from "../../src/repository/identity.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import type { TransactionAuthority } from "../../src/state/authority.js";
import { createInternalInputFingerprintResolver } from "../../src/state/fingerprint.js";
import { readCanonicalDeclaredInputs, readCanonicalSecondaryDeclaredInputs } from "../../src/state/fingerprint-readers.js";
import type { FingerprintReadContext } from "../../src/state/read.js";

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
const requestEvidence = {
  set_digest: digest("8"),
  slots: [
    { role: "counter-review", evidence_digest: digest("6"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
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
  archflow_counter_review: { ...requestCommon, tool: "archflow_counter_review", operation: "counter-review", operation_fields: { artifact_path: "phases/9/result.md" } },
  archflow_gate: { ...requestCommon, tool: "archflow_gate", operation: "gate", operation_fields: { phase_instance: phaseInstance, summary: "Approve implementation", subject_digest: digest("7"), current_evidence: requestEvidence, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, preview_digest: digest("9"), decision: { choice: "approve", reason: "The reviewed artifact is ready." } } },
  archflow_waiver: { ...requestCommon, tool: "archflow_waiver", operation: "waiver", operation_fields: { origin: requestOrigin, rationale: "A bounded exception is required", preview_digest: digest("9"), decision: { choice: "grant", reason: "The bounded exception is acceptable." } } },
} as unknown as Readonly<Record<string, RequestDigestSubject>>;

const configUrl = new URL("../fixtures/contracts/fingerprints/config.yaml", import.meta.url);
const reorderedConfigUrl = new URL("../fixtures/contracts/fingerprints/config-reordered.yaml", import.meta.url);

describe("computeInputFingerprint", () => {
  it("preserves primary-only bytes and domain-separates secondary declared inputs", () => {
    const primaryOnly = computeInputFingerprint(subject);
    expect(computeInputFingerprint({ ...subject, secondary_declared_inputs: [] })).toBe(primaryOnly);
    const secondary = [{ repository: "api", declared_inputs: [declaredInput("api-contract", "7")] }] as const;
    const withSecondary = computeInputFingerprint({ ...subject, secondary_declared_inputs: secondary });
    expect(withSecondary).not.toBe(primaryOnly);
    expect(computeInputFingerprint({ ...subject, secondary_declared_inputs: [{ ...secondary[0], repository: "worker" }] })).not.toBe(withSecondary);
    expect(computeInputFingerprint({ ...subject, secondary_declared_inputs: [{ ...secondary[0], declared_inputs: [declaredInput("api-contract", "8")] }] })).not.toBe(withSecondary);
  });

  it("orders repository-qualified secondary input identities deterministically", () => {
    const api = {
      repository: "api" as const,
      declared_inputs: [declaredInput("api-schema", "1"), declaredInput("api-types", "2")],
    };
    const worker = {
      repository: "worker" as const,
      declared_inputs: [declaredInput("worker-schema", "3")],
    };
    const expected = computeInputFingerprint({
      ...subject,
      secondary_declared_inputs: [api, worker],
    });
    expect(computeInputFingerprint({
      ...subject,
      secondary_declared_inputs: [worker, { ...api, declared_inputs: [...api.declared_inputs].reverse() }],
    })).toBe(expected);
  });

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

describe("durable secondary declared-input fingerprint binding", () => {
  it("does not consult retained declarations for a PRD counter-review", async () => {
    const result = await readCanonicalSecondaryDeclaredInputs({
      call: { name: "archflow_counter_review", input: {} },
      state: { value: { phase_instance: "prd" } },
    } as never, async () => { throw new Error("PRD fingerprint/error ordering must not read retained declarations"); });
    expect(result).toEqual({ schema_version: "1", ok: true, value: [] });
  });

  it("reproduces the secondary addendum through review and triage boundaries while primary inputs stay caller-supplied", async () => {
    const primary = [declaredInput("primary-contract", "6")];
    const secondary = [{
      repository: "api",
      declared_inputs: [{ input_id: parseSafeId("api-contract"), digest: digest("7"), path: claim("schema.json") }],
    }];
    const artifact = {
      artifact_kind: "implementation-output",
      declared_inputs: primary,
      secondary_repositories: secondary,
    } as never;
    const readRetained = async () => ({ schema_version: "1" as const, ok: true as const, value: artifact });
    const calls = [
      { name: "archflow_state", input: { step: "counter_review", status: "running" } },
      { name: "archflow_counter_review", input: {} },
      { name: "archflow_state", input: { step: "triage", status: "running" } },
      { name: "archflow_state", input: { step: "triage", status: "succeeded", artifact: { artifact_kind: "triage" } } },
    ];
    const rubric_digest = (await loadTestRubric("phase-impl")).rubric_digest;
    // Follow-up steps never carried primary declared inputs before repository sets existed; only
    // the secondary addendum is folded in, so a primary-only task keeps its pre-existing bytes.
    const followupFingerprint = computeInputFingerprint({
      ...subject,
      rubric_digest,
      declared_inputs: [],
      secondary_declared_inputs: [{
        repository: "api" as const,
        declared_inputs: [declaredInput("api-contract", "7")],
      }],
    });
    const primaryOnlyFollowup = computeInputFingerprint({ ...subject, rubric_digest, declared_inputs: [] });
    const fingerprints = [];
    const primaryOnlyFingerprints = [];
    for (const call of calls) {
      const context = { call, state: { value: { phase_instance: phaseInstance } } } as never;
      const declared = await readCanonicalDeclaredInputs(context);
      const retainedSecondary = await readCanonicalSecondaryDeclaredInputs(context, readRetained);
      const primaryOnlySecondary = await readCanonicalSecondaryDeclaredInputs(context, async () => ({
        schema_version: "1" as const, ok: true as const,
        value: { artifact_kind: "implementation-output", declared_inputs: primary } as never,
      }));
      expect(declared.ok && retainedSecondary.ok && primaryOnlySecondary.ok).toBe(true);
      if (!declared.ok || !retainedSecondary.ok || !primaryOnlySecondary.ok) continue;
      expect(declared.value).toEqual([]);
      fingerprints.push(computeInputFingerprint({
        ...subject, rubric_digest, declared_inputs: declared.value, secondary_declared_inputs: retainedSecondary.value,
      }));
      primaryOnlyFingerprints.push(computeInputFingerprint({
        ...subject, rubric_digest, declared_inputs: declared.value, secondary_declared_inputs: primaryOnlySecondary.value,
      }));
    }
    expect(fingerprints).toEqual(Array(4).fill(followupFingerprint));
    expect(primaryOnlyFingerprints).toEqual(Array(4).fill(primaryOnlyFollowup));
  });

  it("prefers the caller-supplied implementation declaration for the initial result request", async () => {
    const result = await readCanonicalSecondaryDeclaredInputs({
      call: {
        name: "archflow_state",
        input: {
          artifact: {
            artifact_kind: "implementation-output", declared_inputs: [],
            secondary_repositories: [{ repository: "api", declared_inputs: [{ input_id: parseSafeId("fresh"), digest: digest("8") }] }],
          },
        },
      },
    } as never, async () => { throw new Error("retained authority must not replace the initial artifact"); });
    expect(result.ok && result.value[0]?.declared_inputs[0]?.input_id).toBe("fresh");
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
  it("pins stable golden digests for every closed selector", () => {
    expect(Object.fromEntries(Object.entries(requestSubjects).map(([name, value]) => [name, computeRequestDigest(value)]))).toEqual({
      archflow_state: "cbca6b1b7793de5edcfdbf3f4b4de1036309bab6c3ce06068cba8a42cee07a75",
      archflow_counter_review: "9b9c104471d275365527ac67fcfdadf22bad2f289cbf9ec73e437567b291ea5f",
      archflow_gate: "4e37f9d88c98c1ab8c15ed352d052a47fd052999155ef5f4c756298375c6d621",
      archflow_waiver: "13863ae006859443e4cd654f166b33f54a0567cfdb8aefa822adbf3cdc236c03",
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
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/other.md" } },
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/result.md", invocation_routes: { "counter-reviewer": { model: "claude-fable-5", effort: "high" } } } },
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/result.md", invocation_routes: { adjudicator: { model: "gpt-5.6", effort: "max" } } } },
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/result.md", route_override: { reason: "codex auth outage", "counter-reviewer": { model: "claude-opus-4-6", effort: "high" } } } },
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/result.md", route_override: { reason: "codex auth outage", "counter-reviewer": { model: "claude-opus-4-6", effort: "max" } } } },
        { ...requestSubjects.archflow_counter_review!, operation_fields: { artifact_path: "phases/9/result.md", route_override: { reason: "a different reason", "counter-reviewer": { model: "claude-opus-4-6", effort: "high" } } } },
      ] as unknown as RequestDigestSubject[],
      archflow_gate: [
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, phase_instance: "phase-impl-7" } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, summary: "Revise implementation" } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, subject_digest: digest("0") } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, current_evidence: { ...requestEvidence, set_digest: digest("0") } } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, kind: "commit-authorization" } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, context: { artifact_kind: "phase-design" } } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, preview_digest: digest("0") } },
        { ...requestSubjects.archflow_gate!, operation_fields: { ...requestSubjects.archflow_gate!.operation_fields, decision: { choice: "revise", reason: "Revise it." } } },
      ] as unknown as RequestDigestSubject[],
      archflow_waiver: [
        { ...requestSubjects.archflow_waiver!, operation_fields: { ...requestSubjects.archflow_waiver!.operation_fields, origin: { ...requestOrigin, origin_context_digest: digest("0") } } },
        { ...requestSubjects.archflow_waiver!, operation_fields: { ...requestSubjects.archflow_waiver!.operation_fields, rationale: "A different exception is required" } },
        { ...requestSubjects.archflow_waiver!, operation_fields: { ...requestSubjects.archflow_waiver!.operation_fields, preview_digest: digest("0") } },
        { ...requestSubjects.archflow_waiver!, operation_fields: { ...requestSubjects.archflow_waiver!.operation_fields, decision: { choice: "deny", reason: "The exception is not acceptable." } } },
      ] as unknown as RequestDigestSubject[],
    };
    for (const [name, variants] of Object.entries(mutations)) {
      const baseline = computeRequestDigest(requestSubjects[name]!);
      for (const variant of variants) expect(computeRequestDigest(variant), name).not.toBe(baseline);
    }
  });

  it("separates counter-review route overrides pairwise and keeps the selector closed", () => {
    const withOverride = (route_override: unknown): RequestDigestSubject => ({
      ...requestSubjects.archflow_counter_review!,
      operation_fields: { artifact_path: "phases/9/result.md", route_override },
    } as unknown as RequestDigestSubject);
    const digests = [
      computeRequestDigest(requestSubjects.archflow_counter_review!),
      computeRequestDigest(withOverride({ reason: "codex auth outage", "counter-reviewer": { model: "claude-opus-4-6", effort: "high" } })),
      computeRequestDigest(withOverride({ reason: "codex auth outage", adjudicator: { model: "claude-opus-4-6", effort: "high" } })),
      computeRequestDigest(withOverride({ reason: "codex auth outage", "counter-reviewer": { model: "claude-opus-4-6", effort: "high" }, adjudicator: { model: "claude-opus-4-6", effort: "high" } })),
      computeRequestDigest(withOverride({ reason: "rate limited until tomorrow", "counter-reviewer": { model: "claude-opus-4-6", effort: "high" } })),
    ];
    expect(new Set(digests).size).toBe(digests.length);
    expect(() => computeRequestDigest({
      ...requestSubjects.archflow_counter_review!,
      operation_fields: { artifact_path: "phases/9/result.md", unexpected: "field" },
    } as unknown as RequestDigestSubject)).toThrow(TypeError);
  });

  it("binds invocation routes and human route overrides independently", () => {
    const routed = (invocation_routes: unknown, route_override?: unknown): RequestDigestSubject => ({
      ...requestSubjects.archflow_counter_review!,
      operation_fields: {
        artifact_path: "phases/9/result.md",
        invocation_routes,
        ...(route_override === undefined ? {} : { route_override }),
      },
    } as unknown as RequestDigestSubject);
    const invocationRoutes = { "counter-reviewer": { model: "claude-fable-5", effort: "high" } };
    const override = { reason: "temporary outage", adjudicator: { model: "gpt-5.6", effort: "max" } };
    const digests = [
      computeRequestDigest(requestSubjects.archflow_counter_review!),
      computeRequestDigest(routed(invocationRoutes)),
      computeRequestDigest(routed({ adjudicator: { model: "gpt-5.6", effort: "max" } })),
      computeRequestDigest(routed(invocationRoutes, override)),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("binds artifact kind and recomputed digest under each pinned state operation", () => {
    const cases = [
      ["adopt-task-initialization", "task-initialization"],
      ["adopt-legacy-import-initialization", "legacy-import-initialization"],
      ["record-document-artifact", "document"],
      ["record-implementation-output", "implementation-output"],
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
      // A retry may refresh transport metadata without changing the semantic request.
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

describe("baseline adoption subject", () => {
  it("binds target identity and complete committedness while retaining legacy digest compatibility", () => {
    const drifted = [{ path: claim("src/a.ts"), recorded_digest: digest("1"), observed_digest: digest("2") }];
    const legacy = baselineAdoptionDriftDigest({ drifted_projections: drifted });
    const current = baselineAdoptionDriftDigest({
      drifted_projections: drifted,
      target_ref: "refs/heads/main",
      target_head: oid("a"),
      uncommitted_paths: [claim("src/a.ts")],
    });
    expect(current).not.toBe(legacy);
    expect(baselineAdoptionDriftDigest({
      drifted_projections: drifted,
      target_ref: "refs/heads/main",
      target_head: oid("a"),
      uncommitted_paths: [],
    })).not.toBe(current);
  });
});

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

describe("creation-time config provenance digest", () => {
  it("names the exact creation bytes and distinguishes every byte-level edit", async () => {
    // Provenance only: nothing compares live config against this digest anymore. It exists so
    // the initialization records can name the bytes the task was created with.
    const bytes = new Uint8Array(await readFile(configUrl));
    const pinned = computePinnedConfigDigest(bytes);
    expect(pinned).toBe(sha256Bytes(bytes));

    const oneByte = Uint8Array.from(bytes);
    oneByte[oneByte.length - 2] = oneByte[oneByte.length - 2]! ^ 0x20;
    const extraNewline = Uint8Array.from([...bytes, 0x0a]);
    const reordered = new Uint8Array(await readFile(reorderedConfigUrl));
    for (const observedBytes of [oneByte, extraNewline, reordered]) {
      expect(computePinnedConfigDigest(observedBytes)).not.toBe(pinned);
    }
  });
});

describe("internal input fingerprint resolver", () => {
  const ok = <T>(value: T) => Object.freeze({ schema_version: "1" as const, ok: true as const, value });

  const recordedState: CanonicalDocument<TaskStateV1> = canonicalDocument({
    schema_version: "1",
    task_id: parseTaskSlug("task-1"),
    repository_identity_digest: digest("e"),
    revision: parseSafeInteger(4),
    phase_instance: phaseInstance,
    step: "counter_review",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    input_fingerprint: digest("0"),
    initialization_digest: digest("3"),
    // The creation-time config bytes' digest — the only config value the resolver ever reads,
    // and only on the legacy fallback path.
    config_digest: digest("b"),
    workflow_digest: digest("a"),
    constitution_digest: digest("c"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [],
    approvals: [],
    waivers: [],
  });

  /** The pre-cutover composition: the same fields plus the creation-time config digest. */
  const legacyComposition = async (): Promise<ReturnType<typeof parseSha256Digest>> => canonicalJsonDigest({
    schema_version: "1",
    workflow_digest: recordedState.value.workflow_digest,
    config_digest: recordedState.value.config_digest,
    constitution_digest: recordedState.value.constitution_digest,
    artifact_identities: [...artifacts].sort((left, right) => left.path < right.path ? -1 : 1)
      .map(({ path, mode, oid: identityOid }) => ({ path, mode, oid: identityOid })),
    upstream_identities: [...upstream].sort((left, right) => left.path < right.path ? -1 : 1)
      .map(({ path, mode, oid: identityOid }) => ({ path, mode, oid: identityOid })),
    rubric_digest: (await loadTestRubric("phase-impl")).rubric_digest,
    phase_instance: phaseInstance,
    declared_inputs: [...declaredInputs].sort((left, right) => left.input_id < right.input_id ? -1 : 1)
      .map(({ input_id, digest: inputDigest }) => ({ input_id, digest: inputDigest })),
  });

  const context = (call: ParsedToolCall, expected?: ReturnType<typeof digest>): FingerprintReadContext<"archflow_counter_review"> => ({
    runner: {} as RootBoundGitRunner,
    authority: {} as TransactionAuthority,
    state: recordedState,
    call: call as never,
    // The live config the post-cutover edit produced: bytes and digest entirely unlike the
    // creation-time record. The resolver must never read it into any composition.
    live_config: { bytes: new Uint8Array(), digest: digest("f"), parsed: {} as never },
    ...(expected === undefined ? {} : { expected_input_fingerprint: expected }),
    context: {
      task_id: parseTaskSlug("task-1"),
      phase_instance: phaseInstance,
      operation: parseSafeCode("resolver-test"),
      attempt: parseSafeInteger(1),
    } satisfies RepositoryOperationContext,
  } as never);

  const counterReviewCall = (fingerprint: ReturnType<typeof digest>) => parseToolCall("archflow_counter_review", {
    schema_version: "1",
    task_id: "task-1",
    intent_id: "resolver-contract",
    expected_revision: 4,
    input_fingerprint: fingerprint,
    artifact_path: "phases/6/result.md",
  });

  const resolver = createInternalInputFingerprintResolver({
    read_workflow_digest: async () => ok(recordedState.value.workflow_digest),
    read_constitution_digest: async () => ok(recordedState.value.constitution_digest),
    read_artifact_identities: async () => ok(structuredClone(artifacts)),
    read_upstream_identities: async () => ok(structuredClone(upstream)),
    read_declared_inputs: async () => ok(structuredClone(declaredInputs)),
  });

  it("returns the new composition when no expected fingerprint is supplied", async () => {
    const result = await resolver(context(counterReviewCall(digest("0"))));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fingerprint).toBe(computeInputFingerprint({
      ...subject,
      rubric_digest: (await loadTestRubric("phase-impl")).rubric_digest,
    }));
    expect(Object.hasOwn(result.value.subject, "config_digest")).toBe(false);
  });

  it("accepts when the expected fingerprint equals the new composition", async () => {
    const expected = computeInputFingerprint({ ...subject, rubric_digest: (await loadTestRubric("phase-impl")).rubric_digest });
    const result = await resolver(context(counterReviewCall(expected), expected));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fingerprint).toBe(expected);
  });

  it("falls back to the legacy composition so a pre-cutover edit does not invalidate the record", async () => {
    // The recorded fingerprint was computed before config left the subject; the live bytes have
    // since changed (their digest is nothing like the creation-time record). The accepted value
    // still equals the recorded one, built from `state.config_digest`, never live bytes.
    const recorded = await legacyComposition();
    const result = await resolver(context(counterReviewCall(recorded), recorded));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fingerprint).toBe(recorded);
    expect(result.value.fingerprint).not.toBe(computeInputFingerprint({
      ...subject,
      rubric_digest: (await loadTestRubric("phase-impl")).rubric_digest,
    }));
  });

  it("never drops secondary declared inputs through the primary-only legacy fallback", async () => {
    const secondary = [{
      repository: "api" as const,
      declared_inputs: [declaredInput("api-contract", "7")],
    }];
    const secondaryResolver = createInternalInputFingerprintResolver({
      read_workflow_digest: async () => ok(recordedState.value.workflow_digest),
      read_constitution_digest: async () => ok(recordedState.value.constitution_digest),
      read_artifact_identities: async () => ok(structuredClone(artifacts)),
      read_upstream_identities: async () => ok(structuredClone(upstream)),
      read_declared_inputs: async () => ok(structuredClone(declaredInputs)),
      read_secondary_declared_inputs: async () => ok(structuredClone(secondary)),
    });
    const primaryLegacy = await legacyComposition();
    const result = await secondaryResolver(context(counterReviewCall(primaryLegacy), primaryLegacy));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fingerprint).not.toBe(primaryLegacy);
    expect(result.value.fingerprint).toBe(computeInputFingerprint({
      ...subject,
      rubric_digest: (await loadTestRubric("phase-impl")).rubric_digest,
      secondary_declared_inputs: secondary,
    }));
  });

  it("returns the new composition when the expected value matches neither composition", async () => {
    const result = await resolver(context(counterReviewCall(digest("9")), digest("9")));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The caller's existing mismatch error fires unchanged against this value.
    expect(result.value.fingerprint).toBe(computeInputFingerprint({
      ...subject,
      rubric_digest: (await loadTestRubric("phase-impl")).rubric_digest,
    }));
  });
});
