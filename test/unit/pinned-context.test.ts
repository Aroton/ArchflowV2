import { describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import {
  REVIEW_ENVELOPE_BYTE_CAP,
  ReviewEnvelopeError,
  type DispatchSubject,
  type ReviewEnvelopeInput,
} from "../../src/review/envelopes.js";
import {
  buildReviewEnvelopeWithCap,
  excerptContextEntry,
  importTargetCandidates,
  mentionedRepositoryPaths,
  pinnedContextEntry,
  relativeImportSpecifiers,
  unavailableContextEntry,
  verificationTranscriptEvidence,
} from "../../src/review/pinned-context.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { CurrentProduceSubject } from "../../src/state/produce-subject.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));

const subject = (): DispatchSubject => ({
  task_id: parseTaskSlug("pinned-context"),
  phase_instance: parsePhaseInstanceId("prd"),
  role: "counter-review",
  step: "counter_review",
  subject_digest: digest("a"),
  input_fingerprint: digest("b"),
  rubric_digest: digest("c"),
  producer_family: "claude",
  invocation_id: "invocation-1",
  result_id: "result-1",
});

const input = (context: ReviewEnvelopeInput["context"]): ReviewEnvelopeInput => ({
  artifact: "# PRD\n",
  rubric: {
    schema_version: "1",
    kind: "artifact",
    mode: "adversarial",
    criteria: [{ id: "ask-fidelity", text: "Compare against the pinned ask.", blocking: true }],
  },
  context,
  subject: subject(),
});

describe("pinned context entries", () => {
  it("pins UTF-8 bytes with the digest of exactly those bytes", () => {
    const bytes = new TextEncoder().encode("Build a widget.\n");
    const entry = pinnedContextEntry("user-ask", "ask.md", bytes);
    expect(entry).toEqual({
      kind: "user-ask",
      label: "ask.md",
      status: "pinned",
      content_digest: sha256Bytes(bytes),
      encoding: "utf8",
      content: "Build a widget.\n",
    });
  });

  it("falls back to base64 for non-UTF-8 bytes without changing the digest", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const entry = pinnedContextEntry("user-ask", "ask.md", bytes);
    expect(entry).toMatchObject({
      status: "pinned",
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
      content_digest: sha256Bytes(bytes),
    });
  });

  it("names unavailable evidence instead of omitting it silently", () => {
    expect(unavailableContextEntry("user-ask", "ask.md", "no user-ask declared")).toEqual({
      kind: "user-ask",
      label: "ask.md",
      status: "unavailable",
      note: "no user-ask declared",
    });
  });
});

describe("mechanical extraction", () => {
  it("collects relative import specifiers across the import forms", () => {
    const source = [
      `import { a } from "./sibling.js";`,
      `import "../side-effect.js";`,
      `const lazy = await import("./lazy.js");`,
      `const legacy = require("../legacy.js");`,
      `import { z } from "zod";`,
      `import fs from "node:fs";`,
    ].join("\n");
    expect(relativeImportSpecifiers(source)).toEqual([
      "./sibling.js", "../side-effect.js", "./lazy.js", "../legacy.js",
    ]);
  });

  it("maps compiled-extension imports back to source candidates and rejects escapes", () => {
    expect(importTargetCandidates("src/review/pinned-context.ts", "../contracts/canonical.js"))
      .toEqual(["src/contracts/canonical.js", "src/contracts/canonical.ts"]);
    expect(importTargetCandidates("src/index.ts", "./helpers"))
      .toEqual(["src/helpers", "src/helpers.ts", "src/helpers.js", "src/helpers/index.ts"]);
    expect(importTargetCandidates("src/index.ts", "../../outside.js")).toEqual([]);
  });

  it("extracts backtick path mentions, strips line references, and skips non-paths", () => {
    const text = [
      "The design touches `src/review/envelopes.ts:254` and `src/dispatch/cli.ts`.",
      "Root files like `package.json` qualify too.",
      "It never edits `RubricV1` or `npm run check` or `../escape.ts`.",
      "`src/review/envelopes.ts:254` repeats.",
    ].join("\n");
    expect(mentionedRepositoryPaths(text)).toEqual([
      "src/review/envelopes.ts", "src/dispatch/cli.ts", "package.json",
    ]);
  });

  it("pins small evidence whole and truncates large evidence with the full digest", () => {
    const small = new TextEncoder().encode("short\n");
    expect(excerptContextEntry("interface-excerpt", "src/a.ts", small))
      .toMatchObject({ status: "pinned", content: "short\n" });

    const large = new TextEncoder().encode(`${"x".repeat(30_000)}é`);
    const truncated = excerptContextEntry("interface-excerpt", "src/b.ts", large);
    expect(truncated).toMatchObject({
      status: "truncated",
      content_digest: sha256Bytes(large),
      encoding: "utf8",
      total_byte_count: large.byteLength,
    });
    if (truncated.status === "truncated") {
      expect(truncated.content.length).toBeLessThan(30_000);
    }
  });
});

