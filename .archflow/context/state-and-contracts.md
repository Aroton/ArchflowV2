# Durable State and Protocol Contracts

**Explored:** 2026-08-10
**Commit:** `28c1021`

This document maps the repository's dominant trust subsystem: `src/contracts/`, `src/state/`,
`src/review/`, the MCP handlers in `src/mcp/handlers/`, and the offline/helper surface in
`src/local/`. It describes current behavior, not a desired design.

## 1. Authority layers

```text
src/contracts/**
  Pure JSON shapes, parsers, canonical bytes, digests, state/gate semantics
        ↓
src/state/**
  Authenticated reads, transition planning, immutable installs, transactions, gates,
  reconciliation, status, manual checkpoint/import support
        ↓
src/review/**
  Evidence envelopes, counter-review, triage/adjudication, fixed-point assessment
        ↓
src/mcp/handlers/** and src/local/**
  Connected and offline protocol surfaces
```

`src/contracts/**` does not inspect the filesystem, Git, or processes. A digest-shaped value is a
reference until the state/repository layer resolves and authenticates it. Contract parsers throw on
programmer/input-discipline violations; state and handler paths normally express expected failures
as `ProjectResult<T>` from `src/contracts/errors.ts`.

Two rules are load-bearing throughout this graph:

- Persisted shapes reachable from a `CanonicalDocument<T extends PlainJsonValue>` root are declared
  with `type`, not `interface`; declaration merging and missing implicit index signatures would
  weaken or break the exact persisted shape.
- Caller-owned objects are checked once with `assertPlainJson`, cloned with `structuredClone`, and
  only then inspected. `src/contracts/plain-json.ts` rejects accessors, non-enumerable data fields,
  symbol keys, cycles, sparse arrays, unsafe keys, non-finite numbers, exotic prototypes, and
  descriptor mutation. Shell readers also require an own, enumerable data property.

## 2. Canonical bytes, schemas, and errors

`src/contracts/canonical.ts` is the byte authority:

```ts
export interface CanonicalDocument<T extends PlainJsonValue> {
  readonly bytes: Uint8Array;
  readonly value: T;
  readonly digest: Sha256Digest;
}
```

`canonicalJsonBytes` ordinal-sorts object keys, preserves array order, uses two-space JSON, UTF-8,
and one trailing newline. `parseCanonicalDocument` performs fatal UTF-8 decoding, JSON parsing,
plain-JSON validation, canonical re-rendering, and byte equality. Thus semantically similar but
noncanonical JSON cannot become durable authority. Logical sets declare their own strict sort and
uniqueness rules; `isSortedUniqueBy` and `tupleKey` in `src/contracts/validators.ts` are shared by
Zod mirrors and Ajv custom keywords.

Normative JSON Schemas live in `src/contracts/schemas/v1/`. Agent-supplied MCP shapes have a Zod
mirror and are checked with `assertZodAgreement`; server-internal roots such as task state, intent
receipts, result manifests, and maintenance records deliberately use JSON Schema as their only shape
authority. `validateDurableSemantics` in `src/contracts/durable.ts` is the single cross-document
semantic authority. Its evaluation order is intentional because only one project error is returned.

Representative domain-separated identities from `src/contracts/fingerprints.ts`,
`src/contracts/durable.ts`, `src/state/snapshots.ts`, and
`src/state/implementation-manifest.ts` include:

- input fingerprints over pinned workflow/config/constitution, phase, rubric, Git identities, and
  declared inputs;
- closed request digests over tool, repository/task identity, operation fields, and the recomputed
  input fingerprint;
- deterministic gate IDs and gate-context digests;
- frozen open-gate state, declared-output snapshots, implementation diffs, Git index/worktree
  identities, projection generations, and pinned constitution digests.

