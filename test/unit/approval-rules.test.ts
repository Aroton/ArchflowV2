import { describe, expect, it } from "vitest";

import type { ConfigV1, WorkflowSubject } from "../../src/contracts/config.js";
import { parseConfigV1, WORKFLOW_SUBJECTS } from "../../src/contracts/config.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { CurrentProduceSubject } from "../../src/state/produce-subject.js";
import {
  approvalRuleGateSummary,
  approvalRuleContext,
  approvalRuleMatchSummary,
  evaluateApprovalRules,
  globPatternMatches,
  subjectGateKind,
} from "../../src/state/approval-rules.js";

/**
 * The pure approval-rule evaluator: subject triggers, phase-impl-only content rules, the pinned
 * glob semantics, the subject-to-gate-kind mapping (including the phase-impl force rule), the
 * shared context assembly. Everything here is pure — no filesystem, no fixtures on disk.
 */

const SUBJECTS: readonly WorkflowSubject[] = [...WORKFLOW_SUBJECTS];

/** A parsed config carrying exactly the given `approval_rules`; `undefined` means no config. */
const configWithRules = (approvalRules?: unknown): ConfigV1 | undefined =>
  approvalRules === undefined
    ? undefined
    : parseConfigV1({
      schema_version: "1",
      roles: {},
      approval_rules: approvalRules,
    });

const noRules = (): ConfigV1 => parseConfigV1({ schema_version: "1", roles: {} });

const autonomous = { wait: false, match: null };
const subjectMatch = (subject: WorkflowSubject) => ({ wait: true, match: { kind: "subject", subject } });
const contentMatch = (...paths: readonly string[]) => ({ wait: true, match: { kind: "content", paths } });

describe("evaluateApprovalRules — subject triggers", () => {
  it("waits exactly for the subjects the config lists, for each subject", () => {
    const config = configWithRules({ subjects: ["design"], content: [] });
    for (const subject of SUBJECTS) {
      expect(evaluateApprovalRules(config, subject, [])).toEqual(
        subject === "design" ? subjectMatch("design") : autonomous,
      );
    }
  });

  it("waits for every listed subject without regard to order", () => {
    const config = configWithRules({ subjects: ["phase-impl", "prd", "phase-design", "design"], content: [] });
    for (const subject of SUBJECTS) {
      expect(evaluateApprovalRules(config, subject, [])).toEqual(subjectMatch(subject));
    }
  });

  it("absent, empty, or unreadable rules leave every subject autonomous", () => {
    for (const subject of SUBJECTS) {
      expect(evaluateApprovalRules(undefined, subject, ["db/a.sql"])).toEqual(autonomous);
      expect(evaluateApprovalRules(noRules(), subject, ["db/a.sql"])).toEqual(autonomous);
      expect(evaluateApprovalRules(configWithRules({ subjects: [], content: [] }), subject, ["db/a.sql"]))
        .toEqual(autonomous);
    }
  });
});

describe("approvalRuleMatchSummary — human-facing trigger evidence", () => {
  it("names the exact subject that required the ordinary approval gate", () => {
    expect(approvalRuleMatchSummary({ kind: "subject", subject: "phase-design" })).toBe(
      'Approval rule trigger: this project requires human approval for the "phase-design" subject.',
    );
  });

  it("lists the exact persisted content-match paths without consulting config", () => {
    expect(approvalRuleMatchSummary({ kind: "content", paths: ["db/a.sql", "db/deep/b.sql"] })).toBe(
      "Approval rule trigger: these changed paths matched the project's content rules:\n" +
      "- db/a.sql\n" +
      "- db/deep/b.sql",
    );
  });

  it("bounds a large gate summary while preserving exact path examples and an omitted count", () => {
    const first = `db/${"x".repeat(1000)}.sql`;
    const paths = [first, ...Array.from({ length: 200 }, (_, index) => `db/migration-${index}.sql`)];
    const summary = approvalRuleGateSummary("S".repeat(4096), { kind: "content", paths });

    expect(summary.length).toBeLessThanOrEqual(4096);
    expect(summary).toContain("Gate summary truncated to preserve the approval-rule trigger");
    expect(summary).toContain(`- ${first}`);
    expect(summary).toMatch(/additional matched paths omitted; exact paths remain in durable settlement evidence\./u);
  });

  it("keeps a bounded subject trigger intact after maximum-length caller prose", () => {
    const summary = approvalRuleGateSummary("S".repeat(4096), {
      kind: "subject", subject: "phase-design",
    });
    expect(summary.length).toBeLessThanOrEqual(4096);
    expect(summary).toContain(
      'Approval rule trigger: this project requires human approval for the "phase-design" subject.',
    );
  });
});

