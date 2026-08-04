import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import { parseSafeId } from "../../src/contracts/evidence.js";
import type { RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { SecretScanCandidate, SecretScanner } from "../../src/contracts/secret-scan.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import { createProjectionWriter, type ProjectionWriter } from "../../src/state/atomic.js";
import {
  applyProjectionPlan,
  prepareProjectionPlan,
  type ProjectionDesired,
  type ProjectionObservation,
  type ProjectionSource,
} from "../../src/state/snapshots.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const cleanScanner: SecretScanner = Object.freeze({
  scan: async (candidates: readonly SecretScanCandidate[]) => Object.freeze({
    schema_version: "1",
    outcome: "clean",
    detector_set_id: parseSafeId("manifest-file-kinds"),
    scanned_paths: Object.freeze(candidates.map((candidate) => candidate.virtual_path)),
  }),
});

const claim = (value: string): RepositoryPathClaim => value as RepositoryPathClaim;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archflow-manifest-kinds-"));
  roots.push(root);
  return root;
}

function target(root: string, path: string): ResolvedPath {
  return Object.freeze({
    absolute: join(root, path) as ResolvedTaskPath,
    repositoryRelative: claim(path),
    path_class: "repository-source" as const,
  });
}

function absent(): ProjectionObservation {
  return Object.freeze({ state: "absent" });
}

function desiredAbsent(): ProjectionDesired {
  return Object.freeze({ state: "absent" });
}

function present(bytes: Uint8Array, mode: "100644" | "100755" = "100644"): ProjectionObservation {
  return Object.freeze({
    state: "present",
    file_type: "regular",
    mode,
    size_bytes: bytes.byteLength,
    content_digest: sha256Bytes(bytes),
  });
}

function desiredRegular(bytes: Uint8Array, mode: "100644" | "100755" = "100644"): ProjectionDesired {
  return Object.freeze({ state: "present", file_type: "regular", mode, bytes });
}

async function planAndApply(root: string, sources: readonly ProjectionSource[], writer = createProjectionWriter()) {
  const plan = await prepareProjectionPlan(sources, cleanScanner, root as ResolvedTaskPath);
  expect(plan.ok, plan.ok ? undefined : JSON.stringify(plan.error)).toBe(true);
  if (!plan.ok) throw new Error(plan.error.code);
  const applied = await applyProjectionPlan(writer, plan.value);
  expect(applied).toEqual({ outcome: "applied" });
  return plan.value;
}

