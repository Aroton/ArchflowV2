import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import * as publicContracts from "../../src/contracts/index.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { mintReviewObservation } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchSubject } from "../../src/review/envelopes.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const subject = (producer_family: "claude" | "codex"): DispatchSubject => ({
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: 13 as never }),
  role: "counter-review",
  step: "counter_review",
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
    expect(source).toContain('from "../contracts/internal/test-capabilities.js"');
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

  it("keeps the opposite-family assertion live and returns no evidence for a same-family route", () => {
    const dispatchSubject = subject("claude");
    const route = routeFor("claude");
    expect(() => mintReviewObservation({
      subject: dispatchSubject,
      adapter: route.adapter,
      cli_version: "2.1.220",
      route,
      envelope_input_digest: digest("d"),
      extracted_output_bytes: bytes(rawReview(dispatchSubject)),
    })).toThrow(/opposite-family/);
  });

  it.each(["not JSON", JSON.stringify({ schema_version: "1" })])("rejects malformed output without returning evidence", (output) => {
    expect(() => mint("claude", new TextEncoder().encode(output))).toThrow();
  });
});
