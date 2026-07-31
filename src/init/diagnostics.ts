import { stat } from "node:fs/promises";

import { createProjectError, type ProjectError } from "../contracts/errors.js";
import type { AdapterId } from "../contracts/review.js";
import {
  CLAUDE_MANAGED_POLICY_PATHS,
  CliAdapterError,
  CODEX_MANAGED_POLICY_PATHS,
  preflightAdapter,
} from "../dispatch/cli.js";
import { DispatchProcessError } from "../dispatch/process.js";
import { createDispatchWorkspace } from "../dispatch/workspace.js";
import type { HostRegistrationReport } from "./registration.js";

export type CliInitDiagnostic = Readonly<{
  adapter: AdapterId;
  version: string | null;
  authenticated: boolean | null;
  managed_policy_present: boolean;
  managed_policy_paths: readonly string[];
  error: ProjectError | null;
}>;

export type InitDiagnostics = Readonly<{
  schema_version: "1";
  node_version: string;
  claude: CliInitDiagnostic;
  codex: CliInitDiagnostic;
  claude_pending_approval: boolean | null;
  claude_masked_by_higher_precedence: boolean | null;
  codex_project_trusted: boolean | null;
  codex_masked_by_higher_precedence: boolean | null;
  limitations: readonly string[];
  recovery_guidance: readonly string[];
}>;

export type InitDiagnosticsInput = Readonly<{
  working_directory: string;
  claude_registration?: HostRegistrationReport;
  codex_registration?: HostRegistrationReport;
}>;

async function presentPaths(paths: readonly string[]): Promise<readonly string[]> {
  const found = await Promise.all(paths.map(async (path) => {
    try {
      await stat(path);
      return path;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : path;
    }
  }));
  return Object.freeze(found.filter((path): path is string => path !== undefined));
}

function preflightError(error: unknown): ProjectError | undefined {
  if (error instanceof CliAdapterError || error instanceof DispatchProcessError) return error.project_error;
  return undefined;
}

function unsupportedVersion(error: ProjectError): string | null {
  if (error.code !== "CLI_VERSION_UNSUPPORTED") return null;
  return error.diagnostic.parameters.version;
}

async function diagnoseAdapter(adapter: AdapterId, repository: string): Promise<CliInitDiagnostic> {
  const policyTable = adapter === "claude-cli" ? CLAUDE_MANAGED_POLICY_PATHS : CODEX_MANAGED_POLICY_PATHS;
  const pathsPromise = presentPaths(policyTable);
  let workspace: Awaited<ReturnType<typeof createDispatchWorkspace>> | undefined;
  try {
    workspace = await createDispatchWorkspace(adapter, repository);
    const result = await preflightAdapter(adapter, workspace);
    return Object.freeze({
      adapter,
      version: result.cli_version,
      authenticated: true,
      managed_policy_present: result.managed_policy_present,
      managed_policy_paths: result.managed_policy_paths,
      error: null,
    });
  } catch (caught) {
    const error = preflightError(caught);
    const paths = await pathsPromise;
    const version = caught instanceof CliAdapterError
      ? caught.cli_version ?? unsupportedVersion(caught.project_error)
      : null;
    return Object.freeze({
      adapter,
      version,
      authenticated: error?.code === "AUTH_UNAVAILABLE" ? false : null,
      managed_policy_present: paths.length > 0,
      managed_policy_paths: paths,
      error: error ?? createProjectError("IO_ERROR", { operation: "init-preflight", attempt: 1 }),
    });
  } finally {
    await workspace?.dispose();
  }
}

export async function collectInitDiagnostics(input: InitDiagnosticsInput): Promise<InitDiagnostics> {
  const [claude, codex] = await Promise.all([
    diagnoseAdapter("claude-cli", input.working_directory),
    diagnoseAdapter("codex-cli", input.working_directory),
  ]);
  return Object.freeze({
    schema_version: "1",
    node_version: process.versions.node,
    claude,
    codex,
    claude_pending_approval: input.claude_registration?.pending_approval ?? null,
    claude_masked_by_higher_precedence: input.claude_registration?.masked_by_higher_precedence ?? null,
    codex_project_trusted: input.codex_registration?.project_trusted ?? null,
    codex_masked_by_higher_precedence: input.codex_registration?.masked_by_higher_precedence ?? null,
    limitations: Object.freeze([
      "Dispatch context hygiene uses a generated home and scrubbed environment, but it is best-effort and is not an enforced isolation boundary.",
      "Claude project MCP registration may remain pending until a human approves it; reset choices with `claude mcp reset-project-choices` when needed.",
      "Codex project MCP configuration is active only after a human trusts the repository in Codex; init never writes trust_level.",
      "A one-hour host tool timeout bounds a call, not a durable gate decision; retrying the resumable gate is safe.",
    ]),
    recovery_guidance: Object.freeze([
      "Repair any reported Node, CLI, authentication, policy, trust, approval, or command-collision issue, then re-run archflow-local init.",
      "Initialization is idempotent: re-running the full command is the supported recovery path after any interrupted step.",
    ]),
  });
}
