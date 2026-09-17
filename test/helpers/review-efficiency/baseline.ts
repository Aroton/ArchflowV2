/**
 * The historical baseline: loading the captured instruction fixture, composing the
 * historical instruction objects, delivering them through the production file-input renderer,
 * and proving the pair contract.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJsonDigest, parseCanonicalDocument } from "../../../src/contracts/canonical.js";
import type { Sha256Digest } from "../../../src/contracts/evidence.js";
import { assertPlainJson, type PlainJsonValue } from "../../../src/contracts/plain-json.js";
import type { DispatchEnvelope } from "../../../src/review/envelopes.js";
import { prepareReviewInputs, renderReviewPrompt, type ReviewInputConfiguration } from "../../../src/review/inputs.js";

// ---------------------------------------------------------------------------
// Historical baseline fixture
// ---------------------------------------------------------------------------

export type BaselineInstructions = Readonly<{
  provenance: Readonly<{
    source_commit: string;
    envelopes_path: string;
    envelopes_blob: string;
    simple_review_path: string;
    simple_review_blob: string;
    captured: string;
  }>;
  instructions: Readonly<{
    adjudication_enforcement_context: string;
    diff: string;
    document_review: string;
    general_assignment: string;
    implementation_review: string;
    prior_triage: string;
    test_assignment: string;
  }>;
}>;

let cachedBaseline: BaselineInstructions | undefined;

/** Loads and canonically parses the immutable experiment input. */
export async function loadBaselineInstructions(): Promise<BaselineInstructions> {
  if (cachedBaseline !== undefined) return cachedBaseline;
  const path = fileURLToPath(new URL("../../fixtures/review-efficiency/baseline-instructions.json", import.meta.url));
  const bytes = new Uint8Array(await readFile(path));
  const parsed = parseCanonicalDocument(bytes, "baseline instructions fixture");
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("baseline instructions fixture must be an object");
  }
  const record = value as Record<string, PlainJsonValue>;
  if (record.schema_version !== "1") throw new TypeError("baseline instructions fixture must be schema_version 1");
  cachedBaseline = Object.freeze({
    provenance: requireRecord(record.provenance, "provenance") as BaselineInstructions["provenance"],
    instructions: requireRecord(record.instructions, "instructions") as BaselineInstructions["instructions"],
  });
  return cachedBaseline;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): Readonly<Record<string, PlainJsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`baseline instructions ${label} must be an object`);
  }
  return value as Readonly<Record<string, PlainJsonValue>>;
}

// ---------------------------------------------------------------------------
// Historical envelope substitution and pair parity
// ---------------------------------------------------------------------------

export type DigestKind = "dispatch-envelope" | "adjudication-envelope";

// Keep the captured fixture verbatim, but remove its obsolete output request at delivery.
// Both variants use the current production schema; investigation and prose guidance remain
// historical so this measures the combined instruction changes, not a schema mismatch.
const HISTORICAL_REPORT_FORMAT =
  "Prefer a JSON object with one report string; no finding taxonomy, IDs, or ordering are required.";
const CURRENT_FEEDBACK_FORMAT =
  "Return exactly one JSON object with outcome and feedback. Use outcome=issues_found with nonblank actionable feedback, or outcome=no_issues_found with a short explicit confirmation that the reviewed changes have no remaining actionable issues. No finding taxonomy, IDs, or ordering are required.";

/**
 * Rebuilds the historical review envelope's instructions object in the historical assembly order:
 * diff guidance exactly when diffs are present, the surface's review instruction, the role's
 * assignment instruction, and the remediation instruction exactly when a prior-triage record is
 * pinned. Only the obsolete report-format sentence is adapted to the common current schema.
 */
export function historicalReviewInstructions(input: Readonly<{
  baseline: BaselineInstructions;
  rubricKind: "implementation" | "document";
  focus: "general" | "tests";
  hasDiffs: boolean;
  hasPriorTriage: boolean;
}>): Readonly<Record<string, string>> {
  const { baseline, rubricKind, focus, hasDiffs, hasPriorTriage } = input;
  const review = rubricKind === "implementation"
    ? baseline.instructions.implementation_review
    : baseline.instructions.document_review;
  if (!review.includes(HISTORICAL_REPORT_FORMAT)) {
    throw new TypeError("historical review is missing the captured report-format instruction");
  }
  return Object.freeze({
    ...(hasDiffs ? { changes: baseline.instructions.diff } : {}),
    review: review.replace(HISTORICAL_REPORT_FORMAT, CURRENT_FEEDBACK_FORMAT),
    assignment: focus === "tests"
      ? baseline.instructions.test_assignment
      : baseline.instructions.general_assignment,
    ...(hasPriorTriage ? { prior_triage: baseline.instructions.prior_triage } : {}),
  });
}

/**
 * Rebuilds the historical adjudication instructions. The unchanged server literals (rule
 * coverage, uncertainty, trigger, implementation scope) are carried over from the current
 * document; only the enforcement context and diff guidance have historical replacements.
 */
export function historicalAdjudicationInstructions(input: Readonly<{
  baseline: BaselineInstructions;
  currentInstructions: Readonly<Record<string, PlainJsonValue>>;
  hasDiffs: boolean;
}>): Readonly<Record<string, PlainJsonValue>> {
  const { baseline, currentInstructions, hasDiffs } = input;
  const carried = (key: string): PlainJsonValue => {
    const value = currentInstructions[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`current adjudication instructions are missing ${key}`);
    }
    return value;
  };
  return Object.freeze({
    rule_coverage: carried("rule_coverage"),
    ...(hasDiffs ? { changes: baseline.instructions.diff as PlainJsonValue } : {}),
    enforcement_context: baseline.instructions.adjudication_enforcement_context as PlainJsonValue,
    uncertainty: carried("uncertainty"),
    trigger: carried("trigger"),
    ...(currentInstructions.implementation_scope === undefined
      ? {}
      : { implementation_scope: currentInstructions.implementation_scope }),
  });
}

