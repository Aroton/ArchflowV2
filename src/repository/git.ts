import { execFile, type ExecFileException } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import { repositoryCandidateDigest } from "../contracts/canonical.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import type {
  SafeCode,
  SafeInteger,
  SafeVersion,
  TaskSlug,
} from "../contracts/evidence.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";

export type GitFailureKind =
  | "not-installed"
  | "not-executable"
  | "timeout"
  | "output-overflow"
  | "spawn-failed"
  | "command-failed";

export class GitInvocationError extends Error {
  readonly kind: GitFailureKind;
  readonly operation: SafeCode;
  readonly argv: readonly string[];
  /** Present only for `command-failed`: the process exit status. */
  readonly code?: number | undefined;
  readonly stderr?: string | undefined;

  constructor(options: {
    readonly kind: GitFailureKind;
    readonly operation: SafeCode;
    readonly argv: readonly string[];
    readonly code?: number | undefined;
    readonly stderr?: string | undefined;
    readonly message?: string;
  }) {
    super(
      options.message ??
        `git ${options.operation} failed (${options.kind})${
          options.code === undefined ? "" : ` with exit ${String(options.code)}`
        }`
    );
    this.name = "GitInvocationError";
    this.kind = options.kind;
    this.operation = options.operation;
    this.argv = Object.freeze([...options.argv]);
    this.code = options.code;
    this.stderr = options.stderr;
  }
}

/**
 * Absence is command-specific and caller-declared; it is never inferred from exit 128 alone.
 * `git` exits 128 for dubious ownership, corrupt objects, a corrupt repository, invalid revision
 * syntax and much else — treating those as "not there" turns a broken repository into a silent
 * empty answer. A nonzero exit is absence only when both the exact code and the diagnostic
 * substring match a declared entry.
 */
export interface ExpectedAbsence {
  readonly code: number;
  readonly stderrIncludes: string;
}

export interface GitCommandSpec {
  readonly argv: readonly string[];
  readonly operation: SafeCode;
  /** Optional binary stdin, copied once before the child is spawned. */
  readonly stdin?: Uint8Array;
  readonly expectedAbsence?: readonly ExpectedAbsence[];
  readonly maxBuffer?: number;
  readonly timeoutMs?: number;
}

export interface GitInvocationResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  /** True only via a matched `ExpectedAbsence`. */
  readonly absent: boolean;
}

export interface GitRunner {
  readonly cwd: string;
  readonly run: (spec: GitCommandSpec) => Promise<GitInvocationResult>;
  readonly runText: (spec: GitCommandSpec) => Promise<string>;
  readonly runNulFields: (spec: GitCommandSpec) => Promise<readonly string[]>;
}

export interface GitEnvironment {
  readonly version: SafeVersion;
  readonly object_format: "sha1";
}

/**
 * Every project error the repository readers promise requires parameters no Git command returns,
 * so the context is an explicit argument rather than something a reader invents.
 */
