import { canonicalDocument, canonicalJsonDigest, type CanonicalDocument } from "./canonical.js";
import { isDeepStrictEqual } from "node:util";
import type { DocumentArtifactV1 } from "./durable-document.js";
import type { ImplementationOutputV1 } from "./durable-implementation-output.js";
import type {
  EvidenceArtifactV1,
  ResultManifestV1,
  TriageArtifactV1,
} from "./durable-result-manifest.js";
import type { LegacyImportInitializationV1 } from "./durable-legacy-import.js";
import type { IntentReceiptV1 } from "./durable-intent.js";
import type { TaskStateV1 } from "./durable-state.js";
import type { TaskInitializationV1 } from "./durable-task-initialization.js";
import type {
  ArchivedGateDecisionRecordV1,
  ArchivedGateRequestV1,
  WaiverGateContext,
} from "./durable-gate.js";
import { createProjectError, type ProjectError, type ProjectResult } from "./errors.js";
import { validateArchivedGateDecision, type GateContext, type GateKind } from "./gates.js";
import type { Sha256Digest } from "./evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";

/**
 * The phase's single cross-document semantic authority.
 *
 * **The subject has durable document slots plus one discriminated intent relation.** There is no
 * decision, approval, waiver, authority-link, or evidence slot, so those reference targets are not
 * resolved here: not `approvals[*].gate_id`, not `open_gate.gate_id`, or `waivers[*].gate_id`.
 * Result manifests are the one resolved retained-result authority added by Phase 11.
 *
 * **No template-based path classification (D4).** The class -> template tables live in
 * `src/repository/paths.ts`, which `src/contracts/**` may never import
 * (`test/contracts/repository-boundary.test.ts:28-38`). A cross-class rename is *representable* and
 * is **not** rejected here; rank 5a checks only `previous_path !== path`, and Phase 11 classifies
 * both endpoints. `payload_bytes`, `payload_digest`, and `after.oid` are assertions in this phase
 * and become verified facts in Phase 11; nothing here sees a byte, and `CanonicalDocument.bytes` is
 * never inspected.
 */

export type DurableArtifact =
  | TaskInitializationV1
  | LegacyImportInitializationV1
  | DocumentArtifactV1
  | ImplementationOutputV1
  | TriageArtifactV1;

export type DurableSemanticSubject = {
  readonly state?: CanonicalDocument<TaskStateV1>;
  readonly artifact?: CanonicalDocument<DurableArtifact>;
  readonly result_manifest?: CanonicalDocument<ResultManifestV1>;
  readonly gate_request?: CanonicalDocument<ArchivedGateRequestV1>;
  readonly gate_decision?: CanonicalDocument<ArchivedGateDecisionRecordV1>;
  readonly intent_relation?: DurableIntentRelation;
};

export type DurableIntentRelation =
  | Readonly<{
      mode: "prepared";
      predecessor: CanonicalDocument<TaskStateV1>;
      receipt: CanonicalDocument<IntentReceiptV1>;
    }>
  | Readonly<{
      mode: "committed";
      state: CanonicalDocument<TaskStateV1>;
      receipt: CanonicalDocument<IntentReceiptV1>;
    }>;

export function createPreparedIntentSubject(
  predecessor: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>
): DurableSemanticSubject {
  materialize<TaskStateV1>(predecessor, "prepared intent predecessor document");
  materialize<IntentReceiptV1>(receipt, "prepared intent receipt document");
  return Object.freeze({ intent_relation: Object.freeze({ mode: "prepared", predecessor, receipt }) });
}

export function createCommittedIntentSubject(
  state: CanonicalDocument<TaskStateV1>,
  receipt: CanonicalDocument<IntentReceiptV1>
): DurableSemanticSubject {
  materialize<TaskStateV1>(state, "committed intent state document");
  materialize<IntentReceiptV1>(receipt, "committed intent receipt document");
  return Object.freeze({ intent_relation: Object.freeze({ mode: "committed", state, receipt }) });
}

/** Binds every field frozen by an open gate without introducing a digest cycle through `open_gate`. */
export function openGateFrozenStateDigest(state: TaskStateV1): Sha256Digest {
  const { open_gate: _open, ...shell } = state;
  return canonicalJsonDigest({ schema_version: "1", digest_kind: "open-gate-frozen-state", state: shell });
}

/**
 * Every `issue_code` this module can emit, transcribed from the pinned invariant table. Each is a
 * `SafeCode` (`[a-z0-9][a-z0-9_-]{0,63}`, `evidence.ts:22`). They are named here so the rejection
 * corpus can assert against the same literals the validator constructs rather than a retyped copy.
 * `INPUT_FINGERPRINT_MISMATCH` is deliberately absent: its parameters are exactly the two digests
 * under `.strict()` (`errors.ts:46`), so it carries no `issue_code` at all.
 */
