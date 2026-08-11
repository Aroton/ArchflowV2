import { describe, expect, it } from "vitest";

import type {
  AdjudicationEvidence,
  DerivedAdjudication,
} from "../../src/contracts/adjudication.js";
import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { ConstitutionRegistry } from "../../src/contracts/constitution.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { Sha256Digest } from "../../src/contracts/evidence.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import {
  currentEvidenceSetRef,
  parseRequiredReviewSlots,
} from "../../src/contracts/trust.js";
import {
  AdjudicationServiceError,
  crossCheckRuleFindings,
  selectAdjudicationGate,
  selectAdjudicationGates,
} from "../../src/review/adjudication.js";
import {
  assessCurrentEvidence,
  requireApprovedUpstreamDigests,
  waiverInForce,
} from "../../src/review/fixed-point.js";
import {
  deriveCurrentEvidenceSet,
  type RetainedEvidenceSet,
} from "../../src/state/evidence-results.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";

const D = (character: string): Sha256Digest => character.repeat(64) as Sha256Digest;
const constitution = await resolvedConstitutionFixture({
  "00-active-rule.md": `---
id: active-rule
version: 2
status: active
enforced_by:
  - tests
---
rule
`,
});

function state(overrides: Readonly<Record<string, unknown>> = {}): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: "task",
    repository_identity_digest: D("1"),
    revision: 8,
    phase_instance: "phase-impl-14",
    step: "triage",
    status: "succeeded",
    attempt: 1,
    input_fingerprint: D("2"),
    initialization_digest: D("3"),
    config_digest: D("4"),
    workflow_digest: D("5"),
    constitution_digest: constitution.digest,
    policy_base_commit: "7".repeat(40) as never,
    authoritative_results: [],
    approvals: [],
    waivers: [],
    ...overrides,
  } as unknown as TaskStateV1;
}

function retained(
  subject = D("8"),
  fingerprint = D("2"),
  accepted = 0,
  adjudicationFingerprint = fingerprint,
  approvedUpstreamDigests: readonly Sha256Digest[] = [],
): RetainedEvidenceSet {
  const base = {
    schema_version: "1",
    task_id: "task",
    phase_instance: "phase-impl-14",
    subject_digest: subject,
    input_fingerprint: fingerprint,
  } as const;
  const counter = {
    ...base,
    step: "counter_review",
    role: "counter-review",
    rubric_digest: D("c"),
    producer_family: "claude",
    findings: [{
      finding_id: "counter-finding",
      severity: "major",
      blocking: false,
      summary: "finding",
      evidence: "evidence",
      suggested_resolution: "resolve",
    }],
    matched_rule_versions: [],
    verdict: "advisory",
    blocking_count: 0,
    model_family: "codex",
    model: "gpt-test",
    effort: "medium",
    assurance: "server-attested",
    adapter: "codex-cli",
    cli_version: "1.0.0",
    invocation_id: "invocation",
    envelope_input_digest: D("d"),
    observed_output_digest: D("e"),
    result_id: "result",
  } as const;
  const counterDigest = canonicalJsonDigest(counter);
  const evidenceSet = currentEvidenceSetRef(parseRequiredReviewSlots([{
    role: "counter-review",
    evidence_digest: counterDigest,
    assurance: counter.assurance,
    producer_family: counter.producer_family,
    reviewer_family: counter.model_family,
    independence: "opposite-family",
  }]));
  const triage = {
    ...base,
    step: "triage",
    current_evidence_set_digest: evidenceSet.set_digest,
    source_evidence_digests: [counterDigest],
    dispositions: [{
      review_evidence_digest: counterDigest,
      finding_id: "counter-finding",
      disposition: accepted > 0 ? "accepted" : "rejected",
      rationale: "because",
      ...(accepted > 0 ? { revision_intent: "rewrite" } : { evidence: "not applicable" }),
    }],
    accepted_count: accepted,
    rejected_count: accepted > 0 ? 0 : 1,
  } as const;
  const adjudication = {
    ...base,
    input_fingerprint: adjudicationFingerprint,
    step: "adjudicate",
    pinned_constitution_digest: constitution.digest,
    approved_upstream_digests: approvedUpstreamDigests,
    source_evidence_set_digest: evidenceSet.set_digest,
    rule_findings: [],
    drift_findings: [],
    constitution: "pass",
    drift: "aligned",
    matched_rule_versions: [],
    uncertain_rule_versions: [],
    model_family: "codex",
    model: "gpt-test",
    effort: "medium",
    assurance: "agent-declared",
  } as const;
  const manifest = (
    step: "counter_review" | "triage" | "adjudicate",
    digest: Sha256Digest,
    artifact: ResultManifestV1["source_artifact"],
  ) => ({
    reference: { step },
    manifest: { artifact_digest: digest, source_artifact: artifact },
  }) as unknown as RetainedEvidenceSet extends ReadonlyMap<unknown, infer V> ? V : never;
  return new Map([
    ["counter_review", manifest("counter_review", counterDigest, {
      schema_version: "1", artifact_kind: "review-evidence", evidence: counter as never,
    })],
    ["triage", manifest("triage", D("c"), {
      schema_version: "1", artifact_kind: "triage", evidence: triage as never,
    })],
    ["adjudicate", manifest("adjudicate", D("d"), {
      schema_version: "1", artifact_kind: "adjudication-evidence", evidence: adjudication as never,
    })],
  ]) as RetainedEvidenceSet;
}

