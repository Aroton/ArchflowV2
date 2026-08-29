import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseGitOid } from "../../src/contracts/canonical.js";
import {
  parseSafeCode,
  parseSafeInteger,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import {
  authenticateRuleAcceptancePolicy,
  SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2,
  SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3,
  assertResolvedConstitution,
  detectTaskLocalConstitutionEdit,
  resolvePinnedConstitution,
} from "../../src/state/constitution.js";
import { acceptedNoWaitSettlement } from "../../src/state/restart-authority.js";
import type { RuleSettlementV1, TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";

const roots: string[] = [];
const context: RepositoryOperationContext = {
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: "phase-impl-14" as RepositoryOperationContext["phase_instance"],
  operation: parseSafeCode("constitution-test"),
  attempt: parseSafeInteger(1),
};
const rule = (id: string, version = 1): string =>
  `---\nid: ${id}\nversion: ${version}\nstatus: active\n---\n${id} rule\n`;

function supportedRuleSource(id: string, override: Partial<{
  text: string;
  review_trigger: string;
  enforced_by: readonly string[];
}> = {}, profileEntries = SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3): string {
  const profile = profileEntries.find((candidate) => candidate.id === id);
  if (profile === undefined) throw new Error(`unsupported test rule ${id}`);
  const enforcedBy = override.enforced_by ?? profile.enforced_by;
  const reviewTrigger = override.review_trigger ?? profile.review_trigger;
  return [
    "---",
    `id: ${profile.id}`,
    `version: ${profile.version}`,
    `status: ${profile.status}`,
    ...(reviewTrigger === "" ? [] : [`review_trigger: ${reviewTrigger}`]),
    ...(enforcedBy.length === 0 ? [] : ["enforced_by:", ...enforcedBy.map((entry) => `  - ${entry}`)]),
    "---",
    override.text ?? profile.text,
    "",
  ].join("\n");
}

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
}

async function repository(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), "archflow-state-constitution-"));
  roots.push(root);
  git(root, "init", "-q");
  mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, ".archflow", "constitution", name), source);
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error(discovered.error.code);
  return { root, runner: discovered.value, base: parseGitOid(git(root, "rev-parse", "HEAD")) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pinned constitution", () => {
  it("mints exact supported-v3 authority and refuses v1, divergent semantics, and plain objects", async () => {
    const exact = await repository({
      "00-process.md": supportedRuleSource("explicit-human-authority"),
      "10-architecture.md": supportedRuleSource("approved-design-before-code"),
    });
    const resolved = await resolvePinnedConstitution(exact.runner, exact.base, context);
    if (!resolved.ok) throw new Error(resolved.error.code);
    const state = {
      task_id: parseTaskSlug("policy-task"),
      policy_base_commit: exact.base,
      constitution_digest: resolved.value.digest,
    } as TaskStateV1;
    const policy = authenticateRuleAcceptancePolicy(state, resolved.value);
    expect(policy).toMatchObject({
      task_id: state.task_id,
      policy_base_commit: state.policy_base_commit,
      constitution_digest: state.constitution_digest,
    });

    const wrongDigest = { ...state, constitution_digest: parseSha256Digest("f".repeat(64)) } as TaskStateV1;
    expect(authenticateRuleAcceptancePolicy(wrongDigest, resolved.value)).toBeUndefined();
    expect(authenticateRuleAcceptancePolicy({
      ...state, policy_base_commit: parseGitOid("e".repeat(40)),
    } as TaskStateV1, resolved.value)).toBeUndefined();

    const v1 = await repository({
      "00-process.md": rule("explicit-human-authority"),
      "10-architecture.md": rule("approved-design-before-code"),
    });
    const v1Resolved = await resolvePinnedConstitution(v1.runner, v1.base, context);
    if (!v1Resolved.ok) throw new Error(v1Resolved.error.code);
    expect(authenticateRuleAcceptancePolicy({
      ...state, policy_base_commit: v1.base, constitution_digest: v1Resolved.value.digest,
    } as TaskStateV1, v1Resolved.value)).toBeUndefined();

    const divergentProcessRules = [
      supportedRuleSource("explicit-human-authority", { text: "Divergent v3 semantics." }),
      supportedRuleSource("explicit-human-authority", { review_trigger: "A repository-declared human gate." }),
      supportedRuleSource("explicit-human-authority", { enforced_by: ["different-enforcer"] }),
      supportedRuleSource("explicit-human-authority").replace("version: 3", "version: 4"),
    ];
    for (const processRule of divergentProcessRules) {
      const divergent = await repository({
        "00-process.md": processRule,
        "10-architecture.md": supportedRuleSource("approved-design-before-code"),
      });
      const divergentResolved = await resolvePinnedConstitution(divergent.runner, divergent.base, context);
      if (!divergentResolved.ok) throw new Error(divergentResolved.error.code);
      expect(authenticateRuleAcceptancePolicy({
        ...state, policy_base_commit: divergent.base, constitution_digest: divergentResolved.value.digest,
      } as TaskStateV1, divergentResolved.value)).toBeUndefined();
    }

    expect(() => acceptedNoWaitSettlement(
      { task_id: state.task_id, policy_base_commit: exact.base, constitution_digest: resolved.value.digest } as never,
      state, parseSha256Digest("a".repeat(64)), parsePhaseInstanceId("design"),
    )).toThrow(/authenticated rule acceptance policy/u);
  });

  it("still mints settlement authority for a task pinned to the earlier supported v2 profile", async () => {
    const pinnedV2 = await repository({
      "00-process.md": supportedRuleSource("explicit-human-authority", {}, SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2),
      "10-architecture.md": supportedRuleSource("approved-design-before-code", {}, SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2),
    });
    const resolved = await resolvePinnedConstitution(pinnedV2.runner, pinnedV2.base, context);
    if (!resolved.ok) throw new Error(resolved.error.code);
    const state = {
      task_id: parseTaskSlug("policy-task"),
      policy_base_commit: pinnedV2.base,
      constitution_digest: resolved.value.digest,
    } as TaskStateV1;
    expect(authenticateRuleAcceptancePolicy(state, resolved.value)).toMatchObject({
      task_id: state.task_id,
      policy_base_commit: state.policy_base_commit,
    });

    const mixed = await repository({
      "00-process.md": supportedRuleSource("explicit-human-authority", {}, SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2),
      "10-architecture.md": supportedRuleSource("approved-design-before-code"),
    });
    const mixedResolved = await resolvePinnedConstitution(mixed.runner, mixed.base, context);
    if (!mixedResolved.ok) throw new Error(mixedResolved.error.code);
    expect(authenticateRuleAcceptancePolicy({
      ...state, policy_base_commit: mixed.base, constitution_digest: mixedResolved.value.digest,
    } as TaskStateV1, mixedResolved.value)).toBeUndefined();
  });

  it("selects only the latest restart-eligible no-wait settlement through authenticated policy", async () => {
    const repo = await repository({
      "00-process.md": supportedRuleSource("explicit-human-authority"),
      "10-architecture.md": supportedRuleSource("approved-design-before-code"),
    });
    const resolved = await resolvePinnedConstitution(repo.runner, repo.base, context);
    if (!resolved.ok) throw new Error(resolved.error.code);
    const digest = parseSha256Digest("a".repeat(64));
    const settlement = (revision: number, wait: boolean): RuleSettlementV1 => ({
      task_id: parseTaskSlug("policy-task"),
      phase_instance: parsePhaseInstanceId("design"),
      step: "triage",
      subject_digest: digest,
      conclusion: wait
        ? { wait: true, match: { kind: "subject", subject: "design" } }
        : { wait: false, match: null },
      config_digest: parseSha256Digest("b".repeat(64)),
      ...(wait ? {} : { milestone_baseline_commit: repo.base }),
      settled_at_revision: parseSafeInteger(revision),
    });
    const baseState = {
      task_id: parseTaskSlug("policy-task"),
      policy_base_commit: repo.base,
      constitution_digest: resolved.value.digest,
      rule_settlements: [settlement(3, false), settlement(5, true)],
      restart_history: [],
    } as unknown as TaskStateV1;
    const policy = authenticateRuleAcceptancePolicy(baseState, resolved.value);
    if (policy === undefined) throw new Error("exact policy was not authenticated");

    expect(acceptedNoWaitSettlement(policy, baseState, digest, parsePhaseInstanceId("design"))).toBeUndefined();
    expect(acceptedNoWaitSettlement(policy, {
      ...baseState,
      rule_settlements: [settlement(3, true), settlement(5, false)],
    }, digest, parsePhaseInstanceId("design"))?.settled_at_revision).toBe(5);
    expect(acceptedNoWaitSettlement(policy, baseState, digest, parsePhaseInstanceId("prd"))).toBeUndefined();
    expect(acceptedNoWaitSettlement(policy, {
      ...baseState,
      rule_settlements: [settlement(5, false)],
      restart_history: [{ target_phase_instance: parsePhaseInstanceId("prd"), restarted_at_revision: 6 }],
    } as unknown as TaskStateV1, digest, parsePhaseInstanceId("design"))).toBeUndefined();
  });

  it("reads only numbered rules from the immutable tree and ignores worktree edits", async () => {
    const repo = await repository({
      "00-process.md": rule("process"),
      "10-data.md": rule("data"),
      "README.md": "human notes\n",
    });
    const before = await resolvePinnedConstitution(repo.runner, repo.base, context);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect([...before.value.rules.keys()]).toEqual(["process", "data"]);
    expect(before.value.files.map((file) => file.path)).toEqual([
      ".archflow/constitution/00-process.md",
      ".archflow/constitution/10-data.md",
    ]);

    writeFileSync(join(repo.root, ".archflow", "constitution", "00-process.md"), rule("changed"));
    const after = await resolvePinnedConstitution(repo.runner, repo.base, context);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.digest).toBe(before.value.digest);
    expect([...after.value.rules]).toEqual([...before.value.rules]);
    expect(after.value.files).toEqual(before.value.files);
    expect(() => assertResolvedConstitution({
      ...before.value,
    } as never)).toThrow(/authentic resolved constitution/u);
    expect(() => (before.value.rules as Map<string, unknown>).set("forged", {}))
      .toThrow();
    expect(() => (before.value.files as unknown[]).push({}))
      .toThrow();
  });

  it("classifies an empty pinned rule registry as POLICY_BASE_INVALID", async () => {
    const repo = await repository({ "README.md": "notes only\n" });
    const result = await resolvePinnedConstitution(repo.runner, repo.base, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("POLICY_BASE_INVALID");
  });

  it("detects uncommitted README changes and committed rule changes", async () => {
    const repo = await repository({
      "00-process.md": rule("process"),
      "README.md": "notes\n",
    });
    const pinned = await resolvePinnedConstitution(repo.runner, repo.base, context);
    if (!pinned.ok) throw new Error(pinned.error.code);

    writeFileSync(join(repo.root, ".archflow", "constitution", "README.md"), "changed notes\n");
    const uncommitted = await detectTaskLocalConstitutionEdit(
      repo.runner,
      repo.base,
      pinned.value.digest,
      context,
    );
    expect(uncommitted.ok && uncommitted.value?.current_constitution_digest)
      .toBe(pinned.value.digest);

    git(repo.root, "add", ".");
    git(repo.root, "commit", "-qm", "readme edit");
    writeFileSync(join(repo.root, ".archflow", "constitution", "00-process.md"), rule("process", 2));
    git(repo.root, "add", ".");
    git(repo.root, "commit", "-qm", "rule edit");
    const committed = await detectTaskLocalConstitutionEdit(
      repo.runner,
      repo.base,
      pinned.value.digest,
      context,
    );
    expect(committed.ok && committed.value).toMatchObject({
      pinned_constitution_digest: pinned.value.digest,
      changed_path_class: "task-branch-constitution",
    });
    expect(committed.ok && committed.value?.current_constitution_digest)
      .not.toBe(pinned.value.digest);
  });

  it.each([
    ["deletion", undefined],
    ["malformed rule", "---\nid: broken\nnot: valid: yaml\n"],
  ])("opens the edit gate for a committed %s without parsing the HEAD registry", async (_label, source) => {
    const repo = await repository({ "00-process.md": rule("process") });
    const pinned = await resolvePinnedConstitution(repo.runner, repo.base, context);
    if (!pinned.ok) throw new Error(pinned.error.code);
    const path = join(repo.root, ".archflow", "constitution", "00-process.md");
    if (source === undefined) {
      git(repo.root, "rm", "-q", ".archflow/constitution/00-process.md");
    } else {
      writeFileSync(path, source);
      git(repo.root, "add", ".archflow/constitution/00-process.md");
    }
    git(repo.root, "commit", "-qm", "invalid task-local constitution edit");

    const detected = await detectTaskLocalConstitutionEdit(
      repo.runner,
      repo.base,
      pinned.value.digest,
      context,
    );
    expect(detected.ok && detected.value).toMatchObject({
      pinned_constitution_digest: pinned.value.digest,
      changed_path_class: "task-branch-constitution",
    });
    expect(detected.ok && detected.value?.current_constitution_digest)
      .not.toBe(pinned.value.digest);
  });
});