export const DURABLE_ISSUE_CODES = Object.freeze({
  /** 2 */ statePhaseInstanceUndecodable: "state-phase-instance-undecodable",
  /** 3 */ documentDigestMismatch: "document-digest-mismatch",
  /** 4a */ phaseInstanceUndecodable: "phase-instance-undecodable",
  /** 4b */ implementationOutputPhaseKind: "implementation-output-phase-kind",
  /** 5a */ renamePreviousPathEqualsPath: "rename-previous-path-equals-path",
  /** 5b */ restoreTargetNotDeclared: "restore-target-not-declared",
  /** 6a */ accountingResultBytesSum: "accounting-result-bytes-sum",
  /** 6b */ accountingTaskBytesBelowResult: "accounting-task-bytes-below-result",
  /** 6c */ accountingEntryUnmatched: "accounting-entry-unmatched",
  /** 6d */ accountingOutputUnmatched: "accounting-output-unmatched",
  /** 6e */ accountingStorageMismatch: "accounting-storage-mismatch",
  /** 6f */ accountingStoredBytesMismatch: "accounting-stored-bytes-mismatch",
  /** implementation */ implementationInputIdDuplicate: "implementation-input-id-duplicate",
  /** implementation */ implementationSecondaryPathInvalid: "implementation-secondary-path-invalid",
  /** implementation */ implementationAggregateAccountingInvalid: "implementation-aggregate-accounting-invalid",
  /** 7a */ initializationDigestMismatch: "initialization-digest-mismatch",
  /** 7b */ artifactTaskIdMismatch: "artifact-task-id-mismatch",
  /** 7d */ repositoryIdentityDigestMismatch: "repository-identity-digest-mismatch",
  /** 7e */ configDigestMismatch: "config-digest-mismatch",
  /** 7f */ workflowDigestMismatch: "workflow-digest-mismatch",
  /** 7g */ constitutionDigestMismatch: "constitution-digest-mismatch",
  /** 7h */ policyBaseCommitMismatch: "policy-base-commit-mismatch",
  /** 7i */ baselineAdoptionApprovalMissing: "baseline-adoption-approval-missing",
  /** 3 */ intentReceiptSelfDigestMismatch: "intent-receipt-self-digest-mismatch",
  /** state */ lastTransitionOutcomeDigestMismatch: "last-transition-outcome-digest-mismatch",
  /** state */ lastTransitionRevisionMismatch: "last-transition-revision-mismatch",
  /** state */ repositoryCheckpointMismatch: "repository-checkpoint-mismatch",
  /** 4b */ intentReceiptOutcomeDigestMismatch: "intent-receipt-outcome-digest-mismatch",
  /** 4b */ intentReceiptPreparedStateDigestMismatch: "intent-receipt-prepared-state-digest-mismatch",
  /** 4b */ intentReceiptRevisionNotSuccessor: "intent-receipt-revision-not-successor",
  /** 8a */ intentReceiptFutureRevision: "intent-receipt-future-revision",
  /** 4b */ intentReceiptPreparedStateRevisionMismatch: "intent-receipt-prepared-state-revision-mismatch",
  /** 4b */ intentReceiptPreparedStateLastTransitionPresent: "intent-receipt-prepared-state-last-transition-present",
  /** 8a */ intentReceiptTaskMismatch: "intent-receipt-task-mismatch",
  /** 8a */ intentReceiptRepositoryMismatch: "intent-receipt-repository-mismatch",
  /** 8a */ intentReceiptInitializationMismatch: "intent-receipt-initialization-mismatch",
  /** 8a */ intentReceiptConfigMismatch: "intent-receipt-config-mismatch",
  /** 8a */ intentReceiptWorkflowMismatch: "intent-receipt-workflow-mismatch",
  /** 8a */ intentReceiptConstitutionMismatch: "intent-receipt-constitution-mismatch",
  /** 8a */ intentReceiptPolicyBaseMismatch: "intent-receipt-policy-base-mismatch",
  /** 8b */ intentReceiptIntentMismatch: "intent-receipt-intent-mismatch",
  /** 8b */ intentReceiptRequestMismatch: "intent-receipt-request-mismatch",
  /** 8a */ intentReceiptInputFingerprintMismatch: "intent-receipt-input-fingerprint-mismatch",
  /** 8b */ intentReceiptReferenceOutcomeMismatch: "intent-receipt-reference-outcome-mismatch",
  /** 8b */ intentReceiptReferenceRevisionMismatch: "intent-receipt-reference-revision-mismatch",
  /** 8b */ intentReceiptReferenceResultMismatch: "intent-receipt-reference-result-mismatch",
  /** 8b */ intentReceiptFinalStateMismatch: "intent-receipt-final-state-mismatch",
  /** result */ resultManifestArtifactDigestMismatch: "result-manifest-artifact-digest-mismatch",
  /** result */ resultManifestTaskMismatch: "result-manifest-task-mismatch",
  /** result */ resultManifestPhaseMismatch: "result-manifest-phase-mismatch",
  /** result */ resultManifestStepMismatch: "result-manifest-step-mismatch",
  /** result */ resultManifestInputFingerprintMismatch: "result-manifest-input-fingerprint-mismatch",
  /** result */ resultManifestSnapshotMismatch: "result-manifest-snapshot-mismatch",
  /** result */ resultManifestOutputsMismatch: "result-manifest-outputs-mismatch",
  /** result */ resultManifestProjectionsMismatch: "result-manifest-projections-mismatch",
  /** result */ resultManifestAccountingMismatch: "result-manifest-accounting-mismatch",
  /** result */ resultManifestSecretScanMismatch: "result-manifest-secret-scan-mismatch",
  /** gate */ gateDecisionGateIdMismatch: "gate-decision-gate-id-mismatch",
  /** gate */ gateDecisionTaskMismatch: "gate-decision-task-mismatch",
  /** gate */ gateDecisionPhaseMismatch: "gate-decision-phase-mismatch",
  /** gate */ gateDecisionKindMismatch: "gate-decision-kind-mismatch",
  /** gate */ gateDecisionSubjectMismatch: "gate-decision-subject-mismatch",
  /** gate */ gateDecisionContextMismatch: "gate-decision-context-mismatch",
  /** gate */ gateDecisionEnvelopeMismatch: "gate-decision-envelope-mismatch",
  /** gate */ gateDecisionPayloadInvalid: "gate-decision-payload-invalid",
  /** gate */ waiverDecisionOriginMismatch: "waiver-decision-origin-mismatch",
  /** gate */ openGateFrozenStateMismatch: "open-gate-frozen-state-mismatch",
} as const);

type IssueCode = (typeof DURABLE_ISSUE_CODES)[keyof typeof DURABLE_ISSUE_CODES];

const OK: ProjectResult<void> = Object.freeze({ schema_version: "1", ok: true, value: undefined });
const fail = (error: ProjectError): ProjectResult<void> => ({ schema_version: "1", ok: false, error });

/* ------------------------------------------------------------------ input discipline (rank 1) */

