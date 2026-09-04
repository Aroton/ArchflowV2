import {
  canonicalDocument,
  canonicalJsonDigest,
  sha256Bytes,
} from "../contracts/canonical.js";
import type { AdjudicationEvidence } from "../contracts/adjudication.js";
import type {
  EvidenceArtifactV1,
  ResultManifestV1,
} from "../contracts/durable-result-manifest.js";
import { parseResultManifest } from "../contracts/durable-result-manifest.js";
import type {
  AuthoritativeResultRef,
  TaskStateV1,
} from "../contracts/durable-state.js";
import type {
  DocumentArtifactV1,
  EditorialPredecessorRef,
} from "../contracts/durable-document.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import {
  parseSafeInteger,
  type SafeId,
  type SafeInteger,
  type Sha256Digest,
} from "../contracts/evidence.js";
import {
  createVerifiedEvidenceReference,
} from "../contracts/internal/trust-mints.js";
import { registerCurrentReviewSet } from "../contracts/internal/trust-brands.js";
import {
  parseRepositoryPathClaim,
} from "../contracts/path-claims.js";
import {
  renderAdjudicationEvidence,
  renderReviewEvidence,
  renderTriage,
} from "../contracts/renderers.js";
import { reviewFindingDisplayDetail, type ReviewEvidence } from "../contracts/review.js";
import type { EffortEvidence } from "../contracts/effort-review.js";
import {
  parseSecretScanResult,
  type SecretScanner,
  type SecretScanResult,
} from "../contracts/secret-scan.js";
import type { CurrentReviewSet } from "../contracts/trust.js";
import {
  currentEvidenceSetRef,
  parseRequiredReviewSlots,
  type CurrentEvidenceSetRef,
  type RequiredReviewSlots,
  type VerifiedReferencedEvidence,
} from "../contracts/trust.js";
import {
  validateTriage,
  type ReviewRoundHistoryEntryV1,
  type TriageCandidate,
  type TriageDisposition,
  type TriageDispositionLedgerEntry,
} from "../contracts/triage.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import {
  resultAuthorityClaim,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  counterReviewClaim,
  triageReviewClaim,
  adjudicationReviewClaim,
  type ResolvedPath,
} from "../repository/paths.js";
import {
  assertInternalTransactionAuthority,
  type TransactionAuthority,
} from "./authority.js";
import { loadCurrentProduceSubject } from "./produce-subject.js";
import type { CurrentProduceSubject } from "./produce-subject.js";
import {
  captureProjectionTarget,
  deriveDeclaredSnapshotDigest,
  prepareProjectionPlan,
  prepareSnapshot,
  type PreparedSnapshot,
  type ProjectionPlan,
  type ProjectionSource,
} from "./snapshots.js";
import type {
  RetainedManifest,
  TransactionDependencies,
} from "./transaction.js";

export type PreparedEvidenceResult = Readonly<{
  reference: AuthoritativeResultRef;
  prepared: PreparedSnapshot;
  manifest_target: ResolvedPath;
  projection_plan: ProjectionPlan;
  evidence_digest: Sha256Digest;
  rendered_digest: Sha256Digest;
}>;

export type EvidenceResultValue =
  | Readonly<{ kind: "review"; evidence: ReviewEvidence }>
  | Readonly<{
      kind: "triage";
      current_reviews: CurrentReviewSet;
      evidence: TriageCandidate;
    }>
  | Readonly<{ kind: "adjudication"; evidence: AdjudicationEvidence }>;

export type PrepareEvidenceResultInput = Readonly<{
  authority: TransactionAuthority;
  runner: RootBoundGitRunner;
  result_id: SafeId;
  retained_task_bytes: SafeInteger;
  measured_at_revision: SafeInteger;
  scanner: SecretScanner;
  value: EvidenceResultValue;
  /**
   * Reviewer-memory sources for a triage artifact: the durable attempt of the round being
   * dispositioned plus the retained predecessor-triage and reviewed-evidence references. With
   * a retained-result loader, prepareEvidenceResult embeds the server-computed disposition
   * ledger after validation; producers cannot supply one.
   */
  readonly disposition_ledger?: Readonly<{
    readonly attempt: SafeInteger;
    readonly previous_triage_ref?: AuthoritativeResultRef;
    readonly review_ref?: AuthoritativeResultRef;
  }>;
  readonly load_retained_result?: TransactionDependencies["load_retained_result"];
}>;

export type RetainedEvidenceSet = ReadonlyMap<
  PipelineStep,
  Readonly<{
    reference: AuthoritativeResultRef;
    manifest: ResultManifestV1;
  }>
>;

export type GoverningPhaseDesignEffortEvidence = Readonly<{
  phase_instance: PhaseInstanceId;
  produce: CurrentProduceSubject;
  review?: ReviewEvidence;
  assessment?: EffortEvidence;
}>;

