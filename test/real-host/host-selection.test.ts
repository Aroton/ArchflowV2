/**
 * Opt-in real-host evidence for the two-tool semantic catalogue. Each authenticated host
 * (Claude Code, Codex) is driven as a real MCP client against the freshly installed bundle in
 * a scratch home: the advertisement it sees, the first ArchFlow tool it selects for a
 * plain-language status question (no skill-authored protocol hints in the prompt), and a
 * representative semantic journey slice (initialize-task with a task-ask, reaching
 * submit-work). Results are recorded under docs/validation/ as a digest-bound artifact with a
 * thresholds sidecar — the review-benchmark pattern — so the evidence is reproducible without
 * being a CI dependency.
 *
 * Gated by ARCHFLOW_REAL_HOSTS=1 plus the shared auth probe; deliberately outside
 * `npm run check` (see test/contracts/repository-boundary.test.ts). The scratch-home install
 * and both capability probes run at module scope (only when opted in and available) so the
 * journey tests can skip on a host account that cannot pass the nested invocation object,
 * recording the blockage instead of failing on an environment the suite cannot repair.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalJsonBytes, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import {
  REAL_HOST_TEST_TIMEOUT_MS,
  realHostsAvailable,
  requireRealHostsAvailable,
} from "../helpers/real-host.js";

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);
const TIMEOUT = REAL_HOST_TEST_TIMEOUT_MS;
const INSTALL_TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactPath = join(process.cwd(), "docs", "validation", "host-selection.json");
const sidecarPath = join(process.cwd(), "docs", "validation", "host-selection-thresholds.json");

// The design bar the recorded evidence is judged against: both authenticated hosts must
// advertise the pair, select archflow_status first, and complete the journey slice. A host
// whose account cannot pass a nested invocation object is recorded as blocked with its
// mechanism — the shortfall stays visible in the recorded metrics rather than being
// redefined away.
const DESIGN_THRESHOLDS = Object.freeze({
  minimum_advertisement_hosts: 2,
  minimum_first_call_selection_hosts: 2,
  minimum_completed_journey_hosts: 2,
});

const CLAUDE_MODEL = "claude-opus-5";
const CLAUDE_EFFORT = "high";
const CODEX_MODEL = "gpt-5.6-sol";
const CODEX_EFFORT = "low";
const TASK_ASK = "Add a one-line notes file.";

const gitIdentity: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Host Selection",
  GIT_AUTHOR_EMAIL: "host-selection@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Host Selection",
  GIT_COMMITTER_EMAIL: "host-selection@example.invalid",
};

type HostToolCall = Readonly<{
  name: string;
  input: unknown;
  isError: boolean;
  resultText: string;
}>;

type HostRun = Readonly<{
  exitCode: number | null;
  stderr: string;
  toolCalls: readonly HostToolCall[];
  messages: readonly string[];
}>;

type HostEvidence = {
  cli_version: string;
  requested_model: string;
  advertisement: { status: string; tool_names: string[] };
  first_call_selection: { status: string; prompt: string; first_archflow_tool: string | null; task_id: string | null };
  journey: {
    status: string;
    reason: string;
    initialize_task_apply_seen: boolean;
    final_next_action_kind: string;
    task_state: { phase_instance: string; step: string; status: string; revision: number } | null;
  };
};

function freshEvidence(model: string): HostEvidence {
  return {
    cli_version: "",
    requested_model: model,
    advertisement: { status: "not-run", tool_names: [] },
    first_call_selection: { status: "not-run", prompt: "", first_archflow_tool: null, task_id: null },
    journey: {
      status: "not-run",
      reason: "",
      initialize_task_apply_seen: false,
      final_next_action_kind: "",
      task_state: null,
    },
  };
}

const roots: string[] = [];
let installationRoot = "";
let checkoutRoot = "";
let scratchHome = "";
let scratchBin = "";
let codexHome = "";
let installedEnvironment: NodeJS.ProcessEnv = { ...process.env };
let developerSkillsBefore = "";
let developerClaudeProjectsBefore: string[] = [];
let claudeJourneyCapable = false;
let claudeCapabilityNote = "";
let codexJourneyCapable = false;
let codexCapabilityNote = "";
const claudeEvidence = freshEvidence(CLAUDE_MODEL);
const codexEvidence = freshEvidence(CODEX_MODEL);

function digestTree(paths: readonly string[]): string {
  const hash = createHash("sha256");
  const visit = (path: string, label: string): void => {
    if (!existsSync(path)) {
      hash.update(`missing\0${label}\0`);
      return;
    }
    const stat = lstatSync(path);
    hash.update(`${stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f"}\0${label}\0${stat.mode}\0`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${label}/${name}`);
    } else if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else hash.update(readFileSync(path));
  };
  paths.forEach((path, index) => visit(path, String(index)));
  return hash.digest("hex");
}

function git(root: string, ...argv: string[]): string {
  return spawnSync("git", argv, {
    cwd: root,
    env: { ...process.env, ...gitIdentity },
    encoding: "utf8",
    timeout: INSTALL_TIMEOUT,
  }).stdout.trim();
}

function makeJourneyRepository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `archflow-host-selection-${name}-`));
  roots.push(root);
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root });
  if (initialized.status !== 0) throw new Error(`git init failed in ${root}: ${initialized.stderr}`);
  writeFileSync(join(root, "README.md"), "host selection journey\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = spawnSync("archflow-local", ["init"], {
    cwd: root,
    env: installedEnvironment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: INSTALL_TIMEOUT,
  });
  if (scaffolded.status !== 0) throw new Error(`archflow-local init failed: ${scaffolded.stderr}`);
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "host selection policy base");
  return root;
}

function taskState(root: string, task: string): HostEvidence["journey"]["task_state"] {
  const state = JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "state.json"), "utf8")) as {
    phase_instance: string; step: string; status: string; revision: number;
  };
  return {
    phase_instance: state.phase_instance,
    step: state.step,
    status: state.status,
    revision: state.revision,
  };
}

function runClaude(prompt: string, cwd: string): HostRun {
  const developerHome = process.env.HOME;
  if (developerHome === undefined) throw new Error("HOME is required to preserve Claude authentication");
  const configPath = join(installationRoot, "claude-mcp.json");
  writeFileSync(configPath, `${JSON.stringify({
    mcpServers: { archflow: { type: "stdio", command: join(scratchBin, "archflow-mcp"), args: [], timeout: 3_600_000 } },
  })}\n`, { mode: 0o600 });
  const result = spawnSync("claude", [
    "-p",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", configPath,
    "--no-session-persistence",
    "--setting-sources", "",
    "--output-format", "stream-json",
    "--verbose",
    "--model", CLAUDE_MODEL,
    "--effort", CLAUDE_EFFORT,
    "--permission-mode", "auto",
    prompt,
  ], {
    cwd,
    env: {
      ...process.env,
      ...gitIdentity,
      HOME: scratchHome,
      CLAUDE_CONFIG_DIR: join(developerHome, ".claude"),
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT,
  });
  const calls = new Map<string, HostToolCall>();
  const messages: string[] = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block?.type === "tool_use") {
          calls.set(block.id, { name: block.name, input: block.input, isError: false, resultText: "" });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          messages.push(block.text);
        }
      }
    } else if (event?.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && calls.has(block.tool_use_id)) {
          const previous = calls.get(block.tool_use_id)!;
          const text = Array.isArray(block.content)
            ? block.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("")
            : String(block.content ?? "");
          calls.set(block.tool_use_id, { ...previous, isError: block.is_error === true, resultText: text });
        }
      }
    }
  }
  return { exitCode: result.status, stderr: result.stderr ?? "", toolCalls: [...calls.values()], messages };
}

function runCodex(prompt: string, cwd: string): HostRun {
  const developerHome = process.env.HOME;
  if (developerHome === undefined) throw new Error("HOME is required to preserve Codex authentication");
  const result = spawnSync("codex", [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--approve-for-me",
    "-C", cwd,
    "--json",
    "-m", CODEX_MODEL,
    "-c", `model_reasoning_effort=${JSON.stringify(CODEX_EFFORT)}`,
    "-c", `mcp_servers.archflow.command=${JSON.stringify(join(scratchBin, "archflow-mcp"))}`,
    "-c", "mcp_servers.archflow.args=[]",
    "-c", "mcp_servers.archflow.startup_timeout_sec=30",
    "-c", "mcp_servers.archflow.tool_timeout_sec=3600",
  ], {
    cwd,
    env: { ...process.env, ...gitIdentity, HOME: codexHome, CODEX_HOME: join(developerHome, ".codex") },
    input: `${prompt}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT,
  });
  const calls = new Map<string, HostToolCall>();
  const messages: string[] = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event?.item ?? event;
    if (item?.type === "mcp_tool_call") {
      const text = Array.isArray(item.result?.content)
        ? item.result.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("")
        : "";
      calls.set(item.id, { name: item.tool, input: item.arguments, isError: item.status === "failed", resultText: text });
    } else if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
      messages.push(item.text);
    }
  }
  return { exitCode: result.status, stderr: result.stderr ?? "", toolCalls: [...calls.values()], messages };
}

type HostDriver = (prompt: string, cwd: string) => HostRun;

/** The first ArchFlow tool call in observed order, ignoring the host's own exploratory tools. */
function firstArchflowCall(run: HostRun): HostToolCall | undefined {
  return run.toolCalls.find((call) => /^mcp__archflow__|^archflow_/u.test(call.name));
}

