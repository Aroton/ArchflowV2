# ArchFlow MCP Server Architecture

**Date**: 2026-07-31
**Commit**: fccf3fb

> Deep internals of `src/state/` and `src/contracts/` (durable document shapes, canonicalization,
> trust brands, transaction internals) live in **`.archflow/context/state-and-contracts.md`**.
> This document maps *responsibilities and wiring* only.

---

## 1. What this repository is

Two deliverables in one repo:

1. **Six portable Markdown Agent Skills** (`skills/`) — installed by `install.sh` into
   `~/.claude/skills/` and `~/.agents/skills/`. Pure prose; no code, no imports, no runtime coupling.
2. **A bundled MCP server** (`src/` → `dist/archflow-mcp.mjs`) — a TypeScript/Node 24 stdio
   JSON-RPC server that owns durable workflow state, human gates, cross-client review dispatch,
   and constitution adjudication.

The two are joined only by *names and file layout*: `assets/workflow.yaml` maps each workflow phase
id to a skill name, and both sides agree on the `.archflow/` on-disk tree. Nothing in `src/` reads or
executes a `SKILL.md`.

## 2. Top-level directory map

| Path | Contents |
|---|---|
| `src/` | TypeScript runtime, 6 subdirectories + `main.ts` (~20k lines) |
| `test/` | Vitest: `unit/` (76 files), `contracts/` (16), `integration/` (10), `crash/` (4), `fixtures/`, `helpers/`, `types/` |
| `skills/` | `archflow-{explore,prd,design,phase-design,phase-impl,status}/SKILL.md` — one file each |
| `assets/` | `workflow.yaml` (phase graph) + `constitution/*.md` (4 rule files + README). Scaffold source, copied into a target repo's `.archflow/` |
| `docs/` | `mcp-integration-design.md` (preserved originating design), `archflow-process.md`, `dependency-upgrades.md` |
| `dist/` | **Tracked** release payload: `archflow-mcp.mjs`, `manifest.json`, `metafile.json`, `legal/` |
| `release/` | **Tracked** release governance: `legal-review.json`, `evidence/*.json` (risk acceptance, reachability, advisory snapshot), `legal/upstream/*/LICENSE` |
| `notices/` | `typescript-7.0.2-NOTICE.txt` — the one notice not derivable from package metadata |
| `scripts/` | 17 `.mjs` build/verify tools (no TS), see §6 |
| `.github/workflows/` | `ci.yml` — runs every `npm run check:*` step on Node 24.15.0 and 24.18.0 |
| `.archflow/` | This repo dogfoods ArchFlow: `context/` (these docs) + `tasks/mcp-integration/` |

Root files: `CLAUDE.md` (+ untracked byte-identical `AGENTS.md` mirror for Codex), `install.sh`,
`THIRD_PARTY_NOTICES.md`, `tsconfig.json`, `vitest.config.ts`, `.gitattributes`.

## 3. Entry points

**Process entry — `src/main.ts`** (19 lines, the only file outside `src/mcp/` that touches `process`):

```ts
void runMcpProcess(
  { input: process.stdin, output: process.stdout, diagnostic: process.stderr,
    workingDirectory: process.cwd(), signals: process,
    setExitCode: (code) => { process.exitCode = code; } },
  startMcpRuntime,
);
```

**`package.json` has no `bin`, no `exports`, no `main`** — it is `"private": true`. The shipped
artifact is the bundle `dist/archflow-mcp.mjs` (esbuild entry `src/main.ts`), launched by an MCP
client over stdio. There is no CLI for the server itself.

**"CLI dispatch" means something different here**: `src/dispatch/` spawns *other* coding-agent CLIs
(`claude`, `codex`) as child processes to perform counter-review and adjudication. It is an outbound
client, not an inbound entry point.

### ⚠ The runtime is deliberately handler-free ("inert")

`startMcpRuntime` takes `handlers?: ToolHandlerRegistry` and `main.ts` **passes none**:

```ts
// src/mcp/sdk-adapter.ts:166
const handlers = options.handlers ?? {};
const boundary = createToolBoundary(handlers);
```