type RetainedEvidenceDependencies = Pick<TransactionDependencies, "load_retained_manifest">;
/** Editorial checks read retained evidence and the current produce subject entirely by manifest. */
type EditorialSubjectDependencies = Pick<TransactionDependencies, "load_retained_manifest">;
type CurrentReviewSetDependencies = Readonly<{
  read_state: TransactionDependencies["read_state"];
  load_retained_manifest: NonNullable<TransactionDependencies["load_retained_manifest"]>;
}>;

export type DerivedCurrentEvidenceSet = Readonly<{
  task_id: ReviewEvidence["task_id"];
  phase_instance: PhaseInstanceId;
  subject_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
  current_evidence_set: CurrentEvidenceSetRef;
  reviews: readonly VerifiedReferencedEvidence<"review">[];
}>;

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });

function qualifyAndRender(
  value: EvidenceResultValue,
  dispositionLedger?: readonly TriageDispositionLedgerEntry[],
  reviewRoundHistory?: readonly ReviewRoundHistoryEntryV1[],
): Readonly<{
  artifact: EvidenceArtifactV1;
  bytes: Uint8Array;
  evidence_digest: Sha256Digest;
  phase_instance: PhaseInstanceId;
  step: PipelineStep;
  task_id: ReviewEvidence["task_id"];
  input_fingerprint: Sha256Digest;
}> {
  if (value.kind === "review") {
    const verified = createVerifiedEvidenceReference(value.evidence);
    return Object.freeze({
      artifact: Object.freeze({
        schema_version: "1",
        artifact_kind: "review-evidence",
        evidence: verified.evidence,
      }),
      bytes: renderReviewEvidence(verified),
      evidence_digest: verified.evidence_digest,
      phase_instance: verified.evidence.phase_instance as PhaseInstanceId,
      step: verified.evidence.step,
      task_id: verified.evidence.task_id,
      input_fingerprint: verified.evidence.input_fingerprint,
    });
  }
  if (value.kind === "adjudication") {
    const verified = createVerifiedEvidenceReference(value.evidence);
    return Object.freeze({
      artifact: Object.freeze({
        schema_version: "1",
        artifact_kind: "adjudication-evidence",
        evidence: verified.evidence,
      }),
      bytes: renderAdjudicationEvidence(verified),
      evidence_digest: verified.evidence_digest,
      phase_instance: verified.evidence.phase_instance as PhaseInstanceId,
      step: verified.evidence.step,
      task_id: verified.evidence.task_id,
      input_fingerprint: verified.evidence.input_fingerprint,
    });
  }
  const triage = validateTriage(
    value.current_reviews,
    value.evidence,
    dispositionLedger,
    reviewRoundHistory,
  );
  return Object.freeze({
    artifact: Object.freeze({
      schema_version: "1",
      artifact_kind: "triage",
      evidence: triage,
    }),
    bytes: renderTriage(triage),
    evidence_digest: canonicalJsonDigest(triage),
    phase_instance: triage.phase_instance as PhaseInstanceId,
    step: triage.step,
    task_id: triage.task_id,
    input_fingerprint: triage.input_fingerprint,
  });
}

/**
 * Builds the server-computed disposition ledger a triage artifact installs: the current round's
 * dispositions are embedded with the reviewer-authored finding details of the round they answer
 * — resolvable now because that evidence is still the retained counter-review result — and the
 * predecessor's ledger is carried forward, so each entry's details survive the supersession of
 * its round. The newest disposition of an exact review occurrence wins. Reviewer memory is
 * best-effort context, not authority: a predecessor installed without a ledger (before this field existed)
 * contributes nothing — its dispositions' review evidence is already superseded, so absence is
 * the accurate record — and an unloadable predecessor or review manifest degrades the same way
 * rather than failing the triage.
 */
