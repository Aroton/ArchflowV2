/**
 * Post-triage re-entry treats the authorized artifact edit as expected: after a human accepts a
 * finding whose revision intent authorizes editing the produce document, status must route to
 * the produce re-entry with its normal next action instead of dead-ending on the
 * projection-mismatch the edit necessarily causes. Every other drifted path — and the same edit
 * outside re-entry — keeps blocking on the projection mismatch, now routed to the human
 * baseline-adoption decision instead of a dead end.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeCode, parseTaskSlug } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { computeCallEnvelope, type CallEnvelope } from "../../src/local/call-envelope.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import type { ToolName } from "../../src/contracts/tool-names.js";
import { handleCounterReview } from "../../src/mcp/handlers/counter-review.js";
import { handleState } from "../../src/mcp/handlers/state.js";
import { createProductionServices } from "../../src/state/production.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { computeTaskStatus, type TaskStatusV1 } from "../../src/state/status.js";
import type { ApplySubmissionV1, SemanticResultV1, WorkflowInvocationV1, WorkflowViewV1 } from "../../src/contracts/semantic-workflow.js";
import { installSemanticReviewStub, semanticJourneyHarness, type SemanticJourneyHarness } from "../helpers/semantic-journeys.js";

const TIMEOUT = 60_000;
const task = parseTaskSlug("reentry-task");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const restorers: (() => void)[] = [];
afterEach(() => { for (const restore of restorers.splice(0)) restore(); });

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "archflow-reentry-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  // The resumed PRD approval gate must still open: document-gate opening is rule-driven, so the
  // fixture lists the prd subject explicitly in the config the task copies at creation. The whole
  // file is written rather than appended because the shipped template already carries its own
  // `approval_rules` block and a second one would be a duplicate YAML key.
  writeFileSync(join(root, ".archflow", "config.yaml"), `schema_version: "1"
roles:
  counter-reviewer:
    model: gpt-5.6-sol
    effort: xhigh
  adjudicator:
    model: gpt-5.6-sol
    effort: xhigh
approval_rules:
  subjects: [prd]
  content: []
`);
  // Same fixture constitution as the roundtrip suite — deliberately no active rules, so the
  // merged archflow_counter_review call runs a single dispatch, reports the constitution review
  // as not-run, and this suite stays about re-entry edit tolerance.
  for (const name of readdirSync(join(root, ".archflow", "constitution"))) {
    if (name.endsWith(".md") && name !== "README.md") rmSync(join(root, ".archflow", "constitution", name));
  }
  writeFileSync(join(root, ".archflow", "constitution", "20-data.md"), `---
id: task-and-evidence-isolation
version: 1
status: deprecated
review_trigger: A task reads or mutates another task's files.
---
Tasks are isolated from one another.
`);
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, initialization: staged.value };
}

function harness(root: string) {
  // The default config routes the counter-reviewer to the codex family, so the producing
  // connection must be the claude host for the opposite-family invariant to hold.
  const connection = connectionContextFactory.captureStartup({
    connection_id: "connection-reentry",
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: { name: "claude-code", version: "2.1.220" },
    host: "claude",
    protocol_version: "2025-11-25",
  });
  let sequence = 0;

  async function services() {
    const created = await createProductionServices({
      working_directory: root, task_id: task, operation: parseSafeCode("reentry-test"),
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  }

  return {
    async status(): Promise<TaskStatusV1> {
      const s = await services();
      // Status writes nothing, so it must never reload a full retained installation: that re-reads
      // every payload and re-runs the secret scan to rebuild a projection plan status never looks
      // at. The recorded `secret_scan` verdict on the manifest is the authority on a read path.
      const status = await computeTaskStatus({
        ...s.dependencies,
        load_retained_result: () => {
          throw new Error("status derivation must not load a full retained result");
        },
      }, s.authority);
      if (!status.ok) throw new Error(status.error.code);
      return status.value;
    },
    async envelope(request: PlainJsonValue): Promise<CallEnvelope> {
      const resolved = await computeCallEnvelope(await services(), request);
      if (!resolved.ok) throw new Error(resolved.error.code);
      return resolved.value;
    },
    async compose(value: PlainJsonValue): Promise<CallEnvelope> {
      const composed = await composeRequest(await services(), value);
      if (!composed.ok) throw new Error(composed.error.code);
      return composed.value.envelope;
    },
    /**
     * Executes one composed request through the retained internal handlers — the same services
     * the semantic handler drives. The durable gate/waiver names have no direct handler anymore
     * (their flows are semantic); this harness only ever receives state and counter-review
     * compositions, and refuses loudly if that ever changes. Like invoke, but returns the raw
     * result so refusal tests can assert the exact error.
     */
    async invokeRaw(tool: ToolName, input: PlainJsonValue): Promise<{
      ok: boolean;
      error?: { code?: string; diagnostic?: { parameters?: Record<string, unknown> } };
    }> {
      sequence += 1;
      const context = createInvocationContext(connection, {
        invocation_id: `invocation-${sequence}`,
        transport_metadata: { request_id: `request-${sequence}`, operation: "tools/call" },
      }, new AbortController().signal);
      if (tool !== "archflow_state" && tool !== "archflow_counter_review") {
        throw new Error(`composed tool ${tool} has no retained direct handler`);
      }
      let call;
      try {
        call = parseToolCall(tool, structuredClone(input));
      } catch {
        // The tool-call parse is the contract boundary: an invalid input is a project
        // CONTRACT_INVALID failure before any handler runs.
        return { ok: false, error: { code: "CONTRACT_INVALID" } };
      }
      return tool === "archflow_counter_review"
        ? handleCounterReview(call as never, context) as never
        : handleState(call as never, context) as never;
    },
    async invoke(tool: ToolName, input: PlainJsonValue): Promise<PlainJsonValue> {
      const result = await this.invokeRaw(tool, input);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result as PlainJsonValue;
    },
  };
}

