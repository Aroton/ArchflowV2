import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  parseCli,
  runCli,
  writeCanonicalSummary,
  writeTrackedReleasePayload,
} from "./release-support.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

runCli(async () => {
  const { candidateStageRoot } = parseCli(process.argv.slice(2), {
    "--stage": "candidateStageRoot",
    required: ["candidateStageRoot"],
    usage: "npm run release:write -- --stage <dir>",
  });
  writeCanonicalSummary(await writeTrackedReleasePayload({ repositoryRoot, candidateStageRoot }));
});
