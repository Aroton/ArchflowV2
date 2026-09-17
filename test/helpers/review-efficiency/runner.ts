/**
 * The experiment runner: the test-only stream transformation, per-role attempts with the
 * production-mirrored transient retry policy, group execution under one dispatch-queue
 * link, and the whole opt-in experiment loop with its probe and inconclusive stops.
 */

import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseRawAdjudicationV2, type RawAdjudicationV2 } from "../../../src/contracts/adjudication.js";
import { canonicalJsonDigest, parseGitOid, sha256Bytes, type GitOid } from "../../../src/contracts/canonical.js";
import type { Sha256Digest } from "../../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../../src/contracts/plain-json.js";
import { parseReviewFeedback, type ReviewFeedbackOutput } from "../../../src/contracts/review.js";
import { preflightAdapter, selectCliAdapter, serializeDispatch, type CliPreflight } from "../../../src/dispatch/cli.js";
import { isTransientDispatchFailure } from "../../../src/dispatch/recovery.js";
import { DispatchProcessError, runDispatchChild, type DispatchChildResult, type DispatchChildSpec } from "../../../src/dispatch/process.js";
import { createDispatchWorkspace, type DispatchWorkspace } from "../../../src/dispatch/workspace.js";
import {
  buildExperimentBinding,
  EfficiencyJournal,
  loadEfficiencyCheckpoint,
  validateStageLayout,
  type DeepMutable,
  type EfficiencyAttempt,
  type EfficiencyCheckpoint,
  type EfficiencyGroupRecord,
  type EfficiencyRoleRecord,
  type PreflightRecord,
} from "./checkpoint.js";
import { buildEfficiencyFixtures, type EfficiencyCaseFixture, type EfficiencyFixtures } from "./fixtures.js";
import {
  GROUP_PLAN,
  MAX_ROLE_ATTEMPTS,
  REVIEW_EFFICIENCY_OUTPUT_ENV,
  REVIEW_EFFICIENCY_ROUTE,
  REVIEW_EFFICIENCY_STAGE_ENV,
  TRANSIENT_BACKOFF_MS,
  type EfficiencyRole,
  type GroupPlanEntry,
} from "./plan.js";
import { parseClaudeStream, usageFromTerminal } from "./stream.js";
import {
  buildObservationDocument,
  fillInconclusiveAssessment,
  validateEfficiencyStageAndOutput,
  writeInconclusive,
  writeStagedOutput,
  type ReviewEfficiencyOutcome,
} from "./observation.js";

// ---------------------------------------------------------------------------
// Test-only stream transformation
// ---------------------------------------------------------------------------

type CliInvocation = Omit<DispatchChildSpec, "signal" | "cancellation_source">;

/**
 * The one permitted child-side change: the single `--output-format json` value becomes
 * `stream-json` and `--verbose` is appended. Every other argv element, the stdin payload, cwd,
 * environment, schema, tool restriction, and settings isolation are preserved untouched.
 */
export function streamJsonInvocation(invocation: CliInvocation): CliInvocation {
  const argv = [...invocation.argv];
  const flagIndices = argv.flatMap((value, index) => (value === "--output-format" ? [index] : []));
  if (flagIndices.length !== 1) {
    throw new TypeError(`expected exactly one --output-format flag, found ${String(flagIndices.length)}`);
  }
  const valueIndex = flagIndices[0]! + 1;
  if (argv[valueIndex] !== "json") {
    throw new TypeError("the --output-format value is not the production json form");
  }
  argv[valueIndex] = "stream-json";
  argv.push("--verbose");
  return Object.freeze({ ...invocation, argv: Object.freeze(argv) });
}

function invocationFingerprint(invocation: CliInvocation): Sha256Digest {
  return canonicalJsonDigest({
    command: invocation.command,
    argv: [...invocation.argv],
    cwd: invocation.cwd,
    stdin_sha256: invocation.stdin === undefined ? null : sha256Bytes(invocation.stdin),
  });
}

// ---------------------------------------------------------------------------
// Attempt execution with production-mirrored transient retries
// ---------------------------------------------------------------------------

function isTransientProjectError(projectError: { code: string; diagnostic: { parameters: Record<string, unknown> } }): boolean {
  return projectError.code === "RATE_LIMITED" || projectError.code === "TIMEOUT" ||
    projectError.code === "REPOSITORY_VIEW_UNAVAILABLE" ||
    (projectError.code === "PROCESS_FAILED" &&
      projectError.diagnostic.parameters.exit_class === "transient-transport");
}

function projectErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "project_error" in error) {
    const projectError = (error as { project_error: { code: string } }).project_error;
    if (projectError !== null && typeof projectError === "object") return projectError.code;
  }
  return undefined;
}

/** Classified diagnostic parameters (e.g. exit class), so a bare code stays diagnosable. */
function projectErrorParameters(error: unknown): PlainJsonValue | undefined {
  if (error !== null && typeof error === "object" && "project_error" in error) {
    const projectError = (error as { project_error: unknown }).project_error;
    if (projectError !== null && typeof projectError === "object" && "diagnostic" in projectError) {
      const parameters = (projectError as { diagnostic?: { parameters?: unknown } }).diagnostic?.parameters;
      if (parameters !== null && typeof parameters === "object") {
        return JSON.parse(JSON.stringify(parameters)) as PlainJsonValue;
      }
    }
  }
  return undefined;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}

function nowIso(): string {
  return new Date().toISOString();
}

function findGroup(checkpoint: EfficiencyCheckpoint, groupId: string): EfficiencyGroupRecord {
  const entry = checkpoint.groups.find((group) => group.group_id === groupId);
  if (entry === undefined) throw new TypeError(`checkpoint has no group ${groupId}`);
  return entry;
}

function mutateCheckpoint(
  journal: EfficiencyJournal,
  groupId: string,
  role: EfficiencyRole | undefined,
  mutate: (group: DeepMutable<EfficiencyGroupRecord>, roleRecord: DeepMutable<EfficiencyRoleRecord> | undefined) => void,
): Promise<void> {
  return journal.update((checkpoint) => {
    const group = checkpoint.groups.find((candidate) => candidate.group_id === groupId)!;
    const roleRecord = role === undefined ? undefined : group.roles.find((candidate) => candidate.role === role)!;
    mutate(group, roleRecord);
  });
}

type PreflightFacts = Readonly<{ cli_version: string; managed_policy_present?: boolean }>;

function latestSucceededPreflight(checkpoint: EfficiencyCheckpoint): PreflightFacts | undefined {
  const succeeded = [...checkpoint.preflight_runs].reverse().find((run) => run.status === "succeeded");
  if (succeeded === undefined) return undefined;
  return {
    cli_version: succeeded.cli_version!,
    ...(succeeded.managed_policy_present === undefined ? {} : { managed_policy_present: succeeded.managed_policy_present }),
  };
}

export type ReviewEfficiencyOptions = Readonly<{
  stage: string;
  output: string;
  repositoryRoot: string;
  preflight?: (workspace: DispatchWorkspace) => Promise<CliPreflight>;
  runChild?: (spec: DispatchChildSpec) => Promise<DispatchChildResult>;
  wait?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
}>;

/**
 * Runs the whole paired experiment against an explicit stage and output. The preflight and child
 * runners are injectable so deterministic tests exercise the identical orchestration without a
 * host; production use passes the adapter preflight and {@link runDispatchChild}.
 */
