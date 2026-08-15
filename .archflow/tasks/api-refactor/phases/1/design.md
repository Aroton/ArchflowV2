# Phase 1 Design: Real-host Transport, Catalogue, Containment, and Delegation Policy

## 1. Goal and phase boundary

Phase 1 produces the evidence and separately approved repository policy needed before the semantic
API refactor can define contracts or enable autonomous execution. It must answer four questions
with source-bound, sanitized evidence:

1. Can Claude Code and Codex reliably keep or resume one semantic step through its first durable
   human/terminal boundary, including disconnect, EOF, and concurrent control behavior?
2. Can both hosts select the intended first tool from the exact proposed seven-tool catalogue, and
   what complete-catalogue byte ceiling should Phase 2 inherit?
3. On which operating systems can both adapters run behind a mechanically enforced provider-only
   network and credential boundary without access to the user's home or reusable credentials?
4. What exact repository constitution rule can authorize stage-scoped internal checkpoints and
   commits without weakening explicit human kickoff, exact phase-design approval, or the stop
   before every successor step?

This phase changes no production behavior. It may add opt-in spike harnesses, test-only fixtures,
sanitized validation evidence, a policy proposal, and documentation of the new validation surface.
It must not change `src/**`, generated schemas, the installed or advertised four-tool MCP surface,
the 14-command CLI, registrations or timeouts, durable task/state contracts, skills, release
payloads, or dispatch behavior. Semantic contracts begin in Phase 2; the repository fence and
coordinator begin in Phase 3; production containment begins in Phase 4.

The phase may finish only with a viable transport selection, a numeric catalogue ceiling, at least
one fully proven supported platform for both adapters, and a separately human-approved and
committed constitution revision. A negative transport result is a go/no-go stop that requires the
task design to be revised before Phase 2. An unproven platform is explicitly unsupported and
fail-closed; evidence from one OS never establishes another OS.

## 2. Requirements and upstream mapping

| Phase requirement | Upstream authority | Required result |
|---|---|---|
| Preserve explicit kickoff and exact phase-design approval | PRD R1, R5, R6; task design 3.3, 5.9 | Proposed policy grants authority only inside one explicitly started step and never starts its successor. |
| Select active-step delivery transport | PRD R8 and delivery decision 2; task design 5.1 | Both hosts exercise start and decision-resume lifetime, EOF, disconnect/reissue, concurrent control, and actionable-boundary delivery. |
| Set a measured catalogue budget | PRD R3, R14 and delivery decision 2; task design 5.2 | Exact digest-pinned seven-tool fixture, UTF-8 byte measurement, intent-selection corpus, and numeric ceiling. |
| Prove containment feasibility | PRD R9-R10; task design 3.5, 5.7 | Platform-specific provider proxy, credential/broker, home denial, supervision, cleanup, and fail-closed evidence. |
| Keep evidence honest and non-authoritative | PRD R2, R7, R15; active constitution | Records contain observations only, exclude workflow authority and secrets, and bind to source/fixture bytes. |
| Preserve current implementation | Phase 1 scope in task design Section 10 | Existing four tools, CLI, schemas, skills, durable kernel, and runtime behavior remain unchanged and their regression tests stay green. |

The current repository facts that constrain the work are:

- `src/contracts/tool-names.ts` and `test/unit/tool-names.test.ts` pin four production tools. The
  seven semantic tools therefore live only in a test fixture during this phase.
- `src/mcp/tools.ts` keeps advertised input schemas at plain object roots because hosts have lost
  root-level union branches. The prototype must preserve this property and add purpose-level tool
  descriptions.
- `src/init/registration.ts` configures one-hour tool-call timeouts for both hosts, while a future
  phase step may contain several 15-minute worker operations. Phase 1 must not infer that an
  attached call is viable from a short smoke test.
- `test/helpers/real-host.ts` makes real-host work opt-in and requires both authenticated clients.
  Existing dispatch tests exercise the clients as child reviewers, not as MCP clients selecting
  and waiting on semantic tools.
- Current dispatch shares the real home and credential locations and has no OS sandbox, provider
  proxy, or broker. Spike success must not be described as current production protection.
