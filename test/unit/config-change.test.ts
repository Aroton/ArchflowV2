import { describe, expect, it } from "vitest";

import { parseConfigYaml, type TaskConfigSnapshot } from "../../src/contracts/config.js";
import type { RepositorySet } from "../../src/repository/repository-set.js";
import { computeConfigChange, normalizeForChangeDetection, withLastSeenConfig } from "../../src/state/config-change.js";

/** parseConfigYaml's zod output carries `| undefined` optionals; the snapshot type strips them. */
const parseSnapshot = (source: string, label: string): TaskConfigSnapshot => parseConfigYaml(source, label) as TaskConfigSnapshot;

describe("computeConfigChange", () => {
  it("reports nested object leaves with dot-separated paths", () => {
    const before = parseSnapshot([
      "schema_version: \"1\"",
      "roles:",
      "  counter-reviewer: { model: gpt-example, effort: high }",
      "  adjudicator: { model: claude-example, effort: high }",
    ].join("\n"), "before");
    const after = parseSnapshot([
      "schema_version: \"1\"",
      "roles:",
      "  counter-reviewer: { model: gpt-replacement, effort: high }",
      "  adjudicator: { model: claude-example, effort: max }",
    ].join("\n"), "after");

    expect(computeConfigChange(before, after)).toEqual([
      { path: "roles.adjudicator.effort", before: "high", after: "max" },
      { path: "roles.counter-reviewer.model", before: "gpt-example", after: "gpt-replacement" },
    ]);
  });

  it("reports added and removed leaves on the absent side only", () => {
    const before = parseSnapshot([
      "schema_version: \"1\"",
      "roles: {}",
      "max_attempts: 3",
    ].join("\n"), "before");
    const after = parseSnapshot([
      "schema_version: \"1\"",
      "roles:",
      "  counter-reviewer: { model: gpt-example, effort: high }",
    ].join("\n"), "after");

    expect(computeConfigChange(before, after)).toEqual([
      { path: "max_attempts", before: 3 },
      { path: "roles.counter-reviewer", after: { model: "gpt-example", effort: "high" } },
    ]);
  });

  it("addresses array items by index, including inside nested objects", () => {
    // The config schema itself has no arrays, but the diff must stay correct for any plain-JSON
    // leaf structure it is handed; these fixtures exercise the generic array walk directly.
    const before = { schema_version: "1", roles: {}, content: [{ paths: ["a", "b"] }, { paths: ["c"] }] } as unknown as TaskConfigSnapshot;
    const after = { schema_version: "1", roles: {}, content: [{ paths: ["a", "changed"] }, { paths: [] }, { paths: ["new"] }] } as unknown as TaskConfigSnapshot;

    expect(computeConfigChange(before, after)).toEqual([
      { path: "content.0.paths.1", before: "b", after: "changed" },
      { path: "content.1.paths.0", before: "c" },
      { path: "content.2", after: { paths: ["new"] } },
    ]);
  });

  it("produces no entries for comment-only and reorder-equivalent YAML bytes", () => {
    const plain = [
      "schema_version: \"1\"",
      "roles:",
      "  counter-reviewer: { model: gpt-example, effort: high }",
      "  adjudicator: { model: claude-example, effort: high }",
      "max_attempts: 3",
    ].join("\n");
    // Same structure: reordered keys, flow style collapsed differently, comments added.
    const commented = [
      "# A comment the parser ignores.",
      "max_attempts: 3",
      "schema_version: \"1\"",
      "roles:",
      "  adjudicator:",
      "    effort: high  # trailing comment",
      "    model: claude-example",
      "  counter-reviewer: { effort: high, model: gpt-example }",
    ].join("\n");
    expect(commented).not.toBe(plain);

    const before = parseSnapshot(plain, "plain");
    const after = parseSnapshot(commented, "commented");
    expect(computeConfigChange(before, after)).toEqual([]);
  });

  it("reports repository removal, relocation, and mode edits at their declaring fields", () => {
    const before = parseSnapshot([
      'schema_version: "1"',
      "roles: {}",
      "repositories:",
      "  apis:",
      "    path: ../apis",
      "  stripe:",
      "    path: ../stripe-old",
      "    mode: context-only",
    ].join("\n"), "before repository edit");
    const after = parseSnapshot([
      'schema_version: "1"',
      "roles: {}",
      "repositories:",
      "  stripe:",
      "    path: ../stripe",
      "    mode: writable",
    ].join("\n"), "after repository edit");

    expect(computeConfigChange(before, after)).toEqual([
      { path: "repositories.apis", before: { path: "../apis" } },
      { path: "repositories.stripe.mode", before: "context-only", after: "writable" },
      { path: "repositories.stripe.path", before: "../stripe-old", after: "../stripe" },
    ]);
  });

  it("treats repository map key order as non-semantic", () => {
    const apisFirst = parseSnapshot([
      'schema_version: "1"',
      "roles: {}",
      "repositories:",
      "  apis: { path: ../apis }",
      "  stripe: { path: ../stripe, mode: writable }",
    ].join("\n"), "apis first");
    const stripeFirst = parseSnapshot([
      'schema_version: "1"',
      "repositories:",
      "  stripe: { mode: writable, path: ../stripe }",
      "  apis: { path: ../apis }",
      "roles: {}",
    ].join("\n"), "stripe first");

    expect(computeConfigChange(apisFirst, stripeFirst)).toEqual([]);
    expect(normalizeForChangeDetection(apisFirst)).toEqual(normalizeForChangeDetection(stripeFirst));
  });

  it("drops the retired producer role before diffing so a cosmetic retire reports nothing", () => {
    const withProducer = parseSnapshot([
      "schema_version: \"1\"",
      "roles:",
      "  producer: { model: gpt-example, effort: high }",
      "  counter-reviewer: { model: gpt-example, effort: high }",
    ].join("\n"), "with producer");
    const retired = parseSnapshot([
      "schema_version: \"1\"",
      "roles:",
      "  counter-reviewer: { model: gpt-example, effort: high }",
    ].join("\n"), "retired");

    expect(computeConfigChange(withProducer, retired)).toEqual([]);
    expect(normalizeForChangeDetection(withProducer)).toEqual(retired);
    // The normalization never mutates its input.
    expect(withProducer.roles.producer).toMatchObject({ model: "gpt-example" });
    // A real change alongside the retire still reports.
    const alsoChanged = parseSnapshot([
      "schema_version: \"1\"",
      "roles:",
      "  counter-reviewer: { model: gpt-replacement, effort: high }",
    ].join("\n"), "also changed");
    expect(computeConfigChange(withProducer, alsoChanged)).toEqual([
      { path: "roles.counter-reviewer.model", before: "gpt-example", after: "gpt-replacement" },
    ]);
  });
});

