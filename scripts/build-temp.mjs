import { build } from "esbuild";

await build({
  entryPoints: ["src/contracts/index.ts"],
  outfile: ".tmp/archflow-contracts.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
  }
});