export async function runReviewEfficiencyExperiment(options: ReviewEfficiencyOptions): Promise<ReviewEfficiencyOutcome> {
  const runChild = options.runChild ?? ((spec: DispatchChildSpec) => runDispatchChild(spec));
  const preflightFn = options.preflight ?? ((workspace: DispatchWorkspace) => preflightAdapter("claude-cli", workspace));
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const log = options.log ?? (() => undefined);

  const paths = await validateEfficiencyStageAndOutput({
    [REVIEW_EFFICIENCY_STAGE_ENV]: options.stage,
    [REVIEW_EFFICIENCY_OUTPUT_ENV]: options.output,
  });
  const layout = await validateStageLayout(paths.stage, paths.output);
  const fixtures = await buildEfficiencyFixtures(options.repositoryRoot);
  try {
    // Executable fixture oracles establish intended behavior before any model call.
    await fixtures.runOracles();
    const binding = buildExperimentBinding({
      sourceCommit: gitHead(options.repositoryRoot),
      baseline: fixtures.baseline,
      rubricDigests: fixtures.rubric_digests,
      caseInputs: [...fixtures.cases.values()].map((entry) => ({
        case_id: entry.case_id,
        input_digest: entry.input_fingerprint,
        artifact_digest: entry.artifact_digest,
        roles: entry.roles,
      })),
    });
    const journal = new EfficiencyJournal(paths.stage, await loadEfficiencyCheckpoint(paths.stage, binding, layout));
    const preflightWorkspace = await createDispatchWorkspace("claude-cli", options.repositoryRoot);
    try {
      await journal.update((checkpoint) => {
        checkpoint.preflight_runs.push({ status: "running", started_at: nowIso() });
      });
      let preflight: CliPreflight;
      try {
        preflight = await preflightFn(preflightWorkspace);
      } catch (error) {
        const code = projectErrorCode(error) ?? "PREFLIGHT_FAILED";
        await journal.update((checkpoint) => {
          const run = checkpoint.preflight_runs[checkpoint.preflight_runs.length - 1]!;
          run.status = "failed";
          run.finished_at = nowIso();
          run.failure = { code, message: boundedMessage(error) };
        });
        log(`preflight failed: ${code}`);
        return writeInconclusive(journal, paths.output, `route/preflight unavailable: ${code}`);
      }
      // A resumed process preflights once again; completed observations must never combine
      // environments, so a changed CLI version stops as inconclusive instead. Prior observations
      // are read before this run's preflight is recorded, otherwise the guard compares the
      // current version against itself and can never fire.
      const observedVersions = new Set<string>(
        completedCliVersions(journal.value),
      );
      if (observedVersions.size > 0 && !observedVersions.has(preflight.cli_version)) {
        const reason = `cli version changed across runs: observed ${[...observedVersions].sort().join(", ")} then ${preflight.cli_version}`;
        return writeInconclusive(journal, paths.output, reason);
      }
      await journal.update((checkpoint) => {
        const run = checkpoint.preflight_runs[checkpoint.preflight_runs.length - 1]!;
        run.status = "succeeded";
        run.finished_at = nowIso();
        run.cli_version = preflight.cli_version;
        run.managed_policy_present = preflight.managed_policy_present;
        run.managed_policy_paths = [...preflight.managed_policy_paths];
      });
      log(`preflight ok: cli ${preflight.cli_version}`);
      const probe = probeProblem(journal.value);
      if (probe !== undefined) return writeInconclusive(journal, paths.output, probe);

      for (const planned of GROUP_PLAN) {
        const record = findGroup(journal.value, planned.group_id);
        if (record.status === "completed") {
          log(`group ${planned.group_id} (${planned.case_id}/${planned.variant}) already complete; reused`);
          continue;
        }
        await executeGroup(journal, fixtures, planned, {
          runChild, wait, log, repositoryRoot: options.repositoryRoot,
        });
        if (planned.order === 1) {
          // The first planned turn is the bounded stream-shape probe; stop before spending the
          // remaining turns when its required measurement fields are unavailable.
          const issue = probeProblem(journal.value);
          if (issue !== undefined) return writeInconclusive(journal, paths.output, issue);
        }
      }

      const document = buildObservationDocument(journal.value);
      await writeStagedOutput(paths.output, document);
      log(`staged observation written: ${paths.output}`);
      return { status: "completed", output: paths.output };
    } finally {
      await preflightWorkspace.dispose().catch(() => undefined);
    }
  } finally {
    await fixtures.cleanup();
  }
}

function completedCliVersions(checkpoint: EfficiencyCheckpoint): readonly string[] {
  const versions: string[] = [];
  for (const run of checkpoint.preflight_runs) {
    if (run.status === "succeeded" && run.cli_version !== undefined) versions.push(run.cli_version);
  }
  for (const group of checkpoint.groups) {
    for (const role of group.roles) {
      for (const attempt of role.attempts) {
        if (attempt.cli_version !== undefined) versions.push(attempt.cli_version);
      }
    }
  }
  return versions;
}

/**
 * The first planned turn must demonstrate one valid terminal wrapper, production structured
 * output extraction, cumulative terminal usage fields, and an accepted model. Document-only
 * cases now permit read-only tools to load supplied files. The CLI's own `StructuredOutput` emission is
 * mechanism, not investigation, so it never violates the probe. Returns the named loss, if any.
 */