describe("evaluateApprovalRules — content rules apply to the phase-impl subject only", () => {
  const content = configWithRules({ subjects: [], content: [{ paths: ["**/*.md"] }, { paths: ["db/**"] }] });

  it("a Markdown content rule never fires on a design document subject", () => {
    expect(evaluateApprovalRules(content, "design", ["design.md", "docs/architecture.md"])).toEqual(autonomous);
    expect(evaluateApprovalRules(content, "phase-design", ["phases/1/design.md"])).toEqual(autonomous);
    expect(evaluateApprovalRules(content, "prd", ["prd.md"])).toEqual(autonomous);
  });

  it("matches the phase-impl subject when any changed path hits any rule's globs", () => {
    expect(evaluateApprovalRules(content, "phase-impl", ["src/index.ts", "db/migrate.sql"]))
      .toEqual(contentMatch("db/migrate.sql"));
    expect(evaluateApprovalRules(content, "phase-impl", ["docs/NOTES.md", "db/deep/child.sql"]))
      .toEqual(contentMatch("db/deep/child.sql", "docs/NOTES.md"));
  });

  it("reports unmatched paths nowhere and no rule as autonomous", () => {
    expect(evaluateApprovalRules(content, "phase-impl", ["src/index.ts"])).toEqual(autonomous);
    expect(evaluateApprovalRules(configWithRules({ subjects: [], content: [] }), "phase-impl", ["db/a.sql"]))
      .toEqual(autonomous);
  });

  it("a phase-impl subject trigger forces its wait regardless of content rules", () => {
    const forced = configWithRules({ subjects: ["phase-impl"], content: [{ paths: ["**/*.sql"] }] });
    // No content rule matches, yet the subject trigger still waits — and reports itself as the
    // match, so the gate kind is the subject mapping's commit-authorization, not a content gate.
    expect(evaluateApprovalRules(forced, "phase-impl", ["src/index.ts"])).toEqual(subjectMatch("phase-impl"));
    expect(evaluateApprovalRules(forced, "phase-impl", ["db/a.sql"])).toEqual(subjectMatch("phase-impl"));
  });
});

describe("globPatternMatches — the pinned whole-path semantics", () => {
  it.each([
    // A leading ** collapses zero or more complete directories.
    ["**/*.sql", "a.sql", true],
    ["**/*.sql", "db/a.sql", true],
    ["**/*.sql", "db/deep/a.sql", true],
    ["**/*.sql", "a.sql.bak", false],
    ["**/*.sql", "db/a.ts", false],
    // A trailing ** covers everything under the directory — and, because zero segments already
    // satisfy it, the directory's own path too.
    ["db/**", "db", true],
    ["db/**", "db/migrate.sql", true],
    ["db/**", "db/deep/migrate.sql", true],
    ["db/**", "dbx/migrate.sql", false],
    ["db/**", "src/db/migrate.sql", false],
    // * and ? stay inside one segment.
    ["*", "a", true],
    ["*", "a/b", false],
    ["*.ts", "index.ts", true],
    ["*.ts", "src/index.ts", false],
    ["src/*.ts", "src/index.ts", true],
    ["?.ts", "a.ts", true],
    ["?.ts", "ab.ts", false],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["a/**/b", "x/a/b", false],
    // ** alone matches any path; a literal matches only itself, exactly.
    ["**", "anything/at/all", true],
    ["src/index.ts", "src/index.ts", true],
    ["src/index.ts", "src/index.tsx", false],
    ["src/index.ts", "src/index", false],
    // Case-sensitive throughout.
    ["*.SQL", "a.sql", false],
    ["SRC/**", "src/a.ts", false],
    ["Makefile", "makefile", false],
  ])("%s against %s is %s", (pattern, path, expected) => {
    expect(globPatternMatches(pattern, path)).toBe(expected);
  });
});

