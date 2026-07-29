import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import {
  CHAIN_SELECTION_OUTCOMES,
  CHECKPOINT_BREAK_CODES,
  chainAnchor,
  chainHeadBreak,
  checkpointLinkBreak,
  checkpointSelfBreak,
  checkpointSelfDigest,
  parseManualCheckpointImport,
  selectGreatestValidChain,
  type ChainAnchor,
  type ContinuationManualCheckpointV1,
  type ManualCheckpointImportV1,
  type ManualCheckpointV1,
} from "../../src/contracts/durable-checkpoint.js";

const fixture = async (name: string): Promise<ManualCheckpointImportV1> =>
  parseManualCheckpointImport(
    JSON.parse(
      await readFile(new URL(`../fixtures/contracts/durable/${name}`, import.meta.url), "utf8")
    ) as unknown
  );

const initialImport = await fixture("manual-checkpoint-import.valid.json");
if (initialImport.import_mode !== "initial") throw new Error("expected initial import fixture");
const continuationImport = await fixture("manual-checkpoint-import-continuation.valid.json");
if (continuationImport.import_mode !== "continuation") throw new Error("expected continuation import fixture");
const initialAnchor = chainAnchor(initialImport);
const continuationAnchor = chainAnchor(continuationImport);
const initial = initialImport.chain[0]!;
if (!("initialization" in initial)) throw new Error("expected initial checkpoint");
const continuationTemplate = initialImport.chain[1]!;
const clone = <T>(value: T): T => structuredClone(value);
const stateAnchor: ChainAnchor = {
  mode: "state",
  task_id: initial.task_id,
  repository_identity_digest: initial.repository_identity_digest,
  state_anchor: { anchor_kind: "state", state_revision: 4 as never, state_digest: "f".repeat(64) as never },
};
const stateAnchoredFirst = {
  ...clone(continuationTemplate),
  revision: 5 as never,
  state_anchor: stateAnchor.state_anchor,
} as ManualCheckpointV1;
delete (stateAnchoredFirst as { predecessor?: unknown }).predecessor;

const asContinuation = (checkpoint: ManualCheckpointV1): ContinuationManualCheckpointV1 => {
  if (!("predecessor" in checkpoint)) throw new Error("expected continuation checkpoint");
  return checkpoint;
};

const successor = (
  previous: ManualCheckpointV1,
  changes: Partial<ManualCheckpointV1> = {}
): ManualCheckpointV1 =>
  ({
    ...clone(continuationTemplate),
    task_id: previous.task_id,
    repository_identity_digest: previous.repository_identity_digest,
    revision: (previous.revision + 1) as never,
    initialization_digest: previous.initialization_digest,
    predecessor: {
      revision: previous.revision,
      checkpoint_digest: checkpointSelfDigest(previous),
    },
    ...changes,
  }) as ManualCheckpointV1;

const shuffled = (candidates: readonly ManualCheckpointV1[]): ManualCheckpointV1[] =>
  candidates.length < 2 ? [...candidates] : [candidates.at(-1)!, ...candidates.slice(0, -1)];

