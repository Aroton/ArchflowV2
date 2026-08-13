import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import { parseGateDecisionRecord, parseGateRequest } from "../contracts/durable-gate.js";
import { parseResultManifest } from "../contracts/durable-result-manifest.js";
import { parseDocumentArtifact } from "../contracts/durable-document.js";
import { parseImplementationOutput } from "../contracts/durable-implementation-output.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug, type SafeCode } from "../contracts/evidence.js";
import { createVerifiedEvidenceReference } from "../contracts/internal/trust-mints.js";
import { parseRepositoryPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { renderReviewEvidence } from "../contracts/renderers.js";
import { parseReviewEvidence } from "../contracts/review.js";
import { parseAdjudicationEvidence } from "../contracts/adjudication.js";
import { parseTriageCandidate } from "../contracts/triage.js";
import {
  parseWorkspacePathClaim,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  resultAuthorityClaim,
  type ResolvedTaskPath,
} from "../repository/paths.js";
import { writeGateDecisionChoice, writeGateDecisionInterface } from "../state/gates.js";
import { ensurePayloadParent, ensureResultDirectory } from "../state/layout.js";
import { createProductionServices } from "../state/production.js";
import { computeTaskStatus, projectBriefStatus } from "../state/status.js";
import { installSnapshot, prepareSnapshot, restoreSnapshotOutput } from "../state/snapshots.js";
import { reconcileCurrentAuthority } from "../state/reconciliation.js";
import type { ProjectResult } from "../contracts/errors.js";
import { runInit } from "../init/index.js";
import { stageLegacyUpgrade } from "../init/legacy-upgrade.js";
import { BUILD_REQUEST_KINDS, runBuildRequest } from "./build-request.js";
import { computeCallEnvelope } from "./call-envelope.js";
import { classifyWorkflowStatus } from "./status-classification.js";
import { cleanTaskWorkspace, cleanTerminalTaskWorkspace } from "../state/workspace-cleanup.js";

export const LOCAL_COMMANDS = Object.freeze([
  "validate", "hash", "render", "snapshot", "restore", "clean", "decide",
  "status", "reconcile", "init", "envelope", "build-request",
  "manual-status", "upgrade",
] as const);
export type LocalCommand = typeof LOCAL_COMMANDS[number];

export type LocalCommandContract = Readonly<{
  payload: string | null;   // null = input-free: never reads stdin
  task: "required" | "optional" | "ignored";
}>;

export const LOCAL_COMMAND_CONTRACTS: Readonly<Record<LocalCommand, LocalCommandContract>> = Object.freeze({
  validate: { payload: '{"kind":<artifact kind>,"value":<artifact>}', task: "ignored" },
  hash: { payload: "<any plain-JSON value>", task: "ignored" },
  render: { payload: '{"kind":"review"|"adjudication","value":<review or adjudication artifact>}', task: "ignored" },
  snapshot: { payload: '{"manifest":<result manifest>,"payloads":[...],"retained_task_bytes":<n>}', task: "required" },
  restore: { payload: '{"result_digest":<sha256>,"output_path":<path>}', task: "required" },
  clean: { payload: null, task: "required" },
  decide: { payload: '{"kind":"choice","choice":<presentation option token>,"reason":<human reason>} (legacy interface payload remains accepted)', task: "required" },
  status: { payload: null, task: "required" },
  reconcile: { payload: '{"recorded_projections":[...],"current_projections":[...],"active_heads":{...}}', task: "required" },
  init: { payload: null, task: "ignored" },
  envelope: { payload: '{"tool":<tool name>,"input":<tool input>}', task: "required" },
  "build-request": { payload: `{"intent_id"?:<id; omitted = generated>,"kind"?:${BUILD_REQUEST_KINDS.map((kind) => JSON.stringify(kind)).join("|")},...kind facts: none (initialize/counter-review), "step" (running), "document"/"implementation" (produce), "dispositions":[...] (triage), "summary" (gate)}`, task: "required" },
  "manual-status": { payload: null, task: "required" },
  upgrade: { payload: "<legacy staging descriptor>", task: "optional" },
});

export const INPUT_FREE_COMMANDS: ReadonlySet<LocalCommand> =
  new Set(LOCAL_COMMANDS.filter((command) => LOCAL_COMMAND_CONTRACTS[command].payload === null));


type CommandInput = Readonly<{
  command: LocalCommand;
  working_directory: string;
  task_id?: string;
  value?: unknown;
  /** status only: project the routine-loop brief view of the same computed status. */
  brief?: boolean;
}>;

function requireValue(input: CommandInput): PlainJsonValue {
  assertPlainJson(input.value, `${input.command} input payload`);
  return structuredClone(input.value);
}

function recordValue(input: CommandInput): Record<string, PlainJsonValue> {
  const value = requireValue(input);
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new TypeError(`${input.command} input payload must be a JSON object`);
  return value as Record<string, PlainJsonValue>;
}

function validateArtifact(value: Record<string, PlainJsonValue>): PlainJsonValue {
  const artifact = value.value;
  switch (value.kind) {
    case "result-manifest": return parseResultManifest(artifact);
    case "gate-request": return parseGateRequest(artifact);
    case "gate-decision": return parseGateDecisionRecord(artifact);
    case "review": return parseReviewEvidence(artifact);
    case "adjudication": return parseAdjudicationEvidence(artifact);
    case "triage": return parseTriageCandidate(artifact);
    case "document": return parseDocumentArtifact(artifact);
    case "implementation-output": return parseImplementationOutput(artifact);
    default: throw new TypeError("validate input.kind is not supported");
  }
}

async function services(input: CommandInput) {
  const taskId = parseTaskSlug(input.task_id);
  const created = await createProductionServices({
    working_directory: input.working_directory,
    task_id: taskId,
    operation: input.command as SafeCode,
  });
  return created;
}

async function init(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  return runInit({ working_directory: input.working_directory });
}

async function upgrade(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const value = recordValue(input);
  return stageLegacyUpgrade({
    working_directory: input.working_directory,
    source_root: String(value.source_root),
    task_id: String(value.task_id ?? input.task_id),
    policy_base_commit: String(value.policy_base_commit),
    import_baseline_commit: String(value.import_baseline_commit),
    code_baseline_commit: String(value.code_baseline_commit),
    ...(value.exclude === undefined ? {} : { exclude: value.exclude as unknown as readonly string[] }),
  });
}

async function validate(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  return validateArtifact(recordValue(input));
}

async function hash(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  return { digest: canonicalJsonDigest(requireValue(input)) };
}

async function render(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const value = recordValue(input);
  const evidence = value.kind === "review" ? parseReviewEvidence(value.value)
    : value.kind === "adjudication" ? parseAdjudicationEvidence(value.value)
    : undefined;
  if (evidence === undefined) throw new TypeError("render input.kind must be review or adjudication");
  const verified = createVerifiedEvidenceReference(evidence as never);
  const bytes = value.kind === "review" ? renderReviewEvidence(verified as never) : (await import("../contracts/renderers.js")).renderAdjudicationEvidence(verified as never);
  return { markdown: new TextDecoder().decode(bytes), digest: sha256Bytes(bytes) };
}

async function clean(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  const { authority, dependencies, state } = created.value;
  if (state === undefined) throw new TypeError("clean requires current task state");
  let terminal = false;
  const cleaned = await dependencies.lock.runExclusive(authority.workspace_root, async () => {
    const current = await dependencies.read_state(authority.state);
    if (current.kind !== "canonical") throw new TypeError("clean requires canonical current task state");
    terminal = current.document.value.terminal !== undefined;
    return cleanTaskWorkspace(dependencies, authority, current.document.value);
  });
  if (!cleaned.ok || !terminal) return cleaned;
  const terminalCleanup = await cleanTerminalTaskWorkspace(dependencies, authority);
  if (!terminalCleanup.ok) return terminalCleanup;
  return Object.freeze({
    schema_version: "1",
    ok: true,
    value: Object.freeze({
      removed_files: parseSafeInteger(cleaned.value.removed_files + terminalCleanup.value.removed_files),
      removed_bytes: parseSafeInteger(cleaned.value.removed_bytes + terminalCleanup.value.removed_bytes),
      retained_files: parseSafeInteger(cleaned.value.retained_files + terminalCleanup.value.retained_files),
      retained_bytes: parseSafeInteger(cleaned.value.retained_bytes + terminalCleanup.value.retained_bytes),
      cleanup_pending: terminalCleanup.value.cleanup_pending,
    }),
  });
}

async function manualStatus(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  return classifyWorkflowStatus({
    working_directory: input.working_directory,
    task_id: parseTaskSlug(input.task_id),
  });
}

async function status(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  const computed = await computeTaskStatus(created.value.dependencies, created.value.authority);
  if (!computed.ok || input.brief !== true) return computed;
  return Object.freeze({ schema_version: "1", ok: true, value: projectBriefStatus(computed.value) });
}

async function envelope(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  return computeCallEnvelope(created.value, requireValue(input));
}

async function buildRequest(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  return runBuildRequest(created.value, requireValue(input) as PlainJsonValue);
}

async function snapshot(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  const value = recordValue(input);
  const manifest = parseResultManifest(value.manifest);
  const resultDigest = canonicalDocument(manifest).digest;
  await ensureResultDirectory(created.value.authority, resultDigest);
  const payloadValues = Array.isArray(value.payloads) ? value.payloads : [];
  const payloads = [];
  for (const item of payloadValues) {
    if (item === null || Array.isArray(item) || typeof item !== "object") throw new TypeError("snapshot payload must be an object");
    const path = parseRepositoryPathClaim((item as Record<string, PlainJsonValue>).path);
    const bytes = Buffer.from(String((item as Record<string, PlainJsonValue>).bytes_base64), "base64");
    const claim = parseWorkspacePathClaim(`cache/results/${resultDigest}/payload/${path}`);
    const target = await resolveTaskWorkspacePath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim, expectedClass: "workspace-result-payload", context: created.value.authority.context });
    if (!target.ok) return target;
    await ensurePayloadParent(created.value.authority, resultDigest, target.value.absolute);
    payloads.push({ path, target: target.value, bytes: new Uint8Array(bytes) });
  }
  const prepared = prepareSnapshot({ manifest, payloads, retained_task_bytes: parseSafeInteger(value.retained_task_bytes), validate_manifest: parseResultManifest });
  if (!prepared.ok) return prepared;
  const manifestTarget = await resolveTaskPath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim: resultAuthorityClaim(resultDigest), expectedClass: "authority-result", context: created.value.authority.context });
  if (!manifestTarget.ok) return manifestTarget;
  return installSnapshot(created.value.dependencies.atomic, prepared.value, manifestTarget.value, created.value.runner.location.worktreeRoot as never);
}

