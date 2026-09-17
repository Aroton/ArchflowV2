import { loadReviewDocumentConfiguration } from "./documents.js";
import { createReviewResponseSchema, reviewResponseExample } from "./response-schema.js";
import bundledConfiguration from "../../assets/review-inputs.yaml";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import { parseSingleYamlDocument } from "../contracts/yaml.js";
import type { DispatchEnvelope, ReviewDiffContext, PinnedContextEntry } from "./envelopes.js";
import type { DispatchWorkspace } from "../dispatch/workspace.js";

export class ReviewInputError extends Error {
  readonly project_error: ProjectError;
  constructor(message: string) {
    super(message);
    this.name = "ReviewInputError";
    this.project_error = createProjectError("CONTRACT_INVALID", { issue_code: "review-input-invalid", issues: [message] });
  }
}

export const REVIEW_PROMPT_BYTE_LIMIT = 16 * 1024;
const names = ["effort-context", "subject", "user-ask", "governing-documents", "imported-references", "changes", "revision", "availability", "repository", "verification", "rules", "comparisons", "rubric", "previous-feedback"] as const;
const recipe = z.object({ instructions: z.array(z.string().min(1)).min(1), inputs: z.array(z.enum(names)).min(1), available_inputs: z.array(z.enum(names)).default([]) }).strict();
const rounds = z.object({ initial: recipe, follow_up: recipe }).strict();
const roles = z.object({ general: rounds, tests: rounds.optional(), constitution: rounds, effort: rounds.optional() }).strict();
const phaseRecipe = z.object({ rubric: z.object({ file: z.string().regex(/^rubrics\/[a-z-]+\.yaml$/u), id: z.enum(["prd-v1", "design-v3", "phase-design-v1", "implementation-v1"]), test_criteria: z.array(z.string().min(1)) }).strict(), reviewers: roles }).strict();
const configurationSchema = z.object({ schema_version: z.literal("1"), instructions: z.record(z.string(), z.string().min(1)), input_guidance: z.record(z.string(), z.object({ title: z.string().min(1), use: z.string().min(1) }).strict()), phases: z.object({ prd: phaseRecipe, design: phaseRecipe, "phase-design": phaseRecipe, "phase-impl": phaseRecipe }).strict() }).strict();
export type ReviewInputConfiguration = z.infer<typeof configurationSchema>;

export function loadReviewInputConfiguration(): ReviewInputConfiguration {
  return parseReviewInputConfiguration(parseSingleYamlDocument(bundledConfiguration, "assets/review-inputs.yaml"));
}

export function parseReviewInputConfiguration(value: unknown): ReviewInputConfiguration {
  const config = configurationSchema.parse(value);
  for (const name of [...names, "patch", "statistics", "revision-patch", "revision-statistics", "implementation-notes", "proposed-document", "current-subject", "implementation-scope", "document-patch", "implementation-patch", "available-changes", "available-statistics"]) {
    if (config.input_guidance[name] === undefined) throw new TypeError(`Missing review file guidance: ${name}`);
  }
  for (const [phase, phaseConfig] of Object.entries(config.phases)) {
    const group = phaseConfig.reviewers;
    if ((phase === "phase-design" || phase === "phase-impl") && group.tests === undefined) throw new TypeError(`${phase} requires a test recipe`);
    if (phase === "phase-design" && group.effort === undefined) throw new TypeError("phase-design requires an effort recipe");
    for (const [roleName, role] of Object.entries(group)) for (const mode of Object.values(role!)) {
      if (["general", "tests"].includes(roleName) && (!mode.inputs.includes("rubric") || !mode.instructions.includes("rubric"))) throw new TypeError(`${phase}/${roleName} must supply and instruct use of the assigned rubric`);
      if (mode.instructions.some(name => config.instructions[name] === undefined)) throw new TypeError("Unknown review instruction block");
      if (mode.available_inputs.some(name => mode.inputs.includes(name))) throw new TypeError("An input cannot be both referenced and available-only");
      if (new Set(mode.inputs).size !== mode.inputs.length) throw new TypeError("Duplicate review input group");
    }
  }
  return config;
}

