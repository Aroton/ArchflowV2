import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  canonicalDocument,
  canonicalJsonDigest,
  parseGitOid,
  sha256Bytes,
} from "../contracts/canonical.js";
import { parseConfigYaml } from "../contracts/config.js";
import type {
  LegacyImportInitializationV1,
  LegacyMappingEntry,
  StagedPayloadRef,
} from "../contracts/durable-legacy-import.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../contracts/evidence.js";
import { computePinnedConfigDigest } from "../contracts/fingerprints.js";
import type { GateContext } from "../contracts/gates.js";
import {
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  type RepositoryPathClaim,
} from "../contracts/path-claims.js";
import {
  parsePhaseInstanceId,
  parsePositiveSafePhaseNumber,
  type PhaseInstanceId,
} from "../contracts/phase-instance.js";
import {
  createGitRunner,
  GitInvocationError,
  preflightGit,
  projectErrorForGitFailure,
  resolveCommit,
  type RepositoryOperationContext,
} from "../repository/git.js";
import { discoverWorktree } from "../repository/identity.js";
import {
  classifyTaskPath,
  resolveLegacySourcePath,
  resolveTaskPath,
} from "../repository/paths.js";
import { createProjectionWriter, type ProjectionWriter } from "../state/atomic.js";
import { createInternalTransactionAuthority } from "../state/authority.js";
import { detectTaskLocalConstitutionEdit } from "../state/constitution.js";
import { ensureTaskProjectionParent } from "../state/layout.js";
import { createSecretlintScanner, secretScanCandidateFromBytes } from "../state/secret-scan.js";
import {
  canonicalTaskPaths,
  commitDigest,
  createTaskConfig,
  policyBaseInvalid,
  resolveInitializationPolicyBase,
} from "./task-initialization.js";

export type StageLegacyUpgradeInput = Readonly<{
  working_directory: string;
  source_root: string;
  task_id: string;
  policy_base_commit: string;
  import_baseline_commit: string;
  code_baseline_commit: string;
  exclude?: readonly string[];
  projection_writer?: ProjectionWriter;
}>;

export type StagedLegacyUpgrade = Readonly<{
  initialization: LegacyImportInitializationV1;
  audit_context: GateContext<"migration-audit">;
  manifest_path: string;
  resume_phase: PhaseInstanceId;
  draft_sources: readonly { destination_path: string; staged_path: string }[];
  staged_paths: readonly string[];
  unmapped: readonly string[];
}>;

type SelectedFile = Readonly<{ legacy_path: RepositoryPathClaim; bytes: Uint8Array }>;

const decoder = new TextDecoder("utf-8", { fatal: true });
const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });
const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function ioError(context: RepositoryOperationContext): ProjectError {
  return createProjectError("IO_ERROR", { operation: context.operation, attempt: context.attempt });
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hasCanonicalDocument(taskRoot: string, taskId: ReturnType<typeof parseTaskSlug>): Promise<boolean> {
  if (!(await exists(taskRoot))) return false;
  const pending = [taskRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(absolute); continue; }
      const rel = relative(taskRoot, absolute).split(sep).join("/");
      try {
        const classified = classifyTaskPath(taskId, parseTaskPathClaim(rel));
        if (classified.ok && classified.value === "document") return true;
      } catch { /* An unrelated destination file is not a canonical document. */ }
    }
  }
  return false;
}

