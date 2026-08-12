#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = (await readFile(join(process.cwd(), "plumbing-scenario"), "utf8").catch(() => "success")).trim();

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write("codex-cli 0.146.0\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks);
let sessionId = null;
if (process.platform === "linux") {
  const stat = await readFile("/proc/self/stat", "utf8");
  sessionId = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
}
await writeFile(join(process.cwd(), "plumbing-observation.json"), JSON.stringify({
  pid: process.pid,
  parent_pid: process.ppid,
  session_id: sessionId,
  cwd: process.cwd(),
  env: process.env,
  ...(scenario === "observe-input" ? { stdin_base64: input.toString("base64") } : {}),
  argv,
}));

if (scenario === "prompt-input") {
  // Models codex debug prompt-input's message-list output. It intentionally says nothing
  // about the separate, uninspectable request tools[] surface.
  await writeFile(join(process.cwd(), "prompt-input.json"), JSON.stringify({
    messages: [{ role: "user", content: input.toString("utf8") }],
  }));
}
if (scenario === "hang") await new Promise(() => undefined);
if (scenario === "failure") {
  process.stderr.write("fixture failure without planted values\n");
  process.exit(9);
}
const outputPath = argv[argv.indexOf("-o") + 1];
if (scenario === "overgrown-final") {
  await writeFile(outputPath, JSON.stringify({ oversized: "x".repeat(2048) }));
} else {
  await writeFile(outputPath, '{"schema_version":"1"}\n');
}
process.stdout.write('{"type":"turn.completed"}\n');
