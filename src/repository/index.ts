/**
 * The sole `src/repository/**` barrel, created once by the last repository chunk.
 *
 * **Directional rule, and it is one-way.** Pure computation lives in `src/contracts/`; everything
 * that shells out to `git` or touches `node:fs` lives here. `src/repository/**` is therefore **never
 * re-exported from `src/contracts/index.ts`**, and `src/contracts/**` **never imports from
 * `src/repository/**`**, so the contract layer stays testable without a repository on disk.
 */

export * from "./git.js";
export * from "./identity.js";
export * from "./paths.js";
export * from "./attributes.js";
export * from "./index-entries.js";
export * from "./history.js";
export * from "./repository-set.js";
