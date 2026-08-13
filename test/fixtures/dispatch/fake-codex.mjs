#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const scenario = await readFile(join(process.cwd(), "scenario"), "utf8").catch(() => "success");

async function corpusOutput(selection) {
  const [file, name] = selection.slice("corpus:".length).trim().split("#");
  const corpus = JSON.parse(await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", file),
    "utf8",
  ));
  const entry = corpus.scenarios.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`unknown corpus scenario: ${selection.trim()}`);
  if (entry.output.step !== "adjudicate") return entry.output;
  const { constitution, drift, matched_rule_versions, uncertain_rule_versions, ...output } = entry.output;
  return output;
}

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(scenario.trim() === "old-version" ? "codex-cli 0.121.0\n" : "codex-cli 0.146.0\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  if (scenario.trim() === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  if (scenario.trim() === "auth-stderr" || scenario.trim() === "auth-duplicate") {
    process.stderr.write("WARNING: isolated home could not install PATH aliases\n");
  }
  const channel = scenario.trim() === "auth-stderr" || scenario.trim() === "auth-duplicate" ? process.stderr : process.stdout;
  channel.write("Logged in using ChatGPT\n");
  if (scenario.trim() === "auth-duplicate") process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", async () => {
  const output = argv[argv.indexOf("-o") + 1];
  const value = scenario.trim().startsWith("corpus:")
    ? await corpusOutput(scenario)
    : { schema_version: "1" };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(output, `${JSON.stringify(value)}\n`));
  process.stdout.write('{"type":"turn.completed"}\n');
});
