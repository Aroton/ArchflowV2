import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { type GitOid } from "../contracts/canonical.js";
import { repositoryNameV1Schema, type RepositoryName } from "../contracts/config.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { ReviewedRepositoryV1 } from "../contracts/review.js";
import {
  MULTI_REPOSITORY_VIEW_NOTE,
  PRODUCED_REPOSITORY_VIEW_NOTE,
  REPOSITORY_VIEW_NOTE,
  type ReviewWorkspaceBinding,
} from "../review/envelopes.js";
import type { ProjectionPlan } from "../state/snapshots.js";

import type { AdapterId } from "../contracts/review.js";

export type DispatchWorkspace = Readonly<{
  root: string;
  env: Readonly<NodeJS.ProcessEnv>;
  /** Read-only checkout for review dispatch; absent for adjudication and preflight-only use. */
  repository_view_root?: string;
  dispose: () => Promise<void>;
}>;

const FORWARDED_ENVIRONMENT = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const);

function isInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

/**
 * Creates disposable best-effort dispatch context hygiene without virtualizing authentication.
 * The child uses the caller's canonical home and selected CLI credential directory so an OAuth
 * refresh is persisted by the first-party client exactly as it is in an interactive session.
 * Repository material, schema/output files, and temporary state remain disposable below `root`.
 *
 * Containment for the Claude child is likewise best-effort: a repository view materialized under
 * this workspace is offered as the child's working directory, but reads outside the view are not
 * filesystem-prevented. What the hygiene does guarantee is that the real repository path is never
 * disclosed to the child — only the temporary view path is.
 */
export async function createDispatchWorkspace(
  adapter: AdapterId | readonly AdapterId[],
  repositoryRoot: string = process.cwd(),
): Promise<DispatchWorkspace> {
  const adapters = Array.isArray(adapter) ? adapter : [adapter];
  const [realTemporaryRoot, realRepositoryRoot] = await Promise.all([
    realpath(tmpdir()),
    realpath(repositoryRoot),
  ]);
  if (isInside(realRepositoryRoot, realTemporaryRoot)) {
    throw new Error("dispatch temporary directory must be outside the repository");
  }

  const root = await mkdtemp(join(realTemporaryRoot, "archflow-dispatch-"));
  try {
    const sourceHome = resolve(process.env.HOME ?? homedir());
    const env: NodeJS.ProcessEnv = {
      HOME: sourceHome,
      TMPDIR: root,
      // A shared workspace serves both adapters of one review; each CLI ignores the other's
      // variable, and a single-adapter list produces exactly the env it produced before.
      ...(adapters.includes("codex-cli")
        ? { CODEX_HOME: resolve(process.env.CODEX_HOME ?? join(sourceHome, ".codex")) }
        : {}),
      ...(adapters.includes("claude-cli") && process.env.CLAUDE_CONFIG_DIR !== undefined
        ? { CLAUDE_CONFIG_DIR: resolve(process.env.CLAUDE_CONFIG_DIR) }
        : {}),
    };
    for (const name of FORWARDED_ENVIRONMENT) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }

    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposal ??= rm(root, { recursive: true, force: true });
      return disposal;
    };
    return Object.freeze({ root, env: Object.freeze(env), dispose });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const GIT_OID = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

export type DispatchRepositoryView = Readonly<{
  name: "primary" | RepositoryName;
  member_kind: "primary" | "secondary";
  /** Server-only live location. This value is never projected into a child envelope. */
  repository_root: string;
  repository_identity_digest: Sha256Digest;
  commit: GitOid;
  /** Authenticated retained after-images for this repository's proposed tree. */
  projection_plan?: ProjectionPlan;
  /** Digest of the authenticated projection represented by projection_plan. */
  snapshot_digest?: Sha256Digest;
}>;

export type DispatchRepositoryViewPlan = readonly DispatchRepositoryView[];

/** Internal carrier; callers translate it before crossing a dispatch failure boundary. */
export class RepositoryViewMaterializationError extends Error {
  readonly repository_name: DispatchRepositoryView["name"];

