/**
 * The six frozen case fixtures: document cases from the pinned corpus, implementation
 * cases from temp repositories with sealed post-change views, executable hidden oracles,
 * and every envelope pair built through the production builders with parity proven.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRawAdjudicationV2Schema, type AdjudicationRuleSlotV1 } from "../../../src/contracts/adjudication.js";
import { canonicalJsonDigest, parseGitOid, sha256Bytes, type GitOid } from "../../../src/contracts/canonical.js";
import { parseSafeId, parseSafeInteger, parseTaskSlug, type Sha256Digest } from "../../../src/contracts/evidence.js";
import { parsePhaseInstanceId, type PhaseInstanceId } from "../../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../../src/contracts/plain-json.js";
import { reviewReportOutputSchema, type ReviewEvidence } from "../../../src/contracts/review.js";
import type { RubricV1 } from "../../../src/contracts/rubric.js";
import reviewSchemaImport from "../../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { projectCliOutputSchema } from "../../../src/dispatch/cli.js";
import { createDispatchWorkspace, materializeRepositoryViews, projectRepositoryWorkspaceBinding, type DispatchRepositoryViewPlan, type DispatchWorkspace } from "../../../src/dispatch/workspace.js";
import { prepareReviewDiffs, type PreparedReviewDiffs } from "../../../src/review/diffs.js";
import { loadReviewInputConfiguration } from "../../../src/review/inputs.js";
import { buildAdjudicationEnvelope, buildReviewEnvelope, type DispatchEnvelope, type PinnedContextEntry, type ReviewWorkspaceBinding } from "../../../src/review/envelopes.js";
import { pinnedContextEntry, priorTriageContextEntry, type PriorTriageRecord } from "../../../src/review/pinned-context.js";
import { reviewAssignment } from "../../../src/review/rubrics.js";
import { createGitRunner } from "../../../src/repository/git.js";
import { discoverWorktree } from "../../../src/repository/identity.js";
import type { ProjectionDesired, ProjectionPlan } from "../../../src/state/snapshots.js";
import { cleanupTemporaryRepositories, createTempRepository, type TempRepository } from "../temp-repository.js";
import { loadTestRubric } from "../rubrics.js";
import {
  assertPairParity,
  decodeEnvelopeDocument,
  historicalAdjudicationInstructions,
  historicalReviewInstructions,
  loadBaselineInstructions,
  rewriteEnvelopeDocument,
  substituteInstructions,
  type BaselineInstructions,
} from "./baseline.js";
import {
  CASE_IDS,
  CONSTITUTION_RULES,
  CONSTITUTION_RULE_SLOTS,
  DOCUMENT_CASES,
  IMPLEMENTATION_CASES,
  REVIEW_EFFICIENCY_ROUTE,
  rolesForCase,
  type CaseId,
  type EfficiencyRole,
  type EfficiencyVariant,
} from "./plan.js";

// ---------------------------------------------------------------------------
// Constitution rules and case fixtures
// ---------------------------------------------------------------------------


const TASK_ID = parseTaskSlug("review-efficiency");
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const BASELINE_FORMAT_COUNT = "export const formatCount = (value) => String(value);\n";
const TEMPLATE_FORMAT_COUNT = "export const formatCount = (value) => `${value}`;\n";
const DEFECTIVE_FORMAT_COUNT = "export const formatCount = (value) => Number(value);\n";
const REGRESSION_FORMAT_COUNT = 'export const formatCount = (value) => String(value || "");\n';
const SUMMARY_SOURCE = [
  'import { formatCount } from "./format-count.js";',
  "export const summary = (value) => formatCount(value).toUpperCase();",
  "",
].join("\n");
const LEGACY_SOURCE = [
  "// Pre-existing unrelated defect: this legacy check always grants access.",
  "export const legacyAllowsAccess = () => true;",
  "",
].join("\n");
const CONTRACT_SOURCE = [
  "# formatCount module contract",
  "",
  "- Inputs are non-negative safe integers.",
  "- `formatCount(value)` returns the decimal text form of `value`.",
  "- `summary(value)` returns `formatCount(value).toUpperCase()`.",
  '- `summary(0)` must return `"0"`.',
  "",
].join("\n");

const VARIANT_CONTENT: Readonly<Record<CaseId, string>> = Object.freeze({
  "document-control": "",
  "document-defect": "",
  "implementation-control": TEMPLATE_FORMAT_COUNT,
  "unchanged-caller-defect": DEFECTIVE_FORMAT_COUNT,
  "localized-correction": BASELINE_FORMAT_COUNT,
  "correction-regression": REGRESSION_FORMAT_COUNT,
});

const DECLARED_AFTER: Readonly<Record<CaseId, string>> = Object.freeze({
  "document-control": "",
  "document-defect": "",
  "implementation-control": "formatCount returns an equivalent template-string form",
  "unchanged-caller-defect": "formatCount returns Number(value)",
  "localized-correction": "formatCount returns String(value) again",
  "correction-regression": 'formatCount returns String(value || "")',
});

/**
 * Per-case producer sample verification pinned for the reviewer. Each sample is truthful and
 * bounded to what it actually executed; the hidden zero oracle is never claimed on the
 * regression, and the unchanged-caller sample never exercises the summary consumer.
 */