- `.archflow/constitution/00-process.md` is `explicit-human-authority` version 1. A second active
  rule granting delegation would conflict with it, so the proposal must be version 2 of the same
  stable rule ID. This task remains pinned to version 1.

## 3. Deliverables and file scope

Implementation should keep the hand-written surface near the following set; equivalent names are
acceptable only if the same boundaries remain obvious:

### Test-only harness and fixtures

- `test/real-host/api-refactor-transport.test.ts`: drives both real hosts against a fixture MCP
  server for start/resume lifetime, EOF, disconnect, reissue, concurrent control, and boundary
  delivery.
- `test/real-host/api-refactor-catalogue.test.ts`: advertises the exact semantic catalogue and
  records first-call selection for the pinned intent corpus in both hosts.
- `test/real-host/api-refactor-containment.test.ts`: exercises Linux bubblewrap and macOS seatbelt
  candidates, provider-only proxying, credential/broker candidates, denial canaries, lifecycle,
  and cleanup.
- `test/fixtures/api-refactor/semantic-catalogue.json`: the exact seven-tool prototype bytes used
  for selection and measurement. Any change changes its digest and invalidates earlier evidence.
- `test/fixtures/api-refactor/semantic-probe-server.mjs`: a minimal test-only MCP server that can
  hold a call, record sanitized lifecycle events, expose concurrent control, persist only fixture
  checkpoints needed for reconnect, and return a scripted actionable boundary.
- Test-only proxy, broker, bridge, or seatbelt fixtures under the same fixture directory. The Linux
  bridge must be built and launched in the same standalone form intended for a release payload and
  verified against a manifest digest, but this phase does not ship it.
- `test/contracts/api-refactor-phase1-evidence.test.ts`: in ordinary regression mode validates the
  committed evidence document's schema, self-consistent recorded aggregate, required scenario
  coverage, decision consistency, and absence of forbidden raw transcript/auth fields. Explicit
  evidence-reuse and scope-check modes perform the live-worktree comparisons described below.
- `test/helpers/real-host.ts` only if a small shared opt-in or sanitized host-version helper avoids
  duplication. Do not make ordinary tests spawn a host.

### Evidence and human-readable decisions

- `docs/validation/api-refactor-phase-1-evidence.json`: the canonical machine-checked evidence
  summary described in Section 4. It contains sanitized observations, not raw transcripts.
- `docs/validation/api-refactor-phase-1-decisions.md`: human-readable transport, catalogue, and
  platform selection memo. It explains failures and unsupported cases as plainly as successes.
- `docs/validation/api-refactor-phase-1-delegation-proposal.md`: exact proposed version-2
  `explicit-human-authority` frontmatter/body plus rationale and acceptance checklist for the
  separate `$archflow-constitution` workflow.
- Optional per-host/per-platform Markdown evidence extracts named
  `api-refactor-phase-1-<host-or-platform>.md` only after the corresponding run occurs. Never create
  an empty or implied-success evidence file.

### Maintained documentation

- Update `docs/TESTING.md`, which currently enumerates exactly five real-host test files, to
  describe the new opt-in spike suite, its additional explicit opt-in, and the difference between
  ordinary regression tests and point-in-time evidence runs.
- Update `docs/DEPENDENCIES.md` if the harness introduces optional external tools such as `bwrap`,
  `sandbox-exec`, or a fixture build tool not already documented.
- Do not rewrite MCP, workflow, state, CLI, skill, dispatch, or limitation pages to describe the
  future design as current behavior. Preserve `docs/validation/client-interface-audit.md`,
  `release-validation.md`, and review-benchmark evidence as historical records.

No other task's `.archflow/tasks/**` files may be read or changed.

## 4. Pinned cross-chunk evidence contract

All spike chunks write sanitized observations through one test-only collector. The committed JSON
summary has `schema_version: "1"`, a domain label `archflow-api-refactor-phase-1-evidence`, and these
required groups:

