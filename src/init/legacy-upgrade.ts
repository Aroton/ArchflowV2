import { lstat, readdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
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
  parseWorkspacePathClaim,
  resolveLegacySourcePath,
  resolveTaskWorkspacePath,
} from "../repository/paths.js";
import { createProjectionWriter, type ProjectionWriter } from "../state/atomic.js";
import { createInternalTransactionAuthority } from "../state/authority.js";
import { detectTaskLocalConstitutionEdit } from "../state/constitution.js";
import { ensureWorkspaceProjectionParent } from "../state/layout.js";
import { createSecretlintScanner, secretScanCandidateFromBytes } from "../state/secret-scan.js";
import {
  canonicalTaskPaths,
  commitDigest,
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
  /** Preview performs every validation and computes the immutable plan without writing. */
  operation?: "preview" | "stage";
  /** Stage is accepted only for the exact preview the human reviewed. */
  approved_preview_digest?: string;
  projection_writer?: ProjectionWriter;
}>;

export type StagedLegacyUpgrade = Readonly<{
  initialization: LegacyImportInitializationV1;
  audit_context: GateContext<"migration-audit">;
  manifest_path: string;
  resume_phase: PhaseInstanceId;
  preview_digest: ReturnType<typeof canonicalJsonDigest>;
  operation: "preview" | "stage";
  draft_sources: readonly { destination_path: string; staged_path: string }[];
  staged_paths: readonly string[];
  unmapped: readonly string[];
}>;

export type DiscardLegacyUpgradeInput = Readonly<{
  working_directory: string;
  task_id: string;
  import_digest: string;
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
  // Rendered legacy reviews are evidence cache, not durable documents. Their exact source bytes
  // remain in ignored import staging and are reported as unmapped for the migration audit.
  return undefined;
}

