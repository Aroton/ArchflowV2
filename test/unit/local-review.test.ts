import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLocalReview } from "../../src/local/review.js";
import type { SimpleReviewDependencies } from "../../src/review/simple-review.js";

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
}).trim();
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "archflow-local-review-")); roots.push(root);
  git(root, "init", "-q");
  await writeFile(join(root, "app.txt"), "before\n");
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  return { root, base_commit: git(root, "rev-parse", "HEAD") };
}
const payload = (base_commit: string) => ({ schema_version: "1", stage: "implementation", ask: "Update app", plan: "Update app.txt",
  base_commit, paths: ["app.txt"], verification: "Read the file." });
function passingDispatch(): NonNullable<SimpleReviewDependencies["dispatch"]> {
  return async (_route, envelope) => {
    const body = JSON.parse(new TextDecoder().decode(envelope.bytes));
    const result = envelope.result_kind === "adjudication" ? { schema_version: "2", judgments: Object.fromEntries(body.rules.map((rule: { slot: string }) => [rule.slot, {
      compliance: "pass", rationale: "No policy issue.", trigger: "not-matched", trigger_evidence: "No trigger evidence." }])) }
      : { outcome: "no_issues_found", feedback: "Reviewed the change; no actionable issues." };
    return { cli_version: "test", extracted_output_bytes: new TextEncoder().encode(JSON.stringify(result)) };
  };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("archflow-local review", () => {
  it("requires a supported producer so cross-family routing is never guessed", async () => {
    const { root, base_commit } = await repo();
    for (const producer of [undefined, "unknown"]) {
      await expect(runLocalReview({ working_directory: root, ...(producer === undefined ? {} : { producer }), value: payload(base_commit) }))
        .rejects.toThrow("review requires --producer claude|codex|antigravity");
    }
  });

  it("reviews the uncommitted bytes of the git worktree it runs in", async () => {
    const { root, base_commit } = await repo();
    const worktree = join(root, "..", `${root.split("/").at(-1)}-wt`); roots.push(worktree);
    git(root, "worktree", "add", "-q", "--detach", worktree, base_commit);
    await writeFile(join(worktree, "app.txt"), "changed in the worktree\n");
    const review = async (working_directory: string) => await runLocalReview({ working_directory, producer: "claude", value: payload(base_commit) }, { dispatch: passingDispatch() }) as any;
    const fromWorktree = await review(worktree);
    expect(fromWorktree.ok, JSON.stringify(fromWorktree)).toBe(true);
    expect(fromWorktree.value.reports.map((report: any) => report.role)).toEqual(expect.arrayContaining(["counter-reviewer", "test-reviewer"]));
    // The subject is the bytes of the directory the command runs in: the untouched main checkout differs until it holds the same edit.
    const untouchedMain = await review(root);
    expect(untouchedMain.value.subject_digest).not.toBe(fromWorktree.value.subject_digest);
    await writeFile(join(root, "app.txt"), "changed in the worktree\n");
    expect((await review(root)).value.subject_digest).toBe(fromWorktree.value.subject_digest);
  });

  it("names the offending fields of a hand-built payload", async () => {
    const { root, base_commit } = await repo();
    const { verification: _omitted, ...withoutVerification } = payload(`${base_commit}\n`);
    const result = await runLocalReview({ working_directory: root, producer: "claude", value: withoutVerification }, { dispatch: passingDispatch() }) as any;
    expect(result).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(result.error.message).toContain("base_commit");
    expect(result.error.message).toContain("verification");
  });

  it("reviews the checkout root while agent worktrees are nested inside it", async () => {
    const { root, base_commit } = await repo();
    git(root, "worktree", "add", "-q", "--detach", join(root, ".claude/worktrees/agent-1"), base_commit);
    await writeFile(join(root, "app.txt"), "changed at the root\n");
    const result = await runLocalReview({ working_directory: root, producer: "claude", value: payload(base_commit) }, { dispatch: passingDispatch() }) as any;
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("returns a changed baseline as a failed result rather than reviewing other bytes", async () => {
    const { root } = await repo();
    const result = await runLocalReview({ working_directory: root, producer: "claude", value: payload("0".repeat(40)) }, { dispatch: passingDispatch() }) as any;
    expect(result).toMatchObject({ ok: false, error: { code: "BASELINE_CHANGED" } });
  });

  it("reports cancellation when the interrupt signal has fired", async () => {
    const { root, base_commit } = await repo();
    const controller = new AbortController(); controller.abort();
    const result = await runLocalReview({ working_directory: root, producer: "claude", value: payload(base_commit), signal: controller.signal }, { dispatch: passingDispatch() }) as any;
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  });
});