function mappedEntry(
  legacyPath: RepositoryPathClaim,
  taskId: ReturnType<typeof parseTaskSlug>,
): LegacyMappingEntry | undefined {
  const prefix = `.archflow/tasks/${taskId}/`;
  if (legacyPath === "prd.md") {
    return { legacy_path: legacyPath, destination_path: parseRepositoryPathClaim(`${prefix}prd.md`), phase_instance: parsePhaseInstanceId("prd"), disposition: "draft" };
  }
  if (legacyPath === "architecture.md") {
    return { legacy_path: legacyPath, destination_path: parseRepositoryPathClaim(`${prefix}design.md`), phase_instance: parsePhaseInstanceId("design"), disposition: "draft" };
  }
  const phaseLog = /^phases\/phase-([1-9][0-9]*)-.+-log\.md$/u.exec(legacyPath);
  const phaseDesign = /^phases\/phase-([1-9][0-9]*)-.+\.md$/u.exec(legacyPath);
  const phase = phaseLog ?? phaseDesign;
  if (phase !== null) {
    const number = parsePositiveSafePhaseNumber(Number(phase[1]));
    const implementation = phaseLog !== null;
    return {
      legacy_path: legacyPath,
      destination_path: parseRepositoryPathClaim(`${prefix}phases/${number}/${implementation ? "impl-notes" : "design"}.md`),
      phase_instance: parsePhaseInstanceId(`${implementation ? "phase-impl" : "phase-design"}-${number}`),
      disposition: "historical",
    };
  }
  if (legacyPath === "reviews/architecture-counter-review.md") {
    return { legacy_path: legacyPath, destination_path: parseRepositoryPathClaim(`${prefix}reviews/design.counter.md`), phase_instance: parsePhaseInstanceId("design"), disposition: "historical" };
  }
  const review = /^reviews\/phase-([1-9][0-9]*)-(design|impl)-counter-review\.md$/u.exec(legacyPath);
  if (review !== null) {
    const number = parsePositiveSafePhaseNumber(Number(review[1]));
    const kind = review[2] === "impl" ? "phase-impl" : "phase-design";
    return {
      legacy_path: legacyPath,
      destination_path: parseRepositoryPathClaim(`${prefix}reviews/${kind}-${number}.counter.md`),
      phase_instance: parsePhaseInstanceId(`${kind}-${number}`),
      disposition: "historical",
    };
  }
  return undefined;
}

async function enumerateSource(
  sourceRoot: string,
  excluded: ReadonlySet<string>,
  context: RepositoryOperationContext,
): Promise<ProjectResult<Readonly<{ files: readonly SelectedFile[]; skipped: readonly string[] }>>> {
  const files: SelectedFile[] = [];
  const skipped: string[] = [];
  const walk = async (directory: string): Promise<ProjectResult<undefined>> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return fail(ioError(context)); }
    entries.sort((left, right) => ordinal(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(sourceRoot, absolute).split(sep).join("/");
      if (excluded.has(relativePath)) continue;
      if (entry.isDirectory()) {
        const nested = await walk(absolute);
        if (!nested.ok) return nested;
        continue;
      }
      let claim: RepositoryPathClaim;
      try { claim = parseRepositoryPathClaim(relativePath); } catch { return fail(createProjectError("PATH_ESCAPE", { task_id: context.task_id, path_class: "repository-source" })); }
      let metadata;
      try { metadata = await lstat(absolute); } catch { return fail(ioError(context)); }
      if (!metadata.isFile()) { skipped.push(relativePath); continue; }
      const resolved = await resolveLegacySourcePath({ sourceRoot, claim, context });
      if (!resolved.ok) return resolved;
      try { files.push(Object.freeze({ legacy_path: claim, bytes: new Uint8Array(await readFile(resolved.value.absolute)) })); }
      catch { return fail(ioError(context)); }
    }
    return ok(undefined);
  };
  const walked = await walk(sourceRoot);
  return walked.ok ? ok(Object.freeze({ files: Object.freeze(files), skipped: Object.freeze(skipped.sort(ordinal)) })) : walked;
}