export interface RepositoryOperationContext {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly operation: SafeCode;
  readonly attempt: SafeInteger;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDIN = 26_214_400;
const GIT_MAJOR_FLOOR = 2;
const GIT_MINOR_FLOOR = 25;

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const lossyDecoder = new TextDecoder("utf-8");

interface ExecOutcome {
  readonly failure: ExecFileException | undefined;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function execGit(
  gitPath: string,
  spec: GitCommandSpec,
  options: { readonly cwd: string; readonly maxBuffer: number; readonly timeoutMs: number }
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    const child = execFile(
      gitPath,
      [...spec.argv],
      {
        cwd: options.cwd,
        encoding: "buffer",
        maxBuffer: options.maxBuffer,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (failure, stdout, stderr) => {
        resolve({
          failure: failure ?? undefined,
          stdout: Buffer.from(stdout),
          stderr: Buffer.from(stderr),
        });
      }
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(spec.stdin);
  });
}

function classifySpawnFailure(failure: ExecFileException): GitFailureKind | undefined {
  const code = failure.code;
  if (code === "ENOENT") return "not-installed";
  if (code === "EACCES" || code === "EPERM") return "not-executable";
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || failure.message.includes("maxBuffer")) {
    return "output-overflow";
  }
  if ((failure as { killed?: boolean }).killed === true) return "timeout";
  return undefined;
}

function decodeFatal(bytes: Uint8Array, operation: SafeCode): string {
  try {
    return fatalDecoder.decode(bytes);
  } catch (error) {
    throw new TypeError(`git ${operation} output is not valid UTF-8: ${(error as Error).message}`);
  }
}

export function createGitRunner(options: {
  readonly cwd: string;
  readonly gitPath?: string;
  readonly maxBuffer?: number;
  readonly timeoutMs?: number;
}): GitRunner {
  const cwd = resolvePath(options.cwd);
  const gitPath = options.gitPath ?? "git";
  const runnerMaxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const runnerTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function run(spec: GitCommandSpec): Promise<GitInvocationResult> {
    const stdin = spec.stdin === undefined ? undefined : new Uint8Array(spec.stdin);
    if (stdin !== undefined && stdin.byteLength > DEFAULT_MAX_STDIN) {
      throw new GitInvocationError({
        kind: "output-overflow",
        operation: spec.operation,
        argv: spec.argv,
        message: `git ${spec.operation} stdin exceeds the bounded result-byte limit`,
      });
    }
    const materializedSpec = stdin === undefined ? spec : { ...spec, stdin };
    const outcome = await execGit(gitPath, materializedSpec, {
      cwd,
      maxBuffer: spec.maxBuffer ?? runnerMaxBuffer,
      timeoutMs: spec.timeoutMs ?? runnerTimeoutMs,
    });
    const stderr = lossyDecoder.decode(outcome.stderr);

    if (outcome.failure !== undefined) {
      const kind = classifySpawnFailure(outcome.failure);
      if (kind !== undefined) {
        throw new GitInvocationError({ kind, operation: spec.operation, argv: spec.argv, stderr });
      }
      const status = outcome.failure.code;
      if (typeof status !== "number") {
        throw new GitInvocationError({
          kind: "spawn-failed",
          operation: spec.operation,
          argv: spec.argv,
          stderr,
        });
      }
      const absent = (spec.expectedAbsence ?? []).some(
        (entry) => entry.code === status && stderr.includes(entry.stderrIncludes)
      );
      if (!absent) {
        throw new GitInvocationError({
          kind: "command-failed",
          operation: spec.operation,
          argv: spec.argv,
          code: status,
          stderr,
        });
      }
      return Object.freeze({ code: status, stdout: outcome.stdout, stderr, absent: true });
    }

    return Object.freeze({ code: 0, stdout: outcome.stdout, stderr, absent: false });
  }

  async function runText(spec: GitCommandSpec): Promise<string> {
    const result = await run(spec);
    if (result.absent) return "";
    const text = decodeFatal(result.stdout, spec.operation);
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  }

  async function runNulFields(spec: GitCommandSpec): Promise<readonly string[]> {
    const result = await run(spec);
    if (result.absent) return Object.freeze([]);
    const fields = decodeFatal(result.stdout, spec.operation).split("\0");
    if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
    return Object.freeze(fields);
  }

  return Object.freeze({ cwd, run, runText, runNulFields });
}

export type GitTreeBlobEntry = Readonly<{
  mode: "100644" | "100755" | "120000";
  oid: string;
}>;

const HASH_OBJECT_OPERATION = "git-hash-object" as SafeCode;
const ANCESTOR_OPERATION = "git-ancestor" as SafeCode;
const TREE_ENTRY_OPERATION = "git-tree-entry" as SafeCode;
const OBJECT_SIZE_OPERATION = "git-object-size" as SafeCode;
const OBJECT_READ_OPERATION = "git-object-read" as SafeCode;
const GIT_OID = /^[0-9a-f]{40}$/u;
const BLOB_MODE = /^(?:100644|100755|120000)$/u;
const MAX_RESULT_BLOB_BYTES = 25 * 1024 * 1024;

/** Hashes bytes as Git would for a declared path. Omit `path` for unconverted symlink targets. */
export async function hashGitBlob(
  runner: GitRunner,
  bytes: Uint8Array,
  path?: string
): Promise<string> {
  const argv = ["hash-object"];
  if (path !== undefined) argv.push(`--path=${path}`);
  argv.push("--stdin");
  const oid = await runner.runText({ argv, operation: HASH_OBJECT_OPERATION, stdin: bytes });
  if (!GIT_OID.test(oid)) throw new TypeError("git hash-object returned an invalid SHA-1 object id");
  return oid;
}

/**
 * Hashes path-converted bytes and materializes the resulting loose object only long enough to
 * measure Git's canonical blob byte length. Object existence is never a retention proof: callers
 * must still select `git-object` storage exclusively through a retained commit/tree proof.
 */
export async function hashGitBlobIdentity(
  runner: GitRunner,
  bytes: Uint8Array,
  path?: string
): Promise<Readonly<{ oid: string; size_bytes: number }>> {
  const argv = ["hash-object", "-w"];
  if (path !== undefined) argv.push(`--path=${path}`);
  argv.push("--stdin");
  const oid = await runner.runText({ argv, operation: HASH_OBJECT_OPERATION, stdin: bytes });
  if (!GIT_OID.test(oid)) throw new TypeError("git hash-object returned an invalid SHA-1 object id");
  return Object.freeze({ oid, size_bytes: await readGitBlobSize(runner, oid) });
}

export type GitChangedPathReport = Readonly<{
  paths: readonly string[];
  unrepresentable_count: number;
}>;

/** Reads porcelain-v1 `-z` without losing invalid UTF-8 names; those are counted, never omitted silently. */
export async function readChangedGitPaths(runner: GitRunner): Promise<GitChangedPathReport> {
  const result = await runner.run({
    argv: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    operation: "git-status-declared-scope" as SafeCode,
  });
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < result.stdout.byteLength; index += 1) {
    if (result.stdout[index] === 0) {
      fields.push(result.stdout.slice(start, index));
      start = index + 1;
    }
  }
  if (start !== result.stdout.byteLength) throw new TypeError("git status porcelain output is not NUL-terminated");
  const paths: string[] = [];
  let unrepresentable = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.byteLength < 4 || field[2] !== 0x20) throw new TypeError("git status porcelain record is malformed");
    const status = String.fromCharCode(field[0]!, field[1]!);
    const pathFields: Uint8Array[] = [field.slice(3)];
    if (status.includes("R") || status.includes("C")) {
      const source = fields[index + 1];
      if (source === undefined) throw new TypeError("git status rename record lacks its source");
      pathFields.push(source);
      index += 1;
    }
    for (const pathBytes of pathFields) {
      try { paths.push(fatalDecoder.decode(pathBytes)); }
      catch { unrepresentable += 1; }
    }
  }
  paths.sort();
  return Object.freeze({ paths: Object.freeze([...new Set(paths)]), unrepresentable_count: unrepresentable });
}

