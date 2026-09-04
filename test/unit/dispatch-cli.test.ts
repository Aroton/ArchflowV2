import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalJsonBytes } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parseGeneralReviewOutputV3 } from "../../src/contracts/review.js";
import adjudicationSchema from "../../src/contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import effortReviewSchema from "../../src/contracts/schemas/v1/effort-review.schema.json" with { type: "json" };
import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import type { HostIdentity } from "../../src/contracts/hosts.js";
import { MAX_ARGV_ELEMENT_BYTES, type DispatchChildResult } from "../../src/dispatch/process.js";
import {
  CliAdapterError,
  projectCliOutputSchema,
  selectCliAdapter,
  serializeDispatch,
} from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";
import validReview from "../fixtures/contracts/review/valid.json" with { type: "json" };

const bytes = (value: string): Buffer => Buffer.from(value, "utf8");
const result = (value: Partial<DispatchChildResult> = {}): DispatchChildResult => Object.freeze({
  exit_code: 0,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  ...value,
});
const envelope: DispatchEnvelope = Object.freeze({
  result_kind: "review",
  bytes: bytes('{"schema_version":"1","subject":{}}\n'),
  digest: "d".repeat(64) as never,
  byte_count: 36,
});

async function workspace(): Promise<DispatchWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "archflow-cli-test-"));
  return Object.freeze({ root, env: Object.freeze({ PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, CODEX_HOME: join(root, "home", ".codex") }), dispose: async () => undefined });
}

function projectError(call: () => unknown): CliAdapterError["project_error"] {
  try { call(); } catch (error) {
    expect(error).toBeInstanceOf(CliAdapterError);
    return (error as CliAdapterError).project_error;
  }
  throw new Error("expected adapter error");
}

