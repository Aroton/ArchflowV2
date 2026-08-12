import { randomUUID } from "node:crypto";

import { canonicalDocument } from "../contracts/canonical.js";
import { parseActiveGate, parseGateRequest, type ActiveGateV1, type GateRequestV1 } from "../contracts/durable-gate.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { PathSafeId, Sha256Digest } from "../contracts/evidence.js";
import {
  validateGateDecision,
  type GateContext,
  type HumanDecisionProvenance,
} from "../contracts/gates.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import type { RepositoryPathClaim } from "../contracts/path-claims.js";
import { gateRequestClaim, type ResolvedTaskWorkspacePath } from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { ensureIntentDirectory, ensureWorkspaceProjectionParent } from "./layout.js";
import {
  deepFreezeGateJson,
  activeProjection,
  fail,
  io,
  issue,
  ok,
  parseInterface,
  readCanonical,
  resolvePath,
  stateOrFailure,
  waiverContext,
  type GateLifecycleDependencies,
} from "./gate-core.js";
import { TaskLockError } from "./lock.js";

const TEMPLATE_REASON = "Record the human decision reason.";
const TEMPLATE_RATIONALE = "Record the human decision rationale.";

function decisionTemplateBase(active: ActiveGateV1): Readonly<{
  schema_version: "1";
  gate_id: PathSafeId;
  task_id: GateRequestV1["task_id"];
  phase_instance: GateRequestV1["phase_instance"];
  subject_digest: Sha256Digest;
  context_digest: Sha256Digest;
}> {
  return {
    schema_version: "1",
    gate_id: active.gate_id,
    task_id: active.task_id,
    phase_instance: active.phase_instance,
    subject_digest: active.subject_digest,
    context_digest: active.context_digest,
  };
}

/**
 * Enumerates the complete human-facing decision shapes for the request projected in gate.json.
 * The caller adds human provenance only after the human chooses one of these templates.
 */
export function buildGateDecisionTemplates(active: ActiveGateV1): readonly PlainJsonValue[] {
  const request = parseActiveGate(structuredClone(active));
  const base = decisionTemplateBase(request);
  const cancellation = { ...base, cancelled: true, reason: TEMPLATE_REASON } as const;
  const waiver = waiverContext(request.context);
  if (waiver !== undefined) {
    return deepFreezeGateJson([
      {
        ...base,
        granted: true,
        scope: structuredClone(waiver.origin.scope),
        origin: structuredClone(waiver.origin),
        notes: TEMPLATE_REASON,
      },
      {
        ...base,
        granted: false,
        scope: structuredClone(waiver.origin.scope),
        origin: structuredClone(waiver.origin),
        notes: TEMPLATE_REASON,
      },
      cancellation,
    ] satisfies PlainJsonValue[]);
  }

  const templates: PlainJsonValue[] = [];
  for (const decision of request.allowed_decisions) {
    if (decision === "cancel") {
      templates.push(cancellation);
      continue;
    }

    const context = request.context as GateRequestV1["context"];
    const payloads: PlainJsonValue[] = [];
    if (decision === "waiver-requested") {
      // One template per waivable (rule, axis) pair: waiving a rule's compliance and waiving its
      // review trigger are different requests, and the human must be shown both.
      const eligible = (context as GateContext<"constitution-review">).eligible_waivers;
      for (const item of eligible) {
        payloads.push({
          decision,
          reason: TEMPLATE_REASON,
          rule: structuredClone(item.rule),
          operation: item.scope.operation,
          rationale: TEMPLATE_RATIONALE,
        });
      }
    } else if (request.kind === "restore-collision" && decision === "adopt-as-new-generation") {
      if (request.context.adoption_candidate !== undefined) {
        payloads.push({
          decision,
          reason: TEMPLATE_REASON,
          adoption_authority: structuredClone(request.context.adoption_candidate),
          rationale: TEMPLATE_RATIONALE,
        });
      }
    } else {
      payloads.push({ decision, reason: TEMPLATE_REASON });
    }

    for (const payload of payloads) {
      validateGateDecision(request.kind, request.context as never, payload as never);
      templates.push({ ...base, kind: request.kind, payload });
    }
  }
  return deepFreezeGateJson(templates);
}

