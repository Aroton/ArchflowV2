import { createServer } from "vite";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const CUT_POINTS = Object.freeze([
  "request-created",
  "archive-created",
  "receipt-created",
  "gate-published",
  "state-opened",
  "state-resolved",
  "interface-remove-before",
]);

if (typeof process.send === "function" && process.argv[1] === fileURLToPath(import.meta.url)) {
const [, , action, taskRoot, intentId = "gate-intent", digestByte = "8", cut = "none"] = process.argv;
if (action === undefined || taskRoot === undefined) {
  throw new Error("gate child requires an action, task root, and IPC");
}
if (cut !== "none" && !CUT_POINTS.includes(cut)) {
  throw new Error(`unknown gate cut ${cut}`);
}

const vite = await createServer({ appType: "custom", clearScreen: false, logLevel: "silent", server: { middlewareMode: true } });

try {
  const [canonical, evidence, fingerprints, phase, git, identity, authorityModule, atomicModule, lockModule, read, gates] = await Promise.all([
    vite.ssrLoadModule("/src/contracts/canonical.ts"),
    vite.ssrLoadModule("/src/contracts/evidence.ts"),
    vite.ssrLoadModule("/src/contracts/fingerprints.ts"),
    vite.ssrLoadModule("/src/contracts/phase-instance.ts"),
    vite.ssrLoadModule("/src/repository/git.ts"),
    vite.ssrLoadModule("/src/repository/identity.ts"),
    vite.ssrLoadModule("/src/state/authority.ts"),
    vite.ssrLoadModule("/src/state/atomic.ts"),
    vite.ssrLoadModule("/src/state/lock.ts"),
    vite.ssrLoadModule("/src/state/read.ts"),
    vite.ssrLoadModule("/src/state/gates.ts"),
  ]);
  const taskId = taskRoot.split("/").at(-1);
  const repository = taskRoot.slice(0, -(`/.archflow/tasks/${taskId}`).length);
  const phaseInstance = phase.encodePhaseInstance({ kind: "phase-impl", phase: phase.parsePositiveSafePhaseNumber(12) });
  const context = { task_id: taskId, phase_instance: phaseInstance, operation: "gate-crash-child", attempt: 1 };
  const runner = git.createGitRunner({ cwd: repository });
  const discovered = await identity.discoverWorktree(runner, context);
  const environment = await git.preflightGit(runner, context);
  if (!discovered.ok || !environment.ok) throw new Error("gate child repository discovery failed");
  const authority = await authorityModule.createInternalTransactionAuthority({
    runner: discovered.value, environment: environment.value, task_id: evidence.parseTaskSlug(taskId), context,
  });
  if (!authority.ok) throw new Error("gate child authority failed");
  const state = await read.readTaskState(authority.value.state);
  if (state.kind !== "canonical") throw new Error("gate child state unavailable");
  const subject = {
    schema_version: "1", workflow_digest: state.document.value.workflow_digest,
    config_digest: state.document.value.config_digest, constitution_digest: state.document.value.constitution_digest,
    artifact_identities: [], upstream_identities: [], rubric_digest: "7".repeat(64),
    phase_instance: phaseInstance, declared_inputs: [],
  };
  const inputFingerprint = fingerprints.computeInputFingerprint(subject);
  const reentryKind = action.startsWith("reentry")
    ? "constitution-review"
    : action.startsWith("exhaustion")
      ? "attempts-exhausted"
      : undefined;
  const input = {
    authority: authority.value, expected_revision: 7, intent_id: evidence.parseSafeId(intentId),
    request_digest: evidence.parseSha256Digest(digestByte.repeat(64)), input_fingerprint: inputFingerprint,
    phase_instance: phaseInstance, summary: "Approve the implementation", subject_digest: evidence.parseSha256Digest("9".repeat(64)),
    current_evidence: {
      set_digest: evidence.parseSha256Digest("a".repeat(64)),
      slots: [
        { role: "counter-review", evidence_digest: evidence.parseSha256Digest("c".repeat(64)), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
      ],
    },
    ...(reentryKind === "constitution-review"
      ? {
          kind: reentryKind,
          context: {
            constitution: "pass",
            failed_rules: [],
            uncertain_rules: [],
            matched_trigger_rules: [{ rule_id: "review-required", rule_version: 1 }],
            uncertain_trigger_rules: [],
            eligible_waivers: [],
          },
        }
      : reentryKind === "attempts-exhausted"
        ? {
            kind: reentryKind,
            context: {
              step: state.document.value.step,
              attempts: state.document.value.attempt,
              maximum_attempts: state.document.value.attempt,
            },
          }
        : { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } }),
  };
  const realAtomic = atomicModule.createAtomicWriter();
  let stateReplacements = 0;
  const hit = async (point, path) => {
    if (cut !== point) return;
    await new Promise((resolve, reject) => process.send({ type: "cut", point, path, pid: process.pid }, (error) => error === null ? resolve() : reject(error)));
    if (action.includes("kill")) process.kill(process.pid, "SIGKILL");
    await new Promise((resolve) => {
      const listener = (message) => {
        if (message?.type !== "release") return;
        process.off("message", listener);
        resolve();
      };
      process.on("message", listener);
    });
  };
  const wrappedAtomic = {
    createExclusive: async (path, bytes) => {
      const result = await realAtomic.createExclusive(path, bytes);
      if (result === "created" && path.path_class === "authority-decision") {
        const name = basename(path.absolute);
        await hit(name === "request.json" ? "request-created" : "archive-created", path.absolute);
      }
      if (result === "created" && path.path_class === "workspace-intent") await hit("receipt-created", path.absolute);
      return result;
    },
    replace: async (path, bytes) => {
      await realAtomic.replace(path, bytes);
      if (path.path_class === "workspace-gate-interface" && basename(path.absolute) === "gate.json") await hit("gate-published", path.absolute);
      if (path.path_class === "task-state") {
        stateReplacements += 1;
        await hit(stateReplacements === 1 && action.startsWith("open") ? "state-opened" : "state-resolved", path.absolute);
      }
    },
    removeGateInterface: async (path) => {
      await hit("interface-remove-before", path.absolute);
      await realAtomic.removeGateInterface(path);
    },
  };
  const dependencies = {
    runner: discovered.value, environment: environment.value, atomic: wrappedAtomic, lock: lockModule.createTaskLock(),
    resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: subject }),
    resolve_gate_reentry_fingerprint: async () => ({
      schema_version: "1",
      ok: true,
      value: evidence.parseSha256Digest("e".repeat(64)),
    }),
    read_state: read.readTaskState, read_config: read.readTaskConfig, read_receipt: read.readIntentReceipt,
  };
  // The retired runDurableGate combined open, wait, resolve, and the advancing fallback in one
  // call. The retained surface composes the same journey from exported services: open (which
  // publishes the interface and releases the task lock), an orchestration-level wait for the
  // human decision, the durable resolver (which archives the interface bytes and refuses to
  // manufacture success receipts), and the direct settlement step that finishes an advancing
  // decision. Nothing holds the task lock while the decision lands.
  const result = action.includes("open")
    ? await gates.openDurableGate(dependencies, input)
    : await (async () => {
        const opened = await gates.openDurableGate(dependencies, input);
        if (!opened.ok) return opened;
        if (opened.value.replay === undefined) {
          const decisionFile = `${authority.value.workspace_root}/cache/gates/gate.decision`;
          const deadline = Date.now() + 10_000;
          while (!existsSync(decisionFile)) {
            if (Date.now() > deadline) throw new Error("timed out waiting for the gate decision interface");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        const resolved = await gates.resolveDurableGate(dependencies, authority.value, opened.value.gate_id, inputFingerprint);
        if (resolved.ok || resolved.error.code !== "STATE_INVALID") return resolved;
        const operation = evidence.parseSha256Digest("f".repeat(64));
        return gates.settleDirectSemanticGateDecision(dependencies, {
          authority: authority.value,
          operation_digest: operation,
          intent_id: evidence.parsePathSafeId(`afop-${operation}-decision-settle`),
        });
      })();
  process.send({ type: "result", result });
} catch (error) {
  process.send({ type: "failed", message: error instanceof Error ? error.message : String(error), stack: error?.stack });
} finally {
  await vite.close();
}
}
