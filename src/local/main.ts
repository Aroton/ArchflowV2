import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { INPUT_FREE_COMMANDS, LOCAL_COMMAND_CONTRACTS, LOCAL_COMMANDS, runLocalCommand, type LocalCommand } from "./commands.js";

function usageText(): string {
  return [
    "usage: archflow-local <command> [--task <task>] [--repository <secondary>] [--input <json-file>]",
    "       payload commands read JSON from --input <json-file>, or from stdin when --input is omitted",
    "       input-free commands never read stdin",
    "commands (payload; --task):",
    ...LOCAL_COMMANDS.map((command) => {
      const contract = LOCAL_COMMAND_CONTRACTS[command];
      const payload = contract.payload === null ? "no payload" : `payload ${contract.payload}`;
      return `  ${command.padEnd(29)}${payload}; --task ${contract.task}`;
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
    options: { task: { type: "string" }, repository: { type: "string" }, input: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(usageText());
    return;
  }
  // `upgrade adopt` is the one two-token command form: the skill-facing shape of the input-free
  // adoption adapter registered as `upgrade-adopt`.
  const upgradeAdoptForm = parsed.positionals.length === 2 &&
    parsed.positionals[0] === "upgrade" && parsed.positionals[1] === "adopt";
  if (!upgradeAdoptForm && (parsed.positionals.length !== 1 || !LOCAL_COMMANDS.includes(parsed.positionals[0] as LocalCommand))) {
    throw new TypeError(`unknown archflow-local command "${parsed.positionals.join(" ")}"; run archflow-local --help for the command list`);
  }
  const command = (upgradeAdoptForm ? "upgrade-adopt" : parsed.positionals[0]) as LocalCommand;
  if (LOCAL_COMMAND_CONTRACTS[command].task === "required" && parsed.values.task === undefined) {
    throw new TypeError(`${command} requires --task <task>`);
  }
  if (INPUT_FREE_COMMANDS.has(command) && parsed.values.input !== undefined) {
    throw new TypeError(`${command} accepts no input payload; omit --input`);
  }
  if (parsed.values.repository !== undefined && command !== "restore") {
    throw new TypeError(`--repository is supported only by restore`);
  }
  const value = INPUT_FREE_COMMANDS.has(command) ? undefined : await readInput(command, parsed.values.input);
  const result = await runLocalCommand({ command, working_directory: process.cwd(), ...(parsed.values.task === undefined ? {} : { task_id: parsed.values.task }), ...(parsed.values.repository === undefined ? {} : { repository_name: parsed.values.repository }), ...(value === undefined ? {} : { value }) });
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