describe("withLastSeenConfig", () => {
  type Draft = {
    readonly schema_version: "1";
    readonly last_seen_config?: TaskConfigSnapshot;
    readonly last_seen_repository_bindings?: readonly [{
      readonly name: "primary";
      readonly repository_identity_digest: never;
    }];
  };
  const baseline = parseSnapshot("schema_version: \"1\"\nroles: {}\n", "baseline");
  const identityDigest = "1".repeat(64) as never;
  const repositorySet = {
    members: [{ name: "primary", identity: { digest: identityDigest } }],
    digest: "2".repeat(64),
  } as unknown as RepositorySet;
  const checkpoint = [{ name: "primary" as const, repository_identity_digest: identityDigest }] as const;

  it("returns the same draft when the recorded baseline is unchanged", () => {
    const draft: Draft = {
      schema_version: "1",
      last_seen_config: baseline,
      last_seen_repository_bindings: checkpoint,
    };
    expect(withLastSeenConfig(draft, baseline, repositorySet)).toBe(draft);
  });

  it("treats a checkpoint read back with a different key order as unchanged", () => {
    // Canonical JSON persists keys sorted; a freshly built checkpoint lists them in construction
    // order. Both name the same bindings and must not rewrite the draft.
    const reordered = JSON.parse(JSON.stringify(
      [{ repository_identity_digest: identityDigest, name: "primary" }],
    )) as NonNullable<Draft["last_seen_repository_bindings"]>;
    const draft: Draft = {
      schema_version: "1",
      last_seen_config: baseline,
      last_seen_repository_bindings: reordered,
    };
    expect(Object.keys(reordered[0])).not.toEqual(Object.keys(checkpoint[0]));
    expect(withLastSeenConfig(draft, baseline, repositorySet)).toBe(draft);
  });

  it("records the normalized edited config only when it differs from the baseline", () => {
    const edited = parseSnapshot("schema_version: \"1\"\nroles: {}\nmax_attempts: 4\n", "edited");
    const draft: Draft = { schema_version: "1", last_seen_config: baseline };
    const updated = withLastSeenConfig(draft, edited, repositorySet);
    expect(updated).not.toBe(draft);
    expect(updated.last_seen_config).toEqual(edited);
    expect(updated.last_seen_repository_bindings).toEqual(checkpoint);
  });

  it("seeds paired config and repository checkpoints on a draft that has none", () => {
    const draft: Draft = { schema_version: "1" };
    expect(withLastSeenConfig(draft, baseline, repositorySet)).toEqual({
      ...draft,
      last_seen_config: baseline,
      last_seen_repository_bindings: checkpoint,
    });
  });
});
