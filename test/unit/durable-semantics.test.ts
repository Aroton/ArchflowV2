import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { LegacyImportInitializationV1 } from "../../src/contracts/durable-legacy-import.js";
import type { MaintenanceRecordV1 } from "../../src/contracts/durable-maintenance.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { TaskInitializationV1 } from "../../src/contracts/durable-task-initialization.js";
import { validateDurableSemantics, type DurableSemanticSubject } from "../../src/contracts/durable.js";

/**
 * The **positive path** only: every supplied-slot combination that the invariant table admits must
 * return `ok: true`. The adversarial corpus — every rejection row, the total-order discriminators,
 * and the descriptor/throw matrix — is chunk 12's `test/contracts/durable-semantics-corpus.test.ts`,
 * deliberately written by a different agent so the validator is not marking its own homework.
 */

const fixture = async <T>(name: string): Promise<T> =>
  JSON.parse(
    await readFile(new URL(`../fixtures/contracts/durable/${name}.valid.json`, import.meta.url), "utf8")
  ) as T;

const state = async (): Promise<TaskStateV1> => fixture<TaskStateV1>("task-state");
const taskInitialization = async (): Promise<TaskInitializationV1> =>
  fixture<TaskInitializationV1>("task-initialization");
const legacyImport = async (): Promise<LegacyImportInitializationV1> =>
  fixture<LegacyImportInitializationV1>("legacy-import-initialization");
const documentArtifact = async (): Promise<DocumentArtifactV1> => fixture<DocumentArtifactV1>("document-artifact");
const implementationOutput = async (): Promise<ImplementationOutputV1> =>
  fixture<ImplementationOutputV1>("implementation-output");
const maintenanceRecord = async (): Promise<MaintenanceRecordV1> =>
  fixture<MaintenanceRecordV1>("maintenance-record");

const accept = (subject: DurableSemanticSubject): void => {
  const result = validateDurableSemantics(subject);
  expect(result.ok ? undefined : result.error.diagnostic).toBeUndefined();
  expect(result.ok).toBe(true);
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
});
