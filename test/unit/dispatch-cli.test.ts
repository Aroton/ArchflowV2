import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalJsonBytes } from "../../src/contracts/canonical.js";
import { parseAndDeriveAdjudication } from "../../src/contracts/adjudication.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parseAndDeriveReview } from "../../src/contracts/review.js";
import adjudicationSchema from "../../src/contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { createJsonSchemaValidator } from "../../src/contracts/validators.js";
import type { HostIdentity } from "../../src/contracts/hosts.js";
import type { DispatchChildResult } from "../../src/dispatch/process.js";
import {
  CliAdapterError,
  projectCliOutputSchema,
  selectCliAdapter,
  serializeDispatch,
} from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";
import validAdjudication from "../fixtures/contracts/adjudication/valid.json" with { type: "json" };
import validReview from "../fixtures/contracts/review/valid.json" with { type: "json" };

const bytes = (value: string): Buffer => Buffer.from(value, "utf8");
const result = (value: Partial<DispatchChildResult> = {}): DispatchChildResult => Object.freeze({
  exit_code: 0,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  ...value,
});
const envelope: DispatchEnvelope = Object.freeze({
  result_kind: "review",
  bytes: bytes('{"schema_version":"1","subject":{}}\n'),
  digest: "d".repeat(64) as never,
  byte_count: 36,
});

async function workspace(): Promise<DispatchWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "archflow-cli-test-"));
  return Object.freeze({ root, home: join(root, "home"), env: Object.freeze({ PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, CODEX_HOME: join(root, "home", ".codex") }), dispose: async () => undefined });
}

function projectError(call: () => unknown): CliAdapterError["project_error"] {
  try { call(); } catch (error) {
    expect(error).toBeInstanceOf(CliAdapterError);
    return (error as CliAdapterError).project_error;
  }
  throw new Error("expected adapter error");
}

describe("CLI adapter selection", () => {
  it("uses exactly two opposite-family arms and refuses unknown hosts before launch", () => {
    expect(selectCliAdapter("claude").id).toBe("codex-cli");
    expect(selectCliAdapter("codex", { allow_claude_dispatch: true }).id).toBe("claude-cli");
    expect(projectError(() => selectCliAdapter("unknown" as HostIdentity))).toMatchObject({ code: "UNSUPPORTED_HOST", diagnostic: { parameters: { host: "unknown" } } });
  });

  it("keeps Claude dispatch disabled unless explicitly enabled", () => {
    expect(projectError(() => selectCliAdapter("codex"))).toMatchObject({ code: "CONFIG_FAMILY_UNSUPPORTED", diagnostic: { parameters: { family: "claude" } } });
  });
});

