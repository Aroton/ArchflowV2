import type { RuleSettlementV1, TaskStateV1 } from "../contracts/durable-state.js";
import type { GateKind } from "../contracts/gates.js";
import type { PathSafeId, Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance, nextPhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { WORKFLOW_V1 } from "../contracts/workflow.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import type { EvidenceAssessment } from "../review/fixed-point.js";
import type { ReconciliationFinding } from "./reconciliation.js";

export type NextActionCode =
  | "initialize-repository"
  | "create-task"
  | "resume-exact-intent"
  | "inspect-retained-receipt"
  | "create-fresh-intent"
  | "resolve-current-authority"
  | "open-gate"
  | "resolve-open-gate"
  | "run-step"
  | "commit-artifacts"
  | "commit-phase"
  | "refresh-milestone-baseline"
  | "recover-milestone-authority"
  | "recover-approval-trigger-authority"
  | "refresh-stale-baseline"
  | "advance-phase"
  | "complete-task"
  | "task-complete"
  | "inspect-state";

export type NextAction = Readonly<{
  code: NextActionCode;
  detail: string;
  human_required: boolean;
  phase_instance?: PhaseInstanceId;
  /** The durable phase the action enters; distinct from `phase_instance`, which is current truth. */
  target_phase_instance?: PhaseInstanceId;
  step?: PipelineStep;
  skill?: string;
  /** Phase-specific arguments for `skill`; callers prepend the task id. */
  skill_args?: readonly string[];
  gate_id?: PathSafeId;
  gate_kind?: GateKind;
  /** Exact task-local milestone commit authorized by the approved design gate. */
  commit_path?: string;
  /** Exact sorted repository paths authorized for an implementation commit. */
  commit_paths?: readonly string[];
  commit_message?: string;
  commit_target_ref?: string;
  commit_baseline?: string;
  /** Fresh execution context for a non-primary repository commit. Omission means primary. */
  commit_repository?: Readonly<{ name: string; location: string }>;
  /**
   * Every constitution gate this review still demands, in the order they will open, including the
   * one named by `gate_kind`. Present only when more than one remains, so a human can be told the
   * total cost of the review before answering the first. Disclosure only: each gate is still
   * opened and decided separately.
   */
  pending_gate_kinds?: readonly GateKind[];
  /** Set on the produce run-step routed by `editorial_revision_required`: the produce re-entry applies exactly the accepted editorial revision intents and preserves review evidence. */
  editorial_revision?: boolean;
  /** Set on the produce run-step routed by `policy_reentry_required`: `detail` names the constitution findings the re-entry must resolve. */
  policy_reentry?: boolean;
  /** Set when authenticated phase-design effort evidence requires specification/decomposition revision. */
  effort_reentry?: boolean;
}>;

/** Agent-resolvable constitution findings, already mapped to the paths a producer can act on. */
export type PolicyReentryFindings = Readonly<{
  rules: readonly Readonly<{
    rule_id: string;
    rule_version: number;
    compliance: "fail" | "uncertain";
    rationale: string;
  }>[];
  drift: readonly Readonly<{
    path: string;
    affected_claim_ids: readonly string[];
    rationale: string;
  }>[];
}>;

export type AuthenticatedApprovalFact = Readonly<{
  gate_kind: GateKind;
  subject_digest: Sha256Digest;
}>;

export type NextActionInput = Readonly<{
  repository_initialized: boolean;
  state?: TaskStateV1;
  config_verified?: boolean;
  /** Why the config failed to read (`config-invalid`/`config-missing`/`config-unreadable`/`config-unresolvable`). */
  config_issue?: string;
  reconciliation_findings?: readonly ReconciliationFinding[];
  reconciliation_blocking_reasons?: readonly string[];
  /**
   * Task documents recorded by the current phase's work result whose worktree bytes have since
   * changed, set only while a review of that result is still owed. The review re-reads exactly
   * these before it dispatches, so while any remain it cannot record a terminal result — and no
   * human baseline decision can help, because adoption re-baselines a *path* while the recorded
   * result stays pinned to the bytes it recorded. Re-recording the result is the only move.
   */
  produce_subject_drift?: readonly string[];
  /**
   * The same drift on an approved upstream document (the PRD, the design, the phase design),
   * which the pending review also re-reads. The current phase cannot re-record another phase's
   * document, so the only recovery is putting the recorded bytes back.
   */
  upstream_document_drift?: readonly string[];
  /** Present with `assessment.policy_reentry_required`: what the produce re-entry has to resolve. */
  policy_findings?: PolicyReentryFindings;
  assessment?: EvidenceAssessment;
  evidence_available?: boolean;
  subject_digest?: Sha256Digest;
  authenticated_approvals?: readonly AuthenticatedApprovalFact[];
  /** Already authenticated status guidance; mutation independently re-authenticates this fact. */
  accepted_no_wait_settlement?: RuleSettlementV1;
  /** Fresh status comparison for the exceptional settlement-baseline refresh only. */
  milestone_refresh_config_matches?: boolean;
  commit_observed?: boolean;
  /**
   * Set when running the authorized milestone commit could not produce a recognizable milestone:
   * either it already ran and the result cannot be proven, or something in the task directory would
   * make the commit unprovable the moment it is made. Absent when the commit is simply not made yet.
   */
  commit_blocked_reason?: string;
  /** Server-proved same-position recovery after a milestone is missing from target history. */
  milestone_recovery_required?: boolean;
  /** One-shot re-entry for a pre-trigger adjudication fixed point. */
  approval_trigger_recovery_required?: boolean;
  /** Changed governing planning bytes are owned by the current design position and must re-enter review before any other drift is adopted. */
  governing_document_recovery_required?: boolean;
  /** Git/object/identity failures are inspection-only and never treated as missing authority. */
  milestone_proof_unverifiable_reason?: string;
  /** A stale open adoption interface must be superseded before status can render a fresh one. */
  stale_baseline_refresh_required?: boolean;
  /** Recovery would have no committable delta and therefore cannot produce a new milestone. */
  milestone_recovery_no_delta?: boolean;
  design_commit?: Readonly<{
    path: string;
    message: string;
    target_ref: string;
    baseline_commit: string;
  }>;
  implementation_commit?: Readonly<{
    paths: readonly string[];
    message: string;
    target_ref: string;
    baseline_commit: string;
    repository?: Readonly<{ name: string; location: string }>;
  }>;
  adjudication_gate_kind?: GateKind;
  /** Every constitution gate still pending, in the order they open; the first is `adjudication_gate_kind`. */
  pending_adjudication_gate_kinds?: readonly GateKind[];
  migration_audit_required?: boolean;
  /**
   * The authenticated resume point of an accepted legacy import. The design phase exits to this
   * phase instead of the fixed graph successor, so the reported skill is the server-derived
   * resume skill rather than a generic phase-1 hand-off.
   */
  legacy_resume_phase?: PhaseInstanceId;
}>;

function action(
  code: NextActionCode,
  detail: string,
  humanRequired: boolean,
  state?: TaskStateV1,
  extra: Partial<NextAction> = {},
): NextAction {
  if (state === undefined) return Object.freeze({ code, detail, human_required: humanRequired, ...extra });
  const kind = decodePhaseInstance(state.phase_instance).kind;
  const skill = WORKFLOW_V1.phases.find((phase) => phase.id === kind)?.skill;
  return Object.freeze({
    code,
    detail,
    human_required: humanRequired,
    phase_instance: state.phase_instance,
    ...(skill === undefined ? {} : { skill }),
    ...extra,
  });
}

/**
 * Names the actual remaining work for a run-step action: a step already running needs its
 * terminal result recorded, a failed step needs a retry entry, anything else needs its
 * running entry. The recorded entry write is part of "running" the step, so the mid-step
 * state must never be described as if the step had not started.
 */
function runStepDetail(state: TaskStateV1, step: PipelineStep): string {
  if (state.step === step && state.status === "running") return `Record the terminal ${step} result.`;
  if (state.step === step && state.status === "failed") return `Retry the ${step} pipeline step.`;
  return `Run the ${step} pipeline step.`;
}

/**
 * Names the constitution findings a produce re-entry exists to resolve. Written for the producer
 * that reads it from the revise offer: which rule, why it failed, which document the work drifted
 * from — never a gate or digest.
 */
function policyReentryDetail(findings: PolicyReentryFindings | undefined): string {
  const lines: string[] = [];
  for (const rule of findings?.rules ?? []) {
    const verdict = rule.compliance === "fail" ? "is not met" : "could not be shown to be met";
    lines.push(`Constitution rule ${rule.rule_id} (v${rule.rule_version}) ${verdict}: ${rule.rationale}`);
  }
  for (const drift of findings?.drift ?? []) {
    lines.push(`The work departs materially from ${drift.path} (${drift.affected_claim_ids.join(", ")}): ${drift.rationale}`);
  }
  const listed = lines.length === 0
    ? "The constitution review left findings this work must resolve."
    : lines.join(" ");
  return `${listed} Resolve these in the artifact — or update the governing document this result owns — then resubmit for a fresh review.`;
}

/**
 * The one move that can clear drift inside the live work result: record it again over the bytes
 * that are actually there. Named in plain language because it reaches the human as-is.
 */
function produceSubjectDriftAction(state: TaskStateV1, paths: readonly string[]): NextAction {
  const shown = paths.slice(0, 5);
  const listed = shown.join(", ");
  const rest = paths.length - shown.length;
  return action(
    "run-step",
    `${paths.length === 1 ? "A file" : `${paths.length} files`} this phase's recorded work result covers changed afterwards (${listed}${rest > 0 ? `, and ${rest} more` : ""}). The independent review re-reads them and will not review bytes the result never recorded, and no baseline decision can re-bind a recorded result to different bytes. Re-open the work window and submit a fresh result over the current bytes; the review then covers what is actually there.`,
    false,
    state,
    { step: "produce" },
  );
}

/**
 * The recorded bytes of an approved upstream document are what the pending review reads it
 * through, and no action in this phase can re-record another phase's document.
 */
function upstreamDocumentDriftAction(state: TaskStateV1, paths: readonly string[]): NextAction {
  return action(
    "inspect-state",
    `${paths.length === 1 ? "An approved planning document" : `${paths.length} approved planning documents`} the independent review reads this phase through changed after approval (${paths.slice(0, 5).join(", ")}). Nothing in this phase can re-record another phase's document, so put the recorded bytes back before continuing; keeping the new ones means reopening the phase that owns them.`,
    true,
    state,
  );
}

function matchingApproval(input: NextActionInput, kind: GateKind): boolean {
  const subjectDigest = input.subject_digest;
  if (subjectDigest !== undefined &&
    (input.authenticated_approvals ?? []).some((approval) =>
      approval.gate_kind === kind && approval.subject_digest === subjectDigest)) {
    return true;
  }
  return false;
}

function hasLegacyDesignApproval(input: NextActionInput): boolean {
  return matchingApproval(input, "artifact-approval");
}

function hasAcceptedNoWait(input: NextActionInput, state: TaskStateV1): boolean {
  const settlement = input.accepted_no_wait_settlement;
  return settlement !== undefined && input.subject_digest !== undefined &&
    settlement.task_id === state.task_id && settlement.phase_instance === state.phase_instance &&
    settlement.subject_digest === input.subject_digest && settlement.conclusion.wait === false;
}

function advanceAction(input: NextActionInput, state: TaskStateV1): NextAction {
  const phase = decodePhaseInstance(state.phase_instance);
  const designPhase = phase.kind === "design" || phase.kind === "phase-design";
  const requiredKind = designPhase
    ? "design-approval"
    : phase.kind === "prd"
      ? "artifact-approval"
    : phase.kind === "phase-impl"
      ? "commit-authorization"
      : undefined;
  const legacyDesignApproval = designPhase && hasLegacyDesignApproval(input);
  const migrationApproval = designPhase && matchingApproval(input, "migration-audit");
  const ordinaryApproved = requiredKind !== undefined && matchingApproval(input, requiredKind);
  // An exact ordinary approval is the stronger authority for this subject. A coexisting no-wait
  // settlement may explain why no gate was originally required, but it must never replace the
  // human-bound Git facts after the human has approved this exact subject.
  const autonomous = hasAcceptedNoWait(input, state) && !ordinaryApproved;
  // The imported design exits through its one migration audit, never a design-approval gate —
  // the same rule the adjudication branch applies when constitution gates are pending.
  if (designPhase && input.migration_audit_required === true) {
    return action("open-gate", "Open the reviewed migration audit for the exact imported documents and resume point.", true, state, {
      gate_kind: "migration-audit",
    });
  }
  if (requiredKind !== undefined && !ordinaryApproved && !legacyDesignApproval && !migrationApproval && !autonomous) {
    return action("open-gate", `Open the required ${requiredKind} gate.`, true, state, {
      gate_kind: requiredKind,
    });
  }
  // An artifact-approval request already recorded before design-approval existed completes under
  // its original contract. It did not authorize a commit, so only the new combined gate enters
  // the automatic commit step.
  if (designPhase && !legacyDesignApproval && input.commit_observed !== true) {
    if (autonomous && input.commit_blocked_reason === "approved-document-mismatch") {
      return action(
        "run-step",
        "The reviewed design bytes changed after rule settlement. Reopen produce so the current bytes receive fresh review authority.",
        false,
        state,
        { step: "produce" },
      );
    }
    if (input.design_commit === undefined) {
      return action("inspect-state", "Inspect why the approved design commit authority is unavailable.", true, state);
    }
    // The commit action can only run while the target is still the approved baseline, so a commit
    // that cannot be proven can never be retried. Offering it again — or offering one that would be
    // unprovable the moment it is made — only loops. The blocking reason says what to look at.
    if (input.commit_blocked_reason === "target-moved" && autonomous) {
      if (input.milestone_refresh_config_matches !== true) {
        return action(
          "run-step",
          "The approval-rule configuration changed after this design settled. Reopen produce so the current subject is reviewed under the live configuration before any Git baseline refresh.",
          false,
          state,
          { step: "produce" },
        );
      }
      return action(
        "refresh-milestone-baseline",
        "Refresh the unchanged reviewed design milestone baseline to the current target.",
        false,
        state,
      );
    }
    if (input.commit_blocked_reason !== undefined) {
      return action(
        "inspect-state",
        "Inspect why the authorized design milestone commit cannot be recognized; running it again cannot resolve this.",
        true,
        state,
      );
    }
    return action("commit-artifacts", "Commit the exact recoverable task-local milestone authorized by design approval.", false, state, {
      commit_path: input.design_commit.path,
      commit_message: input.design_commit.message,
      commit_target_ref: input.design_commit.target_ref,
      commit_baseline: input.design_commit.baseline_commit,
    });
  }
  if (phase.kind === "phase-impl" && input.commit_observed !== true) {
    if (input.implementation_commit === undefined) {
      return action("inspect-state", "Inspect why the approved implementation commit authority is unavailable.", true, state);
    }
    return action(
      "commit-phase",
      "Commit the exact phase outputs authorized by the authenticated workflow authority.",
      false,
      state,
      {
        commit_paths: input.implementation_commit.paths,
        commit_message: input.implementation_commit.message,
        commit_target_ref: input.implementation_commit.target_ref,
        commit_baseline: input.implementation_commit.baseline_commit,
        ...(input.implementation_commit.repository === undefined
          ? {}
          : { commit_repository: input.implementation_commit.repository }),
      },
    );
  }
  if (
    phase.kind === "phase-impl" &&
    state.planned_final_phase !== undefined &&
    Number(phase.phase) === Number(state.planned_final_phase)
  ) {
    return action("complete-task", "Record that the final planned implementation phase is committed.", false, state, {
      target_phase_instance: state.phase_instance,
      skill_args: Object.freeze([String(phase.phase)]),
    });
  }
  // An accepted migration audit exits the imported design phase straight to the import's
  // authenticated resume point; every other advance follows the fixed workflow graph.
  const target = designPhase && migrationApproval && input.legacy_resume_phase !== undefined
    ? input.legacy_resume_phase
    : nextPhaseInstance(state.phase_instance);
  if (target === undefined) {
    return action(
      "inspect-state",
      "Inspect the phase plan: the current phase has no representable fixed-workflow successor.",
      true,
      state,
    );
  }
  const targetPhase = decodePhaseInstance(target);
  const targetSkill = WORKFLOW_V1.phases.find((candidate) => candidate.id === targetPhase.kind)?.skill;
  if (targetSkill === undefined) {
    return action("inspect-state", "Inspect the fixed workflow: the successor phase has no skill.", true, state);
  }
  return action("advance-phase", "Advance to the next phase in the fixed workflow.", false, state, {
    target_phase_instance: target,
    skill: targetSkill,
    skill_args: targetPhase.kind === "phase-design" || targetPhase.kind === "phase-impl"
      ? Object.freeze([String(targetPhase.phase)])
      : Object.freeze([]),
  });
}

/** Derives exactly one legal next action from already-authenticated status facts. Pure and I/O-free. */
export function deriveNextAction(input: NextActionInput): NextAction {
  const state = input.state;
  if (state === undefined) {
    return input.repository_initialized
      ? action("create-task", "Create durable state for this task.", false)
      : action("initialize-repository", "Initialize ArchFlow in this repository.", false);
  }
  if (input.config_verified !== true) {
    const readIssue = input.config_issue === "config-missing"
      ? "missing"
      : input.config_issue === "config-unreadable" || input.config_issue === "config-unresolvable"
        ? "unreadable"
        : "invalid";
    return action(
      "inspect-state",
      `The task's config.yaml is ${readIssue}: fix the YAML so the configuration parses, then retry.`,
      true,
      state,
    );
  }
  if (input.stale_baseline_refresh_required === true) {
    return action(
      "refresh-stale-baseline",
      "The open baseline decision no longer matches the live repository subject. Supersede only that stale interface and request fresh status.",
      false,
      state,
    );
  }
  if (input.governing_document_recovery_required === true) {
    return action(
      "recover-milestone-authority",
      "A governing planning document changed after its authority was established. Preserve the repository bytes, retire stale authority, and begin a fresh significant production and review cycle at this owning design position.",
      false,
      state,
    );
  }
  const finding = input.reconciliation_findings?.[0];
  if (finding !== undefined) {
    if (finding.kind === "projection-mismatch") {
      // An already-open human gate outranks opening the drift decision: the baseline gate stands
      // open until the human decides, and re-offering to open it would loop the offer forever.
      if (state.open_gate !== undefined) {
        return action("resolve-open-gate", "Resolve the currently open human gate.", true, state, {
          gate_id: state.open_gate.gate_id,
          gate_kind: state.open_gate.gate_kind,
        });
      }
      // Drift inside the live work result's own documents outranks the baseline decision. That
      // gate re-baselines a path, which is enough for a completed phase's committed bytes but
      // can never re-bind the recorded result the review is about to be dispatched over — so
      // offering it here would spend a human decision and leave the review exactly as stuck.
      if ((input.produce_subject_drift ?? []).length > 0) {
        return produceSubjectDriftAction(state, input.produce_subject_drift!);
      }
      if ((input.upstream_document_drift ?? []).length > 0) {
        return upstreamDocumentDriftAction(state, input.upstream_document_drift!);
      }
      // A projected file absent from the worktree cannot be adopted (there are no current bytes to
      // keep); the honest recovery is the per-output restore, so route there instead of a gate —
      // unless the recorded projection has no retained bytes to restore from (an adoption records
      // digests only). Restore is then impossible, so the one honest recovery is reopening the
      // produce window: the fresh terminal produce re-declares the drifted paths and the deletion,
      // and the normal review boundary covers the new bytes.
      const missing = (input.reconciliation_findings ?? []).filter(
        (candidate): candidate is Extract<ReconciliationFinding, { kind: "projection-mismatch" }> =>
          candidate.kind === "projection-mismatch" && candidate.observed_digest === undefined,
      );
      if (missing.length > 0) {
        const produceReentryApplies = state.step === "produce" && state.status === "succeeded" &&
          state.authoritative_results.some((reference) =>
            reference.phase_instance === state.phase_instance && reference.step === "produce");
        // A committed deletion can neither be restored (adoption records are digest-only) nor
        // re-declared in a produce (no before-image in the base). The produce re-entry is still
        // the right next action while anything re-declarable remains — drifted paths, or a
        // missing file whose deletion is worktree-only — because the fresh terminal produce
        // covers those bytes under review instead of a bytes adoption. Once the only findings
        // left are committed deletions, the re-entry can make no progress and would loop, so
        // the human deletion decision takes over.
        const committedDeletions = missing.filter((candidate) =>
          candidate.committed_absent === true && candidate.restore_unavailable === true);
        const redeclarable = (input.reconciliation_findings ?? []).some((candidate) =>
          candidate.kind === "projection-mismatch" &&
          (candidate.observed_digest !== undefined || !(candidate.committed_absent === true && candidate.restore_unavailable === true)));
        if (produceReentryApplies && redeclarable && missing.some((candidate) => candidate.restore_unavailable === true)) {
          return action(
            "run-step",
            "A recorded projection is missing from the worktree and has no retained bytes to restore from. Reopen the produce window and record a fresh terminal produce that re-declares the drifted paths and the deletion; the review boundary then covers the new bytes. A deletion already absent from HEAD cannot be re-declared and settles at its own human decision afterwards.",
            false,
            state,
            { step: "produce" },
          );
        }
        if (committedDeletions.length > 0) {
          const deletedCount = committedDeletions.length;
          return action(
            "open-gate",
            `${deletedCount} file${deletedCount === 1 ? "" : "s"} ArchFlow recorded from reviewed work w${deletedCount === 1 ? "as" : "ere"} deleted by an already-committed change, and no retained bytes exist to restore. Open the baseline decision so a human chooses whether the records accept the committed deletion${deletedCount === 1 ? "" : "s"} as the baseline.`,
            true,
            state,
            { gate_kind: "baseline-adoption" },
          );
        }
        return action(
          "inspect-state",
          "A file ArchFlow recorded from reviewed work is missing from the worktree; inspect the projection and restore its recorded bytes per output before continuing.",
          true,
          state,
        );
      }
      const count = input.reconciliation_findings?.filter((candidate) => candidate.kind === "projection-mismatch").length ?? 1;
      return action(
        "open-gate",
        `${count} file${count === 1 ? "" : "s"} changed after ArchFlow recorded their reviewed bytes (for example by later commits or a merge). Open the baseline decision so a human chooses: keep the current bytes as the new recorded baseline, or restore the recorded bytes.`,
        true,
        state,
        { gate_kind: "baseline-adoption" },
      );
    }
    return action(finding.next_action, `Resolve reconciliation finding ${finding.kind}.`, true, state);
  }
  const discoveryBlocker = input.reconciliation_blocking_reasons?.[0];
  if (discoveryBlocker !== undefined) {
    return discoveryBlocker === "retained-receipt-ambiguity"
      ? action("inspect-retained-receipt", "Inspect the ambiguous retained successor receipts.", true, state)
      : action("inspect-state", `Inspect reconciliation discovery blocker ${discoveryBlocker}.`, true, state);
  }
  if (input.milestone_proof_unverifiable_reason !== undefined) {
    return action(
      "inspect-state",
      `Milestone proof is unavailable (${input.milestone_proof_unverifiable_reason}); inspect repository identity and Git object availability before retrying.`,
      true,
      state,
    );
  }
  if (input.milestone_recovery_required === true) {
    if (input.accepted_no_wait_settlement?.milestone_baseline_commit !== undefined &&
        input.milestone_refresh_config_matches !== true) {
      return action(
        "run-step",
        "The approval-rule configuration changed after this design settled. Reopen produce so the current subject is reviewed under the live configuration before recovering milestone authority.",
        false,
        state,
        { step: "produce" },
      );
    }
    if (input.milestone_recovery_no_delta === true) {
      return action(
        "inspect-state",
        "The milestone is missing from target history, but the current tree has no committable delta for a replacement milestone. Restore the authorized baseline or make the intended change explicit before recovering authority.",
        true,
        state,
      );
    }
    return action(
      "recover-milestone-authority",
      "The authorized milestone is missing from target history. Retire this phase's stale authority and begin a fresh significant production attempt at the same position.",
      false,
      state,
    );
  }
  if (state.terminal !== undefined) {
    return action(
      "task-complete",
      state.terminal === "complete"
        ? "The final planned implementation phase is committed."
        : `Task is terminal: ${state.terminal}.`,
      false,
      state,
    );
  }
  if (state.open_gate !== undefined) {
    return action("resolve-open-gate", "Resolve the currently open human gate.", true, state, {
      gate_id: state.open_gate.gate_id,
      gate_kind: state.open_gate.gate_kind,
    });
  }
  const currentProduce = state.authoritative_results.some((reference) =>
    reference.phase_instance === state.phase_instance && reference.step === "produce");
  if (!currentProduce) {
    return action("run-step", runStepDetail(state, "produce"), false, state, { step: "produce" });
  }
  // Mid-produce (running or failed) the only legal move is finishing produce. This covers every
  // produce re-entry once its running entry is recorded — accepted findings, editorial revision,
  // or the author-initiated new-information door: prior-cycle evidence is still retained but
  // must not re-route the next action while the artifact is being rewritten.
  if (state.step === "produce" && state.status !== "succeeded") {
    return action("run-step", runStepDetail(state, "produce"), false, state, { step: "produce" });
  }
  // Reached when reconciliation is already consistent — most often because a human adopted the
  // changed bytes as the new baseline for the path. The recorded work result still is not the
  // bytes on disk, so the pipeline would otherwise keep offering a review that cannot run.
  if ((input.produce_subject_drift ?? []).length > 0) {
    return produceSubjectDriftAction(state, input.produce_subject_drift!);
  }
  if ((input.upstream_document_drift ?? []).length > 0) {
    return upstreamDocumentDriftAction(state, input.upstream_document_drift!);
  }
  if (input.approval_trigger_recovery_required === true && input.migration_audit_required !== true) {
    return action(
      "recover-approval-trigger-authority",
      "Retire the pre-trigger review fixed point and re-enter production so unchanged bytes receive fresh review and an authenticated approval trigger.",
      false,
      state,
    );
  }
  const next = input.assessment?.next;
  if (next !== undefined) {
    if (next === "advance") return advanceAction(input, state);
    if (next === "attempts-exhausted") {
      return action("open-gate", "Open the attempts-exhausted gate.", true, state, { gate_kind: "attempts-exhausted" });
    }
    if (next === "adjudication-gate") {
      const phase = decodePhaseInstance(state.phase_instance);
      if (phase.kind === "design" || phase.kind === "phase-design") {
        if (input.migration_audit_required === true) {
          return action("open-gate", "Open the reviewed migration audit for the exact imported documents and resume point.", true, state, {
            gate_kind: "migration-audit",
          });
        }
        if (input.adjudication_gate_kind === "material-drift") {
          // Material upstream drift asks where the correction belongs, so it retains its distinct
          // redirect/revise decision instead of being silently collapsed into document approval.
        } else if (hasLegacyDesignApproval(input) && !matchingApproval(input, "design-approval")) {
          // A legacy document approval does not erase any separately recorded constitution gate.
          // Let the old adjudication contract finish instead of opening the new combined gate.
        } else if (input.adjudication_gate_kind === "constitution-review") {
          return matchingApproval(input, "design-approval")
          ? advanceAction(input, state)
          : action("open-gate", "Open the single design approval with its policy findings and commit authority.", true, state, {
              gate_kind: "design-approval",
            });
        }
      }
      if (
        input.adjudication_gate_kind === "constitution-review" &&
        phase.kind !== "design" && phase.kind !== "phase-design"
      ) {
        const ordinaryKind = phase.kind === "prd"
          ? "artifact-approval"
          : phase.kind === "phase-impl"
            ? "commit-authorization"
            : undefined;
        if (ordinaryKind === undefined) {
          return action("inspect-state", "Inspect the unresolved adjudication gate obligation.", true, state);
        }
        return matchingApproval(input, ordinaryKind)
          ? advanceAction(input, state)
          : action(
            "open-gate",
            `Open the single ${ordinaryKind} boundary with its policy findings and authority.`,
            true,
            state,
            { gate_kind: ordinaryKind },
          );
      }
      if (input.adjudication_gate_kind === undefined) {
        return action("inspect-state", "Inspect the unresolved adjudication gate obligation.", true, state);
      }
      const pending = input.pending_adjudication_gate_kinds ?? [];
      const remaining = pending.length > 1
        ? ` This review requires ${pending.length} separate human decisions; the rest open in turn: ${pending.slice(1).join(", ")}.`
        : "";
      return action("open-gate", `Open the required ${input.adjudication_gate_kind} gate.${remaining}`, true, state, {
        gate_kind: input.adjudication_gate_kind,
        ...(pending.length > 1 ? { pending_gate_kinds: Object.freeze([...pending]) } : {}),
      });
    }
    if (next === "produce" && input.assessment?.editorial_revision_required === true) {
      return action(
        "run-step",
        "Apply exactly the accepted editorial revision intents to the artifact, then run the produce step; nothing is re-run — the retained reviews and constitution verdict stay bound to the declared predecessor.",
        false,
        state,
        { step: "produce", editorial_revision: true },
      );
    }
    if (next === "produce" && input.assessment?.effort_reentry_required === true) {
      const blockers = input.assessment.effort_blockers ?? [];
      const details = blockers.map((blocker) => blocker.kind === "specification-gap"
        ? `${blocker.component_id}: ${blocker.question}`
        : `Implementation components need a clearer boundary: ${blocker.rationale}`);
      return action(
        "run-step",
        `Revise the phase design to resolve its authenticated effort-review blockers.${details.length === 0 ? "" : ` ${details.join(" ")}`}`,
        false,
        state,
        { step: "produce", effort_reentry: true },
      );
    }
    if (next === "produce" && input.assessment?.policy_reentry_required === true) {
      return action("run-step", policyReentryDetail(input.policy_findings), false, state, {
        step: "produce", policy_reentry: true,
      });
    }
    return action("run-step", runStepDetail(state, next), false, state, { step: next });
  }
  return input.evidence_available === false
    ? action("inspect-state", "Inspect why current evidence is unavailable.", true, state)
    : action("run-step", runStepDetail(state, state.step), false, state, { step: state.step });
}