- `source`: full Git commit, explicit dirty-path list, OS, architecture, UTC interval, Node version,
  and an `execution_inputs` manifest. That manifest contains normalized repository-relative path,
  file kind/mode, byte count, and SHA-256 for every real-host test driver, intent corpus, catalogue,
  collector, fixture server, proxy, broker, bridge/profile source, build script, shared test helper,
  package/lock/config file, and repository module imported by any of them, plus one aggregate digest
  over the sorted entries. Generated standalone helper binaries and their release-style manifests
  have separate byte digests bound into the same aggregate. Host/OS versions remain observations,
  not substitutes for these content bindings.
- `hosts`: Claude Code and Codex CLI versions, delivered MCP client identity/protocol when present,
  and process-scoped timeout configuration. Raw auth status and environment values are forbidden.
- `transport`: one record per host and per entry path (`start`, `decision-resume`) containing the
  planned step ceiling, held duration, returned boundary, delivery mode, stdin/EOF outcome,
  disconnect outcome, reconnect/reissue result, duplicate-effect count, and whether a concurrent
  control call was delivered before the held call completed.
- `catalogue`: exact seven names in this order-agnostic set — `archflow_start`, `archflow_submit`,
  `archflow_decide`, `archflow_control`, `archflow_status`, `archflow_doctor`, and
  `archflow_upgrade` — fixture digest, exact complete `tools/list` UTF-8 byte count, selected numeric
  ceiling, and the per-host intent cases with expected and first selected tool. The byte count is
  exactly `Buffer.byteLength(JSON.stringify({ tools: parsedCatalogue }), "utf8")`: the minified MCP
  `ListToolsResult` value in fixture order, with no JSON-RPC envelope, request ID, newline, or other
  transport framing. Fixture-file whitespace and UTF-16 JavaScript string length are not measured.
- `platforms`: one Linux and one macOS decision record, each either `supported` with all required
  proofs or `unsupported` with concrete missing/failed proofs. Each record binds OS version,
  adapter versions, sandbox primitive, exact observed provider endpoint set, forced-proxy result,
  credential channel, refresh/broker-loss result, home/credential denial, arbitrary-network
  denial, process supervision, termination, and cleanup.
- `policy`: proposed stable rule ID/version and proposal digest, plus the separately approved
  constitution commit and final active rule digest once that workflow completes. It explicitly
  records that `api-refactor` remains pinned to version 1.
- `decisions`: selected transport, catalogue ceiling, supported-platform set, and a boolean
  `phase_2_may_begin` derived from the acceptance rules below rather than authored independently.

The evidence collector may persist timestamps, PIDs, exit/signal classifications, method names,
tool names, byte counts, digests, and allowlisted endpoint hostnames. It must never persist raw MCP
arguments or responses, prompts, model output, authentication output, tokens, credential contents,
environment values, home paths, workflow state, intents, receipts, task artifacts, gate data, or
unfiltered stdout/stderr. Temporary raw material is owner-only, lives outside the repository, and
is deleted after sanitized extraction.

The evidence contract test's ordinary mode treats the record as point-in-time validation evidence:
it checks schema and semantic consistency, recomputes the aggregate from the content digests stored
inside the record, validates scenario/decision derivation, and scans for forbidden fields. It does
not compare historical input digests with the current worktree.

With `ARCHFLOW_VERIFY_PHASE1_EVIDENCE=1`, the same test recursively follows every relative import
and referenced fixture from the three real-host drivers and fails if an execution input is absent
from the manifest or a manifest entry is not part of the run. That explicit reuse check recomputes
every current file and built-artifact digest, the aggregate execution-input digest, all fixture
digests, and the catalogue byte count using the exact parse/stringify/UTF-8 algorithm above.
Changing an executable/configuration input after a run therefore marks the evidence stale for
reuse by a dependent phase and forces the affected run to be repeated before it is relied upon; it
does not make ordinary regression tests reject an otherwise valid historical record. Phase 2 must
run evidence-reuse mode and either match the exact fixture shape or rerun Phase 1 catalogue
measurement before relying on its budget.

## 5. Work chunks

### Chunk A: Fixture server, catalogue, and evidence collector

Build the smallest SDK-compatible fixture that supports the measurements without importing or
changing production tool definitions. Its seven inputs have plain object roots, nested variants
only below the root, purpose-level descriptions, and the draft public response shape from task
design Sections 4.1-4.2. The fixture scripts durable mock checkpoints in a disposable directory so
reissuing the same start or decision after host loss returns the same eventual boundary with an
effect count of one. It is not a workflow implementation and must not read `.archflow/tasks/**`.

