import process from "node:process";

import { runMcpProcess } from "./mcp/process-runner.js";
import { startMcpRuntime } from "./mcp/sdk-adapter.js";
import { createToolHandlers } from "./mcp/handlers/index.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("usage: archflow-mcp\n  stdio MCP server: speaks MCP JSON-RPC on stdin/stdout and takes no arguments\n");
} else if (args.length > 0) {
  process.stderr.write(`archflow-mcp takes no arguments (got: ${args.join(" ")}); it is a stdio MCP server speaking MCP JSON-RPC on stdin/stdout\n`);
  process.exitCode = 1;
} else {
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
}
