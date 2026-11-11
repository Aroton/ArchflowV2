import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The server command earlier versions of init registered for every host. */
const LEGACY_SERVER_COMMAND = "archflow-mcp";
/** Markers earlier versions of init wrote around their block in `.codex/config.toml`. */
const CODEX_BLOCK_BEGIN = "# >>> archflow managed MCP server >>>";
const CODEX_BLOCK_END = "# <<< archflow managed MCP server <<<";
const CODEX_BLOCK_COMMAND = /^[ \t]*command[ \t]*=[ \t]*"archflow-mcp"[ \t]*\r?$/mu;

export type LegacyRegistrationPath = ".mcp.json" | ".codex/config.toml";

export type LegacyRegistrationRemoval = Readonly<{
  path: LegacyRegistrationPath;
  /** `entry-removed` rewrote the file without the ArchFlow entry; `file-deleted` removed a file left empty. */
  effect: "entry-removed" | "file-deleted";
}>;

export type LegacyRegistrationLeftAlone = Readonly<{
  path: LegacyRegistrationPath;
  /** `symlink`: the file or its directory is a symbolic link, which may lead outside the repository. */
  reason: "different-command" | "unreadable" | "unmatched-markers" | "symlink";
}>;

export type LegacyRegistrationCleanupReport = Readonly<{
  removed: readonly LegacyRegistrationRemoval[];
  left_alone: readonly LegacyRegistrationLeftAlone[];
}>;

type Outcome = LegacyRegistrationRemoval | LegacyRegistrationLeftAlone | undefined;

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** True when `path` itself is a symbolic link; the link is never followed. */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Replaces a file through a temporary sibling so an interrupted run never leaves it half-written. */
async function replaceFile(path: string, source: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    const mode = (await lstat(path)).mode & 0o777;
    handle = await open(temporary, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Removes `mcpServers.archflow` from `.mcp.json` when its command is exactly the `archflow-mcp`
 * launcher earlier inits registered. Every other byte of meaning in the file is kept; the file is
 * deleted only when the ArchFlow entry was the last thing in it.
 */
async function removeClaudeRegistration(repository: string): Promise<Outcome> {
  const path = join(repository, ".mcp.json");
  if (await isSymlink(path)) return { path: ".mcp.json", reason: "symlink" };
  const source = await readOptional(path);
  if (source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return source.includes(LEGACY_SERVER_COMMAND) ? { path: ".mcp.json", reason: "unreadable" } : undefined;
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, "mcpServers")) return undefined;
  const servers = parsed.mcpServers;
  if (!isRecord(servers)) {
    return source.includes(LEGACY_SERVER_COMMAND) ? { path: ".mcp.json", reason: "unreadable" } : undefined;
  }
  if (!Object.hasOwn(servers, "archflow")) return undefined;
  const entry = servers.archflow;
  if (!isRecord(entry) || entry.command !== LEGACY_SERVER_COMMAND) {
    return { path: ".mcp.json", reason: "different-command" };
  }

  delete servers.archflow;
  const nothingElse = Object.keys(servers).length === 0 && Object.keys(parsed).length === 1;
  if (nothingElse) {
    await unlink(path);
    return { path: ".mcp.json", effect: "file-deleted" };
  }
  await replaceFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return { path: ".mcp.json", effect: "entry-removed" };
}

/**
 * Removes the marker-delimited block earlier inits appended to `.codex/config.toml`. The block is
 * ArchFlow's only when both markers appear exactly once, in order, around the `archflow-mcp`
 * command; the rest of the file is kept byte for byte, and a file left empty is deleted.
 */
async function removeCodexRegistration(repository: string): Promise<Outcome> {
  const directory = join(repository, ".codex");
  const path = join(directory, "config.toml");
  if (await isSymlink(directory) || await isSymlink(path)) return { path: ".codex/config.toml", reason: "symlink" };
  const source = await readOptional(path);
  if (source === undefined) return undefined;
  const begin = source.indexOf(CODEX_BLOCK_BEGIN);
  const end = source.indexOf(CODEX_BLOCK_END);
  if (begin === -1 && end === -1) return undefined;
  if (
    begin === -1 || end === -1 || end < begin
    || source.indexOf(CODEX_BLOCK_BEGIN, begin + 1) !== -1
    || source.indexOf(CODEX_BLOCK_END, end + 1) !== -1
  ) {
    return { path: ".codex/config.toml", reason: "unmatched-markers" };
  }
  if (!CODEX_BLOCK_COMMAND.test(source.slice(begin, end))) {
    return { path: ".codex/config.toml", reason: "different-command" };
  }

  const afterMarker = end + CODEX_BLOCK_END.length;
  const blockEnd = source.startsWith("\r\n", afterMarker)
    ? afterMarker + 2
    : source.startsWith("\n", afterMarker) ? afterMarker + 1 : afterMarker;
  const remaining = `${source.slice(0, begin)}${source.slice(blockEnd)}`;
  if (remaining.trim() === "") {
    await unlink(path);
    // Earlier inits created `.codex/` for this file; remove the directory only if nothing else is in it.
    await rmdir(dirname(path)).catch(() => undefined);
    return { path: ".codex/config.toml", effect: "file-deleted" };
  }
  await replaceFile(path, remaining);
  return { path: ".codex/config.toml", effect: "entry-removed" };
}

/**
 * Removes the MCP registrations earlier versions of `archflow-local init` wrote inside the
 * repository, and only those exact shapes. Anything else that names ArchFlow is left in place and
 * reported so a human can decide. Symbolic links are never followed, so nothing outside the
 * repository is read or changed.
 */
export async function removeLegacyRegistrations(repository: string): Promise<LegacyRegistrationCleanupReport> {
  const outcomes = [await removeClaudeRegistration(repository), await removeCodexRegistration(repository)];
  const removed: LegacyRegistrationRemoval[] = [];
  const leftAlone: LegacyRegistrationLeftAlone[] = [];
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    if ("effect" in outcome) removed.push(Object.freeze(outcome));
    else leftAlone.push(Object.freeze(outcome));
  }
  return Object.freeze({ removed: Object.freeze(removed), left_alone: Object.freeze(leftAlone) });
}
