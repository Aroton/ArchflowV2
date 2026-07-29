import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import {
  approvalRefV1Schema,
  authoritativeResultRefV1Schema,
  checkpointSelfDigest,
  evidenceChainEntryV1Schema,
  manualCheckpointImportV1Schema,
  manualCheckpointV1Schema,
  openGateRefV1Schema,
  parseManualCheckpoint,
  parseManualCheckpointImport,
  predecessorLinkV1Schema,
  stateAnchorV1Schema,
  projectionDigestRefV1Schema,
  waiverRefV1Schema,
  type ContinuationManualCheckpointV1,
  type ManualCheckpointV1,
  type ManualCheckpointImportV1,
} from "../../src/contracts/durable-checkpoint.js";
import { parseSafeInteger } from "../../src/contracts/evidence.js";
import { currentEvidenceSetRefSchema } from "../../src/contracts/trust.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

const references = async (): Promise<object[]> =>
  Promise.all([
    schema("primitives"),
    schema("path-claim"),
    schema("durable-primitives"),
    schema("task-state"),
    schema("task-initialization"),
    schema("legacy-import-initialization"),
    schema("evidence-slots"),
  ]);

const validator = async () =>
  createJsonSchemaValidator<ManualCheckpointV1>(await schema("manual-checkpoint"), await references());

const importValidator = async () =>
  createJsonSchemaValidator<ManualCheckpointImportV1>(
    await schema("manual-checkpoint-import"),
    [await schema("manual-checkpoint"), ...(await references())]
  );

const defValidator = async <T>(name: string) =>
  createJsonSchemaValidator<T>(
    { "$ref": `urn:archflow:schema:v1:manual-checkpoint#/$defs/${name}` },
    [await schema("manual-checkpoint"), ...(await references())]
  );

const taskStateDefValidator = async <T>(name: string) =>
  createJsonSchemaValidator<T>(
    { "$ref": `urn:archflow:schema:v1:task-state#/$defs/${name}` },
    [await schema("task-state"), await schema("primitives"), await schema("path-claim")]
  );

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/contracts/durable/manual-checkpoint.valid.json", import.meta.url), "utf8")
) as Record<string, unknown>;

const importFixture = JSON.parse(
  await readFile(new URL("../fixtures/contracts/durable/manual-checkpoint-import.valid.json", import.meta.url), "utf8")
) as Record<string, unknown>;

const continuationImportFixture = JSON.parse(
  await readFile(
    new URL("../fixtures/contracts/durable/manual-checkpoint-import-continuation.valid.json", import.meta.url),
    "utf8"
  )
) as Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

const continuation = (): Record<string, unknown> => {
  const value = clone(fixture);
  delete value.initialization;
  value.revision = 2;
  value.predecessor = {
    revision: 1,
    checkpoint_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
  return value;
};

const stateAnchored = (): Record<string, unknown> => {
  const value = continuation();
  delete value.predecessor;
  value.revision = 5;
  value.state_anchor = { anchor_kind: "state", state_revision: 4, state_digest: "f".repeat(64) };
  return value;
};

const parsedContinuation = parseManualCheckpoint(continuation());
if (!("predecessor" in parsedContinuation)) throw new TypeError("continuation fixture must carry a predecessor");
const positiveTypedContinuation: ContinuationManualCheckpointV1 = parsedContinuation;
const { revision: _continuationRevision, ...continuationWithoutRevision } = positiveTypedContinuation;
const brandedRevisionOne = parseSafeInteger(1);
// @ts-expect-error a predecessor-bearing checkpoint requires a revision proven to be at least 2
const revisionOneWithPredecessor: ManualCheckpointV1 = { ...continuationWithoutRevision, revision: brandedRevisionOne };
void revisionOneWithPredecessor;

const rejectedBoth = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(false);
  expect(manualCheckpointV1Schema.safeParse(value).success).toBe(false);
};

const importRejectedBoth = async (value: unknown): Promise<void> => {
  const jsonValidator = await importValidator();
  expect(jsonValidator.validate(value)).toBe(false);
  expect(manualCheckpointImportV1Schema.safeParse(value).success).toBe(false);
};