/** Server-created documents; source identifies authenticated authority, never a live fallback. */
export type ReviewDocument = { path: string; content: string; source_version: string };
export type ReviewInputFile = {
  name: string; group: typeof names[number]; byte_count: number; content_digest: string;
  guidance?: { title: string; use: string };
  delivery?: "referenced" | "available";
  source: string; source_version: string; status: "available" | "unavailable";
  content?: string; encoding?: "utf8" | "base64"; source_path?: string;
};
export type PreparedReviewInputs = {
  instructions: string; files: ReviewInputFile[]; configuration_digest: string; response_schema: PlainJsonValue;
  phase: string; reviewer: string; reviewer_id: string; mode: "initial" | "follow_up";
};

type RecordValue = Record<string, PlainJsonValue>;
function object(value: PlainJsonValue | undefined): RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function readable(value: PlainJsonValue, depth = 2): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => readable(item, depth)).join("\n\n");
  if (value !== null && typeof value === "object") return Object.entries(value).filter(([key]) => !["schema_version", "gate_id", "input_fingerprint", "task_id", "content_digest", "proposed_content_digest", "registry_digest", "record_kind", "current_attempt"].includes(key)).map(([key, item]) => `${"#".repeat(Math.min(depth, 6))} ${key.replaceAll("_", " ")}\n\n${readable(item, depth + 1)}`).join("\n\n");
  return String(value);
}
export function dispatchInputRecord(envelope: DispatchEnvelope): RecordValue {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.bytes));
  assertPlainJson(value, "server review input");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Server review input must be an object");
  const record = value as RecordValue;
  if (record.rendered_inputs !== undefined && canonicalJsonDigest({ ...record, digest_kind: envelope.result_kind === "adjudication" ? "adjudication-envelope" : "dispatch-envelope" }) !== envelope.digest) throw new ReviewInputError("The server review input binding changed before dispatch");
  return record;
}

