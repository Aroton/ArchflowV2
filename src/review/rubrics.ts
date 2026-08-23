import { canonicalJsonDigest } from "../contracts/canonical.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { parseRubricV1, type RubricV1 } from "../contracts/rubric.js";

export type CounterReviewPhaseKind = "prd" | "design" | "phase-design" | "phase-impl";
export type CanonicalRubricId = "prd-v1" | "design-v2" | "implementation-v1";

export type CanonicalRubric = Readonly<{
  rubric_id: CanonicalRubricId;
  rubric_digest: Sha256Digest;
  rubric: RubricV1;
}>;

function canonicalRubric(rubricId: CanonicalRubricId, value: unknown): CanonicalRubric {
  const rubric = parseRubricV1(value);
  const frozen = Object.freeze({
    ...rubric,
    criteria: Object.freeze(rubric.criteria.map((criterion) => Object.freeze({ ...criterion }))),
  });
  return Object.freeze({
    rubric_id: rubricId,
    rubric_digest: canonicalJsonDigest(frozen),
    rubric: frozen,
  });
}

const PRD_RUBRIC = canonicalRubric("prd-v1", {
  schema_version: "1", kind: "artifact", mode: "adversarial", criteria: [
    { id: "substantive-correctness", text: "Report a finding only for a material defect: leaving the artifact unchanged is reasonably likely to change a downstream design, implementation, verification, or approval decision, or create an important product, reliability, security, or workflow risk. A blocking finding must cite the exact artifact, pinned, or repository evidence; name the concrete downstream consequence; and explain why it survives the stated non-goals and priority order. Wording is blocking only when it permits materially different reasonable interpretations. If prior-triage is present, make verification of the accepted revision intents the primary task; report a previously undiscovered issue only when it clears the same materiality bar. A challenge to a prior disposition is blocking only when its revision intent was not carried out or the change introduced a material defect. Do not report optional polish, harmless wording refinements, stylistic preferences, or other observations that would not materially change an outcome.", blocking: true },
    { id: "ask-fidelity", text: "Compare the PRD against the pinned ask record: the verbatim original request and every recorded clarification question and answer. Report only an omitted need, unexplained exclusion, or contradiction reasonably likely to materially change what is designed, implemented, or accepted. If the ask is not pinned, do not infer it; use unverifiable-claims only when the gap prevents a material judgment.", blocking: true },
    { id: "proportionality", text: "Report only substantial scope, machinery, or process that the pinned ask does not justify and that would materially change cost, architecture, delivery, or user outcome. Do not report minor simplifications or preferred alternatives.", blocking: true },
    { id: "testable-requirements", text: "Report a defect only when a requirement permits materially different reasonable interpretations or prevents meaningful verification of an important outcome. Do not request extra specificity when a reasonable implementer and verifier would reach the same result.", blocking: true },
    { id: "stated-assumptions", text: "Report only an unstated assumption or unresolved human choice that could materially change scope, behavior, acceptance, or risk; harmless implementation latitude is not a finding.", blocking: true },
    { id: "unverifiable-claims", text: "When missing envelope or read-only repository evidence prevents a material judgment, record one non-blocking finding naming the claim and missing evidence, with a finding_id beginning unverifiable-. Never guess. An explicit assumption is handled under stated-assumptions. Omit gaps that cannot materially affect the review, report each material gap once, and do not re-report one already named in prior-triage.", blocking: false },
    { id: "advisory-observations", text: "Do not report non-material observations, optional improvements, completeness suggestions, stylistic preferences, or harmless prose refinements. A sound, decision-ready artifact should return no findings rather than a list of possible enhancements.", blocking: false },
  ],
});

