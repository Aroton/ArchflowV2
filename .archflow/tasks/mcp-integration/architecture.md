# Architecture: MCP Integration

> Technical design for MCP Integration based on [prd.md](./prd.md), originating from the repository's [detailed design](../../../docs/mcp-integration-design.md)

`docs/mcp-integration-design.md` is preserved as the originating design lineage. The approved PRD and this architecture are normative wherever they differ; the source design receives a visible lineage/supersession banner and remains linked through later documentation updates rather than being treated as unrelated obsolete material.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime and language | Node.js `24.15.0` functional minimum; TypeScript `7.0.2`; `@types/node` `24.13.3`; ECMAScript modules | `write-file-atomic` 8 sets the functional Node floor. Release and CI use the current Node 24 LTS security patch (`24.18.0` at design time), while `@types/node` `24.13.3` is the current compatible Node-24 major typing line pinned independently; runtime and typings patch numbers need not match. |
| MCP | Protocol `2025-11-25`; exact `@modelcontextprotocol/server@2.0.0` with locked `@modelcontextprotocol/core@2.0.0` | Stable server/core were published `2026-07-27T23:55Z`; the completed currency review found unchanged consumed public signatures, legacy runtime behavior, MIT metadata, and transition-license text. The hand-built low-level `Server` remains on the 2025-era path without modern opt-in, so protocol `2026-07-28` adoption is deferred. The SDK is isolated behind the adapter; production imports of core/internal paths are prohibited, there is no `@modelcontextprotocol/node` dependency, and SDK v1 is not a fallback. |
| Tool schemas | Zod `4.4.3` | MCP-facing schemas are derived or wrapped from the normative durable contracts wherever shapes overlap, with only transport-specific wrappers defined locally. |
| Durable schemas | JSON Schema 2020-12 with Ajv `8.20.0` in strict mode | The versioned durable JSON Schema is normative for every persisted shape and every overlapping MCP/persisted shape; files remain independently readable and fail closed on unknown or contradictory data. |
| YAML contracts | `yaml` `2.9.0` | Parses workflow/config files with actionable source locations. |
| Persistence | Repository files, core SHA-256, `write-file-atomic` `8.0.0`, `proper-lockfile` `4.1.2` behind an internal adapter | Keeps authority inspectable and branch-shareable. The lock package's maintenance risk is contained behind replaceable interfaces and crash/race fixtures. |
| Child processes | `execa` `10.0.0` with `shell: false`, `killDescendants: true`, `cancelSignal`, timeout, `maxBuffer`, and forced-termination escalation inside provider-owned OS containment | Execa supplies process control, but each provider must also use a PID namespace/cgroup, Windows job object, or proven equivalent that terminates descendants even after they create new process groups or sessions. |
| Packaging | esbuild `0.28.1`, exact npm lockfile, single host-neutral server/local-helper bundle | `install.sh` installs both `archflow-mcp` and `archflow-local` without an unpinned startup download. |
| Verification | Vitest `4.1.10` with direct dev pin Vite `7.3.6`, fixture CLIs, fault injection, protocol fixtures, and black-box host/sandbox suites | The exact Vite 7 pin constrains Vitest to its supported permissive line; the lock must prove no `lightningcss` or other copyleft dependency before acceptance. Critical persistence, host, process, protocol, and manual-mode behavior is exercised at its real boundaries. |

All runtime and development dependencies are exact lockfile pins. An update deliberately regenerates the lockfile, runs schema/protocol/CLI fixtures, verifies licenses, and records any format migration; beta, model, and CLI versions never float at startup. Direct pins are permissively licensed, and the complete lock must independently prove a permissive-only graph. The repository currently has no project license, which release packaging records alongside dependency notices. `@anthropic-ai/sandbox-runtime` is the preferred Phase 12 candidate behind the provider interface, not an adopted dependency: its package is Apache-2.0, while its Linux bubblewrap and socat paths introduce LGPL-2.0-or-later and GPL-2.0-only components. Those require later explicit user license approval; without it, affected environments remain unsupported.

## System Architecture

The MCP server is a local, stdio-only durable workflow coordinator. Skills remain the host-neutral source of phase-specific production instructions and rubrics. The server owns only capabilities prompts cannot safely supply: validated transitions, immutable retained results, cross-family process dispatch, policy/drift adjudication, and durable human decisions.

```text
Claude Code or Codex
        |
        | thin host-neutral skill + exactly five MCP tools
        v
MCP v2 stdio boundary
        |
        +--> request validation / immutable connection identity
        +--> repository + task path guard
        +--> workflow/state transition service
        +--> file store: lock, CAS, snapshots, projections, reconcile
        +--> gate/waiver service <---- explicit local decision files
        |
        +--> dispatch coordinator
               |
               +--> versioned, hashed, size-bounded envelope
               +--> capability-proven OS sandbox
               +--> fresh Claude CLI or Codex CLI process
               +--> structured JSON validation
               +--> canonical Markdown renderer

archflow-local (same installed bundle, no MCP transport)
        +--> validate / hash / canonical render
        +--> snapshot / collision-safe restore
        +--> atomic decision creation / degraded status
        +--> reconcile/import / legacy upgrade staging

Git task branch
  records workflow state, evidence, decisions, and authoritative snapshots
  for the development lifecycle; .archflow/ is deliberately removed before PR
```

### Request and Mutation Flow

The server establishes the repository identity, supported host identity, protocol version, and configuration policy during MCP initialization. A tool call cannot override connection host identity. Every mutating request then follows this order:

1. Canonicalize the Git worktree and task identity, resolve every declared path, and reject traversal, absolute paths, symlink escapes, cross-task paths, or repository-identity mismatch before any artifact read or child launch.
2. Reconcile the bounded current working set against validated state, then acquire the task-specific same-filesystem process lock. Tasks have independent locks.
3. Reread and strictly validate `state.json` and every referenced machine-readable input; never rely on an earlier in-memory copy. If state is absent, reject every operation except a direct normal/legacy initialization artifact or a `manual-checkpoint-import` whose checkpoint 1 contains one of those valid initialization manifests.
4. Compare `expected_revision` independently on every invocation, including retries and replay attempts; a mismatch returns `STATE_CONFLICT` before intent handling.
5. Check `intent_id` against the canonical request digest. A replay succeeds only when current validated state references the committed intent, result, and resulting revision. A matching but merely prepared receipt is not success; changed reuse returns `INTENT_MISMATCH`.
6. Verify the entire versioned `config.yaml` against the digest pinned at task initialization, returning non-advancing `PINNED_CONFIG_MISMATCH` before dispatch or transition on any byte change; then recompute the declared-input fingerprint from canonical bytes and pinned inputs. The caller's `input_fingerprint` is an assertion, never authority.
7. Perform the bounded operation. Model calls execute from a non-repository temporary directory through the proven sandbox provider. Model JSON must validate before it can become evidence.
8. Materialize the complete immutable result and manifest under its content address, then atomically replace only the declared canonical projections and a `prepared` intent receipt. All pre-state artifacts remain explicitly non-authoritative.
9. Atomically replace `state.json` last with the next monotonic revision and references to the prepared intent/result, thereby committing them. A later maintenance pass may mark the receipt committed, but state is the authority.

A crash before step 9 never implies success. Ordinary pre-request reconciliation is bounded to the projections referenced by current state, the active or prepared intent relevant to the request, and the active gate or manual-checkpoint head; it does not scan retained result, intent, decision, or checkpoint history. A full-chain/history audit is reserved for explicit repair, import, or audit operations. Reconciliation restores the current projections when collision-safe, otherwise stops for the applicable gate or exact repair; it never promotes a prepared/orphan result or model output by inference. Long-lived gates are the exception to holding a lock continuously: gate creation is committed under the sequence above, the lock is released while the request blocks on a decision file, and resolution reacquires the lock and applies a new CAS transition against the same gate ID.

The canonical request digest has one closed field list: contract/schema version, logical tool name, canonical repository identity, canonical task identity, operation tag, that operation's request-specific semantic fields from the five-tool table and closed artifact union, and the recomputed declared-input fingerprint. No other field participates. In particular, `intent_id` identifies the receipt but is not self-hashed, while `expected_revision`, connection/transport identifiers, timestamps, attempt counters, timeout/cancellation state, and retry metadata are excluded. CAS remains independent: a retry after `SUPPLEMENTAL_REVIEW_REQUIRED` reuses the same intent and digest with the newly observed `expected_revision`; if triage changes or supersedes the subject, the caller creates a fresh `intent_id`, fingerprint, and request digest.

Locking and revision CAS coordinate only processes sharing the same filesystem. Git is transport and history, not a distributed lock. Cross-clone concurrent mutation is unsupported and locally undetectable before histories diverge, so one-writer handoff is an operational precondition rather than a server-enforced exclusion. One active writer/worktree owns a task branch; handoff requires an explicit human-approved checkpoint commit and push, a clean pull by the next writer, and identity/revision/conflict checks before mutation. Startup and pull/handoff checks detect divergent task-branch history or Git conflicts; `.archflow/**` uses `merge=binary` (or an equivalent non-text merge policy), and any conflict/divergence state is non-authoritative and blocks mutation. Repair guidance preserves both heads, names the last common authoritative checkpoint, requires the human to choose/replay one successor chain, and records a fresh clean handoff before the next writer resumes. Neither the server nor helper auto-merges, commits, pushes, or claims it can reject an independent clone before divergence.

Repository initialization and task initialization are distinct. `archflow-init` scaffolds repository assets and host registration only. Before a task can start, the workflow and constitution assets must exist in an immutable human-approved commit; ArchFlow never creates that commit automatically. Fresh task creation through its skill and `archflow-local` stages a `task-initialization` manifest, and `archflow_state` adopts it directly or through a closed manual checkpoint import whose first checkpoint contains that manifest. Both routes begin at no-state/revision-sentinel-0 and establish initialized/revision-1 authority before adopting any later checkpoint. Missing, uncommitted, mismatched, or task-locally modified policy bases fail closed.

### Directory Structure

```text
package.json
package-lock.json
tsconfig.json
vitest.config.ts
src/
  main.ts                         # thin real-process binding; protocol-only stdout
  mcp/
    server.ts                     # SDK-free authenticated tool boundary
    tools.ts                      # exactly five registrations
    framing.ts                    # strict bounded SDK-free JSONL byte framer
    session.ts                    # SDK-free lifecycle, routing, IDs, and request records
    send-queue.ts                 # bounded FIFO and caller-stream write ownership
    sdk-adapter.ts                # sole stable SDK import; Server/Transport isolation
    process-runner.ts             # SDK-free termination, diagnostics, and exit arbitration
  local/
    cli.ts                        # archflow-local command surface
    operations.ts                 # shared validation/reconcile/manual operations
  contracts/
    mcp.ts                        # Zod request/result/error contracts
    schemas/                      # versioned JSON Schemas for durable files
    workflow.ts                   # fixed graph/vocabulary validation
    renderers.ts                  # structured JSON -> canonical Markdown
  repository/
    identity.ts                   # Git/worktree discovery and immutable identity
    paths.ts                      # task-scoped allowlist and symlink defense
  state/
    store.ts                      # transition orchestration and reconciliation
    transitions.ts               # legal state machine
    snapshots.ts                  # content-addressed result materialization/restore
    atomic.ts                     # atomic replacement abstraction
    lock.ts                       # wrapped per-task lock implementation
    implementation-manifest.ts    # source-tree/diff snapshot contract
    legacy-import-manifest.ts     # no-state initialization contract
  decisions/
    gates.ts                      # one-active-gate lifecycle
    waivers.ts                    # rule-scoped grants/denials
  review/
    envelopes.ts                  # bounded, hashed child inputs
    counter-review.ts
    adjudication.ts
    render.ts
  dispatch/
    coordinator.ts
    errors.ts                     # stable failure taxonomy
    environment.ts               # allowlisted child environment
    process-tree.ts
    sandbox/
      provider.ts                 # capability/proof interface
      probe.ts                    # black-box repo-read/write isolation checks
    hosts/
      claude.ts
      codex.ts
      identity.ts
  init/
    assets.ts
    registration.ts              # preserving JSON/TOML/settings edits
    diagnostics.ts
assets/
  workflow.yaml
  constitution/
    README.md
    00-process.md
    10-architecture.md
    20-data.md
    30-product.md
skills/                            # one host-neutral source, copied to both clients
  archflow-init/SKILL.md
  archflow-upgrade/SKILL.md
  archflow-explore/SKILL.md
  archflow-prd/SKILL.md
  archflow-design/SKILL.md
  archflow-phase-design/SKILL.md
  archflow-phase-impl/SKILL.md
  archflow-status/SKILL.md
test/
  unit/
  contracts/
  fixtures/
    mcp/
    claude-cli/
    codex-cli/
    repositories/
    corpus/
  integration/
  isolation/
  crash/
  e2e/
dist/                              # generated offline server/helper bundle, release artifact
install.sh
.github/workflows/ci.yml
```

Initialization creates the canonical repository-owned layout below. This layout supersedes the old `architecture.md`, flat phase documents, and ad hoc review names for new tasks; a canonical task has only one authority.