/** True only when `ancestor` is retained by the current HEAD ancestry. */
export async function isCommitAncestorOfHead(
  runner: GitRunner,
  ancestor: string
): Promise<boolean> {
  const result = await runner.run({
    argv: ["merge-base", "--is-ancestor", ancestor, "HEAD"],
    operation: ANCESTOR_OPERATION,
    expectedAbsence: [{ code: 1, stderrIncludes: "" }],
  });
  return !result.absent;
}

/** Resolves one exact blob entry from a commit tree; empty output is ordinary absence. */
export async function readCommitTreeBlob(
  runner: GitRunner,
  commit: string,
  path: string
): Promise<GitTreeBlobEntry | undefined> {
  const fields = await runner.runNulFields({
    argv: ["ls-tree", "-z", commit, "--", path],
    operation: TREE_ENTRY_OPERATION,
  });
  if (fields.length === 0) return undefined;
  if (fields.length !== 1) throw new TypeError("git ls-tree returned conflicting path entries");
  const match = /^(?<mode>\d{6}) blob (?<oid>[0-9a-f]+)\t(?<path>[\s\S]+)$/u.exec(fields[0] ?? "");
  if (
    match?.groups === undefined ||
    match.groups["path"] !== path ||
    !BLOB_MODE.test(match.groups["mode"] ?? "") ||
    !GIT_OID.test(match.groups["oid"] ?? "")
  ) {
    throw new TypeError("git ls-tree returned an invalid or mismatched blob entry");
  }
  return Object.freeze({
    mode: match.groups["mode"] as GitTreeBlobEntry["mode"],
    oid: match.groups["oid"] as string,
  });
}

/** Reads the byte size of a blob already named by an authenticated tree entry. */
export async function readGitBlobSize(runner: GitRunner, oid: string): Promise<number> {
  if (!GIT_OID.test(oid)) throw new TypeError("Git blob object id is invalid");
  const output = await runner.runText({
    argv: ["cat-file", "-s", oid],
    operation: OBJECT_SIZE_OPERATION,
  });
  if (!/^(?:0|[1-9][0-9]*)$/u.test(output)) throw new TypeError("git cat-file returned an invalid size");
  const size = Number(output);
  if (!Number.isSafeInteger(size)) throw new TypeError("git blob size exceeds the safe integer range");
  return size;
}

/** Reads one authenticated Git blob without permitting a result-sized object to exceed storage bounds. */
export async function readGitBlobBytes(runner: GitRunner, oid: string): Promise<Uint8Array> {
  const size = await readGitBlobSize(runner, oid);
  if (size > MAX_RESULT_BLOB_BYTES) throw new TypeError("Git blob exceeds the bounded result-byte limit");
  const result = await runner.run({
    argv: ["cat-file", "blob", oid],
    operation: OBJECT_READ_OPERATION,
    maxBuffer: MAX_RESULT_BLOB_BYTES,
  });
  if (result.stdout.byteLength !== size) throw new TypeError("git cat-file blob size changed during read");
  return new Uint8Array(result.stdout);
}

