import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { LOCAL_COMMANDS, runLocalCommand, type LocalCommand } from "./commands.js";

const INPUT_FREE_COMMANDS = new Set<LocalCommand>(["status", "init", "task-init"]);

async function readInput(path: string | undefined): Promise<unknown> {
  const bytes = path === undefined
    ? await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
        process.stdin.once("error", reject);
      })
    : await readFile(path);
  if (bytes.byteLength === 0) return undefined;
  return JSON.parse(bytes.toString("utf8"));
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: { task: { type: "string" }, input: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(`usage: node dist/archflow-local.mjs <command> [--task <task>] [--input <json-file>]\ncommands: ${LOCAL_COMMANDS.join(", ")}\n`);
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
