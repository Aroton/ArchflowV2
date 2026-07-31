# Phase 15 Implementation Counter-Review

**Task**: mcp-integration
**Phase**: 15 — Five-Tool MCP Assembly and Offline Local CLI
**Reviewed**: 2026-07-31
**Reviewer**: cross-client counter-review (fresh context, uncommitted working tree)

Verification actually run during this review (not taken on trust):

- `npm run typecheck` — clean.
- `npm test` — **3 failed / 1,511**, all in `test/integration/release-offline.test.ts`.
- `npm run release:stage -- --output <scratch>` — **fails**.
- Full release chain (`stage → write → check:release`) reproduced in a throwaway copy of the tree
  after repairing only the legal bindings, to separate "code is wrong" from "authoring is unfinished".

---

## Blocker 1 — Chunk 6 (release rebuild) is unfinished; `npm test` fails and `release:stage` cannot run

The design's success criteria require a regenerated tracked manifest describing both build entries
and `npm test` at zero failures. Neither holds.

Evidence:

- `dist/` is byte-for-byte unchanged (`git status` shows nothing under `dist/`). There is no
  `dist/archflow-local.mjs`; `dist/manifest.json` is still single-entry with no `entry_provenance`
  and still binds `ajv-8.18.0` / `fast-uri-3.1.0`. `release:write` was never run.
- `npm test` fails 3 tests in `release-offline.test.ts` — the exact failures the design says this
  phase clears (`:45`, `:61`, `:78`), including
  `release manifest schema validation failed: … missing required property 'entry_provenance'`.
- `npm run release:stage` aborts at `risk decision bundle binding is stale: fast-uri-3-1-0-local-risk`.

Re-running staging after fixing each stop in turn exposes **three independent authoring
inconsistencies** in `release/`, each of which one staging run would have caught:

| # | Problem | Observed |
| --- | --- | --- |
| a | `release/legal-review.json` decision `bundle_digest` is stale | decision `1e49386c…`, actual staged bundle `6caad4f0…` |
| b | decision `reachability_evidence.digest` does not match the file it names | decision `8b36abbd…`, `sha256(release/evidence/focused-inert-reachability.json)` = `adabe34a…`. The evidence *was* re-authored for the live runtime (correct per the design); the decision binding was not updated. |
| c | `release/evidence/user-risk-acceptance.json` was never touched | still `scope.handler_authority: "inert-no-handler"`, so `acceptance.scope ≠ decision.scope` → `user acceptance scope differs` (`release-support.mjs:804`) |

(c) is more than a digest edit: the retained human acceptance text and date are the pre-live-handler
acceptance, and the decision's own `invalidated_by` lists `handler-authority-change`. The design
reserved "accepting the re-authored `fast-uri` risk decision" as **human judgment only** — that
question was never surfaced to the user, and the phase was reported as verified with the release
chain in a non-runnable state.

Related open item, unresolved: the decision is still `fast-uri-3-1-0-local-risk` /
`package_version: "3.1.0"` while `current_components` now contains `fast-uri@3.1.4`. It slips past
`release-support.mjs:782` only because that check accepts a `componentIds.startsWith("fast-uri-")`
prefix match. The design explicitly asked whether the four advisories apply to 3.1.4 before
assuming a single decision suffices; that check is not recorded anywhere.

**The release *code* is not the problem.** In a throwaway copy I rebound (a), (b) and (c) and then
ran the design's exact ordering — `release:stage → release:write → check:release`. It all passes:
two build entries with per-entry provenance, the derived import allowlist, and a derived 24-source
legal closure. So the remaining work is the last-mile authoring plus the human acceptance, not a
redesign.

**Suggested resolution**: surface the `fast-uri` re-acceptance (and the 3.1.4-vs-3.1.0 scope
question) to the user, then run the single documented ordering end to end:
`.gitattributes` → `release:stage` → read the final digests/entry bindings off the staged payload →
author decision + evidence together → `release:stage` → `release:write` → `check:release`.

---

## Blocker 2 — `release-offline.test.ts` still asserts the field the smoke script removed

`scripts/smoke-release-bundle.mjs:296` now returns `bundles: ["archflow-mcp.mjs", "archflow-local.mjs"]`,
but `test/integration/release-offline.test.ts:50` still asserts
`toMatchObject({ bundle: "archflow-mcp.mjs", … })`. `toMatchObject` requires the key, so this can
never pass.

This is independent of Blocker 1 and survives it: in the repaired copy with a fully written
release, `npm test` reported **1,510 passed / 1 failed**, and the single remaining failure is
exactly this assertion. Closing Blocker 1 alone will *not* produce a clean `npm test`.

**Suggested resolution**: update the assertion to `bundles: ["archflow-mcp.mjs", "archflow-local.mjs"]`.

