import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  buildReleasePayload,
  parseCli,
  runCli,
  writeCanonicalSummary,
} from "./release-support.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

runCli(async () => {
  const { stageRoot } = parseCli(process.argv.slice(2), {
    "--output": "stageRoot",
    required: ["stageRoot"],
    usage: "npm run release:stage -- --output <empty-dir>",
  });
  writeCanonicalSummary(await buildReleasePayload({ repositoryRoot, stageRoot }));
});