No file in `src/` constructs a `ToolHandlerRegistry`. The five tools are fully advertised over
`tools/list`, and any `tools/call` returns the protocol error
`TOOL_DISABLED { lifecycle_state: "inert-no-handler" }` (verified at
`test/integration/mcp-stdio.test.ts:225`). This is a recorded, load-bearing security property —
`release/evidence/focused-inert-reachability.json` accepts a known upstream URI advisory *only*
because no untrusted JSON-RPC route reaches the vulnerable code, and it declares itself invalidated
by any `handler-authority-change`.

**Consequence**: `src/state/`, `src/review/`, `src/dispatch/`, and `src/repository/` are complete,
tested libraries that are **not yet reachable from the MCP protocol surface**. They are exercised
directly by `test/unit`, `test/integration`, and `test/crash`. Wiring handlers is a future phase and
will require re-issuing the release risk evidence.

## 4. The five tools

`src/contracts/tool-names.ts` is the whole registry:

```ts
export const TOOL_NAMES = Object.freeze([
  "archflow_state", "archflow_counter_review", "archflow_adjudicate",
  "archflow_gate", "archflow_waiver",
] as const);
```

Typed contracts (input/success per tool) are in `src/contracts/mcp-tools.ts` (`ToolContractMap`);
the normative JSON Schema is `src/contracts/schemas/v1/mcp-tools.schema.json`.
Every input shares `CommonToolInput = { schema_version: "1", task_id, intent_id, expected_revision,
input_fingerprint }` — optimistic concurrency plus idempotency by intent.

`src/mcp/tools.ts` builds `ADVERTISED_TOOL_CATALOGUE` by *projecting* the normative schema documents
into self-contained per-tool schemas: it strips `$id`/`$schema`/`$anchor`/`x-archflow-*`, rewrites
every cross-document `$ref` to `#/$defs/<key>`, and inlines all 20 referenced schema documents into
`$defs`. So the wire schema is derived from the same files the runtime validates against — never
hand-maintained.

## 5. Module wiring

### Dependency direction (verified by import counts)

```
              src/main.ts
                   │
              src/mcp/          ── 13 imports of contracts, 0 of state/review/dispatch/repository
                   │
   ┌───────────────┴──────────┐
src/review/  ──4──►  src/dispatch/     (review calls dispatch; cli.ts imports review/envelopes types only)
   │  16                 │ 17
   ▼                     ▼
src/state/  ──33──►  src/repository/
   │ 151                 │ 30
   └──────────┬──────────┘
              ▼
        src/contracts/          ── leaf: pure computation, no node:fs, no git
```

Rules that hold in the tree today:

- **`src/contracts/` never imports `src/repository/`** and is never re-exported from it — stated
  verbatim in the docstring of `src/repository/index.ts`. Pure computation vs. anything touching
  `git`/`node:fs` is the dividing line.
- **One deliberate exception**: `src/contracts/internal/test-capabilities.ts:34` imports
  `assertAuthenticTransactionOutcome` from `../../state/transaction.js`. That module is not exported
  from `src/contracts/index.ts`; it mints test-only trust capabilities.
- **`repository → state` is a narrow 3-import seam**: `src/repository/handoff.ts` imports
  `TransactionAuthority`/`assertInternalTransactionAuthority`/`AtomicWriter`. Everything else in
  `repository/` is state-free.
- **`review ↔ dispatch` is a type/value split**: `review/{counter-review,adjudication}.ts` call
  `dispatch/cli.ts` (`serializeDispatch`, `mint*Observation`) and `dispatch/routing.ts`; in the
  other direction `dispatch/cli.ts` imports only *types* from `review/envelopes.ts`.
- `src/contracts/index.ts` is a broad barrel (~40 `export *`); `mcp-tools.ts` and `contexts.ts` are
  re-exported selectively so internal assertions (`assertAuthenticParsedToolCall`,
  `createInternalResultExpectation`) stay off the public surface.

### `src/mcp/` — protocol stack, bottom up