export const VERIFICATION_TEXT: Readonly<Record<CaseId, string>> = Object.freeze({
  "document-control": "",
  "document-defect": "",
  "implementation-control":
    'Producer sample verification (nonzero inputs only): formatCount(7) returned "7"; summary(7) returned "7". Both observed by execution and passed.',
  "unchanged-caller-defect":
    "Producer sample verification (nonzero inputs only, changed function only): formatCount(7) returned 7. The sample did not exercise the summary consumer.",
  "localized-correction":
    'Producer sample verification after the correction (nonzero inputs only): formatCount(7) returned "7"; summary(7) returned "7". Both observed by execution and passed.',
  "correction-regression":
    'Producer sample verification after the correction (nonzero inputs only): formatCount(7) returned "7"; summary(7) returned "7". Both observed by execution and passed.',
});

const DEFECTIVE_PREDECESSOR_DIGEST = (caseId: CaseId): Sha256Digest =>
  sha256Bytes(utf8.encode(`review-efficiency:${caseId}:defective-predecessor`));

export const GENERAL_FEEDBACK =
  "The reviewed change makes formatCount return a number, which breaks the unchanged summary consumer: summary(value).toUpperCase() throws for every input. Restore a string-returning implementation that satisfies the module contract.";
export const TEST_FEEDBACK =
  'The existing checks do not exercise summary for any input. Before resolving, cover the consumer: summary must return "0" for zero and "7" for nonzero input.';
export const REVISION_RATIONALE =
  "The reviewed change broke the unchanged summary consumer; restore the contract-compliant implementation and verify the consumer behavior.";
export const GENERAL_REQUEST =
  "Verify the restore resolves the summary consumer failure without introducing a new contract violation.";
export const TEST_REQUEST =
  'Verify the consumer behavior is covered: confirm summary returns "0" for zero and "7" for nonzero input.';

export type EfficiencyCaseFixture = Readonly<{
  case_id: CaseId;
  artifact: string;
  artifact_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
  phase_instance: PhaseInstanceId;
  rubric: RubricV1;
  rubric_digest: Sha256Digest;
  roles: readonly EfficiencyRole[];
  envelopes: Readonly<Record<EfficiencyVariant, CaseEnvelopes>>;
  verification_entry: PinnedContextEntry | undefined;
  output_schema: PlainJsonValue;
  /** Implementation-only owned state; document cases leave these undefined. */
  repository?: TempRepository;
  workspace?: DispatchWorkspace;
  repositories?: DispatchRepositoryViewPlan;
  workspace_binding?: ReviewWorkspaceBinding;
  diffs?: PreparedReviewDiffs;
}>;

export type CaseEnvelopes = Readonly<{
  general: DispatchEnvelope;
  test?: DispatchEnvelope;
  constitution?: Readonly<{
    envelope: DispatchEnvelope;
    slots: readonly AdjudicationRuleSlotV1[];
    outputSchema: PlainJsonValue;
  }>;
}>;

export type EfficiencyFixtures = Readonly<{
  baseline: BaselineInstructions;
  rubric_digests: Readonly<{ design: Sha256Digest; phase_impl: Sha256Digest }>;
  cases: ReadonlyMap<CaseId, EfficiencyCaseFixture>;
  runOracles: () => Promise<void>;
  cleanup: () => Promise<void>;
}>;

