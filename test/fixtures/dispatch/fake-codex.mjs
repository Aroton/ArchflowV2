#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = await readFile(join(process.cwd(), "scenario"), "utf8").catch(() => "success");

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(scenario.trim() === "old-version" ? "codex-cli 0.121.0\n" : "codex-cli 0.146.0\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  if (scenario.trim() === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", async () => {
  const output = argv[argv.indexOf("-o") + 1];
  await import("node:fs/promises").then(({ writeFile }) => writeFile(output, '{"schema_version":"1"}\n'));
  process.stdout.write('{"type":"turn.completed"}\n');
});
