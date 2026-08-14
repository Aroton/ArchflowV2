import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { AdapterId } from "../contracts/review.js";

export const CLAUDE_MCP_TIMEOUT_MS = 3_600_000;
export const CODEX_TOOL_TIMEOUT_SEC = 3_600;
export const CODEX_STARTUP_TIMEOUT_SEC = 30;

export const CODEX_BLOCK_BEGIN = "# >>> archflow managed MCP server >>>";
export const CODEX_BLOCK_END = "# <<< archflow managed MCP server <<<";
export const CODEX_MANAGED_BLOCK = `${CODEX_BLOCK_BEGIN}\n[mcp_servers.archflow]\ncommand = "archflow-mcp"\nargs = []\nstartup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}\n${CODEX_BLOCK_END}\n`;
export const CLAUDE_MANUAL_ENTRY = `"archflow": {\n  "type": "stdio",\n  "command": "archflow-mcp",\n  "args": [],\n  "timeout": ${CLAUDE_MCP_TIMEOUT_MS}\n}`;
export const CLAUDE_PASTE_GUIDANCE = `Add this exact entry under \"mcpServers\" in .mcp.json after resolving the conflicting content:\n${CLAUDE_MANUAL_ENTRY}\n`;
export const CODEX_PASTE_GUIDANCE = `Add this exact ArchFlow-owned block to .codex/config.toml after resolving the conflicting content:\n${CODEX_MANAGED_BLOCK}`;

export type RegistrationInput = Readonly<{
  working_directory: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
}>;

export type HostRegistrationReport = Readonly<{
  schema_version: "1";
  host: "claude" | "codex";
  registration: "created" | "updated" | "unchanged";
  command: "archflow-mcp";
  pending_approval: boolean;
  project_trusted: boolean | null;
  masked_by_higher_precedence: boolean;
  diagnostic: string;
}>;

type CommandResult = Readonly<{ exit_code: number; stdout: string; stderr: string }>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(issueCode: string): ProjectResult<T> => Object.freeze({
  schema_version: "1",
  ok: false,
  error: createProjectError("CONFIG_INVALID", { issue_code: issueCode }),
});
function refuse<T = never>(issueCode: string, guidance: string): ProjectResult<T> {
  process.stderr.write(guidance);
  return fail(issueCode);
}
const ioFailure = <T = never>(operation: string): ProjectResult<T> => Object.freeze({
  schema_version: "1",
  ok: false,
  error: createProjectError("IO_ERROR", { operation, attempt: 1 }),
});

function commandFailure<T>(adapter: AdapterId, error: NodeJS.ErrnoException): ProjectResult<T> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: error.code === "ENOENT"
      ? createProjectError("CLI_MISSING", { adapter })
      : createProjectError("IO_ERROR", { operation: "init-host-command", attempt: 1 }),
  });
}

function runCommand(
  command: string,
  argv: readonly string[],
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv> | undefined,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], {
      cwd,
      env: environment === undefined ? process.env : { ...environment },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exit_code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomically replaces an ArchFlow-serialized host configuration in its own directory. */
async function replaceHostConfig(path: string, source: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o644);
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

type McpJson = { mcpServers: Record<string, unknown> };

function parseMcpJson(source: string | undefined): ProjectResult<McpJson> {
  if (source === undefined) return ok({ mcpServers: {} });
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return fail("mcp-json-foreign-keys");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("mcp-json-foreign-keys");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "mcpServers")) {
    return fail("mcp-json-foreign-keys");
  }
  const servers = record.mcpServers;
  if (servers === undefined) return ok({ mcpServers: {} });
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    return fail("mcp-json-foreign-keys");
  }
  return ok({ mcpServers: servers as Record<string, unknown> });
}

