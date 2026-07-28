/**
 * Phase 6, chunk 10 — the repository layer driven **end to end against real repositories**.
 *
 * What this suite is for, and what it deliberately is not: the five unit suites already prove each
 * module's claims *in isolation* — the five-repository EOL/mode matrix and the `check-attr` proof in
 * `test/unit/repository-index.test.ts`, the linked-worktree and relocation identity claims in
 * `test/unit/repository-identity.test.ts`, the raw-versus-validated conflict split in
 * `test/unit/repository-history.test.ts`. Re-asserting those here would buy nothing. What no unit
 * suite can show is that the modules **agree with each other** when chained:
 *
 *   createGitRunner → preflightGit → discoverWorktree → resolveRepositoryIdentity →
 *   computeTaskIdentity → resolveTaskPath / resolveRepositoryPath →
 *   readIndexEntries / checkArchflowAttributes → readHistoryStatus → classifyMutationReadiness
 *
 * So every assertion below is a *composition* assertion: the claim the resolver produced is the
 * claim the readers accept and return; the bytes at the resolved absolute path hash to the OID the
 * index reports; the conflicted path the history reader validated is the file that still parses on
 * disk; the identity digest is the same object no matter which worktree, subdirectory, or directory
 * name the chain was started from.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { gitBlobOid } from "../../src/contracts/canonical.js";
import type { ProjectResult } from "../../src/contracts/errors.js";
import {
  parseSafeCode,
  parseSafeInteger,
  parseTaskSlug,
  type TaskSlug,
} from "../../src/contracts/evidence.js";
import {
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  type RepositoryPathClaim,
  type TaskPathClaim,
} from "../../src/contracts/path-claims.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import {
  checkArchflowAttributes,
  type AttributeCheck,
} from "../../src/repository/attributes.js";
import {
  createGitRunner,
  preflightGit,
  type GitEnvironment,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import {
  classifyMutationReadiness,
  readHistoryStatus,
  type WorktreeHistoryStatus,
} from "../../src/repository/history.js";
import {
  computeTaskIdentity,
  discoverWorktree,
  resolveRepositoryIdentity,
  type RepositoryIdentity,
  type RootBoundGitRunner,
  type TaskIdentity,
  type WorktreeLocation,
} from "../../src/repository/identity.js";
import { readIndexEntries, type IndexEntry } from "../../src/repository/index-entries.js";
import {
  openResolved,
  resolveRepositoryPath,
  resolveTaskPath,
  type ResolvedPath,
  type ResolvedTaskPath,
} from "../../src/repository/paths.js";
import {
  cleanupTemporaryRepositories,
  createTempRepository,
  gitAvailable,
  git as rawGit,
} from "../helpers/temp-repository.js";

const hasGit = gitAvailable();

afterAll(() => {
  cleanupTemporaryRepositories();
});

const TASK_ID: TaskSlug = parseTaskSlug("mcp-integration");

const context: RepositoryOperationContext = {
  task_id: TASK_ID,
  phase_instance: encodePhaseInstance({
    kind: "phase-impl",
    phase: parsePositiveSafePhaseNumber(6),
  }),
  operation: parseSafeCode("startup-check"),
  attempt: parseSafeInteger(1),
};

// ---------------------------------------------------------------------------
// The chain under test
// ---------------------------------------------------------------------------

interface StackRequest {
  /** A claim rooted at `.archflow/tasks/<task>/`. */
  readonly taskClaim: TaskPathClaim;
  /** A claim rooted at the worktree. */
  readonly repositoryClaim: RepositoryPathClaim;
  /** Extra claims to read from the index alongside the two resolved ones. */
  readonly extraIndexClaims?: readonly RepositoryPathClaim[];
  /** Claims to check attributes for; defaults to the resolved task claim alone. */
  readonly attributeClaims?: readonly RepositoryPathClaim[];
}

interface StackResult {
  readonly environment: GitEnvironment;
  readonly location: WorktreeLocation;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly taskIdentity: TaskIdentity;
  readonly taskPath: ResolvedPath;
  readonly repositoryPath: ResolvedPath;
  readonly entries: readonly IndexEntry[];
  readonly attributes: readonly AttributeCheck[];
  readonly history: WorktreeHistoryStatus;
  readonly readiness: ProjectResult<void>;
}