export type GateDecisionInterfaceWriteResult = Readonly<{
  gate_id: PathSafeId;
  decision_path: RepositoryPathClaim;
  decision_digest: Sha256Digest;
}>;

/** Installs a selected template without overwriting a decision that already binds the live gate. */
export async function writeGateDecisionInterface(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  value: PlainJsonValue,
): Promise<ProjectResult<GateDecisionInterfaceWriteResult>> {
  assertInternalTransactionAuthority(authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  assertPlainJson(value, "gate decision template");
  const selected = structuredClone(value);
  const provenance: HumanDecisionProvenance = {
    schema_version: "1",
    actor_class: "human",
    assurance: "declared-local-trace",
    channel: "archflow-local",
    decision_event_id: randomUUID(),
    helper_invocation_id: randomUUID(),
    recorded_at: new Date().toISOString(),
  };
  const candidate = selected !== null && typeof selected === "object" && !Array.isArray(selected)
    ? { ...selected, human_provenance: provenance } as PlainJsonValue
    : selected;

  try {
    await ensureIntentDirectory(authority);
    return await dependencies.lock.runExclusive(authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const gate = current.value.open_gate;
      if (gate === undefined) return issue("STATE_INVALID", current.value, "gate-interface-open-gate-missing");

      const requestPath = await resolvePath(
        dependencies,
        authority,
        gateRequestClaim(gate.gate_id),
        "authority-decision",
      );
      const activePath = await resolvePath(dependencies, authority, "gate.json", "workspace-gate-interface");
      const interfacePath = await resolvePath(dependencies, authority, "gate.decision", "workspace-gate-interface");
      if (!requestPath.ok) return requestPath;
      if (!activePath.ok) return activePath;
      if (!interfacePath.ok) return interfacePath;
      const durableRequest = await readCanonical(requestPath.value, "gate request", parseGateRequest);
      if (durableRequest === "missing" || durableRequest === "invalid") {
        return issue("STATE_INVALID", current.value, "active-gate-request-invalid");
      }
      const projected = await readCanonical(activePath.value, "active gate", parseActiveGate);
      const active = projected === "missing" || projected === "invalid"
        ? parseActiveGate(activeProjection(durableRequest.value))
        : projected.value;
      if (
        active.task_id !== authority.task_id ||
        active.gate_id !== gate.gate_id ||
        active.kind !== gate.gate_kind ||
        active.subject_digest !== gate.subject_digest ||
        active.context_digest !== gate.context_digest
      ) return issue("STATE_INVALID", current.value, "active-gate-interface-mismatch");

      if (projected === "missing" || projected === "invalid") {
        await ensureWorkspaceProjectionParent(authority, activePath.value.absolute as ResolvedTaskWorkspacePath);
        await dependencies.atomic.replace(activePath.value, canonicalDocument(active).bytes);
      }

      try {
        parseInterface(candidate, active);
      } catch {
        return fail(createProjectError("GATE_DECISION_INVALID", {
          gate_id: active.gate_id,
          gate_kind: active.kind,
          issue_code: "decision-binding-invalid",
        }));
      }

      const existing = await readCanonical(interfacePath.value, "gate decision interface", (raw) => raw as PlainJsonValue);
      if (existing !== "missing" && existing !== "invalid") {
        try {
          parseInterface(existing.value, active);
          return fail(createProjectError("GATE_ACTIVE", {
            gate_id: active.gate_id,
            gate_kind: active.kind,
          }));
        } catch { /* invalid or stale interface is replaceable */ }
      }

      const document = canonicalDocument(candidate);
      await ensureWorkspaceProjectionParent(authority, interfacePath.value.absolute as ResolvedTaskWorkspacePath);
      await dependencies.atomic.replace(interfacePath.value, document.bytes);
      return ok({
        gate_id: active.gate_id,
        decision_path: interfacePath.value.repositoryRelative,
        decision_digest: document.digest,
      });
    });
  } catch (error) {
    return error instanceof TaskLockError
      ? io(authority, `gate-lock-${error.stage}`)
      : io(authority, "gate-interface-write");
  }
}