export async function computeDispositionLedger(
  dispositions: readonly TriageDisposition[],
  sources: Readonly<{
    attempt: SafeInteger;
    previous_triage_ref?: AuthoritativeResultRef;
    review_ref?: AuthoritativeResultRef;
  }>,
  loadRetainedResult: NonNullable<TransactionDependencies["load_retained_result"]>,
): Promise<readonly TriageDispositionLedgerEntry[]> {
  const merged = new Map<string, TriageDispositionLedgerEntry>();
  if (sources.previous_triage_ref !== undefined) {
    const previous = await loadRetainedResult(sources.previous_triage_ref);
    if (previous.ok) {
      const source = previous.value.prepared.manifest.value.source_artifact;
      if (source.artifact_kind === "triage" && source.evidence.disposition_ledger !== undefined) {
        for (const entry of source.evidence.disposition_ledger) {
          merged.set(`${entry.review_evidence_digest}:${entry.finding_id}`, entry);
        }
      }
    }
  }
  const findingDetails = new Map<string, ReviewEvidence["findings"][number]>();
  if (sources.review_ref !== undefined) {
    const review = await loadRetainedResult(sources.review_ref);
    if (review.ok) {
      const manifest = review.value.prepared.manifest.value;
      if (manifest.source_artifact.artifact_kind === "review-evidence") {
        for (const finding of manifest.source_artifact.evidence.findings) {
          findingDetails.set(`${manifest.artifact_digest}:${finding.finding_id}`, finding);
        }
      }
    }
  }
  for (const disposition of dispositions) {
    const finding = findingDetails.get(`${disposition.review_evidence_digest}:${disposition.finding_id}`);
    const display = finding === undefined ? undefined : reviewFindingDisplayDetail(finding);
    const occurrenceKey = `${disposition.review_evidence_digest}:${disposition.finding_id}`;
    if (finding !== undefined && "reviewer_focus" in finding) {
      const recorded = disposition as Readonly<{ rationale?: string; revision_intent?: string; evidence?: string }>;
      const dispositionEvidence = disposition.disposition === "rejected" || disposition.disposition === "deferred"
        ? recorded.evidence
        : undefined;
      const common = {
        review_evidence_digest: disposition.review_evidence_digest,
        finding_id: disposition.finding_id,
        disposition: disposition.disposition,
        attempt: sources.attempt,
        rationale: disposition.rationale,
        ...(recorded.revision_intent === undefined ? {} : { revision_intent: recorded.revision_intent }),
        claim_type: finding.claim_type,
        confidence: finding.confidence,
        falsifier: finding.falsifier,
        reviewer_id: finding.reviewer_id,
        reviewer_focus: finding.reviewer_focus,
        routing_role: finding.routing_role,
        criterion_id: finding.criterion_id,
        ...(dispositionEvidence === undefined ? {} : { disposition_evidence: dispositionEvidence }),
      } as const;
      merged.set(occurrenceKey, Object.freeze(finding.reviewer_focus === "general"
        ? {
          ...common,
          reviewer_focus: "general" as const,
          routing_role: "counter-reviewer" as const,
          summary: finding.summary,
          evidence: finding.evidence,
          suggested_resolution: finding.suggested_resolution,
        }
        : {
          ...common,
          reviewer_focus: "tests" as const,
          routing_role: "test-reviewer" as const,
          required_behavior_or_risk_boundary: finding.required_behavior_or_risk_boundary,
          coverage_or_oracle_problem: finding.coverage_or_oracle_problem,
          consequence: finding.consequence,
          proposed_verification_change: finding.proposed_verification_change,
        }));
      continue;
    }
    merged.set(occurrenceKey, Object.freeze({
      review_evidence_digest: disposition.review_evidence_digest,
      finding_id: disposition.finding_id,
      disposition: disposition.disposition,
      attempt: sources.attempt,
      rationale: disposition.rationale,
      ...(disposition.disposition === "rejected"
        ? { evidence: disposition.evidence }
        : disposition.disposition === "accepted" || disposition.disposition === "accepted-editorial"
          ? {
            revision_intent: disposition.revision_intent,
            ...(display === undefined ? {} : { evidence: display.evidence }),
          }
          : disposition.disposition === "escalated-human"
            ? (display === undefined ? {} : { evidence: display.evidence })
            : {
              ...(disposition.evidence !== undefined
                ? { evidence: disposition.evidence }
                : display !== undefined
                  ? { evidence: display.evidence }
                  : {}),
            }),
      ...(finding === undefined ? {} : {
        ...("claim_type" in finding
          ? {
            claim_type: finding.claim_type,
            confidence: finding.confidence,
            falsifier: finding.falsifier,
          }
          : {
            severity: finding.severity,
            blocking: finding.blocking,
          }),
        summary: display!.summary,
        suggested_resolution: display!.suggested_resolution,
      }),
    }));
  }
  return Object.freeze([...merged.values()]);
}

/** Resolves the ledger sources threaded by the handler; absent sources mean no ledger field. */
async function triageLedgerFrom(
  input: PrepareEvidenceResultInput,
): Promise<readonly TriageDispositionLedgerEntry[] | undefined> {
  if (input.value.kind !== "triage" || input.disposition_ledger === undefined) return undefined;
  if (input.load_retained_result === undefined) {
    throw new TypeError("disposition ledger sources require a retained-result loader");
  }
  return computeDispositionLedger(
    input.value.evidence.dispositions,
    input.disposition_ledger,
    input.load_retained_result,
  );
}

/**
 * Carries one identity per completed review attempt. Unlike the disposition ledger this does not
 * key by finding occurrence, so repeated feedback and finding-free rounds remain observable.
 */
