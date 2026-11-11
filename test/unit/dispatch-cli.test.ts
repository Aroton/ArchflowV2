import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalJsonBytes } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { reviewReportOutputSchema } from "../../src/contracts/review.js";
import { createAdjudicationOutputSchema } from "../../src/contracts/adjudication.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import type { HostIdentity } from "../../src/contracts/hosts.js";
import { MAX_ARGV_ELEMENT_BYTES, type DispatchChildResult } from "../../src/dispatch/process.js";
import {
  CliAdapterError,
  projectCliOutputSchema,
  selectCliAdapter,
  serializeDispatchAll,
} from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";

const reviewOutputSchema = JSON.parse(JSON.stringify(reviewReportOutputSchema.toJSONSchema({ target: "draft-2020-12" })));
const adjudicationOutputSchema = JSON.parse(JSON.stringify(createAdjudicationOutputSchema(["rule-1"]).toJSONSchema({ target: "draft-2020-12" })));

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
  bytes: bytes('{"schema_version":"1","rubric":{"criteria":[{"id":"correctness","text":"Check correctness","blocking":true}]},"subject":{"stage":"plan"}}\n'),
  digest: "d".repeat(64) as never,
  byte_count: 36,
});

async function workspace(): Promise<DispatchWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "archflow-cli-test-"));
  return Object.freeze({ root, env: Object.freeze({ PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, CODEX_HOME: join(root, "home", ".codex") }), dispose: async () => undefined });
}

function projectError(call: () => unknown): CliAdapterError["project_error"] {
  try { call(); } catch (error) {
    expect(error).toBeInstanceOf(CliAdapterError);
    return (error as CliAdapterError).project_error;
  }
  throw new Error("expected adapter error");
}

