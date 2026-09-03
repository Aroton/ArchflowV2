import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
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
  priorTriageEvidence,
  relativeImportSpecifiers,
  unavailableContextEntry,
  verificationTranscriptEvidence,
} from "../../src/review/pinned-context.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { CurrentProduceSubject } from "../../src/state/produce-subject.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const workspaces: TaskWorkspace[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.dispose(); });

async function transcriptWorkspace(label: string): Promise<TaskWorkspace> {
  const workspace = await createTaskWorkspace({ taskId: "pinned-context", label, operation: label });
  workspaces.push(workspace);
  return workspace;
}

const subject = (): DispatchSubject => ({
  task_id: parseTaskSlug("pinned-context"),
  phase_instance: parsePhaseInstanceId("prd"),
  role: "counter-review",
  step: "counter_review",
  attempt: parseSafeInteger(1),
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
  const implSubject = (evidence = { transcript_digest: sha256Bytes(TRANSCRIPT), byte_count: TRANSCRIPT.byteLength }): CurrentProduceSubject => ({
    artifact_digest: digest("a"),
    artifact: { artifact_kind: "implementation-output", verification_evidence: evidence } as never,
    reference: {} as never,
    retained: {} as never,
  });

  it("lifts the digest-bound workspace transcript into a typed pinned entry", async () => {
    const h = await transcriptWorkspace("pinned-transcript");
    const directory = join(h.services.authority.workspace_root, "cache", "phases", "3");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "verification.txt"), TRANSCRIPT);
    const entries = await verificationTranscriptEvidence(h.services.runner, h.services.authority, implState, implSubject());
    expect(entries).toEqual([{
      kind: "verification-transcript",
      label: "cache/phases/3/verification.txt",
      status: "pinned",
      content_digest: sha256Bytes(TRANSCRIPT),
      encoding: "utf8",
      content: new TextDecoder().decode(TRANSCRIPT),
    }]);
  });

  it("names an absent transcript instead of omitting it", async () => {
    const h = await transcriptWorkspace("missing-transcript");
    const entries = await verificationTranscriptEvidence(h.services.runner, h.services.authority, implState, implSubject());
    expect(entries).toEqual([{
      kind: "verification-transcript",
      label: "cache/phases/3/verification.txt",
      status: "unavailable",
      note: "verification transcript cache is absent; rerun verification before requesting review",
    }]);
  });

  it("emits nothing outside implementation phases", async () => {
    const h = await transcriptWorkspace("document-transcript");
    const documentSubject = {
      artifact_digest: digest("a"),
      artifact: { artifact_kind: "document" } as never,
      reference: {} as never,
      retained: {} as never,
    };
    await expect(verificationTranscriptEvidence(h.services.runner, h.services.authority, implState, documentSubject)).resolves.toEqual([]);
  });
});

