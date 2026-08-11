import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import type { MaintenanceRecordV1 } from "../contracts/durable-maintenance.js";
import { parseGateDecisionRecord, parseGateRequest } from "../contracts/durable-gate.js";
import { chainAnchor, parseManualCheckpoint, parseManualCheckpointImport, selectGreatestValidChain } from "../contracts/durable-checkpoint.js";
import { parseResultManifest } from "../contracts/durable-result-manifest.js";
import { parseDocumentArtifact } from "../contracts/durable-document.js";
import { parseImplementationOutput } from "../contracts/durable-implementation-output.js";
import { parsePathSafeId, parseSafeInteger, parseTaskSlug, type SafeCode } from "../contracts/evidence.js";
import { createVerifiedEvidenceReference } from "../contracts/internal/test-capabilities.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { renderReviewEvidence } from "../contracts/renderers.js";
import { parseReviewEvidence } from "../contracts/review.js";
import { parseAdjudicationEvidence } from "../contracts/adjudication.js";
import { parseTriageCandidate } from "../contracts/triage.js";
import { parseSupplementalReviewRecord } from "../contracts/supplemental-record.js";
import { createJsonSchemaValidator } from "../contracts/validators.js";
import maintenanceRecordSchema from "../contracts/schemas/v1/maintenance-record.schema.json" with { type: "json" };
import primitivesSchema from "../contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import pathClaimSchema from "../contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import { gateCounterReviewClaim, gateRequestClaim, gateSupplementalReviewClaim, openResolved, resolveTaskPath, type ResolvedTaskPath } from "../repository/paths.js";
import { createManualGateFile, writeGateDecisionInterface } from "../state/gates.js";
import { ensureDecisionDirectory, ensureManualCheckpointDirectory, ensureTaskProjectionParent } from "../state/layout.js";
import { ensurePayloadParent, ensureResultDirectory } from "../state/layout.js";
import { computeMaintenanceProof, performMaintenance } from "../state/maintenance.js";
import { enumerateMaintenanceCandidates, enumerateMaintenanceManifests, enumerateMaintenanceRoots } from "../state/maintenance-roots.js";
import { writeManualCheckpoint } from "../state/manual-checkpoints.js";
import { readManualCheckpoints } from "../state/manual-checkpoints.js";
import { createProductionServices } from "../state/production.js";
import { computeTaskStatus, projectBriefStatus } from "../state/status.js";
import { buildDocumentArtifact, type DocumentArtifactInput } from "../state/document-artifact.js";
import { buildImplementationOutput, type ImplementationOutputInput } from "../state/implementation-manifest.js";
import { installSnapshot, prepareSnapshot, restoreSnapshotOutput } from "../state/snapshots.js";
import { reconcileCurrentAuthority } from "../state/reconciliation.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { GateRequestV1 } from "../contracts/durable-gate.js";
import type { SupplementalReviewRecordV1 } from "../contracts/supplemental-record.js";
import { runInit } from "../init/index.js";
import { stageTaskInitialization } from "../init/task-initialization.js";
import { stageLegacyUpgrade } from "../init/legacy-upgrade.js";
import { BUILD_REQUEST_KINDS, runBuildRequest } from "./build-request.js";
import { computeCallEnvelope } from "./envelope.js";
import {
  classifyManualWorkflowStatus,
  runManualHandoff,
  runManualNext,
  type ManualNextValue,
} from "./manual-workflow.js";