function archflowToolName(call: HostToolCall): string {
  return call.name.replace(/^mcp__archflow__/u, "");
}

function parseToolNameList(run: HostRun): string[] | undefined {
  for (const text of [...run.messages].reverse()) {
    const match = /\[[\s\S]*\]/u.exec(text);
    if (match === null) continue;
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) continue;
      return (parsed as string[]).map((entry) => entry.replace(/^mcp__archflow__/u, "")).sort();
    } catch {
      continue;
    }
  }
  return undefined;
}

const SELECTION_PROMPT = (task: string): string =>
  `What is the current status of the ArchFlow task ${task}? Answer in one sentence.`;

const CAPABILITY_PROMPT = (task: string): string =>
  `Call archflow_status exactly once for task ${task} with invocation {"skill":"archflow-prd","intent":"resume"} (a nested JSON object, not a string). Then report the offer token from the response.`;

const JOURNEY_PROMPT = (task: string): string => `Work with the ArchFlow task named ${task} in this repository, using the ArchFlow MCP tools.
Steps:
1) Call archflow_status with arguments {"schema_version":"1","task_id":"${task}","invocation":{"skill":"archflow-prd","intent":"resume"}} — invocation is a nested JSON object, never a string.
2) From that response's next_action, copy the offer token verbatim, then call archflow_apply with the same invocation object, action.offer set to that exact token, and action.submission {"kind":"task-ask","text":"${TASK_ASK}"}.
3) Stop there and report the task's condition and its next action.`;

