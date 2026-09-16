import { simpleReviewInputSchema, simpleReviewResultSchema } from "../simple-review.js";
import { SCHEMA_IDS } from "../versions.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

export const simpleReviewSchemaGroup: SchemaGenerationGroup = {
  group: "simple-review",
  documents: [
    { file: "simple-review-input", id: SCHEMA_IDS.simpleReviewInput, root: simpleReviewInputSchema, migrated: true },
    { file: "simple-review-result", id: SCHEMA_IDS.simpleReviewResult, root: simpleReviewResultSchema, migrated: true },
  ],
};
