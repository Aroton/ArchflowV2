import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import type { HostIdentity } from "../contracts/hosts.js";
import { safeIdV1Schema } from "../contracts/evidence.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import type { AdapterId, ModelFamily } from "../contracts/review.js";
import {
  createAdjudicationObservationCapability,
  createReviewObservationCapability,
} from "../contracts/internal/trust-mints.js";
import {
  observationSource,
  type ObservationBindingByKind,
} from "../contracts/trust.js";
import type {
  AdjudicationSubject,
  DispatchEnvelope,
  DispatchSubject,
} from "../review/envelopes.js";
import {
  runDispatchChild,
  type DispatchChildResult,
  type DispatchChildSpec,
} from "./process.js";
import type { DispatchRoute } from "./routing.js";
import type { DispatchWorkspace } from "./workspace.js";

const CLAUDE_MINIMUM_VERSION = "2.1.205";
const CODEX_MINIMUM_VERSION = "0.122.0";

export const CLAUDE_MANAGED_POLICY_PATHS = Object.freeze([
  "/etc/claude-code/managed-settings.json",
  "/etc/claude-code/managed-settings.d",
  "/etc/claude-code/managed-mcp.json",
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/Library/Application Support/ClaudeCode/managed-settings.d",
  "/Library/Application Support/ClaudeCode/managed-mcp.json",
] as const);

export const CODEX_MANAGED_POLICY_PATHS = Object.freeze([
  "/etc/codex/config.toml",
  "/etc/codex/requirements.toml",
  "/etc/codex/rules",
] as const);

const CODEX_DISABLED_FEATURES = Object.freeze([
  "shell_tool",
  "unified_exec",
  "multi_agent",
  "browser_use",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "apps",
  "hooks",
  "in_app_browser",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "skill_search",
] as const);

export type CliPreflight = Readonly<{
  cli_version: string;
  managed_policy_present: boolean;
  managed_policy_paths: readonly string[];
}>;

export type CliInvocation = Omit<DispatchChildSpec, "signal" | "cancellation_source">;
type CancellationSource = NonNullable<DispatchChildSpec["cancellation_source"]>;

export interface CliAdapter {
  readonly id: AdapterId;
  readonly family: ModelFamily;
  preflight(
    workspace: DispatchWorkspace,
    signal?: AbortSignal,
    cancellationSource?: CancellationSource,
  ): Promise<CliPreflight>;
  buildInvocation(
    envelope: DispatchEnvelope,
    route: DispatchRoute,
    workspace: DispatchWorkspace,
    outputSchema: PlainJsonValue,
  ): Promise<CliInvocation>;
  parseOutput(result: DispatchChildResult): Uint8Array;
  classifyFailure(result: DispatchChildResult): ProjectError | undefined;
}

export type CliDispatchOptions = Readonly<{
  allow_claude_dispatch?: boolean;
}>;

const HOST_SCHEMA_METADATA = new Set(["$schema", "$id"]);
const CLAUDE_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "format",
  "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
]);

function projectSchemaNode(value: PlainJsonValue, adapter: AdapterId): PlainJsonValue {
  if (Array.isArray(value)) return value.map((item) => projectSchemaNode(item, adapter));
  if (value === null || typeof value !== "object") return value;
  const projected: Record<string, PlainJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (HOST_SCHEMA_METADATA.has(key) || key.startsWith("x-archflow-") || key === "allOf" ||
        (adapter === "claude-cli" && CLAUDE_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) ||
        (adapter === "codex-cli" && key === "uniqueItems")) continue;
    projected[key] = projectSchemaNode(child, adapter);
  }
  return projected;
}

function scalarType(value: PlainJsonValue): "string" | "number" | "boolean" | "null" | "array" | "object" | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return undefined;
}

