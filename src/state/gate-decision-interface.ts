import { randomUUID } from "node:crypto";

import { canonicalDocument } from "../contracts/canonical.js";
import { parseActiveGate, type ActiveGateV1, type GateRequestV1 } from "../contracts/durable-gate.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { PathSafeId, Sha256Digest } from "../contracts/evidence.js";
import {
  validateGateDecision,
  type GateContext,
  type HumanDecisionProvenance,
  type RuleVersionRef,
} from "../contracts/gates.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import {
  deepFreezeGateJson,
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
const TEMPLATE_RESOLUTION = "Record the human resolution for this rule.";

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
      const eligible = (context as GateContext<"review-trigger"> | GateContext<"adjudication-failure">).eligible_waiver_rules;
      for (const rule of eligible) {
        payloads.push({
          decision,
          reason: TEMPLATE_REASON,
          rule: structuredClone(rule),
          rationale: TEMPLATE_RATIONALE,
        });
      }
    } else if (request.kind === "adjudication-failure" && decision === "approve") {
      const adjudicationContext = request.context as GateContext<"adjudication-failure">;
      const eligible = new Set(adjudicationContext.eligible_waiver_rules.map((rule) => `${rule.rule_id}:${rule.rule_version}`));
      const required = new Map<string, RuleVersionRef>();
      for (const rule of [...adjudicationContext.failed_rules, ...adjudicationContext.uncertain_rules]) {
        const key = `${rule.rule_id}:${rule.rule_version}`;
        if (!eligible.has(key)) required.set(key, rule);
      }
      const resolutions = [...required.values()]
        .sort((left, right) => left.rule_id.localeCompare(right.rule_id) || left.rule_version - right.rule_version)
        .map((rule) => ({ rule: structuredClone(rule), resolution: TEMPLATE_RESOLUTION }));
      payloads.push({ decision, reason: TEMPLATE_REASON, resolutions });
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
  decision_path: "gate.decision";
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
    return await dependencies.lock.runExclusive(authority.task_root, async () => {
      const stateResult = await stateOrFailure(dependencies, authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const gate = current.value.open_gate;
      if (gate === undefined) return issue("STATE_INVALID", current.value, "gate-interface-open-gate-missing");

      const activePath = await resolvePath(dependencies, authority, "gate.json", "gate-interface");
      const interfacePath = await resolvePath(dependencies, authority, "gate.decision", "gate-interface");
      if (!activePath.ok) return activePath;
      if (!interfacePath.ok) return interfacePath;
      const projected = await readCanonical(activePath.value, "active gate", parseActiveGate);
      if (projected === "missing" || projected === "invalid") {
        return issue("STATE_INVALID", current.value, "active-gate-interface-invalid");
      }
      const active = projected.value;
      if (
        active.task_id !== authority.task_id ||
        active.gate_id !== gate.gate_id ||
        active.kind !== gate.gate_kind ||
        active.subject_digest !== gate.subject_digest ||
        active.context_digest !== gate.context_digest
      ) return issue("STATE_INVALID", current.value, "active-gate-interface-mismatch");

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
      await dependencies.atomic.replace(interfacePath.value, document.bytes);
      return ok({
        gate_id: active.gate_id,
        decision_path: "gate.decision",
        decision_digest: document.digest,
      });
    });
  } catch (error) {
    return error instanceof TaskLockError
      ? io(authority, `gate-lock-${error.stage}`)
      : io(authority, "gate-interface-write");
  }
}
