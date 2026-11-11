import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Sha256Digest } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { reviewReportOutputSchema } from "../../src/contracts/review.js";
import { selectCliAdapter } from "../../src/dispatch/cli.js";
import { runDispatchChild } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";

// The response schema the standalone review dispatches with; the prompt renderer derives its example from it.
const reviewSchema = JSON.parse(JSON.stringify(reviewReportOutputSchema.toJSONSchema({ target: "draft-2020-12" }))) as PlainJsonValue;

type ReviewScenario = Readonly<{
  name: string;
  producer_family: "claude" | "codex";
  expected_verdict: "pass" | "review-raised";
  output: Readonly<{ outcome: string; feedback: string }>;
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
  const bytes = Buffer.from('{"schema_version":"1","subject":{"stage":"plan"},"rubric":{"criteria":[{"id":"correctness","text":"Check correctness","blocking":true}]}}\n');
  return Object.freeze({
    result_kind: resultKind,
    bytes,
    digest: "d".repeat(64) as Sha256Digest,
    byte_count: bytes.byteLength,
  });
};

async function dispatchScenario(
  kind: "claude" | "codex",
  selection: string,
): Promise<Uint8Array> {
  const adapter = kind === "claude"
    ? selectCliAdapter("codex")
    : selectCliAdapter("claude");
  const workspace = await fakeWorkspace(kind, selection);
  try {
    const preflight = await adapter.preflight(workspace);
    const invocation = await adapter.buildInvocation(
      envelope("review"),
      route(kind),
      workspace,
      reviewSchema,
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
  it("parses each scenario's expected standalone verdict from the fake CLI in both producer directions", async () => {
    for (const scenario of await scenarios<ReviewScenario>("review-scenarios.json")) {
      const reviewer = scenario.producer_family === "claude" ? "codex" : "claude";
      const extracted = await dispatchScenario(
        reviewer,
        `corpus:review-scenarios.json#${scenario.name}`,
      );
      // The same strict parse `runSimpleReview` applies to every review child's output.
      const report = reviewReportOutputSchema.strict().parse(JSON.parse(new TextDecoder().decode(extracted)));
      expect(report.outcome).toBe(scenario.expected_verdict === "review-raised" ? "issues_found" : "no_issues_found");
      expect(report.feedback.includes("DEFECT-SEED")).toBe(scenario.expected_verdict === "review-raised");
    }
  });
});