function codexStrictNode(value: PlainJsonValue): PlainJsonValue {
  if (Array.isArray(value)) return value.map(codexStrictNode);
  if (value === null || typeof value !== "object") return value;
  const node = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, codexStrictNode(child)])) as Record<string, PlainJsonValue>;
  if (node.type === undefined && node.const !== undefined) node.type = scalarType(node.const) ?? "string";
  if (node.type === undefined && Array.isArray(node.enum) && node.enum.length > 0) {
    const types = new Set(node.enum.map(scalarType));
    if (types.size === 1 && !types.has(undefined)) node.type = [...types][0]!;
  }
  if (node.type === "object" && node.properties !== null && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    node.required = Object.keys(node.properties);
  }
  return node;
}

/**
 * Binds one server-derived subject field into the child's output schema so the child cannot return
 * a result bound to a different task, digest, or rubric.
 *
 * A scalar binds as an exact `const`. An array cannot, on Codex: OpenAI structured outputs rejects
 * an array-valued `const` outright — `Invalid schema for response_format 'codex_output_schema':
 * context=('properties', 'approved_upstream_digests'), Unexpected constant value: []` — which
 * failed every constitution review whose subject had no approved upstream. The equivalent Codex
 * binding is exact cardinality plus a closed element set: `parseAndDeriveAdjudication` requires
 * `approved_upstream_digests` to be sorted and unique, so a same-length array drawn from the same
 * set is the same array, and `observationSource.observeAdjudication` still compares element by
 * element before any evidence is minted. One shape serves both the empty and non-empty case, so
 * whichever the host accepts, it accepts both.
 *
 * Claude keeps the plain `const`: its projection deliberately strips `minItems`/`maxItems`, and it
 * accepts an array `const` today.
 */
function boundSubjectNode(property: PlainJsonValue, value: PlainJsonValue, adapter: AdapterId): PlainJsonValue {
  if (adapter !== "codex-cli" || !Array.isArray(value)) return { const: structuredClone(value) };
  const arrayProperty = property === null || typeof property !== "object" || Array.isArray(property)
    ? undefined
    : property as Readonly<Record<string, PlainJsonValue>>;
  const items = arrayProperty?.items;
  if (items === null || typeof items !== "object" || Array.isArray(items)) {
    throw new TypeError("array subject binding requires an array property schema with an object items schema");
  }
  if (value.some((element) => element !== null && typeof element === "object")) {
    throw new TypeError("array subject binding requires scalar elements");
  }
  const element = structuredClone(items) as Record<string, PlainJsonValue>;
  return {
    type: "array",
    items: value.length === 0 ? element : { ...element, enum: [...new Set(value)] },
    minItems: value.length,
    maxItems: value.length,
  };
}

function hostFindingSchema(value: PlainJsonValue): PlainJsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const finding = value as Readonly<Record<string, PlainJsonValue>>;
  const properties = finding.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return value;
  const base = properties as Readonly<Record<string, PlainJsonValue>>;
  const branch = (severities: readonly string[], blocking: boolean): PlainJsonValue => {
    const selected = {
      ...base,
      severity: { type: "string", enum: [...severities] },
      blocking: { type: "boolean", const: blocking },
    };
    return { type: "object", additionalProperties: false, properties: selected, required: Object.keys(selected) };
  };
  return {
    type: "object",
    anyOf: [
      branch(["blocker"], true),
      branch(["major", "minor"], false),
    ],
  };
}

function hostTaskSlugSchema(value: PlainJsonValue): PlainJsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...(value as Readonly<Record<string, PlainJsonValue>>),
    // Both hosts accept ordinary regex patterns but not the normative reserved-name lookaheads.
    // The exact task-slug parser still runs during local output validation and attestation.
    pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
  };
}

/**
 * Projects the two normative output contracts to the structured-output subset accepted by both
 * installed hosts. Conditional semantics remain enforced by local parsing and attestation after
 * output; required fields and closed object shapes remain in the transport schema.
 */
