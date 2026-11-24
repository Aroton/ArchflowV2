import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  calcMessageCostUsd,
  classifySubagent,
  compareRuns,
  parseClaudeTranscript,
  parseReviewFile,
  renderMetricsMarkdown,
} from "../../scripts/measure-run.mjs";

describe("measure-run metrics helpers", () => {
  it("computes Claude API cost with 5m/1h cache writes and Haiku 100k multiplier", () => {
    const opus = calcMessageCostUsd("claude-opus-5-5", {
      input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
      output_tokens: 1_000_000,
    });
    expect(opus).toBeCloseTo(4.0 + 0.2 + 8.0 + 20.0, 5);

    const haikuShort = calcMessageCostUsd("claude-haiku-5-5", {
      input_tokens: 50_000,
      output_tokens: 10_000,
    });
    const haikuLong = calcMessageCostUsd("claude-haiku-5-5", {
      input_tokens: 110_000,
      output_tokens: 10_000,
    });
    expect(haikuShort).toBeCloseTo(0.01, 5);
    expect(haikuLong).toBeCloseTo((110_000 * 0.1 + 10_000 * 0.5) * 5 / 1_000_000, 5);

    // OpenAI/Codex input_tokens includes cached_input_tokens
    const sol = calcMessageCostUsd("gpt-6.2-sol", {
      input_tokens: 100_000,
      cache_read_input_tokens: 80_000,
      output_tokens: 10_000,
    });
    expect(sol).toBeCloseTo((20_000 * 2.0 + 80_000 * 0.1 + 10_000 * 10.0) / 1_000_000, 5);
  });

  it("deduplicates streaming assistant chunks by message.id", () => {
    const dir = mkdtempSync(join(tmpdir(), "archflow-metrics-test-"));
    try {
      const p = join(dir, "session.jsonl");
      const lines = [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-24T10:00:00Z",
          message: {
            id: "msg_1",
            model: "claude-opus-5-5",
            usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 20 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-24T10:00:02Z",
          message: {
            id: "msg_1",
            model: "claude-opus-5-5",
            usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 200 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-24T10:01:00Z",
          message: {
            id: "msg_2",
            model: "<synthetic>",
            usage: { input_tokens: 999999, output_tokens: 999999 },
          },
        }),
      ];
      writeFileSync(p, `${lines.join("\n")}\n`, "utf8");
      const parsed = parseClaudeTranscript(p);
      expect(parsed.turns).toBe(1);
      expect(parsed.byModel["claude-opus-5-5"]?.outputTokens).toBe(200);
      expect(parsed.byModel["<synthetic>"]).toBeUndefined();
      expect(parsed.maxContextTokens).toBe(1510);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies subagent roles accurately without confusing gate fix tasks with gate lenses", () => {
    expect(classifySubagent("general-purpose", "Explore Art Studio UI")).toBe("planning_explore");
    expect(classifySubagent("general-purpose", "Write first run plan")).toBe("planning_plan");
    expect(classifySubagent("general-purpose", "Revise M4 from counter-review")).toBe("planning_revision");
    expect(classifySubagent("3d-model-tool-client-implementer", "Implement M1-C6 form gate fixes")).toBe("implement");
    expect(classifySubagent("3d-model-tool-pipeline-implementer", "M2-X3a fixer r2")).toBe("fix");
    expect(classifySubagent("3d-model-tool-pipeline-reviewer", "M3-T1a fix verify")).toBe("review_fix_verify");
    expect(classifySubagent("3d-model-tool-pipeline-reviewer", "Merge M1-P4 counter-review")).toBe("review_merge");
    expect(classifySubagent("3d-model-tool-pipeline-reviewer", "Review M1-P4")).toBe("review_task");
    expect(classifySubagent("3d-model-tool-reviewer", "M3 gate architecture lens")).toBe("gate_lens");
    expect(classifySubagent("3d-model-tool-reviewer", "M3 deferral pass")).toBe("deferral_pass");
  });

  it("parses review findings tables, origins, delta rounds, and decisions", () => {
    const sample = `# M1-X1 review
## Findings
| id | severity | source | file:line | claim |
|---|---|---|---|---|
| F1 | critical | self | a.ts:1 | broken |
| F2 | major | counter+tests | b.ts:2 | missing check |
| F3 | minor | self+counter | c.ts:3 | typo |
| F4 | note | unplanned | d.ts:4 | helper |
## Decisions (r1)
- F1, F2: fix — real bugs
- F3: dismiss — false positive
- F4: keep — useful helper
## Round r2 (fix-verify)
### Delta review of r2
| id | severity | source | file:line | claim |
|---|---|---|---|---|
| D1 | minor | counter | a.ts:9 | edge case |
`;
    const parsed = parseReviewFile(sample);
    expect(parsed.hasR2).toBe(true);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows[0]?.origin).toBe("in_model_only");
    expect(parsed.rows[1]?.origin).toBe("cross_model_only");
    expect(parsed.rows[2]?.origin).toBe("both");
    expect(parsed.rows[4]?.isPostR1).toBe(true);
    expect(parsed.decisions.fix).toBe(2);
    expect(parsed.decisions.dismiss).toBe(1);
    expect(parsed.decisions.keep).toBe(1);
  });

  it("renders METRICS.md with Mermaid charts and comparison rows", () => {
    const md = renderMetricsMarkdown({
      schemaVersion: 1,
      runs: [
        {
          id: "baseline",
          label: "Baseline",
          kind: "baseline",
          date: "2026-11-18",
          kpis: {
            mergedTasks: 52,
            totalCostUsd: 813,
            costPerTaskUsd: 15.63,
            fableSharePct: 46,
            reviewToWriteRatio: 0.56,
            seriousCaught: 32,
            seriousCaughtPerTask: 0.62,
            seriousEscapedToGates: 4,
            signalRatePct: 94.8,
            noDecisionRowSharePct: 72.2,
          },
        },
        {
          id: "demo-run",
          label: "demo-run",
          kind: "measured",
          date: "2026-11-24",
          kpis: {
            mergedTasks: 20,
            totalCostUsd: 160,
            costPerTaskUsd: 8,
            costPerKlocUsd: 16,
            fableSharePct: 12,
            reviewToWriteRatio: 1.1,
            seriousCaught: 10,
            seriousCaughtPerTask: 0.5,
            seriousEscapedToGates: 1,
            signalRatePct: 92,
            noDecisionRowSharePct: 30,
            structureFindingsPerTask: 0.3,
            crossModelOnlyMajorSharePct: 25,
            crossModelOnlyMinorSharePct: 50,
            planningInitCostUsd: 10,
            planningRevisionCostUsd: 5,
            planningTokensM: 15,
            planningRevisionTokensM: 5,
            implementCostUsd: 40,
            implementTokensM: 60,
            fixCostUsd: 20,
            fixTokensM: 30,
            reviewCostUsd: 55,
            reviewTokensM: 80,
            orchestratorCostUsd: 30,
            orchestratorTokensM: 50,
            counterfactual: {
              unreviewedOpusFloorUsd: 70,
              debugAdjustedLowUsd: 100,
              debugAdjustedHighUsd: 130,
              workflowOverheadRatio: 2.29,
              costPerSeriousBugUsd: 9,
            },
          },
          writers: { sonnet: 18, opusHatch: 2, other: 0 },
          findings: {
            critical: 2,
            major: 8,
            minor: 40,
            byOrigin: {
              in_model_only: { critical: 2, major: 4, minor: 15 },
              both: { critical: 0, major: 2, minor: 5 },
              cross_model_only: { critical: 0, major: 2, minor: 20 },
              structure: { critical: 0, major: 0, minor: 6 },
            },
            byMilestone: {},
          },
          counterReview: { total: 20, failures: 0, issuesFound: 18, taskDelta: 4, deltaIssuesFound: 3 },
          git: { netTotalLoc: 10000, netSourceLoc: 5000, netTestLoc: 5000 },
          claude: {
            sessions: 4,
            orchestratorPeakCtxAvg: 240000,
            totals: { inputTokens: 0, cacheReadTokens: 200_000_000, cacheWriteTokens: 10_000_000, outputTokens: 2_000_000 },
          },
          checks: [{ name: "Cost per merged task", value: "$8/task", target: "≤ $10/task", status: "good" }],
        },
      ],
    });
    expect(md).toContain("```mermaid");
    expect(md).toContain("xychart-beta");
    expect(md).toContain("demo-run");
    expect(md).toContain("With ArchFlow vs. Estimated Without Workflow");
  });

  it("compares two runs with directional verdicts", () => {
    const cmp = compareRuns(
      {
        id: "before",
        label: "Before",
        date: "2026-11-18",
        kpis: {
          mergedTasks: 50,
          costPerTaskUsd: 15.6,
          fableSharePct: 46,
          reviewToWriteRatio: 1.5,
          signalRatePct: 90,
          noDecisionRowSharePct: 70,
          seriousEscapedToGates: 4,
        },
      },
      {
        id: "after",
        label: "After",
        date: "2026-11-24",
        kpis: {
          mergedTasks: 60,
          costPerTaskUsd: 7.5,
          fableSharePct: 14,
          reviewToWriteRatio: 1.1,
          signalRatePct: 95,
          noDecisionRowSharePct: 35,
          seriousEscapedToGates: 6,
        },
      },
    );
    const byKey = Object.fromEntries(cmp.rows.map((r) => [r.key, r]));
    expect(byKey.costPerTaskUsd?.verdict).toBe("IMPROVED");
    expect(byKey.fableSharePct?.verdict).toBe("IMPROVED");
    expect(byKey.signalRatePct?.verdict).toBe("IMPROVED");
    expect(byKey.seriousEscapedToGates?.verdict).toBe("REGRESSED");
  });
});
