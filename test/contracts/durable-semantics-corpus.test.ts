import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  canonicalDocument,
  canonicalJsonBytes,
  canonicalJsonDigest,
  type CanonicalDocument,
} from "../../src/contracts/canonical.js";
import {
  DURABLE_ISSUE_CODES,
  openGateFrozenStateDigest,
  validateDurableSemantics,
  type DurableArtifact,
  type DurableSemanticSubject,
} from "../../src/contracts/durable.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { createProjectError } from "../../src/contracts/errors.js";
import type { Sha256Digest } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";

/**
 * **The adversarial corpus for `validateDurableSemantics` (chunk 12).** Written from the phase
 * design's pinned invariant table rather than from the shipped validator, by a different agent than
 * the one that authored `src/contracts/durable.ts` — one agent authoring both a validator and its
 * own rejection matrix is marking its own homework.
 *
 * **The authority line.** Everything here is a *semantic* rejection: what the validator must reject
 * given a subject that has already passed its normative JSON Schema. Structural failures — unknown
 * fields, missing required properties, closed-enum violations, pattern failures, set ordering, byte
 * caps, and the `git-object => stored_bytes === 0` rule — belong to
 * `test/contracts/durable-structural-corpus.test.ts` (chunk 11) and must never reach this function.
 * The two deliberate residues that *are* semantic are ranks 2 and 4: they exist precisely because
 * the `phaseInstanceId` JSON `pattern` is weaker than `decodePhaseInstance` (D6).
 *
 * Fixtures are read as JSON and mutated in plain-JSON space, so a case can violate a clause the
 * TypeScript types make unwritable — which is exactly the caller a validator must survive. Every
 * `CanonicalDocument` for a *valid* case is built with `canonicalDocument`; the digest-mismatch
 * cases construct the shell as an object literal, because a caller can do that too, which is why
 * the validator re-derives every digest it compares rather than trusting the supplied one.
 */

type Json = Record<string, unknown>;

const load = (name: string): Json =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/contracts/durable/${name}.valid.json`, import.meta.url), "utf8")
  ) as Json;

const OPEN_GATE_STATE = load("task-state");
const STATE = (() => {
  const state = structuredClone(OPEN_GATE_STATE);
  delete state.open_gate;
  return state;
})();
const TASK_INIT = load("task-initialization");
const LEGACY_INIT = load("legacy-import-initialization");
const DOCUMENT = load("document-artifact");
const OUTPUT = load("implementation-output");

/** Matches `primitives#/$defs/phaseInstanceId` and is rejected by `decodePhaseInstance` (D6). */
const UNDECODABLE = "phase-impl-99999999999999999999";
const FORGED_DIGEST = "0".repeat(64);

const copy = (value: Json): Json => structuredClone(value);
const patch = (base: Json, changes: Json): Json => ({ ...structuredClone(base), ...changes });
const list = (value: Json, key: string): Json[] => value[key] as Json[];

const withValidOpenGateDigest = (value: Json): TaskStateV1 => {
  const state = structuredClone(value) as unknown as TaskStateV1;
  if (state.open_gate === undefined) return state;
  return { ...state, open_gate: { ...state.open_gate, frozen_state_digest: openGateFrozenStateDigest(state) } };
};
const stateDoc = (value: Json): CanonicalDocument<TaskStateV1> => canonicalDocument(withValidOpenGateDigest(value));
const artifactDoc = (value: Json): CanonicalDocument<DurableArtifact> =>
  canonicalDocument(value as unknown as DurableArtifact);

/**
 * A `CanonicalDocument` whose `digest` disagrees with `canonicalJsonDigest(value)`. `bytes` is
 * filled in honestly but is never read: the validator does not inspect `bytes` at all — Phase 10
 * owns byte-level checks.
 */
function forged<T extends PlainJsonValue>(value: Json, digest: string = FORGED_DIGEST): CanonicalDocument<T> {
  return {
    bytes: canonicalJsonBytes(value as unknown as PlainJsonValue),
    value: value as unknown as T,
    digest: digest as Sha256Digest,
  };
}

/** A state that genuinely adopts the supplied initialization, so ranks 7a-7h all pass by default. */
const adopting = (state: Json, initialization: Json): Json => ({
  ...structuredClone(state),
  task_id: initialization.task_id,
  initialization_digest: canonicalJsonDigest(initialization as unknown as PlainJsonValue),
  repository_identity_digest: initialization.repository_identity_digest,
  config_digest: initialization.config_digest,
  workflow_digest: initialization.workflow_digest,
  constitution_digest: initialization.constitution_digest,
  policy_base_commit: initialization.policy_base_commit,
});

/* ------------------------------------------------------------------------------- assertion core */

/**
 * Every rejection assertion runs the validator several times on the same subject and requires the
 * observed error to be identical across runs — the invariant table's claim is that the reported
 * error is a *total function* of the subject, so repetition is part of the assertion, not garnish.
 */
const RUNS = 3;
type Observed = { readonly code: string; readonly parameters: Json };

function reject(subject: DurableSemanticSubject): Observed {
  const observed: Observed[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const result = validateDurableSemantics(subject);
    if (result.ok) throw new Error("expected validateDurableSemantics to reject, but it returned ok");
    observed.push({ code: result.error.code, parameters: result.error.diagnostic.parameters as Json });
  }
  for (const candidate of observed) expect(candidate).toEqual(observed[0]);
  return observed[0]!;
}

function expectReject(subject: DurableSemanticSubject, code: string, parameters: Json): void {
  expect(reject(subject)).toEqual({ code, parameters });
}

function expectAccept(subject: DurableSemanticSubject): void {
  for (let run = 0; run < RUNS; run += 1) {
    const result = validateDurableSemantics(subject);
    expect(result.ok ? undefined : result.error.diagnostic).toBeUndefined();
    expect(result.ok).toBe(true);
  }
}

