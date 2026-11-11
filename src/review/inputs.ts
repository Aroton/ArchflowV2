import { createReviewResponseSchema, reviewResponseExample } from "./response-schema.js";
import bundledConfiguration from "../../assets/review-inputs.yaml";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import { parseSingleYamlDocument } from "../contracts/yaml.js";
import type { DispatchEnvelope } from "./envelopes.js";
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
const names = ["subject", "verification", "rules", "rubric", "repository"] as const;
const recipe = z.object({ instructions: z.array(z.string().min(1)).min(1), inputs: z.array(z.enum(names)).min(1) }).strict();
const roles = z.object({ general: recipe, tests: recipe, constitution: recipe }).strict();
const phaseRecipe = z.object({ rubric: z.object({ file: z.string().regex(/^rubrics\/[a-z-]+\.yaml$/u), id: z.enum(["simple-plan-v1", "implementation-v1"]), test_criteria: z.array(z.string().min(1)) }).strict(), reviewers: roles }).strict();
const configurationSchema = z.object({ schema_version: z.literal("1"), instructions: z.record(z.string(), z.string().min(1)), input_guidance: z.record(z.string(), z.object({ title: z.string().min(1), use: z.string().min(1) }).strict()), phases: z.object({ "phase-design": phaseRecipe, "phase-impl": phaseRecipe }).strict() }).strict();
export type ReviewInputConfiguration = z.infer<typeof configurationSchema>;

/** The standalone stages and the recipe phase each one runs on. */
const STAGE_PHASES = { plan: "phase-design", implementation: "phase-impl" } as const;

export function loadReviewInputConfiguration(): ReviewInputConfiguration {
  return parseReviewInputConfiguration(parseSingleYamlDocument(bundledConfiguration, "assets/review-inputs.yaml"));
}

export function parseReviewInputConfiguration(value: unknown): ReviewInputConfiguration {
  const config = configurationSchema.parse(value);
  for (const name of [...names, "implementation-scope"]) {
    if (config.input_guidance[name] === undefined) throw new TypeError(`Missing review file guidance: ${name}`);
  }
  for (const name of ["simple", ...Object.keys(STAGE_PHASES).map(stage => `simple_${stage}`)]) {
    if (config.instructions[name] === undefined) throw new TypeError(`Missing review instruction block: ${name}`);
  }
  for (const [phase, phaseConfig] of Object.entries(config.phases)) {
    for (const [roleName, role] of Object.entries(phaseConfig.reviewers)) {
      if (["general", "tests"].includes(roleName) && (!role.inputs.includes("rubric") || !role.instructions.includes("rubric"))) throw new TypeError(`${phase}/${roleName} must supply and instruct use of the assigned rubric`);
      if (role.instructions.some(name => config.instructions[name] === undefined)) throw new TypeError("Unknown review instruction block");
      if (new Set(role.inputs).size !== role.inputs.length) throw new TypeError("Duplicate review input group");
    }
  }
  return config;
}

export type ReviewInputFile = {
  name: string; group: typeof names[number]; byte_count: number; content_digest: string;
  guidance?: { title: string; use: string };
  source: string; source_version: string;
  content: string;
};
export type PreparedReviewInputs = {
  instructions: string; files: ReviewInputFile[]; configuration_digest: string; response_schema: PlainJsonValue;
  phase: string; reviewer: string; reviewer_id: string;
};

type RecordValue = Record<string, PlainJsonValue>;
function object(value: PlainJsonValue | undefined): RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function readable(value: PlainJsonValue, depth = 2): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => readable(item, depth)).join("\n\n");
  if (value !== null && typeof value === "object") return Object.entries(value).map(([key, item]) => `${"#".repeat(Math.min(depth, 6))} ${key.replaceAll("_", " ")}\n\n${readable(item, depth + 1)}`).join("\n\n");
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