function unwrap<T>(result: ProjectResult<T>, step: string): T {
  if (!result.ok) throw new Error(`${step} failed: ${result.error.code}`);
  return result.value;
}

/**
 * The whole layer, in the pinned order, from one starting directory. Every later step consumes the
 * value the previous step produced — the runner is never re-created, the claim is never re-spelled —
 * which is exactly what makes the assertions below composition assertions rather than repeats.
 */
async function driveStack(directory: string, request: StackRequest): Promise<StackResult> {
  const runner = createGitRunner({ cwd: directory });
  const environment = unwrap(await preflightGit(runner, context), "preflightGit");
  const bound: RootBoundGitRunner = unwrap(
    await discoverWorktree(runner, context),
    "discoverWorktree"
  );

  const repositoryIdentity = unwrap(
    await resolveRepositoryIdentity(bound, environment, context),
    "resolveRepositoryIdentity"
  );
  const taskIdentity = computeTaskIdentity(TASK_ID, repositoryIdentity);

  const taskPath = unwrap(
    await resolveTaskPath({ runner: bound, taskId: TASK_ID, claim: request.taskClaim, context }),
    "resolveTaskPath"
  );
  const repositoryPath = unwrap(
    await resolveRepositoryPath({ runner: bound, claim: request.repositoryClaim, context }),
    "resolveRepositoryPath"
  );

  const indexClaims = [
    taskPath.repositoryRelative,
    repositoryPath.repositoryRelative,
    ...(request.extraIndexClaims ?? []),
  ];
  const entries = unwrap(await readIndexEntries(bound, indexClaims, context), "readIndexEntries");
  const attributes = unwrap(
    await checkArchflowAttributes(
      bound,
      request.attributeClaims ?? [taskPath.repositoryRelative],
      context
    ),
    "checkArchflowAttributes"
  );

  const history = unwrap(await readHistoryStatus(bound, context), "readHistoryStatus");
  const readiness = classifyMutationReadiness(history, context);

  return {
    environment,
    location: bound.location,
    repositoryIdentity,
    taskIdentity,
    taskPath,
    repositoryPath,
    entries,
    attributes,
    history,
    readiness,
  };
}

/** Reads the bytes at a resolved path through the layer's own sanctioned open (containment step 7). */
async function readResolved(path: ResolvedTaskPath): Promise<Buffer> {
  const handle = await openResolved(path, 0);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function entryFor(result: StackResult, claim: string): IndexEntry {
  const entry = result.entries.find((candidate) => (candidate.path as string) === claim);
  if (entry === undefined) throw new Error(`no index entry for ${claim}`);
  return entry;
}

const stateClaim = parseTaskPathClaim("state.json");
const workflowClaim = parseRepositoryPathClaim(".archflow/workflow.yaml");
const stateRepositoryClaim = `.archflow/tasks/${TASK_ID}/state.json`;

/** A repository whose `.archflow/` tree is exactly what the resolvers will claim. */
function seededRepository(
  label: string,
  options: {
    readonly config?: Readonly<Record<string, string>>;
    readonly directoryName?: string;
    readonly stateBytes?: Buffer;
  } = {}
): ReturnType<typeof createTempRepository> {
  const repository = createTempRepository({
    label,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.directoryName === undefined ? {} : { directoryName: options.directoryName }),
  });
  repository.write(stateRepositoryClaim, options.stateBytes ?? '{"v":0}\n');
  repository.write(".archflow/workflow.yaml", "steps: []\n");
  repository.write("src/main.ts", "export const x = 1;\n");
  repository.write("sub/nested/.keep", "");
  repository.commitAll("seed");
  return repository;
}

const standardRequest: StackRequest = {
  taskClaim: stateClaim,
  repositoryClaim: workflowClaim,
  attributeClaims: [parseRepositoryPathClaim(stateRepositoryClaim), workflowClaim],
};

