import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { parseAutomationStatus, type AutomationStatusV1 } from "../../src/contracts/automation-status.js";
import type { WorkflowInvocationV1 } from "../../src/contracts/semantic-workflow.js";

export type AutomationObservation = AutomationStatusV1;

export type AutomationProcessResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  observation?: AutomationObservation;
}>;

/** Builds the repository-local CLI entry into a caller-owned temporary path. */
export function buildAutomationLocalBundle(repositoryRoot: string, outfile: string): void {
  const program = [
    'import { build } from "esbuild";',
    'const [root, outfile] = process.argv.slice(1);',
    'await build({absWorkingDir:root,entryPoints:["src/local/main.ts"],outfile,bundle:true,platform:"node",format:"esm",target:"node24",banner:{js:\'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);\'}});',
  ].join("");
  const built = spawnSync(process.execPath, ["--input-type=module", "--eval", program, repositoryRoot, outfile], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (built.status !== 0) throw new Error(`local bundle failed: ${built.stderr}`);
}

/** Runs one cold input-free automation observation and parses only successful documents. */
export function runAutomationStatus(
  localBundle: string,
  repositoryRoot: string,
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): AutomationProcessResult {
  const result = spawnSync(process.execPath, [localBundle, "automation-status", "--task", taskId], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return Object.freeze({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.status === 0 && result.stdout !== ""
      ? { observation: parseAutomationStatus(JSON.parse(result.stdout)) }
      : {}),
  });
}

/** Converts only the published owner descriptor into the semantic invocation a producer uses. */
export function invocationFromAutomation(observation: AutomationObservation): WorkflowInvocationV1 {
  const action = observation.next_action;
  if (action.actor !== "skill" && action.actor !== "orchestrator") {
    throw new TypeError(`automation actor ${action.actor} does not name a producer`);
  }
  if (action.skill === undefined || action.task_id !== observation.task_id || action.skill_args === undefined) {
    throw new TypeError("automation producer descriptor is incomplete");
  }
  const phase = action.skill_args.length === 0 ? undefined : Number(action.skill_args[0]);
  const candidate = {
    skill: action.skill,
    ...(phase === undefined ? {} : { phase }),
    intent: "resume",
  };
  return candidate as WorkflowInvocationV1;
}

export type DirectorySnapshotEntry = Readonly<{
  path: string;
  kind: "file" | "directory" | "symlink";
  digest?: string;
  target?: string;
}>;

/** Captures names and exact bytes without following symlinks. */
export function snapshotDirectory(root: string): readonly DirectorySnapshotEntry[] {
  const entries: DirectorySnapshotEntry[] = [];
  const visit = (absolute: string, relative: string): void => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relative, kind: "symlink", target: readlinkSync(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), relative === "." ? name : `${relative}/${name}`);
      return;
    }
    entries.push({
      path: relative,
      kind: "file",
      digest: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    });
  };
  visit(root, ".");
  return Object.freeze(entries);
}
