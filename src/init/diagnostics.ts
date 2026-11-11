import { stat } from "node:fs/promises";

import { createProjectError, type ProjectError } from "../contracts/errors.js";
import { parseSafeCode } from "../contracts/evidence.js";
import type { AdapterId } from "../contracts/review.js";
import {
  CLAUDE_MANAGED_POLICY_PATHS,
  CliAdapterError,
  CODEX_MANAGED_POLICY_PATHS,
  preflightAdapter,
} from "../dispatch/cli.js";
import { DispatchProcessError } from "../dispatch/process.js";
import { createDispatchWorkspace } from "../dispatch/workspace.js";
import { createGitRunner } from "../repository/git.js";

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
  ignored_generated_assets: readonly string[];
  limitations: readonly string[];
  recovery_guidance: readonly string[];
}>;

const GENERATED_ASSET_PATHS = Object.freeze([
  ".archflow/.gitignore",
  ".archflow/config.yaml",
  ".archflow/constitution/README.md",
]);

export async function diagnoseIgnoredGeneratedAssets(repository: string): Promise<readonly string[]> {
  const runner = createGitRunner({ cwd: repository });
  const ignored: string[] = [];
  for (const path of GENERATED_ASSET_PATHS) {
    try {
      const result = await runner.run({
        argv: ["check-ignore", "--quiet", "--no-index", "--", path],
        operation: parseSafeCode("init-check-generated-asset-ignore"),
        expectedAbsence: [{ code: 1, stderrIncludes: "" }],
      });
      if (!result.absent) ignored.push(path);
    } catch { /* Adapter diagnostics report Git failures elsewhere; this list is advisory. */ }
  }
  return Object.freeze(ignored);
}

export type InitDiagnosticsInput = Readonly<{ working_directory: string }>;

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
  const [claude, codex, ignoredAssets] = await Promise.all([
    diagnoseAdapter("claude-cli", input.working_directory),
    diagnoseAdapter("codex-cli", input.working_directory),
    diagnoseIgnoredGeneratedAssets(input.working_directory),
  ]);
  return Object.freeze({
    schema_version: "1",
    node_version: process.versions.node,
    claude,
    codex,
    ignored_generated_assets: ignoredAssets,
    limitations: Object.freeze([
      "Dispatch context hygiene uses a temporary workspace and scrubbed environment, but authentication stays in each CLI's canonical home; the boundary is best-effort, not enforced isolation.",
    ]),
    recovery_guidance: Object.freeze([
      "Repair any reported Node, CLI, authentication, or policy issue, then re-run archflow-local init.",
      ...(ignoredAssets.length === 0 ? [] : [`Generated ArchFlow assets are hidden by an ancestor Git ignore rule: ${ignoredAssets.join(", ")}. Review that rule and explicitly add the intended files; init does not rewrite repository ignore policy.`]),
      "Initialization is idempotent: re-running the full command is the supported recovery path after any interrupted step.",
    ]),
  });
}
