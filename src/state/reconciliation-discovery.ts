import { constants as fsConstants } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import {
  parseCanonicalDocument,
  sha256Bytes,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import { parsePersistedGateRequest } from "../contracts/durable-gate.js";
import { parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type { AuthoritativeResultRef, TaskStateV1 } from "../contracts/durable-state.js";
import {
  createPreparedIntentSubject,
  validateDurableSemantics,
} from "../contracts/durable.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId, parseSafeCode } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import {
  gateRequestClaim,
  intentReceiptClaim,
  openResolved,
  resolveTaskWorkspacePath,
  resolveDeclaredOutputPath,
  resolveTaskPath,
  type ResolvedPath,
  type ResolvedWorkspacePath,
} from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { repositoryPathKey } from "./snapshots.js";
import type { ProjectionIdentity, ReconciliationInput } from "./reconciliation.js";
import type { GateLifecycleDependencies } from "./gates.js";
import type { RepositoryMember, RepositorySet } from "../repository/repository-set.js";
import type { RootBoundGitRunner } from "../repository/identity.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const stateInvalid = (authority: TransactionAuthority, issueCode: string): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", {
      phase_instance: authority.context.phase_instance,
      issue_code: issueCode,
    }),
  });
const ioFailure = (authority: TransactionAuthority, operation: string): ProjectResult<never> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }),
  });

