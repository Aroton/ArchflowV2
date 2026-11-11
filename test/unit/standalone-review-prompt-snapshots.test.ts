import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectCliAdapter } from "../../src/dispatch/cli.js";
import { runLocalReview } from "../../src/local/review.js";
import { materializeReviewInputs } from "../../src/review/inputs.js";
import type { SimpleReviewDependencies } from "../../src/review/simple-review.js";

/**
 * Pins the exact prompts `archflow-local review` dispatches. Each fixture is the prompt bytes the CLI adapter
 * sends (rendered by `materializeReviewInputs` from the envelope and response schema the review hands to dispatch,
 * exactly as the real dispatcher does), followed by the bytes of every supplied file that prompt references,
 * because the rubric, ask, plan, rules, and repository note reach the reviewer only through those files, and then by
 * the response schema the route's CLI adapter hands the reviewer CLI, as indented JSON in the property order it is sent (order shapes structured output).
 * Each stage must dispatch exactly one call per role, so a template that adds a route forces a fixture update.
 *
 * Fixtures are compared, never written, by default. Regenerate with
 * `ARCHFLOW_WRITE_PROMPT_SNAPSHOTS=1 npx vitest run --project fast test/unit/standalone-review-prompt-snapshots.test.ts`.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/review-prompts");
const writeMode = process.env.ARCHFLOW_WRITE_PROMPT_SNAPSHOTS === "1";
const roles = ["counter-reviewer", "test-reviewer", "adjudicator"] as const;
type Role = typeof roles[number];

// Fixed identity and dates make the base commit SHA, and so every prompt byte, reproducible.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Snapshot", GIT_AUTHOR_EMAIL: "snapshot@example.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Snapshot", GIT_COMMITTER_EMAIL: "snapshot@example.invalid", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitEnv }).trim();

// A fixed constitution in the scratch repository makes the adjudicator dispatch independent of the bundled rules.
const constitution: Record<string, string> = {
  "00-public-interfaces.md": "---\nid: preserve-public-interfaces\nversion: 1\nstatus: active\nreview_trigger: A documented command or exported interface changes.\nenforced_by:\n  - contract tests\n---\nKeep documented commands and exported interfaces backward compatible unless the ask changes them.\n",
  "01-plain-errors.md": "---\nid: plain-error-messages\nversion: 2\nstatus: active\n---\nUser-facing error messages name the failing input and the next step in plain language.\n",
};

let root: string;
let inputsRoot: string;
const captured = new Map<string, string>();
const dispatchCounts = new Map<string, number>();

function capture(stage: string): NonNullable<SimpleReviewDependencies["dispatch"]> {
  return async (route, envelope, schema) => {
    // The real dispatcher hands this envelope and schema to the adapter, which renders the prompt this way.
    // Each dispatch gets its own input root, as each real child workspace does.
    const workspaceRoot = await mkdtemp(join(inputsRoot, "dispatch-"));
    const rendered = await materializeReviewInputs(envelope, { root: workspaceRoot, env: {}, dispose: async () => {} }, schema);
    const body = JSON.parse(new TextDecoder().decode(envelope.bytes));
    const role: Role = envelope.result_kind === "adjudication" ? "adjudicator" : body.assignment.focus === "tests" ? "test-reviewer" : "counter-reviewer";
    const relative = `review-inputs/${rendered.prepared.reviewer_id}`;
    const files = await Promise.all(rendered.prepared.files.map(async file =>
      `\n<!-- supplied file: ${relative}/${file.name} -->\n${await readFile(join(rendered.directory, file.name), "utf8")}`));
    // The adapter the real dispatcher selects for this route builds the invocation; pin the schema it sends the CLI
    // (inline JSON for claude-cli, a schema file for codex-cli and antigravity-cli).
    const adapter = selectCliAdapter("claude", route);
    const invocation = await adapter.buildInvocation(envelope, route, { root: workspaceRoot, env: {}, dispose: async () => {} }, schema);
    const flag = invocation.argv.indexOf(adapter.id === "codex-cli" ? "--output-schema" : "--json-schema");
    const sent = adapter.id === "claude-cli" ? invocation.argv[flag + 1]! : await readFile(invocation.argv[flag + 1]!, "utf8");
    const responseSchema = `\n<!-- response schema sent by ${adapter.id} -->\n\`\`\`json\n${JSON.stringify(JSON.parse(sent), null, 2)}\n\`\`\`\n`;
    const key = `${stage}-${role}`;
    dispatchCounts.set(key, (dispatchCounts.get(key) ?? 0) + 1);
    if (!captured.has(key)) captured.set(key, `${rendered.prompt}\n<!-- end of dispatched prompt; supplied files follow -->\n${files.join("")}${responseSchema}`);
    const result = role === "adjudicator"
      ? { schema_version: "2", judgments: Object.fromEntries(body.rules.map((rule: { slot: string }) => [rule.slot, { compliance: "pass", rationale: "No policy issue.", trigger: "not-matched", trigger_evidence: "No trigger evidence." }])) }
      : { outcome: "no_issues_found", feedback: "Reviewed the declared paths; no actionable issues." };
    return { cli_version: "test", extracted_output_bytes: new TextEncoder().encode(JSON.stringify(result)) };
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "archflow-standalone-prompt-"));
  inputsRoot = await mkdtemp(join(tmpdir(), "archflow-standalone-prompt-inputs-"));
  git(root, "init", "-q");
  await writeFile(join(root, "greeting.ts"), "export const greeting = (name: string) => `Hello, ${name}`;\n");
  await writeFile(join(root, "greeting.test.ts"), "import { greeting } from \"./greeting\";\nif (greeting(\"Ada\") !== \"Hello, Ada\") throw new Error(\"greeting\");\n");
  await mkdir(join(root, ".archflow/constitution/default"), { recursive: true });
  for (const [name, text] of Object.entries(constitution)) await writeFile(join(root, ".archflow/constitution/default", name), text);
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const base_commit = git(root, "rev-parse", "HEAD");
  const request = { schema_version: "1", ask: "Greet with an exclamation mark.", base_commit, paths: ["greeting.ts", "greeting.test.ts"] };
  const plan = await runLocalReview({ working_directory: root, producer: "claude", value: { ...request, stage: "plan",
    plan: "Append an exclamation mark in greeting.ts and update greeting.test.ts to expect it." } }, { dispatch: capture("plan") }) as { ok: boolean };
  expect(plan.ok, JSON.stringify(plan)).toBe(true);
  await writeFile(join(root, "greeting.ts"), "export const greeting = (name: string) => `Hello, ${name}!`;\n");
  await writeFile(join(root, "greeting.test.ts"), "import { greeting } from \"./greeting\";\nif (greeting(\"Ada\") !== \"Hello, Ada!\") throw new Error(\"greeting\");\n");
  const implementation = await runLocalReview({ working_directory: root, producer: "claude", value: { ...request, stage: "implementation",
    plan: "Appended an exclamation mark in greeting.ts and updated greeting.test.ts.", verification: "$ node greeting.test.ts\nexit 0\n" } },
  { dispatch: capture("implementation") }) as { ok: boolean };
  expect(implementation.ok, JSON.stringify(implementation)).toBe(true);
});
afterAll(async () => { await Promise.all([root, inputsRoot].filter(Boolean).map(path => rm(path, { recursive: true, force: true }))); });

describe("standalone review dispatched prompts", () => {
  it.each(["plan", "implementation"].flatMap(stage => roles.map(role => ({ stage, role }))))("$stage / $role", async ({ stage, role }) => {
    const actual = captured.get(`${stage}-${role}`);
    expect(actual, `no ${role} dispatch at ${stage}`).toBeDefined();
    expect(dispatchCounts.get(`${stage}-${role}`), `${role} dispatches at ${stage}`).toBe(1);
    // Scratch paths must never reach a pinned prompt; a leak would make the fixture machine-specific.
    expect(actual).not.toContain(root);
    expect(actual).not.toContain(inputsRoot);
    const fixture = join(fixtures, `standalone-${stage}-${role}.md`);
    if (writeMode) await writeFile(fixture, actual!);
    expect(actual).toBe(await readFile(fixture, "utf8"));
  });
});
