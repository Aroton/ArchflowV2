import { constants as fsConstants } from "node:fs";
import { lstat } from "node:fs/promises";

import type { Sha256Digest } from "../contracts/evidence.js";
import { sha256Bytes } from "../contracts/canonical.js";
import { openResolved, type ResolvedPath } from "../repository/paths.js";

export const GATE_POLL_INTERVAL_MS = 500;

export type GateWaitOutcome =
  | Readonly<{ kind: "interface" }>
  | Readonly<{ kind: "supplemental"; evidence_digest: Sha256Digest }>
  | Readonly<{ kind: "aborted" }>;

export type GateWaitInput = Readonly<{
  decision_path: ResolvedPath;
  supplemental?: Readonly<{
    path: ResolvedPath;
    evidence_digest?: Sha256Digest;
    recorded_evidence_digests: readonly Sha256Digest[];
  }>;
  signal: AbortSignal;
}>;

async function isCompleteRegularProjection(path: ResolvedPath): Promise<boolean> {
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

async function completeProjectionDigest(path: ResolvedPath): Promise<Sha256Digest | undefined> {
  let handle;
  try {
    handle = await openResolved(path.absolute, fsConstants.O_RDONLY);
    if (!(await handle.stat()).isFile()) return undefined;
    return sha256Bytes(new Uint8Array(await handle.readFile()));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw error;
  } finally { await handle?.close().catch(() => undefined); }
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
  if (input.decision_path.path_class !== "gate-interface") {
    throw new TypeError("gate wait decision path must be a gate-interface");
  }
  if (input.supplemental !== undefined && input.supplemental.path.path_class !== "review") {
    throw new TypeError("gate wait supplemental path must be a review");
  }

  const alreadyRecorded = input.supplemental === undefined
    ? undefined
    : new Set(input.supplemental.recorded_evidence_digests);
  for (;;) {
    if (input.signal.aborted) return Object.freeze({ kind: "aborted" });
    if (input.supplemental !== undefined) {
      const evidenceDigest = input.supplemental.evidence_digest ?? await completeProjectionDigest(input.supplemental.path);
      if (evidenceDigest !== undefined && !alreadyRecorded!.has(evidenceDigest)) {
      return Object.freeze({
        kind: "supplemental",
        evidence_digest: evidenceDigest,
      });
      }
    }
    if (await isCompleteRegularProjection(input.decision_path)) {
      return Object.freeze({ kind: "interface" });
    }
    if (await delayOrAbort(input.signal) === "aborted") return Object.freeze({ kind: "aborted" });
  }
}
