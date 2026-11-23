import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTemporaryRepositories, temporaryRoot } from "../helpers/temp-repository.js";

const script = fileURLToPath(new URL("../../skills/archflow-run/scripts/wait.sh", import.meta.url));
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

afterAll(() => {
  cleanupTemporaryRepositories();
});

/** A directory in the temp root, optionally shaped like a handle, with its last change set two days back. */
function directory(temp: string, name: string, files: Readonly<Record<string, string>>, old: boolean): string {
  const path = join(temp, name);
  mkdirSync(path);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  if (old) utimesSync(path, twoDaysAgo, twoDaysAgo);
  return path;
}

/** Runs the script to its end without blocking the test's own timers. */
function run(path: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("bash", [path, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("archflow-run wait script", () => {
  it("returns after one slice with the line to run next, and that line reports the command's status", () => {
    const temp = temporaryRoot("wait-slice");
    const env = { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLICE: "1" };

    const first = spawnSync("bash", [script, "run", "sleep 3; exit 3"], { encoding: "utf8", env });

    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain("running after 1s; continue with:");
    const handle = /^handle=([^;]+);/.exec(first.stdout)?.[1] ?? "";
    expect(first.stdout).toContain(`bash '${script}' wait '${handle}'`);

    // The caller keeps running the printed line; a slice that sees the command end carries its status.
    let next = spawnSync("bash", [script, "wait", handle], { encoding: "utf8", env });
    for (let slices = 0; next.status === 0 && slices < 10; slices += 1) {
      expect(next.stdout).toContain("running after 1s");
      next = spawnSync("bash", [script, "wait", handle], { encoding: "utf8", env });
    }
    expect(next.stdout, next.stderr).toContain("exit=3");
    expect(next.status).toBe(3);
  });

  it("finishes cleanly when the script file is rewritten while it waits", async () => {
    // An install or an edit overwrites the file in place. Bash reads a script as it goes, so a copy that had not
    // read everything would pick up at its old position in the new bytes.
    const temp = temporaryRoot("wait-rewritten");
    const copy = join(temp, "wait.sh");
    const original = readFileSync(script, "utf8");
    writeFileSync(copy, original);

    const waiting = run(copy, ["run", "sleep 2; exit 3"], { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLICE: "20" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    writeFileSync(copy, original.replace("\n", "\n# a later version of this script, with every later byte moved\n"));
    const result = await waiting;

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("exit=3");
    expect(result.status).toBe(3);
  });

  it("holds a command back until another one frees the only slot", async () => {
    const temp = temporaryRoot("wait-slots");
    const env = { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLOTS: "1" };
    const marker = join(temp, "first-is-running");

    const first = run(script, ["run", `touch '${marker}'; sleep 3; rm '${marker}'`], { ...env, ARCHFLOW_WAIT_SLICE: "20" });
    while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 50));
    // The second command fails if it ever runs beside the first. Its first slice ends while it is still queued.
    const queued = await run(script, ["run", `[ ! -e '${marker}' ]`], { ...env, ARCHFLOW_WAIT_SLICE: "1" });

    expect(queued.status, queued.stdout + queued.stderr).toBe(0);
    expect(queued.stdout).toContain("running after 1s");
    expect(queued.stdout).toContain("queued: waiting for one of 1 slots");
    expect((await first).stdout).toContain("exit=0");

    const handle = /continue with: bash '.*' wait '(.*)'/.exec(queued.stdout)?.[1] ?? "";
    const finished = await run(script, ["wait", handle], { ...env, ARCHFLOW_WAIT_SLICE: "20" });
    expect(finished.stdout, finished.stdout + finished.stderr).toContain("exit=0");
    expect(finished.status).toBe(0);
  }, 20_000);

  it("deletes old finished handles when a command starts and keeps everything else", () => {
    const temp = temporaryRoot("wait-handle-sweep");
    const oldFinished = directory(temp, "archflow-wait.oldfin", { command: "true\n", pid: "1\n", exit: "0\n" }, true);
    const oldDead = directory(temp, "archflow-wait.olddead", { command: "true\n", pid: "2147483646\n" }, true);
    // This test's own process stands in for a runner that is still going after a day.
    const oldRunning = directory(temp, "archflow-wait.oldrun", { command: "sleep 1\n", pid: `${process.pid}\n` }, true);
    const recentFinished = directory(temp, "archflow-wait.recent", { command: "true\n", pid: "1\n", exit: "0\n" }, false);
    const notAHandle = directory(temp, "archflow-wait.notes", { "notes.txt": "someone's own\n" }, true);
    const unrelated = directory(temp, "unrelated", { command: "true\n", exit: "0\n" }, true);

    const result = spawnSync("bash", [script, "run", "true"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLICE: "20" },
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("exit=0");
    expect(existsSync(oldFinished)).toBe(false);
    expect(existsSync(oldDead)).toBe(false);
    for (const kept of [oldRunning, recentFinished, notAHandle, unrelated]) expect(existsSync(kept), kept).toBe(true);
    // The handle this run created is still there for the caller to read.
    expect(readdirSync(temp).filter((name) => name.startsWith("archflow-wait.")).length).toBe(4);
  });

  it("returns quickly for a fast command without waiting a full polling interval", () => {
    const temp = temporaryRoot("wait-fast-path");
    const env = { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLICE: "20", ARCHFLOW_WAIT_SYSTEMD: "0" };
    const start = Date.now();
    const result = spawnSync("bash", [script, "run", "echo fast-ok"], { encoding: "utf8", env });
    const elapsedMs = Date.now() - start;

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("exit=0");
    expect(result.stdout).toContain("fast-ok");
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("runs --full exclusively across all slots and blocks normal jobs until it completes", async () => {
    const temp = temporaryRoot("wait-full-exclusive");
    const env = { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLOTS: "2", ARCHFLOW_WAIT_SYSTEMD: "0" };
    const normalMarker = join(temp, "normal-running");
    const fullMarker = join(temp, "full-running");

    // Start a normal job in slot 1.
    const normal1 = run(script, ["run", `touch '${normalMarker}'; sleep 1.5; rm '${normalMarker}'`], {
      ...env,
      ARCHFLOW_WAIT_SLICE: "20",
    });
    while (!existsSync(normalMarker)) await new Promise((resolve) => setTimeout(resolve, 30));

    // --full must wait for normal1 to finish before running, and fail if normalMarker still exists.
    const fullJob = run(
      script,
      ["run", "--full", `[ ! -e '${normalMarker}' ] && touch '${fullMarker}' && sleep 1.5 && rm '${fullMarker}'`],
      { ...env, ARCHFLOW_WAIT_SLICE: "20" },
    );

    // Wait until --full actually holds the exclusive lock and creates its marker.
    const normal1Res = await normal1;
    expect(normal1Res.status, normal1Res.stdout + normal1Res.stderr).toBe(0);
    while (!existsSync(fullMarker)) await new Promise((resolve) => setTimeout(resolve, 30));

    // A normal job submitted while --full is running must wait until --full finishes.
    const normal2 = await run(script, ["run", `[ ! -e '${fullMarker}' ] && echo after-full`], {
      ...env,
      ARCHFLOW_WAIT_SLICE: "20",
    });
    const fullRes = await fullJob;

    expect(fullRes.status, fullRes.stdout + fullRes.stderr).toBe(0);
    expect(normal2.status, normal2.stdout + normal2.stderr).toBe(0);
    expect(normal2.stdout).toContain("after-full");
  }, 20_000);

  it("assigns sliced CPU affinity per slot and full usable CPUs for --full", () => {
    if (process.platform !== "linux" || availableParallelism() < 6) return;

    const temp = temporaryRoot("wait-cpuset");
    const nodeCmd = `node -e 'console.log("CPUS=" + require("node:os").availableParallelism() + " CARGO=" + process.env.CARGO_BUILD_JOBS)'`;

    for (const mode of ["0", "auto"] as const) {
      const env = {
        ...process.env,
        TMPDIR: temp,
        ARCHFLOW_WAIT_SLOTS: "3",
        ARCHFLOW_WAIT_SLICE: "20",
        ARCHFLOW_WAIT_SYSTEMD: mode,
      };
      const normal = spawnSync("bash", [script, "run", nodeCmd], { encoding: "utf8", env });
      const full = spawnSync("bash", [script, "run", "--full", nodeCmd], { encoding: "utf8", env });

      expect(normal.status, normal.stdout + normal.stderr).toBe(0);
      expect(full.status, full.stdout + full.stderr).toBe(0);

      const normalCpus = Number(/CPUS=(\d+)/.exec(normal.stdout)?.[1] ?? 0);
      const normalCargo = Number(/CARGO=(\d+)/.exec(normal.stdout)?.[1] ?? 0);
      const fullCpus = Number(/CPUS=(\d+)/.exec(full.stdout)?.[1] ?? 0);
      const expectedUsable = availableParallelism() - 2;

      expect(normalCpus, `mode=${mode}`).toBeGreaterThan(0);
      expect(normalCpus, `mode=${mode}`).toBeLessThan(expectedUsable);
      expect(normalCargo, `mode=${mode}`).toBe(normalCpus);
      expect(fullCpus, `mode=${mode}`).toBe(expectedUsable);
    }
  });

  it("allows the first job when free RAM is below the floor, and holds a second concurrent job until it finishes", async () => {
    if (!existsSync("/proc/meminfo")) return;

    const temp = temporaryRoot("wait-ram-gate");
    const env = {
      ...process.env,
      TMPDIR: temp,
      ARCHFLOW_WAIT_SLOTS: "2",
      ARCHFLOW_WAIT_MIN_FREE_MB: "999999999",
      ARCHFLOW_WAIT_SYSTEMD: "0",
    };
    const marker = join(temp, "first-ram-running");

    // First job must NOT deadlock even though free RAM is below the configured floor.
    const first = run(script, ["run", `touch '${marker}'; sleep 2; rm '${marker}'`], {
      ...env,
      ARCHFLOW_WAIT_SLICE: "20",
    });
    while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 30));

    // Second concurrent job sees another job active and queues on free RAM.
    const second = await run(script, ["run", `[ ! -e '${marker}' ] && echo ram-ok`], {
      ...env,
      ARCHFLOW_WAIT_SLICE: "1",
    });

    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("queued: waiting for free RAM");
    expect((await first).status).toBe(0);

    const handle = /continue with: bash '.*' wait '(.*)'/.exec(second.stdout)?.[1] ?? "";
    const finished = await run(script, ["wait", handle], { ...env, ARCHFLOW_WAIT_SLICE: "20" });
    expect(finished.status, finished.stdout + finished.stderr).toBe(0);
    expect(finished.stdout).toContain("ram-ok");
  }, 20_000);

  it("stops a running command and releases its slot immediately", async () => {
    const temp = temporaryRoot("wait-stop");
    const env = { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLOTS: "1", ARCHFLOW_WAIT_SLICE: "1" };
    const started = join(temp, "stop-started");

    const first = await run(script, ["run", `touch '${started}'; sleep 60`], env);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const handle = /^handle=([^;]+);/.exec(first.stdout)?.[1] ?? "";
    while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 30));

    const stopped = spawnSync("bash", [script, "stop", handle], { encoding: "utf8", env });
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("stopped");

    // Slot must now be free so the next job completes immediately.
    const after = spawnSync("bash", [script, "run", "echo slot-freed"], {
      encoding: "utf8",
      env: { ...env, ARCHFLOW_WAIT_SLICE: "20" },
    });
    expect(after.status, after.stdout + after.stderr).toBe(0);
    expect(after.stdout).toContain("slot-freed");
  }, 20_000);

  it("slices CPU masks strictly within inherited non-zero-based CPU affinity", () => {
    if (process.platform !== "linux" || availableParallelism() < 12) return;

    const temp = temporaryRoot("wait-inherited-affinity");
    const upperStart = availableParallelism() - 8;
    const upperEnd = availableParallelism() - 1;
    const inherited = `${upperStart}-${upperEnd}`;
    const probeCmd = `awk '$1 == "Cpus_allowed_list:" { print "ALLOWED=" $2 }' /proc/self/status; echo "CARGO=$CARGO_BUILD_JOBS"`;

    const result = spawnSync(
      "taskset",
      ["-c", inherited, "bash", script, "run", probeCmd],
      {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLOTS: "2", ARCHFLOW_WAIT_SLICE: "20", ARCHFLOW_WAIT_SYSTEMD: "0" },
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    const allowed = /ALLOWED=([0-9,-]+)/.exec(result.stdout)?.[1] ?? "";
    const cargo = Number(/CARGO=(\d+)/.exec(result.stdout)?.[1] ?? 0);
    expect(allowed).not.toBe("");
    // 8 inherited CPUs -> 6 usable CPUs (reserving top 2), 2 slots -> 3 CPUs in slot 1: upperStart..(upperStart+2).
    expect(allowed).toBe(`${upperStart}-${upperStart + 2}`);
    expect(cargo).toBe(3);
  });

  it("configures systemd slice properties, scope flags, OOMPolicy fallback (<253), and stops recorded units", async () => {
    const temp = temporaryRoot("wait-systemd-stubs");
    const bin = join(temp, "bin");
    const log = join(temp, "systemd.log");
    mkdirSync(bin);

    // Deterministic PATH stubs for systemctl and systemd-run so we assert exact host-protection arguments
    // regardless of the host's systemd version or user bus availability.
    const systemctlStub = join(bin, "systemctl");
    writeFileSync(
      systemctlStub,
      `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> '${log}'
exit 0
`,
    );
    const systemdRunStub = join(bin, "systemd-run");
    writeFileSync(
      systemdRunStub,
      `#!/usr/bin/env bash
printf 'systemd-run %s\\n' "$*" >> '${log}'
if [ "\${STUB_REJECT_OOM:-0}" = "1" ] && [[ " $* " == *"OOMPolicy=kill"* ]]; then
  exit 1
fi
if [ "\${STUB_REJECT_SCOPE:-0}" = "1" ]; then
  exit 1
fi
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
exec "$@"
`,
    );
    chmodSync(systemctlStub, 0o755);
    chmodSync(systemdRunStub, 0o755);

    const stubEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: temp,
      ARCHFLOW_WAIT_SLOTS: "2",
      ARCHFLOW_WAIT_SLICE: "20",
      ARCHFLOW_WAIT_SYSTEMD: "auto",
    };

    // 1. Full systemd (>=253): slice properties, scope properties with OOMPolicy=kill, and systemctl stop.
    const started = join(temp, "sd-running");
    const first = await run(script, ["run", `touch '${started}'; sleep 60`], { ...stubEnv, ARCHFLOW_WAIT_SLICE: "1" });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const handle = /^handle=([^;]+);/.exec(first.stdout)?.[1] ?? "";
    while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 30));

    const unit = readFileSync(join(handle, "unit"), "utf8").trim();
    expect(unit).toMatch(/^archflow-wait-.*\.scope$/);
    expect(readFileSync(join(handle, "meta"), "utf8")).toContain("systemd=1 oom_policy=1");

    const stopRes = spawnSync("bash", [script, "stop", handle], { encoding: "utf8", env: stubEnv });
    expect(stopRes.status, stopRes.stdout + stopRes.stderr).toBe(0);

    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/systemctl --user set-property --runtime archflow-jobs\.slice CPUQuota=\d+% CPUWeight=50 IOWeight=20/);
    if (existsSync("/proc/meminfo")) {
      expect(calls).toMatch(/MemoryHigh=\d+M MemoryMax=\d+M/);
    }
    expect(calls).toContain(`systemd-run --user --scope --quiet --unit=${unit} --slice=archflow-jobs.slice -p CPUWeight=100 -p IOWeight=20 -p OOMPolicy=kill`);
    expect(calls).toContain(`systemctl --user stop ${unit}`);

    // 2. Older systemd (<253) rejecting OOMPolicy=kill on scopes: stays on systemd without OOMPolicy=kill.
    writeFileSync(log, "");
    const noOom = spawnSync("bash", [script, "run", "echo legacy-systemd-ok"], {
      encoding: "utf8",
      env: { ...stubEnv, STUB_REJECT_OOM: "1" },
    });
    expect(noOom.status, noOom.stdout + noOom.stderr).toBe(0);
    expect(noOom.stdout).toContain("legacy-systemd-ok");
    const noOomHandle = /^handle=([^;]+);/.exec(noOom.stdout)?.[1] ?? "";
    expect(readFileSync(join(noOomHandle, "meta"), "utf8")).toContain("systemd=1 oom_policy=0");
    const noOomUnit = readFileSync(join(noOomHandle, "unit"), "utf8").trim();
    const noOomCalls = readFileSync(log, "utf8");
    expect(noOomCalls).toContain(`--unit=${noOomUnit}`);
    const actualScopeLine = noOomCalls.split("\n").find((line) => line.includes(`--unit=${noOomUnit}`)) ?? "";
    expect(actualScopeLine).not.toContain("OOMPolicy=kill");

    // 3. Scope creation denied: falls back cleanly without systemd instead of failing commands.
    const fallback = spawnSync("bash", [script, "run", "echo fallback-ok"], {
      encoding: "utf8",
      env: { ...stubEnv, STUB_REJECT_SCOPE: "1" },
    });
    expect(fallback.status, fallback.stdout + fallback.stderr).toBe(0);
    expect(fallback.stdout).toContain("fallback-ok");
    const fallbackHandle = /^handle=([^;]+);/.exec(fallback.stdout)?.[1] ?? "";
    expect(readFileSync(join(fallbackHandle, "meta"), "utf8")).toContain("systemd=0 oom_policy=0");
  }, 20_000);

  it("works without Linux-only tools (macOS-like PATH: no flock, setsid, taskset, ionice, systemd, nproc)", async () => {
    const temp = temporaryRoot("wait-macos-compat");
    const bin = join(temp, "bin");
    mkdirSync(bin);

    // Expose only POSIX/macOS utilities (deliberately omitting flock, setsid, taskset, ionice, systemd-run, systemctl, nproc, nice).
    const pathDirs = (process.env.PATH ?? "/usr/bin:/bin").split(":").filter(Boolean);
    const macTools = [
      "awk",
      "basename",
      "bash",
      "cat",
      "date",
      "dirname",
      "env",
      "find",
      "getconf",
      "id",
      "mkdir",
      "mktemp",
      "mv",
      "nohup",
      "pgrep",
      "rm",
      "rmdir",
      "seq",
      "sleep",
      "tail",
      "touch",
      "tr",
      "true",
    ];
    for (const tool of macTools) {
      const found = pathDirs.map((dir) => join(dir, tool)).find((candidate) => existsSync(candidate));
      if (found) symlinkSync(found, join(bin, tool));
    }

    // Trailing slash mirrors macOS TMPDIR (/var/folders/.../T/).
    const macEnv: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: process.env.HOME,
      TMPDIR: `${temp}/`,
      ARCHFLOW_WAIT_SLICE: "20",
    };

    // 1. Zero-argument usage works cleanly under set -u, and a normal run works with both affinity=() and prio=().
    const usage = spawnSync("bash", [script], { encoding: "utf8", env: macEnv });
    expect(usage.status).toBe(2);
    expect(usage.stdout).toContain("usage:");

    const basic = spawnSync("bash", [script, "run", "echo mac-ok CARGO=$CARGO_BUILD_JOBS"], {
      encoding: "utf8",
      env: { ...macEnv, ARCHFLOW_WAIT_SLOTS: "2" },
    });
    expect(basic.status, basic.stdout + basic.stderr).toBe(0);
    expect(basic.stdout).toContain("mac-ok");
    const basicHandle = /^handle=([^;]+);/.exec(basic.stdout)?.[1] ?? "";
    expect(basicHandle).not.toContain("//");
    expect(readFileSync(join(basicHandle, "meta"), "utf8")).toMatch(/^slot=1 full=0 /);

    // 2. Slot queueing + --full exclusivity work via the portable mkdir lock protocol, even across mixed PATHs.
    const normalMarker = join(temp, "mac-normal");
    const fullMarker = join(temp, "mac-full");
    const slotEnv = { ...macEnv, ARCHFLOW_WAIT_SLOTS: "2" };

    // Start normal1 with the host PATH (which has flock on Linux) and --full with macEnv (no flock), sharing one slot_dir.
    const hostPathSlotEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: `${temp}/`, ARCHFLOW_WAIT_SLOTS: "2", ARCHFLOW_WAIT_SLICE: "20" };
    const normal1 = run(script, ["run", `touch '${normalMarker}'; sleep 1.2; rm '${normalMarker}'`], hostPathSlotEnv);
    while (!existsSync(normalMarker)) await new Promise((resolve) => setTimeout(resolve, 30));

    const fullJob = run(
      script,
      ["run", "--full", `[ ! -e '${normalMarker}' ] && touch '${fullMarker}' && sleep 1.2 && rm '${fullMarker}'`],
      slotEnv,
    );

    expect((await normal1).status).toBe(0);
    while (!existsSync(fullMarker)) await new Promise((resolve) => setTimeout(resolve, 30));

    const normal2 = await run(script, ["run", `[ ! -e '${fullMarker}' ] && echo after-mac-full`], slotEnv);
    expect((await fullJob).status).toBe(0);
    expect(normal2.status, normal2.stdout + normal2.stderr).toBe(0);
    expect(normal2.stdout).toContain("after-mac-full");

    // 3. Strict FIFO order across two queued jobs even without high-resolution date.
    const fifoSlotDir = join(temp, "fifo-slots");
    const fifoMarker = join(temp, "fifo-first");
    const fifoOrder = join(temp, "fifo-order");
    const fifoEnv = { ...macEnv, ARCHFLOW_WAIT_SLOTS: "1", ARCHFLOW_WAIT_SLOT_DIR: fifoSlotDir };

    const first = run(script, ["run", `touch '${fifoMarker}'; sleep 1.2; rm '${fifoMarker}'`], fifoEnv);
    while (!existsSync(fifoMarker)) await new Promise((resolve) => setTimeout(resolve, 30));

    const second = run(script, ["run", `echo second >> '${fifoOrder}'`], fifoEnv);
    const queueDir = join(fifoSlotDir, "queue");
    while (!existsSync(queueDir) || readdirSync(queueDir).length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const third = run(script, ["run", `echo third >> '${fifoOrder}'`], fifoEnv);

    expect((await first).status).toBe(0);
    expect((await second).status).toBe(0);
    expect((await third).status).toBe(0);
    expect(readFileSync(fifoOrder, "utf8")).toBe("second\nthird\n");

    // 4. stop without setsid terminates via pgrep -P, removes slot-1.pid immediately, and a later wait reports exit=unknown.
    const stopSlotDir = join(temp, "stop-slots");
    const stopStarted = join(temp, "mac-stop-started");
    const oneSlotEnv = { ...macEnv, ARCHFLOW_WAIT_SLOTS: "1", ARCHFLOW_WAIT_SLICE: "1", ARCHFLOW_WAIT_SLOT_DIR: stopSlotDir };
    const stuck = await run(script, ["run", `touch '${stopStarted}'; sleep 60`], oneSlotEnv);
    expect(stuck.status, stuck.stdout + stuck.stderr).toBe(0);
    const stuckHandle = /^handle=([^;]+);/.exec(stuck.stdout)?.[1] ?? "";
    while (!existsSync(stopStarted)) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(existsSync(join(stopSlotDir, "slot-1.pid"))).toBe(true);

    const stopped = spawnSync("bash", [script, "stop", stuckHandle], { encoding: "utf8", env: oneSlotEnv });
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("stopped");
    expect(existsSync(join(stopSlotDir, "slot-1.pid"))).toBe(false);

    const afterWait = spawnSync("bash", [script, "wait", stuckHandle], { encoding: "utf8", env: oneSlotEnv });
    expect(afterWait.status).toBe(125);
    expect(afterWait.stdout).toContain("exit=unknown");

    // 5. Stale slot/mutex locks left by dead PIDs are reclaimed instead of deadlocking.
    const slotDir = join(temp, "stale-slots");
    mkdirSync(join(slotDir, "lock.d"), { recursive: true });
    writeFileSync(join(slotDir, "lock.d", "owner.2147483646"), "");
    writeFileSync(join(slotDir, "slot-1.pid"), "2147483646\n");
    writeFileSync(join(slotDir, "full.pid"), "2147483646\n");

    const recovered = spawnSync("bash", [script, "run", "echo stale-recovered"], {
      encoding: "utf8",
      env: { ...macEnv, ARCHFLOW_WAIT_SLOTS: "1", ARCHFLOW_WAIT_SLOT_DIR: slotDir },
    });
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("stale-recovered");
  }, 25_000);
});
