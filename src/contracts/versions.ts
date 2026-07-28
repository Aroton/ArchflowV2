export const SCHEMA_VERSION = "1" as const;

export const SCHEMA_IDS = {
  primitives: "urn:archflow:schema:v1:primitives",
  phaseInstance: "urn:archflow:schema:v1:phase-instance",
  workflow: "urn:archflow:schema:v1:workflow",
  config: "urn:archflow:schema:v1:config",
  rubric: "urn:archflow:schema:v1:rubric",
  constitutionRule: "urn:archflow:schema:v1:constitution-rule",
  review: "urn:archflow:schema:v1:review",
  reviewEvidence: "urn:archflow:schema:v1:review-evidence",
  adjudication: "urn:archflow:schema:v1:adjudication",
  adjudicationEvidence: "urn:archflow:schema:v1:adjudication-evidence",
  evidenceReference: "urn:archflow:schema:v1:evidence-reference",
  authorityLink: "urn:archflow:schema:v1:authority-link",
  evidenceSlots: "urn:archflow:schema:v1:evidence-slots",
  triage: "urn:archflow:schema:v1:triage",
  supplementalReview: "urn:archflow:schema:v1:supplemental-review",
  gateContract: "urn:archflow:schema:v1:gate-contract",
  gateDecision: "urn:archflow:schema:v1:gate-decision",
  projectError: "urn:archflow:schema:v1:project-error",
  protocolError: "urn:archflow:schema:v1:protocol-error",
  mcpTools: "https://archflow.dev/schemas/v1/mcp-tools",
  resultExpectation: "https://archflow.dev/schemas/v1/result-expectation",
  pathClaim: "urn:archflow:schema:v1:path-claim",
  releaseManifest: "urn:archflow:schema:v1:release-manifest",
  releaseLegalReview: "urn:archflow:schema:v1:release-legal-review"
} as const;
