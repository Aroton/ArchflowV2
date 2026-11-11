import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRawAdjudicationV2Schema } from "../../src/contracts/adjudication.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { reviewReportOutputSchema } from "../../src/contracts/review.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { serializeDispatchAll } from "../../src/dispatch/cli.js";
import { createReviewDispatcher } from "../../src/dispatch/coordinator.js";
import { configuredRoute } from "../helpers/dispatch-routes.js";
import { sealDispatchInput } from "../../src/review/envelopes.js";
import { dispatchInputRecord } from "../../src/review/inputs.js";
import { reviewAssignment } from "../../src/review/rubrics.js";
import { REAL_HOST_TEST_TIMEOUT_MS, failedAttemptObserver, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { createReviewRepository } from "../helpers/review-repository.js";
import { standaloneReviewFields } from "../helpers/standalone-review-input.js";

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
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const judgments = record.judgments !== null && typeof record.judgments === "object" && !Array.isArray(record.judgments)
    ? Object.keys(record.judgments as Record<string, unknown>)
    : [];
  return `schema_version=${String(record.schema_version)} judgment_slots=[${judgments.join(",")}]`;
}

describe.skipIf(!REAL_HOSTS_AVAILABLE)("real-host production dispatch", () => {
  for (const direction of directions) {
    it(`returns a schema-valid standalone review report for ${direction.name}`, async () => {
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
      const workspace = await createReviewRepository({ label: direction.task, configBytes: encoder.encode(direction.configSource) });
      try {
        const config = parseConfigYaml(direction.configSource, `${direction.name} config`);
        const route = configuredRoute(config, "phase-impl", "counter-reviewer");
        expect(route).toEqual({
          adapter: direction.adapter,
          family: direction.reviewer,
          model: direction.model,
          effort: direction.effort,
        });
        const artifact = "A local parser accepts UTF-8 JSON and rejects malformed JSON before changing state.";
        const assignment = reviewAssignment("counter-reviewer-1", "general", "phase-impl", rubric);
        const envelope = sealDispatchInput("review", { ...standaloneReviewFields({ subject: artifact }), assignment, rubric });
        const observer = failedAttemptObserver();
        const dispatch = createReviewDispatcher({
          host: direction.producer,
          repository_root: workspace.root,
          signal: new AbortController().signal,
          cancellation_source: "client",
        }, observer.observe);
        const command = route.adapter === "claude-cli" ? "claude" : "codex";
        const result = await withObservedHost(command, async (readObservation) => {
          try {
            const [succeeded] = await serializeDispatchAll([() => dispatch(route, envelope, dispatchInputRecord(envelope).response_schema!)]);
            const [observation, attempts] = await Promise.all([
              readObservation(), Promise.resolve(observer.attempts),
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
              readObservation(), Promise.resolve(observer.attempts),
            ]);
            expect(attempts).toHaveLength(1);
            const attempt = attempts[0]!;
            expect(observation.wrapper_pid).not.toBe(process.pid);
            expect(observation.child_pid).not.toBe(process.pid);
            expect(attempt).toMatchObject({
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
        const rawOutput = JSON.parse(decoder.decode(result.succeeded!.extracted_output_bytes)) as unknown;
        expect(reviewReportOutputSchema.strict().safeParse(rawOutput).success, `${direction.name} output`).toBe(true);
        expect(result.succeeded!.cli_version).toMatch(/^\d+\.\d+\.\d+$/u);

        const returnedAndPersisted = Buffer.concat([
          Buffer.from(result.succeeded!.extracted_output_bytes),
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

    it(`returns schema-valid constitution judgments for ${direction.name}`, async () => {
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
      const workspace = await createReviewRepository({ label: taskId, configBytes: encoder.encode(direction.configSource) });
      try {
        const config = parseConfigYaml(direction.configSource, `${direction.name} adjudication config`);
        const route = configuredRoute(config, "phase-impl", "adjudicator");
        const artifact = "The implementation preserves explicit human approval before every commit.";
        const ruleSlots = [{ slot: "slot-1", rule_id: "human-approval", rule_version: 1 }] as const;
        const envelope = sealDispatchInput("adjudication", {
          ...standaloneReviewFields({ subject: artifact }),
          rules: [{
            slot: "slot-1",
            text: "A commit requires explicit human approval.",
            enforced_by: [],
          }],
        });
        const observer = failedAttemptObserver();
        const dispatch = createReviewDispatcher({
          host: direction.producer,
          repository_root: workspace.root,
          signal: new AbortController().signal,
          cancellation_source: "client",
        }, observer.observe);
        const command = route.adapter === "claude-cli" ? "claude" : "codex";
        const result = await withObservedHost(command, async (readObservation) => {
          try {
            const [succeeded] = await serializeDispatchAll([() => dispatch(route, envelope, dispatchInputRecord(envelope).response_schema!)]);
            const [observation, attempts] = await Promise.all([
              readObservation(), Promise.resolve(observer.attempts),
            ]);
            expect(observation.wrapper_pid).not.toBe(process.pid);
            expect(observation.child_pid).not.toBe(process.pid);
            expect(attempts).toEqual([]);
            return { succeeded, observation };
          } catch (error) {
            const [observation, attempts] = await Promise.all([
              readObservation(), Promise.resolve(observer.attempts),
            ]);
            expect(attempts).toHaveLength(1);
            const attempt = attempts[0]!;
            expect(attempt).toMatchObject({
              adapter: route.adapter,
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
        const rawOutput = JSON.parse(decoder.decode(result.succeeded!.extracted_output_bytes)) as unknown;
        if (!createRawAdjudicationV2Schema(ruleSlots).safeParse(rawOutput).success) {
          throw new Error(`${direction.name} adjudication failed normative post-validation: ${adjudicationSemanticDiagnostic(rawOutput)}`);
        }
        expect(result.succeeded!.cli_version).toMatch(/^\d+\.\d+\.\d+$/u);
        const returnedAndPersisted = Buffer.concat([
          Buffer.from(result.succeeded!.extracted_output_bytes),
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
    expect(configuredRoute(config, "phase-impl", "counter-reviewer"))
      .toMatchObject({ adapter: "claude-cli", family: "claude" });
  }, REAL_HOST_TEST_TIMEOUT_MS);
});
