import { assertPlainJson } from "../contracts/plain-json.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalJsonDigest, parseGitOid, sha256Bytes } from "../contracts/canonical.js";
import { parseConfigYaml } from "../contracts/config.js";
import { CONSTITUTION_RULE_NAME, parseConstitutionRuleFiles } from "../contracts/constitution.js";
import { parseRepositoryPathClaim } from "../contracts/path-claims.js";
import type { SimpleReviewInput } from "../contracts/simple-review.js";
import { assetRoot } from "../init/assets.js";
import type { ReviewProjectionPlan, DispatchRepositoryViewPlan } from "../dispatch/workspace.js";

const exec = promisify(execFile);
const BYTE_CAP = 25 * 1024 * 1024;
export class SimpleReviewError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export async function simpleGit(root: string, args: string[], signal: AbortSignal): Promise<string> {
  const result = await exec("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: BYTE_CAP, timeout: 30_000, signal });
  return result.stdout;
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Refuse symlink parents before opening caller-selected repository material. */
async function safeParents(root: string, path: string): Promise<void> {
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SimpleReviewError("INPUT_INVALID", "Review paths must not traverse symlinks or non-directories.");
    } catch (error) { if (absent(error)) return; throw error; }
  }
}
async function regular(root: string, path: string): Promise<string> {
  await safeParents(root, path);
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > BYTE_CAP) throw new SimpleReviewError("INPUT_INVALID", "Review input must be a bounded regular file.");
    return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
  } finally { await handle.close(); }
}
export async function loadSimplePolicy(root: string) {
  const assets = await assetRoot();
  let configText: string;
  try { configText = await regular(root, ".archflow/config.yaml"); }
  catch (error) { if (!absent(error)) throw error; configText = await regular(assets, "config.template.yaml"); }
  let config;
  try { config = parseConfigYaml(configText); }
  catch { throw new SimpleReviewError("CONFIG_INVALID", "Review configuration is invalid. Check .archflow/config.yaml (or the shipped template when absent) against the config schema."); }
  let policyRoot = root;
  let prefix = ".archflow/constitution";
  try {
    await safeParents(root, `${prefix}/placeholder`);
    const directory = await lstat(join(root, prefix));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new SimpleReviewError("CONFIG_INVALID", "Constitution must be a regular directory.");
  } catch (error) { if (!absent(error)) throw error; policyRoot = assets; prefix = "constitution"; }
  const files: Record<string, string> = {};
  for (const layer of ["", "default", "custom"]) {
    const relative = layer === "" ? prefix : `${prefix}/${layer}`;
    let entries;
    try { await safeParents(policyRoot, `${relative}/placeholder`); entries = await readdir(join(policyRoot, relative)); }
    catch (error) { if (absent(error)) continue; throw error; }
    for (const name of entries.filter((name) => CONSTITUTION_RULE_NAME.test(name)).sort()) {
      files[`.archflow/constitution/${layer === "" ? "" : `${layer}/`}${name}`] = await regular(policyRoot, `${relative}/${name}`);
    }
  }
  let registry;
  try { registry = parseConstitutionRuleFiles(files); }
  catch { throw new SimpleReviewError("CONFIG_INVALID", "Constitution rules are invalid. Check rule frontmatter, duplicate IDs, and default/custom layout."); }
  const rules = [...registry.values()].filter((rule) => rule.status === "active")
    .sort((a, b) => `${a.id}:${a.version}`.localeCompare(`${b.id}:${b.version}`));
  assertPlainJson(config, "review config");
  const config_digest = canonicalJsonDigest(structuredClone(config));
  const constitution_digest = canonicalJsonDigest(files);
  return { config, rules, config_digest, constitution_digest,
    policy_digest: canonicalJsonDigest({ config_digest, constitution_digest }) };
}

