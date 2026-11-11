import type { WorkflowSubject } from "../contracts/config.js";

/**
 * The pure approval-rule evaluator. A review must name a human approval reason only when a
 * declarative rule in the project config says so; absent or empty `approval_rules` produce a
 * `wait:false` evaluation.
 *
 * Subject triggers match the review subject wholesale (`phase-design` for a plan review,
 * `phase-impl` for an implementation review). Content rules match when any path the work
 * *changed* matches any rule's glob list. A subject match is checked first and short-circuits
 * content evaluation.
 */

/** Which rule requires human review. */
export type ApprovalRuleMatch =
  | Readonly<{ kind: "subject"; subject: WorkflowSubject }>
  | Readonly<{ kind: "content"; paths: readonly string[] }>;

/** `match` is `null` exactly when no rule requires human review. */
export type ApprovalRuleConclusion =
  | Readonly<{ wait: false; match: null }>
  | Readonly<{ wait: true; match: ApprovalRuleMatch }>;

export type ApprovalRulesConfig = Readonly<{
  approval_rules?: Readonly<{
    subjects: readonly WorkflowSubject[];
    content: readonly Readonly<{ paths: readonly string[] }>[];
  }> | undefined;
}>;

/** Plain-language evidence for the human review reason. */
export function approvalRuleMatchSummary(match: ApprovalRuleMatch): string {
  if (match.kind === "subject") {
    return `Approval rule trigger: this project requires human approval for the "${match.subject}" subject.`;
  }
  const paths = match.paths.map((path) => `- ${path}`).join("\n");
  return `Approval rule trigger: these changed paths matched the project's content rules:\n${paths}`;
}

/**
 * Glob semantics, pinned: a pattern matches the whole repository-relative, `/`-separated path,
 * case-sensitively. `*` and `?` stay within one segment. `**` is special only as a complete
 * segment and matches zero or more complete segments — so a `**` followed by `*.sql` matches both
 * `a.sql` and `db/a.sql`, `db/**` matches everything under `db/`, and because zero segments
 * already satisfies the trailing `**`, `db/**` also matches `db` itself. A `**` inside a larger
 * segment (say `a**b`) is not a directory wildcard: each `*` is an ordinary within-segment star.
 * No dependencies; nothing here reads the filesystem.
 */

/** `?` is one character, `*` is zero or more characters, both confined to the single segment. */
function segmentMatches(pattern: string, segment: string, patternAt: number, segmentAt: number): boolean {
  while (patternAt < pattern.length) {
    const character = pattern[patternAt]!;
    if (character === "*") {
      for (let skip = segmentAt; skip <= segment.length; skip += 1) {
        if (segmentMatches(pattern, segment, patternAt + 1, skip)) return true;
      }
      return false;
    }
    if (segmentAt >= segment.length) return false;
    if (character !== "?" && character !== segment[segmentAt]!) return false;
    patternAt += 1;
    segmentAt += 1;
  }
  return segmentAt === segment.length;
}

function segmentsMatch(pattern: readonly string[], path: readonly string[], patternAt: number, pathAt: number): boolean {
  while (patternAt < pattern.length) {
    const segment = pattern[patternAt]!;
    if (segment === "**") {
      for (let skip = pathAt; skip <= path.length; skip += 1) {
        if (segmentsMatch(pattern, path, patternAt + 1, skip)) return true;
      }
      return false;
    }
    if (pathAt >= path.length || !segmentMatches(segment, path[pathAt]!, 0, 0)) return false;
    patternAt += 1;
    pathAt += 1;
  }
  return pathAt === path.length;
}

/** Whole-path glob match under the pinned semantics above. */
export function globPatternMatches(pattern: string, path: string): boolean {
  return segmentsMatch(pattern.split("/"), path.split("/"), 0, 0);
}

/**
 * Decides whether the work needs human review. `config` may be absent — that evaluates as no
 * rules, never as "wait". A content match reports every changed path any rule matched,
 * deduplicated and sorted.
 */
export function evaluateApprovalRules(
  config: ApprovalRulesConfig | undefined,
  subject: WorkflowSubject,
  changedPaths: readonly string[],
): ApprovalRuleConclusion {
  const rules = config?.approval_rules;
  if (rules !== undefined && rules.subjects.includes(subject)) {
    return Object.freeze({ wait: true, match: Object.freeze({ kind: "subject", subject }) });
  }
  if (rules !== undefined) {
    const matched = [...new Set(changedPaths.filter((path) =>
      rules.content.some((rule) => rule.paths.some((pattern) => globPatternMatches(pattern, path)))))].sort();
    if (matched.length > 0) {
      return Object.freeze({ wait: true, match: Object.freeze({ kind: "content", paths: Object.freeze(matched) }) });
    }
  }
  return Object.freeze({ wait: false, match: null });
}
