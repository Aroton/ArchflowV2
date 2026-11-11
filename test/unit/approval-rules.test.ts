import { describe, expect, it } from "vitest";

import type { ConfigV1, WorkflowSubject } from "../../src/contracts/config.js";
import { parseConfigV1, WORKFLOW_SUBJECTS } from "../../src/contracts/config.js";
import {
  approvalRuleMatchSummary,
  evaluateApprovalRules,
  globPatternMatches,
} from "../../src/review/approval-rules.js";

/**
 * The pure approval-rule evaluator: subject triggers, content rules over changed paths, the pinned
 * glob semantics, and the human-facing trigger summary. Everything here is pure — no filesystem,
 * no fixtures on disk.
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
});

describe("evaluateApprovalRules — content rules match the changed paths any subject reports", () => {
  const content = configWithRules({ subjects: [], content: [{ paths: ["**/*.md"] }, { paths: ["db/**"] }] });

  it("a review that reports no changed paths stays autonomous", () => {
    expect(evaluateApprovalRules(content, "phase-design", [])).toEqual(autonomous);
    expect(evaluateApprovalRules(content, "phase-impl", [])).toEqual(autonomous);
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
    // match, so the human review reason names the subject rule rather than a content rule.
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
