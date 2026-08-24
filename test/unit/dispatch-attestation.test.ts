import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import * as publicContracts from "../../src/contracts/index.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { mintAdjudicationObservation, mintReviewObservation } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { AdjudicationSubject, DispatchSubject } from "../../src/review/envelopes.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const subject = (producer_family: "claude" | "codex"): DispatchSubject => ({
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: 13 as never }),
  role: "counter-review",
  step: "counter_review",
  attempt: parseSafeInteger(1),
  subject_digest: digest("a"),
  input_fingerprint: digest("b"),
  rubric_digest: digest("c"),
  producer_family,
  invocation_id: "invocation-13",
  result_id: "result-13",
});

const rawReview = (value: DispatchSubject): Record<string, unknown> => ({
  schema_version: "1",
  task_id: value.task_id,
  phase_instance: value.phase_instance,
  step: value.step,
  role: value.role,
  subject_digest: value.subject_digest,
  input_fingerprint: value.input_fingerprint,
  rubric_digest: value.rubric_digest,
  producer_family: value.producer_family,
  findings: [],
  matched_rule_versions: [],
  verdict: "pass",
  blocking_count: 0,
});

const adjudicationSubject = (): AdjudicationSubject => ({
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: 14 as never }),
  role: "adjudication",
  step: "adjudicate",
  subject_digest: digest("a"),
  input_fingerprint: digest("b"),
  pinned_constitution_digest: digest("c"),
  approved_upstream_digests: [digest("d")],
  source_evidence_set_digest: digest("e"),
  invocation_id: "invocation-14",
  result_id: "result-14",
});

const rawAdjudication = (value: AdjudicationSubject): Record<string, unknown> => ({
  schema_version: "1",
  task_id: value.task_id,
  phase_instance: value.phase_instance,
  step: value.step,
  subject_digest: value.subject_digest,
  input_fingerprint: value.input_fingerprint,
  pinned_constitution_digest: value.pinned_constitution_digest,
  approved_upstream_digests: value.approved_upstream_digests,
  source_evidence_set_digest: value.source_evidence_set_digest,
  rule_findings: [{
    rule_id: "safe-paths",
    rule_version: 2,
    compliance: "pass",
    rationale: "The rule is satisfied.",
    trigger: "not-matched",
    trigger_evidence: "No trigger condition was observed.",
  }],
  drift_findings: [{
    upstream_digest: value.approved_upstream_digests[0],
    drift: "aligned",
    affected_claim_ids: [],
    rationale: "The approved upstream remains aligned.",
  }],
});

const routeFor = (family: "claude" | "codex"): DispatchRoute => family === "claude"
  ? { adapter: "claude-cli", family, model: "claude-opus-4-6", effort: "max" }
  : { adapter: "codex-cli", family, model: "gpt-5.3-codex", effort: "xhigh" };

function mint(producerFamily: "claude" | "codex", output: Uint8Array = bytes(rawReview(subject(producerFamily)))) {
  const dispatchSubject = subject(producerFamily);
  const route = routeFor(producerFamily === "claude" ? "codex" : "claude");
  return mintReviewObservation({
    subject: dispatchSubject,
    adapter: route.adapter,
    cli_version: route.family === "codex" ? "0.146.0" : "2.1.220",
    route,
    envelope_input_digest: digest("d"),
    extracted_output_bytes: output,
  });
}

