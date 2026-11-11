import { runLocalReview } from "./review.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import { runInit } from "../init/index.js";

export const LOCAL_COMMANDS = Object.freeze(["init", "review"] as const);
export type LocalCommand = typeof LOCAL_COMMANDS[number];

export type LocalCommandContract = Readonly<{
  payload: string | null;   // null = input-free: never reads stdin
}>;

export const LOCAL_COMMAND_CONTRACTS: Readonly<Record<LocalCommand, LocalCommandContract>> = Object.freeze({
  init: { payload: null },
  review: { payload: '<standalone review input: {"schema_version":"1","stage":"plan"|"implementation","ask":...,"plan":...,"base_commit":...,"paths":[...],"verification":... (required for implementation)}>' },
});

export const INPUT_FREE_COMMANDS: ReadonlySet<LocalCommand> =
  new Set(LOCAL_COMMANDS.filter((command) => LOCAL_COMMAND_CONTRACTS[command].payload === null));

type CommandInput = Readonly<{
  command: LocalCommand;
  working_directory: string;
  value?: unknown;
  force?: boolean;
  producer?: string;
  signal?: AbortSignal;
}>;

const LOCAL_COMMAND_HANDLERS: Readonly<Record<LocalCommand, (input: CommandInput) => Promise<PlainJsonValue | ProjectResult<unknown>>>> = Object.freeze({
  init: (input) => runInit({ working_directory: input.working_directory, ...(input.force === true ? { force: true } : {}) }),
  review: (input) => runLocalReview(input),
});

export async function runLocalCommand(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  if (!LOCAL_COMMANDS.includes(input.command)) throw new TypeError(`unknown local command: ${input.command}`);
  return LOCAL_COMMAND_HANDLERS[input.command](input);
}
