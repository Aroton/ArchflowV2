import { createServer } from "vite";
import { link, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const [, , action, target, intentId, expectedRevisionText, cutPoint] = process.argv;

if (target === undefined || typeof process.send !== "function") {
  throw new Error("state transaction child requires an action, target, and IPC");
}

const vite = await createServer({
  appType: "custom",
  clearScreen: false,
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  if (action === "hold-lock") {
    const { createTaskLock } = await vite.ssrLoadModule("/src/state/lock.ts");
    await createTaskLock().runExclusive(target, async () => {
      process.send({ type: "entered", pid: process.pid });
      await new Promise((resolve) => {
        const onMessage = (message) => {
          if (message?.type !== "release") return;
          process.off("message", onMessage);
          resolve();
        };
        process.on("message", onMessage);
      });
    });
    process.send({ type: "released", pid: process.pid });
  } else if (action === "run-transaction" || action === "run-crash-transaction") {
    if (intentId === undefined || expectedRevisionText === undefined) {
      throw new Error("run-transaction requires repository, intent id, and expected revision");
    }
    const taskId = target.split("/").at(-1);
    const repository = target.slice(0, -(`/.archflow/tasks/${taskId}`).length);
    const [canonical, evidence, fingerprints, tools, git, identity, authorityModule, atomic, lock, read, transaction] = await Promise.all([
      vite.ssrLoadModule("/src/contracts/canonical.ts"),
      vite.ssrLoadModule("/src/contracts/evidence.ts"),
      vite.ssrLoadModule("/src/contracts/fingerprints.ts"),
      vite.ssrLoadModule("/src/contracts/mcp-tools.ts"),
      vite.ssrLoadModule("/src/repository/git.ts"),
      vite.ssrLoadModule("/src/repository/identity.ts"),
      vite.ssrLoadModule("/src/state/authority.ts"),
      vite.ssrLoadModule("/src/state/atomic.ts"),
      vite.ssrLoadModule("/src/state/lock.ts"),
      vite.ssrLoadModule("/src/state/read.ts"),
      vite.ssrLoadModule("/src/state/transaction.ts"),
    ]);
    const context = {
      task_id: taskId,
      phase_instance: "phase-impl-9",
      operation: "transaction-child",
      attempt: 1,
    };
    const initialRunner = git.createGitRunner({ cwd: repository });
    const environment = await git.preflightGit(initialRunner, context);
    const discovered = await identity.discoverWorktree(initialRunner, context);
    if (!environment.ok || !discovered.ok) throw new Error("repository setup failed");
    const authority = await authorityModule.createInternalTransactionAuthority({
      runner: discovered.value,
      environment: environment.value,
      task_id: evidence.parseTaskSlug(taskId),
      context,
    });
    if (!authority.ok) throw new Error("transaction authority setup failed");
    const stateRead = await read.readTaskState(authority.value.state);
    const configRead = await read.readTaskConfig(authority.value.config);
    if (stateRead.kind !== "canonical" || configRead.kind !== "valid") throw new Error("durable fixture setup failed");
    const subject = {
      schema_version: "1",
      workflow_digest: stateRead.document.value.workflow_digest,
      config_digest: configRead.snapshot.digest,
      constitution_digest: stateRead.document.value.constitution_digest,
      artifact_identities: [],
      upstream_identities: [],
      rubric_digest: canonical.canonicalJsonDigest({}),
      phase_instance: "phase-impl-9",
      declared_inputs: [],
    };
    const inputFingerprint = fingerprints.computeInputFingerprint(subject);
    const call = tools.parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: taskId,
      intent_id: intentId,
      expected_revision: Number(expectedRevisionText),
      input_fingerprint: inputFingerprint,
      phase_instance: "phase-impl-9",
      step: "produce",
      status: "succeeded",
    });
    const requestDigest = fingerprints.computeRequestDigest({
      schema_version: "1",
      tool: "archflow_state",
      repository_identity_digest: authority.value.repository_identity_digest,
      task_identity_digest: authority.value.task_identity_digest,
      operation: "record-state-boundary",
      operation_fields: { phase_instance: "phase-impl-9", step: "produce", status: "succeeded" },
      input_fingerprint: inputFingerprint,
    });
    const killAtCut = async (point, path) => {
      await new Promise((resolve, reject) => {
        process.send({ type: "cut", point, path, pid: process.pid }, (error) => {
          if (error !== null) reject(error);
          else {
            process.kill(process.pid, "SIGKILL");
            resolve();
          }
        });
      });
    };
    const writeTemporary = async (path, bytes) => {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const atomicWriter = action === "run-crash-transaction"
      ? {
          createExclusive: async (path, bytes) => {
            const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.crash.tmp`);
            await writeTemporary(temporary, bytes);
            if (cutPoint === "receipt-temp") await killAtCut(cutPoint, temporary);
            try {
              await link(temporary, path.absolute);
            } catch (error) {
              if (error?.code === "EEXIST") return "exists";
              throw error;
            }
            if (cutPoint === "receipt-link") await killAtCut(cutPoint, temporary);
            await unlink(temporary);
            return "created";
          },
          replace: async (path, bytes) => {
            const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.crash.tmp`);
            await writeTemporary(temporary, bytes);
            if (cutPoint === "state-replace-before") await killAtCut(cutPoint, temporary);
            await rename(temporary, path.absolute);
            if (cutPoint === "state-replace-after") await killAtCut(cutPoint, temporary);
          },
        }
      : atomic.createAtomicWriter();
    let prepareCalls = 0;
    const result = await transaction.runStateTransaction({
      runner: discovered.value,
      environment: environment.value,
      atomic: atomicWriter,
      lock: lock.createTaskLock(),
      resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: subject }),
      read_state: read.readTaskState,
      read_config: read.readTaskConfig,
      read_receipt: read.readIntentReceipt,
    }, { call, authority: authority.value }, async (current) => {
      prepareCalls += 1;
      const { revision: _revision, committed_intent: _committedIntent, ...nextState } = current.value;
      const success = { path: "state.json", revision: current.value.revision + 1, status: "succeeded" };
      return {
        schema_version: "1",
        ok: true,
        value: {
          expectation: tools.createInternalResultExpectation({
            schema_version: "1",
            tool: "archflow_state",
            task_id: taskId,
            intent_id: intentId,
            input_fingerprint: inputFingerprint,
            request_digest: requestDigest,
            result_id: `result-${intentId}`,
            resulting_revision: success.revision,
            success,
          }),
          result: tools.validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success }),
          next_state: { ...nextState, status: "succeeded" },
        },
      };
    });
    process.send({
      type: "result",
      ok: result.ok,
      code: result.ok ? undefined : result.error.code,
      revision: result.ok ? result.value.state.value.revision : undefined,
      replayed: result.ok ? result.value.replayed : undefined,
      prepareCalls,
    });
  } else {
    throw new Error(`unknown child action ${String(action)}`);
  }
} catch (error) {
  process.send({
    type: "failed",
    name: error instanceof Error ? error.name : "unknown",
    stage: error?.stage,
  });
  process.exitCode = 1;
} finally {
  await vite.close();
}
