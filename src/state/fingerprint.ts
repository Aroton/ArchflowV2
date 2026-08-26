import { canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { computeInputFingerprint, type DeclaredInputRef, type GitIdentityRef, type InputFingerprintSubject, type SecondaryDeclaredInputSectionV1 } from "../contracts/fingerprints.js";
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
export type CanonicalSecondaryDeclaredInputReader = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<readonly SecondaryDeclaredInputSectionV1[]>>;
/**
 * The resolver's accepted value: the new-composition subject plus the fingerprint digest the
 * caller may record or compare. The digest is the new composition, except when the caller
 * supplied an expected fingerprint that only the legacy composition reproduces.
 */
export type ResolvedInputFingerprint = Readonly<{
  subject: InputFingerprintSubject;
  fingerprint: Sha256Digest;
}>;

export type InputFingerprintResolver = <K extends ToolName>(
  input: FingerprintReadContext<K>,
) => Promise<ProjectResult<ResolvedInputFingerprint>>;

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
      if (call.input.operation === "planning_restart") return call.input.target_phase_instance;
      return call.input.phase_instance;
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
    (call.name === "archflow_state" && call.input.operation !== "planning_restart" &&
      (call.input.step === "counter_review" || call.input.step === "triage"));
  return reviewCycle
    ? canonicalRubricForPhaseKind(decodePhaseInstance(phase).kind).rubric_digest
    : canonicalJsonDigest({});
}

const identityJson = (identity: GitIdentityRef) => ({
  path: identity.path,
  mode: identity.mode,
  oid: identity.oid,
});

const declaredInputJson = (declared: DeclaredInputRef) => ({
  input_id: declared.input_id,
  digest: declared.digest,
});

const byPath = (left: GitIdentityRef, right: GitIdentityRef) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

const byInputId = (left: DeclaredInputRef, right: DeclaredInputRef) =>
  left.input_id < right.input_id ? -1 : left.input_id > right.input_id ? 1 : 0;

/**
 * The pre-cutover composition: the same subject with the creation-time config digest folded
 * back in. Read-side fallback only, so evidence recorded before config left the fingerprint
 * still matches; the accepted value it produces is never rewritten into any record.
 */
function legacyInputFingerprint(
  subject: InputFingerprintSubject,
  configDigest: Sha256Digest,
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: subject.schema_version,
    workflow_digest: subject.workflow_digest,
    config_digest: configDigest,
    constitution_digest: subject.constitution_digest,
    artifact_identities: [...subject.artifact_identities].sort(byPath).map(identityJson),
    upstream_identities: [...subject.upstream_identities].sort(byPath).map(identityJson),
    rubric_digest: subject.rubric_digest,
    phase_instance: subject.phase_instance,
    declared_inputs: [...subject.declared_inputs].sort(byInputId).map(declaredInputJson),
  });
}

/** Builds the production resolver from canonical readers; no caller digest or subject is accepted. */
export function createInternalInputFingerprintResolver(input: Readonly<{
  read_workflow_digest: CanonicalWorkflowDigestReader;
  read_constitution_digest: CanonicalConstitutionDigestReader;
  read_artifact_identities: CanonicalGitIdentityReader;
  read_upstream_identities: CanonicalGitIdentityReader;
  read_declared_inputs: CanonicalDeclaredInputReader;
  read_secondary_declared_inputs?: CanonicalSecondaryDeclaredInputReader;
}>): InputFingerprintResolver {
  return async <K extends ToolName>(context: FingerprintReadContext<K>): Promise<ProjectResult<ResolvedInputFingerprint>> => {
    const state = context.state.value;
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
    const secondaryDeclared = input.read_secondary_declared_inputs === undefined
      ? Object.freeze({ schema_version: "1" as const, ok: true as const, value: Object.freeze([] as SecondaryDeclaredInputSectionV1[]) })
      : await input.read_secondary_declared_inputs(context);
    if (!secondaryDeclared.ok) return secondaryDeclared;

    const subject: InputFingerprintSubject = {
      schema_version: "1",
      workflow_digest: workflow.value,
      constitution_digest: constitution.value,
      artifact_identities: structuredClone(artifacts.value),
      upstream_identities: structuredClone(upstream.value),
      rubric_digest: rubricDigest(context.call, state.phase_instance),
      phase_instance: phaseInstance(context.call, context.context),
      declared_inputs: structuredClone(declared.value),
      ...(secondaryDeclared.value.length === 0 ? {} : {
        secondary_declared_inputs: structuredClone(secondaryDeclared.value),
      }),
    };
    const fingerprint = computeInputFingerprint(subject);
    const expected = context.expected_input_fingerprint;
    if (expected !== undefined && fingerprint !== expected && secondaryDeclared.value.length === 0) {
      // One bounded retry under the legacy composition; the recorded creation-time digest is
      // the config source, never live bytes. When neither matches, the new-composition value
      // stands so the caller's existing mismatch error fires unchanged. Secondary declared
      // inputs have no legacy representation, so a multi-repository subject may never erase
      // them by matching the primary-only fallback.
      const legacy = legacyInputFingerprint(subject, state.config_digest);
      if (legacy === expected) {
        return Object.freeze({ schema_version: "1", ok: true, value: { subject, fingerprint: legacy } });
      }
    }
    return Object.freeze({ schema_version: "1", ok: true, value: { subject, fingerprint } });
  };
}