Create a representative intent corpus covering each tool at least once and the ambiguous boundaries
that commonly confuse tools: start PRD, start numbered phase design, submit a draft, approve a
presented choice, pause/cancel, observe status, diagnose a blocked repository, and preview a legacy
upgrade. Prompts express only user intent; they contain no tool names, schemas, or protocol hints.
Record the first MCP tool call only. Ordering runs must vary catalogue order so success is not an
artifact of position.

The selected byte ceiling is the smallest 4 KiB boundary strictly above
`Buffer.byteLength(JSON.stringify({ tools: parsedCatalogue }), "utf8")` for the digest-pinned
fixture. The descriptor array remains in fixture order for serialization even though name coverage
is compared as a set. Record both the raw measurement and formula. Every intent case must select
the expected first tool in both hosts; a miss requires fixture wording/schema revision and a
complete rerun, not a waived average.

### Chunk B: Transport and host-lifecycle evidence

Before the long run, calculate and record a conservative maximum expected attached-call duration
from the current 15-minute worker timeout, maximum remediation attempts, and the greatest number of
serial worker operations in one planned phase step. Do not substitute the ordinary 16-minute
real-host test timeout or a short smoke result. Exercise both `start` and `decision-resume` paths in
Claude Code and Codex with process-scoped MCP registration and the fixture server.

For each path, prove:

1. the call delivers exactly the first `awaiting-approval`, `escalated`, `blocked`, or `ready`
   boundary;
2. closing stdin or terminating the host does not convert silence into completion or leak the
   child process;
3. reissuing after disconnect reattaches/replays without duplicating the scripted effect;
4. a second session can deliver pause/cancel while the first call is held, or the result honestly
   shows that it cannot;
5. if the starting call returns before work completes, the host automatically surfaces the later
   boundary without status polling.

Select attached-until-boundary only if both hosts sustain the calculated ceiling and concurrent
control is deliverable. Select detached/background only if both hosts automatically surface the
later actionable boundary and reconnect is idempotent. The existing one-hour registrations are a
hard current fact: a selected attached ceiling above one hour requires an explicit later-phase
registration change and corresponding task-design update. If neither mode passes in both hosts,
record a no-go result, update the parent task design to reflect the failed assumption, and do not
authorize Phase 2.

### Chunk C: Catalogue measurement and first-call selection

Run the pinned corpus through non-persistent, process-scoped Claude Code and Codex sessions against
the exact fixture. Capture only sanitized selected-tool observations. Confirm that each descriptor
has a purpose-level description, all input roots are plain objects without root combinators, and no
internal transition/digest/path vocabulary is reachable. Commit the exact byte count, fixture
digest, results, and numeric ceiling to the evidence summary and explain the decision in the memo.

The production four-tool catalogue and its `<130000` regression fence remain untouched in this
phase. The historical 105,478-byte measurement is a comparison point, not Phase 1 evidence and not
the new ceiling.

### Chunk D: Containment, provider access, and platform decisions

Implement test-only candidate boundaries for Linux (`bwrap`, private namespaces, standalone
manifest-verified bridge) and macOS (`sandbox-exec`/seatbelt plus host-side broker). Each model-backed
adapter must authenticate and complete a harmless fixture request while:

- the repository view is read-only and only an isolated output directory is writable;
- the real home, `CODEX_HOME`, Claude configuration hierarchy, Keychain hierarchy, and reusable
  credential files are not mounted or readable by model tools;
- provider traffic is forced through one dispatcher-owned allowlisting proxy and every observed
  CONNECT destination is recorded as a hostname/port only;
- direct arbitrary network and proxy bypass canaries fail before effect;
- the selected ephemeral credential or host-side broker channel completes initial authentication
  and refresh behavior without copying reusable credentials into the sandbox;
- broker/proxy loss fails before dispatch or terminates the child cleanly;
- timeout, cancellation, parent death, and normal exit terminate the entire process group and leave
  no writable workspace, proxy, bridge, broker, or credential material behind.