  constructor(repositoryName: DispatchRepositoryView["name"], cause: unknown) {
    super(`repository view materialization failed for ${repositoryName}`, { cause });
    this.name = "RepositoryViewMaterializationError";
    this.repository_name = repositoryName;
  }
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Validates the server-owned ordered plan before any name is used as a filesystem segment. */
export function validateDispatchRepositoryViewPlan(
  candidate: DispatchRepositoryViewPlan,
): DispatchRepositoryViewPlan {
  if (candidate.length === 0) throw new TypeError("repository view plan must contain primary");
  let previous = "";
  for (let index = 0; index < candidate.length; index += 1) {
    const member = candidate[index]!;
    if (!GIT_OID.test(member.commit)) {
      throw new TypeError(`repository view commit for ${member.name} must be a full lowercase git object id`);
    }
    if (!SHA256_DIGEST.test(member.repository_identity_digest)) {
      throw new TypeError(`repository identity for ${member.name} must be a sha256 digest`);
    }
    if ((member.projection_plan === undefined) !== (member.snapshot_digest === undefined)) {
      throw new TypeError(`repository view projection and snapshot digest for ${member.name} must appear together`);
    }
    if (member.snapshot_digest !== undefined && !SHA256_DIGEST.test(member.snapshot_digest)) {
      throw new TypeError(`repository snapshot for ${member.name} must be a sha256 digest`);
    }
    if (!isAbsolute(member.repository_root)) {
      throw new TypeError(`repository root for ${member.name} must be absolute`);
    }
    if (index === 0) {
      if (member.name !== "primary" || member.member_kind !== "primary") {
        throw new TypeError("repository view plan must begin with the primary member");
      }
    } else {
      repositoryNameV1Schema.parse(member.name);
      if (member.member_kind !== "secondary") {
        throw new TypeError(`repository view member ${member.name} must be secondary`);
      }
      if (index > 1 && ordinal(previous, member.name) >= 0) {
        throw new TypeError("secondary repository view names must be sorted and unique");
      }
    }
    previous = member.name;
  }
  return candidate;
}

/** Projects child-visible workspace authority from the same validated plan used to extract bytes. */
export function projectRepositoryWorkspaceBinding(
  candidate: DispatchRepositoryViewPlan,
): ReviewWorkspaceBinding {
  const plan = validateDispatchRepositoryViewPlan(candidate);
  if (plan.length === 1) {
    const primary = plan[0]!;
    return primary.snapshot_digest === undefined
      ? Object.freeze({ kind: "read-only-repository-checkout", commit: primary.commit, note: REPOSITORY_VIEW_NOTE })
      : Object.freeze({
          kind: "read-only-produced-repository-snapshot",
          base_commit: primary.commit,
          snapshot_digest: primary.snapshot_digest,
          note: PRODUCED_REPOSITORY_VIEW_NOTE,
        });
  }
  return Object.freeze({
    kind: "read-only-multi-repository-view",
    note: MULTI_REPOSITORY_VIEW_NOTE,
    repositories: Object.freeze(plan.map((member) => Object.freeze({
      name: member.name,
      path: member.name,
      repository_identity_digest: member.repository_identity_digest,
      commit: member.commit,
      ...(member.snapshot_digest === undefined ? {} : { snapshot_digest: member.snapshot_digest }),
    }))),
  });
}

/** Projects the ordered server-attested commit pins without exposing live repository roots. */
export function projectReviewedRepositories(
  candidate: DispatchRepositoryViewPlan,
): readonly ReviewedRepositoryV1[] {
  const plan = validateDispatchRepositoryViewPlan(candidate);
  return Object.freeze(plan.map((member) => Object.freeze({
    name: member.name,
    repository_identity_digest: member.repository_identity_digest,
    commit: member.commit,
  })));
}

/**
 * Materializes a read-only checkout of the repository at `commit` under the workspace. When a
 * retained projection is supplied, its authenticated after-images reconstruct the proposed tree.
 * `git archive` (NOT `git worktree add`) is deliberate: an archive extraction has
 * no `.git` link back to the repository object database, so after `.archflow/tasks` is removed
 * the tracked task blobs (produce artifacts, triage) are unreachable from the view — the
 * reviewer-fresh-context property of `src/review/envelopes.ts` holds structurally, not by child
 * good behavior. Tracked documentation (`docs/**`) stays readable: it is guidance, not authority.
 * The pipeline is a plain POSIX `git archive | tar -x`, matching this module's existing posture.
 */
async function materializeRepositoryArchive(
  view: string,
  member: DispatchRepositoryView,
): Promise<void> {
  await mkdir(view);
  await new Promise<void>((resolvePipeline, reject) => {
    const archive = spawn("git", ["-C", member.repository_root, "archive", "--format=tar", member.commit], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const extract = spawn("tar", ["-x", "-C", view], { stdio: ["pipe", "ignore", "pipe"] });
    extract.stdin.on("error", () => undefined);
    archive.stdout.pipe(extract.stdin);
    const stderrChunks: Buffer[] = [];
    archive.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    extract.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    let archiveExit: number | null | undefined;
    let extractExit: number | null | undefined;
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) {
        resolvePipeline();
        return;
      }
      // A spawn failure on one side leaves the other still running; stop it before rejecting so
      // the coordinator's workspace removal never races a tar that is still writing.
      archive.kill();
      extract.kill();
      reject(error);
    };
    const finish = (): void => {
      if (archiveExit === undefined || extractExit === undefined) return;
      if (archiveExit === 0 && extractExit === 0) {
        settle();
        return;
      }
      const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
      settle(new Error(`repository view materialization failed: ${detail === "" ? "archive pipeline exited nonzero" : detail}`));
    };
    archive.on("error", (error: Error) => settle(new Error(`git archive failed to spawn: ${error.message}`)));
    extract.on("error", (error: Error) => settle(new Error(`tar failed to spawn: ${error.message}`)));
    archive.on("close", (code) => {
      archiveExit = code;
      finish();
    });
    extract.on("close", (code) => {
      extractExit = code;
      finish();
    });
  });
  if (member.member_kind === "primary") {
    await rm(join(view, ".archflow", "tasks"), { recursive: true, force: true });
  } else {
    await rm(join(view, ".archflow"), { recursive: true, force: true });
  }
  if (member.projection_plan !== undefined) await applyProducedProjection(view, member.projection_plan);
}

