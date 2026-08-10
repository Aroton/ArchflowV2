/**
 * Line-oriented Myers diff with unified-hunk formatting for review material. Hand-rolled rather
 * than a dependency because the runtime dependency set is frozen by the release policy, and a
 * subprocess differ would break the renderer's pure in-memory character.
 */

/** Context lines per hunk — generous so a wide-context diff approximates full-file review. */
export const DIFF_CONTEXT_LINES = 40;

/**
 * Edit-distance budget for the O((N+M)·D) search. Beyond it the diff degrades to one full
 * replacement hunk — still complete and correct, merely not minimal; a change that degenerate has
 * no compact rendering anyway, and the envelope byte cap remains the backstop.
 */
const MAX_DIFF_EDITS = 1000;

export type LineEdit = Readonly<{ kind: "equal" | "delete" | "insert"; line: string }>;

/** Splits into lines, each keeping its trailing newline; a final unterminated line is kept bare. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const segments = text.split("\n");
  const last = segments.pop()!;
  const lines = segments.map((segment) => `${segment}\n`);
  if (last !== "") lines.push(last);
  return lines;
}

function equalEdit(line: string): LineEdit {
  return Object.freeze({ kind: "equal" as const, line });
}

function fullReplacement(before: readonly string[], after: readonly string[]): LineEdit[] {
  return [
    ...before.map((line) => Object.freeze({ kind: "delete" as const, line })),
    ...after.map((line) => Object.freeze({ kind: "insert" as const, line })),
  ];
}

/** Greedy Myers forward search; `undefined` when the edit distance exceeds `MAX_DIFF_EDITS`. */
function myersEdits(a: readonly string[], b: readonly string[]): LineEdit[] | undefined {
  const n = a.length;
  const m = b.length;
  const offset = MAX_DIFF_EDITS;
  const v = new Int32Array(2 * MAX_DIFF_EDITS + 2);
  const trace: Int32Array[] = [];
  const maxD = Math.min(n + m, MAX_DIFF_EDITS);
  let dFound = -1;
  for (let d = 0; d <= maxD && dFound < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        dFound = d;
        break;
      }
    }
  }
  if (dFound < 0) return undefined;

  const reversed: LineEdit[] = [];
  let x = n;
  let y = m;
  for (let d = dFound; d > 0; d -= 1) {
    const prev = trace[d]!;
    const k = x - y;
    const cameFromInsert = k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!);
    const prevK = cameFromInsert ? k + 1 : k - 1;
    const prevX = prev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      reversed.push(equalEdit(a[x]!));
    }
    if (cameFromInsert) {
      y -= 1;
      reversed.push(Object.freeze({ kind: "insert" as const, line: b[y]! }));
    } else {
      x -= 1;
      reversed.push(Object.freeze({ kind: "delete" as const, line: a[x]! }));
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push(equalEdit(a[x]!));
  }
  return reversed.reverse();
}

/** The full line edit script from `before` to `after`, minimal within `MAX_DIFF_EDITS`. */
export function diffLines(beforeText: string, afterText: string): readonly LineEdit[] {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle = myersEdits(middleA, middleB) ?? fullReplacement(middleA, middleB);
  return Object.freeze([
    ...a.slice(0, start).map(equalEdit),
    ...middle,
    ...a.slice(endA).map(equalEdit),
  ]);
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function renderEditLine(prefix: string, line: string): string {
  return line.endsWith("\n")
    ? `${prefix}${line.slice(0, -1)}\n`
    : `${prefix}${line}\n${NO_NEWLINE_MARKER}\n`;
}

/**
 * Formats the edit script as unified hunks (`@@ -a,b +c,d @@`, no file header — the enclosing
 * entry names the path). Returns the empty string when the sides are byte-identical.
 */
export function formatUnifiedHunks(
  beforeText: string,
  afterText: string,
  contextLines: number = DIFF_CONTEXT_LINES,
): string {
  const edits = diffLines(beforeText, afterText);
  if (!edits.some((edit) => edit.kind !== "equal")) return "";

  const keep = new Array<boolean>(edits.length).fill(false);
  let lastChange = -Infinity;
  for (let index = 0; index < edits.length; index += 1) {
    if (edits[index]!.kind !== "equal") lastChange = index;
    if (index - lastChange <= contextLines) keep[index] = true;
  }
  let nextChange = Infinity;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    if (edits[index]!.kind !== "equal") nextChange = index;
    if (nextChange - index <= contextLines) keep[index] = true;
  }

  const output: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let index = 0;
  while (index < edits.length) {
    if (!keep[index]) {
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }
    const hunkStart = index;
    let end = index;
    while (end < edits.length && keep[end]) end += 1;
    let oldCount = 0;
    let newCount = 0;
    for (let cursor = hunkStart; cursor < end; cursor += 1) {
      const kind = edits[cursor]!.kind;
      if (kind !== "insert") oldCount += 1;
      if (kind !== "delete") newCount += 1;
    }
    const oldStart = oldCount === 0 ? oldLine : oldLine + 1;
    const newStart = newCount === 0 ? newLine : newLine + 1;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`);
    for (let cursor = hunkStart; cursor < end; cursor += 1) {
      const edit = edits[cursor]!;
      if (edit.kind === "equal") {
        output.push(renderEditLine(" ", edit.line));
        oldLine += 1;
        newLine += 1;
      } else if (edit.kind === "delete") {
        output.push(renderEditLine("-", edit.line));
        oldLine += 1;
      } else {
        output.push(renderEditLine("+", edit.line));
        newLine += 1;
      }
    }
    index = end;
  }
  return output.join("");
}