export function projectCliOutputSchema(
  outputSchema: PlainJsonValue,
  resultKind: DispatchEnvelope["result_kind"],
  adapter: AdapterId,
  subject?: Readonly<Record<string, PlainJsonValue>>,
): PlainJsonValue {
  assertPlainJson(outputSchema, "CLI output schema");
  const snapshot = structuredClone(outputSchema);
  const projected = projectSchemaNode(snapshot, adapter);
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)) {
    throw new TypeError("CLI output schema must be an object");
  }
  let root = projected as Readonly<Record<string, PlainJsonValue>>;
  const definitions = root.$defs;
  if (definitions !== null && typeof definitions === "object" && !Array.isArray(definitions)) {
    const named = definitions as Readonly<Record<string, PlainJsonValue>>;
    const common: Record<string, PlainJsonValue> = { ...named, taskSlug: hostTaskSlugSchema(named.taskSlug!) };
    root = {
      ...root,
      $defs: resultKind === "review"
        ? { ...common, finding: hostFindingSchema(common.finding!) }
        : common,
    };
  }
  const bindingKeys = resultKind === "review"
    ? ["task_id", "phase_instance", "step", "role", "subject_digest", "input_fingerprint", "rubric_digest", "producer_family"]
    : ["task_id", "phase_instance", "step", "subject_digest", "input_fingerprint", "pinned_constitution_digest", "approved_upstream_digests", "source_evidence_set_digest"];
  if (subject !== undefined) {
    const properties = root.properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      throw new TypeError("CLI output schema must declare properties");
    }
    const bound = { ...(properties as Readonly<Record<string, PlainJsonValue>>) };
    for (const key of bindingKeys) {
      const value = subject[key];
      if (value !== undefined) bound[key] = boundSubjectNode(bound[key]!, value, adapter);
    }
    root = { ...root, properties: bound };
  }
  return adapter === "codex-cli" ? codexStrictNode(root) : root;
}

function envelopeSubject(envelope: DispatchEnvelope): Readonly<Record<string, PlainJsonValue>> {
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.bytes));
  assertPlainJson(decoded, "dispatch envelope");
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError("dispatch envelope must be an object");
  const subject = (decoded as Readonly<Record<string, PlainJsonValue>>).subject;
  if (subject === undefined) return {};
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) throw new TypeError("dispatch envelope subject must be an object");
  return subject as Readonly<Record<string, PlainJsonValue>>;
}

let dispatchQueue: Promise<void> = Promise.resolve();

/**
 * Serializes dispatch operations through one process-wide FIFO. This bounds one MCP server
 * process to one resource-intensive reviewer at a time; authentication remains owned and
 * coordinated by each first-party CLI through its canonical credential store.
 */