export async function computeReviewRoundHistory(
  sources: Readonly<{
    attempt: SafeInteger;
    previous_triage_ref?: AuthoritativeResultRef;
    review_ref?: AuthoritativeResultRef;
  }>,
  loadRetainedResult: NonNullable<TransactionDependencies["load_retained_result"]>,
): Promise<readonly ReviewRoundHistoryEntryV1[]> {
  const rounds = new Map<number, ReviewRoundHistoryEntryV1>();
  const ambiguousAttempts = new Set<number>();
  const remember = (entry: ReviewRoundHistoryEntryV1): void => {
    if (ambiguousAttempts.has(entry.attempt)) return;
    const existing = rounds.get(entry.attempt);
    if (existing !== undefined && existing.review_evidence_digest !== entry.review_evidence_digest) {
      // Historical schemas could represent multiple occurrence-ledger digests for one attempt
      // without enforcing their shared review identity. That attempt proves no completed round:
      // remove it permanently from this reconstruction so ambiguity can only reduce, never
      // inflate, push-through eligibility while ordinary triage remains available.
      rounds.delete(entry.attempt);
      ambiguousAttempts.add(entry.attempt);
      return;
    }
    rounds.set(entry.attempt, Object.freeze({ ...entry }));
  };
  if (sources.previous_triage_ref !== undefined) {
    const previous = await loadRetainedResult(sources.previous_triage_ref);
    if (previous.ok) {
      const source = previous.value.prepared.manifest.value.source_artifact;
      if (source.artifact_kind === "triage") {
        for (const entry of source.evidence.review_round_history ?? []) {
          remember(entry);
        }
        // A pre-history triage can still prove prior completed rounds through its server-computed
        // disposition ledger. One counter-review digest per attempt is the only unambiguous
        // reconstruction; ambiguity fails closed instead of inflating eligibility.
        for (const entry of source.evidence.disposition_ledger ?? []) {
          remember({
            attempt: entry.attempt,
            review_evidence_digest: entry.review_evidence_digest,
          });
        }
      }
    }
  }
  if (sources.review_ref !== undefined) {
    const review = await loadRetainedResult(sources.review_ref);
    if (review.ok) {
      const manifest = review.value.prepared.manifest.value;
      if (manifest.source_artifact.artifact_kind === "review-evidence") {
        const entry = Object.freeze({
          attempt: sources.attempt,
          review_evidence_digest: manifest.artifact_digest,
        });
        remember(entry);
      }
    }
  }
  return Object.freeze([...rounds.values()].sort((left, right) => left.attempt - right.attempt));
}

async function triageRoundHistoryFrom(
  input: PrepareEvidenceResultInput,
): Promise<readonly ReviewRoundHistoryEntryV1[] | undefined> {
  if (input.value.kind !== "triage" || input.disposition_ledger === undefined) return undefined;
  if (input.load_retained_result === undefined) {
    throw new TypeError("review round history sources require a retained-result loader");
  }
  return computeReviewRoundHistory(input.disposition_ledger, input.load_retained_result);
}

/**
 * Prepares one evidence manifest and canonical review projection. Evidence identity is the
 * canonical payload digest; rendered-byte identity is confined to snapshot/projection fields.
 */
export async function prepareEvidenceResult(
  input: PrepareEvidenceResultInput,
): Promise<ProjectResult<PreparedEvidenceResult>> {
  assertInternalTransactionAuthority(input.authority);
  const dispositionLedger = input.value.kind === "triage"
    ? await triageLedgerFrom(input)
    : undefined;
  const reviewRoundHistory = input.value.kind === "triage"
    ? await triageRoundHistoryFrom(input)
    : undefined;
  const qualified = qualifyAndRender(input.value, dispositionLedger, reviewRoundHistory);
  if (
    qualified.task_id !== input.authority.task_id ||
    qualified.phase_instance !== input.authority.context.phase_instance
  ) {
    throw new TypeError("evidence scope does not match transaction authority");
  }
  if (
    input.value.kind !== "triage" &&
    input.value.evidence.assurance === "server-attested" &&
    input.value.evidence.result_id !== input.result_id
  ) {
    throw new TypeError("server-attested evidence result_id does not match prepared result");
  }

  const renderedDigest = sha256Bytes(qualified.bytes);
  const snapshotDigest = deriveDeclaredSnapshotDigest([], []);
  const workspaceClaim = input.value.kind === "triage"
    ? triageReviewClaim(qualified.phase_instance)
    : input.value.kind === "adjudication"
      ? adjudicationReviewClaim(qualified.phase_instance)
      : counterReviewClaim(qualified.phase_instance);
  const projectionTarget = await resolveTaskWorkspacePath({
    runner: input.runner,
    taskId: input.authority.task_id,
    claim: workspaceClaim,
    expectedClass: "workspace-review",
    context: input.authority.context,
  });
  if (!projectionTarget.ok) return projectionTarget;
  const repositoryClaim = projectionTarget.value.repositoryRelative;
  const captured = await captureProjectionTarget(projectionTarget.value);
  let secretScan: SecretScanResult | undefined;
  const capturingScanner: SecretScanner = Object.freeze({
    scan: async (candidates: Parameters<SecretScanner["scan"]>[0]) => {
      const result = parseSecretScanResult(await input.scanner.scan(candidates));
      secretScan = result;
      return result;
    },
  });
  const source: ProjectionSource = Object.freeze({
    path: repositoryClaim,
    target: projectionTarget.value,
    desired: Object.freeze({ state: "present", file_type: "regular", mode: "100644", bytes: qualified.bytes }),
    authenticated_before: captured.observation,
    ...(captured.observation.state === "present" ? { rollback: captured.rollback } : {}),
    git_tracked: false,
  });
  const projectionPlan = await prepareProjectionPlan(
    [source],
    capturingScanner,
    input.runner.location.worktreeRoot as import("../repository/paths.js").ResolvedTaskPath,
  );
  if (!projectionPlan.ok) return projectionPlan;
  if (secretScan === undefined || secretScan.outcome !== "clean") {
    throw new TypeError("successful evidence projection requires a clean secret scan");
  }

  const manifestValue: ResultManifestV1 = Object.freeze({
    schema_version: "1",
    task_id: qualified.task_id,
    repository_identity_digest: input.authority.repository_identity_digest,
    result_id: input.result_id,
    phase_instance: qualified.phase_instance,
    step: qualified.step,
    artifact_digest: qualified.evidence_digest,
    source_artifact: qualified.artifact,
    input_fingerprint: qualified.input_fingerprint,
    snapshot_digest: snapshotDigest,
    outputs: Object.freeze([]),
    projections: Object.freeze([]),
    accounting: Object.freeze({
      schema_version: "1",
      result_bytes: parseSafeInteger(0),
      task_bytes: input.retained_task_bytes,
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: Object.freeze([]),
      measured_at_revision: input.measured_at_revision,
    }),
    secret_scan: secretScan,
  });
  const manifest = canonicalDocument(manifestValue);
  const manifestTarget = await resolveTaskPath({
    runner: input.runner,
    taskId: input.authority.task_id,
    claim: resultAuthorityClaim(manifest.digest),
    expectedClass: "authority-result",
    context: input.authority.context,
  });
  if (!manifestTarget.ok) return manifestTarget;

  const prepared = prepareSnapshot({
    manifest: manifestValue,
    payloads: Object.freeze([]),
    retained_task_bytes: input.retained_task_bytes,
    validate_manifest: parseResultManifest,
  });
  if (!prepared.ok) return prepared;
  const reference: AuthoritativeResultRef = Object.freeze({
    phase_instance: qualified.phase_instance,
    step: qualified.step,
    result_digest: prepared.value.result_digest,
    result_id: input.result_id,
    input_fingerprint: qualified.input_fingerprint,
  });
  return ok(Object.freeze({
    reference,
    prepared: prepared.value,
    manifest_target: manifestTarget.value,
    projection_plan: projectionPlan.value,
    evidence_digest: qualified.evidence_digest,
    rendered_digest: renderedDigest,
  }));
}