export function probeProblem(checkpoint: EfficiencyCheckpoint): string | undefined {
  const first = checkpoint.groups[0];
  if (first === undefined || first.status !== "completed") return undefined;
  const role = first.roles[0];
  const attempt = role?.attempts.find((candidate) => candidate.status === "succeeded");
  if (attempt === undefined) {
    return "the stream-shape probe turn produced no valid terminal wrapper after its retries";
  }
  if (attempt.usage?.input_tokens === undefined || attempt.usage?.output_tokens === undefined) {
    return "terminal cumulative usage fields are unavailable on the probe turn";
  }
  if (attempt.accepted_model === undefined) {
    return "the probe turn did not record an accepted model from the stream";
  }
  return undefined;
}

type GroupExecution = Readonly<{
  runChild: (spec: DispatchChildSpec) => Promise<DispatchChildResult>;
  wait: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
  repositoryRoot: string;
}>;

async function executeGroup(
  journal: EfficiencyJournal,
  fixtures: EfficiencyFixtures,
  planned: GroupPlanEntry,
  execution: GroupExecution,
): Promise<void> {
  const fixture = fixtures.cases.get(planned.case_id)!;
  if (fixture === undefined) throw new TypeError(`no fixture for case ${planned.case_id}`);
  await journal.update((checkpoint) => {
    const group = findGroupMutable(checkpoint, planned.group_id);
    group.status = "running";
    group.started_at = nowIso();
  });
  const started = Date.now();
  // Document cases have no fixture workspace; the group creates one for the child roots.
  const documentWorkspace = fixture.workspace === undefined
    ? await createDispatchWorkspace("claude-cli", execution.repositoryRoot)
    : undefined;
  try {
    const operations = planned.roles.map((role) => () =>
      executeRole(journal, fixture, planned, role, execution, documentWorkspace));
    // One process-wide FIFO link capturing every sibling outcome before the next variant starts;
    // an early rejection (serializeDispatchAll) would release the queue while siblings run.
    await serializeDispatch(() => Promise.allSettled(operations.map((operation) => operation())));
  } finally {
    await documentWorkspace?.dispose().catch(() => undefined);
  }
  await journal.update((checkpoint) => {
    const group = findGroupMutable(checkpoint, planned.group_id);
    group.status = "completed";
    group.finished_at = nowIso();
    group.wall_time_ms = Date.now() - started;
  });
  execution.log(`group ${planned.group_id} (${planned.case_id}/${planned.variant}) completed`);
}

function findGroupMutable(checkpoint: DeepMutable<EfficiencyCheckpoint>, groupId: string): DeepMutable<EfficiencyGroupRecord> {
  const entry = checkpoint.groups.find((group) => group.group_id === groupId);
  if (entry === undefined) throw new TypeError(`checkpoint has no group ${groupId}`);
  return entry;
}

function findRoleMutable(group: DeepMutable<EfficiencyGroupRecord>, role: EfficiencyRole): DeepMutable<EfficiencyRoleRecord> {
  const entry = group.roles.find((candidate) => candidate.role === role);
  if (entry === undefined) throw new TypeError(`group ${group.group_id} has no role ${role}`);
  return entry;
}

