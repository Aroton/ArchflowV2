import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  benchmarkEnabled,
  realHostsAvailable,
  realHostsEnabled,
  requireRealHostsAvailable,
  resetRealHostsCacheForTesting,
  REAL_HOST_OPT_IN_ENV,
  REVIEW_BENCHMARK_OPT_IN_ENV,
} from "../helpers/real-host.js";

const originalPath = process.env.PATH;
const originalRealHosts = process.env[REAL_HOST_OPT_IN_ENV];
const originalBenchmark = process.env[REVIEW_BENCHMARK_OPT_IN_ENV];
const temporaryRoots: string[] = [];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("PATH", originalPath);
  restore(REAL_HOST_OPT_IN_ENV, originalRealHosts);
  restore(REVIEW_BENCHMARK_OPT_IN_ENV, originalBenchmark);
  delete process.env.PROBE_LOG;
  resetRealHostsCacheForTesting();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installFakeHosts(codexAuthChannel: "stdout" | "stderr" | "both" = "stdout"): string {
  const root = mkdtempSync(join(tmpdir(), "archflow-real-host-probe-"));
  temporaryRoots.push(root);
  const script = `#!/bin/sh
printf '%s %s\\n' "$0" "$*" >> "$PROBE_LOG"
case "$0:$*" in
  *claude*:"auth status") printf '%s\\n' '{"loggedIn":true}' ;;
  *codex*:"login status") ${codexAuthChannel === "both"
    ? "printf '%s\\n' 'Logged in using ChatGPT'; printf '%s\\n' 'Logged in using ChatGPT' >&2"
    : `printf '%s\\n' 'Logged in using ChatGPT' ${codexAuthChannel === "stderr" ? ">&2" : ""}`} ;;
  *claude*) printf '%s\\n' '2.1.221 (Claude Code)' ;;
  *codex*) printf '%s\\n' 'codex-cli 0.146.0' ;;
esac
`;
  for (const name of ["claude", "codex"]) {
    const path = join(root, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  return root;
}

describe("real-host gate", () => {
  it("does not probe installed hosts without the explicit opt-in", () => {
    const root = installFakeHosts();
    const log = join(root, "probes.log");
    process.env.PATH = root;
    process.env.PROBE_LOG = log;
    delete process.env[REAL_HOST_OPT_IN_ENV];

    expect(realHostsEnabled()).toBe(false);
    expect(realHostsAvailable()).toBe(false);
    expect(process.env.PATH).toBe(root);
    expect(existsSync(log)).toBe(false);
  });

  it("removes an npm node_modules bin shadow before probing and dispatch", () => {
    const valid = installFakeHosts();
    const shadowRoot = mkdtempSync(join(tmpdir(), "archflow-real-host-shadow-"));
    temporaryRoots.push(shadowRoot);
    const shadow = join(shadowRoot, "node_modules", ".bin");
    mkdirSync(shadow, { recursive: true });
    for (const name of ["claude", "codex"]) {
      const path = join(shadow, name);
      writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' 'obsolete shadow host'\nexit 1\n");
      chmodSync(path, 0o755);
    }
    const log = join(valid, "probes.log");
    process.env.PATH = `${shadow}${delimiter}${valid}`;
    process.env.PROBE_LOG = log;
    process.env[REAL_HOST_OPT_IN_ENV] = "1";

    expect(realHostsAvailable()).toBe(true);
    expect(process.env.PATH).toBe(valid);
    expect(readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ").slice(1).join(" ")))
      .toEqual(["--version", "auth status", "--version", "login status"]);
  });

  it("fails explicitly when an opted-in suite has no available hosts", () => {
    const empty = mkdtempSync(join(tmpdir(), "archflow-real-host-empty-"));
    temporaryRoots.push(empty);
    process.env.PATH = empty;
    process.env[REAL_HOST_OPT_IN_ENV] = "1";

    expect(() => requireRealHostsAvailable(realHostsAvailable())).toThrow(/authenticated Claude and Codex hosts are unavailable/u);
  });

  it("probes both version and authentication only after opt-in", () => {
    const root = installFakeHosts();
    const log = join(root, "probes.log");
    process.env.PATH = root;
    process.env.PROBE_LOG = log;
    process.env[REAL_HOST_OPT_IN_ENV] = "1";

    expect(realHostsAvailable()).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ").slice(1).join(" ")))
      .toEqual(["--version", "auth status", "--version", "login status"]);
  });

  it("requires both opt-ins for the benchmark", () => {
    process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = "1";
    delete process.env[REAL_HOST_OPT_IN_ENV];
    expect(benchmarkEnabled()).toBe(false);

    process.env[REAL_HOST_OPT_IN_ENV] = "1";
    expect(benchmarkEnabled()).toBe(true);
  });

  it("accepts the current Codex login success line from stderr", () => {
    const root = installFakeHosts("stderr");
    process.env.PATH = root;
    process.env.PROBE_LOG = join(root, "probes.log");
    process.env[REAL_HOST_OPT_IN_ENV] = "1";

    expect(realHostsAvailable()).toBe(true);
  });

  it("accepts duplicate Codex login success lines across stdout and stderr", () => {
    const root = installFakeHosts("both");
    process.env.PATH = root;
    process.env.PROBE_LOG = join(root, "probes.log");
    process.env[REAL_HOST_OPT_IN_ENV] = "1";

    expect(realHostsAvailable()).toBe(true);
  });
});
