export type IngressFrame =
  | Readonly<{ kind: "json"; value: unknown }>
  | Readonly<{ kind: "parse-error"; fatal: boolean }>;

export interface JsonLineFramer {
  readonly retainedBytes: number;
  readonly append: (chunk: Uint8Array) => void;
  readonly next: () => IngressFrame | undefined;
  readonly finish: () => IngressFrame | undefined;
}

const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

const nonfatalParseError = (): IngressFrame => ({ kind: "parse-error", fatal: false });
const fatalParseError = (): IngressFrame => ({ kind: "parse-error", fatal: true });

export function createJsonLineFramer(): JsonLineFramer {
  let retained = new Uint8Array();
  let offset = 0;
  let fatalPending = false;
  let stopped = false;

  const compact = (): void => {
    if (offset === 0) return;
    retained = retained.slice(offset);
    offset = 0;
  };

  const fail = (): void => {
    retained = new Uint8Array();
    offset = 0;
    fatalPending = true;
  };

  const append = (chunk: Uint8Array): void => {
    if (stopped || fatalPending || chunk.byteLength === 0) return;

    compact();
    // A maximum-size frame may still have the two-byte CRLF delimiter.
    if (retained.byteLength + chunk.byteLength > MAX_FRAME_BYTES + 2) {
      fail();
      return;
    }

    const combined = new Uint8Array(retained.byteLength + chunk.byteLength);
    combined.set(retained);
    combined.set(chunk, retained.byteLength);
    retained = combined;
  };

  const next = (): IngressFrame | undefined => {
    if (stopped) return undefined;
    if (fatalPending) {
      fatalPending = false;
      stopped = true;
      return fatalParseError();
    }

    const lineFeed = retained.indexOf(LINE_FEED, offset);
    if (lineFeed === -1) {
      if (retained.byteLength - offset > MAX_FRAME_BYTES) {
        fail();
        return next();
      }
      return undefined;
    }

    let end = lineFeed;
    if (end > offset && retained[end - 1] === CARRIAGE_RETURN) end -= 1;
    const frameBytes = retained.subarray(offset, end);
    offset = lineFeed + 1;

    if (frameBytes.byteLength > MAX_FRAME_BYTES) {
      fail();
      return next();
    }

    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(frameBytes);
      return { kind: "json", value: JSON.parse(source) as unknown };
    } catch (error) {
      if (error instanceof TypeError && frameBytes.byteLength !== 0) {
        // TextDecoder uses TypeError for malformed UTF-8. JSON.parse also throws
        // SyntaxError, keeping ordinary malformed JSON nonfatal.
        fail();
        return next();
      }
      return nonfatalParseError();
    }
  };

  const finish = (): IngressFrame | undefined => {
    const frame = next();
    if (frame !== undefined) return frame;
    if (stopped) return undefined;

    if (retained.byteLength - offset > 0) {
      const partial = retained.subarray(offset);
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(partial);
      } catch {
        fail();
        return next();
      }
      retained = new Uint8Array();
      offset = 0;
      stopped = true;
      return nonfatalParseError();
    }

    stopped = true;
    return undefined;
  };

  return {
    get retainedBytes() {
      return retained.byteLength - offset;
    },
    append,
    next,
    finish
  };
}
