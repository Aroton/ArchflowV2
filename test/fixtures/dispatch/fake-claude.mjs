#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = await readFile(join(process.cwd(), "scenario"), "utf8").catch(() => "success");

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(scenario.trim() === "old-version" ? "2.1.204 (Claude Code)\n" : "2.1.220 (Claude Code)\n");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: scenario.trim() !== "logged-out" }));
  process.exit(scenario.trim() === "logged-out" ? 1 : 0);
}
if (argv.includes("--json-schema")) {
  const schema = argv[argv.indexOf("--json-schema") + 1];
  try { JSON.parse(schema); } catch { process.stderr.write("schema was not inline JSON\n"); process.exit(64); }
}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("deprecated model warning\n");
  process.stdout.write(JSON.stringify({ structured_output: { schema_version: "1" } }));
});