/** Materializes the complete ordered repository set and selects the child working directory. */
export async function materializeRepositoryViews(
  workspace: DispatchWorkspace,
  candidate: DispatchRepositoryViewPlan,
): Promise<DispatchWorkspace> {
  const plan = validateDispatchRepositoryViewPlan(candidate);
  const container = plan.length === 1 ? workspace.root : join(workspace.root, "repos");
  if (plan.length > 1) await mkdir(container);
  // Every name has already passed `validateDispatchRepositoryViewPlan` (index 0 is literally
  // `primary`, every other member is a declared repository name), so `join` cannot escape the
  // container; the view is always a direct child.
  for (const member of plan) {
    const view = plan.length === 1 ? join(workspace.root, "repo") : join(container, member.name);
    try {
      await materializeRepositoryArchive(view, member);
    } catch (error) {
      throw new RepositoryViewMaterializationError(member.name, error);
    }
  }
  return Object.freeze({ ...workspace, repository_view_root: plan.length === 1 ? join(workspace.root, "repo") : container });
}

function errno(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function ensureContainedParent(view: string, repositoryPath: string): Promise<string> {
  const target = resolve(view, repositoryPath);
  if (target === view || !isInside(view, target)) {
    throw new TypeError("produced repository view path escapes the checkout");
  }
  const segments = repositoryPath.split("/");
  let parent = view;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      const status = await lstat(parent);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new TypeError("produced repository view path traverses a non-directory");
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      await mkdir(parent);
    }
  }
  return target;
}

async function removeLeaf(target: string): Promise<void> {
  try {
    const status = await lstat(target);
    if (status.isDirectory() && !status.isSymbolicLink()) {
      throw new TypeError("produced repository view output collides with a directory");
    }
    await rm(target, { force: true });
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

/** Applies only authenticated retained after-images to the archived baseline checkout. */
async function applyProducedProjection(view: string, projectionPlan: ProjectionPlan): Promise<void> {
  for (const entry of projectionPlan.entries) {
    if (entry.path === ".archflow/tasks" || entry.path.startsWith(".archflow/tasks/")) {
      continue;
    }
    const target = await ensureContainedParent(view, entry.path);
    await removeLeaf(target);
    if (entry.desired.state === "absent") continue;
    if (entry.desired.file_type === "symlink") {
      await symlink(new TextDecoder().decode(entry.desired.bytes), target);
      continue;
    }
    await writeFile(target, entry.desired.bytes, { mode: entry.desired.mode === "100755" ? 0o755 : 0o644 });
    await chmod(target, entry.desired.mode === "100755" ? 0o755 : 0o644);
  }
}

/**
 * One lazily materialized workspace lent to every dispatch of a single counter-review call: the
 * rubric and constitution children receive byte-identical repository views, so the second
 * materialization is pure duplicated work. The first `acquire` creates and materializes exactly
 * once; a failed acquire is never memoized, so a retry starts from a fresh workspace. A borrower
 * never disposes — the owner disposes once, after every child of the call has settled.
 */
export type SharedRepositoryViewWorkspace = Readonly<{
  /** Creates and materializes exactly once; repeats return the same workspace. */
  acquire: () => Promise<DispatchWorkspace>;
  /** Removes the workspace if it was ever created; never throws. */
  dispose: () => Promise<void>;
}>;

export function shareRepositoryViewWorkspace(
  repositoryViews: DispatchRepositoryViewPlan,
  repositoryRoot: string,
): SharedRepositoryViewWorkspace {
  let ready: Promise<DispatchWorkspace> | undefined;
  const acquire = (): Promise<DispatchWorkspace> => {
    ready ??= (async () => {
      const workspace = await createDispatchWorkspace(["claude-cli", "codex-cli"], repositoryRoot);
      try {
        return await materializeRepositoryViews(workspace, repositoryViews);
      } catch (error) {
        ready = undefined;
        await workspace.dispose().catch(() => undefined);
        throw error;
      }
    })();
    return ready;
  };
  const dispose = (): Promise<void> =>
    ready === undefined
      ? Promise.resolve()
      : ready.then((workspace) => workspace.dispose()).catch(() => undefined);
  return Object.freeze({ acquire, dispose });
}