// ---------------------------------------------------------------------------
// 1. The five-repository matrix, composed
// ---------------------------------------------------------------------------

/**
 * Verification step 3, driven through the whole chain rather than through `readIndexEntries` alone.
 *
 * The unit suite already proves the index OID equals the in-process OID of the *fixture buffer* at
 * each configuration. The composed claim here is the one the rest of the design rests on: the bytes
 * **the path resolver hands you, opened through `openResolved`** hash to the OID the index reports.
 * That is what licenses hashing a file in process instead of shelling out to `git hash-object`, and
 * it is a statement about two modules agreeing, so no unit can make it.
 */
describe.skipIf(!hasGit)("five-repository matrix, composed through the whole layer", () => {
  const crlf = Buffer.from('{\r\n  "v": 0\r\n}\r\n', "utf8");
  const collapsed: string[] = [];

  for (const autocrlf of ["false", "true", "input"] as const) {
    it(`agrees on OID and mode at core.autocrlf=${autocrlf}`, async () => {
      const repository = seededRepository(`matrix-autocrlf-${autocrlf}`, {
        config: { "core.autocrlf": autocrlf },
        stateBytes: crlf,
      });

      const result = await driveStack(repository.path, standardRequest);
      const entry = entryFor(result, stateRepositoryClaim);

      // The resolver's claim is the reader's claim is the resolver's absolute path.
      expect(result.taskPath.path_class).toBe("task-state");
      expect(result.taskPath.repositoryRelative).toBe(stateRepositoryClaim);
      expect(result.taskPath.absolute).toBe(join(repository.path, stateRepositoryClaim));

      // The composed claim: disk bytes → in-process OID → index OID, all three the same value.
      const onDisk = await readResolved(result.taskPath.absolute);
      expect(onDisk.equals(crlf)).toBe(true);
      expect(entry.oid).toBe(gitBlobOid(onDisk));
      expect(entry.oid).toBe(repository.hashObject(crlf));
      expect(entry.mode).toBe("100644");
      expect(entry.stage).toBe(0);

      // …and the attribute reader agrees the rule that licenses it is in force for that same claim.
      expect(result.attributes).toEqual([
        { path: stateRepositoryClaim, text: "unset", merge: "binary" },
        { path: ".archflow/workflow.yaml", text: "unset", merge: "binary" },
      ]);

      collapsed.push(entry.oid);
    });
  }

  it("collapses all three autocrlf configurations to one OID", () => {
    expect(collapsed).toHaveLength(3);
    expect(new Set(collapsed).size).toBe(1);
  });

  it("keeps the mode index-sourced at core.fileMode=false with the exec bit set on disk", async () => {
    const repository = seededRepository("matrix-filemode", {
      config: { "core.fileMode": "false" },
      stateBytes: crlf,
    });
    repository.chmod(stateRepositoryClaim, 0o755);

    const result = await driveStack(repository.path, standardRequest);
    const entry = entryFor(result, stateRepositoryClaim);

    // The filesystem says 0o755; the index says 100644, and the index is the only authority. The
    // resolved path is still openable and still hashes to the index OID.
    expect(entry.mode).toBe("100644");
    expect(gitBlobOid(await readResolved(result.taskPath.absolute))).toBe(entry.oid);
    expect(result.readiness.ok).toBe(true);
  });

  it("keeps mode 120000 and a content-derived OID at core.symlinks=false", async () => {
    const repository = seededRepository("matrix-symlinks", {
      config: { "core.symlinks": "false" },
    });
    // A symlink-incapable checkout stores the target path as a blob with no trailing newline while
    // the index still records 120000, so there is nothing on disk to open — index-sourced mode plus
    // content-derived OID is the whole answer, and the composed point is that the *repository*
    // resolver reaches the entry just as the task resolver reaches a regular file.
    const target = Buffer.from(`${stateRepositoryClaim}`, "utf8");
    const blob = repository.hashObject(target);
    repository.git("update-index", "--add", "--cacheinfo", `120000,${blob},link.txt`);

    const linkClaim = parseRepositoryPathClaim("link.txt");
    const result = await driveStack(repository.path, {
      ...standardRequest,
      repositoryClaim: linkClaim,
    });

    expect(result.repositoryPath.path_class).toBe("repository-source");
    const entry = entryFor(result, "link.txt");
    expect(entry.mode).toBe("120000");
    expect(entry.oid).toBe(blob);
    expect(entry.oid).toBe(gitBlobOid(target));
  });
});