/** One renderer for both previews and live dispatch. The JSON carrier never reaches a CLI. */
export function prepareReviewInputs(envelope: DispatchEnvelope, outputSchema?: PlainJsonValue): PreparedReviewInputs {
  const record = dispatchInputRecord(envelope);
  const responseSchema = record.response_schema ?? outputSchema ?? createReviewResponseSchema(envelope.result_kind, record);
  assertPlainJson(responseSchema, "review response schema");
  const response_schema = structuredClone(responseSchema);
  const config = record.review_configuration === undefined ? loadReviewInputConfiguration() : parseReviewInputConfiguration(record.review_configuration);
  const subject = envelope.result_kind === "effort-review" ? record : object(record.subject);
  const phaseInstance = String(subject.phase_instance ?? (subject.stage === "implementation" ? "phase-impl" : "phase-design"));
  const inferredPhase = phaseInstance.startsWith("phase-impl") ? "phase-impl" : phaseInstance.startsWith("phase-design") ? "phase-design" : phaseInstance === "prd" ? "prd" : "design";
  const phase = z.enum(["prd", "design", "phase-design", "phase-impl"]).parse(record.phase_kind ?? inferredPhase);
  const assignment = object(record.assignment);
  const reviewer = envelope.result_kind === "adjudication" ? "constitution" : envelope.result_kind === "effort-review" ? "effort" : assignment.focus === "tests" ? "tests" : "general";
  const context = (record.context ?? []) as unknown as readonly PinnedContextEntry[];
  const followUp = (reviewer === "general" || reviewer === "tests") && context.some(entry => entry.kind === "prior-triage");
  const mode = followUp ? "follow_up" : "initial";
  const selected = config.phases[phase].reviewers[reviewer]?.[mode];
  if (selected === undefined) throw new TypeError(`No bundled review recipe for ${phase}/${reviewer}`);
  const documentConfig = loadReviewDocumentConfiguration();
  const version = String(subject.subject_digest ?? "server-captured-input");
  const files: ReviewInputFile[] = [];
  const used = new Set<string>();
  const add = (group: ReviewInputFile["group"], name: string, content: string, source: string, sourceVersion = version, status: ReviewInputFile["status"] = "available", encoding: "utf8" | "base64" = "utf8") => {
    if (![...selected.inputs, ...selected.available_inputs].includes(group)) return;
    // Generated filenames have no host-sensitive whitespace, @ syntax, or traversal.
    const stem = name.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/^\.+/u, "");
    let filename = stem || "input.md";
    for (let n = 2; used.has(filename); n++) filename = `${n}-${stem}`;
    used.add(filename);
    const bytes = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
    files.push({ group, name: filename, content, encoding, byte_count: bytes.byteLength, content_digest: sha256Bytes(bytes), source, source_version: sourceVersion, status });
  };
  const documents = (record.documents ?? []) as unknown as ReviewDocument[];
  if (documents.length > 0) {
    for (const doc of documents) {
      const catalog = Object.values(documentConfig.documents).find(item => item.path.replace("{phase}", phaseInstance.split("-").at(-1)!) === doc.path);
      const name = catalog?.filename ?? doc.path.replace(/^phases\/\d+\//u, "");
      const primaryName = `${documentConfig.phases[phase].primary}.md`;
      add("subject", name === primaryName || catalog === undefined ? name : `proposed-${name}`, doc.content, doc.path, doc.source_version);
    }
    if (phase === "phase-impl") add("subject", "implementation.md", String(record.artifact ?? ""), "retained implementation output");
  } else add("subject", phase === "phase-impl" ? "implementation.md" : phase === "design" ? "task-design.md" : `${phase}.md`, String(record.artifact ?? record.plan ?? ""), "review subject");
  if (record.ask !== undefined) add("subject", "ask.md", readable(record.ask), "standalone user ask");
  if (record.paths !== undefined) add("subject", "declared-paths.md", readable(record.paths), "standalone declared paths");
  if (record.verification !== undefined) add("verification", "verification.md", readable(record.verification), "standalone verification");
  for (const entry of context) {
    const isGoverning = Object.values(documentConfig.documents).some(doc => doc.path.replace("{phase}", phaseInstance.split("-").at(-1)!) === entry.label);
    const group = isGoverning && (entry.kind === "approved-upstream" || entry.kind === "imported-reference") ? "governing-documents" : entry.kind === "user-ask" ? "user-ask" : entry.kind === "approved-upstream" ? "governing-documents" : entry.kind === "imported-reference" ? "imported-references" : entry.kind === "prior-triage" ? "previous-feedback" : "verification";
    const governing = Object.values(documentConfig.documents).find(doc => doc.path.replace("{phase}", phaseInstance.split("-").at(-1)!) === entry.label);
    const name = governing?.filename ?? (entry.kind === "validation-override" ? "validation-overrides.md" : entry.kind === "prior-triage" ? "previous-feedback.md" : entry.kind === "verification-transcript" ? "verification.txt" : entry.label === "design.md" ? "task-design.md" : entry.label.replace(/^phases\/\d+\/design.md$/u, "phase-design.md"));
    if (entry.status === "pinned" || entry.status === "truncated") {
      let content = entry.content;
      if (entry.kind === "prior-triage" || entry.kind === "validation-override") { try { content = readable(JSON.parse(content) as PlainJsonValue); } catch { /* already prose */ } }
      add(group, name, content, entry.label, entry.source_version ?? entry.content_digest, "available", entry.encoding);
      if (entry.status === "truncated") add("availability", `unavailable-${name}.md`, `Only historical excerpt evidence is available for ${entry.label}; original size ${entry.total_byte_count} bytes. Missing bytes are not evidence.`, entry.label, entry.content_digest, "unavailable");
    } else add("availability", `unavailable-${name}.md`, `${entry.label}: ${entry.note}\n`, entry.label, "content_digest" in entry ? entry.content_digest : "unavailable", "unavailable");
  }
  if (reviewer === "general" || reviewer === "tests") {
    if (!Array.isArray(object(record.rubric).criteria)) throw new TypeError(`Missing rubric for ${phase}/${reviewer}; refusing to prepare an unscoped review`);
    const assigned = assignment.criterion_ids as string[] | undefined;
    const criteria = (object(record.rubric).criteria as PlainJsonValue[]).filter(criterion => assigned === undefined || assigned.includes(String(object(criterion).id)));
    if (criteria.length === 0 && assignment.expected_upstream_digests === undefined && assignment.legacy_confirmations === undefined) throw new TypeError("Review has no rubric criteria or authenticated responsibility");
    const rubricConfig = subject.stage === "plan"
      ? { file: "rubrics/simple-plan.yaml", id: "simple-plan-v1" }
      : config.phases[phase].rubric;
    const text = `# Assigned review rubric\n\nSource: assets/${rubricConfig.file} (${rubricConfig.id}).\nReviewer: ${reviewer}.\n\n${criteria.length === 0 ? "No rubric criteria assigned. Review only the authenticated upstream-alignment or legacy-confirmation responsibilities." : readable(criteria)}`;
    add("rubric", "rubric.md", text, `assets/${rubricConfig.file}`, String(subject.rubric_digest ?? canonicalJsonDigest(criteria)));

  }
  if (reviewer === "effort" && record.hazard_registry !== undefined) add("effort-context", "repository-hazards.md", readable(record.hazard_registry), "captured repository hazard registry", String(object(record.hazard_registry).registry_digest ?? version));
  if (record.rules !== undefined) add("rules", "constitution-rules.md", readable(record.rules), "pinned constitution rules", String(subject.pinned_constitution_digest ?? version));
  const comparisons = record.governing_document_comparisons;
  if (comparisons !== undefined) add("comparisons", "governing-comparisons.md", `${config.instructions.comparisons}\n\n${readable(comparisons)}`, "authenticated human-approved governing baselines");
  const diffs = record.diffs as unknown as ReviewDiffContext | undefined;
  for (const [group, diff] of [["changes", diffs?.full], ["revision", diffs?.revision]] as const) {
    if (diff === undefined || ![...selected.inputs, ...selected.available_inputs].includes(group)) continue;
    for (const extension of ["patch", "stat"] as const) {
      const file = diff[extension];
      files.push({ group, name: `${group === "revision" ? "revision" : "changes"}.${extension}`, source_path: file.path, byte_count: file.byte_count, content_digest: file.content_digest, source: `${diff.kind} ${extension}`, source_version: diff.base_subject_digest ?? version, status: "available" });
    }
  }
  if (diffs?.revision_unavailable !== undefined) add("availability", "revision-unavailable.md", diffs.revision_unavailable, "reviewer-specific revision baseline", "unavailable", "unavailable");
  const workspace = object(record.workspace);
  if (Object.keys(workspace).length > 0) add("repository", "repository.md", `${String(workspace.note ?? "Inspect the supplied repository snapshot without modifying files.")}\n${Array.isArray(workspace.repositories) ? workspace.repositories.map(repository => `- ${String(object(repository).name)}: repositories/${String(object(repository).path)}`).join("\n") : ""}`, "repository snapshots", canonicalJsonDigest(workspace));
  const label = phase === "prd" ? "PRD" : phase === "design" ? "task design" : `${phase === "phase-design" ? "phase design" : "phase implementation"} ${phaseInstance.split("-").at(-1)!.match(/^\d+$/u) ? phaseInstance.split("-").at(-1) : ""}`.trim();
  const standalone = subject.stage !== undefined;
  const blocks = [
    `Review ${standalone ? `standalone ${String(subject.stage)}` : label}. Assigned reviewer: ${String(assignment.reviewer_id ?? reviewer)}.`,
    ...(standalone ? [config.instructions.simple!, ...(reviewer === "constitution" ? [] : [config.instructions[`simple_${String(subject.stage)}`]!])] : [documentConfig.phases[phase].review]),
    ...selected.instructions.filter(name => !standalone || !["implementation", "constitution_implementation"].includes(name)).map(name => config.instructions[name]!),
  ];
  for (const file of files) {
    file.delivery = selected.available_inputs.includes(file.group) ? "available" : "referenced";
    const key = file.delivery === "available" && file.group === "changes" ? file.name.endsWith(".patch") ? "available-changes" : "available-statistics"
      : file.group === "changes" ? file.name.endsWith(".patch") ? diffs?.full.kind === "document" ? "document-patch" : "implementation-patch" : "statistics"
      : file.group === "revision" ? file.name.endsWith(".patch") ? "revision-patch" : "revision-statistics"
      : file.name === "implementation.md" ? "implementation-scope"
      : file.name.startsWith("proposed-") ? "proposed-document"
      : followUp && file.group === "subject" ? "current-subject"
      : file.name === "impl-notes.md" ? "implementation-notes" : file.group;
    const guidance = config.input_guidance[key]!;
    const governing = file.group === "governing-documents" ? Object.values(documentConfig.documents).find(doc => doc.filename === file.name) : undefined;
    file.guidance = { ...guidance, ...(governing === undefined ? {} : { use: governing.use }) };
  }
  return { instructions: blocks.join("\n\n"), response_schema, files: files.sort((a,b) => [...selected.inputs, ...selected.available_inputs].indexOf(a.group) - [...selected.inputs, ...selected.available_inputs].indexOf(b.group)), configuration_digest: canonicalJsonDigest({ recipes: config, documents: documentConfig } as unknown as PlainJsonValue), phase, reviewer, reviewer_id: String(assignment.reviewer_id ?? reviewer), mode };
}

