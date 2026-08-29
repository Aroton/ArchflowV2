import type { ProjectError, ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../contracts/evidence.js";
import { parsePhaseInstanceId } from "../contracts/phase-instance.js";
import { createGitRunner, type RepositoryOperationContext } from "../repository/git.js";
import { discoverWorktree } from "../repository/identity.js";
import { scaffoldRepositoryAssets, type AssetScaffoldReport } from "./assets.js";
import { collectInitDiagnostics, type InitDiagnostics } from "./diagnostics.js";
import {
  registerAntigravityConfig,
  registerClaudeProject,
  registerCodexProject,
  type HostRegistrationReport,
} from "./registration.js";

export type InitInput = Readonly<{ working_directory: string; force?: boolean }>;

export type InitReport = Readonly<{
  schema_version: "1";
  assets: AssetScaffoldReport;
  claude_registration: HostRegistrationReport | null;
  claude_registration_error: ProjectError | null;
  codex_registration: HostRegistrationReport | null;
  codex_registration_error: ProjectError | null;
  antigravity_registration: HostRegistrationReport | null;
  antigravity_registration_error: ProjectError | null;
  diagnostics: InitDiagnostics;
  creates_task_state: false;
  creates_commit: false;
}>;

export async function runInit(input: InitInput): Promise<ProjectResult<InitReport>> {
  const context: RepositoryOperationContext = Object.freeze({
    task_id: parseTaskSlug("init"),
    phase_instance: parsePhaseInstanceId("prd"),
    operation: parseSafeCode("initialize-repository"),
    attempt: parseSafeInteger(1),
  });
  const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), context);
  if (!discovered.ok) return discovered;
  const rootInput = Object.freeze({ working_directory: discovered.value.location.worktreeRoot });

  const assets = await scaffoldRepositoryAssets({ ...rootInput, ...(input.force === true ? { force: true } : {}) });
  if (!assets.ok) return assets;
  const claude = await registerClaudeProject(rootInput);
  if (!claude.ok && claude.error.code === "CONFIG_INVALID") return claude;
  const codex = await registerCodexProject(rootInput);
  if (!codex.ok && codex.error.code === "CONFIG_INVALID") return codex;
  const antigravity = await registerAntigravityConfig(rootInput);
  if (!antigravity.ok && antigravity.error.code === "CONFIG_INVALID") return antigravity;
  const diagnostics = await collectInitDiagnostics({
    working_directory: rootInput.working_directory,
    ...(claude.ok ? { claude_registration: claude.value } : {}),
    ...(codex.ok ? { codex_registration: codex.value } : {}),
    ...(antigravity.ok ? { antigravity_registration: antigravity.value } : {}),
  });
  return Object.freeze({
    schema_version: "1",
    ok: true,
    value: Object.freeze({
      schema_version: "1",
      assets: assets.value,
      claude_registration: claude.ok ? claude.value : null,
      claude_registration_error: claude.ok ? null : claude.error,
      codex_registration: codex.ok ? codex.value : null,
      codex_registration_error: codex.ok ? null : codex.error,
      antigravity_registration: antigravity.ok ? antigravity.value : null,
      antigravity_registration_error: antigravity.ok ? null : antigravity.error,
      diagnostics,
      creates_task_state: false,
      creates_commit: false,
    }),
  });
}

export * from "./assets.js";
export * from "./diagnostics.js";
export * from "./registration.js";