function expectedSourceKind(step: PipelineStep): EvidenceArtifactV1["artifact_kind"] | undefined {
  if (step === "counter_review") return "review-evidence";
  if (step === "triage") return "triage";
  if (step === "adjudicate") return "adjudication-evidence";
  return undefined;
}

function validateLoadedEvidence(
  reference: AuthoritativeResultRef,
  loaded: RetainedManifest,
): ResultManifestV1 {
  const document = canonicalDocument(parseResultManifest(loaded.manifest.value));
  if (
    document.digest !== loaded.manifest.digest ||
    !Buffer.from(document.bytes).equals(Buffer.from(loaded.manifest.bytes)) ||
    reference.result_digest !== document.digest ||
    loaded.manifest_target.path_class !== "authority-result"
  ) {
    throw new TypeError("loaded evidence result identity disagrees");
  }
  const manifest = document.value;
  const expectedKind = expectedSourceKind(reference.step);
  if (
    expectedKind === undefined ||
    manifest.source_artifact.artifact_kind !== expectedKind ||
    manifest.result_id !== reference.result_id ||
    manifest.phase_instance !== reference.phase_instance ||
    manifest.step !== reference.step ||
    manifest.input_fingerprint !== reference.input_fingerprint
  ) {
    throw new TypeError("loaded evidence result correlation disagrees");
  }
  if (
    manifest.source_artifact.artifact_kind === "review-evidence" &&
    reference.step === "counter_review" &&
    manifest.source_artifact.evidence.role !== "counter-review"
  ) {
    throw new TypeError("loaded review evidence role disagrees with its step");
  }
  if (!validateDurableSemantics({ result_manifest: document }).ok) {
    throw new TypeError("loaded evidence manifest semantics are invalid");
  }
  return manifest;
}

/**
 * Reloads the phase's authoritative evidence manifests. The retained-result callback owns
 * byte/Git revalidation; this layer additionally pins the evidence step, source kind, and
 * authoritative-reference correlation used by the fixed-point decision.
 */
