import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 30_000;

function usage(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--payload" || argv[1] === "") {
    throw usage("usage: smoke-release-bundle.mjs --payload <dir>");
  }
  return resolve(argv[1]);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Input-free commands must answer without stdin, so the child gets an open pipe it never sees closed
// until it exits; a command that waits on stdin times out here instead of passing.
async function runChild({ argv, cwd, env }) {
  const child = spawn(process.execPath, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  let timer;
  try {
    const exit = await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`release smoke child timed out: ${argv.slice(1).join(" ")}`)), timeoutMs);
      }),
    ]);
    return { ...exit, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`release smoke needs ${name} on PATH`);
}

/** Lays the payload out the way install.sh does: <bundle>/dist plus the manifest's runtime assets. */
async function installCopy(payloadRoot, bundleRoot) {
  await cp(payloadRoot, join(bundleRoot, "dist"), { recursive: true, verbatimSymlinks: true });
  const manifest = JSON.parse(await readFile(join(payloadRoot, "manifest.json"), "utf8"));
  for (const record of manifest.runtime_assets) {
    const bytes = await readFile(resolve(repositoryRoot, record.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.digest, `runtime asset differs: ${record.path}`);
    await mkdir(dirname(join(bundleRoot, record.path)), { recursive: true });
    await cp(resolve(repositoryRoot, record.path), join(bundleRoot, record.path));
  }
  return manifest.runtime_assets.map((record) => record.path);
}

export async function smokeReleasePayload(payloadRoot) {
  assert.equal((await stat(join(payloadRoot, "archflow-local.mjs"))).isFile(), true, "payload must contain archflow-local.mjs");
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "archflow-release-smoke-"));
  try {
    const bundleRoot = join(temporaryRoot, "bundle");
    const runtimeAssets = await installCopy(payloadRoot, bundleRoot);
    const bundle = join(bundleRoot, "dist", "archflow-local.mjs");

    // Only node and git are reachable: no host CLIs, no ambient module path, no inherited options.
    const bin = join(temporaryRoot, "bin");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "node"));
    await symlink(await findExecutable("git"), join(bin, "git"));
    const home = join(temporaryRoot, "home");
    await mkdir(home);
    const env = {
      HOME: home,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: bin,
      TMPDIR: tmpdir(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };

    const help = await runChild({ argv: [bundle, "--help"], cwd: temporaryRoot, env });
    assert.deepEqual({ code: help.code, signal: help.signal }, { code: 0, signal: null }, help.stderr);
    assert.equal(help.stderr, "", "help emitted diagnostics");
    assert.match(help.stdout, /usage: archflow-local <command>/u);
    assert.match(help.stdout, /^ {2}init {2,}no payload$/mu);
    assert.match(help.stdout, /^ {2}review {2,}payload /mu);

    const repository = join(temporaryRoot, "repository");
    await mkdir(repository);
    const initialized = spawnSync("git", ["init", "-q"], { cwd: repository, env, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const init = await runChild({ argv: [bundle, "init"], cwd: repository, env });
    assert.deepEqual({ code: init.code, signal: init.signal }, { code: 0, signal: null }, init.stderr);
    const report = JSON.parse(init.stdout);
    assert.equal(report.ok, true, init.stdout);
    for (const path of [".archflow/.gitignore", ".archflow/config.yaml", ".archflow/constitution/README.md"]) {
      assert.ok(report.value.assets.created.includes(path), `init did not create ${path}`);
    }
    assert.deepEqual(
      await readFile(join(repository, ".archflow", "config.yaml")),
      await readFile(join(bundleRoot, "assets", "config.template.yaml")),
      "init must scaffold the bundled config template",
    );
    return {
      bundles: ["archflow-local.mjs"],
      commands: ["help", "init"],
      init_created: report.value.assets.created.length,
      payload_root: payloadRoot,
      runtime_assets: runtimeAssets.length,
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function main() {
  const payloadRoot = parseArguments(process.argv.slice(2));
  const result = await smokeReleasePayload(payloadRoot);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
}