Evidence is adapter-version and OS-version bound. A platform is `supported` only when every item
passes for both adapters on that platform. The current Linux checkout cannot establish macOS
support; absent a separately executed macOS run, record macOS as unsupported. At least one platform
must pass for both adapters or the refactor is a no-go requiring task-design revision. A release-
style fixture proves feasibility only; Phase 4 owns production implementation and packaging.

### Chunk E: Delegation proposal, documentation, and handoff

Draft exact version-2 bytes for `.archflow/constitution/00-process.md` in the proposal document,
preserving `id: explicit-human-authority`. The proposed review trigger and normative text must make
all of these conditions explicit:

- a human explicitly starts one named top-level step;
- the granted authority is derived from exact approved artifacts, pinned policy/configuration,
  repository/task scope, permitted commands, and permitted Git effects;
- routine crash-safe production, review, triage, remediation, verification, and failure checkpoints
  are allowed throughout that explicitly started step while the exact delegation envelope remains
  valid; recording a checkpoint is never approval or authority to cross a human boundary;
- the final exact scoped implementation commit is allowed only inside that envelope and only after
  current review, configured verification, truthful parent documents, an implementation log, and
  exact scope proof;
- phase-design bytes always require explicit human approval;
- the coordinator stops for new scope/authority, unresolved judgment, unsafe or external effects,
  uncertainty, failure, pause/cancel, and every next top-level kickoff;
- missing, changed, deprecated, or mismatched rule bindings fail closed; silence and agent/model
  prose never supply authority.

The phase implementation presents this proposal, then stops and hands it to
`$archflow-constitution`. Only that separate workflow may edit, approve, and commit the repository
rule. Afterward, resume Phase 1 to verify the committed rule still satisfies the checklist, record
its commit/digest, confirm this task remains pinned to version 1, and finish the evidence memo.
Material changes made during the constitution workflow are judged against the checklist; the phase
must not silently substitute its earlier proposal digest for the approved bytes.

Update only the maintained documentation affected by the actual test/dependency additions. If any
measured decision contradicts task design Sections 3.5, 5.1, 5.2, 5.7, or the phase plan, update the
writable task design in the same production result and record the deviation explicitly before
review.

## 6. Review and risk controls

- **Evidence authenticity:** every record binds the source commit and the complete recursively
  checked execution-input manifest, including dirty worktree bytes and generated helper artifacts;
  unlisted inputs are rejected during creation, and later changed inputs are rejected whenever a
  dependent phase explicitly verifies the evidence for reuse. Ordinary tests preserve valid
  historical evidence rather than claiming that it describes later repository bytes.
- **Secret safety:** collect an allowlist of observation fields, never redact an arbitrary raw dump
  after the fact. Canary and contract tests scan committed evidence.
- **No false platform support:** one OS cannot stand in for another; one adapter cannot stand in for
  both; skipped tests are not passes.
- **No circular catalogue claim:** Phase 2 inherits the budget only while its public shape matches
  the exact prototype; drift requires remeasurement.
- **No premature authority:** the proposal and phase-design approval are not constitution approval.
  The rule changes only through the separate human gate and commit.
- **No accidental behavior swap:** regression tests pin four production tools, 14 CLI commands,
  existing schemas, gate behavior, and registration values throughout this phase.
- **Proportionality:** use test-local fixtures and existing SDK/process helpers. Do not build a
  general benchmark framework, production supervisor, proxy framework, credential manager, or
  sandbox abstraction in an evidence phase.

## 7. Success criteria

Phase 1 is complete only when all are true:

1. The committed evidence summary validates against the exact source and fixture bytes and contains
   no forbidden raw/auth/workflow material.
2. Both authenticated real hosts have complete start and decision-resume transport records. One
   transport satisfies the selection criteria for both, or the phase records a no-go and does not
   advance.
3. Every pinned intent case selects the intended first semantic tool in both hosts, and the memo
   records one numeric complete-catalogue ceiling derived by the pinned formula.
4. Each claimed supported platform passes the full sandbox, provider proxy, credential/broker,
   denial, supervision, and cleanup matrix for both adapters. Missing platform evidence is recorded
   as unsupported, and at least one platform is supported.