describe("priorTriageEvidence", () => {
  const PHASE = parsePhaseInstanceId("design");
  const REVIEW_DIGEST = digest("e");
  const reference = (step: string, resultDigest: string) => ({
    phase_instance: PHASE, step, result_digest: resultDigest,
    result_id: `result-${step.replace("_", "-")}`, input_fingerprint: digest("b"),
  });
  const installation = (manifest: Record<string, unknown>) =>
    ({ prepared: { manifest: { value: manifest } } }) as never;
  const reviewManifest = {
    artifact_digest: REVIEW_DIGEST,
    source_artifact: {
      artifact_kind: "review-evidence",
      evidence: {
        findings: [
          { finding_id: "digest-drift", severity: "blocker", blocking: true, summary: "Digest recomputation skips the slot check.", evidence: "The slot is read after hashing.", suggested_resolution: "Recompute after the slot check." },
          { finding_id: "naming-nit", severity: "minor", blocking: false, summary: "Rename the helper.", evidence: "The name differs from a convention.", suggested_resolution: "Rename it." },
          { finding_id: "style-note", severity: "minor", blocking: false, summary: "Editorial wording.", evidence: "The sentence is awkward.", suggested_resolution: "Reword it." },
        ],
      },
    },
  };
  const triageManifest = (dispositions: readonly Record<string, unknown>[]) => ({
    artifact_digest: digest("f"),
    source_artifact: { artifact_kind: "triage", evidence: { dispositions } },
  });
  const state = (results: readonly unknown[]) => ({
    task_id: parseTaskSlug("pinned-context"),
    phase_instance: PHASE,
    attempt: parseSafeInteger(2),
    authoritative_results: results,
  }) as unknown as TaskStateV1;
  const loader = (byStep: Record<string, unknown>) => ({
    load_retained_result: (candidate: { step: string }) => Promise.resolve(
      byStep[candidate.step] === undefined
        ? { schema_version: "1", ok: false, error: { code: "IO_ERROR" } }
        : { schema_version: "1", ok: true, value: byStep[candidate.step] },
    ),
  }) as never;

  it("pins nothing when no triage result is retained for this phase instance", async () => {
    const first = await priorTriageEvidence(loader({}), state([reference("produce", "1".repeat(64))]));
    expect(first).toMatchObject({ ok: true, value: [] });
    const noLoader = await priorTriageEvidence(
      { load_retained_result: undefined } as never,
      state([reference("triage", "2".repeat(64))]),
    );
    expect(noLoader).toMatchObject({ ok: true, value: [] });
  });

  it("projects only the latest accepted dispositions with reviewer-authored findings", async () => {
    const result = await priorTriageEvidence(
      loader({
        triage: installation(triageManifest([
          { review_evidence_digest: REVIEW_DIGEST, finding_id: "digest-drift", disposition: "accepted", rationale: "Real defect.", revision_intent: "Recompute after the slot check." },
          { review_evidence_digest: REVIEW_DIGEST, finding_id: "naming-nit", disposition: "rejected", rationale: "envelope-gap: name matches the convention.", evidence: "See CLAUDE.md." },
          { review_evidence_digest: REVIEW_DIGEST, finding_id: "style-note", disposition: "accepted-editorial", rationale: "Wording only." },
          { review_evidence_digest: digest("9"), finding_id: "older-extra", disposition: "rejected", rationale: "From older review evidence." },
        ])),
        counter_review: installation(reviewManifest),
      }),
      state([reference("counter_review", "3".repeat(64)), reference("triage", "2".repeat(64))]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const entry = result.value[0]!;
    expect(entry).toMatchObject({ kind: "prior-triage", label: "prior-round-triage", status: "pinned" });
    if (entry.status !== "pinned") return;
    expect(entry.content_digest).toBe(sha256Bytes(new TextEncoder().encode(entry.content)));
    const record = JSON.parse(entry.content) as {
      record_kind: string; current_attempt: number; dispositions: readonly Record<string, unknown>[];
    };
    expect(record.record_kind).toBe("prior-triage");
    expect(record.current_attempt).toBe(2);
    expect(record.dispositions).toEqual([
      {
        finding_id: "digest-drift", attempt: 2, severity: "blocker", blocking: true,
        summary: "Digest recomputation skips the slot check.",
        evidence: "The slot is read after hashing.",
        suggested_resolution: "Recompute after the slot check.",
        disposition: "accepted", rationale: "Real defect.",
        revision_intent: "Recompute after the slot check.",
      },
    ]);
  });

  it("preserves native V2 taxonomy details in remediation history", async () => {
    const result = await priorTriageEvidence(
      loader({
        triage: installation(triageManifest([
          { review_evidence_digest: REVIEW_DIGEST, finding_id: "digest-risk", disposition: "accepted", rationale: "Material risk.", revision_intent: "Bind the slot before hashing." },
        ])),
        counter_review: installation({
          artifact_digest: REVIEW_DIGEST,
          source_artifact: {
            artifact_kind: "review-evidence",
            evidence: {
              schema_version: "2",
              findings: [{
                finding_id: "digest-risk", claim_type: "risk", confidence: "likely",
                falsifier: "Run the slot-race test and observe a stable digest.",
                summary: "The digest can race the slot read.", evidence: "The slot is read after hashing.",
                suggested_resolution: "Bind the slot before hashing.",
              }],
            },
          },
        }),
      }),
      state([reference("counter_review", "3".repeat(64)), reference("triage", "2".repeat(64))]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value[0]!;
    if (entry.status !== "pinned") throw new Error("expected pinned prior triage");
    const record = JSON.parse(entry.content) as { dispositions: readonly Record<string, unknown>[] };
    expect(record.dispositions).toEqual([{
      finding_id: "digest-risk", attempt: 2, claim_type: "risk", confidence: "likely",
      falsifier: "Run the slot-race test and observe a stable digest.",
      summary: "The digest can race the slot read.", evidence: "The slot is read after hashing.",
      suggested_resolution: "Bind the slot before hashing.", disposition: "accepted",
      rationale: "Material risk.", revision_intent: "Bind the slot before hashing.",
    }]);
  });

  it("does not expose the cumulative disposition ledger to a remediation child", async () => {
    const result = await priorTriageEvidence(
      loader({
        triage: installation({
          artifact_digest: digest("f"),
          source_artifact: {
            artifact_kind: "triage",
            evidence: {
              dispositions: [
                { review_evidence_digest: REVIEW_DIGEST, finding_id: "digest-drift", disposition: "accepted", rationale: "Round two disposition.", revision_intent: "Recompute after the slot check." },
              ],
              disposition_ledger: [
                { review_evidence_digest: digest("9"), finding_id: "older-round", disposition: "rejected", rationale: "Older rejection.", evidence: "Older rejection evidence.", attempt: 1, severity: "major", blocking: false, summary: "Older summary.", suggested_resolution: "Older resolution." },
                { review_evidence_digest: REVIEW_DIGEST, finding_id: "digest-drift", disposition: "accepted", rationale: "Carried embed.", revision_intent: "Recompute after the slot check.", attempt: 2, severity: "blocker", blocking: true, summary: "Digest recomputation skips the slot check.", evidence: "The slot is read after hashing.", suggested_resolution: "Recompute after the slot check." },
              ],
            },
          },
        }),
      }),
      state([reference("triage", "2".repeat(64))]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const entry = result.value[0]!;
    if (entry.status !== "pinned") return;
    const record = JSON.parse(entry.content) as {
      coverage: string;
      dispositions: readonly Record<string, unknown>[];
    };
    expect(record.coverage).toContain("latest accepted findings");
    expect(record.dispositions).toEqual([
      {
        finding_id: "digest-drift", attempt: 2,
        disposition: "accepted", rationale: "Round two disposition.",
        revision_intent: "Recompute after the slot check.",
      },
    ]);
  });

  it("pins no remediation context when the latest triage has no accepted findings", async () => {
    const result = await priorTriageEvidence(
      loader({
        triage: installation(triageManifest([
          { review_evidence_digest: REVIEW_DIGEST, finding_id: "naming-nit", disposition: "rejected", rationale: "Not applicable." },
          { review_evidence_digest: REVIEW_DIGEST, finding_id: "style-note", disposition: "accepted-editorial", rationale: "Wording only." },
        ])),
        counter_review: installation(reviewManifest),
      }),
      state([reference("counter_review", "3".repeat(64)), reference("triage", "2".repeat(64))]),
    );
    expect(result).toMatchObject({ ok: true, value: [] });
  });

  it("fails closed when a referenced manifest cannot be loaded or has the wrong kind", async () => {
    const unloadable = await priorTriageEvidence(
      loader({}),
      state([reference("triage", "2".repeat(64))]),
    );
    expect(unloadable).toMatchObject({ ok: false, error: { code: "IO_ERROR" } });

    const wrongKind = await priorTriageEvidence(
      loader({ triage: installation(reviewManifest) }),
      state([reference("triage", "2".repeat(64))]),
    );
    expect(wrongKind).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "prior-triage-artifact-invalid" } } },
    });
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
  it("never drops the prior-triage record for the cap: an envelope that cannot hold it fails closed", () => {
    const upstream = pinnedContextEntry("approved-upstream", "prd.md", new TextEncoder().encode("# PRD\n"));
    const priorTriage = pinnedContextEntry(
      "prior-triage", "prior-round-triage", new TextEncoder().encode("t".repeat(1_100_000)),
    );
    expect(() => buildReviewEnvelopeWithCap(input([upstream, priorTriage]))).toThrow();
  });

  it("sacrifices mechanical evidence to the cap before the prior-triage record", () => {
    const priorTriage = pinnedContextEntry(
      "prior-triage", "prior-round-triage", new TextEncoder().encode("t".repeat(400_000)),
    );
    const repoMap = pinnedContextEntry("repo-map", "tree abc", new TextEncoder().encode("m".repeat(800_000)));
    const envelope = buildReviewEnvelopeWithCap(input([priorTriage, repoMap]));
    const visible = JSON.parse(new TextDecoder().decode(envelope.bytes)) as {
      context: readonly { kind: string; status: string }[];
    };
    expect(visible.context.map((entry) => [entry.kind, entry.status])).toEqual([
      ["prior-triage", "pinned"],
      ["repo-map", "omitted-cap"],
    ]);
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
