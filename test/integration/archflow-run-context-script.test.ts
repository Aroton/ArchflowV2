import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTemporaryRepositories, temporaryRoot } from "../helpers/temp-repository.js";

const script = fileURLToPath(new URL("../../skills/archflow-run/scripts/context.sh", import.meta.url));

afterAll(() => {
  cleanupTemporaryRepositories();
});

function assistant(usage: Record<string, number>, sidechain = false): string {
  return JSON.stringify({ type: "assistant", isSidechain: sidechain, message: { usage } });
}

/** Writes a session transcript under a Claude config directory and runs the script as that session would. */
function run(temp: string, session: string | undefined, lines: readonly string[] | undefined) {
  const config = join(temp, "config");
  mkdirSync(join(config, "projects", "-some-project"), { recursive: true });
  if (lines !== undefined) {
    writeFileSync(join(config, "projects", "-some-project", "session-1.jsonl"), lines.join("\n"));
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: temp, CLAUDE_CONFIG_DIR: config };
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  const result = spawnSync("bash", [script], { env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim() };
}

describe("archflow-run context script", () => {
  it("reports what the session's last request sent, cached or not", () => {
    const result = run(temporaryRoot("context-last"), "session-1", [
      assistant({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
      JSON.stringify({ type: "user", message: { content: '"type":"assistant" quoted inside a tool result' } }),
      assistant({ input_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 4_000 }),
    ]);

    expect(result).toEqual({ status: 0, stdout: "context: 304002 tokens" });
  });

  it("ignores sub-agent records and a last line that is still being written", () => {
    const result = run(temporaryRoot("context-skip"), "session-1", [
      assistant({ input_tokens: 1, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 0 }),
      assistant({ input_tokens: 1, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }, true),
      '{"type":"assistant","message":{"usage":{"input_tokens":9',
    ]);

    expect(result).toEqual({ status: 0, stdout: "context: 250001 tokens" });
  });

  it("says it does not know, and fails, instead of guessing", () => {
    const noSession = run(temporaryRoot("context-no-id"), undefined, [assistant({ input_tokens: 1 })]);
    const noTranscript = run(temporaryRoot("context-no-file"), "session-1", undefined);
    const noUsage = run(temporaryRoot("context-no-usage"), "session-1", [JSON.stringify({ type: "user" })]);
    const strayPath = run(temporaryRoot("context-path"), "../session-1", [assistant({ input_tokens: 1 })]);

    for (const result of [noSession, noTranscript, noUsage, strayPath]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/^context: unknown \(/);
    }
  });
});
