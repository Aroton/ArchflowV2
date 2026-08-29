#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const adapter = process.env.FAKE_HOST_ADAPTER;
const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  if (adapter === "claude") {
    process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.220"} (Claude Code)\n`);
  } else if (adapter === "codex") {
    process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.146.0"}\n`);
  } else {
    process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "1.1.22"}\n`);
  }
  process.exit(0);
}
if (adapter === "claude" && argv.join(" ") === "auth status") {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_OUT !== "1" }));
  process.exit(0);
}
if (adapter === "codex" && argv.join(" ") === "login status") {
  process.stdout.write(process.env.FAKE_LOGGED_OUT === "1" ? "Not logged in\n" : "Logged in using ChatGPT\n");
  process.exit(process.env.FAKE_LOGGED_OUT === "1" ? 1 : 0);
}
if (adapter === "claude" && argv.slice(0, 3).join(" ") === "mcp add --scope") {
  const path = join(process.cwd(), ".mcp.json");
  let value = { mcpServers: {} };
  try { value = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  value.mcpServers ??= {};
  value.mcpServers.archflow = { type: "stdio", command: "archflow-mcp", args: [] };
  await writeFile(path, JSON.stringify(value, null, 2));
  process.exit(process.env.FAKE_CLAUDE_DUPLICATE === "1" ? 1 : 0);
}
if (adapter === "claude" && argv.join(" ") === "mcp get archflow") {
  process.stdout.write(process.env.FAKE_CLAUDE_GET ?? "Scope: Project\nStatus: ⏸ Pending approval\nCommand: archflow-mcp\n");
  process.exit(0);
}
if (adapter === "codex" && argv[0] === "mcp" && argv[1] === "add") {
  process.stderr.write("codex mcp add must not be called\n");
  process.exit(91);
}
if (adapter === "codex" && argv.slice(0, 3).join(" ") === "mcp get archflow") {
  const trusted = process.env.FAKE_CODEX_TRUSTED === "1";
  process.stdout.write(JSON.stringify({
    name: "archflow",
    transport: { command: process.env.FAKE_CODEX_COMMAND ?? "archflow-mcp", args: [] },
    startup_timeout_sec: trusted ? 30 : null,
    tool_timeout_sec: trusted ? 3600 : null,
  }));
  process.exit(0);
}
if (adapter === "agy" && argv.slice(0, 2).join(" ") === "mcp list") {
  process.stdout.write(process.env.FAKE_AGY_LIST ?? "archflow  stdio  enabled  archflow-mcp\n");
  process.exit(0);
}
process.stderr.write(`unexpected ${adapter ?? "unknown"} invocation: ${argv.join(" ")}\n`);
process.exit(90);