function corpusUrl(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/corpus/artifacts/${name}`, import.meta.url));
}

function planOf(content: string): ProjectionPlan {
  const desired: ProjectionDesired = {
    state: "present", file_type: "regular", mode: "100644", bytes: utf8.encode(content),
  };
  return {
    entries: [{ path: "src/format-count.js", desired }],
    collisions: [],
    collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
  } as unknown as ProjectionPlan;
}

function projectCliSchema(envelope: DispatchEnvelope, outputSchema: PlainJsonValue): PlainJsonValue {
  // Mirrors the adapter's own projection so the parity contract can compare the exact
  // child-visible schema across variants.
  const document = decodeEnvelopeDocument(envelope);
  return projectCliOutputSchema(
    outputSchema,
    envelope.result_kind,
    "claude-cli",
    document.subject as Readonly<Record<string, PlainJsonValue>> | undefined,
    document.assignment as never,
  );
}

function implementationArtifact(caseId: CaseId, baselineCommit: GitOid): string {
  return `${JSON.stringify({
    schema_version: "1",
    artifact_kind: "implementation-output",
    phase: "phase-impl-1",
    baseline_commit: baselineCommit,
    declared_outputs: [{
      path: "src/format-count.js",
      operation: "modify",
      before: "formatCount returns String(value), or the defective predecessor's form on follow-up",
      after: DECLARED_AFTER[caseId]!,
    }],
    co_produced_documents: [],
  }, null, 2)}\n`;
}

function feedbackFor(
  reviewerId: "general" | "test",
  focus: "general" | "tests",
  subjectDigest: Sha256Digest,
  feedback: string,
) {
  return Object.freeze({
    subject_digest: subjectDigest,
    model: REVIEW_EFFICIENCY_ROUTE.model,
    effort: REVIEW_EFFICIENCY_ROUTE.effort,
    reviewer_id: reviewerId,
    focus,
    outcome: "issues_found" as const,
    feedback,
  });
}

/**
 * Builds the six frozen case fixtures once per experiment process: document cases from the
 * pinned corpus artifacts, implementation cases from a fresh temp repository whose post-change
 * tree is sealed as a produced-snapshot view. All twelve envelope pairs are built through the
 * production builders and their parity is proven before any model call.
 */
export async function buildEfficiencyFixtures(repositoryRoot: string): Promise<EfficiencyFixtures> {
  const baseline = await loadBaselineInstructions();
  const designRubric = await loadTestRubric("design");
  const implRubric = await loadTestRubric("phase-impl");
  const cases = new Map<CaseId, EfficiencyCaseFixture>();
  const workspaces: DispatchWorkspace[] = [];

  for (const caseId of CASE_IDS) {
    const isDocument = DOCUMENT_CASES.includes(caseId);
    const rubric = isDocument ? designRubric.rubric : implRubric.rubric;
    const rubricDigest = isDocument ? designRubric.rubric_digest : implRubric.rubric_digest;
    const phaseInstance = parsePhaseInstanceId(isDocument ? "design" : "phase-impl-1");

    let artifact: string;
    let repository: TempRepository | undefined;
    let workspace: DispatchWorkspace | undefined;
    let repositories: DispatchRepositoryViewPlan | undefined;
    let workspaceBinding: ReviewWorkspaceBinding | undefined;
    let diffs: PreparedReviewDiffs | undefined;
    let priorTriage: PriorTriageRecord | undefined;

    if (isDocument) {
      artifact = decoder.decode(new Uint8Array(await readFile(corpusUrl(caseId === "document-control"
        ? "control-offline-schema-bundle.md"
        : "seeded-offline-constraint.md"))));
    } else {
      const variantContent = VARIANT_CONTENT[caseId]!;
      repository = createTempRepository({ label: `review-efficiency-${caseId}`, attributes: undefined });
      repository.write("package.json", [
        "{",
        '  "name": "review-efficiency-fixture",',
        '  "private": true,',
        '  "type": "module"',
        "}",
        "",
      ].join("\n"));
      repository.write("FORMAT_COUNT_CONTRACT.md", CONTRACT_SOURCE);
      repository.write("src/format-count.js", BASELINE_FORMAT_COUNT);
      repository.write("src/summary.js", SUMMARY_SOURCE);
      repository.write("src/legacy-auth.js", LEGACY_SOURCE);
      // Fixture commit identities enter the experiment binding (baseline_commit flows into the
      // artifact and case fingerprints), so both commits are pinned to a fixed timestamp: a
      // resumed process rebuilds identical commits and therefore an identical binding.
      process.env.GIT_AUTHOR_DATE = "2026-01-01T00:00:00+0000";
      process.env.GIT_COMMITTER_DATE = "2026-01-01T00:00:00+0000";
      repository.commitAll("baseline");
      const baselineCommit = parseGitOid(repository.git("rev-parse", "HEAD"));
      repository.write("src/format-count.js", variantContent);
      repository.git("add", "-A");
      repository.git("commit", "-q", "--allow-empty", "-m", "phase after-image");
      delete process.env.GIT_AUTHOR_DATE;
      delete process.env.GIT_COMMITTER_DATE;
      artifact = implementationArtifact(caseId, baselineCommit);
      const projection = planOf(variantContent);
      repositories = Object.freeze([Object.freeze({
        name: "primary" as const,
        member_kind: "primary" as const,
        repository_root: repository.path,
        repository_identity_digest: sha256Bytes(utf8.encode(`${caseId}:${baselineCommit}`)),
        commit: baselineCommit,
        projection_plan: projection,
        snapshot_digest: canonicalJsonDigest(projection as unknown as PlainJsonValue),
      })]);
      workspaceBinding = projectRepositoryWorkspaceBinding(repositories);

      // The shared post-change view is materialized first so diff preparation runs in exactly
      // the coordinator's layout: the review-diffs directory lands as a sibling of the view.
      workspace = await materializeRepositoryViews(await createDispatchWorkspace("claude-cli", repositoryRoot), repositories);
      workspaces.push(workspace);
      const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), {
        task_id: TASK_ID, phase_instance: phaseInstance, operation: "review-efficiency", attempt: 1,
      } as never);
      if (!discovered.ok) throw new Error(`fixture worktree discovery failed: ${discovered.error.code}`);

      if (caseId === "localized-correction" || caseId === "correction-regression") {
        const predecessorDigest = DEFECTIVE_PREDECESSOR_DIGEST(caseId);
        const predecessorPlan = planOf(DEFECTIVE_FORMAT_COUNT);
        priorTriage = {
          response: {
            decision: "revise",
            rationale: REVISION_RATIONALE,
            reviewers: [
              { reviewer_id: "general", request: GENERAL_REQUEST },
              { reviewer_id: "test", request: TEST_REQUEST },
            ],
          },
          phase_instance: phaseInstance,
          current_attempt: parseSafeInteger(2),
          dispositions: [],
          current: [],
          source_review: {
            evidence_digest: sha256Bytes(utf8.encode(`${caseId}:defective-review`)),
            evidence: {
              schema_version: "5",
              subject_digest: predecessorDigest,
              reports: [
                feedbackFor("general", "general", predecessorDigest, GENERAL_FEEDBACK),
                feedbackFor("test", "tests", predecessorDigest, TEST_FEEDBACK),
              ],
            } as unknown as ReviewEvidence,
          },
        };
        const oldPlans = new Map([[predecessorDigest, predecessorPlan]]);
        diffs = await prepareReviewDiffs({
          workspace, repositories, runners: new Map([["primary", discovered.value]]),
          subject: { artifact_digest: sha256Bytes(utf8.encode(artifact)), artifact: { artifact_kind: "implementation-output" } } as never,
          state: { task_id: TASK_ID, phase_instance: phaseInstance, authoritative_results: [], superseded_production_results: [{
            phase_instance: phaseInstance, step: "produce", result_digest: predecessorDigest,
            result_id: "result-defective-predecessor", input_fingerprint: canonicalJsonDigest({ case: caseId, predecessor: true }),
          }] } as never,
          dependencies: {
            load_retained_manifest: async (reference: { result_digest: string }) => ({ ok: true as const, value: {
              manifest: { value: { artifact_digest: reference.result_digest } },
            } }),
            load_retained_result: async (reference: { result_digest: string }) => ({ ok: true as const, value: {
              prepared: { manifest: { value: { source_artifact: {
                artifact_kind: "implementation-output", task_id: TASK_ID,
                phase_instance: phaseInstance, base_commit: baselineCommit,
              } } } },
              projection_plan: oldPlans.get(reference.result_digest as Sha256Digest)!,
            } }),
          } as never,
          prior_triage: priorTriage,
          signal: new AbortController().signal,
        });
      } else {
        diffs = await prepareReviewDiffs({
          workspace, repositories, runners: new Map([["primary", discovered.value]]),
          subject: { artifact_digest: sha256Bytes(utf8.encode(artifact)), artifact: { artifact_kind: "implementation-output" } } as never,
          state: { task_id: TASK_ID, phase_instance: phaseInstance, authoritative_results: [] } as never,
          dependencies: {},
          signal: new AbortController().signal,
        });
      }
    }

    const artifactDigest = sha256Bytes(utf8.encode(artifact));
    const inputFingerprint = canonicalJsonDigest({ case: caseId, artifact_digest: artifactDigest });
    // Document cases receive the same artifact and empty context in both variants; only the
    // implementation cases pin the sample verification entry.
    const verificationEntry = isDocument ? undefined : pinnedContextEntry(
      "verification-transcript", "verification-transcript", utf8.encode(VERIFICATION_TEXT[caseId]!),
    );

    const subjectBase = {
      task_id: TASK_ID,
      phase_instance: phaseInstance,
      role: "counter-review" as const,
      step: "counter_review" as const,
      attempt: parseSafeInteger(1),
      subject_digest: artifactDigest,
      input_fingerprint: inputFingerprint,
      rubric_digest: rubricDigest,
      producer_family: "claude" as const,
    };

    const context: PinnedContextEntry[] = verificationEntry === undefined ? [] : [verificationEntry];
    if (priorTriage !== undefined) {
      // Rendered by the production renderer, never hand-authored, scoped per reviewer.
      context.unshift(priorTriageContextEntry(priorTriage, undefined, "general"));
    }
    const general = buildReviewEnvelope({
      artifact,
      rubric,
      assignment: reviewAssignment("general", "general", isDocument ? "design" : "phase-impl", rubric, {
        expected_upstream_digests: [],
      }),
      context,
      ...(diffs === undefined ? {} : { diffs: diffs.reviewers.get("general") ?? { full: diffs.full } }),
      ...(workspaceBinding === undefined ? {} : { workspace: workspaceBinding }),
      subject: {
        ...subjectBase,
        invocation_id: parseSafeId(`invocation-${caseId}-general`),
        result_id: parseSafeId(`result-${caseId}-general`),
      },
    });
    const production: { general: DispatchEnvelope; test?: DispatchEnvelope; constitution?: NonNullable<CaseEnvelopes["constitution"]> } = { general };
    if (!isDocument) {
      const testContext: PinnedContextEntry[] = [verificationEntry!];
      if (priorTriage !== undefined) {
        testContext.unshift(priorTriageContextEntry(priorTriage, undefined, "test"));
      }
      production.test = buildReviewEnvelope({
        artifact,
        rubric,
        assignment: reviewAssignment("test", "tests", "phase-impl", rubric),
        context: testContext,
        diffs: diffs!.reviewers.get("test") ?? { full: diffs!.full },
        workspace: workspaceBinding!,
        subject: {
          ...subjectBase,
          invocation_id: parseSafeId(`invocation-${caseId}-test`),
          result_id: parseSafeId(`result-${caseId}-test`),
        },
      });
      production.constitution = {
        envelope: buildAdjudicationEnvelope({
          artifact,
          rules: CONSTITUTION_RULES,
          // Match runCounterReview exactly: adjudication never receives a reviewer-specific
          // revision descriptor, including on follow-up.
          diffs: { full: diffs!.full },
          source_review_envelope_digest: general.digest,
          workspace: workspaceBinding!,
          subject: {
            task_id: TASK_ID,
            phase_instance: phaseInstance,
            role: "adjudication",
            step: "adjudicate",
            subject_digest: artifactDigest,
            input_fingerprint: inputFingerprint,
            pinned_constitution_digest: canonicalJsonDigest({ experiment: TASK_ID, case: caseId }),
            source_review_envelope_digest: general.digest,
            invocation_id: parseSafeId(`invocation-${caseId}-constitution`),
            result_id: parseSafeId(`result-${caseId}-constitution`),
          },
        }),
        slots: CONSTITUTION_RULE_SLOTS,
        outputSchema: JSON.parse(JSON.stringify(createRawAdjudicationV2Schema(CONSTITUTION_RULE_SLOTS)
          .toJSONSchema({ target: "draft-2020-12" }))) as PlainJsonValue,
      };
    }

    // The historical variant replaces the selected recipe instructions with the captured
    // baseline components for this surface and role, then regenerates the delivered prompt.
    // Subject identity, context, diffs, rules, workspace, and schemas stay untouched.
    const hasDiffs = diffs !== undefined;
    const hasPriorTriage = priorTriage !== undefined;
    const rubricKind = isDocument ? "document" : "implementation";
    const constitutionInstructions = production.constitution === undefined
      ? undefined
      : { rule_coverage: loadReviewInputConfiguration().instructions.constitution!,
          uncertainty: "Report uncertainty only when the supplied evidence leaves compliance open.",
          trigger: "Rules without a trigger must report not-matched.",
          implementation_scope: loadReviewInputConfiguration().instructions.constitution_implementation! };
    const historicalEnvelopes: { general: DispatchEnvelope; test?: DispatchEnvelope; constitution?: NonNullable<CaseEnvelopes["constitution"]> } = {
      general: substituteInstructions(
        production.general,
        historicalReviewInstructions({ baseline, rubricKind, focus: "general", hasDiffs, hasPriorTriage }),
        "dispatch-envelope",
      ),
    };
    if (production.test !== undefined) {
      historicalEnvelopes.test = substituteInstructions(
        production.test,
        historicalReviewInstructions({ baseline, rubricKind, focus: "tests", hasDiffs, hasPriorTriage }),
        "dispatch-envelope",
      );
    }
    if (production.constitution !== undefined && constitutionInstructions !== undefined) {
      const substituted = substituteInstructions(
        production.constitution.envelope,
        historicalAdjudicationInstructions({ baseline, currentInstructions: constitutionInstructions, hasDiffs }),
        "adjudication-envelope",
      );
      historicalEnvelopes.constitution = {
        envelope: rewriteEnvelopeDocument(substituted, (document) => {
          // Each variant's adjudication binds its own ordinary general envelope, exactly as an
          // independently executed historical run would have; pair parity normalizes this field.
          document.source_review_envelope_digest = historicalEnvelopes.general.digest;
          const subject = document.subject;
          if (subject !== null && typeof subject === "object" && !Array.isArray(subject)) {
            document.subject = {
              ...(subject as Record<string, PlainJsonValue>),
              source_review_envelope_digest: historicalEnvelopes.general.digest,
            };
          }
        }, "adjudication-envelope"),
        slots: production.constitution.slots,
        outputSchema: production.constitution.outputSchema,
      };
    }
    const envelopes: Record<EfficiencyVariant, CaseEnvelopes> = {
      new: Object.freeze(production),
      old: Object.freeze(historicalEnvelopes),
    };

    // Prove the pair contract at build time: after the normalized fields are removed, the
    // variants must be deep equal while bytes and digests differ; the projected output schema
    // is compared under the same normalization.
    const pairs: readonly (readonly [EfficiencyRole, DispatchEnvelope | undefined, DispatchEnvelope | undefined])[] = [
      ["general", envelopes.new.general, envelopes.old.general],
      ["test", envelopes.new.test, envelopes.old.test],
      ["constitution", envelopes.new.constitution?.envelope, envelopes.old.constitution?.envelope],
    ];
    for (const [role, current, historical] of pairs) {
      if (current === undefined || historical === undefined) continue;
      if (role === "constitution") {
        assertPairParity(current, historical, {
          normalizeSourceDigest: true, label: `${caseId}/constitution`,
        });
        // Separately prove each variant's derived binding equals its actual ordinary envelope.
        const currentGeneralDigest = envelopes.new.general!.digest;
        const historicalGeneralDigest = envelopes.old.general!.digest;
        const currentDocument = decodeEnvelopeDocument(current);
        const historicalDocument = decodeEnvelopeDocument(historical);
        if (currentDocument.source_review_envelope_digest !== currentGeneralDigest ||
            historicalDocument.source_review_envelope_digest !== historicalGeneralDigest) {
          throw new TypeError(`${caseId}/constitution: source envelope binding does not match its variant`);
        }
        const subjectDigest = (value: PlainJsonValue | undefined): PlainJsonValue | undefined => {
          if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
          return (value as Readonly<Record<string, PlainJsonValue>>).source_review_envelope_digest;
        };
        if (subjectDigest(currentDocument.subject) !== currentGeneralDigest ||
            subjectDigest(historicalDocument.subject) !== historicalGeneralDigest) {
          throw new TypeError(`${caseId}/constitution: subject binding does not match its variant`);
        }
      } else {
        assertPairParity(current, historical, { label: `${caseId}/${role}` });
        if (JSON.stringify(projectCliSchema(current, reviewSchemaImport as PlainJsonValue)) !==
            JSON.stringify(projectCliSchema(historical, reviewSchemaImport as PlainJsonValue))) {
          throw new TypeError(`${caseId}/${role}: projected output schemas differ across variants`);
        }
      }
    }

    cases.set(caseId, Object.freeze({
      case_id: caseId,
      artifact,
      artifact_digest: artifactDigest,
      input_fingerprint: inputFingerprint,
      phase_instance: phaseInstance,
      rubric,
      rubric_digest: rubricDigest,
      roles: rolesForCase(caseId),
      envelopes,
      verification_entry: verificationEntry,
      output_schema: reviewSchemaImport as PlainJsonValue,
      ...(repository === undefined ? {} : { repository }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(repositories === undefined ? {} : { repositories }),
      ...(workspaceBinding === undefined ? {} : { workspace_binding: workspaceBinding }),
      ...(diffs === undefined ? {} : { diffs }),
    }));
  }

  const runOracles = async (): Promise<void> => {
    for (const caseId of IMPLEMENTATION_CASES) {
      await runCaseOracle(cases.get(caseId)!, caseId);
    }
  };

  return Object.freeze({
    baseline,
    rubric_digests: Object.freeze({
      design: designRubric.rubric_digest,
      phase_impl: implRubric.rubric_digest,
    }),
    cases,
    runOracles,
    cleanup: async () => {
      await Promise.all(workspaces.splice(0).map((entry) => entry.dispose().catch(() => undefined)));
      cleanupTemporaryRepositories();
    },
  });
}

// ---------------------------------------------------------------------------
// Executable fixture oracles
// ---------------------------------------------------------------------------

/**
 * Establishes each projected implementation subject's intended control or seeded behavior by
 * executing the fixture modules before any model call. A mismatch is a harness fault and aborts
 * the experiment; it never reaches a reviewer.
 */
export async function runCaseOracle(fixture: EfficiencyCaseFixture, caseId: CaseId): Promise<void> {
  const repository = fixture.repository;
  if (repository === undefined) throw new TypeError(`${caseId}: oracle requires an implementation fixture`);
  const root = pathToFileURL(`${join(repository.path, "src")}/`);
  const format = await import(new URL("format-count.js", root).href) as { formatCount: (value: number) => unknown };
  const summary = await import(new URL("summary.js", root).href) as { summary: (value: number) => unknown };
  const observed = {
    format_zero: repr(format.formatCount(0)),
    format_seven: repr(format.formatCount(7)),
    summary_zero: reprOrThrow(() => summary.summary(0)),
    summary_seven: reprOrThrow(() => summary.summary(7)),
  };
  const expect = (actual: string, wanted: string, label: string): void => {
    if (actual !== wanted) {
      throw new TypeError(`${caseId}: oracle mismatch on ${label}: observed ${actual}, intended ${wanted}`);
    }
  };
  if (caseId === "implementation-control" || caseId === "localized-correction") {
    expect(observed.format_zero, '"0"', "formatCount(0)");
    expect(observed.format_seven, '"7"', "formatCount(7)");
    expect(observed.summary_zero, '"0"', "summary(0)");
    expect(observed.summary_seven, '"7"', "summary(7)");
  } else if (caseId === "unchanged-caller-defect") {
    expect(observed.format_zero, "0", "formatCount(0)");
    expect(observed.format_seven, "7", "formatCount(7)");
    if (!(observed.summary_seven.includes("TypeError"))) {
      throw new TypeError(`${caseId}: oracle mismatch: summary(7) did not throw the seeded consumer failure`);
    }
  } else if (caseId === "correction-regression") {
    expect(observed.format_zero, '""', "formatCount(0)");
    expect(observed.format_seven, '"7"', "formatCount(7)");
    expect(observed.summary_zero, '""', "summary(0)");
    expect(observed.summary_seven, '"7"', "summary(7)");
  } else {
    throw new TypeError(`${caseId}: no oracle for this case`);
  }
}

function repr(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function reprOrThrow(call: () => unknown): string {
  try {
    return repr(call());
  } catch (error) {
    return `${error instanceof Error ? error.name : "Error"}: ${(error instanceof Error ? error.message : "")}`;
  }
}
