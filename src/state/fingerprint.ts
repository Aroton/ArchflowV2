import { canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type {
  DeclaredInputRef,
  GitIdentityRef,
  InputFingerprintSubject,
} from "../contracts/fingerprints.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { ParsedToolCall } from "../contracts/mcp-tools.js";
import type { ToolName } from "../contracts/tool-names.js";
import type { RepositoryOperationContext } from "../repository/git.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import { canonicalRubricForPhaseKind } from "../review/rubrics.js";
import type { FingerprintReadContext } from "./read.js";

export type { FingerprintReadContext, LiveConfigSnapshot } from "./read.js";

export type CanonicalWorkflowDigestReader = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<Sha256Digest>>;
export type CanonicalConstitutionDigestReader = CanonicalWorkflowDigestReader;
export type CanonicalGitIdentityReader = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<readonly GitIdentityRef[]>>;
export type CanonicalDeclaredInputReader = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<readonly DeclaredInputRef[]>>;
export type InputFingerprintResolver = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<InputFingerprintSubject>>;

const failure = (state: TaskStateV1, issueCode: string): ProjectResult<never> => Object.freeze({
  schema_version: "1",
  ok: false,
  error: createProjectError("STATE_INVALID", {
    phase_instance: state.phase_instance,
    issue_code: issueCode,
  }),
});

function phaseInstance(call: ParsedToolCall, context: RepositoryOperationContext): TaskStateV1["phase_instance"] {
  switch (call.name) {
    case "archflow_state":
    case "archflow_gate":
      return call.input.phase_instance;
    case "archflow_waiver":
      return call.input.origin.phase_instance;
    case "archflow_counter_review":
      return context.phase_instance;
    default: {
      const exhaustive: never = call;
      throw new TypeError(`unknown tool ${String((exhaustive as { name?: unknown }).name)}`);
    }
  }
}

function rubricDigest(call: ParsedToolCall, phase: TaskStateV1["phase_instance"]): Sha256Digest {
  const reviewCycle = call.name === "archflow_counter_review" ||
    (call.name === "archflow_state" &&
      (call.input.step === "counter_review" || call.input.step === "triage"));
  return reviewCycle
    ? canonicalRubricForPhaseKind(decodePhaseInstance(phase).kind).rubric_digest
    : canonicalJsonDigest({});
}

/** Builds the production resolver from canonical readers; no caller digest or subject is accepted. */
export function createInternalInputFingerprintResolver(input: Readonly<{
  read_workflow_digest: CanonicalWorkflowDigestReader;
  read_constitution_digest: CanonicalConstitutionDigestReader;
  read_artifact_identities: CanonicalGitIdentityReader;
  read_upstream_identities: CanonicalGitIdentityReader;
  read_declared_inputs: CanonicalDeclaredInputReader;
}>): InputFingerprintResolver {
  return async <K extends ToolName>(context: FingerprintReadContext<K>): Promise<ProjectResult<InputFingerprintSubject>> => {
    const state = context.state.value;
    if (context.live_config.digest !== state.config_digest) {
      return Object.freeze({
        schema_version: "1",
        ok: false,
        error: createProjectError("PINNED_CONFIG_MISMATCH", {
          expected_digest: state.config_digest,
          observed_digest: context.live_config.digest,
        }),
      });
    }

    const workflow = await input.read_workflow_digest(context);
    if (!workflow.ok) return workflow;
    if (workflow.value !== state.workflow_digest) return failure(state, "workflow-pin-mismatch");
    const constitution = await input.read_constitution_digest(context);
    if (!constitution.ok) return constitution;
    if (constitution.value !== state.constitution_digest) return failure(state, "constitution-pin-mismatch");
    const artifacts = await input.read_artifact_identities(context);
    if (!artifacts.ok) return artifacts;
    const upstream = await input.read_upstream_identities(context);
    if (!upstream.ok) return upstream;
    const declared = await input.read_declared_inputs(context);
    if (!declared.ok) return declared;

    const subject: InputFingerprintSubject = {
      schema_version: "1",
      workflow_digest: workflow.value,
      config_digest: context.live_config.digest,
      constitution_digest: constitution.value,
      artifact_identities: structuredClone(artifacts.value),
      upstream_identities: structuredClone(upstream.value),
      rubric_digest: rubricDigest(context.call, state.phase_instance),
      phase_instance: phaseInstance(context.call, context.context),
      declared_inputs: structuredClone(declared.value),
    };
    return Object.freeze({ schema_version: "1", ok: true, value: subject });
  };
}
