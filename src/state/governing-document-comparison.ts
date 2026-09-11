import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256Bytes, canonicalJsonDigest } from "../contracts/canonical.js";
import { parseResultManifest, type ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { SafeCode } from "../contracts/evidence.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import { loadAuthenticatedGateApproval, type AuthenticatedGateApproval } from "./gate-approvals.js";
import { authenticatedApprovalIsEligibleAfterLatestRestart } from "./restart-authority.js";
import { changedCoProducedDocumentPaths, type CurrentProduceSubject } from "./produce-subject.js";
import type { TransactionDependencies } from "./transaction.js";

export type GoverningDocumentComparison = {
  readonly path: string;
  readonly baseline: { readonly status: "authenticated"; readonly content_digest: string; readonly content: string }
    | { readonly status: "unavailable"; readonly reason: string };
  readonly proposed_content_digest: string;
};

/** The prior human decision, not the previous automatic amendment, anchors comparison. That
 * prevents a sequence of individually small changes from silently replacing approved decisions.
 * Git supplies bytes by an authenticated blob identity; its branch ordering supplies no authority.
 */
export async function governingDocumentComparisons(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  state: TaskStateV1,
  subject: CurrentProduceSubject,
): Promise<readonly GoverningDocumentComparison[]> {
  const changed = await changedCoProducedDocumentPaths(dependencies, state, subject);
  if (!changed.ok) throw new Error("Cannot identify changed governing documents");
  const paths = subject.artifact.artifact_kind === "implementation-output"
    ? subject.artifact.outputs.map((output) => output.path) : changed.value;
  const parents = paths.filter((path) => path === `.archflow/tasks/${state.task_id}/prd.md` || path === `.archflow/tasks/${state.task_id}/design.md`);
  if (parents.length === 0) return [];
  const approvals: AuthenticatedGateApproval[] = [];
  for (const reference of [...state.approvals].sort((a, b) => b.resolved_at_revision - a.resolved_at_revision)) {
    if (!["artifact-approval", "design-approval", "commit-authorization", "migration-audit"].includes(reference.gate_kind)) continue;
    const loaded = await loadAuthenticatedGateApproval(dependencies, authority, reference);
    if (!loaded.ok) throw new Error("Governing document approval cannot be authenticated");
    if (authenticatedApprovalIsEligibleAfterLatestRestart(state, loaded.value)) approvals.push(loaded.value);
  }
  const subjects = new Set(approvals.map((approval) => approval.approval.subject_digest));
  const manifests: ResultManifestV1[] = [];
  // Only this task's immutable result directory is inspected. Unrelated historical artifact
  // schemas are not parsed: authenticate the address, then select the exact approved subject.
  for (const name of await readdir(join(authority.task_root, "authority", "results"))) {
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue;
    const target = await resolveTaskPath({ runner: dependencies.runner, taskId: state.task_id,
      claim: parseTaskPathClaim(`authority/results/${name}`), expectedClass: "authority-result", context: authority.context });
    if (!target.ok) throw new Error("Governing document result path is unavailable");
    const bytes = await readFile(target.value.absolute);
    if (sha256Bytes(bytes) !== name.slice(0, -5)) throw new Error("Governing document result address mismatch");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertPlainJson(value, "governing comparison manifest");
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const artifactDigest = (value as { artifact_digest?: unknown }).artifact_digest;
    if (typeof artifactDigest !== "string" || ![...subjects].some((digest) => digest === artifactDigest)) continue;
    const manifest = parseResultManifest(value);
    if (manifest.task_id !== state.task_id || manifest.repository_identity_digest !== state.repository_identity_digest ||
        canonicalJsonDigest(manifest.source_artifact) !== manifest.artifact_digest) throw new Error("Governing document result binding mismatch");
    manifests.push(manifest);
  }
  return Promise.all([...new Set(parents)].sort().map(async (path): Promise<GoverningDocumentComparison> => {
    const proposed = subject.retained.manifest.value.projections.find((projection) => projection.path === path);
    if (proposed === undefined) throw new Error("Changed governing document has no produced projection");
    let baseline: GoverningDocumentComparison["baseline"] = { status: "unavailable", reason: "No recoverable human-approved baseline exists for this document. Do not infer a non-material amendment." };
    for (const approval of approvals) {
      const manifest = manifests.find((candidate) => candidate.artifact_digest === approval.approval.subject_digest && candidate.projections.some((projection) => projection.path === path));
      if (manifest === undefined) continue;
      const projection = manifest.projections.find((candidate) => candidate.path === path)!;
      const output = manifest.outputs.find((candidate) => candidate.path === path);
      if (output === undefined || output.operation === "delete") break;
      try {
        const bytes = (await dependencies.runner.run({ argv: ["cat-file", "blob", output.after.oid], operation: "read-governing-baseline" as SafeCode })).stdout;
        if (sha256Bytes(bytes) !== projection.content_digest) throw new Error("Governing baseline content mismatch");
        baseline = { status: "authenticated", content_digest: projection.content_digest, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch { /* An unavailable original baseline remains explicit evidence, never automatic clearance. */ }
      break;
    }
    return { path, baseline, proposed_content_digest: proposed.content_digest };
  }));
}
