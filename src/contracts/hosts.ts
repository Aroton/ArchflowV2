import type { ModelFamily } from "./review.js";

export type HostIdentity = "claude" | "codex" | "antigravity" | "unknown";

type RecordedHandshake = Readonly<{
  name: string;
  version: string;
  host: Exclude<HostIdentity, "unknown">;
}>;

/**
 * Exact clientInfo pairs captured from the supported first-party clients. The recorded names are
 * the stable identity keys; versions remain fixture evidence and are gated separately against the
 * dispatched CLI binary.
 */
const RECORDED_HANDSHAKES: readonly RecordedHandshake[] = Object.freeze([
  Object.freeze({ name: "claude-code", version: "2.1.220", host: "claude" }),
  Object.freeze({ name: "codex-mcp-client", version: "0.146.0", host: "codex" }),
  Object.freeze({ name: "antigravity-client", version: "1.0.0", host: "antigravity" }),
  Object.freeze({ name: "antigravity", version: "1.0.0", host: "antigravity" }),
  Object.freeze({ name: "agy", version: "1.1.22", host: "antigravity" }),
]);

export function deriveHostIdentity(client: {
  readonly name: string;
  readonly version: string;
}): HostIdentity {
  if (client === null || typeof client !== "object") return "unknown";
  const { name, version } = client;
  if (typeof name !== "string" || typeof version !== "string") return "unknown";

  const matches = RECORDED_HANDSHAKES.filter((handshake) => handshake.name === name);
  if (matches.length !== 1) return "unknown";
  return matches[0]!.host;
}

export function hostToModelFamily(host: Exclude<HostIdentity, "unknown">): ModelFamily {
  switch (host) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "antigravity":
      return "gemini";
  }
}