export async function loadRetainedEvidence(
  dependencies: RetainedEvidenceDependencies,
  state: TaskStateV1,
  phase_instance: PhaseInstanceId,
): Promise<ProjectResult<RetainedEvidenceSet>> {
  const loadManifest = dependencies.load_retained_manifest;
  if (loadManifest === undefined) {
    throw new TypeError("retained evidence loading is unavailable");
  }
  const retained = new Map<
    PipelineStep,
    Readonly<{ reference: AuthoritativeResultRef; manifest: ResultManifestV1 }>
  >();
  for (const reference of state.authoritative_results) {
    if (reference.phase_instance !== phase_instance ||
        expectedSourceKind(reference.step) === undefined) {
      continue;
    }
    if (retained.has(reference.step)) {
      throw new TypeError("phase has duplicate retained evidence for one step");
    }
    const loaded = await loadManifest(reference);
    if (!loaded.ok) return loaded;
    const manifest = validateLoadedEvidence(reference, loaded.value);
    retained.set(reference.step, Object.freeze({
      reference: structuredClone(reference),
      manifest,
    }));
  }
  return ok(retained);
}

/**
 * Loads only the authoritative produce and counter-review records for one governing phase design.
 * The ordinary retained loaders authenticate references, manifests, source artifacts, and digests;
 * this join additionally pins the review/assessment to the same task, phase, attempt, subject, and
 * fingerprint. A differing review subject is returned intact so semantic status can report the
 * one explicit `subject-stale` unavailable state.
 */
export async function loadGoverningPhaseDesignEffortEvidence(
  dependencies: RetainedEvidenceDependencies,
  state: TaskStateV1,
  phase_instance: PhaseInstanceId,
): Promise<ProjectResult<GoverningPhaseDesignEffortEvidence>> {
  const loadManifest = dependencies.load_retained_manifest;
  if (loadManifest === undefined) throw new TypeError("retained evidence loading is unavailable");
  if (decodePhaseInstance(phase_instance).kind !== "phase-design") {
    throw new TypeError("governing effort evidence must name a phase design");
  }
  const phaseState = Object.freeze({ ...state, phase_instance });
  const produced = await loadCurrentProduceSubject(dependencies, phaseState);
  if (!produced.ok) return produced;
  const reference = state.authoritative_results.find((candidate) =>
    candidate.phase_instance === phase_instance && candidate.step === "counter_review");
  if (reference === undefined) {
    return ok(Object.freeze({ phase_instance, produce: produced.value }));
  }
  const loaded = await loadManifest(reference);
  if (!loaded.ok) return loaded;
  const manifest = loaded.value.manifest;
  const source = manifest.value.source_artifact;
  if (
    manifest.digest !== reference.result_digest ||
    manifest.value.result_id !== reference.result_id ||
    manifest.value.phase_instance !== reference.phase_instance ||
    manifest.value.step !== reference.step ||
    manifest.value.input_fingerprint !== reference.input_fingerprint
  ) {
    throw new TypeError("governing counter review reference disagrees with its retained manifest");
  }
  if (source.artifact_kind !== "review-evidence") {
    throw new TypeError("governing counter review has the wrong source kind");
  }
  const review = source.evidence;
  if (
    review.task_id !== state.task_id ||
    review.phase_instance !== phase_instance ||
    review.role !== "counter-review"
  ) {
    throw new TypeError("governing counter review scope disagrees");
  }
  let assessment: EffortEvidence | undefined;
  if (review.assurance === "server-attested") {
    assessment = review.effort_review;
    if (assessment !== undefined && (
      assessment.task_id !== review.task_id ||
      assessment.phase_instance !== review.phase_instance ||
      assessment.subject_digest !== review.subject_digest ||
      assessment.input_fingerprint !== review.input_fingerprint
    )) {
      throw new TypeError("governing effort assessment bindings disagree with its review");
    }
  }
  return ok(Object.freeze({
    phase_instance,
    produce: produced.value,
    review,
    ...(assessment === undefined ? {} : { assessment }),
  }));
}

/**
 * Derives the only admissible counter-review evidence set from retained manifests.
 * This is deliberately independent of caller-supplied set references: the review payload,
 * its canonical digest, role, assurance, and family relationship define the set.
 */
export function deriveCurrentEvidenceSet(
  retained: RetainedEvidenceSet,
): DerivedCurrentEvidenceSet {
  const counterEntry = retained.get("counter_review");
  if (counterEntry === undefined) {
    throw new TypeError("current review reconstruction requires counter evidence");
  }
  const counterSource = counterEntry.manifest.source_artifact;
  if (counterSource.artifact_kind !== "review-evidence") {
    throw new TypeError("current review manifests have the wrong source kind");
  }
  const derived = deriveEvidenceSetFromCounter(counterSource.evidence);
  if (derived.reviews[0]!.evidence_digest !== counterEntry.manifest.artifact_digest) {
    throw new TypeError("retained review evidence digest does not match its manifest");
  }
  return derived;
}

/**
 * Derives the one admissible evidence set directly from counter-review evidence. This is how the
 * merged counter-review call binds its constitution dispatch to the review it just observed —
 * the evidence is not durably installed yet, but the set digest is a pure function of the
 * payload, so the binding recomputes identically from the retained result afterwards.
 */
