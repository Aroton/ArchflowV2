import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { buildDocumentArtifact } from "../../src/state/document-artifact.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { prepareDocumentResult } from "../../src/mcp/handlers/state-results.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

const TASK = parseTaskSlug("handler-counter-replay");
// The PRD phase has no upstream-pinning prerequisites, keeping this fixture about replay alone.
const PHASE = encodePhaseInstance({ kind: "prd" });
const ARTIFACT = "prd.md";
const ARTIFACT_BYTES = new TextEncoder().encode("# PRD\n\nRequirements.\n");
const RUBRIC = {
  schema_version: "1",
  kind: "artifact",
  mode: "adversarial",
  criteria: [{ id: "correctness", text: "The artifact satisfies its stated requirements.", blocking: true }],
} as const;
const CONFIG = `schema_version: "1"
roles:
  counter-reviewer:
    model: gpt-fixture
    effort: high
  adjudicator:
    model: gpt-fixture
    effort: high
`;
const scanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1", outcome: "clean", detector_set_id: "counter-replay-scanner" as never,
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

afterAll(cleanupTemporaryRepositories);

async function fixture() {
  const repository = createTempRepository({ label: "handler-counter-replay" });
  const workflow = readFileSync(new URL("../../assets/workflow.yaml", import.meta.url));
  repository.write(".archflow/workflow.yaml", workflow);
  // One active rule (no enforcement declarations), so the merged call runs BOTH child
  // dispatches — rubric review then sealed constitution review — and replay identity must hold
  // over the full evaluated success.
  repository.write(".archflow/constitution/00-process.md", `---
id: process
version: 1
status: active
---
Preserve explicit human review gates.
`);
  repository.write(`.archflow/tasks/${TASK}/config.yaml`, CONFIG);
  repository.write(`.archflow/tasks/${TASK}/${ARTIFACT}`, Buffer.from(ARTIFACT_BYTES));
  repository.write("tracked.txt", "base\n");
  repository.commitAll("counter-review fixture");

  const context = {
    task_id: TASK,
    phase_instance: PHASE,
    operation: parseSafeCode("handler-counter-fixture"),
    attempt: parseSafeInteger(1),
  } as const;
  const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), context);
  if (!discovered.ok) throw new Error(discovered.error.code);
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error(environment.error.code);
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: TASK,
    context,
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const policyBaseCommit = parseGitOid(repository.git("rev-parse", "HEAD"));
  const constitution = await resolvePinnedConstitution(discovered.value, policyBaseCommit, context);
  if (!constitution.ok) throw new Error(constitution.error.code);
  const configDigest = sha256Bytes(new TextEncoder().encode(CONFIG));
  const workflowDigest = sha256Bytes(workflow);
  const fingerprint = computeInputFingerprint({
    schema_version: "1",
    workflow_digest: workflowDigest,
    config_digest: configDigest,
    constitution_digest: constitution.value.digest,
    artifact_identities: [],
    upstream_identities: [],
    rubric_digest: canonicalJsonDigest({}),
    phase_instance: PHASE,
    declared_inputs: [],
  });
  const produceArtifact = await buildDocumentArtifact(discovered.value, authority.value, {
    phase_instance: PHASE, step: "produce", document_path: parseTaskPathClaim(ARTIFACT),
    declared_inputs: [], input_fingerprint: fingerprint,
  });
  if (!produceArtifact.ok) throw new Error(produceArtifact.error.code);
  const preparedProduce = await prepareDocumentResult({
    services: { authority: authority.value, runner: discovered.value } as Parameters<typeof prepareDocumentResult>[0]["services"],
    artifact: produceArtifact.value, result_id: "produce-result" as never,
    retained_task_bytes: parseSafeInteger(0), measured_at_revision: parseSafeInteger(6), scanner,
  });
  if (!preparedProduce.ok) throw new Error(preparedProduce.error.code);
  await ensureResultDirectory(authority.value, preparedProduce.value.reference.result_digest);
  for (const payload of preparedProduce.value.prepared.payloads) {
    await ensurePayloadParent(authority.value, preparedProduce.value.reference.result_digest, payload.target.absolute);
  }
  const installedProduce = await installSnapshot(
    createAtomicWriter(), preparedProduce.value.prepared, preparedProduce.value.manifest_target,
    discovered.value.location.worktreeRoot as never,
  );
  if (!installedProduce.ok) throw new Error(installedProduce.error.code);
  const state: TaskStateV1 = {
    schema_version: "1",
    task_id: TASK,
    repository_identity_digest: authority.value.repository_identity_digest,
    revision: parseSafeInteger(7),
    phase_instance: PHASE,
    step: "counter_review",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: fingerprint,
    initialization_digest: canonicalJsonDigest({ fixture: "counter-handler" }),
    config_digest: configDigest,
    workflow_digest: workflowDigest,
    constitution_digest: constitution.value.digest,
    policy_base_commit: policyBaseCommit,
    authoritative_results: [preparedProduce.value.reference],
    approvals: [],
    waivers: [],
  };
  const initialState = canonicalDocument(state).bytes;
  writeFileSync(authority.value.state.absolute, initialState);
  mkdirSync(join(authority.value.task_root, "reviews"), { recursive: true });

  const bin = join(repository.root, "bin");
  const sourceHome = join(repository.root, "source-home");
  const countPath = join(repository.root, "model-calls.txt");
  mkdirSync(join(sourceHome, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(sourceHome, ".codex", "auth.json"), "{}\n");
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const subject = envelope.subject;
  const output = subject.role === "counter-review" ? {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
    input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
    producer_family: subject.producer_family, findings: [], matched_rule_versions: [],
    verdict: "pass", blocking_count: 0
  } : {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "adjudicate", subject_digest: subject.subject_digest,
    input_fingerprint: subject.input_fingerprint,
    pinned_constitution_digest: subject.pinned_constitution_digest,
    approved_upstream_digests: subject.approved_upstream_digests,
    source_evidence_set_digest: subject.source_evidence_set_digest,
    rule_findings: envelope.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version,
      compliance: "pass", rationale: "Checked the sealed envelope.",
      trigger: "not-matched", trigger_evidence: "No review trigger matched." })),
    drift_findings: subject.approved_upstream_digests.map((upstream_digest) => ({
      upstream_digest, drift: "aligned", affected_claim_ids: [], rationale: "No upstream drift found." })),
    constitution: "pass", drift: "aligned", matched_rule_versions: [], uncertain_rule_versions: []
  };
  await appendFile(${JSON.stringify(countPath)}, "call\\n");
  await writeFile(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}