async function readCanonical<T extends PlainJsonValue>(
  path: ResolvedPath | ResolvedWorkspacePath,
  label: string,
  parse: (value: unknown) => T,
): Promise<"missing" | "invalid" | CanonicalDocument<T>> {
  let handle;
  try {
    handle = await openResolved(path.absolute, fsConstants.O_RDONLY);
    const document = parseCanonicalDocument<T>(new Uint8Array(await handle.readFile()), label);
    parse(document.value);
    return document;
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? "missing" : "invalid";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function currentProjectionDigest(path: ResolvedPath): Promise<"missing" | ProjectionDigestRef["content_digest"]> {
  try {
    const metadata = await lstat(path.absolute);
    if (metadata.isSymbolicLink()) return sha256Bytes(Buffer.from(await readlink(path.absolute), "utf8"));
    if (!metadata.isFile()) throw new TypeError("projection is not a regular file or symlink");
    const handle = await openResolved(path.absolute, fsConstants.O_RDONLY);
    try {
      return sha256Bytes(new Uint8Array(await handle.readFile()));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return "missing";
    throw error;
  }
}

function outputClassFor(
  manifest: ResultManifestV1,
  path: ProjectionDigestRef["path"],
) {
  for (const output of manifest.outputs) {
    if (output.path === path || (output.operation === "rename" && output.previous_path === path)) {
      return output.path_class;
    }
  }
  return undefined;
}

/**
 * One retained manifest's newest word on a projected path. A presence projection says the path was
 * materialized at a digest; a declared delete or rename source says the path is retired. Revisions
 * order the observations, and only a path whose newest observation is a presence contributes a
 * recorded projection — otherwise an earlier phase's stale present-projection would outlive a later
 * phase's declared deletion and wedge reconciliation demanding "restored" bytes.
 *
 * The non-retired arm also carries the retained result that owns the projection. `reference` is
 * `undefined` when the newest record is a human baseline adoption — those bytes exist only in the
 * worktree and git, never in a manifest — which is exactly what a restore needs to know before
 * promising to rewrite them.
 */
type ProjectionLookup = Readonly<Pick<ProjectionDigestRef, "repository" | "path">>;

export type NewestProjection = Readonly<
  | {
    retired: false;
    repository?: ProjectionDigestRef["repository"];
    path: ProjectionDigestRef["path"];
    projection: ProjectionDigestRef;
    measured_at_revision: number;
    target: ResolvedPath;
    reference: AuthoritativeResultRef | undefined;
    runner: RootBoundGitRunner;
  }
  | {
    retired: true;
    repository?: ProjectionDigestRef["repository"];
    path: ProjectionDigestRef["path"];
    measured_at_revision: number;
    reference: undefined;
  }
>;

/**
 * Newest projection per repository-qualified path, keyed by `repositoryPathKey`. A bare path
 * intentionally addresses only the primary repository.
 */
export type NewestProjectionIndex = Map<string, NewestProjection>;

/** Index entries in canonical order: primary first, then repositories by name, then paths. */
export function orderedNewestProjections(index: NewestProjectionIndex): readonly NewestProjection[] {
  return [...index.values()].sort((left, right) => {
    const leftRepository = left.repository ?? "primary";
    const rightRepository = right.repository ?? "primary";
    if (leftRepository !== rightRepository) {
      return leftRepository === "primary" ? -1 : rightRepository === "primary" ? 1 : leftRepository.localeCompare(rightRepository);
    }
    return left.path.localeCompare(right.path);
  });
}

export async function discoverNewestProjections(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
  repositorySet?: Pick<RepositorySet, "members">,
): Promise<ProjectResult<NewestProjectionIndex>> {
  const loadManifest = dependencies.load_retained_manifest;
  if (loadManifest === undefined) {
    return stateInvalid(authority, "reconciliation-result-loader-unavailable");
  }
  const newest: NewestProjectionIndex = new Map();
  const members = new Map<string, RepositoryMember>(
    (repositorySet?.members ?? []).map((member) => [member.name, member]),
  );
  const primaryMember = members.get("primary");
  const primaryRunner = primaryMember?.binding.runner ?? dependencies.runner;
  try {
    for (const reference of state.value.authoritative_results) {
      const loaded = await loadManifest(reference);
      if (!loaded.ok) return loaded;
      const manifest = loaded.value.manifest.value;
      for (const output of manifest.outputs) {
        if (output.operation !== "delete" && output.operation !== "rename") continue;
        const retiredPath = output.operation === "delete" ? output.path : output.previous_path;
        const prior = newest.get(repositoryPathKey(undefined, retiredPath));
        if (prior === undefined || manifest.accounting.measured_at_revision > prior.measured_at_revision) {
          const retirement: NewestProjection = Object.freeze({
            retired: true,
            path: retiredPath,
            measured_at_revision: manifest.accounting.measured_at_revision,
            reference: undefined,
          });
          newest.set(repositoryPathKey(undefined, retiredPath), retirement);
        }
      }
      for (const projection of manifest.projections) {
        const pathClass = outputClassFor(manifest, projection.path);
        if (pathClass === undefined) return stateInvalid(authority, "reconciliation-projection-unbound");
        const target = await resolveDeclaredOutputPath({
          runner: primaryRunner,
          taskId: authority.task_id,
          claim: projection.path,
          pathClass,
          context: authority.context,
        });
        if (!target.ok) return target;
        const measuredAtRevision = manifest.accounting.measured_at_revision;
        const prior = newest.get(repositoryPathKey(undefined, projection.path));
        if (prior === undefined || measuredAtRevision > prior.measured_at_revision) {
          const candidate: NewestProjection = Object.freeze({
            retired: false,
            path: projection.path,
            projection,
            measured_at_revision: measuredAtRevision,
            target: target.value,
            reference,
            runner: primaryRunner,
          });
          newest.set(repositoryPathKey(undefined, projection.path), candidate);
        }
      }
      const implementation = manifest.source_artifact?.artifact_kind === "implementation-output"
        ? manifest.source_artifact
        : undefined;
      for (const section of manifest.secondary_projections ?? []) {
        const member = members.get(section.repository);
        if (member === undefined || member.mode !== "writable" ||
            member.identity.digest !== section.repository_identity_digest) {
          return stateInvalid(authority, "reconciliation-secondary-repository-unavailable");
        }
        const outputSection = implementation?.secondary_repositories?.find(
          (candidate) => candidate.repository === section.repository,
        );
        if (outputSection === undefined) return stateInvalid(authority, "reconciliation-projection-unbound");
        for (const output of outputSection.outputs) {
          if (output.operation !== "delete" && output.operation !== "rename") continue;
          const path = output.operation === "delete" ? output.path : output.previous_path;
          const identity = { repository: section.repository, path } as const;
          const prior = newest.get(repositoryPathKey(identity.repository, identity.path));
          if (prior === undefined || manifest.accounting.measured_at_revision > prior.measured_at_revision) {
            newest.set(repositoryPathKey(identity.repository, identity.path), Object.freeze({
              retired: true, repository: section.repository, path,
              measured_at_revision: manifest.accounting.measured_at_revision,
              reference: undefined,
            }));
          }
        }
        for (const projection of section.projections) {
          const output = outputSection.outputs.find((candidate) =>
            candidate.path === projection.path ||
            (candidate.operation === "rename" && candidate.previous_path === projection.path));
          if (output === undefined) return stateInvalid(authority, "reconciliation-projection-unbound");
          const target = await resolveDeclaredOutputPath({
            runner: member.binding.runner,
            taskId: authority.task_id,
            claim: projection.path,
            pathClass: output.path_class,
            context: authority.context,
          });
          if (!target.ok) return target;
          const prior = newest.get(repositoryPathKey(projection.repository, projection.path));
          if (prior === undefined || manifest.accounting.measured_at_revision > prior.measured_at_revision) {
            newest.set(repositoryPathKey(projection.repository, projection.path), Object.freeze({
              retired: false, repository: section.repository, path: projection.path,
              projection, measured_at_revision: manifest.accounting.measured_at_revision,
              target: target.value, reference, runner: member.binding.runner,
            }));
          }
        }
      }
    }
    // Human-adopted baselines overlay the manifests newest-per-path: an adoption lands at a state
    // revision strictly later than every manifest measured before it, and a later phase's produce
    // manifest measures later still and supersedes the adoption for the paths it re-projects.
    for (const adoption of state.value.baseline_adoptions ?? []) {
      for (const projection of adoption.adopted_projections) {
        const prior = newest.get(repositoryPathKey(projection.repository, projection.path));
        if (prior === undefined) return stateInvalid(authority, "reconciliation-projection-unbound");
        // An adopted path is never retirement-newest from a bytes adoption: adoption gates open
        // only over recorded projections, and a retirement that measured later supersedes the
        // adoption instead. A deletion adoption below may still retire it.
        if (prior.retired) continue;
        if (adoption.adopted_at_revision > prior.measured_at_revision) {
          const adopted: NewestProjection = Object.freeze({
            retired: false,
            ...(projection.repository === undefined ? {} : { repository: projection.repository }),
            path: projection.path,
            projection,
            measured_at_revision: adoption.adopted_at_revision,
            target: prior.target,
            reference: undefined,
            runner: prior.runner,
          });
          newest.set(repositoryPathKey(projection.repository, projection.path), adopted);
        }
      }
      // A deletion adoption records absence, not bytes: the human accepted that an authorized
      // commit already removed these paths, so the record retires the stale presence exactly like
      // a declared deletion output would. Newest-per-path applies for the same reason.
      for (const adoptedAbsence of adoption.adopted_absences ?? []) {
        const identity: ProjectionLookup = typeof adoptedAbsence === "string"
          ? { path: adoptedAbsence }
          : adoptedAbsence;
        const prior = newest.get(repositoryPathKey(identity.repository, identity.path));
        if (prior === undefined) return stateInvalid(authority, "reconciliation-projection-unbound");
        if (prior.retired) continue;
        if (adoption.adopted_at_revision > prior.measured_at_revision) {
          const repository = identity.repository;
          newest.set(repositoryPathKey(identity.repository, identity.path), Object.freeze({
            retired: true,
            ...(repository === undefined ? {} : { repository }),
            path: identity.path,
            measured_at_revision: adoption.adopted_at_revision,
            reference: undefined,
          }));
        }
      }
    }
    return ok(newest);
  } catch {
    return ioFailure(authority, "discover-reconciliation-projections");
  }
}

async function discoverProjections(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
  repositorySet?: Pick<RepositorySet, "members">,
): Promise<ProjectResult<Readonly<{
  recorded: readonly ProjectionDigestRef[];
  current: readonly ProjectionDigestRef[];
  unrestorable: readonly (ProjectionIdentity | ProjectionDigestRef["path"])[];
  committed_absent: readonly (ProjectionIdentity | ProjectionDigestRef["path"])[];
}>>> {
  const newest = await discoverNewestProjections(dependencies, authority, state, repositorySet);
  if (!newest.ok) return newest;
  try {
    const recorded: ProjectionDigestRef[] = [];
    const current: ProjectionDigestRef[] = [];
    const unrestorable: (ProjectionIdentity | ProjectionDigestRef["path"])[] = [];
    const committedAbsent: (ProjectionIdentity | ProjectionDigestRef["path"])[] = [];
    for (const observation of orderedNewestProjections(newest.value)) {
      if (observation.retired) continue;
      recorded.push(observation.projection);
      // An adoption-sourced projection (no retained manifest reference) recorded only a digest;
      // there are no retained bytes to restore if the worktree copy goes missing.
      const identity = observation.repository === undefined
        ? observation.projection.path
        : Object.freeze({ repository: observation.repository, path: observation.projection.path });
      if (observation.reference === undefined) unrestorable.push(identity);
      const digest = await currentProjectionDigest(observation.target);
      if (digest !== "missing") {
        current.push(Object.freeze({
          ...(observation.repository === undefined ? {} : { repository: observation.repository }),
          path: observation.projection.path,
          content_digest: digest,
        }));
      } else if (observation.reference === undefined && !(await committedAtHead(observation.runner, authority, observation.projection.path))) {
        // Unrestorable and gone from HEAD too: the deletion is already committed (typically by an
        // authorized milestone commit), so no produce can re-declare it either — the base commit
        // holds no before-image. Routing offers the human a deletion adoption for exactly this.
        committedAbsent.push(identity);
      }
    }
    return ok(Object.freeze({
      recorded: Object.freeze(recorded),
      current: Object.freeze(current),
      unrestorable: Object.freeze(unrestorable),
      committed_absent: Object.freeze(committedAbsent),
    }));
  } catch {
    return ioFailure(authority, "discover-reconciliation-projections");
  }
}

/**
 * Whether git HEAD still contains the path. `cat-file -e` succeeds when it does and fails with
 * code 128 and a "does not exist" fatal when it does not; the `run` result's `absent` flag
 * carries that distinction, where `runText` would collapse an empty success and the error into
 * the same empty string.
 */
async function committedAtHead(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  path: ProjectionDigestRef["path"],
): Promise<boolean> {
  const result = await runner.run({
    argv: ["cat-file", "-e", `HEAD:${path}`],
    operation: parseSafeCode("git-committed-absence-probe"),
    expectedAbsence: [{ code: 128, stderrIncludes: "does not exist in" }],
  });
  return !result.absent;
}

async function discoverGateHead(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
): Promise<ProjectResult<Readonly<{
  head?: NonNullable<ReconciliationInput["active_heads"]["gate"]>;
  blocker?: string;
}>>> {
  const open = state.value.open_gate;
  if (open === undefined) return ok(Object.freeze({}));
  const requestPath = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: gateRequestClaim(open.gate_id),
    expectedClass: "authority-decision",
    context: authority.context,
  });
  if (!requestPath.ok) return requestPath;
  const request = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
  if (request === "missing") return ok(Object.freeze({ blocker: "active-gate-request-missing" }));
  if (request === "invalid") return ok(Object.freeze({ blocker: "active-gate-request-invalid" }));
  try {
    if (request.value.gate_id !== open.gate_id ||
        request.value.subject_digest !== open.subject_digest ||
        request.value.context_digest !== open.context_digest) {
      return ok(Object.freeze({ blocker: "active-gate-request-mismatch" }));
    }
    return ok(Object.freeze({ head: Object.freeze({
      gate_id: request.value.gate_id,
      subject_digest: request.value.subject_digest,
      context_digest: request.value.context_digest,
    }) }));
  } catch {
    return ok(Object.freeze({ blocker: "active-gate-request-mismatch" }));
  }
}

async function discoverIntent(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
): Promise<ProjectResult<Readonly<{
  intent?: ReconciliationInput["intent"];
  blocker?: string;
}>>> {
  let names: string[];
  try {
    names = await readdir(join(authority.workspace_root, "transient", "intents"));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return ok(Object.freeze({}));
    return ioFailure(authority, "discover-reconciliation-intents");
  }
  const candidates: CanonicalDocument<IntentReceiptV1>[] = [];
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(name)) continue;
    // `.request.json` names are staged requests, a different path class in the same directory;
    // resolving one as an intent receipt would fail classification and abort discovery.
    if (name.endsWith(".request.json")) continue;
    const target = await resolveTaskWorkspacePath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: intentReceiptClaim(parsePathSafeId(name.slice(0, -5))),
      expectedClass: "workspace-intent",
      context: authority.context,
    });
    if (!target.ok) return target;
    const receipt = await readCanonical(target.value, "intent receipt", parseIntentReceipt);
    if (receipt === "missing" || receipt === "invalid") continue;
    if (receipt.value.prior_revision !== state.value.revision ||
        receipt.value.resulting_revision !== state.value.revision + 1 ||
        receipt.value.prepared_state.revision !== receipt.value.resulting_revision) continue;
    if (!validateDurableSemantics(createPreparedIntentSubject(state, receipt)).ok) continue;
    candidates.push(receipt);
  }
  if (candidates.length > 1) {
    return ok(Object.freeze({ blocker: "retained-receipt-ambiguity" }));
  }
  const receipt = candidates[0];
  return receipt === undefined
    ? ok(Object.freeze({}))
    : ok(Object.freeze({ intent: Object.freeze({ request_digest: receipt.value.request_digest, receipt }) }));
}

