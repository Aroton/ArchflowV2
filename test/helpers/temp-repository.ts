/**
 * The reusable temporary-repository harness for the repository layer's tests.
 *
 * Chunks 4–8 each grew their own ad-hoc scaffolding inside a unit suite; this module is the shared
 * version the integration suite drives. It deliberately owns only the *fixture* concerns — creating
 * a repository with a chosen `core.*` configuration, seeding the ArchFlow `.gitattributes` rule,
 * committing, linking a worktree, relocating a directory, and forcing a merge conflict — and knows
 * nothing about `src/repository/**`, so a fixture bug can never be mistaken for a source bug.
 *
 * Every command runs with the ambient global and system Git configuration neutralised, so a
 * developer's `core.autocrlf`, `core.symlinks`, or `init.defaultBranch` cannot change a result.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The line the repository root `.gitattributes` must carry, after the existing `* text=auto`. */
export const ARCHFLOW_GITATTRIBUTES_LINE = ".archflow/** -text merge=binary";

/** The default `.gitattributes` contents: the rule appended *after* `* text=auto`, never before. */
export const ARCHFLOW_GITATTRIBUTES = `* text=auto\n${ARCHFLOW_GITATTRIBUTES_LINE}\n`;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Runs `git` in `cwd` and returns trimmed stdout; a nonzero exit throws. */
export function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trimEnd();
}

/** For the commands whose whole purpose is to stop on a conflict: the nonzero exit *is* the fixture. */
export function gitAllowFail(cwd: string, ...args: readonly string[]): void {
  try {
    execFileSync("git", [...args], { cwd, env: GIT_ENV, stdio: "ignore" });
  } catch {
    /* expected */
  }
}

const temporaryRoots: string[] = [];

/** Registers a fresh temporary directory for removal by {@link cleanupTemporaryRepositories}. */
export function temporaryRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archflow-${label}-`)));
  temporaryRoots.push(root);
  return root;
}

/** Call from `afterAll`. Safe to call when nothing was created. */
export function cleanupTemporaryRepositories(): void {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** The three commits a forced modify/modify conflict needs. */
export type ConflictVariant = "base" | "feature" | "main";

export interface TempRepositoryOptions {
  /** Distinguishes this fixture's temporary directory; also its default directory name. */
  readonly label: string;
  /** Directory name under the temporary root — spaces and non-ASCII text are the point. */
  readonly directoryName?: string;
  /** `.gitattributes` contents. Defaults to {@link ARCHFLOW_GITATTRIBUTES}; `undefined` writes none. */
  readonly attributes?: string | undefined;
  /** `core.autocrlf`, `core.fileMode`, `core.symlinks`, … applied immediately after `init`. */
  readonly config?: Readonly<Record<string, string>>;
}

export interface TempRepository {
  /** The temporary parent directory; the repository lives inside it. */
  readonly root: string;
  /** The worktree root — realpath'd, so it compares equal to what discovery returns. */
  readonly path: string;
  readonly git: (...args: readonly string[]) => string;
  readonly gitAllowFail: (...args: readonly string[]) => void;
  /** Writes a file, creating parent directories. Strings are written verbatim as UTF-8. */
  readonly write: (relativePath: string, content: string | Buffer) => void;
  readonly chmod: (relativePath: string, mode: number) => void;
  readonly commitAll: (message: string) => void;
  /** Writes bytes straight into the object database with no filter, returning the blob OID. */
  readonly hashObject: (content: Buffer) => string;
  /** `git worktree add` at a sibling path, returning the linked worktree's realpath. */
  readonly addWorktree: (directoryName: string, branch: string) => string;
  /** Renames the repository directory and returns its new realpath. Identity must survive this. */
  readonly relocate: (directoryName: string) => string;
  /**
   * Forces a modify/modify conflict on every named path: one base commit, a `feature` branch and a
   * `main` branch each changing the same files, then a merge that stops unmerged. `contentFor`
   * supplies each variant's bytes — the default is the variant name, and a caller asserting that a
   * conflicted file still *parses* supplies its own well-formed content instead.
   */
  readonly forceConflict: (
    names: readonly string[],
    contentFor?: (name: string, variant: ConflictVariant) => string
  ) => void;
}

/**
 * Creates a repository with an initial `.gitattributes` (uncommitted — the caller decides when to
 * commit, because several fixtures need files staged in the same commit).
 */
export function createTempRepository(options: TempRepositoryOptions): TempRepository {
  const root = temporaryRoot(options.label);
  const name = options.directoryName ?? "repo";
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(root, "-c", "init.defaultBranch=main", "init", "-q", name);
  for (const [key, value] of Object.entries(options.config ?? {})) {
    git(path, "config", key, value);
  }

  let current = path;
  const attributes = "attributes" in options ? options.attributes : ARCHFLOW_GITATTRIBUTES;

  const write = (relativePath: string, content: string | Buffer): void => {
    const target = join(current, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    if (typeof content === "string") writeFileSync(target, content, "utf8");
    else writeFileSync(target, content);
  };

  if (attributes !== undefined) write(".gitattributes", attributes);

  const repository: TempRepository = {
    root,
    get path() {
      return current;
    },
    git: (...args) => git(current, ...args),
    gitAllowFail: (...args) => {
      gitAllowFail(current, ...args);
    },
    write,
    chmod: (relativePath, mode) => {
      chmodSync(join(current, relativePath), mode);
    },
    commitAll: (message) => {
      git(current, "add", "-A");
      git(current, "commit", "-q", "-m", message);
    },
    hashObject: (content) =>
      execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: current,
        env: GIT_ENV,
        input: content,
        encoding: "utf8",
      }).trim(),
    addWorktree: (directoryName, branch) => {
      const target = join(root, directoryName);
      git(current, "worktree", "add", "-q", target, "-b", branch);
      return realpathSync(target);
    },
    relocate: (directoryName) => {
      const target = join(root, directoryName);
      renameSync(current, target);
      current = realpathSync(target);
      return current;
    },
    forceConflict: (names, contentFor = (_name, variant) => `${variant}\n`) => {
      const writeAll = (variant: ConflictVariant): void => {
        for (const entry of names) write(entry, contentFor(entry, variant));
      };
      writeAll("base");
      repository.commitAll("base");
      git(current, "checkout", "-q", "-b", "feature");
      writeAll("feature");
      repository.commitAll("feature");
      git(current, "checkout", "-q", "main");
      writeAll("main");
      repository.commitAll("main");
      gitAllowFail(current, "merge", "feature");
    },
  };

  return repository;
}
