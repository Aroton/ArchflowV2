import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { defineConfig } from "vitest/config";

// Reserve CPUs 0 and 1 to keep the host system responsive during parallel test execution.
const responsiveCoreCount = Math.max(1, (typeof availableParallelism === "function" ? availableParallelism() : cpus().length) - 2);

export default defineConfig({
  plugins: [{
    name: "bundled-review-yaml",
    enforce: "pre",
    load(id) {
      if (/[/\\]assets[/\\]review-(inputs|documents)\.yaml$/u.test(id)) {
        return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      }
      return undefined;
    },
  }],
  esbuild: {
    sourcemap: false,
    target: "node24"
  },
  build: {
    sourcemap: false
  },
  test: {
    css: false,
    environment: "node",
    maxWorkers: responsiveCoreCount,
    projects: [
      {
        extends: true,
        test: {
          name: "fast",
          include: ["test/unit/**/*.test.ts", "test/contracts/**/*.test.ts"],
          maxWorkers: responsiveCoreCount
        }
      },
      {
        extends: true,
        test: {
          name: "extended",
          include: ["test/extended/**/*.test.ts"],
          maxWorkers: responsiveCoreCount
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          exclude: ["test/integration/release-offline.test.ts"],
          maxWorkers: responsiveCoreCount
        }
      },
      {
        extends: true,
        test: {
          name: "crash",
          include: ["test/crash/**/*.test.ts"],
          maxWorkers: responsiveCoreCount
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
