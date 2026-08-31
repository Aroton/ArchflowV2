import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonBytes } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import {
  createRetainedChildOutputStore,
  type RetainedChildOutputBinding,
} from "../../src/dispatch/retained-child-output.js";
import type { SelectedDispatchRoute } from "../../src/dispatch/routing.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createProjectionWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const phase = parsePhaseInstanceId("phase-impl-2");

async function fixture(attempt = 1) {
  const root = mkdtempSync(join(tmpdir(), "archflow-retained-output-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnvironment });
  writeFileSync(join(root, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, env: gitEnvironment });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env: gitEnvironment });
  mkdirSync(join(root, ".archflow"));
  const taskId = parseTaskSlug("retained-output");
  const context = {
    task_id: taskId,
    phase_instance: phase,
    operation: parseSafeCode("retained-output-test"),
    attempt: parseSafeInteger(attempt),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw discovered.error;
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw environment.error;
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value, environment: environment.value, task_id: taskId, context,
  });
  if (!authority.ok) throw authority.error;
  const dependencies = {
    runner: discovered.value,
    environment: environment.value,
    projection_writer: createProjectionWriter(),
  } as TransactionDependencies;
  const store = createRetainedChildOutputStore({
    authority: authority.value, dependencies, phase_instance: phase, attempt: parseSafeInteger(attempt),
  });
  if (store === undefined) throw new Error("store unavailable");
  const attemptsDirectory = join(authority.value.workspace_root, "diagnostics", "attempts", phase);
  return { root, authority: authority.value, dependencies, store, attemptsDirectory };
}

function selection(model: string, provenance: "configured" | "invocation-declared" = "configured"): SelectedDispatchRoute {
  const rawRoute = { model, effort: "high" as const };
  return {
    selected: { raw_route: rawRoute, source: { provenance } },
    route: { adapter: "codex-cli", family: "codex", model, effort: "high" },
    source: { provenance },
  };
}

const envelopeDigest = parseSha256Digest("1".repeat(64));
const otherEnvelopeDigest = parseSha256Digest("2".repeat(64));
const output = canonicalJsonBytes({ schema_version: "1", verdict: "pass" });

const binding = (overrides: Partial<RetainedChildOutputBinding> = {}): RetainedChildOutputBinding => ({
  envelope_digest: envelopeDigest,
  role: "counter-reviewer",
  selection: selection("gpt-5.6-sol"),
  ...overrides,
});

describe("retained child outputs", () => {
  it("round-trips a validated output and reads it back only for the exact binding", async () => {
    const f = await fixture();
    await f.store.write(binding(), { cli_version: "codex-cli 0.1", extracted_output_bytes: output });
    expect(readdirSync(f.attemptsDirectory).filter((name) => name.startsWith("round-"))).toHaveLength(1);

    const kept = await f.store.read(binding());
    expect(kept).toBeDefined();
    expect(kept!.cli_version).toBe("codex-cli 0.1");
    expect(Buffer.from(kept!.extracted_output_bytes).equals(Buffer.from(output))).toBe(true);

    await f.store.write(binding({ role: "effort-reviewer" }), {
      cli_version: "codex-cli 0.1", extracted_output_bytes: output,
    });
    expect(await f.store.read(binding({ role: "effort-reviewer" }))).toBeDefined();

    expect(await f.store.read(binding({ role: "adjudicator" }))).toBeUndefined();
    expect(await f.store.read(binding({ envelope_digest: otherEnvelopeDigest }))).toBeUndefined();
    expect(await f.store.read(binding({ selection: selection("claude-fable-5") }))).toBeUndefined();
    expect(await f.store.read(binding({ selection: selection("gpt-5.6-sol", "invocation-declared") }))).toBeUndefined();
  });

  it("treats a record from another attempt, or with tampered bytes, as a miss and drops it", async () => {
    const first = await fixture(1);
    await first.store.write(binding(), { cli_version: "codex-cli 0.1", extracted_output_bytes: output });
    const [name] = readdirSync(first.attemptsDirectory).filter((entry) => entry.startsWith("round-"));
    const recordPath = join(first.attemptsDirectory, name!);

    // Same workspace read under the next attempt: the record binds attempt 1 and must not serve attempt 2.
    const second = createRetainedChildOutputStore({
      authority: first.authority, dependencies: first.dependencies, phase_instance: phase, attempt: parseSafeInteger(2),
    })!;
    expect(await second.read(binding())).toBeUndefined();
    expect(existsSync(recordPath)).toBe(false);

    await first.store.write(binding(), { cli_version: "codex-cli 0.1", extracted_output_bytes: output });
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    record.output_base64 = Buffer.from('{"verdict":"fail"}').toString("base64");
    writeFileSync(recordPath, JSON.stringify(record));
    expect(await first.store.read(binding())).toBeUndefined();
    expect(existsSync(recordPath)).toBe(false);

    writeFileSync(recordPath, "not json");
    expect(await first.store.read(binding())).toBeUndefined();
    expect(existsSync(recordPath)).toBe(false);
  });

  it("discards only the records of the round that committed", async () => {
    const f = await fixture();
    await f.store.write(binding(), { cli_version: "codex-cli 0.1", extracted_output_bytes: output });
    await f.store.write(binding({ role: "adjudicator" }), { cli_version: "codex-cli 0.1", extracted_output_bytes: output });
    await f.store.write(binding({ envelope_digest: otherEnvelopeDigest }), { cli_version: "codex-cli 0.1", extracted_output_bytes: output });
    writeFileSync(join(f.attemptsDirectory, "dispatch-counter-review-1.json"), "{}");

    await f.store.discard(envelopeDigest);

    const remaining = readdirSync(f.attemptsDirectory).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("dispatch-counter-review-1.json");
    expect(remaining.some((name) => name.startsWith(`round-${otherEnvelopeDigest.slice(0, 16)}-`))).toBe(true);
    expect(await f.store.read(binding({ envelope_digest: otherEnvelopeDigest }))).toBeDefined();
  });
});
