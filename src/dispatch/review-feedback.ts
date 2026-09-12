import { readFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalJsonBytes } from "../contracts/canonical.js";
import { reviewReportV1Schema, type ReviewReportV1 } from "../contracts/review.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema, type Sha256Digest } from "../contracts/evidence.js";
import { phaseInstanceIdV1Schema } from "../contracts/phase-instance.js";
import { parseWorkspacePathClaim, resolveTaskWorkspacePath } from "../repository/paths.js";
import type { TransactionAuthority } from "../state/authority.js";
import { ensureAttemptDirectory } from "../state/layout.js";
import type { TransactionDependencies } from "../state/transaction.js";

// A disposable display of received feedback, never evidence or advancement authority.
const feedbackSchema = z.object({
  task_id: taskSlugV1Schema, phase_instance: phaseInstanceIdV1Schema,
  attempt: safeIntegerV1Schema, input_fingerprint: sha256DigestV1Schema,
  subject_digest: sha256DigestV1Schema, reports: z.array(reviewReportV1Schema),
}).strict();

async function target(authority: TransactionAuthority, dependencies: Pick<TransactionDependencies, "runner">, state: TaskStateV1) {
  return resolveTaskWorkspacePath({
    runner: dependencies.runner, taskId: authority.task_id,
    claim: parseWorkspacePathClaim(`diagnostics/attempts/${state.phase_instance}/received-feedback-${state.attempt}.json`),
    expectedClass: "workspace-attempt", context: authority.context,
  });
}

export async function writeReceivedFeedback(
  authority: TransactionAuthority, dependencies: TransactionDependencies, state: TaskStateV1,
  subject: Sha256Digest, reports: readonly ReviewReportV1[],
): Promise<void> {
  try {
    const writer = dependencies.projection_writer;
    if (writer === undefined) return;
    await ensureAttemptDirectory(authority, state.phase_instance);
    const path = await target(authority, dependencies, state);
    if (!path.ok) return;
    await writer.replaceRegular(path.value, canonicalJsonBytes({
      task_id: state.task_id, phase_instance: state.phase_instance, attempt: state.attempt,
      input_fingerprint: state.input_fingerprint, subject_digest: subject, reports: [...reports],
    }), false);
  } catch { /* Display retention cannot replace a dispatch result. */ }
}

export async function readReceivedFeedback(
  authority: TransactionAuthority, dependencies: Pick<TransactionDependencies, "runner">, state: TaskStateV1,
): Promise<readonly ReviewReportV1[] | undefined> {
  if (state.step !== "counter_review" || state.status !== "running") return undefined;
  try {
    const path = await target(authority, dependencies, state);
    if (!path.ok) return undefined;
    const record = feedbackSchema.parse(JSON.parse(await readFile(path.value.absolute, "utf8")));
    if (record.task_id !== state.task_id || record.phase_instance !== state.phase_instance ||
        record.attempt !== state.attempt || record.input_fingerprint !== state.input_fingerprint) return undefined;
    return record.reports;
  } catch { return undefined; }
}
