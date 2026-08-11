import { createServer } from "vite";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCrashProjectionWriter } from "./crash-projection-writer.mjs";

export const CUT_POINTS = Object.freeze([
  "receipt-temp",
  "receipt-link",
  "result-payload-link",
  "result-manifest-link",
  "projection-replace-before",
  "projection-replace-after",
  "state-replace-before",
  "state-replace-after",
]);

if (typeof process.send === "function" && process.argv[1] === fileURLToPath(import.meta.url)) {
const [, , action, target, intentId, expectedRevisionText, cutPoint] = process.argv;

if (target === undefined) {
  throw new Error("state transaction child requires an action, target, and IPC");
}
if (cutPoint !== undefined && !CUT_POINTS.includes(cutPoint)) {
  throw new Error(`unknown state transaction cut ${cutPoint}`);
}
if (action?.startsWith("run-crash-") && cutPoint === undefined) {
  throw new Error("crash transaction requires a cut point");
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
  } else if (["run-transaction", "run-crash-transaction", "run-result-transaction", "run-crash-result-transaction"].includes(action)) {
    if (intentId === undefined || expectedRevisionText === undefined) {
      throw new Error("run-transaction requires repository, intent id, and expected revision");
    }
    const taskId = target.split("/").at(-1);
    const repository = target.slice(0, -(`/.archflow/tasks/${taskId}`).length);
    const [canonical, evidence, fingerprints, tools, git, identity, authorityModule, atomic, lock, read, transaction, requestModule, snapshots] = await Promise.all([
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
      vite.ssrLoadModule("/src/state/request.ts"),
      vite.ssrLoadModule("/src/state/snapshots.ts"),
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
    const resultMode = action.includes("result");
    const retainedBytes = new TextEncoder().encode("retained-result\n");
    const outputPath = `.archflow/tasks/${taskId}/phases/result.md`;
    const contentDigest = canonical.sha256Bytes(retainedBytes);
    const output = {
      path: outputPath, path_class: "document", operation: "add", storage: "raw-payload",
      payload_bytes: retainedBytes.byteLength, payload_digest: contentDigest, file_type: "regular",
      after: { oid: canonical.gitBlobOid(retainedBytes), mode: "100644", size_bytes: retainedBytes.byteLength },
    };
    const projections = [{ path: outputPath, content_digest: contentDigest }];
    const snapshotDigest = snapshots.deriveDeclaredSnapshotDigest([output], projections);
    const artifact = {
      schema_version: "1", artifact_kind: "document", task_id: taskId,
      phase_instance: "phase-impl-9", step: "produce", document_path: "phases/result.md",
      path_class: "document", byte_count: retainedBytes.byteLength, content_digest: contentDigest, declared_inputs: [],
      input_fingerprint: inputFingerprint, snapshot_digest: snapshotDigest,
      projection_target: outputPath,
    };
    const resultId = `result-${intentId}`;
    const resultManifest = canonical.canonicalDocument({
      schema_version: "1", task_id: taskId,
      repository_identity_digest: authority.value.repository_identity_digest,
      result_id: resultId, phase_instance: "phase-impl-9", step: "produce",
      artifact_digest: canonical.canonicalJsonDigest(artifact), source_artifact: artifact,
      input_fingerprint: inputFingerprint, snapshot_digest: snapshotDigest,
      outputs: [output], projections,
      accounting: {
        schema_version: "1", result_bytes: retainedBytes.byteLength, task_bytes: retainedBytes.byteLength,
        result_byte_cap: 26_214_400, task_byte_cap: 262_144_000,
        counted_entries: [{ path: outputPath, storage: "raw-payload", stored_bytes: retainedBytes.byteLength }],
        measured_at_revision: stateRead.document.value.revision,
      },
      secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: "test", scanned_paths: [outputPath] },
    });
    const call = tools.parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: taskId,
      intent_id: intentId,
      expected_revision: Number(expectedRevisionText),
      input_fingerprint: inputFingerprint,
      phase_instance: "phase-impl-9",
      step: "produce",
      status: "succeeded",
      ...(resultMode ? { artifact } : {}),
    });
    const requestDigest = requestModule.identifyTransactionRequest(call, authority.value, inputFingerprint).request_digest;
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
    const atomicWriter = action.startsWith("run-crash-")
      ? {
          createExclusive: async (path, bytes) => {
            await mkdir(dirname(path.absolute), { recursive: true });
            const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.crash.tmp`);
            await writeTemporary(temporary, bytes);
            if (cutPoint === "receipt-temp" && path.path_class === "intent") await killAtCut(cutPoint, temporary);
            try {
              await link(temporary, path.absolute);
            } catch (error) {
              if (error?.code === "EEXIST") return "exists";
              throw error;
            }
            if (
              (cutPoint === "receipt-link" && path.path_class === "intent") ||
              (cutPoint === "result-payload-link" && path.path_class === "result-payload") ||
              (cutPoint === "result-manifest-link" && path.path_class === "result-manifest")
            ) await killAtCut(cutPoint, path.absolute);
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
    const manifestClaim = `.archflow/tasks/${taskId}/results/sha256/${resultManifest.digest}/manifest.json`;
    const payloadClaim = `.archflow/tasks/${taskId}/results/sha256/${resultManifest.digest}/payload/${outputPath}`;
    const manifestTarget = { absolute: join(repository, manifestClaim), repositoryRelative: manifestClaim, path_class: "result-manifest" };
    const payloadTarget = { absolute: join(repository, payloadClaim), repositoryRelative: payloadClaim, path_class: "result-payload" };
    const projectionTarget = { absolute: join(repository, outputPath), repositoryRelative: outputPath, path_class: "document" };
    if (resultMode) await mkdir(dirname(projectionTarget.absolute), { recursive: true });
    const capturedProjection = await snapshots.captureProjectionTarget(projectionTarget);
    const desiredProjection = { state: "present", file_type: "regular", mode: "100644", bytes: retainedBytes };
    const desiredObservation = {
      state: "present", file_type: "regular", mode: "100644",
      size_bytes: retainedBytes.byteLength, content_digest: contentDigest,
    };
    const projectionExact = JSON.stringify(capturedProjection.observation) === JSON.stringify(desiredObservation);
    const installation = {
      prepared: { manifest: resultManifest, result_digest: resultManifest.digest,
        payloads: [{ path: outputPath, bytes: retainedBytes, target: payloadTarget }] },
      manifest_target: manifestTarget,
      projection_plan: {
        entries: [{
          path: outputPath,
          target: projectionTarget,
          observed_before: capturedProjection.observation,
          desired: desiredProjection,
          rollback: capturedProjection.rollback,
          git_tracked: false,
          disposition: projectionExact ? "exact" : "restore-ready",
        }],
        collisions: [],
        collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
      },
      worktree_root: discovered.value.location.worktreeRoot,
    };
    if (resultMode) await mkdir(dirname(payloadTarget.absolute), { recursive: true });
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
      projection_writer: action.startsWith("run-crash-")
        ? createCrashProjectionWriter(atomic.createProjectionWriter(), cutPoint, killAtCut)
        : atomic.createProjectionWriter(),
      read_retained_task_bytes: async () => 0,
      load_retained_result: async (reference) => {
        const bytes = new Uint8Array(await readFile(payloadTarget.absolute));
        if (canonical.sha256Bytes(bytes) !== resultManifest.value.outputs[0].payload_digest) throw new Error("retained payload changed");
        return { schema_version: "1", ok: true, value: {
          ...installation,
          prepared: { ...installation.prepared, payloads: [{ path: outputPath, bytes, target: payloadTarget }] },
        } };
      },
    }, { call, authority: authority.value }, async (current) => {
      prepareCalls += 1;
      const { revision: _revision, committed_intent: _committedIntent, ...nextState } = current.value;
      const success = { path: "state.json", revision: current.value.revision + 1, status: "succeeded" };
      const reference = {
        phase_instance: current.value.phase_instance, step: current.value.step,
        result_digest: resultManifest.digest, result_id: resultId,
        input_fingerprint: inputFingerprint, manifest_path: manifestClaim,
      };
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
            result_id: resultId,
            resulting_revision: success.revision,
            success,
          }),
          result: tools.validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success }),
          next_state: { ...nextState, status: "succeeded",
            ...(resultMode ? { authoritative_results: [reference] } : {}) },
          ...(resultMode ? { result_installation: transaction.prepareResultInstallation({ reference, ...installation }) } : {}),
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
}