describe("manual checkpoint chain predicates", () => {
  it("pins the break and selection vocabularies", () => {
    expect(CHECKPOINT_BREAK_CODES).toEqual([
      "import-checkpoint-revision-not-successor",
      "import-chain-gap",
      "import-predecessor-digest-mismatch",
      "import-chain-head-not-revision-one",
      "import-head-predecessor-revision-mismatch",
      "import-head-predecessor-digest-mismatch",
    ]);
    expect(CHAIN_SELECTION_OUTCOMES).toEqual(["gap", "fork", "foreign-candidate"]);
  });

  it("derives the initial and checkpoint-predecessor anchor branches from wrappers", () => {
    expect(initialAnchor).toEqual({
      mode: "initial",
      task_id: initialImport.task_id,
      repository_identity_digest: initialImport.repository_identity_digest,
    });
    expect(continuationAnchor).toEqual({
      mode: "continuation",
      task_id: continuationImport.task_id,
      repository_identity_digest: continuationImport.repository_identity_digest,
      predecessor: continuationImport.predecessor,
    });
  });

  it("validates and selects a state-anchored first checkpoint followed by ordinary links", () => {
    expect(chainHeadBreak(stateAnchor, stateAnchoredFirst)).toBeUndefined();
    expect(checkpointSelfBreak(stateAnchoredFirst)).toBeUndefined();
    const next = successor(stateAnchoredFirst);
    expect(selectGreatestValidChain(stateAnchor, shuffled([next, stateAnchoredFirst]))).toEqual({
      kind: "chain",
      chain: [stateAnchoredFirst, next],
    });
    expect(chainHeadBreak(stateAnchor, { ...stateAnchoredFirst, state_anchor: { ...stateAnchor.state_anchor, state_digest: "0".repeat(64) as never } } as ManualCheckpointV1)).toBe("import-head-predecessor-digest-mismatch");
  });

  it("checks a continuation checkpoint's own predecessor revision", () => {
    const valid = asContinuation(successor(initial));
    expect(checkpointSelfBreak(initial)).toBeUndefined();
    expect(checkpointSelfBreak(valid)).toBeUndefined();
    expect(
      checkpointSelfBreak({
        ...valid,
        revision: valid.revision + 2,
      } as ManualCheckpointV1)
    ).toBe("import-checkpoint-revision-not-successor");
  });

  it("checks adjacent revision before predecessor presence and digest", () => {
    const valid = asContinuation(successor(initial));
    expect(checkpointLinkBreak(initial, valid)).toBeUndefined();
    expect(checkpointLinkBreak(initial, { ...valid, revision: valid.revision + 1 } as ManualCheckpointV1)).toBe(
      "import-chain-gap"
    );

    const revisionZero = { ...initial, revision: 0 } as unknown as ManualCheckpointV1;
    expect(checkpointLinkBreak(revisionZero, initial)).toBe("import-chain-gap");
    expect(
      checkpointLinkBreak(initial, {
        ...valid,
        predecessor: { ...valid.predecessor, checkpoint_digest: "0".repeat(64) as never },
      })
    ).toBe("import-predecessor-digest-mismatch");
  });

  it("checks initial and continuation heads in fixed field order", () => {
    expect(chainHeadBreak(initialAnchor, initial)).toBeUndefined();
    expect(chainHeadBreak(initialAnchor, successor(initial))).toBe("import-chain-head-not-revision-one");

    const first = asContinuation(continuationImport.chain[0]!);
    expect(chainHeadBreak(continuationAnchor, first)).toBeUndefined();
    expect(chainHeadBreak(continuationAnchor, initial)).toBe("import-head-predecessor-revision-mismatch");
    expect(
      chainHeadBreak(continuationAnchor, {
        ...first,
        predecessor: { ...first.predecessor, revision: (first.predecessor.revision + 1) as never },
      })
    ).toBe("import-head-predecessor-revision-mismatch");
    expect(
      chainHeadBreak(continuationAnchor, {
        ...first,
        predecessor: { ...first.predecessor, checkpoint_digest: "0".repeat(64) as never },
      })
    ).toBe("import-head-predecessor-digest-mismatch");
  });
});