describe("verificationTranscriptEvidence", () => {
  const TRANSCRIPT = new TextEncoder().encode("$ npm test\nall 12 tests passed\n");
  const implState = {
    task_id: parseTaskSlug("pinned-context"),
    phase_instance: parsePhaseInstanceId("phase-impl-3"),
  } as TaskStateV1;
  const implSubject = (entries: readonly unknown[]): CurrentProduceSubject => ({
    artifact_digest: digest("a"),
    artifact: { artifact_kind: "implementation-output" } as never,
    retained: { projection_plan: { entries } } as never,
  });

  it("lifts the phase transcript from the change set into a typed pinned entry", () => {
    const entries = verificationTranscriptEvidence(implState, implSubject([
      {
        path: ".archflow/tasks/pinned-context/phases/3/verification.txt",
        desired: { state: "present", bytes: TRANSCRIPT },
      },
    ]));
    expect(entries).toEqual([{
      kind: "verification-transcript",
      label: "phases/3/verification.txt",
      status: "pinned",
      content_digest: sha256Bytes(TRANSCRIPT),
      encoding: "utf8",
      content: new TextDecoder().decode(TRANSCRIPT),
    }]);
  });

  it("names an absent transcript instead of omitting it", () => {
    const entries = verificationTranscriptEvidence(implState, implSubject([
      { path: "src/index.ts", desired: { state: "present", bytes: new Uint8Array([65]) } },
    ]));
    expect(entries).toEqual([{
      kind: "verification-transcript",
      label: "phases/3/verification.txt",
      status: "unavailable",
      note: "no verification transcript in the change set; claimed-but-untranscribed verification is an unverifiable claim, not a pass",
    }]);
  });

  it("emits nothing outside implementation phases", () => {
    const documentSubject = {
      artifact_digest: digest("a"),
      artifact: { artifact_kind: "document" } as never,
      retained: {} as never,
    };
    expect(verificationTranscriptEvidence(implState, documentSubject)).toEqual([]);
  });
});

describe("buildReviewEnvelopeWithCap", () => {
  it("drops the lowest-priority droppable entry first and marks it omitted-cap", () => {
    const upstream = pinnedContextEntry("approved-upstream", "prd.md", new TextEncoder().encode("# PRD\n"));
    const conventions = pinnedContextEntry("conventions", "CLAUDE.md", new TextEncoder().encode("c".repeat(400_000)));
    const repoMap = pinnedContextEntry("repo-map", "tree abc", new TextEncoder().encode("m".repeat(800_000)));
    const envelope = buildReviewEnvelopeWithCap(input([upstream, conventions, repoMap]));
    const visible = JSON.parse(new TextDecoder().decode(envelope.bytes)) as {
      context: readonly { kind: string; status: string; content_digest?: string }[];
    };
    expect(visible.context.map((entry) => [entry.kind, entry.status])).toEqual([
      ["approved-upstream", "pinned"],
      ["conventions", "pinned"],
      ["repo-map", "omitted-cap"],
    ]);
    expect(visible.context[2]!.content_digest).toBe(repoMap.status === "pinned" ? repoMap.content_digest : undefined);
  });
  it("passes a fitting envelope through unchanged", () => {
    const entry = pinnedContextEntry("user-ask", "ask.md", new TextEncoder().encode("Ask.\n"));
    const envelope = buildReviewEnvelopeWithCap(input([entry]));
    const visible = JSON.parse(new TextDecoder().decode(envelope.bytes)) as { context: unknown };
    expect(visible.context).toEqual([entry]);
  });

  it("fails closed when a non-droppable entry alone exceeds the cap", () => {
    const oversized = pinnedContextEntry(
      "user-ask",
      "ask.md",
      new TextEncoder().encode("x".repeat(REVIEW_ENVELOPE_BYTE_CAP)),
    );
    expect(() => buildReviewEnvelopeWithCap(input([oversized]))).toThrow(ReviewEnvelopeError);
  });

  it("rethrows non-cap envelope failures untouched", () => {
    const bad = { ...input([]), artifact: 7 as never };
    expect(() => buildReviewEnvelopeWithCap(bad)).toThrow(/artifact must be text/u);
  });
});
