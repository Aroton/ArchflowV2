import { parseGitOid, type GitOid } from "../contracts/canonical.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import { readChangedGitPaths, resolveCommit } from "../repository/git.js";
import type { ProductionServices } from "../state/production.js";
import { computeTaskStatus } from "../state/status.js";

export type LocalCommitResult = Readonly<{
  action: "commit-artifacts" | "commit-phase";
  commit: GitOid;
  target_ref: string;
  message: string;
  paths: readonly string[];
}>;

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });

const fail = <T = never>(services: ProductionServices, issueCode: string): ProjectResult<T> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", {
      phase_instance: services.state?.value.phase_instance ?? services.authority.context.phase_instance,
      issue_code: issueCode,
    }),
  });

function literalPathspec(path: string): string {
  return `:(top,literal)${path}`;
}

async function targetMatches(
  services: ProductionServices,
  targetRef: string,
  baseline: string,
): Promise<boolean> {
  const symbolic = await services.runner.runText({
    argv: ["symbolic-ref", "--quiet", "HEAD"],
    operation: parseSafeCode("git-local-commit-target"),
    expectedAbsence: [{ code: 1, stderrIncludes: "" }],
  });
  if (targetRef === "HEAD" ? symbolic !== "" : symbolic !== targetRef) return false;
  const head = await resolveCommit(services.runner, "HEAD");
  const target = await resolveCommit(services.runner, targetRef);
  return head === baseline && target === baseline;
}

/**
 * Commits only the server-derived paths for the current authorized commit action. Git pathspecs
 * keep unrelated staged and worktree changes outside the commit; status and the target/baseline
 * check are recomputed immediately before committing so a stale preview cannot move a ref.
 */
export async function commitCurrentAuthorizedAction(
  services: ProductionServices,
): Promise<ProjectResult<LocalCommitResult>> {
  if (services.state === undefined) return fail(services, "commit-state-missing");
  const status = await computeTaskStatus(services.dependencies, services.authority);
  if (!status.ok) return status;
  const next = status.value.next_action;
  if (next.code !== "commit-artifacts" && next.code !== "commit-phase") {
    return fail(services, "commit-action-not-current");
  }
  const message = next.commit_message;
  const targetRef = next.commit_target_ref;
  const baseline = next.commit_baseline;
  const paths = next.code === "commit-artifacts"
    ? next.commit_path === undefined ? undefined : [next.commit_path]
    : next.commit_paths;
  if (
    message === undefined || targetRef === undefined || baseline === undefined ||
    paths === undefined || paths.length === 0
  ) return fail(services, "commit-authority-incomplete");

  try {
    if (!await targetMatches(services, targetRef, baseline)) {
      return fail(services, "commit-target-or-baseline-changed");
    }
    const sortedPaths = Object.freeze([...new Set(paths)].sort());
    const pathspecs = sortedPaths.map(literalPathspec);

    if (next.code === "commit-phase") {
      // The shared status reader includes untracked additions, unlike `git diff HEAD`. Restrict
      // its repository-wide report back to the authorized set so unrelated changes remain valid.
      const changed = await readChangedGitPaths(services.runner);
      const authorized = new Set(sortedPaths);
      const observed = [...new Set(changed.paths.filter((path) => authorized.has(path)))].sort();
      if (JSON.stringify(observed) !== JSON.stringify(sortedPaths)) {
        return fail(services, "commit-staged-paths-mismatch");
      }
    }

    // `git commit --only` reads tracked modifications/deletions directly from the worktree and
    // preserves unrelated index entries. New files need only an intent-to-add entry; staging every
    // path here would fail for an already-staged rename source that is now absent from the index.
    const untracked = await services.runner.runNulFields({
      argv: ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
      operation: parseSafeCode("git-local-commit-untracked-paths"),
    });
    if (untracked.length > 0) {
      await services.runner.runText({
        argv: ["add", "-N", "--", ...untracked.map(literalPathspec)],
        operation: parseSafeCode("git-local-commit-intent-to-add"),
      });
    }

    await services.runner.runText({
      argv: ["commit", "--only", "-m", message, "--", ...pathspecs],
      operation: parseSafeCode("git-local-commit-create"),
    });
    const commit = parseGitOid(await resolveCommit(services.runner, "HEAD"));
    return ok(Object.freeze({
      action: next.code,
      commit,
      target_ref: targetRef,
      message,
      paths: sortedPaths,
    }) as LocalCommitResult);
  } catch {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("IO_ERROR", {
        operation: parseSafeCode("git-local-commit"),
        attempt: services.authority.context.attempt,
      }),
    });
  }
}

// Compile-time proof that the public result remains plain JSON for the local command boundary.
const _plain: LocalCommitResult extends PlainJsonValue ? true : never = true;
void _plain;
