/**
 * The reusable real task-workspace harness for focused service and integration tests.
 *
 * Test helpers normally know nothing about `src/**`, so fixture defects cannot be mistaken for
 * source defects. This is the deliberate second exception (after `resolved-constitution.ts`): it
 * builds a real initialized task capability from `src/**` and returns the production services that
 * capability authorizes.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskInitializationV1 } from "../../src/contracts/durable-task-initialization.js";
import { parseSafeCode, parseTaskSlug, type TaskSlug } from "../../src/contracts/evidence.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2 } from "../../src/state/constitution.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { createProductionServices, type ProductionServices } from "../../src/state/production.js";

export type TaskWorkspaceOptions = Readonly<{
  taskId: string;
  label?: string;
  operation?: string;
  /** Complete replacement bytes for the scaffolded `.archflow/config.yaml`. */
  configBytes?: Uint8Array;
  /**
   * Pre-initialization replacement bytes keyed by constitution filename. The helper writes these
   * before the policy-base commit, so initialization pins their real Git blobs and digest.
   */
  constitutionBytes?: Readonly<Record<string, Uint8Array>>;
  /**
   * Replacement bytes for the root-commit README. Distinct bytes give the workspace a genuinely
   * distinct repository identity (the identity digest covers the root commits); config bytes no
   * longer do, because task config is not part of the input fingerprint.
   */
  rootBytes?: Uint8Array;
}>;

function supportedRuleSource(id: string): Uint8Array {
  const profile = SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2.find((candidate) => candidate.id === id);
  if (profile === undefined) throw new Error(`unsupported rule acceptance profile entry: ${id}`);
  return new TextEncoder().encode([
    "---",
    `id: ${profile.id}`,
    `version: ${profile.version}`,
    `status: ${profile.status}`,
    `review_trigger: ${JSON.stringify(profile.review_trigger)}`,
    ...(profile.enforced_by.length === 0
      ? []
      : ["enforced_by:", ...profile.enforced_by.map((entry) => `  - ${JSON.stringify(entry)}`)]),
    "---",
    profile.text,
    "",
  ].join("\n"));
}

/** Authentic planned-v2 constitution files derived from the runtime's exact accepted profile. */
export function supportedRuleAcceptanceConstitutionV2Bytes(): Readonly<Record<string, Uint8Array>> {
  return Object.freeze({
    "00-process.md": supportedRuleSource("explicit-human-authority"),
    "10-architecture.md": supportedRuleSource("approved-design-before-code"),
  });
}

/** Explicit legacy-policy fixture for journeys whose purpose is v1's unconditional human gates. */
export function legacyHumanAuthorityConstitutionV1Bytes(): Readonly<Record<string, Uint8Array>> {
  const encoder = new TextEncoder();
  return Object.freeze({
    "00-process.md": encoder.encode(`---
id: explicit-human-authority
version: 1
status: active
review_trigger: Advancement, approval, review-gate, waiver, or commit authority is inferred rather than explicitly recorded by a human for the exact subject.
---
Required human decisions are explicit and bound to the exact artifact or code subject under review. Silence, elapsed time, agent prose, or a model verdict never supplies approval, waives a gate, authorizes a commit, or advances the workflow.
`),
    "10-architecture.md": encoder.encode(`---
id: approved-design-before-code
version: 1
status: active
review_trigger: Implementation begins before the applicable phase design is approved, or implementation materially departs from approved architecture without updating and re-reviewing its governing plan.
---
Implementation starts only from an approved phase design. The PRD, architecture, and phase design remain truthful as work proceeds; material deviations update the governing documents and re-enter the applicable review boundary before dependent work advances.
`),
  });
}

export type TaskWorkspace = Readonly<{
  root: string;
  taskId: TaskSlug;
  initialization: TaskInitializationV1;
  services: ProductionServices;
  dispose: () => void;
}>;

const GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], {
    cwd: root,
    env: GIT_ENVIRONMENT,
    encoding: "utf8",
  }).trim();
}

/** Creates a committed policy base, initializes its task, and opens production services. */
export async function createTaskWorkspace(options: TaskWorkspaceOptions): Promise<TaskWorkspace> {
  const taskId = parseTaskSlug(options.taskId);
  const operation = parseSafeCode(options.operation ?? "task-workspace");
  const label = parseSafeCode(options.label ?? "task-workspace");
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archflow-${label}-`)));
  const dispose = (): void => rmSync(root, { recursive: true, force: true });

  try {
    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(root, "README.md"), options.rootBytes ?? new TextEncoder().encode("repository\n"));
    git(root, "add", "--", "README.md");
    git(root, "commit", "-q", "-m", "root");

    const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
    if (!scaffolded.ok) throw new Error(scaffolded.error.code);
    if (options.configBytes !== undefined) {
      writeFileSync(join(root, ".archflow", "config.yaml"), options.configBytes);
    }
    for (const [filename, bytes] of Object.entries(options.constitutionBytes ?? {})) {
      if (!/^[0-9]{2}-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u.test(filename)) {
        throw new TypeError(`invalid constitution fixture filename: ${filename}`);
      }
      writeFileSync(join(root, ".archflow", "constitution", filename), bytes);
    }
    git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
    git(root, "commit", "-q", "-m", "approve policy");

    const staged = await stageTaskInitialization({ working_directory: root, task_id: taskId });
    if (!staged.ok) throw new Error(staged.error.code);
    const bootstrap = await createProductionServices({ working_directory: root, task_id: taskId, operation });
    if (!bootstrap.ok) throw new Error(bootstrap.error.code);
    const composed = await composeRequest(bootstrap.value, {
      intent_id: "initialize-task-workspace",
      kind: "initialize",
    });
    if (!composed.ok) throw new Error(composed.error.code);
    const call = parseToolCall("archflow_state", composed.value.envelope.request.input);
    const initialized = await runStateInitialization(bootstrap.value.dependencies, {
      authority: bootstrap.value.authority,
      call,
    });
    if (!initialized.ok) throw new Error(initialized.error.code);

    const production = await createProductionServices({ working_directory: root, task_id: taskId, operation });
    if (!production.ok || production.value.state === undefined) {
      throw new Error(production.ok ? "initialized task state unavailable" : production.error.code);
    }
    return Object.freeze({ root, taskId, initialization: staged.value, services: production.value, dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}
