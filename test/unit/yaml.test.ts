import { describe, expect, it } from "vitest";
import { parseSingleYamlDocument } from "../../src/contracts/index.js";

describe("safe YAML parsing", () => {
  it("parses one YAML 1.2 document into a plain JSON value", () => {
    const result = parseSingleYamlDocument("enabled: true\nlegacy_word: yes\nitems:\n  - 1\n  - null\n", "config.yaml");
    expect(result).toEqual({ enabled: true, legacy_word: "yes", items: [1, null] });
  });

  it("rejects duplicate keys with label and location", () => {
    expect(() => parseSingleYamlDocument("name: first\nname: second\n", "workflow.yaml")).toThrow(
      /workflow\.yaml:\d+:\d+.*unique|workflow\.yaml:\d+:\d+.*map key/iu
    );
  });

  it("reports useful Unicode-aware line and column diagnostics", () => {
    try {
      parseSingleYamlDocument("title: café ☕\nitems: [one, two\n", "unicode.yaml");
      throw new Error("expected malformed YAML to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError);
      expect(String(error)).toMatch(/unicode\.yaml:\d+:\d+/u);
    }
  });

  it.each([
    ["multiple documents", "one: 1\n---\ntwo: 2\n", /exactly one/iu],
    ["aliases", "base: &base\n  ok: true\ncopy: *base\n", /alias/iu],
    ["custom tags", "value: !custom hello\n", /tag/iu]
  ])("rejects %s", (_name, source, message) => {
    expect(() => parseSingleYamlDocument(source, "unsafe.yaml")).toThrow(message);
  });

  it("does not mutate or reuse parser state across calls", () => {
    const source = "nested:\n  value: 1\n";
    const first = parseSingleYamlDocument(source, "first.yaml") as { nested: { value: number } };
    first.nested.value = 2;
    expect(parseSingleYamlDocument(source, "second.yaml")).toEqual({ nested: { value: 1 } });
  });
});
