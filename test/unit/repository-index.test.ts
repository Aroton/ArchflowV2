import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { gitBlobOid, normalizeGitTreeMode } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  parseRepositoryPathClaim,
  type RepositoryPathClaim,
} from "../../src/contracts/path-claims.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import {
  ARCHFLOW_ATTRIBUTES_REMEDIATION,
  ARCHFLOW_GITATTRIBUTES_RULE,
  checkArchflowAttributes,
} from "../../src/repository/attributes.js";
import {
  createGitRunner,
  GitInvocationError,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import {
  assertArchflowIndexEntry,
  readIndexEntries,
  type IndexEntry,
} from "../../src/repository/index-entries.js";

const context: RepositoryOperationContext = {
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: encodePhaseInstance({
    kind: "phase-design",
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

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trimEnd();
}

/** Writes bytes through git without any filter, returning the blob OID git recorded. */
function hashObject(cwd: string, content: Buffer): string {
  return execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    env: GIT_ENV,
    input: content,
    encoding: "utf8",
  }).trim();
}

const GITATTRIBUTES = `* text=auto\n${ARCHFLOW_GITATTRIBUTES_RULE}\n`;

/** A repository carrying the ArchFlow attribute rule and one committed `.archflow/` file. */
function newRepository(label: string, options: { readonly attributes?: string } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archflow-index-${label}-`)));
  temporaryRoots.push(root);
  const repository = join(root, "repo");
  mkdirSync(join(repository, ".archflow"), { recursive: true });
  mkdirSync(join(repository, "sub"), { recursive: true });
  git(root, "-c", "init.defaultBranch=main", "init", "-q", "repo");
  writeFileSync(join(repository, ".gitattributes"), options.attributes ?? GITATTRIBUTES, "utf8");
  return repository;
}

function commitAll(repository: string, message: string): void {
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", message);
}

async function boundRunnerAt(directory: string): Promise<RootBoundGitRunner> {
  const result = await discoverWorktree(createGitRunner({ cwd: directory }), context);
  if (!result.ok) throw new Error(`discovery failed: ${result.error.code}`);
  return result.value;
}

function claim(value: string): RepositoryPathClaim {
  return parseRepositoryPathClaim(value);
}

function expectTaskInvalid(
  result: { readonly ok: boolean; readonly error?: unknown },
  issueCode: string
): void {
  expect(result.ok).toBe(false);
  const error = (result as { readonly error: { code: string; diagnostic: { parameters: unknown } } })
    .error;
  expect(error.code).toBe("TASK_INVALID");
  expect(error.diagnostic.parameters).toEqual({
    task_id: "mcp-integration",
    issue_code: issueCode,
  });
}

/** A runner satisfying the type without running git, for the output shapes git cannot produce. */
function stubRunner(runNulFields: () => Promise<readonly string[]>): RootBoundGitRunner {
  return {
    cwd: "/nowhere",
    location: {
      worktreeRoot: "/nowhere",
      gitDir: "/nowhere/.git",
      gitCommonDir: "/nowhere/.git",
      linked: false,
    },
    run: () => Promise.reject(new Error("unused")),
    runText: () => Promise.reject(new Error("unused")),
    runNulFields,
  } as unknown as RootBoundGitRunner;
}

describe("archflow attribute rule", () => {
  it("states the remediation verbatim", () => {
    expect(ARCHFLOW_GITATTRIBUTES_RULE).toBe(".archflow/** -text merge=binary");
    expect(ARCHFLOW_ATTRIBUTES_REMEDIATION).toBe(
      "add `.archflow/** -text merge=binary` to the repository root `.gitattributes`, commit it, then run `git add --renormalize .archflow`"
    );
  });
});

describe("assertArchflowIndexEntry", () => {
  const base = {
    path: claim(".archflow/state.json"),
    oid: "0".repeat(40),
    stage: 0,
  } as unknown as IndexEntry;

  it("accepts 100644 and rejects every other legal tree mode", () => {
    expect(() => {
      assertArchflowIndexEntry({ ...base, mode: "100644" });
    }).not.toThrow();
    for (const mode of ["100755", "120000", "160000", "040000"] as const) {
      expect(() => {
        assertArchflowIndexEntry({ ...base, mode });
      }).toThrow(/only 100644 is legal/u);
    }
  });

  it("normalises the raw-tree 40000 form to the displayed 040000 form", () => {
    expect(normalizeGitTreeMode("40000")).toBe("040000");
    expect(normalizeGitTreeMode("100644")).toBe("100644");
  });
});

describe.skipIf(!hasGit)("checkArchflowAttributes", () => {
  it("reports exactly text: unset and merge: binary, identically from a subdirectory", async () => {
    const repository = newRepository("attrs");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");

    const paths = [claim(".archflow/state.json"), claim(".archflow/tasks/t/config.yaml")];
    const fromRoot = await checkArchflowAttributes(await boundRunnerAt(repository), paths, context);
    const fromSub = await checkArchflowAttributes(
      await boundRunnerAt(join(repository, "sub")),
      paths,
      context
    );

    expect(fromRoot.ok).toBe(true);
    if (!fromRoot.ok) throw new Error("unreachable");
    expect(fromRoot.value).toEqual([
      { path: ".archflow/state.json", text: "unset", merge: "binary" },
      { path: ".archflow/tasks/t/config.yaml", text: "unset", merge: "binary" },
    ]);
    expect(fromSub).toEqual(fromRoot);
  });

  it("fails when the .gitattributes line is deleted", async () => {
    const repository = newRepository("attrs-deleted", { attributes: "* text=auto\n" });
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");

    const result = await checkArchflowAttributes(
      await boundRunnerAt(repository),
      [claim(".archflow/state.json")],
      context
    );
    expectTaskInvalid(result, "archflow-attributes-missing");
  });

  it("fails when $GIT_DIR/info/attributes overrides the repository file", async () => {
    const repository = newRepository("attrs-override");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");
    mkdirSync(join(repository, ".git", "info"), { recursive: true });
    writeFileSync(
      join(repository, ".git", "info", "attributes"),
      ".archflow/** text merge=union\n",
      "utf8"
    );

    const result = await checkArchflowAttributes(
      await boundRunnerAt(repository),
      [claim(".archflow/state.json")],
      context
    );
    expectTaskInvalid(result, "archflow-attributes-missing");
  });

  it("round-trips a non-ASCII name with a space, unquoted, through -z", async () => {
    const repository = newRepository("attrs-unicode");
    writeFileSync(join(repository, ".archflow", "ü space.json"), "{}\n", "utf8");
    commitAll(repository, "init");

    const path = claim(".archflow/ü space.json");
    const result = await checkArchflowAttributes(await boundRunnerAt(repository), [path], context);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.path).toBe(".archflow/ü space.json");
  });

  it("emits exactly 6N NUL fields for N paths and two attributes", async () => {
    const repository = newRepository("attrs-cardinality");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");

    const runner = await boundRunnerAt(repository);
    for (const paths of [
      [claim(".archflow/state.json")],
      [claim(".archflow/state.json"), claim(".archflow/ü space.json")],
      [claim(".archflow/a.json"), claim(".archflow/b.json"), claim(".archflow/c.json")],
    ]) {
      const fields = await runner.runNulFields({
        argv: ["check-attr", "-z", "text", "merge", "--", ...paths],
        operation: parseSafeCode("git-check-attr"),
      });
      expect(fields).toHaveLength(paths.length * 6);
    }
  });

  it("rejects any other field count rather than parsing it best-effort", async () => {
    const paths = [claim(".archflow/a.json"), claim(".archflow/b.json")];
    const triplets = paths.flatMap((path) => [path, "text", "unset", path, "merge", "binary"]);

    for (const fields of [triplets.slice(0, 11), [...triplets, "extra"], []]) {
      const result = await checkArchflowAttributes(
        stubRunner(() => Promise.resolve(fields)),
        paths,
        context
      );
      expectTaskInvalid(result, "git-path-mismatch");
    }
  });

  it("rejects a returned path that is not the requested claim", async () => {
    const paths = [claim(".archflow/a.json")];
    const result = await checkArchflowAttributes(
      stubRunner(() =>
        Promise.resolve([
          "../.archflow/a.json",
          "text",
          "unset",
          "../.archflow/a.json",
          "merge",
          "binary",
        ])
      ),
      paths,
      context
    );
    expectTaskInvalid(result, "git-path-mismatch");
  });

  it("translates a runner failure to IO_ERROR", async () => {
    const result = await checkArchflowAttributes(
      stubRunner(() =>
        Promise.reject(
          new GitInvocationError({
            kind: "timeout",
            operation: parseSafeCode("git-check-attr"),
            argv: ["check-attr"],
          })
        )
      ),
      [claim(".archflow/a.json")],
      context
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("IO_ERROR");
    expect(result.error.diagnostic.parameters).toEqual({
      operation: "startup-check",
      attempt: 1,
    });
  });
});

describe.skipIf(!hasGit)("readIndexEntries", () => {
  it("returns index-sourced mode, OID, and stage, identically from a subdirectory", async () => {
    const repository = newRepository("entries");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    writeFileSync(join(repository, ".archflow", "ü space.json"), "{}\n", "utf8");
    commitAll(repository, "init");

    const paths = [claim(".archflow/state.json"), claim(".archflow/ü space.json")];
    const fromRoot = await readIndexEntries(await boundRunnerAt(repository), paths, context);
    const fromSub = await readIndexEntries(
      await boundRunnerAt(join(repository, "sub")),
      paths,
      context
    );

    expect(fromRoot.ok).toBe(true);
    if (!fromRoot.ok) throw new Error("unreachable");
    expect(fromRoot.value.map((entry) => entry.path).sort()).toEqual([
      ".archflow/state.json",
      ".archflow/ü space.json",
    ]);
    for (const entry of fromRoot.value) {
      expect(entry.mode).toBe("100644");
      expect(entry.stage).toBe(0);
      expect(entry.oid).toBe(gitBlobOid(new TextEncoder().encode("{}\n")));
    }
    expect(fromSub).toEqual(fromRoot);
  });

  it("omits an untracked claim rather than failing", async () => {
    const repository = newRepository("entries-untracked");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");

    const result = await readIndexEntries(
      await boundRunnerAt(repository),
      [claim(".archflow/state.json"), claim(".archflow/absent.json")],
      context
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toHaveLength(1);
  });

  it("rejects a gitlink anywhere in the repository", async () => {
    const repository = newRepository("entries-gitlink");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");
    const head = git(repository, "rev-parse", "HEAD");
    git(repository, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`);

    const result = await readIndexEntries(
      await boundRunnerAt(repository),
      [claim("vendor/sub")],
      context
    );
    expectTaskInvalid(result, "archflow-tree-mode-illegal");
  });

  it("rejects an executable file below .archflow/", async () => {
    const repository = newRepository("entries-exec");
    const file = join(repository, ".archflow", "hook.json");
    writeFileSync(file, "{}\n", "utf8");
    chmodSync(file, 0o755);
    git(repository, "config", "core.fileMode", "true");
    commitAll(repository, "init");

    const result = await readIndexEntries(
      await boundRunnerAt(repository),
      [claim(".archflow/hook.json")],
      context
    );
    expectTaskInvalid(result, "archflow-tree-mode-illegal");
  });

  it("rejects a symlink below .archflow/", async () => {
    const repository = newRepository("entries-symlink");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");
    const target = hashObject(repository, Buffer.from("state.json", "utf8"));
    git(repository, "update-index", "--add", "--cacheinfo", `120000,${target},.archflow/link.json`);

    const result = await readIndexEntries(
      await boundRunnerAt(repository),
      [claim(".archflow/link.json")],
      context
    );
    expectTaskInvalid(result, "archflow-tree-mode-illegal");
  });

  it("rejects a returned path that is not the requested claim", async () => {
    const result = await readIndexEntries(
      stubRunner(() =>
        Promise.resolve([`100644 ${"a".repeat(40)} 0\t../.archflow/state.json`])
      ),
      [claim(".archflow/state.json")],
      context
    );
    expectTaskInvalid(result, "git-path-mismatch");
  });

  it("rejects a malformed entry rather than splitting the path on whitespace", async () => {
    for (const field of [
      `100644 ${"a".repeat(40)} 0 .archflow/ü space.json`,
      `100644 ${"a".repeat(40)}\t.archflow/state.json`,
      `100644 nothex 0\t.archflow/state.json`,
      `100644 ${"a".repeat(40)} 9\t.archflow/state.json`,
    ]) {
      const result = await readIndexEntries(
        stubRunner(() => Promise.resolve([field])),
        [claim(".archflow/state.json")],
        context
      );
      expectTaskInvalid(result, "git-path-mismatch");
    }
  });

  it("translates a runner failure to IO_ERROR", async () => {
    const result = await readIndexEntries(
      stubRunner(() =>
        Promise.reject(
          new GitInvocationError({
            kind: "output-overflow",
            operation: parseSafeCode("git-ls-files"),
            argv: ["ls-files"],
          })
        )
      ),
      [claim(".archflow/a.json")],
      context
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("IO_ERROR");
  });
});

/**
 * Verification step 3: five repositories, each testing a distinct claim — not a 24-cell
 * cross-product, because `-text` collapsing the EOL configurations to one answer is the design's own
 * central claim, so most cells are provably identical by that argument and buy no confidence.
 */
describe.skipIf(!hasGit)("index OID and mode across checkout configurations", () => {
  const crlf = Buffer.from('{\r\n  "a": 1\r\n}\r\n', "utf8");

  for (const autocrlf of ["false", "true", "input"] as const) {
    it(`matches the in-process OID at core.autocrlf=${autocrlf}`, async () => {
      const repository = newRepository(`autocrlf-${autocrlf}`);
      git(repository, "config", "core.autocrlf", autocrlf);
      writeFileSync(join(repository, ".archflow", "crlf.json"), crlf);
      writeFileSync(join(repository, "control.txt"), crlf);
      commitAll(repository, "init");

      const result = await readIndexEntries(
        await boundRunnerAt(repository),
        [claim(".archflow/crlf.json"), claim("control.txt")],
        context
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const entries = new Map(result.value.map((entry) => [entry.path as string, entry]));
      const archflow = entries.get(".archflow/crlf.json");
      expect(archflow?.mode).toBe("100644");
      expect(archflow?.oid).toBe(gitBlobOid(crlf));
      expect(archflow?.oid).toBe(hashObject(repository, crlf));

      // The control file has no `-text`, so `text=auto` normalises CRLF to LF in the index at every
      // autocrlf setting and its OID is never the OID of the bytes on disk. That contrast is what
      // makes the collapse above meaningful rather than incidental.
      const control = entries.get("control.txt");
      expect(control?.oid).not.toBe(gitBlobOid(crlf));
    });
  }

  it("keeps the index mode at core.fileMode=false with the executable bit set on disk", async () => {
    const repository = newRepository("filemode");
    git(repository, "config", "core.fileMode", "false");
    const file = join(repository, ".archflow", "state.json");
    writeFileSync(file, crlf);
    commitAll(repository, "init");
    chmodSync(file, 0o755);

    const result = await readIndexEntries(
      await boundRunnerAt(repository),
      [claim(".archflow/state.json")],
      context
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.mode).toBe("100644");
    expect(result.value[0]?.oid).toBe(gitBlobOid(crlf));
  });

  it("keeps mode 120000 and a content-derived OID at core.symlinks=false", async () => {
    const repository = newRepository("symlinks");
    git(repository, "config", "core.symlinks", "false");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");

    // A symlink-incapable checkout stores the target path as a blob with no trailing newline while
    // the index still records 120000 — index-sourced mode plus content-derived OID needs no case.
    const target = Buffer.from(".archflow/state.json", "utf8");
    const blob = hashObject(repository, target);
    git(repository, "update-index", "--add", "--cacheinfo", `120000,${blob},link.json`);

    const result = await readIndexEntries(
      await boundRunnerAt(repository),
      [claim("link.json")],
      context
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.mode).toBe("120000");
    expect(result.value[0]?.oid).toBe(gitBlobOid(target));
    expect(result.value[0]?.oid).toBe(blob);
  });
});

/**
 * Verification step 4's reader half: the reproduced silent wrong answer, and the type that makes it
 * unwritable.
 */
describe.skipIf(!hasGit)("the unbound-runner hole", () => {
  it("reproduces the wrong answer an unbound runner gives from a subdirectory", async () => {
    const repository = newRepository("unbound");
    writeFileSync(join(repository, ".archflow", "state.json"), "{}\n", "utf8");
    commitAll(repository, "init");
    const sub = join(repository, "sub");

    expect(git(sub, "ls-files", "-s", "--", ".archflow/state.json")).toBe("");
    expect(git(sub, "check-attr", "text", "merge", "--", ".archflow/state.json")).toContain(
      "text: auto"
    );

    // The bound runner gets the right answer from the same directory.
    const bound = await readIndexEntries(
      await boundRunnerAt(sub),
      [claim(".archflow/state.json")],
      context
    );
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("unreachable");
    expect(bound.value).toHaveLength(1);
  });

  it("makes an unbound runner a compile error at both readers", () => {
    const unbound = createGitRunner({ cwd: "/nowhere" });
    const readEntries = (): unknown =>
      // @ts-expect-error - only a RootBoundGitRunner may reach a reader below discovery
      readIndexEntries(unbound, [], context);
    const readAttributes = (): unknown =>
      // @ts-expect-error - only a RootBoundGitRunner may reach a reader below discovery
      checkArchflowAttributes(unbound, [], context);
    expect(typeof readEntries).toBe("function");
    expect(typeof readAttributes).toBe("function");
  });
});

/** Verification step 5's second half: pathspec metacharacters never reach a Git call. */
describe("pathspec metacharacters", () => {
  it("are rejected by the claim schema before any git call", () => {
    for (const name of ["star*name.txt", "q?name.txt", "br[ack]et.txt"]) {
      expect(() => claim(name)).toThrow();
    }
    expect(() => claim(".archflow/ü space.json")).not.toThrow();
  });
});
