#!/usr/bin/env node
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
process.stderr.write(`unexpected ${adapter ?? "unknown"} invocation: ${argv.join(" ")}\n`);
process.exit(90);
