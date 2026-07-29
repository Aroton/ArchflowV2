import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, parseGitOid } from "../../src/contracts/canonical.js";
import { parseManualCheckpoint, type ManualCheckpointImportV1, type ManualCheckpointV1 } from "../../src/contracts/durable-checkpoint.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { installHandoffRecord, observeDivergentHeads, planCleanHandoff } from "../../src/repository/handoff.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { resolveTaskPath } from "../../src/repository/paths.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const TASK = parseTaskSlug("task-1");
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(10) });
const D = (value: string) => parseSha256Digest(value.repeat(64));
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

describe("repository handoff", () => {
  it("preserves divergent heads and records only an explicit later clean selection", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-handoff-")));
    roots.push(root);
    const upstream = join(root, "upstream");
    const clone = join(root, "clone");
    git(root, "-c", "init.defaultBranch=main", "init", "-q", upstream);
    mkdirSync(join(upstream, ".archflow", "tasks", TASK), { recursive: true });
    writeFileSync(join(upstream, ".archflow", "tasks", TASK, "config.yaml"), "task: task-1\n");
    writeFileSync(join(upstream, ".archflow", "tasks", TASK, "state.json"), "{}\n");
    writeFileSync(join(upstream, "base.txt"), "base\n");
    git(upstream, "add", "-A"); git(upstream, "commit", "-q", "-m", "base");
    git(root, "clone", "-q", upstream, clone);

    writeFileSync(join(clone, "local.txt"), "local\n");
    git(clone, "add", "local.txt"); git(clone, "commit", "-q", "-m", "local");
    const localHead = parseGitOid(git(clone, "rev-parse", "HEAD"));
    writeFileSync(join(upstream, "remote.txt"), "remote\n");
    git(upstream, "add", "remote.txt"); git(upstream, "commit", "-q", "-m", "remote");
    git(clone, "fetch", "-q");
    const upstreamHead = parseGitOid(git(clone, "rev-parse", "origin/main"));

    const context: RepositoryOperationContext = { task_id: TASK, phase_instance: PHASE, operation: parseSafeCode("handoff-test"), attempt: parseSafeInteger(1) };
    const discovered = await discoverWorktree(createGitRunner({ cwd: clone }), context);
    if (!discovered.ok) throw new Error("discovery failed");
    const environment = await preflightGit(discovered.value, context);
    if (!environment.ok) throw new Error("preflight failed");
    const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: TASK, context });
    if (!authority.ok) throw new Error("authority failed");

    const fixture = JSON.parse(readFileSync(new URL("../fixtures/contracts/durable/manual-checkpoint-import.valid.json", import.meta.url), "utf8")) as ManualCheckpointImportV1;
    const commonDocument = canonicalDocument(parseManualCheckpoint({
      ...fixture.chain[0]!, task_id: TASK, repository_identity_digest: authority.value.repository_identity_digest,
    }));
    const successor = (status: "succeeded" | "failed") => canonicalDocument(parseManualCheckpoint({
      ...fixture.chain[1]!, task_id: TASK, repository_identity_digest: authority.value.repository_identity_digest,
      status,
      predecessor: { revision: commonDocument.value.revision, checkpoint_digest: commonDocument.digest },
    }));
    const localDocument = successor("succeeded");
    const remoteDocument = successor("failed");
    const common = { revision: parseSafeInteger(commonDocument.value.revision), checkpoint_digest: commonDocument.digest };
    const local = { revision: parseSafeInteger(localDocument.value.revision), checkpoint_digest: localDocument.digest };
    const remote = { revision: parseSafeInteger(remoteDocument.value.revision), checkpoint_digest: remoteDocument.digest };
    const observed = await observeDivergentHeads({ runner: discovered.value }, authority.value, {
      local_chain: [commonDocument, localDocument], upstream_chain: [commonDocument, remoteDocument], common,
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.value.preserved_heads.map((head) => head.head_oid)).toEqual([localHead, upstreamHead]);

    git(clone, "reset", "--hard", "-q", "origin/main");
    const state: TaskStateV1 = {
      schema_version: "1", task_id: TASK, repository_identity_digest: authority.value.repository_identity_digest,
      revision: parseSafeInteger(8), phase_instance: PHASE, step: "produce", status: "running", attempt: parseSafeInteger(1),
      input_fingerprint: D("2"), initialization_digest: D("3"), config_digest: D("4"), workflow_digest: D("5"), constitution_digest: D("6"),
      policy_base_commit: upstreamHead, authoritative_results: [], approvals: [], waivers: [], adopted_checkpoint: remote,
    };
    const planned = await planCleanHandoff({ runner: discovered.value }, authority.value, canonicalDocument(state), observed.value, upstreamHead);
    expect(planned.ok).toBe(true);
    if (planned.ok) expect(planned.value.value).toMatchObject({ selected_successor_head: upstreamHead, clean_handoff: { head_oid: upstreamHead, authoritative_checkpoint: remote } });
    if (!planned.ok) return;

    mkdirSync(join(authority.value.task_root, "maintenance"));
    const target = await resolveTaskPath({
      runner: discovered.value,
      taskId: TASK,
      claim: parseTaskPathClaim("maintenance/handoff-record.json"),
      expectedClass: "maintenance-record",
      context,
    });
    if (!target.ok) throw new Error(`handoff target failed: ${target.error.code}`);
    const atomic = createAtomicWriter();
    await expect(installHandoffRecord(atomic, target.value, planned.value)).resolves.toBe("created");
    await expect(installHandoffRecord(atomic, target.value, planned.value)).resolves.toBe("exists");
    await expect(installHandoffRecord(atomic, authority.value.state, planned.value)).rejects.toThrow(/maintenance-record/u);

    const forged = { ...observed.value } as typeof observed.value;
    const forgedPlan = await planCleanHandoff({ runner: discovered.value }, authority.value, canonicalDocument(state), forged, upstreamHead);
    expect(forgedPlan.ok ? undefined : forgedPlan.error.diagnostic.parameters).toMatchObject({ issue_code: "handoff-preservation-not-authentic" });

    const falseHigher = canonicalDocument(parseManualCheckpoint({
      ...localDocument.value,
      revision: parseSafeInteger(common.revision + 2),
      predecessor: common,
    } as ManualCheckpointV1));
    git(clone, "reset", "--hard", "-q", localHead);
    const invalidChain = await observeDivergentHeads({ runner: discovered.value }, authority.value, {
      local_chain: [commonDocument, falseHigher], upstream_chain: [commonDocument, remoteDocument], common,
    });
    expect(invalidChain.ok ? undefined : invalidChain.error.diagnostic.parameters).toMatchObject({ issue_code: "handoff-checkpoint-chain-invalid" });
  });
});
