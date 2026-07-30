import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalJsonBytes } from "../../src/contracts/canonical.js";
import type { HostIdentity } from "../../src/contracts/hosts.js";
import type { DispatchChildResult } from "../../src/dispatch/process.js";
import {
  CliAdapterError,
  selectCliAdapter,
  serializeDispatch,
} from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";

const bytes = (value: string): Buffer => Buffer.from(value, "utf8");
const result = (value: Partial<DispatchChildResult> = {}): DispatchChildResult => Object.freeze({
  exit_code: 0,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  ...value,
});
const envelope: DispatchEnvelope = Object.freeze({ bytes: bytes('{"schema_version":"1"}\n'), digest: "d".repeat(64) as never, byte_count: 23 });

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
    const invocation = await selectCliAdapter("codex", { allow_claude_dispatch: true }).buildInvocation(envelope, route, target);
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
    const invocation = await selectCliAdapter("claude").buildInvocation(envelope, route, target);
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
