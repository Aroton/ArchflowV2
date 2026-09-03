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
import type { EffortAssessmentV1 } from "../../src/contracts/effort-review.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
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
  retainedReviewEnvelopeDigest,
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
  phaseInstance = "phase-impl-14",
): RetainedEvidenceSet {
  const base = {
    schema_version: "1",
    task_id: "task",
    phase_instance: phaseInstance,
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
    source_review_envelope_digest: D("d"),
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

function phaseDesignRetained(status?: "ready" | "blocked", attempt = 1): RetainedEvidenceSet {
  const entries = new Map(retained());
  const counterEntry = entries.get("counter_review")!;
  const counterSource = counterEntry.manifest.source_artifact;
  if (counterSource.artifact_kind !== "review-evidence") throw new Error("expected review evidence");
  const effort = status === undefined ? undefined : {
    schema_version: "1",
    task_id: "task",
    phase_instance: "phase-design-14",
    attempt,
    subject_digest: D("8"),
    input_fingerprint: D("2"),
    component_manifest_digest: D("3"),
    hazard_registry_digest: D("4"),
    policy_id: "implementation-effort-v1",
    decomposition: { status: "adequate", rationale: "The component is independently scoreable." },
    judgments: [{
      component_id: "api-boundary",
      axes: {
        A: { score: 0, rationale: "small" }, B: { score: 0, rationale: "local" },
        C: { score: 0, rationale: "direct" },
        D: { score: status === "blocked" ? 2 : 0, rationale: "specified" },
        E: { score: 0, rationale: "safe" },
      },
      long_tool_loop: { value: "no", rationale: "bounded" },
      short_component: { value: "yes", rationale: "small" },
      ...(status === "blocked" ? { blocker: { answer_kind: "priority-order", question: "Which API owns retries?" } } : {}),
    }],
    reviewer: {
      adapter: "codex-cli", cli_version: "1.0.0", model_family: "codex",
      model: "gpt-5.6-luna", effort: "xhigh", invocation_id: "effort-invocation",
      result_id: "effort-result", envelope_input_digest: D("5"), observed_output_digest: D("6"),
      route_source: { provenance: "configured" },
      repositories: [{ name: "primary", repository_identity_digest: D("7"), commit: "8".repeat(40) }],
    },
    recommendation: status === "ready"
      ? {
          status: "ready", blockers: [], component_profiles: [{
            component_id: "api-boundary", total: 0,
            profile: { profile_id: "gemini-3-7-flash-max", model: "gemini-3.7-flash", effort: "max" },
            caveats: [],
          }],
          phase_profile: { profile_id: "gemini-3-7-flash-max", model: "gemini-3.7-flash", effort: "max" },
          determining_component_ids: ["api-boundary"],
        }
      : { status: "blocked", component_profiles: [], blockers: [{
          kind: "specification-gap", component_id: "api-boundary", answer_kind: "priority-order", question: "Which API owns retries?",
        }] },
  } as unknown as EffortAssessmentV1;
  const counter = {
    ...counterSource.evidence,
    phase_instance: "phase-design-14",
    ...(effort === undefined ? {} : { effort_review: effort }),
  };
  const counterDigest = canonicalJsonDigest(counter);
  const evidenceSet = currentEvidenceSetRef(parseRequiredReviewSlots([{
    role: "counter-review",
    evidence_digest: counterDigest,
    assurance: counter.assurance,
    producer_family: counter.producer_family,
    reviewer_family: counter.model_family,
  }]));
  entries.set("counter_review", {
    ...counterEntry,
    manifest: {
      ...counterEntry.manifest,
      artifact_digest: counterDigest,
      source_artifact: { schema_version: "1", artifact_kind: "review-evidence", evidence: counter },
    },
  } as never);
  const triageEntry = entries.get("triage")!;
  const triageSource = triageEntry.manifest.source_artifact;
  if (triageSource.artifact_kind !== "triage") throw new Error("expected triage evidence");
  entries.set("triage", {
    ...triageEntry,
    manifest: {
      ...triageEntry.manifest,
      source_artifact: { schema_version: "1", artifact_kind: "triage", evidence: {
        ...triageSource.evidence,
        phase_instance: "phase-design-14",
        current_evidence_set_digest: evidenceSet.set_digest,
        source_evidence_digests: [counterDigest],
        dispositions: triageSource.evidence.dispositions.map((item) => ({
          ...item, review_evidence_digest: counterDigest,
        })),
      } },
    },
  } as never);
  const adjudicationEntry = entries.get("adjudicate")!;
  const adjudicationSource = adjudicationEntry.manifest.source_artifact;
  if (adjudicationSource.artifact_kind !== "adjudication-evidence") throw new Error("expected adjudication evidence");
  entries.set("adjudicate", {
    ...adjudicationEntry,
    manifest: {
      ...adjudicationEntry.manifest,
      source_artifact: { schema_version: "1", artifact_kind: "adjudication-evidence", evidence: {
        ...adjudicationSource.evidence, phase_instance: "phase-design-14",
      } },
    },
  } as never);
  return entries as RetainedEvidenceSet;
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
    source_review_envelope_digest: D("f"),
    rule_findings: [{
      rule_id: "active-rule",
      rule_version: 2,
      compliance: "fail",
      rationale: "the artifact violates the rule",
      trigger: "not-matched",
      trigger_evidence: "none",
    }],
    drift_findings: [],
    constitution: "fail",
    drift: "aligned",
    matched_rule_versions: [],
    uncertain_rule_versions: [],
  } as unknown as DerivedAdjudication;
}

describe("review services", () => {
  it("cross-checks exact active registry coverage, ignoring declared mechanisms", () => {
    const registry: ConstitutionRegistry = new Map([
      ["active-rule", {
        id: "active-rule", version: 2, status: "active", text: "rule", enforced_by: ["tests"],
      }],
      ["old-rule", { id: "old-rule", version: 1, status: "deprecated", text: "old" }],
    ]);
    expect(crossCheckRuleFindings(registry, adjudication()).rule_findings).toHaveLength(1);
    // The rule declares enforced_by; that must not stand between it and a pass.
    const passing = {
      ...adjudication(),
      rule_findings: [{ ...adjudication().rule_findings[0]!, compliance: "pass" }],
      constitution: "pass",
    } as unknown as DerivedAdjudication;
    expect(crossCheckRuleFindings(registry, passing, "codex-cli")).toBe(passing);
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

  it("preserves review currency for one simple human-revision hop and resets significant changes", () => {
    const predecessorEvidence = retained(D("8"), D("2"));
    const simple = assessCurrentEvidence(state({ attempt: 3, input_fingerprint: D("9") }), predecessorEvidence, {
      subject_digest: D("a"), input_fingerprint: D("9"), constitution, max_attempts: 3,
      review_predecessor: { subject_digest: D("8"), input_fingerprint: D("2") },
    });
    expect(simple).toMatchObject({ next: "advance", exhausted: false });

    const significant = assessCurrentEvidence(state({ attempt: 1, input_fingerprint: D("9") }), new Map(), {
      subject_digest: D("a"), input_fingerprint: D("9"), constitution, max_attempts: 3,
    });
    expect(significant).toMatchObject({ next: "counter_review", exhausted: false });
  });

  it("requires exact-current review evidence for changed phase designs", () => {
    const phaseState = state({ phase_instance: "phase-design-14" });
    const subject = { subject_digest: D("8"), input_fingerprint: D("2"), constitution, max_attempts: 3 };
    expect(assessCurrentEvidence(phaseState, phaseDesignRetained("ready"), subject)).toMatchObject({ next: "advance" });
    expect(assessCurrentEvidence(phaseState, phaseDesignRetained(), subject)).toMatchObject({ next: "advance" });
    expect(assessCurrentEvidence(phaseState, phaseDesignRetained("ready"), {
      ...subject,
      subject_digest: D("a"),
      review_predecessor: { subject_digest: D("8"), input_fingerprint: D("2") },
    })).toMatchObject({ next: "counter_review" });
  });

  it("never lets archived effort blockers affect the fixed point", () => {
    const subject = { subject_digest: D("8"), input_fingerprint: D("2"), constitution, max_attempts: 3 };
    expect(assessCurrentEvidence(
      state({ phase_instance: "phase-design-14", attempt: 1 }), phaseDesignRetained("blocked"), subject,
    )).toMatchObject({ next: "advance", reentry_required: false, exhausted: false });
    expect(assessCurrentEvidence(
      state({ phase_instance: "phase-design-14", attempt: 3 }), phaseDesignRetained("blocked", 3), subject,
    )).toMatchObject({ next: "advance", exhausted: false });
  });

  it("never lets a simple human revision clear an accepted material finding", () => {
    const predecessorSubject = D("8");
    const predecessorFingerprint = D("2");
    const resultingSubject = D("a");
    const resultingFingerprint = D("9");
    const produceResultDigest = D("f");
    const accepted = retained(predecessorSubject, predecessorFingerprint, 1);
    const exactRevision = {
      phase_instance: "phase-impl-14",
      gate_id: "simple-revision",
      gate_kind: "attempts-exhausted",
      predecessor_subject_digest: predecessorSubject,
      predecessor_input_fingerprint: predecessorFingerprint,
      resulting_subject_digest: resultingSubject,
      resulting_result_digest: produceResultDigest,
      classification: "simple",
      rationale: "Wording only.",
      previous_attempt: 3,
      resulting_attempt: 3,
      evidence: [],
    } as const;
    const currentProduce = {
      phase_instance: "phase-impl-14",
      step: "produce",
      result_digest: produceResultDigest,
      result_id: "current-produce",
      input_fingerprint: resultingFingerprint,
    } as const;
    const subject = {
      subject_digest: resultingSubject,
      input_fingerprint: resultingFingerprint,
      constitution,
      max_attempts: 3,
      review_predecessor: {
        subject_digest: predecessorSubject,
        input_fingerprint: predecessorFingerprint,
      },
    } as const;
    const completed = assessCurrentEvidence(state({
      step: "produce",
      status: "succeeded",
      attempt: 3,
      input_fingerprint: resultingFingerprint,
      authoritative_results: [currentProduce],
      human_revision_history: [exactRevision],
    }), accepted, subject);
    expect(completed).toMatchObject({ next: "triage", blocker_remains: false, exhausted: false });

    for (const mismatch of [
      { ...exactRevision, classification: "significant" as const },
      { ...exactRevision, resulting_subject_digest: D("b") },
      { ...exactRevision, resulting_result_digest: D("c") },
      { ...exactRevision, predecessor_input_fingerprint: D("d") },
    ]) {
      const rejected = assessCurrentEvidence(state({
        step: "produce",
        status: "succeeded",
        attempt: 3,
        input_fingerprint: resultingFingerprint,
        authoritative_results: [currentProduce],
        human_revision_history: [mismatch],
      }), accepted, subject);
      expect(rejected).toMatchObject({ next: "triage", blocker_remains: false });
    }
  });

  it("never exhausts on an editorial revision, even at the final attempt slot", () => {
    // The shared movement rule makes the editorial produce re-entry consume a durable attempt
    // slot (attempt + 1); the fixed point stays honest by evaluating exhaustion only at demanded
    // re-entries, so the editorial pass itself can never open the attempts-exhausted gate.
    const editorial = new Map(retained(D("8"), D("2"), 0, D("2"), [], "design"));
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
            escalated_human_count: 0,
            deferred_count: 0,
          } as never,
        },
      },
    });
    const assessment = assessCurrentEvidence(state({ attempt: 3, phase_instance: "design" }), editorial, {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution, max_attempts: 3,
    });
    expect(assessment).toMatchObject({
      editorial_revision_required: true,
      reentry_required: false,
      exhausted: false,
      next: "produce",
    });
  });

  it("requires triage to bind the exact review set and adjudication to bind its round", () => {
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
      current: ["counter_review", "adjudicate"],
      stale: ["triage"],
      // Triage binds the review payload's evidence set, so a replaced review stales it. The
      // constitution review binds the ROUND — the review envelope it was commissioned with —
      // which a payload replacement does not change; tampered review bytes still fail closed
      // at the manifest digest and gate slot checks.
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
            source_review_envelope_digest: D("9"),
          },
        },
      },
    });
    expect(assessCurrentEvidence(state(), wrongAdjudication, subject)).toMatchObject({
      next: "produce",
      reentry_required: true,
    });
  });

  it("makes retained adjudication stale when the currently approved upstream digests change", () => {
    const approved = D("6");
    const evidence = retained(D("8"), D("2"), 0, D("2"), [approved]);
    expect(assessCurrentEvidence(state(), evidence, {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution,
      approved_upstream_digests: [approved],
    }).next).toBe("advance");
    expect(assessCurrentEvidence(state({ step: "triage", status: "succeeded" }), evidence, {
      subject_digest: D("8"), input_fingerprint: D("2"), constitution,
      approved_upstream_digests: [D("7")],
    })).toMatchObject({
      current: ["counter_review", "triage"],
      stale: ["adjudicate"],
      next: "produce",
      reentry_required: true,
    });
  });

  it("derives a valid set from a retained counter-review in the producer's own family", () => {
    const changed = new Map(retained());
    const entry = changed.get("counter_review")!;
    const source = entry.manifest.source_artifact;
    if (source.artifact_kind !== "review-evidence") {
      throw new Error("expected counter-review evidence");
    }
    const evidence = { ...source.evidence, model_family: "claude" as const };
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
    const derived = deriveCurrentEvidenceSet(changed);
    expect(derived.current_evidence_set.slots[0]).toMatchObject({
      producer_family: "claude",
      reviewer_family: "claude",
    });
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

  it("selects one constitution-review gate, then material-drift", () => {
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
    // Failing compliance and a matched trigger on one rule are one decision, not two.
    expect(selectAdjudicationGate(registry, base)?.kind).toBe("constitution-review");
    expect(selectAdjudicationGates(registry, base).map((gate) => gate.kind)).toEqual([
      "constitution-review",
      "material-drift",
    ]);

    const material = {
      ...base,
      rule_findings: [{
        ...adjudication().rule_findings[0]!,
        compliance: "pass",
      }],
      constitution: "pass",
      matched_rule_versions: [],
    } as unknown as AdjudicationEvidence;
    expect(selectAdjudicationGates(registry, material).map((gate) => gate.kind)).toEqual([
      "material-drift",
    ]);

    // A rule declaring enforced_by is judged like any other: compliant means no gate at all.
    const clean = {
      ...material,
      drift_findings: [],
      drift: "aligned",
    } as unknown as AdjudicationEvidence;
    expect(selectAdjudicationGates(registry, clean)).toEqual([]);
  });

  it("re-enters production on a failed rule or material drift while attempts remain, and opens the gate once exhausted", () => {
    const evidenceSet = new Map(retained());
    const sourceEvidenceSetDigest = retainedReviewEnvelopeDigest(evidenceSet);
    if (sourceEvidenceSetDigest === undefined) throw new Error("fixture counter evidence is not server-attested");
    const existing = evidenceSet.get("adjudicate")!;
    const withAdjudication = (overrides: Record<string, unknown>): RetainedEvidenceSet => {
      const copy = new Map(evidenceSet);
      copy.set("adjudicate", {
        ...existing,
        manifest: {
          ...existing.manifest,
          source_artifact: {
            schema_version: "1",
            artifact_kind: "adjudication-evidence",
            evidence: { ...adjudication(), ...overrides, source_review_envelope_digest: sourceEvidenceSetDigest },
          },
        },
      } as never);
      return copy as RetainedEvidenceSet;
    };
    const subject = { subject_digest: D("8"), input_fingerprint: D("2"), constitution, max_attempts: 3 };

    // adjudication() fails the rule on compliance with its trigger not matched: producer work.
    const failed = withAdjudication({});
    const remaining = assessCurrentEvidence(state({ attempt: 1 }), failed, subject);
    expect(remaining.next).toBe("produce");
    expect(remaining.reentry_required).toBe(true);
    expect(remaining.policy_reentry_required).toBe(true);
    expect(remaining.exhausted).toBe(false);
    const exhausted = assessCurrentEvidence(state({ attempt: 3 }), failed, subject);
    expect(exhausted.next).toBe("adjudication-gate");
    expect(exhausted.policy_reentry_required).toBeUndefined();
    expect(exhausted.reentry_required).toBe(false);

    // Material drift from an approved upstream is the same producer work.
    const drifted = withAdjudication({
      rule_findings: [{ ...adjudication().rule_findings[0]!, compliance: "pass" }],
      constitution: "pass",
      approved_upstream_digests: [D("a")],
      drift_findings: [{ upstream_digest: D("a"), drift: "material", affected_claim_ids: ["claim"], rationale: "changed" }],
      drift: "material",
    });
    const driftSubject = { ...subject, approved_upstream_digests: [D("a")] };
    expect(assessCurrentEvidence(state({ attempt: 2 }), drifted, driftSubject)).toMatchObject({
      next: "produce", policy_reentry_required: true,
    });
    expect(assessCurrentEvidence(state({ attempt: 3 }), drifted, driftSubject).next).toBe("adjudication-gate");

    // A matched review trigger is the repository asking for a human: the gate opens at once.
    const triggered = withAdjudication({
      rule_findings: [{ ...adjudication().rule_findings[0]!, compliance: "pass", trigger: "matched", trigger_evidence: "observed" }],
      constitution: "pass",
      matched_rule_versions: [{ rule_id: "active-rule", rule_version: 2 }],
    });
    const immediate = assessCurrentEvidence(state({ attempt: 1 }), triggered, subject);
    expect(immediate.next).toBe("adjudication-gate");
    expect(immediate.policy_reentry_required).toBeUndefined();

    // An already-open gate is resumed, never abandoned for a re-entry.
    const gate = selectAdjudicationGate(constitution.rules, {
      ...adjudication(), source_review_envelope_digest: sourceEvidenceSetDigest,
    } as never)!;
    const resumed = assessCurrentEvidence(state({
      attempt: 1,
      open_gate: {
        gate_id: "policy-gate",
        gate_kind: gate.kind,
        subject_digest: gate.subject_digest,
        context_digest: computeGateContextDigest(gate.kind, gate.context),
        frozen_state_digest: D("f"),
        opened_at_revision: 8,
      },
    }), failed, subject);
    expect(resumed).toMatchObject({ next: "adjudication-gate", adjudication_gate_pending: true });
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
      "constitution-review",
      "material-drift",
    ]);

    const evidenceSet = new Map(retained());
    const sourceEvidenceSetDigest = retainedReviewEnvelopeDigest(evidenceSet);
    if (sourceEvidenceSetDigest === undefined) throw new Error("fixture counter evidence is not server-attested");
    const existing = evidenceSet.get("adjudicate")!;
    evidenceSet.set("adjudicate", {
      ...existing,
      manifest: {
        ...existing.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "adjudication-evidence",
          evidence: { ...evidence, source_review_envelope_digest: sourceEvidenceSetDigest },
        },
      },
    });
    const constitutionReview = gates[0]!;
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
        step: "triage",
        status: "succeeded",
        waivers: [liveFailureWaiver],
      }),
      evidenceSet,
      { subject_digest: D("8"), input_fingerprint: D("2"), constitution },
    );
    expect(afterFailureWaiver.next).toBe("adjudication-gate");
    expect(afterFailureWaiver.adjudication_gate_pending).toBe(false);

    // The rule is waivable on both axes, so waiving compliance alone leaves constitution-review
    // standing as the first unmet gate: exempting a rule's compliance says nothing about whether
    // its review trigger still applies. An open material-drift gate is therefore not yet the one
    // the fixed point wants.
    const materialOpenState = {
      gate_id: "material-gate",
      gate_kind: materialDrift.kind,
      subject_digest: materialDrift.subject_digest,
      context_digest: computeGateContextDigest(materialDrift.kind, materialDrift.context),
      frozen_state_digest: D("f"),
      opened_at_revision: 8,
    } as const;
    const materialOpenBeforeTriggerWaiver = assessCurrentEvidence(
      state({ step: "triage", status: "succeeded", waivers: [liveFailureWaiver], open_gate: materialOpenState }),
      evidenceSet,
      { subject_digest: D("8"), input_fingerprint: D("2"), constitution },
    );
    expect(materialOpenBeforeTriggerWaiver.next).toBe("adjudication-gate");
    expect(materialOpenBeforeTriggerWaiver.adjudication_gate_pending).toBe(false);

    // Once both axes are waived, constitution-review is satisfied and the open material-drift
    // gate becomes the one the fixed point is waiting on.
    const withMaterialOpen = assessCurrentEvidence(
      state({
        step: "triage",
        status: "succeeded",
        waivers: [liveFailureWaiver, { ...liveFailureWaiver, gate_id: "waiver-trigger", scope: { operation: "review-trigger", boundary: "subject" } }],
        open_gate: materialOpenState,
      }),
      evidenceSet,
      { subject_digest: D("8"), input_fingerprint: D("2"), constitution },
    );
    expect(withMaterialOpen.next).toBe("adjudication-gate");
    expect(withMaterialOpen.adjudication_gate_pending).toBe(true);
    expect(computeGateContextDigest(
      constitutionReview.kind,
      constitutionReview.context,
    )).not.toBe(computeGateContextDigest(materialDrift.kind, materialDrift.context));
  });

  it("routes a fully stale evidence set back to counter-review", () => {
    const assessment = assessCurrentEvidence(
      state({ step: "counter_review", status: "running", attempt: 2 }),
      retained(D("8"), D("9"), 0, D("9")),
      { subject_digest: D("8"), input_fingerprint: D("2"), constitution },
    );
    expect(assessment.stale).toContain("adjudicate");
    expect(assessment.next).toBe("counter_review");
    expect(assessment.reentry_required).toBe(false);
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
    expect(selected?.kind).toBe("constitution-review");
    if (selected === undefined) throw new Error("expected gate");
    const gated = new Map(retained());
    const sourceEvidenceSetDigest = retainedReviewEnvelopeDigest(gated);
    if (sourceEvidenceSetDigest === undefined) throw new Error("fixture counter evidence is not server-attested");
    const existing = gated.get("adjudicate")!;
    gated.set("adjudicate", {
      ...existing,
      manifest: {
        ...existing.manifest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "adjudication-evidence",
          evidence: { ...evidence, source_review_envelope_digest: sourceEvidenceSetDigest },
        },
      },
    });
    const subject = {
      subject_digest: D("8"),
      input_fingerprint: D("2"),
      constitution,
    };

    const afterCommitCrash = assessCurrentEvidence(
      state({ step: "triage", status: "succeeded" }),
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
      state({ step: "triage", status: "succeeded", open_gate: openGate }),
      gated,
      subject,
    );
    expect(resumed.next).toBe("adjudication-gate");
    expect(resumed.adjudication_gate_pending).toBe(true);

    // A rejected/cancelled/non-advancing closure leaves no ApprovalRef and remains gated.
    expect(assessCurrentEvidence(
      state({ step: "triage", status: "succeeded" }),
      gated,
      subject,
    ).next).toBe("adjudication-gate");

    const unauthenticated = assessCurrentEvidence(
      state({
        step: "triage",
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
    expect(requireApprovedUpstreamDigests(state({ approvals: [approval as never] }), [D("8")])).toEqual([D("8")]);
    expect(() => requireApprovedUpstreamDigests(state(), [D("8")])).toThrow(/lacks current/u);

    // Settlements preserve rule-evaluation evidence but cannot substitute for approval.
    const receipt = {
      task_id: "task",
      phase_instance: "prd",
      step: "triage",
      subject_digest: D("8"),
      conclusion: { wait: false, match: null },
      config_digest: D("a"),
      settled_at_revision: 4,
    } as const;
    expect(() => requireApprovedUpstreamDigests(
      state({ rule_settlements: [receipt as never] }), [D("8")],
    )).toThrow(/lacks current/u);
    expect(() => requireApprovedUpstreamDigests(state({
      rule_settlements: [{
        ...receipt,
        conclusion: { wait: true, match: { kind: "subject", subject: "prd" } },
      } as never],
    }), [D("8")])).toThrow(/lacks current/u);
    const superseded = state({
      rule_settlements: [receipt as never],
      restart_history: [{
        restart_id: "restart-1",
        source_phase_instance: "phase-impl-14",
        target_phase_instance: "prd",
        reason: "reconsider the plan",
        restarted_at_revision: 6,
        superseded_results: [],
        cleared_waivers: [],
        human_provenance: {} as never,
      } as never],
    });
    expect(() => requireApprovedUpstreamDigests(superseded, [D("8")])).toThrow(/lacks current/u);

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

  it("preserves already authenticated reviewed-upstream digests without a second human-only scan", () => {
    expect(requireApprovedUpstreamDigests([
      { subject_digest: D("9"), producer_phase: encodePhaseInstance({ kind: "design" }) },
      { subject_digest: D("8"), producer_phase: encodePhaseInstance({ kind: "prd" }) },
    ])).toEqual([D("8"), D("9")]);
    expect(() => requireApprovedUpstreamDigests([
      { subject_digest: D("8"), producer_phase: encodePhaseInstance({ kind: "design" }) },
      { subject_digest: D("8"), producer_phase: encodePhaseInstance({ kind: "prd" }) },
    ]))
      .toThrow(/must be unique/u);
  });
});
