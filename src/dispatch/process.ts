import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { open, stat } from "node:fs/promises";

import { createProjectError, type ProjectError } from "../contracts/errors.js";
import type { AdapterId } from "../contracts/review.js";

export const DISPATCH_TIMEOUT_MS = 300_000;
export const DISPATCH_OUTPUT_BYTE_CAP = 8 * 1024 * 1024;

const TERMINATION_GRACE_MS = 250;

export type DispatchChildSpec = Readonly<{
  adapter: AdapterId;
  command: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  stdin?: Uint8Array;
  signal: AbortSignal;
  cancellation_source?: "client" | "transport";
  final_output_path?: string;
  timeout_ms?: number;
  byte_cap?: number;
}>;

export type DispatchChildResult = Readonly<{
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  final_output?: Buffer;
}>;

export type DispatchOutputChannels = Readonly<{
  stdout: Uint8Array;
  stderr: Uint8Array;
  final_output?: Uint8Array;
}>;

export class DispatchProcessError extends Error {
  public constructor(public readonly project_error: ProjectError) {
    super(project_error.code);
    this.name = "DispatchProcessError";
  }
}

const fail = (error: ProjectError): never => {
  throw new DispatchProcessError(error);
};

function checkedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function terminateChild(child: ChildProcess): NodeJS.Timeout {
  const send = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child if it exited between the check and group signal.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // A concurrent exit is equivalent to successful termination.
    }
  };
  send("SIGTERM");
  const escalation = setTimeout(() => send("SIGKILL"), TERMINATION_GRACE_MS);
  escalation.unref();
  return escalation;
}

function classifySpawnError(adapter: AdapterId, error: NodeJS.ErrnoException): never {
  if (error.code === "ENOENT") return fail(createProjectError("CLI_MISSING", { adapter }));
  if (error.code === "EACCES" || error.code === "EPERM") {
    return fail(createProjectError("PROCESS_FAILED", { adapter, exit_class: "not-executable" }));
  }
  return fail(createProjectError("IO_ERROR", { operation: "dispatch-spawn", attempt: 1 }));
}

