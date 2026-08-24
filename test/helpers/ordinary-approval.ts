import { parseSafeInteger, parseSha256Digest, type Sha256Digest } from "../../src/contracts/evidence.js";

export type OrdinaryApprovalSubject = "prd" | "design" | "phase-design" | "phase-impl";

/** Complete fresh ordinary-gate policy/trigger facts for tests whose concern lies elsewhere. */
export function ordinaryApprovalFacts(
  subject: OrdinaryApprovalSubject,
  subjectDigest: Sha256Digest = parseSha256Digest("7".repeat(64)),
) {
  return Object.freeze({
    constitution: "pass" as const,
    policy_findings: Object.freeze([]),
    eligible_waivers: Object.freeze([]),
    approval_trigger: Object.freeze({
      kind: "rule-settlement" as const,
      settlement: Object.freeze({
        subject_digest: subjectDigest,
        config_digest: parseSha256Digest("8".repeat(64)),
        settled_at_revision: parseSafeInteger(1),
      }),
      conclusion: Object.freeze({
        wait: true as const,
        match: Object.freeze({ kind: "subject" as const, subject }),
      }),
      rule_authority: "authenticated" as const,
    }),
  });
}