| File | Lines | Responsibility |
|---|---|---|
| `framing.ts` | 125 | JSON-Line ingress framing; yields `IngressFrame` or a fatal/non-fatal parse error |
| `send-queue.ts` | 267 | Egress serialization, backpressure signalling, admission/completion receipts |
| `session.ts` | 554 | JSON-RPC session state machine + request-token routing; `PRE_INIT → INITIALIZING → … → READY → CLOSING → CLOSED`; emits `SessionAction[]` |
| `server.ts` | 248 | `createToolBoundary` — the only path from wire args to a handler. Validates `schema_version`, parses via `parseToolCall`, re-validates handler output with `validateProjectResultStructure`, coerces any throw to `INTERNAL_ERROR`. Brands outcomes in `WeakSet`s (`assertAuthenticToolBoundaryOutcome`) |
| `sdk-adapter.ts` | 497 | Owns `@modelcontextprotocol/server`'s `Server` + a hand-written `Transport`. Bridges framer → session → SDK → boundary → send queue, and cross-checks the SDK's own projection against `matchesExpectedProjection`, substituting `-32603` on divergence |
| `tools.ts` | 117 | `ADVERTISED_TOOL_CATALOGUE` (see §4) |
| `process-runner.ts` | 208 | Node process lifecycle: signals, exit codes, graceful shutdown |

Protocol version pinned at `sdk-adapter.ts:55` — `"2025-11-25"`. Server identity
`{ name: "archflow-mcp", version: "0.0.0" }`. Custom protocol error codes: `-32001 TOOL_NOT_FOUND`,
`-32002 TOOL_DISABLED`, `-32003 UNSUPPORTED_PROTOCOL`, `-32004 INITIALIZATION_REPEATED`.

Host identity is derived at `initialize` from `clientInfo.name` against a fixed table in
`src/contracts/hosts.ts` (`claude-code` → `claude`, `codex-mcp-client` → `codex`, else `unknown`).

### `src/contracts/` — 50 TS files + 45 JSON Schemas

Pure, filesystem-free. Groups (details in `state-and-contracts.md`):

- **Primitives/JSON**: `plain-json.ts`, `canonical.ts`, `evidence.ts` (branded ids/digests),
  `path-claims.ts`, `phase-instance.ts`, `versions.ts` (the `SCHEMA_IDS` URN registry).
- **Configuration**: `workflow.ts` (Zod + a *fixed* `WORKFLOW_V1` graph that any parsed
  `workflow.yaml` must equal exactly), `config.ts` (per-role model/effort routing),
  `constitution.ts`, `rubric.ts`, `yaml.ts`, `vocabulary.ts`.
- **Durable shapes**: `durable.ts` (1055 lines) plus 11 `durable-*.ts` modules — task state, gates,
  checkpoints, handoffs, result manifests, imports.
- **Trust**: `trust.ts`, `internal/trust-brands.ts` (`WeakMap`/`WeakSet` brands for qualified
  evidence, authority links, validated triage), `internal/test-capabilities.ts`.
- **Protocol**: `mcp-tools.ts`, `tool-names.ts`, `errors.ts`, `contexts.ts`, `hosts.ts`,
  `validators.ts` (Ajv 2020-12 + formats).