export function deriveEvidenceSetFromCounter(counter: ReviewEvidence): DerivedCurrentEvidenceSet {
  if (
    counter.role !== "counter-review" ||
    (counter.assurance !== "server-attested" && counter.assurance !== "degraded")
  ) {
    throw new TypeError("retained reviews do not form one current review set");
  }
  const verifiedCounter = createVerifiedEvidenceReference(counter);
  const slots = parseRequiredReviewSlots([{
    role: "counter-review",
    evidence_digest: verifiedCounter.evidence_digest,
    assurance: counter.assurance,
    producer_family: counter.producer_family,
    reviewer_family: counter.model_family,
  }]) as RequiredReviewSlots;
  return Object.freeze({
    task_id: counter.task_id,
    phase_instance: counter.phase_instance as PhaseInstanceId,
    subject_digest: counter.subject_digest,
    input_fingerprint: counter.input_fingerprint,
    current_evidence_set: currentEvidenceSetRef(slots),
    reviews: Object.freeze([
      verifiedCounter,
    ]) as readonly VerifiedReferencedEvidence<"review">[],
  });
}

/**
 * The envelope digest of the retained server-attested counter review — the round identity the
 * constitution review binds to (`source_review_envelope_digest`). A degraded counter review
 * carries no envelope digest, so no adjudication can bind to that round; the comparisons fail
 * closed and the workflow schedules a fresh round.
 */
export function retainedReviewEnvelopeDigest(retained: RetainedEvidenceSet): Sha256Digest | undefined {
  const source = retained.get("counter_review")?.manifest.source_artifact;
  return source?.artifact_kind === "review-evidence" && source.evidence.assurance === "server-attested"
    ? source.evidence.envelope_input_digest
    : undefined;
}

type RetainedEditorialTriage = Readonly<{
  triage: TriageCandidate;
  triage_result_digest: Sha256Digest;
}>;

// A static edge here participates in the production -> state-results -> evidence-results ->
// produce-subject module cycle, which is safe: the binding is only dereferenced at call time,
// long after module initialization. A dynamic import() here is what actually breaks the bundle —
// it forces esbuild to wrap the whole cycle (and, transitively, zod) in lazy __esm closures,
// which reorders bundle initialization and crashes the bundled runtime before main.
async function currentProduceSubject(
  dependencies: Pick<TransactionDependencies, "load_retained_manifest">,
  state: TaskStateV1,
): ReturnType<typeof loadCurrentProduceSubject> {
  return loadCurrentProduceSubject(dependencies, state);
}

/**
 * The retained triage entry, but only when it is an editorial authorizer: every accepted finding
 * is `accepted-editorial` and the triage binds the derived current review set exactly.
 */
function retainedEditorialTriage(retained: RetainedEvidenceSet): RetainedEditorialTriage | undefined {
  const entry = retained.get("triage");
  const source = entry?.manifest.source_artifact;
  if (entry === undefined || source?.artifact_kind !== "triage") return undefined;
  const triage = source.evidence;
  if (
    triage.accepted_count !== 0 ||
    (triage.accepted_editorial_count ?? 0) === 0 ||
    (triage.escalated_human_count ?? 0) !== 0
  ) return undefined;
  let derived: DerivedCurrentEvidenceSet;
  try {
    derived = deriveCurrentEvidenceSet(retained);
  } catch {
    return undefined;
  }
  if (
    triage.subject_digest !== derived.subject_digest ||
    triage.input_fingerprint !== derived.input_fingerprint ||
    triage.current_evidence_set_digest !== derived.current_evidence_set.set_digest ||
    triage.source_evidence_digests.length !== derived.current_evidence_set.slots.length ||
    triage.source_evidence_digests.some((digest, index) =>
      digest !== derived.current_evidence_set.slots[index]!.evidence_digest)
  ) return undefined;
  return Object.freeze({ triage, triage_result_digest: entry.reference.result_digest });
}

/**
 * Derives the editorial predecessor link a produce re-entry must declare, entirely from durable
 * authority: the retained produce result the pending editorial triage judged. Returns undefined
 * when durable state shows no pending editorial revision — the triage is absent, has plain
 * accepts, or is already bound to a predecessor rather than to the retained artifact itself.
 */
export async function derivePendingEditorialPredecessor(
  dependencies: EditorialSubjectDependencies,
  state: TaskStateV1,
): Promise<EditorialPredecessorRef | undefined> {
  const retained = await loadRetainedEvidence(dependencies, state, state.phase_instance);
  if (!retained.ok) return undefined;
  const editorial = retainedEditorialTriage(retained.value);
  if (editorial === undefined) return undefined;
  const produced = await currentProduceSubject(dependencies, state);
  if (!produced.ok || produced.value.artifact.artifact_kind !== "document") return undefined;
  if (editorial.triage.subject_digest !== produced.value.artifact_digest) return undefined;
  // The pair carries the fingerprint the review evidence is bound to — the review cycle's, from
  // the triage — not the produce artifact's own produce-time fingerprint (the two differ: the
  // rubric joins the fingerprint subject at counter-review time).
  return Object.freeze({
    subject_digest: produced.value.artifact_digest,
    input_fingerprint: editorial.triage.input_fingerprint,
    triage_result_digest: editorial.triage_result_digest,
  });
}

