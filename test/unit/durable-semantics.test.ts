import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { ManualCheckpointImportV1 } from "../../src/contracts/durable-checkpoint.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { LegacyImportInitializationV1 } from "../../src/contracts/durable-legacy-import.js";
import type { MaintenanceRecordV1 } from "../../src/contracts/durable-maintenance.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger } from "../../src/contracts/evidence.js";
import type { TaskInitializationV1 } from "../../src/contracts/durable-task-initialization.js";
import {
  DURABLE_ISSUE_CODES,
  createCommittedIntentSubject,
  createPreparedIntentSubject,
  validateDurableSemantics,
  type DurableSemanticSubject,
} from "../../src/contracts/durable.js";

/**
 * The positive paths cover every supplied-slot combination that the invariant table admits. The
 * general adversarial corpus lives in `test/contracts/durable-semantics-corpus.test.ts`; Phase 9's
 * receipt mutations stay here beside the receipt fixture so every new issue code is behaviorally
 * pinned to its rank and error carrier.
 */

const fixture = async <T>(name: string): Promise<T> =>
  JSON.parse(
    await readFile(new URL(`../fixtures/contracts/durable/${name}.valid.json`, import.meta.url), "utf8")
  ) as T;

const state = async (): Promise<TaskStateV1> => {
  const value = await fixture<TaskStateV1>("task-state");
  const { open_gate: _openGate, ...withoutOpenGate } = value;
  return withoutOpenGate;
};
const taskInitialization = async (): Promise<TaskInitializationV1> =>
  fixture<TaskInitializationV1>("task-initialization");
const legacyImport = async (): Promise<LegacyImportInitializationV1> =>
  fixture<LegacyImportInitializationV1>("legacy-import-initialization");
const documentArtifact = async (): Promise<DocumentArtifactV1> => fixture<DocumentArtifactV1>("document-artifact");
const implementationOutput = async (): Promise<ImplementationOutputV1> =>
  fixture<ImplementationOutputV1>("implementation-output");
const checkpointImport = async (): Promise<ManualCheckpointImportV1> =>
  fixture<ManualCheckpointImportV1>("manual-checkpoint-import");
const checkpointContinuationImport = async (): Promise<ManualCheckpointImportV1> =>
  fixture<ManualCheckpointImportV1>("manual-checkpoint-import-continuation");
const maintenanceRecord = async (): Promise<MaintenanceRecordV1> =>
  fixture<MaintenanceRecordV1>("maintenance-record");

const accept = (subject: DurableSemanticSubject): void => {
  const result = validateDurableSemantics(subject);
  expect(result.ok ? undefined : result.error.diagnostic).toBeUndefined();
  expect(result.ok).toBe(true);
};

const withoutCommittedIntent = (value: TaskStateV1): TaskStateV1 => {
  const { committed_intent: _committedIntent, ...rest } = value;
  return rest;
};

const intentPair = async (): Promise<{
  readonly predecessor: TaskStateV1;
  readonly prepared: TaskStateV1;
  readonly receipt: IntentReceiptV1;
}> => {
  const prepared = withoutCommittedIntent(await state());
  const predecessor: TaskStateV1 = { ...prepared, revision: parseSafeInteger(prepared.revision - 1) };
  const outcome = { result_id: "phase-impl-1:counter_review:2", revision: prepared.revision };
  const receipt = {
    schema_version: "1",
    intent_id: "intent-0001",
    task_id: prepared.task_id,
    repository_identity_digest: prepared.repository_identity_digest,
    tool: "archflow_state",
    operation: "record-state-boundary",
    request_digest: "a".repeat(64),
    input_fingerprint: prepared.input_fingerprint,
    prior_revision: predecessor.revision,
    resulting_revision: prepared.revision,
    result_id: outcome.result_id,
    outcome_digest: canonicalJsonDigest(outcome),
    outcome,
    prepared_state_digest: canonicalJsonDigest(prepared),
    prepared_state: prepared,
  } as unknown as IntentReceiptV1;
  return { predecessor, prepared, receipt };
};

