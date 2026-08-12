import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const schemaDirectory = join(repositoryRoot, "src", "contracts", "schemas", "v1");
const handWrittenSchemaFiles = ["release-manifest.schema.json"];

async function renderGeneratedSchemas() {
  const bundleDirectory = await mkdtemp(join(tmpdir(), "archflow-generate-schemas-"));
  try {
    const bundle = join(bundleDirectory, "schema-generation.mjs");
    await build({
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      sourcemap: false,
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
      },
      absWorkingDir: repositoryRoot,
      entryPoints: ["src/contracts/internal/schema-generation.ts"],
      outfile: bundle
    });
    const generation = await import(pathToFileURL(bundle).href);
    return generation.renderGeneratedSchemaFiles();
  } finally {
    await rm(bundleDirectory, { recursive: true, force: true });
  }
}

const checkMode = process.argv.includes("--check");
const rendered = await renderGeneratedSchemas();
const fileNames = Object.keys(rendered).sort();

const forbidden = fileNames.filter((name) => handWrittenSchemaFiles.includes(name));
if (forbidden.length > 0) {
  console.error(`hand-written schemas must never be generated: ${forbidden.join(", ")}`);
  process.exit(1);
}

if (checkMode) {
  const drifted = [];
  for (const name of fileNames) {
    const committed = await readFile(join(schemaDirectory, name), "utf8").catch(() => undefined);
    if (committed !== rendered[name]) drifted.push(name);
  }
  if (drifted.length > 0) {
    console.error("generated schemas drifted from the committed files:");
    for (const name of drifted) console.error(`  src/contracts/schemas/v1/${name}`);
    console.error("run `npm run generate:schemas` and commit the result");
    process.exit(1);
  }
  console.log(`check:schemas — ${fileNames.length} generated schema(s) match the committed bytes; hand-written release manifest untouched`);
} else {
  for (const name of fileNames) await writeFile(join(schemaDirectory, name), rendered[name]);
  console.log(`generate:schemas — wrote ${fileNames.length} schema(s) to src/contracts/schemas/v1`);
}
