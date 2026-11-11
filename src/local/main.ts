import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { INPUT_FREE_COMMANDS, LOCAL_COMMAND_CONTRACTS, LOCAL_COMMANDS, runLocalCommand, type LocalCommand } from "./commands.js";

function usageText(): string {
  return [
    "usage: archflow-local <command> [--producer <claude|codex|antigravity>] [--input <json-file>] [--force]",
    "       init --force refreshes shipped defaults and other scaffold files (including config.yaml), preserves custom/, and migrates flat constitution rules",
    "       payload commands read JSON from --input <json-file>, or from stdin when --input is omitted",
    "       input-free commands never read stdin",
    "       review --producer <claude|codex|antigravity> [--input <json-file>] runs the standalone counter-review of the current working directory (worktrees included)",
    "commands:",
    ...LOCAL_COMMANDS.map((command) => {
      const contract = LOCAL_COMMAND_CONTRACTS[command];
      return `  ${command.padEnd(29)}${contract.payload === null ? "no payload" : `payload ${contract.payload}`}`;
    }),
    "",
  ].join("\n");
}

async function readInput(command: LocalCommand, path: string | undefined): Promise<unknown> {
  const missingPayload = () => new TypeError(path === undefined
    ? `${command} requires an input payload (--input <json-file> or stdin); expected: ${LOCAL_COMMAND_CONTRACTS[command].payload}`
    : `${command} requires an input payload; ${path} is empty; expected: ${LOCAL_COMMAND_CONTRACTS[command].payload}`);
  if (path === undefined && process.stdin.isTTY === true) throw missingPayload();
  const bytes = path === undefined
    ? await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
        process.stdin.once("error", reject);
      })
    : await readFile(path);
  if (bytes.byteLength === 0) throw missingPayload();
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError(`invalid JSON payload from ${path ?? "stdin"}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: { producer: { type: "string" }, input: { type: "string" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(usageText());
    return;
  }
  if (parsed.positionals.length !== 1 || !LOCAL_COMMANDS.includes(parsed.positionals[0] as LocalCommand)) {
    throw new TypeError(`unknown archflow-local command "${parsed.positionals.join(" ")}"; run archflow-local --help for the command list`);
  }
  const command = parsed.positionals[0] as LocalCommand;
  if (INPUT_FREE_COMMANDS.has(command) && parsed.values.input !== undefined) {
    throw new TypeError(`${command} accepts no input payload; omit --input`);
  }
  if (parsed.values.force === true && command !== "init") {
    throw new TypeError(`--force is supported only by init`);
  }
  if (command !== "review" && parsed.values.producer !== undefined) throw new TypeError("--producer is supported only by review");
  if (command === "review" && !["claude", "codex", "antigravity"].includes(parsed.values.producer ?? "")) throw new TypeError("review requires --producer claude|codex|antigravity to resolve the cross-family review routes");
  const value = INPUT_FREE_COMMANDS.has(command) ? undefined : await readInput(command, parsed.values.input);
  // Cancel reviewer children and dispose the review workspace on interrupt instead of dying mid-dispatch.
  const controller = new AbortController();
  if (command === "review") for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  const result = await runLocalCommand({ command, working_directory: process.cwd(), signal: controller.signal, ...(parsed.values.producer === undefined ? {} : { producer: parsed.values.producer }), ...(value === undefined ? {} : { value }), ...(parsed.values.force === true ? { force: true } : {}) });
  assertPlainJson(result, "local command result");
  if (result !== null && typeof result === "object" && !Array.isArray(result) && (result as Record<string, unknown>).ok === false) {
    process.exitCode = 1;
    const error = (result as Record<string, unknown>).error;
    const code = error !== null && typeof error === "object" && !Array.isArray(error) && typeof (error as Record<string, unknown>).code === "string"
      ? (error as Record<string, unknown>).code
      : "PROJECT_ERROR";
    process.stderr.write(`${command} failed: ${code}\n`);
  }
  process.stdout.write(canonicalJsonBytes(result as PlainJsonValue));
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "local command failed" : message;
}

function commandFailure(error: unknown): ProjectResult<never> {
  const message = failureMessage(error);
  return Object.freeze({
    schema_version: "1" as const,
    ok: false as const,
    error: createProjectError("CONTRACT_INVALID", {
      issue_code: "local-command-invalid",
      issues: [message.slice(0, 256)],
    }),
  });
}

main().catch((error) => {
  const message = failureMessage(error);
  process.stdout.write(canonicalJsonBytes(commandFailure(error) as unknown as PlainJsonValue));
  process.stderr.write(`${message.replace(/\s+/gu, " ").slice(0, 512)}\n`);
  process.exitCode = 1;
});
