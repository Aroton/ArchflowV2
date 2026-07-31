import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { parsePathSafeId, parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import {
  REPOSITORY_PATH_CLASSES,
  TASK_PATH_CLASSES,
  adjudicationReviewClaim,
  counterReviewClaim,
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  selfReviewClaim,
  triageReviewClaim,
  type PathClass,
  type RepositoryPathClaim,
  type RepositoryPathClass,
  type TaskPathClaim,
  type TaskPathClass,
} from "../../src/contracts/path-claims.js";
import { createGitRunner, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import {
  classifyRepositoryPath,
  classifyTaskPath,
  gateCounterReviewClaim,
  gateDecisionClaim,
  gateRequestClaim,
  openResolved,
  resolveRepositoryPath,
  resolveTaskRoot,
  resolveTaskPath,
  type ResolvedTaskPath,
} from "../../src/repository/paths.js";

const TASK_ID = parseTaskSlug("demo-task");

describe("gate path constructors", () => {
  it("constructs deterministic decision and gate-counter claims", () => {
    const gateId = parsePathSafeId("gate-1");
    const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(6) });
    expect(gateRequestClaim(gateId)).toBe("decisions/gate-1/request.json");
    expect(gateDecisionClaim(gateId)).toBe("decisions/gate-1/decision.json");
    expect(gateCounterReviewClaim(phase, gateId)).toBe("reviews/phase-impl-6.gate-counter.gate-1.md");
  });

  it("constructs every fixed-point review projection and round-trips the review classifier", () => {
    const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(6) });
    const claims = [
      selfReviewClaim(phase),
      counterReviewClaim(phase),
      triageReviewClaim(phase),
      adjudicationReviewClaim(phase),
    ];
    expect(claims).toEqual([
      "reviews/phase-impl-6.self.md",
      "reviews/phase-impl-6.counter.md",
      "reviews/phase-impl-6.triage.md",
      "reviews/phase-impl-6.adjudication.md",
    ]);
    for (const claim of claims) {
      expect(classifyTaskPath(TASK_ID, claim)).toMatchObject({ ok: true, value: "review" });
    }
  });
});

const context: RepositoryOperationContext = {
  task_id: TASK_ID,
  phase_instance: encodePhaseInstance({
    kind: "phase-impl",
    phase: parsePositiveSafePhaseNumber(6),
  }),
  operation: parseSafeCode("startup-check"),
  attempt: parseSafeInteger(1),
};

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "archflow-paths-")));
  temporaryRoots.push(directory);
  return directory;
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** A real repository, because containment is a filesystem control and a stub would prove nothing. */
function initRepository(directory: string): string {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
    cwd: directory,
    env: GIT_ENV,
  });
  writeFileSync(join(directory, "a.txt"), "root\n", "utf8");
  execFileSync("git", ["add", "--", "a.txt"], { cwd: directory, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: directory, env: GIT_ENV });
  return directory;
}

async function runnerAt(directory: string): Promise<RootBoundGitRunner> {
  const result = await discoverWorktree(createGitRunner({ cwd: directory }), context);
  if (!result.ok) throw new Error(`discovery failed: ${result.error.code}`);
  return result.value;
}

/** A fresh repository plus a parent, so sibling-prefix directories can live beside the root. */
async function freshWorktree(): Promise<{
  readonly parent: string;
  readonly root: string;
  readonly runner: RootBoundGitRunner;
}> {
  const parent = temporaryDirectory();
  const root = initRepository(join(parent, "root"));
  return { parent, root, runner: await runnerAt(root) };
}

/**
 * Containment must be testable independently of the lexical schema, so these casts deliberately
 * bypass `parseTaskPathClaim` / `parseRepositoryPathClaim`. Production code can only obtain a claim
 * through the parsers.
 */
const asTaskClaim = (value: string): TaskPathClaim => value as unknown as TaskPathClaim;
const asRepositoryClaim = (value: string): RepositoryPathClaim =>
  value as unknown as RepositoryPathClaim;

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

interface TaskSample {
  readonly path_class: TaskPathClass;
  readonly claims: readonly string[];
}

