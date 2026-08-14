import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { OutputEntry } from "../../src/contracts/durable-primitives.js";
import {
  parseSafeId,
  parseSafeInteger,
  parseSha256Digest,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import {
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  type TaskPathClaim,
} from "../../src/contracts/path-claims.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { createGitRunner, hashGitBlobIdentity, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import { classifyRepositoryPath } from "../../src/repository/paths.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import {
  buildDocumentArtifact,
  type DocumentArtifactInput,
} from "../../src/state/document-artifact.js";
import { deriveDeclaredSnapshotDigest } from "../../src/state/snapshots.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function fixture(): Promise<Readonly<{
  root: string;
  runner: RootBoundGitRunner;
  authority: TransactionAuthority;
  input: DocumentArtifactInput;
}>> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-document-builder-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
  mkdirSync(join(root, ".archflow", "tasks", "task-1", "phases", "1"), { recursive: true });
  writeFileSync(join(root, ".gitattributes"), ".archflow/** -text merge=binary\n");
  writeFileSync(join(root, "source.txt"), "source bytes\n");
  writeFileSync(join(root, ".archflow", "tasks", "task-1", "prd.md"), "prd input\n");
  writeFileSync(join(root, ".archflow", "tasks", "task-1", "design.md"), "architecture v2\n");
  writeFileSync(join(root, ".archflow", "tasks", "task-1", "phases", "1", "design.md"), "design v1\n");
  execFileSync("git", ["add", "--", ".gitattributes", "source.txt", ".archflow/tasks/task-1/prd.md", ".archflow/tasks/task-1/design.md", ".archflow/tasks/task-1/phases/1/design.md"], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root, env });

  const taskId = parseTaskSlug("task-1");
  const context: RepositoryOperationContext = {
    task_id: taskId,
    phase_instance: "phase-design-1" as RepositoryOperationContext["phase_instance"],
    operation: "build-document-test" as RepositoryOperationContext["operation"],
    attempt: parseSafeInteger(1),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw discovered.error;
  const preflight = await preflightGit(discovered.value, context);
  if (!preflight.ok) throw preflight.error;
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: preflight.value,
    task_id: taskId,
    context,
  });
  if (!authority.ok) throw authority.error;
  return Object.freeze({
    root,
    runner: discovered.value,
    authority: authority.value,
    input: Object.freeze({
      phase_instance: context.phase_instance,
      step: "produce",
      document_path: parseTaskPathClaim("phases/1/design.md"),
      declared_inputs: Object.freeze([]),
      input_fingerprint: parseSha256Digest("f".repeat(64)),
    }),
  });
}

async function expectedSnapshot(
  runner: RootBoundGitRunner,
  path: ReturnType<typeof parseRepositoryPathClaim>,
  bytes: Uint8Array,
): Promise<ReturnType<typeof deriveDeclaredSnapshotDigest>> {
  const digest = sha256Bytes(bytes);
  const identity = await hashGitBlobIdentity(runner, bytes, path);
  const output: OutputEntry = {
    path,
    path_class: "document",
    operation: "add",
    storage: "raw-payload",
    payload_bytes: parseSafeInteger(bytes.byteLength),
    payload_digest: digest,
    file_type: "regular",
    after: {
      oid: parseGitOid(identity.oid),
      mode: "100644",
      size_bytes: parseSafeInteger(identity.size_bytes),
    },
  };
  return deriveDeclaredSnapshotDigest([output], [{ path, content_digest: digest }]);
}

describe("document artifact builder", () => {
  it("derives sorted declared-input digests from repository- and task-frame bytes", async () => {
    const built = await fixture();
    const source = parseRepositoryPathClaim("source.txt");
    expect(classifyRepositoryPath(source)).toMatchObject({ ok: true, value: "repository-source" });

    const result = await buildDocumentArtifact(built.runner, built.authority, {
      ...built.input,
      declared_inputs: [
        { input_id: parseSafeId("source-z"), path: source },
        {
          input_id: parseSafeId("prd-a"),
          path: parseRepositoryPathClaim(".archflow/tasks/task-1/prd.md"),
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        task_id: "task-1",
        document_path: "phases/1/design.md",
        projection_target: ".archflow/tasks/task-1/phases/1/design.md",
        declared_inputs: [
          { input_id: "prd-a", digest: sha256Bytes(Buffer.from("prd input\n")) },
          { input_id: "source-z", digest: sha256Bytes(Buffer.from("source bytes\n")) },
        ],
      },
    });
  });

  it("builds a valid zero-byte document artifact", async () => {
    const built = await fixture();
    writeFileSync(join(built.root, ".archflow", "tasks", "task-1", "phases", "1", "design.md"), "");
    const result = await buildDocumentArtifact(built.runner, built.authority, built.input);
    expect(result).toMatchObject({
      ok: true,
      value: {
        byte_count: 0,
        content_digest: sha256Bytes(new Uint8Array()),
      },
    });
  });

  it("binds sorted companion identities into the compound snapshot", async () => {
    const built = await fixture();
    const result = await buildDocumentArtifact(built.runner, built.authority, {
      ...built.input,
      additional_document_paths: [
        parseTaskPathClaim("prd.md"),
        parseTaskPathClaim("design.md"),
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        additional_documents: [
          {
            document_path: "design.md",
            byte_count: Buffer.byteLength("architecture v2\n"),
            content_digest: sha256Bytes(Buffer.from("architecture v2\n")),
            projection_target: ".archflow/tasks/task-1/design.md",
          },
          {
            document_path: "prd.md",
            byte_count: Buffer.byteLength("prd input\n"),
            content_digest: sha256Bytes(Buffer.from("prd input\n")),
            projection_target: ".archflow/tasks/task-1/prd.md",
          },
        ],
      },
    });
    if (!result.ok) return;
    const primaryOnly = await expectedSnapshot(
      built.runner,
      parseRepositoryPathClaim(".archflow/tasks/task-1/phases/1/design.md"),
      Buffer.from("design v1\n"),
    );
    expect(result.value.snapshot_digest).not.toBe(primaryOnly);
  });

  it("rejects a task path outside the canonical document class", async () => {
    const built = await fixture();
    const result = await buildDocumentArtifact(built.runner, built.authority, {
      ...built.input,
      document_path: "phases/1/notes.md" as TaskPathClaim,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "PATH_INVALID" } });
  });

  it("observes revised bytes from an already-existing document and retains the literal add snapshot", async () => {
    const built = await fixture();
    const revised = Buffer.from("design v2\n");
    writeFileSync(join(built.root, ".archflow", "tasks", "task-1", "phases", "1", "design.md"), revised);

    const result = await buildDocumentArtifact(built.runner, built.authority, built.input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const projection = parseRepositoryPathClaim(".archflow/tasks/task-1/phases/1/design.md");
    expect(result.value.content_digest).toBe(sha256Bytes(revised));
    expect(result.value.snapshot_digest).toBe(await expectedSnapshot(built.runner, projection, revised));
  });
});
