import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureProjectionTarget: vi.fn(),
  deriveDeclaredSnapshotDigest: vi.fn(),
  prepareProjectionPlan: vi.fn(),
  hashGitBlobIdentity: vi.fn(),
  resolveDeclaredOutputPath: vi.fn(),
  resolveTaskPath: vi.fn(),
  verifyImplementationManifest: vi.fn(),
}));

vi.mock("../../src/state/snapshots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/state/snapshots.js")>()),
  captureProjectionTarget: mocks.captureProjectionTarget,
  deriveDeclaredSnapshotDigest: mocks.deriveDeclaredSnapshotDigest,
  prepareProjectionPlan: mocks.prepareProjectionPlan,
}));
vi.mock("../../src/repository/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/repository/paths.js")>()),
  resolveDeclaredOutputPath: mocks.resolveDeclaredOutputPath,
  resolveTaskPath: mocks.resolveTaskPath,
}));
vi.mock("../../src/repository/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/repository/git.js")>()),
  hashGitBlobIdentity: mocks.hashGitBlobIdentity,
}));
vi.mock("../../src/state/implementation-manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/state/implementation-manifest.js")>()),
  verifyImplementationManifest: mocks.verifyImplementationManifest,
}));

import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import { sha256Bytes } from "../../src/contracts/canonical.js";
import type { ProductionServices } from "../../src/state/production.js";
import { prepareDocumentResult, prepareImplementationResult } from "../../src/mcp/handlers/state-results.js";

const D = (character: string) => character.repeat(64);
const documentTarget = {
  repositoryRelative: ".archflow/tasks/task-1/phases/15/notes.md",
  absolute: "/repo/.archflow/tasks/task-1/phases/15/notes.md",
  path_class: "document",
};
const services = {
  runner: { location: { worktreeRoot: "/repo" } },
  authority: {
    task_id: "task-1",
    repository_identity_digest: D("1"),
    context: {},
  },
} as unknown as ProductionServices;
const scanner = { scan: vi.fn() } as never;

function documentArtifact(overrides: Partial<DocumentArtifactV1> = {}): DocumentArtifactV1 {
  return {
    schema_version: "1",
    artifact_kind: "document",
    task_id: "task-1",
    phase_instance: "phase-impl-15",
    step: "produce",
    document_path: "phases/15/notes.md",
    path_class: "document",
    byte_count: 5,
    content_digest: D("2"),
    declared_inputs: [],
    input_fingerprint: D("3"),
    snapshot_digest: D("4"),
    projection_target: documentTarget.repositoryRelative,
    ...overrides,
  } as DocumentArtifactV1;
}

function implementationArtifact(): ImplementationOutputV1 {
  return {
    schema_version: "1",
    artifact_kind: "implementation-output",
    task_id: "task-1",
    phase_instance: "phase-impl-15",
    step: "produce",
    outputs: [{
      path: "src/result.ts",
      path_class: "repository-source",
      operation: "add",
      storage: "raw-payload",
      payload_bytes: 5,
      payload_digest: D("5"),
      file_type: "regular",
      after: { oid: D("6").slice(0, 40), mode: "100644", size_bytes: 5 },
    }],
  } as unknown as ImplementationOutputV1;
}

function expectIssue(result: Awaited<ReturnType<typeof prepareDocumentResult>> | Awaited<ReturnType<typeof prepareImplementationResult>>, issueCode: string): void {
  expect(result).toMatchObject({
    schema_version: "1",
    ok: false,
    error: {
      code: "CONTRACT_INVALID",
      diagnostic: { parameters: { tool: "archflow_state", issue_code: issueCode } },
    },
  });
}

describe("state result caller-data classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTaskPath.mockResolvedValue({ schema_version: "1", ok: true, value: documentTarget });
    mocks.resolveDeclaredOutputPath.mockResolvedValue({ schema_version: "1", ok: true, value: documentTarget });
    mocks.prepareProjectionPlan.mockResolvedValue({ schema_version: "1", ok: true, value: {} });
    mocks.hashGitBlobIdentity.mockResolvedValue({ oid: "6".repeat(40), size_bytes: 5 });
  });

  it.each([
    ["document-projection-target-mismatch", async () => {
      return prepareDocumentResult({ services, artifact: documentArtifact({ projection_target: ".archflow/tasks/task-1/phases/15/other.md" as never }), result_id: "result-1" as never, retained_task_bytes: 0 as never, measured_at_revision: 1 as never, scanner });
    }],
    ["document-projection-not-regular-file", async () => {
      mocks.captureProjectionTarget.mockResolvedValue({ rollback: { state: "absent" } });
      return prepareDocumentResult({ services, artifact: documentArtifact(), result_id: "result-1" as never, retained_task_bytes: 0 as never, measured_at_revision: 1 as never, scanner });
    }],
    ["document-content-mismatch", async () => {
      mocks.captureProjectionTarget.mockResolvedValue({ rollback: { state: "present", file_type: "regular", bytes: new TextEncoder().encode("wrong") } });
      return prepareDocumentResult({ services, artifact: documentArtifact(), result_id: "result-1" as never, retained_task_bytes: 0 as never, measured_at_revision: 1 as never, scanner });
    }],
    ["document-snapshot-digest-mismatch", async () => {
      const bytes = new TextEncoder().encode("notes");
      mocks.captureProjectionTarget.mockResolvedValue({ rollback: { state: "present", file_type: "regular", bytes }, observation: {} });
      mocks.deriveDeclaredSnapshotDigest.mockReturnValue(D("9"));
      return prepareDocumentResult({ services, artifact: documentArtifact({ content_digest: sha256Bytes(bytes) }), result_id: "result-1" as never, retained_task_bytes: 0 as never, measured_at_revision: 1 as never, scanner });
    }],
  ])("returns CONTRACT_INVALID/%s", async (issueCode, run) => {
    const result = await run();
    // The snapshot case supplies a mismatching digest through the mocked authority; all earlier
    // cases stop before projection preparation.
    expectIssue(result, issueCode);
  });

  it("classifies unavailable implementation after-image bytes", async () => {
    mocks.verifyImplementationManifest.mockResolvedValue({ raw_payloads: new Map(), snapshot_entries: [] });
    mocks.captureProjectionTarget.mockResolvedValue({ rollback: { state: "absent" }, observation: {} });
    const result = await prepareImplementationResult({ services, artifact: implementationArtifact(), result_id: "result-1" as never, retained_task_bytes: 0 as never, measured_at_revision: 1 as never, scanner });
    expectIssue(result, "implementation-after-image-unavailable");
  });

  it("classifies a missing implementation projection identity", async () => {
    const bytes = new TextEncoder().encode("notes");
    mocks.verifyImplementationManifest.mockResolvedValue({ raw_payloads: new Map([["src/result.ts", bytes]]), snapshot_entries: [] });
    mocks.captureProjectionTarget.mockResolvedValue({ rollback: { state: "present", file_type: "regular", bytes }, observation: {} });
    const result = await prepareImplementationResult({ services, artifact: implementationArtifact(), result_id: "result-1" as never, retained_task_bytes: 0 as never, measured_at_revision: 1 as never, scanner });
    expectIssue(result, "implementation-projection-identity-missing");
  });
});