`src/contracts/errors.ts` defines a closed registry of 55 project errors and four protocol errors.
Each definition fixes owner, retryability, a strict parameter parser, projection, and next action.
`parseProjectError`/`parseProtocolError` reconstruct the registry value and require deep equality, so
serialized errors cannot forge metadata. Relevant human-flow outcomes are explicit errors:
`SUPPLEMENTAL_REVIEW_REQUIRED`, `GATE_ACTIVE`, `GATE_DECISION_INVALID`, `GATE_CANCELLED`, and
`GATE_SUPERSEDED`.

## 3. Canonical persisted roots and paths

Path classes are declared by `src/contracts/path-claims.ts`; templates and authenticated resolution
live in `src/repository/paths.ts`.

| Durable or projected object | Canonical task-relative path | Contract / authority |
|---|---|---|
| Task config | `config.yaml` | exact-byte digest pin; `config.schema.json` after YAML parse |
| Task state | `state.json` | `TaskStateV1`; `task-state.schema.json` |
| Intent receipt | `intents/<intent-id>.json` | `IntentReceiptV1`; immutable commit point |
| Result manifest | `results/sha256/<result-digest>/manifest.json` | `ResultManifestV1`; content addressed and immutable |
| Result payload | `results/sha256/<result-digest>/payload/<output-path>` | raw immutable bytes bound by manifest |
| Gate archive | `decisions/<gate-id>/{request,decision}.json` | `GateRequestV1`, `GateDecisionRecordV1`; immutable |
| Supplemental gate evidence | `decisions/<gate-id>/supplemental-review.json` | `SupplementalReviewRecordV1`; authenticated separately |
| Human gate projection | `gate.json`, `gate.decision` | disposable `ActiveGateV1` plus human-authored response |
| Maintenance record | `maintenance/<id>.json` | immutable `MaintenanceRecordV1` |
| Manual checkpoint | `manual/checkpoints/<revision>-<digest>.json` | `ManualCheckpointV1` |
| Projected docs | `prd.md`, `design.md`, `phases/<n>/{design,impl-notes}.md` | retained result projection |
| Verification projection | `phases/<n>/verification.txt` | retained result projection |
| Review projection | `reviews/<phase>.{self,counter,triage,adjudication}.md` and gate-counter form | retained evidence projection |
| Import archive | `imports/<digest>/{manifest.json,payload/...}` | legacy import authority |

Repository-scoped authority is `.archflow/workflow.yaml`, numbered files under
`.archflow/constitution/`, and ordinary repository source outside `.archflow/`.
`shared-constitution` and `task-branch-constitution` intentionally share a path template and are
distinguished by the operation's expected class, not by path heuristics.

`src/state/layout.ts` creates sensitive directories with no-follow and directory checks. Mutability
is enforced in `src/state/atomic.ts`: `createExclusive` accepts immutable classes (intent,
maintenance record, result manifest/payload, decision), `replace` accepts only task state and gate
interfaces, and document/review files go through the bounded projection writer.

## 4. `TaskStateV1`: durable workflow authority

The root in `src/contracts/durable-state.ts` is approximately:

```ts
type TaskStateV1 = {
  schema_version: "1";
  task_id: TaskSlug;
  repository_identity_digest: Sha256Digest;
  revision: SafeInteger;                 // >= 1, monotonic
  phase_instance: PhaseInstanceId;       // prd | design | phase-design-N | phase-impl-N
  step: PipelineStep;                    // produce | self_review | counter_review | triage | adjudicate
  status: "running" | "succeeded" | "failed";
  attempt: SafeInteger;                  // >= 1
  input_fingerprint: Sha256Digest;       // current in-flight step
  initialization_digest: Sha256Digest;
  config_digest: Sha256Digest;
  workflow_digest: Sha256Digest;
  constitution_digest: Sha256Digest;
  policy_base_commit: GitOid;
  authoritative_results: AuthoritativeResultRef[];
  approvals: ApprovalRef[];
  waivers: WaiverRef[];
  planned_final_phase?: SafeInteger;
  open_gate?: OpenGateRef;
  committed_intent?: CommittedIntentRef;
  adopted_checkpoint?: AdoptedCheckpointRef;
  terminal?: "complete" | "abandoned";
};
```

Important invariants:

- The repository/config/workflow/constitution/policy pins are duplicated from initialization so
  status can read state without loading initialization. `validateDurableSemantics` compares the
  copies field by field.
- There is no persisted blocking reason; it is derived from terminal state, open gate, evidence,
  reconciliation, and checkpoint facts.
- `input_fingerprint` describes the in-flight step. Completed results retain their own fingerprints
  in `authoritative_results`.
- Result, approval, waiver, and committed-intent digests are references. Their consumers must load
  and authenticate the named archives.
- `authoritative_results` is sorted uniquely by `(phase_instance, step)`; approvals and waivers by
  `gate_id`. Only one open gate is representable.
- `planned_final_phase` is established from the approved design's consecutive phase headings.
  `src/state/transitions.ts` can mark `terminal: "complete"` only when the current `phase-impl-N`
  equals that value, the output is authenticated as committed at the target ref, and an exact
  commit-authorization approval is authenticated.

`planStateTransition` is pure. It checks the recomputed fingerprint before movement, enforces the
fixed phase sequence (`prd → design → phase-design-1 → phase-impl-1 → ...`), validates artifact and
result-reference correspondence, and accepts authenticated approval capabilities rather than raw
approval-shaped objects. `legalRunStepStatus` is reused by status request templates so a generated
request does not advertise an illegal movement.

Revision-zero initialization is separate in `src/state/initialization.ts`. It requires
`expected_revision: 0`, an initialization artifact, and exactly `prd/produce/running`; it validates
canonical task paths and commit objects. The general transition planner cannot mint revision 1.

## 5. Transactions, receipts, and replay

`runStateTransaction` in `src/state/transaction.ts` serializes mutation under the task's
`.transaction-lock` directory:

```text
read + canonically validate state
  → verify repository identity and expected revision
  → inspect immutable intents/<intent-id>.json
  → recompute config/pins, input fingerprint, and request digest
  → prepare result and next-state draft
  → correlate branded result + validate durable semantics
  → install payloads, manifest, and projections
  → create intent receipt exclusively        (commit point)
  → atomically replace state.json             (publication)
  → reread and authenticate committed state
```

The ordering is the crash-recovery proof: retained bytes precede the receipt; the receipt precedes
state publication. An existing intent is never blindly rerun:

- If `state.committed_intent` names it, the receipt is authenticated and the original result is
  replayed.
- If it is the immediate successor, installation/publication is resumed from receipt authority.
- If its request digest differs, the result is `INTENT_MISMATCH`.
- If its resulting revision is already behind current state, the result is `INTENT_NOT_CURRENT`.
- A future or malformed receipt makes task authority invalid rather than being guessed around.

Ambiguous write failures invoke arbitration: reread state, compare it to planned final and
predecessor digests, and return success, the original I/O failure, or `RECONCILIATION_REQUIRED`.
`src/state/reconciliation-discovery.ts` and `src/state/reconciliation.ts` also surface retained
receipt/projection disagreement to status.

The task lock is not automatically stolen. `src/state/lock.ts` pins filesystem identity for an
abandoned-lock plan and requires explicit human confirmation of no live writer before quarantine
and removal.

## 6. Retained results and projections

`ResultManifestV1` in `src/contracts/durable-result-manifest.ts` embeds its source artifact and
binds task/repository identity, phase, step, artifact digest, input fingerprint, declared snapshot,
outputs, projections, accounting, and secret-scan result. The directory's `result_digest` is the
canonical manifest digest; `snapshot_digest` is a separate domain-separated digest of declared
outputs and projections.

`src/state/snapshots.ts` validates raw payload length/digest, result and task byte caps, accounting,
secret-scan status, and the declared snapshot. Installation writes payloads before the manifest.
Existing immutable bytes are reused only when identical. Projection planning classifies each output
as exact, restore-ready, or collision; application re-observes targets and attempts ordered rollback
on drift. Lexical leaf paths are used when observing/mutating symlinks rather than a resolved
referent path.

