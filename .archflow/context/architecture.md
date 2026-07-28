# ArchFlow MCP Server Architecture

**Date**: 2026-07-28  
**Commit**: 91a7c95

## Overview

ArchFlow is a lightweight development workflow framework that runs as an MCP (Model Context Protocol) server. It provides six portable Agent Skills for Claude Code and Codex, guiding structured development from exploration through implementation with human review at every stage. The codebase consists of TypeScript/Node.js runtime logic and Markdown-based skill definitions.

## Top-Level Directory Map

```
.
├── src/                          # TypeScript source
│   ├── main.ts                   # Entry point: process wiring
│   ├── contracts/                # Data structures & validation schemas
│   └── mcp/                       # MCP protocol & runtime
├── skills/                        # Six portable Agent Skills (Markdown)
│   ├── archflow-explore/
│   ├── archflow-prd/
│   ├── archflow-design/
│   ├── archflow-phase-design/
│   ├── archflow-phase-impl/
│   └── archflow-status/
├── test/                         # Test suite (Vitest)
│   ├── unit/
│   ├── integration/
│   ├── contracts/
│   └── fixtures/
├── dist/                         # Build output (bundled MCP runtime)
├── scripts/                       # Build & release tooling
├── docs/                         # Process documentation
├── release/                      # Release artifacts
├── package.json                  # Node.js dependencies & scripts
├── tsconfig.json                 # TypeScript configuration
├── vitest.config.ts              # Test runner configuration
└── THIRD_PARTY_NOTICES.md        # License information
```

## Key Entry Points

### Main Process Entry Point

**File**: `src/main.ts`

```typescript
import { runMcpProcess } from "./mcp/process-runner.js";
import { startMcpRuntime } from "./mcp/sdk-adapter.js";

void runMcpProcess(
  {
    input: process.stdin,
    output: process.stdout,
    diagnostic: process.stderr,
    workingDirectory: process.cwd(),
    signals: process,
    setExitCode: (code) => { process.exitCode = code; },
  },
  startMcpRuntime,
);
```

**Wiring**: The entry point binds Node.js process streams (stdin/stdout/stderr) and signals to the MCP runtime, allowing the server to receive JSON-RPC messages from clients and send responses via stdout with diagnostics on stderr.

### MCP Runtime Initialization

**Files**:
- `src/mcp/sdk-adapter.ts` — Starts the MCP runtime; adapts @modelcontextprotocol/server SDK
- `src/mcp/process-runner.ts` — Manages process lifecycle: startup, signal handling, graceful shutdown
- `src/mcp/session.ts` — Session state machine and JSON-RPC request routing
- `src/mcp/server.ts` — Tool invocation boundary with error handling and contract validation

**Import Chain**:
1. `main.ts` calls `runMcpProcess()`
2. `runMcpProcess()` starts the MCP runtime via `startMcpRuntime()`
3. `startMcpRuntime()` creates an MCP `Server` instance, wires up tool handlers, and manages the JSON-RPC transport
4. Tool calls are routed through `createToolBoundary()` which validates inputs/outputs against contract schemas

## Application Wiring & Dependency Flow

### Protocol Stack (Bottom Up)

1. **Framing** (`src/mcp/framing.ts`)
   - JSON Line protocol encoding/decoding
   - Ingress frame parsing
   - Egress message serialization

2. **Send Queue** (`src/mcp/send-queue.ts`)
   - Serializes outgoing responses
   - Coordinates queueing and backpressure

3. **Session Controller** (`src/mcp/session.ts`)
   - JSON-RPC request/response correlation
   - Session state machine (PRE_INIT → INITIALIZING → INIT_RESPONSE_ACCEPTED → READY → CLOSING → CLOSED)
   - Routes incoming requests to `initialize`, `ping`, `tools/list`, or `tools/call`

4. **Tool Boundary** (`src/mcp/server.ts`)
   - Validates tool names against contract (`isToolName()`)
   - Parses structured inputs via `parseToolCall()`
   - Enforces output schema via `validateProjectResultStructure()` / `validateProjectFailureStructure()`
   - Returns either `project-result` or `protocol-error`

5. **SDK Adapter** (`src/mcp/sdk-adapter.ts`)
   - Wraps @modelcontextprotocol/server `Server` class
   - Configures tool registry from `ADVERTISED_TOOL_CATALOGUE`
   - Implements `MessageHandler` interface for MCP protocol events

6. **Process Runner** (`src/mcp/process-runner.ts`)
   - Orchestrates startup and graceful shutdown
   - Handles SIGINT/SIGTERM
   - Reports exit codes

### Tool Definitions & Contracts

**File**: `src/mcp/tools.ts`

- **`ADVERTISED_TOOL_CATALOGUE`**: Array of `AdvertisedToolDescriptor` (name, inputSchema, outputSchema)
- **Tool schemas**: JSON Schema documents defining each tool's contract
  - `mcp-tools.schema.json` — Main tool definitions
  - `primitives.schema.json` — Common data types
  - `path-claim.schema.json` — File path validation
  - `evidence-slots.schema.json` — Evidence structures
  - `rubric.schema.json` — Review criteria
  - `gate-contract.schema.json` — Review gates
  - `gate-decision.schema.json` — Gate outcomes
  - `project-error.schema.json` — Error structures

**Defined Tools** (sample):
- `analyze-code-structure` — Map codebase
- `perform-research` — Domain research
- `design-phase` — Phase design
- `review-document` — Cross-client review
- `gate-adjudication` — Human approval gates
- `execute-shell` — Shell commands
- etc. (full list in `src/contracts/tool-names.ts`)

### Contract Layer

**Directory**: `src/contracts/`

Exports re-exported from `src/contracts/index.ts`:

| Module | Purpose |
|--------|---------|
| `workflow.ts` | Workflow state (discovery, planning, implementation) |
| `mcp-tools.ts` | Tool contract parsing, validation, correlation |
| `tool-names.ts` | `ToolName` union type and validation |
| `yaml.ts` | YAML parsing for skill definitions |
| `contexts.ts` | Invocation context (user, client, phase, session) |
| `errors.ts` | Protocol and project errors |
| `evidence.ts` | Evidence slot structures |
| `gates.ts` | Review gate rules |
| `trust.ts` | Human trust boundaries |
| `triage.ts` | Counter-review triage |
| `plain-json.ts` | JSON value normalization |
| `validators.ts` | Input/output validation |
| `config.ts` | Configuration parsing |
| `renderers.ts` | Markdown rendering |

## Build System & Configuration

### TypeScript Configuration

**File**: `tsconfig.json`

- **Target**: ES2024
- **Module System**: ESM (NodeNext resolution)
- **Strict Mode**: Enabled (`strict: true`)
- **Root**: Current directory (monorepo-friendly)
- **No-Emit**: Type-checking only (compilation via esbuild)

### NPM Scripts

**Key scripts** (from `package.json`):

| Script | Purpose |
|--------|---------|
| `typecheck` | TypeScript validation |
| `test` | Full vitest suite (unit + contracts + integration) |
| `test:unit` | Unit tests only |
| `test:mcp-runtime` | MCP protocol runtime tests |
| `build:temp` | Build temporary bundles for smoke testing |
| `release:stage` | Build release artifacts |
| `release:check` | Validate release bundle |
| `release:smoke` | Smoke test the bundle |
| `check:release` | Full release verification |
| `check` | Full CI suite: probe, typecheck, test, build, release, notices |

### Test Configuration

**File**: `vitest.config.ts`

- **Environment**: Node.js
- **Test Patterns**: `test/**/*.test.ts`
- **Coverage**: Reported to `coverage/` directory

### Build Artifacts

**Output Directory**: `dist/`

- `archflow-mcp.mjs` — Bundled MCP server (esbuild output, ~1.3MB)
- `manifest.json` — Tool metadata for distribution
- `metafile.json` — Build metadata
- `legal/` — Third-party notices

**Build Tool**: esbuild (v0.28.1)

## Skill System

**Directory**: `skills/`

Each skill is a self-contained Markdown document with YAML frontmatter:

```
skills/archflow-explore/SKILL.md
  ├── name: archflow-explore
  ├── description: Explore a codebase and produce persistent ArchFlow context references
  └── [Full skill logic in Markdown format]
```

Skills define:
- Workflow steps (research, design, implementation)
- Sub-agent delegation strategy
- Approval gates
- File artifacts and state machines

## Node.js Dependencies

**Runtime** (`dependencies` in package.json):

- `@modelcontextprotocol/server@2.0.0` — MCP SDK
- `ajv@8.20.0` — JSON Schema validation
- `ajv-formats@3.0.1` — Format validation (email, uri, etc.)
- `yaml@2.9.0` — YAML parsing for skill definitions
- `zod@4.4.3` — Data validation (complementary to JSON Schema)

**Development** (`devDependencies`):

- `typescript@7.0.2` — Type checking
- `vitest@4.1.10` — Test runner
- `esbuild@0.28.1` — Bundler
- `vite@7.3.6` — Build coordination
- `@types/node@24.13.3` — Node.js type definitions

**Node.js Engine**: >= 24.15.0 (ES2024 features required)

## Critical Boundaries & Trust

### Protocol Guarantee

The tool boundary (in `src/mcp/server.ts`) enforces a strict contract:

1. **Input validation**: All tool arguments parsed and validated against contract schema before handler invocation
2. **Output validation**: All handler results validated against expected output schema
3. **Error coercion**: Failures are coerced into protocol-safe `ProtocolError` structures
4. **No handler bypass**: Direct tool access forbidden; all invocations go through boundary

### Session State Machine

The session controller enforces strict ordering:

```
PRE_INIT → INITIALIZING → INIT_RESPONSE_ACCEPTED → READY
  ↓                                                     ↓
  ├─────────────── (tool calls only in READY) ─────────→
  ↓
CLOSING → CLOSED
```

Tool calls are rejected if session is not READY.

## Test Structure

**Directory**: `test/`

| Path | Purpose |
|------|---------|
| `unit/` | Individual module tests |
| `contracts/` | Contract validation tests |
| `integration/` | MCP protocol end-to-end tests (stdio simulation) |
| `fixtures/` | Test data and utilities |
| `types/` | Type-checking tests |

## Release & Integrity

**Release Process**:

1. **Stage**: Build temporary bundle, verify structure
2. **Check**: Run smoke tests on bundle
3. **Mutations**: Test integrity against bit-flip attacks
4. **Reproduce**: Verify deterministic rebuild
5. **Write**: Track release in git

**Release Artifacts** (in `release/`):
- Tracked bundles for reproducibility
- Checksums for integrity verification
- Legal notices for distribution

## Configuration & Environment

- **Working Directory**: Current working directory (passed from caller)
- **Stdin/Stdout/Stderr**: Bound from process streams
- **Signals**: SIGINT (graceful close) and SIGTERM (immediate close)
- **Exit Codes**:
  - `0` — Clean shutdown
  - `1` — Protocol error or startup failure
  - `130` — SIGINT (Ctrl+C)
  - `143` — SIGTERM

---

**Key Architectural Principle**: ArchFlow separates *protocol and runtime* (MCP server in `src/mcp/`) from *domain logic* (workflow contracts and validation in `src/contracts/`), and *portable skills* (Markdown in `skills/`). This allows the same skill source to be distributed to both Claude Code and Codex without client-specific wiring.