/**
 * Proves whether the host account can pass the nested invocation object the apply journey
 * needs. A miss here is an environment limitation (for example an account whose tool-call
 * serialization stringifies the property), recorded verbatim — never silently dropped and
 * never silently passed.
 */
function probeJourneyCapability(driver: HostDriver, task: string): { capable: boolean; note: string } {
  const root = makeJourneyRepository("capability");
  const run = driver(CAPABILITY_PROMPT(task), root);
  const attempts = run.toolCalls.filter((call) => archflowToolName(call) === "archflow_status");
  const succeeded = attempts.filter((call) => {
    const invocation = (call.input as { invocation?: unknown } | undefined)?.invocation;
    return typeof invocation === "object" && invocation !== null && call.resultText.includes("\"ok\":true");
  });
  if (succeeded.length > 0) return { capable: true, note: `${succeeded.length} invocation-scoped archflow_status call(s) succeeded` };
  if (attempts.some((call) => call.resultText.includes("received string"))) {
    return {
      capable: false,
      note: `${attempts.length} archflow_status attempt(s) were all rejected because this account's tool calls serialize the nested invocation object as a string, so no archflow_apply journey can execute through this host`,
    };
  }
  return { capable: false, note: `no successful invocation-scoped archflow_status call in ${attempts.length} attempt(s)` };
}

