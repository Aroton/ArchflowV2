import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { repositoryCandidateDigest } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import {
  createGitRunner,
  GitInvocationError,
  preflightGit,
  projectErrorForGitFailure,
  readGitBlobBytes,
  type GitCommandSpec,
  type GitRunner,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";

const temporaryRoots: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();

const context: RepositoryOperationContext = {
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: encodePhaseInstance({
    kind: "phase-design",
    phase: parsePositiveSafePhaseNumber(6),
  }),
  operation: parseSafeCode("startup-check"),
  attempt: parseSafeInteger(2),
};

const operation = parseSafeCode("git-probe");

/** A runner whose "git" is /bin/sh, so any exit status, stream, or delay can be produced exactly. */
function shellRunner(overrides: { readonly timeoutMs?: number; readonly maxBuffer?: number } = {}): GitRunner {
  return createGitRunner({ cwd: temporaryRoots[0] ?? tmpdir(), gitPath: "/bin/sh", ...overrides });
}

function script(source: string, extra: Partial<GitCommandSpec> = {}): GitCommandSpec {
  return { argv: ["-c", source], operation, ...extra };
}

async function captureFailure(promise: Promise<unknown>): Promise<GitInvocationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitInvocationError);
    return error as GitInvocationError;
  }
  throw new Error("expected a GitInvocationError");
}

/** Runs one spec through all three methods and reports how each behaved. */
async function allThree(
  runner: GitRunner,
  spec: GitCommandSpec
): Promise<
  | { readonly outcome: "threw"; readonly kinds: readonly string[] }
  | {
      readonly outcome: "returned";
      readonly absent: boolean;
      readonly text: string;
      readonly fields: readonly string[];
    }
> {
  const settled = await Promise.allSettled([
    runner.run(spec),
    runner.runText(spec),
    runner.runNulFields(spec),
  ]);
  const rejected = settled.filter((entry) => entry.status === "rejected");
  if (rejected.length > 0) {
    expect(rejected).toHaveLength(3);
    return {
      outcome: "threw",
      kinds: rejected.map((entry) => (entry.reason as GitInvocationError).kind),
    };
  }
  const [first, second, third] = settled as [
    PromiseFulfilledResult<Awaited<ReturnType<GitRunner["run"]>>>,
    PromiseFulfilledResult<string>,
    PromiseFulfilledResult<readonly string[]>,
  ];
  return {
    outcome: "returned",
    absent: first.value.absent,
    text: second.value,
    fields: [...third.value],
  };
}

