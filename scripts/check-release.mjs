import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  checkReleasePayload,
  parseCli,
  runCli,
  writeCanonicalSummary,
} from "./release-support.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

runCli(async () => {
  const options = parseCli(process.argv.slice(2), {
    "--payload": "payloadRoot",
    "--compare": "comparisonRoot",
    required: ["payloadRoot"],
    usage: "npm run release:check -- --payload <dir> [--compare <dir>]",
  });
  writeCanonicalSummary(await checkReleasePayload({ repositoryRoot, ...options }));
});