/* --------------------------------------------------------------------- rank 1 — input discipline */

describe("input discipline throws rather than returning (D12 rank 1)", () => {
  /**
   * Reading a getter *once* prevents split observation — the defect `CLAUDE.md` records, where a
   * validation pass and a hashing pass see two different values — but reading alone still *accepts*
   * a getter-backed slot. The own-data-descriptor check (`validators.ts:33-36`) is what rejects it.
   * A getter-backed slot or shell field is a defect in the calling server code, not agent-supplied
   * data, so the repository convention is a throw (Phase 6 decision 5).
   */
  const accessorSlot = (slot: "state" | "artifact", value: unknown): DurableSemanticSubject => {
    const subject: Json = {};
    Object.defineProperty(subject, slot, { get: () => value, enumerable: true, configurable: true });
    return subject as DurableSemanticSubject;
  };

  it("throws when the state slot is an accessor property", () => {
    expect(() => validateDurableSemantics(accessorSlot("state", stateDoc(STATE)))).toThrow(TypeError);
  });

  it("throws when the artifact slot is an accessor property", () => {
    expect(() => validateDurableSemantics(accessorSlot("artifact", artifactDoc(DOCUMENT)))).toThrow(TypeError);
  });

  it("throws when a document's value is an accessor property", () => {
    const shell: Json = { bytes: new Uint8Array(), digest: FORGED_DIGEST };
    Object.defineProperty(shell, "value", { get: () => copy(STATE), enumerable: true, configurable: true });
    expect(() =>
      validateDurableSemantics({ state: shell as unknown as CanonicalDocument<TaskStateV1> })
    ).toThrow(TypeError);
  });

  it("throws when a document's digest is an accessor property", () => {
    const shell: Json = { bytes: new Uint8Array(), value: copy(STATE) };
    Object.defineProperty(shell, "digest", { get: () => FORGED_DIGEST, enumerable: true, configurable: true });
    expect(() =>
      validateDurableSemantics({ state: shell as unknown as CanonicalDocument<TaskStateV1> })
    ).toThrow(TypeError);
  });

  it("throws when a document's value is not plain JSON", () => {
    const value = copy(STATE);
    Object.defineProperty(value, "task_id", { get: () => "demo", enumerable: true, configurable: true });
    expect(() =>
      validateDurableSemantics({ state: forged<TaskStateV1>(value) })
    ).toThrow(TypeError);
  });

  /**
   * A *non-enumerable data* property is stable under repeated reads, so it does not defeat the
   * split-observation defence the accessor cases above cover. It is rejected for a different and
   * equally load-bearing reason: `canonicalJsonBytes` serializes only enumerable properties, so a
   * non-enumerable `value` or `digest` is invisible to the very digest the validator re-derives,
   * and `assertPlainJson` already rejects a non-enumerable property *inside* a value as "not a JSON
   * value" (`plain-json.ts:85`). Without these cases the shell check would be weaker than the check
   * applied to the shell's own contents. Added at implementation counter-review, finding 1.
   */
  const nonEnumerableSlot = (slot: "state" | "artifact", value: unknown): DurableSemanticSubject => {
    const subject: Json = {};
    Object.defineProperty(subject, slot, { value, enumerable: false, configurable: true, writable: true });
    return subject as DurableSemanticSubject;
  };

  it.each(["state", "artifact"] as const)(
    "throws when the %s slot is a non-enumerable data property",
    (slot) => {
      const document = slot === "state" ? stateDoc(STATE) : artifactDoc(DOCUMENT);
      expect(() => validateDurableSemantics(nonEnumerableSlot(slot, document))).toThrow(TypeError);
    }
  );

  it.each(["value", "digest"] as const)(
    "throws when a document's %s is a non-enumerable data property",
    (field) => {
      const shell: Json = { bytes: new Uint8Array() };
      const other = field === "value" ? "digest" : "value";
      shell[other] = other === "digest" ? FORGED_DIGEST : copy(STATE);
      Object.defineProperty(shell, field, {
        value: field === "value" ? copy(STATE) : FORGED_DIGEST,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      expect(() =>
        validateDurableSemantics({ state: shell as unknown as CanonicalDocument<TaskStateV1> })
      ).toThrow(TypeError);
    }
  );

  it("has no bytes case: a document whose bytes disagree with its value is still accepted", () => {
    // The validator never inspects `bytes`; Phase 10 owns byte-level verification.
    const document: CanonicalDocument<TaskStateV1> = {
      bytes: new Uint8Array([1, 2, 3]),
      value: copy(STATE) as unknown as TaskStateV1,
      digest: canonicalJsonDigest(STATE as unknown as PlainJsonValue),
    };
    expectAccept({ state: document });
  });
});

/* --------------------------------------------------------- rank 2 — phase-instance carriability */

describe("rank 2 — state.phase_instance carriability precedes every rank that may report STATE_INVALID", () => {
  const undecodableState = patch(STATE, { phase_instance: UNDECODABLE });

  it("reports CONTRACT_INVALID for a pattern-valid, decoder-invalid state.phase_instance", () => {
    expectReject({ state: stateDoc(undecodableState) }, "CONTRACT_INVALID", {
      issue_code: DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable,
    });
  });

  it("still returns, and still reports rank 2, when rank 3 is also violated", () => {
    // The combined case is the whole point of rank 2: without it, rank 3's `STATE_INVALID` would
    // run `decodePhaseInstance` under `.strict()` and throw a `ZodError` where the contract
    // requires a return.
    const subject: DurableSemanticSubject = { state: forged<TaskStateV1>(undecodableState) };
    expect(() => validateDurableSemantics(subject)).not.toThrow();
    expectReject(subject, "CONTRACT_INVALID", {
      issue_code: DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable,
    });
  });

  it("STATE_INVALID is not an admissible carrier for an undecodable phase instance", () => {
    expect(() =>
      createProjectError("STATE_INVALID", {
        phase_instance: "phase-impl-0",
        issue_code: DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable,
      })
    ).toThrow(z.ZodError);
    expect(() =>
      createProjectError("STATE_INVALID", {
        phase_instance: UNDECODABLE,
        issue_code: DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable,
      })
    ).toThrow(z.ZodError);
  });
});

describe("rank 3 — an open gate freezes its state shell", () => {
  it("accepts the bound shell and rejects a last-transition injection", () => {
    const valid = withValidOpenGateDigest(OPEN_GATE_STATE);
    expectAccept({ state: canonicalDocument(valid) });
    const injected = {
      ...valid,
      last_transition: {
        schema_version: "1",
        tool: "archflow_state",
        operation: "record-state-boundary",
        intent_id: "injected-intent",
        request_digest: FORGED_DIGEST,
        input_fingerprint: "1".repeat(64),
        result_id: "injected-result",
        outcome: { revision: 2 },
        outcome_digest: "2".repeat(64),
        prior_revision: 1,
        resulting_revision: 2,
      },
    } as unknown as TaskStateV1;
    expectReject(
      { state: canonicalDocument(injected) },
      "STATE_INVALID",
      { phase_instance: valid.phase_instance, issue_code: DURABLE_ISSUE_CODES.openGateFrozenStateMismatch },
    );
  });
});

/* --------------------------------------------------------------- rank 3 — self-digest agreement */

describe("rank 3 — document-digest-mismatch, under the pinned code for each subject", () => {
  it("reports STATE_INVALID for the state slot", () => {
    expectReject({ state: forged<TaskStateV1>(STATE) }, "STATE_INVALID", {
      phase_instance: STATE.phase_instance,
      issue_code: DURABLE_ISSUE_CODES.documentDigestMismatch,
    });
  });

  it("reports TASK_INVALID for a task-initialization artifact", () => {
    expectReject({ artifact: forged<DurableArtifact>(TASK_INIT) }, "TASK_INVALID", {
      task_id: TASK_INIT.task_id,
      issue_code: DURABLE_ISSUE_CODES.documentDigestMismatch,
    });
  });

  it("reports TASK_INVALID for a legacy-import-initialization artifact", () => {
    expectReject({ artifact: forged<DurableArtifact>(LEGACY_INIT) }, "TASK_INVALID", {
      task_id: LEGACY_INIT.task_id,
      issue_code: DURABLE_ISSUE_CODES.documentDigestMismatch,
    });
  });

  it("reports TASK_INVALID for a document artifact", () => {
    expectReject({ artifact: forged<DurableArtifact>(DOCUMENT) }, "TASK_INVALID", {
      task_id: DOCUMENT.task_id,
      issue_code: DURABLE_ISSUE_CODES.documentDigestMismatch,
    });
  });

  it("reports SNAPSHOT_INVALID for an implementation-output artifact", () => {
    expectReject({ artifact: forged<DurableArtifact>(OUTPUT) }, "SNAPSHOT_INVALID", {
      snapshot_digest: OUTPUT.snapshot_digest,
      issue_code: DURABLE_ISSUE_CODES.documentDigestMismatch,
    });
  });

});

/* ------------------------------------------------------------- rank 4 — the phase-instance residue */

describe("rank 4 — the phase-instance residue, CONTRACT_INVALID in every slot", () => {
  it("4a: an undecodable state.authoritative_results[*].phase_instance", () => {
    const state = copy(STATE);
    list(state, "authoritative_results")[0] = {
      ...list(state, "authoritative_results")[0]!,
      phase_instance: UNDECODABLE,
    };
    expectReject({ state: stateDoc(state) }, "CONTRACT_INVALID", {
      issue_code: DURABLE_ISSUE_CODES.phaseInstanceUndecodable,
    });
  });

  it("4a: an undecodable artifact-root phase_instance on a document artifact", () => {
    expectReject(
      { artifact: artifactDoc(patch(DOCUMENT, { phase_instance: UNDECODABLE })) },
      "CONTRACT_INVALID",
      { issue_code: DURABLE_ISSUE_CODES.phaseInstanceUndecodable }
    );
  });

  it("4a: an undecodable artifact-root phase_instance on an implementation output", () => {
    expectReject(
      { artifact: artifactDoc(patch(OUTPUT, { phase_instance: UNDECODABLE })) },
      "CONTRACT_INVALID",
      { issue_code: DURABLE_ISSUE_CODES.phaseInstanceUndecodable }
    );
  });

  it("4a: an undecodable legacy-import mapping[*].phase_instance", () => {
    const artifact = copy(LEGACY_INIT);
    list(artifact, "mapping")[0] = { ...list(artifact, "mapping")[0]!, phase_instance: UNDECODABLE };
    expectReject({ artifact: artifactDoc(artifact) }, "CONTRACT_INVALID", {
      issue_code: DURABLE_ISSUE_CODES.phaseInstanceUndecodable,
    });
  });

  it("4b: an implementation output whose phase_instance decodes to a non-phase-impl kind", () => {
    for (const phase_instance of ["phase-design-1", "design", "prd"]) {
      expectReject(
        { artifact: artifactDoc(patch(OUTPUT, { phase_instance })) },
        "CONTRACT_INVALID",
        { issue_code: DURABLE_ISSUE_CODES.implementationOutputPhaseKind }
      );
    }
  });

  it("4b does not fire for a phase-impl instance", () => {
    expectAccept({ artifact: artifactDoc(patch(OUTPUT, { phase_instance: "phase-impl-42" })) });
  });
});

/* ------------------------------------------------------ rank 5 — the output-entry residue clauses */

describe("rank 5 — the output-entry residue", () => {
  const renamed = (previous_path: string): Json => {
    const artifact = copy(OUTPUT);
    const outputs = list(artifact, "outputs");
    outputs[1] = { ...outputs[1]!, operation: "rename", previous_path };
    return artifact;
  };

  it("5a: previous_path === path", () => {
    const artifact = renamed(list(OUTPUT, "outputs")[1]!.path as string);
    expectReject({ artifact: artifactDoc(artifact) }, "SNAPSHOT_INVALID", {
      snapshot_digest: OUTPUT.snapshot_digest,
      issue_code: DURABLE_ISSUE_CODES.renamePreviousPathEqualsPath,
    });
  });

  /**
   * **Deferred to Phase 10, deliberately.** A rename whose endpoints belong to two *actual*
   * different path classes is ACCEPTED here. The design withdrew the earlier "structurally
   * unrepresentable" claim: both endpoints are runtime-indistinguishable `RepositoryPathClaim`
   * strings (`path-claims.ts:31-45` is one lexical validator cast twice) and the class -> template
   * tables live in `src/repository/paths.ts`, which `src/contracts/**` may never import (D4,
   * `test/contracts/repository-boundary.test.ts:28-38`). Phase 10 classifies and verifies both
   * endpoints. This test records the deferral rather than pretending the check exists.
   */
  it("5a: a genuinely cross-class rename is accepted, pending byte-level verification", () => {
    expectAccept({ artifact: artifactDoc(renamed(".archflow/tasks/demo/review/legacy-review.md")) });
  });

  it("5a: a rename with distinct endpoints is accepted", () => {
    expectAccept({ artifact: artifactDoc(renamed("src/old-index.ts")) });
  });

  it("5b: a restore target that is not a declared output path", () => {
    const artifact = patch(OUTPUT, {
      restore_targets: [...(OUTPUT.restore_targets as string[]), "src/never-declared.ts"],
    });
    expectReject({ artifact: artifactDoc(artifact) }, "SNAPSHOT_INVALID", {
      snapshot_digest: OUTPUT.snapshot_digest,
      issue_code: DURABLE_ISSUE_CODES.restoreTargetNotDeclared,
    });
  });
});

/* ------------------------------------------------------------- rank 6 — the accounting invariants */

describe("rank 6 — accounting correspondence, ordered by dependency", () => {
  const accountingOf = (artifact: Json): Json => artifact.accounting as Json;

  const withAccounting = (changes: Json): Json => {
    const artifact = copy(OUTPUT);
    artifact.accounting = { ...accountingOf(artifact), ...changes };
    return artifact;
  };

  const expectAccountingIssue = (artifact: Json, issue_code: string): void => {
    expectReject({ artifact: artifactDoc(artifact) }, "SNAPSHOT_INVALID", {
      snapshot_digest: OUTPUT.snapshot_digest,
      issue_code,
    });
  };

  it("6a: result_bytes disagrees with the sum of counted_entries[].stored_bytes", () => {
    expectAccountingIssue(withAccounting({ result_bytes: 4096 }), DURABLE_ISSUE_CODES.accountingResultBytesSum);
  });

  it("6b: task_bytes below result_bytes", () => {
    expectAccountingIssue(withAccounting({ task_bytes: 1024 }), DURABLE_ISSUE_CODES.accountingTaskBytesBelowResult);
  });

  it("6c: a counted entry with no matching output path", () => {
    const artifact = copy(OUTPUT);
    const accounting = accountingOf(artifact);
    (accounting.counted_entries as Json[]).push({
      path: "src/never-declared.ts",
      storage: "git-object",
      stored_bytes: 0,
    });
    expectAccountingIssue(artifact, DURABLE_ISSUE_CODES.accountingEntryUnmatched);
  });

  it("6d: an output path with no matching counted entry", () => {
    const artifact = copy(OUTPUT);
    const accounting = accountingOf(artifact);
    accounting.counted_entries = (accounting.counted_entries as Json[]).slice(0, 1);
    expectAccountingIssue(artifact, DURABLE_ISSUE_CODES.accountingOutputUnmatched);
  });

  it("6e: a matched pair whose storage disagrees", () => {
    const artifact = copy(OUTPUT);
    const accounting = accountingOf(artifact);
    (accounting.counted_entries as Json[])[1] = {
      path: "src/index.ts",
      storage: "raw-payload",
      stored_bytes: 0,
    };
    expectAccountingIssue(artifact, DURABLE_ISSUE_CODES.accountingStorageMismatch);
  });

  it("6f: a raw-payload pair whose stored_bytes disagrees with payload_bytes", () => {
    const artifact = copy(OUTPUT);
    const accounting = accountingOf(artifact);
    (accounting.counted_entries as Json[])[0] = {
      ...(accounting.counted_entries as Json[])[0]!,
      stored_bytes: 1024,
    };
    accounting.result_bytes = 1024;
    expectAccountingIssue(artifact, DURABLE_ISSUE_CODES.accountingStoredBytesMismatch);
  });

  it("6c precedes 6d when both hold", () => {
    const artifact = copy(OUTPUT);
    const accounting = accountingOf(artifact);
    accounting.counted_entries = [
      { path: "src/never-declared.ts", storage: "raw-payload", stored_bytes: 2048 },
    ];
    accounting.result_bytes = 2048;
    expectAccountingIssue(artifact, DURABLE_ISSUE_CODES.accountingEntryUnmatched);
  });
});

/* ---------------------------------------- rank 7 — state <-> initialization, one field at a time */

describe("rank 7 — the state cannot contradict the initialization it adopts", () => {
  /**
   * The five duplicated pinned-input fields plus `task_id`. Both initialization kinds run **one**
   * clause list with no branch, and that uniformity is the point, so the whole set is repeated
   * against `legacy-import-initialization`.
   */
  const PINNED: readonly (readonly [string, string, string])[] = [
    ["task_id", "other-task", DURABLE_ISSUE_CODES.artifactTaskIdMismatch],
    ["repository_identity_digest", "1".repeat(64), DURABLE_ISSUE_CODES.repositoryIdentityDigestMismatch],
    ["config_digest", "2".repeat(64), DURABLE_ISSUE_CODES.configDigestMismatch],
    ["workflow_digest", "3".repeat(64), DURABLE_ISSUE_CODES.workflowDigestMismatch],
    ["constitution_digest", "4".repeat(64), DURABLE_ISSUE_CODES.constitutionDigestMismatch],
    ["policy_base_commit", "5".repeat(40), DURABLE_ISSUE_CODES.policyBaseCommitMismatch],
  ];

  for (const [kind, initialization] of [
    ["task-initialization", TASK_INIT],
    ["legacy-import-initialization", LEGACY_INIT],
  ] as const) {
    describe(kind, () => {
      const base = adopting(STATE, initialization);

      it("accepts the adopting pair unchanged", () => {
        expectAccept({ state: stateDoc(base), artifact: artifactDoc(initialization) });
      });

      it("7a: initialization_digest names a different document", () => {
        expectReject(
          {
            state: stateDoc(patch(base, { initialization_digest: FORGED_DIGEST })),
            artifact: artifactDoc(initialization),
          },
          "STATE_INVALID",
          {
            phase_instance: base.phase_instance,
            issue_code: DURABLE_ISSUE_CODES.initializationDigestMismatch,
          }
        );
      });

      for (const [field, replacement, issue_code] of PINNED) {
        it(`7: ${field} disagrees -> ${issue_code}`, () => {
          expectReject(
            {
              state: stateDoc(patch(base, { [field]: replacement })),
              artifact: artifactDoc(initialization),
            },
            "STATE_INVALID",
            { phase_instance: base.phase_instance, issue_code }
          );
        });
      }

      it("7a is reported when initialization_digest AND a pinned field both disagree", () => {
        // 7d-7h presuppose 7a: comparing pinned inputs against a document the state does not
        // actually adopt would report a mismatch that is not one.
        const observed = reject({
          state: stateDoc(
            patch(base, { initialization_digest: FORGED_DIGEST, config_digest: "2".repeat(64) })
          ),
          artifact: artifactDoc(initialization),
        });
        expect(observed.parameters.issue_code).toBe(DURABLE_ISSUE_CODES.initializationDigestMismatch);
        expect(observed.parameters.issue_code).not.toBe(DURABLE_ISSUE_CODES.configDigestMismatch);
      });
    });
  }

  it("7b applies to a non-initialization artifact too", () => {
    // The state fixture's task_id is `mcp-integration`; the document artifact's is `demo`.
    expectReject({ state: stateDoc(STATE), artifact: artifactDoc(DOCUMENT) }, "STATE_INVALID", {
      phase_instance: STATE.phase_instance,
      issue_code: DURABLE_ISSUE_CODES.artifactTaskIdMismatch,
    });
  });

  it("7d-7h do not run when no initialization artifact is supplied", () => {
    // A document artifact carries none of the pinned inputs; the clauses simply do not apply.
    expectAccept({ state: stateDoc(patch(STATE, { task_id: DOCUMENT.task_id })), artifact: artifactDoc(DOCUMENT) });
  });
});

/* ------------------------------------------------- rank 8 — the in-flight fingerprint and its guard */

describe("rank 8 — the in-flight fingerprint, its guard, and its pinned orientation", () => {
  /** A state whose `(phase_instance, step)` is the supplied artifact's, so the guard is satisfied. */
  const alignedState = (artifact: Json): Json =>
    patch(STATE, {
      task_id: artifact.task_id,
      phase_instance: artifact.phase_instance,
      step: artifact.step,
    });

  for (const [kind, artifact] of [
    ["document", DOCUMENT],
    ["implementation-output", OUTPUT],
  ] as const) {
    describe(kind, () => {
      it("reports INPUT_FINGERPRINT_MISMATCH with the state as expected and the artifact as observed", () => {
        // Orientation is pinned because the reverse assignment would invert every diagnostic the
        // phase emits: the state of truth is what the artifact is measured against.
        const state = alignedState(artifact);
        const observed = reject({ state: stateDoc(state), artifact: artifactDoc(artifact) });
        expect(observed.code).toBe("INPUT_FINGERPRINT_MISMATCH");
        expect(observed.parameters).toEqual({
          expected_digest: state.input_fingerprint,
          observed_digest: artifact.input_fingerprint,
        });
        expect(observed.parameters.expected_digest).toBe(STATE.input_fingerprint);
        expect(observed.parameters.observed_digest).toBe(artifact.input_fingerprint);
        expect(observed.parameters.expected_digest).not.toBe(observed.parameters.observed_digest);
      });

      it("carries no issue_code (errors.ts:46 is .strict() over exactly the two digests)", () => {
        const observed = reject({
          state: stateDoc(alignedState(artifact)),
          artifact: artifactDoc(artifact),
        });
        expect(Object.hasOwn(observed.parameters, "issue_code")).toBe(false);
        expect(Object.keys(observed.parameters).sort()).toEqual(["expected_digest", "observed_digest"]);
        expect(() =>
          createProjectError("INPUT_FINGERPRINT_MISMATCH", {
            expected_digest: FORGED_DIGEST,
            observed_digest: FORGED_DIGEST,
            issue_code: "whatever",
          } as never)
        ).toThrow(z.ZodError);
      });

      it("accepts when the two fingerprints agree", () => {
        const state = patch(alignedState(artifact), { input_fingerprint: artifact.input_fingerprint });
        expectAccept({ state: stateDoc(state), artifact: artifactDoc(artifact) });
      });

      it("is suppressed when phase_instance differs", () => {
        const state = patch(alignedState(artifact), { phase_instance: "phase-impl-9" });
        expectAccept({ state: stateDoc(state), artifact: artifactDoc(artifact) });
      });

      it("is suppressed when step differs", () => {
        const state = patch(alignedState(artifact), { step: "adjudicate" });
        expectAccept({ state: stateDoc(state), artifact: artifactDoc(artifact) });
      });
    });
  }

  it("is suppressed for an artifact with no step (an initialization)", () => {
    // An initialization carries no `step` and no `input_fingerprint`, so it can never enter rank 8.
    expectAccept({
      state: stateDoc(adopting(STATE, TASK_INIT)),
      artifact: artifactDoc(TASK_INIT),
    });
    expectAccept({
      state: stateDoc(adopting(STATE, LEGACY_INIT)),
      artifact: artifactDoc(LEGACY_INIT),
    });
  });
});

/* ---------------------------------------------- the reported error is a total function of the subject */

describe("the reported error is a total function of the subject", () => {
  it("(a) two clauses at different ranks: the lower rank is reported", () => {
    // Rank 4a (an undecodable authoritative result) against rank 7a (a disowned initialization).
    const state = copy(adopting(STATE, TASK_INIT));
    state.initialization_digest = FORGED_DIGEST;
    list(state, "authoritative_results")[0] = {
      ...list(state, "authoritative_results")[0]!,
      phase_instance: UNDECODABLE,
    };
    expectReject({ state: stateDoc(state), artifact: artifactDoc(TASK_INIT) }, "CONTRACT_INVALID", {
      issue_code: DURABLE_ISSUE_CODES.phaseInstanceUndecodable,
    });
  });

  it("(a') rank 2 precedes rank 4a in the same slot", () => {
    const state = patch(STATE, { phase_instance: UNDECODABLE });
    list(state, "authoritative_results")[0] = {
      ...list(state, "authoritative_results")[0]!,
      phase_instance: UNDECODABLE,
    };
    expectReject({ state: stateDoc(state) }, "CONTRACT_INVALID", {
      issue_code: DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable,
    });
  });

  it("(b) the same rank in two slots: state (0) beats artifact (1)", () => {
    expectReject(
      { state: forged<TaskStateV1>(STATE), artifact: forged<DurableArtifact>(OUTPUT) },
      "STATE_INVALID",
      { phase_instance: STATE.phase_instance, issue_code: DURABLE_ISSUE_CODES.documentDigestMismatch }
    );
  });

  /**
   * (c) One rank at two array indices. **The index component of the tuple is not observable through
   * the return value**: no parameter of any pinned error code carries a collection path or an index,
   * and no sub-rank in the table emits a different `issue_code` at a different index of the same
   * collection. What is observable — and what these assertions pin — is that adding a *higher*-index
   * violation of the same sub-rank leaves the reported error byte-identical to the lower-index-only
   * subject, which is precisely the behaviour "the lower index is reported" produces.
   */
  it("(c) one rank at two array indices: the reported error is the lower index's", () => {
    const lowerOnly = copy(STATE);
    list(lowerOnly, "authoritative_results")[0] = {
      ...list(lowerOnly, "authoritative_results")[0]!,
      phase_instance: UNDECODABLE,
    };
    const both = copy(lowerOnly);
    list(both, "authoritative_results")[2] = {
      ...list(both, "authoritative_results")[2]!,
      phase_instance: "phase-design-99999999999999999999",
    };
    const higherOnly = copy(STATE);
    list(higherOnly, "authoritative_results")[2] = {
      ...list(higherOnly, "authoritative_results")[2]!,
      phase_instance: "phase-design-99999999999999999999",
    };

    const expected = { issue_code: DURABLE_ISSUE_CODES.phaseInstanceUndecodable };
    expectReject({ state: stateDoc(lowerOnly) }, "CONTRACT_INVALID", expected);
    expectReject({ state: stateDoc(both) }, "CONTRACT_INVALID", expected);
    expectReject({ state: stateDoc(higherOnly) }, "CONTRACT_INVALID", expected);
    expect(reject({ state: stateDoc(both) })).toEqual(reject({ state: stateDoc(lowerOnly) }));
  });

  it("(c') the same, at rank 5a over two output entries", () => {
    const artifact = copy(OUTPUT);
    const outputs = list(artifact, "outputs");
    outputs[0] = { ...outputs[0]!, operation: "rename", previous_path: outputs[0]!.path };
    outputs[1] = { ...outputs[1]!, operation: "rename", previous_path: outputs[1]!.path };
    expectReject({ artifact: artifactDoc(artifact) }, "SNAPSHOT_INVALID", {
      snapshot_digest: OUTPUT.snapshot_digest,
      issue_code: DURABLE_ISSUE_CODES.renamePreviousPathEqualsPath,
    });
  });

  it("(d) two sub-ranks at the same rank and slot with no index to separate them: 7a beats 7b", () => {
    const state = patch(adopting(STATE, TASK_INIT), {
      initialization_digest: FORGED_DIGEST,
      task_id: "definitely-not-demo",
    });
    const observed = reject({ state: stateDoc(state), artifact: artifactDoc(TASK_INIT) });
    expect(observed).toEqual({
      code: "STATE_INVALID",
      parameters: {
        phase_instance: STATE.phase_instance,
        issue_code: DURABLE_ISSUE_CODES.initializationDigestMismatch,
      },
    });
    expect(observed.parameters.issue_code).not.toBe(DURABLE_ISSUE_CODES.artifactTaskIdMismatch);
  });

  /**
   * (e) The design's verification step 10 asks for one subject violating rank 4a **at the artifact
   * root and at `mapping[0]`**, so the collection-path component (`""` sorts below every property
   * name) breaks the tie. **That subject is unconstructible, and this is a finding about the design,
   * not a weakened test.** Rank 4a's artifact-root clause reads `artifact.phase_instance`, which
   * only `document` and `implementation-output` declare; `mapping` exists only on
   * `legacy-import-initialization`, which has **no root `phase_instance` field at all**. The two
   * collection paths are therefore on disjoint artifact kinds and can never tie. The assertions
   * below pin both halves separately, and pin the structural reason the tie cannot be built, so a
   * later phase that adds a root `phase_instance` to an artifact carrying a collection re-opens the
   * case rather than inheriting a silently vacuous claim.
   */
  it("(e) the root-versus-collection tie at rank 4a is unconstructible, and here is why", () => {
    expect(Object.hasOwn(LEGACY_INIT, "phase_instance")).toBe(false);
    expect(Object.hasOwn(LEGACY_INIT, "mapping")).toBe(true);
    expect(Object.hasOwn(DOCUMENT, "phase_instance")).toBe(true);
    expect(Object.hasOwn(DOCUMENT, "mapping")).toBe(false);
    expect(Object.hasOwn(OUTPUT, "phase_instance")).toBe(true);
    expect(Object.hasOwn(OUTPUT, "mapping")).toBe(false);

    const rootClause = patch(DOCUMENT, { phase_instance: UNDECODABLE });
    const collectionClause = copy(LEGACY_INIT);
    list(collectionClause, "mapping")[0] = {
      ...list(collectionClause, "mapping")[0]!,
      phase_instance: UNDECODABLE,
    };
    const expected = { issue_code: DURABLE_ISSUE_CODES.phaseInstanceUndecodable };
    expectReject({ artifact: artifactDoc(rootClause) }, "CONTRACT_INVALID", expected);
    expectReject({ artifact: artifactDoc(collectionClause) }, "CONTRACT_INVALID", expected);
  });

  it("(e') the state slot's root clause (rank 2) precedes its collection clause (rank 4a)", () => {
    // The closest representable root-versus-collection ordering: rank 2 reads `state.phase_instance`
    // at the root, rank 4a walks `state.authoritative_results`.
    const state = patch(STATE, { phase_instance: UNDECODABLE });
    list(state, "authoritative_results")[0] = {
      ...list(state, "authoritative_results")[0]!,
      phase_instance: UNDECODABLE,
    };
    expectReject({ state: stateDoc(state) }, "CONTRACT_INVALID", {
      issue_code: DURABLE_ISSUE_CODES.statePhaseInstanceUndecodable,
    });
  });

  it("is stable across independently constructed but equal subjects", () => {
    const build = (): DurableSemanticSubject => ({
      state: forged<TaskStateV1>(copy(STATE)),
      artifact: forged<DurableArtifact>(copy(OUTPUT)),
    });
    expect(reject(build())).toEqual(reject(build()));
  });
});

/* ----------------------------------------------------------------------- negative-space assertions */

describe("the validator claims nothing its durable subject cannot receive", () => {
  /**
   * `DurableSemanticSubject` has no result-manifest, decision, approval,
   * waiver, authority-link, or evidence slot, so there is no target to resolve any pointer against.
   * Each unresolved pointer has a named later owner: `authoritative_results[*].result_digest` is
   * Phase 10's; `approvals[*].gate_id`, `open_gate.gate_id`, and `waivers[*].gate_id` are Phase 11's.
   */
  it("resolves no authoritative_results[*].result_digest", () => {
    const state = copy(STATE);
    for (const result of list(state, "authoritative_results")) {
      result.result_digest = FORGED_DIGEST;
    }
    expectAccept({ state: stateDoc(state) });
  });

  it("resolves no approvals[*].gate_id, open_gate.gate_id, or waivers[*].gate_id", () => {
    const state = copy(OPEN_GATE_STATE);
    for (const approval of list(state, "approvals")) approval.gate_id = "gate-that-does-not-exist";
    for (const waiver of list(state, "waivers")) waiver.gate_id = "gate-that-does-not-exist";
    (state.open_gate as Json).gate_id = "gate-that-does-not-exist";
    expectAccept({ state: stateDoc(state) });
  });

  it("verifies no bytes behind payload_bytes, payload_digest, or after.oid", () => {
    // In Phase 7 these three fields are assertions; Phase 10 turns them into verified facts. A
    // manifest can be fully internally consistent here and still describe bytes that exist nowhere.
    const artifact = copy(OUTPUT);
    const outputs = list(artifact, "outputs");
    outputs[0] = {
      ...outputs[0]!,
      payload_bytes: 99,
      payload_digest: FORGED_DIGEST,
      after: { oid: "0".repeat(40), mode: "100644", size_bytes: 123456 },
    };
    const accounting = artifact.accounting as Json;
    (accounting.counted_entries as Json[])[0] = {
      ...(accounting.counted_entries as Json[])[0]!,
      stored_bytes: 99,
    };
    accounting.result_bytes = 99;
    expectAccept({ artifact: artifactDoc(artifact) });
  });

  it("verifies no diff_digest, snapshot_digest, index/worktree identity, or secret-scan target", () => {
    expectAccept({
      artifact: artifactDoc(
        patch(OUTPUT, {
          diff_digest: FORGED_DIGEST,
          index_identity_digest: FORGED_DIGEST,
          worktree_identity_digest: FORGED_DIGEST,
        })
      ),
    });
  });

  it("accepts the empty subject", () => {
    expectAccept({});
  });
});

/* ------------------------------------------------------------------------ the pinned literal table */

describe("the pinned issue_code literals", () => {
  const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

  it("are exactly the invariant table's, spelled exactly", () => {
    expect({ ...DURABLE_ISSUE_CODES }).toEqual({
      statePhaseInstanceUndecodable: "state-phase-instance-undecodable",
      documentDigestMismatch: "document-digest-mismatch",
      openGateFrozenStateMismatch: "open-gate-frozen-state-mismatch",
      phaseInstanceUndecodable: "phase-instance-undecodable",
      implementationOutputPhaseKind: "implementation-output-phase-kind",
      renamePreviousPathEqualsPath: "rename-previous-path-equals-path",
      restoreTargetNotDeclared: "restore-target-not-declared",
      accountingResultBytesSum: "accounting-result-bytes-sum",
      accountingTaskBytesBelowResult: "accounting-task-bytes-below-result",
      accountingEntryUnmatched: "accounting-entry-unmatched",
      accountingOutputUnmatched: "accounting-output-unmatched",
      accountingStorageMismatch: "accounting-storage-mismatch",
      accountingStoredBytesMismatch: "accounting-stored-bytes-mismatch",
      initializationDigestMismatch: "initialization-digest-mismatch",
      artifactTaskIdMismatch: "artifact-task-id-mismatch",
      baselineAdoptionApprovalMissing: "baseline-adoption-approval-missing",
      lastTransitionOutcomeDigestMismatch: "last-transition-outcome-digest-mismatch",
      lastTransitionRevisionMismatch: "last-transition-revision-mismatch",
      repositoryIdentityDigestMismatch: "repository-identity-digest-mismatch",
      configDigestMismatch: "config-digest-mismatch",
      workflowDigestMismatch: "workflow-digest-mismatch",
      constitutionDigestMismatch: "constitution-digest-mismatch",
      policyBaseCommitMismatch: "policy-base-commit-mismatch",
      intentReceiptSelfDigestMismatch: "intent-receipt-self-digest-mismatch",
      intentReceiptOutcomeDigestMismatch: "intent-receipt-outcome-digest-mismatch",
      intentReceiptPreparedStateDigestMismatch: "intent-receipt-prepared-state-digest-mismatch",
      intentReceiptRevisionNotSuccessor: "intent-receipt-revision-not-successor",
      intentReceiptFutureRevision: "intent-receipt-future-revision",
      intentReceiptPreparedStateRevisionMismatch: "intent-receipt-prepared-state-revision-mismatch",
      intentReceiptPreparedStateLastTransitionPresent: "intent-receipt-prepared-state-last-transition-present",
      intentReceiptTaskMismatch: "intent-receipt-task-mismatch",
      intentReceiptRepositoryMismatch: "intent-receipt-repository-mismatch",
      intentReceiptInitializationMismatch: "intent-receipt-initialization-mismatch",
      intentReceiptConfigMismatch: "intent-receipt-config-mismatch",
      intentReceiptWorkflowMismatch: "intent-receipt-workflow-mismatch",
      intentReceiptConstitutionMismatch: "intent-receipt-constitution-mismatch",
      intentReceiptPolicyBaseMismatch: "intent-receipt-policy-base-mismatch",
      intentReceiptIntentMismatch: "intent-receipt-intent-mismatch",
      intentReceiptRequestMismatch: "intent-receipt-request-mismatch",
      intentReceiptInputFingerprintMismatch: "intent-receipt-input-fingerprint-mismatch",
      intentReceiptReferenceOutcomeMismatch: "intent-receipt-reference-outcome-mismatch",
      intentReceiptReferenceRevisionMismatch: "intent-receipt-reference-revision-mismatch",
      intentReceiptReferenceResultMismatch: "intent-receipt-reference-result-mismatch",
      intentReceiptFinalStateMismatch: "intent-receipt-final-state-mismatch",
      resultManifestArtifactDigestMismatch: "result-manifest-artifact-digest-mismatch",
      resultManifestTaskMismatch: "result-manifest-task-mismatch",
      resultManifestPhaseMismatch: "result-manifest-phase-mismatch",
      resultManifestStepMismatch: "result-manifest-step-mismatch",
      resultManifestInputFingerprintMismatch: "result-manifest-input-fingerprint-mismatch",
      resultManifestSnapshotMismatch: "result-manifest-snapshot-mismatch",
      resultManifestOutputsMismatch: "result-manifest-outputs-mismatch",
      resultManifestProjectionsMismatch: "result-manifest-projections-mismatch",
      resultManifestAccountingMismatch: "result-manifest-accounting-mismatch",
      resultManifestSecretScanMismatch: "result-manifest-secret-scan-mismatch",
      gateDecisionGateIdMismatch: "gate-decision-gate-id-mismatch",
      gateDecisionTaskMismatch: "gate-decision-task-mismatch",
      gateDecisionPhaseMismatch: "gate-decision-phase-mismatch",
      gateDecisionKindMismatch: "gate-decision-kind-mismatch",
      gateDecisionSubjectMismatch: "gate-decision-subject-mismatch",
      gateDecisionContextMismatch: "gate-decision-context-mismatch",
      gateDecisionEnvelopeMismatch: "gate-decision-envelope-mismatch",
      gateDecisionPayloadInvalid: "gate-decision-payload-invalid",
      waiverDecisionOriginMismatch: "waiver-decision-origin-mismatch",
    });
  });

  it("are all SafeCode, and rank 8 has none", () => {
    for (const code of Object.values(DURABLE_ISSUE_CODES)) expect(code).toMatch(SAFE_CODE);
    expect(Object.values(DURABLE_ISSUE_CODES)).toHaveLength(63);
    expect(Object.values(DURABLE_ISSUE_CODES)).not.toContain("input-fingerprint-mismatch");
  });
});