```text
.archflow/
  workflow.yaml
  constitution/
    README.md
    00-process.md
    10-architecture.md
    20-data.md
    30-product.md
  <shared global documents>
  tasks/<task>/
    config.yaml                      # versioned whole-file digest pinned at task initialization
    state.json
    gate.json                       # only while one gate is active
    gate.decision                   # active-gate decision interface
    prd.md
    design.md
    phases/<n>/
      design.md
      impl-notes.md
    reviews/
      <phase-instance>.self.md
      <phase-instance>.counter.md
      <phase-instance>.triage.md
      <phase-instance>.adjudication.md
      <phase-instance>.gate-counter.<gate-id>.md
    decisions/<gate-id>/
      request.json
      decision.json
    results/sha256/<result-digest>/
      manifest.json
      payload/<declared-output-path>
    intents/<intent-id>.json
    attempts/<phase-instance>/<attempt-id>.json
    manual/checkpoints/<revision>-<checkpoint-digest>.json
    maintenance/<maintenance-id>.json
    imports/<import-digest>/
      manifest.json
      payload/<legacy-relative-path>
```

`results/`, `intents/`, `attempts/`, `manual/checkpoints/`, reviews, decisions, and state are ordinary files checked into Git with the task on its shared branch. Snapshot/checkpoint manifests and manual checkpoints are immutable after creation. `attempts/` is diagnostic and cannot authorize advancement. Every currently authoritative generation and all decision, review, and manual-checkpoint evidence remain retained for the task lifetime. `.archflow/` provides development-lifecycle traceability only and is removed before PR; v1 deliberately does not add or promise a permanent audit export.

### Data Model and Invariants

| Entity | Durable identity and content | Authority/invariant |
|--------|------------------------------|---------------------|
| Repository | Canonical worktree root, Git common identity, immutable starting commit | Relocation and linked worktrees are supported; the identity must still match the active task. |
| Task | Canonical task ID, repository identity, import/code baseline, approved policy-base commit, pinned constitution/workflow digests, and whole-file `config.yaml` digest | The approved policy base is explicit and separate from imported or current code. The entire versioned config is immutable for the task; normal execution never reads another task. |
| Task initialization manifest | Versioned normal task ID/repository identity, normal code baseline, explicitly approved policy-base commit and constitution digest, pinned workflow digest, exact whole-file `config.yaml` digest, and canonical paths | Required first authority for a normal task, supplied directly or as checkpoint 1 of a closed manual import. Its policy assets must resolve from an immutable human-approved commit; ArchFlow does not commit them. |
| State revision | Schema version, monotonic revision, phase instance, step/status/attempt, authoritative result refs, approvals, open gate, waivers | `state.json` is normal-mode authority and is written last. A successful step references validating artifacts with matching digests. |
| Declared-input fingerprint | Hash of versioned workflow, the immutable whole-config digest, pinned constitution, canonical artifact/upstream Git identities, rubric, phase instance, and explicitly declared inputs | Recomputed by the server from the canonical identities below. Whole-config binding is deliberate: because config cannot change within a task, it never causes partial in-task invalidation. |
| Result snapshot | Content-addressed manifest, canonical Git identities for tracked outputs, and bounded copied payloads only where required | Immutable and task-local. Canonical Markdown/files are replaceable projections of a referenced snapshot; copied payload accounting enforces the limits below. |
| Intent receipt | Intent ID, canonical request digest, prior/result revision, result/error reference, `prepared`/`committed` marker | Prepared receipts are never replay success. Only current state can commit/reference an intent/result/revision; changed reuse is `INTENT_MISMATCH`. |
| Implementation-output manifest | Versioned tagged artifact binding declared source/task paths and add/modify/delete/rename operations; file type, tree mode, and canonical Git blob identities; before/after digests; base/index/worktree identity; parent-document outputs; exact canonical diff digest; snapshot/restore targets; bounded raw payload bytes where required; and undeclared-change scan | It is the complete phase-implementation and commit-authorization subject. Tracked outputs reuse Git objects rather than copied payloads; restore is collision-safe in normal and manual mode. |
| Legacy-import initialization manifest | Versioned tagged artifact containing selected legacy source identity, immutable import digest, destination identity, code/import baselines, approved policy-base commit/constitution, exact destination `config.yaml` digest, canonical mapping, and staged payload refs | Authorizes only the no-state → initialized transition for a distinct destination and pins that destination's whole config. Imported prose/history remains unapproved/historical. |
| Manual milestone checkpoint | Immutable schema-versioned task/phase/step/status, declared-input fingerprint, authoritative result/snapshot and projection digests, current evidence chain, decisions/gates/waivers, predecessor checkpoint digest/revision, and degraded assurance | In manual mode, only snapshots reachable from the latest valid predecessor-linked checkpoint are authoritative. Prepared/uncheckpointed files are not. Normal and legacy initialization each begin with a checkpoint. |
| Review evidence | Structured source JSON represented by canonical Markdown with subject/input digests, stable findings, verdict/counts, assurance and execution metadata | JSON validates before Markdown rendering. Server-attested, agent-declared, and degraded provenance are distinct and cannot be upgraded by prose. |
| Gate | Unique ID, task/phase/kind, subject/context digests, allowed decisions, active status | At most one active gate per task. Timeout, cancellation, disconnect, or missing decision leaves it pending. |
| Decision | Gate ID, exact subject/context digests, allowed explicit outcome, notes/provenance | Resolves once and is retained under `decisions/<gate-id>/`; singular gate files are interfaces, not history. |
| Waiver | Pinned rule version, narrow scope, task/subject/evidence digests, explicit grant/denial and expiry | Never amends policy, crosses tasks, or silently follows a changed subject. |
| Phase instance | `prd`, `design`, `phase-design-<n>`, or `phase-impl-<n>` | Encoding is reversible; phases and supplemental gate reviews never overwrite one another. |

Canonical Git identity is part of the contract, not an ambient checkout accident. Pinned committed inputs bind the exact Git blob bytes and tree modes from the pinned tree. Repository attributes mark `.archflow/** -text merge=binary`, so its tracked authority bytes neither pass through end-of-line conversion nor receive text merges. For tracked implementation outputs, the manifest binds and reuses the canonical Git blob OID produced after the path's Git attributes/clean conversion plus the tree mode (`100644`, `100755`, `120000`, or deletion); their payload bytes are not duplicated in result storage. Raw payload bytes are copied only when collision-safe restoration needs bytes not available from the bound Git object or an output is untracked/generated and therefore has no canonical blob yet. This contract is invariant across `core.autocrlf`, working-tree line endings, `core.fileMode`, executable-bit support, and symlink checkout capability; unsupported materialization fails with guidance instead of changing the identity.

Copied untracked/generated/restore payload is capped at 25 MiB per result and 250 MiB per task, counted from validated stored bytes before projection. Exceeding either limit returns stable non-advancing `SNAPSHOT_LIMIT` with the exact offending paths, current/cap byte counts, and safe guidance to reduce or track the declared output; payload is never truncated and never moves to external hidden authority. Before any snapshot or manual checkpoint is projected into Git-tracked `.archflow/`, ArchFlow scans the complete candidate projection for secrets and fails closed with path-safe remediation. Guidance explicitly warns that later deletion of `.archflow/` does not erase secrets from branch history.

Retention preserves every currently authoritative generation and the complete decision/review/manual-checkpoint chain through task lifetime. An explicit human-approved maintenance operation may prune only unreferenced diagnostic attempts and superseded non-authoritative payloads after reachability validation proves deterministic rerun and every checkpoint chain remain intact. It writes an immutable maintenance record containing every deleted digest, byte count, and human reason before deletion; it cannot prune manifests, current generations, authoritative evidence, or any payload still needed for replay/restore.

The entire versioned `config.yaml` is pinned byte-for-byte by its initialization digest. Every status/readiness check and mutating invocation verifies it before dispatch or state transition; any difference returns `PINNED_CONFIG_MISMATCH`, identifies the expected and observed digests without echoing config content, and gives one safe next action. There is no in-task amendment or re-pin. An intentional routing, model, or effort change requires a distinct new task or the explicit upgrade flow, so whole-config fingerprint binding never triggers partial in-task evidence invalidation.

If restoring a declared path would overwrite divergent worktree bytes, reconciliation opens the sole active `restore-collision` gate. Its exact decisions are: `discard-and-restore`, which discards only the declared-path worktree bytes and restores the recorded generation; `adopt-as-new-generation`, which is valid only after the caller changes the declared inputs/fingerprint and supplies a rationale, then creates a new generation from those bytes; or `abort`, which leaves both worktree and state non-advancing. No default, timeout, retry, manual fallback, or repair path silently overwrites the collision.

Further invariants:

- The shipped workflow has a fixed phase/step vocabulary. The repository copy is inspectable and driveable, not a plugin engine; structural edits fail validation.
- Normal task state cannot appear from directory presence. Only a validating `task-initialization` transition creates revision 1; legacy initialization uses its separate tag. Both pin an approved immutable policy basis.
- The phase lifecycle remains no document → `DESIGNED` → `IN PROGRESS` → `COMPLETE`. Phase implementation cannot start until the current phase design is workflow-approved.
- An artifact rewrite invalidates all dependent current-digest evidence. Accepted review findings rerun self-review, counter-review, and triage; only the final digest is adjudicated. Exhaustion opens a gate.
- PRD and design always gate. Trigger/uncertainty, material drift, failed adjudication, attempts exhaustion, waivers, and task-branch constitution edits gate. Every implementation also requires a separate digest-bound commit authorization.
- The pinned constitution is read from the immutable base commit. Missing/stale `enforced_by` evidence does not pass. A task-branch constitution-edit gate may request revert/abort or base-branch amendment work, but cannot approve the edit.
- Approved upstream snapshots remain addressable after canonical parent documents are updated. Accepted material drift reopens the affected upstream evidence and approval chain.
- Normal evidence is server-attested only where the server observed the adapter, CLI, family, model, effort, input, and result. In-session self-review is agent-declared or unknown. Manual fallback is explicitly degraded.
- Pure manual authority is the greatest valid immutable checkpoint chain, never loose files or a fabricated `state.json`. Each checkpoint commits exact snapshots, projections, evidence, and decisions through its predecessor digest.
- One active gate is preserved through waiver sequencing. A current review/approval gate may resolve explicitly as non-advancing `waiver-requested`, then closes and archives before `archflow_waiver` opens the sole waiver gate for the recorded rule and scope. A grant resumes the phase against exactly that record; denial remains non-advancing. Gates are never nested.

### Five-Tool MCP API Boundary

The MCP server registers exactly these five logical workflow tools. All requests and results are versioned. Repository/task identity comes from validated connection/request context. Every mutation includes `intent_id`, `expected_revision`, and caller-asserted `input_fingerprint`; every success reports the resulting revision. Every error has a stable code, retryability, and safe diagnostic and performs no success side effect.

| Tool | Request-specific fields | Success result | Architectural effect |
|------|-------------------------|----------------|----------------------|
| `archflow_state` | `phase_instance`, `step`, `status`, optional versioned `artifact` tagged union | `path`, `revision`, `status` | Validates a workflow transition and atomically projects the next `state.json`; same-intent replay returns a result only when current state commits it. |
| `archflow_counter_review` | task-relative `artifact_path`, structured `rubric` | `path`, `verdict`, `blocking_count`, `revision` | Dispatches a fresh opposite-family process with only the counter envelope, validates JSON, stores a result snapshot, and projects the phase-instance counter-review Markdown. |
| `archflow_adjudicate` | task-relative `artifact_path`, declared `upstream_paths` | `path`, separate `constitution` and `drift`, `triggers`, `revision` | Dispatches the configured adjudicator against the pinned constitution and approved upstream snapshots, then records canonical evidence. |
| `archflow_gate` | `phase_instance`, `summary`, structured `context` | explicit `decision`, `notes`, `revision` | Creates or resumes one digest-bound gate and remains pending until a valid decision or explicit cancellation/failure. It never returns “pending” as success. |
| `archflow_waiver` | `rule_id`, `rationale`, narrow `scope` | explicit `granted`, `notes`, `revision` | Uses the same durable gate mechanism and records a grant only for the pinned rule/task/subject/scope. |

Init, upgrade, status reconstruction, Git inspection, ordinary file reads, artifact production, and manual fallback remain skill or server-internal mechanics. They do not add a sixth tool.

`archflow_state.artifact` is a closed, versioned tagged union:

- `task-initialization` binds a fresh task ID/repository identity, normal code baseline, explicitly approved policy-base commit and constitution, pinned workflow digest, exact whole-file `config.yaml` digest, and canonical paths. It is the required first normal authority and may be adopted directly or only as checkpoint 1 of a validating `manual-checkpoint-import`.
- `document` binds a canonical task-relative document path, bytes/digest, declared inputs, snapshot, and projection target.
- `implementation-output` carries the complete implementation-output manifest: declared repository/task-relative source paths; add/modify/delete/rename operations; regular/symlink file type and tree mode; canonical post-attributes Git blob OIDs reused for tracked outputs; capped raw payload bytes only for collision-safe restore or untracked/generated outputs; before/after identities; immutable base commit plus index/worktree identity; parent PRD/design/implementation-note outputs; the exact canonical diff digest used for review and commit authorization; snapshot and restore targets; byte-accounting/secret-scan results; and undeclared-change detection results. Restore validates current collisions and before-images before changing only declared targets; ambiguity opens `restore-collision` and is non-advancing in both normal and manual modes.
- `legacy-import-initialization` carries the immutable staged-import manifest required as the first authority for a legacy destination, including the destination's exact whole-file `config.yaml` digest. It may be adopted directly or as checkpoint 1 of a closed manual import. It uses existing `phase_instance: prd`, leaves the imported PRD draft pending its normal pipeline, creates no migration phase, separates policy from code/import baselines, and rejects unresolved task-local constitution edits.
- `manual-checkpoint-import` carries the greatest fully validated predecessor-linked manual checkpoint chain for adoption/reconciliation into server state. When state is absent, checkpoint 1 must contain a valid `task-initialization` or `legacy-import-initialization`; the server establishes revision 1 from it, then adopts the remaining closed chain without replaying decisions. A single state-last commit references the validated chain and final adopted revision, so interruption cannot expose partial authority. When state exists, the predecessor must match it exactly. No route imports a gap, loose prepared file, or unreferenced decision.

The union makes document, code-output, and migration state representable without adding a tool or inventing a migration phase instance.

Gate IDs are deterministic and caller-known from canonical task identity, `intent_id`, and request digest. A skill can therefore present the REQ-41 prompt with the exact gate ID before invoking the blocking call. `archflow_gate` publishes and commits the request before it waits. The other client emits versioned structured JSON, not an authoritative Markdown file. From a second terminal, the human runs `archflow-local` in normal or manual mode; it validates the JSON, binds the exact task/gate/subject/input digests, canonically renders it, and atomically renames the complete projection to `reviews/<phase-instance>.gate-counter.<gate-id>.md`. The blocking server observes only complete atomic projections, using a filesystem notification plus bounded polling fallback so missed/coalesced notifications do not strand a gate.

While a gate is pending, its closed legal transition set is supplemental-review ingestion, triage of that review, an explicit decline or gate decision, explicit cancellation, or supersession after an accepted change/changed subject. If an untriaged supplemental review arrives, the wait ends with retryable non-success `SUPPLEMENTAL_REVIEW_REQUIRED` while the gate remains pending. The resumed orchestrator rejects current-digest findings and retries the same intent with refreshed CAS, or accepts a change, closes the gate as non-advancing `superseded`, re-enters the fixed-point pipeline, and later creates a fresh intent and deterministic gate for the new subject. Explicit decline fabricates no review and allows the otherwise-valid decision path.

### Review Dispatch and Trust Boundaries

The producer host is derived only from immutable MCP `clientInfo` and supported real-host handshake fixtures. Unknown or ambiguous hosts return `UNSUPPORTED_HOST` before dispatch. Per-task routing can select model and effort, but trusted adapter metadata defines family; counter-review refuses same-family routing with `FAMILY_MISMATCH`. Adjudication may use the opposite family normally; an unavoidable same-family manual adjudication is labeled degraded and failure/uncertainty gates.

Each dispatch creates a fresh, non-resumed child in a temporary directory outside the repository. Counter-review receives only the artifact bytes, adversarial rubric, fixed result schema, and minimal phase/execution identity. Adjudication receives only its artifact, fixed schema, pinned constitution, and declared approved upstream bytes. Envelopes are canonical, size-bounded, hashed, and retained as declared input evidence. A measured host-specific read set contains the selected first-party CLI's executables, libraries, CA material, and narrowly required own subscription-authentication paths plus envelope/temp paths. ArchFlow trusts that supported CLI and its descendants to use that CLI's own credential store; shared access within the selected CLI process tree is not a release blocker. ArchFlow itself never reads, copies, injects, prompts for, persists, or logs credential values. Generated empty config/home paths are used where compatible. Producer history, triage, prior findings, repository/global agent instructions/config, the other model family's credential store, unrelated secrets/files, and child persistence remain denied.

`--sandbox read-only` and a temporary current directory are defense-in-depth, not the repository-read boundary. A `SandboxProvider` must:

- declare its OS/runtime/license identity;
- prepare an auditable allowlist containing the envelope, temp/output paths, and only the measured runtime plus selected CLI's narrowly required own authentication paths;
- prevent reads and writes to the repository and sibling tasks by absolute path, traversal, symlink, inherited descriptor, or child process;
- deny global agent instructions/config, the other model family's credential store, and unrelated secrets; scrub API keys and provider-routing variables; and prove unrelated-secret canaries cannot be read or emitted without treating the selected CLI process tree's use of its own subscription store as a failure;
- allow only the provider-network behavior needed by the first-party CLI;
- use an OS containment primitive capable of terminating every descendant on abort, timeout, server shutdown, or output overflow even if a descendant creates a new process group/session—PID namespace/cgroup, Windows job object, or a proven equivalent, not Execa best effort alone; and
- return a capability proof tied to the OS, provider, CLI/runtime versions, exact allowed-read manifest, and randomized denied canaries.

At install/startup and whenever that fingerprint changes, a black-box probe launches a real child that uses the selected CLI's measured runtime and own-auth paths, reads its envelope, and writes temp output while failing to read/write randomized repository, sibling-task, global agent config/instructions, the other family's credential store, and unrelated-secret canaries. ArchFlow never opens or copies the selected CLI's own credential files, and captured output/persisted diagnostics are scanned for unrelated-secret canaries and prohibited API-key/provider-routing material, not for the mere use of the supported CLI's own authentication. Managed Claude hooks/policy or Codex managed/global instructions make the environment unsupported unless real fixtures prove no injection. The proof is completed in Phase 12 for both producer directions. `@anthropic-ai/sandbox-runtime` remains a non-adopted preferred candidate subject to proof and license approval.

The Claude adapter uses fresh `--safe-mode`, `--tools ""`, a strict empty MCP config, disabled slash commands, no persistence, and schema-constrained output. It preflights subscription authentication and managed hooks/policy. Host setup configures and validates the Claude server entry's persistent per-server `timeout` when supported; otherwise a newly started host must inherit `MCP_TOOL_TIMEOUT` as described below. Cancellation or host timeout always leaves a durable resumable gate; timeout-then-resume is supported normal behavior. The Codex adapter uses exact fixture-proven ephemeral, ignore-user-config, `--ignore-rules`, read-only, and output-schema behavior while preserving first-party auth; `--ignore-rules` is inherited-context isolation only, never security confinement. It configures/tests `project_doc_max_bytes=0` or a proven equivalent and rejects managed instruction injection. An ArchFlow deny-all Codex execpolicy remains an early feasibility candidate, and the design does not claim it works. Both adapters still require OS sandbox proof, are version-gated from real fixtures, and spawn with `shell: false`, scrubbed environment, no provider keys/routing or unrelated secrets, `killDescendants`, cancellation, timeout/output bounds, forced escalation, and provider-owned descendant containment. Stable failures cover missing CLI, auth, unsupported host/model, family mismatch, rate limit, timeout, cancellation, overflow, invalid output, nonzero exit, and I/O failure.

### Initialization, Manual Operation, and Upgrade

`install.sh` installs one offline host-neutral bundle with stable PATH-resolved `archflow-mcp` and `archflow-local` launchers, then copies the same `skills/` source to both clients. Claude registration must run `claude mcp add --scope project archflow -- archflow-mcp`; the official command creates/updates the PRD-required project `.mcp.json`, which is shared and committed with the repository. It registers the stable command name, never an absolute home/install path. Codex likewise uses its official project registration command. Init preserves all unrelated server entries and settings and narrowly patches only persistent fields the official commands cannot express—such as a supported per-server timeout or required Codex fields—with parse-before/after and byte-preservation fixtures; it never replaces whole JSON/TOML files or claims a generic rewriter.

Init cannot set an environment variable inherited by the already-running host. If Claude has no persistent per-server timeout, init emits this exact shell-profile line and restart instruction: `export MCP_TOOL_TIMEOUT=3600000` followed by “add this line to the shell profile that launches Claude Code, start a new terminal, then restart Claude Code.” It launches/verifies a newly started host and fails closed until the `archflow-mcp` child inherits the parsed value `3600000`. It detects registration collisions, invalid/untrusted configuration, unsupported runtime/CLI versions, managed-instruction hazards, and missing launcher/sandbox capability. Machine-specific executable locations stay only in installation/PATH resolution and never enter `.mcp.json` or portable task state.

`archflow-local` exposes local operations for validate, hash, canonical render, snapshot/restore, human-approved maintenance, atomic decision creation, degraded status, reconcile/import, upgrade staging, and `checkpoint`. These are CLI/library functions from the same installed bundle, not MCP tools. “Server unavailable” means this helper remains available. If both server and helper are unavailable, skills fail non-advancing with installation/repair instructions rather than improvising file formats.

Manual mode never fabricates `state.json`. `archflow-local checkpoint` first reconciles and validates, then atomically writes the next immutable `manual/checkpoints/<revision>-<digest>.json` bound to its predecessor. Only snapshots and projections referenced by the greatest valid chain checkpoint are authoritative; prepared files not checkpointed remain non-authoritative. Initial normal and legacy checkpoints commit the corresponding task-initialization or legacy-import manifest and approved policy basis. Counter-review emits a self-contained opposite-client prompt and stops. Same-family adjudication is degraded and gates uncertainty. Status is labeled degraded; collision, chain gap, or ambiguity stops. When the server returns, it adopts only the greatest valid chain through `manual-checkpoint-import`, without replaying decisions or inferring missing revisions.

`archflow-upgrade` invokes an offline local upgrade orchestrator. The user supplies one legacy source and a distinct unused destination; the orchestrator alone receives narrow permission to read that source, stages a hashed immutable import below the destination, and never edits the source. It resolves an explicitly approved policy-base commit/constitution and destination whole-config digest separately from the import/code baseline and rejects unresolved task-local constitution edits. After staging is complete, it calls `archflow_state` with a `legacy-import-initialization` artifact for the destination's no-state → initialized transition. A prepared import or interrupted call is not authoritative; exact replay succeeds only after destination state commits its intent/result/revision, while changed replay or collisions stop.

Imported PRD, design, and phase documents map to the existing `prd`, `design`, `phase-design-<n>`, and `phase-impl-<n>` instances and rerun their current pipelines—there is no migration phase instance. Legacy completed code is audited through each `phase-impl-<n>` implementation-output manifest and an explicit migration gate kind before it can be represented as validated. Normal/manual paths share staged manifests and conservative milestones. Normal task tools retain the cross-task prohibition; only the offline pre-initialization orchestrator may read the explicitly selected legacy source.

## Key Decisions

| Decision | Options Considered | Choice | Rationale |
|----------|--------------------|--------|-----------|
| MCP generation | SDK v1; v2 stable; direct protocol implementation | Exact-pinned MCP v2 stable `2.0.0` behind an adapter, retaining the 2025-era protocol | Stable retained the consumed public API and legacy behavior. Contract fixtures, public compatibility probes, and adapter isolation preserve the trust boundary while `2026-07-28` modern opt-in remains a separate future design. |
| Workflow authority | Conversation/artifact inference; SQLite; repository files | Strict, file-native state and evidence tracked on the task branch | Human and agents can inspect/share it with Git; there is no hidden database authority. |
| Task creation | Directory presence; init-created state; manifest adoption | Separate normal/legacy initialization tags adopted by `archflow_state` | Both pin a human-approved immutable policy base; repository init never silently creates task authority or commits. |
| Deterministic rerun | Seed model calls; regenerate/merge; retain exact results | Immutable content-addressed snapshots and canonical projections | Supported CLIs do not promise seeded output. Exact bytes are reusable without touching unrelated dirty files. |
| Concurrency | Best-effort; distributed Git lock; local task lock plus CAS | Lock/CAS on one filesystem; one active writer/worktree per task branch with clean checkpoint handoff | Git cannot coordinate live writers. Explicit commit/push/pull handoff prevents false distributed-safety claims and is never automated. |
| State commit order | State before artifact; implicit replay from receipt; prepared result then state commit | Snapshots/projections/receipt are prepared; `state.json` alone commits them; reconcile before every interpretation | A crash cannot turn a prepared receipt into replay success or promote an orphan. |
| Review representation | Model-authored Markdown; raw JSON only; validated JSON plus canonical Markdown | Validate structured JSON, retain it in snapshots, render deterministic Markdown | Separates machine authority from readable evidence and prevents prose from forging verdict/provenance fields. |
| Review isolation | Fresh prompt only; temp cwd/read-only flag; OS-enforced capability-tested sandbox | Sandbox-provider boundary with black-box repository-read/write proof | Fresh process identity is insufficient if the reviewer can discover repository context by absolute path. Unsupported environments fail closed. |
| Sandbox dependency | Roll OS-specific isolation; immediately adopt a tool; evaluate a provider | Prefer `@anthropic-ai/sandbox-runtime` behind the boundary, but adopt only after proof and explicit component-license approval | The package is Apache-2.0, while Linux bubblewrap/socat introduce LGPL/GPL. Unsupported is safer than silent adoption. |
| Reviewer fallback | Same-family substitute; skip; visible pending failure | No same-family counter-review fallback | Substitution would create the appearance of independence. Manual cross-client handoff remains available. |
| Host routing | Skill branches/self-report; environment variable; MCP identity plus adapter fixtures | Immutable connection identity and validated per-task config | Keeps skills host-neutral and fails safely as host/version behavior changes. |
| Task configuration | Mutable per-step routing; partial invalidation; immutable whole config | Pin the complete versioned `config.yaml` at initialization | Routing/model/effort changes create a new task or explicit upgrade; a changed config can never reinterpret evidence inside the current task. |
| Human gates | Conversation approval; short polling; durable blocking gate | One active digest-bound gate with archived decisions and external cancellation semantics | Approval survives sessions and cannot be inferred from timeout, absence, or model prose. |
| Legacy tasks | Auto-promote; mutate in place; abandon; migrate to a new canonical task | Explicit `archflow-upgrade` import followed by current evidence and approvals | Preserves history without representing legacy prose or conversation as modern evidence. |
| Manual mechanics | Skills hand-author formats; extra MCP tools; offline local helper | Bundled host-neutral `archflow-local` CLI/library sharing server contracts | Manual validation and recovery remain deterministic without expanding the five-tool MCP surface. |
| Manual authority | Loose evidence files; fabricated state; immutable checkpoint chain | Greatest valid predecessor-linked manual checkpoint | Prepared files and gaps cannot become authority; server recovery imports the closed chain once without replaying decisions. |
| Policy during upgrade | Derive from imported/code baseline; current worktree; explicit approved policy base | Separate approved policy-base commit/constitution from import/code baseline | Legacy code cannot select or silently modify the policy used to validate it. |
| Distribution | `npx` at startup; dev checkout; offline server/helper bundle | One pinned installed bundle with MCP and local launchers | Host startup and degraded operation are offline/reproducible while skills keep one source. |
| Snapshot bounds and retention | Unbounded payload copies; hidden external store; Git-object reuse plus bounded payloads | Reuse tracked Git objects, cap copied payloads, retain authority/evidence, and allow recorded pruning of unreachable non-authority only | Bounds growth without truncation, hidden authority, broken reruns, or broken checkpoint chains. |
| Audit lifetime | Permanent external archive; delete without explanation; lifecycle Git evidence | Track all evidence on the branch and remove `.archflow/` before PR | Matches current product scope. Durable external export remains REQ-52, not an implied v1 promise. |

