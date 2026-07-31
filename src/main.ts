import process from "node:process";

import { runMcpProcess } from "./mcp/process-runner.js";
import { startMcpRuntime } from "./mcp/sdk-adapter.js";
import { createToolHandlers } from "./mcp/handlers/index.js";

void runMcpProcess(
  {
    input: process.stdin,
    output: process.stdout,
    diagnostic: process.stderr,
    workingDirectory: process.cwd(),
    handlers: createToolHandlers(),
    signals: process,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
  startMcpRuntime,
);
