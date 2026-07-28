import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reproduceCurrentRelease,
  runCli,
  writeCanonicalSummary,
} from "./release-support.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

runCli(async () => {
  if (process.argv.length !== 2) {
    const error = new Error("usage: npm run release:reproduce");
    error.usage = true;
    throw error;
  }
  writeCanonicalSummary(await reproduceCurrentRelease({ repositoryRoot }));
});
