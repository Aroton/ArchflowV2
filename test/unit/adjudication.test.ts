import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseAdjudicationEvidence,
  parseAndDeriveAdjudication,
  parseAndDeriveAdjudicationV2,
  parseRawAdjudicationV2,
  parseReferencedAdjudicationEvidence,
} from "../../src/contracts/adjudication.js";
import type { ReviewEvidence } from "../../src/contracts/review.js";
import { policyReviewFacts, selectPolicyReviewGates } from "../../src/review/adjudication.js";

const valid = async () => JSON.parse(await readFile(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url), "utf8")) as Record<string, unknown>;
const findings = (value: Record<string, unknown>) => value.rule_findings as Array<Record<string, unknown>>;
const output = (value: Record<string, unknown>): Record<string, unknown> => {
  const { constitution: _constitution, drift: _drift, matched_rule_versions: _matched, uncertain_rule_versions: _uncertain, ...raw } = value;
  return raw;
};

describe("adjudication semantics", () => {
  it.each([
    ["pass", "not-matched", "pass", [], []],
    ["fail", "matched", "fail", [{ rule_id: "safe-paths", rule_version: 2 }], []],
    ["uncertain", "uncertain", "uncertain", [], [{ rule_id: "safe-paths", rule_version: 2 }]],
  ] as const)("derives %s compliance and %s trigger summaries", async (compliance, trigger, constitution, matched, uncertain) => {
    const value = output(await valid());
    const before = structuredClone(value);
    const finding = { ...structuredClone(findings(value)[0]!), compliance, trigger };
    const derived = parseAndDeriveAdjudication({ ...value, rule_findings: [finding] });
    expect(derived).toMatchObject({ constitution, drift: "aligned", matched_rule_versions: matched, uncertain_rule_versions: uncertain });
    expect(value).toEqual(before);
  });

  it.each([
    ["aligned", [], "aligned"],
    ["incidental", ["claim-a"], "incidental"],
    ["material", ["claim-a"], "material"],
  ] as const)("derives the %s drift rollup", async (drift, affectedClaimIds, expected) => {
    const value = output(await valid());
    const driftFinding = { ...(value.drift_findings as Array<Record<string, unknown>>)[0]!, drift, affected_claim_ids: affectedClaimIds };
    expect(parseAndDeriveAdjudication({ ...value, drift_findings: [driftFinding] }).drift).toBe(expected);
  });

  it("rejects model-supplied derived summaries", async () => {
    const value = await valid();
    expect(() => parseAndDeriveAdjudication(value)).toThrow(/Unrecognized keys/u);
  });

  it("keeps complete durable evidence strict about derived summaries", async () => {
    const value = await valid();
    expect(() => parseAdjudicationEvidence({ ...value, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown", uncertain_rule_versions: [{ rule_id: "safe-paths", rule_version: 2 }] })).toThrow(/contradict/u);
  });

  it("rejects incomplete and duplicate finding coverage", async () => {
    const value = output(await valid());
    expect(() => parseAndDeriveAdjudication({ ...value, drift_findings: [] })).toThrow(/exactly cover/u);
    expect(() => parseAndDeriveAdjudication({ ...value, rule_findings: [...findings(value), ...findings(value)] })).toThrow(/sorted and unique/u);
  });

  it("canonicalizes harmless model-authored set ordering", async () => {
    const value = output(await valid());
    const upstreamA = "a".repeat(64);
    const upstreamB = "b".repeat(64);
    const baseRule = structuredClone(findings(value)[0]!);
    const baseDrift = structuredClone((value.drift_findings as Array<Record<string, unknown>>)[0]!);
    const derived = parseAndDeriveAdjudication({
      ...value,
      approved_upstream_digests: [upstreamB, upstreamA],
      rule_findings: [
        { ...baseRule, rule_id: "zeta-rule", rule_version: 1 },
        { ...baseRule, rule_id: "alpha-rule", rule_version: 2 },
      ],
      drift_findings: [
        { ...baseDrift, upstream_digest: upstreamB },
        { ...baseDrift, upstream_digest: upstreamA },
      ],
    });

    expect(derived.approved_upstream_digests).toEqual([upstreamA, upstreamB]);
    expect(derived.rule_findings.map((finding) => finding.rule_id)).toEqual(["alpha-rule", "zeta-rule"]);
    expect(derived.drift_findings.map((finding) => finding.upstream_digest)).toEqual([upstreamA, upstreamB]);
  });

  // A rule's enforced_by labels are reviewer context that never reaches a finding. Reinstating a
  // per-mechanism attestation is what once made such a rule permanently uncertain.
  it("refuses a per-mechanism attestation on a rule finding", async () => { const value = output(await valid()); const finding = { ...structuredClone(findings(value)[0]!), enforced_by: [{ mechanism: "path-contract", state: "unknown", details: "Not current." }] }; expect(() => parseAndDeriveAdjudication({ ...value, rule_findings: [finding] })).toThrow(); });
  it("composes provenance and reference parsers over the same findings", async () => { const value = await valid(); const evidence = { ...value, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" }; expect(parseAdjudicationEvidence(evidence).rule_findings[0]?.compliance).toBe("pass"); expect(parseReferencedAdjudicationEvidence({ evidence_digest: "f".repeat(64), evidence }).evidence.rule_findings[0]?.compliance).toBe("pass"); });

  it("maps exact V2 judgment slots to server-owned rules and derives only constitution summaries", () => {
    const slots = [
      { slot: "slot-b", rule_id: "alpha-rule", rule_version: 1 },
      { slot: "slot-a", rule_id: "zeta-rule", rule_version: 2 },
    ] as const;
    const output = {
      schema_version: "2",
      judgments: {
        "slot-a": { compliance: "uncertain", rationale: "Could not prove it.", trigger: "uncertain", trigger_evidence: "The boundary is ambiguous." },
        "slot-b": { compliance: "pass", rationale: "The guard is present.", trigger: "matched", trigger_evidence: "The changed path is in scope." },
      },
    } as const;
    const derived = parseAndDeriveAdjudicationV2(output, slots);
    expect(derived).toMatchObject({
      schema_version: "2", constitution: "uncertain",
      matched_rule_versions: [{ rule_id: "alpha-rule", rule_version: 1 }],
      uncertain_rule_versions: [{ rule_id: "zeta-rule", rule_version: 2 }],
    });
    expect(derived.rule_findings.map((finding) => finding.rule_id)).toEqual(["alpha-rule", "zeta-rule"]);
    expect(derived).not.toHaveProperty("drift");
    expect(derived).not.toHaveProperty("approved_upstream_digests");
    expect(() => parseRawAdjudicationV2({ ...output, judgments: { "slot-a": output.judgments["slot-a"] } }, slots)).toThrow();
    expect(() => parseRawAdjudicationV2({ ...output, judgments: { ...output.judgments, extra: output.judgments["slot-a"] } }, slots)).toThrow();
    expect(() => parseRawAdjudicationV2({ ...output, task_id: "server-owned" }, slots)).toThrow();
  });

  it("rejects accessor-backed and non-enumerable V2 judgment slots before inspection", () => {
    const slots = [{ slot: "slot-a", rule_id: "safe-paths", rule_version: 1 }] as const;
    const judgment = { compliance: "pass", rationale: "Present.", trigger: "not-matched", trigger_evidence: "No matching change." };
    let reads = 0;
    const toggling = { schema_version: "2", judgments: {} as Record<string, unknown> };
    Object.defineProperty(toggling.judgments, "slot-a", { enumerable: true, get: () => (++reads === 1 ? judgment : { ...judgment, compliance: "fail" }) });
    expect(() => parseRawAdjudicationV2(toggling, slots)).toThrow(/accessor properties/u);
    expect(reads).toBe(0);

    const hidden = { schema_version: "2", judgments: {} as Record<string, unknown> };
    Object.defineProperty(hidden.judgments, "slot-a", { enumerable: false, value: judgment });
    expect(() => parseRawAdjudicationV2(hidden, slots)).toThrow(/non-enumerable/u);
  });

  it("selects fresh material drift from Review V3 without requiring constitution evidence", () => {
    const digest = "a".repeat(64);
    const review = {
      schema_version: "3",
      assurance: "server-attested",
      subject_digest: digest,
      input_fingerprint: "b".repeat(64),
      envelope_input_digest: "c".repeat(64),
      upstream_alignment: [{
        upstream_digest: "d".repeat(64),
        drift: "material",
        affected_claim_ids: ["approved-claim"],
        rationale: "The implementation contradicts the approved boundary.",
      }],
    } as unknown as ReviewEvidence;
    const facts = policyReviewFacts(review, undefined, false);
    expect(facts).toMatchObject({
      constitution: { status: "not-run", result: "pass" },
      alignment: { source: "review-v3", result: "material" },
    });
    expect(selectPolicyReviewGates(new Map(), facts)).toMatchObject([{
      kind: "material-drift",
      subject_digest: digest,
      context: { affected_claim_ids: ["approved-claim"] },
    }]);
  });
});
