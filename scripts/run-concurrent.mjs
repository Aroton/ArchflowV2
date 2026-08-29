import { availableParallelism, cpus } from "node:os";
import { spawn } from "node:child_process";

const responsiveWorkers = Math.max(1, (typeof availableParallelism === "function" ? availableParallelism() : cpus().length) - 2);

function parseArgs(args) {
  const scripts = [];
  const commands = [];
  let mode = "scripts";
  let maxConcurrency = responsiveWorkers;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--npm") {
      mode = "scripts";
    } else if (arg === "--exec") {
      mode = "commands";
    } else if (arg === "--concurrency" || arg === "-c") {
      maxConcurrency = Math.max(1, parseInt(args[++i], 10) || responsiveWorkers);
    } else if (mode === "scripts") {
      scripts.push(arg);
    } else {
      commands.push(arg);
    }
  }

  const tasks = [
    ...scripts.map((script) => ({
      name: script,
      cmd: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", script],
    })),
    ...commands.map((cmd) => ({
      name: cmd,
      cmd: "/bin/sh",
      args: ["-c", cmd],
    })),
  ];

  return { tasks, maxConcurrency };
}

async function runTask(task) {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(task.cmd, task.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code, signal) => {
      const durationMs = Math.round(performance.now() - start);
      resolve({
        task,
        code,
        signal,
        durationMs,
        stdout,
        stderr,
        ok: code === 0,
      });
    });

    child.on("error", (err) => {
      const durationMs = Math.round(performance.now() - start);
      resolve({
        task,
        code: 1,
        signal: null,
        durationMs,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        ok: false,
      });
    });
  });
}

async function main() {
  const { tasks, maxConcurrency } = parseArgs(process.argv.slice(2));
  if (tasks.length === 0) {
    console.error("Usage: node scripts/run-concurrent.mjs [--npm <scripts...>] [--exec <commands...>] [--concurrency <n>]");
    process.exit(1);
  }

  const results = [];
  const executing = new Set();
  let failed = false;

  for (const task of tasks) {
    if (failed) break;

    const promise = runTask(task).then((result) => {
      executing.delete(promise);
      results.push(result);
      if (!result.ok) {
        failed = true;
        process.stderr.write(`\n[FAILED] ${result.task.name} (${result.durationMs}ms):\n`);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      } else {
        process.stdout.write(`  ✓ ${result.task.name} (${result.durationMs}ms)\n`);
      }
      return result;
    });

    executing.add(promise);
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);

  if (failed || results.some((r) => !r.ok)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
