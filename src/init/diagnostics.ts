import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

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
import { CLAUDE_MCP_TIMEOUT_MS, CODEX_TOOL_TIMEOUT_SEC, type HostRegistrationReport } from "./registration.js";

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
  timeout_findings: readonly string[];
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

const TIMEOUT_FINDING_IMPACT = "Counter-review dispatches can run up to fifteen minutes, and a host default MCP timeout"
  + " (~2 minutes in some hosts) will cut them off mid-run; re-running archflow-init repairs the entry.";

/**
 * Reports when a registered `.mcp.json` archflow entry lacks the expected `timeout`.
 * A missing entry is a registration problem reported elsewhere, not a timeout finding.
 */
export function claudeTimeoutFinding(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return undefined;
  const entry = (servers as Record<string, unknown>).archflow;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const timeout = (entry as Record<string, unknown>).timeout;
  if (timeout === CLAUDE_MCP_TIMEOUT_MS) return undefined;
  const detail = timeout === undefined
    ? `is missing "timeout": ${CLAUDE_MCP_TIMEOUT_MS}`
    : `has "timeout" ${JSON.stringify(timeout)} instead of ${CLAUDE_MCP_TIMEOUT_MS}`;
  return `The archflow entry in .mcp.json ${detail}. ${TIMEOUT_FINDING_IMPACT}`;
}

/**
 * Reports when a registered `.codex/config.toml` archflow block lacks the expected
 * `tool_timeout_sec`. A missing block is a registration problem reported elsewhere.
 */
export function codexTimeoutFinding(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\[\s*mcp_servers\.archflow\s*\]$/u.test(line.trim()));
  if (start === -1) return undefined;
  for (let index = start + 1; index < lines.length && !/^\s*\[/u.test(lines[index]!); index += 1) {
    const match = /^\s*tool_timeout_sec\s*=\s*(\S+)/u.exec(lines[index]!);
    if (match === null) continue;
    if (match[1] === String(CODEX_TOOL_TIMEOUT_SEC)) return undefined;
    return `The [mcp_servers.archflow] block in .codex/config.toml has tool_timeout_sec = ${match[1]}`
      + ` instead of ${CODEX_TOOL_TIMEOUT_SEC}. ${TIMEOUT_FINDING_IMPACT}`;
  }
  return `The [mcp_servers.archflow] block in .codex/config.toml is missing tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}.`
    + ` ${TIMEOUT_FINDING_IMPACT}`;
}

async function readHostConfig(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function collectInitDiagnostics(input: InitDiagnosticsInput): Promise<InitDiagnostics> {
  const [claude, codex, claudeHostConfig, codexHostConfig] = await Promise.all([
    diagnoseAdapter("claude-cli", input.working_directory),
    diagnoseAdapter("codex-cli", input.working_directory),
    readHostConfig(join(input.working_directory, ".mcp.json")),
    readHostConfig(join(input.working_directory, ".codex", "config.toml")),
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
    timeout_findings: Object.freeze(
      [claudeTimeoutFinding(claudeHostConfig), codexTimeoutFinding(codexHostConfig)]
        .filter((finding): finding is string => finding !== undefined),
    ),
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
