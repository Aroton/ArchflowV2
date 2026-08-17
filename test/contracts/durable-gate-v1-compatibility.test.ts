import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import {
  exactCommitAuthorizationContext,
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  parseGateDecisionRecord,
  parseGateRequest,
} from "../../src/contracts/durable-gate.js";
import { parseGateContext } from "../../src/contracts/gates.js";

const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(
  import.meta.dirname,
  "../fixtures/contracts",
  `${name}.json`,
), "utf8")) as Record<string, unknown>;

const fixture = (name: string): unknown => read(`durable-gate-v1-pre-ad057d3-${name}`);

/** The four-key commit-authorization context archived before 1624fb4 added the exact-commit fields. */
const archivedCommitRequest = (): Record<string, unknown> =>
  read("durable-gate-v1-pre-1624fb4-request-commit-authorization");

/** The same request as a writer would compose it today. */
const currentCommitRequest = (): Record<string, unknown> => {
  const request = archivedCommitRequest();
  return {
    ...request,
    context: {
      ...request.context as Record<string, unknown>,
      baseline_commit: "1".repeat(40),
      commit_message: "ArchFlow: Implement task-1 phase 1",
      paths: ["src/a.ts", "src/b.ts"],
    },
  };
};

describe("durable gate V1 archive compatibility", () => {
  it("reads a retired request supersession without admitting it to the current writer shape", () => {
    const bytes = fixture("request-with-supersedes");
    const archived = parseArchivedGateRequest(bytes);

    expect(archived).toMatchObject({
      gate_id: "gate-legacy-2",
      supersedes: { superseded_gate_id: "gate-legacy-1" },
    });
    expect(archived).toEqual(bytes);
    expect(() => parseGateRequest(bytes)).toThrow();
  });

  it.each([
    ["empty", "decision-empty-supplemental", 0],
    ["non-empty", "decision-nonempty-supplemental", 1],
  ])("reads a retired decided record with a %s supplemental ledger", (_label, name, count) => {
    const bytes = fixture(name);
    const archived = parseArchivedGateDecisionRecord(bytes);

    expect(archived).toMatchObject({ outcome: "decided", supplemental: expect.any(Array) });
    expect("supplemental" in archived && archived.supplemental).toHaveLength(count);
    expect(archived).toEqual(bytes);
    expect(() => parseGateDecisionRecord(bytes)).toThrow();
  });

  it("reads a historical superseded outcome but does not reinterpret it as a decision", () => {
    const bytes = fixture("decision-superseded");
    const archived = parseArchivedGateDecisionRecord(bytes);

    expect(archived).toMatchObject({
      outcome: "superseded",
      supersession: { superseded_gate_id: "gate-legacy-1" },
    });
    expect(archived).toEqual(bytes);
    expect("envelope" in archived).toBe(false);
    expect(() => parseGateDecisionRecord(bytes)).toThrow();
  });

  it("rejects retired ledgers containing a supersession action", () => {
    expect(() => parseArchivedGateDecisionRecord(fixture("decision-malformed-supplemental")))
      .toThrow(/supplemental|discriminator/);
  });

  describe("commit-authorization archived before the exact-commit fields", () => {
    it("reads the four-key context without altering the document or its digest", () => {
      const bytes = archivedCommitRequest();
      const archived = parseArchivedGateRequest(bytes);

      expect(archived).toMatchObject({ gate_id: "gate-legacy-3", kind: "commit-authorization" });
      // Nothing stripped and nothing defaulted: `validateDurableSemantics` re-digests this value
      // against the stored slot digest, so any added or dropped field would fail the contract.
      // Key order is not part of the identity — canonical JSON sorts keys — but the digest is.
      expect(archived).toEqual(bytes);
      expect(canonicalJsonDigest(archived as never)).toBe(canonicalJsonDigest(bytes as never));
    });

    it("still refuses the archived shape to every current writer path", () => {
      const bytes = archivedCommitRequest();

      // Property 1: composing or validating a NEW request is unchanged.
      expect(() => parseGateRequest(bytes)).toThrow();
      expect(() => parseGateContext("commit-authorization", bytes.context)).toThrow();
    });

    it("keeps a current-shape request on the current arm", () => {
      const bytes = currentCommitRequest();

      // Property 3: the compatibility arm is a fallback, never a replacement — a request written
      // today reads identically through both entry points.
      expect(parseGateRequest(bytes)).toEqual(bytes);
      expect(parseArchivedGateRequest(bytes)).toEqual(parseGateRequest(bytes));
      expect(exactCommitAuthorizationContext(
        parseGateContext("commit-authorization", bytes.context),
      )).toBeDefined();
    });

    it("relaxes nothing for any other gate kind", () => {
      // Property 3: the shim is scoped to the one context 1624fb4 changed. `design-approval`
      // carries the same three field names and must keep requiring them.
      const designApproval = read("durable/gate-request.valid");
      expect(parseArchivedGateRequest(designApproval)).toEqual(parseGateRequest(designApproval));

      const { constitution: _c, ...withoutConstitution } = designApproval.context as Record<string, unknown>;
      expect(() => parseArchivedGateRequest({ ...designApproval, context: withoutConstitution })).toThrow();

      // The waiver arm is likewise untouched.
      const waiver = archivedCommitRequest();
      expect(() => parseArchivedGateRequest({
        ...waiver, kind: "constitution-review", allowed_decisions: ["grant", "deny", "cancel"],
      })).toThrow();
    });

    it("reports an archived context as carrying no exact commit", () => {
      const archived = parseArchivedGateRequest(archivedCommitRequest());
      if (archived.kind !== "commit-authorization") throw new Error("expected commit-authorization");

      expect(exactCommitAuthorizationContext(archived.context)).toBeUndefined();
    });

    it.each([
      ["a missing diff_digest", (context: Record<string, unknown>) => {
        delete context.diff_digest;
        return context;
      }],
      ["an unknown extra key", (context: Record<string, unknown>) => ({ ...context, squash: true })],
      ["an empty current_artifact_digests", (context: Record<string, unknown>) => ({ ...context, current_artifact_digests: [] })],
      ["unsorted parent_document_digests", (context: Record<string, unknown>) => ({
        ...context,
        parent_document_digests: [...context.parent_document_digests as string[]].reverse(),
      })],
    ])("still rejects an archived commit-authorization request with %s", (_label, mutate) => {
      // Property 4: the compatibility arm relaxes exactly three requirements and nothing else.
      const bytes = archivedCommitRequest();
      expect(() => parseArchivedGateRequest({
        ...bytes,
        context: mutate(bytes.context as Record<string, unknown>),
      })).toThrow();
    });

    it("still rejects a new-shape request with empty paths", () => {
      const bytes = currentCommitRequest();
      const context = { ...bytes.context as Record<string, unknown>, paths: [] };

      expect(() => parseGateRequest({ ...bytes, context })).toThrow();
      // It matches neither the current arm (empty `paths`) nor the archived arm (`paths` present).
      expect(() => parseArchivedGateRequest({ ...bytes, context })).toThrow();
    });
  });
});
