import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ProjectionPlan } from "../state/snapshots.js";

import type { AdapterId } from "../contracts/review.js";

export type DispatchWorkspace = Readonly<{
  root: string;
  home: string;
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

function credentialPaths(adapter: AdapterId, sourceHome: string, generatedHome: string): Readonly<{
  source: string;
  destination: string;
}> {
  if (adapter === "claude-cli") {
    return {
      source: join(sourceHome, ".claude", ".credentials.json"),
      destination: join(generatedHome, ".claude", ".credentials.json"),
    };
  }
  return {
    source: join(sourceHome, ".codex", "auth.json"),
    destination: join(generatedHome, ".codex", "auth.json"),
  };
}

/**
 * Creates disposable best-effort dispatch context hygiene. The generated home links only the
 * selected first-party CLI credential file; no other state from the caller's home is admitted.
 *
 * Containment for the Claude child is likewise best-effort: a repository view materialized under
 * this workspace is offered as the child's working directory, but reads outside the view are not
 * filesystem-prevented. What the hygiene does guarantee is that the real repository path is never
 * disclosed to the child — only the temporary view path is.
 */
export async function createDispatchWorkspace(
  adapter: AdapterId,
  repositoryRoot: string = process.cwd(),
): Promise<DispatchWorkspace> {
  const [realTemporaryRoot, realRepositoryRoot] = await Promise.all([
    realpath(tmpdir()),
    realpath(repositoryRoot),
  ]);
  if (isInside(realRepositoryRoot, realTemporaryRoot)) {
    throw new Error("dispatch temporary directory must be outside the repository");
  }

  const root = await mkdtemp(join(realTemporaryRoot, "archflow-dispatch-"));
  try {
    const home = join(root, "home");
    const codexHome = join(home, ".codex");
    const sourceHome = resolve(process.env.HOME ?? homedir());
    const credential = credentialPaths(adapter, sourceHome, home);

    await mkdir(resolve(credential.destination, ".."), { recursive: true });
    await symlink(credential.source, credential.destination, "file");

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      TMPDIR: root,
      CODEX_HOME: codexHome,
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
    return Object.freeze({ root, home, env: Object.freeze(env), dispose });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const GIT_OID = /^[0-9a-f]{40}$/u;

/**
 * Materializes a read-only checkout of the repository at `commit` under the workspace. When a
 * retained projection is supplied, its authenticated after-images reconstruct the proposed tree.
 * `git archive` (NOT `git worktree add`) is deliberate: an archive extraction has
 * no `.git` link back to the repository object database, so after `.archflow/tasks` is removed
 * the tracked task blobs (produce artifacts, triage) are unreachable from the view — the
 * reviewer-independence property of `src/review/envelopes.ts` holds structurally, not by child
 * good behavior. Tracked documentation (`docs/**`) stays readable: it is guidance, not authority.
 * The pipeline is a plain POSIX `git archive | tar -x`, matching this module's existing posture.
 */
export async function materializeRepositoryView(
  workspace: DispatchWorkspace,
  repositoryRoot: string,
  commit: string,
  projectionPlan?: ProjectionPlan,
): Promise<DispatchWorkspace> {
  if (!GIT_OID.test(commit)) {
    throw new TypeError("repository view commit must be a full lowercase git object id");
  }
  const view = join(workspace.root, "repo");
  await mkdir(view, { recursive: true });
  await new Promise<void>((resolvePipeline, reject) => {
    const archive = spawn("git", ["-C", repositoryRoot, "archive", "--format=tar", commit], {
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
      if (error === undefined) resolvePipeline();
      else reject(error);
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
  await rm(join(view, ".archflow", "tasks"), { recursive: true, force: true });
  if (projectionPlan !== undefined) await applyProducedProjection(view, projectionPlan);
  return Object.freeze({ ...workspace, repository_view_root: view });
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