function deriveResumePhase(mapping: readonly LegacyMappingEntry[]): ProjectResult<PhaseInstanceId> {
  const designs = new Set<number>();
  const implementations = new Set<number>();
  for (const entry of mapping) {
    const decoded = /^(phase-design|phase-impl)-([1-9][0-9]*)$/u.exec(entry.phase_instance);
    if (decoded === null) continue;
    (decoded[1] === "phase-design" ? designs : implementations).add(Number(decoded[2]));
  }
  let highestImplemented = 0;
  while (implementations.has(highestImplemented + 1)) {
    const next = highestImplemented + 1;
    if (!designs.has(next)) {
      return fail(createProjectError("TASK_INVALID", { task_id: mapping[0]?.destination_path.split("/")[2] ?? "legacy", issue_code: "legacy-implementation-without-design" }));
    }
    highestImplemented = next;
  }
  if ([...implementations].some((phase) => phase > highestImplemented)) {
    return fail(createProjectError("TASK_INVALID", { task_id: mapping[0]?.destination_path.split("/")[2] ?? "legacy", issue_code: "legacy-phase-history-gap" }));
  }
  const inFlight = highestImplemented + 1;
  return ok(parsePhaseInstanceId(designs.has(inFlight) ? `phase-impl-${inFlight}` : `phase-design-${inFlight}`));
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
    if (await exists(destinationRoot)) {
      return fail(createProjectError("TASK_INVALID", { task_id: taskId, issue_code: "legacy-destination-in-use" }));
    }

    let configBytes: Uint8Array;
    try {
      configBytes = new Uint8Array(await readFile(join(runner.location.worktreeRoot, ".archflow", "config.yaml")));
    } catch {
      return fail(createProjectError("CONFIG_INVALID", { issue_code: "archflow-initialization-required" }));
    }
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
    if (!mapping.some((entry) => entry.phase_instance === "prd") || !mapping.some((entry) => entry.phase_instance === "design")) {
      return fail(createProjectError("TASK_INVALID", { task_id: taskId, issue_code: "legacy-prd-and-architecture-required" }));
    }
    const resume = deriveResumePhase(mapping);
    if (!resume.ok) return resume;
    const resumeNumber = Number(/([1-9][0-9]*)$/u.exec(resume.value)?.[1] ?? 1);
    let plannedFinalPhase = Math.max(resumeNumber, ...mapping.map((entry) => Number(/([1-9][0-9]*)$/u.exec(entry.phase_instance)?.[1] ?? 0)));
    const architecture = selected.value.files.find((file) => file.legacy_path === "architecture.md");
    if (architecture !== undefined) {
      for (const match of decoder.decode(architecture.bytes).matchAll(/\bphase\s+([1-9][0-9]*)\b/giu)) {
        plannedFinalPhase = Math.max(plannedFinalPhase, Number(match[1]));
      }
    }
    const importDigest = canonicalJsonDigest({ schema_version: "1", staged_payload_refs: stagedRefs, mapping });
    const sourceRelative = relative(runner.location.worktreeRoot, sourceRoot).split(sep).join("/");
    const sourceIdentityDigest = canonicalJsonDigest({
      schema_version: "1",
      repository_identity_digest: authority.repository_identity_digest,
      source_root: parseRepositoryPathClaim(sourceRelative),
    });
    const symbolicRef = await runner.runText({
      argv: ["symbolic-ref", "--quiet", "HEAD"],
      operation: parseSafeCode("legacy-upgrade-target-ref"),
      expectedAbsence: [{ code: 1, stderrIncludes: "" }],
    });
    const targetRef = symbolicRef === "" ? "HEAD" : symbolicRef;
    const commitMessage = `archflow(${taskId}): adopt legacy import`;
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
      resume_phase: resume.value,
      planned_final_phase: parseSafeInteger(plannedFinalPhase),
      target_ref: targetRef,
      commit_message: commitMessage,
    });
    const previewDigest = canonicalJsonDigest({
      schema_version: "1",
      initialization,
      resume_phase: resume.value,
      excluded: [...excluded].sort(ordinal),
    });
    const operation = input.operation ?? "stage";
    if (operation === "stage" && input.approved_preview_digest !== undefined && input.approved_preview_digest !== previewDigest) {
      return fail(createProjectError("CONTRACT_INVALID", { issue_code: "legacy-preview-digest-mismatch" }));
    }
    if (operation === "stage" && input.operation !== undefined && input.approved_preview_digest === undefined) {
      return fail(createProjectError("CONTRACT_INVALID", { issue_code: "legacy-preview-approval-required" }));
    }
    const writer = input.projection_writer ?? createProjectionWriter();
    const stagedPaths: string[] = [];
    const stagedByLegacy = new Map<string, string>();
    for (const file of selected.value.files) {
      const claim = parseWorkspacePathClaim(`cache/imports/${importDigest}/payload/${file.legacy_path}`);
      const target = await resolveTaskWorkspacePath({ runner, taskId, claim, expectedClass: "workspace-import", context });
      if (!target.ok) return target;
      if (operation === "stage") {
        await ensureWorkspaceProjectionParent(authority, target.value.absolute);
        await writer.replaceRegular(target.value, file.bytes, false);
      }
      const stagedPath = target.value.repositoryRelative as string;
      stagedPaths.push(stagedPath);
      stagedByLegacy.set(file.legacy_path, stagedPath);
    }
    const manifestClaim = parseWorkspacePathClaim(`cache/imports/${importDigest}/manifest.json`);
    const manifestTarget = await resolveTaskWorkspacePath({ runner, taskId, claim: manifestClaim, expectedClass: "workspace-import", context });
    if (!manifestTarget.ok) return manifestTarget;
    if (operation === "stage") {
      await ensureWorkspaceProjectionParent(authority, manifestTarget.value.absolute);
      await writer.replaceRegular(manifestTarget.value, canonicalDocument(initialization).bytes, false);
    }
    const manifestPath = manifestTarget.value.repositoryRelative as string;
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
    if (operation === "stage") {
      const configClaim = parseWorkspacePathClaim(`cache/imports/${importDigest}/config.yaml`);
      const configTarget = await resolveTaskWorkspacePath({ runner, taskId, claim: configClaim, expectedClass: "workspace-import", context });
      if (!configTarget.ok) return configTarget;
      await ensureWorkspaceProjectionParent(authority, configTarget.value.absolute);
      await writer.replaceRegular(configTarget.value, configBytes, false);
      stagedPaths.push(configTarget.value.repositoryRelative as string);

      const stageClaim = parseWorkspacePathClaim(`cache/imports/${importDigest}/stage.json`);
      const stageTarget = await resolveTaskWorkspacePath({ runner, taskId, claim: stageClaim, expectedClass: "workspace-import", context });
      if (!stageTarget.ok) return stageTarget;
      await ensureWorkspaceProjectionParent(authority, stageTarget.value.absolute);
      await writer.replaceRegular(stageTarget.value, canonicalDocument({
        schema_version: "1",
        task_id: taskId,
        import_digest: importDigest,
        preview_digest: previewDigest,
        manifest_path: manifestPath,
        resume_phase: resume.value,
      }).bytes, false);
      stagedPaths.push(stageTarget.value.repositoryRelative as string);
    }
    stagedPaths.sort(ordinal);
    return ok(Object.freeze({
      initialization,
      audit_context: Object.freeze({
        source_identity_digest: sourceIdentityDigest,
        destination_identity_digest: authority.task_identity_digest,
        import_digest: importDigest,
        code_baseline_digest: commitDigest(codeCommit, "code-baseline-commit"),
        policy_baseline_digest: commitDigest(policyCommit, "policy-base-commit"),
        resume_phase: resume.value,
        planned_final_phase: parseSafeInteger(plannedFinalPhase),
        imported_documents: Object.freeze(mapping.map((entry) => Object.freeze({
          path: entry.destination_path,
          content_digest: stagedRefs.find((reference) => reference.legacy_path === entry.legacy_path)!.digest,
        })).sort((left, right) => ordinal(left.path, right.path))),
        target_ref: targetRef,
        baseline_commit: codeCommit,
        commit_message: commitMessage,
      }),
      manifest_path: manifestPath,
      resume_phase: resume.value,
      preview_digest: previewDigest,
      operation,
      draft_sources: Object.freeze(draftSources),
      staged_paths: Object.freeze(stagedPaths),
      unmapped: Object.freeze(unmapped),
    }));
  } catch (error) {
    if (error instanceof GitInvocationError) return fail(projectErrorForGitFailure(error, runner, context));
    return fail(ioError(context));
  }
}

