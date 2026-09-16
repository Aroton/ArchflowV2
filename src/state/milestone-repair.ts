import type { SafeCode, TaskSlug } from "../contracts/evidence.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { classifyTaskPath } from "../repository/paths.js";

/** Only untracked durable task files are at risk of being silently omitted by git add. */
export async function ignoredMilestonePaths(runner: RootBoundGitRunner, taskId: TaskSlug): Promise<readonly string[]> {
  const prefix = `.archflow/tasks/${taskId}/`;
  const ignored = await runner.runNulFields({
    argv: ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", `:(top,literal)${prefix}`],
    operation: "git-ignored-milestone-paths" as SafeCode,
  });
  return ignored.filter((path) => {
    if (!path.startsWith(prefix)) return false;
    try {
      return classifyTaskPath(taskId, parseTaskPathClaim(path.slice(prefix.length))).ok;
    } catch {
      return false; // Unrecognized scratch files are not durable authority.
    }
  }).sort();
}

export const INCOMPLETE_DOCUMENT_MILESTONE_GUIDANCE =
  "The approval commit is missing required task state or approval archives. Approval is retained. " +
  "Correct any Git ignore rules, then repair the incomplete authorized commit to include its durable task files " +
  "while preserving its approved baseline, message, and reviewed documents. Adding a later commit does not repair " +
  "the original milestone. Request fresh status after repair; do not repeat review or approval.";
