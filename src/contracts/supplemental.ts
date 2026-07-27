import { z } from "zod";

import { safeIdV1Schema, type Sha256Digest } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import type { ReviewEvidenceSlot } from "./trust.js";

export interface SupplementalGateRef { readonly prior_gate_id: string; readonly task_id: string; readonly phase_instance: string; readonly subject_digest: Sha256Digest; readonly input_fingerprint: Sha256Digest }
export interface SupplementalReviewRef extends SupplementalGateRef { readonly evidence_slot: Extract<ReviewEvidenceSlot, { role: "gate-counter-review" }> }
export interface GateSupersessionRef { readonly superseded_gate_id: string; readonly accepted_triage_digest: Sha256Digest; readonly old_subject_digest: Sha256Digest }
export type SupplementalReviewOutcome =
  | { readonly action: "decline"; readonly gate: SupplementalGateRef; readonly reason: string }
  | { readonly action: "ingest"; readonly review: SupplementalReviewRef; readonly reason: string }
  | { readonly action: "triage-no-change"; readonly review: SupplementalReviewRef; readonly triage_digest: Sha256Digest; readonly reason: string }
  | { readonly action: "supersede"; readonly review: SupplementalReviewRef; readonly accepted_triage_digest: Sha256Digest; readonly old_subject_digest: Sha256Digest; readonly new_subject_digest: Sha256Digest; readonly reason: string };

const id = safeIdV1Schema;
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, "must contain a non-whitespace character");
const family = z.enum(["claude", "codex"]);
const phase = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u);
const gateShape = { prior_gate_id: id, task_id: id, phase_instance: phase, subject_digest: digest, input_fingerprint: digest };
export const supplementalGateRefSchema = z.object(gateShape).strict();
const gateCounterSlotSchema = z.object({ role: z.literal("gate-counter-review"), evidence_digest: digest, assurance: z.enum(["server-attested", "degraded"]), producer_family: family, reviewer_family: family, independence: z.literal("opposite-family"), gate_id: id }).strict().superRefine((slot, context) => { if (slot.producer_family === slot.reviewer_family) context.addIssue({ code: "custom", message: "gate counter-review must be opposite-family" }); });
export const supplementalReviewRefSchema = z.object({ ...gateShape, evidence_slot: gateCounterSlotSchema }).strict().superRefine((review, context) => { if (review.evidence_slot.gate_id !== review.prior_gate_id) context.addIssue({ code: "custom", path: ["evidence_slot", "gate_id"], message: "gate-counter slot must bind prior_gate_id" }); });
const decline = z.object({ action: z.literal("decline"), gate: supplementalGateRefSchema, reason: nonBlank }).strict();
const ingest = z.object({ action: z.literal("ingest"), review: supplementalReviewRefSchema, reason: nonBlank }).strict();
const noChange = z.object({ action: z.literal("triage-no-change"), review: supplementalReviewRefSchema, triage_digest: digest, reason: nonBlank }).strict();
const supersede = z.object({ action: z.literal("supersede"), review: supplementalReviewRefSchema, accepted_triage_digest: digest, old_subject_digest: digest, new_subject_digest: digest, reason: nonBlank }).strict().superRefine((outcome, context) => {
  if (outcome.old_subject_digest !== outcome.review.subject_digest) context.addIssue({ code: "custom", path: ["old_subject_digest"], message: "old subject must match supplemental review subject" });
  if (outcome.new_subject_digest === outcome.old_subject_digest) context.addIssue({ code: "custom", path: ["new_subject_digest"], message: "new subject must differ" });
});
export const supplementalReviewOutcomeSchema = z.discriminatedUnion("action", [decline, ingest, noChange, supersede]);
export function parseSupplementalReviewOutcome(value: unknown): SupplementalReviewOutcome { assertPlainJson(value, "supplemental review outcome"); return supplementalReviewOutcomeSchema.parse(value); }
