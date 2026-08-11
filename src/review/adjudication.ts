import adjudicationOutputSchema from "../contracts/schemas/v1/adjudication.schema.json" with { type: "json" };

import type {
  AdjudicationEvidence,
  DerivedAdjudication,
} from "../contracts/adjudication.js";
import type { ConfigV1 } from "../contracts/config.js";
import type {
  ConstitutionRegistry,
  ConstitutionRuleV1,
} from "../contracts/constitution.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import { parseSafeInteger, type SafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import {
  createInternalResultExpectation,
  validateProjectResultStructure,
  type ParsedToolCall,
} from "../contracts/mcp-tools.js";
import { adjudicationReviewClaim } from "../contracts/path-claims.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { AdapterId, ModelFamily } from "../contracts/review.js";
import {
  mintAdjudicationObservation,
  serializeDispatch,
} from "../dispatch/cli.js";
import { resolveDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import type { ResolvedTaskPath } from "../repository/paths.js";
import {
  buildAdjudicationEnvelope,
  type AdjudicationUpstreamInput,
  type AdjudicationEnvelopeInput,
} from "./envelopes.js";
import {
  requireApprovedUpstreamDigests,
} from "./fixed-point.js";
import type {
  CurrentReviewSet,
} from "../contracts/trust.js";
import { authenticCurrentReviewSet } from "../contracts/internal/trust-brands.js";
import type { PreparedEvidenceResult } from "../state/evidence-results.js";
import {
  assertResolvedConstitution,
  type ResolvedConstitution,
} from "../state/constitution.js";
import type { TransactionAuthority } from "../state/authority.js";
import type {
  TransactionDependencies,
  TransactionOutcome,
} from "../state/transaction.js";
import {
  prepareResultInstallation,
  runStateTransaction,
} from "../state/transaction.js";
import { identifyTransactionRequest } from "../state/request.js";
import { planStateTransition } from "../state/transitions.js";
import type { GateContext, GateKind } from "../contracts/gates.js";

export class AdjudicationServiceError extends Error {
  public constructor(public readonly project_error: ProjectError) {
    super(project_error.code);
    this.name = "AdjudicationServiceError";
  }
}

const invalidOutput = (issueCode: string, adapter: AdapterId | undefined): never => {
  if (adapter === undefined) {
    throw new TypeError("the dispatch adapter is required to classify invalid model output");
  }
  throw new AdjudicationServiceError(createProjectError("MODEL_OUTPUT_INVALID", {
    adapter,
    attempt: 1,
    issue_code: issueCode,
  }));
};

/**
 * Applies only registry-dependent checks. Structural folds, drift coverage, and observation
 * bindings remain owned by the contract and observation layers.
 */
export function crossCheckRuleFindings<T extends DerivedAdjudication>(
  registry: ConstitutionRegistry,
  adjudication: T,
  adapter?: AdapterId,
): T {
  const active = [...registry.values()]
    .filter((rule) => rule.status === "active")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (adjudication.rule_findings.length !== active.length) {
    return invalidOutput("constitution-rule-coverage", adapter);
  }
  for (let index = 0; index < active.length; index += 1) {
    const rule = active[index]!;
    const finding = adjudication.rule_findings[index]!;
    if (finding.rule_id !== rule.id || finding.rule_version !== rule.version) {
      return invalidOutput("constitution-rule-version", adapter);
    }
    const declared = rule.enforced_by ?? [];
    const labels = finding.enforced_by.map((entry) => entry.mechanism);
    if (
      new Set(labels).size !== labels.length ||
      labels.length !== declared.length ||
      declared.some((label) => !labels.includes(label))
    ) return invalidOutput("constitution-enforcement-labels", adapter);
    if (declared.length > 0 && finding.compliance === "pass") {
      return invalidOutput("constitution-mechanism-pass", adapter);
    }
  }
  return adjudication;
}

export type AdjudicationDispatchResult = Readonly<{
  cli_version: string;
  extracted_output_bytes: Uint8Array;
}>;

export type AdjudicationGateRequest<K extends GateKind = GateKind> = Readonly<{
  kind: K;
  subject_digest: Sha256Digest;
  context: GateContext<K>;
}>;

export type RunAdjudicationDependencies = Readonly<{
  transaction: TransactionDependencies;
  dispatch: (
    route: DispatchRoute,
    envelope: ReturnType<typeof buildAdjudicationEnvelope>,
    outputSchema: PlainJsonValue,
  ) => Promise<AdjudicationDispatchResult>;
  prepare_evidence: (
    evidence: AdjudicationEvidence,
    measuredAtRevision: SafeInteger,
  ) => Promise<ProjectResult<PreparedEvidenceResult>>;
  detect_constitution_edit: () => Promise<ProjectResult<GateContext<"constitution-edit"> | undefined>>;
  derive_approved_upstreams: (
    state: TaskStateV1,
    paths: Extract<ParsedToolCall, { name: "archflow_adjudicate" }>["input"]["upstream_paths"],
  ) => Promise<ProjectResult<readonly AdjudicationUpstreamInput[]>>;
  load_current_review_set: (
    authority: TransactionAuthority,
    phaseInstance: TaskStateV1["phase_instance"],
  ) => Promise<ProjectResult<CurrentReviewSet>>;
  load_constitution: (
    policyBaseCommit: TaskStateV1["policy_base_commit"],
  ) => Promise<ProjectResult<ResolvedConstitution>>;
  open_gate: (request: AdjudicationGateRequest) => Promise<ProjectResult<unknown>>;
}>;

export type RunAdjudicationInput = Readonly<{
  authority: TransactionAuthority;
  call: Extract<ParsedToolCall, { name: "archflow_adjudicate" }>;
  config: ConfigV1;
  phase_kind: keyof NonNullable<ConfigV1["overrides"]>;
  producer_family: ModelFamily;
  /**
   * The editorial predecessor pair the current produce artifact declares, supplied by the
   * handler only from the record-time-validated retained artifact. The current review set may
   * be bound to this pair instead of the new subject — exactly one hop; adjudication itself
   * still binds the new subject digest and fingerprint.
   */
  editorial_predecessor?: Readonly<{
    subject_digest: Sha256Digest;
    input_fingerprint: Sha256Digest;
  }>;
  envelope: Omit<AdjudicationEnvelopeInput, "approved_upstreams">;
}>;

function rulesForEnvelope(registry: ConstitutionRegistry):
  AdjudicationEnvelopeInput["rules"] {
  return Object.freeze([...registry.values()]
    .filter((rule) => rule.status === "active")
    .sort((left, right) =>
      left.id.localeCompare(right.id) || left.version - right.version)
    .map((rule) => Object.freeze({
      id: rule.id,
      version: rule.version,
      text: rule.text,
      ...(rule.review_trigger === undefined
        ? {}
        : { review_trigger: rule.review_trigger }),
      enforced_by: Object.freeze([...(rule.enforced_by ?? [])]),
    })));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function refs(rules: readonly ConstitutionRuleV1[]): readonly Readonly<{
  rule_id: string;
  rule_version: number;
}>[] {
  return canonicalRefs(rules.map((rule) =>
    Object.freeze({ rule_id: rule.id, rule_version: rule.version })));
}

function canonicalRefs(rules: readonly Readonly<{
  rule_id: string;
  rule_version: number;
}>[]): readonly Readonly<{ rule_id: string; rule_version: number }>[] {
  return Object.freeze([...rules].sort((left, right) =>
    left.rule_id.localeCompare(right.rule_id) ||
    left.rule_version - right.rule_version));
}

export function selectAdjudicationGates(
  registry: ConstitutionRegistry,
  evidence: AdjudicationEvidence,
): readonly AdjudicationGateRequest[] {
  const gates: AdjudicationGateRequest[] = [];
  if (evidence.constitution === "fail" || evidence.constitution === "uncertain") {
    const failed = evidence.rule_findings.filter((item) => item.compliance === "fail");
    const uncertain = evidence.rule_findings.filter((item) => item.compliance === "uncertain");
    gates.push(Object.freeze({
      kind: "adjudication-failure",
      subject_digest: evidence.subject_digest,
      context: Object.freeze({
        constitution: evidence.constitution,
        failed_rules: refs(failed.map((item) => registry.get(item.rule_id)!)),
        uncertain_rules: refs(uncertain.map((item) => registry.get(item.rule_id)!)),
        eligible_waiver_rules: refs([...failed, ...uncertain].map((item) =>
          registry.get(item.rule_id)!)),
        waiver_scope: Object.freeze({
          operation: "adjudication-failure",
          boundary: "subject",
        }),
      }),
    }));
  }
  // Material drift is deliberately serialized. Resolving this gate re-enters production
  // and requires fresh adjudication before another upstream can become authoritative.
  const material = evidence.drift_findings.find((item) => item.drift === "material");
  if (material !== undefined) {
    gates.push(Object.freeze({
      kind: "material-drift",
      subject_digest: evidence.subject_digest,
      context: Object.freeze({
        affected_upstream: Object.freeze({
          kind: "implementation-result",
          digest: material.upstream_digest,
        }),
        drift: "material",
        affected_claim_ids: Object.freeze([...material.affected_claim_ids].sort()),
      }),
    }));
  }
  if (
    evidence.matched_rule_versions.length > 0 ||
    evidence.uncertain_rule_versions.length > 0
  ) {
    gates.push(Object.freeze({
      kind: "review-trigger",
      subject_digest: evidence.subject_digest,
      context: Object.freeze({
        matched_rules: evidence.matched_rule_versions,
        uncertain_rules: evidence.uncertain_rule_versions,
        eligible_waiver_rules: canonicalRefs([
          ...evidence.matched_rule_versions,
          ...evidence.uncertain_rule_versions,
        ]),
        waiver_scope: Object.freeze({
          operation: "review-trigger",
          boundary: "subject",
        }),
      }),
    }));
  }
  return Object.freeze(gates);
}

/** Compatibility selector for callers that can publish only the next gate. */
export function selectAdjudicationGate(
  registry: ConstitutionRegistry,
  evidence: AdjudicationEvidence,
): AdjudicationGateRequest | undefined {
  return selectAdjudicationGates(registry, evidence)[0];
}

/**
 * Direct Phase 14 service. Phase 15 supplies handler-owned dispatch, transaction-result
 * preparation, and gate publication callbacks; this service owns their ordering and evidence.
 */
export async function runAdjudication(
  dependencies: RunAdjudicationDependencies,
  input: RunAdjudicationInput,
): Promise<ProjectResult<Readonly<{
  transaction?: TransactionOutcome<"archflow_adjudicate">;
  gate?: unknown;
  evidence?: AdjudicationEvidence;
}>>> {
  const stateRead = await dependencies.transaction.read_state(input.authority.state);
  if (stateRead.kind !== "canonical") {
    throw new TypeError("adjudication requires canonical current state");
  }
  const durableState = stateRead.document.value;
  if (
    durableState.task_id !== input.authority.task_id ||
    durableState.phase_instance !== input.envelope.subject.phase_instance ||
    durableState.input_fingerprint !== input.envelope.subject.input_fingerprint
  ) {
    throw new TypeError("adjudication subject is not durably current");
  }
  const loadedConstitution = await dependencies.load_constitution(
    durableState.policy_base_commit,
  );
  if (!loadedConstitution.ok) return loadedConstitution;
  const constitution = loadedConstitution.value;
  assertResolvedConstitution(constitution);
  const envelopeRules = rulesForEnvelope(constitution.rules);
  if (
    constitution.digest !== durableState.constitution_digest ||
    constitution.digest !== input.envelope.subject.pinned_constitution_digest ||
    !sameJson(envelopeRules, input.envelope.rules)
  ) {
    throw new TypeError("adjudication constitution is not durably pinned");
  }
  const currentReviews = await dependencies.load_current_review_set(
    input.authority,
    durableState.phase_instance,
  );
  if (!currentReviews.ok) return currentReviews;
  const current = currentReviews.value;
  const reviewsBindSubject =
    current.subject_digest === input.envelope.subject.subject_digest &&
    current.input_fingerprint === input.envelope.subject.input_fingerprint &&
    current.input_fingerprint === durableState.input_fingerprint;
  // One hop only: after an editorial revision the retained reviews stay bound to the
  // predecessor bytes the produce artifact declares; adjudication still binds the new subject.
  const reviewsBindDeclaredPredecessor =
    input.editorial_predecessor !== undefined &&
    current.subject_digest === input.editorial_predecessor.subject_digest &&
    current.input_fingerprint === input.editorial_predecessor.input_fingerprint;
  if (
    !authenticCurrentReviewSet(current) ||
    current.task_id !== input.authority.task_id ||
    current.task_id !== input.envelope.subject.task_id ||
    current.phase_instance !== durableState.phase_instance ||
    current.phase_instance !== input.envelope.subject.phase_instance ||
    (!reviewsBindSubject && !reviewsBindDeclaredPredecessor) ||
    current.current_evidence_set.set_digest !== input.envelope.source_evidence_set_digest ||
    current.current_evidence_set.set_digest !==
      input.envelope.subject.source_evidence_set_digest
  ) {
    throw new TypeError("adjudication source review set is not durably current");
  }
  const edited = await dependencies.detect_constitution_edit();
  if (!edited.ok) return edited;
  if (edited.value !== undefined) {
    const gate = await dependencies.open_gate({
      kind: "constitution-edit",
      subject_digest: input.envelope.subject.subject_digest,
      context: edited.value,
    });
    return gate.ok
      ? { schema_version: "1", ok: true, value: Object.freeze({ gate: gate.value }) }
      : gate;
  }

  const derivedUpstreams = await dependencies.derive_approved_upstreams(
    durableState,
    input.call.input.upstream_paths,
  );
  if (!derivedUpstreams.ok) return derivedUpstreams;
  const missingUpstreamApproval = derivedUpstreams.value.find((item) =>
    !durableState.approvals.some((approval) =>
      approval.gate_kind === "artifact-approval" &&
      approval.subject_digest === item.upstream_digest));
  if (missingUpstreamApproval !== undefined) {
    return {
      schema_version: "1",
      ok: false,
      error: createProjectError("STATE_INVALID", {
        phase_instance: durableState.phase_instance,
        issue_code: "upstream-approval-missing",
      }),
    };
  }
  const upstreamDigests = requireApprovedUpstreamDigests(
    durableState.approvals,
    derivedUpstreams.value.map((item) => item.upstream_digest),
  );
  if (
    upstreamDigests.length !== input.envelope.subject.approved_upstream_digests.length ||
    upstreamDigests.some((digest, index) =>
      digest !== input.envelope.subject.approved_upstream_digests[index])
  ) throw new TypeError("adjudication upstream subject is not durably derived");

  const route = resolveDispatchRoute(
    input.config,
    input.phase_kind,
    "adjudicator",
    input.producer_family,
  );
  const envelope = buildAdjudicationEnvelope({
    ...input.envelope,
    approved_upstreams: derivedUpstreams.value,
  });
  const dispatched = await serializeDispatch(() =>
    dependencies.dispatch(route, envelope, adjudicationOutputSchema as PlainJsonValue));
  let evidence: AdjudicationEvidence;
  try {
    const observed = mintAdjudicationObservation({
      subject: input.envelope.subject,
      adapter: route.adapter,
      cli_version: dispatched.cli_version,
      route,
      envelope_input_digest: envelope.digest,
      extracted_output_bytes: dispatched.extracted_output_bytes,
    });
    evidence = crossCheckRuleFindings(
      constitution.rules,
      observed.evidence,
      route.adapter,
    );
  } catch (error) {
    return {
      schema_version: "1",
      ok: false,
      error: error instanceof AdjudicationServiceError
        ? error.project_error
        : createProjectError("MODEL_OUTPUT_INVALID", {
          adapter: route.adapter,
          attempt: 1,
          issue_code: "adjudication-output-invalid",
        }),
    };
  }
  const prepared = await dependencies.prepare_evidence(evidence, durableState.revision);
  if (!prepared.ok) return prepared;
  const identified = identifyTransactionRequest(
    input.call,
    input.authority,
    prepared.value.reference.input_fingerprint,
  );
  const installation = prepareResultInstallation({
    reference: prepared.value.reference,
    prepared: prepared.value.prepared,
    manifest_target: prepared.value.manifest_target,
    projection_plan: prepared.value.projection_plan,
    worktree_root: dependencies.transaction.runner.location.worktreeRoot as ResolvedTaskPath,
  });
  const committed = await runStateTransaction(
    dependencies.transaction,
    { authority: input.authority, call: input.call },
    async (current, call) => {
      if (current.value.constitution_digest !== constitution.digest) {
        throw new TypeError("constitution changed before adjudication installation");
      }
      const revision = parseSafeInteger(current.value.revision + 1);
      const triggers = canonicalRefs([
        ...evidence.matched_rule_versions,
        ...evidence.uncertain_rule_versions,
      ]);
      const success = Object.freeze({
        path: adjudicationReviewClaim(current.value.phase_instance),
        constitution: evidence.constitution,
        drift: evidence.drift,
        triggers,
        revision,
        request_digest: identified.request_digest,
      });
      const expectation = createInternalResultExpectation({
        schema_version: "1",
        tool: "archflow_adjudicate",
        task_id: input.authority.task_id,
        intent_id: input.call.input.intent_id,
        input_fingerprint: prepared.value.reference.input_fingerprint,
        request_digest: identified.request_digest,
        result_id: prepared.value.reference.result_id,
        resulting_revision: revision,
        success,
      });
      const result = validateProjectResultStructure(call, {
        schema_version: "1",
        ok: true,
        value: success,
      });
      const next = planStateTransition({
        current: current.value,
        target: {
          phase_instance: current.value.phase_instance,
          step: "adjudicate",
          status: "succeeded",
          attempt: current.value.attempt,
          input_fingerprint: prepared.value.reference.input_fingerprint,
        },
        recomputed_input_fingerprint: prepared.value.reference.input_fingerprint,
        result_reference: prepared.value.reference,
      });
      if (!next.ok) return next;
      return {
        schema_version: "1",
        ok: true,
        value: {
          expectation,
          result,
          next_state: next.value,
          result_installation: installation,
        },
      };
    },
  );
  if (!committed.ok) return committed;
  const gateRequest = selectAdjudicationGate(constitution.rules, evidence);
  if (gateRequest === undefined) {
    return { schema_version: "1", ok: true, value: Object.freeze({
      transaction: committed.value,
      evidence,
    }) };
  }
  const gate = await dependencies.open_gate(gateRequest);
  if (!gate.ok) return gate;
  return { schema_version: "1", ok: true, value: Object.freeze({
    transaction: committed.value,
    gate: gate.value,
    evidence,
  }) };
}