const receiptWithPrepared = (
  receipt: IntentReceiptV1,
  preparedChanges: Partial<TaskStateV1>,
  receiptChanges: Partial<IntentReceiptV1> = {},
): IntentReceiptV1 => {
  const prepared = { ...receipt.prepared_state, ...preparedChanges } as TaskStateV1;
  return {
    ...receipt,
    prepared_state: prepared,
    prepared_state_digest: canonicalJsonDigest(prepared),
    ...receiptChanges,
  } as IntentReceiptV1;
};

const committedState = (receipt: IntentReceiptV1): TaskStateV1 => ({
  ...receipt.prepared_state,
  committed_intent: {
    intent_id: receipt.intent_id,
    request_digest: receipt.request_digest,
    receipt_digest: canonicalJsonDigest(receipt),
    outcome_digest: receipt.outcome_digest,
    prior_revision: receipt.prior_revision,
    resulting_revision: receipt.resulting_revision,
    result_id: receipt.result_id,
  },
});

const expectIntentIssue = (
  subject: DurableSemanticSubject,
  code: "TASK_INVALID" | "STATE_INVALID",
  parameters: Readonly<Record<string, unknown>>,
): void => {
  const result = validateDurableSemantics(subject);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.diagnostic.parameters).toEqual(parameters);
};

/**
 * A state that genuinely adopts the supplied initialization: rank 7a re-derives
 * `initialization_digest` with `canonicalJsonDigest` rather than trusting a caller-supplied
 * `CanonicalDocument.digest`, and 7b/7d-7h compare `task_id` and all five duplicated pinned inputs.
 */
const adopting = (base: TaskStateV1, initialization: TaskInitializationV1 | LegacyImportInitializationV1): TaskStateV1 => ({
  ...base,
  task_id: initialization.task_id,
  initialization_digest: canonicalJsonDigest(initialization),
  repository_identity_digest: initialization.repository_identity_digest,
  config_digest: initialization.config_digest,
  workflow_digest: initialization.workflow_digest,
  constitution_digest: initialization.constitution_digest,
  policy_base_commit: initialization.policy_base_commit,
});