- **Rendering**: `renderers.ts` — deterministic Markdown for review/triage/adjudication evidence,
  with aggressive control-character and bidi escaping (`‪-‮`, `⁦-⁩`, `` ` ``,
  `<>&`) so agent-authored prose cannot forge structure.

`schemas/v1/*.json` are imported with `with { type: "json" }` (needs `resolveJsonModule`) and are the
normative side of contract tests in `test/contracts/`.

### `src/state/` — the durable kernel (23 files)

Owns `.archflow/tasks/<task>/`. Everything funnels through two entry points:

- **`transaction.ts:1016` `runStateTransaction(deps, request, prepare)`** — take task lock, read
  current state, verify authority + intent receipt, run the caller's `prepare` callback to build the
  next state and result, then install atomically. Handles crash arbitration on lock-release failure.
- **`gates.ts:1007` `runDurableGate(deps, input)`** — open a gate, project the human interface, wait,
  parse the human's file, archive the decision.

Supporting modules: `atomic.ts` (write-file-atomic), `lock.ts`, `authority.ts` (branded
`TransactionAuthority`), `layout.ts`, `read.ts`, `snapshots.ts`, `transitions.ts`,
`reconciliation.ts`, `repair.ts`, `initialization.ts`, `checkpoints.ts`, `maintenance.ts`,
`evidence-results.ts`, `implementation-manifest.ts`, `fingerprint*.ts`, `constitution.ts`,
`secret-scan.ts` (secretlint), `gate-wait.ts` (500 ms poll), `request.ts`.

### `src/repository/` — git and path safety (8 files)

- `git.ts` — `GitRunner` abstraction over `git` invocations; blob hashing, tree reads, changed paths.
- `identity.ts` — worktree discovery, repository/task identity, `RootBoundGitRunner`.
- `paths.ts` (608 lines) — **the path class table**. Every `.archflow` path a tool may name is
  matched against an anchored regex whose fragments are the regex forms of the branded contract
  types. Resolution uses `realpath` containment + `O_NOFOLLOW`; failures map to `PATH_INVALID` /
  `PATH_ESCAPE` / `TASK_SCOPE_VIOLATION`.
- `attributes.ts` — enforces `.archflow/** -text merge=binary` in `.gitattributes`.
- `history.ts`, `index-entries.ts`, `handoff.ts`, `index.ts` (barrel).

### `src/dispatch/` — outbound CLI adapters (4 files)

- `routing.ts` — `resolveDispatchRoute(config, phaseKind, role, producer_family)`. Model prefix
  decides family (`claude-*` → claude/`claude-cli`, `gpt-*` → codex/`codex-cli`); **a counter-review
  or adjudication route whose family equals the producer's fails with `FAMILY_MISMATCH`** — the
  cross-client guarantee is enforced in code, not convention.
- `cli.ts` (532 lines) — the two adapters. Minimum versions pinned (`CLAUDE_MINIMUM_VERSION
  "2.1.205"`, `CODEX_MINIMUM_VERSION "0.122.0"`), managed-policy paths probed, a long list of Codex
  features force-disabled (`shell_tool`, `hooks`, `plugins`, `browser_use`, …). Mints server-attested
  observations.
- `process.ts` — `runDispatchChild`: 300 s timeout, 8 MiB output cap, plus `scanDispatchOutput`.
- `workspace.ts` — disposable `$HOME` per dispatch, forwarding only `PATH`/`LANG`/proxy/CA vars and
  symlinking exactly one credential file (`~/.claude/.credentials.json` or `~/.codex/auth.json`).
  Refuses to run if `tmpdir()` is inside the repository.

### `src/review/` — orchestration (4 files)

The only layer that composes state + dispatch. Every service takes an explicit dependency record —
no module-level singletons.

- `envelopes.ts` — builds the exact bytes sent to a child CLI; 1 MiB cap (`REVIEW_ENVELOPE_BYTE_CAP`).
- `counter-review.ts` — `runCounterReview`: resolve route → build envelope → `serializeDispatch` →
  mint observation → `prepare_evidence` → `runStateTransaction`. A `fail` verdict is a **successful**
  result; the service never manufactures advancement.
- `adjudication.ts` — `runAdjudication` plus `selectAdjudicationGates` / `crossCheckRuleFindings`;
  loads the pinned constitution, dispatches an opposite-family adjudicator, opens gates for triggers.
- `fixed-point.ts` — `assessCurrentEvidence`, `requireApprovedUpstreamDigests`, `waiverInForce`;
  `DEFAULT_MAX_ATTEMPTS = 3`.

## 6. Build, release, and verification

### TypeScript

`tsconfig.json`: ES2024 / NodeNext / `noEmit`. Notable strictness beyond `strict`:
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`skipLibCheck: false`. Includes `src/**/*.ts`, `test/**/*.ts`, `vitest.config.ts`.
TypeScript is `7.0.2`. `tsc` never emits — esbuild does all bundling.

### esbuild — two profiles

| | Dev (`scripts/build-temp-helper.mjs`) | Release (`RELEASE_BUILD_PROFILE`, `scripts/release-support.mjs:53`) |
|---|---|---|
| entries | `src/contracts/index.ts` **and** `src/main.ts` | `src/main.ts` only |
| sourcemap | `true` | `false` |
| output | temp dir under `os.tmpdir()`, deleted after smoke | `dist/archflow-mcp.mjs` |

Both share `bundle: true, platform: node, format: esm, target: node24` and an exact
`createRequire` banner. The release profile additionally pins `legalComments: "none"`,
`minify: false`, `splitting: false`, and an `allowedImports` allowlist of exactly five node builtins:
`node:buffer`, `node:crypto`, `node:module`, `node:process`, `node:util`.

### Release payload — tracked in git

`RELEASE_FILES` = `archflow-mcp.mjs`, `manifest.json`, `metafile.json`, `legal/THIRD_PARTY_NOTICES.md`,
`legal/review.json`. `dist/manifest.json` is **not** tool metadata — it is a provenance manifest
(bundle digest, per-input digests/sizes/`bytes_in_output`, source-map expectations, dependency
identities with registry URLs + integrity hashes). `.gitattributes` pins `dist/*.mjs text eol=lf` so
the tracked bytes are reproducible.

### `scripts/` (all `.mjs`, run via `npm run …`)

| Script | Purpose |
|---|---|
| `build-temp.mjs` + `build-temp-helper.mjs` + `smoke-temp-bundle.mjs` | Dev bundle in a temp dir, smoke-run, delete |
| `release-support.mjs` (1500+ lines) + `release-support.d.mts` | Shared release engine: build, digest, validate semantics, reproduce, recover |
| `build-release.mjs` / `check-release.mjs` / `reproduce-release.mjs` / `write-tracked-release.mjs` | Stage / verify / byte-reproduce / commit the payload |
| `smoke-release-bundle.mjs` / `test-release-integrity.mjs` | Launch the bundle; mutation-test that tampering is detected |
| `check-dependency-policy.mjs` | Exact-version allowlist for every runtime dependency |
| `check-notices.mjs` / `test-notices-policy.mjs` | `THIRD_PARTY_NOTICES.md` ↔ lockfile ↔ `notices/` consistency |
| `check-phase-4-mcp-boundary.mjs` | Asserts `src/mcp/sdk-adapter.ts` is the **only** file importing `@modelcontextprotocol/*`, and only its public roots |
| `probe-phase-4-mcp-compatibility.mjs` | Runs first against the installed SDK to catch upstream drift |

`npm run check` chains them in the same order `ci.yml` uses. CI also asserts `test ! -e .tmp`.

### Runtime dependencies (all exact-pinned)

`@modelcontextprotocol/server@2.0.0`, `ajv@8.20.0` + `ajv-formats@3.0.1`, `zod@4.4.3`,
`yaml@2.9.0`, `write-file-atomic@8.0.0`, `@secretlint/core@13.0.4` +
`@secretlint/secretlint-rule-preset-recommend@13.0.4`. Engine `node ^24.15.0`.

## 7. Configuration and on-disk layout

`assets/` is the scaffold copied into a target repository's `.archflow/`. No code path in `src/` reads
`assets/` — the runtime reads `.archflow/workflow.yaml` and `.archflow/constitution/*.md` from the
worktree. `scripts/release-support.mjs` declares the asset set in the release manifest so the shipped
scaffold is digest-pinned.

**`assets/workflow.yaml`** — the fixed v1 phase graph, mirrored byte-for-byte by `WORKFLOW_V1` in
`src/contracts/workflow.ts`; `parseWorkflowV1` rejects anything that differs:

| phase | skill | requires | iterates | pipeline | gate |
|---|---|---|---|---|---|
| `explore` | archflow-explore | — | — | produce | never *(optional)* |
| `prd` | archflow-prd | — | — | produce, self_review, counter_review, triage, adjudicate | always |
| `design` | archflow-design | prd | — | (full) | always |
| `phase-design` | archflow-phase-design | design | per_phase | (full) | on_trigger |
| `phase-impl` | archflow-phase-impl | phase-design | per_phase | (full) | on_trigger |

**`assets/constitution/`** — one rule per numbered file, YAML frontmatter `{id, version, status,
review_trigger}` + prose body. Rule IDs are append-only; deprecate, never delete or reactivate. Tasks
pin these from an immutable human-approved policy-base commit, so a task branch cannot amend its own
governing constitution (`src/state/constitution.ts` resolves the pin and detects task-local edits).

**Per-task `config.yaml`** — `src/contracts/config.ts`: `{schema_version, roles, overrides?,
max_attempts?}` with roles `producer | self-reviewer | counter-reviewer | adjudicator`, each
`{model, effort}` where effort ∈ `low|medium|high|xhigh|max|ultra`.

**Task tree** (`.archflow/tasks/<task>/`, from the class table in `src/repository/paths.ts:130`):

```
config.yaml                                   task-config
state.json                                    task-state
gate.json | gate.decision                     gate-interface   ← the human's read/write surface
prd.md | design.md | phases/<n>/design.md | phases/<n>/impl-notes.md   document
reviews/<phase-instance>.{self,counter,triage,adjudication}.md         review
reviews/<phase-instance>.gate-counter.<gate-id>.md                     review
decisions/<gate-id>/{request,decision}.json   decision
results/sha256/<digest>/manifest.json         result-manifest
results/sha256/<digest>/payload/<path>        result-payload
intents/<intent-id>.json                      intent
attempts/<phase-instance>/<attempt-id>.json   attempt
manual/checkpoints/<revision>-<digest>.json   manual-checkpoint
maintenance/<id>.json                         maintenance-record
imports/<digest>/{manifest.json,payload/…}    import
```

Repository-scoped classes: `shared-workflow` (`.archflow/workflow.yaml`), `shared-constitution` /
`task-branch-constitution` (`.archflow/constitution/<name>.md` — same path, distinguished by the
caller's `expectedClass`, not by the path), `repository-source` (anything outside `.archflow/`).

**The human gate interface** (`src/state/gates.ts:212 activeProjection`): the server writes
`gate.json` containing the request plus a `decision_template` that enumerates every field the
resolver accepts — `required_fields` (`["payload","human_provenance"]`, or
`["granted","scope","origin","notes","human_provenance"]` for a waiver gate) and
`cancellation_fields` (`["cancelled","reason","human_provenance"]`). The human writes
`gate.decision`; `parseInterface` binds it to the archived request by `gate_id`, `task_id`,
`phase_instance`, `subject_digest`, and `context_digest` before it counts. `gate.json`/`gate.decision`
are disposable projections — the durable authority is `decisions/<gate-id>/{request,decision}.json`.

## 8. Skills ↔ runtime

| | `skills/*/SKILL.md` | `src/` |
|---|---|---|
| Form | Markdown + `{name, description}` frontmatter | TypeScript |
| Distribution | `install.sh` copies to `~/.claude/skills/`, `~/.agents/skills/` | esbuild bundle, launched over stdio |
| Coupling | phase→skill names in `workflow.yaml`; the `.archflow/` file layout | same layout, enforced by `src/repository/paths.ts` |

The skills currently work standalone — an agent following `SKILL.md` writes `.archflow/` files
directly. The MCP server exists to make those writes transactional, digest-bound, and gated, but
because the runtime is inert (§3) that substitution has not been switched on. `docs/archflow-process.md`
documents the skill-only workflow; `docs/mcp-integration-design.md` is the originating design and
notes that `.archflow/tasks/mcp-integration/{prd,architecture}.md` are normative where they differ.

## 9. Testing

`vitest.config.ts`: node environment, `test/**/*.test.ts`, coverage to `coverage/`.

| Suite | What it buys |
|---|---|
| `test/unit/` (76) | One file per source module, near 1:1 with `src/**` |
| `test/contracts/` (16) | TS types ↔ JSON Schema agreement, schema registry completeness, canonicalization parity, release manifest contracts |
| `test/integration/` (10) | Real stdio MCP session, real git repositories, real child-CLI dispatch, offline release launch |
| `test/crash/` (4) | Interrupted transaction / gate-lifecycle / initialization recovery |
| `test/types/` | Compile-time assertions |

`test/helpers/temp-repository.ts` builds throwaway git repos; `test/fixtures/mcp/runtime/*.json`
are also release proof inputs (listed in `PROOF_INPUTS`), so changing them invalidates release
evidence.