/** Removes only an explicitly named, unadopted import stage and the known pre-fix config side effect. */
export async function discardLegacyUpgrade(input: DiscardLegacyUpgradeInput): Promise<ProjectResult<Readonly<{ discarded: true }>>> {
  const taskId = parseTaskSlug(input.task_id);
  const context: RepositoryOperationContext = Object.freeze({
    task_id: taskId,
    phase_instance: parsePhaseInstanceId("prd"),
    operation: parseSafeCode("discard-legacy-stage"),
    attempt: parseSafeInteger(1),
  });
  const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), context);
  if (!discovered.ok) return discovered;
  const root = discovered.value.location.worktreeRoot;
  const digest = String(input.import_digest);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    return fail(createProjectError("CONTRACT_INVALID", { issue_code: "legacy-import-digest-invalid" }));
  }
  const destination = join(root, ".archflow", "tasks", taskId);
  if (await exists(join(destination, "state.json"))) {
    return fail(createProjectError("TASK_INVALID", { task_id: taskId, issue_code: "legacy-stage-already-adopted" }));
  }
  if (await exists(destination)) {
    const entries = await readdir(destination);
    if (entries.some((entry) => entry !== "config.yaml")) {
      return fail(createProjectError("TASK_INVALID", { task_id: taskId, issue_code: "legacy-destination-not-disposable" }));
    }
    if (entries.includes("config.yaml")) {
      const [actual, template] = await Promise.all([
        readFile(join(destination, "config.yaml")),
        readFile(join(root, ".archflow", "config.yaml")),
      ]);
      if (!actual.equals(template)) {
        return fail(createProjectError("TASK_INVALID", { task_id: taskId, issue_code: "legacy-destination-config-modified" }));
      }
      await rm(join(destination, "config.yaml"));
      await rmdir(destination).catch(() => undefined);
    }
  }
  await rm(join(root, ".archflow", "runtime", "tasks", taskId, "cache", "imports", digest), { recursive: true, force: true });
  return ok(Object.freeze({ discarded: true as const }));
}