/**
 * Decodes a finished envelope document, lets the caller rewrite exactly the named fields, and
 * regenerates the prompt and file bindings with the production renderer, then seals compact JSON
 * and the canonical digest with the result-kind's domain tag.
 */
export function rewriteEnvelopeDocument(
  envelope: DispatchEnvelope,
  mutate: (document: Record<string, PlainJsonValue>) => void,
  digestKind: DigestKind,
): DispatchEnvelope {
  const document = { ...decodeEnvelopeDocument(envelope) } as Record<string, PlainJsonValue>;
  mutate(document);
  // Rebuild the delivered prompt and file bindings after changing recipe instructions.
  delete document.rendered_inputs;
  const provisional = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  const prepared = prepareReviewInputs({ ...envelope, bytes: provisional, byte_count: provisional.byteLength });
  document.rendered_inputs = {
    prompt: renderReviewPrompt(prepared, `review-inputs/${prepared.reviewer_id}`),
    files: prepared.files.map(({ content: _content, encoding: _encoding, ...file }) => file),
  } as unknown as PlainJsonValue;
  const bytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  const digest = canonicalJsonDigest({ ...document, digest_kind: digestKind });
  return Object.freeze({ result_kind: envelope.result_kind, bytes, digest, byte_count: bytes.byteLength });
}

/**
 * Replaces the selected recipe instructions while preserving its supplied inputs, and seals with
 * {@link rewriteEnvelopeDocument}'s finisher semantics.
 */
export function substituteInstructions(
  envelope: DispatchEnvelope,
  instructions: PlainJsonValue,
  digestKind: DigestKind,
): DispatchEnvelope {
  return rewriteEnvelopeDocument(envelope, (document) => {
    const prepared = prepareReviewInputs(envelope);
    const config = document.review_configuration as unknown as ReviewInputConfiguration;
    config.instructions.historical = Object.values(instructions as Record<string, string>).join("\n\n");
    const phase = config.phases[prepared.phase as keyof typeof config.phases];
    const role = phase.reviewers[prepared.reviewer as keyof typeof phase.reviewers]!;
    role[prepared.mode].instructions = ["base", "historical", ...(["general", "tests"].includes(prepared.reviewer) ? ["rubric"] : []), "response"];
    document.instructions = instructions; // Experiment provenance; delivery uses the recipe above.
  }, digestKind);
}

export function decodeEnvelopeDocument(envelope: DispatchEnvelope): Readonly<Record<string, PlainJsonValue>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.bytes));
  } catch (error) {
    throw new TypeError(`dispatch envelope is not valid UTF-8 JSON: ${(error as Error).message}`);
  }
  assertPlainJson(decoded, "dispatch envelope document");
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("dispatch envelope document must be an object");
  }
  return decoded as Readonly<Record<string, PlainJsonValue>>;
}

/**
 * Decodes an envelope and removes exactly the fields the pair contract normalizes: the whole
 * instruction text/selections and their rendered prompt, and — for adjudication pairs — the derived source-envelope binding at the
 * top level and on the subject. Everything else must survive byte-for-byte/deep equal.
 */
export function normalizedEnvelopeDocument(
  envelope: DispatchEnvelope,
  options?: Readonly<{ normalizeSourceDigest?: boolean }>,
): Readonly<Record<string, PlainJsonValue>> {
  const document = decodeEnvelopeDocument(envelope);
  const clone = JSON.parse(JSON.stringify(document)) as Record<string, PlainJsonValue>;
  delete clone.instructions;
  const config = clone.review_configuration as unknown as ReviewInputConfiguration;
  delete (config as Partial<ReviewInputConfiguration>).instructions;
  for (const phase of Object.values(config.phases)) for (const role of Object.values(phase.reviewers)) {
    for (const recipe of Object.values(role!)) delete (recipe as { instructions?: string[] }).instructions;
  }
  // The prompt derives from the instruction choice; all delivered file bindings remain compared.
  delete (clone.rendered_inputs as Record<string, PlainJsonValue>).prompt;
  if (options?.normalizeSourceDigest === true) {
    delete clone.source_review_envelope_digest;
    const subject = clone.subject;
    if (subject !== null && typeof subject === "object" && !Array.isArray(subject)) {
      delete (subject as Record<string, PlainJsonValue>).source_review_envelope_digest;
    }
  }
  return clone;
}

/**
 * The pair contract: after the normalized fields are removed, current and historical variants of
 * one role must be deep equal, while envelope bytes and digests must differ. Adjudication pairs
 * normalize the derived source-envelope binding, and the caller separately proves each variant's
 * binding equals its actual ordinary-envelope digest.
 */
export function assertPairParity(
  current: DispatchEnvelope,
  historical: DispatchEnvelope,
  options?: Readonly<{ normalizeSourceDigest?: boolean; label?: string }>,
): void {
  const label = options?.label ?? "envelope pair";
  const left = JSON.stringify(normalizedEnvelopeDocument(current, options));
  const right = JSON.stringify(normalizedEnvelopeDocument(historical, options));
  if (left !== right) {
    throw new TypeError(`${label}: variants differ outside the instructions substitution`);
  }
  if (Buffer.compare(Buffer.from(current.bytes), Buffer.from(historical.bytes)) === 0) {
    throw new TypeError(`${label}: variants must not produce identical bytes`);
  }
  if (current.digest === historical.digest) {
    throw new TypeError(`${label}: variants must not produce identical digests`);
  }
}
