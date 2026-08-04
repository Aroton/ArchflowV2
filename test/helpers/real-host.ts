/**
 * The shared opt-in and availability gate for tests that invoke real coding-agent hosts.
 *
 * Test helpers normally know nothing about `src/**`, so fixture defects cannot be mistaken for
 * source defects. This is the deliberate third exception (after `resolved-constitution.ts` and
 * `task-workspace.ts`): its test timeout is coupled to the production dispatch timeout.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, normalize } from "node:path";

import { DISPATCH_TIMEOUT_MS } from "../../src/dispatch/process.js";

export const REAL_HOST_OPT_IN_ENV = "ARCHFLOW_REAL_HOSTS";
export const REVIEW_BENCHMARK_OPT_IN_ENV = "ARCHFLOW_REVIEW_BENCHMARK";
export const REAL_HOST_PROBE_TIMEOUT_MS = 10_000;
export const REAL_HOST_TEST_TIMEOUT_MS = DISPATCH_TIMEOUT_MS + 60_000;
export const REVIEW_BENCHMARK_TEST_TIMEOUT_MS = 3_600_000;

function optedIn(name: string): boolean {
  return process.env[name] === "1";
}

function sanitizePathForRealHosts(): void {
  const path = process.env.PATH;
  if (path === undefined) return;
  process.env.PATH = path.split(delimiter).filter((entry) => {
    const normalized = normalize(entry).replace(/[\\/]+$/u, "");
    return !/(?:^|[\\/])node_modules[\\/]\.bin$/u.test(normalized);
  }).join(delimiter);
}

/** Returns whether real-host tests were explicitly enabled for this process. */
export function realHostsEnabled(): boolean {
  return optedIn(REAL_HOST_OPT_IN_ENV);
}

/** Returns whether the longer review benchmark received its separate second opt-in. */
export function benchmarkEnabled(): boolean {
  return realHostsEnabled() && optedIn(REVIEW_BENCHMARK_OPT_IN_ENV);
}

function output(command: string, argv: readonly string[]): string {
  return execFileSync(command, [...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: REAL_HOST_PROBE_TIMEOUT_MS,
  });
}

function claudeAuthenticated(): boolean {
  const value = JSON.parse(output("claude", ["auth", "status"])) as unknown;
  return value !== null && typeof value === "object" &&
    Object.getOwnPropertyDescriptor(value, "loggedIn")?.value === true;
}

function codexAuthenticated(): boolean {
  const result = spawnSync("codex", ["login", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: REAL_HOST_PROBE_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) return false;
  const successLines = [result.stdout, result.stderr]
    .flatMap((channel) => typeof channel === "string" ? channel.split(/\r?\n/u) : [])
    .filter((line) => /^Logged in(?:\s|$)/u.test(line.trim()));
  return successLines.length >= 1;
}

/**
 * Synchronously checks the two required real hosts and their authentication state.
 *
 * The explicit suite opt-in is checked before any child process is spawned, preserving hermetic
 * ordinary test runs even when both authenticated CLIs are installed on `PATH`.
 */
export function realHostsAvailable(): boolean {
  if (!realHostsEnabled()) return false;
  // npm/npx prepend package bins to PATH. A stale host shim there must not shadow the developer's
  // installed first-party CLI during an explicitly opted-in run. The sanitized PATH intentionally
  // remains installed so production dispatch uses the same binaries the probe approved.
  sanitizePathForRealHosts();
  try {
    output("claude", ["--version"]);
    if (!claudeAuthenticated()) return false;
    output("codex", ["--version"]);
    return codexAuthenticated();
  } catch {
    return false;
  }
}

/** Converts an opted-in but unavailable suite from a silent skip into an explicit failure. */
export function requireRealHostsAvailable(available: boolean): void {
  if (realHostsEnabled() && !available) {
    throw new Error("ARCHFLOW_REAL_HOSTS=1, but authenticated Claude and Codex hosts are unavailable after PATH sanitization");
  }
}
