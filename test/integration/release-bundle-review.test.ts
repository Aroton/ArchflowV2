import { execFileSync, spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Stages the release payload from the working tree, lays it out the way install.sh does
 * (<ARCHFLOW_HOME>/bundle/{dist,assets}), and runs the staged `archflow-local` against a scratch
 * repository with a scratch HOME. Only the manifest's runtime assets sit beside the bundle, so a
 * passing review proves the shipped rubrics, constitution and config template, plus the review
 * YAML inlined at build time, all resolve from the bundle rather than from this checkout.
 */
const TEST_TIMEOUT_MS = 120_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const reviewInputsReader = new URL("../fixtures/dispatch/read-review-inputs.mjs", import.meta.url).href;
let root = "";
let bin = "";
let home = "";
let bundleRoot = "";

async function findExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    try {
      await access(join(directory, name), constants.X_OK);
      return join(directory, name);
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`${name} must be on PATH`);
}

/** The fake codex reviewer of simple-review-dispatch.test.ts, logging which role each call served. */
function fakeCodex(log: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.146.0'); }
else if (args[0] === 'login') { console.log('Logged in using ChatGPT'); }
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    const envelope = (await import(${JSON.stringify(reviewInputsReader)})).readReviewFixtureInputs(args);
    const cwd = args[args.indexOf('-C') + 1];
    const current = fs.readFileSync(path.join(cwd, 'repositories', 'primary', 'app.txt'), 'utf8');
    const baseline = fs.readFileSync(path.join(cwd, 'repositories', 'baseline', 'app.txt'), 'utf8');
    if (current !== 'after' || baseline !== 'before') process.exit(3);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role: envelope.rules ? 'constitution' : envelope.assignment.focus, rules: envelope.rules ? envelope.rules.length : 0, criteria: envelope.rubric.criteria.length }) + '\\n');
    const result = envelope.rules ? { schema_version: '2', judgments: Object.fromEntries(envelope.rules.map(rule => [rule.slot, {
      compliance: 'pass', rationale: 'Inspected exact bytes.', trigger: 'not-matched', trigger_evidence: 'No matched trigger.'
    }])) } : { outcome: 'no_issues_found', feedback: 'Inspected exact current and baseline bytes; no actionable issues.' };
    fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result));
    console.log(JSON.stringify({type: 'turn.completed'}));
  });
}
`;
}

function scratchRepository(name: string): Promise<string> {
  const repository = join(root, name);
  return mkdir(repository).then(() => repository);
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", env: environment() }).trim();
}

function environment(): NodeJS.ProcessEnv {
  return {
    HOME: home,
    LANG: "C.UTF-8",
    PATH: bin,
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function runBundle(entry: string, cwd: string, args: readonly string[]) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: "utf8", env: environment(), input: "", timeout: TEST_TIMEOUT_MS,
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "archflow-release-bundle-review-"));
  const stage = join(root, "stage");
  const staged = spawnSync(process.execPath, [join(repositoryRoot, "scripts/build-release.mjs"), "--output", stage], {
    cwd: repositoryRoot, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
  });
  expect(staged.status, staged.stderr).toBe(0);

  home = join(root, "home");
  bundleRoot = join(home, ".archflow", "bundle");
  await cp(stage, join(bundleRoot, "dist"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(stage, "manifest.json"), "utf8")) as { runtime_assets: Array<{ path: string }> };
  for (const { path } of manifest.runtime_assets) {
    await mkdir(dirname(join(bundleRoot, path)), { recursive: true });
    await cp(join(repositoryRoot, path), join(bundleRoot, path));
  }

  // A hermetic PATH: node, git, tar (repository snapshots), and the fake codex reviewer only.
  bin = join(root, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  for (const tool of ["git", "tar"]) await symlink(await findExecutable(tool), join(bin, tool));
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("staged release bundle", () => {
  it("runs a standalone review whose rubrics, constitution and config come from the bundle", async () => {
    const log = join(root, "calls.jsonl");
    await writeFile(join(bin, "codex"), fakeCodex(log));
    await chmod(join(bin, "codex"), 0o755);

    const repository = await scratchRepository("repository");
    git(repository, "init", "-q");
    await writeFile(join(repository, "app.txt"), "before");
    git(repository, "add", ".");
    git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
    await writeFile(join(repository, "app.txt"), "after");

    const route = { model: "gpt-5.6-sol", effort: "medium" };
    const payload = join(root, "payload.json");
    await writeFile(payload, JSON.stringify({
      schema_version: "1", stage: "implementation", ask: "Update app", plan: "Update app and verify",
      base_commit: git(repository, "rev-parse", "HEAD"), paths: ["app.txt"], verification: "Application check passed",
      review_routes: { "counter-reviewer": route, "test-reviewer": route, adjudicator: route },
    }));

    const reviewed = runBundle(join(bundleRoot, "dist", "archflow-local.mjs"), repository, ["review", "--producer", "claude", "--input", payload]);
    expect(reviewed.error).toBeUndefined();
    expect(reviewed.status, `${reviewed.stderr}${reviewed.stdout}`).toBe(0);
    const result = JSON.parse(reviewed.stdout) as {
      ok: boolean;
      value: {
        failures: unknown[];
        reports: Array<{ role: string; outcome?: string; route: { model: string }; report?: string }>;
        constitution: { status: string; judgments: Array<{ compliance: string; rule_id: string }> };
      };
    };
    expect(result.ok, reviewed.stdout).toBe(true);
    expect(result.value.failures).toEqual([]);
    expect(result.value.reports.map((report) => report.role).sort()).toEqual(["adjudicator", "counter-reviewer", "test-reviewer"]);
    for (const report of result.value.reports.filter((entry) => entry.role !== "adjudicator")) {
      expect(report).toMatchObject({ outcome: "no_issues_found", route: { model: "gpt-5.6-sol" } });
    }
    expect(result.value.reports.find((entry) => entry.role === "adjudicator"))
      .toMatchObject({ route: { model: "gpt-5.6-sol" }, report: expect.stringContaining(": pass.") });
    // No .archflow/ in the scratch repository: the constitution is the bundle's shipped defaults.
    const shippedRules = (await readdir(join(bundleRoot, "assets", "constitution", "default"))).length;
    expect(result.value.constitution.status).toBe("complete");
    expect(result.value.constitution.judgments).toHaveLength(shippedRules);
    expect(result.value.constitution.judgments.every((judgment) => judgment.compliance === "pass")).toBe(true);

    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { role: string; rules: number; criteria: number });
    expect(calls.map((call) => call.role).sort()).toEqual(["constitution", "general", "tests"]);
    expect(calls.find((call) => call.role === "constitution")?.rules).toBe(shippedRules);
    for (const call of calls.filter((entry) => entry.role !== "constitution")) expect(call.criteria).toBeGreaterThan(0);

    // The installed layout records one usage file per dispatch beside the bundle.
    expect(await readdir(join(home, ".archflow", "usage"))).toHaveLength(3);
    expect(await readdir(repository)).not.toContain(".archflow");
  }, TEST_TIMEOUT_MS);

  it("names the searched directories when the bundle has no assets, and init does not ask for a retry", async () => {
    const lone = join(root, "lone", "dist");
    await mkdir(lone, { recursive: true });
    await cp(join(bundleRoot, "dist", "archflow-local.mjs"), join(lone, "archflow-local.mjs"));
    const repository = await scratchRepository("assetless");
    git(repository, "init", "-q");

    const initialized = runBundle(join(lone, "archflow-local.mjs"), repository, ["init"]);
    expect(initialized.status).not.toBe(0);
    expect(initialized.stderr).toContain(`installed ArchFlow assets are missing: looked in ${join(root, "lone", "assets")}/, ${join(root, "assets")}/`);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", retryable: false, diagnostic: { parameters: { issue_code: "installed-assets-missing" } } },
    });

    await writeFile(join(repository, "app.txt"), "before");
    git(repository, "add", ".");
    git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
    const payload = join(root, "assetless-payload.json");
    await writeFile(payload, JSON.stringify({
      schema_version: "1", stage: "plan", ask: "Update app", plan: "Update app and verify",
      base_commit: git(repository, "rev-parse", "HEAD"), paths: [],
    }));
    const reviewed = runBundle(join(lone, "archflow-local.mjs"), repository, ["review", "--producer", "claude", "--input", payload]);
    expect(reviewed.stderr).toContain("installed ArchFlow assets are missing: looked in");
    expect(JSON.parse(reviewed.stdout)).toMatchObject({ ok: false });
  }, TEST_TIMEOUT_MS);
});