5. The version-2 `explicit-human-authority` proposal has completed the separate constitution
   workflow, the exact approved bytes and commit are recorded, and this task is still governed by
   its pinned version-1 policy.
6. No production source, generated contract, installed surface, registration, skill, durable state,
   or release payload changed. `docs/TESTING.md` and any actually affected dependency documentation
   describe the new opt-in validation surface accurately.
7. Ordinary verification and all applicable real-host/platform runs pass. A skip is recorded only
   as unsupported evidence, never as success.

## 8. Executable verification

Run local regression first; it must not invoke real clients:

```bash
npm run typecheck
npm run check:schemas
npm exec -- vitest run \
  test/unit/tool-names.test.ts \
  test/unit/local-commands.test.ts \
  test/contracts/mcp-advertised-schema.test.ts \
  test/contracts/api-refactor-phase1-evidence.test.ts \
  test/unit/mcp-sdk-adapter.test.ts \
  test/integration/mcp-stdio.test.ts \
  test/integration/dispatch-plumbing.test.ts \
  test/unit/constitution.test.ts \
  test/unit/state-constitution.test.ts
npm run check
git diff --check
ARCHFLOW_VERIFY_PHASE1_SCOPE=1 npm exec -- vitest run \
  test/contracts/api-refactor-phase1-evidence.test.ts
ARCHFLOW_VERIFY_PHASE1_EVIDENCE=1 npm exec -- vitest run \
  test/contracts/api-refactor-phase1-evidence.test.ts
```

On each platform claimed as supported, with both authenticated clients available, run the dedicated
spikes serially so they cannot race for credentials, ports, or temporary host configuration:

```bash
ARCHFLOW_REAL_HOSTS=1 ARCHFLOW_API_REFACTOR_PHASE1=1 \
  npm exec -- vitest run --no-file-parallelism \
  test/real-host/api-refactor-transport.test.ts \
  test/real-host/api-refactor-catalogue.test.ts \
  test/real-host/api-refactor-containment.test.ts
```

The implementation notes must list the actual per-platform commands, UTC run intervals, source
commit, dirty paths, aggregate execution-input digest, client/OS versions, evidence digest, and any
unsupported result. During Phase 1, evidence-reuse mode must match the exact bytes that produced the
records; re-run an affected spike if it does not. After Phase 1, input drift marks the evidence
stale for a later phase's reuse but does not fail the ordinary historical-record test. Re-run both
explicit modes after the separate constitution commit has been recorded. In scope-check
mode that test parses
`git status --porcelain=v1 -z --untracked-files=all`, including tracked, staged, deleted, renamed,
and untracked paths, and rejects everything outside this explicit allowlist:

- `.archflow/tasks/api-refactor/**` (workflow-owned state, phase artifact/log, and any truthful
  parent-document revision);
- `test/real-host/api-refactor-*.test.ts`;
- `test/fixtures/api-refactor/**`;
- `test/contracts/api-refactor-phase1-evidence.test.ts`;
- `test/helpers/real-host.ts`;
- `docs/validation/api-refactor-phase-1-*`;
- `docs/TESTING.md` and `docs/DEPENDENCIES.md`.

For rename/copy entries the check validates both paths. No ignored path is admitted merely because
Git status omits it: the implementation also compares the concrete deliverable files and fixture
tree against `git ls-files --cached --others --exclude-standard` so every expected evidence input
is present and no expected file is hidden by an ignore rule.

## 9. Handoff

When the evidence and policy criteria pass, Phase 2 may consume exactly three outputs: the selected
transport shape (including maximum supported duration and reconnect semantics), the digest-pinned
seven-tool catalogue plus numeric ceiling, and the supported-platform/provider boundary inventory.
Before consuming them it runs `ARCHFLOW_VERIFY_PHASE1_EVIDENCE=1`; a mismatch requires the affected
measurement to be rerun or the dependent design to stop treating that record as current. Phase 2
must not treat spike code as production code or the api-refactor task's version-1 policy pin as
delegated commit authority.

If transport has no viable cross-host result, no platform supports both adapters, or the separate
constitution revision is denied, Phase 1 reports the specific no-go result and returns to task
design. It does not soften containment, infer approval, or let Phase 2 proceed on provisional
evidence.