export function serializeDispatch<T>(operation: () => Promise<T>): Promise<T> {
  const result = dispatchQueue.then(operation);
  dispatchQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export type ReviewObservationMint = Readonly<{
  subject: DispatchSubject;
  adapter: AdapterId;
  cli_version: string;
  route: DispatchRoute;
  envelope_input_digest: ObservationBindingByKind["review"]["envelope_input_digest"];
  extracted_output_bytes: Uint8Array;
}>;

export type AdjudicationObservationMint = Readonly<{
  subject: AdjudicationSubject;
  adapter: AdapterId;
  cli_version: string;
  route: DispatchRoute;
  envelope_input_digest: ObservationBindingByKind["adjudication"]["envelope_input_digest"];
  extracted_output_bytes: Uint8Array;
}>;

export class CliAdapterError extends Error {
  public constructor(
    public readonly project_error: ProjectError,
    public readonly cli_version?: string,
  ) {
    super(project_error.code);
    this.name = "CliAdapterError";
  }
}

const fail = (error: ProjectError, cliVersion?: string): never => {
  throw new CliAdapterError(error, cliVersion);
};

function decodeJson(bytes: Uint8Array, adapter: AdapterId, issueCode: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    assertPlainJson(value, "CLI JSON output");
    return value;
  } catch {
    return fail(createProjectError("MODEL_OUTPUT_INVALID", {
      adapter,
      attempt: 1,
      issue_code: issueCode,
    }));
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function exactVersion(adapter: AdapterId, output: Uint8Array): string {
  const text = Buffer.from(output).toString("utf8").trim();
  const match = adapter === "claude-cli"
    ? /^(\d+\.\d+\.\d+) \(Claude Code\)$/u.exec(text)
    : /^codex-cli (\d+\.\d+\.\d+)$/u.exec(text);
  return match?.[1] ?? "unrecognized";
}

/** Detects present managed-policy paths; exported for the real-host positive-branch probe. */
export async function detectManagedPolicyPaths(paths: readonly string[]): Promise<readonly string[]> {
  const observations = await Promise.all(paths.map(async (path) => {
    try {
      await stat(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return path;
    }
  }));
  return Object.freeze(observations.filter((path): path is string => path !== undefined));
}

async function runPreflightCommand(
  adapter: AdapterId,
  command: string,
  argv: readonly string[],
  workspace: DispatchWorkspace,
  signal: AbortSignal,
  cancellationSource: CancellationSource,
): Promise<DispatchChildResult> {
  return runDispatchChild({
    adapter,
    command,
    argv,
    cwd: workspace.root,
    env: workspace.env,
    signal,
    cancellation_source: cancellationSource,
  });
}

async function preflight(
  adapter: AdapterId,
  command: string,
  versionArgv: readonly string[],
  authArgv: readonly string[],
  minimumVersion: string,
  policyPaths: readonly string[],
  workspace: DispatchWorkspace,
  signal: AbortSignal,
  cancellationSource: CancellationSource,
): Promise<CliPreflight> {
  const versionResult = await runPreflightCommand(
    adapter, command, versionArgv, workspace, signal, cancellationSource,
  );
  const version = exactVersion(adapter, versionResult.stdout);
  if (versionResult.exit_code !== 0 || version === "unrecognized" || compareVersions(version, minimumVersion) < 0) {
    return fail(createProjectError("CLI_VERSION_UNSUPPORTED", { adapter, version }));
  }

  const authResult = await runPreflightCommand(
    adapter, command, authArgv, workspace, signal, cancellationSource,
  );
  let loggedIn = false;
  if (adapter === "claude-cli" && authResult.exit_code === 0) {
    try {
      const auth = JSON.parse(authResult.stdout.toString("utf8")) as unknown;
      loggedIn = auth !== null && typeof auth === "object" &&
        Object.getOwnPropertyDescriptor(auth, "loggedIn")?.value === true;
    } catch {
      loggedIn = false;
    }
  } else if (adapter === "codex-cli" && authResult.exit_code === 0) {
    const successLines = [authResult.stdout, authResult.stderr]
      .flatMap((channel) => channel.toString("utf8").split(/\r?\n/u))
      .filter((line) => /^Logged in(?:\s|$)/u.test(line.trim()));
    loggedIn = successLines.length >= 1;
  }
  if (!loggedIn) return fail(createProjectError("AUTH_UNAVAILABLE", { adapter }), version);

  const managedPolicyPaths = await detectManagedPolicyPaths(policyPaths);
  return Object.freeze({
    cli_version: version,
    managed_policy_present: managedPolicyPaths.length > 0,
    managed_policy_paths: managedPolicyPaths,
  });
}

function assertRoute(adapter: AdapterId, route: DispatchRoute): void {
  const expectedFamily = adapter === "claude-cli" ? "claude" : "codex";
  if (route.adapter !== adapter || route.family !== expectedFamily) {
    fail(createProjectError("FAMILY_MISMATCH", {
      expected_family: expectedFamily,
      observed_family: route.family,
    }));
  }
  if (!safeIdV1Schema.safeParse(route.model).success) {
    fail(createProjectError("CONFIG_INVALID", { issue_code: "model-not-safe-id" }));
  }
}

/** Describes how a child ended (exit-N / signal-name) for failure diagnostics and attempt records. */
export function exitClass(result: DispatchChildResult): string {
  if (result.exit_code !== null) return `exit-${String(result.exit_code)}`;
  if (result.signal !== null) return `signal-${result.signal.toLowerCase()}`;
  return "unknown-exit";
}

function modelFromMessage(message: string): string | undefined {
  const quoted = /(?:model|deployment)(?:\s+named)?\s+["'`](?<model>[A-Za-z0-9][A-Za-z0-9._:-]{0,127})["'`]/iu.exec(message)?.groups?.model;
  if (quoted !== undefined && safeIdV1Schema.safeParse(quoted).success) return quoted;
  const slug = /(?<![A-Za-z0-9/_.:-])(?<model>(?:claude-(?:opus|sonnet|haiku)-[A-Za-z0-9.-]+|gpt-[A-Za-z0-9.-]+))(?![A-Za-z0-9/_.:-])/iu.exec(message)?.groups?.model;
  return slug !== undefined && safeIdV1Schema.safeParse(slug).success ? slug : undefined;
}

function classifyMessage(adapter: AdapterId, message: string): ProjectError | undefined {
  if (/\b(?:rate[ -]?limit(?:ed)?|too many requests|usage limit|quota (?:exceeded|reached))\b/iu.test(message)) {
    return createProjectError("RATE_LIMITED", { adapter, attempt: 1 });
  }
  if (/\b(?:not logged in|login required|authentication (?:failed|required)|failed to authenticate|unauthorized|invalid credentials?|oauth session expired|refresh token (?:expired|invalid)|could not be refreshed)\b/iu.test(message)) {
    return createProjectError("AUTH_UNAVAILABLE", { adapter });
  }
  if (/\b(?:model|deployment)\b.*\b(?:not found|not supported|unsupported|does not exist|unknown|invalid)\b/iu.test(message) ||
      /\b(?:not found|not supported|unsupported|does not exist|unknown|invalid)\b.*\b(?:model|deployment)\b/iu.test(message)) {
    const model = modelFromMessage(message);
    if (model !== undefined) return createProjectError("UNSUPPORTED_MODEL", { model });
  }
  return undefined;
}

function claudeFailureMessage(result: DispatchChildResult): string | undefined {
  try {
    const value = JSON.parse(result.stdout.toString("utf8")) as unknown;
    if (value === null || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (record.is_error !== true && record.type !== "error") return undefined;
    return typeof record.result === "string" ? record.result
      : typeof record.error === "string" ? record.error
      : undefined;
  } catch {
    return undefined;
  }
}

function codexFailureMessages(stdout: Uint8Array): readonly string[] {
  const messages: string[] = [];
  for (const line of Buffer.from(stdout).toString("utf8").split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const event = value as Record<string, unknown>;
      let message: unknown;
      if (event.type === "error") message = event.message;
      if (event.type === "turn.failed" && event.error !== null && typeof event.error === "object") {
        message = (event.error as Record<string, unknown>).message;
      }
      if (typeof message === "string" && !messages.includes(message)) messages.push(message);
    } catch {
      // A malformed or non-event JSONL line has no semantic authority.
    }
  }
  return Object.freeze(messages);
}

function classifyNonzero(
  adapter: AdapterId,
  result: DispatchChildResult,
  messages: readonly string[],
): ProjectError | undefined {
  if (result.exit_code === 0 && result.signal === null) return undefined;
  for (const message of messages) {
    const classified = classifyMessage(adapter, message);
    if (classified !== undefined) return classified;
  }
  return createProjectError("PROCESS_FAILED", { adapter, exit_class: exitClass(result) });
}

const claudeAdapter: CliAdapter = Object.freeze({
  id: "claude-cli",
  family: "claude",
  preflight: (
    workspace: DispatchWorkspace,
    signal = new AbortController().signal,
    cancellationSource: CancellationSource = "client",
  ) => preflight(
    "claude-cli",
    "claude",
    ["--version"],
    ["auth", "status"],
    CLAUDE_MINIMUM_VERSION,
    CLAUDE_MANAGED_POLICY_PATHS,
    workspace,
    signal,
    cancellationSource,
  ),
  async buildInvocation(
    envelope: DispatchEnvelope,
    route: DispatchRoute,
    workspace: DispatchWorkspace,
    outputSchema: PlainJsonValue,
  ) {
    assertRoute("claude-cli", route);
    const schema = projectCliOutputSchema(outputSchema, envelope.result_kind, "claude-cli", envelopeSubject(envelope));
    if (route.effort === "ultra") {
      return fail(createProjectError("CONFIG_INVALID", { issue_code: "effort-unsupported" }));
    }
    const mcpConfigPath = join(workspace.root, "empty-mcp.json");
    await writeFile(mcpConfigPath, '{"mcpServers":{}}\n', { encoding: "utf8", mode: 0o600 });
    // A dispatch workspace with a materialized repository view runs the child inside the view with
    // exactly the read-only tools (no write, bash, or network tools). `--setting-sources ""`,
    // `--disable-slash-commands`, and the empty strict MCP config stay pinned so the view's own
    // CLAUDE.md and settings never become instructions. Without a view, every tool stays disabled.
    return Object.freeze({
      adapter: "claude-cli",
      command: "claude",
      argv: Object.freeze([
        "-p",
        "--safe-mode",
        "--tools", workspace.repository_view_root === undefined ? "" : "Read,Grep,Glob",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config", mcpConfigPath,
        "--no-session-persistence",
        "--setting-sources", "",
        "--output-format", "json",
        "--json-schema", JSON.stringify(schema),
        "--model", route.model,
        "--effort", route.effort,
      ]),
      cwd: workspace.repository_view_root ?? workspace.root,
      env: workspace.env,
      stdin: envelope.bytes,
    });
  },
  parseOutput(result: DispatchChildResult) {
    const wrapper = decodeJson(result.stdout, "claude-cli", "claude-wrapper-invalid");
    if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper)) {
      return fail(createProjectError("MODEL_OUTPUT_INVALID", {
        adapter: "claude-cli", attempt: 1, issue_code: "structured-output-missing",
      }));
    }
    const descriptor = Object.getOwnPropertyDescriptor(wrapper, "structured_output");
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return fail(createProjectError("MODEL_OUTPUT_INVALID", {
        adapter: "claude-cli", attempt: 1, issue_code: "structured-output-missing",
      }));
    }
    try {
      assertPlainJson(descriptor.value, "Claude structured output");
      return canonicalJsonBytes(descriptor.value as PlainJsonValue);
    } catch {
      return fail(createProjectError("MODEL_OUTPUT_INVALID", {
        adapter: "claude-cli", attempt: 1, issue_code: "structured-output-invalid",
      }));
    }
  },
  classifyFailure(result: DispatchChildResult) {
    const message = claudeFailureMessage(result);
    return classifyNonzero("claude-cli", result, message === undefined ? [] : [message]);
  },
});

const codexAdapter: CliAdapter = Object.freeze({
  id: "codex-cli",
  family: "codex",
  preflight: (
    workspace: DispatchWorkspace,
    signal = new AbortController().signal,
    cancellationSource: CancellationSource = "client",
  ) => preflight(
    "codex-cli",
    "codex",
    ["--version"],
    ["login", "status"],
    CODEX_MINIMUM_VERSION,
    CODEX_MANAGED_POLICY_PATHS,
    workspace,
    signal,
    cancellationSource,
  ),
  async buildInvocation(
    envelope: DispatchEnvelope,
    route: DispatchRoute,
    workspace: DispatchWorkspace,
    outputSchema: PlainJsonValue,
  ) {
    assertRoute("codex-cli", route);
    const schema = projectCliOutputSchema(outputSchema, envelope.result_kind, "codex-cli", envelopeSubject(envelope));
    const schemaPath = join(workspace.root, `${envelope.result_kind}.schema.json`);
    const outputPath = join(workspace.root, "final-output.json");
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const disabled = CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
    return Object.freeze({
      adapter: "codex-cli",
      command: "codex",
      argv: Object.freeze([
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--strict-config",
        "-s", "read-only",
        // The already read-only sandbox targets the repository view when one is materialized;
        // schema and output files deliberately stay in workspace.root, outside the view.
        "-C", workspace.repository_view_root ?? workspace.root,
        "--json",
        "--output-schema", schemaPath,
        "-o", outputPath,
        "-m", route.model,
        "-c", "skills.include_instructions=false",
        "-c", "project_doc_max_bytes=0",
        "-c", `model_reasoning_effort=${JSON.stringify(route.effort)}`,
        ...disabled,
      ]),
      cwd: workspace.root,
      env: workspace.env,
      stdin: envelope.bytes,
      final_output_path: outputPath,
    });
  },
  parseOutput(result: DispatchChildResult) {
    if (result.final_output === undefined) {
      return fail(createProjectError("MODEL_OUTPUT_INVALID", {
        adapter: "codex-cli", attempt: 1, issue_code: "final-output-missing",
      }));
    }
    decodeJson(result.final_output, "codex-cli", "final-output-invalid");
    return Uint8Array.from(result.final_output);
  },
  classifyFailure(result: DispatchChildResult) {
    return classifyNonzero("codex-cli", result, codexFailureMessages(result.stdout));
  },
});

/** Runs the exact dispatch version/auth/policy preflight for one named adapter. */
export function preflightAdapter(
  adapterId: AdapterId,
  workspace: DispatchWorkspace,
): Promise<CliPreflight> {
  return adapterId === "claude-cli"
    ? claudeAdapter.preflight(workspace)
    : codexAdapter.preflight(workspace);
}

/** Selects the opposite-family reviewer in two compile-time-known arms, before any child launch. */
export function selectCliAdapter(
  host: HostIdentity,
  options: CliDispatchOptions = {},
): CliAdapter {
  if (host === "unknown") return fail(createProjectError("UNSUPPORTED_HOST", { host: "unknown" }));
  if (host === "claude") return codexAdapter;
  if (options.allow_claude_dispatch !== true) {
    return fail(createProjectError("CONFIG_FAMILY_UNSUPPORTED", { family: "claude" }));
  }
  return claudeAdapter;
}

/** Binds extracted child output to its validated dispatch provenance. */
export function mintReviewObservation(input: ReviewObservationMint): ReturnType<typeof observationSource.observeReview> {
  assertRoute(input.adapter, input.route);
  const binding: ObservationBindingByKind["review"] = {
    kind: "review",
    task_id: input.subject.task_id,
    phase_instance: input.subject.phase_instance,
    role: input.subject.role,
    subject_digest: input.subject.subject_digest,
    input_fingerprint: input.subject.input_fingerprint,
    invocation_id: input.subject.invocation_id,
    envelope_input_digest: input.envelope_input_digest,
    result_id: input.subject.result_id,
    adapter: input.adapter,
    cli_version: input.cli_version,
    family: input.route.family,
    model: input.route.model,
    effort: input.route.effort,
    rubric_digest: input.subject.rubric_digest,
    producer_family: input.subject.producer_family,
  };
  const capability = createReviewObservationCapability(binding);
  return observationSource.observeReview(capability, input.extracted_output_bytes);
}

/** Binds extracted adjudicator output to the complete server-derived adjudication subject. */
export function mintAdjudicationObservation(
  input: AdjudicationObservationMint,
): ReturnType<typeof observationSource.observeAdjudication> {
  assertRoute(input.adapter, input.route);
  const binding: ObservationBindingByKind["adjudication"] = {
    kind: "adjudication",
    task_id: input.subject.task_id,
    phase_instance: input.subject.phase_instance,
    role: input.subject.role,
    subject_digest: input.subject.subject_digest,
    input_fingerprint: input.subject.input_fingerprint,
    invocation_id: input.subject.invocation_id,
    envelope_input_digest: input.envelope_input_digest,
    result_id: input.subject.result_id,
    adapter: input.adapter,
    cli_version: input.cli_version,
    family: input.route.family,
    model: input.route.model,
    effort: input.route.effort,
    pinned_constitution_digest: input.subject.pinned_constitution_digest,
    approved_upstream_digests: input.subject.approved_upstream_digests,
    source_evidence_set_digest: input.subject.source_evidence_set_digest,
  };
  const capability = createAdjudicationObservationCapability(binding);
  return observationSource.observeAdjudication(capability, input.extracted_output_bytes);
}