function runAdvertisement(driver: HostDriver, record: HostEvidence): void {
  const root = makeJourneyRepository("advertisement");
  const run = driver(
    "List the exact names of every MCP tool available to you from the archflow server. Reply with only a JSON array of the tool name strings, nothing else.",
    root,
  );
  const listed = parseToolNameList(run);
  expect(listed, `the host did not report a JSON array of archflow tool names: ${run.messages.join(" ")}`).toBeDefined();
  expect(listed).toEqual(["archflow_apply", "archflow_status"]);
  // Every ArchFlow tool the host actually called must also be inside the advertised pair.
  for (const call of run.toolCalls) {
    if (/^mcp__archflow__|^archflow_/u.test(call.name)) {
      expect(["archflow_apply", "archflow_status"]).toContain(archflowToolName(call));
    }
  }
  record.advertisement = { status: "passed", tool_names: listed! };
}

function runFirstCallSelection(driver: HostDriver, task: string, record: HostEvidence): void {
  const root = makeJourneyRepository("selection");
  const prompt = SELECTION_PROMPT(task);
  expect(prompt).not.toMatch(/archflow_|archflow-local|invocation|offer|schema_version|\bskill\b/u);
  const run = driver(prompt, root);
  const first = firstArchflowCall(run);
  expect(first, `no ArchFlow tool call was observed: ${run.messages.join(" ")}`).toBeDefined();
  expect(archflowToolName(first!)).toBe("archflow_status");
  const input = first!.input as { task_id?: unknown } | undefined;
  expect(input?.task_id).toBe(task);
  record.first_call_selection = {
    status: "passed",
    prompt,
    first_archflow_tool: "archflow_status",
    task_id: typeof input?.task_id === "string" ? input.task_id : null,
  };
}

function runJourneySlice(driver: HostDriver, task: string, record: HostEvidence): void {
  const root = makeJourneyRepository("journey");
  const run = driver(JOURNEY_PROMPT(task), root);
  const initializeApplies = run.toolCalls.filter((call) => {
    if (archflowToolName(call) !== "archflow_apply") return false;
    const action = (call.input as { action?: { submission?: { kind?: unknown } } } | undefined)?.action;
    return action?.submission?.kind === "task-ask";
  });
  expect(initializeApplies.length, `no initialize-task archflow_apply call was observed: ${run.messages.join(" ")}`).toBeGreaterThan(0);
  const succeeded = initializeApplies.find((call) => call.resultText.includes("\"ok\":true"));
  expect(succeeded, `the initialize-task archflow_apply never succeeded: ${run.messages.join(" ")}`).toBeDefined();
  const result = JSON.parse(succeeded!.resultText) as { value?: { next_action?: { kind?: unknown } } };
  expect(result.value?.next_action?.kind).toBe("submit-work");
  const state = taskState(root, task);
  expect(state).toMatchObject({ phase_instance: "prd", step: "produce", status: "running" });
  record.journey = {
    status: "completed",
    reason: "",
    initialize_task_apply_seen: true,
    final_next_action_kind: "submit-work",
    task_state: state,
  };
}