export async function stageLegacyUpgrade(input: StageLegacyUpgradeInput): Promise<ProjectResult<StagedLegacyUpgrade>> {
  const taskId = parseTaskSlug(input.task_id);
  const context: RepositoryOperationContext = Object.freeze({
    task_id: taskId,
    phase_instance: parsePhaseInstanceId("prd"),
    operation: parseSafeCode("stage-legacy-upgrade"),
    attempt: parseSafeInteger(1),
  });
  const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), context);
  if (!discovered.ok) return discovered;
  const runner = discovered.value;
  const environment = await preflightGit(runner, context);
  if (!environment.ok) return environment;

  try {
    const sourceRoot = await realpath(input.source_root);
    const sourceRepository = await discoverWorktree(createGitRunner({ cwd: sourceRoot }), context);
    if (!sourceRepository.ok) return sourceRepository;
    if (sourceRepository.value.location.worktreeRoot !== runner.location.worktreeRoot) {
      return fail(createProjectError("REPOSITORY_MISMATCH", {
        expected_digest: canonicalJsonDigest({ schema_version: "1", root: runner.location.worktreeRoot }),
        observed_digest: canonicalJsonDigest({ schema_version: "1", root: sourceRepository.value.location.worktreeRoot }),
      }));
    }
    const destinationRoot = join(runner.location.worktreeRoot, ".archflow", "tasks", taskId);
    if (isInside(sourceRoot, destinationRoot) || isInside(destinationRoot, sourceRoot)) {
      return fail(createProjectError("TASK_INVALID", { task_id: taskId, issue_code: "legacy-source-destination-overlap" }));
    }
    if (await exists(join(destinationRoot, "state.json")) || await hasCanonicalDocument(destinationRoot, taskId)) {
      return fail(createProjectError("TASK_INVALID", { task_id: taskId, issue_code: "legacy-destination-in-use" }));
    }

    const configBytes = await createTaskConfig(runner.location.worktreeRoot, taskId);
    try { parseConfigYaml(decoder.decode(configBytes), "task config"); }
    catch { return fail(createProjectError("CONFIG_INVALID", { issue_code: "task-config-invalid" })); }

    const authorityResult = await createInternalTransactionAuthority({ runner, environment: environment.value, task_id: taskId, context });
    if (!authorityResult.ok) return authorityResult;
    const authority = authorityResult.value;
    const policyCommit = parseGitOid(input.policy_base_commit);
    const importCommit = parseGitOid(input.import_baseline_commit);
    const codeCommit = parseGitOid(input.code_baseline_commit);
    for (const commit of [policyCommit, importCommit, codeCommit]) {
      if (await resolveCommit(runner, commit) !== commit) return fail(policyBaseInvalid(commit));
    }
    const policy = await resolveInitializationPolicyBase(runner, policyCommit, context);
    if (!policy.ok) return policy;
    const edit = await detectTaskLocalConstitutionEdit(runner, policyCommit, policy.value.constitution_digest, context);
    if (!edit.ok) return edit;
    if (edit.value !== undefined) {
      return fail(createProjectError("POLICY_BASE_INVALID", {
        expected_digest: commitDigest(policyCommit, "policy-base-commit"),
        observed_digest: edit.value.current_constitution_digest,
      }));
    }

    const excluded = new Set((input.exclude ?? []).map((item) => parseRepositoryPathClaim(item) as string));
    const selected = await enumerateSource(sourceRoot, excluded, context);
    if (!selected.ok) return selected;
    const scanner = createSecretlintScanner();
    const scan = await scanner.scan(selected.value.files.map((file) => secretScanCandidateFromBytes({
      virtual_path: file.legacy_path,
      path_class: "repository-source",
      bytes: file.bytes,
    })));
    if (scan.outcome !== "clean") {
      const finding = scan.outcome === "detected" ? scan.findings[0] : undefined;
      return fail(createProjectError("SECRET_DETECTED", {
        path_class: finding?.path_class ?? "repository-source",
        detector_id: finding?.detector_id ?? "scanner-unavailable",
      }));
    }

    const stagedRefs: StagedPayloadRef[] = selected.value.files.map((file) => Object.freeze({
      legacy_path: file.legacy_path,
      digest: sha256Bytes(file.bytes),
      byte_count: parseSafeInteger(file.bytes.byteLength),
    })).sort((left, right) => ordinal(left.legacy_path, right.legacy_path));
    const mapping = selected.value.files.map((file) => mappedEntry(file.legacy_path, taskId)).filter((entry): entry is LegacyMappingEntry => entry !== undefined)
      .sort((left, right) => ordinal(left.destination_path, right.destination_path));
    if (mapping.some((entry, index) => index > 0 && mapping[index - 1]!.destination_path === entry.destination_path)) {
      return fail(createProjectError("PATH_INVALID", { task_id: taskId, path_class: "document" }));
    }
    const importDigest = canonicalJsonDigest({ schema_version: "1", staged_payload_refs: stagedRefs, mapping });
    const taskPrefix = `.archflow/tasks/${taskId}`;
    const sourceRelative = relative(runner.location.worktreeRoot, sourceRoot).split(sep).join("/");
    const sourceIdentityDigest = canonicalJsonDigest({
      schema_version: "1",
      repository_identity_digest: authority.repository_identity_digest,
      source_root: parseRepositoryPathClaim(sourceRelative),
    });
    const initialization: LegacyImportInitializationV1 = Object.freeze({
      schema_version: "1",
      artifact_kind: "legacy-import-initialization",
      task_id: taskId,
      repository_identity_digest: authority.repository_identity_digest,
      source_identity_digest: sourceIdentityDigest,
      import_digest: importDigest,
      import_baseline_commit: importCommit,
      code_baseline_commit: codeCommit,
      policy_base_commit: policyCommit,
      constitution_digest: policy.value.constitution_digest,
      workflow_digest: policy.value.workflow_digest,
      config_digest: computePinnedConfigDigest(configBytes),
      canonical_paths: canonicalTaskPaths(taskId),
      mapping: Object.freeze(mapping),
      staged_payload_refs: Object.freeze(stagedRefs),
    });
    const writer = input.projection_writer ?? createProjectionWriter();
    const stagedPaths: string[] = [];
    const stagedByLegacy = new Map<string, string>();
    for (const file of selected.value.files) {
      const claim = parseTaskPathClaim(`imports/${importDigest}/payload/${file.legacy_path}`);
      const target = await resolveTaskPath({ runner, taskId, claim, expectedClass: "import", context });
      if (!target.ok) return target;
      await ensureTaskProjectionParent(authority, target.value.absolute);
      await writer.replaceRegular(target.value, file.bytes, false);
      const stagedPath = `${taskPrefix}/${claim}`;
      stagedPaths.push(stagedPath);
      stagedByLegacy.set(file.legacy_path, stagedPath);
    }
    const manifestClaim = parseTaskPathClaim(`imports/${importDigest}/manifest.json`);
    const manifestTarget = await resolveTaskPath({ runner, taskId, claim: manifestClaim, expectedClass: "import", context });
    if (!manifestTarget.ok) return manifestTarget;
    await ensureTaskProjectionParent(authority, manifestTarget.value.absolute);
    await writer.replaceRegular(manifestTarget.value, canonicalDocument(initialization).bytes, false);
    const manifestPath = `${taskPrefix}/${manifestClaim}`;
    stagedPaths.push(manifestPath);
    stagedPaths.sort(ordinal);
    const unmapped = [
      ...selected.value.files.filter((file) => mappedEntry(file.legacy_path, taskId) === undefined).map((file) => file.legacy_path),
      ...selected.value.skipped,
    ].sort(ordinal);
    const draftSources = mapping.filter((entry) => entry.disposition === "draft").map((entry) => Object.freeze({
      destination_path: entry.destination_path as string,
      staged_path: stagedByLegacy.get(entry.legacy_path)!,
    }));
    let highestImplemented = 0;
    for (const entry of mapping) {
      const match = /^phase-impl-([1-9][0-9]*)$/u.exec(entry.phase_instance);
      if (match !== null) highestImplemented = Math.max(highestImplemented, Number(match[1]));
    }
    const resumePhase = parsePhaseInstanceId(`phase-design-${highestImplemented + 1}`);
    return ok(Object.freeze({
      initialization,
      audit_context: Object.freeze({
        source_identity_digest: sourceIdentityDigest,
        destination_identity_digest: authority.task_identity_digest,
        import_digest: importDigest,
        code_baseline_digest: commitDigest(codeCommit, "code-baseline-commit"),
        policy_baseline_digest: commitDigest(policyCommit, "policy-base-commit"),
      }),
      manifest_path: manifestPath,
      resume_phase: resumePhase,
      draft_sources: Object.freeze(draftSources),
      staged_paths: Object.freeze(stagedPaths),
      unmapped: Object.freeze(unmapped),
    }));
  } catch (error) {
    if (error instanceof GitInvocationError) return fail(projectErrorForGitFailure(error, runner, context));
    return fail(ioError(context));
  }
}