async function readBoundedFinalOutput(
  adapter: AdapterId,
  path: string,
  byteCap: number,
): Promise<Buffer | undefined> {
  let metadata;
  try {
    metadata = await stat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail(createProjectError("IO_ERROR", { operation: "dispatch-output-stat", attempt: 1 }));
  }
  if (!metadata.isFile()) {
    return fail(createProjectError("IO_ERROR", { operation: "dispatch-output-read", attempt: 1 }));
  }
  if (metadata.size > BigInt(byteCap)) {
    const byteCount = Number(metadata.size);
    if (!Number.isSafeInteger(byteCount)) {
      return fail(createProjectError("IO_ERROR", { operation: "dispatch-output-stat", attempt: 1 }));
    }
    return fail(createProjectError("OUTPUT_OVERFLOW", { adapter, byte_count: byteCount, byte_cap: byteCap }));
  }

  let handle;
  try {
    handle = await open(path, "r");
    const chunks: Buffer[] = [];
    let byteCount = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, byteCap + 1 - byteCount));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      byteCount += bytesRead;
      if (byteCount > byteCap) {
        return fail(createProjectError("OUTPUT_OVERFLOW", { adapter, byte_count: byteCount, byte_cap: byteCap }));
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, byteCount);
  } catch (error) {
    if (error instanceof DispatchProcessError) throw error;
    return fail(createProjectError("IO_ERROR", { operation: "dispatch-output-read", attempt: 1 }));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Runs one CLI process. Adapter-specific interpretation of nonzero exits stays with the adapter. */
export async function runDispatchChild(spec: DispatchChildSpec): Promise<DispatchChildResult> {
  const timeoutMs = checkedPositiveInteger(spec.timeout_ms ?? DISPATCH_TIMEOUT_MS, "dispatch timeout");
  const byteCap = checkedPositiveInteger(spec.byte_cap ?? DISPATCH_OUTPUT_BYTE_CAP, "dispatch byte cap");
  const cancellationSource = spec.cancellation_source ?? "client";
  if (spec.signal.aborted) {
    return fail(createProjectError("CANCELLED", { source: cancellationSource, attempt: 1 }));
  }

  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: spec.cwd,
    env: { ...spec.env },
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  };

  const child = spawn(spec.command, [...spec.argv], spawnOptions);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let termination: "timeout" | "cancelled" | "overflow" | "io" | undefined;
  let overflowBytes: number | undefined;
  let ioOperation: "dispatch-stdin" | "dispatch-stdout" | "dispatch-stderr" | undefined;
  let spawnError: NodeJS.ErrnoException | undefined;
  let escalation: NodeJS.Timeout | undefined;

  const stop = (reason: typeof termination): void => {
    if (termination !== undefined) return;
    termination = reason;
    escalation = terminateChild(child);
  };
  const append = (channel: "stdout" | "stderr", chunk: Buffer): void => {
    if (termination !== undefined) return;
    const nextCount = (channel === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
    if (nextCount > byteCap) {
      overflowBytes = nextCount;
      stop("overflow");
      return;
    }
    if (channel === "stdout") {
      stdoutBytes = nextCount;
      stdoutChunks.push(chunk);
    } else {
      stderrBytes = nextCount;
      stderrChunks.push(chunk);
    }
  };

  child.stdout.on("data", (chunk: Buffer) => append("stdout", Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", Buffer.from(chunk)));
  child.stdout.on("error", () => {
    ioOperation = "dispatch-stdout";
    stop("io");
  });
  child.stderr.on("error", () => {
    ioOperation = "dispatch-stderr";
    stop("io");
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    spawnError = error;
  });

  const abort = (): void => stop("cancelled");
  spec.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => stop("timeout"), timeoutMs);
  timeout.unref();

  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
    ioOperation = "dispatch-stdin";
    stop("io");
  });
  child.stdin.end(spec.stdin === undefined ? undefined : Buffer.from(spec.stdin));

  const closed = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  if (escalation !== undefined) clearTimeout(escalation);
  spec.signal.removeEventListener("abort", abort);

  if (spawnError !== undefined) return classifySpawnError(spec.adapter, spawnError);
  if (termination === "cancelled") {
    return fail(createProjectError("CANCELLED", { source: cancellationSource, attempt: 1 }));
  }
  if (termination === "timeout") {
    return fail(createProjectError("TIMEOUT", { adapter: spec.adapter, attempt: 1, limit_ms: timeoutMs }));
  }
  if (termination === "overflow") {
    return fail(createProjectError("OUTPUT_OVERFLOW", {
      adapter: spec.adapter,
      byte_count: overflowBytes!,
      byte_cap: byteCap,
    }));
  }
  if (termination === "io") {
    return fail(createProjectError("IO_ERROR", { operation: ioOperation!, attempt: 1 }));
  }

  const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
  const stderr = Buffer.concat(stderrChunks, stderrBytes);
  const finalOutput = spec.final_output_path === undefined
    ? undefined
    : await readBoundedFinalOutput(spec.adapter, spec.final_output_path, byteCap);
  return Object.freeze({
    exit_code: closed.code,
    signal: closed.signal,
    stdout,
    stderr,
    ...(finalOutput === undefined ? {} : { final_output: finalOutput }),
  });
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0) return false;
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(Buffer.from(needle));
}

/** Exact planted-value regression scan; this is not a generic secret detector or dispatch gate. */
export function scanDispatchOutput(
  output: DispatchOutputChannels,
  plantedValues: readonly string[],
): readonly string[] {
  const channels = [output.stdout, output.stderr, ...(output.final_output === undefined ? [] : [output.final_output])];
  const matches = plantedValues.filter((value) => {
    const bytes = Buffer.from(value, "utf8");
    return channels.some((channel) => includesBytes(channel, bytes));
  });
  return Object.freeze([...new Set(matches)]);
}