export function renderReviewPrompt(prepared: PreparedReviewInputs, directory: string): string {
  const references = prepared.files.map(file => {
    if (file.guidance === undefined) throw new ReviewInputError(`Missing usage guidance for ${file.name}`);
    const reference = file.delivery === "available" ? `Available on disk: \`${directory}/${file.name}\`` : `@${directory}/${file.name}`;
    return `### ${file.guidance.title}\n\n${reference}\n\n${file.guidance.use}`;
  }).join("\n\n");
  const { example, choices } = reviewResponseExample(prepared.response_schema);
  const response = `## Response format\n\nReturn exactly one JSON object using the structure below. Replace the illustrative judgments and placeholder text with your own assessment; preserve fixed identifiers and version values. Do not wrap your response in Markdown fences, add surrounding commentary, or create a separate review document.\n\n\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\`\n\nAllowed values: ${choices.join("; ")}.`;
  const prompt = `${prepared.instructions}\n\n${response}\n\n## Supplied files and how to use them\n\n${references}\n`;
  if (Buffer.byteLength(prompt) > REVIEW_PROMPT_BYTE_LIMIT) throw new ReviewInputError("Review instructions, response example, and references exceed 16 KiB; shorten the bundled recipe, reduce document references, or reduce the assigned rule set. No context or example was truncated.");
  return prompt;
}
export async function materializeReviewInputs(envelope: DispatchEnvelope, workspace: DispatchWorkspace, outputSchema?: PlainJsonValue): Promise<{ prompt: string; directory: string; prepared: PreparedReviewInputs }> {
  const prepared = prepareReviewInputs(envelope, outputSchema);
  const root = workspace.review_root ?? workspace.root;
  const directoryId = prepared.reviewer_id;
  if (!/^[a-z][a-z0-9-]*$/u.test(directoryId)) throw new TypeError("Invalid reviewer input directory");
  const relative = `review-inputs/${directoryId}`;
  const directory = join(root, "review-inputs", directoryId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of prepared.files) {
    const bytes = file.source_path === undefined ? Buffer.from(file.content ?? "", file.encoding === "base64" ? "base64" : "utf8") : await readFile(join(workspace.review_root === undefined ? workspace.root : dirname(workspace.review_root), file.source_path));
    if (bytes.byteLength !== file.byte_count || sha256Bytes(bytes) !== file.content_digest) throw new TypeError(`Review input changed before dispatch: ${file.name}`);
    const target = join(directory, file.name);
    // Identical reviewers may share a materialization, so verify an existing file instead of rewriting it.
    try { await writeFile(target, bytes, { flag: "wx", mode: 0o444 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!(await lstat(target)).isFile()) throw new ReviewInputError(`Review input is not a regular file: ${file.name}`);
    if (sha256Bytes(await readFile(target)) !== file.content_digest) throw new TypeError(`Materialized review input changed: ${file.name}`);
    await chmod(target, 0o444);
  }
  return { prepared, directory, prompt: renderReviewPrompt(prepared, relative) };
}

export const CLI_CONTEXT_NOTES = {
  "claude-cli": "Direct @ references can preload contents. Large files may be omitted by the CLI and require Read. References inside documents are not recursively expanded. Safe mode suppresses local instructions; managed policy and built-in context may remain.",
  "codex-cli": "@ references are text in exec mode; the model must read files with tools. User configuration and project instructions are suppressed by the adapter. Built-in context and managed policy may remain.",
  "antigravity-cli": "@ references require tool reads in the tested print mode. The adapter retains host tools and context; disabling slash commands is not a filesystem sandbox or complete instruction isolation.",
} as const;
