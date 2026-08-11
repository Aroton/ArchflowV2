import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import { parseMaintenanceRecord, type MaintenanceRecordV1 } from "../contracts/durable-maintenance.js";
import { parseGateDecisionRecord, parseGateRequest } from "../contracts/durable-gate.js";
import { parseResultManifest } from "../contracts/durable-result-manifest.js";
import { parseDocumentArtifact } from "../contracts/durable-document.js";
import { parseImplementationOutput } from "../contracts/durable-implementation-output.js";
import { parsePathSafeId, parseSafeInteger, parseTaskSlug, type SafeCode } from "../contracts/evidence.js";
import { createVerifiedEvidenceReference } from "../contracts/internal/trust-mints.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { renderReviewEvidence } from "../contracts/renderers.js";
import { parseReviewEvidence } from "../contracts/review.js";
import { parseAdjudicationEvidence } from "../contracts/adjudication.js";
import { parseTriageCandidate } from "../contracts/triage.js";
import { parseSupplementalReviewRecord } from "../contracts/supplemental-record.js";
import { gateCounterReviewClaim, gateRequestClaim, gateSupplementalReviewClaim, openResolved, resolveTaskPath, type ResolvedTaskPath } from "../repository/paths.js";
import { writeGateDecisionInterface } from "../state/gates.js";
import { ensureDecisionDirectory, ensureTaskProjectionParent } from "../state/layout.js";
import { ensurePayloadParent, ensureResultDirectory } from "../state/layout.js";
import { computeMaintenanceProof, performMaintenance } from "../state/maintenance.js";
import { enumerateMaintenanceCandidates, enumerateMaintenanceManifests, enumerateMaintenanceRoots } from "../state/maintenance-roots.js";
import { createProductionServices } from "../state/production.js";
import { computeTaskStatus, projectBriefStatus } from "../state/status.js";
import { installSnapshot, prepareSnapshot, restoreSnapshotOutput } from "../state/snapshots.js";
import { reconcileCurrentAuthority } from "../state/reconciliation.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { GateRequestV1 } from "../contracts/durable-gate.js";
import type { SupplementalReviewRecordV1 } from "../contracts/supplemental-record.js";
import { runInit } from "../init/index.js";
import { stageLegacyUpgrade } from "../init/legacy-upgrade.js";
import { BUILD_REQUEST_KINDS, runBuildRequest } from "./build-request.js";
import { computeCallEnvelope } from "./call-envelope.js";
import { classifyWorkflowStatus } from "./status-classification.js";

export const LOCAL_COMMANDS = Object.freeze([
  "validate", "hash", "render", "snapshot", "restore", "maintain", "decide",
  "gate-counter", "status", "reconcile", "init", "envelope", "build-request",
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
  maintain: { payload: '{"maintenance_id":<id>,"human_reason":<text>}', task: "required" },
  decide: { payload: '{"kind":"interface","value":<chosen decision template>}', task: "required" },
  "gate-counter": { payload: "<supplemental review record from the counter-review recipe>", task: "required" },
  status: { payload: null, task: "required" },
  reconcile: { payload: '{"recorded_projections":[...],"current_projections":[...],"active_heads":{...}}', task: "required" },
  init: { payload: null, task: "ignored" },
  envelope: { payload: '{"tool":<tool name>,"input":<tool input>}', task: "required" },
  "build-request": { payload: `{"intent_id"?:<id; omitted = generated>,"kind"?:${BUILD_REQUEST_KINDS.map((kind) => JSON.stringify(kind)).join("|")},...kind facts: none (initialize), "step" (running), "document"/"implementation" (produce), "dispositions":[...] (triage), "rubric" (counter-review), "summary" (gate)}`, task: "required" },
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
    case "supplemental-review": return parseSupplementalReviewRecord(artifact);
    case "review": return parseReviewEvidence(artifact);
    case "adjudication": return parseAdjudicationEvidence(artifact);
    case "triage": return parseTriageCandidate(artifact);
    case "document": return parseDocumentArtifact(artifact);
    case "implementation-output": return parseImplementationOutput(artifact);
    default: throw new TypeError("validate input.kind is not supported");
  }
}