export const LOCAL_COMMANDS = Object.freeze([
  "validate", "hash", "render", "snapshot", "restore", "maintain", "decide",
  "gate-counter", "status", "reconcile", "import", "checkpoint", "init", "task-init",
  "envelope", "build-document", "build-implementation-output", "build-request",
  "manual-status", "manual-next", "manual-handoff", "upgrade",
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
  decide: { payload: '{"kind":"request"|"decision"|"interface","value":<document>}', task: "required" },
  "gate-counter": { payload: "<supplemental review record from the counter-review recipe>", task: "required" },
  status: { payload: null, task: "required" },
  reconcile: { payload: '{"recorded_projections":[...],"current_projections":[...],"active_heads":{...}}', task: "required" },
  import: { payload: "<manual-checkpoint-import document>", task: "ignored" },
  checkpoint: { payload: "<manual checkpoint chain extension>", task: "required" },
  init: { payload: null, task: "ignored" },
  "task-init": { payload: null, task: "required" },
  envelope: { payload: '{"tool":<tool name>,"input":<tool input>}', task: "required" },
  "build-document": { payload: "<document artifact input>", task: "required" },
  "build-implementation-output": { payload: "<implementation output input>", task: "required" },
  "build-request": { payload: `{"intent_id"?:<id; omitted = generated>,"kind"?:${BUILD_REQUEST_KINDS.map((kind) => JSON.stringify(kind)).join("|")},...kind facts: none (initialize), "step" (running), "document"/"implementation" (produce), "dispositions":[...] (triage), "rubric" (counter-review), "summary" (gate)}`, task: "required" },
  "manual-status": { payload: null, task: "required" },
  "manual-next": { payload: "<selector/source artifact requested by manual-status>", task: "required" },
  "manual-handoff": { payload: '{"expected_head":<digest>,"initialization"?:<task-init artifact>}', task: "required" },
  upgrade: { payload: "<legacy staging descriptor>", task: "optional" },
});

export const INPUT_FREE_COMMANDS: ReadonlySet<LocalCommand> =
  new Set(LOCAL_COMMANDS.filter((command) => LOCAL_COMMAND_CONTRACTS[command].payload === null));

const maintenanceRecordV1Validator = createJsonSchemaValidator<MaintenanceRecordV1>(maintenanceRecordSchema, [primitivesSchema, pathClaimSchema]);

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
    case "manual-checkpoint": return parseManualCheckpoint(artifact);
    case "manual-checkpoint-import": return parseManualCheckpointImport(artifact);
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

export function validateCheckpointExtension(
  existing: readonly ReturnType<typeof parseManualCheckpoint>[],
  candidateValue: unknown,
): ReturnType<typeof parseManualCheckpoint> {
  const candidate = parseManualCheckpoint(candidateValue);
  const first = existing[0] ?? candidate;
  const anchor = "initialization" in first
    ? { mode: "initial" as const, task_id: first.task_id, repository_identity_digest: first.repository_identity_digest }
    : "state_anchor" in first
      ? { mode: "state" as const, task_id: first.task_id, repository_identity_digest: first.repository_identity_digest, state_anchor: first.state_anchor }
      : { mode: "continuation" as const, task_id: first.task_id, repository_identity_digest: first.repository_identity_digest, predecessor: first.predecessor };
  const selected = selectGreatestValidChain(anchor, [...existing, candidate]);
  if (selected.kind !== "chain") throw new TypeError(`checkpoint extension rejected: ${selected.outcome}`);
  if (selected.chain.length !== existing.length + 1 || selected.chain.at(-1) !== candidate) {
    throw new TypeError("checkpoint extension must append the unique greatest chain");
  }
  return candidate;
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
  return performMaintenance({ atomic: dependencies.atomic, record_target: target.value, record, proof, validate_record: (candidate) => maintenanceRecordV1Validator.assert(candidate, "maintenance record") });
}

