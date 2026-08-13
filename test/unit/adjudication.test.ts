import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseAdjudicationEvidence, parseAndDeriveAdjudication, parseReferencedAdjudicationEvidence } from "../../src/contracts/adjudication.js";

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

  // A rule's enforced_by labels are reviewer context that never reaches a finding. Reinstating a
  // per-mechanism attestation is what once made such a rule permanently uncertain.
  it("refuses a per-mechanism attestation on a rule finding", async () => { const value = output(await valid()); const finding = { ...structuredClone(findings(value)[0]!), enforced_by: [{ mechanism: "path-contract", state: "unknown", details: "Not current." }] }; expect(() => parseAndDeriveAdjudication({ ...value, rule_findings: [finding] })).toThrow(); });
  it("composes provenance and reference parsers over the same findings", async () => { const value = await valid(); const evidence = { ...value, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" }; expect(parseAdjudicationEvidence(evidence).rule_findings[0]?.compliance).toBe("pass"); expect(parseReferencedAdjudicationEvidence({ evidence_digest: "f".repeat(64), evidence }).evidence.rule_findings[0]?.compliance).toBe("pass"); });
});
