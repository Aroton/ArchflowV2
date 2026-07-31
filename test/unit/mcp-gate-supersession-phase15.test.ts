import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runDurableGate: vi.fn(),
  openHandlerSession: vi.fn(),
}));

vi.mock("../../src/state/gates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/state/gates.js")>()),
  runDurableGate: mocks.runDurableGate,
}));
vi.mock("../../src/state/request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/state/request.js")>()),
  identifyTransactionRequest: () => ({ request_digest: "f".repeat(64) }),
}));
vi.mock("../../src/mcp/handlers/session.js", () => ({
  openHandlerSession: mocks.openHandlerSession,
}));

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { handleGate } from "../../src/mcp/handlers/gate.js";
import { createToolBoundary } from "../../src/mcp/server.js";

const OLD_SUBJECT = "a".repeat(64);
const NEW_SUBJECT = "b".repeat(64);
const TRIAGE = "c".repeat(64);

describe("Phase 15 gate handler supersession classification", () => {
  it("returns a classified subject-transition failure after durable supersession", async () => {
    mocks.openHandlerSession.mockResolvedValue({
      schema_version: "1",
      ok: true,
      value: { services: { authority: {}, dependencies: {} } },
    });
    mocks.runDurableGate.mockResolvedValue({
      schema_version: "1",
      ok: true,
      value: {
        state: { value: { revision: 8 } },
        record: {
          value: {
            outcome: "superseded",
            gate_id: "gate-15",
            supersession: {
              superseded_gate_id: "gate-15",
              accepted_triage_digest: TRIAGE,
              old_subject_digest: OLD_SUBJECT,
            },
            supplemental: [],
          },
        },
      },
    });
    const input = {
        schema_version: "1",
        task_id: "task-1",
        intent_id: "intent-1",
        expected_revision: 7,
        input_fingerprint: "d".repeat(64),
        phase_instance: "phase-impl-15",
        summary: "Review phase 15",
        subject_digest: OLD_SUBJECT,
        current_evidence: {
          set_digest: "e".repeat(64),
          slots: [
            { role: "self-review", evidence_digest: "1".repeat(64), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
            { role: "counter-review", evidence_digest: "2".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
          ],
        },
        supplemental_outcome: {
          action: "supersede",
          review: {
            prior_gate_id: "gate-15",
            task_id: "task-1",
            phase_instance: "phase-impl-15",
            subject_digest: OLD_SUBJECT,
            input_fingerprint: "d".repeat(64),
            evidence_slot: { role: "gate-counter-review", evidence_digest: "3".repeat(64), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family", gate_id: "gate-15" },
          },
          accepted_triage_digest: TRIAGE,
          old_subject_digest: OLD_SUBJECT,
          new_subject_digest: NEW_SUBJECT,
          reason: "Revise subject",
        },
        kind: "artifact-approval",
        context: { artifact_kind: "phase-implementation" },
    } as const;
    const connection = connectionContextFactory.captureStartup({
      connection_id: "gate-supersession-connection",
      startup_repository_candidate: { working_directory: "/repo" },
    }).initialize({ client: { name: "codex", version: "1.0" }, host: "codex", protocol_version: "2025-11-25" });
    const context = createInvocationContext(connection, {
      invocation_id: "gate-supersession-test",
      transport_metadata: { request_id: "gate-supersession-request", operation: "tools/call" },
    }, new AbortController().signal);

    const result = await createToolBoundary({ archflow_gate: handleGate }).invoke("archflow_gate", input, context);

    expect(result).toMatchObject({
      kind: "project-result",
      result: {
        schema_version: "1",
        ok: false,
        error: {
          schema_version: "1",
          code: "GATE_SUPERSEDED",
          owner: "gate",
          retryable: false,
          diagnostic: {
            template_id: "GATE_SUPERSEDED",
            parameters: {
              gate_id: "gate-15",
              old_subject_digest: OLD_SUBJECT,
              new_subject_digest: NEW_SUBJECT,
            },
          },
          next_action: "retry-with-superseding-subject",
        },
      },
    });
  });
});