export async function runLocalCommand(input: CommandInput): Promise<PlainJsonValue | ProjectResult<unknown>> {
  if (!LOCAL_COMMANDS.includes(input.command)) throw new TypeError(`unknown local command: ${input.command}`);
  if (input.command === "init") return runInit({ working_directory: input.working_directory });
  if (input.command === "task-init") {
    return stageTaskInitialization({
      working_directory: input.working_directory,
      task_id: parseTaskSlug(input.task_id),
    });
  }
  if (input.command === "upgrade") {
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
  if (input.command === "validate") return validateArtifact(recordValue(input));
  if (input.command === "hash") return { digest: canonicalJsonDigest(requireValue(input)) };
  if (input.command === "render") {
    const value = recordValue(input);
    const evidence = value.kind === "review" ? parseReviewEvidence(value.value)
      : value.kind === "adjudication" ? parseAdjudicationEvidence(value.value)
      : undefined;
    if (evidence === undefined) throw new TypeError("render input.kind must be review or adjudication");
    const verified = createVerifiedEvidenceReference(evidence as never);
    const bytes = value.kind === "review" ? renderReviewEvidence(verified as never) : (await import("../contracts/renderers.js")).renderAdjudicationEvidence(verified as never);
    return { markdown: new TextDecoder().decode(bytes), digest: sha256Bytes(bytes) };
  }
  if (input.command === "gate-counter") return gateCounter(input);
  if (input.command === "maintain") return maintain(input);
  if (input.command === "import") {
    const artifact = parseManualCheckpointImport(requireValue(input));
    const selected = selectGreatestValidChain(chainAnchor(artifact), artifact.chain);
    return selected.kind === "chain"
      ? { outcome: "valid", greatest_revision: selected.chain.at(-1)?.revision ?? 0, chain: selected.chain }
      : { outcome: selected.outcome };
  }
  const created = await services(input);
  if (!created.ok) return created;
  if (input.command === "manual-status") {
    return classifyManualWorkflowStatus({ services: created.value });
  }
  if (input.command === "manual-next") {
    return runManualNext({ services: created.value, value: requireValue(input) as unknown as ManualNextValue });
  }
  if (input.command === "manual-handoff") {
    const value = recordValue(input);
    return runManualHandoff({
      services: created.value,
      expected_head: String(value.expected_head) as never,
      ...(value.initialization === undefined ? {} : { initialization: value.initialization as never }),
    });
  }
  if (input.command === "status") {
    const status = await computeTaskStatus(created.value.dependencies, created.value.authority);
    if (!status.ok || input.brief !== true) return status;
    return Object.freeze({ schema_version: "1", ok: true, value: projectBriefStatus(status.value) });
  }
  if (input.command === "envelope") return computeCallEnvelope(created.value, requireValue(input));
  if (input.command === "build-document") {
    return buildDocumentArtifact(
      created.value.runner,
      created.value.authority,
      requireValue(input) as unknown as DocumentArtifactInput,
    );
  }
  if (input.command === "build-implementation-output") {
    if (created.value.state === undefined) throw new TypeError("build-implementation-output requires current task state");
    return buildImplementationOutput(
      created.value.dependencies,
      created.value.authority,
      created.value.state,
      requireValue(input) as unknown as ImplementationOutputInput,
    );
  }
  if (input.command === "build-request") {
    return runBuildRequest(created.value, requireValue(input) as PlainJsonValue);
  }
  if (input.command === "snapshot") {
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
  if (input.command === "restore") {
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
  if (input.command === "checkpoint") {
    await ensureManualCheckpointDirectory(created.value.authority);
    const existing = await readManualCheckpoints(created.value.dependencies, created.value.authority);
    if (!existing.ok) return existing;
    const checkpoint = validateCheckpointExtension(existing.value.map((item) => item.value), requireValue(input));
    return writeManualCheckpoint(created.value.dependencies, created.value.authority, checkpoint);
  }
  if (input.command === "decide") {
    const value = requireValue(input) as Record<string, PlainJsonValue>;
    const kind = value.kind;
    if (kind === "interface") {
      assertPlainJson(value.value, "decide interface value");
      return writeGateDecisionInterface(created.value.dependencies, created.value.authority, structuredClone(value.value));
    }
    if (kind !== "request" && kind !== "decision") throw new TypeError("decide input.kind must be request, decision, or interface");
    const document = value.value;
    const parsed = kind === "request" ? parseGateRequest(document) : parseGateDecisionRecord(document);
    return createManualGateFile(created.value.dependencies, created.value.authority, kind, parsed);
  }
  if (input.command === "reconcile") {
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
  throw new TypeError(`unimplemented local command: ${input.command}`);
}
