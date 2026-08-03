import { readFile, link, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createServer } from "vite";

const [, , action, taskRoot, cutPoint] = process.argv;
if ((action !== "initialize" && action !== "adopt") || taskRoot === undefined || typeof process.send !== "function") {
  throw new Error("phase 10 child requires initialize|adopt, a task root, and IPC");
}
const taskId = taskRoot.split("/").at(-1);
const repository = taskRoot.slice(0, -(`/.archflow/tasks/${taskId}`).length);
const input = JSON.parse(await readFile(join(taskRoot, "phase10-child-input.json"), "utf8"));
const vite = await createServer({ appType: "custom", clearScreen: false, logLevel: "silent", server: { middlewareMode: true } });

const killAt = async (point, path) => {
  await new Promise((resolve, reject) => process.send({ type: "cut", point, path }, (error) => {
    if (error !== null) reject(error);
    else { process.kill(process.pid, "SIGKILL"); resolve(); }
  }));
};

try {
  const [canonical, tools, git, identity, authorityModule, atomic, lock, read, initialization, transaction, checkpoints, requestModule, manualImport] = await Promise.all([
    vite.ssrLoadModule("/src/contracts/canonical.ts"),
    vite.ssrLoadModule("/src/contracts/mcp-tools.ts"),
    vite.ssrLoadModule("/src/repository/git.ts"),
    vite.ssrLoadModule("/src/repository/identity.ts"),
    vite.ssrLoadModule("/src/state/authority.ts"),
    vite.ssrLoadModule("/src/state/atomic.ts"),
    vite.ssrLoadModule("/src/state/lock.ts"),
    vite.ssrLoadModule("/src/state/read.ts"),
    vite.ssrLoadModule("/src/state/initialization.ts"),
    vite.ssrLoadModule("/src/state/transaction.ts"),
    vite.ssrLoadModule("/src/state/checkpoints.ts"),
    vite.ssrLoadModule("/src/state/request.ts"),
    vite.ssrLoadModule("/src/state/manual-import.ts"),
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
      const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.phase10.tmp`);
      await writeTemporary(temporary, bytes);
      try { await link(temporary, path.absolute); } catch (error) {
        if (error?.code === "EEXIST") return "exists";
        throw error;
      } finally { await unlink(temporary).catch(() => undefined); }
      if (cutPoint === "receipt-only") await killAt(cutPoint, path.absolute);
      return "created";
    },
    replace: async (path, bytes) => {
      const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.phase10.tmp`);
      await writeTemporary(temporary, bytes);
      if (cutPoint === "state-before") await killAt(cutPoint, temporary);
      await rename(temporary, path.absolute);
      if (cutPoint === "state-after") await killAt(cutPoint, path.absolute);
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
    load_retained_result: async () => { throw new Error("empty crash-test chains must not load retained results"); },
  };
  let evidence;
  if (call.input.artifact?.artifact_kind === "manual-checkpoint-import") {
    const loaded = await manualImport.loadManualImportEvidence({
      dependencies, authority: authority.value, artifact: call.input.artifact,
    });
    if (!loaded.ok) {
      process.send({ type: "result", ok: false, code: loaded.error.code });
      process.exitCode = 1;
      throw new Error("manual import evidence failed");
    }
    evidence = loaded.value;
  }
  let result;
  if (action === "initialize") {
    result = await initialization.runStateInitialization(dependencies, { call, authority: authority.value }, evidence);
  } else {
    result = await transaction.runStateTransaction(dependencies, { call, authority: authority.value }, async (current) => {
      const identified = requestModule.identifyTransactionRequest(call, authority.value, call.input.input_fingerprint);
      const success = { path: "state.json", revision: current.value.revision + 1, status: call.input.status };
      const expectation = tools.createInternalResultExpectation({
        schema_version: "1", tool: "archflow_state", task_id: taskId, intent_id: call.input.intent_id,
        input_fingerprint: call.input.input_fingerprint, request_digest: identified.request_digest,
        result_id: call.input.intent_id, resulting_revision: success.revision, success,
      });
      const toolResult = tools.validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success });
      return checkpoints.planCheckpointAdoption({ current, call, expectation, result: toolResult, evidence });
    });
  }
  process.send({ type: "result", ok: result.ok, code: result.ok ? undefined : result.error.code,
    revision: result.ok ? result.value.state.value.revision : undefined, replayed: result.ok ? result.value.replayed : undefined });
} catch (error) {
  process.send({ type: "failed", name: error instanceof Error ? error.name : "unknown", message: String(error) });
  process.exitCode = 1;
} finally {
  await vite.close();
}