describe("greatest valid manual checkpoint chain selection", () => {
  it("links a candidate whose predecessor digest is derived independently", () => {
    const second = asContinuation(successor(initial));
    const independentlyLinked = {
      ...second,
      predecessor: {
        revision: initial.revision as never,
        checkpoint_digest: canonicalJsonDigest(initial),
      },
    };
    expect(selectGreatestValidChain(initialAnchor, shuffled([initial, independentlyLinked]))).toEqual({
      kind: "chain",
      chain: [initial, independentlyLinked],
    });
  });

  it("returns a unique chain in revision order independent of candidate order", () => {
    const second = successor(initial);
    const third = successor(second);
    expect(selectGreatestValidChain(initialAnchor, shuffled([initial, second, third]))).toEqual({
      kind: "chain",
      chain: [initial, second, third],
    });
  });

  it("stops on forks at the head and one step deeper", () => {
    const first = asContinuation(continuationImport.chain[0]!);
    const alternateFirst = { ...first, attempt: first.attempt + 1 } as ManualCheckpointV1;
    expect(selectGreatestValidChain(continuationAnchor, shuffled([first, alternateFirst]))).toEqual({
      kind: "stop",
      outcome: "fork",
    });

    const second = successor(initial);
    const third = successor(second);
    const alternateThird = successor(second, { attempt: third.attempt + 1 as never });
    const result = selectGreatestValidChain(initialAnchor, shuffled([initial, second, third, alternateThird]));
    expect(result).toEqual({ kind: "stop", outcome: "fork" });
    expect(result).not.toEqual({ kind: "chain", chain: [initial, second, third] });
    expect(result).not.toEqual({ kind: "chain", chain: [initial, second, alternateThird] });
  });

  it("stops on material above an unlinkable frontier and when no head links", () => {
    const second = successor(initial);
    const thirdWithoutSecond = successor(second);
    expect(selectGreatestValidChain(initialAnchor, shuffled([initial, thirdWithoutSecond]))).toEqual({
      kind: "stop",
      outcome: "gap",
    });

    const first = continuationImport.chain[0]!;
    const aboveHead = successor(first);
    expect(selectGreatestValidChain(continuationAnchor, shuffled([aboveHead]))).toEqual({
      kind: "stop",
      outcome: "gap",
    });
  });

  it("stops on an unconsumed same-revision collision below the tail", () => {
    const second = successor(initial);
    const collision = {
      ...second,
      predecessor: {
        ...asContinuation(second).predecessor,
        checkpoint_digest: "0".repeat(64) as never,
      },
    } as ManualCheckpointV1;
    const third = successor(second);
    const result = selectGreatestValidChain(initialAnchor, shuffled([initial, second, collision, third]));
    expect(result).toEqual({ kind: "stop", outcome: "gap" });
    expect(result).not.toEqual({ kind: "chain", chain: [initial, second, third] });
  });

  it("returns an empty chain for no candidates and for retained history below the head", () => {
    expect(selectGreatestValidChain(initialAnchor, [])).toEqual({ kind: "chain", chain: [] });

    const second = successor(initial);
    const third = successor(second);
    const historyAnchor: ChainAnchor = {
      mode: "continuation",
      task_id: initial.task_id,
      repository_identity_digest: initial.repository_identity_digest,
      predecessor: { revision: third.revision as never, checkpoint_digest: checkpointSelfDigest(third) },
    };
    expect(selectGreatestValidChain(historyAnchor, shuffled([initial, second, third]))).toEqual({
      kind: "chain",
      chain: [],
    });
  });

  it("stops on foreign task, repository, and linked initialization candidates", () => {
    const foreignTask = { ...initial, task_id: "another-task" as never };
    expect(selectGreatestValidChain(initialAnchor, shuffled([foreignTask]))).toEqual({
      kind: "stop",
      outcome: "foreign-candidate",
    });

    const foreignRepository = { ...initial, repository_identity_digest: "2".repeat(64) as never };
    expect(selectGreatestValidChain(initialAnchor, shuffled([foreignRepository]))).toEqual({
      kind: "stop",
      outcome: "foreign-candidate",
    });

    const second = successor(initial, { initialization_digest: "3".repeat(64) as never });
    expect(selectGreatestValidChain(initialAnchor, shuffled([initial, second]))).toEqual({
      kind: "stop",
      outcome: "foreign-candidate",
    });
  });

  it("stops on a foreign task embedded in the initial head", () => {
    const foreignHead = {
      ...initial,
      initialization: {
        ...clone(initial.initialization),
        task_id: "another-task" as never,
      },
    };
    const second = successor(foreignHead);
    expect(selectGreatestValidChain(initialAnchor, shuffled([foreignHead, second]))).toEqual({
      kind: "stop",
      outcome: "foreign-candidate",
    });
  });

  it("stops on a foreign repository embedded in the initial head", () => {
    const foreignHead = {
      ...initial,
      initialization: {
        ...clone(initial.initialization),
        repository_identity_digest: "4".repeat(64) as never,
      },
    };
    const second = successor(foreignHead);
    expect(selectGreatestValidChain(initialAnchor, shuffled([foreignHead, second]))).toEqual({
      kind: "stop",
      outcome: "foreign-candidate",
    });
  });

  it("applies the self-break quantifier to continuation head candidates", () => {
    const predecessor = { revision: 3 as never, checkpoint_digest: "a".repeat(64) as never };
    const anchor: ChainAnchor = {
      mode: "continuation",
      task_id: initial.task_id,
      repository_identity_digest: initial.repository_identity_digest,
      predecessor,
    };
    const divergent = {
      ...successor(initial),
      revision: 7,
      predecessor,
    } as unknown as ManualCheckpointV1;
    expect(chainHeadBreak(anchor, divergent)).toBeUndefined();
    expect(checkpointSelfBreak(divergent)).toBe("import-checkpoint-revision-not-successor");
    expect(selectGreatestValidChain(anchor, shuffled([divergent]))).toEqual({
      kind: "stop",
      outcome: "gap",
    });
  });
});
