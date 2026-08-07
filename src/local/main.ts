import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { LOCAL_COMMANDS, runLocalCommand, type LocalCommand } from "./commands.js";

const INPUT_FREE_COMMANDS = new Set<LocalCommand>(["status", "manual-status", "init", "task-init"]);

const NO_PAYLOAD_MESSAGE = "no payload provided: pass --input <json-file> or pipe JSON on stdin";

async function readInput(path: string | undefined): Promise<unknown> {
  if (path === undefined && process.stdin.isTTY === true) throw new TypeError(NO_PAYLOAD_MESSAGE);
  const bytes = path === undefined
    ? await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
        process.stdin.once("error", reject);
      })
    : await readFile(path);
  if (bytes.byteLength === 0) throw new TypeError(path === undefined ? NO_PAYLOAD_MESSAGE : `no payload provided: ${path} is empty`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError(`invalid JSON payload from ${path ?? "stdin"}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: { task: { type: "string" }, input: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write([
      "usage: node dist/archflow-local.mjs <command> [--task <task>] [--input <json-file>]",
      "       payload is read from --input <json-file>, or from stdin when --input is omitted",
      `commands: ${LOCAL_COMMANDS.join(", ")}`,
      `input-free commands (never read stdin): ${[...INPUT_FREE_COMMANDS].join(", ")}`,
      "",
    ].join("\n"));
    return;
  }
  if (parsed.positionals.length !== 1 || !LOCAL_COMMANDS.includes(parsed.positionals[0] as LocalCommand)) throw new TypeError("unknown archflow-local command");
  const command = parsed.positionals[0] as LocalCommand;
  const value = INPUT_FREE_COMMANDS.has(command) ? undefined : await readInput(parsed.values.input);
  const result = await runLocalCommand({ command, working_directory: process.cwd(), ...(parsed.values.task === undefined ? {} : { task_id: parsed.values.task }), ...(value === undefined ? {} : { value }) });
  assertPlainJson(result, "local command result");
  process.stdout.write(canonicalJsonBytes(result as PlainJsonValue));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