## Testing and Release Strategy

Testing follows the trust boundaries rather than module percentages:

- Unit tests cover schema rejection, fixed graph validation, transition tables, canonical hashing/rendering, path allowlists, routing, error classification, and gate/waiver decision validation. A shared valid/invalid corpus proves Ajv and Zod agree for every overlapping durable/MCP shape.
- Contract tests pin MCP initialization and `tools/list` to protocol `2025-11-25`, exactly five v2 tools, schemas, cancellation, and protocol-only stdout. Recorded real Claude Code and Codex handshakes protect host detection from vendor naming drift.
- State integration tests cover normal/legacy no-state initialization, immutable whole-config pinning and `PINNED_CONFIG_MISMATCH`, uncommitted/mismatched policy bases, two same-filesystem processes, exact replay/mismatch/conflict races, prepared-receipt crashes, implementation manifests, independent tasks, projection restore and `restore-collision`, manual checkpoint-chain import, and fault injection. Separate-clone tests acknowledge that pre-divergence concurrency is locally undetectable, then exercise divergent-history/conflict detection, non-authoritative blocking, repair/replay, and clean Git handoff.
- Path tests use traversal, absolute paths, symlink escapes, sibling tasks, linked worktrees, relocation, and paths with spaces/Unicode before reads or dispatch.
- Adapter fixtures use fake CLIs for every stable failure class and version behavior. Real supported-version smoke fixtures verify first-party auth detection, model/family identity, flags, fresh PID/session, structured output, cancellation, and process-tree death without persisting secrets.
- Sandbox black-box tests use randomized repository/instruction, other-family-auth, and unrelated-secret canaries plus output/diagnostic scans to prove the selected first-party CLI can use its own subscription authentication while ArchFlow never handles credential values, API keys/provider routing are scrubbed, model input remains envelope-only, writes remain temp-only, and repository/sibling/global discovery fails. Shared own-auth access inside the selected CLI process tree is not a failure. Tests also spawn descendants that create new process groups/sessions and prove the provider containment primitive terminates them on every stop path. A provider/OS/CLI combination is unsupported until this passes under its release artifact.
- Review/adjudication corpus tests seed substantive defects, clean controls, trigger uncertainty, `enforced_by` evidence states, aligned/incidental/material drift, repeated rewrites, and exhaustion. Release thresholds are chosen and explicitly approved from observed results; finding count is not the metric.
- Manual-mode tests remove each tool and then the server while retaining `archflow-local`, drive normal and legacy initialization plus two phases through immutable checkpoint chains, gates, waiver, supplemental review/decline, commit authorization, and greatest-valid-chain recovery/import. Prepared/unlinked files remain non-authoritative; removing server and helper fails for repair.
- End-to-end tests run both producer directions entirely from a terminal and verify branch-tracked artifacts, explicit checkpoint handoff, no auto-commit, no premature implementation/commit, parent updates, non-colliding evidence, immutable config mismatch status, representative snapshot growth/caps/retention/maintenance records/secret rejection, deterministic dirty-worktree restore/collision decisions, Git normalization across line-ending and mode/symlink checkout configurations, interruption/resume, and cleanup guidance.
- Repository-consistency tests compare `CLAUDE.md`, tracked/project `AGENTS.md` policy where in scope, `README.md`, `docs/archflow-process.md`, the preserved lineage/supersession banner and links in `docs/mcp-integration-design.md`, `install.sh` output, and every installed skill listing against the canonical workflow/tool/layout contracts.

Release is blocked unless all applicable tests pass and the supported matrix is documented. In addition:

1. A sandbox provider/OS combination has current black-box proof and an explicitly acceptable license. Unsupported environments fail closed rather than receiving reduced isolation.
2. Real minimum supported Claude/Codex host and CLI versions have fixtures; initialization validates the persistent per-server timeout or inherited `MCP_TOOL_TIMEOUT`, Claude safe-mode/tool/MCP/slash-command/persistence constraints, Codex config/rules/project-document suppression, and official registration behavior.
3. Written Anthropic clarification or a qualified legal determination establishes that third-party local subscription-authenticated Claude dispatch is permitted (`VAL-14`). Internal risk acceptance alone does not satisfy this gate. Until then, the integration may be implemented and tested with fixtures, but no release may advertise or enable that Claude dispatch path.
4. The exact dependency lock, licenses/notices, MCP stable migration notes, and offline bundle are reproducible. Any selected sandbox license is surfaced explicitly.
5. `VAL-01` through `VAL-06` pass in terminal runs before Archforge implementation begins. If `VAL-02` does not demonstrate useful independent review, the automation premise is revisited rather than compensated for with more mechanics.

## Requirement and Validation Coverage

| Coverage area | Requirements | Validation | Primary phases | Proof boundary |
|---------------|--------------|------------|----------------|----------------|
| Initialization and canonical repository contracts | REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06 | VAL-08, VAL-11, VAL-12 | 1, 5, 15, 16, 21 | Strict assets/schemas, dependency-complete offline packaging, preserving official registration, fixed graph, and documentation agreement establish one v1 authority. |
| Thin phase marshalling and production lifecycle | REQ-07, REQ-08, REQ-09, REQ-10 | VAL-01, VAL-02, VAL-05, VAL-06, VAL-16 | 1, 14, 16, 20, 21 | Normal skills drive persisted boundaries, implementation manifests, current-digest loops, approvals, parent updates, and commit authorization. |
| Review evidence and truthful status | REQ-11, REQ-12, REQ-13, REQ-14 | VAL-02, VAL-05, VAL-06, VAL-08, VAL-12, VAL-16 | 2, 5, 6, 7, 8, 9, 10, 13, 16, 17, 19, 20 | Structured JSON/projections, manifest evidence, fixed-point fixtures, and reconciled normal/degraded status distinguish provenance. |
| Constitution and task policy | REQ-15, REQ-16, REQ-17 | VAL-03, VAL-15 | 1, 2, 13, 18, 19, 20 | Explicit approved policy base, trigger corpus, and unresolved-edit rejection fail closed. |
| Waivers, drift, and human authority | REQ-18, REQ-19, REQ-20 | VAL-01, VAL-03, VAL-04, VAL-09, VAL-15 | 2, 11, 13, 18, 20 | Digest-bound decisions, scoped expiry, migration audit, separate verdicts, and upstream reopening preserve authority. |
| Durable state and recovery | REQ-21, REQ-22 | VAL-05, VAL-06, VAL-09, VAL-12 | 6, 7, 8, 9, 10, 11, 17, 19, 20 | Prepared-before-state semantics, fault injection, durable gates, helper reconciliation, and collision-safe restore never infer success. |
| Idempotency and concurrency | REQ-23, REQ-24, REQ-25 | VAL-05, VAL-06, VAL-08, VAL-10 | 6, 7, 9, 10, 11, 17, 18, 19 | Intent/state commitment, local lock/CAS, one-writer Git handoff, manifests, and exact restore cover retries/races without claiming distributed locks. |
| Repository and task isolation | REQ-26 | VAL-07, VAL-10, VAL-11, VAL-13 | 6, 7, 8, 9, 10, 12, 18, 19, 20 | Path guards, narrow pre-init legacy read, and measured sandbox manifests block undeclared access. |
| Fixed MCP boundary and local service | REQ-27, REQ-28 | VAL-08, VAL-13 | 2, 3, 4, 5, 14, 15, 19, 20 | Correlated five-tool contracts, v2 fixtures, and the license-complete deterministic offline payload expose only the stdio boundary; the separate offline helper is not an MCP tool. |
| Host identity and routing | REQ-29, REQ-30, REQ-31 | VAL-07, VAL-08 | 12, 14, 19, 20 | Real handshakes and exact CLI fixtures bind immutable host/opposite family and reject injected managed context. |
| Fresh structured dispatch | REQ-32, REQ-33 | VAL-02, VAL-07, VAL-08, VAL-13 | 2, 3, 4, 5, 12, 13, 14, 19, 20 | Hashed envelopes, portable manifest evidence, measured runtime/selected-CLI own-auth reads, fresh PIDs, OS isolation, validation, and attestation prove the boundary. |
| Authentication and child lifecycle | REQ-34, REQ-35 | VAL-07, VAL-08, VAL-13, VAL-14 | 12, 15, 19, 20, 21 | Auth/version/policy preflights, environment sentinels, descendant escape tests, and the legal release gate prevent unsafe dispatch. |
| Durable gate semantics | REQ-36, REQ-37 | VAL-01, VAL-03, VAL-09, VAL-10 | 2, 11, 14, 17, 19, 20 | Deterministic IDs, pre-block publication, supplemental-review retry, cancellation, and CAS resolution prove exactly-once decisions. |
| Degraded/manual terminal completion | REQ-38, REQ-39, REQ-40 | VAL-06, VAL-09, VAL-12 | 8, 14, 15, 17, 18, 20 | `archflow-local` and exact fallback templates advance only from validating evidence; loss of both paths stops for repair. |
| Optional cross-client gate review | REQ-41 | VAL-09, VAL-12, VAL-16 | 2, 11, 16, 17, 20 | Caller-known gate IDs avoid blocking deadlock; triage resumes or supersedes deterministically and decline fabricates nothing. |
| Legacy migration | REQ-50 | VAL-17 | 6, 7, 8, 9, 10, 11, 18, 19, 20 | Staged import, no-state initialization union, existing phase mappings, implementation audits, and interruption fixtures prevent auto-promotion. |

All v1 requirements `REQ-01` through `REQ-41` and `REQ-50`, and all release validations `VAL-01` through `VAL-17`, appear above. `REQ-52` remains explicitly outside the v1 architecture.

## Phases

Phases 8–20 were renumbered to 9–21 on 2026-07-28, when the manual-checkpoint family was split out of Phase 7 into a new Phase 8. Completed phase design documents and past counter-reviews under `.archflow/tasks/mcp-integration/` were deliberately not rewritten, so a phase number in a document dated before 2026-07-28 refers to the old numbering. Phases 1–7 keep their numbers under both.

### Phase 1: Contracts, Assets, and Package Scaffold

**Status**: COMPLETE (2026-07-27)

**Goal**: Establish the buildable package foundation and foundational repository contracts.

**Requirements**: REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-10, REQ-15, REQ-17

**Scope**: First add the visible lineage/supersession banner to `docs/mcp-integration-design.md`, preserving it as originating design and linking the normative PRD/architecture; Phase 21 later updates surrounding documentation. Establish a private ESM package, exact lockfile, scripts, Node matrix CI, dependency notices/policy, and only Phase-1 direct dependencies: Zod, Ajv, `ajv-formats`, YAML, TypeScript, Node typings, esbuild, Vitest, and direct Vite `7.3.6`. Implement recursive plain-JSON preflight, strict non-mutating Ajv2020, explicit Zod agreement infrastructure, branded canonical phase-instance codec, safe YAML parsing, fixed workflow/config/rubric/constitution rule contracts, shipped workflow/constitution assets, and append-only constitution evolution fixtures. This phase has no review/triage/adjudication contracts or renderers, error registry, tool schemas, MCP SDK/server, or tracked offline bundle.

**Success Criteria**:

- [x] Clean exact-lock install, strict typecheck, foundational tests, and temporary esbuild output pass on Node `24.15.0` and `24.18.0`; TypeScript is CLI-only with explicit `rootDir` and Node types.
- [x] The exact lock includes direct `vite@7.3.6`, excludes `lightningcss`, and passes complete permissive-only license/NOTICE proof; copyleft, unreviewed licenses, ranged direct pins, and later-phase dependencies fail policy.
- [x] Recursive plain-JSON/Ajv/Zod agreement fixtures reject mutation, non-plain prototypes, dangerous keys, unknown structure, bad formats, and YAML ambiguity with stable located validation results.
- [x] Exact workflow/config/rubric/constitution assets and schemas round-trip; graph mutations, authoritative family config, invalid rubric modes, duplicate/invalid rules, and illegal append/deprecate/version evolution fail.
- [x] Branded positive-safe phase numbers and phase-instance IDs are minted only by codecs/validators; compile-time assertions and runtime aliases reject non-canonical values, while Explore remains disposable pre-task vocabulary rather than a phase instance.
- [x] Phase 1's first change adds the source design's visible lineage/supersession banner, links the approved PRD/architecture, preserves its originating-design status, and precedes all server implementation.

### Phase 2: Review Evidence and Contract Authority

**Goal**: Freeze the trust-bearing semantic, provenance, gate, error, tool, connection, and invocation contracts before any MCP transport or durable workflow implementation adopts them.

**Depends on**: Phase 1

**Requirements**: REQ-04, REQ-05, REQ-10, REQ-11, REQ-12, REQ-13, REQ-15, REQ-17, REQ-18, REQ-19, REQ-20, REQ-23, REQ-27, REQ-33, REQ-36, REQ-37, REQ-41, REQ-50

**Scope**: Define complete raw/derived/agent-declared/server-attested/degraded review evidence, composite finding references, exact current-slot triage, digest-bound adjudication, supplemental evidence/choices, and canonical anti-spoofing renderers. Establish scope-bound observation/result/authority expectations; one exact gate catalogue with waiver, restore, migration, human-decision, and commit subjects; separate exhaustive project-result and ArchFlow protocol-error registries plus explicit SDK-standard-error ownership; and exactly five versioned request/result contract pairs, with `archflow_state.artifact` temporarily disabled. Pin required request `task_id`, lexical path claims, and branded immutable connection/invocation contexts without adopting transport types. This phase adds no MCP SDK dependency, server, protocol fixtures, bundle, persistence, dispatch, durable gate lifecycle, or durable state/artifact schema.

**Success Criteria**:

