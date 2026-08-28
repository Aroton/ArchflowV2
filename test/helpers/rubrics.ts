import {
  loadCanonicalRubricForPhaseKind,
  type CanonicalRubric,
  type CounterReviewPhaseKind,
} from "../../src/review/rubrics.js";

/** Loads one canonical rubric for a test, unwrapping the failure arm. */
export async function loadTestRubric(phaseKind: CounterReviewPhaseKind): Promise<CanonicalRubric> {
  const loaded = await loadCanonicalRubricForPhaseKind(phaseKind);
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}