describe("review observation attestation mint", () => {
  it("keeps capability minting internal while the production mint remains usable", async () => {
    const source = await readFile(new URL("../../src/dispatch/cli.ts", import.meta.url), "utf8");
    expect(publicContracts).not.toHaveProperty("createReviewObservationCapability");
    expect(source).toContain('from "../contracts/internal/trust-mints.js"');
    expect(() => mint("claude")).not.toThrow();
  });

  it.each(["claude", "codex"] as const)("attests the %s producer direction and binds every source field", (producerFamily) => {
    const dispatchSubject = subject(producerFamily);
    const output = bytes(rawReview(dispatchSubject));
    const result = mint(producerFamily, output);
    const reviewerFamily = producerFamily === "claude" ? "codex" : "claude";
    const route = routeFor(reviewerFamily);

    expect(result.observation).toMatchObject({
      kind: "review",
      task_id: dispatchSubject.task_id,
      phase_instance: dispatchSubject.phase_instance,
      role: dispatchSubject.role,
      subject_digest: dispatchSubject.subject_digest,
      input_fingerprint: dispatchSubject.input_fingerprint,
      rubric_digest: dispatchSubject.rubric_digest,
      producer_family: dispatchSubject.producer_family,
      invocation_id: dispatchSubject.invocation_id,
      result_id: dispatchSubject.result_id,
      envelope_input_digest: digest("d"),
      adapter: route.adapter,
      cli_version: reviewerFamily === "codex" ? "0.146.0" : "2.1.220",
      family: route.family,
      model: route.model,
      effort: route.effort,
      raw_output_digest: createHash("sha256").update(output).digest("hex"),
    });
    expect(result.evidence).toMatchObject({
      assurance: "server-attested",
      adapter: route.adapter,
      cli_version: reviewerFamily === "codex" ? "0.146.0" : "2.1.220",
      model_family: route.family,
      model: route.model,
      effort: route.effort,
      invocation_id: dispatchSubject.invocation_id,
      result_id: dispatchSubject.result_id,
      envelope_input_digest: digest("d"),
      observed_output_digest: result.observation.raw_output_digest,
    });
  });

  it.each([
    "task_id",
    "phase_instance",
    "role",
    "step",
    "subject_digest",
    "input_fingerprint",
    "rubric_digest",
    "producer_family",
  ] as const)("rejects output omitting echoed subject field %s without returning evidence", (field) => {
    const dispatchSubject = subject("claude");
    const output = rawReview(dispatchSubject);
    delete output[field];
    expect(() => mint("claude", bytes(output))).toThrow();
  });

  it.each([
    ["task_id", "another-task"],
    ["phase_instance", "design"],
    ["role", "gate-counter-review"],
    ["step", "self_review"],
    ["subject_digest", "e".repeat(64)],
    ["input_fingerprint", "f".repeat(64)],
    ["rubric_digest", "0".repeat(64)],
    ["producer_family", "codex"],
  ] as const)("rejects output with wrong echoed subject field %s without returning evidence", (field, wrongValue) => {
    const dispatchSubject = subject("claude");
    expect(() => mint("claude", bytes({ ...rawReview(dispatchSubject), [field]: wrongValue }))).toThrow();
  });

  it("attests a same-family review when the route names the producer's own family", () => {
    const dispatchSubject = subject("claude");
    const route = routeFor("claude");
    const observed = mintReviewObservation({
      subject: dispatchSubject,
      adapter: route.adapter,
      cli_version: "2.1.220",
      route,
      envelope_input_digest: digest("d"),
      extracted_output_bytes: bytes(rawReview(dispatchSubject)),
    });
    expect(observed.evidence.model_family).toBe("claude");
    expect(observed.evidence.producer_family).toBe("claude");
    expect(observed.evidence.route_source).toEqual({ provenance: "configured" });
  });

  it("binds provider and invocation provenance through the capability into fresh evidence", () => {
    const dispatchSubject = subject("codex");
    const route: DispatchRoute = {
      adapter: "claude-cli",
      family: "claude",
      model: "glm-5-3",
      effort: "high",
      provider: "zai",
    };
    const routeSource = {
      provenance: "invocation-declared" as const,
      displaced: { source: "configured" as const, model: "gpt-configured", effort: "xhigh" as const },
    };
    const observed = mintReviewObservation({
      subject: dispatchSubject,
      adapter: route.adapter,
      cli_version: "2.1.220",
      route,
      route_source: routeSource,
      envelope_input_digest: digest("d"),
      extracted_output_bytes: bytes(rawReview(dispatchSubject)),
    });
    expect(observed.observation).toMatchObject({ provider: "zai", route_source: routeSource });
    expect(observed.evidence).toMatchObject({ provider: "zai", route_source: routeSource });
  });

  it.each(["not JSON", JSON.stringify({ schema_version: "1" })])("rejects malformed output without returning evidence", (output) => {
    expect(() => mint("claude", new TextEncoder().encode(output))).toThrow();
  });
});

describe("adjudication observation attestation mint", () => {
  it("binds every adjudication authority field and rejects a changed subject", () => {
    const dispatchSubject = adjudicationSubject();
    const route = routeFor("codex");
    const output = bytes(rawAdjudication(dispatchSubject));
    const result = mintAdjudicationObservation({
      subject: dispatchSubject,
      adapter: route.adapter,
      cli_version: "0.146.0",
      route,
      envelope_input_digest: digest("0"),
      extracted_output_bytes: output,
    });

    expect(result.observation).toMatchObject({
      kind: "adjudication",
      task_id: dispatchSubject.task_id,
      phase_instance: dispatchSubject.phase_instance,
      role: "adjudication",
      subject_digest: dispatchSubject.subject_digest,
      input_fingerprint: dispatchSubject.input_fingerprint,
      pinned_constitution_digest: dispatchSubject.pinned_constitution_digest,
      approved_upstream_digests: dispatchSubject.approved_upstream_digests,
      source_evidence_set_digest: dispatchSubject.source_evidence_set_digest,
      invocation_id: dispatchSubject.invocation_id,
      result_id: dispatchSubject.result_id,
      envelope_input_digest: digest("0"),
      family: "codex",
    });
    expect(result.evidence).toMatchObject({
      assurance: "server-attested",
      model_family: "codex",
      constitution: "pass",
      drift: "aligned",
      matched_rule_versions: [],
      uncertain_rule_versions: [],
      observed_output_digest: createHash("sha256").update(output).digest("hex"),
      route_source: { provenance: "configured" },
    });

    expect(() => mintAdjudicationObservation({
      subject: { ...dispatchSubject, subject_digest: digest("1") },
      adapter: route.adapter,
      cli_version: "0.146.0",
      route,
      envelope_input_digest: digest("0"),
      extracted_output_bytes: output,
    })).toThrow(/subject_digest/u);
  });
});