/**
 * The shipped own-data-descriptor idiom (`hasUniqueObjectPropertyValues` in `validators.ts`),
 * reused rather than reinvented. A
 * getter-backed slot or shell field is a defect in the *calling server code*, not agent-supplied
 * data, so the repository convention is a throw. Reading alone does not reject a getter — the
 * descriptor check is what does.
 *
 * `enumerable` is required as well as `value`, matching `assertPlainJson`, which already rejects a
 * non-enumerable property inside a value as "not a JSON value" (`plain-json.ts:85`). Without it the
 * shell check would be weaker than the check applied to the shell's own contents, and a
 * non-enumerable `value` or `digest` — invisible to `canonicalJsonBytes`, which serializes only
 * enumerable properties — would pass. `canonicalDocument` builds its result from an object literal
 * (`canonical.ts:104`), so every document from the sanctioned constructor satisfies this.
 */
function ownDataSlot(subject: DurableSemanticSubject, slot: keyof DurableSemanticSubject): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(subject, slot);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`durable semantic subject: ${slot} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function ownDataField(document: unknown, field: "value" | "digest", label: string): unknown {
  const descriptor =
    document === null || (typeof document !== "object" && typeof document !== "function")
      ? undefined
      : Object.getOwnPropertyDescriptor(document, field);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${label}: ${field} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function ownEnumerableDataField(document: unknown, field: string, label: string): unknown {
  const descriptor =
    document === null || (typeof document !== "object" && typeof document !== "function")
      ? undefined
      : Object.getOwnPropertyDescriptor(document, field);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${label}: ${field} must be an own enumerable data property`);
  }
  return descriptor.value;
}

type Materialized<T> = { readonly value: T; readonly digest: unknown };

/**
 * Validate and materialize a caller-owned object **once** before inspecting it more than once, per
 * `CLAUDE.md`: `assertPlainJson` then `structuredClone`, and validate only the clone. An enumerable
 * getter can otherwise return one value to a validation pass and a different value to a hashing
 * pass. `assertPlainJson` guards the *inside* of a value and can never be applied to a whole
 * `CanonicalDocument`, because `bytes` is a `Uint8Array` (`canonical.ts:99`).
 *
 * The caller's `digest` is carried but is never authority: a `CanonicalDocument` can be built as an
 * object literal rather than through `parseCanonicalDocument`, so every digest this module compares
 * is re-derived with `canonicalJsonDigest`.
 */
function materialize<T extends PlainJsonValue>(document: unknown, label: string): Materialized<T> {
  const value = ownDataField(document, "value", label);
  const digest = ownDataField(document, "digest", label);
  assertPlainJson(value, `${label} value`);
  return { value: structuredClone(value) as T, digest };
}

/* ------------------------------------------------------------------- reporting code by subject */

function stateInvalid(state: TaskStateV1, issue_code: IssueCode): ProjectError {
  return createProjectError("STATE_INVALID", { phase_instance: state.phase_instance, issue_code });
}

function artifactInvalid(artifact: DurableArtifact, issue_code: IssueCode): ProjectError {
  return artifact.artifact_kind === "implementation-output"
    ? createProjectError("SNAPSHOT_INVALID", { snapshot_digest: artifact.snapshot_digest, issue_code })
    : createProjectError("TASK_INVALID", {
        task_id: artifact.artifact_kind === "triage" ? artifact.evidence.task_id : artifact.task_id,
        issue_code,
      });
}

function receiptInvalid(receipt: IntentReceiptV1, issue_code: IssueCode): ProjectError {
  return createProjectError("TASK_INVALID", { task_id: receipt.task_id, issue_code });
}

function resultManifestInvalid(manifest: ResultManifestV1, issue_code: IssueCode): ProjectError {
  return createProjectError("SNAPSHOT_INVALID", { snapshot_digest: manifest.snapshot_digest, issue_code });
}

function contractInvalid(issue_code: IssueCode): ProjectError {
  return createProjectError("CONTRACT_INVALID", { issue_code });
}

/* ---------------------------------------------------------------------------- small predicates */

function decodable(value: PhaseInstanceId): boolean {
  try {
    decodePhaseInstance(value);
    return true;
  } catch {
    return false;
  }
}

/** A checkpoint is continuity evidence only when it exactly mirrors the last-seen membership. */
function repositoryCheckpointCorresponds(state: TaskStateV1): boolean {
  const repositories = state.last_seen_config?.repositories;
  const secondaryNames = repositories === undefined ? [] : Object.keys(repositories).sort();
  const checkpoint = state.last_seen_repository_bindings;

  if (checkpoint === undefined) return secondaryNames.length === 0;
  if (state.last_seen_config === undefined || checkpoint.length !== secondaryNames.length + 1) return false;

  const primary = checkpoint[0];
  if (primary === undefined || primary.name !== "primary" || primary.declared_path !== undefined) return false;
  return secondaryNames.every((name, index) => {
    const binding = checkpoint[index + 1];
    return binding?.name === name && binding.declared_path === repositories?.[name]?.path;
  });
}

type InitializationArtifact = TaskInitializationV1 | LegacyImportInitializationV1;

function isInitialization(artifact: DurableArtifact): artifact is InitializationArtifact {
  return artifact.artifact_kind === "task-initialization" || artifact.artifact_kind === "legacy-import-initialization";
}

/** The two kinds carrying a `step`, and therefore the only ones rank 8's guard can admit (D19). */
type SteppedArtifact = DocumentArtifactV1 | ImplementationOutputV1;

function isStepped(artifact: DurableArtifact): artifact is SteppedArtifact {
  return artifact.artifact_kind === "document" || artifact.artifact_kind === "implementation-output";
}

function durableArtifactTaskId(artifact: DurableArtifact): TaskInitializationV1["task_id"] {
  return artifact.artifact_kind === "triage" ? artifact.evidence.task_id : artifact.task_id;
}

function durableSteppedPayload(
  artifact: DurableArtifact,
): DocumentArtifactV1 | ImplementationOutputV1 | TriageArtifactV1["evidence"] | undefined {
  return artifact.artifact_kind === "triage"
    ? artifact.evidence
    : isStepped(artifact)
      ? artifact
      : undefined;
}

function isEvidenceArtifact(
  artifact: ResultManifestV1["source_artifact"],
): artifact is EvidenceArtifactV1 {
  return artifact.artifact_kind === "review-evidence" ||
    artifact.artifact_kind === "triage" ||
    artifact.artifact_kind === "adjudication-evidence";
}

