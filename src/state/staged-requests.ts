import { constants as fsConstants } from "node:fs";

import { z } from "zod";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import { createProjectError, describeValidationIssues, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseTaskSlug, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import {
  parseToolCall,
  type ParsedToolCall,
  type StagedRequestReference,
} from "../contracts/mcp-tools.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { TOOL_NAMES, type ToolName } from "../contracts/tool-names.js";
import { openResolved, resolveTaskPath, stagedRequestClaim } from "../repository/paths.js";
import type { RepositoryPathClaim } from "../contracts/path-claims.js";
import { ensureIntentDirectory } from "./layout.js";
import { createProductionServices, type ProductionServices } from "./production.js";
import { identifyTransactionRequest } from "./request.js";

/**
 * The durable shape `build-request` stages at `intents/<intent-id>.request.json`: the complete
 * resolved request plus the envelope's request digest. The digest is what protects the handoff —
 * the server recomputes it from the rehydrated call and refuses on any disagreement — so the file
 * itself needs no further authentication and may be freely overwritten by a recompose.
 */
export type StagedRequestRecordV1 = Readonly<{
  schema_version: "1";
  request: Readonly<{ tool: ToolName; input: PlainJsonValue }>;
  request_digest: Sha256Digest;
}>;

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const stagedRecordSchema = z.object({
  schema_version: z.literal("1"),
  request: z.object({ tool: z.enum(TOOL_NAMES), input: z.unknown() }).strict(),
  request_digest: digest,
}).strict();

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

const mismatch = (
  intentId: PathSafeId,
  issue: string,
  digests?: Readonly<{ expected: Sha256Digest; observed: Sha256Digest }>,
  issues?: string[],
): ProjectResult<never> => fail(createProjectError("STAGED_REQUEST_MISMATCH", {
  intent_id: intentId,
  issue_code: issue,
  ...(digests === undefined ? {} : { expected_digest: digests.expected, observed_digest: digests.observed }),
  ...(issues === undefined ? {} : { issues }),
}));

/**
 * Atomically stages the resolved request for one intent. Overwriting is deliberate: recomposing
 * the same intent before the call is legitimate, and the digest — not file freshness — is what a
 * later rehydration is checked against.
 */
export async function writeStagedRequest(input: Readonly<{
  services: ProductionServices;
  intent_id: PathSafeId;
  tool: ToolName;
  request_input: PlainJsonValue;
  request_digest: Sha256Digest;
}>): Promise<ProjectResult<Readonly<{ path: RepositoryPathClaim; reference: StagedRequestReference }>>> {
  const { services } = input;
  await ensureIntentDirectory(services.authority);
  const target = await resolveTaskPath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: stagedRequestClaim(input.intent_id),
    expectedClass: "staged-request",
    context: services.authority.context,
  });
  if (!target.ok) return target;
  const record: StagedRequestRecordV1 = {
    schema_version: "1",
    request: { tool: input.tool, input: input.request_input },
    request_digest: input.request_digest,
  };
  await services.dependencies.atomic.replace(target.value, canonicalJsonBytes(record as unknown as PlainJsonValue));
  return ok(Object.freeze({
    path: target.value.repositoryRelative,
    reference: Object.freeze({
      schema_version: "1" as const,
      task_id: services.authority.task_id,
      intent_id: input.intent_id,
      request_digest: input.request_digest,
    }),
  }));
}

/**
 * Resolves a staged-request reference back into an authentic full-payload tool call, failing
 * closed — with no state change — unless every binding holds:
 *
 * 1. the staged file exists in its own path class inside the task (`STAGED_REQUEST_NOT_FOUND`);
 * 2. it parses as a staged record whose `request.tool` equals the tool actually called;
 * 3. its `input` re-parses through the tool's full-payload contract, and the parsed call carries
 *    the reference's `task_id` and `intent_id`;
 * 4. the request digest recomputed from the rehydrated call — through the same
 *    `identifyTransactionRequest` the live path uses — equals BOTH the digest recorded in the
 *    staged file and the digest the model typed into the reference.
 *
 * Everything downstream (fingerprint re-derivation, revision CAS, replay correlation) then runs
 * unchanged on the returned call, which is byte-equivalent to the envelope's `request.input`.
 */
export async function rehydrateStagedToolCall<K extends ToolName>(
  name: K,
  reference: StagedRequestReference,
  workingDirectory: string,
): Promise<ProjectResult<Extract<ParsedToolCall, { name: K }>>> {
  const services = await createProductionServices({
    working_directory: workingDirectory,
    task_id: parseTaskSlug(reference.task_id),
    operation: parseSafeCode(name),
  });
  if (!services.ok) return services;
  const target = await resolveTaskPath({
    runner: services.value.runner,
    taskId: services.value.authority.task_id,
    claim: stagedRequestClaim(reference.intent_id),
    expectedClass: "staged-request",
    context: services.value.authority.context,
  });
  if (!target.ok) return target;

  let bytes: Uint8Array;
  let handle;
  try {
    handle = await openResolved(target.value.absolute, fsConstants.O_RDONLY);
    bytes = new Uint8Array(await handle.readFile());
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      return fail(createProjectError("STAGED_REQUEST_NOT_FOUND", {
        task_id: reference.task_id,
        intent_id: reference.intent_id,
      }));
    }
    return fail(createProjectError("IO_ERROR", {
      operation: services.value.authority.context.operation,
      attempt: services.value.authority.context.attempt,
    }));
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let record: StagedRequestRecordV1;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertPlainJson(parsed, "staged request record");
    record = stagedRecordSchema.parse(parsed) as StagedRequestRecordV1;
  } catch {
    return mismatch(reference.intent_id, "staged-record-invalid");
  }
  if (record.request.tool !== name) return mismatch(reference.intent_id, "staged-tool-mismatch");

  let call: Extract<ParsedToolCall, { name: K }>;
  try {
    call = parseToolCall(name, record.request.input as PlainJsonValue);
  } catch (error) {
    return mismatch(reference.intent_id, "staged-input-invalid", undefined, describeValidationIssues(error));
  }
  if (call.input.intent_id !== reference.intent_id) {
    return mismatch(reference.intent_id, "staged-intent-mismatch");
  }
  if (call.input.task_id !== reference.task_id) {
    return mismatch(reference.intent_id, "staged-task-mismatch");
  }

  const identified = identifyTransactionRequest(call, services.value.authority, call.input.input_fingerprint);
  if (identified.request_digest !== record.request_digest) {
    return mismatch(reference.intent_id, "staged-digest-mismatch", {
      expected: record.request_digest,
      observed: identified.request_digest,
    });
  }
  if (identified.request_digest !== reference.request_digest) {
    return mismatch(reference.intent_id, "reference-digest-mismatch", {
      expected: reference.request_digest,
      observed: identified.request_digest,
    });
  }
  return ok(call);
}