`);
  chmodSync(executable, 0o755);

  const connection = connectionContextFactory.captureStartup({
    connection_id: "handler-counter-replay-connection",
    startup_repository_candidate: { working_directory: repository.path },
  }).initialize({
    client: { name: "claude-code", version: "2.1.220" },
    host: "claude",
    protocol_version: "2025-11-25",
  });
  const invocation = (id: string) => createInvocationContext(connection, {
    invocation_id: id,
    transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
  }, new AbortController().signal);
  const args = {
    schema_version: "1",
    task_id: TASK,
    intent_id: "counter-replay-intent",
    expected_revision: 7,
    input_fingerprint: fingerprint,
    artifact_path: ARTIFACT,
    rubric: RUBRIC,
  } as const;
  return { args, authority: authority.value, bin, sourceHome, countPath, initialState, invocation };
}

function callCount(path: string): number {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe("counter-review handler replay integration", () => {
  it("does not launch a second child for exact replay or receipt-only recovery", async () => {
    const h = await fixture();
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${h.bin}${delimiter}${saved.PATH ?? dirname(process.execPath)}`;
    process.env.HOME = h.sourceHome;
    try {
      const boundary = createToolBoundary(createToolHandlers());
      const first = await boundary.invoke("archflow_counter_review", h.args, h.invocation("counter-first"));
      // The one call ran both children and reports the evaluated constitution outcome inline.
      expect(first, JSON.stringify(first)).toMatchObject({
        kind: "project-result",
        result: { schema_version: "1", ok: true, value: {
          verdict: "pass",
          blocking_count: 0,
          constitution: {
            status: "evaluated",
            constitution: "pass",
            drift: "aligned",
            triggers: [],
          },
          revision: 8,
        } },
      });
      expect(callCount(h.countPath)).toBe(2);
      // Both evidence results were installed by the one transaction: durable state moved a
      // single revision and now retains the counter_review AND adjudicate references together.
      const committed = JSON.parse(readFileSync(h.authority.state.absolute, "utf8")) as {
        revision: number;
        authoritative_results: readonly { step: string; input_fingerprint: string }[];
      };
      expect(committed.revision).toBe(8);
      expect(committed.authoritative_results
        .filter((reference) => reference.input_fingerprint === h.args.input_fingerprint &&
          reference.step !== "produce")
        .map((reference) => reference.step)
        .sort()).toEqual(["adjudicate", "counter_review"]);

      const replay = await boundary.invoke(
        "archflow_counter_review",
        { ...h.args, expected_revision: 8 },
        h.invocation("counter-replay"),
      );
      expect(replay).toEqual(first);
      expect(callCount(h.countPath)).toBe(2);

      // Model the receipt-created/state-not-replaced crash cut. The retained results and receipt
      // remain authoritative; recovery must reinstall BOTH prepared results — the review and the
      // constitution evidence — without redispatching either child.
      writeFileSync(h.authority.state.absolute, h.initialState);
      const recovered = await boundary.invoke(
        "archflow_counter_review",
        h.args,
        h.invocation("counter-receipt-only"),
      );
      expect(recovered).toEqual(first);
      expect(callCount(h.countPath)).toBe(2);
      const recoveredState = JSON.parse(readFileSync(h.authority.state.absolute, "utf8")) as {
        revision: number;
        authoritative_results: readonly { step: string }[];
      };
      expect(recoveredState.revision).toBe(8);
      expect(recoveredState.authoritative_results.map((reference) => reference.step).sort())
        .toEqual(["adjudicate", "counter_review", "produce"]);
    } finally {
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    }
  });
});
