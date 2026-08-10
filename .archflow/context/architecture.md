# ArchFlow MCP Server Architecture

**Date:** 2026-08-10
**Commit:** `28c1021`

> This document maps repository structure, runtime wiring, dependency direction, and subsystem
> boundaries. Detailed durable-state and contract semantics are covered separately in
> `.archflow/context/state-and-contracts.md`.

## 1. Repository purpose

This repository ships one workflow through three cooperating surfaces:

1. Eight portable Agent Skills in `skills/`, installed for Claude Code and/or Codex.
2. A stdio MCP server, built from `src/main.ts`, that exposes the durable workflow tools.
3. A local helper CLI, built from `src/local/main.ts`, for initialization, task staging,
   artifact construction, manual/degraded operation, status, and maintenance.

The clients coordinate through repository-owned files under `.archflow/`. Skills are prose
orchestrators; they do not run inside the TypeScript process. The server and local helper enforce
the contracts, repository boundaries, durable state transitions, review evidence, and human gates
that the skills drive.

## 2. Top-level map

| Path | Responsibility |
|---|---|
| `src/` | TypeScript implementation for contracts, repository access, durable state, review dispatch, MCP, initialization, and the local CLI |
| `skills/` | Canonical `SKILL.md` sources for init, upgrade, explore, PRD, design, phase design, phase implementation, and status |
| `assets/` | Repository scaffold copied by initialization: workflow, constitution, and task-config template |
| `test/` | Vitest unit, contract, integration, crash, real-host, fixture, helper, and public-type coverage |
| `scripts/` | Build, release, reproduction, smoke, dependency-policy, notice, and MCP SDK-boundary checks |
| `dist/` | Tracked offline payload: MCP and local-helper bundles plus release metadata/legal files |
| `release/` | Release evidence and legal review inputs |
| `docs/` | Design history, process notes, real-host journeys, validation data, and known limitations |
| `notices/` | Supplemental third-party notice material |
| `.archflow/` | This repository's own workflow configuration, constitution, shared context, and tasks |
| `.github/workflows/ci.yml` | Node 24 verification matrix and full release reproduction checks |
| `install.sh` | Verifies the tracked payload, installs bundles/launchers, and copies skills to client discovery directories |

The package is private and ESM-only (`package.json`: `"private": true`, `"type": "module"`). It
does not publish a package `main`, `exports`, or `bin`; `install.sh` creates the user-facing
`archflow-mcp` and `archflow-local` launchers around the tracked bundles.

## 3. Runtime entry points

### MCP server: `src/main.ts`

`src/main.ts` accepts no operational arguments and binds the process streams and lifecycle:

```ts
void runMcpProcess(
  {
    input: process.stdin,
    output: process.stdout,
    diagnostic: process.stderr,
    workingDirectory: process.cwd(),
    handlers: createToolHandlers(),
    signals: process,
    setExitCode: (code) => { process.exitCode = code; },
  },
  startMcpRuntime,
);
```

The handler registry in `src/mcp/handlers/index.ts` is live and intentionally complete:

```ts
{
  archflow_state: handleState,
  archflow_counter_review: handleCounterReview,
  archflow_adjudicate: handleAdjudicate,
  archflow_gate: handleGate,
  archflow_waiver: handleWaiver,
}
```

The startup working directory is captured as the repository candidate for the connection. Tool
calls cannot select an arbitrary repository root; `openHandlerSession` later discovers and binds
the containing worktree from that captured location.

### Local helper: `src/local/main.ts`

`archflow-local <command> [--task <task>] [--input <json-file>]` parses the command before reading
input. Commands whose contract has no payload never read stdin. `src/local/commands.ts` owns the
command catalogue and delegates to initialization, repository, state, review, snapshot, status,
and manual-workflow services. Important groups are:

- repository setup: `init`, `task-init`, `upgrade`;
- artifact/request construction: `build-document`, `build-implementation-output`, `build-request`,
  `envelope`;
- durable inspection/mutation: `status`, `reconcile`, `snapshot`, `restore`, `maintain`, `decide`;
- degraded/manual workflow: `manual-status`, `manual-next`, `manual-handoff`, `checkpoint`, `import`.

This CLI is the non-MCP path to the same durable primitives; it is not a second state model.

### Installer: `install.sh`

The installer verifies every tracked bundle/runtime asset against `dist/manifest.json`, installs
the payload beneath `${ARCHFLOW_HOME:-$HOME/.archflow}/bundle/`, creates launchers beneath
`${ARCHFLOW_BIN:-$HOME/.local/bin}/`, and copies `skills/` to the selected client directories.
`archflow-local init` then scaffolds the target repository and registers the MCP server in
project-scoped Claude and Codex configuration.

