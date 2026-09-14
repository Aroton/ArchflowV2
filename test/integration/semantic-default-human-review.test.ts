import { registerSemanticImplementationCompletionJourney } from "./semantic-implementation-completion-journeys.js";

for (const kind of ["embedded-query", "orm-write", "schema-migration", "sql-file", "combined-sql"]) {
  registerSemanticImplementationCompletionJourney(`requires human review for ${kind} under shipped defaults`);
}
registerSemanticImplementationCompletionJourney("automatically commits reviewed security contracts and policy changes under shipped defaults");
registerSemanticImplementationCompletionJourney("preserves a repository custom human-review trigger alongside the shipped defaults");