describe("CLI adapter selection", () => {
  it("defaults to the host's opposite family and refuses unknown hosts before launch", () => {
    expect(selectCliAdapter("claude").id).toBe("codex-cli");
    expect(selectCliAdapter("codex").id).toBe("claude-cli");
    expect(selectCliAdapter("antigravity").id).toBe("claude-cli");
    expect(projectError(() => selectCliAdapter("unknown" as HostIdentity))).toMatchObject({ code: "UNSUPPORTED_HOST", diagnostic: { parameters: { host: "unknown" } } });
  });

  it("follows the resolved route's adapter for any family", () => {
    expect(selectCliAdapter("claude", { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" }).id).toBe("claude-cli");
    expect(selectCliAdapter("codex", { adapter: "codex-cli", family: "codex", model: "gpt-5.4", effort: "high" }).id).toBe("codex-cli");
    expect(selectCliAdapter("antigravity", { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" }).id).toBe("antigravity-cli");
    expect(projectError(() => selectCliAdapter("unknown" as HostIdentity, { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" })))
      .toMatchObject({ code: "UNSUPPORTED_HOST", diagnostic: { parameters: { host: "unknown" } } });
  });
});

describe("dispatch serialization", () => {
  it("runs globally in FIFO order without concurrent overlap", async () => {
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const operation = (id: number): Promise<number> => serializeDispatch(async () => {
      events.push(`start-${id}`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      events.push(`end-${id}`);
      return id;
    });

    const first = operation(1);
    const second = operation(2);
    const third = operation(3);
    await vi.waitFor(() => expect(events).toEqual(["start-1"]));
    releases.shift()!();
    await vi.waitFor(() => expect(events).toEqual(["start-1", "end-1", "start-2"]));
    releases.shift()!();
    await vi.waitFor(() => expect(events).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3"]));
    releases.shift()!();

    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    expect(maximumActive).toBe(1);
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("preserves rejection identity and does not poison later operations", async () => {
    const failure = new Error("dispatch failed");
    const events: string[] = [];
    const rejected = serializeDispatch(async () => {
      events.push("reject");
      throw failure;
    });
    const recoveredValue = Object.freeze({ ok: true });
    const recovered = serializeDispatch(async () => {
      events.push("recover");
      return recoveredValue;
    });

    await expect(rejected).rejects.toBe(failure);
    await expect(recovered).resolves.toBe(recoveredValue);
    expect(events).toEqual(["reject", "recover"]);
  });
});

describe("CLI invocation construction", () => {
  it("builds the pinned Claude argv with inline schema and no implicit defaults", async () => {
    const target = await workspace();
    const route: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" };
    const invocation = await selectCliAdapter("codex")
      .buildInvocation(envelope, route, target, reviewSchema);
    expect(invocation.argv.slice(0, 5)).toEqual(["-p", "--safe-mode", "--tools", "", "--disable-slash-commands"]);
    expect(invocation.argv).toContain("--setting-sources");
    expect(invocation.argv).not.toContain("--bare");
    expect(invocation.argv).not.toContain("--permission-mode");
    const schema = invocation.argv[invocation.argv.indexOf("--json-schema") + 1]!;
    expect(schema.startsWith("/")).toBe(false);
    expect(() => JSON.parse(schema)).not.toThrow();
    expect(invocation.stdin).toEqual(envelope.bytes);
  });

  it("wraps the Claude launch through cc-switch only when a route names a provider", async () => {
    const target = await workspace();
    const adapter = selectCliAdapter("codex");
    const plainRoute: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" };
    const providerRoute: DispatchRoute = { ...plainRoute, provider: "zai" };

    const plain = await adapter.buildInvocation(envelope, plainRoute, target, reviewSchema);
    expect(plain.command).toBe("claude");
    expect(plain.env).toBe(target.env);

    const wrapped = await adapter.buildInvocation(envelope, providerRoute, target, reviewSchema);
    expect(wrapped.command).toBe("cc-switch");
    expect(wrapped.argv.slice(0, 4)).toEqual(["start", "claude", "zai", "--"]);
    // The full lockdown argv rides unchanged after the `--` separator.
    expect(wrapped.argv.slice(4)).toEqual([...plain.argv]);
    expect(wrapped.cwd).toBe(plain.cwd);
    expect(wrapped.stdin).toEqual(plain.stdin);
    // The wrap prepends the user's ~/.local/bin so the cc-switch binary stays reachable.
    const localBin = join(target.env.HOME!, ".local", "bin");
    expect(wrapped.env.PATH?.split(":")[0]).toBe(localBin);
    expect(wrapped.env.PATH).not.toBe(plain.env.PATH);
  });

  it("builds the pinned Codex argv with schema/output paths and exact suppressions", async () => {
    const target = await workspace();
    const route: DispatchRoute = { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "xhigh" };
    const invocation = await selectCliAdapter("claude").buildInvocation(envelope, route, target, reviewSchema);
    await expect(selectCliAdapter("claude").buildInvocation(
      envelope,
      { ...route, provider: "zai" } as DispatchRoute,
      target,
      reviewSchema,
    )).rejects.toMatchObject({ project_error: { code: "CONFIG_INVALID", diagnostic: { parameters: { issue_code: "provider-unsupported" } } } });
    expect(invocation.argv.slice(0, 6)).toEqual(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--strict-config"]);
    expect(invocation.argv).toContain("--output-schema");
    expect(invocation.argv).toContain("-o");
    expect(invocation.argv).toContain('model_reasoning_effort="xhigh"');
    expect(invocation.argv).not.toContain("forced_login_method");
    expect(invocation.argv).not.toContain("view_image");
    expect(invocation.argv.filter((item) => item === "--disable")).toHaveLength(14);
    expect(JSON.parse(await readFile(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]!, "utf8"))).toMatchObject({ type: "object" });
    expect(invocation.final_output_path).toBe(invocation.argv[invocation.argv.indexOf("-o") + 1]);
  });

  it("runs the Claude child inside the repository view with only read-only tools", async () => {
    const target = await workspace();
    const viewed: DispatchWorkspace = Object.freeze({ ...target, repository_view_root: join(target.root, "repo") });
    const route: DispatchRoute = { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" };
    const adapter = selectCliAdapter("codex");

    const bare = await adapter.buildInvocation(envelope, route, target, reviewSchema);
    expect(bare.cwd).toBe(target.root);
    expect(bare.argv[bare.argv.indexOf("--tools") + 1]).toBe("");

    const invocation = await adapter.buildInvocation(envelope, route, viewed, reviewSchema);
    expect(invocation.cwd).toBe(viewed.repository_view_root);
    expect(invocation.argv[invocation.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    for (const pinned of ["--safe-mode", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) {
      expect(invocation.argv).toContain(pinned);
    }
    expect(invocation.argv[invocation.argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(invocation.argv[invocation.argv.indexOf("--mcp-config") + 1]).toBe(join(target.root, "empty-mcp.json"));
  });

  it("points the Codex sandbox at the repository view while outputs stay outside it", async () => {
    const target = await workspace();
    const viewed: DispatchWorkspace = Object.freeze({ ...target, repository_view_root: join(target.root, "repo") });
    const route: DispatchRoute = { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" };
    const adapter = selectCliAdapter("claude");

    const bare = await adapter.buildInvocation(envelope, route, target, reviewSchema);
    expect(bare.argv[bare.argv.indexOf("-C") + 1]).toBe(target.root);

    const invocation = await adapter.buildInvocation(envelope, route, viewed, reviewSchema);
    expect(invocation.argv[invocation.argv.indexOf("-C") + 1]).toBe(viewed.repository_view_root);
    expect(invocation.argv).toContain("-s");
    expect(invocation.argv[invocation.argv.indexOf("-s") + 1]).toBe("read-only");
    expect(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]).toBe(join(target.root, "review.schema.json"));
    expect(invocation.argv[invocation.argv.indexOf("-o") + 1]).toBe(join(target.root, "review-final-output.json"));
    expect(invocation.argv).toContain("project_doc_max_bytes=0");
  });

  it.each([
    ["claude", "claude-cli"],
    ["codex", "codex-cli"],
  ] as const)("passes the projected adjudication host schema through the %s adapter", async (_name, id) => {
    const target = await workspace();
    const adapter = id === "claude-cli"
      ? selectCliAdapter("codex")
      : selectCliAdapter("claude");
    const route: DispatchRoute = id === "claude-cli"
      ? { adapter: id, family: "claude", model: "claude-opus-4-6", effort: "high" }
      : { adapter: id, family: "codex", model: "gpt-5.3-codex", effort: "high" };
    const adjudicationEnvelope: DispatchEnvelope = { ...envelope, result_kind: "adjudication" };
    const invocation = await adapter.buildInvocation(adjudicationEnvelope, route, target, adjudicationSchema);
    const schemaText = id === "claude-cli"
      ? invocation.argv[invocation.argv.indexOf("--json-schema") + 1]!
      : await readFile(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]!, "utf8");
    const parsed = JSON.parse(schemaText) as Record<string, unknown>;

    expect(schemaText).not.toMatch(/(?:"\$schema"|"\$id"|"allOf"|"x-archflow-)/u);
    expect(parsed).toEqual(projectCliOutputSchema(adjudicationSchema as PlainJsonValue, "adjudication", id));
    expect(parsed).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: adjudicationSchema.required,
    });
    const properties = parsed.properties as Record<string, unknown>;
    for (const derived of ["constitution", "drift", "matched_rule_versions", "uncertain_rule_versions"]) {
      expect(properties).not.toHaveProperty(derived);
    }
    if (id === "codex-cli") {
      expect(invocation.argv[invocation.argv.indexOf("--output-schema") + 1]).toMatch(/adjudication\.schema\.json$/u);
      // The codex state-branch expansion existed only for per-mechanism evidence, which findings
      // no longer carry; the adjudication document needs no adapter-specific rewrite at all.
      expect(parsed.$defs as Record<string, unknown>).not.toHaveProperty("mechanical");
    } else {
      expect(schemaText).not.toMatch(/"(?:minimum|maximum|minLength|minItems|maxItems|uniqueItems)"/u);
    }
  });

  it("projects review schema keywords without mutating or inventing an unbound review identity", () => {
    const before = structuredClone(reviewSchema);
    const projected = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "codex-cli") as Record<string, unknown>;
    const properties = projected.properties as Record<string, unknown>;

    expect(reviewSchema).toEqual(before);
    expect(JSON.stringify(projected)).not.toMatch(/(?:"\$schema"|"\$id"|"allOf"|"x-archflow-)/u);
    expect(projected).toMatchObject({
      type: "object",
      additionalProperties: false,
      // Codex strict mode requires every declared root property. Role unions remain below the
      // root; an assigned envelope replaces this publication schema with one exact role branch.
      required: Object.keys(properties),
    });
    expect(projected).not.toHaveProperty("oneOf");
    expect(projected).not.toHaveProperty("anyOf");
    expect(properties).toMatchObject({
      step: { const: "counter_review" },
      role: { type: "string", enum: ["counter-review"] },
    });
    const definitions = projected.$defs as Record<string, Record<string, unknown>>;
    expect(definitions.taskSlug).toMatchObject({
      type: "string",
      pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
    });
    expect(definitions.id).toMatchObject({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
    const finding = definitions.finding!;
    expect(finding).toMatchObject({ type: "object", additionalProperties: false });
    expect(finding.required).toEqual(Object.keys(finding.properties as Record<string, unknown>));
    expect(finding.properties).toMatchObject({
      claim_type: { enum: ["defect", "risk", "gap", "preference"] },
      confidence: { enum: ["certain", "likely", "suspicion"] },
      falsifier: { maxLength: 4096 },
    });
    expect(JSON.stringify(projected)).toMatch(/"pattern"/u);
    expect(JSON.stringify(projected)).toMatch(/"maxLength":4096/u);
  });

  it("binds host-visible review identity fields to the server-derived envelope subject", () => {
    const subject = Object.fromEntries([
      "task_id", "phase_instance", "step", "role", "subject_digest", "input_fingerprint", "rubric_digest", "producer_family",
    ].map((key) => [key, validReview[key as keyof typeof validReview]])) as Record<string, PlainJsonValue>;
    const projected = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "claude-cli", subject) as Record<string, unknown>;
    const properties = projected.properties as Record<string, Record<string, unknown>>;

    for (const [key, value] of Object.entries(subject)) expect(properties[key]).toEqual({ const: value });
  });

  it.each(["claude-cli", "codex-cli", "antigravity-cli"] as const)(
    "projects a plain strict test-review root with exact assigned criteria for %s",
    (adapter) => {
      const projected = projectCliOutputSchema(
        reviewSchema as PlainJsonValue,
        "review",
        adapter,
        {},
        { reviewer_id: "test", focus: "tests", criterion_ids: ["verification-evidence", "test-quality"] },
      ) as Record<string, unknown>;
      expect(projected).toMatchObject({ type: "object", additionalProperties: false });
      expect(projected).not.toHaveProperty("oneOf");
      expect(projected).not.toHaveProperty("anyOf");
      const properties = projected.properties as Record<string, Record<string, unknown>>;
      expect(Object.keys(properties)).toEqual([
        "schema_version", "task_id", "phase_instance", "step", "role", "subject_digest",
        "input_fingerprint", "rubric_digest", "producer_family", "findings",
      ]);
      const finding = properties.findings!.items as Record<string, unknown>;
      expect(Object.keys(finding.properties as Record<string, unknown>)).toEqual([
        "finding_id", "criterion_id", "claim_type", "confidence", "falsifier",
        "required_behavior_or_risk_boundary", "coverage_or_oracle_problem", "consequence",
        "proposed_verification_change",
      ]);
      expect((finding.properties as Record<string, unknown>).criterion_id).toMatchObject({
        enum: ["verification-evidence", "test-quality"],
      });
    },
  );

  it("projects present zero-upstream alignment and confirmation-only responsibilities", () => {
    const alignment = projectCliOutputSchema(
      reviewSchema as PlainJsonValue,
      "review",
      "codex-cli",
      {},
      { reviewer_id: "general", focus: "general", criterion_ids: [], expected_upstream_digests: [] },
    ) as Record<string, unknown>;
    const alignmentProperties = alignment.properties as Record<string, Record<string, unknown>>;
    expect(alignmentProperties).toHaveProperty("upstream_alignment");
    expect(alignmentProperties.findings).toMatchObject({ maxItems: 0 });

    const confirmation = projectCliOutputSchema(
      reviewSchema as PlainJsonValue,
      "review",
      "codex-cli",
      {},
      {
        reviewer_id: "test",
        focus: "tests",
        criterion_ids: [],
        legacy_confirmations: [{ finding_id: "old-finding", criterion_ids: ["test-quality"] }],
      },
    ) as Record<string, unknown>;
    const confirmationProperties = confirmation.properties as Record<string, Record<string, unknown>>;
    expect(confirmationProperties.findings).toMatchObject({ maxItems: 0 });
    expect(confirmationProperties).toHaveProperty("legacy_confirmations");
    expect(confirmationProperties).not.toHaveProperty("upstream_alignment");
  });

  it.each(["claude-cli", "codex-cli", "antigravity-cli"] as const)(
    "preserves exact constitution judgment slots below a plain root for %s",
    (adapter) => {
      const judgment = {
        type: "object",
        properties: {
          compliance: { type: "string", enum: ["pass", "fail", "uncertain"] },
          rationale: { type: "string" },
          trigger: { type: "string", enum: ["not-matched", "matched", "uncertain"] },
          trigger_evidence: { type: "string" },
        },
        required: ["compliance", "rationale", "trigger", "trigger_evidence"],
        additionalProperties: false,
      } as const;
      const schema = {
        type: "object",
        properties: {
          schema_version: { type: "string", const: "2" },
          judgments: {
            type: "object",
            properties: { "rule-slot-1": judgment, "rule-slot-2": judgment },
            required: ["rule-slot-1", "rule-slot-2"],
            additionalProperties: false,
          },
        },
        required: ["schema_version", "judgments"],
        additionalProperties: false,
      } as const;
      const projected = projectCliOutputSchema(
        schema,
        "adjudication",
        adapter,
        { task_id: "must-not-be-added", subject_digest: "a".repeat(64) },
      ) as Record<string, unknown>;
      expect(projected).toMatchObject({ type: "object", additionalProperties: false });
      expect(projected).not.toHaveProperty("oneOf");
      expect(projected).not.toHaveProperty("anyOf");
      const properties = projected.properties as Record<string, Record<string, unknown>>;
      expect(Object.keys(properties)).toEqual(["schema_version", "judgments"]);
      expect(Object.keys((properties.judgments!.properties as Record<string, unknown>)))
        .toEqual(["rule-slot-1", "rule-slot-2"]);
    },
  );

  it.each(["claude-cli", "codex-cli"] as const)(
    "binds the effort selector output identities for %s",
    (adapter) => {
      const values = {
        task_id: "effort-review",
        phase_instance: "phase-design-1",
        subject_digest: "1".repeat(64),
        input_fingerprint: "2".repeat(64),
        policy_id: "implementation-agent-selector-v2",
      } as const;
      const subject: Record<string, PlainJsonValue> = {
        task_id: values.task_id,
        phase_instance: values.phase_instance,
        subject_digest: values.subject_digest,
        input_fingerprint: values.input_fingerprint,
        policy_id: values.policy_id,
      };
      const projected = projectCliOutputSchema(
        effortReviewSchema as PlainJsonValue,
        "effort-review",
        adapter,
        subject,
      ) as Record<string, unknown>;
      const properties = projected.properties as Record<string, Record<string, unknown>>;
      for (const [key, value] of Object.entries(values)) {
        expect(properties[key], key).toMatchObject({ const: value });
      }
    },
  );

  it("projects a strict profile-only effort selector schema for Codex", () => {
    const projected = projectCliOutputSchema(
      effortReviewSchema as PlainJsonValue,
      "effort-review",
      "codex-cli",
    ) as Record<string, unknown>;

    // Must not contain oneOf anywhere (OpenAI Structured Outputs restriction)
    expect(JSON.stringify(projected)).not.toContain('"oneOf"');
    // Must not contain any external URN references
    expect(JSON.stringify(projected)).not.toContain("urn:archflow:");
    // Definitions must include simplified taskSlug
    const definitions = projected.$defs as Record<string, Record<string, unknown>>;
    expect(definitions.taskSlug).toMatchObject({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" });

    const validateProjected = createJsonSchemaValidator<Record<string, unknown>>(projected);
    const sampleOutput = {
      schema_version: "2",
      task_id: "test-task",
      phase_instance: "phase-design-1",
      step: "effort_review",
      role: "effort-reviewer",
      subject_digest: "a".repeat(64),
      input_fingerprint: "b".repeat(64),
      policy_id: "implementation-agent-selector-v2",
      profile_id: "gpt-5-6-sol-medium",
    };
    expect(() => validateProjected.assert(sampleOutput, "sample effort review")).not.toThrow();

    expect(() => validateProjected.assert({ ...sampleOutput, rationale: "not allowed" }, "extra selector work")).toThrow();
  });

  it("keeps Claude-supported simple patterns while simplifying only the task-slug lookahead", () => {
    const projected = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "claude-cli") as Record<string, unknown>;
    const definitions = projected.$defs as Record<string, Record<string, unknown>>;
    expect(definitions.id).toMatchObject({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
    expect(definitions.digest).toMatchObject({ pattern: "^[0-9a-f]{64}$" });
    expect(definitions.nonBlank).toMatchObject({ pattern: "\\S" });
    expect(definitions.phaseInstance).toMatchObject({ pattern: "^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$" });
    expect(definitions.taskSlug).toMatchObject({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" });
    expect(JSON.stringify(projected)).not.toContain("(?!");
    const finding = definitions.finding!;
    expect(finding).toMatchObject({ type: "object", additionalProperties: false });
    expect(finding.required).toEqual(Object.keys(finding.properties as Record<string, unknown>));
    expect(finding.properties).toMatchObject({
      claim_type: { enum: ["defect", "risk", "gap", "preference"] },
      confidence: { enum: ["certain", "likely", "suspicion"] },
      falsifier: expect.not.objectContaining({ maxLength: expect.anything() }),
    });

    const validateProjected = createJsonSchemaValidator<Record<string, unknown>>(projected);
    const invalid = structuredClone(validReview) as Record<string, unknown>;
    const findings = invalid.findings as Array<Record<string, unknown>>;
    findings[0]!.finding_id = "Invalid Finding Id";
    expect(() => validateProjected.assert(invalid, "Claude projected finding id")).toThrow();
    findings[0]!.finding_id = "valid-finding-id";
    findings[0]!.severity = "major";
    expect(() => validateProjected.assert(invalid, "Claude projected legacy finding field")).toThrow();
  });

  it("keeps normative semantic rejection after the host transport projection", () => {
    const projectedReview = projectCliOutputSchema(reviewSchema as PlainJsonValue, "review", "codex-cli");
    const validateProjectedReview = createJsonSchemaValidator<Record<string, unknown>>(projectedReview as Record<string, unknown>);
    const invalidFinding = structuredClone(validReview) as Record<string, unknown>;
    const invalidFindingItems = invalidFinding.findings as Array<Record<string, unknown>>;
    invalidFindingItems[0]!.blocking = false;
    expect(() => validateProjectedReview.assert(invalidFinding, "projected review finding")).toThrow();
    delete invalidFindingItems[0]!.blocking;
    invalidFindingItems[0]!.finding_id = "Invalid Finding Id";
    expect(() => validateProjectedReview.assert(invalidFinding, "projected review finding id")).toThrow();

    const assignment = {
      reviewer_id: "general",
      focus: "general",
      criterion_ids: ["substantive-correctness"],
    } as const;
    const invalidReview = {
      schema_version: "3",
      task_id: "mcp-integration",
      phase_instance: "phase-impl-2",
      step: "counter_review",
      role: "counter-review",
      subject_digest: "a".repeat(64),
      input_fingerprint: "b".repeat(64),
      rubric_digest: "c".repeat(64),
      producer_family: "claude",
      findings: [{
        finding_id: "unsafe-path",
        criterion_id: "substantive-correctness",
        claim_type: "defect",
        confidence: "certain",
        falsifier: "x".repeat(4097),
        summary: "Path is unsafe.",
        evidence: "The path escapes its task.",
        suggested_resolution: "Reject traversal.",
      }],
    };
    const projectedClaudeReview = projectCliOutputSchema(
      reviewSchema as PlainJsonValue, "review", "claude-cli", undefined, assignment,
    );
    const validateProjectedClaudeReview = createJsonSchemaValidator<Record<string, unknown>>(projectedClaudeReview as Record<string, unknown>);
    expect(() => validateProjectedClaudeReview.assert(invalidReview, "projected review")).not.toThrow();
    expect(() => parseGeneralReviewOutputV3(invalidReview, {
      criterion_ids: assignment.criterion_ids,
    })).toThrow();
  });
});

describe("CLI output contracts and failure classification", () => {
  it("extracts and canonically re-encodes only Claude structured_output", () => {
    const adapter = selectCliAdapter("codex");
    const structured = { schema_version: "1", verdict: "pass" };
    expect(adapter.parseOutput(result({ stdout: bytes(JSON.stringify({ result: "ignored", structured_output: structured })) })))
      .toEqual(canonicalJsonBytes(structured));
    expect(projectError(() => adapter.parseOutput(result({ stdout: bytes("not-json") })))).toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("returns exact Codex final-output bytes and rejects missing/invalid files", () => {
    const adapter = selectCliAdapter("claude");
    const final = bytes('{"schema_version":"1"}\n');
    expect(Buffer.from(adapter.parseOutput(result({ final_output: final })))).toEqual(final);
    expect(projectError(() => adapter.parseOutput(result()))).toMatchObject({ code: "MODEL_OUTPUT_INVALID", diagnostic: { parameters: { issue_code: "final-output-missing" } } });
    expect(projectError(() => adapter.parseOutput(result({ final_output: bytes("bad") })))).toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("classifies Codex only from valid fatal events, deduplicating paired events", () => {
    const adapter = selectCliAdapter("claude");
    const message = "rate limit exceeded";
    const paired = bytes(`${JSON.stringify({ type: "error", message })}\n${JSON.stringify({ type: "turn.failed", error: { message } })}\n`);
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: paired }))).toMatchObject({ code: "RATE_LIMITED", diagnostic: { parameters: { adapter: "codex-cli", attempt: 1 } } });
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: bytes('{"type":"notice","message":"rate limit"}\n'), stderr: bytes("rate limit exceeded") })))
      .toMatchObject({ code: "PROCESS_FAILED", diagnostic: { parameters: { exit_class: "exit-1" } } });
  });

  it.each([
    ["auth", "Authentication required", "AUTH_UNAVAILABLE"],
    ["model", "Model 'gpt-unknown-codex' is not found", "UNSUPPORTED_MODEL"],
    ["current model", "The 'gpt-unknown-codex' model is not supported when using Codex with a ChatGPT account", "UNSUPPORTED_MODEL"],
    ["rate", "Too many requests", "RATE_LIMITED"],
  ])("classifies %s failures with schema-safe parameters", (_label, message, code) => {
    const event = bytes(`${JSON.stringify({ type: "turn.failed", error: { message } })}\n`);
    expect(() => selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).not.toThrow();
    expect(selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).toMatchObject({ code });
  });

  it("falls back safely when an unsupported-model message contains a non-SafeId slug", () => {
    const event = bytes(`${JSON.stringify({ type: "error", message: "Model 'openai/gpt-5' is not found" })}\n`);
    expect(() => selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).not.toThrow();
    expect(selectCliAdapter("claude").classifyFailure(result({ exit_code: 1, stdout: event }))).toMatchObject({ code: "PROCESS_FAILED" });
  });

  it("ignores Claude stderr warnings and uses only an error wrapper for semantics", () => {
    const adapter = selectCliAdapter("codex");
    expect(adapter.classifyFailure(result({ stderr: bytes("deprecated model: rate limit wording") }))).toBeUndefined();
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: bytes(JSON.stringify({ is_error: true, result: "Login required" })) })))
      .toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(adapter.classifyFailure(result({ exit_code: 1, stdout: bytes(JSON.stringify({
      is_error: true,
      terminal_reason: "api_error",
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    })) }))).toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });

  it("extracts and canonically re-encodes Antigravity structured_output", async () => {
    const adapter = selectCliAdapter("antigravity", {
      adapter: "antigravity-cli",
      family: "gemini",
      model: "gemini-3.7-flash-high",
      effort: "high",
    });
    const structured = { schema_version: "1", verdict: "pass" };
    // stream-json output: progress events precede the final result event, which carries the wrapper.
    const stream = [
      JSON.stringify({ event: "init", init: { model: "gemini-3.7-flash-high" } }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "{}" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", structured_output: structured } }),
    ].join("\n");
    expect(adapter.parseOutput(result({ stdout: bytes(`${stream}\n`) }))).toEqual(canonicalJsonBytes(structured));
    // A bare single-object wrapper (the `--output-format json` shape) stays readable.
    expect(adapter.parseOutput(result({
      stdout: bytes(JSON.stringify({ status: "SUCCESS", structured_output: structured })),
    }))).toEqual(canonicalJsonBytes(structured));

    expect(projectError(() => adapter.parseOutput(result({
      stdout: bytes(`${JSON.stringify({ event: "result", result: { status: "ERROR" } })}\n`),
    })))).toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      diagnostic: { parameters: { issue_code: "structured-output-missing" } },
    });
    expect(projectError(() => adapter.parseOutput(result({
      stdout: bytes(`${JSON.stringify({ event: "init", init: {} })}\n`),
    })))).toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      diagnostic: { parameters: { issue_code: "antigravity-wrapper-invalid" } },
    });
    expect(adapter.classifyFailure(result({
      exit_code: 1,
      stdout: bytes(`${JSON.stringify({ event: "result", result: { status: "ERROR", error: "Authentication required" } })}\n`),
    }))).toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });

  it("builds Antigravity CLI invocation with exact arguments and flags", async () => {
    const adapter = selectCliAdapter("antigravity", {
      adapter: "antigravity-cli",
      family: "gemini",
      model: "gemini-3.7-flash-high",
      effort: "high",
    });
    const ws = await workspace();
    const inv = await adapter.buildInvocation(
      envelope,
      { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" },
      ws,
      reviewSchema as PlainJsonValue,
    );

    expect(inv.command).toBe("agy");
    expect(inv.argv).toContain("-p");
    expect(inv.argv).toContain("--input-format");
    expect(inv.argv).toContain("stream-json");
    expect(inv.argv).toContain("--output-format");
    expect(inv.argv).toContain("--json-schema");
    expect(inv.argv).toContain("--model");
    expect(inv.argv).toContain("gemini-3.7-flash-high");
    expect(inv.argv).toContain("--effort");
    expect(inv.argv).toContain("high");
    expect(inv.argv).toContain("--disable-slash-commands");
    expect(inv.argv).toContain("--dangerously-skip-permissions");

    // The envelope rides on stdin as one stream-json user message, never on argv; the schema is
    // a workspace file. Neither can then grow past the per-element argv limit.
    const promptText = envelope.bytes.toString();
    expect(inv.argv.some((element) => element.includes(promptText))).toBe(false);
    const lines = Buffer.from(inv.stdin ?? new Uint8Array()).toString("utf8").split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ event: "user", message: { role: "user", content: promptText } });
    const schemaPath = inv.argv[inv.argv.indexOf("--json-schema") + 1]!;
    expect(schemaPath.startsWith(ws.root)).toBe(true);
    expect(JSON.parse(await readFile(schemaPath, "utf8"))).toMatchObject({ type: "object" });
  });

  it.each([
    { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" },
    { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" },
  ] as const)("keeps every $adapter argv element bounded and preserves the exact 300 KiB envelope payload", async (route) => {
    const adapter = selectCliAdapter("claude", route);
    const large: DispatchEnvelope = Object.freeze({
      ...envelope,
      bytes: bytes(JSON.stringify({ schema_version: "1", subject: {}, artifact: "x".repeat(300 * 1024) })),
      byte_count: 300 * 1024 + 48,
    });
    const inv = await adapter.buildInvocation(
      large,
      route,
      await workspace(),
      reviewSchema as PlainJsonValue,
    );
    expect(inv.argv.every((element) => Buffer.byteLength(element, "utf8") < MAX_ARGV_ELEMENT_BYTES)).toBe(true);
    expect(inv.stdin?.byteLength ?? 0).toBeGreaterThan(300 * 1024);
    const promptText = new TextDecoder().decode(large.bytes);
    expect(inv.argv.some((element) => element.includes(promptText))).toBe(false);
    if (route.adapter === "antigravity-cli") {
      const line = Buffer.from(inv.stdin!).toString("utf8").trim();
      expect(JSON.parse(line)).toEqual({ event: "user", message: { role: "user", content: promptText } });
    } else {
      expect(inv.stdin).toEqual(large.bytes);
    }
  });

  it("fails an oversized Claude-only inline schema before spawn with a named error", async () => {
    const adapter = selectCliAdapter("codex", {
      adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high",
    });
    const oversizedSchema = {
      type: "object",
      description: "x".repeat(MAX_ARGV_ELEMENT_BYTES),
      properties: {},
      required: [],
      additionalProperties: false,
    } as const;
    await expect(adapter.buildInvocation(
      envelope,
      { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" },
      await workspace(),
      oversizedSchema,
    )).rejects.toMatchObject({
      project_error: {
        code: "PROCESS_FAILED",
        diagnostic: { parameters: { adapter: "claude-cli", exit_class: "argument-list-too-long" } },
      },
    });
  });
});
