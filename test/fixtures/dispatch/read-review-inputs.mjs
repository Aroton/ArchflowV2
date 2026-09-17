// Offline reviewer simulator: read the real referenced files and output schema, never stdin.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
export function readReviewFixtureInputs(argv) {
  const prompt = argv.find(value => value.includes("entire supplied base context"));
  if (!prompt) throw new Error("The review prompt was not supplied on argv");
  const cwd = argv.includes("-C") ? argv[argv.indexOf("-C") + 1] : process.cwd();
  const references = [...prompt.matchAll(/^@(.+)$/gm)].map(match => match[1]).concat([...prompt.matchAll(/^Available on disk: `([^`]+)`$/gm)].map(match => match[1]));
  const files = references.map(path => { const bytes = readFileSync(resolve(cwd, path)); return { path, name: path.split("/").at(-1), content: bytes.toString("utf8"), content_digest: createHash("sha256").update(bytes).digest("hex"), byte_count: bytes.length }; });
  const file = name => files.find(file => file.name === name);
  const schemaValue = argv.includes("--output-schema") ? argv[argv.indexOf("--output-schema") + 1] : argv[argv.indexOf("--json-schema") + 1];
  const schema = JSON.parse(schemaValue.startsWith("{") ? schemaValue : readFileSync(schemaValue, "utf8"));
  const constants = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, node]) => node.const !== undefined).map(([key, node]) => [key, node.const]));
  const phase = /Review (PRD|task design|phase design|phase implementation)(?: (\d+))?\./.exec(prompt);
  const phaseInstance = phase?.[1] === "PRD" ? "prd" : phase?.[1] === "task design" ? "design" : `${phase?.[1] === "phase implementation" ? "phase-impl" : "phase-design"}-${phase?.[2] ?? 1}`;
  const ruleFile = file("constitution-rules.md");
  const rules = ruleFile?.content.split(/(?=^## slot\n)/m).filter(text => text.startsWith("## slot\n")).map(text => ({ slot: /^## slot\n\n([^\n]+)/.exec(text)[1], text, ...(/## review trigger\n\n([\s\S]*?)(?:\n\n## |$)/.exec(text) ? { review_trigger: /## review trigger\n\n([\s\S]*?)(?:\n\n## |$)/.exec(text)[1] } : {}) }));
  const criteria = [...(file("rubric.md")?.content ?? "").matchAll(/^## id\n\n([^\n]+)/gm)].map(match => ({ id: match[1] }));
  const focus = /Assigned reviewer: test\b/.test(prompt) ? "tests" : "general";
  const descriptor = name => { const found = file(name); return found && { path: found.path, byte_count: found.byte_count, content_digest: found.content_digest }; };
  const primaryName = phaseInstance === "prd" ? "prd.md" : phaseInstance === "design" ? "task-design.md" : phaseInstance.startsWith("phase-design") ? "phase-design.md" : "implementation.md";
  const context = files.filter(file => file.name !== primaryName && ["ask.md", "prd.md", "task-design.md", "previous-feedback.md", "verification.txt", "validation-overrides.md", "unavailable-ask.md.md"].includes(file.name)).map(file => file.name.startsWith("unavailable-") ? { kind: "user-ask", label: "ask.md", status: "unavailable", note: file.content } : { kind: file.name === "ask.md" ? "user-ask" : file.name === "previous-feedback.md" ? "prior-triage" : file.name === "verification.txt" ? "verification-transcript" : file.name === "validation-overrides.md" ? "validation-override" : "approved-upstream", label: file.name === "task-design.md" ? "design.md" : file.name, status: "pinned", content_digest: file.content_digest, encoding: "utf8", content: file.content });
  const workspace = { note: file("repository.md")?.content, repositories: (file("repository.md")?.content.match(/^- (.+): (.+)$/gm) ?? []).map(line => { const [,name,path] = /^- (.+): (.+)$/.exec(line); return {name,path}; }) };
  return { ...constants, prompt, files, subject: { phase_instance: phaseInstance, role: rules ? "adjudication" : "counter-review", ...constants }, artifact: (file("implementation.md") ?? file("phase-design.md") ?? file("task-design.md") ?? file("prd.md"))?.content, assignment: { focus, reviewer_id: /Assigned reviewer: ([\w-]+)/.exec(prompt)?.[1], criterion_ids: criteria.map(criterion => criterion.id) }, rubric: { criteria }, context, workspace, ...(rules ? { rules } : {}), ...(descriptor("changes.patch") ? { diffs: { full: { patch: descriptor("changes.patch"), stat: descriptor("changes.stat") }, ...(descriptor("revision.patch") ? { revision: { patch: descriptor("revision.patch"), stat: descriptor("revision.stat") } } : {}) } } : {}) };
}
