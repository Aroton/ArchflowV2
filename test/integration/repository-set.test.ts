import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { ConfigV1 } from "../../src/contracts/config.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { openRepository, resolveRepositorySet, unavailableRepositoryView } from "../../src/repository/repository-set.js";
import { cleanupTemporaryRepositories, createTempRepository, git, gitAvailable, temporaryRoot } from "../helpers/temp-repository.js";

const context: RepositoryOperationContext = Object.freeze({
  task_id: parseTaskSlug("repository-set"),
  phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(1) }),
  operation: parseSafeCode("resolve-repositories"),
  attempt: parseSafeInteger(1),
});

const tempRoot = (): string => temporaryRoot("repository-set");

/** Several members must share one parent so relative declarations such as `../apis` resolve. */
function repository(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, `${name}.txt`), `${name}\n`, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `root ${name}`);
  return root;
}

function config(repositories?: ConfigV1["repositories"]): ConfigV1 {
  return {
    schema_version: "1",
    roles: {},
    ...(repositories === undefined ? {} : { repositories }),
  };
}

async function primaryAt(path: string) {
  const opened = await openRepository(path, context);
  if (!opened.ok) throw new Error(opened.error.code);
  return opened.value;
}

afterAll(cleanupTemporaryRepositories);

describe.skipIf(!gitAvailable())("declared repository set", () => {
  it("keeps primary-only tasks compatible and reuses the shared successful binding", async () => {
    const root = repository(tempRoot(), "primary");
    const binding = await primaryAt(root);
    const again = await primaryAt(root);
    const resolved = await resolveRepositorySet(binding, config(), context);
    expect(again).toBe(binding);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.members).toHaveLength(1);
    expect(resolved.value.members[0]).toMatchObject({ name: "primary", mode: "writable", binding });
    expect(resolved.value.members[0]!.declared_path).toBeUndefined();
  });

  it("resolves relative and absolute declarations to actual roots in ordinal name order", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const apis = repository(parent, "apis");
    const stripe = repository(parent, "stripe");
    mkdirSync(join(apis, "inside"));
    const resolved = await resolveRepositorySet(await primaryAt(primary), config({
      stripe: { path: stripe, mode: "writable" },
      apis: { path: "../apis/inside" },
    }), context);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.members.map(({ name }) => name)).toEqual(["primary", "apis", "stripe"]);
    expect(resolved.value.members.map(({ mode }) => mode)).toEqual(["writable", "context-only", "writable"]);
    expect(resolved.value.members.map(({ binding }) => binding.runner.location.worktreeRoot)).toEqual([primary, apis, stripe]);
    expect(resolved.value.members.map(({ head }) => head)).toEqual([
      git(primary, "rev-parse", "HEAD"), git(apis, "rev-parse", "HEAD"), git(stripe, "rev-parse", "HEAD"),
    ]);
  });

  it("makes mapping-key order and machine-local locations irrelevant to the digest", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const apis = repository(parent, "apis");
    const stripe = repository(parent, "stripe");
    const binding = await primaryAt(primary);
    const first = await resolveRepositorySet(binding, config({
      stripe: { path: stripe }, apis: { path: apis, mode: "writable" },
    }), context);
    const second = await resolveRepositorySet(binding, config({
      apis: { path: "../apis", mode: "writable" }, stripe: { path: "../stripe" },
    }), context);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.members.map(({ name }) => name)).toEqual(first.value.members.map(({ name }) => name));
    expect(second.value.digest).toBe(first.value.digest);
  });

  it("observes HEAD live even when the successful binding is cached", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const secondary = repository(parent, "secondary");
    const binding = await primaryAt(primary);
    const first = await resolveRepositorySet(binding, config({ secondary: { path: secondary } }), context);
    writeFileSync(join(secondary, "later.txt"), "later\n", "utf8");
    git(secondary, "add", "-A");
    git(secondary, "commit", "-q", "-m", "later");
    const second = await resolveRepositorySet(binding, config({ secondary: { path: secondary } }), context);
    if (!first.ok || !second.ok) throw new Error("repository set must resolve");
    expect(second.value.members[1]!.binding).toBe(first.value.members[1]!.binding);
    expect(second.value.members[1]!.head).not.toBe(first.value.members[1]!.head);
  });

  it("rediscovers an interior declaration when it becomes a nested repository", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const secondary = repository(parent, "secondary");
    const inside = join(secondary, "inside");
    mkdirSync(inside);
    const binding = await primaryAt(primary);
    const first = await resolveRepositorySet(binding, config({ services: { path: inside } }), context);
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.members[1]!.binding.runner.location.worktreeRoot).toBe(secondary);

    git(inside, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(inside, "nested.txt"), "nested\n", "utf8");
    git(inside, "add", "-A");
    git(inside, "commit", "-q", "-m", "nested root");

    const second = await resolveRepositorySet(binding, config({ services: { path: inside } }), context);
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.members[1]!.binding.runner.location.worktreeRoot).toBe(inside);
    expect(second.value.members[1]!.identity.digest).not.toBe(first.value.members[1]!.identity.digest);
  });

  it("rediscovers a cached nested root when it becomes an interior path", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const secondary = repository(parent, "secondary");
    const nested = repository(secondary, "nested");
    const binding = await primaryAt(primary);
    const first = await resolveRepositorySet(binding, config({ services: { path: nested } }), context);
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.members[1]!.binding.runner.location.worktreeRoot).toBe(nested);

    rmSync(join(nested, ".git"), { recursive: true, force: true });

    const second = await resolveRepositorySet(binding, config({ services: { path: nested } }), context);
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.members[1]!.binding.runner.location.worktreeRoot).toBe(secondary);
    expect(second.value.members[1]!.binding).not.toBe(first.value.members[1]!.binding);
    expect(second.value.members[1]!.identity.digest).not.toBe(first.value.members[1]!.identity.digest);
  });

  it("rejects aliases of the primary and nested member roots with named safe diagnostics", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const secondary = repository(parent, "secondary");
    mkdirSync(join(primary, "inside"));
    const binding = await primaryAt(primary);
    const alias = await resolveRepositorySet(binding, config({ alias: { path: "inside" } }), context);
    expect(alias.ok).toBe(false);
    if (!alias.ok) {
      expect(alias.error.code).toBe("CONFIG_INVALID");
      if (alias.error.code !== "CONFIG_INVALID") throw new Error(alias.error.code);
      expect(alias.error.diagnostic.parameters.issues).toEqual([
        "repositories.alias.path: repository must be distinct and non-nested (overlaps primary)",
      ]);
      expect(JSON.stringify(alias.error)).not.toContain(primary);
      // A topology fault is a declaration problem, never a retryable missing view.
      expect(unavailableRepositoryView(alias.error)).toBeUndefined();
    }

    // A repository nested below a declared repository is independently discoverable but forbidden.
    const nested = repository(secondary, "nested");
    const contained = await resolveRepositorySet(binding, config({
      secondary: { path: secondary }, nested: { path: nested },
    }), context);
    expect(contained.ok).toBe(false);
    if (!contained.ok) {
      if (contained.error.code !== "CONFIG_INVALID") throw new Error(contained.error.code);
      expect(contained.error.diagnostic.parameters.issues?.[0]).toMatch(/^repositories\.(nested|secondary)\.path:/u);
    }
  });

  it("does not cache a failed open and names the declaration without exposing its resolved path", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const missing = join(parent, "missing");
    const binding = await primaryAt(primary);
    const failed = await resolveRepositorySet(binding, config({ services: { path: "../missing" } }), context);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("CONFIG_INVALID");
      if (failed.error.code !== "CONFIG_INVALID") throw new Error(failed.error.code);
      expect(failed.error.diagnostic.parameters.issues).toEqual([
        "repositories.services.path: repository could not be opened",
      ]);
      expect(JSON.stringify(failed.error)).not.toContain(missing);
      expect(unavailableRepositoryView(failed.error)).toEqual({ repository_name: "services", reason: "open" });
    }
    repository(parent, "missing");
    const retried = await resolveRepositorySet(binding, config({ services: { path: "../missing" } }), context);
    expect(retried.ok).toBe(true);
  });

  it("projects refused bare, shallow, submodule, and unborn shapes as one safe named config issue", async () => {
    const parent = tempRoot();
    const primary = repository(parent, "primary");
    const source = repository(parent, "source");
    const bare = join(parent, "bare.git");
    git(parent, "init", "--bare", "-q", bare);
    const unborn = join(parent, "unborn");
    mkdirSync(unborn);
    git(unborn, "-c", "init.defaultBranch=main", "init", "-q");
    const shallow = join(parent, "shallow");
    git(parent, "clone", "-q", "--depth=1", pathToFileURL(source).href, shallow);
    const superproject = repository(parent, "superproject");
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor");
    git(superproject, "commit", "-q", "-am", "add submodule");
    const binding = await primaryAt(primary);

    for (const [name, path] of Object.entries({ bare, shallow, submodule: join(superproject, "vendor"), unborn })) {
      const result = await resolveRepositorySet(binding, config({ [name]: { path } }), context);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      if (result.error.code !== "CONFIG_INVALID") throw new Error(result.error.code);
      expect(result.error.diagnostic.parameters.issues, name).toEqual([
        `repositories.${name}.path: ${name === "unborn" ? "repository identity could not be resolved" : "repository could not be opened"}`,
      ]);
      expect(JSON.stringify(result.error), name).not.toContain(path);
      expect(unavailableRepositoryView(result.error), name).toEqual({
        repository_name: name, reason: name === "unborn" ? "identity" : "open",
      });
    }
  });

  it("accepts a linked worktree of another member as a distinct root sharing that member's identity", async () => {
    const primary = repository(tempRoot(), "primary");
    const member = createTempRepository({ label: "repository-set-member" });
    member.write("member.txt", "member\n");
    member.commitAll("root member");
    const linked = member.addWorktree("linked", "linked");
    const resolved = await resolveRepositorySet(await primaryAt(primary), config({
      member: { path: member.path }, linked: { path: linked },
    }), context);
    if (!resolved.ok) throw new Error(resolved.error.code);
    const [, linkedMember, mainMember] = resolved.value.members;
    expect(resolved.value.members.map(({ name }) => name)).toEqual(["primary", "linked", "member"]);
    expect(linkedMember!.binding.runner.location.worktreeRoot).toBe(linked);
    expect(mainMember!.binding.runner.location.worktreeRoot).toBe(member.path);
    // Two worktrees of one repository are not rejected as overlapping roots; they share the
    // repository identity, so a declaration set naming both carries that identity twice.
    expect(linkedMember!.identity.digest).toBe(mainMember!.identity.digest);
  });
});
