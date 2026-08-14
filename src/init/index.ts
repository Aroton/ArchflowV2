import type { ProjectError, ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../contracts/evidence.js";
import { parsePhaseInstanceId } from "../contracts/phase-instance.js";
import { createGitRunner, type RepositoryOperationContext } from "../repository/git.js";
import { discoverWorktree } from "../repository/identity.js";
import { scaffoldRepositoryAssets, type AssetScaffoldReport } from "./assets.js";
import { collectInitDiagnostics, type InitDiagnostics } from "./diagnostics.js";
import {
  registerClaudeProject,
  registerCodexProject,
  type HostRegistrationReport,
} from "./registration.js";

export type InitInput = Readonly<{ working_directory: string }>;

export type InitReport = Readonly<{
  schema_version: "1";
  assets: AssetScaffoldReport;
  claude_registration: HostRegistrationReport | null;
  claude_registration_error: ProjectError | null;
  codex_registration: HostRegistrationReport | null;
  codex_registration_error: ProjectError | null;
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

  const assets = await scaffoldRepositoryAssets(rootInput);
  if (!assets.ok) return assets;
  const claude = await registerClaudeProject(rootInput);
  if (!claude.ok && claude.error.code === "CONFIG_INVALID") return claude;
  const codex = await registerCodexProject(rootInput);
  if (!codex.ok && codex.error.code === "CONFIG_INVALID") return codex;
  const diagnostics = await collectInitDiagnostics({
    working_directory: rootInput.working_directory,
    ...(claude.ok ? { claude_registration: claude.value } : {}),
    ...(codex.ok ? { codex_registration: codex.value } : {}),
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
      diagnostics,
      creates_task_state: false,
      creates_commit: false,
    }),
  });
}

export * from "./assets.js";
export * from "./diagnostics.js";
export * from "./registration.js";
