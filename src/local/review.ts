import { connectionContextFactory, createInvocationContext } from "../contracts/contexts.js";
import type { HostIdentity } from "../contracts/hosts.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { SimpleReviewInput } from "../contracts/simple-review.js";
import { runSimpleReview, type SimpleReviewDependencies } from "../review/simple-review.js";

/** The archflow_review standalone pass without the MCP: the repository is the caller's working directory, so a worktree reviews itself. */
export async function runLocalReview(input: { working_directory: string; producer?: string; value?: unknown; signal?: AbortSignal }, dependencies: SimpleReviewDependencies = {}): Promise<PlainJsonValue> {
  if (!["claude", "codex", "antigravity"].includes(input.producer ?? "")) throw new TypeError("review requires --producer claude|codex|antigravity to resolve the cross-family review routes");
  const connection = connectionContextFactory.captureStartup({ connection_id: "local-review", startup_repository_candidate: { working_directory: input.working_directory } })
    .initialize({ client: { name: "archflow-local", version: "1" }, host: input.producer as HostIdentity, protocol_version: "2025-11-25" });
  const context = createInvocationContext(connection, { invocation_id: "local-review", transport_metadata: { request_id: "local-review", operation: "tools/call" } }, input.signal ?? new AbortController().signal);
  return await runSimpleReview(input.value as SimpleReviewInput, context, dependencies) as unknown as PlainJsonValue;
}
