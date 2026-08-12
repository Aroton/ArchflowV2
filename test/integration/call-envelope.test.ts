import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { parseGateRequest } from "../../src/contracts/durable-gate.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest, computeGateId } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { LOCAL_COMMANDS } from "../../src/local/commands.js";
import { computeCallEnvelope, renderGateCounterPrompt } from "../../src/local/call-envelope.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { createProductionServices } from "../../src/state/production.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const task = parseTaskSlug("call-envelope");
const D = (character: string) => parseSha256Digest(character.repeat(64));

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "archflow-call-envelope-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  git(root, "add", "--", ".gitattributes", ".archflow/.gitignore", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "approve policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, artifact: staged.value };
}

describe("local call envelopes", () => {
  it("shares revision-0 identification, covers every tool branch, and binds gate paths and prompts", async () => {
    const fixture = await repository();
    const bootstrap = await createProductionServices({
      working_directory: fixture.root,
      task_id: task,
      operation: parseSafeCode("envelope-bootstrap"),
    });
    if (!bootstrap.ok) throw new Error(bootstrap.error.code);
    mkdirSync(join(bootstrap.value.authority.workspace_root, "transient"), { recursive: true });
    expect(bootstrap.value.state).toBeUndefined();
    const placeholder = D("0");
    const initialInput = {
      schema_version: "1" as const,
      task_id: task,
      intent_id: "initialize-envelope",
      expected_revision: 0,
      input_fingerprint: placeholder,
      phase_instance: "prd" as const,
      step: "produce" as const,
      status: "running" as const,
      artifact: fixture.artifact,
    };
    const firstEnvelope = await computeCallEnvelope(bootstrap.value, { tool: "archflow_state", input: initialInput });
    expect(firstEnvelope.ok).toBe(true);
    if (!firstEnvelope.ok) return;
    expect(firstEnvelope.value.artifact_digest).toBe(canonicalJsonDigest(fixture.artifact));
    const initializedCall = parseToolCall("archflow_state", {
      ...initialInput,
      input_fingerprint: firstEnvelope.value.input_fingerprint,
    });
    const initialized = await runStateInitialization(bootstrap.value.dependencies, {
      authority: bootstrap.value.authority,
      call: initializedCall,
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;
    expect(initialized.value.state.value.last_transition?.request_digest).toBe(firstEnvelope.value.request_digest);
    expect(initialized.value.state.value.input_fingerprint).toBe(firstEnvelope.value.input_fingerprint);

    const production = await createProductionServices({
      working_directory: fixture.root,
      task_id: task,
      operation: parseSafeCode("envelope-tools"),
    });
    if (!production.ok || production.value.state === undefined) throw new Error("production state unavailable");
    const state = production.value.state.value;
    const common = {
      schema_version: "1" as const,
      task_id: task,
      expected_revision: state.revision,
      input_fingerprint: placeholder,
    };
    const currentEvidence = {
      set_digest: D("a"),
      slots: [
        { role: "counter-review" as const, evidence_digest: D("c"), assurance: "server-attested" as const, producer_family: "claude" as const, reviewer_family: "codex" as const, independence: "opposite-family" as const },
      ] as const,
    };
    const rubric = { schema_version: "1" as const, kind: "artifact" as const, mode: "adversarial" as const, criteria: [{ id: "scope", text: "Check scope.", blocking: true }] };
    const values = [
      { tool: "archflow_state" as const, input: { ...common, intent_id: "state-envelope", phase_instance: "prd", step: "counter_review", status: "running" } },
      { tool: "archflow_counter_review" as const, input: { ...common, intent_id: "counter-envelope", artifact_path: "prd.md", rubric } },
    ];
    for (const value of values) {
      const envelope = await computeCallEnvelope(production.value, value);
      expect(envelope.ok, envelope.ok ? undefined : envelope.error.code).toBe(true);
      if (envelope.ok) {
        expect(envelope.value.tool).toBe(value.tool);
        expect(envelope.value.input_fingerprint).toBe(state.input_fingerprint);
        expect(envelope.value.request_digest).toMatch(/^[0-9a-f]{64}$/u);
        expect(envelope.value.gate).toBeUndefined();
      }
    }

    const gateInput = {
      ...common,
      intent_id: "gate-envelope",
      phase_instance: "prd" as const,
      summary: "Approve the PRD",
      subject_digest: D("d"),
      current_evidence: currentEvidence,
      kind: "artifact-approval" as const,
      context: { artifact_kind: "prd" as const },
    };
    const gate = await computeCallEnvelope(production.value, { tool: "archflow_gate", input: gateInput });
    expect(gate.ok).toBe(true);
    if (!gate.ok || gate.value.gate === undefined) return;
    expect(gate.value.gate.gate_id).toBe(computeGateId({
      task_identity_digest: production.value.authority.task_identity_digest,
      intent_id: gateInput.intent_id as never,
      request_digest: gate.value.request_digest,
    }));
    expect(gate.value.gate).toMatchObject({
      decision_path: `.archflow/runtime/tasks/${task}/cache/gates/gate.decision`,
      archive_decision_path: `authority/decisions/${gate.value.gate.gate_id}/decision.json`,
      request_path: `authority/decisions/${gate.value.gate.gate_id}/request.json`,
      gate_counter_review_path: `.archflow/runtime/tasks/${task}/cache/reviews/prd.gate-counter.${gate.value.gate.gate_id}.md`,
    });
    for (const binding of [gate.value.gate.gate_id, gate.value.request_digest, gateInput.subject_digest, state.input_fingerprint, currentEvidence.set_digest, "codex", "archflow-local gate-counter"]) {
      expect(gate.value.gate.counter_review_prompt).toContain(binding);
    }

    const originGateId = "origin-gate";
    const rule = { rule_id: "review-rule", rule_version: 1 };
    const scope = { operation: "review-trigger" as const, boundary: "subject" as const };
    const originContext = { constitution: "pass" as const, failed_rules: [], uncertain_rules: [], matched_trigger_rules: [rule], uncertain_trigger_rules: [], eligible_waivers: [{ rule, scope }] };
    const originContextDigest = computeGateContextDigest("constitution-review", originContext);
    const originRequest = parseGateRequest({
      schema_version: "1", gate_id: originGateId, intent_id: "origin-intent", request_digest: D("e"), task_id: task,
      phase_instance: "prd", summary: "Review trigger", subject_digest: D("f"), context_digest: originContextDigest,
      current_evidence: currentEvidence, kind: "constitution-review", context: originContext,
      allowed_decisions: ["approve", "revise", "reject", "waiver-requested", "cancel"], opened_at_revision: parseSafeInteger(state.revision),
    });
    mkdirSync(join(production.value.authority.task_root, "authority", "decisions", originGateId), { recursive: true });
    writeFileSync(join(production.value.authority.task_root, "authority", "decisions", originGateId, "request.json"), canonicalDocument(originRequest).bytes);
    const waiverInput = {
      ...common,
      intent_id: "waiver-envelope",
      origin: {
        origin_gate_id: originGateId,
        origin_decision_digest: D("1"),
        origin_context_digest: originContextDigest,
        task_id: task,
        phase_instance: "prd" as const,
        subject_digest: originRequest.subject_digest,
        current_evidence_set_digest: currentEvidence.set_digest,
        rule,
        scope,
      },
      rationale: "The rule does not apply.",
    };
    const waiver = await computeCallEnvelope(production.value, { tool: "archflow_waiver", input: waiverInput });
    expect(waiver.ok).toBe(true);
    if (waiver.ok) {
      expect(waiver.value.input_fingerprint).toBe(state.input_fingerprint);
      expect(waiver.value.gate?.decision_path).toBe(`.archflow/runtime/tasks/${task}/cache/gates/gate.decision`);
      expect(waiver.value.gate?.counter_review_prompt).toContain(originRequest.subject_digest);
      expect(waiver.value.gate?.counter_review_prompt).toContain("retry archflow_waiver once");
      expect(waiver.value.gate?.counter_review_prompt).toContain("same archflow_waiver input");
    }
  });

  it("the counter-review recipe names only published local commands", () => {
    // The recipe is the one interface a human counter-reviewer follows; every archflow-local
    // invocation it prescribes must exist on the current command surface, so a retired command
    // can never survive inside the rendered hand-off.
    const prompt = renderGateCounterPrompt({
      tool: "archflow_gate",
      gate_id: "gate-recipe-commands" as never,
      request_digest: D("1"),
      task_id: task,
      phase_instance: "prd" as never,
      kind: "artifact-approval",
      subject_digest: D("2"),
      context_digest: D("3"),
      input_fingerprint: D("4"),
      current_evidence: {
        set_digest: D("5"),
        slots: [{
          role: "counter-review", evidence_digest: D("6"), assurance: "server-attested",
          producer_family: "claude", reviewer_family: "codex", independence: "opposite-family",
        }],
      } as never,
    });
    const named = [...prompt.matchAll(/archflow-local\s+([a-z][a-z-]*)/gu)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(LOCAL_COMMANDS as readonly string[], `recipe names unpublished command ${name}`).toContain(name);
    }
  });
});
