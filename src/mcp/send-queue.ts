import type { Writable } from "node:stream";

export type SendSource = "direct" | "sdk" | "fallback";

export interface SendEntry {
  readonly source: SendSource;
  readonly frame: Uint8Array;
  readonly requestToken?: string;
}

export interface SendReceipt {
  readonly admitted: Promise<void>;
  readonly completed: Promise<void>;
}

export interface SendQueue {
  readonly backpressured: boolean;
  readonly enqueue: (entry: SendEntry) => SendReceipt;
  readonly close: () => Promise<void>;
}

const MAX_ENTRIES = 1_024;
const MAX_BYTES = 10 * 1_024 * 1_024;

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface PendingSend {
  readonly entry: SendEntry;
  readonly admitted: Deferred;
  readonly completed: Deferred;
  writeReturned: boolean;
  callbackCalled: boolean;
  callbackError: Error | null | undefined;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export function createSendQueue(
  output: Writable,
  onBackpressureChange: (paused: boolean) => void,
  onFatal: () => void,
): SendQueue {
  const waiting: PendingSend[] = [];
  const incomplete = new Set<PendingSend>();
  let incompleteBytes = 0;
  let paused = false;
  let closed = false;
  let pumping = false;

  const closeError = new Error("Send queue closed");

  function notifyBackpressure(value: boolean): boolean {
    if (paused === value) {
      return true;
    }

    paused = value;
    try {
      onBackpressureChange(value);
      return true;
    } catch (error: unknown) {
      fail(asError(error, "Backpressure notification failed"));
      return false;
    }
  }

  function removeListeners(): void {
    output.off("drain", handleDrain);
    output.off("error", handleOutputError);
  }

  function rejectIncomplete(error: Error): void {
    waiting.length = 0;
    for (const pending of incomplete) {
      if (!pending.writeReturned) {
        pending.admitted.reject(error);
      }
      pending.completed.reject(error);
    }
    incomplete.clear();
    incompleteBytes = 0;
  }

  function shutDown(error: Error, fatal: boolean): void {
    if (closed) {
      return;
    }

    closed = true;
    removeListeners();
    const wasPaused = paused;
    paused = false;
    rejectIncomplete(error);

    if (wasPaused) {
      try {
        onBackpressureChange(false);
      } catch {
        // Shutdown is already final; a notification failure cannot widen it.
      }
    }

    if (fatal) {
      try {
        onFatal();
      } catch {
        // The queue remains closed even if its fatal observer fails.
      }
    }
  }

  function fail(error: Error): void {
    shutDown(error, true);
  }

  function finish(pending: PendingSend, error?: Error | null): void {
    if (!incomplete.has(pending)) {
      return;
    }

    if (error != null) {
      pending.completed.reject(error);
      fail(error);
      return;
    }

    incomplete.delete(pending);
    incompleteBytes -= pending.entry.frame.byteLength;
    pending.completed.resolve();
    pump();
  }

  function handleWriteCallback(
    pending: PendingSend,
    error?: Error | null,
  ): void {
    if (!pending.writeReturned) {
      pending.callbackCalled = true;
      pending.callbackError = error;
      return;
    }
    finish(pending, error);
  }

  function pump(): void {
    if (pumping || paused || closed) {
      return;
    }

    pumping = true;
    try {
      while (!paused && !closed) {
        const pending = waiting.shift();
        if (pending === undefined) {
          break;
        }

        let accepted: boolean;
        try {
          accepted = output.write(pending.entry.frame, (error?: Error | null) => {
            handleWriteCallback(pending, error);
          });
          pending.writeReturned = true;
          pending.admitted.resolve();
        } catch (error: unknown) {
          pending.writeReturned = true;
          const writeError = asError(error, "Output write failed");
          pending.admitted.reject(writeError);
          pending.completed.reject(writeError);
          incomplete.delete(pending);
          incompleteBytes -= pending.entry.frame.byteLength;
          fail(writeError);
          break;
        }

        if (!accepted && !closed) {
          notifyBackpressure(true);
        }

        if (pending.callbackCalled && !closed) {
          finish(pending, pending.callbackError);
        }
      }
    } finally {
      pumping = false;
    }
  }

  function handleDrain(): void {
    if (!closed && paused && notifyBackpressure(false)) {
      pump();
    }
  }

  function handleOutputError(error: Error): void {
    fail(asError(error, "Output stream failed"));
  }

  output.on("drain", handleDrain);
  output.on("error", handleOutputError);

  return {
    get backpressured(): boolean {
      return paused;
    },

    enqueue(entry: SendEntry): SendReceipt {
      const admitted = deferred();
      const completed = deferred();
      const receipt = { admitted: admitted.promise, completed: completed.promise };

      if (closed) {
        admitted.reject(closeError);
        completed.reject(closeError);
        return receipt;
      }

      const nextBytes = incompleteBytes + entry.frame.byteLength;
      if (
        entry.frame.byteLength > MAX_BYTES ||
        incomplete.size >= MAX_ENTRIES ||
        nextBytes > MAX_BYTES
      ) {
        const overflowError = new Error("Send queue capacity exceeded");
        admitted.reject(overflowError);
        completed.reject(overflowError);
        fail(overflowError);
        return receipt;
      }

      const pending: PendingSend = {
        entry,
        admitted,
        completed,
        writeReturned: false,
        callbackCalled: false,
        callbackError: undefined,
      };
      waiting.push(pending);
      incomplete.add(pending);
      incompleteBytes = nextBytes;
      pump();
      return receipt;
    },

    async close(): Promise<void> {
      shutDown(closeError, false);
    },
  };
}