export function assertGateCounterRequestBinding(
  record: SupplementalReviewRecordV1,
  request: GateRequestV1,
  currentInputFingerprint: string | undefined,
): void {
  const producerFamilies = new Set(request.current_evidence.slots.map((slot) => slot.producer_family));
  if (
    record.review.assurance !== "degraded" ||
    record.request_digest !== request.request_digest ||
    record.task_id !== request.task_id || record.phase_instance !== request.phase_instance ||
    record.kind !== request.kind || record.subject_digest !== request.subject_digest ||
    record.context_digest !== request.context_digest ||
    record.current_evidence_set_digest !== request.current_evidence.set_digest ||
    record.input_fingerprint !== currentInputFingerprint ||
    producerFamilies.size !== 1 || !producerFamilies.has(record.review.producer_family)
  ) throw new TypeError("gate-counter record does not bind the archived request");
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

async function gateCounter(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const record = parseSupplementalReviewRecord(requireValue(input));
  if (input.task_id !== record.task_id) throw new TypeError("gate-counter task does not match --task");
  const created = await services(input);
  if (!created.ok) return created;
  const { authority, dependencies, runner } = created.value;
  const requestTarget = await resolveTaskPath({ runner, taskId: authority.task_id, claim: gateRequestClaim(record.gate_id), expectedClass: "decision", context: authority.context });
  if (!requestTarget.ok) return requestTarget;
  const requestHandle = await openResolved(requestTarget.value.absolute, 0);
  let request;
  try {
    request = parseGateRequest(JSON.parse((await requestHandle.readFile()).toString("utf8")));
  } finally { await requestHandle.close(); }
  assertGateCounterRequestBinding(record, request, created.value.state?.value.input_fingerprint);
  await ensureDecisionDirectory(authority, record.gate_id);
  const reviewProjection = renderReviewEvidence(createVerifiedEvidenceReference(record.review));
  if (sha256Bytes(reviewProjection) !== record.projection_digest) throw new TypeError("gate-counter projection digest differs");
  const retained = await resolveTaskPath({ runner, taskId: authority.task_id, claim: gateSupplementalReviewClaim(record.gate_id), expectedClass: "decision", context: authority.context });
  if (!retained.ok) return retained;
  const document = canonicalDocument(record);
  const installation = await dependencies.atomic.createExclusive(retained.value, document.bytes);
  if (installation === "exists") {
    const handle = await openResolved(retained.value.absolute, 0);
    try {
      if (!Buffer.from(await handle.readFile()).equals(Buffer.from(document.bytes))) throw new TypeError("gate-counter retained record disagrees");
    } finally { await handle.close(); }
  }
  const projection = await resolveTaskPath({ runner, taskId: authority.task_id, claim: gateCounterReviewClaim(record.phase_instance, record.gate_id), expectedClass: "review", context: authority.context });
  if (!projection.ok) return projection;
  if (dependencies.projection_writer === undefined) throw new TypeError("projection writer is unavailable");
  await ensureTaskProjectionParent(authority, projection.value.absolute as ResolvedTaskPath);
  await dependencies.projection_writer.replaceRegular(projection.value, reviewProjection, false);
  return { record_digest: document.digest, projection_digest: record.projection_digest, installation };
}

async function maintain(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const value = requireValue(input) as Record<string, PlainJsonValue>;
  const created = await services(input);
  if (!created.ok) return created;
  const { authority, dependencies, runner } = created.value;
  const roots = await enumerateMaintenanceRoots(dependencies, authority);
  if (!roots.ok) return roots;
  const manifests = await enumerateMaintenanceManifests(dependencies, authority, roots.value);
  if (!manifests.ok) return manifests;
  const candidates = await enumerateMaintenanceCandidates(dependencies, authority, roots.value);
  if (!candidates.ok) return candidates;
  const proof = computeMaintenanceProof({ roots: roots.value, manifests: manifests.value, candidates: candidates.value });
  if (proof.permitted_deletions.length === 0) return { deleted: 0, reachability_proof_digest: proof.digest };
  const maintenanceId = parsePathSafeId(value.maintenance_id);
  const reason = String(value.human_reason ?? "");
  await mkdir(join(authority.task_root, "maintenance"), { recursive: false }).catch((error: { code?: string }) => { if (error.code !== "EEXIST") throw error; });
  const target = await resolveTaskPath({ runner, taskId: authority.task_id, claim: parseTaskPathClaim(`maintenance/${maintenanceId}.json`), expectedClass: "maintenance-record", context: authority.context });
  if (!target.ok) return target;
  const deletions = proof.permitted_deletions.map(({ target: _target, ...deletion }) => deletion);
  const record: MaintenanceRecordV1 = {
    schema_version: "1", maintenance_id: maintenanceId, task_id: authority.task_id,
    performed_at_revision: roots.value.current_state.revision, human_reason: reason,
    reachability_proof_digest: proof.digest, deletions,
    total_bytes_deleted: parseSafeInteger(deletions.reduce((total, deletion) => total + deletion.byte_count, 0)),
  };
  return performMaintenance({ atomic: dependencies.atomic, record_target: target.value, record, proof, validate_record: parseMaintenanceRecord });
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
    const path = String((item as Record<string, PlainJsonValue>).path);
    const bytes = Buffer.from(String((item as Record<string, PlainJsonValue>).bytes_base64), "base64");
    const claim = parseTaskPathClaim(`results/sha256/${resultDigest}/payload/${path}`);
    const target = await resolveTaskPath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim, expectedClass: "result-payload", context: created.value.authority.context });
    if (!target.ok) return target;
    await ensurePayloadParent(created.value.authority, resultDigest, target.value.absolute);
    payloads.push({ path: path as never, target: target.value, bytes: new Uint8Array(bytes) });
  }
  const prepared = prepareSnapshot({ manifest, payloads, retained_task_bytes: parseSafeInteger(value.retained_task_bytes), validate_manifest: parseResultManifest });
  if (!prepared.ok) return prepared;
  const manifestTarget = await resolveTaskPath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim: parseTaskPathClaim(`results/sha256/${resultDigest}/manifest.json`), expectedClass: "result-manifest", context: created.value.authority.context });
  if (!manifestTarget.ok) return manifestTarget;
  return installSnapshot(created.value.dependencies.atomic, prepared.value, manifestTarget.value, created.value.runner.location.worktreeRoot as never);
}

