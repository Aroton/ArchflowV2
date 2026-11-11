import type { HostIdentity } from "../contracts/hosts.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { SimpleReviewInput } from "../contracts/simple-review.js";
import { runSimpleReview, type SimpleReviewDependencies } from "../review/simple-review.js";

/** One standalone review pass: the repository is the caller's working directory, so a worktree reviews itself, and the producer picks the opposite-family routes. */
export async function runLocalReview(input: { working_directory: string; producer?: string; value?: unknown; signal?: AbortSignal }, dependencies: SimpleReviewDependencies = {}): Promise<PlainJsonValue> {
  if (!["claude", "codex", "antigravity"].includes(input.producer ?? "")) throw new TypeError("review requires --producer claude|codex|antigravity to resolve the cross-family review routes");
  const context = { working_directory: input.working_directory, host: input.producer as HostIdentity, signal: input.signal ?? new AbortController().signal, invocation_id: "local-review" };
  return await runSimpleReview(input.value as SimpleReviewInput, context, dependencies) as unknown as PlainJsonValue;
}