- [ ] Closed schemas/interfaces enumerate every field and trust source for raw finding/review, derived review, `AgentDeclaredReview`, `ServerAttestedReview`, `DegradedReview`, `ReviewEvidence`, `FindingRef`, `TriageDisposition`, `ValidatedTriage`, `AdapterObservation`, and scope-bound `AuthorityLink`; verdict/count/binding fields are recomputed, untrusted, or internally minted as specified.
- [ ] Server attestation is minted only from an invocation-scoped observation capability containing immutable expected envelope bindings and observer-owned output bytes. Phase 2 freezes scope-bound receipt/state/result/checkpoint authority-link contracts and proves the capability seams with internal fixtures; Phase 6 and later owners verify live links/currentness. Forged, schema-shaped, wrong-policy, wrong-scope, wrong-invocation, and wrong-digest provenance cannot qualify.
- [ ] Composite `(review_evidence_digest, finding_id)` dispositions cover the exact applicable current finding set once and only once, reject stale/foreign/duplicate/missing findings, and digest-bound `ValidatedAdjudication` retains per-rule compliance findings, all `enforced_by` states, separate drift, triggers, and canonical byte-stable rendering.
- [ ] One normative gate contract catalogue defines all nine exact contexts, decision payloads, effect classes, decision envelopes, waiver origin/binding, supplemental actions, restore/migration subjects, and commit authorization over the implementation result/diff/current artifacts; cross-kind or cross-gate substitution fails.
- [ ] Exactly five correlated request/result definitions exist for `archflow_state`, `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, and `archflow_waiver`, with no sixth tool and `archflow_state.artifact` rejected until its durable union exists. Structural result validation is distinct from expectation-based authoritative correlation; wrong invocation/gate/revision/path/semantic results fail when a later owner supplies the scoped expectation.
- [ ] Separate exhaustive project and ArchFlow protocol error registries fix per-code ownership, retryability, safe parameters, one next action, and projection eligibility; standard SDK/MCP/JSON-RPC errors have an explicit mapping boundary rather than being misrepresented as project errors.
- [ ] Internal constructors validate, copy, and freeze initialization-established connection data and per-invocation metadata exactly once while preserving `AbortSignal` as the sole live capability; repeated initialization and request identity overrides fail. No SDK or transport-owned type leaks into these interfaces.
- [ ] No MCP SDK package, MCP server, protocol fixture, tracked bundle, persistence implementation, dispatch implementation, durable gate lifecycle, or durable state/artifact schema is introduced in this phase.

### Phase 3: MCP Contract Boundary and Dependency Admission

**Goal**: Admit the exact reviewed MCP dependency surface and freeze a complete SDK-free five-tool catalogue and authenticated handler/error boundary for a later transport owner.

**Depends on**: Phase 2

**Requirements**: REQ-04, REQ-05, REQ-11, REQ-27, REQ-33

**Scope**: Before dependency mutation, recheck exact direct `@modelcontextprotocol/server@2.0.0-beta.5`, exact locked `@modelcontextprotocol/core@2.0.0-beta.5`, protocol `2025-11-25`, required public exports/declarations, current guidance, and only that both root packages declare allowed `MIT`. Record both root entries in existing dependency notices; a changed/disallowed root declaration or incompatible dependency/public surface returns for phase-design review without dependency changes. Phase-design approval is not commit authorization. Phase 3 performs no tarball, transitive, embedded-component, documentation-classification, or bundle-wide legal audit. Extend Phase 2 with a failure-only result validator, one shared request-ID schema consumed by parser and authentic invocation mint, and one shared client-implementation schema consumed by parser and direct-only connection mint; full SDK Implementation metadata is projected to exact `{name, version}` before both client consumers. Build the exact five-tool portable catalogue in supported direct-import module `src/mcp/tools.ts` from the exact eight-schema closure, validate tests only through public-root `specTypeSchemas`, and compile with strict Ajv/formats. `src/contracts/index.ts` remains contract-only; `src/mcp/tools.ts` owns and exports `AdvertisedToolDescriptor` and `ADVERTISED_TOOL_CATALOGUE` for Phase 4; no `src/mcp/index.ts`, package/barrel catalogue export, or internal builder exists. Implement the SDK-free authenticated handler/error boundary with exact input classification, return revalidation, and safe fallback. This phase creates no SDK adapter, transport, lifecycle, cancellation, runnable server, release bundle, or REQ-28 claim.

**Success Criteria**:

- [ ] Implementation-start evidence confirms exact server/core beta.5, protocol `2025-11-25`, required public exports/declarations, and allowed root `MIT` declarations before package/lock mutation; a mismatch returns for phase-design review without dependency changes, and phase-design approval does not authorize a commit.
- [ ] Existing dependency notices contain both root package entries. Phase 3 adds no retained MCP legal assets or tarball/transitive/embedded/documentation-class legal audit; Phase 5 independently owns bundle-wide legal completeness.
- [ ] The Phase 2 seam adds only the failure-only project-result validator, one shared internal request-ID schema consumed by parser and authentic invocation mint, and one shared internal client-implementation schema consumed by parser and direct-only authentic connection mint. Arbitrary strings and finite safe integers, including negative values, `-0`, and both safe bounds, are preserved; adjacent unsafe integers fail. Full SDK Implementation metadata is projected to exact `{name, version}` before both client-schema consumers, parser-to-mint fixtures preserve admitted values, the factory remains absent from `src/contracts/index.ts`, and no SDK-owned type crosses or appears in production source outside tests.
- [ ] `src/contracts/index.ts` remains contract-only. Supported direct-import `src/mcp/tools.ts` owns and exports `AdvertisedToolDescriptor` and `ADVERTISED_TOOL_CATALOGUE`; Phase 4 imports both only from that exact module, no `src/mcp/index.ts` or catalogue barrel/package export exists, and no internal builder or ownership cycle is introduced. The exact five-tool catalogue passes public-root `ListToolsResult`, strict Ajv/formats, and frozen-2025 object-root invariants without core-root or SDK-internal schema imports.
- [ ] Every advertised schema compiles in strict `ajv@8.20.0` plus pinned `ajv-formats@3.0.1` with an otherwise empty registry and no ArchFlow schemas or custom keywords; a classified corpus separately proves portable structural validation and all runtime-only semantic constraints.
- [ ] The authenticated SDK-free boundary fixes handler registry, invocation context, project outcome, authenticated protocol error, boundary outcome, exact known/unknown-tool and argument classification, handler-result revalidation, and safe `INTERNAL_ERROR` fallback without transport or lifecycle assumptions.
- [ ] Focused unit, contract, dependency-policy, schema-portability, and authenticity fixtures pass; there is no `src/main.ts`, `src/mcp/sdk-adapter.ts`, transport, cancellation, live transcript, tracked release output, persistence, dispatch, or claim that a local MCP service exists.

### Phase 4: Guarded MCP Runtime and SDK Compatibility

**Goal**: Consume Phase 3's frozen seam to implement and prove the complete inert low-level stable `2.0.0` stdio runtime.

**Depends on**: Phase 3

**Requirements**: REQ-04, REQ-05, REQ-11, REQ-27, REQ-28

**Design Revision (2026-07-27, approved)**: Stable server/core `2.0.0` replaced the prior prerelease target after the completed currency review found unchanged consumed public signatures, legacy runtime behavior, MIT metadata, and transition-license text. The user approved the revision before dependency mutation; the migration changed only exact pins, lockfile, dependency-policy/notices evidence, and probe expectations, not the runtime architecture.

**Scope**: Isolate the low-level SDK `Server` as a documented advanced-use exception wholly inside `src/mcp/sdk-adapter.ts`, beginning and ending with live currency/public-hook gates. The current target is exact stable server/core `2.0.0`, published `2026-07-27T23:55Z`, with unchanged consumed public signatures, legacy runtime behavior, MIT metadata, and transition-license text. The approved stable migration updates only exact package/lock pins, dependency policy/notices evidence, and compatibility-probe expectations; it requires no runtime architecture rewrite. Production imports of core or SDK internal/private paths remain prohibited. Retain singleton protocol `2025-11-25`; official hand-built-Server guidance keeps this legacy path unless modern behavior is explicitly selected, so protocol `2026-07-28` adoption is deferred to a later design. Repair the SDK-free `src/mcp/server.ts` seam so known-tool arguments are classified before handler availability while unknown-name precedence remains fixed. Split raw strict/bounded JSONL framing, session lifecycle/routing, session-lifetime seen-ID and monotonic internal-ID ownership, universal bounded output FIFO, and process termination into SDK-free modules. Construct the exact low-level server identity/capability/handler/connect sequence behind a public `Transport` facade; make SDK initialize validation transactional, pin context-mint ordering, cancellation tombstones, and a closed request/notification/response routing table. Normalize numeric `-0` to `0` and reject every previously seen request ID for the entire session—response/cancellation/rejection “reuse” fixtures prove rejection, never legal reuse. Reject unknown top-level request members and unknown method-parameter keys before SDK stripping. For list/call, preserve permitted `_meta` and legacy `task` only for SDK validation/lifting and exclude them from ArchFlow boundary input. Missing call arguments are SDK-valid and pass unchanged; use the exact surrogate only for a present non-object argument, while unchanged objects reach the boundary as sole semantic authority. Retain authentic boundary outcomes across SDK projection so the facade restores exact ArchFlow protocol codes, including stable legacy `TOOL_DISABLED` rewriting; preserve malformed-initialize canonicalization, public result projection, protocol/project/SDK byte separation, and post-close quarantine. Bound ingress/output/ID state, pause input under backpressure, expose runtime termination to an SDK-free process runner, and add a thin inert `src/main.ts`. Phase 4 only preserves/projects already-authenticated outcomes; model-result validation remains later. Stop for architecture review on dependency/API drift or any failed public-hook invariant.

**Success Criteria**:

- [ ] The stable `2.0.0` currency/public API evidence is reconfirmed after explicit design approval and before dependency mutation, then immediately before final verification; drift or any failed facade/initialize/projection/teardown invariant stops without dependency mutation, core/internal import, or private workaround.
- [ ] `src/mcp/server.ts` classifies known arguments before handler availability; missing arguments pass unchanged, only present non-object arguments use a surrogate, and object semantics retain one boundary authority across inert and enabled fixtures.
- [ ] Exact `Server({name:"archflow-mcp",version:"0.0.0"})`, singleton versions, `registerCapabilities({tools:{}})`, two tool handlers, then facade connection produce pinned initialize bytes and transactional malformed-retry/success behavior.
- [ ] Strict bounded framing, lifetime seen-ID rejection, monotonic non-recycled internal IDs, cancellation tombstones, and the closed initialize/ping/list/call/notification/response table enforce all lifecycle and same-chunk races without unbounded state. “Reuse” fixtures assert rejection after every terminal path.
- [ ] The exact request/list/call member allowlists reject unknown keys before SDK stripping; permitted `_meta`/legacy `task` are SDK-only inputs; missing/present-non-object/object argument routes reach `CONTRACT_*`, `TOOL_NOT_FOUND`, or `TOOL_DISABLED` exactly. Retained authentic outcomes restore all ArchFlow mappings despite stable legacy SDK rewriting; malformed initialize remains bounded/retryable only before mutation, while public projection and project/SDK/direct/fallback bytes remain distinct and bounded.
- [ ] The universal capped FIFO separates write admission, callback completion, and backpressure; pauses/resumes ingress, rejects all entries on close, performs no adapter-owned state/output effect after `CLOSING`, preserves post-close late-result quarantine under stable `2.0.0`, and never destroys caller streams. Injected handlers must honor `AbortSignal`.
- [ ] The runtime exposes SDK-free termination to the process runner; `src/main.ts` is a thin inert binding with exact stdout, diagnostics, exit, signal, and cleanup behavior.
- [ ] Exact stable package/lock pins, dependency-policy and unchanged-license notices, public compatibility probes, and focused/live fixtures pass on Node `24.15.0` and `24.18.0` without a dependency beyond the approved stable transition, schema, tracked release output, persistence, dispatch, model-result authority, or REQ-33 completion claim.

### Phase 5: Offline Bundle and Release Integrity

**Goal**: Produce a license-complete deterministic tracked offline payload and prove hostile clean-copy startup.

**Depends on**: Phase 4

**Requirements**: REQ-04, REQ-05, REQ-11, REQ-27, REQ-28, REQ-33

**Scope**: Define a strict versioned release-manifest schema and build the inert server payload deterministically. Independently inventory every component and transitive input present in the final bundle, verify its applicable license and attribution requirements, and track the complete bundle, manifest, and legal payload. Prove startup from a hostile clean copy with no `node_modules`, npm, cache, startup build, network, or listener access, while preserving protocol-only stdout and enforcing the release proof in CI. This phase adds no persistence, dispatch, durable gate lifecycle, durable state schema, durable artifact schema, or production handler authority.

**Success Criteria**:

- [ ] A strict, versioned `dist/manifest.json` schema rejects unknown fields, unsupported versions, missing or contradictory evidence, and binds the bundle SHA-256, Node target, package/lock, source entry, schema/assets, full esbuild metafile, and every metafile input to canonical digests.
- [ ] The tracked legal payload independently inventories every bundled component and transitive input, binding exact version/source, applicable license, required notice/attribution text, and corresponding bundle input; missing, disallowed, unreviewed, or mismatched entries fail the build.
- [ ] Repeated builds from the exact lock and declared inputs produce byte-identical bundle, manifest, metafile evidence, and legal payload, with no undeclared input or timestamp/environment variation.
- [ ] A hostile clean-copy smoke starts the tracked bundle without `node_modules`, npm, package cache, network, startup build, or repository-local undeclared input and completes live initialize, `tools/list`, and shutdown over stdio.
- [ ] Node-core guards prove startup and protocol exercise open no network connection or listener, emit only MCP traffic on stdout, route diagnostics to stderr, and leave no background handle.
- [ ] CI validates the manifest schema and all input/hash/license bindings, reproduces the payload, runs the hostile clean-copy smoke, and fails on bundle, lock, schema, asset, metafile, legal-inventory, attribution, or protocol-fixture drift.

### Phase 6: Repository Identity, Paths, and Canonical Digests

**Goal**: Establish the repository/task identity, path safety, immutable task configuration pinning, and byte-stable digest contracts used by every mutation.

**Depends on**: Phases 1–5

**Requirements**: REQ-04, REQ-05, REQ-13, REQ-26

**Scope**: Implement Git/worktree and task identity; `.archflow/** -text merge=binary` with runtime attribute verification; task-relative and repository-relative path claims, path classes, and filesystem containment; canonical JSON, canonical Git blob/tree-mode identity, and request/declared-input digests; exact whole-file `config.yaml` digest pinning; divergence, conflict, and in-progress-operation detection; and the secret-scan result contract. This phase introduces the first filesystem and Git-subprocess code in `src/`. It implements no durable state or artifact schema, no state mutation, no payload restore, and no secret-scanning engine, and adds no runtime dependency.

**Implemented 2026-07-28.** Three design errors were corrected during implementation and are recorded in the phase log: containment step 6 omitted a `rel !== ".."` guard and therefore accepted the root's own parent; `--literal-pathspecs` and `:(top,literal)` are mutually exclusive on git 2.43, so the flag is now prohibited rather than mandated; and `--git-common-dir` is relative to the process cwd, not the worktree toplevel. The global ID retightening reached a fourth round of previously unlisted sites (`review.ts`, `triage.ts`, `adjudication.ts`, `errors.ts`, `authority-link.schema.json`), where it is a vocabulary swap rather than a pure narrowing. `npm run check:release` remains blocked, but **not** on the risk re-acceptance, which the user granted and which `release:stage` accepted. Promotion fails because three invariants in `scripts/release-support.mjs` cannot co-exist across a bundle change: committed decision records are byte-immutable against HEAD (`:1380`), every decision must bind the current bundle digest (`:803`), and a supersession must retain the superseded decision (`:676-677`) — which necessarily carries the old digest. The tracked `dist/` payload therefore cannot be re-promoted after any bundle change; Phase 5 created the initial release, so this path was never exercised. Fixing Phase 5's integrity model is tracked as a follow-up.

**Success Criteria**:

- [x] Traversal, absolute paths, drive-relative and UNC inputs, symlink escape, cross-task access, pathspec metacharacters, and repository-identity mismatch fail before any read, while linked worktrees, relocation, spaces, and Unicode pass.
- [x] Committed inputs and tracked outputs have identical canonical Git blob/tree identities across LF/CRLF worktrees, `core.autocrlf`, `core.fileMode`, executable-bit support, and symlink-capable/incapable checkouts; unsupported materialization fails closed.
- [x] The whole `config.yaml` file is pinned by exact digest, and any byte change is detected as `PINNED_CONFIG_MISMATCH` with expected/observed digests and no config content.
- [x] The canonical request digest is computed from its closed field list only, and logically set-valued fingerprint collections hash identically under any input permutation. **Limitation recorded**: the closed list is enforced by an exact-name denylist over an open `operation_fields`, so alternate spellings of volatile state are not caught; a closed per-operation allowlist is owned by the phase that defines operation field sets.
- [x] Startup and pull/handoff detection identifies divergent histories and `.archflow/**` conflicts as non-authoritative without claiming it can detect independent-clone concurrency before divergence.
- [x] Every Git invocation is bound to the discovered worktree root, so no command can silently report an absent path or attribute because of the caller's working directory.

### Phase 7: Durable State and Artifact Schemas

**Goal**: Define every persisted shape as a versioned normative schema with one cross-document semantic authority.

**Depends on**: Phase 6

**Requirements**: REQ-04, REQ-11, REQ-13, REQ-14, REQ-21, REQ-26, REQ-50

**Scope**: Author the durable `state.json` schema and the task-initialization, document, implementation-output, legacy-import-initialization, maintenance-record, and durable-primitives schemas, with Zod mirrors wherever a shape is reachable from the `archflow_state.artifact` union, plus one consolidated semantic validator for cross-document invariants. Snapshot accounting is authored here as a `$def` of the shared `durable-primitives` schema rather than a standalone registry entry; `durable-primitives` is the file that ships. This phase consumes Phase 6's identity, path, and digest primitives. It implements no state mutation, transaction kernel, snapshot materialization, or payload restore, and authors no manual-checkpoint or checkpoint-import schema.

**Success Criteria**:

- [x] Task-initialization and legacy-import-initialization schemas bind the exact whole-file config digest; no re-pin or amendment schema exists.
- [x] Valid state/initialization/document/implementation/maintenance samples round-trip through normative schemas; unknown fields, digest mismatches, invalid phase IDs, and contradictory accounting fail with stable errors.
- [x] Every shape reachable from the `archflow_state.artifact` union passes Ajv/Zod agreement; purely server-internal shapes have exactly one shape model.
- [x] Implementation-output manifests represent add/modify/delete/rename, tree modes, canonical Git blob identities, and bounded payload accounting without any structurally representable contradiction.
- [x] Byte accounting is bound to the 25 MiB per-result and 250 MiB per-task caps and corresponds one-to-one with the declared outputs it measures.

**Implemented 2026-07-28.** One scope limitation is recorded rather than absorbed, because it narrows the fourth criterion: a **cross-class rename is representable** here. `path` and `previous_path` are runtime-indistinguishable `RepositoryPathClaim` strings, Phase 6's sole lexical validator derives no class from either, and the class→template tables sit on the repository side of an import boundary `src/contracts/**` may not cross. Phase 7 therefore checks only `previous_path !== path` and supplies both typed endpoints; **Phase 10 classifies and verifies both endpoints and rejects a rename whose endpoints disagree**. The criterion holds for the operation × storage × file-type table, tree modes, blob identities, and accounting — all structurally unrepresentable when contradictory — but not for path-class agreement.

Two further deferrals the phase makes explicit: `payload_bytes`, `payload_digest`, and `after.oid` are **assertions** here and become verified facts in Phase 10, which is the layer that sees bytes; and the collection-path component of the semantic validator's pinned total order is never a tiebreaker in the current invariant table, because no artifact kind carries both a root `phase_instance` and a `phase_instance`-bearing collection.

### Phase 8: Manual Checkpoint Chain and Import

**Goal**: Define the immutable predecessor-linked manual checkpoint chain and its import wrapper as a self-proving conservative manual authority.

**Depends on**: Phase 7

**Requirements**: REQ-11, REQ-21, REQ-26, REQ-39, REQ-50

**Scope**: Author the `manual-checkpoint` and `manual-checkpoint-import` schemas with Zod mirrors, and extend Phase 7's same consolidated semantic validator with the chain invariants; this phase adds no second cross-document authority. Checkpoints are predecessor-linked by a self-digest over canonical bytes and carry the evidence chain that holds degraded-mode review provenance, composed over Phase 2's `evidence-slots` definitions rather than restating their assurance and family correlations; that chain is REQ-11's slice here, and it moved with the checkpoint family out of Phase 7. The wrapper pins one complete representation of both initialization modes: revision 1 supplies the whole `task-initialization` or `legacy-import-initialization` artifact it names rather than only an `initialization_digest`, and the validator's subject admits that artifact together with the chain, so an import can carry both. An accepted chain therefore begins at revision 1 or at an authenticated predecessor target; the expected-state-revision field is present exactly when existing state is supplied; and existing state is correlated to the exact predecessor checkpoint by digest, never by revision number alone. Every checkpoint binds the wrapper's task and repository identity, so a chain cannot be assembled across task boundaries. This phase implements no state mutation, no adoption, and no reconciliation; those belong to Phase 9.

**Success Criteria**:

- [ ] A chain proves its own initialization: revision 1 carries the complete `task-initialization` or `legacy-import-initialization` artifact it names, the validator subject admits that artifact alongside the chain, and a chain naming an initialization it cannot supply fails with a stable error.
- [ ] Every accepted import begins at revision 1 or names an authenticated predecessor target. The expected-state-revision field is present exactly when existing state is supplied and absent otherwise; state whose revision matches the predecessor but whose digest does not fails.
- [ ] Every checkpoint's task and repository identity equals the wrapper's. A digest-valid chain assembled from checkpoints of two tasks fails as an isolation violation instead of validating.
- [ ] Predecessor gaps, self-digest mismatches, reordered or duplicated revisions, and unknown fields fail with stable errors, and the greatest valid chain is identified without consulting server state.
- [ ] `manual-checkpoint` and `manual-checkpoint-import` pass the same Ajv/Zod agreement harness as Phase 7's union-reachable shapes.
- [ ] Chain invariants live in Phase 7's consolidated semantic validator, extended in place; no second semantic authority exists.

### Phase 9: Transaction Kernel, Intent/CAS, and Crash Recovery

**Goal**: Commit one task's transitions exactly once under races, crashes, retries, config drift, and bounded reconciliation.

**Depends on**: Phases 7–8

**Requirements**: REQ-04, REQ-08, REQ-13, REQ-14, REQ-21, REQ-22, REQ-23, REQ-24, REQ-26, REQ-39, REQ-50

**Scope**: Implement task locks, revision CAS on every invocation, closed request digests, prepared receipts/results, atomic projections, state-last commitment, direct and checkpoint-1-constrained revision-0→1 adoption, bounded ordinary reconciliation, explicit full audit/repair, config-pin enforcement before transition, and divergent-history repair/handoff. Payload snapshots and restore are Phase 10.

**Success Criteria**:

- [ ] Exact replay returns the recorded revision/result only when current state commits it; prepared receipts do not. The request digest excludes revision/retry transport data, CAS is checked on every invocation, changed reuse returns `INTENT_MISMATCH`, stale writers return `STATE_CONFLICT`, and two same-filesystem processes yield one winner.
- [ ] Fault injection before/during/after every receipt/projection/state write leaves prior/next valid state or precise non-advancing repair; reconciliation never promotes an orphan as success.
- [ ] A normal task reaches revision 1 only from a valid `task-initialization` supplied directly or as checkpoint 1 of a closed manual import; legacy initialization follows its tagged equivalent and missing/mismatched policy fails.
- [ ] Any config byte change returns `PINNED_CONFIG_MISMATCH` before dispatch/state transition; status reports the mismatch and directs intentional routing/model/effort changes to a distinct task or explicit upgrade.
- [ ] Mature-task step boundaries and status reconcile only current state projections, the relevant active/prepared intent, and active gate/checkpoint head; only explicit repair/import/audit walks history.
- [ ] Divergent/conflicted clones remain non-authoritative until preserve-both-heads repair selects/replays one successor chain and records a clean one-writer handoff.

### Phase 10: Snapshots, Implementation Manifests, and Restore

**Goal**: Retain and restore deterministic declared outputs within explicit storage, retention, collision, and secret-safety bounds.

**Depends on**: Phase 9

**Requirements**: REQ-08, REQ-11, REQ-13, REQ-21, REQ-22, REQ-23, REQ-25, REQ-26, REQ-33, REQ-39, REQ-50

**Scope**: Implement content-addressed result manifests, tracked-output Git-object reuse, bounded untracked/generated/restore payload storage, implementation-output manifests, snapshot/checkpoint secret scanning, atomic projection/restore, collision classification, retention reachability, and explicit maintenance records. Phase 11 connects collision decisions to the gate service.

**Success Criteria**:

- [ ] An unchanged fingerprint restores byte-identical declared outputs while unrelated tracked/untracked bytes remain untouched; a changed fingerprint creates one new retained generation, and a collision changes nothing before an explicit decision.
- [ ] Implementation manifests round-trip add/modify/delete/rename, binary content, tree modes, canonical post-attributes Git blob OIDs, retained restore/untracked payloads, before/after identities, parent outputs, and exact diff digest; tracked outputs reuse Git objects rather than copied payloads.
- [ ] Representative payload growth reaches but never exceeds 25 MiB per result or 250 MiB per task; either excess returns non-advancing `SNAPSHOT_LIMIT` with counts/guidance, writes no partial/truncated payload, and creates no hidden authority.
- [ ] Every current authoritative generation and all decision/review/checkpoint evidence remain reachable. Human-approved maintenance prunes only unreferenced diagnostic attempts or superseded non-authoritative payloads, writes an immutable deleted-digest/bytes/reason record, and cannot break rerun, restore, or checkpoint chains.
- [ ] Secret fixtures in any candidate Git-tracked snapshot/checkpoint projection fail before projection with safe remediation warning that later `.archflow/` deletion cannot erase branch history; clean binary/text fixtures pass without logging secret values.
- [ ] Snapshot/projection/restore fault injection preserves prior/next authority or exact repair, and the three `restore-collision` outcomes are representable without silent overwrite.

### Phase 11: Durable Gates, Waivers, and Manual Decisions

**Goal**: Persist every human authority boundary independently of a live MCP request.

**Depends on**: Phase 10

**Requirements**: REQ-09, REQ-13, REQ-18, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-36, REQ-37, REQ-38, REQ-39, REQ-40, REQ-41, REQ-50

**Scope**: Implement the one-active-gate lifecycle, retained gate-ID request/decision archives, blocking/cancellation/resume semantics, `waiver-requested` close/archive sequencing, scoped waivers and expiry, digest-bound commit authorization, `restore-collision`, supplemental gate-counter evidence paths, exact manual request/decision templates, and conservative evidence reconciliation.

**Success Criteria**:

- [ ] A connected call blocks until a schema-valid exact decision or explicit cancellation/failure; restart/cancellation leaves one resumable pending gate and never returns pending as success.
- [ ] Partial, malformed, stale, wrong-task, wrong-ID, wrong-digest, duplicated, and approval-shaped constitution-edit decisions cannot resolve or advance a gate; one valid decision resolves exactly once.
- [ ] Two processes cannot create or resolve conflicting gates/waivers; separate tasks can wait independently.
- [ ] Manual files can record multiple non-colliding gates, one waiver, supplemental review/decline, and commit authorization, and recovery imports only complete decisions without repetition.
- [ ] A `SUPPLEMENTAL_REVIEW_REQUIRED` retry after an intervening transition reuses the same intent/request digest with refreshed `expected_revision`; accepted-change or other subject supersession closes the old gate and requires a fresh intent/generation.
- [ ] `waiver-requested` is non-advancing and archives the current gate before the sole waiver gate opens; grant resumes only the recorded rule/scope, denial remains non-advancing, and no nested gate exists. `restore-collision` exposes only discard-and-restore, adopt-as-new-generation with changed inputs/fingerprint and rationale, or abort.
- [ ] A real Claude host timeout leaves one pending gate, and a later invocation resumes and resolves that gate exactly once; timeout-then-resume is normal supported behavior.

### Phase 12: Host Identity, Sandbox, and CLI Dispatch

**Goal**: Prove fresh opposite-family reviewer processes receive only declared envelopes and are safe to dispatch on every claimed environment.

**Depends on**: Phases 1–11

**Requirements**: REQ-26, REQ-29, REQ-30, REQ-31, REQ-32, REQ-34, REQ-35

**Scope**: Implement immutable host identity, routing/family validation, exact adapters, auth/version/managed-policy preflights, selected-CLI runtime/own-auth allowlists, generated empty config/home, repository/global/other-family/unrelated-secret isolation, environment scrubbing, canary/output scans, bounded envelopes, process lifecycle/failures, provider probes, and candidate/license evaluation without automatic adoption.

**Success Criteria**:

- [ ] Real handshake fixtures identify supported Claude Code/Codex versions; missing/ambiguous/unsupported identity and same-family routing launch no child.
- [ ] Both producer directions prove a fresh PID/session and expected family. Provider-key/routing sentinels and unrelated secrets are absent from child input and persisted diagnostics.
- [ ] Both supported first-party CLIs use their own subscription authentication without ArchFlow reading, copying, injecting, prompting for, persisting, or logging credential values. Shared own-auth access in the selected CLI process tree is permitted; API-key/provider-routing variables remain scrubbed.
- [ ] A randomized black-box child can read its envelope/temp, measured runtime, and selected CLI's narrowly required own-auth paths, but cannot read/write the repository, sibling tasks, global agent instructions/config, the other family's credential store, or unrelated-secret canaries. Output/diagnostics emit no unrelated-secret canary. No environment is supported without this proof in both producer directions.
- [ ] Missing CLI, bad/unsupported auth or model, rate limit, timeout, cancellation, output overflow, invalid JSON, nonzero exit, and I/O failure remain distinguishable; descendants die and none produces pass evidence.
- [ ] For every supported SandboxProvider, descendants that create new process groups/sessions are terminated by the provider's PID namespace/cgroup/job object or proven equivalent on cancellation, timeout, shutdown, and overflow; Execa best effort alone cannot satisfy the proof.
- [ ] Any external sandbox dependency and license is presented for explicit acceptance before adoption; copyleft is never silently bundled.
- [ ] The Anthropic subscription-authenticated dispatch path remains release-disabled until written clarification or a qualified legal determination satisfies `VAL-14`; implementation or fixture success is not legal approval.

### Phase 13: Constitution Adjudication, Drift, and Review Fixed Point

**Goal**: Turn validated reviewer output and pinned policy/upstream inputs into current-digest advancement evidence.

**Depends on**: Phases 1–12

**Requirements**: REQ-10, REQ-11, REQ-12, REQ-13, REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-32, REQ-33

**Scope**: Implement counter-review/adjudication orchestration, structured result validation, server-attested canonical rendering, stable findings and exact triage, accepted-finding reruns, attempt bounds, explicit approved-policy-base constitution resolution, `review_trigger` and current `enforced_by` evaluation, separate compliance/drift verdicts, unresolved task-local constitution-edit rejection, and upstream evidence invalidation/reopening.

**Success Criteria**:

- [ ] Accepted findings across two rewrites invalidate stale evidence, rerun self/counter/triage, and adjudicate only the final digest; blockers never authorize advancement and exhaustion gates.
- [ ] The curated corpus distinguishes seeded substantive defects from clean controls and records approved release thresholds based on quality rather than finding count.
- [ ] Positive, negative, and uncertain triggers plus current/missing/stale/failed mechanical evidence behave fail-closed against the approved policy-base constitution.
- [ ] Aligned and incidental drift are recorded correctly; material drift gates and an accepted change reopens the affected upstream approval/evidence chain.

### Phase 14: Five-Tool MCP Assembly and Offline Local CLI

**Goal**: Assemble persistence, dispatch, adjudication, and decisions behind the complete and only MCP workflow surface.

**Depends on**: Phases 1–13

**Requirements**: REQ-07, REQ-08, REQ-11, REQ-13, REQ-21, REQ-23, REQ-27, REQ-28, REQ-29, REQ-30, REQ-31, REQ-32, REQ-33, REQ-35, REQ-36, REQ-37, REQ-38, REQ-39, REQ-40

**Scope**: Wire exactly five handlers through the v2 adapter and implement `archflow-local` for validate, hash, render, snapshot/restore, human-approved maintenance with immutable records, atomic decisions, degraded status, reconcile/import, upgrade staging, and immutable checkpoint creation/chain validation. Connect mutation/replay, dispatch, evidence, supplemental interruption, cancellation, protocol-only stdout, and public errors. Rebuild the Phase 5 tracked bundle and `dist/manifest.json` for the full server/helper assembly. Init and upgrade remain outside the tool list.

**Success Criteria**:

- [ ] Live `tools/list` returns exactly `archflow_state`, `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, and `archflow_waiver`, with the normative schemas and no sixth workflow tool.
- [ ] Valid and invalid calls exhibit replay, mismatch, conflict, family, host, path, child, and blocking semantics without partial success side effects.
- [ ] MCP cancellation leaves durable truth and kills active descendants; reconnect/resume observes existing state/gate rather than duplicating work.
- [ ] The bundled server emits only MCP traffic on stdout and opens no network listener.
- [ ] The offline helper performs its named local operations without MCP, shares schemas/renderers with the server, and is absent from `tools/list`.
- [ ] `archflow-local checkpoint` atomically extends only a valid reconciled chain, and server adoption imports only its greatest valid checkpoint via the closed union tag.
- [ ] The updated tracked manifest binds the complete server/helper bundle to current package/lock/source/schema/assets digests and passes clean-checkout offline startup before installer work.

### Phase 15: Installer, Initialization, and Host Registration

**Goal**: Install the offline bundle and initialize supported repositories repeatedly without damaging host or project configuration.

**Depends on**: Phases 1, 12, and 14

**Requirements**: REQ-01, REQ-02, REQ-28, REQ-29, REQ-34, REQ-37, REQ-40

**Scope**: Verify the Phase 14 tracked bundle/manifest, then extend `install.sh` for both bundle launchers and skill targets, replacing hard-coded `STALE_SKILLS` deletion with an ArchFlow-owned install manifest that removes only obsolete owned files and preserves unrelated skills; create `archflow-init`; scaffold assets; require `claude mcp add --scope project` to create/update committed shared `.mcp.json` with the PATH command `archflow-mcp`, and use official Codex registration; narrowly patch unsupported persistent per-server timeout/required settings with parse-before/after preservation; otherwise emit exact shell-profile guidance and verify a newly started host inherits `MCP_TOOL_TIMEOUT`; detect collisions, untrusted or managed config, unsupported versions/auth, and missing sandbox capability; and add recovery guidance.

**Success Criteria**:

- [ ] Installation from a clean checkout starts the exact pinned bundle offline on every claimed Node/host environment.
- [ ] Init reruns byte-stably, preserves unrelated JSON/TOML/settings, and reports collisions, malformed/untrusted config, unsupported runtime/CLI/auth, or missing sandbox proof without claiming success.
- [ ] Claude registration uses `claude mcp add --scope project archflow -- archflow-mcp`, produces the PRD-required shared/committed `.mcp.json`, contains no absolute home/install path, and preserves unrelated project registration/config bytes. Codex registration likewise uses its stable PATH launcher and preserves unrelated config.
- [ ] When Claude lacks a persistent per-server timeout, init explains that it cannot alter the current host's inherited environment, emits exactly `export MCP_TOOL_TIMEOUT=3600000` plus profile/new-terminal/restart guidance, and fails closed until a newly started host proves `archflow-mcp` inherited `3600000`.
- [ ] The owned install manifest upgrades/removes only ArchFlow-owned obsolete files; unrelated Claude/Codex skills and host files remain byte-identical.
- [ ] Initialized state is Git-trackable/shareable, contains no machine-specific executable path in portable task state, and works after repository relocation and in linked/space/Unicode worktrees.
- [ ] `archflow-init` creates no task state and no commit. Fresh task creation refuses to start until workflow/constitution assets resolve from an explicitly approved immutable commit and then stages the normal initialization manifest.

### Phase 16: Normal-Mode Thin Phase Skills and Truthful Status

**Goal**: Drive the normal MCP workflow from host-neutral phase skills and report only reconciled durable truth.

**Depends on**: Phases 1–15

**Requirements**: REQ-03, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-13, REQ-14, REQ-20, REQ-41

**Scope**: Rewrite the five phase skills and status as normal-mode marshallers over the fixed pipeline; preserve one source for both clients; use implementation manifests; enforce workflow approval and exact-diff commit authorization; update canonical parents/notes; offer deterministic gate-ID supplemental prompts; direct the second-terminal human to ingest the other client's structured JSON through `archflow-local`; and reconcile before truthful status. Manual fallbacks and upgrade are later phases.

**Success Criteria**:

- [ ] No skill branches on host identity or adds workflow tools; the same source installs and drives both producer directions.
- [ ] Phase design cannot become `DESIGNED` or permit code while evidence/gates are incomplete, and phase implementation cannot commit/complete before explicit final-digest authorization.
- [ ] Every human gate offers the optional other-client prompt; the other client emits structured JSON and, from a second terminal, the human runs `archflow-local` in normal/manual mode to validate, bind, canonically render, and atomically rename it to the gate-counter path. Decline records no fabricated review.
- [ ] The server sees only complete supplemental projections through filesystem notification plus bounded polling fallback. The gate-pending transition table admits only supplemental ingestion, triage, explicit decline/decision, cancellation, or supersession; `SUPPLEMENTAL_REVIEW_REQUIRED` rejection resumes the gate and accepted change supersedes it and re-enters the fixed point.
- [ ] Status verifies the immutable whole-config digest before recommending work; `PINNED_CONFIG_MISMATCH` reports no config content and recommends only a distinct new task or explicit upgrade for intentional routing/model/effort changes.

### Phase 17: Manual and Degraded Recovery Workflow

**Goal**: Complete and recover the workflow conservatively when individual MCP tools or the server are unavailable.

**Depends on**: Phases 1–16

**Requirements**: REQ-08, REQ-09, REQ-11, REQ-12, REQ-13, REQ-14, REQ-18, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25, REQ-36, REQ-37, REQ-38, REQ-39, REQ-40, REQ-41

**Scope**: Add exact per-tool fallback templates and skill flows using `archflow-local` for reconciliation, validation/hashing/rendering, snapshots/restores, atomic decisions, immutable manual milestone checkpoints, degraded status, and greatest-valid-chain import. Define initial normal/legacy checkpoints, one-writer handoff, and both-server-and-helper repair behavior.

**Success Criteria**:

- [ ] Removing each MCP capability and then the whole server still yields validating non-colliding artifacts, explicit decisions, retained exact results, and degraded truthful status through a multi-phase task.
- [ ] Prepared receipts/results never become manual success; collision, ambiguity, or absent helper stops non-advancing with exact repair instructions.
- [ ] Only snapshots/evidence/decisions reachable from the latest valid checkpoint are manual authority; server recovery adopts the greatest closed chain without replay or inferred gaps.
- [ ] Supplemental-review arrival, rejection/resume, accepted-change supersession, explicit decline, cancellation, and restart behave identically to normal-mode milestones.
- [ ] Manual operation never auto-commits/pushes and documents clean human-approved checkpoint handoff between writers.

### Phase 18: Legacy Upgrade Workflow

**Goal**: Migrate selected legacy material into a distinct canonical task without changing or implicitly approving the source.

**Depends on**: Phases 6–11, 13, 14, 16, and 17

**Requirements**: REQ-02, REQ-04, REQ-09, REQ-13, REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25, REQ-26, REQ-38, REQ-39, REQ-40, REQ-41, REQ-50

**Scope**: Add `archflow-upgrade` and its offline orchestrator: narrow selected-source read, immutable destination staging, explicit policy-base selection, no-state initialization manifest transition, mapping into existing phase instances, current-pipeline reruns, phase implementation-output audits, migration gate kind, and normal/manual interruption/replay. Use this repository's current legacy `.archflow/tasks/...` layout as an upgrade fixture and document release handling for users whose legacy tasks are in flight.

**Success Criteria**:

- [ ] Source bytes remain identical; destination staging is content-addressed and an interrupted/prepared import never initializes state.
- [ ] Exact replay returns the committed initialized destination, while changed source/destination/policy/config inputs or collisions stop without overwrite; the destination's whole config is pinned by its initialization manifest.
- [ ] Imported PRD/design/phases are unapproved/historical until existing current-digest pipelines approve them; no migration phase instance exists.
- [ ] Completed code is validated only by `phase-impl-<n>` implementation manifests and an explicit migration gate, with separate approved policy and import/code baselines.
- [ ] Pure manual upgrade begins with a validating legacy-initialization checkpoint and later server recovery adopts its chain without changing the source or replaying decisions.
- [ ] The repository's current legacy task layout upgrades through the same fixture path, and release guidance tells users with in-flight tasks how to finish in legacy tooling or checkpoint/handoff into a distinct upgraded task without silent in-place conversion.

### Phase 19: Reliability and Security Matrices

**Goal**: Prove persistence, race, path, process, and isolation invariants under adversarial failures.

**Depends on**: Phases 1–18

**Requirements**: REQ-04, REQ-05, REQ-11, REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-17, REQ-18, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25, REQ-26, REQ-27, REQ-28, REQ-29, REQ-30, REQ-31, REQ-32, REQ-33, REQ-34, REQ-35, REQ-36, REQ-37, REQ-38, REQ-39, REQ-50

**Scope**: Expand the owning-phase proofs across fault/configuration matrices: task/manual initialization and checkpoint chains; immutable-config mutations; local races and clone-divergence repair; Git text/mode/symlink normalization; snapshot growth/caps/retention/maintenance/secret scanning; implementation-manifest operations; path portability; gate attacks; selected-CLI own-auth trust with repository/global/other-family/unrelated-secret isolation; managed context injection; descendant escape; cancellation; and migration.

**Success Criteria**:

- [ ] Every crash point leaves committed prior/next state or precise non-advancing repair, with prepared material never inferred as success.
- [ ] Same-filesystem races yield one winner plus `STATE_CONFLICT`; independent-clone concurrency is documented as unsupported and locally undetectable before divergence, while divergent histories/conflicts are detected, remain non-authoritative, and pass preserve-both-heads repair plus clean one-writer handoff tests.
- [ ] Path, sandbox, managed-context, secret, descendant, and malformed-decision attacks read/write no undeclared repository data and create no pass/approval.
- [ ] Every config-byte mutation, including routing/model/effort and semantically equivalent rewrites, returns `PINNED_CONFIG_MISMATCH` before dispatch/transition and status gives the new-task/upgrade guidance.
- [ ] The selected CLI may use its own subscription store, but ArchFlow never handles credential values; repository/global/other-family/unrelated-secret canaries remain unreadable/unemitted, and API-key/provider-routing sentinels are absent. Lack of this proof marks the matrix entry unsupported.
- [ ] Binary/mode/rename/delete restore, manual recovery, and legacy staging remain collision-safe under fault injection; tracked canonical blob/tree identities remain stable across attributes, LF/CRLF and `core.autocrlf`, `core.fileMode`, executable-bit, and symlink checkout cases.
- [ ] Boundary and over-limit payload matrices prove 25 MiB/result and 250 MiB/task enforcement, no truncation/hidden authority, authoritative/evidence retention, maintenance reachability records, and pre-projection secret rejection under crashes and retries.

### Phase 20: Real-Host E2E and Review-Quality Validation

**Goal**: Validate useful independent review and complete normal, manual, and migration journeys in both producer directions.

**Depends on**: Phases 1–19

**Requirements**: REQ-01, REQ-02, REQ-03, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25, REQ-26, REQ-27, REQ-28, REQ-29, REQ-30, REQ-31, REQ-32, REQ-33, REQ-34, REQ-35, REQ-36, REQ-37, REQ-38, REQ-39, REQ-40, REQ-41, REQ-50

**Scope**: Run real supported Claude→Codex and Codex→Claude journeys, clean normal initialization plus policy/config mismatch cases, server-absent checkpoint journeys, upgrade journeys, multi-phase non-collision, representative snapshot growth/caps/retention/maintenance/secret rejection, dirty restore and `restore-collision` decisions, interruption/resume, optional gate review, selected-CLI own-auth plus prohibited-access canaries/output scans, and the review/policy/drift corpus. Set thresholds from results.

**Success Criteria**:

- [ ] `VAL-01` through `VAL-13` and `VAL-15` through `VAL-17` have reproducible evidence; `VAL-01` through `VAL-06` pass before any Archforge work begins.
- [ ] Both producer directions prove fresh opposite-family review, exact approvals/commit subjects, non-colliding phase evidence, parent updates, and no premature implementation or commit.
- [ ] Normal, manual, and migration journeys reach equivalent conservative milestones through interruption without fabricated evidence.
- [ ] Normal and manual journeys prove no restore collision overwrites silently: discard-and-restore touches only declared paths, adopt requires changed declared inputs/fingerprint plus rationale and creates a new generation, and abort leaves state/worktree non-advancing.
- [ ] Clean normal initialization reaches revision 1 only from the committed approved policy base; missing/uncommitted/mismatched bases fail. Manual initialization/checkpoints and greatest-chain recovery produce equivalent conservative authority.
- [ ] Every supported real host/provider proves the selected first-party CLI's own subscription authentication works in both producer directions while ArchFlow handles no credential values, API-key/provider routing is scrubbed, and repository/global/other-family/unrelated-secret canaries remain inaccessible/unemitted; shared selected-CLI own-auth access alone does not fail the run.
- [ ] A real task reaches the snapshot boundaries, receives `SNAPSHOT_LIMIT` above either cap without partial authority, retains all current/evidence chains, records a safe maintenance prune, and rejects a secret-bearing checkpoint before Git projection.
- [ ] The approved corpus thresholds demonstrate substantive defect detection and acceptable false blockers; failure of `VAL-02` reopens the automation premise.

### Phase 21: Release Packaging, Support Matrix, and Documentation Consistency

**Goal**: Produce a coherent beta release candidate and an explicit report of any remaining external release blockers.

**Depends on**: Phases 1–20

**Requirements**: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25, REQ-26, REQ-27, REQ-28, REQ-29, REQ-30, REQ-31, REQ-32, REQ-33, REQ-34, REQ-35, REQ-36, REQ-37, REQ-38, REQ-39, REQ-40, REQ-41, REQ-50

**Scope**: Reproduce the exact server/helper bundle and dependency notices; publish the supported Node/host/CLI/OS/sandbox/auth matrix and operations guidance; update `CLAUDE.md`, tracked/project `AGENTS.md` policy where in scope, `README.md`, process documentation, and the originating `docs/mcp-integration-design.md` while preserving its visible lineage/supersession banner and links to the normative PRD/architecture; update `install.sh` output and every installed skill listing; add agreement tests; and report the external Anthropic legal gate.

**Success Criteria**:

- [ ] The Node `24.15.0` functional floor, current Node 24 LTS security patch used by release/CI (`24.18.0` at design time), independently pinned Node-24 typings line, exact dependency/CLI/host pins, bundle hashes, licenses, and approved sandbox components are documented and reproducible offline.
- [ ] Repository-facing docs, installer output, assets, schemas, workflow, five-tool list, two launchers, canonical paths, and all installed skill listings pass consistency tests.
- [ ] Documentation preserves `docs/mcp-integration-design.md` as originating design lineage, retains its supersession banner, and identifies the approved PRD/architecture as normative where they differ.
- [ ] Supported environments have current real fixtures and sandbox proofs; all others fail closed with actionable guidance.
- [ ] Phase implementation/documentation may complete without the `VAL-14` determination, but release remains explicitly blocked until written Anthropic clarification or qualified legal determination exists.
- [ ] Cleanup guidance states `.archflow/` is branch-tracked development-lifecycle evidence removed before PR and v1 has no permanent audit export.

## Progress

| Phase | Name | Status |
|-------|------|--------|
| 1 | Contracts, Assets, and Package Scaffold | COMPLETE (2026-07-27) |
| 2 | Review Evidence and Contract Authority | COMPLETE (2026-07-27) |
| 3 | MCP Contract Boundary and Dependency Admission | COMPLETE (2026-07-27) |
| 4 | Guarded MCP Runtime and SDK Compatibility | COMPLETE (2026-07-27) |
| 5 | Offline Bundle and Release Integrity | COMPLETE (2026-07-28) |
| 6 | Repository Identity, Paths, and Canonical Digests | COMPLETE (2026-07-28) |
| 7 | Durable State and Artifact Schemas | COMPLETE (2026-07-28) |
| 8 | Manual Checkpoint Chain and Import | Not Started |
| 9 | Transaction Kernel, Intent/CAS, and Crash Recovery | Not Started |
| 10 | Snapshots, Implementation Manifests, and Restore | Not Started |
| 11 | Durable Gates, Waivers, and Manual Decisions | Not Started |
| 12 | Host Identity, Sandbox, and CLI Dispatch | Not Started |
| 13 | Constitution Adjudication, Drift, and Review Fixed Point | Not Started |
| 14 | Five-Tool MCP Assembly and Offline Local CLI | Not Started |
| 15 | Installer, Initialization, and Host Registration | Not Started |
| 16 | Normal-Mode Thin Phase Skills and Truthful Status | Not Started |
| 17 | Manual and Degraded Recovery Workflow | Not Started |
| 18 | Legacy Upgrade Workflow | Not Started |
| 19 | Reliability and Security Matrices | Not Started |
| 20 | Real-Host E2E and Review-Quality Validation | Not Started |
| 21 | Release Packaging, Support Matrix, and Documentation Consistency | Not Started |

---
*Created: 2026-07-26*
