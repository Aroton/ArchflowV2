import type { Readable, Writable } from "node:stream";

import type {
  McpRuntimeHandle,
  McpRuntimeOptions,
  RuntimeTermination,
} from "./sdk-adapter.js";

export interface SignalSource {
  readonly on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
}

export interface ProcessBindings {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostic: Writable;
  readonly workingDirectory: string;
  readonly signals: SignalSource;
  readonly setExitCode: (code: number) => void;
}

export type RuntimeStarter = (
  options: McpRuntimeOptions,
) => Promise<McpRuntimeHandle>;

type ExitReason =
  | Readonly<{ kind: "startup" }>
  | Readonly<{ kind: "runtime-fatal" }>
  | Readonly<{ kind: "eof" }>
  | Readonly<{ kind: "signal"; code: 130 | 143 }>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

type StartupResult =
  | Readonly<{ kind: "started"; runtime: McpRuntimeHandle }>
  | Readonly<{ kind: "failed" }>;

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function reasonForRuntime(termination: RuntimeTermination): ExitReason {
  return termination.reason === "input-eof"
    ? { kind: "eof" }
    : { kind: "runtime-fatal" };
}

export async function runMcpProcess(
  bindings: ProcessBindings,
  start: RuntimeStarter,
): Promise<void> {
  const selected = deferred<ExitReason>();
  let firstReason: ExitReason | undefined;
  let diagnosticWritten = false;
  let exitCodeSet = false;

  function select(reason: ExitReason): void {
    if (firstReason === undefined) {
      firstReason = reason;
      selected.resolve(reason);
    }
  }

  function writeDiagnostic(code: string): void {
    if (diagnosticWritten) {
      return;
    }
    diagnosticWritten = true;
    try {
      bindings.diagnostic.write(`${code}\n`);
    } catch {
      // Diagnostics are best effort and never replace the selected exit reason.
    }
  }

  function setExitCode(code: number): void {
    if (exitCodeSet) {
      return;
    }
    exitCodeSet = true;
    bindings.setExitCode(code);
  }

  const onSigint = (): void => select({ kind: "signal", code: 130 });
  const onSigterm = (): void => select({ kind: "signal", code: 143 });

  bindings.signals.on("SIGINT", onSigint);
  bindings.signals.on("SIGTERM", onSigterm);

  let runtime: McpRuntimeHandle | undefined;
  let termination: RuntimeTermination | undefined;
  let closePromise: Promise<boolean> | undefined;

  function closeOnce(handle: McpRuntimeHandle): Promise<boolean> {
    closePromise ??= Promise.resolve()
      .then(() => handle.close())
      .then(
        () => false,
        () => true,
      );
    return closePromise;
  }

  try {
    let startup: Promise<StartupResult>;
    try {
      startup = start({
        input: bindings.input,
        output: bindings.output,
        workingDirectory: bindings.workingDirectory,
      }).then(
        (startedRuntime): StartupResult => ({
          kind: "started",
          runtime: startedRuntime,
        }),
        (): StartupResult => ({ kind: "failed" }),
      );
    } catch {
      startup = Promise.resolve({ kind: "failed" });
    }

    const startupRace = await Promise.race([
      startup,
      selected.promise.then(() => undefined),
    ]);

    if (startupRace === undefined) {
      void startup.then((result) => {
        if (result.kind === "started") {
          void result.runtime.closed.catch(() => undefined);
          void closeOnce(result.runtime).then((closeFailed) => {
            if (closeFailed) {
              writeDiagnostic("ARCHFLOW_MCP_CLOSE_FAILED");
            }
          });
        }
      });
    } else if (startupRace.kind === "failed") {
      select({ kind: "startup" });
    } else {
      runtime = startupRace.runtime;
    }

    if (runtime !== undefined) {
      void runtime.closed.then(
        (result: RuntimeTermination) => {
          termination = result;
          select(reasonForRuntime(result));
        },
        () => select({ kind: "runtime-fatal" }),
      );
    }

    const reason = await selected.promise;
    let closeFailed = termination?.close_failed ?? false;

    if (runtime !== undefined) {
      const closeRejected = await closeOnce(runtime);
      closeFailed ||= closeRejected;

      if (termination === undefined) {
        try {
          termination = await runtime.closed;
          closeFailed ||= termination.close_failed;
        } catch {
          closeFailed = true;
        }
      }
    }

    let exitCode: number;
    switch (reason.kind) {
      case "startup":
        writeDiagnostic("ARCHFLOW_MCP_START_FAILED");
        exitCode = 1;
        break;
      case "runtime-fatal":
        writeDiagnostic("ARCHFLOW_MCP_TRANSPORT_ERROR");
        exitCode = 1;
        break;
      case "eof":
        exitCode = closeFailed ? 1 : 0;
        if (closeFailed) {
          writeDiagnostic("ARCHFLOW_MCP_CLOSE_FAILED");
        }
        break;
      case "signal":
        exitCode = reason.code;
        if (closeFailed) {
          writeDiagnostic("ARCHFLOW_MCP_CLOSE_FAILED");
        }
        break;
    }

    setExitCode(exitCode);
  } finally {
    bindings.signals.off("SIGINT", onSigint);
    bindings.signals.off("SIGTERM", onSigterm);
  }
}