describe("subjectGateKind — the subject-to-gate-kind mapping", () => {
  it("maps each subject to its pinned gate kind", () => {
    expect({ ...subjectGateKind }).toEqual({
      prd: "artifact-approval",
      design: "design-approval",
      "phase-design": "design-approval",
      "phase-impl": "commit-authorization",
    });
  });

  it("covers every workflow subject exactly", () => {
    expect([...Object.keys(subjectGateKind)].sort()).toEqual([...SUBJECTS].sort());
  });
});

describe("approvalRuleContext — the shared assembly", () => {
  // The builder reads only the phase instance off the state and the artifact off the subject, so
  // minimal literals stand in for the full durable shapes.
  const state = (phaseInstance: string): TaskStateV1 => ({ phase_instance: phaseInstance } as unknown as TaskStateV1);
  const implementationSubject = (...outputs: ReadonlyArray<Record<string, unknown>>): CurrentProduceSubject =>
    ({ artifact: { artifact_kind: "implementation-output", outputs } }) as unknown as CurrentProduceSubject;
  const documentSubject = (): CurrentProduceSubject =>
    ({ artifact: { artifact_kind: "document" } }) as unknown as CurrentProduceSubject;

  it("derives the subject from the state's phase instance", () => {
    expect(approvalRuleContext(state("prd"), undefined, undefined).subject).toBe("prd");
    expect(approvalRuleContext(state("phase-design-3"), undefined, noRules()).subject).toBe("phase-design");
    expect(approvalRuleContext(state("phase-impl-2"), undefined, undefined).subject).toBe("phase-impl");
  });

  it("collects implementation output paths, including rename previous paths, sorted and deduplicated", () => {
    const subject = implementationSubject(
      { path: "src/new.ts", operation: "modify" },
      { path: "src/gone.ts", operation: "delete" },
      { path: "src/moved.ts", operation: "rename", previous_path: "src/old.ts" },
      { path: "src/other.ts", operation: "modify" },
    );
    expect(approvalRuleContext(state("phase-impl-1"), subject, undefined).changedPaths).toEqual([
      "src/gone.ts",
      "src/moved.ts",
      "src/new.ts",
      "src/old.ts",
      "src/other.ts",
    ]);
  });

  it("carries no changed paths for document subjects or an unloaded produce subject", () => {
    expect(approvalRuleContext(state("design"), documentSubject(), noRules()).changedPaths).toEqual([]);
    expect(approvalRuleContext(state("design"), undefined, noRules()).changedPaths).toEqual([]);
  });

  it("passes the parsed config through unchanged", () => {
    const config = configWithRules({ subjects: ["design"], content: [] });
    expect(approvalRuleContext(state("design"), undefined, config).config).toBe(config);
    expect(approvalRuleContext(state("design"), undefined, undefined).config).toBeUndefined();
  });

  it("round-trips through the evaluator: the context is the evaluation input", () => {
    const context = approvalRuleContext(
      state("phase-impl-1"),
      implementationSubject({ path: "db/a.sql", operation: "modify" }),
      configWithRules({ subjects: [], content: [{ paths: ["**/*.sql"] }] }),
    );
    expect(evaluateApprovalRules(context.config, context.subject, context.changedPaths))
      .toEqual(contentMatch("db/a.sql"));
  });
});