/** Every task-scoped class of the seventeen, with each template form the table pins. */
const TASK_SAMPLES: readonly TaskSample[] = [
  { path_class: "task-config", claims: ["config.yaml"] },
  { path_class: "task-state", claims: ["state.json"] },
  { path_class: "gate-interface", claims: ["gate.json", "gate.decision"] },
  {
    path_class: "document",
    claims: ["prd.md", "design.md", "phases/6/design.md", "phases/6/impl-notes.md"],
  },
  {
    path_class: "review",
    claims: [
      "reviews/prd.self.md",
      "reviews/design.counter.md",
      "reviews/phase-design-6.triage.md",
      "reviews/phase-impl-6.adjudication.md",
      "reviews/phase-impl-6.gate-counter.gate-1.md",
    ],
  },
  {
    path_class: "decision",
    claims: ["decisions/gate-1/request.json", "decisions/gate-1/decision.json"],
  },
  { path_class: "result-manifest", claims: [`results/sha256/${DIGEST_A}/manifest.json`] },
  { path_class: "result-payload", claims: [`results/sha256/${DIGEST_A}/payload/src/index.ts`] },
  { path_class: "intent", claims: ["intents/intent-1.json"] },
  { path_class: "attempt", claims: ["attempts/phase-impl-6/attempt-1.json"] },
  { path_class: "manual-checkpoint", claims: [`manual/checkpoints/3-${DIGEST_B}.json`] },
  { path_class: "maintenance-record", claims: ["maintenance/vacuum-1.json"] },
  {
    path_class: "import",
    claims: [`imports/${DIGEST_B}/manifest.json`, `imports/${DIGEST_B}/payload/legacy/notes.md`],
  },
];

interface RepositorySample {
  readonly path_class: RepositoryPathClass;
  readonly claims: readonly string[];
  /** `task-branch-constitution` is reachable only by caller narrowing, never by classification. */
  readonly classifiesAs: RepositoryPathClass;
}

const REPOSITORY_SAMPLES: readonly RepositorySample[] = [
  {
    path_class: "shared-workflow",
    claims: [".archflow/workflow.yaml"],
    classifiesAs: "shared-workflow",
  },
  {
    path_class: "shared-constitution",
    claims: [".archflow/constitution/base.md"],
    classifiesAs: "shared-constitution",
  },
  {
    path_class: "task-branch-constitution",
    claims: [".archflow/constitution/base.md"],
    classifiesAs: "shared-constitution",
  },
  {
    path_class: "repository-source",
    claims: ["src/index.ts", "docs/readme.md"],
    classifiesAs: "repository-source",
  },
];