export async function captureSimpleContext(workingDirectory: string, input: SimpleReviewInput, signal: AbortSignal) {
  const root = (await simpleGit(workingDirectory, ["rev-parse", "--show-toplevel"], signal)).trimEnd();
  const head = (await simpleGit(root, ["rev-parse", "HEAD"], signal)).trim();
  const branch = await simpleGit(root, ["rev-parse", "--symbolic-full-name", "HEAD"], signal);
  if (head !== input.base_commit) throw new SimpleReviewError("BASELINE_CHANGED", "HEAD differs from the simple task baseline. Resolve the changed baseline before review.");
  const policy = await loadSimplePolicy(root);
  if (input.expected_policy_digest !== undefined && input.expected_policy_digest !== policy.policy_digest) {
    throw new SimpleReviewError("POLICY_CHANGED", "Repository review configuration or constitution changed since plan review. Resolve the change with the user before continuing.");
  }
  const collect = async (): Promise<ReviewProjectionPlan> => {
    const dirty = (await simpleGit(root, ["diff", "--name-only", "-z", "HEAD", "--"], signal)).split("\0");
    const untracked = (await simpleGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal)).split("\0");
    const paths = [...new Set([...dirty, ...untracked, ...input.paths].filter(Boolean))].sort();
    const entries: ReviewProjectionPlan["entries"][number][] = [];
    let size = 0;
    for (const path of paths) {
      // Other initialized tasks are never review context for a simple task.
      if (path === ".archflow/tasks" || path.startsWith(".archflow/tasks/")) continue;
      const claim = parseRepositoryPathClaim(path);
      await safeParents(root, path);
      let stat;
      try { stat = await lstat(join(root, path)); }
      catch (error) { if (absent(error)) { entries.push({ path: claim, desired: { state: "absent" } }); continue; } throw error; }
      if (stat.isSymbolicLink()) {
        const bytes = new TextEncoder().encode(await readlink(join(root, path)));
        entries.push({ path: claim, desired: { state: "present", file_type: "symlink", mode: "120000", bytes } });
        size += bytes.byteLength;
      } else if (stat.isFile()) {
        if (stat.size + size > BYTE_CAP) throw new SimpleReviewError("INPUT_TOO_LARGE", "Simple review snapshot exceeds 25 MiB of changed files.");
        const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes;
        try { bytes = new Uint8Array(await handle.readFile()); } finally { await handle.close(); }
        size += bytes.byteLength;
        entries.push({ path: claim, desired: { state: "present", file_type: "regular", mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644", bytes } });
      } else throw new SimpleReviewError("INPUT_INVALID", `Review requires file paths; unsupported entry: ${path}`);
      if (size > BYTE_CAP) throw new SimpleReviewError("INPUT_TOO_LARGE", "Simple review snapshot exceeds 25 MiB of changed files.");
    }
    return { entries };
  };
  const fingerprint = (projection: ReviewProjectionPlan) => canonicalJsonDigest(projection.entries.map(({ path, desired }) =>
    desired.state === "absent" ? { path, state: "absent" } : { path, state: "present", mode: desired.mode, digest: sha256Bytes(desired.bytes) }));
  const projection = await collect();
  const snapshot = fingerprint(projection);
  const views: DispatchRepositoryViewPlan = [{
    name: "primary", member_kind: "primary", repository_root: root,
    repository_identity_digest: canonicalJsonDigest({ root }), commit: parseGitOid(head), projection_plan: projection, snapshot_digest: snapshot,
  }, {
    name: "baseline", member_kind: "secondary", repository_root: root,
    repository_identity_digest: canonicalJsonDigest({ root }), commit: parseGitOid(head),
  }];
  const assertCurrent = async () => {
    const currentSnapshot = fingerprint(await collect());
    const currentPolicy = (await loadSimplePolicy(root)).policy_digest;
    if (currentSnapshot !== snapshot || currentPolicy !== policy.policy_digest ||
      (await simpleGit(root, ["rev-parse", "HEAD"], signal)).trim() !== head ||
      await simpleGit(root, ["rev-parse", "--symbolic-full-name", "HEAD"], signal) !== branch) {
      throw new SimpleReviewError("SUBJECT_CHANGED", "Repository bytes, branch, or review policy changed during review. These reports do not cover the current work.");
    }
  };
  await assertCurrent();
  return { root, policy, views, assertCurrent, subject_digest: canonicalJsonDigest({
    stage: input.stage, ask: input.ask, plan: input.plan, base_commit: input.base_commit, paths: input.paths,
    verification: input.verification ?? null, snapshot,
  }) };
}
