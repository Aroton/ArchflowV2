import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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

export type GateDecisionChoice = Readonly<{
  choice: string;
  reason: string;
  rationale?: string;
  rule?: PlainJsonValue;
  operation?: string;
}>;

function choiceRecord(value: PlainJsonValue): Record<string, PlainJsonValue> {
  assertPlainJson(value, "gate decision choice");
  const materialized = structuredClone(value);
  if (materialized === null || Array.isArray(materialized) || typeof materialized !== "object") {
    throw new TypeError("gate decision choice must be a JSON object");
  }
  const record = materialized as Record<string, PlainJsonValue>;
  const allowed = new Set(["choice", "reason", "rationale", "rule", "operation"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("gate decision choice contains unsupported fields");
  }
  if (typeof record.choice !== "string" || record.choice.trim() === "") {
    throw new TypeError("gate decision choice.choice must be a non-empty string");
  }
  if (typeof record.reason !== "string" || record.reason.trim() === "") {
    throw new TypeError("gate decision choice.reason must be a non-empty string");
  }
  return record;
}

/**
 * Binds the human's small judgment-only input to the live server-owned gate template.
 * Gate ids, digests, scopes, origins, and adoption authority never need to be copied by a caller.
 */
export function selectGateDecisionTemplate(active: ActiveGateV1, value: PlainJsonValue): PlainJsonValue {
  const choice = choiceRecord(value);
  const decision = choice.choice as string;
  const reason = choice.reason as string;
  const templates = buildGateDecisionTemplates(active);

  if (decision === "cancel") {
    if (choice.rationale !== undefined || choice.rule !== undefined || choice.operation !== undefined) {
      throw new TypeError("cancel accepts only choice and reason");
    }
    const template = templates.find((candidate) => "cancelled" in (candidate as object));
    if (template === undefined) throw new TypeError("cancel is not allowed for the active gate");
    return { ...(template as Record<string, PlainJsonValue>), reason };
  }

  const waiver = waiverContext(active.context);
  if (waiver !== undefined) {
    if (!(["grant", "deny"] as const).includes(decision as "grant" | "deny")) {
      throw new TypeError("choice is not allowed for the active waiver gate");
    }
    if (choice.rationale !== undefined || choice.rule !== undefined || choice.operation !== undefined) {
      throw new TypeError("waiver decisions accept only choice and reason");
    }
    const granted = decision === "grant";
    const template = templates.find((candidate) => (candidate as { granted?: boolean }).granted === granted);
    if (template === undefined) throw new TypeError("choice is not allowed for the active waiver gate");
    return { ...(template as Record<string, PlainJsonValue>), notes: reason };
  }

  let template: PlainJsonValue | undefined;
  if (decision === "waiver-requested") {
    if (typeof choice.rationale !== "string" || choice.rationale.trim() === "") {
      throw new TypeError("waiver-requested requires a non-empty rationale");
    }
    if (choice.rule === undefined || typeof choice.operation !== "string" || choice.operation.trim() === "") {
      throw new TypeError("waiver-requested requires rule and operation selectors");
    }
    template = templates.find((candidate) => {
      const payload = (candidate as { payload?: Record<string, PlainJsonValue> }).payload;
      return payload?.decision === decision && payload.operation === choice.operation && isDeepStrictEqual(payload.rule, choice.rule);
    });
  } else {
    if (choice.rule !== undefined || choice.operation !== undefined) {
      throw new TypeError("rule and operation apply only to waiver-requested");
    }
    if (decision === "adopt-as-new-generation") {
      if (typeof choice.rationale !== "string" || choice.rationale.trim() === "") {
        throw new TypeError("adopt-as-new-generation requires a non-empty rationale");
      }
    } else if (choice.rationale !== undefined) {
      throw new TypeError("rationale is not accepted for this decision");
    }
    template = templates.find((candidate) =>
      (candidate as { payload?: { decision?: string } }).payload?.decision === decision,
    );
  }
  if (template === undefined) throw new TypeError("choice is not allowed for the active gate");
  const payload = (template as { payload: Record<string, PlainJsonValue> }).payload;
  return {
    ...(template as Record<string, PlainJsonValue>),
    payload: {
      ...payload,
      reason,
      ...(choice.rationale === undefined ? {} : { rationale: choice.rationale }),
    },
  };
}

export type GateDecisionInterfaceWriteResult = Readonly<{
  gate_id: PathSafeId;
  decision_path: RepositoryPathClaim;
  decision_digest: Sha256Digest;
}>;

type DecisionSelector = (active: ActiveGateV1) => PlainJsonValue;

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
  return writeSelectedGateDecision(dependencies, authority, () => selected);
}

/** Installs a human choice after resolving all live gate bindings from durable authority. */
export async function writeGateDecisionChoice(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  value: PlainJsonValue,
): Promise<ProjectResult<GateDecisionInterfaceWriteResult>> {
  assertInternalTransactionAuthority(authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  const selected = structuredClone(choiceRecord(value));
  return writeSelectedGateDecision(dependencies, authority, (active) => selectGateDecisionTemplate(active, selected));
}

/** Installs a selected template without overwriting a decision that already binds the live gate. */
async function writeSelectedGateDecision(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  select: DecisionSelector,
): Promise<ProjectResult<GateDecisionInterfaceWriteResult>> {

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

      let selected: PlainJsonValue;
      try {
        selected = select(active);
      } catch {
        return fail(createProjectError("GATE_DECISION_INVALID", {
          gate_id: active.gate_id,
          gate_kind: active.kind,
          issue_code: "decision-choice-invalid",
        }));
      }
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