async function restore(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  const value = recordValue(input);
  const resultDigest = parseSha256Digest(value.result_digest);
  const outputPath = parseRepositoryPathClaim(value.output_path);
  const manifestTarget = await resolveTaskPath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim: resultAuthorityClaim(resultDigest), expectedClass: "authority-result", context: created.value.authority.context });
  if (!manifestTarget.ok) return manifestTarget;
  const payloadTarget = await resolveTaskWorkspacePath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim: parseWorkspacePathClaim(`cache/results/${resultDigest}/payload/${outputPath}`), expectedClass: "workspace-result-payload", context: created.value.authority.context });
  if (!payloadTarget.ok) return payloadTarget;
  const restored = await restoreSnapshotOutput({ target: manifestTarget.value, expected_result_digest: resultDigest, runner: created.value.runner, worktree_root: created.value.runner.location.worktreeRoot as never, output_path: outputPath, payload_target: payloadTarget.value });
  if (!restored.ok || restored.value.state === "absent") return restored;
  return { schema_version: "1", ok: true, value: { ...restored.value, bytes: Buffer.from(restored.value.bytes).toString("base64") } };
}

async function decide(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const value = recordValue(input);
  const created = await services(input);
  if (!created.ok) return created;
  if (value.kind === "choice") {
    const { kind: _kind, ...choice } = value;
    return writeGateDecisionChoice(created.value.dependencies, created.value.authority, choice);
  }
  if (value.kind === "interface") {
    assertPlainJson(value.value, "decide interface value");
    return writeGateDecisionInterface(created.value.dependencies, created.value.authority, structuredClone(value.value));
  }
  throw new TypeError("decide input.kind must be choice or interface");
}

async function reconcile(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  if (created.value.state === undefined) throw new TypeError("reconcile requires current task state");
  const value = recordValue(input);
  const result = reconcileCurrentAuthority({
    state: created.value.state,
    recorded_projections: (value.recorded_projections ?? []) as never,
    current_projections: (value.current_projections ?? []) as never,
    active_heads: (value.active_heads ?? {}) as never,
    ...(value.intent === undefined ? {} : { intent: value.intent as never }),
  });
  return structuredClone(result) as unknown as PlainJsonValue;
}

const LOCAL_COMMAND_HANDLERS: Readonly<Record<LocalCommand, (input: CommandInput) => Promise<PlainJsonValue | ProjectResult<unknown>>>> = Object.freeze({
  validate, hash, render, snapshot, restore, clean, decide,
  status, reconcile, init, envelope,
  "build-request": buildRequest, "manual-status": manualStatus, upgrade,
});

export async function runLocalCommand(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  if (!LOCAL_COMMANDS.includes(input.command)) throw new TypeError(`unknown local command: ${input.command}`);
  return LOCAL_COMMAND_HANDLERS[input.command](input);
}