---

## Major 3 — A successful gate supersession is reported to the caller as `STATE_INVALID`

`src/mcp/handlers/gate.ts:43-48` rejects any resolution whose record outcome is not `"decided"`.
But `supplemental_outcome: { action: "supersede", … }` is accepted wire input
(`src/contracts/mcp-tools.ts:48,91`), and `openDurableGate` (`src/state/gates.ts:607-628`) handles
it by archiving a `outcome: "superseded"` record, advancing the revision, and removing the gate
interface. `runDurableGate` then returns `ok({ record: <superseded document>, … })`.

Result: the durable write succeeded, the gate is gone, the revision advanced — and the caller is
told `STATE_INVALID / gate-resolution-missing-decision`. A caller that retries on that error will
find the gate no longer open. The design required the analogous constitution-edit arm to return a
*classified* non-success naming the gate and its retry contract; supersession gets a misclassified
one instead.

**Suggested resolution**: give `"superseded"` its own arm — a classified non-success naming the
superseded gate and the new subject digest (the same treatment `adjudicate.ts:344-348` gives the
open constitution-edit gate), rather than reusing `STATE_INVALID`.

---

## Major 4 — Ordinary caller-data mismatches surface as `INTERNAL_ERROR`

`src/mcp/handlers/state-results.ts` throws `TypeError` for conditions that are ordinary invalid
caller input, not server defects:

- `:103` `document path and projection target disagree`
- `:107` `document projection must be a present regular file`
- `:111` `document bytes disagree with the supplied artifact` (byte count or `content_digest`)
- `:131` `document snapshot digest disagrees`
- `:247` `implementation after-image bytes are unavailable`
- `:266` `implementation projection identity missing`

`mapHandlerErrors` (`src/mcp/handlers/errors.ts:43`) deliberately rethrows `TypeError` as a defect,
and the tool boundary flattens it to `INTERNAL_ERROR`. So an agent that computes a document digest,
then touches the file before calling `archflow_state`, gets `INTERNAL_ERROR` with a correlation id
and no way to tell what went wrong — from a completely routine mistake.

The design is explicit here: handlers return `ProjectResult` only and reserve throws for defects.
The other handler paths honour that (`counter-review.ts:65`, `adjudicate.ts:91`, and
`state-results.ts:214`, which throws a `ProjectError` that `carried()` recovers).

**Suggested resolution**: return `CONTRACT_INVALID` (caller artifact disagrees with disk) or
`STATE_INVALID` from these six sites instead of throwing.

---

## Major 5 — `archflow-local status` hangs waiting on stdin

`src/local/main.ts:32` calls `readInput(parsed.values.input)` for every non-`--help` command, and
`readInput` (`:9-20`) drains `process.stdin` to EOF when `--input` is absent. `status` is the one
command that takes no input, and per the design it is what the human runs from their second
terminal — where stdin is an open TTY, so it never reaches EOF.

Confirmed empirically against a bundle of `src/local/main.ts`:
`sleep 10 | node local.mjs status --task foo` under a 5s timeout exits 124 (hung); it produces no
output and never returns.

**Suggested resolution**: only read stdin for commands that need a value (or read it only when
`process.stdin.isTTY` is false).

---

## Major 6 — "Both producer directions dispatch" is unproven, and `allow_claude_dispatch: true` was decided silently