async function executeRole(
  journal: EfficiencyJournal,
  fixture: EfficiencyCaseFixture,
  planned: GroupPlanEntry,
  role: EfficiencyRole,
  execution: GroupExecution,
  documentWorkspace: DispatchWorkspace | undefined,
): Promise<void> {
  const variantEnvelopes = fixture.envelopes[planned.variant];
  const constitution = variantEnvelopes.constitution;
  const envelope = role === "constitution"
    ? constitution!.envelope
    : role === "test"
      ? variantEnvelopes.test!
      : variantEnvelopes.general;
  const outputSchema = role === "constitution" ? constitution!.outputSchema : fixture.output_schema;
  const baseWorkspace = fixture.workspace ?? documentWorkspace;
  if (baseWorkspace === undefined) throw new TypeError(`${planned.case_id}: no workspace for role execution`);
  const adapter = selectCliAdapter("claude", REVIEW_EFFICIENCY_ROUTE);
  const childRoot = join(baseWorkspace.root, "children", `${planned.group_id}-${role}`);
  await mkdir(childRoot, { recursive: true, mode: 0o700 });
  const childWorkspace: DispatchWorkspace = Object.freeze({
    ...baseWorkspace,
    root: childRoot,
    env: Object.freeze({ ...baseWorkspace.env, TMPDIR: childRoot }),
  });
  const invocation = streamJsonInvocation(
    await adapter.buildInvocation(envelope, REVIEW_EFFICIENCY_ROUTE, childWorkspace, outputSchema),
  );
  const fingerprint = invocationFingerprint(invocation);

  // Resume reuses terminal work: a succeeded role is never re-dispatched, a finalized
  // nontransient failure is terminal regardless of the recovered role status, and an interrupted
  // role continues from its retained attempts, keeping the per-role budget across processes.
  const retained = findGroup(journal.value, planned.group_id)
    .roles.find((candidate) => candidate.role === role)!;
  if (retained.status === "succeeded") {
    execution.log(`role ${planned.group_id}/${role} already succeeded; reused`);
    return;
  }
  // Terminality comes from the retained attempts, not the role status, so neither recovery nor a
  // crash between finalization and role-end bookkeeping can resurrect a terminal failure.
  const terminalFailure = retained.attempts.find((attempt) =>
    attempt.status === "failed" && attempt.failure !== undefined && !attempt.failure.transient);
  if (terminalFailure !== undefined) {
    execution.log(`role ${planned.group_id}/${role} already failed terminally (${terminalFailure.failure!.code}); reused`);
    return;
  }
  for (let index = retained.attempts.length + 1; index <= MAX_ROLE_ATTEMPTS; index += 1) {
    await journal.update((checkpoint) => {
      const roleRecord = findRoleMutable(findGroupMutable(checkpoint, planned.group_id), role);
      roleRecord.status = "running";
      roleRecord.attempts.push({ index, status: "running", started_at: nowIso() });
    });
    const startMs = Date.now();
    const preflightFacts = latestSucceededPreflight(journal.value);
    let child: DispatchChildResult;
    try {
      child = await execution.runChild({ ...invocation, signal: new AbortController().signal });
    } catch (error) {
      const code = projectErrorCode(error) ?? "UNKNOWN";
      const transient = isTransientDispatchFailure(error);
      const diagnosticParameters = projectErrorParameters(error);
      const roleEnded = !transient || index === MAX_ROLE_ATTEMPTS;
      await finalizeFailedAttempt(journal, planned.group_id, role, index, Date.now() - startMs,
        {
          code, message: boundedMessage(error), transient,
          ...(diagnosticParameters === undefined ? {} : { parameters: diagnosticParameters }),
        }, preflightFacts, {}, roleEnded ? "failed" : undefined);
      if (roleEnded) {
        execution.log(`role ${planned.group_id}/${role} failed: ${code}`);
        return;
      }
      await execution.wait(TRANSIENT_BACKOFF_MS[index - 1]!);
      continue;
    }
    try {
      const parsed = parseClaudeStream(child.stdout);
      // Serialize only the terminal result object into a cloned child result so production
      // failure classification and structured-output extraction apply unchanged.
      // A real Buffer: plain Uint8Array.prototype.toString ignores the encoding argument and
      // returns comma-joined digits, which would blind the failure-message classifier.
      const clone = { ...child, stdout: Buffer.from(JSON.stringify(parsed.terminal), "utf8") } as DispatchChildResult;
      const failure = adapter.classifyFailure(clone);
      if (failure !== undefined) {
        const transient = isTransientProjectError(failure);
        const failureParameters = JSON.parse(JSON.stringify(failure.diagnostic.parameters)) as PlainJsonValue;
        // A bounded terminal excerpt keeps provider-side rejections (quota, capacity) diagnosable
        // in the observation without retaining arbitrary output beyond what classification needs.
        const excerpt = JSON.stringify(parsed.terminal).slice(0, 400);
        // A classified terminal failure's real measurements stay visible: the stream parsed, so
        // its usage and tool observations belong to this attempt and to the aggregates.
        const { usage: failedUsage, usage_raw: failedUsageRaw } = usageFromTerminal(parsed.terminal);
        const hasFailedUsage = Object.keys(failedUsage).length > 0;
        const roleEnded = !transient || index === MAX_ROLE_ATTEMPTS;
        await finalizeFailedAttempt(journal, planned.group_id, role, index, Date.now() - startMs,
          {
            code: failure.code, message: boundedMessage(new Error(excerpt)), transient,
            parameters: failureParameters,
          }, preflightFacts, {
            ...(hasFailedUsage ? { usage: failedUsage } : {}),
            ...(failedUsageRaw === undefined ? {} : { usage_raw: failedUsageRaw }),
            tool_calls: parsed.toolCalls,
            structured_output_calls: parsed.structuredOutputCalls,
          }, roleEnded ? "failed" : undefined);
        if (roleEnded) {
          execution.log(`role ${planned.group_id}/${role} failed: ${failure.code}`);
          return;
        }
        await execution.wait(TRANSIENT_BACKOFF_MS[index - 1]!);
        continue;
      }
      const extracted = adapter.parseOutput(clone);
      const terminal = parsed.terminal;
      const { usage, usage_raw } = usageFromTerminal(terminal);
      // The stream-json terminal carries no top-level model; the stream reports it instead.
      const acceptedModel = typeof terminal.model === "string" && terminal.model.trim() !== ""
        ? terminal.model
        : parsed.model;
      let reviewFeedback: ReviewFeedbackOutput | undefined;
      let judgments: PlainJsonValue | undefined;
      if (envelope.result_kind === "review") {
        const parsedOutput: unknown = JSON.parse(decoder.decode(extracted));
        reviewFeedback = parseReviewFeedback(parsedOutput);
      } else {
        const parsedOutput: unknown = JSON.parse(decoder.decode(extracted));
        const validated: RawAdjudicationV2 = parseRawAdjudicationV2(parsedOutput, constitution!.slots);
        judgments = validated.judgments as unknown as PlainJsonValue;
      }
      await mutateCheckpoint(journal, planned.group_id, role, (_group, roleRecord) => {
        roleRecord!.status = "succeeded";
        const attempt = roleRecord!.attempts[roleRecord!.attempts.length - 1]!;
        Object.assign(attempt, {
          status: "succeeded",
          elapsed_ms: Date.now() - startMs,
          envelope_digest: envelope.digest,
          extracted_output_digest: sha256Bytes(extracted),
          invocation_fingerprint: fingerprint,
          ...(acceptedModel === undefined ? {} : { accepted_model: acceptedModel }),
          ...(Object.keys(usage).length === 0 ? {} : { usage }),
          ...(usage_raw === undefined ? {} : { usage_raw }),
          tool_calls: parsed.toolCalls,
          structured_output_calls: parsed.structuredOutputCalls,
          ...reviewFeedback,
          ...(judgments === undefined ? {} : { judgments }),
          ...(preflightFacts === undefined ? {} : {
            cli_version: preflightFacts.cli_version,
            ...(preflightFacts.managed_policy_present === undefined ? {} : { managed_policy_present: preflightFacts.managed_policy_present }),
          }),
        } as Partial<EfficiencyAttempt>);
      });
      execution.log(`role ${planned.group_id}/${role} succeeded (attempt ${String(index)})`);
      return;
    } catch (error) {
      // Stream, classification-output, and schema failures are nontransient: they end the role.
      const code = projectErrorCode(error) ?? "MODEL_OUTPUT_INVALID";
      await finalizeFailedAttempt(journal, planned.group_id, role, index, Date.now() - startMs,
        { code, message: boundedMessage(error), transient: false }, preflightFacts, {}, "failed");
      execution.log(`role ${planned.group_id}/${role} failed: ${code}`);
      return;
    }
  }
}

