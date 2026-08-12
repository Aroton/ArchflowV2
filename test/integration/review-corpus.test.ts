import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import adjudicationSchema from "../../src/contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { parseAndDeriveAdjudication } from "../../src/contracts/adjudication.js";
import {
  parseConstitutionRuleV1,
  type ConstitutionRegistry,
  type ConstitutionRuleV1,
} from "../../src/contracts/constitution.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { mintAdjudicationObservation, mintReviewObservation, selectCliAdapter } from "../../src/dispatch/cli.js";
import { runDispatchChild } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import {
  AdjudicationServiceError,
  crossCheckRuleFindings,
  selectAdjudicationGate,
  selectAdjudicationGates,
} from "../../src/review/adjudication.js";
import type { AdjudicationSubject, DispatchEnvelope, DispatchSubject } from "../../src/review/envelopes.js";

type ReviewScenario = Readonly<{
  name: string;
  producer_family: "claude" | "codex";
  expected_verdict: "pass" | "fail";
  output: Record<string, unknown>;
}>;

type AdjudicationScenario = Readonly<{
  name: string;
  registry_rules: readonly string[];
  expected_parser: "valid" | "invalid";
  expected_cross_check: "valid" | "invalid" | "not-reached";
  expected_gate: "review-trigger" | "adjudication-failure" | "material-drift" | null;
  expected_first_upstream?: string;
  modeled_resolution?: "amend-upstream" | "revise-current";
  output: Record<string, unknown>;
}>;

type AdjudicationCorpus = Readonly<{
  rules: Readonly<Record<string, Omit<ConstitutionRuleV1, "status">>>;
  scenarios: readonly AdjudicationScenario[];
}>;

const roots: string[] = [];
const corpus = (name: string) => new URL(`../fixtures/corpus/${name}`, import.meta.url);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scenarios<T>(name: string): Promise<readonly T[]> {
  const value = JSON.parse(await readFile(corpus(name), "utf8")) as { scenarios: T[] };
  return value.scenarios;
}

async function adjudicationCorpus(): Promise<AdjudicationCorpus> {
  return JSON.parse(
    await readFile(corpus("adjudication-scenarios.json"), "utf8"),
  ) as AdjudicationCorpus;
}

function registryFor(
  document: AdjudicationCorpus,
  scenario: AdjudicationScenario,
): ConstitutionRegistry {
  return new Map(scenario.registry_rules.map((name) => {
    const rule = document.rules[name];
    if (rule === undefined) throw new Error(`unknown registry rule fixture: ${name}`);
    const { enforced_by: enforcedBy, ...base } = rule;
    const parsed = parseConstitutionRuleV1({
      ...base,
      ...(enforcedBy === undefined || enforcedBy.length === 0
        ? {}
        : { enforced_by: enforcedBy }),
      status: "active",
    });
    return [parsed.id, parsed] as const;
  }));
}

async function fakeWorkspace(
  kind: "claude" | "codex",
  scenario: string,
): Promise<DispatchWorkspace> {
  const root = await mkdtemp(join(tmpdir(), `archflow-review-corpus-${kind}-`));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await Promise.all([mkdir(bin), mkdir(home)]);
  const fixture = new URL(`../fixtures/dispatch/fake-${kind}.mjs`, import.meta.url);
  await chmod(fixture, 0o755);
  await symlink(fixture, join(bin, kind));
  await writeFile(join(root, "scenario"), scenario);
  return Object.freeze({
    root,
    home,
    env: Object.freeze({
      PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
      HOME: home,
      TMPDIR: root,
      CODEX_HOME: join(home, ".codex"),
    }),
    dispose: () => rm(root, { recursive: true, force: true }),
  });
}