if (REAL_HOSTS_AVAILABLE) {
  const developerHome = process.env.HOME;
  if (developerHome === undefined) throw new Error("HOME is required for the non-mutation assertion");
  developerSkillsBefore = digestTree([
    join(developerHome, ".claude", "skills"),
    join(developerHome, ".agents", "skills"),
  ]);
  const claudeState = join(developerHome, ".claude.json");
  if (existsSync(claudeState)) {
    const projects = (JSON.parse(readFileSync(claudeState, "utf8")) as { projects?: Record<string, unknown> }).projects ?? {};
    developerClaudeProjectsBefore = Object.keys(projects).filter((path) => path.includes("archflow-host-selection")).sort();
  }
  installationRoot = mkdtempSync(join(tmpdir(), "archflow-host-selection-"));
  checkoutRoot = join(installationRoot, "checkout");
  scratchHome = join(installationRoot, "home");
  scratchBin = join(installationRoot, "bin");
  codexHome = join(installationRoot, "codex-home");
  mkdirSync(scratchHome, { recursive: true });
  mkdirSync(scratchBin, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(checkoutRoot, { recursive: true });
  for (const path of ["dist", "assets", "skills"]) {
    cpSync(join(repositoryRoot, path), join(checkoutRoot, path), { recursive: true });
  }
  for (const path of ["install.sh", "package.json"]) {
    cpSync(join(repositoryRoot, path), join(checkoutRoot, path));
  }
  chmodSync(join(checkoutRoot, "install.sh"), 0o755);
  installedEnvironment = {
    ...process.env,
    ...gitIdentity,
    HOME: scratchHome,
    ARCHFLOW_HOME: join(installationRoot, "archflow-home"),
    ARCHFLOW_BIN: scratchBin,
    PATH: `${scratchBin}:${process.env.PATH ?? ""}`,
  };
  const installed = spawnSync("./install.sh", [], {
    cwd: checkoutRoot, env: installedEnvironment, encoding: "utf8", timeout: INSTALL_TIMEOUT,
  });
  if (installed.status !== 0) throw new Error(`scratch install failed: ${installed.stderr}`);
  if (digestTree([join(developerHome, ".claude", "skills"), join(developerHome, ".agents", "skills")]) !== developerSkillsBefore) {
    throw new Error("the scratch install mutated the developer's shared skill directories");
  }
  claudeEvidence.cli_version = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout.trim();
  codexEvidence.cli_version = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout.trim();
  const claudeProbe = probeJourneyCapability(runClaude, "hostsel-claude-capability");
  claudeJourneyCapable = claudeProbe.capable;
  claudeCapabilityNote = claudeProbe.note;
  const codexProbe = probeJourneyCapability(runCodex, "hostsel-codex-capability");
  codexJourneyCapable = codexProbe.capable;
  codexCapabilityNote = codexProbe.note;
}

afterAll(() => {
  const developerHome = process.env.HOME;
  if (REAL_HOSTS_AVAILABLE && developerHome !== undefined) {
    expect(digestTree([join(developerHome, ".claude", "skills"), join(developerHome, ".agents", "skills")]))
      .toBe(developerSkillsBefore);
    // The real credential directory is reused, but HOME is scratch-isolated so headless runs must
    // not add project records to the developer's remembered Claude state.
    const claudeState = join(developerHome, ".claude.json");
    if (existsSync(claudeState)) {
      const projects = (JSON.parse(readFileSync(claudeState, "utf8")) as { projects?: Record<string, unknown> }).projects ?? {};
      expect(Object.keys(projects).filter((path) => path.includes("archflow-host-selection")).sort())
        .toEqual(developerClaudeProjectsBefore);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (installationRoot !== "") rmSync(installationRoot, { recursive: true, force: true });
});

describe("host-selection digest contract", () => {
  it("binds the recorded artifact, its thresholds sidecar, and its observed metrics", async () => {
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
      readonly host_selection_result_digest: string;
      readonly observation_payload: PlainJsonValue & {
        readonly bundle_manifest_sha256: string;
        readonly hosts: Readonly<Record<"claude" | "codex", HostEvidence>>;
        readonly observed_metrics: Readonly<Record<string, number>>;
      };
    };
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
      readonly host_selection_result_digest: string;
      readonly observed_metrics: Readonly<Record<string, number>>;
      readonly thresholds: Readonly<Record<string, number>>;
    };
    expect(canonicalJsonDigest(artifact.observation_payload)).toBe(artifact.host_selection_result_digest);
    // The recorded evidence must describe the bytes this checkout ships: a dist regeneration
    // without re-running the opt-in real-host suite leaves a stale digest here, and this
    // always-on assertion is what fails `npm run check` instead of relying on operator memory.
    expect(artifact.observation_payload.bundle_manifest_sha256).toBe(
      createHash("sha256").update(readFileSync(join(process.cwd(), "dist", "manifest.json"))).digest("hex"),
    );
    expect(sidecar.host_selection_result_digest).toBe(artifact.host_selection_result_digest);
    expect(sidecar.observed_metrics).toEqual(artifact.observation_payload.observed_metrics);
    expect(sidecar.thresholds).toEqual(DESIGN_THRESHOLDS);
    expect(Object.keys(artifact.observation_payload.hosts).sort()).toEqual(["claude", "codex"]);
    for (const host of ["claude", "codex"] as const) {
      const evidence = artifact.observation_payload.hosts[host]!;
      expect(evidence.advertisement.status).toBe("passed");
      expect(evidence.advertisement.tool_names).toEqual(["archflow_apply", "archflow_status"]);
      expect(evidence.first_call_selection.status).toBe("passed");
      expect(evidence.first_call_selection.first_archflow_tool).toBe("archflow_status");
      expect(["completed", "blocked"]).toContain(evidence.journey.status);
      if (evidence.journey.status === "blocked") expect(evidence.journey.reason).not.toBe("");
    }
  });
});

describe.skipIf(!REAL_HOSTS_AVAILABLE)("real-host tool selection and semantic journey", () => {
  it("advertises exactly the semantic pair in Claude Code", () => {
    runAdvertisement(runClaude, claudeEvidence);
  }, TIMEOUT);

  it("advertises exactly the semantic pair in Codex", () => {
    runAdvertisement(runCodex, codexEvidence);
  }, TIMEOUT);

  it("selects archflow_status first for a plain-language status question in Claude Code", () => {
    runFirstCallSelection(runClaude, "hostsel-claude", claudeEvidence);
  }, TIMEOUT);

  it("selects archflow_status first for a plain-language status question in Codex", () => {
    runFirstCallSelection(runCodex, "hostsel-codex", codexEvidence);
  }, TIMEOUT);

  it.skipIf(!claudeJourneyCapable)(
    "drives initialize-task with a task-ask and reaches submit-work in Claude Code",
    () => {
      runJourneySlice(runClaude, "hostsel-claude-journey", claudeEvidence);
    },
    TIMEOUT,
  );

  it.skipIf(!codexJourneyCapable)(
    "drives initialize-task with a task-ask and reaches submit-work in Codex",
    () => {
      runJourneySlice(runCodex, "hostsel-codex-journey", codexEvidence);
    },
    TIMEOUT,
  );

  it("records the selection and journey observation under docs/validation", async () => {
    if (!claudeJourneyCapable) {
      claudeEvidence.journey = { ...claudeEvidence.journey, status: "blocked", reason: claudeCapabilityNote };
    }
    if (!codexJourneyCapable) {
      codexEvidence.journey = { ...codexEvidence.journey, status: "blocked", reason: codexCapabilityNote };
    }
    const hosts: Readonly<Record<"claude" | "codex", HostEvidence>> = { claude: claudeEvidence, codex: codexEvidence };
    const observedMetrics = {
      advertisement_hosts: Object.values(hosts).filter((host) => host.advertisement.status === "passed").length,
      first_call_selection_hosts: Object.values(hosts).filter((host) => host.first_call_selection.status === "passed").length,
      completed_journey_hosts: Object.values(hosts).filter((host) => host.journey.status === "completed").length,
      blocked_journey_hosts: Object.values(hosts).filter((host) => host.journey.status === "blocked").length,
    };
    const observationPayload = {
      schema_version: "1",
      suite: "test/real-host/host-selection.test.ts",
      bundle_manifest_sha256: installationRoot === ""
        ? ""
        : createHash("sha256").update(readFileSync(join(checkoutRoot, "dist", "manifest.json"))).digest("hex"),
      hosts,
      observed_metrics: observedMetrics,
    } as const satisfies PlainJsonValue;
    const document = {
      schema_version: "1",
      host_selection_result_digest: canonicalJsonDigest(observationPayload),
      observation_payload: observationPayload,
    } as const satisfies PlainJsonValue;
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, canonicalJsonBytes(document), { mode: 0o644 });
    await writeFile(sidecarPath, canonicalJsonBytes({
      schema_version: "1",
      host_selection_result_digest: document.host_selection_result_digest,
      observed_metrics: observedMetrics,
      thresholds: DESIGN_THRESHOLDS,
      recorded_at: new Date().toISOString().slice(0, 10),
    }), { mode: 0o644 });
    expect(observedMetrics.advertisement_hosts).toBe(2);
    expect(observedMetrics.first_call_selection_hosts).toBe(2);
  }, TIMEOUT);
});
