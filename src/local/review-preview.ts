import { createProductionServices } from "../state/production.js";
import { loadCurrentProduceSubject } from "../state/produce-subject.js";
import { parseTaskSlug } from "../contracts/evidence.js";
import { parseToolCall } from "../contracts/mcp-tools.js";
import { connectionContextFactory, createInvocationContext } from "../contracts/contexts.js";
import { prepareCounterReviewRequest } from "../mcp/handlers/counter-review.js";
import { prepareCounterReviewDispatch } from "../review/counter-review.js";
import { CLI_CONTEXT_NOTES, dispatchInputRecord, materializeReviewInputs } from "../review/inputs.js";
import type { HostIdentity } from "../contracts/hosts.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { DispatchEnvelope } from "../review/envelopes.js";
import type { DispatchRoute } from "../dispatch/routing.js";

export async function previewReview(input: { working_directory: string; task_id?: string; producer?: string; reviewer?: string }) {
  if (!["claude", "codex", "antigravity"].includes(input.producer ?? "")) throw new TypeError("review-preview requires --producer claude|codex|antigravity to resolve the actual review routes");
  const created = await createProductionServices({ working_directory: input.working_directory, task_id: parseTaskSlug(input.task_id), operation: "review-preview" as never });
  if (!created.ok) return created;
  const services = created.value;
  const state = services.state?.value;
  if (state === undefined) throw new TypeError("Review preview requires an initialized task and an authenticated produced subject");
  const produce = await loadCurrentProduceSubject(services.dependencies, state);
  if (!produce.ok) return produce;
  const artifact = produce.value.artifact;
  const artifactPath = artifact.artifact_kind === "document" ? artifact.document_path : `phases/${state.phase_instance.split("-").at(-1)}/impl-notes.md`;
  const call = parseToolCall("archflow_counter_review", { schema_version: "1", task_id: services.authority.task_id, intent_id: "review-preview", expected_revision: state.revision, input_fingerprint: state.input_fingerprint, artifact_path: artifactPath });
  const connection = connectionContextFactory.captureStartup({ connection_id: "review-preview", startup_repository_candidate: { working_directory: input.working_directory } }).initialize({ client: { name: "archflow-local", version: "1" }, host: input.producer as HostIdentity, protocol_version: "2025-11-25" });
  const context = createInvocationContext(connection, { invocation_id: "review-preview", transport_metadata: { request_id: "review-preview", operation: "tools/call" } }, new AbortController().signal);
  const request = await prepareCounterReviewRequest(call, context, false, true);
  if (!request.ok) return request;
  const { dependencies, input: reviewInput, sharedWorkspace } = request.value;
  try {
    // Deliberately provide no dispatch, persistence, recovery or diagnostic writers.
    const prepared = await prepareCounterReviewDispatch({ ...(dependencies.prepare_diffs === undefined ? {} : { prepare_diffs: dependencies.prepare_diffs }) }, reviewInput);
    if (!prepared.ok) return prepared;
    const value = prepared.value;
    const reviews: { reviewer: string; route: DispatchRoute; envelope: DispatchEnvelope }[] = value.reviewRoutes.map((route, index) => ({ reviewer: route.assignment.reviewer_id, route: route.selection.route, envelope: value.reviewEnvelopes[index]! }));
    if (value.constitutionEnvelope !== undefined && value.constitutionRoute !== undefined) reviews.push({ reviewer: "constitution", route: value.constitutionRoute.selection.route, envelope: value.constitutionEnvelope });
    if (value.effortEnvelope !== undefined && value.effortRoute !== undefined) reviews.push({ reviewer: "effort", route: value.effortRoute.selection.route, envelope: value.effortEnvelope });
    if (input.reviewer !== undefined && !reviews.some(review => review.reviewer === input.reviewer)) throw new TypeError(`Reviewer ${input.reviewer} is not selected for this round; available: ${reviews.map(review => review.reviewer).join(", ")}`);
    const workspace = await sharedWorkspace.acquire();
    const rendered = [];
    for (const review of reviews.filter(review => input.reviewer === undefined || review.reviewer === input.reviewer)) {
      const material = await materializeReviewInputs(review.envelope, workspace);
      const binding = dispatchInputRecord(review.envelope);
      const baselines = ((binding.governing_document_comparisons ?? []) as { path: string; baseline: { status: string; content_digest?: string; reason?: string }; proposed_content_digest: string }[]).map(item => ({ path: item.path, baseline_status: item.baseline.status, baseline_version: item.baseline.content_digest ?? item.baseline.reason ?? "unavailable", proposed_version: item.proposed_content_digest }));
      rendered.push({ reviewer: review.reviewer, route: review.route, phase: material.prepared.phase, mode: material.prepared.mode, prompt: material.prompt, prompt_bytes: Buffer.byteLength(material.prompt), configuration_digest: material.prepared.configuration_digest, repository_versions: binding.workspace ?? null, governing_document_versions: baselines, files: material.prepared.files.map(({ content: _content, encoding: _encoding, source_path: _source, ...file }) => file), cli_added_context: CLI_CONTEXT_NOTES[review.route.adapter] });
    }
    return { schema_version: "1", ok: true, value: { task: services.authority.task_id, phase_instance: state.phase_instance, subject_digest: produce.value.artifact_digest, supplied_by: "ArchFlow", reviews: rendered, effort_default: value.effortPlan !== undefined && value.effortRoute === undefined, note: "Preview supplies no approval or review authority. CLI loading and additional context are reported separately from the exact supplied prompt and files." } } as unknown as PlainJsonValue;
  } finally { await sharedWorkspace.dispose(); }
}

export function renderReviewPreview(value: unknown): string {
  const result = value as { ok?: boolean; value?: { task: string; phase_instance: string; reviews: { reviewer: string; route: DispatchRoute; prompt: string; repository_versions: unknown; governing_document_versions: unknown; files: { name: string; byte_count: number; source: string; source_version: string; status: string }[]; cli_added_context: string }[]; note: string } };
  if (!result.ok || result.value === undefined) return `${JSON.stringify(value, null, 2)}\n`;
  const { task, phase_instance, reviews, note } = result.value;
  return [`Review inputs: ${task} / ${phase_instance}`, ...reviews.map(review => [
    `\nReviewer: ${review.reviewer} (${review.route.adapter}, ${review.route.model}, ${review.route.effort})`,
    "\nExact ArchFlow prompt:", review.prompt,
    "Supplied files (bytes | originating document | version | availability):",
    ...review.files.map(file => `${file.name}: ${file.byte_count} | ${file.source} | ${file.source_version} | ${file.status}`),
    `\nGoverning comparison versions: ${JSON.stringify(review.governing_document_versions, null, 2)}`,
    `\nOriginating repository versions: ${JSON.stringify(review.repository_versions, null, 2)}`,
    `\nCLI-added context/loading: ${review.cli_added_context}`,
  ].join("\n")), note].join("\n") + "\n";
}