const DESIGN_RUBRIC = canonicalRubric("design-v2", {
  schema_version: "1", kind: "artifact", mode: "adversarial", criteria: [
    { id: "substantive-correctness", text: "Report a finding only for a material defect: leaving the artifact unchanged is reasonably likely to change downstream behavior, implementation, verification, delivery, or important risk. A blocking finding must cite exact artifact, pinned, or repository evidence; name the concrete consequence; and explain why it survives stated non-goals and priorities. Wording is blocking only when it permits materially different reasonable interpretations. If prior-triage is present, make verification of accepted revision intents the primary task; report a previously undiscovered issue only when it clears the same materiality bar. Challenge a prior disposition only when its revision intent was not carried out or the change introduced a material defect. Do not report optional polish or preferred alternatives without a material consequence.", blocking: true },
    { id: "upstream-coverage", text: "Report only an upstream requirement that is materially unmapped or contradicted, or a substantial design element with no upstream purpose. Do not report traceability polish that would not change the design or its verification.", blocking: true },
    { id: "interface-reality", text: "Report a repository or interface claim only when pinned or repository evidence materially contradicts it. Use unverifiable-claims only when missing evidence prevents a material judgment.", blocking: true },
    { id: "evidence-completeness", text: "Report an unaddressed adjacent component only when the omission is reasonably likely to break a stated design element, interface, verification result, or important risk boundary.", blocking: true },
    { id: "proportionality", text: "Report only layers, abstractions, phases, or machinery for unstated futures when they would materially increase complexity, cost, delivery time, or maintenance risk. Do not report minor simplifications or stylistic preferences.", blocking: true },
    { id: "phase-plan-soundness", text: "Report a phase-plan ordering, sizing, scope, boundary, or verification defect only when leaving it unchanged is reasonably likely to materially harm implementation, verification, review, delivery, or create an important risk. For architecture design, require an inspectable split-and-merge sizing attempt: each finite phase has one coherent repository-ready outcome, a valid completion state, explicit predecessors or stable inputs, and one meaningful verification story; consider splitting bundled independently implementable or verifiable outcomes and merging scaffolding, file-, type-, or layer-only fragments without a stable checkpoint. Require concrete atomicity, repository-validity, inseparable-verification, stable-interface, or risk-reduction value for a retained unusually broad or small phase. For a genuinely open-ended plan, require an explanation of why responsible boundaries cannot yet be named and what information will enable decomposition; report using the marker merely to avoid the sizing attempt. For numbered phase design, perform only the bounded fit check against concrete repository, interface, dependency, risk, and verification evidence: preserve a sound approved boundary, but report when a material split or merge is needed and the producer neither corrects the writable parent through the reviewed path nor follows returned authority. Phase count, layer count, file count, diff size, and reviewer preference are not dispositive; report a defect only with its concrete consequence.", blocking: true },
    { id: "unverifiable-claims", text: "When missing pinned or read-only repository evidence prevents a material judgment, record one non-blocking finding naming the claim and missing file or interface, with a finding_id beginning unverifiable-. Never guess. Omit gaps that cannot materially affect the review, report each material gap once, and do not re-report one already named in prior-triage.", blocking: false },
    { id: "advisory-observations", text: "Do not report non-material observations, optional improvements, completeness suggestions, stylistic preferences, or harmless wording refinements. A sound, decision-ready artifact should return no findings rather than a list of possible enhancements.", blocking: false },
  ],
});

const IMPLEMENTATION_RUBRIC = canonicalRubric("implementation-v1", {
  schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [
    { id: "substantive-correctness", text: "Report a finding only for a material defect: merging the change unchanged is reasonably likely to alter required behavior, break verification, violate an approved boundary, or create an important reliability, security, or maintenance risk. A blocking finding must cite exact changed, pinned, or repository evidence; name the concrete consequence; and explain why it survives the phase design's non-goals and priorities. If prior-triage is present, make verification of accepted revision intents the primary task; report a previously undiscovered issue only when it clears the same materiality bar. Challenge a prior disposition only when its revision intent was not carried out or the change introduced a material defect. Do not report optional cleanup, stylistic preferences, or harmless refinements.", blocking: true },
    { id: "design-conformance", text: "Report only a behavior, interface, file, or verification deviation from the pinned phase design that materially changes the approved outcome or leaves parent documents materially false. If missing phase-design evidence prevents that judgment, use unverifiable-claims.", blocking: true },
    { id: "interface-fidelity", text: "Report a changed-to-unchanged interface mismatch only when it is reasonably likely to break behavior, data, compatibility, or an important contract. Use unverifiable-claims only when missing interface evidence prevents a material judgment.", blocking: true },
    { id: "verification-evidence", text: "Report missing or failed verification only when the phase design requires it for an important behavior or risk. Claimed but untranscribed required verification is unverifiable, not a pass.", blocking: true },
    { id: "simplicity", text: "Report complexity only when it materially harms correctness, maintainability, change cost, or the approved operating envelope; do not report a merely preferred simpler implementation.", blocking: true },
    { id: "duplication", text: "Report duplication only when it creates a concrete material risk of divergence, defects, or disproportionate maintenance; do not request an abstraction for small or clearer repetition.", blocking: true },
    { id: "dead-code", text: "Report unreachable code, compatibility paths, or speculative extensions only when they materially affect behavior, safety, maintenance, or the approved scope.", blocking: true },
    { id: "error-handling", text: "Report an unhandled boundary failure only when it is reasonably likely and carries a material consequence under the current operating envelope.", blocking: true },
    { id: "unverifiable-claims", text: "When missing envelope or read-only repository evidence prevents a material judgment, record one non-blocking finding naming exactly what is missing, with a finding_id beginning unverifiable-. Never guess. Omit gaps that cannot materially affect the review, report each material gap once, and do not re-report one already named in prior-triage.", blocking: false },
    { id: "advisory-observations", text: "Do not report non-material observations, optional cleanup, completeness suggestions, stylistic preferences, or harmless refinements. A sound implementation should return no findings rather than a list of possible enhancements.", blocking: false },
  ],
});

/** Selects the immutable workflow rubric for a durable phase kind. */
export function canonicalRubricForPhaseKind(phaseKind: CounterReviewPhaseKind): CanonicalRubric {
  switch (phaseKind) {
    case "prd": return PRD_RUBRIC;
    case "design":
    case "phase-design": return DESIGN_RUBRIC;
    case "phase-impl": return IMPLEMENTATION_RUBRIC;
  }
}