describe("CLI adapter selection", () => {
  it("defaults to the host's opposite family and refuses unknown hosts before launch", () => {
    expect(selectCliAdapter("claude").id).toBe("codex-cli");
    expect(selectCliAdapter("codex").id).toBe("claude-cli");
    expect(selectCliAdapter("antigravity").id).toBe("claude-cli");
    expect(projectError(() => selectCliAdapter("unknown" as HostIdentity))).toMatchObject({ code: "UNSUPPORTED_HOST", diagnostic: { parameters: { host: "unknown" } } });
  });

  it("follows the resolved route's adapter for any family", () => {
    expect(selectCliAdapter("claude", { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" }).id).toBe("claude-cli");
    expect(selectCliAdapter("codex", { adapter: "codex-cli", family: "codex", model: "gpt-5.4", effort: "high" }).id).toBe("codex-cli");
    expect(selectCliAdapter("antigravity", { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" }).id).toBe("antigravity-cli");
    expect(projectError(() => selectCliAdapter("unknown" as HostIdentity, { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" })))
      .toMatchObject({ code: "UNSUPPORTED_HOST", diagnostic: { parameters: { host: "unknown" } } });
  });
});

describe("dispatch serialization", () => {
  it("runs globally in FIFO order without concurrent overlap", async () => {
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const operation = (id: number): Promise<number> => serializeDispatchAll([async () => {
      events.push(`start-${id}`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      events.push(`end-${id}`);
      return id;
    }]).then(([value]) => value!);

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
    const rejected = serializeDispatchAll([async () => {
      events.push("reject");
      throw failure;
    }]);
    const recoveredValue = Object.freeze({ ok: true });
    const recovered = serializeDispatchAll([async () => {
      events.push("recover");
      return recoveredValue;
    }]);

    await expect(rejected).rejects.toBe(failure);
    await expect(recovered).resolves.toEqual([recoveredValue]);
    expect((await recovered)[0]).toBe(recoveredValue);
    expect(events).toEqual(["reject", "recover"]);
  });
});

describe("CLI invocation construction", () => {
  it("builds the pinned Claude argv with inline schema and no implicit defaults", async () => {
    const target = await workspace();
    const route: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" };
    const invocation = await selectCliAdapter("codex")
      .buildInvocation(envelope, route, target, reviewOutputSchema);
    expect(invocation.argv.slice(0, 5)).toEqual(["-p", "--safe-mode", "--tools", "Read,Grep,Glob", "--add-dir"]);
    expect(invocation.argv).toContain("--setting-sources");
    expect(invocation.argv).not.toContain("--bare");
    expect(invocation.argv).not.toContain("--permission-mode");
    const schema = invocation.argv[invocation.argv.indexOf("--json-schema") + 1]!;
    expect(schema.startsWith("/")).toBe(false);
    expect(() => JSON.parse(schema)).not.toThrow();
    expect(invocation.stdin).toBeUndefined();
  });

  it("wraps the Claude launch through cc-switch only when a route names a provider", async () => {
    const target = await workspace();
    const adapter = selectCliAdapter("codex");
    const plainRoute: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" };
    const providerRoute: DispatchRoute = { ...plainRoute, provider: "zai" };

    const plain = await adapter.buildInvocation(envelope, plainRoute, target, reviewOutputSchema);
    expect(plain.command).toBe("claude");
    expect(plain.env).toBe(target.env);

    const wrapped = await adapter.buildInvocation(envelope, providerRoute, target, reviewOutputSchema);
    expect(wrapped.command).toBe("cc-switch");
    expect(wrapped.argv.slice(0, 4)).toEqual(["start", "claude", "zai", "--"]);
    // The full lockdown argv rides unchanged after the `--` separator.
    expect(wrapped.argv.slice(4)).toEqual([...plain.argv]);
    expect(wrapped.cwd).toBe(plain.cwd);
    expect(wrapped.stdin).toEqual(plain.stdin);
    // The wrap prepends the user's ~/.local/bin so the cc-switch binary stays reachable.
    const localBin = join(target.env.HOME!, ".local", "bin");
    expect(wrapped.env.PATH?.split(":")[0]).toBe(localBin);
    expect(wrapped.env.PATH).not.toBe(plain.env.PATH);
  });

  it("builds the pinned Codex argv with schema/output paths and exact suppressions", async () => {
    const target = await workspace();
    const route: DispatchRoute = { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "xhigh" };
    const invocation = await selectCliAdapter("claude").buildInvocation(envelope, route, target, reviewOutputSchema);
    await expect(selectCliAdapter("claude").buildInvocation(
      envelope,
      { ...route, provider: "zai" } as DispatchRoute,
      target,
      reviewOutputSchema,
    )).rejects.toMatchObject({ project_error: { code: "CONFIG_INVALID", diagnostic: { parameters: { issue_code: "provider-unsupported" } } } });
    expect(invocation.argv.slice(0, 6)).toEqual(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--strict-config"]);
    expect(invocation.argv).toContain("--output-schema");
    expect(invocation.argv).toContain("-o");
    expect(invocation.argv).toContain('model_reasoning_effort="xhigh"');
    expect(invocation.argv).not.toContain("forced_login_method");
    expect(invocation.argv).not.toContain("view_image");
    expect(invocation.argv.filter((item) => item === "--disable")).toHaveLength(12);
    expect(JSON.parse(await readFile(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]!, "utf8"))).toMatchObject({ type: "object" });
    expect(invocation.final_output_path).toBe(invocation.argv[invocation.argv.indexOf("-o") + 1]);
  });

  it("runs the Claude child inside the repository view with only read-only tools", async () => {
    const target = await workspace();
    const viewed: DispatchWorkspace = Object.freeze({ ...target, review_root: join(target.root, "review") });
    const route: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" };
    const adapter = selectCliAdapter("codex");

    const bare = await adapter.buildInvocation(envelope, route, target, reviewOutputSchema);
    expect(bare.cwd).toBe(target.root);
    expect(bare.argv).toContain("--add-dir");
    expect(bare.argv[bare.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");

    const invocation = await adapter.buildInvocation(envelope, route, viewed, reviewOutputSchema);
    expect(invocation.cwd).toBe(viewed.review_root);
    expect(invocation.argv).toContain("--add-dir");
    expect(invocation.argv[invocation.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    for (const pinned of ["--safe-mode", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) {
      expect(invocation.argv).toContain(pinned);
    }
    expect(invocation.argv[invocation.argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(invocation.argv[invocation.argv.indexOf("--mcp-config") + 1]).toBe(join(target.root, "empty-mcp.json"));
  });

  it("points the Codex sandbox at the repository view while outputs stay outside it", async () => {
    const target = await workspace();
    const viewed: DispatchWorkspace = Object.freeze({ ...target, review_root: join(target.root, "review") });
    const route: DispatchRoute = { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" };
    const adapter = selectCliAdapter("claude");

    const bare = await adapter.buildInvocation(envelope, route, target, reviewOutputSchema);
    expect(bare.argv[bare.argv.indexOf("-C") + 1]).toBe(target.root);
    for (const feature of ["shell_tool", "unified_exec"]) {
      expect(bare.argv[bare.argv.indexOf(feature) - 1]).toBe("--enable");
    }

    const invocation = await adapter.buildInvocation(envelope, route, viewed, reviewOutputSchema);
    expect(invocation.argv[invocation.argv.indexOf("-C") + 1]).toBe(viewed.review_root);
    for (const feature of ["shell_tool", "unified_exec"]) {
      expect(invocation.argv[invocation.argv.indexOf(feature) - 1]).toBe("--enable");
    }
    expect(invocation.argv).toContain("-s");
    expect(invocation.argv[invocation.argv.indexOf("-s") + 1]).toBe("read-only");
    expect(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]).toBe(join(target.root, "review.schema.json"));
    expect(invocation.argv[invocation.argv.indexOf("-o") + 1]).toBe(join(target.root, "review-final-output.json"));
    expect(invocation.argv).toContain("project_doc_max_bytes=0");
  });

  it.each([
    ["claude", "claude-cli"],
    ["codex", "codex-cli"],
  ] as const)("passes the projected adjudication host schema through the %s adapter", async (_name, id) => {
    const target = await workspace();
    const adapter = id === "claude-cli"
      ? selectCliAdapter("codex")
      : selectCliAdapter("claude");
    const route: DispatchRoute = id === "claude-cli"
      ? { adapter: id, family: "claude", model: "claude-opus-4-6", effort: "high" }
      : { adapter: id, family: "codex", model: "gpt-5.3-codex", effort: "high" };
    const adjudicationEnvelope: DispatchEnvelope = { ...envelope, result_kind: "adjudication" };
    const invocation = await adapter.buildInvocation(adjudicationEnvelope, route, target, adjudicationOutputSchema);
    const schemaText = id === "claude-cli"
      ? invocation.argv[invocation.argv.indexOf("--json-schema") + 1]!
      : await readFile(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]!, "utf8");
    const parsed = JSON.parse(schemaText) as Record<string, unknown>;

    expect(schemaText).not.toMatch(/(?:"\$schema"|"\$id"|"allOf"|"x-archflow-)/u);
    expect(parsed).toEqual(projectCliOutputSchema(adjudicationOutputSchema as PlainJsonValue, id));
    expect(parsed).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: adjudicationOutputSchema.required,
    });
    const properties = parsed.properties as Record<string, unknown>;
    for (const derived of ["constitution", "drift", "matched_rule_versions", "uncertain_rule_versions"]) {
      expect(properties).not.toHaveProperty(derived);
    }
    if (id === "codex-cli") {
      expect(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]).toMatch(/adjudication\.schema\.json$/u);
      // The codex state-branch expansion existed only for per-mechanism evidence, which findings
      // no longer carry; the adjudication document needs no adapter-specific rewrite at all.
      expect(parsed).not.toHaveProperty("$defs.mechanical");
    } else {
      expect(schemaText).not.toMatch(/"(?:minimum|maximum|minLength|minItems|maxItems|uniqueItems)"/u);
    }
  });

  it("projects host-unsupported keywords away without mutating the contract", () => {
    // Exercises every projection rule on one contract: metadata, x-archflow extensions and allOf are
    // stripped for every host; Claude drops numeric, length, count and format bounds; Codex drops
    // uniqueItems, rewrites oneOf to anyOf, and requires every declared property.
    const contract = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:example:contract",
      type: "object",
      "x-archflow-note": "internal",
      allOf: [{ required: ["name"] }],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z]+$", format: "hostname" },
        count: { type: "integer", minimum: 0, maximum: 9, multipleOf: 1 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
        choice: { oneOf: [{ const: "a" }, { const: "b" }] },
      },
      required: ["name"],
      additionalProperties: false,
    } as const;
    const before = structuredClone(contract);
    const claude = projectCliOutputSchema(contract as unknown as PlainJsonValue, "claude-cli") as Record<string, any>;
    const codex = projectCliOutputSchema(contract as unknown as PlainJsonValue, "codex-cli") as Record<string, any>;
    const antigravity = projectCliOutputSchema(contract as unknown as PlainJsonValue, "antigravity-cli") as Record<string, any>;
    expect(contract).toEqual(before);
    for (const projected of [claude, codex, antigravity]) {
      expect(JSON.stringify(projected)).not.toMatch(/(?:"\$schema"|"\$id"|"allOf"|"x-archflow-)/u);
      expect(projected).toMatchObject({ type: "object", additionalProperties: false });
      expect(projected.properties.name.pattern).toBe("^[a-z]+$");
    }
    expect(JSON.stringify(claude)).not.toMatch(/"(?:minimum|maximum|multipleOf|minLength|maxLength|format|minItems|maxItems|uniqueItems)"/u);
    expect(claude.properties.choice).toHaveProperty("oneOf");
    expect(claude.required).toEqual(["name"]);
    expect(codex.properties.name).toMatchObject({ minLength: 1, maxLength: 64, format: "hostname" });
    expect(codex.properties.tags).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(codex.properties.tags).not.toHaveProperty("uniqueItems");
    expect(codex.properties.choice).not.toHaveProperty("oneOf");
    expect(codex.properties.choice.anyOf).toEqual([{ const: "a", type: "string" }, { const: "b", type: "string" }]);
    expect(codex.required).toEqual(["name", "count", "tags", "choice"]);
    expect(antigravity.properties.tags).toMatchObject({ minItems: 1, maxItems: 3, uniqueItems: true });
    expect(antigravity.properties.choice).toHaveProperty("oneOf");
  });

  it.each(["claude-cli", "codex-cli", "antigravity-cli"] as const)(
    "projects a simple readable report root for %s",
    (adapter) => {
      const projected = projectCliOutputSchema(reviewOutputSchema, adapter) as Record<string, unknown>;
      expect(projected).toMatchObject({ type: "object", additionalProperties: false });
      expect(projected).not.toHaveProperty("oneOf");
      expect(projected).not.toHaveProperty("anyOf");
      const properties = projected.properties as Record<string, Record<string, unknown>>;
      expect(Object.keys(properties)).toEqual(["outcome", "feedback"]);
      expect(properties.feedback).toMatchObject({ type: "string" });
      const validate = createJsonSchemaValidator<Record<string, unknown>>(projected);
      expect(validate.validate({ outcome: "issues_found", feedback: "The guard is missing." })).toBe(true);
      expect(validate.validate({ outcome: "issues_found", feedback: "The guard is missing.", findings: [] })).toBe(false);
      expect(validate.validate({ outcome: "pass", feedback: "Fine." })).toBe(false);
    },
  );

  it.each(["claude-cli", "codex-cli", "antigravity-cli"] as const)(
    "preserves exact constitution judgment slots below a plain root for %s",
    (adapter) => {
      const judgment = {
        type: "object",
        properties: {
          compliance: { type: "string", enum: ["pass", "fail", "uncertain"] },
          rationale: { type: "string" },
          trigger: { type: "string", enum: ["not-matched", "matched", "uncertain"] },
          trigger_evidence: { type: "string" },
        },
        required: ["compliance", "rationale", "trigger", "trigger_evidence"],
        additionalProperties: false,
      } as const;
      const schema = {
        type: "object",
        properties: {
          schema_version: { type: "string", const: "2" },
          judgments: {
            type: "object",
            properties: { "rule-slot-1": judgment, "rule-slot-2": judgment },
            required: ["rule-slot-1", "rule-slot-2"],
            additionalProperties: false,
          },
        },
        required: ["schema_version", "judgments"],
        additionalProperties: false,
      } as const;
      const projected = projectCliOutputSchema(schema, adapter) as Record<string, unknown>;
      expect(projected).toMatchObject({ type: "object", additionalProperties: false });
      expect(projected).not.toHaveProperty("oneOf");
      expect(projected).not.toHaveProperty("anyOf");
      const properties = projected.properties as Record<string, Record<string, unknown>>;
      expect(Object.keys(properties)).toEqual(["schema_version", "judgments"]);
      expect(Object.keys((properties.judgments!.properties as Record<string, unknown>)))
        .toEqual(["rule-slot-1", "rule-slot-2"]);
    },
  );
});

describe("CLI output contracts and failure classification", () => {
  it("extracts and canonically re-encodes only Claude structured_output", () => {
    const adapter = selectCliAdapter("codex");
    const structured = { schema_version: "1", verdict: "pass" };
    expect(adapter.parseOutput(result({ stdout: bytes(JSON.stringify({ result: "ignored", structured_output: structured })) })))
      .toEqual(canonicalJsonBytes(structured));
    expect(projectError(() => adapter.parseOutput(result({ stdout: bytes("not-json") })))).toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("returns exact Codex final-output bytes and rejects missing/invalid files", () => {
    const adapter = selectCliAdapter("claude");
    const final = bytes('{"schema_version":"1","rubric":{"criteria":[{"id":"correctness","text":"Check correctness","blocking":true}]}}\n');
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
    const adapter = selectCliAdapter("codex");
    expect(adapter.classifyFailure(result({ stderr: bytes("deprecated model: rate limit wording") }))).toBeUndefined();
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: bytes(JSON.stringify({ is_error: true, result: "Login required" })) })))
      .toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: bytes(JSON.stringify({
      is_error: true,
      terminal_reason: "api_error",
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    })) }))).toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });

  it.each([0, 1])("recognizes Claude session-limit error wrappers at exit %s", (exit_code) => {
    const adapter = selectCliAdapter("codex");
    expect(adapter.classifyFailure(result({ exit_code, stdout: bytes(JSON.stringify({
      is_error: true, result: "API Error: 429 session limit reached (private account details)",
    })) }))).toMatchObject({ code: "RATE_LIMITED", diagnostic: { parameters: { reason: "session-limit" } } });
    expect(adapter.classifyFailure(result({ exit_code, stdout: bytes(JSON.stringify({
      is_error: true, result: "HTTP 429",
    })) }))).toMatchObject({ code: "RATE_LIMITED" });
  });

  it.each([0, 1])("recognizes agy's print deadline at exit %s and rejects partial output", (exit_code) => {
    const adapter = selectCliAdapter("antigravity", {
      adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high",
    });
    for (const structured_output of [undefined, { report: "unfinished" }]) {
      const child = result({ exit_code,
        stdout: bytes(JSON.stringify({ event: "result", result: { status: "SUCCESS", result: "", structured_output } })),
        stderr: bytes("[agy] print timeout after 5m0s with turn in progress; returning partial output\n"),
      });
      const expected = { code: "TIMEOUT", diagnostic: { parameters: {
        adapter: "antigravity-cli", attempt: 1, limit_ms: 300_000, origin: "cli",
      } } };
      expect(adapter.classifyFailure(child)).toMatchObject(expected);
      expect(projectError(() => adapter.parseOutput(child))).toMatchObject(expected);
    }
  });

  it("does not infer agy timeouts from ordinary stderr or reviewer prose", () => {
    const adapter = selectCliAdapter("antigravity", {
      adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high",
    });
    const child = result({
      stdout: bytes(JSON.stringify({ status: "SUCCESS", result: "A command timed out after 5 minutes" })),
      stderr: bytes("warning: command timed out after 5 minutes\n"),
    });
    expect(adapter.classifyFailure(child)).toBeUndefined();
    expect(projectError(() => adapter.parseOutput(child))).toMatchObject({
      code: "MODEL_OUTPUT_INVALID", diagnostic: { parameters: { issue_code: "structured-output-missing" } },
    });
  });

  it("extracts and canonically re-encodes Antigravity structured_output", async () => {
    const adapter = selectCliAdapter("antigravity", {
      adapter: "antigravity-cli",
      family: "gemini",
      model: "gemini-3.7-flash-high",
      effort: "high",
    });
    const structured = { schema_version: "1", verdict: "pass" };
    // stream-json output: progress events precede the final result event, which carries the wrapper.
    const stream = [
      JSON.stringify({ event: "init", init: { model: "gemini-3.7-flash-high" } }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "{}" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", structured_output: structured } }),
    ].join("\n");
    expect(adapter.parseOutput(result({ stdout: bytes(`${stream}\n`) }))).toEqual(canonicalJsonBytes(structured));
    // A bare single-object wrapper (the `--output-format json` shape) stays readable.
    expect(adapter.parseOutput(result({
      stdout: bytes(JSON.stringify({ status: "SUCCESS", structured_output: structured })),
    }))).toEqual(canonicalJsonBytes(structured));

    expect(projectError(() => adapter.parseOutput(result({
      stdout: bytes(`${JSON.stringify({ event: "result", result: { status: "ERROR" } })}\n`),
    })))).toMatchObject({
      code: "PROCESS_FAILED",
    });
    expect(projectError(() => adapter.parseOutput(result({
      stdout: bytes(`${JSON.stringify({ event: "init", init: {} })}\n`),
    })))).toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      diagnostic: { parameters: { issue_code: "antigravity-wrapper-invalid" } },
    });
    expect(adapter.classifyFailure(result({
      exit_code: 1,
      stdout: bytes(`${JSON.stringify({ event: "result", result: { status: "ERROR", error: "Authentication required" } })}\n`),
    }))).toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });

  it("builds Antigravity CLI invocation with exact arguments and flags", async () => {
    const adapter = selectCliAdapter("antigravity", {
      adapter: "antigravity-cli",
      family: "gemini",
      model: "gemini-3.7-flash-high",
      effort: "high",
    });
    const ws = await workspace();
    const inv = await adapter.buildInvocation(
      envelope,
      { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" },
      ws,
      reviewOutputSchema as PlainJsonValue,
    );

    expect(inv.command).toBe("agy");
    expect(inv.argv[inv.argv.indexOf("--print-timeout") + 1]).toBe("900s");
    expect(inv.argv).toContain("-p");
    expect(inv.argv).not.toContain("--input-format");
    expect(inv.argv).toContain("stream-json");
    expect(inv.argv).toContain("--output-format");
    expect(inv.argv).toContain("--json-schema");
    expect(inv.argv).toContain("--model");
    expect(inv.argv).toContain("gemini-3.7-flash-high");
    expect(inv.argv).toContain("--effort");
    expect(inv.argv).toContain("high");
    expect(inv.argv).toContain("--disable-slash-commands");
    expect(inv.argv).toContain("--dangerously-skip-permissions");

    // The envelope rides on stdin as one stream-json user message, never on argv; the schema is
    // a workspace file. Neither can then grow past the per-element argv limit.
    const promptText = envelope.bytes.toString();
    expect(inv.argv.some((element) => element.includes(promptText))).toBe(false);
    expect(inv.stdin).toBeUndefined();
    expect(inv.argv[1]).toContain("@review-inputs/");
    const schemaPath = inv.argv[inv.argv.indexOf("--json-schema") + 1]!;
    expect(schemaPath.startsWith(ws.root)).toBe(true);
    expect(JSON.parse(await readFile(schemaPath, "utf8"))).toMatchObject({ type: "object" });
  });

  it.each([
    { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" },
    { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" },
  ] as const)("keeps every $adapter argv element bounded and preserves the exact 300 KiB envelope payload", async (route) => {
    const adapter = selectCliAdapter("claude", route);
    const large: DispatchEnvelope = Object.freeze({
      ...envelope,
      bytes: bytes(JSON.stringify({ schema_version: "1", subject: { stage: "plan" }, rubric: { criteria: [{ id: "correctness", text: "Check correctness", blocking: true }] }, plan: "x".repeat(300 * 1024) })),
      byte_count: 300 * 1024 + 48,
    });
    const inv = await adapter.buildInvocation(
      large,
      route,
      await workspace(),
      reviewOutputSchema as PlainJsonValue,
    );
    expect(inv.argv.every((element) => Buffer.byteLength(element, "utf8") < MAX_ARGV_ELEMENT_BYTES)).toBe(true);
    expect(inv.stdin).toBeUndefined();
    const prompt = route.adapter === "antigravity-cli" ? inv.argv[1]! : inv.argv.at(-1)!;
    expect(prompt).toContain("@review-inputs/");
    expect(prompt).not.toContain("x".repeat(100));
    const ref = prompt.split("\n").find(line => line.endsWith("phase-design.md"))!.slice(1);
    const cwd = route.adapter === "codex-cli" ? inv.argv[inv.argv.indexOf("-C") + 1]! : inv.cwd;
    expect(await readFile(join(cwd, ref), "utf8")).toBe("x".repeat(300 * 1024));

  });

  it("fails an oversized Claude-only inline schema before spawn with a named error", async () => {
    const adapter = selectCliAdapter("codex", {
      adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high",
    });
    const oversizedSchema = {
      type: "object",
      description: "x".repeat(MAX_ARGV_ELEMENT_BYTES),
      properties: {},
      required: [],
      additionalProperties: false,
    } as const;
    await expect(adapter.buildInvocation(
      envelope,
      { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" },
      await workspace(),
      oversizedSchema,
    )).rejects.toMatchObject({
      project_error: {
        code: "PROCESS_FAILED",
        diagnostic: { parameters: { adapter: "claude-cli", exit_class: "argument-list-too-long" } },
      },
    });
  });
});