describe("manual checkpoint contract", () => {
  it("round-trips and parses the initial fixture in both authorities", async () => {
    const jsonValidator = await validator();
    expect(jsonValidator.validate(fixture), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
    expect(assertZodAgreement(fixture, jsonValidator, manualCheckpointV1Schema)).toBe(fixture);
    expect(parseManualCheckpoint(fixture)).toEqual(fixture);
  });

  it("accepts the continuation branch in both authorities", async () => {
    const value = continuation();
    const jsonValidator = await validator();
    expect(assertZodAgreement(value, jsonValidator, manualCheckpointV1Schema)).toBe(value);
    expect(parseManualCheckpoint(value)).toEqual(value);
  });

  it("accepts the strict state-anchored first-checkpoint branch", async () => {
    const value = stateAnchored();
    expect(assertZodAgreement(value, await validator(), manualCheckpointV1Schema)).toBe(value);
    expect(assertZodAgreement(value.state_anchor, await defValidator("stateAnchor"), stateAnchorV1Schema)).toBe(value.state_anchor);
    await rejectedBoth({ ...value, predecessor: continuation().predecessor });
    await rejectedBoth({ ...value, state_anchor: { ...(value.state_anchor as object), extra: true } });
  });

  it("derives the self digest from the whole checkpoint", () => {
    const checkpoint = parseManualCheckpoint(fixture);
    expect(checkpointSelfDigest(checkpoint)).toBe(canonicalJsonDigest(checkpoint));
    expect(checkpointSelfDigest({ ...checkpoint, attempt: 2 as never })).not.toBe(checkpointSelfDigest(checkpoint));
  });

  it("agrees for the four task-state-owned reference mirrors", async () => {
    const cases = [
      ["authoritativeResultRef", authoritativeResultRefV1Schema, (fixture.authoritative_results as unknown[])[0]],
      ["approvalRef", approvalRefV1Schema, (fixture.approvals as unknown[])[0]],
      ["waiverRef", waiverRefV1Schema, (fixture.waivers as unknown[])[0]],
      ["openGateRef", openGateRefV1Schema, fixture.open_gate],
    ] as const;
    for (const [name, mirror, sample] of cases) {
      expect(assertZodAgreement(sample, await taskStateDefValidator(name), mirror)).toBe(sample);
    }
  });

  it("agrees for the four manual-checkpoint-owned reference mirrors", async () => {
    const continued = continuation();
    const evidence = (fixture.evidence_chain as Record<string, unknown>[])[0]!;
    const cases = [
      ["predecessorLink", predecessorLinkV1Schema, continued.predecessor],
      ["projectionDigestRef", projectionDigestRefV1Schema, (fixture.projections as unknown[])[0]],
      ["evidenceChainEntry", evidenceChainEntryV1Schema, evidence],
      ["currentEvidenceSetRef", currentEvidenceSetRefSchema, evidence.current_evidence],
    ] as const;
    for (const [name, mirror, sample] of cases) {
      expect(assertZodAgreement(sample, await defValidator(name), mirror)).toBe(sample);
    }
  });

  it("requires initialization and forbids predecessor at revision 1", async () => {
    const missing = clone(fixture);
    delete missing.initialization;
    await rejectedBoth(missing);
    await rejectedBoth({
      ...fixture,
      predecessor: {
        revision: 1,
        checkpoint_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });
  });

  it("requires predecessor and forbids initialization at revision 2 or later", async () => {
    await rejectedBoth({ ...fixture, revision: 2 });
    await rejectedBoth({ ...continuation(), initialization: fixture.initialization });
  });

  it("rejects unknown root fields and zero in each positive root field", async () => {
    await rejectedBoth({ ...fixture, self_digest: "0".repeat(64) });
    await rejectedBoth({ ...fixture, revision: 0 });
    await rejectedBoth({ ...fixture, attempt: 0 });
  });

  it("rejects shuffled and duplicate members of every declared set", async () => {
    for (const field of ["authoritative_results", "projections", "evidence_chain", "approvals", "waivers"] as const) {
      const members = fixture[field] as unknown[];
      await rejectedBoth({ ...fixture, [field]: [...members].reverse() });
      await rejectedBoth({ ...fixture, [field]: [members[0], members[0]] });
    }
  });

  it("composes the evidence-slot family rules in both authorities", async () => {
    const evidence = clone(fixture.evidence_chain as Record<string, unknown>[]);
    const current = evidence[0]!.current_evidence as Record<string, unknown>;
    const slots = clone(current.slots as Record<string, unknown>[]);
    slots[1] = { ...slots[1], reviewer_family: slots[1]!.producer_family };
    current.slots = slots;
    await rejectedBoth({ ...fixture, evidence_chain: evidence });
  });
});

describe("manual checkpoint import contract", () => {
  it("round-trips and parses both import modes in both authorities", async () => {
    const jsonValidator = await importValidator();
    for (const sample of [importFixture, continuationImportFixture]) {
      expect(jsonValidator.validate(sample), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
      expect(assertZodAgreement(sample, jsonValidator, manualCheckpointImportV1Schema)).toBe(sample);
      expect(parseManualCheckpointImport(sample)).toEqual(sample);
    }
  });

  it("round-trips the state-anchored import mode and closes its branch fields", async () => {
    const stateAnchor = (stateAnchored().state_anchor as Record<string, unknown>);
    const value = {
      ...importFixture,
      import_mode: "state-anchored",
      chain: [stateAnchored()],
      state_anchor: stateAnchor,
    };
    expect(assertZodAgreement(value, await importValidator(), manualCheckpointImportV1Schema)).toBe(value);
    expect(parseManualCheckpointImport(value)).toEqual(value);
    await importRejectedBoth({ ...value, predecessor: continuationImportFixture.predecessor });
    await importRejectedBoth({ ...value, expected_state_revision: 4 });
  });

  it("requires each continuation-only field in continuation mode", async () => {
    for (const field of ["predecessor", "expected_state_revision", "expected_state_digest"] as const) {
      const value = clone(continuationImportFixture);
      delete value[field];
      await importRejectedBoth(value);
    }
  });

  it("forbids each continuation-only field individually in initial mode", async () => {
    for (const field of ["predecessor", "expected_state_revision", "expected_state_digest"] as const) {
      await importRejectedBoth({ ...importFixture, [field]: continuationImportFixture[field] });
    }
  });

  it("rejects duplicate revisions while accepting the pinned two-checkpoint chains", async () => {
    for (const sample of [importFixture, continuationImportFixture]) {
      const chain = clone(sample.chain as Record<string, unknown>[]);
      chain[1] = clone(chain[0]!);
      await importRejectedBoth({ ...sample, chain });
    }
  });

  it("rejects an empty chain, non-positive expected revision, and unknown fields", async () => {
    await importRejectedBoth({ ...importFixture, chain: [] });
    await importRejectedBoth({ ...continuationImportFixture, expected_state_revision: 0 });
    await importRejectedBoth({ ...importFixture, extra: true });

    const predecessor = {
      ...(continuationImportFixture.predecessor as Record<string, unknown>),
      extra: true,
    };
    await importRejectedBoth({ ...continuationImportFixture, predecessor });
  });
});
