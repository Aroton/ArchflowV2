import { Buffer } from "node:buffer";

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** Decodes bytes as strict UTF-8, returning `undefined` when the bytes are not valid UTF-8. */
export function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Renders bytes for a human or reviewer: UTF-8 text when valid, base64 otherwise. */
export function visibleContent(
  bytes: Uint8Array,
): Readonly<{ encoding: "utf8" | "base64"; content: string }> {
  const content = decodeUtf8Strict(bytes);
  return content === undefined
    ? Object.freeze({ encoding: "base64" as const, content: Buffer.from(bytes).toString("base64") })
    : Object.freeze({ encoding: "utf8" as const, content });
}
