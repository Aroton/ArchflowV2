import { registerSemanticImplementationCompletionJourney } from "../integration/semantic-implementation-completion-journeys.js";

// Reuse the one semantic journey: its receipt-before-state rollback is the push-through settlement
// crash cut, while keeping the production/review/gate fixture and assertions in one source.
registerSemanticImplementationCompletionJourney(
  "pushes through the exact exhausted review and preserves configured commit authorization",
);