## 4. Source architecture and dependency flow

```text
src/main.ts                         src/local/main.ts
    |                                      |
    v                                      v
src/mcp protocol stack  ------>  src/mcp/handlers     src/local/commands
                                      |                    |
                                      +---------+----------+
                                                v
                          src/review       src/state       src/init
                               |               |              |
                               v               v              v
                          src/dispatch <-> src/repository <----+
                               \              /
                                v            v
                                  src/contracts
```

The arrows show primary use, not every type-only import. The principal rule is that
`src/contracts/` is the pure, filesystem-free foundation. Filesystem and Git effects live in
`src/repository/`, while `src/state/` composes those capabilities into durable operations.

### `src/contracts/`: protocol and durable vocabulary

This layer defines branded identifiers and digests, plain-JSON and canonical-document rules,
workflow/config parsing, task-state and retained-result shapes, review/gate/triage artifacts,
renderers, MCP tool inputs/results, and project errors. Normative JSON Schemas live under
`src/contracts/schemas/v1/` and are loaded by the TypeScript validators.

`src/contracts/index.ts` is the public contract barrel. Internal trust brands and test
capabilities remain in `src/contracts/internal/`. Persisted shapes are modeled as closed JSON
types and validated at boundaries before they can become durable authority.

### `src/repository/`: Git and path authority

This is the effectful repository boundary:

- `git.ts` executes Git through a structured runner and exposes object/tree/history operations.
- `identity.ts` discovers the worktree and mints a root-bound runner.
- `paths.ts` classifies path claims, enforces task scope and containment, and opens resolved paths
  without following unsafe links.
- `attributes.ts` verifies the required `.archflow/** -text merge=binary` policy.
- `history.ts`, `index-entries.ts`, and `handoff.ts` inspect mutation readiness, index identities,
  and cross-session handoffs.

`src/repository/index.ts` records the directional rule: contracts do not import or re-export this
effectful layer.

### `src/state/`: durable workflow kernel

`createProductionServices` in `src/state/production.ts` is the normal composition root. It:

1. discovers and preflights the Git worktree;
2. creates transaction authority bound to one task;
3. reads canonical `state.json` and the pinned task config;
4. supplies atomic/projection writers, task locks, fingerprint readers, secret scanning, retained
   result loading, and gate re-entry services.

The central write path is `runStateTransaction` in `src/state/transaction.ts`: identify and bind the
request, lock the task, validate current authority and replay receipts, prepare the next state and
optional retained snapshot, then install the result and canonical state atomically. Supporting
modules own initialization, state transitions, locks, snapshots, gates, reconciliation/repair,
checkpoints, status/next-action derivation, result maintenance, constitution pinning, evidence
loading, implementation manifests, and fingerprint construction.

Durable result bytes are content-addressed; human-facing Markdown and other working files are
projections that can be checked or reconstructed from authenticated authority.

### `src/review/`: fixed-point review services

This layer prepares bounded review/adjudication envelopes and interprets returned evidence:

- `pinned-context.ts` assembles task-local and repository context under an envelope cap;
- `counter-review.ts` runs opposite-family review and prepares retained evidence;
- `adjudication.ts` cross-checks findings against the pinned constitution and selects gates;
- `fixed-point.ts` determines whether evidence is current and advancement is allowed;
- `envelopes.ts` and `line-diff.ts` define the dispatched payload and readable change material.

Review verdicts are evidence, not direct permission to advance. Advancement remains a state
transition backed by current digests and any required human decision.

### `src/dispatch/`: isolated outbound agent execution

`routing.ts` resolves model/family/role from the task's pinned config. `cli.ts` adapts the Claude and
Codex CLIs and performs preflight checks. `coordinator.ts` creates one attempt, invokes the selected
adapter, and records best-effort attempt telemetry. `process.ts` enforces timeout/output limits;
`workspace.ts` creates a disposable home and exposes only the required credential/config material.

This is outbound execution for counter-review and adjudication. It is distinct from the inbound
MCP process.

### `src/init/`: repository and task setup

`runInit` discovers the worktree, scaffolds repository assets, registers project-scoped Claude and
Codex MCP configuration, and returns diagnostics. It explicitly creates neither task state nor a
commit. `task-initialization.ts` stages a new canonical task, while `legacy-upgrade.ts` stages an
explicit import into a distinct task.

## 5. MCP request path

The inbound call path is:

```text
stdin bytes
  -> framing.ts (JSON-line frames)
  -> session.ts (JSON-RPC lifecycle and request routing)
  -> sdk-adapter.ts (@modelcontextprotocol/server integration)
  -> server.ts (tool boundary and structural validation)
  -> handlers/<tool>.ts
  -> production/review/state/repository services
  -> validated project result
  -> SDK result projection
  -> send-queue.ts (ordered, backpressured stdout)
```

`src/mcp/sdk-adapter.ts` is the sole MCP SDK boundary. `src/mcp/tools.ts` derives advertised input
and output schemas from the same normative schemas used by runtime validation. `server.ts` rejects
unknown/disabled tools, classifies schema-version errors, authenticates invocation context, and
converts handler exceptions into non-leaking internal project failures. `process-runner.ts` owns
signals, shutdown, diagnostics, and exit-code selection.

Handler responsibilities are deliberately narrow:

| Tool | Primary responsibility |
|---|---|
| `archflow_state` | Initialize or advance task state and retain document, implementation, review, or triage artifacts |
| `archflow_counter_review` | Dispatch and retain opposite-family review evidence |
| `archflow_adjudicate` | Resolve findings against current evidence/constitution and open triggered gates |
| `archflow_gate` | Run the durable human decision lifecycle |
| `archflow_waiver` | Apply a specifically bound, authenticated waiver path |

Shared handler helpers open the production session, detect replay, map errors, and prepare state
results. The registry is the only live MCP workflow surface.

## 6. Configuration and durable layout

`assets/workflow.yaml` defines the fixed workflow graph:

```text
explore (optional)
prd -> design -> phase-design[N] -> phase-impl[N]
```

PRD and design always have human gates; phase design and implementation gate when evidence or
policy triggers require it. `assets/config.template.yaml` selects producer, self-reviewer,
counter-reviewer, and adjudicator model/effort routes. Task creation copies and pins this config at
`.archflow/tasks/<task>/config.yaml`; routing does not float with later repository-template edits.

The durable task shape is rooted at:

```text
.archflow/
  workflow.yaml
  constitution/
  context/
  tasks/<task>/
    config.yaml
    state.json
    prd.md
    design.md
    phases/<n>/
      design.md
      impl-notes.md
    intents/
    results/sha256/
    reviews/
    decisions/
    attempts/
    manual/checkpoints/
    maintenance/
```

Not every auxiliary directory exists at all times. `state.json`, intent receipts, retained result
manifests/payloads, archived decisions, and checkpoint chains carry authority. PRD/design/review
Markdown and gate interfaces are human-facing projections. Task path classification prevents one
task from resolving another task's files.

Constitution rules are repository-owned under `.archflow/constitution/` and are resolved from a
pinned policy commit for task review/adjudication. The task cannot silently alter its own governing
rules.

## 7. Build and verification

`tsconfig.json` typechecks ES2024/NodeNext with strict mode, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and no TypeScript emission. esbuild performs
bundling for Node 24.

- Temporary development build: `scripts/build-temp-helper.mjs` builds contracts plus the MCP
  runtime into a unique temporary directory and smoke-tests it.
- Release build: `scripts/release-support.mjs` builds both `src/main.ts` and `src/local/main.ts` into
  `dist/archflow-mcp.mjs` and `dist/archflow-local.mjs` with a fixed, reproducible profile.
- Release metadata: `dist/manifest.json` and `dist/metafile.json` bind entry points, inputs,
  dependencies, assets, output bytes, and launch policy.
- Verification: `npm run check` combines MCP SDK compatibility, TypeScript, MCP/runtime and full
  Vitest suites, temporary build smoke, dependency/notices policy, SDK-boundary enforcement, and
  release integrity/reproduction.

Vitest uses the Node environment and discovers `test/**/*.test.ts`. Contract tests exercise JSON
Schema/TypeScript agreement, integration tests cover real repository and stdio flows, crash tests
exercise interrupted durable operations, and real-host tests run serialized external-client
journeys. CI runs the verification chain on the minimum Node version and a later Node 24 version.

## 8. Architectural trust boundaries

- Human review and commit authorization remain explicit gates; no handler commits on its own.
- The MCP connection is bound to its startup repository, and every operation is further bound to a
  validated task identity and path class.
- Canonical JSON bytes and SHA-256 digests bind state, requests, evidence, results, and decisions.
- The state transaction kernel is the single normal authority-changing path; review/dispatch
  services prepare evidence but do not bypass it.
- Content-addressed retained results are authoritative; disposable projections cannot strand or
  redefine durable state.
- Opposite-family review/adjudication is enforced by routing and evidence bindings, not merely by
  skill prose.
- External agent processes run in isolated temporary workspaces with bounded output and lifetime.
- Release bundles and runtime assets are tracked, digest-verified, mutation-tested, and reproduced
  in CI before installation.
