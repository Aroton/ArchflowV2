import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { resetMemoizedCliPreflight } from "../../src/dispatch/cli.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";

const roots: string[] = [];
const initialPath = process.env.PATH;
afterEach(async () => {
  if (initialPath === undefined) delete process.env.PATH; else process.env.PATH = initialPath;
  resetMemoizedCliPreflight();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("dispatches all standalone roles through the real CLI runner with disposable shared snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "archflow-simple-dispatch-")); roots.push(root);
  const repository = join(root, "repository"); const bin = join(root, "bin");
  await mkdir(repository); await mkdir(bin);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); await writeFile(join(repository, "app.txt"), "before"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  await writeFile(join(repository, "app.txt"), "after");
  const log = join(root, "calls.jsonl");
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.146.0'); }
else if (args[0] === 'login') { console.log('Logged in using ChatGPT'); }
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    const envelope = JSON.parse(input);
    const cwd = args[args.indexOf('-C') + 1];
    const current = fs.readFileSync(path.join(cwd, 'primary', 'app.txt'), 'utf8');
    const baseline = fs.readFileSync(path.join(cwd, 'baseline', 'app.txt'), 'utf8');
    if (current !== 'after' || baseline !== 'before') process.exit(3);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd, args, role: envelope.assignment?.focus ?? 'constitution' }) + '\\n');
    const result = envelope.rules ? { schema_version: '2', judgments: Object.fromEntries(envelope.rules.map(rule => [rule.slot, {
      compliance: 'pass', rationale: 'Inspected exact bytes.', trigger: 'not-matched', trigger_evidence: 'No matched trigger.'
    }])) } : { report: 'Inspected exact current and baseline bytes.' };
    fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result));
    console.log(JSON.stringify({type: 'turn.completed'}));
  });
}
`);
  await chmod(executable, 0o755); process.env.PATH = `${bin}:${initialPath ?? ""}`; resetMemoizedCliPreflight();
  const connection = connectionContextFactory.captureStartup({ connection_id: "standalone-dispatch", startup_repository_candidate: { working_directory: repository } })
    .initialize({ client: { name: "codex", version: "test" }, host: "codex", protocol_version: "2025-11-25" });
  const context = createInvocationContext(connection, { invocation_id: "standalone-dispatch", transport_metadata: { request_id: "review", operation: "tools/call" } }, new AbortController().signal);
  const route = { model: "gpt-5.6-sol", effort: "medium" };
  const outcome = await createToolBoundary(createToolHandlers()).invoke("archflow_review", {
    schema_version: "1", stage: "implementation", ask: "Update app", plan: "Update app and verify", base_commit: git("rev-parse", "HEAD"),
    paths: ["app.txt"], verification: "Application check passed", review_routes: { "counter-reviewer": route, "test-reviewer": route, adjudicator: route },
  }, context);
  expect(outcome.kind).toBe("review-result");
  if (outcome.kind !== "review-result") throw new Error("wrong tool outcome");
  expect(outcome.result.ok, JSON.stringify(outcome.result)).toBe(true);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(calls).toHaveLength(3); expect(new Set(calls.map((call) => call.cwd)).size).toBe(1);
  expect(calls.map((call) => call.role).sort()).toEqual(["constitution", "general", "tests"]);
  await expect(readdir(calls[0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(repository)).not.toContain(".archflow");
  expect(await readFile(join(repository, "app.txt"), "utf8")).toBe("after");
});
