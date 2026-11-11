
import type { AdapterId, ModelFamily } from "./review.js";

export function assertAdapterFamily(adapter: AdapterId, family: ModelFamily): void {
  const expected = adapter === "claude-cli" ? "claude" : adapter === "antigravity-cli" ? "gemini" : "codex";
  if (family !== expected) throw new TypeError("adapter and model family do not match");
}