describe("createGitRunner: spawn failures", () => {
  it("reports a missing git binary as not-installed and REPOSITORY_NOT_FOUND", async () => {
    const cwd = temporaryDirectory("archflow-git-missing-");
    const runner = createGitRunner({ cwd, gitPath: join(cwd, "no-such-git") });
    const result = await allThree(runner, { argv: ["--version"], operation });
    expect(result).toEqual({ outcome: "threw", kinds: ["not-installed", "not-installed", "not-installed"] });

    const failure = await captureFailure(runner.run({ argv: ["--version"], operation }));
    expect(failure.kind).toBe("not-installed");
    expect(failure.operation).toBe(operation);
    expect(failure.argv).toEqual(["--version"]);

    const error = projectErrorForGitFailure(failure, runner, context);
    expect(error.code).toBe("REPOSITORY_NOT_FOUND");
    expect(error.diagnostic.parameters).toEqual({
      repository_candidate_digest: repositoryCandidateDigest(runner.cwd),
    });
  });

  it("reports a non-executable git as not-executable and REPOSITORY_NOT_FOUND", async () => {
    const cwd = temporaryDirectory("archflow-git-eacces-");
    const gitPath = join(cwd, "git");
    writeFileSync(gitPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const runner = createGitRunner({ cwd, gitPath });

    const result = await allThree(runner, { argv: ["--version"], operation });
    expect(result).toEqual({ outcome: "threw", kinds: ["not-executable", "not-executable", "not-executable"] });

    const failure = await captureFailure(runner.runText({ argv: ["--version"], operation }));
    expect(failure.kind).toBe("not-executable");
    const error = projectErrorForGitFailure(failure, runner, context);
    expect(error.code).toBe("REPOSITORY_NOT_FOUND");
    expect(error.diagnostic.parameters).toEqual({
      repository_candidate_digest: repositoryCandidateDigest(runner.cwd),
    });
  });
});

describe("createGitRunner: resource limits", () => {
  it("classifies a run past timeoutMs as timeout and IO_ERROR", async () => {
    temporaryDirectory("archflow-git-timeout-");
    const runner = shellRunner({ timeoutMs: 100 });
    const spec = script("sleep 5");

    const result = await allThree(runner, spec);
    expect(result).toEqual({ outcome: "threw", kinds: ["timeout", "timeout", "timeout"] });

    const failure = await captureFailure(runner.run(spec));
    expect(failure.kind).toBe("timeout");
    const error = projectErrorForGitFailure(failure, runner, context);
    expect(error.code).toBe("IO_ERROR");
    expect(error.diagnostic.parameters).toEqual({ operation: context.operation, attempt: context.attempt });
  });

  it("classifies a run past maxBuffer as output-overflow and IO_ERROR", async () => {
    temporaryDirectory("archflow-git-overflow-");
    const runner = shellRunner({ maxBuffer: 8 });
    const spec = script("i=0; while [ $i -lt 200 ]; do echo aaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done");

    const result = await allThree(runner, spec);
    expect(result).toEqual({
      outcome: "threw",
      kinds: ["output-overflow", "output-overflow", "output-overflow"],
    });

    const failure = await captureFailure(runner.runNulFields(spec));
    expect(failure.kind).toBe("output-overflow");
    expect(projectErrorForGitFailure(failure, runner, context).code).toBe("IO_ERROR");
  });
});

describe("createGitRunner: caller-declared absence", () => {
  it("throws command-failed on an undeclared nonzero exit", async () => {
    temporaryDirectory("archflow-git-nonzero-");
    const runner = shellRunner();
    const spec = script("echo 'fatal: some other problem' 1>&2; exit 1");

    const result = await allThree(runner, spec);
    expect(result).toEqual({
      outcome: "threw",
      kinds: ["command-failed", "command-failed", "command-failed"],
    });

    const failure = await captureFailure(runner.run(spec));
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("some other problem");
    const error = projectErrorForGitFailure(failure, runner, context);
    expect(error.code).toBe("IO_ERROR");
    expect(error.diagnostic.parameters).toEqual({ operation: context.operation, attempt: context.attempt });
  });

  it("treats exit 128 with a dubious-ownership diagnostic as a failure, never as absence", async () => {
    temporaryDirectory("archflow-git-dubious-");
    const runner = shellRunner();
    // The command declares absence for a *different* 128 diagnostic; ownership must not match it.
    const spec = script(
      "echo \"fatal: detected dubious ownership in repository at '/repo'\" 1>&2; exit 128",
      { expectedAbsence: [{ code: 128, stderrIncludes: "unknown revision or path not in the working tree" }] }
    );

    const result = await allThree(runner, spec);
    expect(result).toEqual({
      outcome: "threw",
      kinds: ["command-failed", "command-failed", "command-failed"],
    });

    const failure = await captureFailure(runner.run(spec));
    expect(failure.kind).toBe("command-failed");
    expect(failure.code).toBe(128);
    const error = projectErrorForGitFailure(failure, runner, context);
    expect(error.code).toBe("IO_ERROR");
    expect(error.diagnostic.parameters).toEqual({ operation: context.operation, attempt: context.attempt });
  });

  it("treats exit 128 matching a declared expectedAbsence as absence", async () => {
    temporaryDirectory("archflow-git-absent-");
    const runner = shellRunner();
    const spec = script(
      "echo \"fatal: bad revision 'x': unknown revision or path not in the working tree\" 1>&2; exit 128",
      { expectedAbsence: [{ code: 128, stderrIncludes: "unknown revision or path not in the working tree" }] }
    );

    const result = await allThree(runner, spec);
    expect(result).toEqual({ outcome: "returned", absent: true, text: "", fields: [] });
    expect((await runner.run(spec)).code).toBe(128);
  });

  it("requires both the exact code and the diagnostic to match", async () => {
    temporaryDirectory("archflow-git-partial-");
    const runner = shellRunner();
    const wrongCode = script("echo 'unknown revision' 1>&2; exit 1", {
      expectedAbsence: [{ code: 128, stderrIncludes: "unknown revision" }],
    });
    const wrongDiagnostic = script("echo 'something else' 1>&2; exit 128", {
      expectedAbsence: [{ code: 128, stderrIncludes: "unknown revision" }],
    });

    expect((await captureFailure(runner.run(wrongCode))).kind).toBe("command-failed");
    expect((await captureFailure(runner.run(wrongDiagnostic))).kind).toBe("command-failed");
  });
});

describe("createGitRunner: success decoding", () => {
  it("strips exactly one trailing LF in runText", async () => {
    temporaryDirectory("archflow-git-text-");
    const runner = shellRunner();
    expect(await runner.runText(script("printf 'sha1\\n'"))).toBe("sha1");
    expect(await runner.runText(script("printf 'sha1\\n\\n'"))).toBe("sha1\n");
    expect(await runner.runText(script("printf 'sha1'"))).toBe("sha1");
    expect(await runner.runText(script("printf ''"))).toBe("");
    expect((await runner.run(script("printf 'sha1\\n'"))).absent).toBe(false);
  });

  it("drops only the trailing empty NUL field and never interprets tabs", async () => {
    temporaryDirectory("archflow-git-nul-");
    const runner = shellRunner();
    expect(await runner.runNulFields(script("printf 'a\\0b\\0'"))).toEqual(["a", "b"]);
    expect(await runner.runNulFields(script("printf 'a\\0b'"))).toEqual(["a", "b"]);
    expect(await runner.runNulFields(script("printf 'a\\0\\0b\\0'"))).toEqual(["a", "", "b"]);
    expect(await runner.runNulFields(script("printf ''"))).toEqual([]);
    expect(await runner.runNulFields(script("printf '100644 abc 0\\tsome\\tpath\\0'"))).toEqual([
      "100644 abc 0\tsome\tpath",
    ]);
  });

  it("rejects invalid UTF-8 in both decoding methods", async () => {
    temporaryDirectory("archflow-git-utf8-");
    const runner = shellRunner();
    const spec = script("printf '\\377\\376'");
    await expect(runner.runText(spec)).rejects.toThrow(/not valid UTF-8/u);
    await expect(runner.runNulFields(spec)).rejects.toThrow(/not valid UTF-8/u);
    // `run` is byte-transparent: the same output is returned without decoding.
    expect(Array.from((await runner.run(spec)).stdout)).toEqual([0xff, 0xfe]);
  });
});

describe("preflightGit", () => {
  it("rejects a git below the ~2.25 floor without probing the object format", async () => {
    temporaryDirectory("archflow-git-old-");
    const runner = shellRunner();
    const stub: GitRunner = {
      cwd: runner.cwd,
      run: runner.run,
      runNulFields: runner.runNulFields,
      runText: async (spec) =>
        spec.argv[0] === "--version"
          ? "git version 2.24.0"
          : await Promise.reject(new Error("object format must not be probed below the floor")),
    };
    const result = await preflightGit(stub, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RUNTIME_VERSION_UNSUPPORTED");
    expect(result.error.diagnostic.parameters).toEqual({ component: "git", version: "2.24.0" });
  });

  it("fails closed on a sha256 object format", async () => {
    temporaryDirectory("archflow-git-sha256-");
    const runner = shellRunner();
    const stub: GitRunner = {
      cwd: runner.cwd,
      run: runner.run,
      runNulFields: runner.runNulFields,
      runText: async (spec) =>
        Promise.resolve(spec.argv[0] === "--version" ? "git version 2.43.0" : "sha256"),
    };
    const result = await preflightGit(stub, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RUNTIME_VERSION_UNSUPPORTED");
    expect(result.error.diagnostic.parameters).toEqual({
      component: "git-object-format",
      version: "sha256",
    });
  });

  it("translates a runner failure into the failure map rather than throwing", async () => {
    const cwd = temporaryDirectory("archflow-git-preflight-missing-");
    const runner = createGitRunner({ cwd, gitPath: join(cwd, "no-such-git") });
    const result = await preflightGit(runner, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
    expect(result.error.diagnostic.parameters).toEqual({
      repository_candidate_digest: repositoryCandidateDigest(runner.cwd),
    });
  });

  it.skipIf(!hasGit)("accepts a healthy sha1 repository", async () => {
    const cwd = temporaryDirectory("archflow-git-real-");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", "."], { cwd });
    const runner = createGitRunner({ cwd });
    const result = await preflightGit(runner, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.object_format).toBe("sha1");
    expect(result.value.version).toMatch(/^[A-Za-z0-9.-]{1,64}$/u);
  });

  it.skipIf(!hasGit)("throws command-failed for a real undeclared git failure", async () => {
    const cwd = temporaryDirectory("archflow-git-real-fail-");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", "."], { cwd });
    const runner = createGitRunner({ cwd });
    const failure = await captureFailure(
      runner.runText({ argv: ["rev-parse", "--verify", "refs/heads/does-not-exist"], operation })
    );
    expect(failure.kind).toBe("command-failed");
    expect(failure.code).toBe(128);
    expect(projectErrorForGitFailure(failure, runner, context).code).toBe("IO_ERROR");
  });
});

describe("readGitBlobBytes", () => {
  it("reports an over-limit blob as the bounded-size TypeError, not a git failure", async () => {
    const runner = shellRunner();
    const oid = "a".repeat(40);
    const stub: GitRunner = {
      cwd: runner.cwd,
      runText: runner.runText,
      runNulFields: runner.runNulFields,
      run: async (spec) => {
        expect(spec.argv).toEqual(["cat-file", "blob", oid]);
        throw new GitInvocationError({ kind: "output-overflow", operation: spec.operation, argv: spec.argv });
      },
    };
    await expect(readGitBlobBytes(stub, oid)).rejects.toThrow(/exceeds the bounded result-byte limit/u);
  });

  it("rejects a malformed object id before spawning anything", async () => {
    const runner = shellRunner();
    const stub: GitRunner = {
      ...runner,
      run: async () => Promise.reject(new Error("must not spawn")),
    };
    await expect(readGitBlobBytes(stub, "not-an-oid")).rejects.toThrow(/object id is invalid/u);
  });
});
