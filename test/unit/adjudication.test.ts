import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseAdjudicationEvidence, parseAndDeriveAdjudication, parseReferencedAdjudicationEvidence } from "../../src/contracts/adjudication.js";

const valid = async () => JSON.parse(await readFile(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url), "utf8")) as Record<string, unknown>;
const findings = (value: Record<string, unknown>) => value.rule_findings as Array<Record<string, unknown>>;

describe("adjudication semantics", () => {
  it("derives independent constitution, drift, and trigger summaries", async () => { const value = await valid(); const before = structuredClone(value); expect(parseAndDeriveAdjudication(value).constitution).toBe("pass"); expect(value).toEqual(before); expect(() => parseAndDeriveAdjudication({ ...value, drift: "material" })).toThrow(/drift must be aligned/); });
  it("rejects trigger list contradictions", async () => { const value = await valid(); expect(() => parseAndDeriveAdjudication({ ...value, matched_rule_versions: [{ rule_id: "safe-paths", rule_version: 2 }] })).toThrow(/contradict/); });
  it("folds any uncertain compliance into an uncertain constitution", async () => { const value = await valid(); const finding = { ...structuredClone(findings(value)[0]!), compliance: "uncertain", rationale: "The artifact leaves the question genuinely open." }; expect(parseAndDeriveAdjudication({ ...value, rule_findings: [finding], constitution: "uncertain" }).constitution).toBe("uncertain"); expect(() => parseAndDeriveAdjudication({ ...value, rule_findings: [finding] })).toThrow(/constitution must be uncertain/); });
  // A rule's enforced_by labels are reviewer context that never reaches a finding. Reinstating a
  // per-mechanism attestation is what once made such a rule permanently uncertain.
  it("refuses a per-mechanism attestation on a rule finding", async () => { const value = await valid(); const finding = { ...structuredClone(findings(value)[0]!), enforced_by: [{ mechanism: "path-contract", state: "unknown", details: "Not current." }] }; expect(() => parseAndDeriveAdjudication({ ...value, rule_findings: [finding] })).toThrow(); });
  it("composes provenance and reference parsers over the same findings", async () => { const value = await valid(); const evidence = { ...value, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" }; expect(parseAdjudicationEvidence(evidence).rule_findings[0]?.compliance).toBe("pass"); expect(parseReferencedAdjudicationEvidence({ evidence_digest: "f".repeat(64), evidence }).evidence.rule_findings[0]?.compliance).toBe("pass"); });
});