Two halves of one success criterion ("Both producer directions dispatch successfully, with the
Claude-family path deliberately configured and its release authorization still recorded as blocked
by VAL-14"):

- `test/integration/dispatch-coordinator-phase15.test.ts:137,142` and `:168,173` both use
  `host: "claude"` with `allow_claude_dispatch: false`, so only the codex-adapter direction is ever
  exercised through the assembled coordinator. The `host: "codex"` → `claude-cli` direction — the
  one that the design says is "silently dead" without this flag — is never run through
  `createDispatchCoordinator` or a handler. Existing coverage is at the `selectCliAdapter`/adapter
  level from Phase 13, which is what the design said was insufficient.
- Meanwhile `src/mcp/handlers/counter-review.ts:81` and `src/mcp/handlers/adjudicate.ts:145`
  hardcode `allow_claude_dispatch: true` in the shipped handlers, behind a one-line comment. The
  design listed "the production `allow_claude_dispatch` value" under **human judgment only** and
  required recording that architecture release criterion 3 / VAL-14 (`architecture.md:371`, `:685`)
  still forbids releasing that path. Neither `architecture.md` nor the phase document records this
  decision; the only trace is the source comment.

**Suggested resolution**: add a coordinator/handler test for the `host: "codex"` direction using the
existing `test/fixtures/dispatch/fake-claude.mjs` fixture, and record the enablement decision (and
its VAL-14 release block) in `architecture.md` / the phase implementation log rather than only in a
code comment.

---

## Major 7 — The supplemental review round trip is never tested end to end

Success criterion: *"Supplemental review works end to end: `gate-counter` retains the immutable
record then publishes the projection; the resolver authenticates only from the record; a forged
projection, a forged slot, a `server-attested` claim, and a fabricated triage digest are all
rejected."*

What is actually covered:

- `test/contracts/supplemental-record.test.ts` — the record contract in isolation.
- `test/unit/local-commands-phase15.test.ts:45` — `assertGateCounterRequestBinding` in isolation.
- `test/integration/state-gate-lifecycle-phase12.test.ts` — `runDurableGate` supplemental paths,
  but against the **stub** `resolve_supplemental_review` at `:113`, not the record-backed
  production resolver in `src/state/production.ts:293`.

What is not covered anywhere: no test invokes `gate-counter` at all
(`grep -rn "gate-counter\|gateCounter" test/` finds only path-claim and slot fixtures). So the three
properties the design specifically pinned are unproven:

1. **record first, projection last** (`src/local/commands.ts:126-158`) — including the byte-identical
   re-run path at `:147-152`;
2. `resolve_supplemental_review` reading **only** the retained record and re-deriving families and
   digests from it (`production.ts:309-323`);
3. a **forged projection** (a hand-written `reviews/<phase>.gate-counter.<gate>.md` with no retained
   record) being rejected — this is the whole point of the record, and nothing exercises it.

The `server-attested` rejection, forged slot, and fabricated triage digest are covered structurally
by the contract parser and the new `gates.ts:492-517` checks, but not through the real resolver.

**Suggested resolution**: add the `gate-supplemental-phase15` integration suite the design's Files
table calls for: real repository, real `gate-counter` run, then `runDurableGate` with the production
dependencies, asserting the round trip plus the four rejections.

---

## Major 8 — Several other suites the design required were not written

From the design's "Edge cases the new suites must cover", with no corresponding test:

- **"Each typed dispatch failure — routing, unsupported host, family mismatch, CLI missing, auth
  unavailable, timeout, overflow, cancellation — surfacing its own code through the live boundary."**
  Only `test/unit/mcp-handler-errors.test.ts` exists, which throws four synthetic errors directly at
  `mapHandlerErrors`. Nothing drives a real failure through `createToolBoundary` → handler →
  coordinator, which is what the success criterion ("every stable dispatch failure class arrives
  classified, never as `INTERNAL_ERROR`") actually asserts.
- **Constitution-edit pre-dispatch gate.** `adjudicate.ts:344-348` (the classified non-success that
  must not fabricate a success shape) has no test.
- **Adjudication crash window.** `adjudicate.ts:188-299` — `loadRetiredOutcome`, the full
  authenticated-approval load, and the deterministic next-gate derivation — is untested;
  `test/unit/mcp-adjudicate-replay-phase15.test.ts` (31 lines) only exercises the
  `resumeAdjudicationReplay` driver against stubs.
- **`archflow-local` command surface.** `test/unit/local-commands-phase15.test.ts` covers only pure
  adapters (`hash`, `validate`, import-chain selection, and two assertion helpers). `gate-counter`,
  `maintain`, `snapshot`, `restore`, `decide`, `reconcile`, `status`, and the `checkpoint` **writer**
  have no command-level test — which is also why Major 5 went unnoticed.
- **Cancellation during the child** (as distinct from during preflight) is not covered;
  `dispatch-coordinator-phase15.test.ts:162` covers preflight only.

Design items that *are* adequately covered, for the record: the five-tool registry, the process-runner
handler seam, exact-replay and receipt-only recovery by model-call count, the decline-then-decision
end-to-end gate test, checkpoint gap/fork/foreign rejection, the maintenance roots/candidates exact-set
test, non-plain-JSON → `INTERNAL_ERROR`, the `git`-absent smoke path, and the per-entry-provenance
`provenance` mutation class.

---

## Not findings

Checked and found correct, listed so they are not re-litigated:

- The two-phase authority bootstrap in `state/production.ts:211-243` and the resolved-context rebuild.
- The pre-dispatch replay probe (`mcp/handlers/replay.ts`): `executeLocked` (`transaction.ts:1007-1034`)
  calls `prepare` only after replay/recovery is resolved and before any write, so the sentinel-failure
  probe is genuinely side-effect-free for a new intent.
- The chunk-2 gate fixes: `recorded = authenticatedLedger.length !== 0` is correct because
  `currentSupplementalLedger` already filters to entries deep-equal to the caller's outcome; triage
  authentication now runs ahead of both `triage-no-change` and `supersede`.
- The dispatch coordinator does not call `serializeDispatch` and does not mint observations, disposes
  its workspace in a `finally`, and never lets an attempt-record write mask the primary error.
- The scaffolding fix in `state/transaction.ts:810-822` (result directory / payload parents before
  `installSnapshot`).
- `src/local/commands.ts` importing `contracts/internal/test-capabilities.js` is consistent with
  existing production use in `state/evidence-results.ts` and `dispatch/cli.ts`.
- No upgrade command, no `package.json` `bin`, no loader-policy replacement, and no preview/two-pass
  release operation — all correctly absent.

One trivial cleanup, noted rather than filed: `state-results.ts:21-22` imports `RESULT_BYTE_CAP` and
`TASK_BYTE_CAP` but never uses them; `accounting()` at `:85-86` re-states both caps as literals. The
literals are currently correct, so nothing is broken today.

## Triage

1. **Blocker 1 — Accepted, with one factual correction.** The tracked release is deliberately
   unfinished and must not be promoted until the human re-authorizes the live-handler fast-uri
   scope. That exact question was surfaced in the implementation verification immediately before
   this counter-review, so the statement that it was never surfaced is outdated. After approval,
   rebind the final bundle and reachability digests, update the human acceptance and decision
   together, stage again, write `dist/`, and run the complete release check. The 3.1.0 decision
   applies to the embedded 3.1.0 copy; the separately inventoried installed 3.1.4 copy is at the
   advisory safe floor and does not require a second acceptance. Record that distinction in the
   implementation log.
2. **Blocker 2 — Accepted.** Update the offline release assertion from singular `bundle` to the
   two-entry `bundles` result and prove it against the regenerated payload.
3. **Major 3 — Accepted.** A durable supersession must return an explicit classified non-success,
   not `STATE_INVALID`, after the state change has landed. Add the minimal error vocabulary needed
   to bind the superseded gate and subject transition, then test the live handler outcome.
4. **Major 4 — Accepted.** Convert the six enumerated caller/disk disagreement branches to
   classified `ProjectResult` failures with stable issue codes; keep throws for actual invariants.
5. **Major 5 — Accepted.** Make no-input commands such as `status` skip stdin and add a spawned-CLI
   regression test that would hang under the old behavior.
6. **Major 6 — Accepted.** Add assembled coordinator coverage for Codex-host to Claude CLI. The
   production value remains pending the explicit human decision already requested; if approved,
   record both `allow_claude_dispatch: true` and the continuing VAL-14 release block in the phase
   log/architecture rather than relying on the source comment.
7. **Major 7 — Accepted.** Add a real repository round trip through `gate-counter` and the
   production retained-record resolver, including forged projection and byte-identical retry.
8. **Major 8 — Partially accepted.** Add the missing boundary-critical coverage: real typed failure
   propagation through the tool boundary, constitution-edit classified response, child-stage
   cancellation, and command-level no-input/gate-counter behavior. Existing disk-backed Phase 14
   fixed-point tests plus the new replay driver cover the adjudication algorithm; existing direct
   command/service tests need not be duplicated exhaustively where they already prove the same
   boundary. Expand further only when these tests expose a concrete gap.

## Repair status

- **Blocker 1 — Repaired after human approval.** The user approved the live-handler
  `fast-uri@3.1.0` scope and the production/release decisions on 2026-07-31. The acceptance,
  reachability evidence, decision, final MCP digest, and entry bindings were rebound together;
  `dist/` now contains both entries and the derived 24-component legal closure. Full release check,
  hostile/offline smoke, mutations, and reproduction pass.
- **Blocker 2 — Repaired and proved.** The offline smoke assertion checks both `bundles` entries and
  passes against the regenerated tracked payload.
- **Major 3 — Repaired.** Durable supersession returns classified `GATE_SUPERSEDED`, bound to the
  gate and old/new subject digests, with a live tool-boundary regression.
- **Major 4 — Repaired.** All six enumerated state-result disagreements return stable
  `CONTRACT_INVALID` results; focused tests cover every branch.
- **Major 5 — Repaired.** `archflow-local status` skips stdin, and a spawned bundled-CLI test keeps
  stdin open while proving prompt exit.
- **Major 6 — Repaired and approved.** Both producer directions run through the assembled
  coordinator. Production deliberately sets `allow_claude_dispatch: true`; the phase log and
  architecture record that `VAL-14` still blocks distribution authorization for that path.
- **Major 7 — Repaired.** A real repository `gate-counter` round trip proves record-first,
  projection-last publication, byte-identical retry, production retained-record resolution, and
  rejection of projection-only, server-attested, and fabricated-triage authority.
- **Major 8 — Accepted boundary coverage repaired.** Tests now exercise a real typed coordinator
  failure through the tool boundary, child-stage cancellation without result evidence, and the
  constitution-edit pre-dispatch gate without a fabricated success or child launch.