/**
 * Record-time validation of a declared editorial predecessor. Accepts the artifact only when the
 * declared predecessor is the produce result currently retained in durable authority, the
 * retained triage authorizes exactly this revision (current for the predecessor pair, editorial
 * accepts only, result digest as declared), and the bytes actually changed.
 */
export async function validateEditorialPredecessorDeclaration(
  dependencies: EditorialSubjectDependencies,
  state: TaskStateV1,
  artifact: DocumentArtifactV1,
): Promise<ProjectResult<undefined>> {
  const declared = artifact.editorial_predecessor;
  if (declared === undefined) return ok(undefined);
  const invalid = (issue: string): ProjectResult<undefined> => Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", {
      phase_instance: state.phase_instance,
      issue_code: issue,
    }),
  });
  const produced = await currentProduceSubject(dependencies, state);
  if (
    !produced.ok ||
    produced.value.artifact.artifact_kind !== "document" ||
    produced.value.artifact_digest !== declared.subject_digest
  ) return invalid("editorial-predecessor-not-current-produce");
  const retained = await loadRetainedEvidence(dependencies, state, state.phase_instance);
  if (!retained.ok) return invalid("editorial-authorizing-triage-invalid");
  const editorial = retainedEditorialTriage(retained.value);
  if (
    editorial === undefined ||
    editorial.triage.subject_digest !== declared.subject_digest ||
    editorial.triage.input_fingerprint !== declared.input_fingerprint ||
    editorial.triage_result_digest !== declared.triage_result_digest
  ) return invalid("editorial-authorizing-triage-invalid");
  if (artifact.content_digest === produced.value.artifact.content_digest) {
    return invalid("editorial-revision-unchanged-bytes");
  }
  const companionSet = (document: DocumentArtifactV1): string => JSON.stringify(
    (document.additional_documents ?? []).map((entry) => ({
      document_path: entry.document_path,
      content_digest: entry.content_digest,
      projection_target: entry.projection_target,
    })),
  );
  if (companionSet(artifact) !== companionSet(produced.value.artifact)) {
    return invalid("editorial-revision-companion-changed");
  }
  return ok(undefined);
}

/**
 * Reconstructs the current counter review from canonical durable authority. This is the
 * production path to the branded set consumed by triage: callers provide neither an authority
 * brand for the set nor invented receipt/revision facts for either review.
 */
export async function loadCurrentReviewSet(
  dependencies: CurrentReviewSetDependencies,
  authority: TransactionAuthority,
  phase_instance: PhaseInstanceId,
): Promise<ProjectResult<CurrentReviewSet>> {
  assertInternalTransactionAuthority(authority);
  if (authority.context.phase_instance !== phase_instance) {
    throw new TypeError("current review phase does not match transaction authority");
  }
  const stateRead = await dependencies.read_state(authority.state);
  if (stateRead.kind !== "canonical") {
    throw new TypeError("current review reconstruction requires canonical durable state");
  }
  const stateDocument = canonicalDocument(stateRead.document.value);
  if (
    stateDocument.digest !== stateRead.document.digest ||
    !Buffer.from(stateDocument.bytes).equals(Buffer.from(stateRead.document.bytes)) ||
    stateDocument.value.task_id !== authority.task_id ||
    stateDocument.value.repository_identity_digest !== authority.repository_identity_digest ||
    stateDocument.value.phase_instance !== phase_instance
  ) {
    throw new TypeError("durable state does not match current review authority");
  }
  const semantics = validateDurableSemantics({ state: stateDocument });
  if (!semantics.ok) return semantics;

  const retained = await loadRetainedEvidence(
    { load_retained_manifest: dependencies.load_retained_manifest },
    stateDocument.value,
    phase_instance,
  );
  if (!retained.ok) return retained;
  const derived = deriveCurrentEvidenceSet(retained.value);
  if (
    derived.task_id !== authority.task_id ||
    derived.phase_instance !== phase_instance
  ) {
    throw new TypeError("retained reviews do not form one current review set");
  }
  if (derived.input_fingerprint !== stateDocument.value.input_fingerprint) {
    // After an editorial revision the retained counter review stays bound to the predecessor
    // bytes. It remains the one current review set exactly when the current produce artifact
    // declares that predecessor — one hop, authenticated from retained authority, no chaining.
    const produced = await currentProduceSubject(
      { load_retained_manifest: dependencies.load_retained_manifest },
      stateDocument.value,
    );
    const predecessor = produced.ok && produced.value.artifact.artifact_kind === "document"
      ? produced.value.artifact.editorial_predecessor
      : undefined;
    if (
      predecessor === undefined ||
      derived.subject_digest !== predecessor.subject_digest ||
      derived.input_fingerprint !== predecessor.input_fingerprint
    ) {
      throw new TypeError("retained reviews do not form one current review set");
    }
  }
  const current = Object.freeze({
    ...derived,
  });
  registerCurrentReviewSet(current);
  return ok(current);
}