/* ------------------------------------------------------------------------------- the validator */

/**
 * **Two exits, and only two.** Semantic disagreement *returns* `ProjectResult{ok:false}` carrying
 * one of the five pinned existing error codes; an input-discipline violation *throws* a `TypeError`.
 * Structural failure never arrives: unknown fields, missing required properties, closed-enum
 * violations, and pattern failures are rejected by the normative JSON Schema or the Zod mirror at
 * the caller's parse boundary. **Precondition: the caller has already validated the subject against
 * its normative JSON Schema.** No structure is re-checked here, with exactly two deliberate
 * residues — ranks 2 and 4 — which exist because the `phaseInstanceId` JSON `pattern` is weaker
 * than the decoder that is the real authority (D6).
 *
 * `ProjectResult` carries exactly one error, so the evaluation order below is normative: the
 * reported error is the minimum under *(rank, sub-rank, slot, collection path, index)* compared
 * lexicographically, and the clauses are written in exactly that order so the first failure found
 * is that minimum. Slot is `state` = 0, `artifact` = 1; collection path is the
 * walked collection's dotted property path, `""` for a root clause, which sorts below every
 * property name; index is the ascending array index, `0` for a root clause.
 */
export function validateDurableSemantics(subject: DurableSemanticSubject): ProjectResult<void> {
  /* Rank 1 — input discipline, before any slot and before any `.value` or `.digest` is read. */
  const stateDocument = ownDataSlot(subject, "state");
  const artifactDocument = ownDataSlot(subject, "artifact");
  const resultManifestDocument = ownDataSlot(subject, "result_manifest");
  const gateRequestDocument = ownDataSlot(subject, "gate_request");
  const gateDecisionDocument = ownDataSlot(subject, "gate_decision");
  const relationValue = ownDataSlot(subject, "intent_relation");

  const stateSlot =
    stateDocument === undefined ? undefined : materialize<TaskStateV1>(stateDocument, "durable state document");
  const artifactSlot =
    artifactDocument === undefined
      ? undefined
      : materialize<DurableArtifact>(artifactDocument, "durable artifact document");
  const resultManifestSlot =
    resultManifestDocument === undefined
      ? undefined
      : materialize<ResultManifestV1>(resultManifestDocument, "durable result manifest document");
  const gateRequestSlot = gateRequestDocument === undefined ? undefined : materialize<ArchivedGateRequestV1>(gateRequestDocument, "durable gate request document");
  const gateDecisionSlot = gateDecisionDocument === undefined ? undefined : materialize<ArchivedGateDecisionRecordV1>(gateDecisionDocument, "durable gate decision document");

  let relation: { readonly mode: "prepared" | "committed"; readonly state: Materialized<TaskStateV1>; readonly receipt: Materialized<IntentReceiptV1> } | undefined;
  if (relationValue !== undefined) {
    const mode = ownEnumerableDataField(relationValue, "mode", "durable intent relation");
    if (mode !== "prepared" && mode !== "committed") throw new TypeError("durable intent relation: invalid mode");
    const expectedKeys = mode === "prepared" ? ["mode", "predecessor", "receipt"] : ["mode", "state", "receipt"];
    if (!isDeepStrictEqual(Object.keys(relationValue as object).sort(), [...expectedKeys].sort())) {
      throw new TypeError("durable intent relation: unexpected or missing slots");
    }
    const stateDocumentForRelation = ownEnumerableDataField(
      relationValue,
      mode === "prepared" ? "predecessor" : "state",
      "durable intent relation"
    );
    const receiptDocument = ownEnumerableDataField(relationValue, "receipt", "durable intent relation");
    relation = {
      mode,
      state: materialize<TaskStateV1>(stateDocumentForRelation, `${mode} intent state document`),
      receipt: materialize<IntentReceiptV1>(receiptDocument, `${mode} intent receipt document`),
    };
  }

  const state = stateSlot?.value;
  const artifact = artifactSlot?.value;
  const resultManifest = resultManifestSlot?.value;
  const gateRequest = gateRequestSlot?.value;
  const gateDecision = gateDecisionSlot?.value;
  const intentState = relation?.state.value;
  const receipt = relation?.receipt.value;

  /*
   * Rank 2 — carriability, and it must precede every rank that may report under `STATE_INVALID`.
   * That code's `phase_instance` parameter runs `decodePhaseInstance` under `.strict()`, and the
   * JSON `pattern` admits `phase-impl-99999999999999999999`, which the decoder rejects. Ranks 3 and
   * 5-9 may all report `STATE_INVALID`, so an undecodable `state.phase_instance` is *established*
   * here and no later rank runs — otherwise `createProjectError` would throw a `ZodError` exactly
   * where the contract requires a return. Routing rank 4 to `CONTRACT_INVALID` does not protect
   * rank 3, which is why an earlier ordering was wrong.
   */
  if (state !== undefined && !decodable(state.phase_instance)) {
    return fail(contractInvalid(DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable));
  }
  if (intentState !== undefined && !decodable(intentState.phase_instance)) {
    return fail(contractInvalid(DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable));
  }
  if (resultManifest !== undefined && !decodable(resultManifest.phase_instance)) {
    return fail(contractInvalid(DURABLE_ISSUE_CODES.phaseInstanceUndecodable));
  }

  /* Rank 3 — self-digest agreement, per supplied document, in slot order. */
  if (state !== undefined && canonicalJsonDigest(state) !== stateSlot?.digest) {
    return fail(stateInvalid(state, DURABLE_ISSUE_CODES.documentDigestMismatch));
  }
  if (artifact !== undefined && canonicalJsonDigest(artifact) !== artifactSlot?.digest) {
    return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.documentDigestMismatch));
  }
  if (resultManifest !== undefined && canonicalJsonDigest(resultManifest) !== resultManifestSlot?.digest) {
    return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.documentDigestMismatch));
  }
  if (gateRequest !== undefined && canonicalJsonDigest(gateRequest) !== gateRequestSlot?.digest) {
    return fail(contractInvalid(DURABLE_ISSUE_CODES.documentDigestMismatch));
  }
  if (gateDecision !== undefined && canonicalJsonDigest(gateDecision) !== gateDecisionSlot?.digest) {
    return fail(contractInvalid(DURABLE_ISSUE_CODES.documentDigestMismatch));
  }
  if (state?.open_gate !== undefined && openGateFrozenStateDigest(state) !== state.open_gate.frozen_state_digest) {
    return fail(stateInvalid(state, DURABLE_ISSUE_CODES.openGateFrozenStateMismatch));
  }
  if (
    state?.last_transition !== undefined &&
    canonicalJsonDigest(state.last_transition.outcome) !== state.last_transition.outcome_digest
  ) {
    return fail(stateInvalid(state, DURABLE_ISSUE_CODES.lastTransitionOutcomeDigestMismatch));
  }
  if (
    state?.last_transition !== undefined &&
    (
      state.last_transition.resulting_revision !== state.revision ||
      state.last_transition.prior_revision === Number.MAX_SAFE_INTEGER ||
      state.last_transition.resulting_revision !== state.last_transition.prior_revision + 1
    )
  ) {
    return fail(stateInvalid(state, DURABLE_ISSUE_CODES.lastTransitionRevisionMismatch));
  }
  if (state !== undefined && !repositoryCheckpointCorresponds(state)) {
    return fail(stateInvalid(state, DURABLE_ISSUE_CODES.repositoryCheckpointMismatch));
  }
  if (intentState !== undefined && !repositoryCheckpointCorresponds(intentState)) {
    return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.repositoryCheckpointMismatch));
  }
  if (receipt !== undefined && canonicalJsonDigest(receipt) !== relation?.receipt.digest) {
    return fail(receiptInvalid(receipt, DURABLE_ISSUE_CODES.intentReceiptSelfDigestMismatch));
  }

  if (gateRequest !== undefined && gateDecision !== undefined) {
    if (gateDecision.gate_id !== gateRequest.gate_id) return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionGateIdMismatch));
    if (gateDecision.task_id !== gateRequest.task_id) return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionTaskMismatch));
    if (gateDecision.phase_instance !== gateRequest.phase_instance) return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionPhaseMismatch));
    if (gateDecision.kind !== gateRequest.kind) return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionKindMismatch));
    if (gateDecision.subject_digest !== gateRequest.subject_digest) return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionSubjectMismatch));
    if (gateDecision.context_digest !== gateRequest.context_digest) return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionContextMismatch));

    if (gateDecision.outcome === "decided") {
      const envelope = gateDecision.envelope;
      if (envelope.gate_id !== gateRequest.gate_id || envelope.task_id !== gateRequest.task_id || envelope.phase_instance !== gateRequest.phase_instance || envelope.kind !== gateRequest.kind || envelope.subject_digest !== gateRequest.subject_digest || envelope.context_digest !== gateRequest.context_digest) {
        return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionEnvelopeMismatch));
      }
      if ("origin" in gateRequest.context) return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionPayloadInvalid));
      try {
        // The request slot is by definition archive-read, so a context shape retired by a later
        // schema change must still validate here; only writers are held to the current shape.
        validateArchivedGateDecision(gateRequest.kind, gateRequest.context as GateContext<GateKind>, envelope.payload);
      } catch {
        return fail(contractInvalid(DURABLE_ISSUE_CODES.gateDecisionPayloadInvalid));
      }
    } else if (gateDecision.outcome === "waiver-decided") {
      const waiverContext = gateRequest.context as WaiverGateContext;
      if (!("origin" in waiverContext) || !isDeepStrictEqual(gateDecision.origin, waiverContext.origin) || !isDeepStrictEqual(gateDecision.scope, waiverContext.origin.scope) || gateDecision.kind !== "constitution-review") {
        return fail(contractInvalid(DURABLE_ISSUE_CODES.waiverDecisionOriginMismatch));
      }
    }
  }

  /*
   * Rank 4a — the residue: every `phase_instance` rank 2 did not cover. It reports
   * `CONTRACT_INVALID` in every slot uniformly, because a phase-instance value is the one thing
   * this error family cannot carry. Slot order state -> artifact; within the artifact slot the
   * root clause (collection path `""`) precedes `mapping`.
   */
  if (state !== undefined) {
    for (const result of state.authoritative_results) {
      if (!decodable(result.phase_instance)) {
        return fail(contractInvalid(DURABLE_ISSUE_CODES.phaseInstanceUndecodable));
      }
    }
  }
  if (artifact !== undefined) {
    const stepped = durableSteppedPayload(artifact);
    if (stepped !== undefined && !decodable(stepped.phase_instance as PhaseInstanceId)) {
      return fail(contractInvalid(DURABLE_ISSUE_CODES.phaseInstanceUndecodable));
    }
    if (artifact.artifact_kind === "legacy-import-initialization") {
      for (const entry of artifact.mapping) {
        if (!decodable(entry.phase_instance)) {
          return fail(contractInvalid(DURABLE_ISSUE_CODES.phaseInstanceUndecodable));
        }
      }
    }
  }

  /* Rank 4b — an implementation output is produced by an implementation phase and nothing else. */
  if (artifact !== undefined && artifact.artifact_kind === "implementation-output") {
    if (decodePhaseInstance(artifact.phase_instance).kind !== "phase-impl") {
      return fail(contractInvalid(DURABLE_ISSUE_CODES.implementationOutputPhaseKind));
    }
  }

  if (resultManifest !== undefined) {
    const source = resultManifest.source_artifact;
    if (!isEvidenceArtifact(source)) {
      const sourceSemantics = validateDurableSemantics({ artifact: canonicalDocument(source) });
      if (!sourceSemantics.ok) return sourceSemantics;
    }
    const correlatedSource = isEvidenceArtifact(source) ? source.evidence : source;
    if (resultManifest.artifact_digest !== canonicalJsonDigest(correlatedSource)) {
      return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestArtifactDigestMismatch));
    }
    if (resultManifest.task_id !== correlatedSource.task_id) {
      return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestTaskMismatch));
    }
    if (resultManifest.phase_instance !== correlatedSource.phase_instance) {
      return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestPhaseMismatch));
    }
    if (resultManifest.step !== correlatedSource.step) {
      return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestStepMismatch));
    }
    if (resultManifest.input_fingerprint !== correlatedSource.input_fingerprint) {
      return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestInputFingerprintMismatch));
    }
    if (!isEvidenceArtifact(source) && resultManifest.snapshot_digest !== source.snapshot_digest) {
      return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestSnapshotMismatch));
    }

    if (source.artifact_kind === "implementation-output") {
      if (!isDeepStrictEqual(resultManifest.outputs, source.outputs)) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestOutputsMismatch));
      }
      if (!isDeepStrictEqual(resultManifest.accounting, source.accounting)) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestAccountingMismatch));
      }
      if (!isDeepStrictEqual(resultManifest.secret_scan, source.secret_scan)) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestSecretScanMismatch));
      }
      if (resultManifest.projections.some((projection) => projection.repository !== undefined)) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
      }
      const expectedProjectionPaths = source.outputs
        .filter((output) => output.operation !== "delete")
        .map((output) => output.path);
      if (!isDeepStrictEqual(resultManifest.projections.map((projection) => projection.path), expectedProjectionPaths)) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
      }
      for (const [index, output] of source.outputs.filter((entry) => entry.operation !== "delete").entries()) {
        if (
          output.storage === "raw-payload" &&
          resultManifest.projections[index]?.content_digest !== output.payload_digest
        ) {
          return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
        }
      }
      const changedSecondaries = (source.secondary_repositories ?? []).filter((section) => section.outputs.length > 0);
      const secondaryProjections = resultManifest.secondary_projections ?? [];
      if (
        changedSecondaries.length !== secondaryProjections.length ||
        changedSecondaries.some((section, index) => {
          const wrapper = secondaryProjections[index];
          if (
            wrapper === undefined || wrapper.repository !== section.repository ||
            wrapper.repository_identity_digest !== section.repository_identity_digest
          ) return true;
          const expectedOutputs = section.outputs.filter((output) => output.operation !== "delete");
          if (wrapper.projections.length !== expectedOutputs.length) return true;
          return expectedOutputs.some((output, outputIndex) => {
            const projection = wrapper.projections[outputIndex];
            return projection === undefined || projection.repository !== section.repository || projection.path !== output.path ||
              (output.storage === "raw-payload" && projection.content_digest !== output.payload_digest);
          });
        })
      ) return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
    } else if (source.artifact_kind === "document") {
      if (resultManifest.secondary_projections !== undefined) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
      }
      const declaredDocuments = [{
        projection_target: source.projection_target,
        byte_count: source.byte_count,
        content_digest: source.content_digest,
      }, ...(source.additional_documents ?? [])]
        .sort((left, right) => left.projection_target < right.projection_target ? -1 : left.projection_target > right.projection_target ? 1 : 0);
      const outputsMatch = resultManifest.outputs.length === declaredDocuments.length &&
        resultManifest.outputs.every((output, index) => {
          const document = declaredDocuments[index];
          return document !== undefined &&
            output.operation === "add" &&
            output.storage === "raw-payload" &&
            output.file_type === "regular" &&
            output.path === document.projection_target &&
            output.path_class === "document" &&
            output.payload_bytes === document.byte_count &&
            output.payload_digest === document.content_digest &&
            output.after.mode === "100644";
        });
      if (!outputsMatch) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestOutputsMismatch));
      }
      const projectionsMatch = resultManifest.projections.length === declaredDocuments.length &&
        resultManifest.projections.every((projection, index) => {
          const document = declaredDocuments[index];
          return document !== undefined && projection.path === document.projection_target &&
            projection.content_digest === document.content_digest;
        });
      if (!projectionsMatch) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
      }
    } else {
      // Review, triage, and adjudication evidence is embedded in the manifest. Any human-facing
      // Markdown is a reconstructible workspace projection and therefore is not a durable output.
      if (resultManifest.outputs.length !== 0) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestOutputsMismatch));
      }
      if (resultManifest.projections.length !== 0) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
      }
      if (resultManifest.secondary_projections !== undefined) {
        return fail(resultManifestInvalid(resultManifest, DURABLE_ISSUE_CODES.resultManifestProjectionsMismatch));
      }
    }
  }

  /* Rank 4b — receipt-local relations, before every cross-document comparison. */
  if (receipt !== undefined) {
    if (canonicalJsonDigest(receipt.outcome) !== receipt.outcome_digest) {
      return fail(receiptInvalid(receipt, DURABLE_ISSUE_CODES.intentReceiptOutcomeDigestMismatch));
    }
    if (canonicalJsonDigest(receipt.prepared_state) !== receipt.prepared_state_digest) {
      return fail(receiptInvalid(receipt, DURABLE_ISSUE_CODES.intentReceiptPreparedStateDigestMismatch));
    }
    if (receipt.prior_revision === Number.MAX_SAFE_INTEGER || receipt.resulting_revision !== receipt.prior_revision + 1) {
      return fail(receiptInvalid(receipt, DURABLE_ISSUE_CODES.intentReceiptRevisionNotSuccessor));
    }
    if (receipt.prepared_state.revision !== receipt.resulting_revision) {
      return fail(receiptInvalid(receipt, DURABLE_ISSUE_CODES.intentReceiptPreparedStateRevisionMismatch));
    }
    if (receipt.prepared_state.last_transition !== undefined) {
      return fail(receiptInvalid(receipt, DURABLE_ISSUE_CODES.intentReceiptPreparedStateLastTransitionPresent));
    }
  }

  if (artifact !== undefined && artifact.artifact_kind === "implementation-output") {
    const sections = [
      { outputs: artifact.outputs, restore_targets: artifact.restore_targets, accounting: artifact.accounting },
      ...(artifact.secondary_repositories ?? []),
    ];
    const inputIds = new Set<string>();
    for (const input of artifact.declared_inputs) {
      if (inputIds.has(input.input_id)) return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.implementationInputIdDuplicate));
      inputIds.add(input.input_id);
    }
    for (const section of artifact.secondary_repositories ?? []) {
      for (const input of section.declared_inputs) {
        if (inputIds.has(input.input_id)) return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.implementationInputIdDuplicate));
        inputIds.add(input.input_id);
      }
      const secondaryPaths = [
        ...section.outputs.flatMap((output) => output.operation === "rename" ? [output.path, output.previous_path] : [output.path]),
        ...section.restore_targets,
        ...section.declared_inputs.map((input) => input.path),
      ];
      if (
        section.outputs.some((output) => output.path_class !== "repository-source") ||
        secondaryPaths.some((path) => path === ".archflow" || path.startsWith(".archflow/"))
      ) return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.implementationSecondaryPathInvalid));
    }

    /*
     * Rank 5a — the one rename clause this phase can evaluate. Verifying that the two endpoints
     * belong to the same path class needs the template tables and is Phase 11's (D4).
     */
    for (const section of sections) {
      for (const output of section.outputs) {
        if (output.operation === "rename" && output.previous_path === output.path) {
          return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.renamePreviousPathEqualsPath));
        }
      }

      /* Rank 5b — a restore target must be one of the outputs its section declares. */
      const declaredPaths = new Set<string>(section.outputs.map((output) => output.path));
      for (const target of section.restore_targets) {
        if (!declaredPaths.has(target)) {
          return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.restoreTargetNotDeclared));
        }
      }
    }

    /*
     * Rank 6 — the accounting correspondence, ordered by dependency: 6e and 6f presuppose the
     * pairing 6c and 6d establish. The `git-object => stored_bytes === 0` half is **not** here:
     * D16 made it structural, a discriminated union on `storage` in chunk 4's schema.
     */
    const accounting = artifact.accounting;
    let storedTotal = 0;
    for (const entry of accounting.counted_entries) storedTotal += entry.stored_bytes;
    if (accounting.result_bytes !== storedTotal) {
      return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingResultBytesSum));
    }
    if (accounting.task_bytes < accounting.result_bytes) {
      return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingTaskBytesBelowResult));
    }
    const aggregateResultBytes = sections.reduce((sum, section) => sum + section.accounting.result_bytes, 0);
    if (aggregateResultBytes > accounting.result_byte_cap || accounting.task_bytes < aggregateResultBytes) {
      return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.implementationAggregateAccountingInvalid));
    }

    const outputsByPath = new Map<string, (typeof artifact.outputs)[number][]>();
    for (const output of artifact.outputs) {
      const bucket = outputsByPath.get(output.path);
      if (bucket === undefined) outputsByPath.set(output.path, [output]);
      else bucket.push(output);
    }
    const entriesByPath = new Map<string, (typeof accounting.counted_entries)[number][]>();
    for (const entry of accounting.counted_entries) {
      const bucket = entriesByPath.get(entry.path);
      if (bucket === undefined) entriesByPath.set(entry.path, [entry]);
      else bucket.push(entry);
    }

    for (const entry of accounting.counted_entries) {
      if (outputsByPath.get(entry.path)?.length !== 1) {
        return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingEntryUnmatched));
      }
    }
    for (const output of artifact.outputs) {
      if (entriesByPath.get(output.path)?.length !== 1) {
        return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingOutputUnmatched));
      }
    }
    for (const entry of accounting.counted_entries) {
      const output = outputsByPath.get(entry.path)![0]!;
      if (output.storage !== entry.storage) {
        return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingStorageMismatch));
      }
    }
    for (const entry of accounting.counted_entries) {
      const output = outputsByPath.get(entry.path)![0]!;
      if (entry.storage === "raw-payload" && output.storage === "raw-payload") {
        if (entry.stored_bytes !== output.payload_bytes) {
          return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingStoredBytesMismatch));
        }
      }
    }
    for (const section of artifact.secondary_repositories ?? []) {
      const localTotal = section.accounting.counted_entries.reduce((sum, entry) => sum + entry.stored_bytes, 0);
      if (section.accounting.result_bytes !== localTotal) {
        return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingResultBytesSum));
      }
      const outputByPath = new Map(section.outputs.map((output) => [output.path, output] as const));
      const entryByPath = new Map(section.accounting.counted_entries.map((entry) => [entry.path, entry] as const));
      if (
        section.accounting.counted_entries.some((entry) => !outputByPath.has(entry.path)) ||
        section.outputs.some((output) => !entryByPath.has(output.path))
      ) return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingEntryUnmatched));
      for (const entry of section.accounting.counted_entries) {
        const output = outputByPath.get(entry.path)!;
        if (output.storage !== entry.storage) return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingStorageMismatch));
        if (entry.storage === "raw-payload" && output.storage === "raw-payload" && entry.stored_bytes !== output.payload_bytes) {
          return fail(artifactInvalid(artifact, DURABLE_ISSUE_CODES.accountingStoredBytesMismatch));
        }
      }
    }
  }

  /*
   * Rank 7 — state <-> artifact agreement. A clause spanning two slots
   * reports against the slot its rank is named for, so every clause here reports against `state`.
   * 7d-7h presuppose 7a: comparing pinned inputs against a document the state does not actually
   * adopt would report a mismatch that is not one.
   */
  if (state !== undefined) {
    const initialization = artifact !== undefined && isInitialization(artifact) ? artifact : undefined;

    if (initialization !== undefined && state.initialization_digest !== canonicalJsonDigest(initialization)) {
      return fail(stateInvalid(state, DURABLE_ISSUE_CODES.initializationDigestMismatch));
    }
    if (artifact !== undefined && state.task_id !== durableArtifactTaskId(artifact)) {
      return fail(stateInvalid(state, DURABLE_ISSUE_CODES.artifactTaskIdMismatch));
    }
    if (initialization !== undefined) {
      /*
       * The five duplicated pinned-input fields. The duplication stays because `archflow-status`
       * reads `state.json` alone, without loading the initialization document (REQ-14, REQ-21);
       * what keeps the two authorities from disagreeing is this comparison, one field at a time.
       */
      if (state.repository_identity_digest !== initialization.repository_identity_digest) {
        return fail(stateInvalid(state, DURABLE_ISSUE_CODES.repositoryIdentityDigestMismatch));
      }
      if (state.config_digest !== initialization.config_digest) {
        return fail(stateInvalid(state, DURABLE_ISSUE_CODES.configDigestMismatch));
      }
      if (state.workflow_digest !== initialization.workflow_digest) {
        return fail(stateInvalid(state, DURABLE_ISSUE_CODES.workflowDigestMismatch));
      }
      if (state.constitution_digest !== initialization.constitution_digest) {
        return fail(stateInvalid(state, DURABLE_ISSUE_CODES.constitutionDigestMismatch));
      }
      if (state.policy_base_commit !== initialization.policy_base_commit) {
        return fail(stateInvalid(state, DURABLE_ISSUE_CODES.policyBaseCommitMismatch));
      }
    }

    /*
     * Rank 7i — a baseline adoption is human authority and must cite the archived decision that
     * granted it. The approval and the adoption record are appended in the same revision advance,
     * so an adoption whose gate never decided `adopt-current-bytes` can only be a fabrication.
     */
    if (state.baseline_adoptions?.some((adoption) =>
      !state.approvals.some((approval) => approval.gate_id === adoption.gate_id && approval.gate_kind === "baseline-adoption"),
    )) {
      return fail(stateInvalid(state, DURABLE_ISSUE_CODES.baselineAdoptionApprovalMissing));
    }

    /*
     * Rank 8 — the in-flight fingerprint. **The guard is a correctness condition, not an
     * optimization**: `state.input_fingerprint` is the *in-flight* step's (D13), so comparing a
     * completed artifact from a different `(phase_instance, step)` would be wrong. Orientation is
     * pinned — `expected_digest` is the state of truth, `observed_digest` is what the artifact
     * claims; the reverse would invert every diagnostic this phase emits. The code names the
     * invariant, so there is no `issue_code`: `errors.ts:46` is `.strict()` over exactly the two
     * digests and `createProjectError` throws if given one. Phase 9 owns the half this guard
     * cannot supply (D19).
     */
    const stepped = artifact === undefined ? undefined : durableSteppedPayload(artifact);
    if (
      stepped !== undefined &&
      stepped.phase_instance === state.phase_instance &&
      stepped.step === state.step &&
      stepped.input_fingerprint !== state.input_fingerprint
    ) {
      const expected: Sha256Digest = state.input_fingerprint;
      const observed: Sha256Digest = stepped.input_fingerprint;
      return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", { expected_digest: expected, observed_digest: observed }));
    }
  }

  /* Rank 8a — receipt identity agrees with the prepared successor in either relation mode. */
  if (relation !== undefined && receipt !== undefined && intentState !== undefined) {
    if (receipt.task_id !== receipt.prepared_state.task_id) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptTaskMismatch));
    }
    if (receipt.repository_identity_digest !== receipt.prepared_state.repository_identity_digest) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptRepositoryMismatch));
    }
    if (receipt.input_fingerprint !== receipt.prepared_state.input_fingerprint) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptInputFingerprintMismatch));
    }
  }

  /* Rank 8a — an uncommitted receipt must be the exact successor of its supplied predecessor. */
  if (relation?.mode === "prepared" && receipt !== undefined && intentState !== undefined) {
    const prepared = receipt.prepared_state;
    if (receipt.prior_revision > intentState.revision) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptFutureRevision));
    }
    // The receipt is locally a successor, but it must also succeed this exact predecessor.
    if (receipt.prior_revision < intentState.revision) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptRevisionNotSuccessor));
    }
    if (receipt.task_id !== intentState.task_id || prepared.task_id !== intentState.task_id) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptTaskMismatch));
    }
    if (
      receipt.repository_identity_digest !== intentState.repository_identity_digest ||
      prepared.repository_identity_digest !== intentState.repository_identity_digest
    ) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptRepositoryMismatch));
    }
    if (prepared.initialization_digest !== intentState.initialization_digest) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptInitializationMismatch));
    }
    if (prepared.config_digest !== intentState.config_digest) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptConfigMismatch));
    }
    if (prepared.workflow_digest !== intentState.workflow_digest) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptWorkflowMismatch));
    }
    if (prepared.constitution_digest !== intentState.constitution_digest) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptConstitutionMismatch));
    }
    if (prepared.policy_base_commit !== intentState.policy_base_commit) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptPolicyBaseMismatch));
    }
  }

  /* Rank 8b — final state is prepared state plus only the kernel-derived committed binding. */
  if (relation?.mode === "committed" && receipt !== undefined && intentState !== undefined) {
    const reference = intentState.last_transition;
    if (reference === undefined || reference.intent_id !== receipt.intent_id) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptIntentMismatch));
    }
    if (reference.request_digest !== receipt.request_digest) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptRequestMismatch));
    }
    if (reference.outcome_digest !== receipt.outcome_digest) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptReferenceOutcomeMismatch));
    }
    if (
      reference.prior_revision !== receipt.prior_revision ||
      reference.resulting_revision !== receipt.resulting_revision
    ) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptReferenceRevisionMismatch));
    }
    if (reference.result_id !== receipt.result_id) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptReferenceResultMismatch));
    }
    if (
      reference.schema_version !== "1" ||
      reference.tool !== receipt.tool ||
      reference.operation !== receipt.operation ||
      reference.input_fingerprint !== receipt.input_fingerprint ||
      !isDeepStrictEqual(reference.outcome, receipt.outcome)
    ) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptFinalStateMismatch));
    }
    const expectedState: TaskStateV1 = { ...receipt.prepared_state, last_transition: reference };
    if (!isDeepStrictEqual(intentState, expectedState)) {
      return fail(stateInvalid(intentState, DURABLE_ISSUE_CODES.intentReceiptFinalStateMismatch));
    }
  }

  return OK;
}
