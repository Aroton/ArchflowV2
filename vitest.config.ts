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
          include: ["test/integration/**/*.test.ts"]
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