const DEFAULT_STUB_FINDINGS = [{
  finding_id: "requirement-untestable", severity: "minor", blocking: false,
  summary: "One requirement is not testable as written.", evidence: "prd.md line 3.",
  suggested_resolution: "State the observable behavior.",
}] as const;

function installReviewerStub(
  root: string,
  findings: readonly Record<string, unknown>[] = DEFAULT_STUB_FINDINGS,
): { restore: () => void } {
  const bin = join(root, "stub-bin");
  const stubHome = join(root, "stub-home");
  mkdirSync(join(stubHome, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const generatorScript = `
function generateOutput(envelope, findings) {
  const subject = envelope.subject;
  return {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
    input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
    producer_family: subject.producer_family,
    findings,
    matched_rule_versions: [],
    verdict: findings.some((finding) => finding.blocking === true) ? "fail" : "advisory",
    blocking_count: findings.filter((finding) => finding.blocking === true).length
  };
}
`;

  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
${generatorScript}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const output = generateOutput(envelope, ${JSON.stringify(findings)});
  await writeFile(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
  chmodSync(join(bin, "codex"), 0o755);

  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
${generatorScript}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("2.1.220 (Claude Code)\\n");
else if (argv[0] === "auth" && argv[1] === "status") process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const output = generateOutput(envelope, ${JSON.stringify(findings)});
  process.stdout.write(JSON.stringify({ structured_output: output }) + "\\n");
}`);
  chmodSync(join(bin, "claude"), 0o755);

  writeFileSync(join(bin, "agy"), `#!/usr/bin/env node
${generatorScript}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("agy 1.1.22\\n");
else if (argv[0] === "models") process.stdout.write("gemini-3.7-flash-high\\n");
else {
  // The envelope arrives as one stream-json user message on stdin, never on argv.
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const firstLine = Buffer.concat(chunks).toString("utf8").split("\\n").find((line) => line.trim() !== "");
  const message = JSON.parse(firstLine);
  const envelope = message.event === "user" ? JSON.parse(message.message.content) : message;
  const output = generateOutput(envelope, ${JSON.stringify(findings)});
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", structured_output: output } }) + "\\n");
}`);
  chmodSync(join(bin, "agy"), 0o755);
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.HOME = stubHome;
  return {
    restore() {
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    },
  };
}

async function applySemanticOk(
  h: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
  view: WorkflowViewV1,
  submission?: ApplySubmissionV1,
): Promise<WorkflowViewV1> {
  const result = await h.apply(invocation, view, submission);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("post-triage re-entry edits are expected", () => {
  it("suppresses only the authorized produce-document drift, and only during re-entry", async () => {
    const fixture = await repository();
    const h = harness(fixture.root);
    const prdPath = join(fixture.root, ".archflow", "tasks", task, "prd.md");
    const prdClaim = `.archflow/tasks/${task}/prd.md`;
    const rubric = {
      schema_version: "1", kind: "artifact", mode: "adversarial",
      criteria: [{ id: "scope", text: "Check scope against the ask.", blocking: true }],
    };

    // Drive the PRD phase to counter_review-succeeded with one counter-review finding.
    const created = await h.status();
    expect(created.next_action.code).toBe("create-task");
    const createComposed = await h.compose({ intent_id: "initialize-1", kind: "initialize" });
    await h.invoke("archflow_state", createComposed.request.input);
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the re-entry proof.\n");
    writeFileSync(prdPath, "# PRD\n\nRe-entry requirements.\n");
    const produceComposed = await h.compose({ intent_id: "produce-1" });
    await h.invoke(produceComposed.request.tool, produceComposed.request.input);
    const counterEntry = await h.compose({ intent_id: "counter-entry-1", kind: "running", step: "counter_review" });
    await h.invoke(counterEntry.request.tool, counterEntry.request.input);
    const counterComposed = await h.compose({ intent_id: "counter-1", kind: "counter-review" });
    const stub = installReviewerStub(fixture.root);
    try {
      await h.invoke(counterComposed.request.tool, counterComposed.request.input);

      // Control case: the same prd.md edit while NOT in re-entry (counter_review-succeeded,
      // nothing accepted yet) is unauthorized drift and must still block.
      const recordedPrd = readFileSync(prdPath);
      writeFileSync(prdPath, "# PRD\n\nPremature edit before any accepted finding.\n");
      const premature = await h.status();
      expect(premature.next_action).toMatchObject({
        code: "recover-milestone-authority",
        human_required: false,
      });
      expect(premature.reconciliation?.classification).toBe("reconciliation-required");
      expect(premature.reconciliation?.findings.map((finding) => finding.kind)).toContain("projection-mismatch");
      expect(premature.reconciliation?.expected_reentry_edits).toBeUndefined();
      expect(premature.blocking_reasons).toContain("projection-mismatch");
      writeFileSync(prdPath, recordedPrd);

      // Triage: the human accepts the counter-review finding with a revision intent — the
      // durable authorization to edit the produce document.
      const triageEntry = await h.compose({ intent_id: "triage-entry-1", kind: "running", step: "triage" });
      await h.invoke(triageEntry.request.tool, triageEntry.request.input);
      const triageComposed = await h.compose({
        intent_id: "triage-1", kind: "triage",
        dispositions: [{
          finding_id: "requirement-untestable", disposition: "accepted",
          rationale: "The requirement is indeed untestable as written.",
          revision_intent: "Restate the requirement as observable behavior in prd.md.",
        }],
      });
      await h.invoke(triageComposed.request.tool, triageComposed.request.input);

      // Re-entry, document still untouched: status already routes to the produce step.
      const beforeEdit = await h.status();
      expect(beforeEdit).toMatchObject({ step: "triage", status: "succeeded" });
      expect(beforeEdit.evidence?.assessment?.reentry_required).toBe(true);
      expect(beforeEdit.next_action).toMatchObject({ code: "run-step", step: "produce", human_required: false });
      expect(beforeEdit.reconciliation?.classification).toBe("consistent");

      // The authorized edit: revising prd.md must NOT dead-end. Status keeps the produce
      // re-entry action with its normal prefilled running-entry request, reports no
      // projection-mismatch, and names the suppressed path honestly.
      writeFileSync(prdPath, "# PRD\n\nRe-entry requirements, restated as observable behavior.\n");
      const afterEdit = await h.status();
      expect(afterEdit.next_action).toMatchObject({
        code: "run-step", step: "produce", human_required: false,
      });
      expect(afterEdit.reconciliation?.findings).toEqual([]);
      expect(afterEdit.reconciliation?.classification).toBe("consistent");
      expect(afterEdit.reconciliation?.expected_reentry_edits).toEqual([prdClaim]);
      expect(afterEdit.blocking_reasons).not.toContain("projection-mismatch");

      // Rendered reviews are disposable cache. Editing one never creates durable reconciliation
      // drift; it can be regenerated from the structured result authority.
      const counterReviewPath = join(fixture.root, ".archflow", "runtime", "tasks", task, "cache", "reviews", "prd.counter.md");
      const recordedCounterReview = readFileSync(counterReviewPath);
      writeFileSync(counterReviewPath, "tampered rendered review\n");
      const foreignDrift = await h.status();
      expect(foreignDrift.next_action).toMatchObject({
        code: "run-step", step: "produce", human_required: false,
      });
      expect(foreignDrift.reconciliation?.classification).toBe("consistent");
      expect(foreignDrift.reconciliation?.findings).toEqual([]);
      expect(foreignDrift.reconciliation?.expected_reentry_edits).toEqual([prdClaim]);
      expect(foreignDrift.blocking_reasons).not.toContain("projection-mismatch");
      writeFileSync(counterReviewPath, recordedCounterReview);

      // The composed running entry executes against the drifted document projection, and the
      // terminal produce then records the revised document.
      const reentryComposed = await h.compose({ intent_id: "produce-reentry-1", kind: "running", step: "produce" });
      await h.invoke("archflow_state", reentryComposed.request.input);
      const revisedComposed = await h.compose({ intent_id: "produce-reentry-2" });
      await h.invoke(revisedComposed.request.tool, revisedComposed.request.input);
      const revised = await h.status();
      expect(revised.subject_digest).toBe(revisedComposed.artifact_digest);
      expect(revised.subject_digest).not.toBe(produceComposed.artifact_digest);
      expect(revised.reconciliation?.classification).toBe("consistent");
      expect(revised.reconciliation?.expected_reentry_edits).toBeUndefined();
      expect(revised.next_action).toMatchObject({ code: "run-step", step: "counter_review" });

      // The adjudicate position is retired outright: no movement can target it, so stale
      // prior-cycle reviews cannot be laundered into a direct re-adjudication — the pipeline
      // still demands the fresh counter-review, and the state parser refuses the step name.
      await expect(h.compose({ intent_id: "adjudicate-entry-stale", kind: "running", step: "adjudicate" }))
        .rejects.toThrow(/TRANSITION_INVALID/u);
      const parseRefused = await h.invokeRaw("archflow_state", {
        schema_version: "1", task_id: task, intent_id: "adjudicate-direct", expected_revision: 0,
        input_fingerprint: "0".repeat(64), phase_instance: "prd", step: "adjudicate", status: "running",
      });
      expect(parseRefused.ok).toBe(false);
      expect(parseRefused.error?.code).toBe("CONTRACT_INVALID");
      expect(await h.status()).toMatchObject({ step: "produce", status: "succeeded" });
    } finally {
      stub.restore();
    }
  }, TIMEOUT);

  it("routes editorial-only acceptance through the evidence-preserving produce re-entry", async () => {
    const fixture = await repository();
    const h = harness(fixture.root);
    const prdPath = join(fixture.root, ".archflow", "tasks", task, "prd.md");
    const prdClaim = `.archflow/tasks/${task}/prd.md`;
    const rubric = {
      schema_version: "1", kind: "artifact", mode: "adversarial",
      criteria: [{ id: "scope", text: "Check scope against the ask.", blocking: true }],
    };

    // Drive the PRD phase to counter_review-succeeded with one blocking and one purely
    // editorial finding, so both the compose-time refusal and the editorial route are real.
    const created = await h.status();
    expect(created.next_action.code).toBe("create-task");
    const createComposed = await h.compose({ intent_id: "initialize-1", kind: "initialize" });
    await h.invoke("archflow_state", createComposed.request.input);
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the editorial proof.\n");
    const originalPrd = "# PRD\n\nEditorial requirements, teh original wording.\n";
    writeFileSync(prdPath, originalPrd);
    const produceComposed = await h.compose({ intent_id: "produce-1" });
    await h.invoke(produceComposed.request.tool, produceComposed.request.input);

    // The adjudicate entry no longer exists as a composable movement from any position: the
    // constitution review rides the counter-review call instead.
    await expect(h.compose({ intent_id: "adjudicate-entry-refused", kind: "running", step: "adjudicate" }))
      .rejects.toThrow(/TRANSITION_INVALID/u);
    expect(await h.status()).toMatchObject({ step: "produce", status: "succeeded", attempt: 1 });
    const counterEntry = await h.compose({ intent_id: "counter-entry-1", kind: "running", step: "counter_review" });
    await h.invoke(counterEntry.request.tool, counterEntry.request.input);
    const counterComposed = await h.compose({ intent_id: "counter-1", kind: "counter-review" });
    const stub = installReviewerStub(fixture.root, [
      {
        finding_id: "scope-mismatch", severity: "blocker", blocking: true,
        summary: "The stated scope contradicts the ask.", evidence: "prd.md scope section.",
        suggested_resolution: "Align the scope with the ask.",
      },
      {
        finding_id: "wording-typo", severity: "minor", blocking: false,
        summary: "A requirement sentence contains a typo.", evidence: "prd.md line 3: 'teh'.",
        suggested_resolution: "Fix the typo; no meaning change.",
      },
    ]);
    try {
      await h.invoke(counterComposed.request.tool, counterComposed.request.input);
      const triageEntry = await h.compose({ intent_id: "triage-entry-1", kind: "running", step: "triage" });
      await h.invoke(triageEntry.request.tool, triageEntry.request.input);

      // Compose-time refusal: an editorial acceptance of a blocking finding never composes.
      await expect(h.compose({
        intent_id: "triage-refused", kind: "triage",
        dispositions: [
          { finding_id: "scope-mismatch", disposition: "accepted-editorial", rationale: "Wording only.", revision_intent: "Reword the scope." },
          { finding_id: "wording-typo", disposition: "rejected", rationale: "Not a defect.", evidence: "Reads fine." },
        ],
      })).rejects.toThrow(/blocking/u);

      // The recorded triage: the blocker is rejected with evidence, the typo accepted as
      // purely editorial. accepted_count stays 0; only the editorial count is populated.
      const triageComposed = await h.compose({
        intent_id: "triage-1", kind: "triage",
        dispositions: [
          {
            finding_id: "scope-mismatch", disposition: "rejected",
            rationale: "The scope matches the recorded ask verbatim.",
            evidence: "ask.md and prd.md scope wording agree.",
          },
          {
            finding_id: "wording-typo", disposition: "accepted-editorial",
            rationale: "The typo changes wording, not meaning.",
            revision_intent: "Replace 'teh' with 'the' in the requirements sentence.",
          },
        ],
      });
      const composedTriage = (triageComposed.request.input as { artifact: { evidence: Record<string, unknown> } }).artifact.evidence;
      expect(composedTriage).toMatchObject({ accepted_count: 0, accepted_editorial_count: 1, rejected_count: 1 });
      await h.invoke(triageComposed.request.tool, triageComposed.request.input);

      // Editorial-only acceptance is not a re-entry: the attempt budget is untouched and the
      // next action is the produce step with the editorial wording, not a fresh review loop.
      const pending = await h.status();
      expect(pending).toMatchObject({ step: "triage", status: "succeeded", attempt: 1 });
      expect(pending.evidence?.assessment).toMatchObject({
        editorial_revision_required: true,
        reentry_required: false,
        exhausted: false,
        next: "produce",
      });
      expect(pending.next_action).toMatchObject({ code: "run-step", step: "produce", editorial_revision: true });
      expect(pending.next_action.detail).toMatch(/editorial/u);
      const predecessorDigest = pending.subject_digest;
      expect(predecessorDigest).toBe(produceComposed.artifact_digest);

      // The artifact edit is expected under the editorial flag exactly as under full re-entry.
      writeFileSync(prdPath, "# PRD\n\nEditorial requirements, the original wording.\n");
      const afterEdit = await h.status();
      expect(afterEdit.reconciliation?.classification).toBe("consistent");
      expect(afterEdit.reconciliation?.expected_reentry_edits).toEqual([prdClaim]);
      expect(afterEdit.next_action).toMatchObject({ code: "run-step", step: "produce" });
      writeFileSync(prdPath, originalPrd);

      // Enter the produce re-entry. The shared triage-succeeded -> produce-running movement
      // rule still increments the durable attempt; only the fixed point treats the editorial
      // pass as attempt-neutral (it never demands re-entry, so it can never exhaust).
      const produceEntry = await h.compose({ intent_id: "produce-editorial-entry", kind: "running", step: "produce" });
      await h.invoke(produceEntry.request.tool, produceEntry.request.input);

      // Degenerate self-link: recording without changing any byte is refused.
      const degenerate = await h.compose({ intent_id: "produce-editorial-degenerate" });
      const degenerateArtifact = (degenerate.request.input as {
        artifact: { editorial_predecessor?: Record<string, string> };
      }).artifact;
      expect(degenerateArtifact.editorial_predecessor).toMatchObject({ subject_digest: predecessorDigest });
      const unchanged = await h.invokeRaw(degenerate.request.tool, degenerate.request.input);
      expect(unchanged.ok).toBe(false);
      expect(unchanged.error?.diagnostic?.parameters).toMatchObject({ issue_code: "editorial-revision-unchanged-bytes" });

      // A predecessor digest that is not the retained produce result is refused.
      const wrongPredecessor = structuredClone(degenerate.request.input) as {
        intent_id: string; artifact: { editorial_predecessor: Record<string, string> };
      } & Record<string, PlainJsonValue>;
      wrongPredecessor.intent_id = "produce-editorial-wrong-predecessor";
      wrongPredecessor.artifact.editorial_predecessor.subject_digest = "f".repeat(64);
      const wrongPredecessorResolved = await h.envelope({
        tool: "archflow_state", input: wrongPredecessor,
      } as unknown as PlainJsonValue);
      const wrongPredecessorResult = await h.invokeRaw(wrongPredecessorResolved.request.tool, wrongPredecessorResolved.request.input);
      expect(wrongPredecessorResult.ok).toBe(false);
      expect(wrongPredecessorResult.error?.diagnostic?.parameters).toMatchObject({ issue_code: "editorial-predecessor-not-current-produce" });

      // A triage result digest that is not the retained authorizing triage is refused.
      const wrongTriage = structuredClone(degenerate.request.input) as {
        intent_id: string; artifact: { editorial_predecessor: Record<string, string> };
      } & Record<string, PlainJsonValue>;
      wrongTriage.intent_id = "produce-editorial-wrong-triage";
      wrongTriage.artifact.editorial_predecessor.triage_result_digest = "e".repeat(64);
      const wrongTriageResolved = await h.envelope({
        tool: "archflow_state", input: wrongTriage,
      } as unknown as PlainJsonValue);
      const wrongTriageResult = await h.invokeRaw(wrongTriageResolved.request.tool, wrongTriageResolved.request.input);
      expect(wrongTriageResult.ok).toBe(false);
      expect(wrongTriageResult.error?.diagnostic?.parameters).toMatchObject({ issue_code: "editorial-authorizing-triage-invalid" });

      // The genuine editorial revision: apply exactly the revision intent and record produce.
      // The composer attaches the predecessor link from durable authority.
      writeFileSync(prdPath, "# PRD\n\nEditorial requirements, the original wording.\n");
      const revisedComposed = await h.compose({ intent_id: "produce-editorial-2" });
      expect((revisedComposed.request.input as {
        artifact: { editorial_predecessor?: Record<string, string> };
      }).artifact.editorial_predecessor).toMatchObject({ subject_digest: predecessorDigest });
      await h.invoke(revisedComposed.request.tool, revisedComposed.request.input);

      // After the editorial produce: the reviews and triage stay current for exactly this one
      // hop, nothing is re-run — with no active constitution rules the loop closes at "advance"
      // immediately — and status surfaces the editorial block the gate presenter needs, with the
      // review-set subject still naming the predecessor bytes the reviews actually evaluated.
      const revised = await h.status();
      expect(revised.subject_digest).toBe(revisedComposed.artifact_digest);
      expect(revised.subject_digest).not.toBe(predecessorDigest);
      expect(revised.evidence?.available).toBe(true);
      expect(revised.evidence?.available === true && revised.evidence.subject_digest).toBe(predecessorDigest);
      expect(revised.evidence?.assessment).toMatchObject({
        current: ["counter_review", "triage"],
        stale: [],
        reentry_required: false,
        editorial_revision_required: false,
        next: "advance",
      });
      expect(revised.next_action).toMatchObject({ code: "open-gate", gate_kind: "artifact-approval" });
      expect(revised.editorial_revision).toMatchObject({
        predecessor_subject_digest: predecessorDigest,
        dispositions: [{
          finding_id: "wording-typo",
          revision_intent: "Replace 'teh' with 'the' in the requirements sentence.",
        }],
      });
      expect(revised.reconciliation?.classification).toBe("consistent");
    } finally {
      stub.restore();
    }
  }, TIMEOUT);

  it("recovers post-review governing drift through fresh production and review", async () => {
    const fixture = await repository();
    const prdPath = join(fixture.root, ".archflow", "tasks", task, "prd.md");
    const recordedPrd = "# PRD\n\nBaseline requirements.\n";
    const mergedPrd = "# PRD\n\nBaseline requirements, plus merged changes from main.\n";
    const prd = { skill: "archflow-prd", intent: "resume" } as const;
    const h = semanticJourneyHarness({ root: fixture.root, taskId: task } as never);
    restorers.push(installSemanticReviewStub(fixture.root, [[], []]));

    // Create the task and drive the PRD through produce and a clean (empty-findings) review, so
    // the recorded projection exists and later drift is strict — exactly like a design phase
    // blocked after a merge from main.
    let view = await h.status(prd);
    expect(view.next_action.kind).toBe("initialize-task");
    view = await applySemanticOk(h, prd, view, { kind: "task-ask", text: "Build the baseline proof." });
    expect(view.next_action.kind).toBe("submit-work");
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the baseline proof.\n");
    writeFileSync(prdPath, recordedPrd);
    view = await applySemanticOk(h, prd, view, { kind: "work-result", outcome: "succeeded" });
    // The review action settles its own deterministic empty triage and lands at the approval gate.
    view = await applySemanticOk(h, prd, view);
    expect(view.next_action.kind).toBe("decide");
    expect(view.next_action.expected_submission).toBe("gate-summary");

    // The drift changes the current position's governing document after review. It cannot be
    // adopted as reviewed bytes: the server must retire the stale result/review authority and
    // start a fresh significant production boundary without changing repository bytes.
    writeFileSync(prdPath, mergedPrd);
    view = await h.status(prd);
    expect(view.next_action.kind).toBe("recover-milestone-authority");
    expect(view.next_action.expected_submission).toBe("none");
    view = await applySemanticOk(h, prd, view);
    expect(view.next_action.kind).toBe("submit-work");
    expect(readFileSync(prdPath, "utf8")).toBe(mergedPrd);
    view = await applySemanticOk(h, prd, view, { kind: "work-result", outcome: "succeeded" });
    expect(view.next_action.kind).toBe("review");
    view = await applySemanticOk(h, prd, view);
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
  }, TIMEOUT);

  it("keeps an executable offer after a committed governing-document deletion", async () => {
    const fixture = await repository();
    const prdPath = join(fixture.root, ".archflow", "tasks", task, "prd.md");
    const prd = { skill: "archflow-prd", intent: "resume" } as const;
    const h = semanticJourneyHarness({ root: fixture.root, taskId: task } as never);
    restorers.push(installSemanticReviewStub(fixture.root, [[]]));

    // Create the task and drive the PRD through produce and a clean review, so a recorded
    // projection exists and later drift is strict.
    let view = await h.status(prd);
    expect(view.next_action.kind).toBe("initialize-task");
    view = await applySemanticOk(h, prd, view, { kind: "task-ask", text: "Build the deletion proof." });
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the deletion proof.\n");
    writeFileSync(prdPath, "# PRD\n\nBaseline requirements.\n");
    view = await applySemanticOk(h, prd, view, { kind: "work-result", outcome: "succeeded" });
    view = await applySemanticOk(h, prd, view);

    // Recover once so the merged governing bytes become a fresh produced subject rather than an
    // adopted reviewed baseline. Leave that fresh result before review so no human gate masks the
    // committed-deletion reconciliation below.
    writeFileSync(prdPath, "# PRD\n\nBaseline requirements, merged.\n");
    view = await h.status(prd);
    expect(view.next_action.kind).toBe("recover-milestone-authority");
    view = await applySemanticOk(h, prd, view);
    view = await applySemanticOk(h, prd, view, { kind: "work-result", outcome: "succeeded" });

    // Commit the task document, then delete it with another commit. The deletion is now
    // committed reality. A governing document still cannot enter baseline adoption: status must
    // return an executable same-owner recovery offer instead of a dead-end inspection.
    git(fixture.root, "add", "--", `.archflow/tasks/${task}`);
    git(fixture.root, "commit", "-q", "-m", "task documents");
    rmSync(prdPath);
    git(fixture.root, "add", "--", `.archflow/tasks/${task}`);
    git(fixture.root, "commit", "-q", "-m", "remove the PRD");
    view = await h.status(prd);
    expect(view.next_action.kind).not.toBe("inspect");
    expect(view.next_action.expected_submission).toBe("none");
    expect(view.next_action.offer).toBeDefined();
  }, TIMEOUT);

  it("admits the author-initiated produce re-entry door from counter_review-succeeded", async () => {
    const fixture = await repository();
    const h = harness(fixture.root);
    const prdPath = join(fixture.root, ".archflow", "tasks", task, "prd.md");
    const prdClaim = `.archflow/tasks/${task}/prd.md`;
    const rubric = {
      schema_version: "1", kind: "artifact", mode: "adversarial",
      criteria: [{ id: "scope", text: "Check scope against the ask.", blocking: true }],
    };

    const created = await h.status();
    expect(created.next_action.code).toBe("create-task");
    const createComposed = await h.compose({ intent_id: "initialize-1", kind: "initialize" });
    await h.invoke("archflow_state", createComposed.request.input);
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the door proof.\n");
    writeFileSync(prdPath, "# PRD\n\nDoor requirements.\n");
    const produceComposed = await h.compose({ intent_id: "produce-1" });
    await h.invoke(produceComposed.request.tool, produceComposed.request.input);
    const counterEntry = await h.compose({ intent_id: "counter-entry-1", kind: "running", step: "counter_review" });
    await h.invoke(counterEntry.request.tool, counterEntry.request.input);
    const counterComposed = await h.compose({ intent_id: "counter-1", kind: "counter-review" });
    const stub = installReviewerStub(fixture.root);
    try {
      await h.invoke(counterComposed.request.tool, counterComposed.request.input);

      // New information arrives at counter_review-succeeded, with no accepted finding anywhere.
      // The sanctioned door: record the produce running entry FIRST — the composer derives it
      // from the server's own movement rule — and only then edit the artifact.
      const door = await h.compose({ intent_id: "produce-door-entry", kind: "running", step: "produce" });
      expect(door.request.input).toMatchObject({ step: "produce", status: "running" });
      await h.invoke(door.request.tool, door.request.input);
      const entered = await h.status();
      expect(entered).toMatchObject({ step: "produce", status: "running", attempt: 2 });
      expect(entered.next_action).toMatchObject({
        code: "run-step", step: "produce", human_required: false,
        detail: "Record the terminal produce result.",
      });
      expect(entered.reconciliation?.classification).toBe("consistent");

      // The revision under the recorded running entry is an expected re-entry edit: no drift
      // finding, no dead end, and the suppressed path is named honestly.
      writeFileSync(prdPath, "# PRD\n\nDoor requirements, restated after the upstream change.\n");
      const afterEdit = await h.status();
      expect(afterEdit.reconciliation?.findings).toEqual([]);
      expect(afterEdit.reconciliation?.classification).toBe("consistent");
      expect(afterEdit.reconciliation?.expected_reentry_edits).toEqual([prdClaim]);
      expect(afterEdit.blocking_reasons).not.toContain("projection-mismatch");
      expect(afterEdit.next_action).toMatchObject({ code: "run-step", step: "produce" });

      // The terminal produce records the new bytes; downstream evidence goes stale exactly as
      // an accepted re-entry, and the loop re-runs from counter_review.
      const revisedComposed = await h.compose({ intent_id: "produce-door-2" });
      await h.invoke(revisedComposed.request.tool, revisedComposed.request.input);
      const revised = await h.status();
      expect(revised.subject_digest).toBe(revisedComposed.artifact_digest);
      expect(revised.subject_digest).not.toBe(produceComposed.artifact_digest);
      expect(revised.reconciliation?.classification).toBe("consistent");
      expect(revised.reconciliation?.expected_reentry_edits).toBeUndefined();
      expect(revised.evidence?.assessment).toMatchObject({ next: "counter_review", stale: ["counter_review"] });
      expect(revised.next_action).toMatchObject({ code: "run-step", step: "counter_review" });

      const counterEntry2 = await h.compose({ intent_id: "counter-entry-2", kind: "running", step: "counter_review" });
      await h.invoke(counterEntry2.request.tool, counterEntry2.request.input);
      const counterComposed2 = await h.compose({ intent_id: "counter-2", kind: "counter-review" });
      await h.invoke(counterComposed2.request.tool, counterComposed2.request.input);
      const triageEntry = await h.compose({ intent_id: "triage-entry-1", kind: "running", step: "triage" });
      await h.invoke(triageEntry.request.tool, triageEntry.request.input);
      const triageComposed = await h.compose({
        intent_id: "triage-1", kind: "triage",
        dispositions: [{
          finding_id: "requirement-untestable", disposition: "rejected",
          rationale: "The restated requirement names observable behavior.",
          evidence: "prd.md restated requirement.",
        }],
      });
      await h.invoke(triageComposed.request.tool, triageComposed.request.input);
      // The completed triage alone closes the loop: no adjudicate position follows it.
      const closed = await h.status();
      expect(closed.evidence?.assessment).toMatchObject({ next: "advance" });
      expect(closed.next_action).toMatchObject({ code: "open-gate", gate_kind: "artifact-approval" });
    } finally {
      stub.restore();
    }
  }, TIMEOUT);
  it("re-records the work result when the reviewed document changed under a pending review", async () => {
    // The wedge this covers: a document the recorded work result covers is edited after the
    // result was recorded but before the review has run. The review re-reads that document and
    // refuses to review bytes the result never recorded, so the position has no forward edge —
    // and the human baseline decision cannot supply one, because adopting the bytes re-baselines
    // the *path* while the recorded result stays pinned to what it recorded.
    const fixture = await repository();
    const h = harness(fixture.root);
    const prdPath = join(fixture.root, ".archflow", "tasks", task, "prd.md");
    const prdClaim = `.archflow/tasks/${task}/prd.md`;

    const created = await h.status();
    expect(created.next_action.code).toBe("create-task");
    const createComposed = await h.compose({ intent_id: "initialize-1", kind: "initialize" });
    await h.invoke("archflow_state", createComposed.request.input);
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the drift proof.\n");
    writeFileSync(prdPath, "# PRD\n\nRecorded requirements.\n");
    const produceComposed = await h.compose({ intent_id: "produce-1" });
    await h.invoke(produceComposed.request.tool, produceComposed.request.input);

    // Enter the review, then let the document change under it.
    const counterEntry = await h.compose({ intent_id: "counter-entry-1", kind: "running", step: "counter_review" });
    await h.invoke(counterEntry.request.tool, counterEntry.request.input);
    expect(await h.status()).toMatchObject({ step: "counter_review", status: "running", attempt: 1 });
    writeFileSync(prdPath, "# PRD\n\nRecorded requirements, plus a late note.\n");

    const stub = installReviewerStub(fixture.root);
    try {
      // The dispatch genuinely cannot run: this is the failure the position used to be stuck on.
      const counterComposed = await h.compose({ intent_id: "counter-1", kind: "counter-review" });
      const refused = await h.invokeRaw(counterComposed.request.tool, counterComposed.request.input);
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("STATE_INVALID");

      // Status names the file and offers the one move that clears it, instead of a human
      // baseline decision that could only spend a choice and leave the review just as stuck.
      const stuck = await h.status();
      expect(stuck.next_action).toMatchObject({ code: "run-step", step: "produce", human_required: false });
      expect(stuck.next_action.detail).toContain(prdClaim);
      expect(stuck.next_action.gate_kind).toBeUndefined();

      // And the move is actually available from a review that is still running: the produce
      // window re-opens at attempt + 1, and the terminal produce records the current bytes.
      const reentryComposed = await h.compose({ intent_id: "produce-reentry-1", kind: "running", step: "produce" });
      await h.invoke(reentryComposed.request.tool, reentryComposed.request.input);
      expect(await h.status()).toMatchObject({ step: "produce", status: "running", attempt: 2 });
      const rerecorded = await h.compose({ intent_id: "produce-reentry-2" });
      await h.invoke(rerecorded.request.tool, rerecorded.request.input);

      const recovered = await h.status();
      expect(recovered.subject_digest).toBe(rerecorded.artifact_digest);
      expect(recovered.subject_digest).not.toBe(produceComposed.artifact_digest);
      expect(recovered.reconciliation?.classification).toBe("consistent");
      expect(recovered.next_action).toMatchObject({ code: "run-step", step: "counter_review" });

      // The review now dispatches over the bytes that are really there.
      const counterEntry2 = await h.compose({ intent_id: "counter-entry-2", kind: "running", step: "counter_review" });
      await h.invoke(counterEntry2.request.tool, counterEntry2.request.input);
      const counterComposed2 = await h.compose({ intent_id: "counter-2", kind: "counter-review" });
      await h.invoke(counterComposed2.request.tool, counterComposed2.request.input);
      expect(await h.status()).toMatchObject({ step: "counter_review", status: "succeeded" });
    } finally {
      stub.restore();
    }
  }, TIMEOUT);
});
