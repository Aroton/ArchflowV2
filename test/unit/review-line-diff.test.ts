import { describe, expect, it } from "vitest";

import { DIFF_CONTEXT_LINES, diffLines, formatUnifiedHunks } from "../../src/review/line-diff.js";

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const segments = text.split("\n");
  const last = segments.pop()!;
  const lines = segments.map((segment) => `${segment}\n`);
  if (last !== "") lines.push(last);
  return lines;
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** Strict unified-patch applier: verifies context and deletions against `before` as it goes. */
function applyUnifiedHunks(before: string, patch: string): string {
  const beforeLines = splitLines(before);
  const result: string[] = [];
  let cursor = 0;
  const rawLines = patch.length === 0 ? [] : patch.slice(0, -1).split("\n");
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]!;
    if (raw === NO_NEWLINE_MARKER) continue;
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(raw);
    if (header) {
      const oldStart = Number(header[1]);
      const oldCount = Number(header[2]);
      const copyUntil = oldCount === 0 ? oldStart : oldStart - 1;
      while (cursor < copyUntil) result.push(beforeLines[cursor]!), (cursor += 1);
      continue;
    }
    const unterminated = rawLines[index + 1] === NO_NEWLINE_MARKER;
    const decoded = unterminated ? raw.slice(1) : `${raw.slice(1)}\n`;
    if (raw.startsWith(" ") || raw.startsWith("-")) {
      expect(beforeLines[cursor]).toBe(decoded);
      cursor += 1;
      if (raw.startsWith(" ")) result.push(decoded);
    } else if (raw.startsWith("+")) {
      result.push(decoded);
    } else {
      throw new Error(`unexpected patch line: ${JSON.stringify(raw)}`);
    }
  }
  while (cursor < beforeLines.length) result.push(beforeLines[cursor]!), (cursor += 1);
  return result.join("");
}

function expectRoundTrip(before: string, after: string, contextLines?: number): string {
  const patch = formatUnifiedHunks(before, after, contextLines);
  expect(applyUnifiedHunks(before, patch)).toBe(after);
  return patch;
}

describe("diffLines", () => {
  it("produces an edit script that reconstructs both sides exactly", () => {
    const before = "a\nb\nc\nd\n";
    const after = "a\nx\nc\nd\ne";
    const edits = diffLines(before, after);
    const rebuiltBefore = edits.filter((edit) => edit.kind !== "insert").map((edit) => edit.line).join("");
    const rebuiltAfter = edits.filter((edit) => edit.kind !== "delete").map((edit) => edit.line).join("");
    expect(rebuiltBefore).toBe(before);
    expect(rebuiltAfter).toBe(after);
  });

  it("survives an edit distance beyond the search budget via full replacement", () => {
    const before = Array.from({ length: 1200 }, (_, index) => `old ${index}\n`).join("");
    const after = Array.from({ length: 1200 }, (_, index) => `new ${index}\n`).join("");
    expectRoundTrip(before, after);
  });
});

describe("formatUnifiedHunks", () => {
  it("returns the empty string for identical inputs", () => {
    expect(formatUnifiedHunks("a\nb\n", "a\nb\n")).toBe("");
    expect(formatUnifiedHunks("", "")).toBe("");
  });

  it("round-trips boundary shapes", () => {
    expectRoundTrip("", "new\nlines\n");
    expectRoundTrip("old\nlines\n", "");
    expectRoundTrip("a\nb", "a\nb\nc\n");
    expectRoundTrip("a\nb\n", "a\nb\nc");
    expectRoundTrip("no newline", "still no newline");
    expectRoundTrip("café\n汉字テスト\n", "café!\n汉字テスト\n");
  });

  it("separates distant edits into hunks and merges edits within twice the context", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index}\n`);
    const changed = [...lines];
    changed[10] = "changed ten\n";
    changed[20] = "changed twenty\n";
    const before = lines.join("");
    const after = changed.join("");

    const separate = expectRoundTrip(before, after, 3);
    expect(separate.match(/^@@/gm)).toHaveLength(2);
    const merged = expectRoundTrip(before, after, 5);
    expect(merged.match(/^@@/gm)).toHaveLength(1);
    const generous = expectRoundTrip(before, after);
    expect(generous.match(/^@@/gm)).toHaveLength(1);
  });

  it("defaults to generous context", () => {
    expect(DIFF_CONTEXT_LINES).toBe(40);
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
    const changed = [...lines];
    changed[15] = "changed\n";
    const patch = formatUnifiedHunks(lines.join(""), changed.join(""));
    expect(patch.match(/^ line/gm)).toHaveLength(29);
  });

  it("round-trips randomized edit scripts", () => {
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 25; round += 1) {
      const length = Math.floor(random() * 80);
      const before = Array.from({ length }, (_, index) => `line ${index} ${Math.floor(random() * 4)}\n`);
      const after = before
        .filter(() => random() > 0.2)
        .flatMap((line) => (random() > 0.85 ? [line, `inserted ${Math.floor(random() * 100)}\n`] : [line]));
      if (random() > 0.5 && after.length > 0) {
        after[after.length - 1] = after.at(-1)!.slice(0, -1);
      }
      expectRoundTrip(before.join(""), after.join(""), Math.floor(random() * 6));
    }
  });
});
