import { readFile, link, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export const CUT_POINTS = Object.freeze([
  "initialization-receipt-only",
  "state-before",
  "state-after",
]);

if (typeof process.send === "function" && process.argv[1] === fileURLToPath(import.meta.url)) {
const [, , action, taskRoot, cutPoint] = process.argv;
if (action !== "initialize" || taskRoot === undefined) {
  throw new Error("initialization child requires initialize, a task root, and IPC");
}
if (cutPoint !== "none" && (cutPoint === undefined || !CUT_POINTS.includes(cutPoint))) {
  throw new Error(`unknown initialization child cut ${String(cutPoint)}`);
}
const taskId = taskRoot.split("/").at(-1);
const repository = taskRoot.slice(0, -(`/.archflow/tasks/${taskId}`).length);
const input = JSON.parse(await readFile(join(taskRoot, "initialization-child-input.json"), "utf8"));
const vite = await createServer({ appType: "custom", clearScreen: false, logLevel: "silent", server: { middlewareMode: true } });

const killAt = async (point, path) => {
  await new Promise((resolve, reject) => process.send({ type: "cut", point, path }, (error) => {
    if (error !== null) reject(error);
    else { process.kill(process.pid, "SIGKILL"); resolve(); }
  }));
};

try {
  const [tools, git, identity, authorityModule, atomic, lock, read, initialization] = await Promise.all([
    vite.ssrLoadModule("/src/contracts/mcp-tools.ts"),
    vite.ssrLoadModule("/src/repository/git.ts"),
    vite.ssrLoadModule("/src/repository/identity.ts"),
    vite.ssrLoadModule("/src/state/authority.ts"),
    vite.ssrLoadModule("/src/state/atomic.ts"),
    vite.ssrLoadModule("/src/state/lock.ts"),
    vite.ssrLoadModule("/src/state/read.ts"),
    vite.ssrLoadModule("/src/state/initialization.ts"),
  ]);
  const runner = git.createGitRunner({ cwd: repository });
  const discovered = await identity.discoverWorktree(runner, input.context);
  if (!discovered.ok) throw new Error("discovery failed");
  const environment = await git.preflightGit(discovered.value, input.context);
  if (!environment.ok) throw new Error("preflight failed");
  const authority = await authorityModule.createInternalTransactionAuthority({
    runner: discovered.value, environment: environment.value, task_id: taskId, context: input.context,
  });
  if (!authority.ok) throw new Error("authority failed");
  const call = tools.parseToolCall("archflow_state", input.call);
  const writeTemporary = async (path, bytes) => {
    const handle = await open(path, "wx");
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  };
  const crashAtomic = {
    createExclusive: async (path, bytes) => {
      const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.initialization.tmp`);
      await writeTemporary(temporary, bytes);
      try { await link(temporary, path.absolute); } catch (error) {
        if (error?.code === "EEXIST") return "exists";
        throw error;
      } finally { await unlink(temporary).catch(() => undefined); }
      if (cutPoint === "initialization-receipt-only" && path.path_class === "workspace-intent") await killAt(cutPoint, path.absolute);
      return "created";
    },
    replace: async (path, bytes) => {
      const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.initialization.tmp`);
      await writeTemporary(temporary, bytes);
      if (cutPoint === "state-before" && path.path_class === "task-state") await killAt(cutPoint, temporary);
      await rename(temporary, path.absolute);
      if (cutPoint === "state-after" && path.path_class === "task-state") await killAt(cutPoint, path.absolute);
    },
  };
  const dependencies = {
    runner: discovered.value,
    environment: environment.value,
    atomic: cutPoint === "none" ? atomic.createAtomicWriter() : crashAtomic,
    lock: lock.createTaskLock(),
    resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: input.subject }),
    read_state: read.readTaskState,
    read_config: read.readTaskConfig,
    read_receipt: read.readIntentReceipt,
  };
  const result = await initialization.runStateInitialization(dependencies, { call, authority: authority.value });
  process.send({ type: "result", ok: result.ok, code: result.ok ? undefined : result.error.code,
    revision: result.ok ? result.value.state.value.revision : undefined, replayed: result.ok ? result.value.replayed : undefined });
} catch (error) {
  process.send({ type: "failed", name: error instanceof Error ? error.name : "unknown", message: String(error) });
  process.exitCode = 1;
} finally {
  await vite.close();
}
}