async function finalizeFailedAttempt(
  journal: EfficiencyJournal,
  groupId: string,
  role: EfficiencyRole,
  index: number,
  elapsedMs: number,
  failure: Readonly<{ code: string; message: string; transient: boolean; parameters?: PlainJsonValue }>,
  preflightFacts: PreflightFacts | undefined,
  measurements: Partial<Pick<EfficiencyAttempt, "usage" | "usage_raw" | "tool_calls" | "structured_output_calls">> = {},
  roleStatus?: "failed",
): Promise<void> {
  await mutateCheckpoint(journal, groupId, role, (_group, roleRecord) => {
    const attempt = roleRecord!.attempts[roleRecord!.attempts.length - 1]!;
    if (attempt.index !== index) throw new TypeError(`attempt bookkeeping desynced on ${groupId}/${role}`);
    Object.assign(attempt, {
      status: "failed",
      elapsed_ms: elapsedMs,
      failure,
      ...(preflightFacts === undefined ? {} : { cli_version: preflightFacts.cli_version }),
      ...measurements,
    } as Partial<EfficiencyAttempt>);
    // Ending the role is part of the same atomic update as finalizing its last attempt: a stop
    // between the two must never leave a running role whose terminal failure recovery resurrects.
    if (roleStatus !== undefined) roleRecord!.status = roleStatus;
  });
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function gitHead(repositoryRoot: string): GitOid {
  return parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim());
}