`src/state/implementation-manifest.ts` authenticates implementation output against the base tree,
index, and live worktree; recomputes declared identity/diff digests; and requires the supplied
undeclared-change report to equal live Git state. `src/state/document-artifact.ts` performs the
corresponding document-byte checks. `src/state/produce-subject.ts` reconstructs current and upstream
review subjects from retained result authority.

## 7. Review and fixed-point contracts

The trust model is in `src/contracts/trust.ts` and private brands in
`src/contracts/internal/trust-brands.ts`. A current evidence set is ordered:

1. agent-declared self-review from the producer family;
2. server-attested or degraded counter-review from the opposite family;
3. optionally, gate-counter-review from the opposite family.

Evidence digests must be unique and every slot binds the same task, phase, subject, fingerprint,
rubric, and producer family. Production reconstruction happens through retained manifests in
`src/state/evidence-results.ts`; callers cannot mint its internal authority brands.

`validateTriage` requires exact coverage of every finding with consistent counts.
`parseAndDeriveAdjudication` recomputes constitution/drift folds and evidence coverage;
`crossCheckRuleFindings` in `src/review/adjudication.ts` checks active rule IDs, versions, order, and
enforcement mechanisms. `assessCurrentEvidence` in `src/review/fixed-point.ts` derives the next
workflow obligation (`self_review`, `counter_review`, `triage`, `adjudicate`, gate, advance, or
attempt exhaustion) from retained authority. Approved upstreams and waivers are accepted only after
their archived gate records are authenticated.

Review envelopes in `src/review/envelopes.ts` and `src/review/pinned-context.ts` pin exact evidence
bytes or bounded excerpts while retaining full digests. The byte cap prioritizes hand-written change
context; omitted material remains explicitly named/unavailable rather than silently disappearing.

## 8. Human gates, decisions, cancellation, and waiver

Nine gate kinds are closed over `GateContractByKind` in `src/contracts/gates.ts`:

| Kind | Main decision vocabulary |
|---|---|
| `artifact-approval` | approve / revise / reject |
| `review-trigger` | approve / revise / reject / waiver-requested |
| `material-drift` | amend-upstream / revise-current / reject |
| `adjudication-failure` | approve with exact resolutions / revise / reject / waiver-requested |
| `attempts-exhausted` | retry-once / revise / abort |
| `constitution-edit` | revert-edit / start-base-amendment / abort |
| `commit-authorization` | authorize-commit / revise / abort |
| `restore-collision` | discard-and-restore / adopt-as-new-generation / abort |
| `migration-audit` | accept-import-audit / revise / abort |

Every ordinary decision is a `GateDecisionEnvelope` binding gate/task/phase/subject/context plus
human provenance. Connected provenance binds connection/request identity; local provenance binds a
helper invocation. `validateGateDecision` enforces rules that structure alone cannot: waiver rules
must be eligible, adjudication resolutions must exactly cover non-waived failed/uncertain rules, and
restore adoption authority must equal the context candidate.

The lifecycle in `src/state/gates.ts` is:

```text
no open gate
  → archive decisions/<id>/request.json
  → set state.open_gate and publish reconstructible gate.json
  → human writes gate.decision (or optional supplemental evidence arrives)
  → archive decision.json
  → apply non-advancing outcome, or install authenticated success receipt/approval/waiver
  → clear state.open_gate and remove interface files
```

`gate_id` deterministically binds task identity, intent ID, and request digest. Archived request and
decision files are immutable and races must agree byte-for-byte. `gate.json` and `gate.decision` are
disposable interfaces: `gate.json` can be reconstructed from the request archive, and no interface
projection is required to resolve authority already archived.

`buildGateDecisionTemplates` and `ActiveGateV1.decision_template` expose every resolver-accepted
shape. Ordinary gates require `{payload,human_provenance}`; waiver gates require
`{granted,scope,origin,notes,human_provenance}`; every gate also publishes the cancellation form
`{cancelled,reason,human_provenance}`. A cancellation archives outcome `cancelled`, clears the open
gate, and returns `GATE_CANCELLED`; it never implies approval. Supersession archives outcome
`superseded`, clears the old gate without approval, and returns `GATE_SUPERSEDED` with old/new
subjects.