// ---------------------------------------------------------------------------
// 2. The subdirectory reproduction
// ---------------------------------------------------------------------------

/**
 * Verification step 4, composed. The unit suites assert *per reader* that a subdirectory answers
 * like the root; the phase's headline defence is stronger than that — the whole chain, started from
 * anywhere inside the worktree, must produce one identical result object, including the identity and
 * task-identity digests that later manifests bind.
 */
describe.skipIf(!hasGit)("the full stack from a subdirectory equals the full stack from the root", () => {
  it("produces an identical composed result from the root and a nested subdirectory", async () => {
    const repository = seededRepository("subdirectory");

    const fromRoot = await driveStack(repository.path, standardRequest);
    const fromNested = await driveStack(join(repository.path, "sub", "nested"), standardRequest);

    expect(fromNested).toStrictEqual(fromRoot);
    expect(fromNested.location.worktreeRoot).toBe(repository.path);
    expect(fromNested.repositoryIdentity.digest).toBe(fromRoot.repositoryIdentity.digest);
    expect(fromNested.taskIdentity.digest).toBe(fromRoot.taskIdentity.digest);
    expect(fromNested.taskPath.repositoryRelative).toBe(stateRepositoryClaim);
  });
});

// ---------------------------------------------------------------------------
// 3. Unicode filenames, composed
// ---------------------------------------------------------------------------

/**
 * Verification step 5's first half, composed. The unit suite proves `-z` round-trips
 * `.archflow/ü space.json` unquoted through each reader; the composed claim is that a name with a
 * space and non-ASCII text survives *resolution* too — the task claim, the composed repository
 * claim, the index entry, and the attribute check are all byte-equal, unquoted, with no C-style
 * unquoting anywhere in the chain.
 *
 * The pathspec-metacharacter half of step 5 is **not** repeated here: `test/unit/repository-index.test.ts`
 * already asserts that `*`, `?`, and `[` are rejected by the claim schema before any Git call, and a
 * rejection that happens before the first subprocess has no composed behaviour to observe.
 */
