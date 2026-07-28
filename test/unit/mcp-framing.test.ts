import { describe, expect, it } from "vitest";

import { createJsonLineFramer, type IngressFrame } from "../../src/mcp/framing.js";

const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function drain(framer: ReturnType<typeof createJsonLineFramer>): IngressFrame[] {
  const frames: IngressFrame[] = [];
  let frame: IngressFrame | undefined;
  while ((frame = framer.next()) !== undefined) frames.push(frame);
  return frames;
}

describe("JSON-line framing", () => {
  it("decodes split Unicode and treats LF and CRLF segments independently", () => {
    const framer = createJsonLineFramer();
    const input = bytes('{"message":"🙂"}\n{"line":2}\r\n');
    const split = input.indexOf(0xf0) + 2;

    framer.append(input.subarray(0, split));
    expect(framer.next()).toBeUndefined();
    framer.append(input.subarray(split));

    expect(drain(framer)).toEqual([
      { kind: "json", value: { message: "🙂" } },
      { kind: "json", value: { line: 2 } }
    ]);
    expect(framer.retainedBytes).toBe(0);
  });

  it("strips exactly one CR and keeps empty or malformed lines nonfatal", () => {
    const framer = createJsonLineFramer();
    framer.append(bytes('\nnot-json\n{"ok":true}\r\n{}\r\r\n'));

    expect(drain(framer)).toEqual([
      { kind: "parse-error", fatal: false },
      { kind: "parse-error", fatal: false },
      { kind: "json", value: { ok: true } },
      { kind: "json", value: {} }
    ]);
  });

  it("makes invalid UTF-8 fatal and discards later segments", () => {
    const framer = createJsonLineFramer();
    framer.append(new Uint8Array([0x7b, 0x7d, 0x0a, 0xc3, 0x28, 0x0a, 0x7b, 0x7d, 0x0a]));

    expect(framer.next()).toEqual({ kind: "json", value: {} });
    expect(framer.next()).toEqual({ kind: "parse-error", fatal: true });
    expect(framer.next()).toBeUndefined();
    expect(framer.retainedBytes).toBe(0);

    const invalidFinal = createJsonLineFramer();
    invalidFinal.append(new Uint8Array([0xc3]));
    expect(invalidFinal.finish()).toEqual({ kind: "parse-error", fatal: true });
  });

  it("accepts an exact 10 MiB frame and rejects an over-limit frame", () => {
    const exact = createJsonLineFramer();
    exact.append(bytes(`"${"a".repeat(MAX_FRAME_BYTES - 2)}"\r\n`));
    const exactFrame = exact.next();
    expect(exactFrame?.kind).toBe("json");
    if (exactFrame?.kind !== "json") throw new Error("expected exact-size JSON frame");
    expect((exactFrame.value as string).length).toBe(MAX_FRAME_BYTES - 2);

    const over = createJsonLineFramer();
    over.append(bytes(`"${"a".repeat(MAX_FRAME_BYTES - 1)}"\n`));
    expect(over.next()).toEqual({ kind: "parse-error", fatal: true });
    expect(over.next()).toBeUndefined();
  });

  it("bounds retained partial input at exactly 10 MiB", () => {
    const exact = createJsonLineFramer();
    exact.append(new Uint8Array(MAX_FRAME_BYTES));
    expect(exact.retainedBytes).toBe(MAX_FRAME_BYTES);
    expect(exact.next()).toBeUndefined();

    const over = createJsonLineFramer();
    over.append(new Uint8Array(MAX_FRAME_BYTES + 1));
    expect(over.next()).toEqual({ kind: "parse-error", fatal: true });
    expect(over.retainedBytes).toBe(0);
  });

  it("drains many lines from one chunk without coupling their results", () => {
    const framer = createJsonLineFramer();
    const count = 2_000;
    framer.append(bytes(Array.from({ length: count }, (_, index) => `${JSON.stringify(index)}\n`).join("")));

    const frames = drain(framer);
    expect(frames).toHaveLength(count);
    expect(frames[0]).toEqual({ kind: "json", value: 0 });
    expect(frames.at(-1)).toEqual({ kind: "json", value: count - 1 });
  });

  it("reports one nonfatal parse error for a partial final line", () => {
    const framer = createJsonLineFramer();
    framer.append(bytes('{"complete":true}\n{"partial":'));

    expect(framer.finish()).toEqual({ kind: "json", value: { complete: true } });
    expect(framer.finish()).toEqual({ kind: "parse-error", fatal: false });
    expect(framer.finish()).toBeUndefined();
    expect(framer.retainedBytes).toBe(0);
  });
});
