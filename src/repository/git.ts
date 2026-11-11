import { execFile, type ExecFileException } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import { repositoryCandidateDigest } from "../contracts/canonical.js";
import {
  createProjectError,
  type ProjectError
} from "../contracts/errors.js";
import type {
  SafeCode,
  SafeInteger
} from "../contracts/evidence.js";

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

/**
 * Every project error the repository readers promise requires parameters no Git command returns,
 * so the context is an explicit argument rather than something a reader invents.
 */
export interface RepositoryOperationContext {
  readonly operation: SafeCode;
  readonly attempt: SafeInteger;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDIN = 26_214_400;

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
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
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
    const text = decodeFatal(result.stdout, spec.operation);
    if (text.length === 0) return Object.freeze([]);
    const fields: string[] = [];
    let start = 0;
    let index = text.indexOf("\0");
    while (index !== -1) {
      fields.push(text.slice(start, index));
      start = index + 1;
      index = text.indexOf("\0", start);
    }
    if (start < text.length) {
      fields.push(text.slice(start));
    }
    return Object.freeze(fields);
  }

  return Object.freeze({ cwd, run, runText, runNulFields });
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
