import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "fast",
          include: ["test/unit/**/*.test.ts", "test/contracts/**/*.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "extended",
          include: ["test/extended/**/*.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          exclude: ["test/integration/release-offline.test.ts"],
          // Integration is an explicit, Git/process-heavy opt-in. Use the final available core
          // instead of Vitest's ordinary "CPUs minus one" default so independently sharded
          // semantic journeys do not leave one worker lane idle.
          maxWorkers: "100%"
        }
      },
      {
        extends: true,
        test: {
          name: "crash",
          include: ["test/crash/**/*.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "real-host",
          include: ["test/real-host/**/*.test.ts"],
          fileParallelism: false
        }
      }
    ],
    coverage: {
      reportsDirectory: "coverage"
    }
  }
});
