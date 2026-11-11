import { sha256Bytes } from "../../src/contracts/canonical.js";
import type { ReviewWorkspaceBinding } from "../../src/review/envelopes.js";

/**
 * Approximates the fields `runSimpleReview` seals for every standalone reviewer, with `subject` as
 * the reviewed plan text: `scope` is a short stand-in for production's text, and there is no
 * repository view unless `workspace` is passed. Callers add `assignment` and `rubric` for a review
 * child or `rules` for the constitution child, then seal the record with `sealDispatchInput`.
 */
export function standaloneReviewFields(options: {
  readonly subject: string;
  readonly stage?: "plan" | "implementation";
  readonly paths?: readonly string[];
  readonly workspace?: ReviewWorkspaceBinding;
}) {
  return {
    subject: { stage: options.stage ?? "implementation", subject_digest: sha256Bytes(new TextEncoder().encode(options.subject)) },
    ask: "Review the described change.",
    plan: options.subject,
    paths: [...(options.paths ?? ["src/index.ts"])],
    verification: "npm test",
    scope: "This is a standalone simple task, not an initialized ArchFlow workflow. Inspect declared paths as the subject, with other files only as context. Review once.",
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };
}