/** Materializes a regular blob through the declared destination path's checkout filters. */
export async function readGitBlobProjectedBytes(
  runner: GitRunner,
  oid: string,
  path: string,
): Promise<Uint8Array> {
  if (!GIT_OID.test(oid)) throw new TypeError("cannot read an invalid Git object id");
  const result = await runner.run({
    argv: ["cat-file", "--filters", `--path=${path}`, oid],
    operation: "git-object-projected-bytes" as SafeCode,
    maxBuffer: MAX_RESULT_BLOB_BYTES,
  });
  if (result.stdout.byteLength > MAX_RESULT_BLOB_BYTES) {
    throw new GitInvocationError({
      kind: "output-overflow",
      operation: "git-object-projected-bytes" as SafeCode,
      argv: ["cat-file", "--filters", `--path=${path}`, oid],
      message: "projected Git blob exceeds the bounded result-byte limit",
    });
  }
  return new Uint8Array(result.stdout);
}

/**
 * The failure map for every `GitInvocationError` kind, published here so chunks below cannot each
 * invent their own translation. `git` missing or not executable is a repository-candidate failure;
 * every other runner failure is an I/O failure carrying the caller-supplied operation and attempt.
 */
export function projectErrorForGitFailure(
  error: GitInvocationError,
  runner: GitRunner,
  context: RepositoryOperationContext
): ProjectError {
  if (error.kind === "not-installed" || error.kind === "not-executable") {
    return createProjectError("REPOSITORY_NOT_FOUND", {
      repository_candidate_digest: repositoryCandidateDigest(runner.cwd),
    });
  }
  return createProjectError("IO_ERROR", {
    operation: context.operation,
    attempt: context.attempt,
  });
}

function ok<T>(value: T): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: true, value });
}

function fail<T>(error: ProjectError): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: false, error });
}

const SAFE_VERSION = /^[A-Za-z0-9.-]{1,64}$/u;

function safeVersionOf(value: string): SafeVersion {
  return (SAFE_VERSION.test(value) ? value : "unknown") as SafeVersion;
}

function unsupportedRuntime(component: string, version: SafeVersion): ProjectError {
  return createProjectError("RUNTIME_VERSION_UNSUPPORTED", { component, version });
}

const VERSION_OPERATION = "git-version" as SafeCode;
const OBJECT_FORMAT_OPERATION = "git-object-format" as SafeCode;

/**
 * Preflights the single Git version floor (~2.25, where `rev-parse --show-object-format` first
 * exists) and the repository object format, failing closed on `sha256`. `extensions.objectFormat`
 * is deliberately not consulted: that key is absent in a SHA-1 repository.
 *
 * The runner throws; this reader translates — the failure convention in one function. It assumes
 * `runner.cwd` is inside a work tree; establishing that is discovery's job.
 */
export async function preflightGit(
  runner: GitRunner,
  context: RepositoryOperationContext
): Promise<ProjectResult<GitEnvironment>> {
  let versionOutput: string;
  try {
    versionOutput = await runner.runText({ argv: ["--version"], operation: VERSION_OPERATION });
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    throw error;
  }

  const reported = /(?<major>\d+)\.(?<minor>\d+)(?:\.[^\s]*)?/u.exec(versionOutput);
  const token = /^git version (?<token>\S+)/u.exec(versionOutput)?.groups?.["token"] ?? versionOutput.trim();
  const version = safeVersionOf(token);
  const major = Number(reported?.groups?.["major"] ?? Number.NaN);
  const minor = Number(reported?.groups?.["minor"] ?? Number.NaN);
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < GIT_MAJOR_FLOOR ||
    (major === GIT_MAJOR_FLOOR && minor < GIT_MINOR_FLOOR)
  ) {
    return fail(unsupportedRuntime("git", version));
  }

  let objectFormat: string;
  try {
    objectFormat = await runner.runText({
      argv: ["rev-parse", "--show-object-format"],
      operation: OBJECT_FORMAT_OPERATION,
    });
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    throw error;
  }

  if (objectFormat !== "sha1") {
    return fail(unsupportedRuntime("git-object-format", safeVersionOf(objectFormat.trim())));
  }

  return ok<GitEnvironment>(Object.freeze({ version, object_format: "sha1" }));
}
