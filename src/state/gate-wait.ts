import { constants as fsConstants } from "node:fs";
import { lstat } from "node:fs/promises";

import { openResolved, type ResolvedWorkspacePath } from "../repository/paths.js";

export const GATE_POLL_INTERVAL_MS = 500;

export type GateWaitOutcome =
  | Readonly<{ kind: "interface" }>
  | Readonly<{ kind: "aborted" }>;

export type GateWaitInput = Readonly<{
  decision_path: ResolvedWorkspacePath;
  signal: AbortSignal;
}>;

async function isCompleteRegularProjection(path: ResolvedWorkspacePath): Promise<boolean> {
  let handle;
  try {
    const metadata = await lstat(path.absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
    handle = await openResolved(path.absolute, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    return (await handle.stat()).isFile();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ELOOP") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function delayOrAbort(signal: AbortSignal): Promise<"poll" | "aborted"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("poll");
    }, GATE_POLL_INTERVAL_MS);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Waits outside the task lock and returns only a signal; resolve must re-read under the lock. */
export async function waitForGateInterface(input: GateWaitInput): Promise<GateWaitOutcome> {
  if (input.decision_path.path_class !== "workspace-gate-interface") {
    throw new TypeError("gate wait decision path must be a gate-interface");
  }
  for (;;) {
    if (input.signal.aborted) return Object.freeze({ kind: "aborted" });
    if (await isCompleteRegularProjection(input.decision_path)) {
      return Object.freeze({ kind: "interface" });
    }
    if (await delayOrAbort(input.signal) === "aborted") return Object.freeze({ kind: "aborted" });
  }
}
