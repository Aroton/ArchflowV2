import {
  canonicalDocument,
  canonicalJsonDigest,
  sha256Bytes,
  type GitOid,
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
  adjudicationReviewClaim,
  counterReviewClaim,
  parseTaskPathClaim,
  toRepositoryPathClaim,
  triageReviewClaim,
} from "../contracts/path-claims.js";
import {
  renderAdjudicationEvidence,
  renderReviewEvidence,
  renderTriage,
} from "../contracts/renderers.js";
import type { ReviewEvidence } from "../contracts/review.js";
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
  type TriageCandidate,
} from "../contracts/triage.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import {
  hashGitBlobIdentity,
  type GitRunner,
} from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import {
  resolveTaskPath,
  type ResolvedPath,
  type ResolvedTaskPath,
} from "../repository/paths.js";
import {
  assertInternalTransactionAuthority,
  type TransactionAuthority,
} from "./authority.js";
import { loadCurrentProduceSubject } from "./produce-subject.js";
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
  RetainedResultInstallation,
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
}>;

export type RetainedEvidenceSet = ReadonlyMap<
  PipelineStep,
  Readonly<{
    reference: AuthoritativeResultRef;
    manifest: ResultManifestV1;
  }>
>;

type RetainedEvidenceDependencies = Pick<TransactionDependencies, "load_retained_result">;
type CurrentReviewSetDependencies = Readonly<{
  read_state: TransactionDependencies["read_state"];
  load_retained_result: NonNullable<TransactionDependencies["load_retained_result"]>;
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

function projectionClaim(
  phaseInstance: PhaseInstanceId,
  value: EvidenceResultValue,
): ReturnType<typeof counterReviewClaim> {
  if (value.kind === "triage") return triageReviewClaim(phaseInstance);
  if (value.kind === "adjudication") return adjudicationReviewClaim(phaseInstance);
  return counterReviewClaim(phaseInstance);
}

function qualifyAndRender(value: EvidenceResultValue): Readonly<{
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
    if (verified.evidence.role === "gate-counter-review") {
      throw new TypeError("gate-counter-review evidence requires the gate-owned retention route");
    }
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
  const triage = validateTriage(value.current_reviews, value.evidence);
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

async function resolveEvidenceTarget(
  input: PrepareEvidenceResultInput,
  claim: ReturnType<typeof parseTaskPathClaim>,
  expectedClass: "review" | "result-manifest" | "result-payload",
): Promise<ProjectResult<ResolvedPath>> {
  return resolveTaskPath({
    runner: input.runner,
    taskId: input.authority.task_id,
    claim,
    expectedClass,
    context: input.authority.context,
  });
}

/**
 * Prepares one evidence manifest and canonical review projection. Evidence identity is the
 * canonical payload digest; rendered-byte identity is confined to snapshot/projection fields.
 */
export async function prepareEvidenceResult(
  input: PrepareEvidenceResultInput,
): Promise<ProjectResult<PreparedEvidenceResult>> {
  assertInternalTransactionAuthority(input.authority);
  const qualified = qualifyAndRender(input.value);
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

  const taskClaim = projectionClaim(qualified.phase_instance, input.value);
  const repositoryClaim = toRepositoryPathClaim(input.authority.task_id, taskClaim);
  const projectionTarget = await resolveEvidenceTarget(input, taskClaim, "review");
  if (!projectionTarget.ok) return projectionTarget;

  const renderedDigest = sha256Bytes(qualified.bytes);
  const byteCount = parseSafeInteger(qualified.bytes.byteLength);
  const gitIdentity = await hashGitBlobIdentity(
    input.runner as unknown as GitRunner,
    qualified.bytes,
    repositoryClaim,
  );
  const output = Object.freeze({
    path: repositoryClaim,
    path_class: "review" as const,
    operation: "add" as const,
    storage: "raw-payload" as const,
    payload_bytes: byteCount,
    payload_digest: renderedDigest,
    file_type: "regular" as const,
    after: Object.freeze({
      oid: gitIdentity.oid as GitOid,
      mode: "100644" as const,
      size_bytes: parseSafeInteger(gitIdentity.size_bytes),
    }),
  });
  const projections = Object.freeze([
    Object.freeze({ path: repositoryClaim, content_digest: renderedDigest }),
  ]);
  const snapshotDigest = deriveDeclaredSnapshotDigest([output], projections);

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
    desired: Object.freeze({
      state: "present",
      file_type: "regular",
      mode: "100644",
      bytes: qualified.bytes,
    }),
    authenticated_before: captured.observation,
    ...(captured.observation.state === "present"
      ? { rollback: captured.rollback }
      : {}),
    git_tracked: true,
  });
  const projectionPlan = await prepareProjectionPlan(
    [source],
    capturingScanner,
    input.runner.location.worktreeRoot as ResolvedTaskPath,
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
    outputs: Object.freeze([output]),
    projections,
    accounting: Object.freeze({
      schema_version: "1",
      result_bytes: byteCount,
      task_bytes: parseSafeInteger(input.retained_task_bytes + byteCount),
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: Object.freeze([
        Object.freeze({
          path: repositoryClaim,
          storage: "raw-payload",
          stored_bytes: byteCount,
        }),
      ]),
      measured_at_revision: input.measured_at_revision,
    }),
    secret_scan: secretScan,
  });
  const manifest = canonicalDocument(manifestValue);
  const manifestClaim = parseTaskPathClaim(
    `results/sha256/${manifest.digest}/manifest.json`,
  );
  const payloadClaim = parseTaskPathClaim(
    `results/sha256/${manifest.digest}/payload/${repositoryClaim}`,
  );
  const [manifestTarget, payloadTarget] = await Promise.all([
    resolveEvidenceTarget(input, manifestClaim, "result-manifest"),
    resolveEvidenceTarget(input, payloadClaim, "result-payload"),
  ]);
  if (!manifestTarget.ok) return manifestTarget;
  if (!payloadTarget.ok) return payloadTarget;

  const prepared = prepareSnapshot({
    manifest: manifestValue,
    payloads: Object.freeze([
      Object.freeze({
        path: repositoryClaim,
        bytes: qualified.bytes,
        target: payloadTarget.value,
      }),
    ]),
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
    manifest_path: manifestTarget.value.repositoryRelative,
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
  loaded: RetainedResultInstallation,
): ResultManifestV1 {
  const document = canonicalDocument(parseResultManifest(loaded.prepared.manifest.value));
  if (
    document.digest !== loaded.prepared.manifest.digest ||
    !Buffer.from(document.bytes).equals(Buffer.from(loaded.prepared.manifest.bytes)) ||
    loaded.prepared.result_digest !== document.digest ||
    reference.result_digest !== document.digest ||
    reference.manifest_path !== loaded.manifest_target.repositoryRelative ||
    loaded.manifest_target.path_class !== "result-manifest"
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
  if (dependencies.load_retained_result === undefined) {
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
    const loaded = await dependencies.load_retained_result(reference);
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
    (counter.assurance !== "server-attested" && counter.assurance !== "degraded") ||
    counter.model_family === counter.producer_family
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
    independence: "opposite-family",
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
  dependencies: RetainedEvidenceDependencies,
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
  if (triage.accepted_count !== 0 || (triage.accepted_editorial_count ?? 0) === 0) return undefined;
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
  dependencies: RetainedEvidenceDependencies,
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
  dependencies: RetainedEvidenceDependencies,
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
    { load_retained_result: dependencies.load_retained_result },
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
      { load_retained_result: dependencies.load_retained_result },
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
