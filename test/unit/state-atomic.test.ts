import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PathClass, RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import {
  AtomicReplaceError,
  createAtomicWriter,
} from "../../src/state/atomic.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archflow-state-atomic-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function resolved(absolute: string, pathClass: PathClass): ResolvedPath {
  return Object.freeze({
    path_class: pathClass,
    repositoryRelative: ".archflow/tasks/demo/target" as RepositoryPathClaim,
    absolute: absolute as ResolvedTaskPath,
  });
}

async function atomicFailure(promise: Promise<unknown>): Promise<AtomicReplaceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AtomicReplaceError);
    return error as AtomicReplaceError;
  }
  throw new Error("expected AtomicReplaceError");
}

describe("createAtomicWriter.createExclusive", () => {
  it("fsyncs a same-directory temporary file and links the complete bytes without leftovers", async () => {
    const root = await temporaryRoot();
    const intents = join(root, "intents");
    await mkdir(intents);
    const target = join(intents, "intent-1.json");
    const bytes = new TextEncoder().encode('{"schema_version":"1"}\n');

    await expect(createAtomicWriter().createExclusive(resolved(target, "intent"), bytes)).resolves.toBe(
      "created",
    );
    expect(await readFile(target)).toEqual(Buffer.from(bytes));
    expect(await readdir(intents)).toEqual(["intent-1.json"]);
  });

  it("returns exists without overwriting the immutable target and cleans its own temp", async () => {
    const root = await temporaryRoot();
    const intents = join(root, "intents");
    await mkdir(intents);
    const target = join(intents, "intent-1.json");
    await writeFile(target, "original");

    await expect(
      createAtomicWriter().createExclusive(
        resolved(target, "intent"),
        new TextEncoder().encode("replacement"),
      ),
    ).resolves.toBe("exists");
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readdir(intents)).toEqual(["intent-1.json"]);
  });

  it("rejects a class mismatch before touching the filesystem", async () => {
    const root = await temporaryRoot();
    const target = join(root, "state.json");

    await expect(
      createAtomicWriter().createExclusive(resolved(target, "task-state"), new Uint8Array([1])),
    ).rejects.toThrow(TypeError);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports pre-link failures as uncommitted and removes only its known temp", async () => {
    const root = await temporaryRoot();
    const missingParent = join(root, "missing", "intents");
    const target = join(missingParent, "intent-1.json");

    const error = await atomicFailure(
      createAtomicWriter().createExclusive(resolved(target, "intent"), new Uint8Array([1])),
    );
    expect(error).toMatchObject({
      operation: "create-exclusive",
      target_may_have_changed: false,
      collision: false,
    });
    expect(await readdir(root)).toEqual([]);
  });
});

describe("createAtomicWriter.replace", () => {
  it("atomically replaces only task-state paths without exposing partial reader bytes", async () => {
    const root = await temporaryRoot();
    const target = join(root, "state.json");
    const before = Buffer.alloc(512 * 1024, 0x61);
    const after = Buffer.alloc(512 * 1024, 0x62);
    await writeFile(target, before);

    const replacement = createAtomicWriter().replace(resolved(target, "task-state"), after);
    const observed: Buffer[] = [];
    while (true) {
      observed.push(await readFile(target));
      const settled = await Promise.race([
        replacement.then(() => true),
        new Promise<false>((resolve) => setImmediate(() => resolve(false))),
      ]);
      if (settled) break;
    }
    await replacement;

    expect(await readFile(target)).toEqual(after);
    expect(observed.every((bytes) => bytes.equals(before) || bytes.equals(after))).toBe(true);
  });

  it("rejects non-state classes before I/O", async () => {
    const root = await temporaryRoot();
    const target = join(root, "intent.json");

    await expect(
      createAtomicWriter().replace(resolved(target, "intent"), new Uint8Array([1])),
    ).rejects.toThrow(TypeError);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks package-level replacement failures as potentially ambiguous but never collisions", async () => {
    const root = await temporaryRoot();
    const target = join(root, "missing", "state.json");

    const error = await atomicFailure(
      createAtomicWriter().replace(resolved(target, "task-state"), new Uint8Array([1])),
    );
    expect(error).toMatchObject({
      operation: "replace",
      target_may_have_changed: true,
      collision: false,
    });
  });
});