const route = (kind: "claude" | "codex"): DispatchRoute => kind === "claude"
  ? { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" }
  : { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" };

const envelope = (resultKind: DispatchEnvelope["result_kind"]): DispatchEnvelope => {
  const bytes = Buffer.from('{"schema_version":"1"}\n');
  return Object.freeze({
    result_kind: resultKind,
    bytes,
    digest: parseSha256Digest("d".repeat(64)),
    byte_count: bytes.byteLength,
  });
};

function reviewSubject(output: Record<string, unknown>): DispatchSubject {
  return {
    task_id: parseTaskSlug(output.task_id),
    phase_instance: parsePhaseInstanceId(output.phase_instance),
    role: "counter-review",
    step: "counter_review",
    attempt: parseSafeInteger(1),
    subject_digest: parseSha256Digest(output.subject_digest),
    input_fingerprint: parseSha256Digest(output.input_fingerprint),
    rubric_digest: parseSha256Digest(output.rubric_digest),
    producer_family: output.producer_family as "claude" | "codex",
    invocation_id: "corpus-review-invocation",
    result_id: "corpus-review-result",
  };
}

function adjudicationSubject(output: Record<string, unknown>): AdjudicationSubject {
  return {
    task_id: parseTaskSlug(output.task_id),
    phase_instance: parsePhaseInstanceId(output.phase_instance),
    role: "adjudication",
    step: "adjudicate",
    subject_digest: parseSha256Digest(output.subject_digest),
    input_fingerprint: parseSha256Digest(output.input_fingerprint),
    pinned_constitution_digest: parseSha256Digest(output.pinned_constitution_digest),
    approved_upstream_digests: (output.approved_upstream_digests as unknown[]).map(parseSha256Digest),
    source_evidence_set_digest: parseSha256Digest(output.source_evidence_set_digest),
    invocation_id: "corpus-adjudication-invocation",
    result_id: "corpus-adjudication-result",
  };
}

async function dispatchScenario(
  kind: "claude" | "codex",
  selection: string,
  resultKind: DispatchEnvelope["result_kind"],
): Promise<Uint8Array> {
  const adapter = kind === "claude"
    ? selectCliAdapter("codex", { allow_claude_dispatch: true })
    : selectCliAdapter("claude");
  const workspace = await fakeWorkspace(kind, selection);
  try {
    const preflight = await adapter.preflight(workspace);
    const invocation = await adapter.buildInvocation(
      envelope(resultKind),
      route(kind),
      workspace,
      resultKind === "review" ? reviewSchema : adjudicationSchema,
    );
    const child = await runDispatchChild({ ...invocation, signal: new AbortController().signal });
    expect(adapter.classifyFailure(child)).toBeUndefined();
    expect(preflight.cli_version).toBe(kind === "claude" ? "2.1.220" : "0.146.0");
    return adapter.parseOutput(child);
  } finally {
    await workspace.dispose();
  }
}

describe("deterministic fake-CLI review corpus", () => {
  it("finds the seeded counter-review defect and accepts the clean control in both producer directions", async () => {
    for (const scenario of await scenarios<ReviewScenario>("review-scenarios.json")) {
      const reviewer = scenario.producer_family === "claude" ? "codex" : "claude";
      const extracted = await dispatchScenario(
        reviewer,
        `corpus:review-scenarios.json#${scenario.name}`,
        "review",
      );
      const result = mintReviewObservation({
        subject: reviewSubject(scenario.output),
        adapter: route(reviewer).adapter,
        cli_version: reviewer === "claude" ? "2.1.220" : "0.146.0",
        route: route(reviewer),
        envelope_input_digest: parseSha256Digest("d".repeat(64)),
        extracted_output_bytes: extracted,
      });
      expect(result.evidence.verdict).toBe(scenario.expected_verdict);
      expect(result.evidence.model_family).toBe(reviewer);
      expect(result.evidence.producer_family).toBe(scenario.producer_family);
      expect(result.evidence.findings.map((finding) => finding.finding_id)).toEqual(
        scenario.expected_verdict === "fail" ? ["seeded-defect"] : [],
      );
    }
  });

  it("dispatches and attests representative trigger, compliance, and drift adjudications", async () => {
    const document = await adjudicationCorpus();
    const entries = document.scenarios;
    expect(entries.filter((entry) => entry.modeled_resolution !== undefined).map((entry) => [
      entry.name,
      entry.modeled_resolution,
    ])).toEqual([
      ["two-material-upstreams", "amend-upstream"],
      ["second-material-upstream-after-readjudication", "revise-current"],
    ]);
    for (const scenario of entries.filter((entry) => entry.expected_parser === "valid")) {
      const extracted = await dispatchScenario(
        "codex",
        `corpus:adjudication-scenarios.json#${scenario.name}`,
        "adjudication",
      );
      const result = mintAdjudicationObservation({
        subject: adjudicationSubject(scenario.output),
        adapter: "codex-cli",
        cli_version: "0.146.0",
        route: route("codex"),
        envelope_input_digest: parseSha256Digest("d".repeat(64)),
        extracted_output_bytes: extracted,
      });
      expect(result.evidence.assurance).toBe("server-attested");
      expect(result.evidence.rule_findings).toHaveLength(
        (scenario.output.rule_findings as unknown[]).length,
      );
      expect(result.evidence.drift).toBe(scenario.output.drift);
      if (scenario.expected_cross_check === "valid") {
        const registry = registryFor(document, scenario);
        expect(crossCheckRuleFindings(registry, result.evidence)).toBe(result.evidence);
        const gate = selectAdjudicationGate(registry, result.evidence);
        expect(gate?.kind).toBe(scenario.expected_gate ?? undefined);
        if (scenario.name === "compliance-and-trigger-share-one-gate") {
          // One rule failing on both axes costs exactly one human decision, and that decision
          // must disclose both axes and offer a waiver on each.
          expect(selectAdjudicationGates(registry, result.evidence)).toHaveLength(1);
          expect(gate).toMatchObject({
            kind: "constitution-review",
            context: {
              constitution: "fail",
              failed_rules: [{ rule_id: "plain-rule", rule_version: 1 }],
              matched_trigger_rules: [{ rule_id: "plain-rule", rule_version: 1 }],
              eligible_waivers: [
                { rule: { rule_id: "plain-rule" }, scope: { operation: "adjudication-failure" } },
                { rule: { rule_id: "plain-rule" }, scope: { operation: "review-trigger" } },
              ],
            },
          });
        }
        if (scenario.expected_first_upstream !== undefined) {
          expect(gate).toMatchObject({
            kind: "material-drift",
            context: {
              affected_upstream: {
                digest: scenario.expected_first_upstream,
              },
            },
          });
        }
      } else {
        expect(() => crossCheckRuleFindings(
          registryFor(document, scenario),
          result.evidence,
          "codex-cli",
        )).toThrowError(AdjudicationServiceError);
      }
    }
  });

  it("rejects a child contradiction before any attested observation can be returned", async () => {
    const entries = await scenarios<AdjudicationScenario>("adjudication-scenarios.json");
    for (const scenario of entries.filter((entry) => entry.expected_parser === "invalid")) {
      const extracted = await dispatchScenario(
        "codex",
        `corpus:adjudication-scenarios.json#${scenario.name}`,
        "adjudication",
      );
      expect(() => mintAdjudicationObservation({
        subject: adjudicationSubject(scenario.output),
        adapter: "codex-cli",
        cli_version: "0.146.0",
        route: route("codex"),
        envelope_input_digest: parseSha256Digest("d".repeat(64)),
        extracted_output_bytes: extracted,
      })).toThrow(/contradict/i);
    }
  });

  it("classifies every registry-dependent malformed control as MODEL_OUTPUT_INVALID", async () => {
    const document = await adjudicationCorpus();
    const malformed = document.scenarios.filter((scenario) =>
      scenario.expected_cross_check === "invalid");
    expect(malformed.map((scenario) => scenario.name)).toEqual([
      "missing-rule-finding",
    ]);
    for (const scenario of malformed) {
      const parsed = parseAndDeriveAdjudication(scenario.output);
      try {
        crossCheckRuleFindings(registryFor(document, scenario), parsed, "codex-cli");
        throw new Error("expected registry cross-check rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AdjudicationServiceError);
        expect((error as AdjudicationServiceError).project_error.code).toBe(
          "MODEL_OUTPUT_INVALID",
        );
      }
    }
  });
});
