import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DISPATCH_OUTPUT_BYTE_CAP,
  DISPATCH_TIMEOUT_MS,
  DispatchProcessError,
  runDispatchChild,
  scanDispatchOutput,
  type DispatchChildSpec,
} from "../../src/dispatch/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "archflow-process-test-"));
  temporaryDirectories.push(path);
  return path;
}

function nodeSpec(
  cwd: string,
  source: string,
  overrides: Partial<DispatchChildSpec> = {},
): DispatchChildSpec {
  return {
    adapter: "codex-cli",
    command: process.execPath,
    argv: ["-e", source],
    cwd,
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function projectFailure(promise: Promise<unknown>): Promise<DispatchProcessError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DispatchProcessError);
    return error as DispatchProcessError;
  }
  throw new Error("expected dispatch process failure");
}

describe("dispatch process runner", () => {
  it("pins the production timeout and per-channel output cap", () => {
    expect(DISPATCH_TIMEOUT_MS).toBe(900_000);
    expect(DISPATCH_OUTPUT_BYTE_CAP).toBe(8 * 1024 * 1024);
  });

  it("passes explicit cwd, environment, and stdin and preserves output bytes", async () => {
    const cwd = await temporaryDirectory();
    const source = [
      "const chunks = [];",
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(Buffer.concat(chunks));",
      "  process.stderr.write(`${process.cwd()}|${process.env.ONLY_ALLOWED ?? ''}`);",
      "});",
    ].join("\n");
    const result = await runDispatchChild(nodeSpec(cwd, source, {
      env: { ONLY_ALLOWED: "present" },
      stdin: Buffer.from([0, 1, 2, 255]),
    }));

    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    expect([...result.stdout]).toEqual([0, 1, 2, 255]);
    expect(result.stderr.toString("utf8")).toBe(`${cwd}|present`);
  });

  it("classifies missing and non-executable commands without exposing raw spawn errors", async () => {
    const cwd = await temporaryDirectory();
    const missing = await projectFailure(runDispatchChild({
      ...nodeSpec(cwd, ""),
      command: join(cwd, "missing-cli"),
      argv: [],
    }));
    expect(missing.project_error).toMatchObject({
      code: "CLI_MISSING",
      diagnostic: { parameters: { adapter: "codex-cli" } },
    });

    if (process.platform !== "win32") {
      const executable = join(cwd, "not-executable");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executable, 0o600);
      const denied = await projectFailure(runDispatchChild({
        ...nodeSpec(cwd, ""),
        command: executable,
        argv: [],
      }));
      expect(denied.project_error).toMatchObject({
        code: "PROCESS_FAILED",
        diagnostic: { parameters: { adapter: "codex-cli", exit_class: "not-executable" } },
      });
    }
  });

  it("bounds stdout with exact stable error parameters", async () => {
    const cwd = await temporaryDirectory();
    const stdoutFailure = await projectFailure(runDispatchChild(nodeSpec(
      cwd,
      "process.stdout.write(Buffer.alloc(65, 120));",
      { byte_cap: 64 },
    )));
    expect(stdoutFailure.project_error).toMatchObject({
      code: "OUTPUT_OVERFLOW",
      diagnostic: { parameters: { adapter: "codex-cli", byte_count: 65, byte_cap: 64 } },
      next_action: "reduce-output",
    });
  });

  it("stats and bounded-reads Codex final output before returning it", async () => {
    const cwd = await temporaryDirectory();
    const finalPath = join(cwd, "final-output.json");
    const writer = `require('node:fs').writeFileSync(${JSON.stringify(finalPath)}, Buffer.alloc(65, 120)); process.stdout.write('small-jsonl');`;
    const failure = await projectFailure(runDispatchChild(nodeSpec(cwd, writer, {
      byte_cap: 64,
      final_output_path: finalPath,
    })));
    expect(failure.project_error).toMatchObject({
      code: "OUTPUT_OVERFLOW",
      diagnostic: { parameters: { adapter: "codex-cli", byte_count: 65, byte_cap: 64 } },
    });

    await writeFile(finalPath, Buffer.from([0, 255, 1]));
    const result = await runDispatchChild(nodeSpec(cwd, "", { final_output_path: finalPath }));
    expect([...result.final_output!]).toEqual([0, 255, 1]);
  });

  it("distinguishes timeout from InvocationContext-signal-compatible cancellation", async () => {
    const cwd = await temporaryDirectory();
    const source = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const timedOut = await projectFailure(runDispatchChild(nodeSpec(cwd, source, { timeout_ms: 30 })));
    expect(timedOut.project_error).toMatchObject({
      code: "TIMEOUT",
      diagnostic: { parameters: { adapter: "codex-cli", attempt: 1, limit_ms: 30 } },
    });

    const controller = new AbortController();
    const running = runDispatchChild(nodeSpec(cwd, source, {
      signal: controller.signal,
      cancellation_source: "transport",
      timeout_ms: 5_000,
    }));
    setTimeout(() => controller.abort(), 30);
    const cancelled = await projectFailure(running);
    expect(cancelled.project_error).toMatchObject({
      code: "CANCELLED",
      diagnostic: { parameters: { source: "transport", attempt: 1 } },
    });
  });

  it("exact-substring scans planted values across every output channel", () => {
    const clean = { stdout: Buffer.from("safe"), stderr: Buffer.from("also-safe") };
    expect(scanDispatchOutput(clean, ["credential-canary", "routing-sentinel"])).toEqual([]);

    const leakingNegativeControl = {
      stdout: Buffer.from("prefix credential-canary suffix"),
      stderr: Buffer.from("routing-sentinel"),
      final_output: Buffer.from("credential-canary"),
    };
    expect(scanDispatchOutput(leakingNegativeControl, ["credential-canary", "routing-sentinel", "canary"])).toEqual([
      "credential-canary",
      "routing-sentinel",
      "canary",
    ]);
  });
});
