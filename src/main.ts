import process from "node:process";

import { runMcpProcess } from "./mcp/process-runner.js";
import { startMcpRuntime } from "./mcp/sdk-adapter.js";

void runMcpProcess(
  {
    input: process.stdin,
    output: process.stdout,
    diagnostic: process.stderr,
    workingDirectory: process.cwd(),
    signals: process,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
  startMcpRuntime,
);