async function restore(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const created = await services(input);
  if (!created.ok) return created;
  const value = recordValue(input);
  const resultDigest = String(value.result_digest);
  const outputPath = String(value.output_path);
  const manifestTarget = await resolveTaskPath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim: parseTaskPathClaim(`results/sha256/${resultDigest}/manifest.json`), expectedClass: "result-manifest", context: created.value.authority.context });
  if (!manifestTarget.ok) return manifestTarget;
  const payloadTarget = await resolveTaskPath({ runner: created.value.runner, taskId: created.value.authority.task_id, claim: parseTaskPathClaim(`results/sha256/${resultDigest}/payload/${outputPath}`), expectedClass: "result-payload", context: created.value.authority.context });
  if (!payloadTarget.ok) return payloadTarget;
  const restored = await restoreSnapshotOutput({ target: manifestTarget.value, expected_result_digest: resultDigest as never, runner: created.value.runner, worktree_root: created.value.runner.location.worktreeRoot as never, output_path: outputPath as never, payload_target: payloadTarget.value });
  if (!restored.ok || restored.value.state === "absent") return restored;
  return { schema_version: "1", ok: true, value: { ...restored.value, bytes: Buffer.from(restored.value.bytes).toString("base64") } };
}

async function decide(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  const value = recordValue(input);
  if (value.kind !== "interface") throw new TypeError("decide input.kind must be interface");
  assertPlainJson(value.value, "decide interface value");
  const created = await services(input);
  if (!created.ok) return created;
  return writeGateDecisionInterface(created.value.dependencies, created.value.authority, structuredClone(value.value));
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
  validate, hash, render, snapshot, restore, maintain, decide,
  "gate-counter": gateCounter, status, reconcile, init, envelope,
  "build-request": buildRequest, "manual-status": manualStatus, upgrade,
});

export async function runLocalCommand(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  if (!LOCAL_COMMANDS.includes(input.command)) throw new TypeError(`unknown local command: ${input.command}`);
  return LOCAL_COMMAND_HANDLERS[input.command](input);
}
