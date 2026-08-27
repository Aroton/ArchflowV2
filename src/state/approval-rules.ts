import type { RepositoryName, WorkflowSubject } from "../contracts/config.js";
import type {
  RepositoryCommitMilestoneV1,
  RuleSettlementConclusionV1,
  RuleSettlementV1,
  TaskStateV1,
} from "../contracts/durable-state.js";
import { parseSafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import type { GateKind } from "../contracts/gates.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import type { GitOid } from "../contracts/canonical.js";
import type { CurrentProduceSubject } from "./produce-subject.js";

/**
 * The pure approval-rule evaluator (P3-1). A completed step must wait for a human only when a
 * declarative rule in the task config says so; absent or empty `approval_rules` produce a
 * `wait:false` evaluation. Authority consumption is a separate, later phase boundary.
 *
 * Subject triggers gate a workflow subject wholesale. Content rules match when any path the result
 * *changed* matches any rule's glob list. An implementation reports every repository path it
 * touched; a document result reports only the governing task documents it co-produced with
 * different bytes (see `changedCoProducedDocumentPaths`) — so a rule on
 * `.archflow/tasks/*\/design.md` fires when a later phase rewrites the architecture design, and a
 * Markdown rule still never fires on a phase design merely for existing.
 *
 * A subject match is checked first and short-circuits content evaluation. For phase-impl this is
 * the force rule: a phase-impl subject trigger waits on `commit-authorization` regardless of any
 * content rule — including when no content rule matches at all.
 */

/** Which rule made the step wait; `null` when nothing did. */
export type ApprovalRuleMatch =
  | Readonly<{ kind: "subject"; subject: WorkflowSubject }>
  | Readonly<{
      kind: "content";
      paths: readonly string[];
      secondary_paths?: readonly Readonly<{ repository: RepositoryName; paths: readonly string[] }>[];
    }>;

export type ApprovalRuleConclusion = RuleSettlementConclusionV1;

const GATE_SUMMARY_MAX_LENGTH = 4096;
const RULE_MATCH_SUMMARY_MAX_LENGTH = 1536;

/** Matched paths as shown to humans: primary paths bare, secondary paths prefixed by repository name. */
export function displayMatchPaths(match: Extract<ApprovalRuleMatch, { kind: "content" }>): readonly string[] {
  return [
    ...match.paths,
    ...(match.secondary_paths ?? []).flatMap((section) =>
      section.paths.map((path) => `${section.repository}/${path}`)),
  ];
}

/**
 * Names a matched path for a human. The task's own governing documents are the one case where the
 * path alone undersells what happened — a later phase rewrote the plan — so they say so.
 */
export function describeMatchedPath(path: string): string {
  const governing = /^\.archflow\/tasks\/[^/]+\/(design\.md|prd\.md)$/u.exec(path);
  if (governing === null) return path;
  return governing[1] === "design.md"
    ? `${path} (this phase changed the architecture design)`
    : `${path} (this phase changed the PRD)`;
}

/** Plain-language evidence carried into a waiting gate's durable human summary. */
export function approvalRuleMatchSummary(match: ApprovalRuleMatch): string {
  if (match.kind === "subject") {
    return `Approval rule trigger: this project requires human approval for the "${match.subject}" subject.`;
  }
  const paths = displayMatchPaths(match).map((path) => `- ${describeMatchedPath(path)}`).join("\n");
  return `Approval rule trigger: these changed paths matched the project's content rules:\n${paths}`;
}

function boundedApprovalRuleMatchSummary(match: ApprovalRuleMatch): string {
  const full = approvalRuleMatchSummary(match);
  if (full.length <= RULE_MATCH_SUMMARY_MAX_LENGTH || match.kind === "subject") return full;

  const header = "Approval rule trigger: these changed paths matched the project's content rules:";
  let shown = header;
  let shownCount = 0;
  const displayPaths = displayMatchPaths(match);
  for (const path of displayPaths) {
    const line = `\n- ${path}`;
    const remaining = displayPaths.length - shownCount - 1;
    const notice = remaining === 0
      ? ""
      : `\n- … ${remaining} additional matched path${remaining === 1 ? "" : "s"} omitted; exact paths remain in durable settlement evidence.`;
    if (shown.length + line.length + notice.length > RULE_MATCH_SUMMARY_MAX_LENGTH) break;
    shown += line;
    shownCount += 1;
  }
  const omitted = displayPaths.length - shownCount;
  return omitted === 0
    ? shown
    : `${shown}\n- … ${omitted} additional matched path${omitted === 1 ? "" : "s"} omitted; exact paths remain in durable settlement evidence.`;
}

/**
 * Adds persisted trigger evidence without exceeding the gate input's bounded-text contract.
 * Trigger evidence gets reserved space; unusually long caller prose is shortened explicitly,
 * and a large content match shows exact leading paths plus an omitted count while the complete
 * sorted path set remains durable in the settlement.
 */
export function approvalRuleGateSummary(summary: string, match: ApprovalRuleMatch): string {
  const trigger = boundedApprovalRuleMatchSummary(match);
  const separator = "\n\n";
  const prose = summary.trimEnd();
  if (prose.length + separator.length + trigger.length <= GATE_SUMMARY_MAX_LENGTH) {
    return `${prose}${separator}${trigger}`;
  }
  const notice = "\n… Gate summary truncated to preserve the approval-rule trigger.";
  const proseLimit = GATE_SUMMARY_MAX_LENGTH - separator.length - trigger.length;
  const shortened = `${prose.slice(0, Math.max(0, proseLimit - notice.length)).trimEnd()}${notice}`;
  return `${shortened}${separator}${trigger}`;
}

type ApprovalRulesConfig = Readonly<{
  approval_rules?: Readonly<{
    subjects: readonly WorkflowSubject[];
    content: readonly Readonly<{ paths: readonly string[] }>[];
  }> | undefined;
}>;

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
 * Decides whether a completed step must wait for a human. `config` may be absent (unreadable
 * config is already a blocker elsewhere) — that evaluates as no rules, never as "wait".
 * A content match reports every changed path any rule matched, deduplicated and sorted — the
 * same shape a settlement's content match is pinned to.
 */
export function evaluateApprovalRules(
  config: ApprovalRulesConfig | undefined,
  subject: WorkflowSubject,
  changedPaths: readonly string[],
  secondaryChangedPaths: readonly Readonly<{ repository: RepositoryName; paths: readonly string[] }>[] = [],
): ApprovalRuleConclusion {
  const rules = config?.approval_rules;
  if (rules !== undefined && rules.subjects.includes(subject)) {
    return Object.freeze({ wait: true, match: Object.freeze({ kind: "subject", subject }) });
  }
  if (rules !== undefined) {
    const matched = [...new Set(changedPaths.filter((path) =>
      rules.content.some((rule) => rule.paths.some((pattern) => globPatternMatches(pattern, path)))))].sort();
    const secondaryMatched = secondaryChangedPaths.flatMap((section) => {
      const paths = [...new Set(section.paths.filter((path) =>
        rules.content.some((rule) => rule.paths.some((pattern) => globPatternMatches(pattern, path)))))].sort();
      return paths.length === 0 ? [] : [Object.freeze({ repository: section.repository, paths: Object.freeze(paths) })];
    }).sort((left, right) => left.repository < right.repository ? -1 : left.repository > right.repository ? 1 : 0);
    if (matched.length > 0 || secondaryMatched.length > 0) {
      return Object.freeze({ wait: true, match: Object.freeze({
        kind: "content", paths: Object.freeze(matched),
        ...(secondaryMatched.length === 0 ? {} : { secondary_paths: Object.freeze(secondaryMatched) }),
      }) });
    }
  }
  return Object.freeze({ wait: false, match: null });
}

/**
 * The subject-to-gate-kind mapping (D5). Phase 3 uses it as vocabulary only. Settlement-driven
 * gate suppression is deferred until the constitution amendment; until then every mapped gate
 * remains explicitly human-authorized.
 */
export const subjectGateKind: Readonly<Record<WorkflowSubject, GateKind>> = Object.freeze({
  prd: "artifact-approval",
  design: "design-approval",
  "phase-design": "design-approval",
  "phase-impl": "commit-authorization",
});

/**
 * The one shared context assembly for the rule evaluation, so the status seam, the composeGate
 * disagreement-guard mirror, and the settling transaction cannot drift apart — the same pattern
 * as the guard's existing status mirror. Every consumer already holds the state, the loaded
 * produce subject, and its own parsed config read, and passes them exactly as held.
 */
export type ApprovalRuleContext = Readonly<{
  subject: WorkflowSubject;
  /**
   * An implementation output contributes every path it touched, collected the same way
   * `buildCommitAuthorizationInput` collects them: each output's path, plus a rename's previous
   * path, deduplicated and sorted. A document subject contributes the co-produced governing
   * documents it changed, which the caller measures (`changedCoProducedDocumentPaths`) and
   * passes in; no subject loaded yet carries none.
   */
  changedPaths: readonly string[];
  secondaryChangedPaths: readonly Readonly<{ repository: RepositoryName; paths: readonly string[] }>[];
  config: ApprovalRulesConfig | undefined;
}>;

export function approvalRuleContext(
  state: TaskStateV1,
  produceSubject: CurrentProduceSubject | undefined,
  config: ApprovalRulesConfig | undefined,
  changedDocumentPaths: readonly string[] = [],
): ApprovalRuleContext {
  const artifact = produceSubject?.artifact;
  const changedPaths = artifact?.artifact_kind === "implementation-output"
    ? [...new Set(artifact.outputs.flatMap((output) =>
        output.operation === "rename" ? [output.path, output.previous_path] : [output.path],
      ))].sort()
    : artifact?.artifact_kind === "document"
      ? [...new Set(changedDocumentPaths)].sort()
      : [];
  const secondaryChangedPaths = artifact?.artifact_kind === "implementation-output"
    ? (artifact.secondary_repositories ?? []).flatMap((section) => {
        const paths = [...new Set(section.outputs.flatMap((output) =>
          output.operation === "rename" ? [output.path, output.previous_path] : [output.path],
        ))].sort();
        return paths.length === 0 ? [] : [Object.freeze({ repository: section.repository, paths: Object.freeze(paths) })];
      })
    : [];
  return Object.freeze({
    subject: decodePhaseInstance(state.phase_instance).kind,
    changedPaths: Object.freeze(changedPaths),
    secondaryChangedPaths: Object.freeze(secondaryChangedPaths),
    config,
  });
}

/**
 * Builds the one durable settlement shape shared by the narrowly enumerated clean-fixed-point
 * transactions. Callers own proving that their boundary is eligible; this constructor owns the
 * mechanically derived task/phase/revision binding and preserves either rule conclusion exactly.
 */
export function buildRuleSettlement(
  state: TaskStateV1,
  subjectDigest: Sha256Digest,
  configDigest: Sha256Digest,
  conclusion: RuleSettlementConclusionV1,
  milestoneBaselineCommit?: GitOid,
  milestoneTarget?: Readonly<{ ref: string; head: GitOid }>,
  secondaryMilestones: readonly RepositoryCommitMilestoneV1[] = [],
): RuleSettlementV1 {
  const kind = decodePhaseInstance(state.phase_instance).kind;
  const baselineAllowed = !conclusion.wait && (kind === "design" || kind === "phase-design" || kind === "phase-impl");
  if ((milestoneBaselineCommit !== undefined) !== baselineAllowed) {
    throw new TypeError("a milestone baseline is required exactly for milestone-bearing wait:false settlements");
  }
  if ((milestoneTarget !== undefined) !== baselineAllowed) {
    throw new TypeError("milestone target facts are required exactly for milestone-bearing wait:false settlements");
  }
  if (!baselineAllowed && secondaryMilestones.length !== 0) {
    throw new TypeError("secondary milestones are allowed only for milestone-bearing wait:false settlements");
  }
  return Object.freeze({
    task_id: state.task_id,
    phase_instance: state.phase_instance,
    step: state.step,
    subject_digest: subjectDigest,
    conclusion: structuredClone(conclusion),
    config_digest: configDigest,
    ...(milestoneBaselineCommit === undefined ? {} : { milestone_baseline_commit: milestoneBaselineCommit }),
    ...(milestoneTarget === undefined ? {} : {
      milestone_target_ref: milestoneTarget.ref,
      milestone_target_head: milestoneTarget.head,
    }),
    ...(secondaryMilestones.length === 0 ? {} : { secondary_milestones: Object.freeze([...secondaryMilestones]) }),
    settled_at_revision: parseSafeInteger(state.revision + 1),
  });
}
