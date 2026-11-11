import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseSafeInteger } from "../contracts/evidence.js";
import { createGitRunner, type RepositoryOperationContext } from "../repository/git.js";
import { discoverWorktree } from "../repository/identity.js";
import { scaffoldRepositoryAssets, type AssetScaffoldReport } from "./assets.js";
import { collectInitDiagnostics, type InitDiagnostics } from "./diagnostics.js";
import {
  removeLegacyRegistrations,
  type LegacyRegistrationCleanupReport,
  type LegacyRegistrationLeftAlone,
  type LegacyRegistrationRemoval,
} from "./legacy-registration-cleanup.js";

export type InitInput = Readonly<{ working_directory: string; force?: boolean }>;

export type InitReport = Readonly<{
  schema_version: "1";
  assets: AssetScaffoldReport;
  legacy_registrations: LegacyRegistrationCleanupReport;
  diagnostics: InitDiagnostics;
  creates_commit: false;
}>;

export async function runInit(input: InitInput): Promise<ProjectResult<InitReport>> {
  const context: RepositoryOperationContext = Object.freeze({
    operation: parseSafeCode("initialize-repository"),
    attempt: parseSafeInteger(1),
  });
  const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), context);
  if (!discovered.ok) return discovered;
  const rootInput = Object.freeze({ working_directory: discovered.value.location.worktreeRoot });

  // The cleanup runs first: it touches only entries earlier inits wrote and does not depend on the
  // scaffold, so a repository whose old config.yaml makes the scaffold refuse still loses its stale
  // `archflow-mcp` registrations.
  let legacyRegistrations: LegacyRegistrationCleanupReport;
  try {
    legacyRegistrations = await removeLegacyRegistrations(rootInput.working_directory);
  } catch {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("IO_ERROR", { operation: "remove-legacy-registrations", attempt: 1 }),
    });
  }
  const assets = await scaffoldRepositoryAssets({ ...rootInput, ...(input.force === true ? { force: true } : {}) });
  if (!assets.ok) {
    // A failed result carries no report, so the cleanup that already happened is told on stderr.
    reportLegacyRegistrations(legacyRegistrations);
    return assets;
  }
  const diagnostics = await collectInitDiagnostics(rootInput);
  return Object.freeze({
    schema_version: "1",
    ok: true,
    value: Object.freeze({
      schema_version: "1",
      assets: assets.value,
      legacy_registrations: legacyRegistrations,
      diagnostics,
      creates_commit: false,
    }),
  });
}

const REMOVAL_EFFECTS: Readonly<Record<LegacyRegistrationRemoval["effect"], string>> = {
  "entry-removed": "removed its archflow entry",
  "file-deleted": "deleted the file, which held nothing else",
};

const LEFT_ALONE_REASONS: Readonly<Record<LegacyRegistrationLeftAlone["reason"], string>> = {
  "different-command": "its archflow server runs a different command",
  unreadable: "the file could not be parsed",
  "unmatched-markers": "the ArchFlow markers do not pair up",
  symlink: "the file or its directory is a symbolic link",
};

/** Writes one stderr line per legacy MCP registration init removed or left alone. */
function reportLegacyRegistrations(report: LegacyRegistrationCleanupReport): void {
  for (const removal of report.removed) {
    process.stderr.write(`ArchFlow removed the legacy archflow-mcp registration in ${removal.path}: ${REMOVAL_EFFECTS[removal.effect]}.\n`);
  }
  for (const leftAlone of report.left_alone) {
    process.stderr.write(`ArchFlow left an archflow registration in ${leftAlone.path} alone: ${LEFT_ALONE_REASONS[leftAlone.reason]}.\n`);
  }
}

export * from "./assets.js";
export * from "./diagnostics.js";
export * from "./legacy-registration-cleanup.js";