/** Discovers only the live authority needed by reconciliation; it never promotes or repairs it. */
export async function discoverReconciliationInput(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
  repositorySet?: Pick<RepositorySet, "members">,
): Promise<ProjectResult<ReconciliationInput>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const projections = await discoverProjections(dependencies, authority, state, repositorySet);
  if (!projections.ok) return projections;
  const gate = await discoverGateHead(dependencies, authority, state);
  if (!gate.ok) return gate;
  const intent = await discoverIntent(dependencies, authority, state);
  if (!intent.ok) return intent;
  const blockers = [gate.value.blocker, intent.value.blocker]
    .filter((value): value is string => value !== undefined);
  return ok(Object.freeze({
    state,
    recorded_projections: projections.value.recorded,
    current_projections: projections.value.current,
    ...(projections.value.unrestorable.length === 0 ? {} : { unrestorable_paths: projections.value.unrestorable }),
    ...(projections.value.committed_absent.length === 0 ? {} : { committed_absent_paths: projections.value.committed_absent }),
    active_heads: Object.freeze({
      ...(gate.value.head === undefined ? {} : { gate: gate.value.head }),
    }),
    ...(intent.value.intent === undefined ? {} : { intent: intent.value.intent }),
    ...(blockers.length === 0 ? {} : { blocking_reasons: Object.freeze(blockers) }),
  }));
}
