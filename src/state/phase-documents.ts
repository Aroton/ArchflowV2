import { readFile } from "node:fs/promises";

import { sha256Bytes } from "../contracts/canonical.js";
import type { PathSafeId } from "../contracts/evidence.js";
import type { Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { ResolvedPath } from "../repository/paths.js";
import { replaceTaskAsk, type AtomicWriter } from "./atomic.js";

export type PhaseReviewPaths = Readonly<{
  artifact_path: string;
  upstream_paths: readonly string[];
}>;

export const STATUS_RESOURCE_ROLES = Object.freeze([
  "current-artifact",
  "user-ask",
  "prd",
  "task-design",
  "phase-design",
  "prior-implementation-notes",
  "verification-transcript",
] as const);

export type StatusResourceRole = typeof STATUS_RESOURCE_ROLES[number];
export type StatusResource = Readonly<{
  role: StatusResourceRole;
  path: string;
  access: "read" | "write" | "read-write";
  digest?: Sha256Digest;
}>;

/**
 * The task files a producer needs for the current phase. Status publishes these repository-relative
 * paths so agents consume the workflow's canonical resource projection instead of rediscovering
 * the task layout. The current artifact is the phase's durable human-readable write target; phase
 * implementation also publishes its ignored verification transcript write target.
 */
export function phaseStatusResources(
  taskId: TaskSlug,
  phaseInstance: PhaseInstanceId,
): readonly StatusResource[] {
  const phase = decodePhaseInstance(phaseInstance);
  const task = (path: string) => `.archflow/tasks/${taskId}/${path}`;
  const runtime = (path: string) => `.archflow/runtime/tasks/${taskId}/${path}`;
  const resources: StatusResource[] = [];

  switch (phase.kind) {
    case "prd":
      resources.push(
        { role: "current-artifact", path: task("prd.md"), access: "write" },
        { role: "user-ask", path: task("ask.md"), access: "read-write" },
      );
      break;
    case "design":
      resources.push(
        { role: "current-artifact", path: task("design.md"), access: "write" },
        { role: "prd", path: task("prd.md"), access: "read-write" },
      );
      break;
    case "phase-design":
      resources.push(
        { role: "current-artifact", path: task(`phases/${phase.phase}/design.md`), access: "write" },
        { role: "prd", path: task("prd.md"), access: "read-write" },
        { role: "task-design", path: task("design.md"), access: "read-write" },
      );
      if (Number(phase.phase) > 1) {
        resources.push({
          role: "prior-implementation-notes",
          path: task(`phases/${Number(phase.phase) - 1}/impl-notes.md`),
          access: "read",
        });
      }
      break;
    case "phase-impl":
      resources.push(
        { role: "current-artifact", path: task(`phases/${phase.phase}/impl-notes.md`), access: "write" },
        { role: "prd", path: task("prd.md"), access: "read-write" },
        { role: "task-design", path: task("design.md"), access: "read-write" },
        { role: "phase-design", path: task(`phases/${phase.phase}/design.md`), access: "read-write" },
      );
      if (Number(phase.phase) > 1) {
        resources.push({
          role: "prior-implementation-notes",
          path: task(`phases/${Number(phase.phase) - 1}/impl-notes.md`),
          access: "read",
        });
      }
      resources.push({
        role: "verification-transcript",
        path: runtime(`cache/phases/${phase.phase}/verification.txt`),
        access: "write",
      });
      break;
  }

  return Object.freeze(resources.map((resource) => Object.freeze(resource)));
}

/** Canonical review-subject paths per phase kind, as published by the phase skills. */
export function phaseReviewPaths(phaseInstance: PhaseInstanceId): PhaseReviewPaths {
  const phase = decodePhaseInstance(phaseInstance);
  switch (phase.kind) {
    case "prd": return { artifact_path: "prd.md", upstream_paths: [] };
    case "design": return { artifact_path: "design.md", upstream_paths: ["prd.md"] };
    case "phase-design": return {
      artifact_path: `phases/${phase.phase}/design.md`,
      upstream_paths: ["design.md", "prd.md"],
    };
    case "phase-impl": return {
      artifact_path: `phases/${phase.phase}/impl-notes.md`,
      upstream_paths: [`phases/${phase.phase}/design.md`, "design.md"],
    };
  }
}

export type PhaseDocumentDefaults = Readonly<{
  document_path: string;
  additional_document_paths?: readonly string[];
  declared_inputs: readonly Readonly<{ input_id: string; path: string }>[];
}>;

/**
 * Canonical produce-document defaults per phase kind: the drafted document and the declared
 * inputs its counter-review is sealed against. These are the same defaults the phase skills
 * publish, held here once so templates, the build-request composer, and prose can never
 * disagree. phase-impl produces an implementation output, not a document, so it has none.
 */
export function phaseDocumentDefaults(
  taskId: TaskSlug,
  phaseInstance: PhaseInstanceId,
): PhaseDocumentDefaults | undefined {
  const phase = decodePhaseInstance(phaseInstance);
  const task = (path: string) => `.archflow/tasks/${taskId}/${path}`;
  switch (phase.kind) {
    case "prd": return {
      document_path: "prd.md",
      declared_inputs: [{ input_id: "user-ask", path: task("ask.md") }],
    };
    case "design":
    case "phase-design": {
      const taskPrefix = task("");
      const additionalDocumentPaths = phaseStatusResources(taskId, phaseInstance)
        .filter((resource) => resource.access === "read-write" && resource.path.startsWith(taskPrefix))
        .map((resource) => resource.path.slice(taskPrefix.length))
        .sort();
      if (phase.kind === "design") return {
        document_path: "design.md",
        additional_document_paths: additionalDocumentPaths,
        declared_inputs: [{ input_id: "prd", path: task("prd.md") }],
      };
      return {
        document_path: `phases/${phase.phase}/design.md`,
        additional_document_paths: additionalDocumentPaths,
        declared_inputs: [
          { input_id: "design", path: task("design.md") },
          { input_id: "prd", path: task("prd.md") },
        ],
      };
    }
    case "phase-impl": return undefined;
  }
}

export type PhaseImplParentDocument = Readonly<{
  document_path: string;
  role: "prd" | "design" | "phase-design" | "impl-notes";
}>;

/** Canonical parent documents an implementation output binds, as published by archflow-phase-impl. */
export function phaseImplParentDocumentDefaults(
  phaseInstance: PhaseInstanceId,
): readonly PhaseImplParentDocument[] | undefined {
  const phase = decodePhaseInstance(phaseInstance);
  if (phase.kind !== "phase-impl") return undefined;
  return [
    { document_path: `phases/${phase.phase}/design.md`, role: "phase-design" },
    { document_path: "design.md", role: "design" },
    { document_path: "prd.md", role: "prd" },
    { document_path: `phases/${phase.phase}/impl-notes.md`, role: "impl-notes" },
  ];
}

export type PlanningRestartAskAppendInput = Readonly<{
  target: ResolvedPath;
  /** Omit only for operation-bound recovery, where an exact suffix is accepted first. */
  expected_base_digest?: Sha256Digest;
  restart_id: PathSafeId;
  request: string;
}>;

export type PlanningRestartAskAppendResult = Readonly<{
  status: "appended" | "replayed";
  content_digest: Sha256Digest;
  byte_count: number;
}>;

/** Read-only durable replay check; it never repairs or appends after state records the restart. */
export async function validatePlanningRestartAskAppend(
  input: Required<Pick<PlanningRestartAskAppendInput, "target" | "expected_base_digest" | "restart_id" | "request">>,
): Promise<boolean> {
  if (input.target.path_class !== "task-ask") return false;
  const existing = new Uint8Array(await readFile(input.target.absolute));
  const suffix = restartAskSuffix(input.restart_id, input.request);
  if (!bytesEndWith(existing, suffix)) return false;
  return sha256Bytes(existing.subarray(0, existing.byteLength - suffix.byteLength)) === input.expected_base_digest;
}

function restartAskSuffix(restartId: PathSafeId, request: string): Uint8Array {
  const requestBytes = new TextEncoder().encode(request);
  const framing = new TextEncoder().encode(
    `\n\n## Reopening and corrections\n\n<!-- archflow-restart:${restartId};request-bytes:${requestBytes.byteLength};request-sha256:${sha256Bytes(requestBytes)} -->\n\n`,
  );
  const suffix = new Uint8Array(framing.byteLength + requestBytes.byteLength);
  suffix.set(framing);
  suffix.set(requestBytes, framing.byteLength);
  return suffix;
}

/** Recovers the pre-append authority for semantic recomposition after the ask-only crash cut. */
export function planningRestartAskBaseDigest(
  existing: Uint8Array,
  restartId: PathSafeId,
  request: string,
): Sha256Digest {
  const suffix = restartAskSuffix(restartId, request);
  return bytesEndWith(existing, suffix)
    ? sha256Bytes(existing.subarray(0, existing.byteLength - suffix.byteLength))
    : sha256Bytes(existing);
}

function bytesEndWith(bytes: Uint8Array, suffix: Uint8Array): boolean {
  if (suffix.byteLength > bytes.byteLength) return false;
  const offset = bytes.byteLength - suffix.byteLength;
  return suffix.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Installs the sole worktree side effect of a PRD restart. Exact retry is accepted only when the
 * operation-bound suffix is the current tail and its preceding bytes are the expected base.
 */
export async function installPlanningRestartAskAppend(
  writer: Pick<AtomicWriter, "replaceTaskAsk">,
  input: PlanningRestartAskAppendInput,
): Promise<PlanningRestartAskAppendResult> {
  if (input.target.path_class !== "task-ask") {
    throw new TypeError("planning restart ask append requires the canonical ask document");
  }
  if (input.request.trim() === "") throw new TypeError("planning restart request must not be blank");
  const existing = new Uint8Array(await readFile(input.target.absolute));
  const suffix = restartAskSuffix(input.restart_id, input.request);
  const existingDigest = sha256Bytes(existing);
  if (bytesEndWith(existing, suffix)) {
    const prefix = existing.subarray(0, existing.byteLength - suffix.byteLength);
    if (input.expected_base_digest === undefined || sha256Bytes(prefix) === input.expected_base_digest) {
      return Object.freeze({
        status: "replayed",
        content_digest: sha256Bytes(existing),
        byte_count: existing.byteLength,
      });
    }
  }
  if (input.expected_base_digest === undefined || existingDigest === input.expected_base_digest) {
    const combined = new Uint8Array(existing.byteLength + suffix.byteLength);
    combined.set(existing);
    combined.set(suffix, existing.byteLength);
    await replaceTaskAsk(writer, input.target, combined);
    return Object.freeze({
      status: "appended",
      content_digest: sha256Bytes(combined),
      byte_count: combined.byteLength,
    });
  }
  throw new TypeError("planning restart ask append conflicts with current ask bytes");
}