function serverCommand(server: unknown): string | undefined {
  if (server === null || typeof server !== "object" || Array.isArray(server)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(server, "command");
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function claudeGetDiagnostic(output: string): Pick<HostRegistrationReport, "pending_approval" | "masked_by_higher_precedence"> {
  const pendingApproval = /(?:pending approval|⏸)/iu.test(output);
  const projectScope = /(?:scope\s*:\s*project|project scope|\.mcp\.json)/iu.test(output);
  const differentCommand = /command\s*:\s*(?!archflow-mcp(?:\s|$))\S+/iu.test(output);
  const explicitHigherScope = /(?:scope\s*:\s*(?:local|user)|(?:local|user) scope)/iu.test(output);
  return {
    pending_approval: pendingApproval,
    masked_by_higher_precedence: explicitHigherScope || differentCommand || (!projectScope && output.trim() !== ""),
  };
}

export async function registerClaudeProject(input: RegistrationInput): Promise<ProjectResult<HostRegistrationReport>> {
  const path = join(input.working_directory, ".mcp.json");
  try {
    const beforeSource = await readOptional(path);
    const before = parseMcpJson(beforeSource);
    if (!before.ok) return refuse("mcp-json-foreign-keys", CLAUDE_PASTE_GUIDANCE);
    const existing = before.value.mcpServers.archflow;
    if (existing !== undefined && serverCommand(existing) !== "archflow-mcp") {
      return refuse("server-command-collision", CLAUDE_PASTE_GUIDANCE);
    }

    let registration: HostRegistrationReport["registration"] = "unchanged";
    if (existing === undefined) {
      let add: CommandResult;
      try {
        add = await runCommand(
          "claude",
          ["mcp", "add", "--scope", "project", "archflow", "--", "archflow-mcp"],
          input.working_directory,
          input.environment,
        );
      } catch (error) {
        return commandFailure("claude-cli", error as NodeJS.ErrnoException);
      }
      if (add.exit_code !== 0 && add.exit_code !== 1) return ioFailure("claude-mcp-add");
      registration = "created";
    }

    const after = parseMcpJson(await readOptional(path));
    if (!after.ok) return refuse("mcp-json-foreign-keys", CLAUDE_PASTE_GUIDANCE);
    const projectEntry = after.value.mcpServers.archflow;
    if (projectEntry === undefined) return ioFailure("claude-mcp-add-readback");
    if (serverCommand(projectEntry) !== "archflow-mcp") return refuse("server-command-collision", CLAUDE_PASTE_GUIDANCE);
    const entry = projectEntry as Record<string, unknown>;
    if (entry.timeout !== CLAUDE_MCP_TIMEOUT_MS) registration = registration === "created" ? "created" : "updated";
    entry.timeout = CLAUDE_MCP_TIMEOUT_MS;
    const serialized = `${JSON.stringify({ mcpServers: after.value.mcpServers }, null, 2)}\n`;
    if (serialized !== beforeSource) await replaceHostConfig(path, serialized);

    let get: CommandResult;
    try {
      get = await runCommand("claude", ["mcp", "get", "archflow"], input.working_directory, input.environment);
    } catch (error) {
      return commandFailure("claude-cli", error as NodeJS.ErrnoException);
    }
    const text = `${get.stdout}\n${get.stderr}`;
    const diagnostic = claudeGetDiagnostic(text);
    return ok(Object.freeze({
      schema_version: "1",
      host: "claude",
      registration,
      command: "archflow-mcp",
      pending_approval: diagnostic.pending_approval,
      project_trusted: null,
      masked_by_higher_precedence: diagnostic.masked_by_higher_precedence,
      diagnostic: get.exit_code === 0 ? text.trim() : "Project registration written; Claude runtime approval remains to be completed.",
    }));
  } catch {
    return ioFailure("claude-registration");
  }
}

function managedBlockRange(source: string): ProjectResult<Readonly<{ start: number; end: number }> | undefined> {
  const begin = source.indexOf(CODEX_BLOCK_BEGIN);
  const end = source.indexOf(CODEX_BLOCK_END);
  if (begin === -1 && end === -1) return ok(undefined);
  if (begin === -1 || end === -1 || end < begin || source.indexOf(CODEX_BLOCK_BEGIN, begin + 1) !== -1 || source.indexOf(CODEX_BLOCK_END, end + 1) !== -1) {
    return fail("codex-config-foreign");
  }
  return ok({ start: begin, end: end + CODEX_BLOCK_END.length + (source[end + CODEX_BLOCK_END.length] === "\n" ? 1 : 0) });
}

function outsideCodexConflict(source: string): "server-command-collision" | "codex-config-foreign" | undefined {
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.startsWith("#")) continue;
    if (/^\[\s*mcp_servers\.archflow\s*\]$/u.test(line)) {
      for (let next = index + 1; next < lines.length && !/^\s*\[/u.test(lines[next]!); next += 1) {
        const match = /^\s*command\s*=\s*["']([^"']+)["']/u.exec(lines[next]!);
        if (match !== null) return match[1] === "archflow-mcp" ? "codex-config-foreign" : "server-command-collision";
      }
      return "codex-config-foreign";
    }
    if (/^\[\s*mcp_servers\s*\]$/u.test(line)) {
      for (let next = index + 1; next < lines.length && !/^\s*\[/u.test(lines[next]!); next += 1) {
        const entry = /^\s*archflow\s*=\s*(.*)$/u.exec(lines[next]!);
        if (entry === null) continue;
        const command = /\bcommand\s*=\s*["']([^"']+)["']/u.exec(entry[1] ?? "");
        return command !== null && command[1] !== "archflow-mcp"
          ? "server-command-collision"
          : "codex-config-foreign";
      }
      continue;
    }
    if (/\bmcp_servers(?:\.archflow|\s*=.*\barchflow\b)/u.test(line)) return "codex-config-foreign";
  }
  return undefined;
}

type CodexGetDiagnostic = Readonly<{
  command: string | undefined;
  startup_timeout_sec: number | null | undefined;
  tool_timeout_sec: number | null | undefined;
}>;

function codexGetDiagnostic(output: string): CodexGetDiagnostic | undefined {
  try {
    const value = JSON.parse(output) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    let command = typeof record.command === "string" ? record.command : undefined;
    const transport = record.transport;
    if (transport !== null && typeof transport === "object" && !Array.isArray(transport)) {
      const transportCommand = (transport as Record<string, unknown>).command;
      if (typeof transportCommand === "string") command = transportCommand;
    }
    const startupTimeout = record.startup_timeout_sec;
    const toolTimeout = record.tool_timeout_sec;
    return {
      command,
      startup_timeout_sec: typeof startupTimeout === "number" || startupTimeout === null ? startupTimeout : undefined,
      tool_timeout_sec: typeof toolTimeout === "number" || toolTimeout === null ? toolTimeout : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function registerCodexProject(input: RegistrationInput): Promise<ProjectResult<HostRegistrationReport>> {
  const path = join(input.working_directory, ".codex", "config.toml");
  try {
    const before = await readOptional(path) ?? "";
    const range = managedBlockRange(before);
    if (!range.ok) return refuse("codex-config-foreign", CODEX_PASTE_GUIDANCE);
    const outside = range.value === undefined
      ? before
      : `${before.slice(0, range.value.start)}${before.slice(range.value.end)}`;
    const conflict = outsideCodexConflict(outside);
    if (conflict !== undefined) return refuse(conflict, CODEX_PASTE_GUIDANCE);

    let registration: HostRegistrationReport["registration"];
    let next: string;
    if (range.value === undefined) {
      registration = "created";
      next = before === "" ? CODEX_MANAGED_BLOCK : `${before}${before.endsWith("\n") ? "" : "\n"}${CODEX_MANAGED_BLOCK}`;
    } else {
      next = `${before.slice(0, range.value.start)}${CODEX_MANAGED_BLOCK}${before.slice(range.value.end)}`;
      registration = next === before ? "unchanged" : "updated";
    }
    if (next !== before) {
      await mkdir(dirname(path), { recursive: true });
      await replaceHostConfig(path, next);
    }

    let get: CommandResult;
    try {
      get = await runCommand("codex", ["mcp", "get", "archflow", "--json"], input.working_directory, input.environment);
    } catch (error) {
      return commandFailure("codex-cli", error as NodeJS.ErrnoException);
    }
    const resolved = get.exit_code === 0 ? codexGetDiagnostic(get.stdout) : undefined;
    const resolvedCommand = resolved?.command;
    const trusted = get.exit_code === 0
      && resolvedCommand === "archflow-mcp"
      && resolved?.startup_timeout_sec === CODEX_STARTUP_TIMEOUT_SEC
      && resolved?.tool_timeout_sec === CODEX_TOOL_TIMEOUT_SEC;
    return ok(Object.freeze({
      schema_version: "1",
      host: "codex",
      registration,
      command: "archflow-mcp",
      pending_approval: false,
      project_trusted: trusted,
      masked_by_higher_precedence: get.exit_code === 0 && resolvedCommand !== undefined && resolvedCommand !== "archflow-mcp",
      diagnostic: trusted
        ? get.stdout.trim()
        : "Codex project config is written but remains inactive until the repository is trusted in Codex.",
    }));
  } catch {
    return ioFailure("codex-registration");
  }
}