describe("validateDurableSemantics — positive path", () => {
  it("accepts a state document supplied alone", async () => {
    accept({ state: canonicalDocument(await state()) });
  });

  it("accepts a task-initialization artifact supplied alone", async () => {
    accept({ artifact: canonicalDocument(await taskInitialization()) });
  });

  it("accepts a legacy-import-initialization artifact supplied alone", async () => {
    accept({ artifact: canonicalDocument(await legacyImport()) });
  });

  it("accepts a document artifact supplied alone", async () => {
    accept({ artifact: canonicalDocument(await documentArtifact()) });
  });

  it("accepts an implementation-output artifact supplied alone", async () => {
    accept({ artifact: canonicalDocument(await implementationOutput()) });
  });

  it("accepts an initial manual-checkpoint import without state", async () => {
    accept({ artifact: canonicalDocument(await checkpointImport()) });
  });

  it("accepts a continuation manual-checkpoint import with its computed matching state", async () => {
    const imported = await checkpointContinuationImport();
    if (imported.import_mode !== "continuation") throw new TypeError("expected continuation import fixture");
    const first = imported.chain[0];
    if (first === undefined) throw new TypeError("expected non-empty checkpoint chain fixture");

    const matchingState: TaskStateV1 = {
      ...(await state()),
      task_id: imported.task_id,
      repository_identity_digest: imported.repository_identity_digest,
      revision: imported.predecessor.revision,
      adopted_checkpoint: imported.predecessor,
      initialization_digest: first.initialization_digest,
    };
    const matchingImport: ManualCheckpointImportV1 = {
      ...imported,
      expected_state_revision: imported.predecessor.revision,
      expected_state_digest: canonicalJsonDigest(matchingState),
    };

    accept({ state: canonicalDocument(matchingState), artifact: canonicalDocument(matchingImport) });
  });

  it("accepts the first checkpoint anchored to ordinary state with no adopted checkpoint", async () => {
    const baseState = { ...(await state()) };
    delete (baseState as { adopted_checkpoint?: unknown }).adopted_checkpoint;
    const imported = await checkpointImport();
    const template = structuredClone(imported.chain[1]!);
    delete (template as { predecessor?: unknown }).predecessor;
    const stateAnchor = {
      anchor_kind: "state" as const,
      state_revision: baseState.revision,
      state_digest: canonicalJsonDigest(baseState),
    };
    const first = {
      ...template,
      task_id: baseState.task_id,
      repository_identity_digest: baseState.repository_identity_digest,
      revision: (baseState.revision + 1) as never,
      initialization_digest: baseState.initialization_digest,
      state_anchor: stateAnchor,
    };
    const artifact = {
      schema_version: "1" as const,
      artifact_kind: "manual-checkpoint-import" as const,
      task_id: baseState.task_id,
      repository_identity_digest: baseState.repository_identity_digest,
      import_mode: "state-anchored" as const,
      chain: [first],
      state_anchor: stateAnchor,
    };
    accept({ state: canonicalDocument(baseState), artifact: canonicalDocument(artifact) });
  });

  it("accepts a maintenance record supplied alone", async () => {
    accept({ maintenance: canonicalDocument(await maintenanceRecord()) });
  });

  it("accepts a state that adopts the supplied task-initialization (rank 7a-7h)", async () => {
    const initialization = await taskInitialization();
    accept({
      state: canonicalDocument(adopting(await state(), initialization)),
      artifact: canonicalDocument(initialization),
    });
  });

  it("accepts a state that adopts the supplied legacy-import-initialization (rank 7a-7h)", async () => {
    const initialization = await legacyImport();
    accept({
      state: canonicalDocument(adopting(await state(), initialization)),
      artifact: canonicalDocument(initialization),
    });
  });

  it("accepts a document artifact whose fingerprint agrees under rank 8's guard", async () => {
    const artifact = await documentArtifact();
    const base = await state();
    accept({
      state: canonicalDocument({
        ...base,
        task_id: artifact.task_id,
        phase_instance: artifact.phase_instance,
        step: artifact.step,
        input_fingerprint: artifact.input_fingerprint,
      }),
      artifact: canonicalDocument(artifact),
    });
  });

  it("accepts an implementation output whose fingerprint agrees under rank 8's guard", async () => {
    const artifact = await implementationOutput();
    const base = await state();
    accept({
      state: canonicalDocument({
        ...base,
        task_id: artifact.task_id,
        phase_instance: artifact.phase_instance,
        step: artifact.step,
        input_fingerprint: artifact.input_fingerprint,
      }),
      artifact: canonicalDocument(artifact),
    });
  });

  /**
   * Rank 8's guard is a *correctness* condition, not an optimization: `state.input_fingerprint` is
   * the in-flight step's (D13), so an artifact from a different `(phase_instance, step)` is simply
   * not comparable and disagreeing fingerprints are not a failure.
   */
  it("accepts disagreeing fingerprints when the artifact is not the in-flight step's", async () => {
    const artifact = await documentArtifact();
    const base = await state();
    expect(base.step).not.toBe(artifact.step);
    accept({
      state: canonicalDocument({ ...base, task_id: artifact.task_id, phase_instance: artifact.phase_instance }),
      artifact: canonicalDocument(artifact),
    });
  });

  it("accepts all three slots supplied together", async () => {
    const initialization = await taskInitialization();
    const base = adopting(await state(), initialization);
    const maintenance = await maintenanceRecord();
    accept({
      state: canonicalDocument(base),
      artifact: canonicalDocument(initialization),
      maintenance: canonicalDocument({
        ...maintenance,
        task_id: base.task_id,
        performed_at_revision: base.revision,
      }),
    });
  });

  it("accepts an empty subject", () => {
    accept({});
  });

  it("accepts the exact prepared and committed intent relations", async () => {
    const { predecessor, prepared, receipt } = await intentPair();
    accept(createPreparedIntentSubject(canonicalDocument(predecessor), canonicalDocument(receipt)));

    const committed = {
      ...prepared,
      committed_intent: {
        intent_id: receipt.intent_id,
        request_digest: receipt.request_digest,
        receipt_digest: canonicalJsonDigest(receipt),
        outcome_digest: receipt.outcome_digest,
        prior_revision: receipt.prior_revision,
        resulting_revision: receipt.resulting_revision,
        result_id: receipt.result_id,
      },
    };
    accept(createCommittedIntentSubject(canonicalDocument(committed), canonicalDocument(receipt)));
  });

  it("keeps receipt self-digest and local digests ahead of relation checks", async () => {
    const { predecessor, receipt } = await intentPair();
    const forgedDocument = { ...canonicalDocument(receipt), digest: "f".repeat(64) } as never;
    const selfDigest = validateDurableSemantics(createPreparedIntentSubject(canonicalDocument(predecessor), forgedDocument));
    expect(selfDigest.ok ? undefined : selfDigest.error.diagnostic.parameters).toEqual({
      task_id: receipt.task_id,
      issue_code: DURABLE_ISSUE_CODES.intentReceiptSelfDigestMismatch,
    });

    const changedOutcome = { ...receipt, outcome: { changed: true } } as IntentReceiptV1;
    const local = validateDurableSemantics(
      createPreparedIntentSubject(canonicalDocument(predecessor), canonicalDocument(changedOutcome))
    );
    expect(local.ok ? undefined : local.error.diagnostic.parameters).toEqual({
      task_id: receipt.task_id,
      issue_code: DURABLE_ISSUE_CODES.intentReceiptOutcomeDigestMismatch,
    });
  });

  it("reports prepared agreement at rank 8a before committed derivation at rank 8b", async () => {
    const { predecessor, prepared, receipt } = await intentPair();
    const changedPrepared = { ...prepared, config_digest: "e".repeat(64) } as TaskStateV1;
    const rank8aReceipt = {
      ...receipt,
      prepared_state: changedPrepared,
      prepared_state_digest: canonicalJsonDigest(changedPrepared),
    } as IntentReceiptV1;
    const rank8a = validateDurableSemantics(
      createPreparedIntentSubject(canonicalDocument(predecessor), canonicalDocument(rank8aReceipt))
    );
    expect(rank8a.ok ? undefined : rank8a.error.diagnostic.parameters).toEqual({
      phase_instance: predecessor.phase_instance,
      issue_code: DURABLE_ISSUE_CODES.intentReceiptConfigMismatch,
    });

    const committed = {
      ...prepared,
      status: "failed" as const,
      committed_intent: {
        intent_id: receipt.intent_id,
        request_digest: receipt.request_digest,
        receipt_digest: canonicalJsonDigest(receipt),
        outcome_digest: receipt.outcome_digest,
        prior_revision: receipt.prior_revision,
        resulting_revision: receipt.resulting_revision,
        result_id: receipt.result_id,
      },
    };
    const rank8b = validateDurableSemantics(
      createCommittedIntentSubject(canonicalDocument(committed), canonicalDocument(receipt))
    );
    expect(rank8b.ok ? undefined : rank8b.error.diagnostic.parameters).toEqual({
      phase_instance: committed.phase_instance,
      issue_code: DURABLE_ISSUE_CODES.intentReceiptFinalStateMismatch,
    });
  });

  it("reports every receipt-local issue at its pinned rank and TASK_INVALID carrier", async () => {
    const { predecessor, receipt } = await intentPair();
    const taskParameters = (issue_code: string): Readonly<Record<string, unknown>> => ({
      task_id: receipt.task_id,
      issue_code,
    });
    const preparedSubject = (candidate: IntentReceiptV1): DurableSemanticSubject =>
      createPreparedIntentSubject(canonicalDocument(predecessor), canonicalDocument(candidate));

    const forgedReceiptDocument = {
      ...canonicalDocument(receipt),
      digest: "f".repeat(64),
    } as never;
    expectIntentIssue(
      createPreparedIntentSubject(canonicalDocument(predecessor), forgedReceiptDocument),
      "TASK_INVALID",
      taskParameters(DURABLE_ISSUE_CODES.intentReceiptSelfDigestMismatch),
    );
    const committedIntent = committedState(receipt).committed_intent;
    if (committedIntent === undefined) throw new TypeError("expected committed intent reference");

    const localCases: ReadonlyArray<readonly [IntentReceiptV1, string]> = [
      [
        { ...receipt, outcome: { changed: true } } as IntentReceiptV1,
        DURABLE_ISSUE_CODES.intentReceiptOutcomeDigestMismatch,
      ],
      [
        { ...receipt, prepared_state: { ...receipt.prepared_state, status: "failed" } } as IntentReceiptV1,
        DURABLE_ISSUE_CODES.intentReceiptPreparedStateDigestMismatch,
      ],
      [
        receiptWithPrepared(
          receipt,
          { revision: parseSafeInteger(receipt.resulting_revision + 1) },
          { resulting_revision: parseSafeInteger(receipt.resulting_revision + 1) },
        ),
        DURABLE_ISSUE_CODES.intentReceiptRevisionNotSuccessor,
      ],
      [
        receiptWithPrepared(receipt, { revision: parseSafeInteger(receipt.resulting_revision + 1) }),
        DURABLE_ISSUE_CODES.intentReceiptPreparedStateRevisionMismatch,
      ],
      [
        receiptWithPrepared(receipt, { committed_intent: committedIntent }),
        DURABLE_ISSUE_CODES.intentReceiptPreparedStateCommittedIntentPresent,
      ],
    ];

    for (const [candidate, issueCode] of localCases) {
      expectIntentIssue(preparedSubject(candidate), "TASK_INVALID", taskParameters(issueCode));
    }
  });

  it("reports every prepared relation issue at rank 8a with the predecessor STATE_INVALID carrier", async () => {
    const { predecessor, receipt } = await intentPair();
    const stateParameters = (issue_code: string): Readonly<Record<string, unknown>> => ({
      phase_instance: predecessor.phase_instance,
      issue_code,
    });
    const subject = (candidate: IntentReceiptV1): DurableSemanticSubject =>
      createPreparedIntentSubject(canonicalDocument(predecessor), canonicalDocument(candidate));
    const digest = (character: string): string => character.repeat(64);

    const futurePrior = parseSafeInteger(predecessor.revision + 1);
    const futureResult = parseSafeInteger(predecessor.revision + 2);
    const stalePrior = parseSafeInteger(predecessor.revision - 1);
    const staleResult = predecessor.revision;
    const relationCases: ReadonlyArray<readonly [IntentReceiptV1, string]> = [
      [
        receiptWithPrepared(
          receipt,
          { revision: futureResult },
          { prior_revision: futurePrior, resulting_revision: futureResult },
        ),
        DURABLE_ISSUE_CODES.intentReceiptFutureRevision,
      ],
      [
        receiptWithPrepared(
          receipt,
          { revision: staleResult },
          { prior_revision: stalePrior, resulting_revision: staleResult },
        ),
        DURABLE_ISSUE_CODES.intentReceiptRevisionNotSuccessor,
      ],
      [
        receiptWithPrepared(receipt, { task_id: "foreign-task" as never }, { task_id: "foreign-task" as never }),
        DURABLE_ISSUE_CODES.intentReceiptTaskMismatch,
      ],
      [
        receiptWithPrepared(
          receipt,
          { repository_identity_digest: digest("9") as never },
          { repository_identity_digest: digest("9") as never },
        ),
        DURABLE_ISSUE_CODES.intentReceiptRepositoryMismatch,
      ],
      [
        receiptWithPrepared(receipt, { initialization_digest: digest("8") as never }),
        DURABLE_ISSUE_CODES.intentReceiptInitializationMismatch,
      ],
      [
        receiptWithPrepared(receipt, { config_digest: digest("7") as never }),
        DURABLE_ISSUE_CODES.intentReceiptConfigMismatch,
      ],
      [
        receiptWithPrepared(receipt, { workflow_digest: digest("6") as never }),
        DURABLE_ISSUE_CODES.intentReceiptWorkflowMismatch,
      ],
      [
        receiptWithPrepared(receipt, { constitution_digest: digest("5") as never }),
        DURABLE_ISSUE_CODES.intentReceiptConstitutionMismatch,
      ],
      [
        receiptWithPrepared(receipt, { policy_base_commit: "1".repeat(40) as never }),
        DURABLE_ISSUE_CODES.intentReceiptPolicyBaseMismatch,
      ],
      [
        receiptWithPrepared(receipt, {
          adopted_checkpoint: {
            revision: parseSafeInteger(predecessor.revision - 1),
            checkpoint_digest: digest("4") as never,
          },
        }),
        DURABLE_ISSUE_CODES.intentReceiptAdoptedCheckpointMismatch,
      ],
      [
        { ...receipt, input_fingerprint: digest("3") } as IntentReceiptV1,
        DURABLE_ISSUE_CODES.intentReceiptInputFingerprintMismatch,
      ],
    ];

    for (const [candidate, issueCode] of relationCases) {
      expectIntentIssue(subject(candidate), "STATE_INVALID", stateParameters(issueCode));
    }
  });

  it("permits adopted-checkpoint movement only for the durable adoption operation", async () => {
    const { predecessor, receipt } = await intentPair();
    const changed = receiptWithPrepared(receipt, {
      adopted_checkpoint: {
        revision: parseSafeInteger(predecessor.revision + 1),
        checkpoint_digest: "4".repeat(64) as never,
      },
    });
    const adoptionReceipt = { ...changed, operation: "adopt-manual-checkpoint-import" } as IntentReceiptV1;
    accept(createPreparedIntentSubject(canonicalDocument(predecessor), canonicalDocument(adoptionReceipt)));
    expectIntentIssue(
      createPreparedIntentSubject(canonicalDocument(predecessor), canonicalDocument(changed)),
      "STATE_INVALID",
      { phase_instance: predecessor.phase_instance, issue_code: DURABLE_ISSUE_CODES.intentReceiptAdoptedCheckpointMismatch },
    );
  });

  it("reports every committed reference issue at rank 8b with the final STATE_INVALID carrier", async () => {
    const { receipt } = await intentPair();
    const exactState = committedState(receipt);
    const exactReference = exactState.committed_intent;
    if (exactReference === undefined) throw new TypeError("expected committed intent reference");
    const stateParameters = (issue_code: string): Readonly<Record<string, unknown>> => ({
      phase_instance: exactState.phase_instance,
      issue_code,
    });
    const subject = (candidate: TaskStateV1): DurableSemanticSubject =>
      createCommittedIntentSubject(canonicalDocument(candidate), canonicalDocument(receipt));
    const withReference = (changes: Partial<typeof exactReference>): TaskStateV1 => ({
      ...exactState,
      committed_intent: { ...exactReference, ...changes },
    });

    const committedCases: ReadonlyArray<readonly [TaskStateV1, string]> = [
      [withReference({ intent_id: "intent-foreign" as never }), DURABLE_ISSUE_CODES.intentReceiptIntentMismatch],
      [withReference({ request_digest: "9".repeat(64) as never }), DURABLE_ISSUE_CODES.intentReceiptRequestMismatch],
      [
        withReference({ receipt_digest: "8".repeat(64) as never }),
        DURABLE_ISSUE_CODES.intentReceiptReferenceDigestMismatch,
      ],
      [
        withReference({ outcome_digest: "7".repeat(64) as never }),
        DURABLE_ISSUE_CODES.intentReceiptReferenceOutcomeMismatch,
      ],
      [
        withReference({ prior_revision: parseSafeInteger(exactReference.prior_revision - 1) }),
        DURABLE_ISSUE_CODES.intentReceiptReferenceRevisionMismatch,
      ],
      [
        withReference({ result_id: "phase-impl-1:counter_review:99" as never }),
        DURABLE_ISSUE_CODES.intentReceiptReferenceResultMismatch,
      ],
      [{ ...exactState, status: "failed" }, DURABLE_ISSUE_CODES.intentReceiptFinalStateMismatch],
    ];

    for (const [candidate, issueCode] of committedCases) {
      expectIntentIssue(subject(candidate), "STATE_INVALID", stateParameters(issueCode));
    }
  });
});