describe.skipIf(!hasGit)("a Unicode, space-containing name round-trips the whole chain", () => {
  it("resolves, indexes, and attributes the same unquoted name", async () => {
    const digest = "a".repeat(64);
    const payloadClaim = parseTaskPathClaim(`results/sha256/${digest}/payload/ü space.json`);
    const payloadRepositoryClaim = `.archflow/tasks/${TASK_ID}/results/sha256/${digest}/payload/ü space.json`;

    const repository = seededRepository("unicode");
    repository.write(payloadRepositoryClaim, '{"u":"ü"}\n');
    repository.commitAll("payload");

    const result = await driveStack(repository.path, {
      taskClaim: payloadClaim,
      repositoryClaim: workflowClaim,
      attributeClaims: [parseRepositoryPathClaim(payloadRepositoryClaim)],
    });

    expect(result.taskPath.path_class).toBe("result-payload");
    expect(result.taskPath.repositoryRelative).toBe(payloadRepositoryClaim);

    const entry = entryFor(result, payloadRepositoryClaim);
    expect(entry.mode).toBe("100644");
    expect(entry.oid).toBe(gitBlobOid(await readResolved(result.taskPath.absolute)));
    expect(result.attributes).toEqual([
      { path: payloadRepositoryClaim, text: "unset", merge: "binary" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. The forced-conflict proof
// ---------------------------------------------------------------------------

/**
 * Verification step 7 — the property the whole design leans on, asserted where all three of its
 * halves meet: `merge=binary` makes a conflicted `.archflow/` JSON file **still parse**, while both
 * of Git's independent conflict channels still report it unmerged, and a conflicted file whose name
 * no ArchFlow claim can express neither throws nor disappears.
 *
 * The unit suite asserts the raw/validated split and that `git show :2:` carries no markers. What is
 * composed here: the file the *history reader* validated is the file the *path resolver* resolves,
 * and it is the bytes on disk — not a staged blob — that parse.
 */
describe.skipIf(!hasGit)("forced conflict on an .archflow/ file", () => {
  /** A colon, a trailing dot, and an NFD name: all legal on ext4, none expressible as a claim. */
  const UNREPRESENTABLE = ["weird:name.txt", "trailing.", "cafe\u0301.txt"] as const;
  const CONTROL = "control.txt";

  async function conflicted(): Promise<{
    readonly repository: ReturnType<typeof createTempRepository>;
    readonly result: StackResult;
  }> {
    const repository = createTempRepository({ label: "conflict" });
    repository.write(".archflow/workflow.yaml", "steps: []\n");
    // The `.archflow/` file is real JSON in every variant, because "it still parses" is the claim.
    repository.forceConflict(
      [stateRepositoryClaim, CONTROL, ...UNREPRESENTABLE],
      (name, variant) =>
        name === stateRepositoryClaim ? `{"v":"${variant}"}\n` : `${variant}\n`
    );
    return { repository, result: await driveStack(repository.path, standardRequest) };
  }

  it("reports the conflict on both channels while the file still parses on disk", async () => {
    const { repository, result } = await conflicted();

    // The history reader validated exactly our claim…
    expect(result.history.conflictedArchflowPaths).toEqual([stateRepositoryClaim]);
    expect(result.readiness.ok).toBe(false);
    if (result.readiness.ok) throw new Error("unreachable");
    expect(result.readiness.error.code).toBe("GIT_CONFLICT");
    expect(result.readiness.error.diagnostic.parameters).toEqual({ operation: "startup-check" });

    // …and both of Git's independent channels agree with it.
    const porcelain = repository.git("status", "--porcelain=v2", "--branch");
    expect(porcelain).toContain("u UU");
    expect(porcelain).toContain(stateRepositoryClaim);
    const unmerged = repository
      .git("diff", "--name-only", "--diff-filter=U")
      .split("\n")
      .filter((line) => line !== "");
    expect(unmerged).toContain(stateRepositoryClaim);
    expect(unmerged).toContain(CONTROL);

    // The composed claim: the bytes at the *resolved* path carry no markers and still parse, while
    // the control file — same conflict, no `merge=binary` — is a marker sandwich.
    const archflowBytes = await readResolved(result.taskPath.absolute);
    const archflowText = archflowBytes.toString("utf8");
    expect(archflowText).not.toContain("<<<<<<<");
    expect(archflowText).not.toContain(">>>>>>>");
    expect(() => JSON.parse(archflowText) as unknown).not.toThrow();

    const controlText = readFileSync(join(repository.path, CONTROL), "utf8");
    expect(controlText).toContain("<<<<<<<");
    expect(controlText).toContain(">>>>>>>");

    // The index reader sees the same path unmerged as three stages, all still mode 100644.
    expect(result.entries.filter((entry) => (entry.path as string) === stateRepositoryClaim)).toEqual(
      [1, 2, 3].map((stage) => ({
        path: stateRepositoryClaim,
        mode: "100644",
        oid: expect.stringMatching(/^[0-9a-f]{40}$/u),
        stage,
      }))
    );
  });

  it("keeps unrepresentable conflicted names raw and counted, without throwing", async () => {
    const { result } = await conflicted();

    expect([...result.history.conflictedOtherPaths].sort()).toEqual(
      [CONTROL, ...UNREPRESENTABLE].sort()
    );
    expect(result.history.unrepresentableOtherConflicts).toBe(UNREPRESENTABLE.length);
    // The whole chain ran to completion around them: nothing threw, and the readiness verdict came
    // from the `.archflow/` conflict rather than from any of these.
    expect(result.history.inProgress).toEqual(["merge"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Linked worktree and relocation
// ---------------------------------------------------------------------------

/**
 * Verification step 8, composed. `test/unit/repository-identity.test.ts` already proves the digest is
 * shared by a linked worktree and survives relocation. What is new here is that the *readers* run
 * correctly in a linked worktree at all — `readHistoryStatus` probes in-progress markers under the
 * **per-worktree** `gitDir`, which no unit exercises — and that the whole chain, including path
 * resolution against a directory whose name contains spaces and non-ASCII text, agrees.
 */
describe.skipIf(!hasGit)("linked worktrees and relocation", () => {
  it("produces one identity and working readers in both the main and a linked worktree", async () => {
    const repository = seededRepository("worktree", { directoryName: "ré po ü space" });
    const linked = repository.addWorktree("linked wt ü", "other");

    const fromMain = await driveStack(repository.path, standardRequest);
    const fromLinked = await driveStack(linked, standardRequest);

    expect(fromLinked.repositoryIdentity.digest).toBe(fromMain.repositoryIdentity.digest);
    expect(fromLinked.taskIdentity.digest).toBe(fromMain.taskIdentity.digest);

    // Same repository, different worktree: the git dir is per-worktree, the common dir is shared.
    expect(fromLinked.location.linked).toBe(true);
    expect(fromLinked.location.gitCommonDir).toBe(fromMain.location.gitDir);
    expect(fromLinked.location.gitDir).not.toBe(fromMain.location.gitDir);

    // The readers answer from the linked worktree's own checkout, on its own branch.
    expect(fromLinked.taskPath.absolute).toBe(join(linked, stateRepositoryClaim));
    expect(entryFor(fromLinked, stateRepositoryClaim).oid).toBe(
      entryFor(fromMain, stateRepositoryClaim).oid
    );
    expect(fromLinked.attributes).toEqual(fromMain.attributes);
    expect(fromMain.history.branch).toBe("main");
    expect(fromLinked.history.branch).toBe("other");
    expect(fromLinked.history.inProgress).toEqual([]);
    expect(fromLinked.readiness.ok).toBe(true);
  });

  it("is unchanged when the repository directory is relocated and renamed", async () => {
    const repository = seededRepository("relocate", { directoryName: "before" });

    const before = await driveStack(repository.path, standardRequest);
    const moved = repository.relocate("after moved ü space");
    const after = await driveStack(moved, standardRequest);

    expect(after.repositoryIdentity).toStrictEqual(before.repositoryIdentity);
    expect(after.taskIdentity).toStrictEqual(before.taskIdentity);
    expect(after.entries).toStrictEqual(before.entries);
    expect(after.attributes).toStrictEqual(before.attributes);
    // Only the absolute path moves; the claim frame is path-free by construction.
    expect(after.taskPath.repositoryRelative).toBe(before.taskPath.repositoryRelative);
    expect(after.taskPath.absolute).toBe(join(moved, stateRepositoryClaim));
    expect(after.taskPath.absolute).not.toBe(before.taskPath.absolute);
  });
});

// ---------------------------------------------------------------------------
// The reproduced silent wrong answer, once, at the composed level
// ---------------------------------------------------------------------------

/**
 * The hole the root-bound runner closes, reproduced against the same fixture the chain just used:
 * an *unbound* `git` in a subdirectory answers wrongly with no error at all. The unit suite proves
 * the readers are unwritable with an unbound runner; this proves the wrong answer is real in the
 * exact repository shape the composed chain gets right.
 */
describe.skipIf(!hasGit)("the unbound-runner hole, against the composed fixture", () => {
  it("returns nothing from ls-files and text: auto from check-attr in a subdirectory", async () => {
    const repository = seededRepository("unbound");
    const nested = join(repository.path, "sub", "nested");

    expect(rawGit(nested, "ls-files", "-s", "--", stateRepositoryClaim)).toBe("");
    expect(rawGit(nested, "check-attr", "text", "merge", "--", stateRepositoryClaim)).toContain(
      "text: auto"
    );

    const bound = await driveStack(nested, standardRequest);
    expect(entryFor(bound, stateRepositoryClaim).mode).toBe("100644");
    expect(bound.attributes[0]?.text).toBe("unset");
  });
});