describe("Phase 20 manifest file-kind restore matrix", () => {
  it("restores binary bytes without text conversion", async () => {
    const root = await workspace();
    const bytes = Uint8Array.from([0, 255, 13, 10, 128, 1, 0]);
    const output = target(root, "binary/payload.bin");
    await mkdir(join(root, "binary"));

    await planAndApply(root, [{
      path: output.repositoryRelative,
      target: output,
      desired: desiredRegular(bytes),
      authenticated_before: absent(),
      git_tracked: true,
    }]);

    expect(await readFile(output.absolute)).toEqual(Buffer.from(bytes));
  });

  it("restores an executable mode change", async () => {
    const root = await workspace();
    const bytes = Buffer.from("#!/bin/sh\nexit 0\n");
    const output = target(root, "tool.sh");
    await writeFile(output.absolute, bytes, { mode: 0o644 });
    await chmod(output.absolute, 0o644);

    await planAndApply(root, [{
      path: output.repositoryRelative,
      target: output,
      desired: desiredRegular(bytes, "100755"),
      authenticated_before: present(bytes),
      rollback: desiredRegular(bytes),
      git_tracked: true,
    }]);

    expect((await lstat(output.absolute)).mode & 0o777).toBe(0o755);
  });

  it("restores both members of a rename pair", async () => {
    const root = await workspace();
    const bytes = Buffer.from("renamed bytes\n");
    const source = target(root, "old-name.bin");
    const destination = target(root, "new-name.bin");
    await writeFile(source.absolute, bytes);

    await planAndApply(root, [
      {
        path: source.repositoryRelative,
        target: source,
        desired: desiredAbsent(),
        authenticated_before: present(bytes),
        rollback: desiredRegular(bytes),
        git_tracked: true,
        rename_pair: { role: "source", peer_path: destination.repositoryRelative },
      },
      {
        path: destination.repositoryRelative,
        target: destination,
        desired: desiredRegular(bytes),
        authenticated_before: absent(),
        git_tracked: true,
        rename_pair: { role: "destination", peer_path: source.repositoryRelative },
      },
    ]);

    await expect(lstat(source.absolute)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(destination.absolute)).toEqual(bytes);
  });

  it("restores a declared deletion", async () => {
    const root = await workspace();
    const bytes = Buffer.from("remove this generation\n");
    const output = target(root, "deleted.txt");
    await writeFile(output.absolute, bytes);

    await planAndApply(root, [{
      path: output.repositoryRelative,
      target: output,
      desired: desiredAbsent(),
      authenticated_before: present(bytes),
      rollback: desiredRegular(bytes),
      git_tracked: true,
    }]);

    await expect(lstat(output.absolute)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes a symlink generation through replaceSymlink", async () => {
    const root = await workspace();
    const linkTarget = "../shared/target.txt";
    const output = target(root, "links/current");
    await mkdir(join(root, "links"));
    const real = createProjectionWriter();
    const calls: string[] = [];
    const observing: ProjectionWriter = Object.freeze({
      replaceRegular: async (...arguments_) => {
        calls.push("replaceRegular");
        await real.replaceRegular(...arguments_);
      },
      replaceSymlink: async (...arguments_) => {
        calls.push("replaceSymlink");
        await real.replaceSymlink(...arguments_);
      },
      remove: async (...arguments_) => {
        calls.push("remove");
        await real.remove(...arguments_);
      },
    });

    await planAndApply(root, [{
      path: output.repositoryRelative,
      target: output,
      desired: Object.freeze({
        state: "present",
        file_type: "symlink",
        mode: "120000",
        bytes: new TextEncoder().encode(linkTarget),
      }),
      authenticated_before: absent(),
      git_tracked: true,
    }], observing);

    expect(calls).toEqual(["replaceSymlink"]);
    expect(await readlink(output.absolute)).toBe(linkTarget);
    expect((await lstat(output.absolute)).isSymbolicLink()).toBe(true);
  });

  it("opens the existing collision decision path without overwriting", async () => {
    const root = await workspace();
    const output = target(root, "occupied.bin");
    const humanBytes = Buffer.from("human generation\n");
    await writeFile(output.absolute, humanBytes);

    const plan = await prepareProjectionPlan([{
      path: output.repositoryRelative,
      target: output,
      desired: desiredRegular(Buffer.from("retained generation\n")),
      authenticated_before: absent(),
      git_tracked: true,
    }], cleanScanner, root as ResolvedTaskPath);

    expect(plan).toMatchObject({
      ok: true,
      value: {
        collisions: [{ path: output.repositoryRelative, path_class: "repository-source" }],
        collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
      },
    });
    if (!plan.ok) throw new Error(plan.error.code);
    await expect(applyProjectionPlan(createProjectionWriter(), plan.value)).resolves.toEqual({
      outcome: "collision",
      path: output.repositoryRelative,
      writes: 0,
    });
    expect(await readFile(output.absolute)).toEqual(humanBytes);
  });

  it("leaves the prior or complete binary generation across real SIGKILL projection-writer cuts", async () => {
    const root = await workspace();
    const output = join(root, "crash-binary.bin");
    const fixture = fileURLToPath(new URL("../fixtures/crash-projection-writer.mjs", import.meta.url));
    const priorBytes = Uint8Array.from([9, 0, 247, 10]);
    const bytes = Uint8Array.from([0, 255, 1, 254, 2, 253]);
    const program = `
      import { createServer } from "vite";
      import { createCrashProjectionWriter } from ${JSON.stringify(fixture)};
      const target = process.argv[1];
      const bytes = Uint8Array.from(JSON.parse(process.argv[2]));
      const cutPoint = process.argv[3];
      const vite = await createServer({
        appType: "custom",
        clearScreen: false,
        logLevel: "silent",
        server: { middlewareMode: true },
      });
      const { createProjectionWriter } = await vite.ssrLoadModule("/src/state/atomic.ts");
      const killAtCut = async (point, path) => new Promise((resolve, reject) => {
        process.send({ type: "cut", point, path }, (error) => {
          if (error !== null) reject(error);
          else { process.kill(process.pid, "SIGKILL"); resolve(); }
        });
      });
      const writer = createCrashProjectionWriter(createProjectionWriter(), cutPoint, killAtCut);
      await writer.replaceRegular({
        absolute: target,
        repositoryRelative: "crash-binary.bin",
        path_class: "repository-source",
      }, bytes, false);
    `;

    for (const cutPoint of ["projection-replace-before", "projection-replace-after"] as const) {
      await writeFile(output, priorBytes);
      const child = spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        program,
        output,
        JSON.stringify([...bytes]),
        cutPoint,
      ], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.add(child);

      const cut = await new Promise<Record<string, unknown>>((resolve, reject) => {
        child.once("message", (message) => resolve(message as Record<string, unknown>));
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal !== "SIGKILL") reject(new Error(`crash child exited unexpectedly: ${String(code)}/${String(signal)}`));
        });
      });
      await new Promise<void>((resolve, reject) => {
        if (child.signalCode === "SIGKILL") return resolve();
        child.once("exit", (code, signal) => signal === "SIGKILL"
          ? resolve()
          : reject(new Error(`crash child exited unexpectedly: ${String(code)}/${String(signal)}`)));
      });

      expect(cut).toMatchObject({ type: "cut", point: cutPoint, path: output });
      expect(await readFile(output)).toEqual(Buffer.from(
        cutPoint === "projection-replace-before" ? priorBytes : bytes,
      ));
      expect((await lstat(output)).isFile()).toBe(true);
    }
  }, 30_000);
});
