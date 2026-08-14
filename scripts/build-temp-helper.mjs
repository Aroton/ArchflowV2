import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = resolve(tmpdir());
const sharedBuildOptions = Object.freeze({
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
  }
});

export async function buildTemporaryBundles(outputDirectory) {
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)) {
    throw new TypeError("temporary bundle output directory must be an explicit absolute path");
  }
  const resolvedOutput = resolve(outputDirectory);
  const relativeToTemporaryRoot = relative(temporaryRoot, resolvedOutput);
  if (
    resolvedOutput === temporaryRoot ||
    relativeToTemporaryRoot === "" ||
    relativeToTemporaryRoot.startsWith("..") ||
    isAbsolute(relativeToTemporaryRoot)
  ) {
    throw new TypeError(`temporary bundle output must be a unique child of ${temporaryRoot}`);
  }

  await mkdir(resolvedOutput, { recursive: true });
  const contractsBundle = resolve(resolvedOutput, "archflow-contracts.mjs");
  const runtimeBundle = resolve(resolvedOutput, "archflow-mcp.mjs");
  await Promise.all([
    build({
      ...sharedBuildOptions,
      absWorkingDir: repositoryRoot,
      entryPoints: ["src/contracts/index.ts"],
      outfile: contractsBundle
    }),
    build({
      ...sharedBuildOptions,
      absWorkingDir: repositoryRoot,
      entryPoints: ["src/main.ts"],
      outfile: runtimeBundle
    })
  ]);
  return Object.freeze({ contractsBundle, runtimeBundle });
}
