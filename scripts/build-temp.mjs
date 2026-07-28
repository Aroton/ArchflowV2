import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildTemporaryBundles } from "./build-temp-helper.mjs";
import { smokeTemporaryBundles } from "./smoke-temp-bundle.mjs";

const outputDirectory = await mkdtemp(resolve(tmpdir(), "archflow-mcp-build-"));

try {
  const bundles = await buildTemporaryBundles(outputDirectory);
  await smokeTemporaryBundles(bundles);
  console.log(`Temporary contract and inert runtime bundles built and exercised under ${process.version}.`);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