/** One renderer for the sealed envelope and the dispatched child, so both see the same inputs. The JSON carrier never reaches a CLI. */
export function prepareReviewInputs(envelope: DispatchEnvelope, outputSchema?: PlainJsonValue): PreparedReviewInputs {
  const record = dispatchInputRecord(envelope);
  const responseSchema = record.response_schema ?? outputSchema ?? createReviewResponseSchema(envelope.result_kind, record);
  assertPlainJson(responseSchema, "review response schema");
  const response_schema = structuredClone(responseSchema);
  const config = record.review_configuration === undefined ? loadReviewInputConfiguration() : parseReviewInputConfiguration(record.review_configuration);
  const subject = object(record.subject);
  const stage = z.enum(["plan", "implementation"]).parse(subject.stage);
  const phase = STAGE_PHASES[stage];
  const assignment = object(record.assignment);
  const reviewer = envelope.result_kind === "adjudication" ? "constitution" : assignment.focus === "tests" ? "tests" : "general";
  const selected = config.phases[phase].reviewers[reviewer];
  const version = String(subject.subject_digest ?? "server-captured-input");
  const files: ReviewInputFile[] = [];
  const used = new Set<string>();
  const add = (group: ReviewInputFile["group"], name: string, content: string, source: string, sourceVersion = version) => {
    if (!selected.inputs.includes(group)) return;
    // Generated filenames have no host-sensitive whitespace, @ syntax, or traversal.
    const stem = name.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/^\.+/u, "");
    let filename = stem || "input.md";
    for (let n = 2; used.has(filename); n++) filename = `${n}-${stem}`;
    used.add(filename);
    const bytes = Buffer.from(content, "utf8");
    files.push({ group, name: filename, content, byte_count: bytes.byteLength, content_digest: sha256Bytes(bytes), source, source_version: sourceVersion });
  };
  add("subject", phase === "phase-impl" ? "implementation.md" : `${phase}.md`, String(record.plan ?? ""), "review subject");
  if (record.ask !== undefined) add("subject", "ask.md", readable(record.ask), "standalone user ask");
  if (record.paths !== undefined) add("subject", "declared-paths.md", readable(record.paths), "standalone declared paths");
  if (record.verification !== undefined) add("verification", "verification.md", readable(record.verification), "standalone verification");
  if (reviewer === "general" || reviewer === "tests") {
    if (!Array.isArray(object(record.rubric).criteria)) throw new TypeError(`Missing rubric for ${phase}/${reviewer}; refusing to prepare an unscoped review`);
    const assigned = assignment.criterion_ids as string[] | undefined;
    const criteria = (object(record.rubric).criteria as PlainJsonValue[]).filter(criterion => assigned === undefined || assigned.includes(String(object(criterion).id)));
    if (criteria.length === 0) throw new TypeError("Review has no assigned rubric criteria");
    const rubricConfig = config.phases[phase].rubric;
    const text = `# Assigned review rubric\n\nSource: assets/${rubricConfig.file} (${rubricConfig.id}).\nReviewer: ${reviewer}.\n\n${readable(criteria)}`;
    add("rubric", "rubric.md", text, `assets/${rubricConfig.file}`, canonicalJsonDigest(criteria));
  }
  if (record.rules !== undefined) add("rules", "constitution-rules.md", readable(record.rules), "pinned constitution rules");
  const workspace = object(record.workspace);
  if (Object.keys(workspace).length > 0) add("repository", "repository.md", `${String(workspace.note ?? "Inspect the supplied repository snapshot without modifying files.")}\n${Array.isArray(workspace.repositories) ? workspace.repositories.map(repository => `- ${String(object(repository).name)}: repositories/${String(object(repository).path)}`).join("\n") : ""}`, "repository snapshots", canonicalJsonDigest(workspace));
  const blocks = [
    `Review standalone ${stage}. Assigned reviewer: ${String(assignment.reviewer_id ?? reviewer)}.`,
    config.instructions.simple!,
    ...(reviewer === "constitution" ? [] : [config.instructions[`simple_${stage}`]!]),
    ...selected.instructions.map(name => config.instructions[name]!),
  ];
  for (const file of files) file.guidance = { ...config.input_guidance[file.name === "implementation.md" ? "implementation-scope" : file.group]! };
  return { instructions: blocks.join("\n\n"), response_schema, files: files.sort((a, b) => selected.inputs.indexOf(a.group) - selected.inputs.indexOf(b.group)), configuration_digest: canonicalJsonDigest({ recipes: config } as unknown as PlainJsonValue), phase, reviewer, reviewer_id: String(assignment.reviewer_id ?? reviewer) };
}

export function renderReviewPrompt(prepared: PreparedReviewInputs, directory: string): string {
  const references = prepared.files.map(file => {
    if (file.guidance === undefined) throw new ReviewInputError(`Missing usage guidance for ${file.name}`);
    return `### ${file.guidance.title}\n\n@${directory}/${file.name}\n\n${file.guidance.use}`;
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
    const bytes = Buffer.from(file.content, "utf8");
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