A waiver is a second gate bound to an exact archived `waiver-requested` origin. Authentication
re-reads the origin request and decision and compares gate, rule/version, task, phase, subject,
context, current evidence-set digest, scope, and decision digest. Granted waivers are scoped to
operation plus subject/phase/task boundary and expire at task completion.

## 9. Supplemental gate review

`SupplementalReviewRecordV1` in `src/contracts/supplemental-record.ts` binds the open gate request,
subject/context/fingerprint/current evidence, a complete degraded gate-counter review, its rendered
projection digest, complete triage, and a derived `no-change | accepted-change` outcome. The parser
recomputes both evidence and triage digests, checks all shared bindings, exact finding coverage and
counts, and requires `accepted-change` iff at least one finding was accepted.

The durable gate ledger accepts `decline`, `ingest`, and `triage-no-change`; `supersede` is archived
as the gate decision outcome rather than inserted into the ledger. `currentSupplementalLedger`
re-authenticates each non-decline entry against the supplemental archive. A projection entry alone
is never evidence authority.

`status.open_gate` publishes the decision templates, exact supplemental outcomes, a complete
counter-review prompt, and—when an accepted change exists—the exact supersession material. The
blocked gate/waiver call must be retried with the same intent and only the selected
`supplemental_outcome` added. No-change can return to the separately authored human decision;
accepted change supersedes the old gate and requires rebuilding the workflow subject.

## 10. MCP tool contracts

The five tools are fixed by `src/contracts/tool-names.ts`, `src/contracts/mcp-tools.ts`, and
`src/contracts/schemas/v1/mcp-tools.schema.json`:

| Tool | Purpose | Success identity |
|---|---|---|
| `archflow_state` | initialize or record a state/step artifact | path, revision, status |
| `archflow_counter_review` | dispatch and retain independent review | path, verdict, blocking count, revision |
| `archflow_adjudicate` | derive and retain policy/drift adjudication | path, constitution, drift, triggers, revision |
| `archflow_gate` | open/wait/resolve a typed human gate | typed decision, notes, revision |
| `archflow_waiver` | open/wait/resolve exact-origin waiver | binding plus granted/expiry or denial, revision |

Common input is `{schema_version, task_id, intent_id, expected_revision, input_fingerprint}`. Live
successes echo `request_digest`; the field is optional only so old immutable receipts replay
byte-identically. `parseToolCall` materializes, validates, freezes, and privately brands input.
`identifyTransactionRequest` derives the closed request identity. Result validation and correlation
then require tool, request/task/intent/fingerprint identity and exact expected success.

Handlers in `src/mcp/handlers/` are thin compositions over production services. `state.ts` selects
initialization versus ordinary transaction and prepares document/implementation/evidence results;
`counter-review.ts` and `adjudicate.ts` dispatch/reconstruct evidence; `gate.ts` and `waiver.ts`
invoke the shared gate lifecycle; `replay.ts` authenticates retained outcomes. Handler failures are
normalized through `handlers/errors.ts` without leaking arbitrary exceptions.

## 11. Status, request templates, and helper CLI

`computeTaskStatus` in `src/state/status.ts` is read-only and reconciliation-aware. `TaskStatusV1`
reports degraded state facts, config verification, dispatch routes, expected self-review
provenance, pinned constitution, current subject/evidence, open-gate interface material,
reconciliation findings, optional commit-authorization input, blockers, and exactly one
`next_action`.

`deriveNextAction` in `src/state/next-action.ts` is pure. Its ordering makes authority repair and
human gates precede ordinary workflow work. `src/state/request-templates.ts` attaches an executable
`{tool,input}` template when authenticated facts determine the mechanical fields. Judgment fields
remain explicit placeholders. Most templates carry an all-zero fingerprint sentinel that is valid
syntax but cannot authenticate directly.

`archflow-local envelope --task <task>` in `src/local/envelope.ts` is the normal request boundary:

- it parses the completed tool request;
- internally recomputes the fingerprint from live pinned authority;
- substitutes it only into the request and document/implementation artifact slots that contractually
  carry it;
- returns the exact `request.input`, `input_fingerprint`, and `request_digest`;
- for state artifacts, returns `artifact_digest`;
- for gates, returns deterministic paths and the complete optional counter-review prompt.

One pass is sufficient, and passing its returned request back through envelope is a fixed point.
Callers should invoke the MCP tool with `request.input` verbatim rather than transcribing digests.

`src/local/commands.ts` exposes 22 commands. The command contract table is authoritative about
whether a task is required and whether stdin is required. Input-free `init`, `task-init`, `status`,
and `manual-status` never read stdin. Important builders are `build-document`,
`build-implementation-output`, and `build-request`; inspection/recovery commands include
`validate`, `hash`, `render`, `snapshot`, `restore`, `maintain`, `decide`, `gate-counter`,
`reconcile`, `import`, and `checkpoint`.

## 12. Manual degraded workflow

Manual mode in `src/local/manual-workflow.ts` is deliberately lower assurance, not an alternate
source of truth. `loadManualAuthority` selects one authenticated authority form: initial,
state-anchored, or continuation. It loads retained manifests, verifies initialization and approved
design authority, derives `planned_final_phase`, and mints a private `ManualAuthority` capability.

`ManualCheckpointV1` and `ManualCheckpointImportV1` in
`src/contracts/durable-checkpoint.ts` support:

- initial revision 1 with embedded initialization;
- continuation linked by predecessor revision and checkpoint digest;
- state-anchored recovery linked to an authenticated state revision/digest.

`selectGreatestValidChain` stops on forks, gaps, or foreign candidates rather than guessing.
Checkpoint adoption replays transitions, requires the exact selected chain/head, and records
`adopted_checkpoint`. `manual-status` provides one command-shaped next action; `manual-next` records
actual milestones, results, terminal state, gate publication/resolution/supersession, or fallback
material; `manual-handoff` creates the canonical import call. Manual gates publish all accepted
decision templates and preserve the same cancellation, waiver-origin, supplemental-review, and
immutable archive bindings as connected mode.

## 13. Change hazards and verification map

- Adding a durable field affects schema authority, canonical digests, exact-field checks, replay,
  and possibly request selectors. Decide whether every new array is a set or sequence.
- Keep `validateDurableSemantics` rank order and its separation between shape, semantic, and live
  byte/Git checks.
- Preserve install ordering: payload → manifest → projection → receipt → state.
- Do not widen immutable versus replaceable path-class allowlists without revisiting crash recovery.
- A new gate kind must update the type map, kind list, context and decision parsers, effects,
  durable gate unions, templates, handler semantics, and schemas.
- Do not use `--literal-pathspecs` with `:(top,literal)` Git pathspecs.
- When reading through `Object.getOwnPropertyDescriptor`, require both a data `value` and
  `enumerable`.

Representative tests:

| Concern | Tests |
|---|---|
| Durable structural/semantic authority and schema agreement | `test/contracts/durable-*.test.ts`, `test/contracts/*agreement.test.ts` |
| Canonical bytes and schema registry | `test/contracts/canonical-parity.test.ts`, `test/contracts/schema-registry.test.ts` |
| Transaction, gate, initialization, checkpoint crash cuts | `test/crash/state-*.test.ts` |
| MCP parsing, handlers, replay, session, stdio | `test/integration/mcp-*.test.ts` |
| Status and executable request round trips | `test/integration/status-request-roundtrip.test.ts`, `state-projection-fresh-task.test.ts` |
| Local CLI stdin/payload/command contracts | `test/integration/local-cli-*.test.ts`, `local-envelope.test.ts` |
| Manual workflow/import | `test/integration/manual-workflow.test.ts`, `legacy-upgrade.test.ts` |
| Repository identity and Git path behavior | `test/integration/repository-git-*.test.ts` |

Primary verification commands are `npm run typecheck`, `npm test`, `npm run test:contracts`, and
`npm run check`.