describe("dispatch serialization", () => {
  it("runs globally in FIFO order without concurrent overlap", async () => {
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const operation = (id: number): Promise<number> => serializeDispatch(async () => {
      events.push(`start-${id}`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      events.push(`end-${id}`);
      return id;
    });

    const first = operation(1);
    const second = operation(2);
    const third = operation(3);
    await vi.waitFor(() => expect(events).toEqual(["start-1"]));
    releases.shift()!();
    await vi.waitFor(() => expect(events).toEqual(["start-1", "end-1", "start-2"]));
    releases.shift()!();
    await vi.waitFor(() => expect(events).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3"]));
    releases.shift()!();

    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    expect(maximumActive).toBe(1);
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("preserves rejection identity and does not poison later operations", async () => {
    const failure = new Error("dispatch failed");
    const events: string[] = [];
    const rejected = serializeDispatch(async () => {
      events.push("reject");
      throw failure;
    });
    const recoveredValue = Object.freeze({ ok: true });
    const recovered = serializeDispatch(async () => {
      events.push("recover");
      return recoveredValue;
    });

    await expect(rejected).rejects.toBe(failure);
    await expect(recovered).resolves.toBe(recoveredValue);
    expect(events).toEqual(["reject", "recover"]);
  });
});

describe("CLI invocation construction", () => {
  it("builds the pinned Claude argv with inline schema and no implicit defaults", async () => {
    const target = await workspace();
    const route: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" };
    const invocation = await selectCliAdapter("codex", { allow_claude_dispatch: true })
      .buildInvocation(envelope, route, target, reviewSchema);
    expect(invocation.argv.slice(0, 5)).toEqual(["-p", "--safe-mode", "--tools", "", "--disable-slash-commands"]);
    expect(invocation.argv).toContain("--setting-sources");
    expect(invocation.argv).not.toContain("--bare");
    expect(invocation.argv).not.toContain("--permission-mode");
    const schema = invocation.argv[invocation.argv.indexOf("--json-schema") + 1]!;
    expect(schema.startsWith("/")).toBe(false);
    expect(() => JSON.parse(schema)).not.toThrow();
    expect(invocation.stdin).toEqual(envelope.bytes);
  });

  it("builds the pinned Codex argv with schema/output paths and exact suppressions", async () => {
    const target = await workspace();
    const route: DispatchRoute = { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "xhigh" };
    const invocation = await selectCliAdapter("claude").buildInvocation(envelope, route, target, reviewSchema);
    expect(invocation.argv.slice(0, 6)).toEqual(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--strict-config"]);
    expect(invocation.argv).toContain("--output-schema");
    expect(invocation.argv).toContain("-o");
    expect(invocation.argv).toContain('model_reasoning_effort="xhigh"');
    expect(invocation.argv).not.toContain("forced_login_method");
    expect(invocation.argv).not.toContain("view_image");
    expect(invocation.argv.filter((item) => item === "--disable")).toHaveLength(14);
    expect(JSON.parse(await readFile(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]!, "utf8"))).toMatchObject({ type: "object" });
    expect(invocation.final_output_path).toBe(invocation.argv[invocation.argv.indexOf("-o") + 1]);
  });

  it("runs the Claude child inside the repository view with only read-only tools", async () => {
    const target = await workspace();
    const viewed: DispatchWorkspace = Object.freeze({ ...target, repository_view_root: join(target.root, "repo") });
    const route: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" };
    const adapter = selectCliAdapter("codex", { allow_claude_dispatch: true });

    const bare = await adapter.buildInvocation(envelope, route, target, reviewSchema);
    expect(bare.cwd).toBe(target.root);
    expect(bare.argv[bare.argv.indexOf("--tools") + 1]).toBe("");

    const invocation = await adapter.buildInvocation(envelope, route, viewed, reviewSchema);
    expect(invocation.cwd).toBe(viewed.repository_view_root);
    expect(invocation.argv[invocation.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    for (const pinned of ["--safe-mode", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) {
      expect(invocation.argv).toContain(pinned);
    }
    expect(invocation.argv[invocation.argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(invocation.argv[invocation.argv.indexOf("--mcp-config") + 1]).toBe(join(target.root, "empty-mcp.json"));
  });

  it("points the Codex sandbox at the repository view while outputs stay outside it", async () => {
    const target = await workspace();
    const viewed: DispatchWorkspace = Object.freeze({ ...target, repository_view_root: join(target.root, "repo") });
    const route: DispatchRoute = { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" };
    const adapter = selectCliAdapter("claude");

    const bare = await adapter.buildInvocation(envelope, route, target, reviewSchema);
    expect(bare.argv[bare.argv.indexOf("-C") + 1]).toBe(target.root);

    const invocation = await adapter.buildInvocation(envelope, route, viewed, reviewSchema);
    expect(invocation.argv[invocation.argv.indexOf("-C") + 1]).toBe(viewed.repository_view_root);
    expect(invocation.argv).toContain("-s");
    expect(invocation.argv[invocation.argv.indexOf("-s") + 1]).toBe("read-only");
    expect(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]).toBe(join(target.root, "review.schema.json"));
    expect(invocation.argv[invocation.argv.indexOf("-o") + 1]).toBe(join(target.root, "final-output.json"));
    expect(invocation.argv).toContain("project_doc_max_bytes=0");
  });

  it.each([
    ["claude", "claude-cli"],
    ["codex", "codex-cli"],
  ] as const)("passes the projected adjudication host schema through the %s adapter", async (_name, id) => {
    const target = await workspace();
    const adapter = id === "claude-cli"
      ? selectCliAdapter("codex", { allow_claude_dispatch: true })
      : selectCliAdapter("claude");
    const route: DispatchRoute = id === "claude-cli"
      ? { adapter: id, family: "claude", model: "claude-opus-4-6", effort: "high" }
      : { adapter: id, family: "codex", model: "gpt-5.3-codex", effort: "high" };
    const adjudicationEnvelope: DispatchEnvelope = { ...envelope, result_kind: "adjudication" };
    const invocation = await adapter.buildInvocation(adjudicationEnvelope, route, target, adjudicationSchema);
    const schemaText = id === "claude-cli"
      ? invocation.argv[invocation.argv.indexOf("--json-schema") + 1]!
      : await readFile(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]!, "utf8");
    const parsed = JSON.parse(schemaText) as Record<string, unknown>;

    expect(schemaText).not.toMatch(/(?:"\$schema"|"\$id"|"allOf"|"x-archflow-)/u);
    expect(parsed).toEqual(projectCliOutputSchema(adjudicationSchema as PlainJsonValue, "adjudication", id));
    expect(parsed).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: adjudicationSchema.required,
    });
    if (id === "codex-cli") {
      expect(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]).toMatch(/adjudication\.schema\.json$/u);
      const mechanical = ((parsed.$defs as Record<string, unknown>).mechanical as Record<string, unknown>);
      expect(mechanical).toMatchObject({ type: "object", anyOf: expect.any(Array) });
      for (const branch of mechanical.anyOf as Array<Record<string, unknown>>) {
        expect(branch).toMatchObject({ type: "object", additionalProperties: false });
        expect(branch.required).toEqual(Object.keys(branch.properties as Record<string, unknown>));
      }
    } else {
      expect(schemaText).not.toMatch(/"(?:minimum|maximum|minLength|minItems|maxItems|uniqueItems)"/u);
    }
  });

  it("projects review schema keywords without mutating or inventing an unbound review identity", () => {
    const before = structuredClone(reviewSchema);
    const projected = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "codex-cli") as Record<string, unknown>;
    const properties = projected.properties as Record<string, unknown>;

    expect(reviewSchema).toEqual(before);
    expect(JSON.stringify(projected)).not.toMatch(/(?:"\$schema"|"\$id"|"allOf"|"x-archflow-)/u);
    expect(projected).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: reviewSchema.required,
    });
    expect(properties).toMatchObject({
      step: { const: "counter_review" },
      role: { type: "string", enum: ["counter-review", "gate-counter-review"] },
    });
    const definitions = projected.$defs as Record<string, Record<string, unknown>>;
    expect(definitions.taskSlug).toMatchObject({
      type: "string",
      pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
    });
    expect(definitions.id).toMatchObject({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
    const finding = definitions.finding!;
    expect(finding).toMatchObject({ type: "object", anyOf: expect.any(Array) });
    for (const branch of finding.anyOf as Array<Record<string, unknown>>) {
      expect(branch).toMatchObject({ type: "object", additionalProperties: false });
      expect(branch.required).toEqual(Object.keys(branch.properties as Record<string, unknown>));
    }
    expect(JSON.stringify(projected)).toMatch(/"pattern"/u);
    expect(JSON.stringify(projected)).toMatch(/"minimum"/u);
    expect(JSON.stringify(projected)).toMatch(/"maximum"/u);
  });

  it("binds host-visible review identity fields to the server-derived envelope subject", () => {
    const subject = Object.fromEntries([
      "task_id", "phase_instance", "step", "role", "subject_digest", "input_fingerprint", "rubric_digest", "producer_family",
    ].map((key) => [key, validReview[key as keyof typeof validReview]])) as Record<string, PlainJsonValue>;
    const projected = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "claude-cli", subject) as Record<string, unknown>;
    const properties = projected.properties as Record<string, Record<string, unknown>>;

    for (const [key, value] of Object.entries(subject)) expect(properties[key]).toEqual({ const: value });
  });

  it("keeps Claude-supported simple patterns while simplifying only the task-slug lookahead", () => {
    const projected = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "claude-cli") as Record<string, unknown>;
    const definitions = projected.$defs as Record<string, Record<string, unknown>>;
    expect(definitions.id).toMatchObject({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
    expect(definitions.digest).toMatchObject({ pattern: "^[0-9a-f]{64}$" });
    expect(definitions.nonBlank).toMatchObject({ pattern: "\\S" });
    expect(definitions.phaseInstance).toMatchObject({ pattern: "^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$" });
    expect(definitions.taskSlug).toMatchObject({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" });
    expect(JSON.stringify(projected)).not.toContain("(?!");
    const finding = definitions.finding!;
    expect(finding).toMatchObject({ type: "object", anyOf: expect.any(Array) });
    for (const branch of finding.anyOf as Array<Record<string, unknown>>) {
      expect(branch).toMatchObject({ type: "object", additionalProperties: false });
      expect(branch.required).toEqual(Object.keys(branch.properties as Record<string, unknown>));
    }

    const validateProjected = createJsonSchemaValidator<Record<string, unknown>>(projected);
    const invalid = structuredClone(validReview) as Record<string, unknown>;
    const findings = invalid.findings as Array<Record<string, unknown>>;
    findings[0]!.finding_id = "Invalid Finding Id";
    expect(() => validateProjected.assert(invalid, "Claude projected finding id")).toThrow();
    findings[0]!.finding_id = "valid-finding-id";
    findings[0]!.blocking = false;
    expect(() => validateProjected.assert(invalid, "Claude projected finding severity")).toThrow();
  });

  it("keeps normative semantic rejection after the host transport projection", () => {
    const projectedReview = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "codex-cli");
    const validateProjectedReview = createJsonSchemaValidator<Record<string, unknown>>(projectedReview as Record<string, unknown>);
    const invalidFinding = structuredClone(validReview) as Record<string, unknown>;
    const invalidFindingItems = invalidFinding.findings as Array<Record<string, unknown>>;
    invalidFindingItems[0]!.blocking = false;
    expect(() => validateProjectedReview.assert(invalidFinding, "projected review finding")).toThrow();
    invalidFindingItems[0]!.blocking = true;
    invalidFindingItems[0]!.finding_id = "Invalid Finding Id";
    expect(() => validateProjectedReview.assert(invalidFinding, "projected review finding id")).toThrow();

    const invalidReview = structuredClone(validReview) as Record<string, unknown>;
    invalidReview.verdict = "pass";
    expect(() => validateProjectedReview.assert(invalidReview, "projected review")).not.toThrow();
    expect(() => parseAndDeriveReview(invalidReview)).toThrow();

    const projectedAdjudication = projectCliOutputSchema(adjudicationSchema as PlainJsonValue, "adjudication", "claude-cli");
    const validateProjectedAdjudication = createJsonSchemaValidator<Record<string, unknown>>(projectedAdjudication as Record<string, unknown>);
    const invalidAdjudication = structuredClone(validAdjudication) as Record<string, unknown>;
    const ruleFindings = invalidAdjudication.rule_findings as Array<Record<string, unknown>>;
    const mechanical = ruleFindings[0]!.enforced_by as Array<Record<string, unknown>>;
    delete mechanical[0]!.subject_digest;
    delete mechanical[0]!.evidence_digest;
    expect(() => validateProjectedAdjudication.assert(invalidAdjudication, "projected adjudication")).not.toThrow();
    expect(() => parseAndDeriveAdjudication(invalidAdjudication)).toThrow();
  });
});

describe("CLI output contracts and failure classification", () => {
  it("extracts and canonically re-encodes only Claude structured_output", () => {
    const adapter = selectCliAdapter("codex", { allow_claude_dispatch: true });
    const structured = { schema_version: "1", verdict: "pass" };
    expect(adapter.parseOutput(result({ stdout: bytes(JSON.stringify({ result: "ignored", structured_output: structured })) })))
      .toEqual(canonicalJsonBytes(structured));
    expect(projectError(() => adapter.parseOutput(result({ stdout: bytes("not-json") })))).toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("returns exact Codex final-output bytes and rejects missing/invalid files", () => {
    const adapter = selectCliAdapter("claude");
    const final = bytes('{"schema_version":"1"}\n');
    expect(Buffer.from(adapter.parseOutput(result({ final_output: final })))).toEqual(final);
    expect(projectError(() => adapter.parseOutput(result()))).toMatchObject({ code: "MODEL_OUTPUT_INVALID", diagnostic: { parameters: { issue_code: "final-output-missing" } } });
    expect(projectError(() => adapter.parseOutput(result({ final_output: bytes("bad") })))).toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("classifies Codex only from valid fatal events, deduplicating paired events", () => {
    const adapter = selectCliAdapter("claude");
    const message = "rate limit exceeded";
    const paired = bytes(`${JSON.stringify({ type: "error", message })}\n${JSON.stringify({ type: "turn.failed", error: { message } })}\n`);
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: paired }))).toMatchObject({ code: "RATE_LIMITED", diagnostic: { parameters: { adapter: "codex-cli", attempt: 1 } } });
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: bytes('{"type":"notice","message":"rate limit"}\n'), stderr: bytes("rate limit exceeded") })))
      .toMatchObject({ code: "PROCESS_FAILED", diagnostic: { parameters: { exit_class: "exit-1" } } });
  });

  it.each([
    ["auth", "Authentication required", "AUTH_UNAVAILABLE"],
    ["model", "Model 'gpt-unknown-codex' is not found", "UNSUPPORTED_MODEL"],
    ["current model", "The 'gpt-unknown-codex' model is not supported when using Codex with a ChatGPT account", "UNSUPPORTED_MODEL"],
    ["rate", "Too many requests", "RATE_LIMITED"],
  ])("classifies %s failures with schema-safe parameters", (_label, message, code) => {
    const event = bytes(`${JSON.stringify({ type: "turn.failed", error: { message } })}\n`);
    expect(() => selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).not.toThrow();
    expect(selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).toMatchObject({ code });
  });

  it("falls back safely when an unsupported-model message contains a non-SafeId slug", () => {
    const event = bytes(`${JSON.stringify({ type: "error", message: "Model 'openai/gpt-5' is not found" })}\n`);
    expect(() => selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).not.toThrow();
    expect(selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).toMatchObject({ code: "PROCESS_FAILED" });
  });

  it("ignores Claude stderr warnings and uses only an error wrapper for semantics", () => {
    const adapter = selectCliAdapter("codex", { allow_claude_dispatch: true });
    expect(adapter.classifyFailure(result({ stderr: bytes("deprecated model: rate limit wording") }))).toBeUndefined();
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: bytes(JSON.stringify({ is_error: true, result: "Login required" })) })))
      .toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });
});