describe.skipIf(!hasGit)("the seventeen-class table", () => {
  it("covers every class exactly once across the two frames", () => {
    expect(TASK_SAMPLES.map((sample) => sample.path_class)).toEqual([...TASK_PATH_CLASSES]);
    expect(REPOSITORY_SAMPLES.map((sample) => sample.path_class)).toEqual([
      ...REPOSITORY_PATH_CLASSES,
    ]);
    expect(TASK_SAMPLES.length + REPOSITORY_SAMPLES.length).toBe(17);
  });

  it("resolves every task-scoped class through the resolver that owns it", async () => {
    const { root, runner } = await freshWorktree();
    for (const sample of TASK_SAMPLES) {
      for (const value of sample.claims) {
        const claim = parseTaskPathClaim(value);
        expect(classifyTaskPath(TASK_ID, claim)).toMatchObject({
          ok: true,
          value: sample.path_class,
        });

        const result = await resolveTaskPath({
          runner,
          taskId: TASK_ID,
          claim,
          expectedClass: sample.path_class,
          context,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.value.path_class).toBe(sample.path_class);
        expect(result.value.repositoryRelative).toBe(`.archflow/tasks/${TASK_ID}/${value}`);
        expect(result.value.absolute).toBe(join(root, ".archflow", "tasks", TASK_ID, value));
      }
    }
  });

  it("rejects every task-scoped class through the repository resolver", async () => {
    const { runner } = await freshWorktree();
    for (const sample of TASK_SAMPLES) {
      for (const value of sample.claims) {
        // The worktree-frame spelling of a task path: valid lexically, wrong frame semantically.
        const claim = parseRepositoryPathClaim(`.archflow/tasks/${TASK_ID}/${value}`);
        expect(classifyRepositoryPath(claim).ok).toBe(false);

        const result = await resolveRepositoryPath({ runner, claim, context });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe("PATH_INVALID");
      }
    }
  });

  it("resolves every repository-scoped class through the resolver that owns it", async () => {
    const { root, runner } = await freshWorktree();
    for (const sample of REPOSITORY_SAMPLES) {
      for (const value of sample.claims) {
        const claim = parseRepositoryPathClaim(value);
        expect(classifyRepositoryPath(claim)).toMatchObject({
          ok: true,
          value: sample.classifiesAs,
        });

        const result = await resolveRepositoryPath({
          runner,
          claim,
          expectedClass: sample.path_class,
          context,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.value.path_class).toBe(sample.path_class);
        expect(result.value.repositoryRelative).toBe(value);
        expect(result.value.absolute).toBe(join(root, value));
      }
    }
  });

  it("rejects every repository-scoped class through the task resolver", async () => {
    const { runner } = await freshWorktree();
    for (const sample of REPOSITORY_SAMPLES) {
      for (const value of sample.claims) {
        const claim = parseTaskPathClaim(value);
        expect(classifyTaskPath(TASK_ID, claim).ok).toBe(false);

        const result = await resolveTaskPath({ runner, taskId: TASK_ID, claim, context });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe("PATH_INVALID");
      }
    }
  });

  it("narrows shared-constitution to task-branch-constitution only when the caller declares it", async () => {
    const { runner } = await freshWorktree();
    const claim = parseRepositoryPathClaim(".archflow/constitution/base.md");

    // A path alone cannot decide between the two: they name the same file and differ by operation.
    expect(classifyRepositoryPath(claim)).toMatchObject({ ok: true, value: "shared-constitution" });

    const shared = await resolveRepositoryPath({ runner, claim, context });
    expect(shared.ok && shared.value.path_class).toBe("shared-constitution");

    const branch = await resolveRepositoryPath({
      runner,
      claim,
      expectedClass: "task-branch-constitution",
      context,
    });
    expect(branch.ok && branch.value.path_class).toBe("task-branch-constitution");
  });

  it("rejects a claim whose class is not the class the caller expected", async () => {
    const { runner } = await freshWorktree();
    const result = await resolveTaskPath({
      runner,
      taskId: TASK_ID,
      claim: parseTaskPathClaim("state.json"),
      expectedClass: "task-config",
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_INVALID");
    expect(result.error.diagnostic.parameters).toEqual({
      task_id: TASK_ID,
      path_class: "task-config",
    });
  });
});

// ---------------------------------------------------------------------------
// Verification step 10 — the path matrix
// ---------------------------------------------------------------------------

/** Entries that must escape containment even when the lexical gate is bypassed. */
const ESCAPING_MATRIX: ReadonlyArray<readonly [label: string, value: string]> = [
  ["../escape", "../escape"],
  ["a/../../etc/passwd", "a/../../etc/passwd"],
  ["/etc/passwd", "/etc/passwd"],
  ["C:foo", "C:foo"],
  ["D:..\\x", "D:..\\x"],
  ["\\\\?\\C:\\x", "\\\\?\\C:\\x"],
  ["\\\\server\\share\\y", "\\\\server\\share\\y"],
  ["a NUL byte", "a\u0000b"],
];

/**
 * Entries the *lexical* schema owns. On Linux these name perfectly ordinary files, so containment
 * accepts them; the defence is chunk 2's claim schema, and saying otherwise would misattribute it.
 */
const LEXICAL_MATRIX: ReadonlyArray<readonly [label: string, value: string]> = [
  ["file.txt:stream", "file.txt:stream"],
  ["CON", "CON"],
  ["CON.txt", "CON.txt"],
  ["a.", "a."],
  ["a (trailing space)", "a "],
  ["an NFD segment", "cafe\u0301/notes.md"],
  ["a*b", "a*b"],
  ["a?b", "a?b"],
  ["a[b]", "a[b]"],
  ["a<b", "a<b"],
  ["a|b", "a|b"],
];

const FULL_MATRIX = [...ESCAPING_MATRIX, ...LEXICAL_MATRIX];

describe.skipIf(!hasGit)("verification step 10 — the path matrix", () => {
  it.each(FULL_MATRIX)("the lexical gate rejects %s in both frames", (_label, value) => {
    expect(() => parseTaskPathClaim(value)).toThrow();
    expect(() => parseRepositoryPathClaim(value)).toThrow();
  });

  it.each(FULL_MATRIX)(
    "the task resolver rejects %s even with the lexical gate bypassed",
    async (_label, value) => {
      const { runner } = await freshWorktree();
      const task = await resolveTaskPath({
        runner,
        taskId: TASK_ID,
        claim: asTaskClaim(value),
        context,
      });
      expect(task.ok).toBe(false);
    }
  );

  it.each(ESCAPING_MATRIX)(
    "the repository resolver rejects %s even with the lexical gate bypassed",
    async (_label, value) => {
      const { runner } = await freshWorktree();
      // The repository frame classifies anything outside `.archflow/` as `repository-source`, so
      // this arm reaches containment rather than stopping at classification.
      const repository = await resolveRepositoryPath({
        runner,
        claim: asRepositoryClaim(value),
        context,
      });
      expect(repository.ok).toBe(false);
    }
  );

  it.each(ESCAPING_MATRIX)(
    "containment independently rejects %s with PATH_ESCAPE",
    async (_label, value) => {
      const { runner } = await freshWorktree();

      const repository = await resolveRepositoryPath({
        runner,
        claim: asRepositoryClaim(value),
        context,
      });
      expect(repository.ok).toBe(false);
      if (repository.ok) return;
      expect(repository.error.code).toBe("PATH_ESCAPE");
      expect(repository.error.diagnostic.parameters).toEqual({
        task_id: TASK_ID,
        path_class: "repository-source",
      });
    }
  );

  it.each(LEXICAL_MATRIX)(
    "containment alone accepts %s — the lexical schema is what rejects it",
    async (_label, value) => {
      const { runner } = await freshWorktree();
      const result = await resolveRepositoryPath({
        runner,
        claim: asRepositoryClaim(value),
        context,
      });
      expect(result.ok).toBe(true);
    }
  );

  it("rejects a lexically traversing tail inside a classifying template as PATH_INVALID", async () => {
    const { runner } = await freshWorktree();
    const claim = asTaskClaim(`results/sha256/${DIGEST_A}/payload/${"../".repeat(12)}etc/passwd`);

    // The template matches, so classification passes; re-framing to the worktree is what rejects it,
    // because `.archflow/tasks/<task-id>/…` composed with `..` segments is not a valid claim.
    expect(classifyTaskPath(TASK_ID, claim)).toMatchObject({ ok: true, value: "result-payload" });

    const result = await resolveTaskPath({ runner, taskId: TASK_ID, claim, context });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_INVALID");
    expect(result.error.diagnostic.parameters).toEqual({
      task_id: TASK_ID,
      path_class: "result-payload",
    });
  });

  it("rejects a symlinked escape inside a classifying template as PATH_ESCAPE", async () => {
    const { parent, root, runner } = await freshWorktree();
    const outside = join(parent, "outside-payload");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "index.ts"), "secret\n", "utf8");

    const payload = join(root, ".archflow", "tasks", TASK_ID, "results", "sha256", DIGEST_A, "payload");
    mkdirSync(payload, { recursive: true });
    symlinkSync(outside, join(payload, "src"));

    const claim = parseTaskPathClaim(`results/sha256/${DIGEST_A}/payload/src/index.ts`);
    const result = await resolveTaskPath({ runner, taskId: TASK_ID, claim, context });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_ESCAPE");
    expect(result.error.diagnostic.parameters).toEqual({
      task_id: TASK_ID,
      path_class: "result-payload",
    });
  });
});

// ---------------------------------------------------------------------------
// The seven containment steps, each exercised on its own
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit)("containment steps", () => {
  it("step 1 — rejects an absolute input before resolving, because path.resolve would discard the root", async () => {
    const { root, runner } = await freshWorktree();

    // The reason step 1 cannot be folded into steps 5–6.
    expect(join(root, "..", "..")).not.toBe("/etc/passwd");
    const { resolve } = await import("node:path");
    expect(resolve(root, "/etc/passwd")).toBe("/etc/passwd");

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("/etc/passwd"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("step 1 — rejects a win32 drive letter and a UNC prefix that posix isAbsolute misses", async () => {
    const { runner } = await freshWorktree();
    const { isAbsolute: posixIsAbsolute } = await import("node:path");

    for (const value of ["C:foo", "D:..\\x", "\\\\?\\C:\\x", "\\\\server\\share\\y"]) {
      // The whole point: on posix these are ordinary relative-looking strings.
      expect(posixIsAbsolute(value)).toBe(false);
      const result = await resolveRepositoryPath({
        runner,
        claim: asRepositoryClaim(value),
        context,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("PATH_ESCAPE");
    }
  });

  it("step 2 — resolves the candidate against the root, collapsing traversal", async () => {
    const { root, runner } = await freshWorktree();
    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("nested/../a.txt"),
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.absolute).toBe(join(root, "a.txt"));
  });

  it("steps 3 and 4 — realpath is the whole control: a symlink inside the root pointing outside is rejected", async () => {
    const { parent, root, runner } = await freshWorktree();
    const outside = join(parent, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret\n", "utf8");
    symlinkSync(outside, join(root, "escape-link"));

    // A purely lexical check would accept this: `resolve(root, "escape-link/secret.txt")` is inside.
    const { resolve } = await import("node:path");
    expect(resolve(root, "escape-link/secret.txt").startsWith(root)).toBe(true);

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("escape-link/secret.txt"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("step 4 — a not-yet-existing path whose nearest ancestor exists resolves", async () => {
    const { root, runner } = await freshWorktree();
    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("missing-dir/deeper/missing-file.json"),
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.absolute).toBe(join(root, "missing-dir/deeper/missing-file.json"));
  });

  it("step 4 — the existing prefix of a missing path is still resolved through its symlinks", async () => {
    const { parent, root, runner } = await freshWorktree();
    const outside = join(parent, "outside-prefix");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "prefix-link"));

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("prefix-link/not-created-yet.json"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("step 6 — path.relative, not startsWith: the /srv/root-evil/x sibling-prefix case", async () => {
    const { parent, root, runner } = await freshWorktree();
    const evil = join(parent, "root-evil");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "x"), "evil\n", "utf8");
    symlinkSync(evil, join(root, "evil-link"));

    // This is exactly what `startsWith(root)` gets wrong.
    expect(join(evil, "x").startsWith(root)).toBe(true);
    expect(relative(root, join(evil, "x"))).toBe(`..${sep}root-evil${sep}x`);

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("evil-link/x"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("step 6 — path.relative, not startsWith: the /srv/rootx sibling-prefix case", async () => {
    const { parent, root, runner } = await freshWorktree();
    const sibling = join(parent, "rootx");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "y"), "sibling\n", "utf8");
    symlinkSync(sibling, join(root, "sibling-link"));

    expect(join(sibling, "y").startsWith(root)).toBe(true);

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("sibling-link/y"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("step 6 — accepts the root itself, the one recorded divergence from release-support's isInside", async () => {
    const { root, runner } = await freshWorktree();
    symlinkSync(".", join(root, "self-link"));

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("self-link"),
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.absolute).toBe(root);

    // `scripts/release-support.mjs`'s module-private `isInside` is otherwise the same predicate but
    // requires `rel !== ""`, because a release payload path is always a strict sub-path. Chunk 1's
    // parity suite deferred this assertion here, since `isInside` is not exported and can only be
    // compared behaviourally.
    const rel = relative(root, result.value.absolute);
    expect(rel).toBe("");
    const isInside = (r: string, candidate: string): boolean => {
      const value = relative(r, candidate);
      return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolutePath(value);
    };
    expect(isInside(root, result.value.absolute)).toBe(false);

    // `startsWith(root + sep)` — the other naive fix — would also wrongly reject the root itself.
    expect(root.startsWith(`${root}${sep}`)).toBe(false);
  });

  it("step 6 — rejects a relative result of exactly '..', which startsWith('../') alone would miss", async () => {
    const { parent, root, runner } = await freshWorktree();
    symlinkSync(parent, join(root, "parent-link"));

    expect("..".startsWith(`..${sep}`)).toBe(false);

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("parent-link"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("reports IO_ERROR with the operation and attempt from the context when realpath fails for a reason other than ENOENT", async () => {
    const { root, runner } = await freshWorktree();
    // A symlink cycle: `realpath` raises ELOOP, which the ENOENT ancestor walk must not swallow.
    symlinkSync("loop-b", join(root, "loop-a"));
    symlinkSync("loop-a", join(root, "loop-b"));

    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("loop-a"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("IO_ERROR");
    expect(result.error.diagnostic.parameters).toEqual({
      operation: context.operation,
      attempt: context.attempt,
    });
  });
});

function isAbsolutePath(value: string): boolean {
  return value.startsWith(sep);
}

describe.skipIf(!hasGit)("task scope", () => {
  it("reports TASK_SCOPE_VIOLATION for a path inside the worktree but outside the active task", async () => {
    const { root, runner } = await freshWorktree();
    const tasks = join(root, ".archflow", "tasks");
    mkdirSync(join(tasks, TASK_ID), { recursive: true });
    mkdirSync(join(tasks, "other-task"), { recursive: true });
    writeFileSync(join(tasks, "other-task", "state.json"), "{}\n", "utf8");
    symlinkSync(join(tasks, "other-task", "state.json"), join(tasks, TASK_ID, "state.json"));

    const result = await resolveTaskPath({
      runner,
      taskId: TASK_ID,
      claim: parseTaskPathClaim("state.json"),
      context,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_SCOPE_VIOLATION");
    expect(result.error.diagnostic.parameters).toEqual({
      task_id: TASK_ID,
      path_class: "task-state",
    });
  });
});

// ---------------------------------------------------------------------------
// Step 7 and the TOCTOU window
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit)("openResolved — containment step 7", () => {
  it("opens a resolved regular file", async () => {
    const { runner } = await freshWorktree();
    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("a.txt"),
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const handle = await openResolved(result.value.absolute, fsConstants.O_RDONLY);
    try {
      expect((await handle.readFile({ encoding: "utf8" })).trim()).toBe("root");
    } finally {
      await handle.close();
    }
  });

  it("refuses a symlink because O_NOFOLLOW is OR-ed in", async () => {
    const { root, runner } = await freshWorktree();
    symlinkSync(join(root, "a.txt"), join(root, "a-link.txt"));

    // Containment accepts it — the target is inside the root — so O_NOFOLLOW is what stops it.
    const result = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("a-link.txt"),
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The resolved path is the *realpath*, so open the lexical symlink path deliberately.
    const link = join(root, "a-link.txt") as unknown as ResolvedTaskPath;
    await expect(openResolved(link, fsConstants.O_RDONLY)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("still opens with the flag simply absent when fs.constants.O_NOFOLLOW is undefined", async () => {
    const { root } = await freshWorktree();
    symlinkSync(join(root, "a.txt"), join(root, "b-link.txt"));
    const link = join(root, "b-link.txt") as unknown as ResolvedTaskPath;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } };
    });
    try {
      const stubbed = await import("../../src/repository/paths.js");
      // `flags | undefined` is `flags`, not NaN — ToInt32 — so the flag is simply dropped, and on
      // Windows (where O_NOFOLLOW does not exist) this is the permanent state of step 7.
      const handle = await stubbed.openResolved(link, fsConstants.O_RDONLY);
      try {
        expect((await handle.readFile({ encoding: "utf8" })).trim()).toBe("root");
      } finally {
        await handle.close();
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("leaves a TOCTOU window: a symlink target created after validation is never re-checked", async () => {
    const { parent, root, runner } = await freshWorktree();
    const later = join(parent, "created-later");
    symlinkSync(later, join(root, "pending-link"));

    // At validation time the link dangles, so step 4 walks to the nearest existing ancestor and the
    // path is accepted — correctly, because a not-yet-existing path must be resolvable.
    const before = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("pending-link"),
      context,
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const resolved = before.value.absolute;

    // The attacker now materialises the target. Nothing re-validates `resolved`: Node 24 has no
    // openat-style API, so this is a check-then-use control and the window is real.
    mkdirSync(later, { recursive: true });
    writeFileSync(join(later, "payload.txt"), "attacker\n", "utf8");

    const after = await resolveRepositoryPath({
      runner,
      claim: asRepositoryClaim("pending-link"),
      context,
    });
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error.code).toBe("PATH_ESCAPE");

    // The stale brand still typechecks; O_NOFOLLOW is the only defence left, and it holds.
    await expect(openResolved(resolved, fsConstants.O_RDONLY)).rejects.toMatchObject({
      code: "ELOOP",
    });
  });
});

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

describe("path brands", () => {
  it("mints the authentic task root through live containment", async () => {
    const { root, runner } = await freshWorktree();
    const result = await resolveTaskRoot({ runner, taskId: TASK_ID, context });
    expect(result).toEqual({
      schema_version: "1",
      ok: true,
      value: join(root, ".archflow", "tasks", TASK_ID),
    });
  });

  it("keeps the two claim frames and the resolved brand mutually unassignable", () => {
    const taskClaim = parseTaskPathClaim("state.json");
    const repositoryClaim = parseRepositoryPathClaim("state.json");

    // @ts-expect-error a repository claim is not assignable where a task claim is required
    const wrongFrame: TaskPathClaim = repositoryClaim;
    // @ts-expect-error a task claim carries no containment proof
    const unproven: ResolvedTaskPath = taskClaim;
    // @ts-expect-error a plain string cannot mint a containment proof
    const untrusted: ResolvedTaskPath = "/srv/root/state.json";

    expect([wrongFrame, unproven]).toEqual(["state.json", "state.json"]);
    expect(untrusted).toBe("/srv/root/state.json");
  });

  it("keeps the class partition total over PathClass", () => {
    const all: readonly PathClass[] = [...TASK_PATH_CLASSES, ...REPOSITORY_PATH_CLASSES];
    expect(all).toHaveLength(17);
  });
});
