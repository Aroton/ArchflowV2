import { describe, expect, it } from "vitest";
import { parseConfigV1 } from "../../src/contracts/config.js";
import type { RuleSettlementV1, TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { currentRuleSettlement } from "../../src/state/approval-rules.js";
import type { CurrentProduceSubject } from "../../src/state/produce-subject.js";

const phase = parsePhaseInstanceId("phase-design-2");
const task = parseTaskSlug("editorial-trigger");
const before = parseSha256Digest("a".repeat(64));
const after = parseSha256Digest("b".repeat(64));
const configDigest = parseSha256Digest("c".repeat(64));
const config = parseConfigV1({ schema_version: "1", roles: {}, approval_rules: { subjects: ["phase-design"], content: [] } });
const predecessor: RuleSettlementV1 = {
  task_id: task, phase_instance: phase, step: "produce", subject_digest: before,
  config_digest: configDigest, settled_at_revision: parseSafeInteger(8),
  conclusion: { wait: true, match: { kind: "subject", subject: "phase-design" } },
};
const state = (settlements: readonly RuleSettlementV1[]) => ({
  task_id: task, phase_instance: phase, revision: 10, rule_settlements: settlements,
} as TaskStateV1);
const subject = {
  artifact_digest: after,
  artifact: { artifact_kind: "document", phase_instance: phase, step: "produce", editorial_predecessor: { subject_digest: before } },
} as CurrentProduceSubject;

describe("current approval trigger derivation", () => {
  it("retains the editorial predecessor's exact trigger instead of rebinding it to new bytes", () => {
    const current = currentRuleSettlement(state([predecessor]), subject, { config, digest: configDigest, changed_documents: [] });
    expect(current).toEqual(predecessor);
    expect(current?.subject_digest).not.toBe(after);
    expect(current?.settled_at_revision).toBe(8);
  });

  it("evaluates the live rule when no eligible settlement exists", () => {
    expect(currentRuleSettlement(state([]), subject)).toBeUndefined();
    expect(currentRuleSettlement(state([]), subject, { config, digest: configDigest, changed_documents: [] })).toEqual({
      task_id: task, phase_instance: phase, step: "produce", subject_digest: after,
      config_digest: configDigest, settled_at_revision: 10,
      conclusion: { wait: true, match: { kind: "subject", subject: "phase-design" } },
    });
  });

  it("prefers the current subject's settlement over its predecessor", () => {
    const current = { ...predecessor, subject_digest: after, settled_at_revision: parseSafeInteger(9) };
    expect(currentRuleSettlement(state([predecessor, current]), subject)).toEqual(current);
  });
});
