import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import reviewOutputSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import adjudicationOutputSchema from "../../src/contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import { parseAndDeriveAdjudication } from "../../src/contracts/adjudication.js";
import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { parseSafeId, parseSafeInteger } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import { mintAdjudicationObservation, mintReviewObservation, serializeDispatch } from "../../src/dispatch/cli.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";
import { buildAdjudicationEnvelope, buildReviewEnvelope } from "../../src/review/envelopes.js";
import { REAL_HOST_TEST_TIMEOUT_MS, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SENTINELS = Object.freeze([
  "credential-canary-7429",
  "routing-sentinel-1836",
  "openai-env-sentinel-5228",
  "anthropic-env-sentinel-6114",
]);

const CLAUDE_PRODUCER_CONFIG = `schema_version: "1"
roles:
  counter-reviewer: {model: gpt-5.6-sol, effort: xhigh}
  adjudicator: {model: gpt-5.6-sol, effort: xhigh}
`;
const CODEX_PRODUCER_CONFIG = `schema_version: "1"
roles:
  counter-reviewer: {model: claude-opus-5, effort: high}
  adjudicator: {model: claude-opus-5, effort: high}
`;

const rubric = parseRubricV1({
  schema_version: "1",
  kind: "implementation",
  mode: "adversarial",
  criteria: [{
    id: "correctness",
    text: "Report only a concrete contradiction or unmet requirement that requires producer action.",
    blocking: true,
  }],
});
const rubricDigest = canonicalJsonDigest(rubric as unknown as PlainJsonValue);
const PHASE = parsePhaseInstanceId("prd");
const validateReview = createJsonSchemaValidator<Record<string, unknown>>(reviewOutputSchema);
const validateAdjudication = createJsonSchemaValidator<Record<string, unknown>>(adjudicationOutputSchema);

const directions = Object.freeze([
  Object.freeze({
    name: "Claude producer to Codex reviewer",
    task: "real-dispatch-claude-codex",
    producer: "claude" as const,
    reviewer: "codex" as const,
    configSource: CLAUDE_PRODUCER_CONFIG,
    adapter: "codex-cli" as const,
    model: "gpt-5.6-sol",
    effort: "xhigh" as const,
  }),
  Object.freeze({
    name: "Codex producer to Claude reviewer",
    task: "real-dispatch-codex-claude",
    producer: "codex" as const,
    reviewer: "claude" as const,
    configSource: CODEX_PRODUCER_CONFIG,
    adapter: "claude-cli" as const,
    model: "claude-opus-5",
    effort: "high" as const,
  }),
]);

type HostObservation = Readonly<{
  wrapper_pid: number;
  child_pid: number;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  argv: readonly string[];
  stdout: string;
  stderr: string;
}>;

async function attemptRecords(root: string, taskId: string): Promise<readonly Readonly<{ bytes: Buffer; value: Record<string, unknown> }>[]> {
  const directory = join(root, ".archflow", "runtime", "tasks", taskId, "diagnostics", "attempts", "prd");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(names.map(async (name) => {
    const bytes = await readFile(join(directory, name));
    return { bytes, value: JSON.parse(decoder.decode(bytes)) as Record<string, unknown> };
  }));
}

async function withObservedHost<T>(command: "claude" | "codex", work: (read: () => Promise<HostObservation>) => Promise<T>): Promise<T> {
  const executable = execFileSync("which", [command], { encoding: "utf8" }).trim();
  const root = await mkdtemp(join(tmpdir(), `archflow-observed-${command}-`));
  const wrapper = join(root, command);
  const observation = join(root, "dispatch-observation.json");
  const source = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const probe = argv.length === 1 && argv[0] === "--version" || argv[0] === "auth" || argv[0] === "login";
const child = spawn(${JSON.stringify(executable)}, argv, { stdio: probe ? "inherit" : ["inherit", "pipe", "pipe"] });
if (probe) child.on("close", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
else {
  const stdout = []; const stderr = [];
  child.stdout.on("data", (chunk) => { stdout.push(Buffer.from(chunk)); process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr.push(Buffer.from(chunk)); process.stderr.write(chunk); });
  child.on("close", (code, signal) => {
    writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ wrapper_pid: process.pid, child_pid: child.pid, exit_code: code, signal, argv, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}
`;
  await writeFile(wrapper, source, { mode: 0o755 });
  await chmod(wrapper, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${root}${delimiter}${savedPath ?? ""}`;
  try {
    return await work(async () => JSON.parse(await readFile(observation, "utf8")) as HostObservation);
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  }
}

function safeFailureDiagnostic(observation: HostObservation): string {
  const messages: string[] = [];
  for (const line of observation.stdout.split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.message === "string") messages.push(event.message);
      const nestedMessage = event.error !== null && typeof event.error === "object"
        ? (event.error as Record<string, unknown>).message
        : undefined;
      if (typeof nestedMessage === "string") {
        messages.push(nestedMessage);
      }
    } catch { /* Non-event output is not diagnostic authority. */ }
  }
  messages.push(...observation.stderr.split(/\r?\n/u).filter((line) =>
    /\b(?:error|invalid|unknown|unsupported|not supported|schema|model|effort|argument|option)\b/iu.test(line)));
  const safeMessages = messages.join(" | ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "<redacted-email>")
    .replace(/(?:sk-|api[_-]?key[=: ]+)[A-Za-z0-9_-]+/giu, "<redacted-token>")
    .slice(0, 2_000);
  const flags = observation.argv.map((argument, index, argv) => {
    if (index > 0 && ["--json-schema", "--output-schema", "--mcp-config", "-o", "-C"].includes(argv[index - 1]!)) return "<value>";
    return argument.startsWith("{") ? "<json>" : argument;
  }).join(" ").slice(0, 2_000);
  return `exit=${String(observation.exit_code)} signal=${String(observation.signal)} argv=${flags} messages=${safeMessages || "<none>"}`;
}

function adjudicationSemanticDiagnostic(value: unknown): string {
  try {
    parseAndDeriveAdjudication(value);
    return "normative parser accepted output";
  } catch (error) {
    const issues = error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? error.issues as Array<Readonly<{ message?: unknown }>>
      : [];
    const reasons = issues.map((issue) => issue.message).filter((message): message is string => typeof message === "string");
    const record = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const ruleFindings = Array.isArray(record.rule_findings) ? record.rule_findings : [];
    const safeRules = ruleFindings.map((finding) => {
      if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return "invalid-finding";
      const item = finding as Record<string, unknown>;
      return `${String(item.rule_id)}:${String(item.rule_version)} compliance=${String(item.compliance)} trigger=${String(item.trigger)}`;
    });
    return `reason=${reasons.join(" | ") || (error instanceof Error ? error.message : "unknown")}; constitution=${String(record.constitution)} drift=${String(record.drift)} matched=${Array.isArray(record.matched_rule_versions) ? record.matched_rule_versions.length : "invalid"} uncertain=${Array.isArray(record.uncertain_rule_versions) ? record.uncertain_rule_versions.length : "invalid"} rules=[${safeRules.join("; ")}]`;
  }
}

describe.skipIf(!REAL_HOSTS_AVAILABLE)("real-host production dispatch", () => {
  for (const direction of directions) {
    it(`returns schema-valid, server-attested review evidence for ${direction.name}`, async () => {
      const saved = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ARCHFLOW_CREDENTIAL_CANARY: process.env.ARCHFLOW_CREDENTIAL_CANARY,
        ARCHFLOW_ROUTING_SENTINEL: process.env.ARCHFLOW_ROUTING_SENTINEL,
      };
      process.env.OPENAI_API_KEY = SENTINELS[2];
      process.env.ANTHROPIC_API_KEY = SENTINELS[3];
      process.env.ARCHFLOW_CREDENTIAL_CANARY = SENTINELS[0];
      process.env.ARCHFLOW_ROUTING_SENTINEL = SENTINELS[1];
      const workspace = await createTaskWorkspace({
        taskId: direction.task,
        label: direction.task,
        operation: "real-dispatch",
        configBytes: encoder.encode(direction.configSource),
      });
      try {
        const config = parseConfigYaml(direction.configSource, `${direction.name} config`);
        const route = resolveDispatchRoute(config, "phase-impl", "counter-reviewer");
        expect(route).toEqual({
          adapter: direction.adapter,
          family: direction.reviewer,
          model: direction.model,
          effort: direction.effort,
        });
        const artifact = "A local parser accepts UTF-8 JSON and rejects malformed JSON before changing state.";
        const subject = {
          task_id: workspace.taskId,
          phase_instance: PHASE,
          role: "counter-review" as const,
          step: "counter_review" as const,
          attempt: parseSafeInteger(1),
          subject_digest: sha256Bytes(encoder.encode(artifact)),
          input_fingerprint: canonicalJsonDigest({ direction: direction.name }),
          rubric_digest: rubricDigest,
          producer_family: direction.producer,
          invocation_id: parseSafeId(`invocation-${direction.task}`),
          result_id: parseSafeId(`result-${direction.task}`),
        };
        const envelope = buildReviewEnvelope({ artifact, rubric, context: [], subject });
        const dispatch = createDispatchCoordinator({
          authority: workspace.services.authority,
          dependencies: workspace.services.dependencies,
          host: direction.producer,
          repository_root: workspace.root,
          phase_instance: PHASE,
          signal: new AbortController().signal,
          cancellation_source: "client",
        });
        const command = route.adapter === "claude-cli" ? "claude" : "codex";
        const result = await withObservedHost(command, async (readObservation) => {
          try {
            const succeeded = await serializeDispatch(() => dispatch(route, envelope, reviewOutputSchema as PlainJsonValue));
            const [observation, attempts] = await Promise.all([
              readObservation(), attemptRecords(workspace.root, workspace.taskId),
            ]);
            expect(observation.wrapper_pid).not.toBe(process.pid);
            expect(observation.child_pid).not.toBe(process.pid);
            expect(attempts).toEqual([]);
            for (const sentinel of SENTINELS) {
              expect(Buffer.from(`${observation.stdout}\n${observation.stderr}`).includes(Buffer.from(sentinel))).toBe(false);
            }
            return { succeeded, observation };
          } catch (error) {
            const [observation, attempts] = await Promise.all([
              readObservation(), attemptRecords(workspace.root, workspace.taskId),
            ]);
            expect(attempts).toHaveLength(1);
            const attempt = attempts[0]!;
            expect(observation.wrapper_pid).not.toBe(process.pid);
            expect(observation.child_pid).not.toBe(process.pid);
            expect(attempt.value).toMatchObject({
              status: "failed",
              adapter: route.adapter,
              cli_version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
            });
            const code = error instanceof Error && "project_error" in error
              ? String((error as { project_error: { code: string } }).project_error.code)
              : error instanceof Error ? error.name : typeof error;
            throw new Error(
              `${direction.name} expected a successful ${route.model} dispatch but observed ${code}; ${safeFailureDiagnostic(observation)}`,
              { cause: error },
            );
          }
        });
        const rawOutput = JSON.parse(decoder.decode(result.succeeded.extracted_output_bytes)) as unknown;
        validateReview.assert(rawOutput, `${direction.name} output`);
        const observed = mintReviewObservation({
          subject,
          adapter: route.adapter,
          cli_version: result.succeeded.cli_version,
          route,
          repositories: [{
            name: "primary",
            repository_identity_digest: workspace.initialization.repository_identity_digest,
            commit: workspace.initialization.code_baseline_commit,
          }],
          envelope_input_digest: envelope.digest,
          extracted_output_bytes: result.succeeded.extracted_output_bytes,
        });
        expect(observed.evidence).toMatchObject({
          assurance: "server-attested",
          adapter: direction.adapter,
          model_family: direction.reviewer,
          model: direction.model,
          effort: direction.effort,
          cli_version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        });

        const returnedAndPersisted = Buffer.concat([
          Buffer.from(result.succeeded.extracted_output_bytes),
          Buffer.from(JSON.stringify(observed.evidence)),
          Buffer.from(result.observation.stdout),
          Buffer.from(result.observation.stderr),
        ]);
        for (const sentinel of SENTINELS) {
          expect(returnedAndPersisted.includes(Buffer.from(sentinel))).toBe(false);
        }
      } finally {
        workspace.dispose();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }, REAL_HOST_TEST_TIMEOUT_MS);

    it(`returns schema-valid, server-attested adjudication evidence for ${direction.name}`, async () => {
      const taskId = `${direction.task}-adjudicate`;
      const saved = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ARCHFLOW_CREDENTIAL_CANARY: process.env.ARCHFLOW_CREDENTIAL_CANARY,
        ARCHFLOW_ROUTING_SENTINEL: process.env.ARCHFLOW_ROUTING_SENTINEL,
      };
      process.env.OPENAI_API_KEY = SENTINELS[2];
      process.env.ANTHROPIC_API_KEY = SENTINELS[3];
      process.env.ARCHFLOW_CREDENTIAL_CANARY = SENTINELS[0];
      process.env.ARCHFLOW_ROUTING_SENTINEL = SENTINELS[1];
      const workspace = await createTaskWorkspace({
        taskId,
        label: taskId,
        operation: "real-adjudication",
        configBytes: encoder.encode(direction.configSource),
      });
      try {
        const config = parseConfigYaml(direction.configSource, `${direction.name} adjudication config`);
        const route = resolveDispatchRoute(config, "phase-impl", "adjudicator");
        const artifact = "The implementation preserves explicit human approval before every commit.";
        const sourceEvidenceSetDigest = canonicalJsonDigest({ source: direction.name });
        const subject = {
          task_id: workspace.taskId,
          phase_instance: PHASE,
          role: "adjudication" as const,
          step: "adjudicate" as const,
          subject_digest: sha256Bytes(encoder.encode(artifact)),
          input_fingerprint: canonicalJsonDigest({ adjudication: direction.name }),
          pinned_constitution_digest: canonicalJsonDigest({ constitution: "pinned-test" }),
          approved_upstream_digests: [],
          source_evidence_set_digest: sourceEvidenceSetDigest,
          invocation_id: parseSafeId(`invocation-${taskId}`),
          result_id: parseSafeId(`result-${taskId}`),
        };
        const envelope = buildAdjudicationEnvelope({
          artifact,
          rules: [{
            id: "human-approval",
            version: 1,
            text: "A commit requires explicit human approval.",
            enforced_by: [],
          }],
          approved_upstreams: [],
          source_evidence_set_digest: sourceEvidenceSetDigest,
          subject,
        });
        const dispatch = createDispatchCoordinator({
          authority: workspace.services.authority,
          dependencies: workspace.services.dependencies,
          host: direction.producer,
          repository_root: workspace.root,
          phase_instance: PHASE,
          signal: new AbortController().signal,
          cancellation_source: "client",
        });
        const command = route.adapter === "claude-cli" ? "claude" : "codex";
        const result = await withObservedHost(command, async (readObservation) => {
          try {
            const succeeded = await serializeDispatch(() =>
              dispatch(route, envelope, adjudicationOutputSchema as PlainJsonValue));
            const [observation, attempts] = await Promise.all([
              readObservation(), attemptRecords(workspace.root, workspace.taskId),
            ]);
            expect(observation.wrapper_pid).not.toBe(process.pid);
            expect(observation.child_pid).not.toBe(process.pid);
            expect(attempts).toEqual([]);
            return { succeeded, observation };
          } catch (error) {
            const [observation, attempts] = await Promise.all([
              readObservation(), attemptRecords(workspace.root, workspace.taskId),
            ]);
            expect(attempts).toHaveLength(1);
            const attempt = attempts[0]!;
            expect(attempt.value).toMatchObject({
              status: "failed", adapter: route.adapter,
              cli_version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
            });
            const code = error instanceof Error && "project_error" in error
              ? String((error as { project_error: { code: string } }).project_error.code)
              : error instanceof Error ? error.name : typeof error;
            throw new Error(
              `${direction.name} expected a successful ${route.model} adjudication but observed ${code}; ${safeFailureDiagnostic(observation)}`,
              { cause: error },
            );
          }
        });
        const rawOutput = JSON.parse(decoder.decode(result.succeeded.extracted_output_bytes)) as unknown;
        try {
          validateAdjudication.assert(rawOutput, `${direction.name} adjudication output`);
        } catch (error) {
          throw new Error(`${direction.name} adjudication failed normative post-validation: ${adjudicationSemanticDiagnostic(rawOutput)}`, { cause: error });
        }
        const observed = mintAdjudicationObservation({
          subject,
          adapter: route.adapter,
          cli_version: result.succeeded.cli_version,
          route,
          repositories: [{
            name: "primary",
            repository_identity_digest: workspace.initialization.repository_identity_digest,
            commit: workspace.initialization.code_baseline_commit,
          }],
          envelope_input_digest: envelope.digest,
          extracted_output_bytes: result.succeeded.extracted_output_bytes,
        });
        expect(observed.evidence).toMatchObject({
          assurance: "server-attested", adapter: route.adapter,
          model_family: direction.reviewer, model: direction.model, effort: direction.effort,
          cli_version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        });
        const returnedAndPersisted = Buffer.concat([
          Buffer.from(result.succeeded.extracted_output_bytes),
          Buffer.from(JSON.stringify(observed.evidence)),
          Buffer.from(result.observation.stdout),
          Buffer.from(result.observation.stderr),
        ]);
        for (const sentinel of SENTINELS) {
          expect(returnedAndPersisted.includes(Buffer.from(sentinel))).toBe(false);
        }
      } finally {
        workspace.dispose();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }, REAL_HOST_TEST_TIMEOUT_MS);
  }

  it("accepts an explicitly configured same-family counter-reviewer route", () => {
    const config = parseConfigYaml(CODEX_PRODUCER_CONFIG, "same-family real-host config");
    expect(resolveDispatchRoute(config, "phase-impl", "counter-reviewer"))
      .toMatchObject({ adapter: "claude-cli", family: "claude" });
  }, REAL_HOST_TEST_TIMEOUT_MS);
});
