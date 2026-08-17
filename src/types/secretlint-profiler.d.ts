// `@secretlint/profiler` types `getEntries`/`getMeasures` as returning `PerformanceEntry`, a name
// @types/node publishes globally as a value only. Under `skipLibCheck: false` that package's own
// declaration file therefore stops compiling as soon as anything imports it. Publishing the name as
// a global type resolves it without relaxing library checking for every other dependency.
declare global {
  type PerformanceEntry = import("node:perf_hooks").PerformanceEntry;
}

export {};
