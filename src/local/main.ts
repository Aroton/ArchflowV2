import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { INPUT_FREE_COMMANDS, LOCAL_COMMAND_CONTRACTS, LOCAL_COMMANDS, runLocalCommand, type LocalCommand } from "./commands.js";

function usageText(): string {
  return [
    "usage: archflow-local <command> [--task <task>] [--input <json-file>] [--brief]",
    "       payload commands read JSON from --input <json-file>, or from stdin when --input is omitted",
    "       input-free commands never read stdin",
    "       --brief (status only) projects position, blockers, and next action without rendered bodies",
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
    options: { task: { type: "string" }, input: { type: "string" }, brief: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(usageText());
    return;
  }
  if (parsed.positionals.length !== 1 || !LOCAL_COMMANDS.includes(parsed.positionals[0] as LocalCommand)) {
    throw new TypeError(`unknown archflow-local command "${parsed.positionals.join(" ")}"; run archflow-local --help for the command list`);
  }
  const command = parsed.positionals[0] as LocalCommand;
  if (LOCAL_COMMAND_CONTRACTS[command].task === "required" && parsed.values.task === undefined) {
    throw new TypeError(`${command} requires --task <task>`);
  }
  if (parsed.values.brief === true && command !== "status") {
    throw new TypeError("--brief is only supported by the status command");
  }
  const value = INPUT_FREE_COMMANDS.has(command) ? undefined : await readInput(command, parsed.values.input);
  const result = await runLocalCommand({ command, working_directory: process.cwd(), ...(parsed.values.task === undefined ? {} : { task_id: parsed.values.task }), ...(value === undefined ? {} : { value }), ...(parsed.values.brief === true ? { brief: true } : {}) });
  assertPlainJson(result, "local command result");
  process.stdout.write(canonicalJsonBytes(result as PlainJsonValue));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
