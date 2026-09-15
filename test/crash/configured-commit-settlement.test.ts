import { registerSemanticImplementationCompletionJourney } from "../integration/semantic-implementation-completion-journeys.js";

// Reuse the current configured-commit gate journey, including its
// receipt-before-state rollback and exact-decision recovery assertions.
registerSemanticImplementationCompletionJourney(
  "finishes disputed fifth-round feedback while preserving configured commit approval",
);