function adjudication(): DerivedAdjudication {
  return {
    schema_version: "1",
    task_id: "task",
    phase_instance: "phase-impl-14",
    step: "adjudicate",
    subject_digest: D("8"),
    input_fingerprint: D("2"),
    pinned_constitution_digest: constitution.digest,
    approved_upstream_digests: [],
    source_evidence_set_digest: D("f"),
    rule_findings: [{
      rule_id: "active-rule",
      rule_version: 2,
      compliance: "uncertain",
      rationale: "needs mechanical proof",
      trigger: "not-matched",
      trigger_evidence: "none",
      enforced_by: [{ mechanism: "tests", state: "unknown", details: "not supplied" }],
    }],
    drift_findings: [],
    constitution: "uncertain",
    drift: "aligned",
    matched_rule_versions: [],
    uncertain_rule_versions: [],
  } as unknown as DerivedAdjudication;
}

describe("review services", () => {
  it("cross-checks exact active registry coverage and declared mechanisms", () => {
    const registry: ConstitutionRegistry = new Map([
      ["active-rule", {
        id: "active-rule", version: 2, status: "active", text: "rule", enforced_by: ["tests"],
      }],
      ["old-rule", { id: "old-rule", version: 1, status: "deprecated", text: "old" }],
    ]);
    expect(crossCheckRuleFindings(registry, adjudication()).rule_findings).toHaveLength(1);
    expect(() => crossCheckRuleFindings(registry, {
      ...adjudication(),
      rule_findings: [{ ...adjudication().rule_findings[0]!, compliance: "pass" }],
      constitution: "pass",
    }, "codex-cli")).toThrow(AdjudicationServiceError);
    expect(() => crossCheckRuleFindings(registry, {
      ...adjudication(),
      rule_findings: [{ ...adjudication().rule_findings[0]!, rule_version: 3 }],
    }, "codex-cli")).toThrow(AdjudicationServiceError);
  });

  it("checks exhaustion only when an accepted finding requires re-entry", () => {
    const clean = assessCurrentEvidence(state({ attempt: 3 }), retained(), {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution, max_attempts: 3,
    });
    expect(clean.next).toBe("advance");
    expect(clean.exhausted).toBe(false);

    const rewrite = assessCurrentEvidence(state({ attempt: 3 }), retained(D("8"), D("2"), 1), {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution, max_attempts: 3,
    });
    expect(rewrite.next).toBe("attempts-exhausted");
    expect(rewrite.reentry_required).toBe(true);
  });

  it("never exhausts on an editorial revision, even at the final attempt slot", () => {
    // The shared movement rule makes the editorial produce re-entry consume a durable attempt
    // slot (attempt + 1); the fixed point stays honest by evaluating exhaustion only at demanded
    // re-entries, so the editorial pass itself can never open the attempts-exhausted gate.
    const editorial = new Map(retained());
    const triageEntry = editorial.get("triage")!;
    const triageSource = triageEntry.manifest.source_artifact;
    if (triageSource.artifact_kind !== "triage") throw new Error("expected triage evidence");
    editorial.set("triage", {
      ...triageEntry,
      manifest: {
        ...triageEntry.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "triage",
          evidence: {
            ...triageSource.evidence,
            dispositions: [{
              review_evidence_digest: triageSource.evidence.dispositions[0]!.review_evidence_digest,
              finding_id: "counter-finding",
              disposition: "accepted-editorial",
              rationale: "wording only",
              revision_intent: "fix the typo",
            }],
            accepted_count: 0,
            rejected_count: 0,
            accepted_editorial_count: 1,
          } as never,
        },
      },
    });
    const assessment = assessCurrentEvidence(state({ attempt: 3 }), editorial, {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution, max_attempts: 3,
    });
    expect(assessment).toMatchObject({
      editorial_revision_required: true,
      reentry_required: false,
      exhausted: false,
      next: "produce",
    });
  });

  it("requires triage and adjudication to bind the exact retained review set", () => {
    const subject = {
      subject_digest: D("8"),
      input_fingerprint: D("2"),
      constitution,
    };
    expect(assessCurrentEvidence(state(), retained(), subject).next).toBe("advance");

    const replaced = new Map(retained());
    const counterEntry = replaced.get("counter_review")!;
    const counterSource = counterEntry.manifest.source_artifact;
    if (counterSource.artifact_kind !== "review-evidence") {
      throw new Error("expected counter-review evidence");
    }
    const replacement = {
      ...counterSource.evidence,
      model: "replacement-model",
    };
    replaced.set("counter_review", {
      ...counterEntry,
      manifest: {
        ...counterEntry.manifest,
        artifact_digest: canonicalJsonDigest(replacement),
        source_artifact: {
          schema_version: "1",
          artifact_kind: "review-evidence",
          evidence: replacement,
        },
      },
    });
    expect(assessCurrentEvidence(state(), replaced, subject)).toMatchObject({
      current: ["counter_review"],
      stale: ["triage", "adjudicate"],
      next: "triage",
    });

    const wrongTriage = new Map(retained());
    const triageEntry = wrongTriage.get("triage")!;
    const triageSource = triageEntry.manifest.source_artifact;
    if (triageSource.artifact_kind !== "triage") throw new Error("expected triage evidence");
    wrongTriage.set("triage", {
      ...triageEntry,
      manifest: {
        ...triageEntry.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "triage",
          evidence: {
            ...triageSource.evidence,
            current_evidence_set_digest: D("9"),
          },
        },
      },
    });
    expect(assessCurrentEvidence(state(), wrongTriage, subject).next).toBe("triage");

    const wrongAdjudication = new Map(retained());
    const adjudicationEntry = wrongAdjudication.get("adjudicate")!;
    const adjudicationSource = adjudicationEntry.manifest.source_artifact;
    if (adjudicationSource.artifact_kind !== "adjudication-evidence") {
      throw new Error("expected adjudication evidence");
    }
    wrongAdjudication.set("adjudicate", {
      ...adjudicationEntry,
      manifest: {
        ...adjudicationEntry.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "adjudication-evidence",
          evidence: {
            ...adjudicationSource.evidence,
            source_evidence_set_digest: D("9"),
          },
        },
      },
    });
    expect(assessCurrentEvidence(state(), wrongAdjudication, subject).next)
      .toBe("adjudicate");
  });

  it("makes retained adjudication stale when the currently approved upstream digests change", () => {
    const approved = D("6");
    const evidence = retained(D("8"), D("2"), 0, D("2"), [approved]);
    expect(assessCurrentEvidence(state(), evidence, {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution,
      approved_upstream_digests: [approved],
    }).next).toBe("advance");
    expect(assessCurrentEvidence(state({ step: "adjudicate", status: "succeeded" }), evidence, {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution,
      approved_upstream_digests: [D("7")],
    })).toMatchObject({
      current: ["counter_review", "triage"],
      stale: ["adjudicate"],
      next: "produce",
      reentry_required: true,
    });
  });

  it.each([
    ["same family as its producer", { model_family: "claude" as const }],
    ["wrong role", { role: "gate-counter-review" as const }],
  ])("rejects a retained counter-review that is %s", (_label, change) => {
    const changed = new Map(retained());
    const entry = changed.get("counter_review")!;
    const source = entry.manifest.source_artifact;
    if (source.artifact_kind !== "review-evidence") {
      throw new Error("expected counter-review evidence");
    }
    const evidence = { ...source.evidence, ...change };
    changed.set("counter_review", {
      ...entry,
      manifest: {
        ...entry.manifest,
        artifact_digest: canonicalJsonDigest(evidence),
        source_artifact: {
          schema_version: "1",
          artifact_kind: "review-evidence",
          evidence,
        },
      },
    });
    expect(() => deriveCurrentEvidenceSet(changed))
      .toThrow(/one current review set/u);
  });

  it("requires an authentic constitution matching state and retained adjudication", () => {
    const subject = {
      subject_digest: D("8"),
      input_fingerprint: D("2"),
      constitution,
    };
    expect(() => assessCurrentEvidence(
      state({ constitution_digest: D("f") }),
      retained(),
      subject,
    )).toThrow(/does not match durable state/u);
    expect(() => assessCurrentEvidence(
      state(),
      retained(),
      { ...subject, constitution: { ...constitution } as never },
    )).toThrow(/authentic resolved constitution/u);

    const mismatched = new Map(retained());
    const entry = mismatched.get("adjudicate")!;
    const source = entry.manifest.source_artifact;
    if (source.artifact_kind !== "adjudication-evidence") {
      throw new Error("expected adjudication evidence");
    }
    mismatched.set("adjudicate", {
      ...entry,
      manifest: {
        ...entry.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "adjudication-evidence",
          evidence: { ...source.evidence, pinned_constitution_digest: D("f") },
        },
      },
    });
    expect(() => assessCurrentEvidence(state(), mismatched, subject))
      .toThrow(/retained adjudication/u);
  });

  it("selects adjudication gates in compliance, material-drift, then trigger order", () => {
    const registry: ConstitutionRegistry = new Map([
      ["active-rule", {
        id: "active-rule", version: 2, status: "active", text: "rule", enforced_by: ["tests"],
      }],
    ]);
    const base = {
      ...adjudication(),
      assurance: "agent-declared",
      model_family: "codex",
      model: "gpt-test",
      effort: "medium",
      drift_findings: [{
        upstream_digest: D("a"),
        drift: "material",
        affected_claim_ids: ["claim"],
        rationale: "changed",
      }],
      drift: "material",
      matched_rule_versions: [{ rule_id: "active-rule", rule_version: 2 }],
    } as unknown as AdjudicationEvidence;
    expect(selectAdjudicationGate(registry, base)?.kind).toBe("adjudication-failure");
    expect(selectAdjudicationGates(registry, base).map((gate) => gate.kind)).toEqual([
      "adjudication-failure",
      "material-drift",
      "review-trigger",
    ]);

    const material = {
      ...base,
      rule_findings: [{
        ...adjudication().rule_findings[0]!,
        compliance: "pass",
        enforced_by: [],
      }],
      constitution: "pass",
    } as unknown as AdjudicationEvidence;
    expect(selectAdjudicationGate(registry, material)?.kind).toBe("material-drift");

    const trigger = {
      ...material,
      drift_findings: [],
      drift: "aligned",
    } as unknown as AdjudicationEvidence;
    expect(selectAdjudicationGate(registry, trigger)?.kind).toBe("review-trigger");
  });

  it("requires each simultaneous adjudication obligation to be resolved exactly", () => {
    const registry: ConstitutionRegistry = new Map([
      ["active-rule", {
        id: "active-rule", version: 2, status: "active", text: "rule", enforced_by: ["tests"],
      }],
    ]);
    const evidence = {
      ...adjudication(),
      task_id: "task",
      phase_instance: "phase-impl-14",
      subject_digest: D("8"),
      input_fingerprint: D("2"),
      drift_findings: [{
        upstream_digest: D("a"),
        drift: "material",
        affected_claim_ids: ["claim"],
        rationale: "changed",
      }],
      drift: "material",
      matched_rule_versions: [{ rule_id: "active-rule", rule_version: 2 }],
      uncertain_rule_versions: [{ rule_id: "active-rule", rule_version: 2 }],
    } as unknown as AdjudicationEvidence;
    const gates = selectAdjudicationGates(registry, evidence);
    expect(gates.map((gate) => gate.kind)).toEqual([
      "adjudication-failure",
      "material-drift",
      "review-trigger",
    ]);

    const evidenceSet = new Map(retained());
    const sourceEvidenceSetDigest =
      deriveCurrentEvidenceSet(evidenceSet).current_evidence_set.set_digest;
    const existing = evidenceSet.get("adjudicate")!;
    evidenceSet.set("adjudicate", {
      ...existing,
      manifest: {
        ...existing.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "adjudication-evidence",
          evidence: { ...evidence, source_evidence_set_digest: sourceEvidenceSetDigest },
        },
      },
    });
    const adjudicationFailure = gates[0]!;
    const materialDrift = gates[1]!;
    const liveFailureWaiver = {
      gate_id: "waiver",
      rule_id: "active-rule",
      rule_version: 2,
      subject_digest: D("8"),
      scope: { operation: "adjudication-failure", boundary: "subject" },
      granted: true,
      expires: "task-complete",
      granted_at_revision: 4,
    } as const;
    const afterFailureWaiver = assessCurrentEvidence(
      state({
        step: "adjudicate",
        status: "succeeded",
        waivers: [liveFailureWaiver],
      }),
      evidenceSet,
      { subject_digest: D("8"), input_fingerprint: D("2"), constitution },
    );
    expect(afterFailureWaiver.next).toBe("adjudication-gate");
    expect(afterFailureWaiver.adjudication_gate_pending).toBe(false);

    const withMaterialOpen = assessCurrentEvidence(
      state({
        step: "adjudicate",
        status: "succeeded",
        waivers: [liveFailureWaiver],
        open_gate: {
          gate_id: "material-gate",
          gate_kind: materialDrift.kind,
          subject_digest: materialDrift.subject_digest,
          context_digest: computeGateContextDigest(materialDrift.kind, materialDrift.context),
          frozen_state_digest: D("f"),
          opened_at_revision: 8,
        },
      }),
      evidenceSet,
      { subject_digest: D("8"), input_fingerprint: D("2"), constitution },
    );
    expect(withMaterialOpen.next).toBe("adjudication-gate");
    expect(withMaterialOpen.adjudication_gate_pending).toBe(true);
    expect(computeGateContextDigest(
      adjudicationFailure.kind,
      adjudicationFailure.context,
    )).not.toBe(computeGateContextDigest(materialDrift.kind, materialDrift.context));
  });

  it("requires adjudication re-entry when retained evidence is stale", () => {
    const assessment = assessCurrentEvidence(
      state({ step: "adjudicate", attempt: 2 }),
      retained(D("8"), D("9"), 0, D("9")),
      { subject_digest: D("8"), input_fingerprint: D("2"), constitution },
    );
    expect(assessment.stale).toContain("adjudicate");
    expect(assessment.next).toBe("produce");
  });

  it("keeps a selected adjudication gate durable across publication crashes and non-advancing closure", () => {
    const registry: ConstitutionRegistry = new Map([
      ["active-rule", {
        id: "active-rule", version: 2, status: "active", text: "rule", enforced_by: ["tests"],
      }],
    ]);
    const evidence = {
      ...adjudication(),
      task_id: "task",
      phase_instance: "phase-impl-14",
      subject_digest: D("8"),
      input_fingerprint: D("2"),
      rule_findings: [{
        ...adjudication().rule_findings[0]!,
        rule_id: "active-rule",
        rule_version: 2,
      }],
      uncertain_rule_versions: [{ rule_id: "active-rule", rule_version: 2 }],
    } as unknown as AdjudicationEvidence;
    const selected = selectAdjudicationGate(registry, evidence);
    expect(selected?.kind).toBe("adjudication-failure");
    if (selected === undefined) throw new Error("expected gate");
    const gated = new Map(retained());
    const sourceEvidenceSetDigest =
      deriveCurrentEvidenceSet(gated).current_evidence_set.set_digest;
    const existing = gated.get("adjudicate")!;
    gated.set("adjudicate", {
      ...existing,
      manifest: {
        ...existing.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "adjudication-evidence",
          evidence: { ...evidence, source_evidence_set_digest: sourceEvidenceSetDigest },
        },
      },
    });
    const subject = {
      subject_digest: D("8"),
      input_fingerprint: D("2"),
      constitution,
    };

    const afterCommitCrash = assessCurrentEvidence(
      state({ step: "adjudicate", status: "succeeded" }),
      gated,
      subject,
    );
    expect(afterCommitCrash.next).toBe("adjudication-gate");
    expect(afterCommitCrash.adjudication_gate_pending).toBe(false);

    const openGate = {
      gate_id: "selected-gate",
      gate_kind: selected.kind,
      subject_digest: selected.subject_digest,
      context_digest: computeGateContextDigest(selected.kind, selected.context),
      frozen_state_digest: D("f"),
      opened_at_revision: 8,
    };
    const resumed = assessCurrentEvidence(
      state({ step: "adjudicate", status: "succeeded", open_gate: openGate }),
      gated,
      subject,
    );
    expect(resumed.next).toBe("adjudication-gate");
    expect(resumed.adjudication_gate_pending).toBe(true);

    // A rejected/cancelled/non-advancing closure leaves no ApprovalRef and remains gated.
    expect(assessCurrentEvidence(
      state({ step: "adjudicate", status: "succeeded" }),
      gated,
      subject,
    ).next).toBe("adjudication-gate");

    const unauthenticated = assessCurrentEvidence(
      state({
        step: "adjudicate",
        status: "succeeded",
        approvals: [{
          gate_id: "selected-gate",
          gate_kind: selected.kind,
          subject_digest: selected.subject_digest,
          decision_digest: D("e"),
          resolved_at_revision: 9,
        }],
      }),
      gated,
      subject,
    );
    expect(unauthenticated.next).toBe("adjudication-gate");
  });

  it("binds upstream approvals and waivers to exact durable tuples", () => {
    const approval = {
      gate_id: "gate",
      gate_kind: "artifact-approval",
      subject_digest: D("8"),
      decision_digest: D("9"),
      resolved_at_revision: 2,
    } as const;
    expect(requireApprovedUpstreamDigests([approval as never], [D("8")])).toEqual([D("8")]);
    expect(() => requireApprovedUpstreamDigests([], [D("8")])).toThrow(/lacks current/u);

    const live = state({
      waivers: [{
        gate_id: "waiver",
        rule_id: "active-rule",
        rule_version: 2,
        subject_digest: D("8"),
        scope: { operation: "review-trigger", boundary: "subject" },
        granted: true,
        expires: "task-complete",
        granted_at_revision: 4,
      }],
    });
    expect(waiverInForce(
      live,
      { rule_id: "active-rule", rule_version: 2 },
      D("8"),
      { operation: "review-trigger", boundary: "subject" },
    )).toBeDefined();
    expect(waiverInForce(
      { ...live, terminal: "complete" },
      { rule_id: "active-rule", rule_version: 2 },
      D("8"),
      { operation: "review-trigger", boundary: "subject" },
    )).toBeUndefined();
    expect(waiverInForce(
      { ...live, terminal: "abandoned" },
      { rule_id: "active-rule", rule_version: 2 },
      D("8"),
      { operation: "review-trigger", boundary: "subject" },
    )).toBeUndefined();
  });
});
